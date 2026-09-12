// C1–C4、C2、E1–E2、E6 的純邏輯斷言（plan.md §5）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chartModel, currentLabel, dayNumber, decimalChange, latestEventLabel, MAX_RESULTS, prepareIndex,
  search, searchCard, selectMeta, shardPrefix, staleness, stateLabel, summaryAt, totalChangeLabel,
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
  const drugs = [];
  for (let i = 0; i < 120; i++) {
    const code = `AC48${String(i).padStart(3, '0')}100`;
    drugs.push({ code, chName: `候選藥${i}`, enName: `CANDIDATE ${i}`, ingredient: 'AC4809 LOOKALIKE' });
  }
  drugs.push({ code: 'AC48092100', chName: '"衛采" 撫緒錠', enName: 'CAREMOD TABLETS', ingredient: 'PAROXETINE HCL' });
  drugs.push({ code: 'ZZ99999999', chName: '終止藥品', enName: 'ENDED', ingredient: 'OLDINE', window: [] });
  return prepareIndex(drugs);
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
  assert.deepEqual(search(makeIndex(), 'no-such-thing'), { total: 0, items: [] });
  // chName 結尾「錠」＋ enName 開頭「CAREMOD」→ 查「錠care」不得命中
  assert.equal(search(makeIndex(), '錠care').total, 0);
});

test('C4 符合項位於全資料第 50 筆之後仍可找到', () => {
  const idx = makeIndex();
  const pos = idx.drugs.findIndex((d) => d.code === 'ZZ99999999');
  assert.ok(pos > 50);
  assert.equal(search(idx, 'ended').items[0].code, 'ZZ99999999');
});

test('C4 未排序的 index 仍依代號排序；已排序時不改動原陣列', () => {
  const drugs = [{ code: 'B2' }, { code: 'A1' }, { code: 'A10' }].map((d) => ({ chName: '', enName: '', ingredient: '', ...d }));
  const p = prepareIndex(drugs);
  assert.deepEqual(p.drugs.map((d) => d.code), ['A1', 'A10', 'B2']);
  assert.deepEqual(drugs.map((d) => d.code), ['B2', 'A1', 'A10']);
  assert.deepEqual(search(p, 'a1').items.map((d) => d.code), ['A1', 'A10']);
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
  assert.equal(validateIndex({ dataVersion: 'v2', drugs: [] }, meta).reason, 'version_mismatch');
  assert.ok(validateIndex({ dataVersion: 'v1', drugs: [] }, meta).ok);
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
