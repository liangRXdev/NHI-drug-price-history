// 健保藥價歷史 — 前端純邏輯（無 DOM、無 I/O），瀏覽器與 node --test 共用。
//
// 規則對應 spec.md：
//   §5.5 參考日摘要        → summaryAt()（與 lib/history.py summary_at 同規則，golden 交叉比對）
//   §5.1 搜尋卡判定        → searchCard()
//   §5.3 狀態標籤／首列 0 元 → stateLabel()
//   §6.6 描述欄位選列      → selectMeta()
//   §8.1 搜尋             → prepareIndex()、search()
//   §8.2 圖表             → chartModel()
//   §8.6 過期警示          → staleness()
//   §7／§8.7 分片與混批    → shardPrefix()、validate*()
//
// 規則對應 spec-upcoming.md：
//   §5.5.1 預告清單合法性   → validateUpcoming()
//   §5.1 徽章數字（依 T）   → upcomingPendingCount()
//
// 規則對應 spec-compare.md：
//   §4.3 兩層狀態          → dayState()、statusBands()
//   §4.1.1 基準資格        → relativeBaseline()、relativeIndex()
//   §4.1.2 繪製資格        → compareSegments()
//   §4.4 共用 X 軸與 preset → compareRange()、minusYears()
//
// 日期一律為 ISO 'YYYY-MM-DD' 字串（字典序即時間序）；有效區間為閉區間 [from, to]，to=null 為無迄日。

export const MAX_RESULTS = 50;
export const CHANGE_EVENTS = new Set(['increase', 'decrease']);
const MINUS = '−';          // 顯示用負號（−），與連字號區隔
const DAY_MS = 86400000;

// ── 日期 ────────────────────────────────────────────────────────
export function localISODate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function dayNumber(iso) {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS;
}

export function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  return fromDayNumber(dayNumber(iso) + n);
}

export function isEffective(r, day) {
  return r.from <= day && (r.to === null || r.to >= day);
}

// ── 十進位金額（避免浮點誤差；規則同 Python ROUND_HALF_UP：half away from zero）──
// 接受 Python Decimal 對一般數字的寫法：12.50、.5、10.、1e1、2.5E-1（ETL 以 Decimal 判定 priced）
const DECIMAL = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function parseDecimal(raw) {
  const m = DECIMAL.exec(String(raw).trim());
  if (!m || (m[1] + (m[2] || '')) === '') return null;
  const frac = m[2] || '';
  let int = BigInt(m[1] + frac || '0');
  let scale = frac.length - Number(m[3] || 0);
  if (scale < 0) { int *= 10n ** BigInt(-scale); scale = 0; }
  return { int, scale };
}

function align(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const up = (x) => x.int * 10n ** BigInt(scale - x.scale);
  return [up(a), up(b), scale];
}

function roundDiv(num, den) {       // num/den 四捨五入（遠離 0）至整數
  const neg = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (2n * n + d) / (2n * d);
  return neg ? -q : q;
}

