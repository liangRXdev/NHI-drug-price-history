// 首訪啟動策略量測（spec-startup.md §7；驗收用，非 CI）。
//
// 兩個 gzip 伺服器（A＝legacy、B＝candidate）提供各自的前端檔，共用同一份 data/。
// Chromium 經 CDP 設 CPU 4x、9 Mbps／60 ms、冷 cache、SW 封鎖。終點由本腳本注入的同一段
// 觀察碼判定，A／B 共用，不依賴 app 內的 mark（「搜尋可用時刻」除外，見 §7）。
//
// 用法：
//   node scripts/measure_startup.mjs --a <legacy 目錄> --b <candidate 目錄> --out <json> [--blocks 5]
//   M0（量變異）：--a 與 --b 都指向 legacy。
//
// 量測條件的補充（A／B 相同）：對 fonts.googleapis.com／fonts.gstatic.com 的請求一律 abort，
// 避免外部網路的即時狀態混入配對差值。
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const DIR = { A: resolve(arg('a', REPO)), B: resolve(arg('b', REPO)) };
const OUT = resolve(arg('out', join(REPO, '.ai-review', 'startup-measure.json')));
const BLOCKS = Number(arg('blocks', 5));
const DATA = join(REPO, 'data');
const PORTS = { A: 8791, B: 8792 };

// 動工前凍結，之後不得更換（spec-startup.md §7）：最大片／gzip 中位片／最小片
const CODES = ['AC49155265', 'B004922277', 'NB01043100'];
const QUERY = 'AC49155265';                       // 可搜尋終點與事後驗證的固定查詢
const NET = { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };
const ORDERS = [['A', 'B', 'B', 'A', 'A', 'B'], ['B', 'A', 'A', 'B', 'B', 'A']];
const MAX_VOID = 3;                               // 同一區塊最多作廢重跑次數，超過即中止回報
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const FRONT = ['index.html', 'app.js', 'engine.js', 'styles.css', 'manifest.webmanifest', 'icon.svg'];

const gz = new Map();
async function gzFile(file) {
  let body = gz.get(file);
  if (!body) { body = gzipSync(await readFile(file), { level: 6 }); gz.set(file, body); }
  return body;
}

function serve(side) {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const root = path.startsWith('/data/') ? REPO : DIR[side];
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await gzFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Encoding': 'gzip' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((ok) => server.listen(PORTS[side], '127.0.0.1', () => ok(server)));
}

// 每個代號的預期值：由 shard 的 records 獨立算出
async function expectations() {
  const meta = JSON.parse(await readFile(join(DATA, 'meta.json'), 'utf8'));
  const out = {};
  for (const code of CODES) {
    const prefix = meta.shards.files.filter((f) => code.startsWith(f)).sort((a, b) => b.length - a.length)[0];
    const shard = JSON.parse(await readFile(join(DATA, 'history', `${prefix}.json`), 'utf8'));
    const e = shard.drugs[code];
    const froms = e.records.map((r) => r.from);
    out[code] = { prefix, rows: e.records.length + e.invalidRecords.length, newest: froms[froms.length - 1], oldest: froms[0] };
  }
  return { meta, exp: out };
}

