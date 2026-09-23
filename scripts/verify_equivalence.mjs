/* F1／F2／F3／F1-S 等價驗收（spec-index-format.md v0.3 §7）。
 *
 *   node scripts/verify_equivalence.mjs <legacy.json> <columnar.json> [--sentinel]
 *
 * 舊側**直接用 legacy oracle 物件**，不經任何新格式的 decoder（§7.0）——
 * 由新格式反解出「舊格式」再自我比較，是「斷言的期望值由受測程式產生」。
 *
 * T 的產生規則（§7.1 F3）：對每一筆藥品，取它自己每個 window 列的
 * `from-1`、`from`、`to`、`to+1`（to 非 null 時），外加全域的「今天」。
 * 邊界日只對該筆藥品有意義，全域笛卡兒積（4.5 萬筆 × 18 萬個 T）不可行也無意義。
 */
import fs from 'node:fs';
import * as E from '../engine.js';

const [legacyPath, columnarPath] = process.argv.slice(2);
const SENTINEL = process.argv.includes('--sentinel');
if (!legacyPath || !columnarPath) {
  console.error('用法：node scripts/verify_equivalence.mjs <legacy.json> <columnar.json> [--sentinel]');
  process.exit(2);
}

const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
const columnar = JSON.parse(fs.readFileSync(columnarPath, 'utf8'));

// ── F1-S 反向哨兵：指定 code、指定欄位、指定 T 注入破壞 ──────────
const SENTINEL_CODE = 'A000015421';
const SENTINEL_FIELD = 'priceState';
let sentinelT = null;
if (SENTINEL) {
  const i = columnar.rows.findIndex((r) => r[0] === SENTINEL_CODE);
  if (i < 0) throw new Error(`哨兵目標 ${SENTINEL_CODE} 不在資料中——哨兵沒打中目標`);
  const w = columnar.rows[i][columnar.fields.length];
  if (!w.length) throw new Error(`哨兵目標 ${SENTINEL_CODE} 沒有 window 列`);
  const k = columnar.windowFields.indexOf(SENTINEL_FIELD);
  sentinelT = w[0][columnar.windowFields.indexOf('from')];
  w[0][k] = w[0][k] === 'terminated' ? 'priced' : 'terminated';
  console.log(`〔哨兵〕已把 ${SENTINEL_CODE} 的 window[0].${SENTINEL_FIELD} 改掉，`
    + `預期 F1／F2 在 T=${sentinelT} 對該 code 轉紅\n`);
}

const v = E.validateIndex(columnar, null);
if (!v.ok) { console.error(`columnar 未通過 validateIndex：${v.reason}`); process.exit(1); }
const prepared = E.prepareIndex(columnar);

const legacyByCode = new Map(legacy.drugs.map((d) => [d.code, d]));
if (legacyByCode.size !== legacy.drugs.length) throw new Error('legacy oracle 的 code 不唯一');
if (prepared.n !== legacy.drugs.length) {
  console.error(`筆數不符：legacy ${legacy.drugs.length} vs columnar ${prepared.n}`);
  process.exit(1);
}

const TODAY = new Date().toISOString().slice(0, 10);
const shift = (d, days) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