function centsToString(c) {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** 以 rawPrice 十進位值計算差額與百分比，回傳 2 位小數字串；無法解析或任一值不為正數回傳 null。 */
export function decimalChange(prevRaw, newRaw) {
  const p = parseDecimal(prevRaw);
  const n = parseDecimal(newRaw);
  if (!p || !n || p.int <= 0n || n.int <= 0n) return null;
  const [pi, ni, scale] = align(p, n);
  const diff = ni - pi;
  const unit = 10n ** BigInt(scale);
  return {
    absoluteChange: centsToString(roundDiv(diff * 100n, unit)),
    percentChange: centsToString(roundDiv(diff * 10000n, pi)),
  };
}

// ── 摘要（spec §5.5）─────────────────────────────────────────────
/** 參考日 ref 的摘要；預告區間（from > ref）一律不計入統計。records 須已依 §6.2 排序。 */
export function summaryAt(records, ref) {
  const effective = records.filter((r) => r.from <= ref);
  const current = records.filter((r) => isEffective(r, ref));

  let status;
  if (current.length > 1) status = 'conflict';
  else if (current.length === 1) status = current[0].priceState;
  else if (records.length === 0 || ref < records[0].from) status = 'not_yet_effective';
  else if (records.some((r) => r.from > ref)) status = 'gap';
  else status = 'no_record';

  let latestEvent = null;
  for (let i = effective.length - 1; i >= 0; i--) {
    if (effective[i].eventType !== 'unchanged') { latestEvent = effective[i]; break; }
  }
  if (latestEvent && (latestEvent.eventType === 'initial' || latestEvent.eventType === 'first_priced')) {
    latestEvent = null;
  }

  const priced = effective.filter((r) => r.priceState === 'priced');
  let totalChange = null;
  if (priced.length >= 2) {
    const first = priced[0];
    const last = priced[priced.length - 1];
    totalChange = { first, last, ...decimalChange(first.rawPrice, last.rawPrice) };
  }

  const current1 = current.length === 1 ? current[0] : null;
  return {
    ref,
    status,
    current: current1,
    currentCandidates: current,
    pricedBefore: current1 ? pricedBefore(records, current1) : null,
    upcoming: records.find((r) => r.from > ref) || null,
    latestEvent,
    priceChangeCount: effective.filter((r) => CHANGE_EVENTS.has(r.eventType)).length,
    pricedCount: priced.length,
    totalChange,
  };
}

/**
 * 每筆 record → 其之前最後一個 priced 金額（null＝此前從未有價）；一次掃描。
 * 與 index window 的 pricedBefore 同義；摘要、圖表、歷史表共用，避免各處各算一次而漂移。
 */
export function priorPrices(records) {
  const out = new Map();
  let last = null;
  for (const r of records) {
    out.set(r, last);
    if (r.priceState === 'priced') last = r.price;
  }
  return out;
}

/** target 之前最後一個 priced 金額。 */
export function pricedBefore(records, target) {
  const v = priorPrices(records).get(target);
  return v === undefined ? null : v;
}

/** 此前從未有價的 0 元列（spec §5.3 首列 0 元例外）：不得稱「終止」。 */
export function isUnpricedZero(r, prior) {
  return r.priceState === 'terminated' && prior === null;
}

// ── 描述欄位（spec §6.6）─────────────────────────────────────────
/** 日期 day 選用的描述欄位；只有未來列時回傳 null（顯示代號＋「—」，不以預告列回填）。 */
export function selectMeta(entry, day) {
  const recs = entry.records;
  let row = recs.find((r) => isEffective(r, day));
  if (!row) {
    const past = recs.filter((r) => r.from <= day);
    if (past.length) {
      const latest = past.reduce((m, r) => (r.from > m ? r.from : m), past[0].from);
      row = past.filter((r) => r.from === latest).pop();
    }
  }
  if (!row) return recs.length === 0 && entry.meta ? entry.meta : null;
  if (entry.meta) return entry.meta;
  // metaVariants：recordIndex＝該變體首次出現之 record 索引；取 recordIndex ≤ 選定列索引的最後一個。
  // 只比 from 在「同起日、不同描述」時會選錯列（codex R4），僅在缺 recordIndex 的舊資料退回比 from。
  const variants = entry.metaVariants || [];
  const k = recs.indexOf(row);
  let chosen = null;
  for (const v of variants) {
    if (Number.isInteger(v.recordIndex) ? v.recordIndex <= k : v.from <= row.from) chosen = v;
  }
  return chosen;
}

// ── 金額與標籤 ──────────────────────────────────────────────────
/** 數值金額顯示：至少 2 位小數；原值更精細時保留原值（不得截斷）。 */
export function fmtMoney(x) {
  if (x === null || x === undefined) return '—';
  const two = x.toFixed(2);
  return Number(two) === x ? two : String(x);
}

export function fmtSigned(str) {
  if (str === null || str === undefined) return '—';
  const s = String(str);
  if (s.startsWith('-')) return MINUS + s.slice(1);
  return Number(s) === 0 ? s : `+${s}`;
}

export function fmtPct(x) {
  if (x === null || x === undefined) return '—';
  return `${fmtSigned(typeof x === 'number' ? x.toFixed(2) : x)}%`;
}

/**
 * 單筆紀錄的狀態標籤（spec §5.3）。prior＝該列之前最後一個有價金額（null＝從未有價）。
 * mode 'current'：用於「現行支付價」；'cell'：用於歷史表支付價欄。
 */
export function stateLabel(r, prior, mode = 'current') {
  switch (r.priceState) {
    case 'priced':
      return `${r.rawPrice} 元`;
    case 'terminated':
      if (prior === null) return '健保支付價 0 元（此前無有價紀錄）';
      return mode === 'cell'
        ? '健保支付價 0 元（已終止支付）'
        : `已終止支付（終止前 ${fmtMoney(prior)} 元）`;
    case 'suspended': {
      const base = `暫停支付（來源標示 ${r.rawPrice}）`;
      return mode === 'cell' || prior === null ? base : `${base}，暫停前 ${fmtMoney(prior)} 元`;
    }
    case 'missing':
      return '來源無支付價資料';
    default:
      return `資料格式異常（原始值：${r.rawPrice}）`;
  }
}

/** 預告標籤（spec §8.2）；u＝最早未生效紀錄，prior＝u 之前最後一個有價金額。 */
export function upcomingLabel(u, prior) {
  const d = u.from;
  switch (u.priceState) {
    case 'terminated':
      return prior === null ? `${d} 起健保支付價 0 元（此前無有價紀錄）` : `⚠ ${d} 起終止支付`;
    case 'suspended':
      return `⚠ ${d} 起暫停支付（來源標示 ${u.rawPrice}）`;
    case 'missing':
    case 'malformed':
      return `${d} 起有新紀錄（${stateLabel(u, prior)}）`;
    default:
      break;
  }
  switch (u.eventType) {
    case 'increase':
    case 'decrease':
      return `${d} 起調整為 ${u.rawPrice} 元（${fmtPct(u.percentChange)}）`;
    case 'relisted':
      return `${d} 起恢復支付 ${u.rawPrice} 元`;
    case 'unchanged':
      return `${d} 起續期，價格不變（${u.rawPrice} 元）`;
    case 'unknown':
      return `${d} 起 ${u.rawPrice} 元（前後紀錄異常，變動無法判定）`;
    default:          // initial／first_priced
      return `${d} 起支付 ${u.rawPrice} 元`;
  }
}

/** 詳細頁「現行支付價」主標籤。 */
export function currentLabel(s) {
  switch (s.status) {
    case 'conflict': return '來源紀錄衝突，無法判定單一支付價';
    case 'gap': return '此日期無支付紀錄（空窗）';
    case 'not_yet_effective': return '尚未生效';
    case 'no_record': return '目前無有效支付紀錄';
    default: return stateLabel(s.current, s.pricedBefore);
  }
}

/** 最新一次調整（spec §5.5）。 */
export function latestEventLabel(e) {
  if (!e) return '無調價紀錄';
  switch (e.eventType) {
    case 'increase':
    case 'decrease':
      return `${e.from} ${e.eventType === 'increase' ? '調升' : '調降'} ${fmtMoney(e.previousPrice)} → ${e.rawPrice} 元`
        + `（${fmtSigned(fmtMoney(e.absoluteChange))} 元，${fmtPct(e.percentChange)}）`;
    case 'relisted':
      return `${e.from} 恢復支付 ${e.rawPrice} 元（停止前 ${fmtMoney(e.previousPrice)} 元，`
        + `${fmtPct(e.percentChange)}，跨越停止期間）`;
    case 'terminated':        // previousPrice 為 null ⇔ 此前從未有價：首列 0 元例外，不得稱「終止」（§5.3）
      return e.previousPrice === null
        ? `健保支付價 0 元（此前無有價紀錄，${e.from} 起）`
        : `已終止支付（終止前 ${fmtMoney(e.previousPrice)} 元，${e.from} 起）`;
    case 'suspended':
      return e.previousPrice === null
        ? `暫停支付（無先前有價紀錄，${e.from} 起）`
        : `暫停支付（暫停前 ${fmtMoney(e.previousPrice)} 元，${e.from} 起）`;
    default:
      return '最近一次變動無法判定（來源資料異常）';
  }
}

/** 總變化（spec §5.5、E1）。 */
export function totalChangeLabel(s) {
  if (s.pricedCount === 0) return '無有價紀錄';
  if (s.pricedCount === 1) return '僅一筆有價紀錄';
  const t = s.totalChange;
  let suffix = '';
  if (s.status === 'terminated') suffix = '，至終止前';
  else if (s.status === 'suspended') suffix = '，至暫停前';
  const change = t.absoluteChange === undefined
    ? `（差額無法計算：原始金額格式特殊${suffix}）`
    : `（${fmtSigned(t.absoluteChange)} 元，${fmtPct(t.percentChange)}${suffix}）`;
  return `${t.first.rawPrice} → ${t.last.rawPrice} 元${change}`;
}

// ── 搜尋卡（spec §5.1「搜尋卡判定」，瀏覽器本地日期 T）────────────
/**
 * → { kind, text, upcoming, rawPrice }
 * kind：priced／stopped／conflict／none／not_yet／gap／exhausted
 * exhausted（window 耗盡或資料格式過舊）時不得給出任何確定價格。
 */
const NEEDS_UPDATE = { kind: 'exhausted', text: '需更新，請開啟詳細頁', upcoming: null, rawPrice: null };

export function searchCard(drug, T) {
  const w = drug.window || [];
  if (w.length === 0) return { kind: 'none', text: '目前無有效支付紀錄', upcoming: null, rawPrice: null };
  // 舊版 index 缺 pricedBefore：停止狀態的「終止前 X 元」與首列 0 元例外都無法判定，保守要求開詳細頁（codex R1）
  if (w.some((r) => r.pricedBefore === undefined && r.priceState !== 'priced')) return NEEDS_UPDATE;

  const effective = w.filter((r) => isEffective(r, T));
  const i = w.findIndex((r) => isEffective(r, T));
  const upcomingOf = (j) => {
    const u = w.slice(j).find((r) => r.from > T);
    return u ? upcomingLabel(u, u.pricedBefore) : null;
  };

  if (i >= 0) {
    const r = w[i];
    // T 當日多筆有效（build 後預告生效又與現行重疊）或來源標示衝突／重疊 → 不給單一價格（codex R2）
    const flagged = (f) => effective.some((x) => x.flags.includes(f));
    if (effective.length > 1 || flagged('conflict') || flagged('conflicting_price_interval') || flagged('overlap')) {
      const later = w.findIndex((x) => x.from > T);
      // 單筆帶 overlap：重疊對象可能不在 window 內，搜尋卡無從判定 → 要求開詳細頁，不稱「衝突」
      const text = effective.length === 1 && !flagged('conflict') && !flagged('conflicting_price_interval')
        ? '來源紀錄區間重疊，請開啟詳細頁確認' : '來源紀錄衝突，無法判定單一支付價';
      return { kind: 'conflict', text, upcoming: later >= 0 ? upcomingOf(later) : null, rawPrice: null };
    }
    return {
      kind: r.priceState === 'priced' ? 'priced' : 'stopped',
      text: stateLabel(r, r.pricedBefore),
      upcoming: upcomingOf(i + 1),
      rawPrice: r.priceState === 'priced' ? r.rawPrice : null,
    };
  }

  if (T < w[0].from) {
    // 首筆即為該代號第一筆紀錄 → 尚未生效；否則 T 位於 build 日有效區間之前（裝置日期早於 build 日）
    const kind = w[0].eventType === 'initial' ? 'not_yet' : 'gap';
    const text = kind === 'not_yet' ? '尚未生效' : '此日期無支付紀錄';
    return { kind, text, upcoming: upcomingOf(0), rawPrice: null };
  }
  const later = w.findIndex((r) => r.from > T);
  if (later >= 0) {
    return { kind: 'gap', text: '此日期無支付紀錄（空窗）', upcoming: upcomingOf(later), rawPrice: null };
  }
  return NEEDS_UPDATE;
}

// ── 搜尋（spec §8.1）────────────────────────────────────────────
/**
 * index.drugs → 依代號排序、預先小寫化的搜尋表（載入時做一次）。
 * 用平行陣列而非每筆一個物件：45k 筆在行動裝置上，配置與 GC 是可搜尋前的主要成本（plan E7）。
 * build 輸出本已依代號排序，已排序時跳過排序。
 */
export function prepareIndex(drugs) {
  const SEP = '\u0001';     // 欄位分隔：避免查詢字串跨欄位邊界誤中
  let list = drugs;
  for (let i = 1; i < list.length; i++) {
    if (list[i - 1].code > list[i].code) {
      list = drugs.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      break;
    }
  }
  const n = list.length;
  const codes = new Array(n);
  const hays = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = list[i];
    codes[i] = d.code.toLowerCase();
    hays[i] = `${d.code}${SEP}${d.chName}${SEP}${d.enName}${SEP}${d.ingredient}`.toLowerCase();
  }
  return { drugs: list, codes, hays };
}

