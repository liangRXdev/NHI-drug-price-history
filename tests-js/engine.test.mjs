// C1–C4、C2、E1–E2、E6 的純邏輯斷言（plan.md §5）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chartModel, currentLabel, dayNumber, decimalChange, INDEX_FIELDS, INDEX_FORMAT, INDEX_WINDOW_FIELDS,
  IndexShapeError, isEffective, latestEventLabel, MAX_RESULTS, prepareIndex,
  priorPrices, search, searchCard, selectMeta, shardPrefix, staleness, stateLabel, summaryAt, terminatedMask, totalChangeLabel,
  upcomingLabel, validateIndex, validateMeta, validateShard,
} from '../engine.js';

// 手工 record（欄位同 shard；事件依 spec §5.4 由呼叫端給定）
function rec(from, to, rawPrice, eventType, extra = {}) {
  const n = Number(rawPrice);
  let priceState = 'malformed';
  if (rawPrice === '') priceState = 'missing';
  else if (['-', '－', '—'].includes(rawPrice)) priceState = 'suspended';
  else if (n === 0) priceState = 'terminated';
  else if (n > 0) priceState = 'priced';
  return {
    from, to, rawPrice, priceState, price: priceState === 'priced' ? n : null, eventType,
    previousPrice: null, absoluteChange: null, percentChange: null, crossesStop: false, flags: [], ...extra,
  };
}
const win = (r, pricedBefore, flags = r.flags) => ({ ...r, pricedBefore, flags });

/**
 * 測試用：把簡化的 drug 物件補齊 mandatory 欄位後轉成 columnar/1。
 *
 * 這些測試關心的是搜尋與篩選**行為**，不是表示法本身——表示法的正確性由
 * scripts/verify_equivalence.mjs（F1／F2）與轉換器自檢（F4）負責。
 * 補齊用的預設值只求通過型別驗證，不代表真實資料分布。
 */
function asColumnar(drugs) {
  const D = {
    code: '', chName: '', enName: '', ingredient: '', dosageForm: '', strength: '',
    strengthUnit: '', atcCode: '', manufacturer: '', firstEffectiveDate: '2020-01-01',
    lastPriceChangeDate: null, historyCount: 0, priceChangeCount: 0, flags: [],
  };
  const W = {
    from: '2020-01-01', to: null, price: null, rawPrice: '', previousPrice: null,
    pricedBefore: null, priceState: 'missing', eventType: 'initial', crossesStop: false,
    changeFlag: '', absoluteChange: null, percentChange: null, flags: [],
  };
  const rows = drugs.map((d0) => {
    const d = { ...D, ...d0 };
    const w = (d0.window || []).map((r0) => {
      const r = { ...W, ...r0 };
      return INDEX_WINDOW_FIELDS.map((k) => r[k]);
    });
    return [...INDEX_FIELDS.map((k) => d[k]), w];
  });
  return {
    dataVersion: 'sha256:test', indexFormat: INDEX_FORMAT,
    fields: [...INDEX_FIELDS], windowFields: [...INDEX_WINDOW_FIELDS], rows,
  };
}

/** prepared 的第 i 筆代號——columnar 下沒有 prepared.drugs 陣列可直接取 */
const codeAt = (p, i) => p.drugAt(i).code;

// 依 spec §5.1（lib/history.py build_window）由完整 history 組 build 日 D 的 window，
// 讓搜尋卡與詳細頁吃同一份 history，測試「build 後日期移動」的情境。
function windowAt(records, D) {
  const priors = priorPrices(records);
  const current = records.filter((r) => isEffective(r, D));
  const upcoming = records.find((r) => r.from > D);
  const w = [];
  if (current.length) w.push({ ...current[0], pricedBefore: priors.get(current[0]), flags: current.length > 1 ? [...current[0].flags, 'conflict'] : current[0].flags });
  if (upcoming) w.push({ ...upcoming, pricedBefore: priors.get(upcoming) });
  return { window: w };
}

// ── C1 現行價判定（合成案例）─────────────────────────────────────
test('C1 priced 10 → 預告 priced 8：前一天顯示 10 與調整標籤', () => {
  const recs = [
    rec('2020-01-01', '2026-09-30', '10.00', 'initial'),
    rec('2026-10-01', null, '8.00', 'decrease', { previousPrice: 10, absoluteChange: -2, percentChange: -20 }),
  ];
  const s = summaryAt(recs, '2026-09-30');
  assert.equal(currentLabel(s), '10.00 元');
  assert.equal(upcomingLabel(s.upcoming, 10), '2026-10-01 起調整為 8.00 元（−20.00%）');
  const card = searchCard({ window: [win(recs[0], null), win(recs[1], 10)] }, '2026-09-30');
  assert.equal(card.text, '10.00 元');
  assert.equal(card.upcoming, '2026-10-01 起調整為 8.00 元（−20.00%）');
  assert.equal(searchCard({ window: [win(recs[0], null), win(recs[1], 10)] }, '2026-10-01').rawPrice, '8.00');
});

