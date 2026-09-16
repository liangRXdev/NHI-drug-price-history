// U4／U15：預告列的呈現決策表（spec-upcoming §4.1）與合法性判準（§5.5.1）。
//
// §9.1 實測：未生效 terminated 的 everPriced=false 共 0 列、missing／malformed／
// 衝突六類零實例，序 1–3、序 4、序 7–11、序 14 在真實資料裡不會自然出現，
// 一律以合成反例逐條驗，不得以「掃完 82 列」代替。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  upcomingDecision, validateUpcoming, upcomingPendingCount, UPCOMING_GENERATOR_VERSION,
  upcomingParams, upcomingModel, upcomingCSV, csvField, UPCOMING_CSV_HEADER, isCalendarDate,
} from '../engine.js';

const front = JSON.parse(readFileSync(new URL('../tests/fixtures/golden_frontend_2026-09-11.json', import.meta.url), 'utf8'));

const item = (o) => ({
  code: 'T000000100', chName: '測試藥', enName: 'TEST', ingredient: '', strength: '',
  strengthUnit: '', dosageForm: '', atcCode: '', manufacturer: '',
  effectiveDate: '2026-10-01', endDate: null, eventType: 'initial', priceState: 'terminated',
  price: null, rawPrice: '0.00', previousPrice: null, pricedBefore: null, previousState: null,
  absoluteChange: null, percentChange: null, crossesStop: false, everPriced: false, flags: [],
  ...o,
});

// §4.1 的 14 個序號，每個都有合成案例與精確字串
const CASES = [
  [1, item({ priceState: 'priced', price: 12.5, rawPrice: '12.50', eventType: 'increase', everPriced: true, pricedBefore: 6.9, previousPrice: 6.9, previousState: 'priced', flags: ['conflicting_price_interval'] }),
    { label: '無法判定', sub: '來源資料異常，請開啟詳細頁確認', type: 'other' }],
  [1, item({ priceState: 'priced', price: 12.5, rawPrice: '12.50', eventType: 'unknown', everPriced: true, pricedBefore: 6.9, previousState: 'priced' }),
    { label: '無法判定', sub: '來源資料異常，請開啟詳細頁確認', type: 'other' }],
  [2, item({ priceState: 'malformed', rawPrice: 'N/A', eventType: 'initial' }),
    { label: '資料格式異常', sub: '2026-10-01 起（原始值：N/A）', type: 'other' }],
  [3, item({ priceState: 'missing', rawPrice: '', eventType: 'initial' }),
    { label: '來源無支付價資料', sub: '2026-10-01 起；請開啟詳細頁確認', type: 'other' }],
  // 序 4 的三種 eventType：首列 0 元、0 元續期、暫停後轉 0 元（皆未曾有價）
  [4, item({ eventType: 'initial' }),
    { label: '健保支付價 0 元', sub: '2026-10-01 起（此前無有價紀錄）', type: 'first_priced' }],
  [4, item({ eventType: 'unchanged', previousState: 'terminated' }),
    { label: '健保支付價 0 元', sub: '2026-10-01 起（此前無有價紀錄）', type: 'first_priced' }],
  [4, item({ eventType: 'terminated', previousState: 'suspended' }),
    { label: '健保支付價 0 元', sub: '2026-10-01 起（此前無有價紀錄）', type: 'first_priced' }],
  [5, item({ eventType: 'unchanged', previousState: 'terminated', everPriced: true, pricedBefore: 245 }),
    { label: '終止支付續期', sub: '2026-10-01 起仍為 0 元；終止前 245.00 元', type: 'terminated' }],
  [6, item({ eventType: 'terminated', previousState: 'priced', everPriced: true, pricedBefore: 245, previousPrice: 245 }),
    { label: '終止支付', sub: '2026-10-01 起；終止前 245.00 元', type: 'terminated' }],
  [7, item({ priceState: 'suspended', rawPrice: '-', eventType: 'initial' }),
    { label: '暫停支付', sub: '2026-10-01 起（此前無有價紀錄，來源標示「-」）', type: 'first_priced' }],
  [8, item({ priceState: 'suspended', rawPrice: '－', eventType: 'unchanged', previousState: 'suspended', everPriced: true, pricedBefore: 18 }),
    { label: '暫停支付續期', sub: '2026-10-01 起仍為暫停；暫停前 18.00 元', type: 'suspended' }],
  [9, item({ priceState: 'suspended', rawPrice: '—', eventType: 'suspended', previousState: 'priced', everPriced: true, pricedBefore: 18, previousPrice: 18 }),
    { label: '暫停支付', sub: '2026-10-01 起；暫停前 18.00 元（來源標示「—」）', type: 'suspended' }],
  [10, item({ priceState: 'priced', price: 12.5, rawPrice: '12.50', eventType: 'first_priced' }),
    { label: '首次有價', sub: '2026-10-01 起 12.50 元', type: 'first_priced' }],
  [11, item({ priceState: 'priced', price: 22.9, rawPrice: '22.90', eventType: 'relisted', previousState: 'terminated', everPriced: true, pricedBefore: 29.8, previousPrice: 29.8, absoluteChange: -6.9, percentChange: -23.15, crossesStop: true }),
    { label: '恢復支付', sub: '2026-10-01 起 29.80 → 22.90 元（−6.90 元，−23.15%，跨越停止期間）', type: 'relisted' }],
  [12, item({ priceState: 'priced', price: 94, rawPrice: '94.00', eventType: 'unchanged', previousState: 'priced', everPriced: true, pricedBefore: 94, previousPrice: 94 }),
    { label: '續期（支付價不變）', sub: '2026-10-01 起 94.00 元，與前期相同', type: 'unchanged' }],
  [13, item({ priceState: 'priced', price: 7.9, rawPrice: '7.90', eventType: 'increase', previousState: 'priced', everPriced: true, pricedBefore: 6.9, previousPrice: 6.9, absoluteChange: 1, percentChange: 14.49 }),
    { label: '調升', sub: '2026-10-01 起 6.90 → 7.90 元（+14.49%）', type: 'increase' }],
  [13, item({ priceState: 'priced', price: 6.9, rawPrice: '6.90', eventType: 'decrease', previousState: 'priced', everPriced: true, pricedBefore: 7.9, previousPrice: 7.9, absoluteChange: -1, percentChange: -12.66 }),
    { label: '調降', sub: '2026-10-01 起 7.90 → 6.90 元（−12.66%）', type: 'decrease' }],
  // 序 14 安全網：priced 但前一筆是 missing，事件卻標成確定的 increase（來源異常組合）
  [14, item({ priceState: 'priced', price: 12.5, rawPrice: '12.50', eventType: 'increase', previousState: 'missing', everPriced: true, pricedBefore: 6.9 }),
    { label: '無法判定', sub: '來源資料異常，請開啟詳細頁確認', type: 'other' }],
];

