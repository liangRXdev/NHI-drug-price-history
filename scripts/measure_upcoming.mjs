// U14 預告中心效能量測（spec-upcoming.md §8、§8.1 量測契約；非 CI）。
//
// 契約：全量真實 data/（非空清單）、gzip level 6、CPU 4x throttle、9 Mbps／1.5 Mbps／60 ms、
// meta.json 視為已完成（首屏已載入），量測起點為點擊徽章那一刻，終點為「版本驗證通過且
// 完整清單已渲染」（骨架可捲動不算）。每項 3 次取中位數。
//
// 用法：node scripts/measure_upcoming.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8798;
const NET = { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
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

const raw = await readFile(join(ROOT, 'data', 'upcoming.json'));
const payload = JSON.parse(raw);
const sizes = { rawBytes: raw.length, gzipBytes: gzipSync(raw, { level: 6 }).length, count: payload.count, codeCount: payload.codeCount };

const browser = await chromium.launch();
const runs = [];
for (let i = 0; i < RUNS; i += 1) {
  const ctx = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', NET);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const requests = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 180_000 });
  const beforeClick = requests.filter((p) => p.endsWith('upcoming.json')).length;

  await page.locator('#upcomingBadge').click();
  await page.waitForFunction((n) => document.querySelectorAll('.upcoming-row').length === n, payload.count, { timeout: 60_000 });
  const fetchToRendered = await page.evaluate(() =>
    performance.getEntriesByName('upcoming-fetch-to-rendered').pop()?.duration ?? -1);

  // 篩選／排序重繪：每個操作各量一次，取最大值（最壞情況）
  const rerender = [];
  for (const [id, value] of [['upType', 'terminated'], ['upSort', 'change_desc'], ['upType', 'all'], ['upSort', 'date_asc']]) {
    rerender.push(await page.evaluate(async ([elId, v]) => {
      performance.clearMeasures('upcoming-rerender');
      const el = document.getElementById(elId);
      el.value = v;
      el.dispatchEvent(new Event('change'));
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      return Math.round(performance.getEntriesByName('upcoming-rerender').pop()?.duration ?? -1);
    }, [id, value]));
  }

  runs.push({
    fetchToRenderedMs: Math.round(fetchToRendered),
    rerenderMaxMs: Math.max(...rerender),
    upcomingRequestsBeforeClick: beforeClick,
    rows: await page.locator('.upcoming-row').count(),
  });
  await ctx.close();
}

await browser.close();
server.close();

const out = {
  measuredAt: new Date().toISOString(),
  contract: { runs: RUNS, cpuThrottle: '4x', network: '9 Mbps / 1.5 Mbps / 60 ms', gzip: 'level 6', serviceWorker: 'blocked' },
  data: sizes,
  runs,
  median: {
    fetchToRenderedMs: median(runs.map((r) => r.fetchToRenderedMs)),
    rerenderMaxMs: median(runs.map((r) => r.rerenderMaxMs)),
  },
  targets: { fetchToRenderedMs: 200, rerenderMs: 50, gzipBytes: 20 * 1024, firstScreenUpcomingBytes: 0 },
};
console.log(JSON.stringify(out, null, 2));