/** 該筆藥品的邊界日集合＋今天（§7.1 F3） */
function tsFor(drug) {
  const set = new Set([TODAY]);
  for (const r of drug.window || []) {
    set.add(shift(r.from, -1));
    set.add(r.from);
    if (r.to !== null) { set.add(r.to); set.add(shift(r.to, 1)); }
  }
  return set;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── F1：searchCard 逐筆逐 T ────────────────────────────────────
let cardChecks = 0;
let cardDiffs = 0;
const diffSample = [];
const allTs = new Set([TODAY]);

for (let i = 0; i < prepared.n; i++) {
  const code = prepared.rows[i][0];
  const oldDrug = legacyByCode.get(code);
  if (!oldDrug) { console.error(`columnar 有 legacy 沒有的 code：${code}`); process.exit(1); }
  const newDrug = prepared.drugAt(i);

  for (const T of tsFor(oldDrug)) {
    allTs.add(T);
    let a; let b;
    try { a = E.searchCard(oldDrug, T); } catch (e) { a = { __throw: String(e.message) }; }
    try { b = E.searchCard(newDrug, T); } catch (e) { b = { __throw: String(e.message) }; }
    cardChecks++;
    if (!eq(a, b)) {
      cardDiffs++;
      if (diffSample.length < 5) diffSample.push({ code, T, legacy: a, columnar: b });
    }
  }
}

// ── F2：terminatedMask 逐項 ───────────────────────────────────
const maskTs = [TODAY, ...[...allTs].filter((t) => t !== TODAY).slice(0, 12)];
let maskChecks = 0;
let maskDiffs = 0;
const maskDiffSample = [];
const legacyPrepared = { drugs: legacy.drugs };

for (const T of maskTs) {
  // 舊側：直接用 oracle 物件跑舊邏輯（不經新 decoder）
  const expected = legacyPrepared.drugs.map((d) => {
    const eff = (d.window || []).filter((r) => r.from <= T && (r.to === null || r.to >= T));
    return eff.length === 1 && eff[0].priceState === 'terminated'
      && !eff[0].flags.some((f) => f === 'conflict' || f === 'conflicting_price_interval' || f === 'overlap');
  });
  const actual = E.terminatedMask(prepared, T);
  if (actual.length !== expected.length) { console.error('mask 長度不符'); process.exit(1); }
  for (let i = 0; i < expected.length; i++) {
    maskChecks++;
    if (expected[i] !== actual[i]) {
      maskDiffs++;
      if (maskDiffSample.length < 5) {
        maskDiffSample.push({ code: legacy.drugs[i].code, T, legacy: expected[i], columnar: actual[i] });
      }
    }
  }
  // fixture 必須同時含 true 與 false，否則「全 false 也相等」是恆真斷言
  if (T === TODAY) {
    const t = expected.filter(Boolean).length;
    console.log(`F2 今日 mask：true ${t.toLocaleString()} 筆、false ${(expected.length - t).toLocaleString()} 筆`
      + `${t === 0 || t === expected.length ? '  ⚠ 單一值，斷言恆真！' : ''}`);
  }
}

// ── 報告 ──────────────────────────────────────────────────────
console.log(`\nF1 searchCard：${cardChecks.toLocaleString()} 次比對（${prepared.n.toLocaleString()} 筆 × 各自的 T），`
  + `唯一 T ${allTs.size.toLocaleString()} 個`);
console.log(`F2 terminatedMask：${maskChecks.toLocaleString()} 次比對（${maskTs.length} 個 T × ${prepared.n.toLocaleString()} 筆）`);
console.log(`差異：F1 ${cardDiffs}、F2 ${maskDiffs}`);

for (const d of [...diffSample, ...maskDiffSample]) {
  console.log(`  ${d.code} @ ${d.T}\n    legacy   = ${JSON.stringify(d.legacy)}\n    columnar = ${JSON.stringify(d.columnar)}`);
}

const total = cardDiffs + maskDiffs;
if (SENTINEL) {
  const hitSentinel = [...diffSample, ...maskDiffSample].some((d) => d.code === SENTINEL_CODE);
  if (total === 0) {
    console.error('\n〔哨兵〕**未轉紅**——F1／F2 證明不了任何事');
    process.exit(1);
  }
  if (!hitSentinel) {
    console.error(`\n〔哨兵〕有差異但不在 ${SENTINEL_CODE}——哨兵沒打中目標，差異另有來源`);
    process.exit(1);
  }
  console.log(`\n〔哨兵〕通過：差異確實歸因到 ${SENTINEL_CODE}`);
  process.exit(0);
}

console.log(total === 0 ? '\nF1／F2 全等價' : `\n**不等價，${total} 處差異**`);
process.exit(total === 0 ? 0 : 1);
