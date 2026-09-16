// 多代號比較藥師目檢用（spec-compare.md §9.3；非 CI）。
//
// 同時開兩個埠：
//   8768  真實資料：四個代號（多次降價＋空窗／終止後恢復／暫停後終止／首列 0 元）
//   8769  合成情境：四條線在 2019 整年**完全重合**，其中一碼帶預告區間
//         （§9.3 第 3、4 項在真實資料裡湊不出來）
//
// 用法：node scripts/compare_review.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json' };

const REAL = ['A035680329', 'AC48867100', 'B009254100', 'A020296321'];
const SYNTH = ['ZZ00000001', 'ZZ00000002', 'ZZ00000003', 'ZZ00000004'];
const TODAY = new Date().toISOString().slice(0, 10);

const rec = (from, to, rawPrice, over = {}) => ({
  from, to, price: Number(rawPrice), rawPrice, priceState: 'priced', changeFlag: '',
  eventType: 'initial', previousPrice: null, absoluteChange: null, percentChange: null,
  crossesStop: false, flags: [], ...over,
});

// 四碼在 2019 整年同為 20.00 元（完全重合），其餘期間各自不同；第 4 碼帶一段預告
function syntheticShard() {
  const drugs = {};
  SYNTH.forEach((code, i) => {
    const base = 20 + (i + 1) * 6;
    const records = [
      rec('2016-01-01', '2018-12-31', base.toFixed(2)),
      rec('2019-01-01', '2019-12-31', '20.00', {
        eventType: 'decrease', previousPrice: base, absoluteChange: 20 - base, percentChange: Number((((20 - base) / base) * 100).toFixed(2)),
      }),
      rec('2020-01-01', i === 3 ? '2027-12-31' : null, (base - 4).toFixed(2), {
        eventType: 'increase', previousPrice: 20, absoluteChange: base - 24, percentChange: Number((((base - 24) / 20) * 100).toFixed(2)),
      }),
    ];
    if (i === 3) {
      records.push(rec('2028-01-01', null, (base - 9).toFixed(2), {      // 預告區間（起日在未來）
        eventType: 'decrease', previousPrice: base - 4, absoluteChange: -5, percentChange: -20,
      }));
    }
    drugs[code] = {
      meta: {
        chName: `合成比較藥${i + 1}`, enName: `SYNTH COMPARE ${i + 1}`, ingredient: 'SYNTHETICINE',
        strength: '10', strengthUnit: 'MG', compound: '', manufacturer: '合成藥廠', maker: '',
        dosageForm: '錠劑', drugClass: '', groupName: '', atcCode: 'Z01ZZ01', ruleChapter: '',
        tfdaLink: '', nhiRuleLink: '',
      },
      records,
      invalidRecords: [],
      flags: [],
    };
  });
  return { drugs };
}

function buildSynthetic() {
  const shard = syntheticShard();
  const body = JSON.stringify(shard);
  const shardVersion = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const withVersion = { shardVersion, drugs: shard.drugs };
  const dataVersion = `sha256:${createHash('sha256').update(JSON.stringify(withVersion)).digest('hex')}`;
  const meta = {
    dataVersion,
    generatedAt: `${TODAY}T00:00:00+08:00`,
    source: 'SYNTHETIC (compare review)',
    shards: { prefixLength: 4, files: ['ZZ00'], versions: { ZZ00: shardVersion } },
    sourceRowCount: SYNTH.length * 3, uniqueDrugCodeCount: SYNTH.length, recordCount: SYNTH.length * 3,
    coverageStart: '2016-01-01', coverageEnd: '2028-01-01',
  };
  const drugs = SYNTH.map((code) => ({
    code,
    chName: withVersion.drugs[code].meta.chName,
    enName: withVersion.drugs[code].meta.enName,
    ingredient: 'SYNTHETICINE', strength: '10', strengthUnit: 'MG', dosageForm: '錠劑',
    atcCode: 'Z01ZZ01', manufacturer: '合成藥廠',
    window: [], historyCount: withVersion.drugs[code].records.length, priceChangeCount: 2,
    firstEffectiveDate: '2016-01-01', lastPriceChangeDate: '2020-01-01', flags: [],
  }));
  return {
    'data/meta.json': meta,
    'data/drug_index.json': { dataVersion, drugs },
    'data/status.json': { lastCheckedAt: `${TODAY}T02:00:00+08:00`, lastCheckResult: 'unchanged', dataVersion, sourceModifiedAt: null },
    'data/history/ZZ00.json': withVersion,
  };
}

function serve(port, overrides, label, codes) {
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
    } catch { res.writeHead(404); res.end('not found'); }
  }).listen(port, '127.0.0.1', () => {
    console.log(`${label}\n  http://127.0.0.1:${port}/?codes=${codes.join(',')}`);
  });
}

serve(8768, {}, '真實四碼（空窗／終止後恢復／暫停後終止／首列 0 元）', REAL);
serve(8769, buildSynthetic(), '合成情境（四條線 2019 整年完全重合；第 4 碼帶 2028 預告）', SYNTH);
console.log(`
目檢項目（§9.3）：
  1. 四代號完整畫面：無 §7 禁止用語（較便宜／較貴／性價比／可替代／等效／建議改用）
  2. 移除一碼再重新加入：序位與顏色不重新洗牌
  3. 含預告的代號（8769 第 4 碼）：預告以不透明度表示、線型仍代表序位
  4. 四條線完全重合（8769 的 2019 年）：仍能透過圖例、band 與 tooltip 分辨
  5. 手機觸控：點擊定位 crosshair、再點空白處取消（DevTools 裝置模擬）
  6. 色盲模擬（deuteranopia／protanopia／tritanopia）下四條線仍可區分
Ctrl+C 結束`);