test('C1 terminated（終止前 10）→ 預告 relisted 20：終止前價格不得為 20', () => {
  const recs = [
    rec('2020-01-01', '2024-12-31', '10.00', 'initial'),
    rec('2025-01-01', '2026-09-30', '0.00', 'terminated', { previousPrice: 10 }),
    rec('2026-10-01', null, '20.00', 'relisted', { previousPrice: 10, absoluteChange: 10, percentChange: 100, crossesStop: true }),
  ];
  const s = summaryAt(recs, '2026-09-30');
  assert.equal(currentLabel(s), '已終止支付（終止前 10.00 元）');
  assert.equal(upcomingLabel(s.upcoming, 10), '2026-10-01 起恢復支付 20.00 元');
  const card = searchCard({ window: [win(recs[1], 10), win(recs[2], 10)] }, '2026-09-30');
  assert.equal(card.text, '已終止支付（終止前 10.00 元）');
  assert.equal(card.upcoming, '2026-10-01 起恢復支付 20.00 元');
});

test('C1 suspended → priced；空窗日期', () => {
  const recs = [
    rec('2020-01-01', '2020-12-31', '10.00', 'initial'),
    rec('2021-01-01', '2021-06-30', '-', 'suspended', { previousPrice: 10 }),
    rec('2022-01-01', null, '9.00', 'relisted', { previousPrice: 10, flags: ['gap_before'] }),
  ];
  assert.equal(currentLabel(summaryAt(recs, '2021-03-01')), '暫停支付（來源標示 -），暫停前 10.00 元');
  assert.equal(currentLabel(summaryAt(recs, '2021-09-01')), '此日期無支付紀錄（空窗）');
  assert.equal(currentLabel(summaryAt(recs, '2022-01-01')), '9.00 元');
  const w = { window: [win(recs[1], 10), win(recs[2], 10)] };
  assert.equal(searchCard(w, '2021-09-01').kind, 'gap');
  assert.equal(searchCard(w, '2021-09-01').text, '此日期無支付紀錄（空窗）');
});

test('C1 window 耗盡：搜尋卡不顯示任何確定價格；詳細頁仍正確', () => {
  const recs = [
    rec('2020-01-01', '2026-09-30', '10.00', 'initial'),
    rec('2026-10-01', '2026-12-31', '8.00', 'decrease', { previousPrice: 10, percentChange: -20 }),
    rec('2027-01-01', null, '7.00', 'decrease', { previousPrice: 8, percentChange: -12.5 }),
  ];
  const w = { window: [win(recs[0], null), win(recs[1], 10)] };   // build 日 2026-09-11 的 window
  const card = searchCard(w, '2027-01-01');
  assert.equal(card.kind, 'exhausted');
  assert.equal(card.text, '需更新，請開啟詳細頁');
  assert.equal(card.rawPrice, null);
  assert.equal(card.upcoming, null);
  assert.ok(!/\d+\.\d{2} 元/.test(card.text));
  assert.equal(summaryAt(recs, '2027-01-01').current.rawPrice, '7.00');
});

test('C1 衝突、尚未生效、空 window', () => {
  const a = rec('2026-01-01', null, '10.00', 'initial');
  assert.equal(searchCard({ window: [win(a, null, ['conflict'])] }, '2026-09-11').kind, 'conflict');
  const future = rec('2026-10-01', null, '10.00', 'initial');
  const c = searchCard({ window: [win(future, null)] }, '2026-09-11');
  assert.equal(c.kind, 'not_yet');
  assert.equal(c.upcoming, '2026-10-01 起支付 10.00 元');
  assert.equal(searchCard({ window: [] }, '2026-09-11').text, '目前無有效支付紀錄');
  const recs = [a, { ...rec('2026-01-01', null, '12.00', 'unknown'), flags: ['conflicting_price_interval'] }];
  const s = summaryAt(recs, '2026-09-11');
  assert.equal(s.status, 'conflict');
  assert.equal(currentLabel(s), '來源紀錄衝突，無法判定單一支付價');
  assert.equal(s.currentCandidates.length, 2);
});

test('§5.3 首列 0 元：預告終止若此前從未有價，不得出現「終止」', () => {
  const u = rec('2026-10-01', null, '0.00', 'unchanged');
  assert.ok(!upcomingLabel(u, null).includes('終止'));
  assert.equal(stateLabel(rec('1995-03-01', null, '0.00', 'initial'), null), '健保支付價 0 元（此前無有價紀錄）');
  assert.equal(stateLabel(rec('2020-01-01', null, '0.00', 'terminated'), 5, 'cell'), '健保支付價 0 元（已終止支付）');
});

