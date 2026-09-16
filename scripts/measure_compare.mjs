// M17 多代號比較效能量測（spec-compare.md §8；非 CI）。
//
// 三種情境分開量，不可混為一談：
//   A 搜尋後進比較（已完成啟動）：點「開始比較」→ 圖表可互動   目標 < 600 ms
//   B 已快取重繪（增刪一個已載入的代號）：操作 → 重繪完成      目標 < 150 ms
//   C 冷開 deep link：導覽開始 → 圖表可互動                  只記錄，不設門檻
//
// 終點「可互動」＝圖表已渲染（DOM ＋ layout）且 crosshair 實際可回應——腳本在收秒表後
// 派送一次 mousemove，確認 tooltip 真的出現，否則該次數據不算數。
// 條件：全量真實資料、CPU 4x throttle、9 Mbps／1.5 Mbps／60 ms、gzip level 6、每項 3 次取中位數。
// 指名 4 片不同 shard（含最大片 AC49.json）與 4 個代號。
//
// 用法：node scripts/measure_compare.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8797;
const NET = { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const CODES = ['AC49155265', 'A049565335', 'AC48055100', 'A041725329'];   // 四片不同 shard，含最大片 AC49
const RUNS = 3;
const gzCache = new Map();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

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

const shardSizes = {};
for (const code of CODES) {
  const prefix = code.slice(0, 4);
  const raw = await readFile(join(ROOT, 'data', 'history', `${prefix}.json`));
  shardSizes[prefix] = { rawBytes: (await stat(join(ROOT, 'data', 'history', `${prefix}.json`))).size, gzipBytes: gzipSync(raw, { level: 6 }).length };
}

const browser = await chromium.launch();

async function throttled() {
  const ctx = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', serviceWorkers: 'block' });
  if (process.env.NOFONTS) await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', NET);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  return { ctx, page };
}

/** 收秒表後確認 crosshair 真的回應，否則不算「可互動」。 */
async function crosshairResponds(page) {
  const box = await page.locator('.cmp-chart').boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  try {
    await page.locator('#compareCross .cross-row').first().waitFor({ state: 'visible', timeout: 5000 });
    return (await page.locator('#compareCross .cross-row').count()) === CODES.length;
  } catch {
    return false;
  }
}

const runs = { A: [], B: [], C: [] };
for (let i = 0; i < RUNS; i += 1) {
  // ── A：已完成啟動後點「開始比較」 ──
  {
    const { ctx, page } = await throttled();
    await page.goto(base);
    await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 180_000 });
    await page.evaluate((codes) => {
      // 直接放進比較籃，避免把搜尋輸入時間算進情境 A
      sessionStorage.setItem('compareCodes', JSON.stringify(codes.map((code, slot) => ({ code, slot, valid: true }))));
    }, CODES);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 180_000 });
    await page.locator('#compareTray button', { hasText: '開始比較' }).click();
    await page.locator('.cmp-chart').waitFor({ timeout: 60_000 });
    const ms = await page.evaluate(() => performance.getEntriesByName('compare-open-to-interactive').pop()?.duration ?? -1);
    runs.A.push({ ms: Math.round(ms), interactive: await crosshairResponds(page) });

    // ── B：已快取重繪（移除一碼再加回） ──
    const rerender = [];
    for (const round of [0, 1]) {
      await page.locator('.compare-code', { hasText: CODES[3] }).getByRole('button', { name: '移除' }).click();
      await page.locator('.cmp-chart').waitFor({ timeout: 30_000 });
      rerender.push(await page.evaluate(() => Math.round(performance.getEntriesByName('compare-render').pop()?.duration ?? -1)));
      await page.evaluate((codes) => {
        sessionStorage.setItem('compareCodes', JSON.stringify(codes.map((code, slot) => ({ code, slot, valid: true }))));
      }, CODES);
      await page.goto(`${base}?codes=${CODES.join(',')}`);
      await page.locator('.cmp-chart').waitFor({ timeout: 60_000 });
      if (round === 0) rerender.length = 0;                 // 第一輪含冷啟動，捨棄
    }
    runs.B.push({ ms: rerender[0] });
    await ctx.close();
  }

  // ── C：冷開 deep link ──
  {
    const { ctx, page } = await throttled();
    await page.goto(`${base}?codes=${CODES.join(',')}`);
    await page.locator('.cmp-chart').waitFor({ timeout: 180_000 });
    const ms = await page.evaluate(() => performance.getEntriesByName('compare-open-to-interactive').pop()?.duration ?? -1);
    runs.C.push({ ms: Math.round(ms), interactive: await crosshairResponds(page) });
    await ctx.close();
  }
}

await browser.close();
server.close();

console.log(JSON.stringify({
  measuredAt: new Date().toISOString(),
  codes: CODES,
  shards: shardSizes,
  contract: { runs: RUNS, cpuThrottle: '4x', network: '9 Mbps / 1.5 Mbps / 60 ms', gzip: 'level 6', fonts: process.env.NOFONTS ? 'blocked' : 'loaded' },
  runs,
  median: {
    A_openToInteractiveMs: median(runs.A.map((r) => r.ms)),
    B_rerenderMs: median(runs.B.map((r) => r.ms)),
    C_coldDeepLinkMs: median(runs.C.map((r) => r.ms)),
  },
  interactiveVerified: { A: runs.A.every((r) => r.interactive), C: runs.C.every((r) => r.interactive) },
  targets: { A: 600, B: 150, C: null },
}, null, 2));