// 注入頁面的觀察碼（A／B 共用）。window.__m 收集結果。
function probe(cfg) {
  const m = { searchReady: null, searchReadyEnabled: null, detail: null, detailError: null, home: null, homeError: null };
  window.__m = m;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name === 'search-ready' && m.searchReady === null) {
        m.searchReady = e.startTime;
        m.searchReadyEnabled = document.getElementById('q')?.disabled === false;
      }
    }
  }).observe({ type: 'mark', buffered: true });
  const raf2 = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  const firstDate = () => document.querySelector('#detail table.history tbody tr td.date')?.textContent ?? null;

  if (cfg.mode === 'detail') {
    let started = false;
    const check = async () => {
      if (started) return;
      const view = document.getElementById('detailView');
      const sum = document.getElementById('sumTitle');
      const table = document.querySelector('#detail table.history');
      const btn = document.querySelector('#detail [data-action="toggle-sort"]');
      if (!view || view.hidden || !sum || !table || !btn) return;
      started = true;
      obs.disconnect();
      const box = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      void document.getElementById('detail').offsetHeight;          // 強制 layout
      if (!box(sum) || !box(table)) { m.detailError = '摘要或歷史表不可見'; return; }
      const rows = table.querySelectorAll('tbody tr').length;
      const before = firstDate();
      const pressedBefore = btn.getAttribute('aria-pressed');
      if (rows !== cfg.rows || before !== cfg.newest) { m.detailError = `排序前不符：rows=${rows} first=${before}`; return; }
      btn.click();
      await raf2();
      const after = firstDate();
      const pressedAfter = document.querySelector('#detail [data-action="toggle-sort"]')?.getAttribute('aria-pressed');
      const rowsAfter = document.querySelectorAll('#detail table.history tbody tr').length;
      if (after !== cfg.oldest || rowsAfter !== cfg.rows || pressedAfter === pressedBefore) {
        m.detailError = `排序後不符：first=${after} rows=${rowsAfter} pressed=${pressedBefore}→${pressedAfter}`;
        return;
      }
      m.detail = performance.now();
    };
    const obs = new MutationObserver(check);
    obs.observe(document, { childList: true, subtree: true });
  } else {
    let typed = false;
    const check = () => {
      const q = document.getElementById('q');
      if (!q) return;
      if (!typed) {
        if (q.disabled) return;
        typed = true;
        q.value = cfg.query;
        q.dispatchEvent(new Event('input'));
        return;
      }
      const first = document.querySelector('#results .result');
      if (first && first.dataset.code === cfg.query) { m.home = performance.now(); obs.disconnect(); }
    };
    const obs = new MutationObserver(check);
    obs.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  }
}

const browser = await chromium.launch();

async function open(side, query, cfg) {
  const ctx = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', serviceWorkers: 'block' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', NET);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(probe, cfg);
  await page.goto(`http://127.0.0.1:${PORTS[side]}/${query}`, { waitUntil: 'commit' });
  return { ctx, page };
}

// ?code= 入口：回 { detail, searchReady } 或 { invalid }
async function runDetail(side, code, exp) {
  const { ctx, page } = await open(side, `?code=${code}`, { mode: 'detail', ...exp });
  try {
    await page.waitForFunction(() => window.__m && (window.__m.detail !== null || window.__m.detailError !== null), null, { timeout: 180_000 });
    await page.waitForFunction(() => window.__m.searchReady !== null, null, { timeout: 180_000 });
    const m = await page.evaluate(() => window.__m);
    if (m.detailError) return { invalid: m.detailError };
    if (!m.searchReadyEnabled) return { invalid: 'search-ready 時搜尋框仍停用' };
    // 事後驗證（不計時）：mark 屬實＝切到搜尋頁後固定查詢在 300 ms 內得到預期首筆
    const ok = await page.evaluate(async (q) => {
      history.pushState(null, '', './');
      dispatchEvent(new PopStateEvent('popstate'));
      const input = document.getElementById('q');
      if (input.disabled) return false;
      const t0 = performance.now();
      input.value = q;
      input.dispatchEvent(new Event('input'));
      while (performance.now() - t0 < 300) {
        if (document.querySelector('#results .result')?.dataset.code === q) return true;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return false;
    }, QUERY);
    if (!ok) return { invalid: 'search-ready 不實：300 ms 內未得到預期首筆' };
    return { detail: m.detail, searchReady: m.searchReady };
  } catch (e) {
    return { invalid: `逾時或例外：${e.message.split('\n')[0]}` };
  } finally {
    await ctx.close();
  }
}

// 首頁入口：回 { home } 或 { invalid }
async function runHome(side) {
  const { ctx, page } = await open(side, '', { mode: 'home', query: QUERY });
  try {
    await page.waitForFunction(() => window.__m && window.__m.home !== null, null, { timeout: 180_000 });
    return { home: await page.evaluate(() => window.__m.home) };
  } catch (e) {
    return { invalid: `逾時或例外：${e.message.split('\n')[0]}` };
  } finally {
    await ctx.close();
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) >> 1] + (s.length % 2 ? 0 : (s[s.length >> 1] - s[(s.length - 1) >> 1]) / 2); };
const round = (x) => Math.round(x * 10) / 10;