// ── C1 三日 × 搜尋卡／詳細頁矩陣（window 由 history 以 build 日組成）──────
const DAYS = ['2026-09-30', '2026-10-01', '2026-10-02'];
const BUILD = '2026-09-11';

function matrix(records, expectCard, expectDetail) {
  const w = windowAt(records, BUILD);
  DAYS.forEach((T, i) => {
    const card = searchCard(w, T);
    const s = summaryAt(records, T);
    assert.equal(card.text, expectCard[i], `搜尋卡 @${T}`);
    assert.equal(currentLabel(s), expectDetail[i], `詳細頁 @${T}`);
  });
}

test('C1 矩陣：終止（終止前 10）→ 預告恢復支付 20', () => {
  matrix([
    rec('2020-01-01', '2024-12-31', '10.00', 'initial'),
    rec('2025-01-01', '2026-09-30', '0.00', 'terminated', { previousPrice: 10 }),
    rec('2026-10-01', null, '20.00', 'relisted', { previousPrice: 10, percentChange: 100, crossesStop: true }),
  ],
  ['已終止支付（終止前 10.00 元）', '20.00 元', '20.00 元'],
  ['已終止支付（終止前 10.00 元）', '20.00 元', '20.00 元']);
});

test('C1 矩陣：暫停 → 預告有價', () => {
  matrix([
    rec('2020-01-01', '2024-12-31', '10.00', 'initial'),
    rec('2025-01-01', '2026-09-30', '-', 'suspended', { previousPrice: 10 }),
    rec('2026-10-01', null, '9.00', 'relisted', { previousPrice: 10, percentChange: -10, crossesStop: true }),
  ],
  ['暫停支付（來源標示 -），暫停前 10.00 元', '9.00 元', '9.00 元'],
  ['暫停支付（來源標示 -），暫停前 10.00 元', '9.00 元', '9.00 元']);
});

test('C1 矩陣：預告前一天起為空窗', () => {
  matrix([
    rec('2020-01-01', '2026-09-29', '10.00', 'initial'),
    rec('2026-10-02', null, '9.00', 'decrease', { previousPrice: 10, percentChange: -10, flags: ['gap_before'] }),
  ],
  ['此日期無支付紀錄（空窗）', '此日期無支付紀錄（空窗）', '9.00 元'],
  ['此日期無支付紀錄（空窗）', '此日期無支付紀錄（空窗）', '9.00 元']);
});

// ── codex R2：build 時單筆、T 跨入重疊 ──────────────────────────────
test('R2 build 後預告生效又與無迄日現行重疊：搜尋卡不得報單一價格，與詳細頁一致', () => {
  const recs = [
    rec('2020-01-01', null, '10.00', 'initial'),
    rec('2026-10-01', null, '0.00', 'unknown', { flags: ['overlap'] }),
  ];
  const w = windowAt(recs, BUILD);
  assert.equal(searchCard(w, '2026-09-30').rawPrice, '10.00');         // 生效前：單一現行
  for (const T of ['2026-10-01', '2026-10-02']) {
    const card = searchCard(w, T);
    assert.equal(card.kind, 'conflict', T);
    assert.equal(card.rawPrice, null, T);
    assert.equal(card.text, '來源紀錄衝突，無法判定單一支付價', T);
    assert.equal(summaryAt(recs, T).status, 'conflict', T);
  }
});

test('R2 兩筆 window 同日有效、皆無 flag（僅靠有效筆數判定）→ 衝突', () => {
  const w = { window: [
    win(rec('2020-01-01', null, '10.00', 'initial'), null, []),
    win(rec('2026-10-01', null, '8.00', 'decrease'), 10, []),
  ] };
  assert.equal(searchCard(w, '2026-09-30').rawPrice, '10.00');
  const c = searchCard(w, '2026-10-01');
  assert.equal(c.kind, 'conflict');
  assert.equal(c.text, '來源紀錄衝突，無法判定單一支付價');
  assert.equal(c.rawPrice, null);
});

test('R2 單筆有效但帶 overlap／conflicting_price_interval → 不給確定價格', () => {
  const a = rec('2026-01-01', null, '10.00', 'unknown');
  const o = searchCard({ window: [win({ ...a, flags: ['overlap'] }, null)] }, '2026-09-11');
  assert.equal(o.kind, 'conflict');
  assert.equal(o.text, '來源紀錄區間重疊，請開啟詳細頁確認');
  assert.equal(o.rawPrice, null);
  const c = searchCard({ window: [win({ ...a, flags: ['conflicting_price_interval'] }, null)] }, '2026-09-11');
  assert.equal(c.text, '來源紀錄衝突，無法判定單一支付價');
});

