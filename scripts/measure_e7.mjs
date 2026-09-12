// E7 效能量測與 C2 截圖（Phase 2 驗收紀錄用；非 CI）。
//
// 以 gzip 伺服器提供真實 data/（模擬 GitHub Pages 的壓縮傳輸），Chromium 經 CDP 設定
// CPU 4x throttle 與網路節流，量測：
//   index fetch 開始 → 解析完成、解析完成 → 可搜尋、前 50 筆 render、shard 取得後 chart render
// 並對 11 個 golden 代號截圖（桌面 1280、行動 390）存至 .ai-review/screenshots/。
//
// 用法：node scripts/measure_e7.mjs [--no-shots]
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8799;
const NET = { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };
const GOLDEN = ['A017014321', 'AC48092100', 'AC48867100', 'AC48845100', 'B009254100', 'BC23981100',
  'A035680329', 'BC05037209', 'AB47689100', 'BC26467100', 'A020296321'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const gzCache = new Map();

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    let body = gzCache.get(file);
    if (!body) { body = gzipSync(await readFile(file), { level: 6 }); gzCache.set(file, body); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Encoding': 'gzip' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const base = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch();
const results = {};

async function throttled(ctxOpts = {}) {
  const ctx = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', serviceWorkers: 'block', ...ctxOpts });
  if (process.env.NOFONTS) await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());   // 對照實驗
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', NET);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  return { ctx, page };
}

// 1. index 載入與搜尋
{
  const { ctx, page } = await throttled();
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 120_000 });
  const m = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('measure').map((e) => [e.name, e.duration])));
  results.indexFetchToParsedMs = Math.round(m['index-fetch-to-parsed']);
  results.parsedToSearchableMs = Math.round(m['parsed-to-searchable']);

  // 每個查詢跑兩次（首次含 JIT／字型等冷啟動）；compute＝E.search、render＝組 HTML＋innerHTML、
  // toPaint＝輸入事件 → 兩個 animation frame 後（含 layout／paint）
  const renders = [];
  for (const q of ['a', '錠', 'paroxetine', 'AC48092100', 'a']) {
    for (const round of ['cold', 'warm']) {
      await page.evaluate(() => { document.getElementById('q').value = ''; document.getElementById('q').dispatchEvent(new Event('input')); });
      await page.waitForTimeout(100);
      const r = await page.evaluate(async (query) => {
        performance.clearMeasures('search-compute');
        performance.clearMeasures('search-render');
        const input = document.getElementById('q');
        const t0 = performance.now();
        input.value = query;
        input.dispatchEvent(new Event('input'));
        await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        const get = (n) => Math.round(performance.getEntriesByName(n).pop()?.duration ?? -1);
        return { compute: get('search-compute'), render: get('search-render'), toPaint: Math.round(performance.now() - t0) };
      }, q);
      renders.push({ q, round, ...r, results: await page.locator('.result').count() });
    }
  }
  results.search = renders;
  await ctx.close();
}

// 2. shard 取得後的詳細頁 render（含 chart）
{
  const { ctx, page } = await throttled();
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 120_000 });
  const rows = [];
  for (const code of ['A017014321', 'AC48092100', 'AC49000209', 'A017014321']) {
    await page.evaluate(() => {
      window.__shardDone = null;
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.name.includes('/data/history/')) window.__shardDone = e.responseEnd;
      });
      obs.observe({ type: 'resource', buffered: false });
    });
    await page.evaluate((c) => { history.pushState(null, '', `?code=${c}`); dispatchEvent(new PopStateEvent('popstate')); }, code);
    await page.locator('svg.chart').waitFor({ timeout: 60_000 });
    const r = await page.evaluate(async () => {
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const get = (n) => Math.round(performance.getEntriesByName(n).pop()?.duration ?? -1);
      return {
        responseEndToPaint: window.__shardDone ? Math.round(performance.now() - window.__shardDone) : null,
        fetchParse: get('shard-fetch-parse'),
        detailRender: get('detail-render'),
      };
    });
    rows.push({ code, ...r });
  }
  results.shardToChartMs = rows;
  await ctx.close();
}

results.conditions = { cpuThrottle: 4, network: { latencyMs: NET.latency, downloadMbps: 9, uploadMbps: 1.5 }, gzip: 'level 6', browser: browser.version() };
results.measuredAt = new Date().toISOString();
console.log(JSON.stringify(results, null, 2));

// 3. C2 截圖（無節流）
if (!process.argv.includes('--no-shots')) {
  const dir = join(ROOT, '.ai-review', 'screenshots');
  await mkdir(dir, { recursive: true });
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', serviceWorkers: 'block', deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 120_000 });
    for (const code of GOLDEN) {
      await page.evaluate((c) => { history.pushState(null, '', `?code=${c}`); dispatchEvent(new PopStateEvent('popstate')); }, code);
      await page.locator('svg.chart').waitFor();
      await page.screenshot({ path: join(dir, `${code}_${label}.png`), fullPage: true });
    }
    await page.evaluate(() => { history.pushState(null, '', './'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('#q').fill('BC0503');
    await page.screenshot({ path: join(dir, `search_${label}.png`), fullPage: true });
    await ctx.close();
  }
  await writeFile(join(dir, 'e7_measurement.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`✓ 截圖 → ${dir}`);
}

await browser.close();
server.close();
