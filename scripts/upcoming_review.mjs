// 預告中心藥師目檢用（spec-upcoming.md §9.2；非 CI）。
//
// 同時開兩個埠：
//   8766  真實資料（data/ 原樣）——目檢完整清單 82 列
//   8767  合成反例——§4.1 的 14 個序號各一列。§9.1 實測：序 1–3、4、7–11、14 在真實
//         資料裡是零實例，只看真實清單等於沒驗到決策表的大半。
// 合成清單在送出前會先過 engine.validateUpcoming()，避免拿一份自己就不合法的資料目檢。
//
// 用法：node scripts/upcoming_review.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateUpcoming, UPCOMING_GENERATOR_VERSION } from '../engine.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const meta = JSON.parse(await readFile(join(ROOT, 'data', 'meta.json'), 'utf8'));
const real = JSON.parse(await readFile(join(ROOT, 'data', 'upcoming.json'), 'utf8'));
const BUILD_DATE = real.buildDate;

const row = (o) => ({
  code: 'ZZ00000000', chName: '合成案例', enName: 'SYNTHETIC CASE', ingredient: 'SYNTHETICINE',
  strength: '10', strengthUnit: 'MG', dosageForm: '錠劑', atcCode: 'Z01ZZ01', manufacturer: '合成藥廠',
  effectiveDate: '2026-12-01', endDate: null, eventType: 'initial', priceState: 'terminated',
  price: null, rawPrice: '0.00', previousPrice: null, pricedBefore: null, previousState: null,
  absoluteChange: null, percentChange: null, crossesStop: false, everPriced: false, flags: [], ...o,
});
const pricedRow = (o) => row({ priceState: 'priced', everPriced: true, previousState: 'priced', ...o });

// 每列的 chName 直接寫出它要驗的規則，目檢時對照 §4.1 逐條看
const SYNTHETIC = [
  row({ code: 'ZZ00000101', chName: '序1 衝突區間（應為「無法判定」）', priceState: 'priced', price: 12.5, rawPrice: '12.50', eventType: 'increase', everPriced: true, pricedBefore: 6.9, previousPrice: 6.9, previousState: 'priced', flags: ['conflicting_price_interval', 'conflict'] }),
  row({ code: 'ZZ00000102', chName: '序2 格式異常（應顯示原始值）', priceState: 'malformed', rawPrice: 'N/A' }),
  row({ code: 'ZZ00000103', chName: '序3 來源無支付價', priceState: 'missing', rawPrice: '' }),
  row({ code: 'ZZ00000104', chName: '序4a 首列即 0 元（不得出現「終止」）' }),
  row({ code: 'ZZ00000105', chName: '序4b 0 元續期、此前從未有價', eventType: 'unchanged', previousState: 'terminated' }),
  row({ code: 'ZZ00000106', chName: '序4c 暫停後轉 0 元、此前從未有價', eventType: 'terminated', previousState: 'suspended' }),
  row({ code: 'ZZ00000107', chName: '序5 終止支付續期（須顯示終止前金額）', eventType: 'unchanged', previousState: 'terminated', everPriced: true, pricedBefore: 245 }),
  row({ code: 'ZZ00000108', chName: '序6 終止支付（須顯示終止前金額）', eventType: 'terminated', previousState: 'priced', everPriced: true, pricedBefore: 245, previousPrice: 245 }),
  row({ code: 'ZZ00000109', chName: '序7 暫停、此前從未有價', priceState: 'suspended', rawPrice: '-' }),
  row({ code: 'ZZ00000110', chName: '序8 暫停支付續期（須顯示暫停前金額）', priceState: 'suspended', rawPrice: '－', eventType: 'unchanged', previousState: 'suspended', everPriced: true, pricedBefore: 18 }),
  row({ code: 'ZZ00000111', chName: '序9 暫停支付（原始標記為破折號）', priceState: 'suspended', rawPrice: '—', eventType: 'suspended', previousState: 'priced', everPriced: true, pricedBefore: 18, previousPrice: 18 }),
  pricedRow({ code: 'ZZ00000112', chName: '序10 首次有價', price: 12.5, rawPrice: '12.50', everPriced: false, pricedBefore: null, previousState: null, eventType: 'first_priced' }),
  pricedRow({ code: 'ZZ00000113', chName: '序11 恢復支付（須顯示差額與跨越停止期間）', price: 22.9, rawPrice: '22.90', previousState: 'terminated', previousPrice: 29.8, pricedBefore: 29.8, eventType: 'relisted', absoluteChange: -6.9, percentChange: -23.15, crossesStop: true }),
  pricedRow({ code: 'ZZ00000114', chName: '序12 續期、支付價不變', price: 94, rawPrice: '94.00', previousPrice: 94, pricedBefore: 94, eventType: 'unchanged' }),
  pricedRow({ code: 'ZZ00000115', chName: '序13a 調升', price: 7.9, rawPrice: '7.90', previousPrice: 6.9, pricedBefore: 6.9, eventType: 'increase', absoluteChange: 1, percentChange: 14.49 }),
  pricedRow({ code: 'ZZ00000116', chName: '序13b 調降', price: 6.9, rawPrice: '6.90', previousPrice: 7.9, pricedBefore: 7.9, eventType: 'decrease', absoluteChange: -1, percentChange: -12.66 }),
  pricedRow({ code: 'ZZ00000117', chName: '序14 安全網：組合異常（應為「無法判定」）', price: 12.5, rawPrice: '12.50', previousState: 'missing', pricedBefore: 6.9, eventType: 'increase' }),
  // 合法缺值：只有未來列的代號，八個描述欄位皆為 null，畫面應一律顯示「—」
  row({ code: 'ZZ00000118', chName: null, enName: null, ingredient: null, strength: null,
    strengthUnit: null, dosageForm: null, atcCode: null, manufacturer: null,
    effectiveDate: '2027-03-01', eventType: 'initial' }),
];

const synthetic = {
  dataVersion: meta.dataVersion,
  generatorVersion: UPCOMING_GENERATOR_VERSION,
  buildDate: BUILD_DATE,
  count: SYNTHETIC.length,
  codeCount: new Set(SYNTHETIC.map((r) => r.code)).size,
  items: SYNTHETIC,
};

const check = validateUpcoming(synthetic, meta);
if (!check.ok) {
  console.error(`✗ 合成清單本身不合法（${check.reason}），請先修正 scripts/upcoming_review.mjs`);
  process.exit(1);
}

function serve(port, overrides, label) {
  createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const override = overrides[path.replace(/^\//, '')];
    if (override) {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      res.end(JSON.stringify(override));
      return;
    }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }).listen(port, '127.0.0.1', () => {
    console.log(`${label}  http://127.0.0.1:${port}/?view=upcoming`);
  });
}

serve(8766, {}, `真實清單（${real.count} 列 / ${real.codeCount} 代號，資料產生日 ${BUILD_DATE}）`);
serve(8767, { 'data/upcoming.json': synthetic }, `合成反例（§4.1 的 14 個序號，共 ${synthetic.count} 列）`);
console.log('Ctrl+C 結束');