// ── codex R1：舊版 index 缺 pricedBefore ──────────────────────────
test('R1 非有價 window 列缺 pricedBefore → 需更新，不得顯示「— 元」或「終止」', () => {
  const stop = rec('2020-01-01', null, '0.00', 'unchanged');
  const card = searchCard({ window: [{ ...stop }] }, '2026-09-11');     // 無 pricedBefore 欄位
  assert.equal(card.kind, 'exhausted');
  assert.equal(card.text, '需更新，請開啟詳細頁');
  assert.ok(!card.text.includes('—'));
  // 有價列缺欄位不影響（價格本身不需要 pricedBefore）
  assert.equal(searchCard({ window: [{ ...rec('2020-01-01', null, '5.00', 'initial') }] }, '2026-09-11').rawPrice, '5.00');
});

// ── codex R3：首列 0 元例外擴及事件與圖表 ───────────────────────────
test('R3 暫停 → 0 元、此前從未有價：最新事件與圖表區塊皆不稱「終止」', () => {
  const recs = [
    rec('1995-03-01', '1996-12-31', '-', 'initial'),
    rec('1997-01-01', null, '0.00', 'terminated'),                     // previousPrice null：從未有價
  ];
  const s = summaryAt(recs, '2026-01-01');
  assert.equal(latestEventLabel(s.latestEvent), '健保支付價 0 元（此前無有價紀錄，1997-01-01 起）');
  assert.equal(currentLabel(s), '健保支付價 0 元（此前無有價紀錄）');
  assert.deepEqual(chartModel(recs, '2026-01-01').bands.map((b) => b.kind), ['suspended', 'unpriced_zero']);
  // 曾有價後的 0 元仍為一般終止區塊
  const later = [rec('1995-03-01', '1996-12-31', '5.00', 'initial'), rec('1997-01-01', null, '0.00', 'terminated', { previousPrice: 5 })];
  assert.deepEqual(chartModel(later, '2026-01-01').bands.map((b) => b.kind), ['terminated']);
});

// ── E1 總變化、E2 最新事件 ───────────────────────────────────────
test('E1 總變化以參考日前最後一筆有價為準，不用預告價', () => {
  const recs = [
    rec('2020-01-01', '2022-12-31', '30.00', 'initial'),
    rec('2023-01-01', '2026-09-30', '20.00', 'decrease', { previousPrice: 30 }),
    rec('2026-10-01', null, '25.00', 'increase', { previousPrice: 20 }),
  ];
  const s = summaryAt(recs, '2026-09-11');
  assert.equal(s.totalChange.absoluteChange, '-10.00');
  assert.equal(s.totalChange.percentChange, '-33.33');
  assert.equal(totalChangeLabel(s), '30.00 → 20.00 元（−10.00 元，−33.33%）');
});

test('E1 無有價／僅一筆／至終止前', () => {
  assert.equal(totalChangeLabel(summaryAt([rec('2020-01-01', null, '0.00', 'initial')], '2026-01-01')), '無有價紀錄');
  assert.equal(totalChangeLabel(summaryAt([rec('2020-01-01', null, '5.00', 'initial')], '2026-01-01')), '僅一筆有價紀錄');
  const recs = [
    rec('2020-01-01', '2020-12-31', '10.00', 'initial'),
    rec('2021-01-01', '2021-12-31', '8.00', 'decrease', { previousPrice: 10 }),
    rec('2022-01-01', null, '0.00', 'terminated', { previousPrice: 8 }),
  ];
  assert.match(totalChangeLabel(summaryAt(recs, '2026-01-01')), /至終止前/);
});

test('E2 最新事件：跳過 unchanged；terminated 取該事件 previousPrice；unknown；無調價', () => {
  const recs = [
    rec('2020-01-01', '2020-12-31', '10.00', 'initial'),
    rec('2021-01-01', '2021-12-31', '0.00', 'terminated', { previousPrice: 10 }),
    rec('2022-01-01', null, '0.00', 'unchanged'),
  ];
  const s = summaryAt(recs, '2026-01-01');
  assert.equal(s.latestEvent.from, '2021-01-01');
  assert.equal(latestEventLabel(s.latestEvent), '已終止支付（終止前 10.00 元，2021-01-01 起）');
  assert.equal(latestEventLabel(summaryAt([rec('2020-01-01', null, '10.00', 'initial')], '2026-01-01').latestEvent), '無調價紀錄');
  const unk = [rec('2020-01-01', '2020-12-31', '10.00', 'initial'), rec('2021-01-01', null, '', 'unknown')];
  assert.equal(latestEventLabel(summaryAt(unk, '2026-01-01').latestEvent), '最近一次變動無法判定（來源資料異常）');
  const fp = [rec('1995-03-01', '1998-02-28', '0.00', 'initial'), rec('1998-03-01', null, '34.00', 'first_priced')];
  assert.equal(latestEventLabel(summaryAt(fp, '2026-01-01').latestEvent), '無調價紀錄');
});

