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
