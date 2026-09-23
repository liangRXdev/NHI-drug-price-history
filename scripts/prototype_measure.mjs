/* 原型量測（spec-index-format.md v0.3 §6.1）——決定走方案 (a) 或 (b)，並檢驗中止條件。
 *
 *   node scripts/prototype_measure.mjs <columnar.json 路徑>
 *
 * 方法（§6.1 已凍結，不得在此放寬）：
 *   - gzip level 6 伺服器；CPU 4x throttle；9 Mbps／60 ms latency；**每次冷 cache**
 *   - legacy baseline 與 (a)、(b) **三者交錯**量測，不分批
 *   - 每個對象 ≥7 次；**每次先算該次合計**，最後對合計取 median
 *   - 全部原始值都印出來，不事後剔除離群
 *
 * 量的三段與 measure_e7.mjs 對齊：
 *   fetchParse   = fetch 開始 → JSON.parse 完成
 *   prepare      = parse 完成 → 可搜尋（codes/hays 建好）
 *   total        = 兩者相加
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COLUMNAR = process.argv[2];
if (!COLUMNAR) { console.error('用法：node scripts/prototype_measure.mjs <columnar.json>'); process.exit(2); }

const PORT = 8801;
const RUNS = 7;
const NET = { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const gzCache = new Map();
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path === '/columnar.json' ? COLUMNAR : normalize(join(ROOT, path));
  if (file !== COLUMNAR && !file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    let body = gzCache.get(file);
    if (!body) { body = gzipSync(await readFile(file), { level: 6 }); gzCache.set(file, body); }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${PORT}/`;

/** 三種路徑，都在瀏覽器內執行；回傳 { fetchParse, prepare } */
const PROBE = `
const SEP = '\\u0001';

function prepareFromObjects(drugs) {
  const n = drugs.length;
  const codes = new Array(n), hays = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = drugs[i];
    codes[i] = d.code.toLowerCase();
    hays[i] = (d.code + SEP + d.chName + SEP + d.enName + SEP + d.ingredient).toLowerCase();
  }
  return { codes, hays };
}

async function run(variant) {
  // 絕對路徑：頁面在 /scripts/ 底下，相對路徑會解析到 /scripts/data/... 而 404
  const url = variant === 'legacy' ? '/data/drug_index.json' : '/columnar.json';
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const doc = await res.json();
  const t1 = performance.now();

  let out;
  if (variant === 'legacy') {
    out = prepareFromObjects(doc.drugs);
  } else if (variant === 'a') {
    // (a) 先還原成物件陣列，再走既有的 prepare
    const F = doc.fields, W = doc.windowFields, N = F.length, M = W.length;
    const drugs = new Array(doc.rows.length);
    for (let i = 0; i < doc.rows.length; i++) {
      const r = doc.rows[i];
      if (r.length !== N + 1) throw new Error('row len');
      const o = {};
      for (let j = 0; j < N; j++) o[F[j]] = r[j];
      const w = r[N], ws = new Array(w.length);
      for (let k = 0; k < w.length; k++) {
        if (w[k].length !== M) throw new Error('win len');
        const wo = {};
        for (let q = 0; q < M; q++) wo[W[q]] = w[k][q];
        ws[k] = wo;
      }
      o.window = ws;
      drugs[i] = o;
    }
    out = prepareFromObjects(drugs);
  } else {
    // (b) 直接吃 rows：codes/hays 由 rows 建，順帶做全量 shape 驗證（§4.1.1）
    const F = doc.fields, W = doc.windowFields, N = F.length, M = W.length;
    const iCode = F.indexOf('code'), iCh = F.indexOf('chName'), iEn = F.indexOf('enName'), iIn = F.indexOf('ingredient');
    const rows = doc.rows, n = rows.length;
    const codes = new Array(n), hays = new Array(n);
    let prev = '';
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (r.length !== N + 1) throw new Error('row len');
      const w = r[N];
      for (let k = 0; k < w.length; k++) if (w[k].length !== M) throw new Error('win len');
      const code = r[iCode];
      if (typeof code !== 'string' || !code || code <= prev) throw new Error('code');
      prev = code;
      codes[i] = code.toLowerCase();
      hays[i] = (code + SEP + r[iCh] + SEP + r[iEn] + SEP + r[iIn]).toLowerCase();
    }
    out = { codes, hays };
  }
  const t2 = performance.now();
  if (out.codes.length < 1000) throw new Error('prepare 結果異常');
  return { fetchParse: t1 - t0, prepare: t2 - t1 };
}
`;

const browser = await chromium.launch();
const results = { legacy: [], a: [], b: [] };
const VARIANTS = ['legacy', 'a', 'b'];

console.log(`交錯量測 ${RUNS} 輪 × 3 個對象，每次冷 cache（CPU 4x、9 Mbps／60 ms、gzip 6）\n`);

for (let round = 1; round <= RUNS; round++) {
  const line = [];
  for (const v of VARIANTS) {
    const ctx = await browser.newContext();                 // 每次新 context ＝ 冷 cache
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', NET);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(`${BASE}scripts/_prototype_page.html`, { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(`(async () => { ${PROBE}; return await run(${JSON.stringify(v)}); })()`);
    results[v].push(r);
    line.push(`${v}=${(r.fetchParse + r.prepare).toFixed(0)}`);
    await ctx.close();
  }
  console.log(`  第 ${round} 輪  ${line.join('  ')}`);
}
await browser.close();
server.close();

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log(`\n${'對象'.padEnd(10)}${'fetchParse'.padStart(12)}${'prepare'.padStart(10)}${'合計 median'.padStart(14)}`);
console.log('-'.repeat(48));
const totals = {};
for (const v of VARIANTS) {
  const rs = results[v];
  // §6.1：每次先算該次合計，最後對合計取 median
  totals[v] = median(rs.map((r) => r.fetchParse + r.prepare));
  console.log(
    `${v.padEnd(10)}${median(rs.map((r) => r.fetchParse)).toFixed(0).padStart(12)}`
    + `${median(rs.map((r) => r.prepare)).toFixed(0).padStart(10)}`
    + `${totals[v].toFixed(0).padStart(14)}`,
  );
}

console.log('\n原始合計值（不剔除離群）：');
for (const v of VARIANTS) {
  console.log(`  ${v.padEnd(7)}${results[v].map((r) => (r.fetchParse + r.prepare).toFixed(0)).join(', ')}`);
}

const best = totals.a <= totals.b ? 'a' : 'b';
const gain = totals.legacy - totals[best];
console.log(`\n較佳方案：(${best})   改善 ${gain.toFixed(0)} ms（${(gain / totals.legacy * 100).toFixed(1)}%）`);
console.log(gain >= 500
  ? `§6.2 中止條件：**通過**（≥ 500 ms）`
  : `§6.2 中止條件：**未通過**（< 500 ms）→ 依規格應停工回報，不得調門檻`);
process.exit(gain >= 500 ? 0 : 3);