test('十進位差額：half away from zero、不受浮點誤差影響', () => {
  assert.deepEqual(decimalChange('3', '2'), { absoluteChange: '-1.00', percentChange: '-33.33' });
  assert.deepEqual(decimalChange('10', '12'), { absoluteChange: '2.00', percentChange: '20.00' });
  assert.deepEqual(decimalChange('0.30', '0.10'), { absoluteChange: '-0.20', percentChange: '-66.67' });
  assert.deepEqual(decimalChange('8', '9.001'), { absoluteChange: '1.00', percentChange: '12.51' });
  assert.equal(decimalChange('0.00', '1.00'), null);
});

test('R5 十進位語法與 Python Decimal 一致；任一值非正數 → null；失敗時明示', () => {
  assert.deepEqual(decimalChange('1e1', '2e1'), { absoluteChange: '10.00', percentChange: '100.00' });
  assert.deepEqual(decimalChange('.5', '1.'), { absoluteChange: '0.50', percentChange: '100.00' });
  assert.deepEqual(decimalChange('2.5E-1', '0.5'), { absoluteChange: '0.25', percentChange: '100.00' });
  assert.equal(decimalChange('10', '0'), null);
  assert.equal(decimalChange('.', '1'), null);
  const s = summaryAt([rec('2020-01-01', '2020-12-31', '10.00', 'initial'),
    { ...rec('2021-01-01', null, '12.00', 'increase'), rawPrice: '1_2' }], '2026-01-01');
  assert.match(totalChangeLabel(s), /差額無法計算/);
});

// ── C2 圖表區段模型 ─────────────────────────────────────────────
const TODAY = '2026-09-11';
const chartRecs = [
  rec('2020-01-01', '2020-12-31', '10.00', 'initial'),
  rec('2021-01-01', '2021-06-30', '8.00', 'decrease', { previousPrice: 10 }),
  rec('2021-07-01', '2021-12-31', '0.00', 'terminated', { previousPrice: 8 }),
  rec('2022-01-01', '2022-06-30', '-', 'suspended', { previousPrice: 8 }),
  rec('2022-07-01', '2022-12-31', '', 'unknown'),
  rec('2023-01-01', '2023-12-31', 'abc', 'unknown'),
  rec('2024-03-01', '2026-09-30', '9.00', 'relisted', { previousPrice: 8, flags: ['gap_before'] }),
  rec('2026-10-01', null, '7.50', 'decrease', { previousPrice: 9 }),
];

test('C2 只有 priced 產生價格線段，y 值等於價格；非有價不得產生 y=0', () => {
  const m = chartModel(chartRecs, TODAY);
  assert.deepEqual(m.lines.map((l) => l.y), [10, 8, 9, 7.5]);
  assert.ok(m.lines.every((l) => l.record.priceState === 'priced'));
  assert.ok(m.lines.every((l) => l.y > 0));
  assert.deepEqual(m.bands.map((b) => b.kind), ['terminated', 'suspended', 'unknown', 'unknown']);
  assert.ok(m.connectors.every((c) => c.y0 > 0 && c.y1 > 0));
});

test('C2 空窗兩側與停止區間兩側不相連', () => {
  const m = chartModel(chartRecs, TODAY);
  assert.deepEqual(m.gaps, [{ x0: dayNumber('2024-01-01'), x1: dayNumber('2024-03-01') }]);
  // 相連的只有 10→8（相鄰有價）與 9→7.5；8 與 9 之間隔著終止／暫停／空窗，不得相連
  assert.deepEqual(m.connectors.map((c) => [c.y0, c.y1]), [[10, 8], [9, 7.5]]);
});

test('C2 有價 → 空窗 → 有價：兩段之間沒有垂直連接線', () => {
  const m = chartModel([
    rec('2019-04-01', '2019-05-31', '13.80', 'initial'),
    rec('2020-06-01', null, '12.00', 'decrease', { previousPrice: 13.8, flags: ['gap_before'] }),
  ], TODAY);
  assert.equal(m.gaps.length, 1);
  assert.deepEqual(m.connectors, []);
});

