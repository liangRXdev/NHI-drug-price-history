// D2／E：前端 engine.js 與 Python ETL 以同一份凍結快照交叉比對。
// 預期值來自藥師核對過的 tests/fixtures/golden_<code>.json（不得以 JS 輸出回寫）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { searchCard, selectMeta, summaryAt, pricedBefore, currentLabel, latestEventLabel } from '../engine.js';

const FIX = new URL('../tests/fixtures/', import.meta.url);
const front = JSON.parse(readFileSync(new URL('golden_frontend_2026-09-11.json', FIX), 'utf8'));
const goldens = readdirSync(FIX)
  .filter((f) => /^golden_[A-Z0-9]{10}\.json$/.test(f))
  .map((f) => [f.slice(7, 17), JSON.parse(readFileSync(new URL(f, FIX), 'utf8'))]);

const num = (x) => (x === null ? null : Number(x));

test('11 個 golden 代號都有前端 fixture', () => {
  assert.equal(goldens.length, 11);
  for (const [code] of goldens) assert.ok(front.shards[code], code);
});

for (const [code, g] of goldens) {
  const entry = front.shards[code];

  test(`${code} 事件序列與 golden 一致`, () => {
    assert.deepEqual(
      entry.records.map((r) => [r.from, r.to, r.rawPrice, r.priceState]),
      g.intervals.map((i) => [i.from, i.to, i.rawPrice, i.priceState]),
    );
    assert.deepEqual(
      entry.records.map((r) => [r.eventType, r.previousPrice, r.crossesStop, r.flags]),
      g.events.map((e) => [e.eventType, num(e.previousPrice), e.crossesStop, e.flags]),
    );
  });

  for (const ref of Object.keys(g.summaries)) {
    test(`${code} 參考日 ${ref} 摘要與 golden 一致`, () => {
      const s = summaryAt(entry.records, ref);
      const want = g.summaries[ref];
      assert.equal(s.status, want.status);
      assert.deepEqual(s.current && { from: s.current.from, rawPrice: s.current.rawPrice }, want.current);
      assert.deepEqual(
        s.upcoming && { from: s.upcoming.from, rawPrice: s.upcoming.rawPrice, eventType: s.upcoming.eventType },
        want.upcoming,
      );
      assert.deepEqual(
        s.latestEvent && { eventType: s.latestEvent.eventType, from: s.latestEvent.from,
          previousPrice: s.latestEvent.previousPrice },
        want.latestEvent && { ...want.latestEvent, previousPrice: num(want.latestEvent.previousPrice) },
      );
      assert.equal(s.priceChangeCount, want.priceChangeCount);
      assert.equal(s.pricedCount, want.pricedCount);
      assert.deepEqual(
        s.totalChange && { absoluteChange: s.totalChange.absoluteChange, percentChange: s.totalChange.percentChange },
        want.totalChange,
      );
    });

    test(`${code} 參考日 ${ref} 描述欄位與 golden 一致`, () => {
      const m = selectMeta(entry, ref);
      const pick = m && { chName: m.chName, enName: m.enName, ingredient: m.ingredient, manufacturer: m.manufacturer };
      assert.deepEqual(pick, g.meta[ref]);
    });
  }
}

// ── D2 反例綁定（前端側）────────────────────────────────────────
test('A020296321 首列 0 元：標籤不含「終止」', () => {
  const recs = front.shards.A020296321.records;
  const s = summaryAt(recs, '1996-01-01');
  assert.equal(s.status, 'terminated');
  const label = currentLabel(s);
  assert.equal(label, '健保支付價 0 元（此前無有價紀錄）');
  assert.ok(!label.includes('終止'));
});

test('AC48867100 恢復支付對比停止前 29.80、跨越停止期間', () => {
  const recs = front.shards.AC48867100.records;
  const s = summaryAt(recs, '2018-01-01');
  assert.equal(s.latestEvent.eventType, 'relisted');
  assert.match(latestEventLabel(s.latestEvent), /停止前 29\.80 元.*跨越停止期間/);
  assert.equal(s.priceChangeCount, 1);          // 只有 32.30→29.80，恢復支付不計入
});

test('BC23981100 暫停續期：搜尋卡仍帶暫停前價格（pricedBefore）', () => {
  const card = searchCard(front.index.BC23981100, '2026-09-11');
  assert.equal(card.kind, 'stopped');
  assert.equal(card.text, '暫停支付（來源標示 -），暫停前 13.80 元');
  // 詳細頁由完整 history 推導，須與搜尋卡一致
  const recs = front.shards.BC23981100.records;
  const s = summaryAt(recs, '2026-09-11');
  assert.equal(s.pricedBefore, pricedBefore(recs, s.current));
  assert.equal(currentLabel(s), card.text);
});

// ── C1 以真實預告代號驗「前一天／當天／後一天」──────────────────
const C1_DAYS = ['2026-09-30', '2026-10-01', '2026-10-02'];

test('C1 BC05037209 預告終止：搜尋卡與詳細頁', () => {
  const idx = front.index.BC05037209;
  const recs = front.shards.BC05037209.records;
  const [before, on, after] = C1_DAYS;

  const cb = searchCard(idx, before);
  assert.equal(cb.text, '245.00 元');
  assert.equal(cb.upcoming, '⚠ 2026-10-01 起終止支付');
  const sb = summaryAt(recs, before);
  assert.equal(currentLabel(sb), '245.00 元');
  assert.equal(sb.upcoming.from, '2026-10-01');

  for (const T of [on, after]) {
    const c = searchCard(idx, T);
    assert.equal(c.text, '已終止支付（終止前 245.00 元）', T);
    assert.equal(c.upcoming, null, T);
    const s = summaryAt(recs, T);
    assert.equal(currentLabel(s), '已終止支付（終止前 245.00 元）', T);
    assert.equal(s.upcoming, null, T);
  }
});

test('C1 AB47689100 預告調價：前一天為現價＋預告，當天起為新價', () => {
  const idx = front.index.AB47689100;
  const recs = front.shards.AB47689100.records;
  const [before, on, after] = C1_DAYS;
  const cb = searchCard(idx, before);
  assert.equal(cb.rawPrice, '6.90');
  assert.equal(cb.upcoming, '2026-10-01 起調整為 7.90 元（+14.49%）');
  for (const T of [on, after]) {
    assert.equal(searchCard(idx, T).rawPrice, '7.90', T);
    assert.equal(summaryAt(recs, T).current.rawPrice, '7.90', T);
  }
});
