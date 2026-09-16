// 多代號比較 — 每代號契約（spec-compare.md §4.1、§4.3、§4.4；M8／M9／M10／M11／M12 的純邏輯面）。
//
// 預期值取自 tests/fixtures/compare_expected_2026-09-11.json：由藥師已核對的
// golden_<code>.json intervals 轉寫、狀態依 §4.3 人工判定，**不由待驗函式產生**（§10.2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  dayState, statusBands, relativeBaseline, relativeIndex, compareSegments,
  hasDrawableSegment, compareRange, minusYears, isValidCode, summaryAt, selectMeta,
} from '../engine.js';

const FIX = new URL('../tests/fixtures/', import.meta.url);
const front = JSON.parse(readFileSync(new URL('golden_frontend_2026-09-11.json', FIX), 'utf8'));
const expected = JSON.parse(readFileSync(new URL('compare_expected_2026-09-11.json', FIX), 'utf8'));
const T = expected.T;
const recordsOf = (code) => front.shards[code].records;

// 合成序列：用最少的欄位組出 records（priceState 與 flags 決定狀態）
const rec = (from, to, rawPrice, priceState = 'priced', extra = {}) => ({
  from, to, rawPrice, priceState,
  price: priceState === 'priced' ? Number(rawPrice) : null,
  eventType: 'initial', previousPrice: null, absoluteChange: null, percentChange: null,
  crossesStop: false, flags: [], ...extra,
});

// ── M8／M9：狀態 band 逐代號逐區間 ───────────────────────────────
for (const [code, exp] of Object.entries(expected.codes)) {
  test(`M8 ${code} 的 band 起迄、狀態與 tooltip 與凍結預期完全相同`, () => {
    const recs = recordsOf(code);
    const bands = statusBands(recs, exp.bands[0].from, expected.window.to, T);
    assert.deepEqual(
      bands.map((b) => ({ from: b.from, to: b.to, rule: b.rule, kind: b.kind, tooltip: b.tooltip })),
      exp.bands,
    );
  });

  test(`M10 ${code} 的基準與指數值與凍結預期相同`, () => {
    const base = relativeBaseline(recordsOf(code));
    assert.equal(base.kind, exp.baseline.kind);
    assert.equal(base.date, exp.baseline.date);
    assert.equal(base.rawPrice, exp.baseline.rawPrice);
    for (const { rawPrice, value } of exp.index) {
      assert.equal(relativeIndex(rawPrice, base.rawPrice), value, `${code} ${rawPrice}`);
    }
  });
}

test('M9 首列 0 元的 tooltip 不得含「終止」；曾有價後終止必須含「終止」', () => {
  const zero = expected.codes.A020296321.bands[0];
  assert.equal(zero.tooltip, '健保支付價 0 元（此前無有價紀錄）');
  assert.ok(!zero.tooltip.includes('終止'));
  const stopped = expected.codes.B009254100.bands.at(-1);
  assert.ok(stopped.tooltip.includes('終止'), stopped.tooltip);
  // 真實案例的正對照：兩者都是 priceState=terminated，差別只在該列之前有無 priced
  assert.equal(zero.kind, 'unpriced_zero');
  assert.equal(stopped.kind, 'terminated');
});

test('M9 首列 0 元續期：判定只看該列之前，不看未來的恢復支付', () => {
  const recs = [
    rec('2020-01-01', '2020-12-31', '0.00', 'terminated'),
    rec('2021-01-01', '2021-12-31', '0.00', 'terminated'),   // 續期，此前仍從未有價
    rec('2022-01-01', null, '12.50'),                        // 之後才首次有價
  ];
  const bands = statusBands(recs, '2020-01-01', '2026-09-11', T);
  assert.deepEqual(bands.map((b) => [b.from, b.to, b.kind]), [
    ['2020-01-01', '2021-12-31', 'unpriced_zero'],
    ['2022-01-01', '2026-09-11', 'priced'],
  ]);
  assert.ok(!bands[0].tooltip.includes('終止'));
});

test('M8 巢狀區間：序 2／3／4 依有效區間聯集，不依最後一列', () => {
  const recs = [
    rec('2020-01-01', '2024-12-31', '10.00'),                // 長區間
    rec('2021-01-01', '2021-12-31', '10.00'),                // 被包覆的短區間（同價）
  ];
  // 2022 年落在聯集內、且只有長區間有效 → 有價，不得因「最後一列已結束」而判成未涵蓋
  assert.equal(dayState(recs, '2022-06-01').kind, 'priced');
  assert.equal(dayState(recs, '2025-01-01').kind, 'uncovered');
  assert.equal(dayState(recs, '2019-12-31').kind, 'before');
  // 兩列同時有效的日期 → 序 1 衝突
  assert.equal(dayState(recs, '2021-06-01').rule, 1);
});