test('C2 x 軸上限：max(今日, 最後一筆起日)＋邊界，不得延伸至 2910 年', () => {
  const m = chartModel(chartRecs, TODAY);
  assert.equal(m.end, dayNumber('2026-10-01'));
  assert.ok(m.xMax > m.end && m.xMax <= m.end + 400);
  const open = m.lines[m.lines.length - 1];
  assert.equal(open.x1, m.xMax);
  const m2 = chartModel([rec('2020-01-01', null, '10.00', 'initial')], TODAY);
  assert.equal(m2.end, dayNumber(TODAY));
  // 起日 9991231 哨兵（民國 999 年＝2910）不納入座標範圍
  const m3 = chartModel([rec('2020-01-01', null, '10.00', 'initial'), rec('2910-12-31', null, '5.00', 'decrease')], TODAY);
  assert.equal(m3.skipped, 1);
  assert.ok(m3.xMax < dayNumber('2030-01-01'));
});

test('C2 預告區段帶 upcoming；已生效區段沒有', () => {
  const m = chartModel(chartRecs, TODAY);
  assert.deepEqual(m.lines.map((l) => l.upcoming), [false, false, false, true]);
  assert.deepEqual(m.markers.map((k) => [k.type, k.upcoming]), [['decrease', false], ['relisted', false], ['decrease', true]]);
});

test('C2 有 priced 的代號，價格線段非空；全為終止的代號沒有線段', () => {
  assert.ok(chartModel(chartRecs, TODAY).lines.length > 0);
  assert.equal(chartModel([rec('2020-01-01', null, '0.00', 'initial')], TODAY).lines.length, 0);
});

// ── C3 過期警示 ─────────────────────────────────────────────────
test('C3 21／22／45／46 天 → 無／黃／黃／紅；以 +08:00 日期計算', () => {
  const at = '2026-09-01T01:00:00+08:00';
  assert.equal(staleness(at, '2026-09-22').level, 'none');
  assert.equal(staleness(at, '2026-09-23').level, 'yellow');
  assert.equal(staleness(at, '2026-10-16').level, 'yellow');
  assert.equal(staleness(at, '2026-10-17').level, 'red');
  // UTC 表示的同一時刻：+08:00 日期仍為 09-01
  assert.equal(staleness('2026-08-31T17:00:00Z', '2026-09-22').days, 21);
});

test('C3 無法解析 → 紅', () => {
  for (const bad of [undefined, null, '', 'not-a-date', 123]) {
    assert.equal(staleness(bad, '2026-09-11').level, 'red');
  }
});

// ── C4 搜尋 ─────────────────────────────────────────────────────
function makeIndex() {
  // 代號必須嚴格遞增且唯一（§3.5）。原本的 `AC48${i}100` 在 i=92 會產生
  // AC48092100，與下方特意加入的那筆**重複**——舊版 prepareIndex 的 fallback sort
  // 讓這個 fixture bug 一直沒有顯形。改用 AC4809xxxx 讓候選與目標自然遞增。
  // 目標排在候選**之前**：rows 依 code 遞增，而 prefix bucket 只留前 MAX_RESULTS 筆，
  // 目標若排在 120 筆候選之後會被擠掉（舊 fixture 靠重複代號＋fallback sort 巧合閃過）
  const drugs = [{ code: 'AC48092100', chName: '"衛采" 撫緒錠', enName: 'CAREMOD TABLETS', ingredient: 'PAROXETINE HCL' }];
  for (let i = 0; i < 120; i++) {
    const code = `AC4809${String(i + 3000).padStart(4, '0')}`;
    drugs.push({ code, chName: `候選藥${i}`, enName: `CANDIDATE ${i}`, ingredient: 'AC4809 LOOKALIKE' });
  }
  drugs.push({ code: 'ZZ99999999', chName: '終止藥品', enName: 'ENDED', ingredient: 'OLDINE', window: [] });
  return prepareIndex(asColumnar(drugs));
}

test('C4 代號完全相符排第一，即使有 > 50 筆候選', () => {
  const r = search(makeIndex(), 'AC48092100');
  assert.equal(r.items[0].code, 'AC48092100');
  const r2 = search(makeIndex(), 'ac4809');
  assert.ok(r2.items.some((d) => d.code === 'AC48092100'));
  assert.ok(r2.total > MAX_RESULTS);
  assert.equal(r2.items.length, MAX_RESULTS);
});

test('C4 中文／英文／成分不分大小寫子字串；終止品項不排除', () => {
  for (const q of ['撫緒', 'caremod', 'paroxetine']) {
    assert.ok(search(makeIndex(), q).items.some((d) => d.code === 'AC48092100'), q);
  }
  assert.equal(search(makeIndex(), 'oldine').items[0].code, 'ZZ99999999');
});

test('C4 空白查詢 → null；不存在 → 空；跨欄位邊界不得誤中', () => {
  assert.equal(search(makeIndex(), '   '), null);
  assert.deepEqual(search(makeIndex(), 'no-such-thing'), { total: 0, hidden: 0, items: [] });
  // chName 結尾「錠」＋ enName 開頭「CAREMOD」→ 查「錠care」不得命中
  assert.equal(search(makeIndex(), '錠care').total, 0);
});