/**
 * 瀏覽器日期 T 當日「現行為健保支付 0 元」的品項（含此前從未有價的 0 元）→ 布林陣列，與 prepared 同序。
 * 判定與搜尋卡相同：T 當日恰一筆有效 window 列、無衝突、priceState 為 terminated。
 * 暫停支付、衝突、window 耗盡、只有預告等不確定狀態一律不算，寧可多顯示也不誤藏。
 */
export function terminatedMask(prepared, T) {
  return prepared.drugs.map((d) => {
    const eff = (d.window || []).filter((r) => isEffective(r, T));
    return eff.length === 1 && eff[0].priceState === 'terminated'
      && !eff[0].flags.some((f) => f === 'conflict' || f === 'conflicting_price_interval' || f === 'overlap');
  });
}

/**
 * 不分大小寫子字串比對（代號另支援完全相符／前綴優先）。
 * 空白查詢 → null（只顯示提示）；否則 { total, hidden, items }，items 至多 MAX_RESULTS 筆。
 * hideMask（terminatedMask 結果）：為 true 者不列入、只計入 hidden；**代號完全相符者一律顯示**，
 * 避免使用者輸入完整代號卻像「查無」。
 */
export function search(prepared, query, hideMask = null) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const { drugs, codes, hays } = prepared;
  const exact = [];
  const prefix = [];
  const other = [];
  let total = 0;
  let hidden = 0;
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    let bucket = null;
    if (c === q) bucket = exact;
    else if (c.startsWith(q)) bucket = prefix;
    else if (hays[i].includes(q)) bucket = other;
    else continue;
    if (hideMask && hideMask[i] && bucket !== exact) { hidden++; continue; }
    total++;
    if (bucket.length < MAX_RESULTS) bucket.push(drugs[i]);    // 只保留可能顯示的前 50 筆，其餘只計數
  }
  const items = exact.concat(prefix, other).slice(0, MAX_RESULTS);
  return { total, hidden, items };
}

