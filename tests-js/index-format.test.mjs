// spec-index-format.md v0.4：F6、F7a／F7b（JS 側）。
// expected 讀 tests/fixtures/index_format_cases.json（逐案手寫）。Python 側在
// tests/test_index_format.py 各自對同一份 expected 驗證——兩端不互比、不委派。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EVENT_TYPES, INDEX_FIELDS, INDEX_FORMAT, INDEX_WINDOW_FIELDS, IndexShapeError, PRICE_STATES,
  prepareIndex, validateIndex,
} from '../engine.js';

const DOC = JSON.parse(readFileSync(new URL('../tests/fixtures/index_format_cases.json', import.meta.url), 'utf8'));

/** 與 app.js loadCore 相同的判定路徑：先 validateIndex，再在 prepareIndex 的走訪中驗逐筆。 */
function check(index, meta) {
  const v = validateIndex(index, meta);
  if (!v.ok) return { ok: false, reason: v.reason };
  try {
    prepareIndex(index);
  } catch (e) {
    if (e instanceof IndexShapeError) return { ok: false, reason: 'invalid' };
    throw e;                                    // 其他例外＝驗證漏掉、會在 app 裡 crash
  }
  return { ok: true, reason: null };
}

test('常數與規格 fixture 一致（擋 engine.js 與 lib/index_format.py 漂移）', () => {
  const c = DOC.constants;
  assert.equal(INDEX_FORMAT, c.indexFormat);
  assert.deepEqual(INDEX_FIELDS, c.fields);
  assert.deepEqual(INDEX_WINDOW_FIELDS, c.windowFields);
  assert.deepEqual([...PRICE_STATES].sort(), [...c.priceStates].sort());
  assert.deepEqual([...EVENT_TYPES].sort(), [...c.eventTypes].sort());
});

for (const c of DOC.cases) {
  test(`F7 ${c.layer}：${c.name}`, () => {
    assert.deepEqual(check(c.index, c.meta), c.expect.js);
  });
}

test('F7b 的 Infinity fixture 確實被 JSON.parse 成 Infinity（否則該案驗的不是 finite 邊界）', () => {
  const inf = DOC.cases.filter((c) => c.name.endsWith('非 finite'));
  assert.ok(inf.length >= 5);
  const hasInf = (v) => v === Infinity || (Array.isArray(v) && v.some(hasInf));
  for (const c of inf) assert.ok(hasInf(c.index.rows), c.name);
});

// ── F6：逐欄刪除／重複／空字串／非字串 ─────────────────────────
const base = DOC.cases.find((c) => c.name === '最小合法 fixture');

for (const [key, names] of [['fields', INDEX_FIELDS], ['windowFields', INDEX_WINDOW_FIELDS]]) {
  for (let i = 0; i < names.length; i++) {
    for (const [op, mutate] of [
      ['刪除', (a) => a.splice(i, 1)],
      ['重複', (a) => a.push(a[i])],
      ['空字串', (a) => { a[i] = ''; }],
      ['非字串', (a) => { a[i] = 1; }],
    ]) {
      test(`F6 ${key}[${i}] ${names[i]} ${op} → invalid`, () => {
        const idx = structuredClone(base.index);
        mutate(idx[key]);
        assert.deepEqual(validateIndex(idx, base.meta), { ok: false, reason: 'invalid' });
      });
    }
  }
}

test('F6 正向：未知附加欄位允許存在', () => {
  const ok = DOC.cases.find((c) => c.name === '含合法附加欄位');
  assert.deepEqual(check(ok.index, ok.meta), { ok: true, reason: null });
});