test('C4 符合項位於全資料第 50 筆之後仍可找到', () => {
  const idx = makeIndex();
  let pos = -1;
  for (let i = 0; i < idx.n; i++) if (codeAt(idx, i) === 'ZZ99999999') { pos = i; break; }
  assert.ok(pos > 50);
  assert.equal(search(idx, 'ended').items[0].code, 'ZZ99999999');
});

test('C4 未排序的 index 是資料違約，不得靜默修正', () => {
  // 〔不變量變更〕舊版 prepareIndex 會對未排序的 drugs 做 fallback sort。
  // columnar/1 把「rows 依 code 嚴格遞增」寫成契約（spec-index-format.md §3.5）：
  // 靜默排序會讓一次 45,179 筆的 sort 留在首屏路徑上，且掩蓋建置端的錯誤。
  // 改為拒絕——搜尋不可用比悄悄用錯的順序安全。
  assert.throws(() => prepareIndex(asColumnar([{ code: 'B2' }, { code: 'A1' }, { code: 'A10' }])),
    IndexShapeError);
  // 重複代號同樣違約
  assert.throws(() => prepareIndex(asColumnar([{ code: 'A1' }, { code: 'A1' }])), IndexShapeError);
  // 已排序者正常運作
  const p = prepareIndex(asColumnar([{ code: 'A1' }, { code: 'A10' }, { code: 'B2' }]));
  assert.deepEqual(search(p, 'a1').items.map((d) => d.code), ['A1', 'A10']);
});

// ── 「顯示已終止支付品項」篩選（2026-09-12 使用者需求；預設隱藏）──────────
function filterIndex() {
  const T = '2026-09-11';
  const mk = (code, window) => ({ code, chName: `藥${code}`, enName: '', ingredient: 'FILTERINE', window });
  const drugs = [
    mk('F000000001', [win(rec('2020-01-01', null, '10.00', 'initial'), null)]),                       // 有價
    mk('F000000002', [win(rec('2020-01-01', null, '0.00', 'terminated', { previousPrice: 10 }), 10)]),  // 終止
    mk('F000000003', [win(rec('2020-01-01', null, '0.00', 'initial'), null)]),                         // 此前無有價 0 元
    mk('F000000004', [win(rec('2020-01-01', null, '-', 'suspended', { previousPrice: 10 }), 10)]),     // 暫停：不藏
    mk('F000000005', [win(rec('2020-01-01', '2026-09-30', '10.00', 'initial'), null),
      win(rec('2026-10-01', null, '0.00', 'terminated', { previousPrice: 10 }), 10)]),                // 預告終止、現行有價：不藏
    mk('F000000006', [win(rec('2020-01-01', null, '0.00', 'terminated'), 10, ['conflict'])]),          // 衝突：不藏
    mk('F000000007', [win(rec('2020-01-01', '2021-12-31', '5.00', 'initial'), null)]),                 // window 耗盡：不藏
  ];
  const p = prepareIndex(asColumnar(drugs));
  return { p, mask: terminatedMask(p, T) };
}

test('篩選：只藏 T 當日確定為 0 元的品項；暫停／預告終止／衝突／耗盡不藏', () => {
  const { p, mask } = filterIndex();
  const masked = [];
  for (let i = 0; i < p.n; i++) if (mask[i]) masked.push(codeAt(p, i));
  assert.deepEqual(masked, ['F000000002', 'F000000003']);
  const r = search(p, 'filterine', mask);
  assert.equal(r.total, 5);
  assert.equal(r.hidden, 2);
  assert.deepEqual(r.items.map((d) => d.code), ['F000000001', 'F000000004', 'F000000005', 'F000000006', 'F000000007']);
  assert.equal(search(p, 'filterine').total, 7);                 // 不給遮罩＝全部顯示
});

test('篩選：代號完全相符一律顯示；前綴仍受篩選', () => {
  const { p, mask } = filterIndex();
  assert.deepEqual(search(p, 'F000000002', mask), { total: 1, hidden: 0, items: [p.drugAt(1)] });
  const pre = search(p, 'F00000000', mask);
  assert.equal(pre.hidden, 2);
  assert.ok(!pre.items.some((d) => d.code === 'F000000002'));
});

test('篩選：遮罩依日期而定（預告終止生效後才藏）', () => {
  const { p } = filterIndex();
  const mask = terminatedMask(p, '2026-10-01');
  let i5 = -1;
  for (let i = 0; i < p.n; i++) if (codeAt(p, i) === 'F000000005') { i5 = i; break; }
  assert.equal(mask[i5], true);
});