// ── 分片與資料版本（spec §7、§8.7）──────────────────────────────
/** 依 meta.shards.files 以最長符合前綴選檔；不寫死前綴長度。 */
export function shardPrefix(code, shards) {
  let best = null;
  for (const f of shards.files) {
    if (code.startsWith(f) && (best === null || f.length > best.length)) best = f;
  }
  return best;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function validateMeta(meta) {
  if (!isObj(meta) || typeof meta.dataVersion !== 'string' || !isObj(meta.shards)
      || !Array.isArray(meta.shards.files) || !isObj(meta.shards.versions)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true };
}

export function validateIndex(index, meta) {
  if (!isObj(index) || typeof index.dataVersion !== 'string' || !Array.isArray(index.drugs)) {
    return { ok: false, reason: 'invalid' };
  }
  if (meta && index.dataVersion !== meta.dataVersion) return { ok: false, reason: 'version_mismatch' };
  return { ok: true };
}

export function validateShard(shard, meta, prefix, code) {
  if (!isObj(shard) || typeof shard.shardVersion !== 'string' || !isObj(shard.drugs)) {
    return { ok: false, reason: 'invalid' };
  }
  if (shard.shardVersion !== meta.shards.versions[prefix]) return { ok: false, reason: 'version_mismatch' };
  const e = shard.drugs[code];
  if (!isObj(e) || !Array.isArray(e.records) || !Array.isArray(e.invalidRecords)
      || !(isObj(e.meta) || Array.isArray(e.metaVariants))) {
    return { ok: false, reason: 'missing_code' };
  }
  return { ok: true };
}

// ── 過期警示（spec §8.6）────────────────────────────────────────
/** lastCheckedAt 在 +08:00 的日期與 today 的天數差 → { days, level: none|yellow|red }。 */
export function staleness(lastCheckedAt, today) {
  const ms = typeof lastCheckedAt === 'string' ? Date.parse(lastCheckedAt) : NaN;
  if (!Number.isFinite(ms) || !ISO_DATE.test(today)) return { days: null, level: 'red', checkedDate: null };
  const checkedDate = new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
  const days = dayNumber(today) - dayNumber(checkedDate);
  const level = days >= 46 ? 'red' : days >= 22 ? 'yellow' : 'none';
  return { days, level, checkedDate };
}

// ── 圖表區段模型（spec §8.2、plan C2）────────────────────────────
const FAR_FUTURE_YEARS = 10;     // 起日超過今日 10 年（如起日 9991231 哨兵）不納入座標範圍

/**
 * → { xMin, xMax, end, yMin, yMax, lines, connectors, bands, gaps, markers, skipped }
 * 日期座標為 day number（UTC 日序）。只有 priced 產生價格線段；非有價區間只產生 band。
 * 無迄日的區間畫至 xMax＝end＋右側邊界，end＝max(today, 最後一筆起日)。
 */
export function chartModel(records, today) {
  const limit = addDays(today, 365 * FAR_FUTURE_YEARS);
  const recs = records.filter((r) => r.from <= limit);
  const skipped = records.length - recs.length;
  if (recs.length === 0) {
    return { xMin: null, xMax: null, end: null, yMin: 0, yMax: 1, lines: [], connectors: [], bands: [], gaps: [], markers: [], skipped };
  }

  const lastFrom = recs.reduce((m, r) => (r.from > m ? r.from : m), recs[0].from);
  const end = dayNumber(lastFrom > today ? lastFrom : today);
  const xMin = dayNumber(recs[0].from);
  const pad = Math.max(30, Math.round((end - xMin) * 0.04));
  const xMax = end + pad;
  const todayN = dayNumber(today);

  const lines = [];
  const bands = [];
  const connectors = [];
  const markers = [];
  const gaps = [];
  let maxEnd = null;       // 累計最大迄日（day number，含當日）；Infinity＝已有無迄日區間
  let prevLine = null;     // 上一筆 record 若為 priced，其線段
  const priors = priorPrices(records);

  for (const r of recs) {
    const x0 = dayNumber(r.from);
    const x1 = r.to === null ? xMax : Math.min(dayNumber(r.to) + 1, xMax);
    const upcoming = r.from > today;

    if (maxEnd !== null && maxEnd !== Infinity && x0 > maxEnd + 1) {
      gaps.push({ x0: maxEnd + 1, x1: x0 });
      prevLine = null;                         // 空窗兩側不得相連
    }

    if (r.priceState === 'priced') {
      const seg = { x0, x1, y: r.price, upcoming, record: r };
      lines.push(seg);
      if (prevLine && prevLine.x1 === x0 && prevLine.y !== seg.y) {
        connectors.push({ x: x0, y0: prevLine.y, y1: seg.y, upcoming });
      }
      if (r.eventType === 'increase' || r.eventType === 'decrease' || r.eventType === 'relisted') {
        markers.push({ x: x0, y: r.price, type: r.eventType, upcoming, record: r });
      }
      prevLine = seg;
    } else {
      // 此前從未有價的 0 元另成一類：圖例不得稱「終止」（§5.3，codex R3）
      const kind = isUnpricedZero(r, priors.get(r)) ? 'unpriced_zero'
        : r.priceState === 'terminated' || r.priceState === 'suspended' ? r.priceState : 'unknown';
      bands.push({ x0, x1, kind, upcoming, record: r });
      prevLine = null;
    }

    const e = r.to === null ? Infinity : dayNumber(r.to);
    maxEnd = maxEnd === null ? e : Math.max(maxEnd, e);
  }

  const prices = lines.map((l) => l.y);
  let yMin = 0;
  let yMax = 1;
  if (prices.length) {
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const span = hi - lo || hi * 0.2 || 1;
    yMin = Math.max(0, lo - span * 0.15);
    yMax = hi + span * 0.15;
  }
  return { xMin, xMax, end, today: todayN, yMin, yMax, lines, connectors, bands, gaps, markers, skipped };
}

/** 刻度：回傳 [min, max] 之間約 n 個「好看」的數值。 */
export function niceTicks(min, max, n = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

// ── 預告中心（spec-upcoming.md）──────────────────────────────────
// 前端內建的期望生成規則版本。dataVersion 只依來源內容，同一份來源在規則變更
// 前後的 dataVersion 相同，少了這個欄位就分不出舊規則產物（§3.3.2）。
export const UPCOMING_GENERATOR_VERSION = 'upcoming/1';

const PRICE_STATES = new Set(['priced', 'terminated', 'suspended', 'missing', 'malformed']);
const EVENT_TYPES = new Set(['initial', 'unknown', 'unchanged', 'terminated', 'suspended',
  'increase', 'decrease', 'relisted', 'first_priced']);
export const UPCOMING_META_FIELDS = ['chName', 'enName', 'ingredient', 'strength',
  'strengthUnit', 'dosageForm', 'atcCode', 'manufacturer'];
const UPCOMING_NULLABLE = ['endDate', 'price', 'previousPrice', 'pricedBefore',
  'previousState', 'absoluteChange', 'percentChange'];

/**
 * 真實日曆日（不只是外形）。`ISO_DATE` 只驗 `YYYY-MM-DD` 的樣子，`2027-02-30`
 * 照樣通過；Python 端用 `date.fromisoformat()` 會拒絕，兩端不等價等於防線有洞。
 */
export function isCalendarDate(v) {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validUpcomingRow(it, buildDate) {
  if (!isObj(it)) return false;
  if (typeof it.code !== 'string' || it.code === '') return false;
  if (typeof it.rawPrice !== 'string' || typeof it.everPriced !== 'boolean'
      || typeof it.crossesStop !== 'boolean' || !Array.isArray(it.flags)) return false;
  if (it.flags.some((f) => typeof f !== 'string')) return false;
  if (!PRICE_STATES.has(it.priceState) || !EVENT_TYPES.has(it.eventType)) return false;
  // 描述欄位允許 null（只有未來列的代號），但不得省略鍵——省略等於分不出「來源沒有」
  // 與「產生器漏寫」（§5.5.1 合法缺值）
  for (const k of UPCOMING_META_FIELDS) {
    if (!(k in it) || (it[k] !== null && typeof it[k] !== 'string')) return false;
  }
  for (const k of UPCOMING_NULLABLE) if (!(k in it)) return false;
  if (it.previousState !== null && !PRICE_STATES.has(it.previousState)) return false;
  // 狀態與價格一致性：priced ⟺ price 為正數
  if (it.priceState === 'priced' ? !(typeof it.price === 'number' && it.price > 0)
    : it.price !== null) return false;
  if (it.everPriced !== (it.pricedBefore !== null)) return false;
  for (const k of ['previousPrice', 'pricedBefore', 'absoluteChange', 'percentChange']) {
    if (it[k] !== null && typeof it[k] !== 'number') return false;
  }
  if (!isCalendarDate(it.effectiveDate) || it.effectiveDate <= buildDate) return false;
  if (it.endDate !== null && (!isCalendarDate(it.endDate) || it.endDate < it.effectiveDate)) return false;
  return true;
}

/**
 * spec-upcoming §5.5.1：→ { ok, reason }。reason 'version_mismatch'｜'invalid'。
 * **任一列不合法即整份損毀**：靜默跳過壞列會讓使用者看到一份看起來完整、其實缺項的清單。
 */
export function validateUpcoming(payload, meta) {
  if (!isObj(payload) || typeof payload.dataVersion !== 'string'
      || typeof payload.generatorVersion !== 'string' || !isCalendarDate(payload.buildDate)
      || !Number.isInteger(payload.count) || !Number.isInteger(payload.codeCount)
      || !Array.isArray(payload.items)) {
    return { ok: false, reason: 'invalid' };
  }
  if (payload.generatorVersion !== UPCOMING_GENERATOR_VERSION) {
    return { ok: false, reason: 'version_mismatch' };
  }
  if (!meta || typeof meta.dataVersion !== 'string') return { ok: false, reason: 'version_mismatch' };
  if (payload.dataVersion !== meta.dataVersion) return { ok: false, reason: 'version_mismatch' };
  // count／codeCount 比對的是原始完整 items，不是經 T、篩選或去重後的集合
  if (payload.count !== payload.items.length) return { ok: false, reason: 'invalid' };
  if (payload.codeCount !== new Set(payload.items.map((it) => (isObj(it) ? it.code : it))).size) {
    return { ok: false, reason: 'invalid' };
  }
  for (const it of payload.items) {
    if (!validUpcomingRow(it, payload.buildDate)) return { ok: false, reason: 'invalid' };
  }
  return { ok: true };
}

/** 依瀏覽器日期 T 計算徽章數字：只算仍未生效的列（§5.1）。 */
export function upcomingPendingCount(items, T) {
  return items.reduce((n, it) => n + (it.effectiveDate > T ? 1 : 0), 0);
}

/**
 * 預告列的呈現決策（spec-upcoming §4.1）：**由上而下取第一個符合的規則**。
 * → { rule, label, sub, type }；rule 為 §4.1 序號，type 為 §4.1.1 的篩選分類。
 *
 * 主鍵是 priceState ＋ 該列之前有無 priced，不是 eventType：首列即 0 元的代號
 * 事件是 initial，用 eventType 當索引鍵會讓它沒有任何標籤可用（plan-verdict-upcoming H1）。
 * 序 14 是安全網：任何未預期組合一律落到「無法判定」，不得靜默顯示成確定的價格事件。
 */
export function upcomingDecision(it) {
  const d = it.effectiveDate;
  const Y = it.rawPrice;
  const before = fmtMoney(it.pricedBefore);          // X：停止前最後一個有價金額
  const prev = fmtMoney(it.previousPrice);           // X：priced 列的前一筆有價金額
  const pct = it.percentChange === null ? '' : `（${fmtPct(it.percentChange)}`;

  if ((it.flags || []).includes('conflicting_price_interval') || it.eventType === 'unknown') {
    return { rule: 1, label: '無法判定', sub: '來源資料異常，請開啟詳細頁確認', type: 'other' };
  }
  if (it.priceState === 'malformed') {
    return { rule: 2, label: '資料格式異常', sub: `${d} 起（原始值：${Y}）`, type: 'other' };
  }
  if (it.priceState === 'missing') {
    return { rule: 3, label: '來源無支付價資料', sub: `${d} 起；請開啟詳細頁確認`, type: 'other' };
  }
  if (it.priceState === 'terminated') {
    // 此前無有價紀錄者不得出現「終止」字樣（spec.md §5.3 首列 0 元例外）
    if (!it.everPriced) {
      return { rule: 4, label: '健保支付價 0 元', sub: `${d} 起（此前無有價紀錄）`, type: 'first_priced' };
    }
    if (it.previousState === 'terminated') {
      return { rule: 5, label: '終止支付續期', sub: `${d} 起仍為 0 元；終止前 ${before} 元`, type: 'terminated' };
    }
    return { rule: 6, label: '終止支付', sub: `${d} 起；終止前 ${before} 元`, type: 'terminated' };
  }
  if (it.priceState === 'suspended') {
    if (!it.everPriced) {
      return { rule: 7, label: '暫停支付', sub: `${d} 起（此前無有價紀錄，來源標示「${Y}」）`, type: 'first_priced' };
    }
    if (it.previousState === 'suspended') {
      return { rule: 8, label: '暫停支付續期', sub: `${d} 起仍為暫停；暫停前 ${before} 元`, type: 'suspended' };
    }
    return { rule: 9, label: '暫停支付', sub: `${d} 起；暫停前 ${before} 元（來源標示「${Y}」）`, type: 'suspended' };
  }
  if (it.priceState === 'priced') {
    if (!it.everPriced) return { rule: 10, label: '首次有價', sub: `${d} 起 ${Y} 元`, type: 'first_priced' };
    if (it.previousState === 'terminated' || it.previousState === 'suspended') {
      // §4.2／U4：relisted 的差額與百分比在 record 上已有值，**兩者都必須呈現**，
      // 不得只顯示新價或只顯示百分比
      const parts = [];
      if (it.absoluteChange !== null) parts.push(`${fmtSigned(fmtMoney(it.absoluteChange))} 元`);
      if (it.percentChange !== null) parts.push(fmtPct(it.percentChange));
      parts.push('跨越停止期間');
      return {
        rule: 11,
        label: '恢復支付',
        sub: `${d} 起 ${before} → ${Y} 元（${parts.join('，')}）`,
        type: 'relisted',
      };
    }
    if (it.previousState === 'priced' && it.previousPrice !== null) {
      if (it.price === it.previousPrice) {
        return { rule: 12, label: '續期（支付價不變）', sub: `${d} 起 ${Y} 元，與前期相同`, type: 'unchanged' };
      }
      const up = it.price > it.previousPrice;
      return {
        rule: 13,
        label: up ? '調升' : '調降',
        sub: `${d} 起 ${prev} → ${Y} 元${pct ? `${pct}）` : ''}`,
        type: up ? 'increase' : 'decrease',
      };
    }
  }
  return { rule: 14, label: '無法判定', sub: '來源資料異常，請開啟詳細頁確認', type: 'other' };
}

/** §5.3 篩選的 type 值域（§4.1.1 的完整映射結果）。 */
export const UPCOMING_TYPES = ['all', 'decrease', 'increase', 'terminated', 'suspended',
  'relisted', 'first_priced', 'unchanged', 'other'];

// ── 預告清單的篩選、排序與分組（spec-upcoming §5.3）──────────────
export const UPCOMING_SORTS = ['date_asc', 'date_desc', 'change_desc'];
const ATC_LETTER = /^[A-V]$/;

/** 本份清單中實際出現的 ATC 首字母（升冪）；篩選值必須存在於清單中才算合法。 */
export function upcomingAtcLetters(items) {
  const set = new Set();
  for (const it of items) {
    const c = (it.atcCode || '').charAt(0).toUpperCase();
    if (ATC_LETTER.test(c)) set.add(c);
  }
  return [...set].sort();
}

/** 本份清單中的批次日（升冪）。`date` 的語意是精確批次，不是區間起點。 */
export function upcomingDates(items) {
  return [...new Set(items.map((it) => it.effectiveDate))].sort();
}

/** URL 參數 → 篩選狀態；無效值一律回預設且不報錯（§5.3）。 */
export function upcomingParams(search, items) {
  const p = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const type = UPCOMING_TYPES.includes(p.get('type')) ? p.get('type') : 'all';
  const atc = upcomingAtcLetters(items).includes(p.get('atc')) ? p.get('atc') : '';
  const date = upcomingDates(items).includes(p.get('date')) ? p.get('date') : '';
  const sort = UPCOMING_SORTS.includes(p.get('sort')) ? p.get('sort') : 'date_asc';
  return { type, atc, date, sort, q: (p.get('q') || '').slice(0, 100) };
}

function matchesQuery(it, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [it.code, it.chName, it.enName, it.ingredient]
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}

function sortRows(rows, sort) {
  const out = [...rows];                       // 來源順序已是 §3.2 的 date→event→code→索引
  if (sort === 'date_desc') {
    out.sort((a, b) => (a.it.effectiveDate < b.it.effectiveDate ? 1 : a.it.effectiveDate > b.it.effectiveDate ? -1 : 0));
  } else if (sort === 'change_desc') {
    // 幅度取絕對值（−30% 與 +30% 同級）；無 percentChange 者一律置底，不得視為 0%
    const mag = (r) => (typeof r.it.percentChange === 'number' ? Math.abs(r.it.percentChange) : null);
    out.sort((a, b) => {
      const [x, y] = [mag(a), mag(b)];
      if (x !== y) {
        if (x === null) return 1;
        if (y === null) return -1;
        return y - x;
      }
      if (a.it.effectiveDate !== b.it.effectiveDate) return a.it.effectiveDate < b.it.effectiveDate ? -1 : 1;
      return a.it.code < b.it.code ? -1 : a.it.code > b.it.code ? 1 : 0;
    });
  }
  return out;
}

/**
 * → { total, rows, groups }。total 為**篩選前**的總列數（空結果的提示要用它）。
 * groups 為 null 表示不分組：「幅度 desc」時分組會把最大變動切散在各批次裡（§5.3）。
 */
export function upcomingModel(items, params) {
  const decorated = items.map((it) => ({ it, dec: upcomingDecision(it) }));
  const matched = decorated.filter(({ it, dec }) => (
    (params.type === 'all' || dec.type === params.type)
    && (!params.atc || (it.atcCode || '').toUpperCase().startsWith(params.atc))
    && (!params.date || it.effectiveDate === params.date)
    && matchesQuery(it, params.q)
  ));
  const rows = sortRows(matched, params.sort);
  let groups = null;
  if (params.sort !== 'change_desc') {
    groups = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (last && last.date === row.it.effectiveDate) last.rows.push(row);
      else groups.push({ date: row.it.effectiveDate, rows: [row] });
    }
  }
  return { total: items.length, rows, groups };
}

// ── 預告清單 CSV 匯出（spec-upcoming §5.4）──────────────────────
export const UPCOMING_CSV_HEADER = ['生效日', '代號', '中文品名', '英文品名', '成分', '規格',
  '劑型', 'ATC', '藥商', '事件', '變動前支付價', '變動後支付價', '差額', '變動%',
  '原始支付價字串', '備註'];

const CRLF = '\r\n';

/** RFC 4180：含逗號、引號、換行者加引號，內部引號重複一次。其餘逐字輸出。 */
export function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (fields) => fields.map(csvField).join(',');

const TYPE_TEXT = {
  all: '全部', decrease: '調降', increase: '調升', terminated: '終止支付',
  suspended: '暫停支付', relisted: '恢復支付', first_priced: '首次有價／0 元',
  unchanged: '續期（支付價不變）', other: '無法判定／資料異常',
};
const SORT_TEXT = { date_asc: '生效日近→遠', date_desc: '生效日遠→近', change_desc: '變動幅度大→小' };

export function describeUpcomingFilters(p) {
  const parts = [`事件型別＝${TYPE_TEXT[p.type] || p.type}`];
  if (p.atc) parts.push(`ATC＝${p.atc}`);
  if (p.date) parts.push(`生效日＝${p.date}`);
  if (p.q) parts.push(`關鍵字＝${p.q}`);
  parts.push(`排序＝${SORT_TEXT[p.sort] || p.sort}`);
  return parts.join('，');
}

/** 變動前支付價（§4.2）：停止狀態取該列之前最後一個有價金額，有價列取前一筆有價金額。 */
function priorAmount(it) {
  return it.priceState === 'priced' ? it.previousPrice : it.pricedBefore;
}

/**
 * → CSV 字串（含 BOM、CRLF、前言一行＋標頭一行）。匯出的是**目前篩選後**的結果。
 * `rows` 為 upcomingModel() 的 rows（帶 dec），順序與畫面一致。
 */
export function upcomingCSV(rows, { buildDate, params, today, staleNote = '' }) {
  const preamble = '健保藥價歷史查詢 — 預告清單匯出。'
    + '資料來源：中央健康保險署「健保用藥品項查詢項目檔」（A21030000I-E41001-001）。'
    + `資料產生日 ${buildDate}；檢視日期 ${today}；篩選條件：${describeUpcomingFilters(params)}。`
    + (staleNote ? `${staleNote}。` : '')
    + '本系統顯示中央健康保險署公告之健保支付價，不代表醫療院所實際採購價、零售價或病人自付金額。'
    + '預告內容以健保署最新公告為準。';

  const lines = [csvRow([preamble]), csvRow(UPCOMING_CSV_HEADER)];
  for (const { it, dec } of rows) {
    const notes = [];
    if (it.effectiveDate <= today) notes.push('已生效（本站資料尚未重建）');
    for (const f of it.flags || []) notes.push(UPCOMING_FLAG_TEXT[f] || f);
    lines.push(csvRow([
      it.effectiveDate,
      it.code,
      it.chName,
      it.enName,
      it.ingredient,
      [it.strength, it.strengthUnit].filter(Boolean).join(' '),
      it.dosageForm,
      it.atcCode,
      it.manufacturer,
      dec.label,
      fmtAmount(priorAmount(it)),
      fmtAmount(it.price),
      fmtAmount(it.absoluteChange),
      fmtAmount(it.percentChange),
      it.rawPrice,                       // 逐字輸出：12.50 不得變成 12.5、0.00 不得變成 0
      notes.join('；'),
    ]));
  }
  return `﻿${lines.join(CRLF)}${CRLF}`;
}

/** CSV 內的金額一律用 ASCII 負號與 2 位小數；null 輸出空欄。 */
function fmtAmount(x) {
  if (x === null || x === undefined) return '';
  const two = x.toFixed(2);
  return Number(two) === x ? two : String(x);
}

export const UPCOMING_FLAG_TEXT = {
  gap: '有支付空窗',
  overlap: '來源區間重疊',
  conflict: '來源紀錄衝突',
  conflicting_price_interval: '同期間有不同支付價',
  invalid_records: '含日期異常紀錄',
  question_mark: '品名含「?」（來源缺字）',
  inconsistent_metadata: '描述欄位不一致',
};

// ── 多代號比較：每代號契約（spec-compare.md §4.1、§4.3、§4.4）──────
// 比較頁**不另寫一套摘要邏輯**：摘要、描述欄位、狀態標籤一律重用 summaryAt()／
// selectMeta()／stateLabel()。本節只新增「把各代號結果放到共同座標」所需的純函式。

export const COMPARE_MAX = 4;
const CODE_RE = /^[A-Z0-9]{10}$/;                 // §3.3 第 5 步（v0.3.1 釘死）

export const isValidCode = (c) => CODE_RE.test(c);

/** 該代號所有 records 的有效區間聯集。open＝有開放迄日（右界無限）。 */
function unionBounds(records) {
  if (!records.length) return null;
  let min = records[0].from;
  let max = null;
  let open = false;
  for (const r of records) {
    if (r.from < min) min = r.from;
    if (r.to === null) open = true;
    else if (max === null || r.to > max) max = r.to;
  }
  return { min, max, open };
}

/**
 * §4.3 第二層：某一日的日期／價格狀態，**由上而下取第一個符合**。
 * → { rule, kind, tooltip, record }
 *
 * 序 2／3／4 依**有效區間聯集**判定，不依最後一列的位置：長區間包覆短區間時，
 * 「最後起日那筆」已結束不代表資料覆蓋已結束（spec.md §6.4 的累計最大迄日原則）。
 */
export function dayState(records, day, priors = priorPrices(records)) {
  const bounds = unionBounds(records);
  if (!bounds) return { rule: 0, kind: 'no_records', tooltip: '無有效支付紀錄', record: null };

  const eff = records.filter((r) => isEffective(r, day));
  // 衝突 flag 只作用於帶該 flag 的那筆紀錄所涵蓋的日期，不擴張到首筆前或空窗
  if (eff.length > 1 || eff.some((r) => (r.flags || []).includes('conflicting_price_interval'))) {
    return { rule: 1, kind: 'conflict', tooltip: '來源紀錄衝突，無法判定單一支付價', record: null };
  }
  if (day < bounds.min) return { rule: 2, kind: 'before', tooltip: '尚未有紀錄', record: null };
  if (!bounds.open && bounds.max !== null && day > bounds.max) {
    return { rule: 3, kind: 'uncovered', tooltip: '本站資料未涵蓋此日期', record: null };
  }
  if (eff.length === 0) return { rule: 4, kind: 'gap', tooltip: '此日期無支付紀錄', record: null };

  const r = eff[0];
  const prior = priors.get(r) ?? null;
  switch (r.priceState) {
    case 'malformed':
      return { rule: 5, kind: 'malformed', tooltip: `資料格式異常（原始值：${r.rawPrice}）`, record: r };
    case 'missing':
      return { rule: 6, kind: 'missing', tooltip: '來源無支付價資料', record: r };
    case 'terminated':
      // 該列之前從未有價：不得出現「終止」字樣（spec.md §5.3 首列 0 元例外）
      return prior === null
        ? { rule: 7, kind: 'unpriced_zero', tooltip: '健保支付價 0 元（此前無有價紀錄）', record: r }
        : { rule: 8, kind: 'terminated', tooltip: `已終止支付（終止前 ${fmtMoney(prior)} 元）`, record: r };
    case 'suspended':
      return {
        rule: 9,
        kind: 'suspended',
        tooltip: prior === null
          ? `暫停支付（來源標示「${r.rawPrice}」）`
          : `暫停支付（來源標示「${r.rawPrice}」，暫停前 ${fmtMoney(prior)} 元）`,
        record: r,
      };
    default:
      return {
        rule: 10,
        kind: 'priced',
        tooltip: `${r.rawPrice} 元（${r.from} ～ ${r.to === null ? '無迄日' : r.to}）`,
        record: r,
      };
  }
}

/**
 * §4.3 狀態時間帶：把 [winFrom, winTo] 切成連續不重疊的段，每段一個狀態。
 * 邊界取自各 record 的起日與迄日次日，因此段內狀態必定一致；相鄰同狀態者合併。
 */
export function statusBands(records, winFrom, winTo, today) {
  if (!records.length || winTo < winFrom) return [];
  const priors = priorPrices(records);
  const marks = new Set([winFrom]);
  for (const r of records) {
    if (r.from > winFrom && r.from <= winTo) marks.add(r.from);
    if (r.to !== null) {
      const next = addDays(r.to, 1);
      if (next > winFrom && next <= winTo) marks.add(next);
    }
  }
  const starts = [...marks].sort();
  const out = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const to = i + 1 < starts.length ? addDays(starts[i + 1], -1) : winTo;
    const st = dayState(records, from, priors);
    const prev = out[out.length - 1];
    if (prev && prev.kind === st.kind && prev.tooltip === st.tooltip) prev.to = to;
    else out.push({ from, to, kind: st.kind, rule: st.rule, tooltip: st.tooltip, record: st.record, upcoming: from > today });
  }
  return out;
}

/**
 * §4.1.1 相對變化模式的基準。
 * → { kind: 'ok'|'none'|'undeterminable', record, date, price, rawPrice }
 *
 * 候選資格：`priced`、不帶 `conflicting_price_interval`、且其起日當天不存在其他有效紀錄。
 * 跳過不合格的更早列時，圖例顯示的是**實際採用那一列**的起日，不得稱為「歷史首筆價格」。
 */
export function relativeBaseline(records) {
  const priced = records.filter((r) => r.priceState === 'priced');
  if (!priced.length) return { kind: 'none', record: null };
  const eligible = priced.filter((r) => !(r.flags || []).includes('conflicting_price_interval')
    && records.filter((o) => isEffective(o, r.from)).length === 1);
  if (!eligible.length) return { kind: 'undeterminable', record: null };
  const rec = eligible.reduce((m, r) => (r.from < m.from ? r : m), eligible[0]);
  return { kind: 'ok', record: rec, date: rec.from, price: rec.price, rawPrice: rec.rawPrice };
}

/** 指數值＝100 × 當期價 ÷ 自身基準價，四捨五入（遠離 0）至小數 1 位；以十進位計算避免浮點邊界。 */
export function relativeIndex(rawPrice, baseRawPrice) {
  const p = parseDecimal(rawPrice);
  const b = parseDecimal(baseRawPrice);
  if (!p || !b || p.int <= 0n || b.int <= 0n) return null;
  const [pi, bi] = align(p, b);
  const tenths = roundDiv(pi * 1000n, bi);
  return `${tenths / 10n}.${tenths % 10n}`;
}

/**
 * §4.1.2 繪製資格＝**有效有價區間與顯示視窗相交**（不是「起日落在視窗內」）。
 * 回傳裁切到視窗內的有價線段；`clipped*` 表示該段在視窗外仍延續。
 */
export function compareSegments(records, winFrom, winTo, today) {
  const out = [];
  for (const r of records) {
    if (r.priceState !== 'priced') continue;
    const segTo = r.to === null ? winTo : r.to;
    if (segTo < winFrom || r.from > winTo) continue;          // 不相交
    out.push({
      from: r.from < winFrom ? winFrom : r.from,
      to: segTo > winTo ? winTo : segTo,
      price: r.price,
      rawPrice: r.rawPrice,
      record: r,
      upcoming: r.from > today,
      clippedLeft: r.from < winFrom,
      clippedRight: segTo > winTo,
    });
  }
  return out;
}

/** 視窗內是否有可繪製的有價區間；配合 §4.1.1 的三種無線狀態使用。 */
export function hasDrawableSegment(records, winFrom, winTo, today) {
  return compareSegments(records, winFrom, winTo, today).length > 0;
}

export const COMPARE_PRESETS = { all: null, y3: 3, y5: 5, y10: 10 };

/** 日期減 N 年；2 月 29 日等不存在的日子夾到當月最後一天（閏日以實際日曆計算）。 */
export function minusYears(iso, years) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = y - years;
  const lastDay = new Date(Date.UTC(target, m, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(target).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * §4.4 共用 X 軸範圍。右界＝max(T, 最後一筆預告起日)——預告要能看見。
 * preset 只裁切左界，**不改變** T、基準與摘要參考日。
 * → { from, to } 或 null（無任何可繪製日期列）
 */
export function compareRange(series, today, preset = 'all') {
  const limit = addDays(today, 365 * FAR_FUTURE_YEARS);
  const recs = series.flatMap((s) => s.records || []).filter((r) => r.from <= limit);
  if (!recs.length) return null;
  let earliest = recs[0].from;
  let lastFrom = recs[0].from;
  for (const r of recs) {
    if (r.from < earliest) earliest = r.from;
    if (r.from > lastFrom) lastFrom = r.from;
  }
  const to = lastFrom > today ? lastFrom : today;
  const years = COMPARE_PRESETS[preset] ?? null;
  return { from: years === null ? earliest : minusYears(today, years), to };
}

/**
 * §3.3 八步：URL → 選定清單。**順序不得調換**（先清洗去重合併，最後才截斷）。
 * → { items: [{ code, valid }], skipped, full }
 *   `items` 為截斷後的結果（≤ 4），`full` 為截斷前的完整有序清單，
 *   `skipped` ＝ `full.length − COMPARE_MAX`（未超量為 0）。
 *
 * 格式不合法與確認不存在的代號**佔用名額**（它們要顯示在畫面上），所以截斷只依
 * 格式層資訊，不因載入結果重新截斷。
 */
export function parseCompareCodes(search) {
  const codesRaw = rawParam(search, 'codes');            // 1. 同名參數取第一個
  const codeRaw = rawParam(search, 'code');
  const tokens = splitCodes(codesRaw);                   // 2–3. 解碼一次 → 切分 → 丟棄空 token

  const seen = new Set();
  const list = [];
  for (const token of tokens) {
    const code = token.trim().toUpperCase();             // 4. 清洗
    if (!code || seen.has(code)) continue;               // 6. 去重：保留最先出現者
    seen.add(code);
    list.push({ code, valid: isValidCode(code) });       // 5. 格式檢查（不合法者保留）
  }

  // 7. 合併 ?code=：無條件置於首位；已在清單中則移至首位，不重複加入。此步不截斷
  const single = (splitCodes(codeRaw)[0] || '').trim().toUpperCase();
  if (single) {
    const at = list.findIndex((x) => x.code === single);
    if (at >= 0) list.unshift(list.splice(at, 1)[0]);
    else list.unshift({ code: single, valid: isValidCode(single) });
  }

  // 8. 截斷：N 一律以完整清單長度計算
  return { items: list.slice(0, COMPARE_MAX), skipped: Math.max(0, list.length - COMPARE_MAX), full: list };
}

/** 取未解碼的原始參數值（URLSearchParams 會先解一次，再解就是解兩次）。 */
function rawParam(search, key) {
  const q = String(search || '').replace(/^\?/, '');
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if ((i === -1 ? part : part.slice(0, i)) !== key) continue;
    return i === -1 ? '' : part.slice(i + 1);
  }
  return null;
}

/** 解碼恰一次 → 以逗號切分 → 丟棄空 token（空 token 不計入略過數）。解碼失敗整個參數視為空。 */
function splitCodes(raw) {
  if (raw === null) return [];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return [];
  }
  return decoded.split(',').filter((t) => t.trim() !== '');
}

/** 選定清單 → `?codes=` 參數值（大寫、逗號分隔、依序）。 */
export function serializeCompareCodes(items) {
  return items.map((x) => (typeof x === 'string' ? x : x.code)).join(',');
}
