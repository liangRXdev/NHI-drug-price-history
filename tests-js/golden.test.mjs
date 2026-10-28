// D2／E：前端 engine.js 與 Python ETL 以同一份凍結快照交叉比對。
// 預期值來自藥師核對過的 tests/fixtures/golden_<code>.json（不得以 JS 輸出回寫）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as Eng from '../engine.js';

import { searchCard, selectMeta, summaryAt, pricedBefore, currentLabel, latestEventLabel, dayState } from '../engine.js';

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

// ── M2 同價重疊不是衝突（spec §5.4、§5.5）：與 Python 同一份人工凍結預期值 ──
const samePrice = JSON.parse(readFileSync(new URL('golden_same_price_overlap.json', FIX), 'utf8'));
const samePriceFront = JSON.parse(readFileSync(new URL('golden_frontend_same_price_overlap.json', FIX), 'utf8'));

for (const [code, want] of Object.entries(samePrice.codes)) {
  const recs = samePriceFront.shards[code].records;

  for (const [ref, s] of Object.entries(want.summaries)) {
    test(`M2 ${code} 參考日 ${ref} 摘要與 golden 一致`, () => {
      const got = summaryAt(recs, ref);
      assert.deepEqual(
        [got.status, got.current && { from: got.current.from, rawPrice: got.current.rawPrice }, got.currentCandidates.length],
        [s.status, s.current, s.candidates],
      );
    });
  }

  for (const [day, kind] of Object.entries(want.dayState)) {
    test(`M2 ${code} ${day} dayState 與 golden 一致`, () => {
      assert.equal(dayState(recs, day).kind, kind);
    });
  }

  for (const [indexDate, byT] of Object.entries(want.searchCard)) {
    for (const [T, card] of Object.entries(byT)) {
      test(`M2 ${code} index ${indexDate}／T ${T} 搜尋卡與 golden 一致`, () => {
        const got = searchCard(samePriceFront.index[indexDate][code], T);
        assert.deepEqual({ kind: got.kind, text: got.text }, card);
      });
    }
  }
}

// ── pricedBefore 三態（spec.md §5.1）：與 Python 同一份人工凍結預期值 ──────────
// 衝突組之後、尚未出現單一有價列前，前價不唯一：不得取任一候選價，也不得觸發 §5.3 首列 0 元例外
const pbGolden = JSON.parse(readFileSync(new URL('golden_priced_before_ambiguous.json', FIX), 'utf8'));
const pbFront = JSON.parse(readFileSync(new URL('golden_frontend_priced_before_ambiguous.json', FIX), 'utf8'));
const pbToken = (v) => (v === Eng.PRIOR_AMBIGUOUS ? 'AMBIGUOUS' : v);

for (const [code, want] of Object.entries(pbGolden.codes)) {
  const recs = pbFront.shards[code].records;

  test(`三態 ${code} 事件與 priorPrices 與 golden 一致`, () => {
    assert.deepEqual(recs.map((r) => r.eventType), want.events);
    const priors = Eng.priorPrices(recs);
    assert.deepEqual(recs.map((r) => pbToken(priors.get(r))), want.priors);
    assert.deepEqual(recs.map((r) => pbToken(Eng.pricedBefore(recs, r))), want.priors);
  });

  for (const [day, [rule, tooltip]] of Object.entries(want.dayState)) {
    test(`三態 ${code} ${day} dayState 與 golden 一致`, () => {
      const st = Eng.dayState(recs, day);
      assert.deepEqual([st.rule, st.tooltip], [rule, tooltip]);
    });
  }

  for (const [day, label] of Object.entries(want.currentLabel)) {
    test(`三態 ${code} ${day} 現行支付價標籤與 golden 一致`, () => {
      assert.equal(Eng.currentLabel(Eng.summaryAt(recs, day)), label);
    });
  }

  test(`三態 ${code} 圖表區塊：不唯一不得落入「此前無有價」`, () => {
    const kinds = new Map(Eng.chartModel(recs, '2024-01-01').bands.map((b) => [b.record, b.kind]));
    assert.deepEqual(recs.map((r) => kinds.get(r) ?? null), want.bandKinds);
  });

  for (const [indexDate, byT] of Object.entries(want.searchCard)) {
    for (const [T, [kind, text, upcoming]] of Object.entries(byT)) {
      test(`三態 ${code} index ${indexDate}／T ${T} 搜尋卡與 golden 一致`, () => {
        const card = Eng.searchCard(pbFront.index[indexDate][code], T);
        assert.deepEqual([card.kind, card.text, card.upcoming], [kind, text, upcoming]);
      });
    }
  }

  for (const [indexDate, decisions] of Object.entries(want.upcomingDecision)) {
    test(`三態 ${code} upcoming ${indexDate} 呈現決策與 golden 一致`, () => {
      const items = pbFront.upcoming[indexDate].items.filter((it) => it.code === code);
      assert.deepEqual(items.map((it) => { const d = Eng.upcomingDecision(it); return [d.rule, d.label, d.sub]; }), decisions);
    });
  }
}

for (const day of pbGolden.indexDates) {
  test(`三態 upcoming ${day} 含不唯一列仍通過前端 validator`, () => {
    assert.deepEqual(Eng.validateUpcoming(pbFront.upcoming[day], { dataVersion: 'sha256:golden' }), { ok: true });
  });
}

test('三態：不唯一的 0 元不是首列 0 元例外（事件欄、歷史表、預告標籤）', () => {
  const recs = pbFront.shards.P000000201.records;
  const prior = Eng.priorPrices(recs).get(recs[4]);
  assert.equal(prior, Eng.PRIOR_AMBIGUOUS);
  assert.equal(Eng.isUnpricedZero(recs[4], prior), false);
  assert.equal(Eng.stateLabel(recs[4], prior, 'cell'), '健保支付價 0 元（已終止支付）');
  assert.equal(Eng.upcomingLabel(recs[4], prior), '⚠ 2023-01-01 起終止支付');
  assert.notEqual(Eng.eventText({ ...recs[4], eventType: 'terminated' }, prior), '0 元（此前無有價紀錄）');
});

test('三態：預告 CSV 的變動前支付價不得留空（空欄會被讀成此前無有價）', () => {
  const items = pbFront.upcoming['2022-06-01'].items.filter((it) => it.code === 'P000000202');
  const params = { type: 'all', atc: '', date: '', q: '', sort: 'date_asc' };
  const csv = Eng.upcomingCSV(Eng.upcomingModel(items, params).rows, { buildDate: '2022-06-01', params, today: '2022-06-01' });
  assert.match(csv.split('\r\n')[2], /,不唯一（來源紀錄衝突）,/);
});