async function block(index, exp) {
  const order = ORDERS[index % 2];
  const out = { index, order: order.join(''), detail: {}, home: null, voided: [] };
  for (const code of CODES) {
    const raw = { A: [], B: [] };
    for (const side of order) {
      const r = await runDetail(side, code, exp[code]);
      if (r.invalid) return { void: `${code}/${side}: ${r.invalid}`, partial: out };
      raw[side].push({ detail: round(r.detail), searchReady: round(r.searchReady) });
    }
    const med = (side, k) => median(raw[side].map((x) => x[k]));
    out.detail[code] = {
      raw,
      detailImprovement: round(med('A', 'detail') - med('B', 'detail')),          // 正值＝B 較快
      searchReadyDegradation: round(med('B', 'searchReady') - med('A', 'searchReady')),   // 正值＝B 較慢
    };
  }
  const raw = { A: [], B: [] };
  for (const side of order) {
    const r = await runHome(side);
    if (r.invalid) return { void: `home/${side}: ${r.invalid}`, partial: out };
    raw[side].push(round(r.home));
  }
  out.home = { raw, degradation: round(median(raw.B) - median(raw.A)) };            // 正值＝B 較慢
  return out;
}

const servers = [await serve('A'), await serve('B')];
const { meta, exp } = await expectations();
// 伺服器預熱：兩側會用到的檔案先 gzip 完成（瀏覽器端仍為冷 cache）
for (const side of ['A', 'B']) for (const f of FRONT) await gzFile(join(DIR[side], f));
for (const f of ['meta.json', 'drug_index.json', 'status.json', 'upcoming.json']) await gzFile(join(DATA, f));
for (const code of CODES) await gzFile(join(DATA, 'history', `${exp[code].prefix}.json`));

const result = {
  measuredAt: new Date().toISOString(),
  conditions: { cpuThrottle: 4, network: { latencyMs: 60, downloadMbps: 9, uploadMbps: 1.5 }, gzip: 'level 6', cache: 'cold',
    serviceWorkers: 'block', fonts: 'aborted', browser: browser.version() },
  dirs: { A: basename(DIR.A), B: basename(DIR.B) }, dataVersion: meta.dataVersion, codes: exp, query: QUERY, blocks: [], voided: [],
};

for (let i = 0; i < BLOCKS; i++) {
  let b;
  for (let attempt = 0; ; attempt++) {
    b = await block(i, exp);
    if (!b.void) break;
    result.voided.push({ block: i, attempt, reason: b.void, partial: b.partial });
    console.error(`區塊 ${i} 作廢（第 ${attempt + 1} 次）：${b.void}`);
    if (attempt + 1 >= MAX_VOID) {
      await writeFile(OUT, `${JSON.stringify({ ...result, aborted: true }, null, 2)}\n`);
      console.error('同一區塊連續作廢達上限，中止。');
      await browser.close(); servers.forEach((s) => s.close()); process.exit(2);
    }
  }
  result.blocks.push(b);
  console.error(`區塊 ${i}（${b.order}）：` + CODES.map((c) => `${c} Δ詳情 ${b.detail[c].detailImprovement} / Δ搜尋 ${b.detail[c].searchReadyDegradation}`).join('；')
    + `；首頁 Δ ${b.home.degradation}`);
}

const abs = (xs) => xs.map(Math.abs);
const summary = { perCode: {}, home: {} };
for (const code of CODES) {
  const imp = result.blocks.map((b) => b.detail[code].detailImprovement);
  const deg = result.blocks.map((b) => b.detail[code].searchReadyDegradation);
  summary.perCode[code] = { detailImprovement: imp, min: Math.min(...imp), median: median(imp), maxAbs: Math.max(...abs(imp)),
    searchReadyDegradation: deg, searchReadyDegradationMedian: median(deg) };
}
const hd = result.blocks.map((b) => b.home.degradation);
summary.home = { degradation: hd, median: median(hd), maxAbs: Math.max(...abs(hd)) };
summary.V = Math.max(...CODES.map((c) => summary.perCode[c].maxAbs));      // 僅在 A＝B＝legacy（M0）時有意義
summary.V_home = summary.home.maxAbs;
result.summary = summary;

await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
await browser.close();
servers.forEach((s) => s.close());
