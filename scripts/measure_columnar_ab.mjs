/* F10 驗收量測（spec-index-format.md v0.3 §6.1）——量**真實實作**，不是原型路徑。
 *
 *   node scripts/measure_columnar_ab.mjs <legacy-oracle.json>
 *
 * 與 prototype_measure.mjs 的差別：
 *   - current 走真實的 engine.js（validateIndex ＋ prepareIndex，含全量逐欄 type 驗證）
 *   - legacy 走改版前的邏輯（oracle 物件陣列 ＋ 舊 prepare），由本檔內聯重現
 *
 * 原型階段量的 (b) 只驗長度與 code，**不含逐欄 type 驗證**——那是一個不存在的方案，
 * 用它定門檻會低估成本。這支才是 F10 的依據。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ORACLE = process.argv[2];
if (!ORACLE) { console.error('用法：node scripts/measure_columnar_ab.mjs <legacy-oracle.json>'); process.exit(2); }

const PORT = 8802;
const RUNS = 7;
const NET = { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const gzCache = new Map();
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path === '/legacy.json' ? ORACLE : normalize(join(ROOT, path));
  if (file !== ORACLE && !file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
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

const PAGE = `<!doctype html><meta charset="utf-8"><title>ab</title><body>
<script type="module">
import * as E from '/engine.js';
const SEP = '\\u0001';

// 改版前的 prepareIndex，內聯重現以作為 baseline（含它原本的 fallback sort 分支）
function legacyPrepare(drugs) {
  let list = drugs;
  for (let i = 1; i < list.length; i++) {
    if (list[i - 1].code > list[i].code) {
      list = drugs.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      break;
    }
  }
  const n = list.length;
  const codes = new Array(n), hays = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = list[i];
    codes[i] = d.code.toLowerCase();
    hays[i] = (d.code + SEP + d.chName + SEP + d.enName + SEP + d.ingredient).toLowerCase();
  }
  return { drugs: list, codes, hays };
}

window.runVariant = async (variant) => {
  const url = variant === 'legacy' ? '/legacy.json' : '/data/drug_index.json';
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const doc = await res.json();
  const t1 = performance.now();
  let out;
  if (variant === 'legacy') {
    if (!Array.isArray(doc.drugs)) throw new Error('legacy 檔缺 drugs');
    out = legacyPrepare(doc.drugs);
  } else {
    const v = E.validateIndex(doc, null);
    if (!v.ok) throw new Error('validateIndex: ' + v.reason);
    out = E.prepareIndex(doc);           // 含全量逐欄 type 驗證
  }
  const t2 = performance.now();
  const n = out.codes.length;
  if (n < 1000) throw new Error('prepare 結果異常');
  return { fetchParse: t1 - t0, prepare: t2 - t1, n };
};
<\/script></body>`;

const browser = await chromium.launch();
const results = { legacy: [], current: [] };
const VARIANTS = ['legacy', 'current'];
console.log(`交錯量測 ${RUNS} 輪 × 2 個對象，每次冷 cache（CPU 4x、9 Mbps／60 ms、gzip 6）\n`);

for (let round = 1; round <= RUNS; round++) {
  const line = [];
  for (const v of VARIANTS) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route(`${BASE}_ab.html`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', NET);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(`${BASE}_ab.html`, { waitUntil: 'load' });
    const r = await page.evaluate((vv) => window.runVariant(vv), v);
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
  totals[v] = median(rs.map((r) => r.fetchParse + r.prepare));
  console.log(`${v.padEnd(10)}${median(rs.map((r) => r.fetchParse)).toFixed(0).padStart(12)}`
    + `${median(rs.map((r) => r.prepare)).toFixed(0).padStart(10)}${totals[v].toFixed(0).padStart(14)}`);
}
console.log('\n原始合計值（不剔除離群）：');
for (const v of VARIANTS) console.log(`  ${v.padEnd(8)}${results[v].map((r) => (r.fetchParse + r.prepare).toFixed(0)).join(', ')}`);

const gain = totals.legacy - totals.current;
console.log(`\n改善 ${gain.toFixed(0)} ms（${(gain / totals.legacy * 100).toFixed(1)}%）`);
console.log(gain >= 500 ? 'F10／§6.2：**通過**（≥ 500 ms）'
  : 'F10／§6.2：**未通過**（< 500 ms）→ 依規格停工回報，不得調門檻');
process.exit(gain >= 500 ? 0 : 3);