// ── A8／E6 分片與混批 ───────────────────────────────────────────
test('shardPrefix 以最長符合前綴選檔，不寫死長度', () => {
  const shards = { files: ['A0', 'AC48', 'AC4809', 'B0'] };
  assert.equal(shardPrefix('AC48092100', shards), 'AC4809');
  assert.equal(shardPrefix('AC48867100', shards), 'AC48');
  assert.equal(shardPrefix('ZZ00000000', shards), null);
});

test('E6 混批：index↔meta、shard↔meta 版本不一致 → version_mismatch', () => {
  const meta = { dataVersion: 'v1', shards: { files: ['AC48'], versions: { AC48: 's1' } } };
  assert.ok(validateMeta(meta).ok);
  const idx = (dataVersion, extra = {}) => ({
    dataVersion, indexFormat: INDEX_FORMAT,
    fields: [...INDEX_FIELDS], windowFields: [...INDEX_WINDOW_FIELDS],
    rows: [['A1', '', '', '', '', '', '', '', '', '2020-01-01', null, 0, 0, [], []]],
    ...extra,
  });
  const meta1 = { ...meta, uniqueDrugCodeCount: 1 };
  assert.equal(validateIndex(idx('v2'), meta1).reason, 'version_mismatch');
  assert.ok(validateIndex(idx('v1'), meta1).ok);
  // 表示法不符 → mismatch（可自癒，「請重新整理」），不是 invalid（「無法查詢」）
  assert.equal(validateIndex(idx('v1', { indexFormat: 'columnar/0' }), meta1).reason, 'version_mismatch');
  assert.equal(validateIndex({ dataVersion: 'v1', drugs: [] }, meta1).reason, 'invalid');
  // 最小結構前提排在版本判定之前：null／陣列不得被誤歸成版本問題
  for (const bad of [null, [], 'x', { indexFormat: INDEX_FORMAT }]) {
    assert.equal(validateIndex(bad, meta1).reason, 'invalid');
  }
  // 空 rows 是資料故障，不得偽裝成零結果（§3.5）
  assert.equal(validateIndex(idx('v1', { rows: [] }), meta1).reason, 'invalid');
  // rows 數與 meta.uniqueDrugCodeCount 不符
  assert.equal(validateIndex(idx('v1'), { ...meta, uniqueDrugCodeCount: 999 }).reason, 'invalid');
  const entry = { meta: {}, records: [], invalidRecords: [], flags: [] };
  assert.equal(validateShard({ shardVersion: 's0', drugs: { AC48092100: entry } }, meta, 'AC48', 'AC48092100').reason, 'version_mismatch');
  assert.equal(validateShard({ shardVersion: 's1', drugs: {} }, meta, 'AC48', 'AC48092100').reason, 'missing_code');
  assert.ok(validateShard({ shardVersion: 's1', drugs: { AC48092100: entry } }, meta, 'AC48', 'AC48092100').ok);
  assert.equal(validateShard('garbage', meta, 'AC48', 'AC48092100').reason, 'invalid');
  assert.equal(validateMeta({ dataVersion: 'v1' }).ok, false);
});

test('§6.6 metaVariants 依日期選用，不以預告列回填', () => {
  const entry = {
    metaVariants: [{ from: '2020-01-01', chName: '現行名' }, { from: '2026-10-01', chName: '預告名' }],
    records: [rec('2020-01-01', '2026-09-30', '10.00', 'initial'), rec('2026-10-01', null, '9.00', 'decrease')],
  };
  assert.equal(selectMeta(entry, '2026-09-11').chName, '現行名');
  assert.equal(selectMeta(entry, '2026-10-01').chName, '預告名');
  assert.equal(selectMeta({ meta: { chName: 'x' }, records: [rec('2027-01-01', null, '1.00', 'initial')] }, '2026-09-11'), null);
});

test('R4 同起日、不同描述：依 recordIndex 對應選中的那一列（與 Python select_meta_row 一致）', () => {
  const entry = {
    metaVariants: [
      { from: '2020-01-01', recordIndex: 0, chName: '甲名' },
      { from: '2020-01-01', recordIndex: 1, chName: '乙名' },
      { from: '2022-01-01', recordIndex: 2, chName: '甲名' },
    ],
    records: [
      rec('2020-01-01', '2020-12-31', '10.00', 'initial'),
      rec('2020-01-01', '2021-12-31', '10.00', 'unchanged', { flags: ['overlap'] }),
      rec('2022-01-01', null, '10.00', 'unchanged'),
    ],
  };
  assert.equal(selectMeta(entry, '2020-06-01').chName, '甲名');      // 第一筆有效列＝record 0
  assert.equal(selectMeta(entry, '2021-06-01').chName, '乙名');      // 只剩 record 1 有效
  assert.equal(selectMeta(entry, '2023-01-01').chName, '甲名');
});