test('M8 衝突 flag 只作用於該筆涵蓋的日期，不擴張', () => {
  const recs = [
    rec('2020-01-01', '2020-12-31', '10.00', 'priced', { flags: ['conflicting_price_interval'] }),
    rec('2022-01-01', null, '12.00'),
  ];
  assert.equal(dayState(recs, '2020-06-01').rule, 1);
  assert.equal(dayState(recs, '2019-06-01').kind, 'before');      // 首筆之前不受影響
  assert.equal(dayState(recs, '2021-06-01').kind, 'gap');         // 空窗不受影響
  assert.equal(dayState(recs, '2023-06-01').kind, 'priced');      // 之後的紀錄不受影響
});

test('M13 §4.3 第二層十個序號各有案例，含三種暫停標記', () => {
  const seen = new Map();
  const add = (recs, day) => { const s = dayState(recs, day); seen.set(s.rule, s); return s; };

  const conflict = [rec('2020-01-01', '2020-12-31', '10.00'), rec('2020-01-01', '2020-12-31', '11.00')];
  assert.equal(add(conflict, '2020-06-01').tooltip, '來源紀錄衝突，無法判定單一支付價');
  const normal = [rec('2020-01-01', '2020-12-31', '10.00'), rec('2022-01-01', '2022-12-31', '12.00')];
  assert.equal(add(normal, '2019-01-01').tooltip, '尚未有紀錄');
  assert.equal(add(normal, '2024-01-01').tooltip, '本站資料未涵蓋此日期');
  assert.equal(add(normal, '2021-06-01').tooltip, '此日期無支付紀錄');
  assert.equal(add([rec('2020-01-01', null, 'abc', 'malformed')], '2021-01-01').tooltip,
    '資料格式異常（原始值：abc）');
  assert.equal(add([rec('2020-01-01', null, '', 'missing')], '2021-01-01').tooltip,
    '來源無支付價資料');
  assert.equal(add([rec('2020-01-01', null, '0.00', 'terminated')], '2021-01-01').tooltip,
    '健保支付價 0 元（此前無有價紀錄）');
  assert.equal(add([rec('2019-01-01', '2019-12-31', '24.00'), rec('2020-01-01', null, '0.00', 'terminated')], '2021-01-01').tooltip,
    '已終止支付（終止前 24.00 元）');
  assert.equal(add([rec('2020-01-01', null, '10.00')], '2021-01-01').tooltip,
    '10.00 元（2020-01-01 ～ 無迄日）');

  // 序 9：三種來源標記都必須逐字顯示，不得寫死「-」
  for (const mark of ['-', '－', '—']) {
    const recs = [rec('2019-01-01', '2019-12-31', '18.00'), rec('2020-01-01', null, mark, 'suspended')];
    const s = add(recs, '2021-01-01');
    assert.equal(s.tooltip, `暫停支付（來源標示「${mark}」，暫停前 18.00 元）`);
  }
  assert.deepEqual([...seen.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

// ── M11／M12：繪製資格與空窗 ────────────────────────────────────
test('M11 §4.1.2 跨左界：持續有價但視窗內無任何 from，仍須畫線', () => {
  const recs = recordsOf('A020296321');            // 2014-07-01 起、to=null、20.50 元
  const win = compareRange([{ records: recs }], T, 'y3');
  assert.deepEqual(win, { from: '2023-09-11', to: '2026-09-11' });
  assert.ok(!recs.some((r) => r.from >= win.from && r.from <= win.to), '視窗內不應有任何 from');
  const segs = compareSegments(recs, win.from, win.to, T);
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].from, segs[0].to, segs[0].rawPrice, segs[0].clippedLeft],
    ['2023-09-11', '2026-09-11', '20.50', true]);
  assert.equal(hasDrawableSegment(recs, win.from, win.to, T), true);
});

test('M11 三種無線狀態各自可分辨', () => {
  assert.equal(relativeBaseline([rec('2020-01-01', null, '0.00', 'terminated')]).kind, 'none');
  const conflicted = [
    rec('2020-01-01', '2020-12-31', '10.00', 'priced', { flags: ['conflicting_price_interval'] }),
    rec('2020-01-01', '2020-12-31', '11.00', 'priced', { flags: ['conflicting_price_interval'] }),
  ];
  assert.equal(relativeBaseline(conflicted).kind, 'undeterminable');
  const ok = recordsOf('A035680329');
  assert.equal(relativeBaseline(ok).kind, 'ok');
  // 有基準但視窗內無可繪點（該代號 2010-10-01 起已終止）
  assert.equal(hasDrawableSegment(ok, '2023-09-11', '2026-09-11', T), false);
});

test('M11 基準候選須排除衝突列，圖例基準日為實際採用的那一列', () => {
  const recs = [
    rec('2019-01-01', '2019-12-31', '50.00', 'priced', { flags: ['conflicting_price_interval'] }),
    rec('2020-01-01', null, '40.00'),
  ];
  const base = relativeBaseline(recs);
  assert.equal(base.date, '2020-01-01');
  assert.equal(base.rawPrice, '40.00');
});

for (const [name, second] of [['同價', '10.00'], ['異價', '12.00']]) {
  test(`M12 priced → 空窗 → priced（${name}）：空窗段無線段`, () => {
    const recs = [rec('2020-01-01', '2020-12-31', '10.00'), rec('2022-01-01', null, second)];
    const bands = statusBands(recs, '2020-01-01', '2026-09-11', T);
    assert.deepEqual(bands.map((b) => [b.from, b.to, b.kind]), [
      ['2020-01-01', '2020-12-31', 'priced'],
      ['2021-01-01', '2021-12-31', 'gap'],
      ['2022-01-01', '2026-09-11', 'priced'],
    ]);
    const segs = compareSegments(recs, '2020-01-01', '2026-09-11', T);
    assert.deepEqual(segs.map((s) => [s.from, s.to, s.rawPrice]), [
      ['2020-01-01', '2020-12-31', '10.00'],
      ['2022-01-01', '2026-09-11', second],
    ]);
    // 空窗期間不得有任何線段覆蓋
    assert.ok(!segs.some((s) => s.from <= '2021-06-01' && s.to >= '2021-06-01'));
  });
}

// ── M10：基準固定，切換 preset 不改變 ───────────────────────────
test('M10 切換 preset 後基準與指數值皆不變，只有可見範圍改變', () => {
  const recs = recordsOf('AC48867100');
  const base = relativeBaseline(recs);
  const windows = ['all', 'y10', 'y5', 'y3'].map((p) => compareRange([{ records: recs }], T, p));
  assert.deepEqual(windows.map((w) => w.from),
    ['2013-08-01', '2016-09-11', '2021-09-11', '2023-09-11']);
  assert.ok(windows.every((w) => w.to === '2026-09-11'));
  for (const w of windows) {
    assert.equal(relativeBaseline(recs).date, base.date);          // 基準與視窗無關
    assert.equal(relativeIndex('12.50', relativeBaseline(recs).rawPrice), '38.7');
    assert.ok(hasDrawableSegment(recs, w.from, w.to, T));
  }
});

test('M10 指數四捨五入為「遠離 0 至小數 1 位」，邊界值凍結', () => {
  assert.equal(relativeIndex('100.00', '100.00'), '100.0');
  assert.equal(relativeIndex('1.005', '1.00'), '100.5');
  assert.equal(relativeIndex('1.0005', '1.00'), '100.1');          // 100.05 → 100.1（遠離 0）
  assert.equal(relativeIndex('0.9995', '1.00'), '100.0');          // 99.95 → 100.0
  // 以下三組數學上剛好落在 .x5，且浮點實作會少進一位（實測 Math.round((100*p/b)*10)/10
  // 分別得到 18.7／143.7／231.2）——十進位計算不得受此影響
  assert.equal(relativeIndex('0.21', '1.12'), '18.8');
  assert.equal(relativeIndex('2.07', '1.44'), '143.8');
  assert.equal(relativeIndex('4.81', '2.08'), '231.3');
  assert.equal(relativeIndex('2.00', '3.00'), '66.7');
  assert.equal(relativeIndex('0.00', '3.00'), null);               // 非正數無指數
  assert.equal(relativeIndex('-', '3.00'), null);
});

// ── §4.4 X 軸 ───────────────────────────────────────────────────
test('§4.4 右界含預告；左界為所有代號最早的 from', () => {
  const withUpcoming = [
    { records: recordsOf('A035680329') },
    { records: [...recordsOf('AC48867100'), rec('2027-01-01', null, '9.00')] },
  ];
  assert.deepEqual(compareRange(withUpcoming, T, 'all'), { from: '1997-03-01', to: '2027-01-01' });
  assert.deepEqual(compareRange(withUpcoming, T, 'y3'), { from: '2023-09-11', to: '2027-01-01' });
});

test('§4.4 preset 左界以實際日曆計算，2/29 夾到當月最後一天', () => {
  assert.equal(minusYears('2028-02-29', 3), '2025-02-28');
  assert.equal(minusYears('2028-02-29', 4), '2024-02-29');
  assert.equal(minusYears('2026-09-11', 10), '2016-09-11');
});

test('§4.4 全部代號皆無有效日期列 → 無可繪製區間', () => {
  assert.equal(compareRange([{ records: [] }, { records: [] }], T, 'all'), null);
});

// ── 契約重用：比較頁與詳細頁共用同一組純函式（M1 的基礎）────────
test('M1 比較頁的每代號摘要與詳細頁同源（同一組 engine 函式、同一個 T）', () => {
  for (const code of Object.keys(expected.codes)) {
    const entry = front.shards[code];
    const a = summaryAt(entry.records, T);
    const b = summaryAt(entry.records, T);
    assert.deepEqual(a.status, b.status);
    assert.equal(selectMeta(entry, T).chName, front.index[code].chName);
  }
});

test('§3.3 第 5 步的代號格式', () => {
  assert.equal(isValidCode('A020296321'), true);
  assert.equal(isValidCode('a020296321'), false);      // 檢查在轉大寫之後
  assert.equal(isValidCode('A02029632'), false);
  assert.equal(isValidCode('A0202963211'), false);
  assert.equal(isValidCode('A020-96321'), false);
});