for (const [rule, it, expected] of CASES) {
  test(`U4 序 ${rule}：${expected.label}（${it.priceState}／${it.eventType}）`, () => {
    assert.deepEqual(upcomingDecision(it), { rule, ...expected });
  });
}

test('U4 §4.1 的 14 個序號每個都有案例', () => {
  assert.deepEqual([...new Set(CASES.map(([r]) => r))].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test('U4 everPriced=false 的 0 元列不得出現「終止」字樣；曾有價者必須出現', () => {
  for (const [rule, it, expected] of CASES) {
    if (rule === 4) assert.ok(!`${expected.label}${expected.sub}`.includes('終止'), `序 4 出現「終止」：${expected.label}`);
  }
  const positive = CASES.filter(([r]) => r === 5 || r === 6);
  assert.equal(positive.length, 2);
  for (const [, , expected] of positive) assert.ok(expected.label.includes('終止'));
});

test('U4 續期必須顯示停止前金額；恢復支付必須顯示差額百分比', () => {
  const sub = (rule) => CASES.find(([r]) => r === rule)[2].sub;
  assert.match(sub(5), /終止前 245\.00 元/);
  assert.match(sub(8), /暫停前 18\.00 元/);
  // §4.2／U4：差額與百分比兩者都要出現，只有百分比不算數
  assert.match(sub(11), /29\.80 → 22\.90 元（−6\.90 元，−23\.15%，跨越停止期間）/);
});

test('U4 序 1／2／3／14 不得顯示為確定的價格事件', () => {
  for (const [rule, , expected] of CASES) {
    if ([1, 2, 3, 14].includes(rule)) {
      assert.equal(expected.type, 'other');
      assert.ok(!/調升|調降|終止支付|恢復支付|續期/.test(expected.label), expected.label);
    }
  }
});

test('U4 暫停標記逐字顯示三種來源值，不得寫死「-」', () => {
  const marks = CASES.filter(([r]) => r === 7 || r === 9).map(([, it]) => it.rawPrice);
  assert.deepEqual(marks, ['-', '—']);
  for (const [, it, expected] of CASES.filter(([r]) => r === 7 || r === 9)) {
    assert.ok(expected.sub.includes(`「${it.rawPrice}」`), expected.sub);
  }
  const [, it8, exp8] = CASES.find(([r]) => r === 8);
  assert.equal(it8.rawPrice, '－');                 // 全形：續期副標不含原始標記，但資料須保真
  assert.ok(!exp8.sub.includes('－'));
});

// ── 真實案例正對照（凍結快照）────────────────────────────────────
test('U4 真實預告列：BC05037209 終止、AB47689100 調升', async () => {
  const byCode = Object.fromEntries(front.upcoming.items.map((it) => [it.code, it]));
  assert.deepEqual(upcomingDecision(byCode.BC05037209),
    { rule: 6, label: '終止支付', sub: '2026-10-01 起；終止前 245.00 元', type: 'terminated' });
  assert.deepEqual(upcomingDecision(byCode.AB47689100),
    { rule: 13, label: '調升', sub: '2026-10-01 起 6.90 → 7.90 元（+14.49%）', type: 'increase' });
});

// ── U15 合法性判準（§5.5.1）──────────────────────────────────────
const payload = (over = {}, mutate = null) => {
  const p = {
    dataVersion: 'sha256:x',
    generatorVersion: UPCOMING_GENERATOR_VERSION,
    buildDate: '2026-09-11',
    items: [item({ eventType: 'terminated', previousState: 'priced', everPriced: true, pricedBefore: 245, previousPrice: 245 })],
    ...over,
  };
  p.count ??= p.items.length;
  p.codeCount ??= new Set(p.items.map((x) => x.code)).size;
  if (mutate) mutate(p);
  return p;
};
const META = { dataVersion: 'sha256:x' };

test('U15 合法輸入通過', () => {
  assert.deepEqual(validateUpcoming(payload(), META), { ok: true });
  assert.deepEqual(validateUpcoming({ ...front.upcoming, dataVersion: 'sha256:x' }, META), { ok: true });
});

test('U15 合法缺值：只有未來列的代號描述欄位為 null，不得判為損毀', () => {
  const p = payload({ items: [item({ chName: null, enName: null, ingredient: null, strength: null, strengthUnit: null, dosageForm: null, atcCode: null, manufacturer: null })] });
  assert.deepEqual(validateUpcoming(p, META), { ok: true });
});

for (const [name, mutate, reason] of [
  ['priced 但 price 為 null', (p) => { p.items[0] = item({ priceState: 'priced', price: null, rawPrice: '12.50' }); }, 'invalid'],
  ['terminated 但 price 為正數', (p) => { p.items[0].price = 12.5; }, 'invalid'],
  ['everPriced 與 pricedBefore 不一致', (p) => { p.items[0].everPriced = false; }, 'invalid'],
  ['pricedBefore 與 everPriced 不一致', (p) => { p.items[0].pricedBefore = null; }, 'invalid'],
  ['描述欄位省略鍵', (p) => { delete p.items[0].chName; }, 'invalid'],
  ['可為 null 的欄位省略鍵', (p) => { delete p.items[0].pricedBefore; }, 'invalid'],
  ['priceState 非列舉值', (p) => { p.items[0].priceState = 'unknown'; }, 'invalid'],
  ['eventType 非列舉值', (p) => { p.items[0].eventType = 'bumped'; }, 'invalid'],
  ['rawPrice 非字串', (p) => { p.items[0].rawPrice = 0; }, 'invalid'],
  ['flags 非陣列', (p) => { p.items[0].flags = 'none'; }, 'invalid'],
  ['effectiveDate 不晚於 buildDate', (p) => { p.items[0].effectiveDate = '2026-09-11'; }, 'invalid'],
  ['endDate 早於 effectiveDate', (p) => { p.items[0].endDate = '2026-09-30'; }, 'invalid'],
  ['count 與 items 不符', (p) => { p.count = 99; }, 'invalid'],
  ['codeCount 與相異代號數不符', (p) => { p.codeCount = 99; }, 'invalid'],
  ['buildDate 非合法日期', (p) => { p.buildDate = '2026-13-01'; p.items = []; p.count = 0; p.codeCount = 0; }, 'invalid'],
  ['items 不是陣列', (p) => { p.items = {}; }, 'invalid'],
  ['generatorVersion 不符', (p) => { p.generatorVersion = 'upcoming/0'; }, 'version_mismatch'],
  ['dataVersion 不符', (p) => { p.dataVersion = 'sha256:old'; }, 'version_mismatch'],
]) {
  test(`U15 拒絕：${name}`, () => {
    assert.deepEqual(validateUpcoming(payload({}, mutate), META), { ok: false, reason });
  });
}

test('U15 meta 不可用時不得通過驗證', () => {
  assert.deepEqual(validateUpcoming(payload(), null), { ok: false, reason: 'version_mismatch' });
});

test('徽章數字只算仍未生效的列', () => {
  const items = [item({ effectiveDate: '2026-10-01' }), item({ effectiveDate: '2026-11-01' })];
  assert.equal(upcomingPendingCount(items, '2026-09-11'), 2);
  assert.equal(upcomingPendingCount(items, '2026-10-01'), 1);
  assert.equal(upcomingPendingCount(items, '2026-11-02'), 0);
});

// ── U12 CSV 匯出（§5.4）─────────────────────────────────────────
/** 最小 RFC 4180 解析器：驗匯出的是可正確解回的檔案，不是「看起來像 CSV」。 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const CSV_ITEMS = [
  item({ code: 'Q000000001', chName: '含,逗號與"引號"的品名', enName: 'LINE1\nLINE2',
    ingredient: '', strength: '10', strengthUnit: 'MG', dosageForm: '錠劑', atcCode: 'A01AA01',
    manufacturer: '測試藥廠', effectiveDate: '2026-10-01', priceState: 'priced', price: 12.5,
    rawPrice: '12.50', previousPrice: 10, pricedBefore: 10, previousState: 'priced',
    everPriced: true, eventType: 'increase', absoluteChange: 2.5, percentChange: 25 }),
  item({ code: 'Q000000002', chName: '零元藥', effectiveDate: '2026-10-01', rawPrice: '0.00',
    eventType: 'terminated', previousState: 'priced', everPriced: true, pricedBefore: 245,
    previousPrice: 245, flags: ['inconsistent_metadata'] }),
  item({ code: 'Q000000003', chName: '暫停藥半形', effectiveDate: '2026-11-01', priceState: 'suspended',
    rawPrice: '-', eventType: 'suspended', previousState: 'priced', everPriced: true,
    pricedBefore: 18, previousPrice: 18 }),
  item({ code: 'Q000000004', chName: '暫停藥全形', effectiveDate: '2026-11-01', priceState: 'suspended',
    rawPrice: '－', eventType: 'unchanged', previousState: 'suspended', everPriced: true, pricedBefore: 18 }),
  item({ code: 'Q000000005', chName: '暫停藥破折號', effectiveDate: '2026-11-01', priceState: 'suspended',
    rawPrice: '—', eventType: 'unchanged', previousState: 'suspended', everPriced: true, pricedBefore: 18 }),
  item({ code: 'Q000000006', chName: null, enName: null, ingredient: null, strength: null,
    strengthUnit: null, dosageForm: null, atcCode: null, manufacturer: null,
    effectiveDate: '2026-12-01', rawPrice: '', priceState: 'missing', eventType: 'initial' }),
];

const csvOf = (search = '', today = '2026-09-11') => {
  const params = upcomingParams(search, CSV_ITEMS);
  const model = upcomingModel(CSV_ITEMS, params);
  return { text: upcomingCSV(model.rows, { buildDate: '2026-09-11', params, today }), model, params };
};

test('U12 檔案結構：BOM、前言一行、標頭一行，資料列與篩選結果逐列對應', () => {
  const { text, model } = csvOf();
  assert.ok(text.startsWith('﻿'), '缺 BOM');
  const rows = parseCSV(text.slice(1));
  assert.equal(rows.length, model.rows.length + 2);
  assert.match(rows[0][0], /^健保藥價歷史查詢 — 預告清單匯出。/);
  assert.equal(rows[0].length, 1);
  assert.deepEqual(rows[1], UPCOMING_CSV_HEADER);

  const data = rows.slice(2);
  assert.deepEqual(data.map((r) => r[1]), model.rows.map((r) => r.it.code));      // 順序與重數
  assert.deepEqual(data.map((r) => r[0]), model.rows.map((r) => r.it.effectiveDate));
  assert.deepEqual(data.map((r) => r[9]), model.rows.map((r) => r.dec.label));
  assert.deepEqual(data.map((r) => r[14]), model.rows.map((r) => r.it.rawPrice));
});

test('U12 原始支付價字串逐字保真（12.50 不變 12.5、0.00 不變 0、三種暫停標記）', () => {
  const data = parseCSV(csvOf().text.slice(1)).slice(2);
  assert.deepEqual(data.map((r) => r[14]), ['12.50', '0.00', '-', '－', '—', '']);
});

test('U12 逗號、引號、換行、中文依 RFC 4180 跳脫且可解回原值', () => {
  const data = parseCSV(csvOf().text.slice(1)).slice(2);
  assert.equal(data[0][2], '含,逗號與"引號"的品名');
  assert.equal(data[0][3], 'LINE1\nLINE2');
  assert.ok(csvOf().text.includes('"含,逗號與""引號""的品名"'));
  assert.equal(data[1][2], '零元藥');
});

test('U12 空值輸出空欄；金額欄位 2 位小數', () => {
  const data = parseCSV(csvOf().text.slice(1)).slice(2);
  assert.deepEqual(data[5].slice(2, 9), ['', '', '', '', '', '', '']);   // 描述欄位為 null
  assert.deepEqual(data[0].slice(10, 14), ['10.00', '12.50', '2.50', '25.00']);
  assert.deepEqual(data[1].slice(10, 14), ['245.00', '', '', '']);       // 終止：無新價與差額
});

test('U12 備註欄帶到期標示與品質提示', () => {
  const data = parseCSV(csvOf('', '2026-10-15').text.slice(1)).slice(2);
  assert.equal(data[0][15], '已生效（本站資料尚未重建）');
  assert.equal(data[1][15], '已生效（本站資料尚未重建）；描述欄位不一致');
  assert.equal(data[2][15], '');
});

test('U12 匯出的是篩選後的結果，前言記錄篩選條件', () => {
  const { text } = csvOf('?type=suspended');
  const rows = parseCSV(text.slice(1));
  assert.deepEqual(rows.slice(2).map((r) => r[1]), ['Q000000003', 'Q000000004', 'Q000000005']);
  assert.match(rows[0][0], /篩選條件：事件型別＝暫停支付/);
});

test('U12 更新失敗時前言註明沿用舊快照', () => {
  const params = upcomingParams('', CSV_ITEMS);
  const text = upcomingCSV(upcomingModel(CSV_ITEMS, params).rows,
    { buildDate: '2026-09-11', params, today: '2026-09-20', staleNote: '更新失敗，本檔沿用 2026-09-11 的資料' });
  assert.match(parseCSV(text.slice(1))[0][0], /更新失敗，本檔沿用 2026-09-11 的資料。/);
});

test('csvField 只在必要時加引號', () => {
  assert.equal(csvField('12.50'), '12.50');
  assert.equal(csvField(null), '');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('a"b'), '"a""b"');
  assert.equal(csvField('a\r\nb'), '"a\r\nb"');
});

// ── 日期合法性：與 Python validator 共用同一組案例（R4／T1）────────
const DATE_CASES = JSON.parse(readFileSync(new URL('../tests/fixtures/dates.json', import.meta.url), 'utf8'));

test('R4 日期驗證只接受真實日曆日，與 Python 端同判定', () => {
  for (const v of DATE_CASES.legal) assert.equal(isCalendarDate(v), true, v);
  for (const v of DATE_CASES.illegal) assert.equal(isCalendarDate(v), false, v);
});

for (const v of DATE_CASES.illegal) {
  test(`T1 拒絕非法 effectiveDate：${JSON.stringify(v)}`, () => {
    // 生效日改成非法值，但 buildDate 維持 2026-09-11：若只比字串大小，
    // '2027-02-30' > '2026-09-11' 會通過——必須是日曆驗證擋下來的
    const p = payload({}, (x) => { x.items[0].effectiveDate = v; });
    assert.deepEqual(validateUpcoming(p, META), { ok: false, reason: 'invalid' });
  });

  test(`T1 拒絕非法 buildDate：${JSON.stringify(v)}`, () => {
    const p = payload({ items: [] }, (x) => { x.buildDate = v; });
    assert.deepEqual(validateUpcoming(p, META), { ok: false, reason: 'invalid' });
  });
}

test('T1 反向哨兵：合法但晚於 buildDate 的日期仍須通過', () => {
  const p = payload({}, (x) => { x.items[0].effectiveDate = '2028-02-29'; });
  assert.deepEqual(validateUpcoming(p, META), { ok: true });
});
