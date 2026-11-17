// S17 回頭客量測（spec-startup.md §8 S17；只記錄、不設門檻）。對**線上 GitHub Pages** 執行。
//
// 每個入口（首頁、?code=）各做 REPS 次；每次開新的 browser context：
//   1. 首訪：載入一次，等到 index 發布（搜尋框啟用）
//   2. 回訪：同一 context 重新導覽到同一網址（Service Worker 照常運作；data/ 依設計不經 SW）
// 經 CDP 記錄每個 data/ 檔的網路層狀態碼、是否來自磁碟快取／SW、實際傳輸位元組、解碼後大小，
// 以及終點耗時（起點 navigationStart）：
//   - ?code=：詳情可互動＝摘要卡片與歷史表可見且列數符合 shard（不點排序：S17 不設門檻，只看回訪是否變快）
//   - 首頁：可搜尋＝固定查詢的結果首筆等於該代號
// 不加 CPU／網路節流：記錄的是實際網路下的回頭客行為（S17 的目的是看 HTTP 快取，不是重現 S1 的條件）。
//
// 用法：node scripts/measure_returning.mjs --out <json> [--reps 3] [--base <url>]
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg('base', 'https://liangrxdev.github.io/NHI-drug-price-history/');
const OUT = resolve(arg('out', '.ai-review/startup-s17.json'));
const REPS = Number(arg('reps', 3));
const CODE = 'AC49155265';                    // 與 S1–S3 相同的凍結代號（最大片）

function probe(cfg) {
  const m = { end: null, error: null };
  window.__m = m;
  const check = () => {
    if (m.end !== null) return;
    if (cfg.mode === 'detail') {
      const sum = document.getElementById('sumTitle')?.closest('section');
      const table = document.querySelector('#detail table.history');
      if (!sum || !table || document.getElementById('detailView')?.hidden) return;
      const r = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      void document.getElementById('detail').offsetHeight;
      if (!r(sum) || !r(table) || !sum.querySelector('.metric.key')) return;
      const rows = table.querySelectorAll('tbody tr').length;
      if (rows !== cfg.rows) { m.error = `列數 ${rows} ≠ ${cfg.rows}`; return; }
      m.end = performance.now();
    } else {
      const q = document.getElementById('q');
      if (!q || q.disabled) return;
      if (q.value !== cfg.code) { q.value = cfg.code; q.dispatchEvent(new Event('input')); return; }
      if (document.querySelector('#results .result')?.dataset.code === cfg.code) m.end = performance.now();
    }
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
}

async function shardRows(request) {
  const meta = await (await request.get(`${BASE}data/meta.json`)).json();
  const prefix = meta.shards.files.filter((f) => CODE.startsWith(f)).sort((a, b) => b.length - a.length)[0];
  const shard = await (await request.get(`${BASE}data/history/${prefix}.json`)).json();
  const e = shard.drugs[CODE];
  return { rows: e.records.length + e.invalidRecords.length, dataVersion: meta.dataVersion };
}

/** 記錄一次導覽中 data/ 檔的網路層資訊。 */
function netRecorder(cdp) {
  const byId = new Map();
  cdp.on('Network.requestWillBeSent', (e) => {
    if (/\/data\//.test(e.request.url)) byId.set(e.requestId, { url: e.request.url.replace(/^.*\/data\//, 'data/').replace(/\?.*$/, ''), decoded: 0 });
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = byId.get(e.requestId);
    if (r) Object.assign(r, { status: e.response.status, fromDiskCache: e.response.fromDiskCache, fromServiceWorker: e.response.fromServiceWorker });
  });
  cdp.on('Network.dataReceived', (e) => { const r = byId.get(e.requestId); if (r) r.decoded += e.dataLength; });
  cdp.on('Network.loadingFinished', (e) => { const r = byId.get(e.requestId); if (r) r.transferred = e.encodedDataLength; });
  cdp.on('Network.loadingFailed', (e) => { const r = byId.get(e.requestId); if (r) r.failed = e.errorText; });
  return { take() { const out = [...byId.values()]; byId.clear(); return out; } };
}

async function waitEnd(page) {
  await page.waitForFunction(() => window.__m && (window.__m.end !== null || window.__m.error !== null), null, { timeout: 120_000 });
  const m = await page.evaluate(() => window.__m);
  if (m.error) throw new Error(m.error);
  return Math.round(m.end * 10) / 10;
}

const browser = await chromium.launch();
const ctx0 = await browser.newContext();
const ref = await shardRows(ctx0.request);
await ctx0.close();

const runs = [];
for (const entry of ['code', 'home']) {
  for (let i = 0; i < REPS; i++) {
    const ctx = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    const net = netRecorder(cdp);
    const cfg = entry === 'code' ? { mode: 'detail', rows: ref.rows } : { mode: 'home', code: CODE };
    await page.addInitScript(probe, cfg);
    const url = entry === 'code' ? `${BASE}?code=${CODE}` : BASE;
    const run = { entry, rep: i };
    try {
      await page.goto(url);
      run.first = { endMs: await waitEnd(page) };
      await page.waitForFunction(() => document.getElementById('q')?.disabled === false, null, { timeout: 120_000 });   // index 已發布
      await page.waitForTimeout(500);
      run.first.data = net.take();
      await page.goto(url);                                                                       // 同一 context 重新導覽
      run.returning = { endMs: await waitEnd(page) };
      await page.waitForFunction(() => document.getElementById('q')?.disabled === false, null, { timeout: 120_000 });
      await page.waitForTimeout(500);
      run.returning.data = net.take();
      run.swControlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
    } catch (e) {
      run.error = e.message.split('\n')[0];
    }
    runs.push(run);
    console.error(`${entry} #${i}：首訪 ${run.first?.endMs ?? '—'} ms → 回訪 ${run.returning?.endMs ?? '—'} ms${run.error ? `（錯誤：${run.error}）` : ''}`);
    await ctx.close();
  }
}
const result = { measuredAt: new Date().toISOString(), base: BASE, code: CODE, browser: browser.version(), dataVersion: ref.dataVersion,
  conditions: '無節流、實際網路、SW 啟用、每次新 context', runs };
await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);
await browser.close();
