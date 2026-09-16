// 健保藥價歷史查詢 — DOM、資源載入、競態處理。純邏輯在 engine.js。
//
// 資源四態（spec §8.7）：載入中／不可用（網路、404）／內容不合法（JSON 損毀、缺代號、版本不一致）／成功。
// 任何非成功狀態都不得顯示「查無」或他代號內容。
import * as E from './engine.js';

const $ = (id) => document.getElementById(id);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const dash = (s) => (s === null || s === undefined || s === '' ? '—' : esc(s));
const APP_TITLE = '健保藥價歷史查詢';

const state = {
  core: 'loading',            // loading | ready | error | mismatch
  coreError: null,
  meta: null,
  prepared: null,
  byCode: null,
  status: null,
  statusError: null,
  statusSettled: false,
  today: E.localISODate(),    // 頁面載入與每次選定藥品時取用，不跨午夜自動更新
  shardCache: new Map(),
  coreSeq: 0,
  detailSeq: 0,
  current: null,              // 目前詳細頁 { code, entry }
  newestFirst: true,
  // 預告中心（spec-upcoming §5.5）：snapshot 是最後一份**通過驗證**的快照，連同當時的
  // 最後檢查日一起保存；updateFailed 只有在新資料驗證成功時才解除——請求進行中解除，
  // 會讓畫面與 CSV 在更新尚未成功時看起來像最新資料
  upcoming: { phase: 'idle', snapshot: null, error: null, reason: null, updateFailed: null, refreshing: false },
  upcomingSeq: 0,
  upcomingInflight: 0,
};

// 逾時（毫秒）：請求卡住時必須在有限時間內轉為錯誤狀態，不可無限顯示「載入中」（codex R7）。
// index 約 3 MB gzip，慢速網路需較長時間。e2e 可經 window.NHI_FETCH_TIMEOUTS 縮短。
const TIMEOUT = { meta: 30_000, index: 120_000, status: 20_000, shard: 45_000, upcoming: 30_000, ...(globalThis.NHI_FETCH_TIMEOUTS || {}) };

class LoadError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

async function fetchJSON(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    } catch {
      throw new LoadError('network', ctrl.signal.aborted ? '連線逾時' : '網路連線失敗');
    }
    if (!res.ok) throw new LoadError('http', `HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      // headers 已到、body 還沒收完時逾時，仍是網路類失敗：歸成 invalid 會讓呼叫端
      // 誤判「來源已壞」而清掉還能用的舊快照（spec-upcoming §5.5）
      if (ctrl.signal.aborted) throw new LoadError('network', '連線逾時');
      throw new LoadError('invalid', '內容不是有效的 JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── 核心資源（meta、index、status）──────────────────────────────
// 每次載入帶序號：重試期間舊請求較晚完成時，結果一律丟棄，不得覆蓋較新的狀態（codex R6）。
// status 為輔助資源：不阻塞查詢；回來後才更新過期警示與來源資訊（codex R7）。
async function loadCore() {
  const seq = ++state.coreSeq;
  state.core = 'loading';
  state.coreError = null;
  state.status = null;
  state.statusError = null;
  state.statusSettled = false;
  renderBanners();            // 清掉舊的錯誤訊息與重試鈕，載入中不可重複觸發
  renderSource();
  renderCoreState();
  route();                    // 載入中：詳細頁顯示「資料載入中」，不得顯示「查無」

  performance.mark('index-fetch-start');
  fetchJSON('data/status.json', TIMEOUT.status).then((s) => [s, null], (e) => [null, e]).then(([s, e]) => {
    if (seq !== state.coreSeq) return;
    state.status = s;
    state.statusError = e;
    state.statusSettled = true;
    renderBanners();
    renderSource();
    renderUpcoming();                           // 預告頁的「最後檢查日」與到期提示互相獨立（§2）
    if (state.current) renderDetail();          // 紅色警示須同步加註於現行價旁
  });

  let next;
  try {
    const indexP = fetchJSON('data/drug_index.json', TIMEOUT.index).then((x) => {
      if (seq === state.coreSeq) performance.mark('index-parsed');
      return x;
    });
    const [meta, index] = await Promise.all([fetchJSON('data/meta.json', TIMEOUT.meta), indexP]);
    if (!E.validateMeta(meta).ok) throw new LoadError('invalid', 'meta.json 內容不合法');
    const vi = E.validateIndex(index, meta);
    if (vi.reason === 'version_mismatch') next = { core: 'mismatch' };
    else if (!vi.ok) throw new LoadError('invalid', 'drug_index.json 內容不合法');
    else {
      next = {
        core: 'ready', meta,
        prepared: E.prepareIndex(index.drugs),
        byCode: new Map(index.drugs.map((d) => [d.code, d])),
      };
    }
  } catch (e) {
    next = { core: 'error', coreError: e instanceof LoadError ? e : new LoadError('invalid', String(e)) };
  }
  if (seq !== state.coreSeq) return;            // 已有較新的載入：丟棄本次結果

  state.core = next.core;
  state.coreError = next.coreError || null;
  if (next.core === 'ready') {
    state.meta = next.meta;
    state.prepared = next.prepared;
    state.byCode = next.byCode;
    state.shardCache.clear();
  }
  renderBanners();
  renderSource();
  renderCoreState();
  if (state.core === 'ready') {
    performance.mark('search-ready');           // 搜尋框已啟用、首次查詢已執行
    performance.measure('index-fetch-to-parsed', 'index-fetch-start', 'index-parsed');
    performance.measure('parsed-to-searchable', 'index-parsed', 'search-ready');
  }
  route();
}

function coreMessageHTML() {
  if (state.core === 'loading') return '<div class="card"><p class="loading">資料載入中…</p></div>';
  if (state.core === 'mismatch') {
    return '<div class="alert alert--error">資料已更新，請重新整理頁面。<button type="button" data-action="reload">重新整理</button></div>';
  }
  return `<div class="alert alert--error">無法載入藥價資料（${esc(state.coreError?.message)}），目前無法查詢。`
    + '<button type="button" data-action="retry-core">重試</button></div>';
}

function renderCoreState() {
  const q = $('q');
  const status = $('searchStatus');
  if (state.core === 'ready') {
    q.disabled = false;
    q.placeholder = '例：AC48092100、撫緒、paroxetine';
    runSearch();
    return;
  }
  q.disabled = true;
  q.placeholder = state.core === 'loading' ? '資料載入中…' : '資料無法使用';
  $('results').innerHTML = '';
  status.textContent = state.core === 'loading' ? '資料載入中…' : '資料無法使用，請見上方訊息。';
}

// ── 橫幅：核心錯誤、過期警示（spec §8.6）─────────────────────────
function renderBanners() {
  const out = [];
  if (state.core === 'error' || state.core === 'mismatch') out.push(coreMessageHTML());
  const st = stale();
  if (st.level === 'yellow' || st.level === 'red') {
    const cls = st.level === 'red' ? 'alert--error' : 'alert--warn';
    const when = st.checkedDate ? `最後檢查：${st.checkedDate}，${st.days} 天前` : '無法取得資料檢查狀態';
    out.push(`<div class="alert ${cls}" data-stale="${st.level}">資料可能未更新，請以健保署公告為準（${esc(when)}）。</div>`);
  }
  $('banners').innerHTML = out.join('');
}

function stale() {
  if (!state.statusSettled) return { level: 'none' };
  return E.staleness(state.status?.lastCheckedAt, state.today);
}

// ── 資料來源與更新時間（spec §8.5）──────────────────────────────
const TW_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?\+08:00$/;
function twTime(iso) {
  if (typeof iso !== 'string') return '無法取得';
  const m = TW_TIME.exec(iso);
  return m ? `${m[1]} ${m[2]}（台灣時間）` : esc(iso);
}

function renderSource() {
  const s = state.status;
  const m = state.meta;
  const rows = [];
  const result = { changed: '資料有更新', unchanged: '資料無變動' }[s?.lastCheckResult];
  const checked = !state.statusSettled ? '載入中…'
    : s ? `${twTime(s.lastCheckedAt)}${result ? `・${result}` : ''}` : '無法取得';
  rows.push(['最後檢查', checked]);
  rows.push(['本站資料產生時間', m ? `${twTime(m.generatedAt)}<br><small>已發布資料批次的產生時間，不代表官方內容異動時間；官方月更，落後一個月屬正常</small>` : '—']);
  rows.push(['data.gov.tw 資料集更新時間', s?.sourceModifiedAt ? esc(s.sourceModifiedAt) : '無法取得']);
  if (m) {
    rows.push(['涵蓋期間', `<span class="mono">${esc(m.coverageStart)} ～ ${esc(m.coverageEnd)}</span>（含已公告未生效）`]);
    rows.push(['資料規模', `<span class="mono">${Number(m.uniqueDrugCodeCount).toLocaleString('zh-TW')}</span> 個健保代號、<span class="mono">${Number(m.sourceRowCount).toLocaleString('zh-TW')}</span> 筆紀錄`]);
  }
  rows.push(['來源', '<a href="https://data.gov.tw/dataset/23715" target="_blank" rel="noopener">健保用藥品項查詢項目檔（data.gov.tw）↗</a>']);
  $('sourceInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ── 搜尋 ────────────────────────────────────────────────────────
// 品質提示文案與 CSV 備註欄共用同一份，避免兩處漂移
const flagTags = (flags) => (flags || []).map((f) => `<span class="tag warn">${esc(E.UPCOMING_FLAG_TEXT[f] || f)}</span>`).join('');

function upcomingTag(label) {
  if (!label) return '';
  const warn = label.startsWith('⚠ ');
  return `<span class="tag ${warn ? 'warn' : 'info'}">預告：${esc(warn ? label.slice(2) : label)}</span>`;
}

function strengthText(d) {
  return d.strength ? `${d.strength}${d.strengthUnit ? ` ${d.strengthUnit}` : ''}` : '';
}

function renderCard(d) {
  const c = E.searchCard(d, state.today);
  let price;
  if (c.kind === 'priced') price = `<span class="val">${esc(c.rawPrice)}</span> 元`;
  else if (c.kind === 'stopped') price = `<span class="tag stop">${esc(c.text)}</span>`;
  else if (c.kind === 'exhausted' || c.kind === 'conflict') price = `<span class="tag warn">${esc(c.text)}</span>`;
  else price = `<span class="tag info">${esc(c.text)}</span>`;
  const sub = [d.ingredient, strengthText(d), d.dosageForm].filter(Boolean).map(esc).join('・');
  return `<a class="result" href="?code=${encodeURIComponent(d.code)}" data-code="${esc(d.code)}">
    <div class="r-top"><span class="r-name">${dash(d.chName)}</span><span class="r-code mono">${esc(d.code)}</span></div>
    <div class="r-en">${dash(d.enName)}</div>
    ${sub ? `<div class="r-sub">${sub}</div>` : ''}
    <div class="r-price">${price}${upcomingTag(c.upcoming)}</div>
    <div class="r-meta">最近異動 <span class="mono">${dash(d.lastPriceChangeDate)}</span>・歷史 ${d.historyCount} 筆・調價 ${d.priceChangeCount} 次 ${flagTags(d.flags)}</div>
  </a>`;
}

function runSearch() {
  if (state.core !== 'ready') return;
  const q = $('q').value;
  const status = $('searchStatus');
  const t0 = performance.now();
  const res = E.search(state.prepared, q, $('showTerminated').checked ? null : hideMask());
  performance.measure('search-compute', { start: t0 });
  if (res === null) {
    status.textContent = '請輸入健保代號、品名或成分開始搜尋。';
    $('results').innerHTML = '';
    return;
  }
  const hiddenNote = res.hidden
    ? `另有 ${res.hidden.toLocaleString('zh-TW')} 筆已終止支付品項未顯示（勾選「顯示已終止支付品項」即可查看）。`
    : '';
  if (res.total === 0) {
    // 全部被篩掉時不得只說「查無」：品項存在，只是目前終止支付
    status.textContent = res.hidden
      ? `沒有符合「${q.trim()}」的現行支付品項；${hiddenNote}`
      : `查無符合「${q.trim()}」的藥品。`;
    $('results').innerHTML = '';
    return;
  }
  status.textContent = (res.total > E.MAX_RESULTS
    ? `共 ${res.total.toLocaleString('zh-TW')} 筆，僅顯示前 ${E.MAX_RESULTS} 筆，請縮小搜尋範圍。`
    : `共 ${res.total} 筆。`) + hiddenNote;
  const t1 = performance.now();
  $('results').innerHTML = res.items.map(renderCard).join('');
  performance.measure('search-render', { start: t1 });
}

// 「現行 0 元」遮罩依瀏覽器日期而定：同一天只算一次，日期改變（state.today 於選藥時更新）才重算
let maskCache = { prepared: null, day: null, mask: null };
function hideMask() {
  if (maskCache.prepared !== state.prepared || maskCache.day !== state.today) {
    maskCache = { prepared: state.prepared, day: state.today, mask: E.terminatedMask(state.prepared, state.today) };
  }
  return maskCache.mask;
}

let searchFrame = 0;
function scheduleSearch() {
  cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(runSearch);
}

// ── 路由 ────────────────────────────────────────────────────────
function route() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (params.get('view') === 'upcoming') showUpcoming();
  else if (code !== null) showDetail(code.trim().toUpperCase());
  else showSearch();
}

function showSearch() {
  state.detailSeq++;                   // 丟棄尚未回應的詳細頁請求
  state.upcomingSeq++;                 // 同時使在途的預告請求失效，其回應一律丟棄
  state.current = null;
  $('detailView').hidden = true;
  $('upcomingView').hidden = true;
  $('searchView').hidden = false;
  $('detail').innerHTML = '';
  document.title = APP_TITLE;
}

function navigate(code) {
  history.pushState({ code, fromSearch: true }, '', `?code=${encodeURIComponent(code)}`);
  showDetail(code);
  window.scrollTo(0, 0);
}

// ── 詳細頁 ──────────────────────────────────────────────────────
async function showDetail(code) {
  const seq = ++state.detailSeq;
  state.upcomingSeq++;                 // 同上：離開預告頁即丟棄其在途回應
  state.current = null;
  $('searchView').hidden = true;
  $('upcomingView').hidden = true;
  $('detailView').hidden = false;
  const box = $('detail');

  if (state.core !== 'ready') {
    box.innerHTML = coreMessageHTML();
    document.title = APP_TITLE;
    return;
  }
  state.today = E.localISODate();
  const drug = state.byCode.get(code);
  if (!drug) {
    box.innerHTML = `<div class="card"><h2>查無此代號</h2>
      <p>找不到健保代號 <span class="mono">${esc(code) || '（空白）'}</span>。請確認代號是否正確，或<a href="./" data-action="to-search">回搜尋頁</a>以品名查詢。</p></div>`;
    document.title = `查無此代號 — ${APP_TITLE}`;
    return;
  }

  document.title = `${drug.chName || code}（${code}）— ${APP_TITLE}`;
  box.innerHTML = `<div class="card"><p class="loading">載入 <span class="mono">${esc(code)}</span> 的歷史資料中…</p></div>`;

  const prefix = E.shardPrefix(code, state.meta.shards);
  let shard;
  try {
    if (!prefix) throw new LoadError('invalid', '分片清單中找不到此代號');
    const t0 = performance.now();
    shard = state.shardCache.get(prefix) ?? await fetchJSON(`data/history/${encodeURIComponent(prefix)}.json`, TIMEOUT.shard);
    performance.measure('shard-fetch-parse', { start: t0 });
  } catch (e) {
    if (seq !== state.detailSeq) return;
    box.innerHTML = shardErrorHTML(code, e.message);
    return;
  }
  if (seq !== state.detailSeq) return;            // 使用者已改選其他代號：丟棄本回應

  const v = E.validateShard(shard, state.meta, prefix, code);
  if (!v.ok) {
    box.innerHTML = v.reason === 'version_mismatch'
      ? '<div class="alert alert--error">資料已更新，請重新整理頁面。<button type="button" data-action="reload">重新整理</button></div>'
      : shardErrorHTML(code, v.reason === 'missing_code' ? '分片中缺少此代號' : '分片內容不合法');
    return;
  }
  state.shardCache.set(prefix, shard);
  state.current = { code, drug, entry: shard.drugs[code] };
  try {
    const t0 = performance.now();
    renderDetail();
    performance.measure('detail-render', { start: t0 });
  } catch (e) {
    state.current = null;
    box.innerHTML = shardErrorHTML(code, `畫面產生失敗：${e.message}`);
  }
}

function shardErrorHTML(code, msg) {
  return `<div class="alert alert--error">無法載入 <span class="mono">${esc(code)}</span> 的歷史資料（${esc(msg)}）。`
    + `<button type="button" data-action="retry-shard" data-code="${esc(code)}">重試</button></div>`;
}

const safeLink = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

function renderDetail() {
  chartWidth = measureChartWidth();
  const { code, entry } = state.current;
  const T = state.today;
  const recs = entry.records;
  const s = E.summaryAt(recs, T);
  const meta = E.selectMeta(entry, T);
  const st = stale();
  // 入口只依詳細頁自己的 history 判定，不讀 upcoming.json：詳細頁的單一真相仍是
  // 完整 history，且兩者跨日後本來就可能不一致（詳細頁依 T、清單依 D）（§6）
  const hasUpcoming = recs.some((r) => r.from > T);

  const facts = meta ? [
    ['成分', meta.ingredient], ['規格', strengthText(meta)], ['劑型', meta.dosageForm],
    ['ATC', meta.atcCode], ['藥商', meta.manufacturer], ['製造廠', meta.maker],
  ] : [];
  const tfda = safeLink(meta?.tfdaLink);
  const rule = safeLink(meta?.nhiRuleLink);

  const head = `<div class="card detail-head">
    <div class="code mono">${esc(code)}</div>
    <h2>${dash(meta?.chName)}</h2>
    <div class="en">${dash(meta?.enName)}</div>
    ${meta ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${dash(v)}</dd>`).join('')}</dl>`
    : '<p class="hint">尚無已生效紀錄，描述欄位待生效後顯示。</p>'}
    <p class="hint" style="margin:0.6rem 0 0">品名、成分等描述欄位為來源以現況回填之資料，非各期間當時的名稱。</p>
    ${tfda || rule || hasUpcoming ? `<div class="links">
      ${tfda ? `<a href="${esc(tfda)}" target="_blank" rel="noopener">TFDA 許可證資料 ↗</a>` : ''}
      ${rule ? `<a href="${esc(rule)}" target="_blank" rel="noopener">健保給付規定（PDF）↗</a>` : ''}
      ${hasUpcoming ? '<a href="?view=upcoming" data-action="to-upcoming">前往預告中心 ↗</a>' : ''}
    </div>` : ''}
  </div>`;

  const quality = (entry.flags || []).map((f) => `<div class="alert alert--warn">${esc(QUALITY_TEXT[f] || f)}</div>`).join('');

  $('detail').innerHTML = `${head}
    ${quality ? `<div class="warnings">${quality}</div>` : ''}
    <section class="card" aria-labelledby="sumTitle">
      <h2 id="sumTitle">支付價摘要 <span class="ref-date">參考日期：<span class="mono">${esc(T)}</span>（依您裝置的日期）</span></h2>
      <div class="results">${summaryMetrics(s, recs, entry, st)}</div>
    </section>
    <section class="card chart-card" aria-labelledby="chartTitleH">
      <h2 id="chartTitleH">支付價走勢</h2>
      <p class="hint">階梯線表示每段有效區間內的固定支付價；終止、暫停、空窗期間不畫價格線。游標停在線段上可看區間與金額。</p>
      ${renderChart(recs, T)}
    </section>
    <section class="card" aria-labelledby="tableTitle">
      <div class="table-tools">
        <h2 id="tableTitle">歷史紀錄（${recs.length + entry.invalidRecords.length} 筆）</h2>
        <button type="button" data-action="toggle-sort" aria-pressed="${state.newestFirst}">排序：${state.newestFirst ? '新 → 舊' : '舊 → 新'}</button>
      </div>
      <div class="table-wrap">${renderTable(entry, T)}</div>
    </section>`;
}

const QUALITY_TEXT = {
  gap: '此代號有支付空窗：歷史表中標示「前有空窗」的紀錄之前，有一段來源未涵蓋的期間；圖表於空窗處中斷，不以前一價格延續。',
  overlap: '來源紀錄的有效區間有重疊，受影響紀錄已在歷史表標示「重疊」。',
  conflict: '來源紀錄衝突：同一期間有不同支付價，受影響日期無法判定單一支付價。',
  invalid_records: '部分來源紀錄的日期無法解析，已原樣列於歷史表末並標「日期異常」，不納入摘要與圖表。',
  question_mark: '品名或成分含「?」：來源將罕用字替換為「?」，本站不自行補字；以正確字搜尋可能查不到此品項。',
  inconsistent_metadata: '此代號各紀錄的描述欄位不一致，依參考日期選用對應紀錄的欄位。',
};

function metric(name, valHTML, { key = false, text = false, interp = '', ci = '' } = {}) {
  return `<div class="metric${key ? ' key' : ''}">
    <div class="name">${name}</div>
    <div class="val${text ? ' text' : ''}">${valHTML}</div>
    ${ci ? `<div class="ci">${ci}</div>` : ''}
    ${interp}
  </div>`;
}

const interp = (cls, text, attrs = '') => `<div class="interp ${cls}"${attrs}>${esc(text)}</div>`;

function summaryMetrics(s, recs, entry, st) {
  // 1. 現行支付價
  const notes = [];
  if (s.upcoming) {
    const label = E.upcomingLabel(s.upcoming, E.pricedBefore(recs, s.upcoming));
    const warn = label.startsWith('⚠ ');
    notes.push(interp(warn ? 'warn' : 'muted', `預告：${warn ? label.slice(2) : label}`, ' data-upcoming'));
  } else {
    notes.push(interp('muted', '無已公告的預告異動'));
  }
  if (st.level === 'red') notes.push(interp('warn', '資料可能已過期，請以健保署公告為準', ' data-stale-note'));
  let curVal;
  let curText = true;
  if (s.status === 'priced') {
    curVal = `${esc(s.current.rawPrice)} <small>元</small>`;
    curText = false;
  } else {
    curVal = esc(E.currentLabel(s));
    if (s.status === 'conflict') {
      curVal += `<ul class="candidates">${s.currentCandidates.map((r) => `<li><span class="mono">${esc(r.from)} ～ ${esc(r.to ?? '')}</span>：${esc(E.stateLabel(r, E.pricedBefore(recs, r), 'cell'))}</li>`).join('')}</ul>`;
    }
  }
  const cur = metric('現行支付價', curVal, { key: true, text: curText, interp: notes.join('') });

  // 2–5
  const latest = metric('最新一次調整', esc(E.latestEventLabel(s.latestEvent)), { text: true });
  const count = metric('歷史調價次數', `${s.priceChangeCount} <small>次</small>`, { ci: '僅計調升／調降；不含終止、暫停、恢復支付' });
  const total = recs.length + entry.invalidRecords.length;
  const first = metric('最早可取得紀錄', recs.length ? esc(recs[0].from) : '—', { ci: `共 ${total} 筆紀錄` });
  const change = metric('總變化', esc(E.totalChangeLabel(s)), { text: true, ci: '已生效紀錄中第一筆有價 → 最後一筆有價' });
  return cur + latest + count + first + change;
}

// ── 圖表（手刻 SVG；區段模型見 engine.chartModel）─────────────────
// viewBox 寬度＝實際容器寬度，文字才會維持 11px（固定 800 寬在手機上會縮到約 5px）
const M = { l: 58, r: 14, t: 16, b: 30 };
let chartWidth = 800;

function measureChartWidth() {
  const card = document.querySelector('#detail .chart-card') || $('detail');
  const inner = card.clientWidth - 2 * 20;            // 扣卡片左右 padding
  return Math.max(320, Math.min(900, Math.round(inner || 800)));
}

const BAND_CLASS = { terminated: 'term', unpriced_zero: 'zero', suspended: 'susp', unknown: 'unknown' };

function renderChart(recs, T) {
  const m = E.chartModel(recs, T);
  if (m.xMin === null) return '<p class="hint">無可繪製的紀錄。</p>';
  const W = chartWidth;
  const H = W < 520 ? 230 : 280;
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const x = (d) => M.l + ((d - m.xMin) / (m.xMax - m.xMin)) * iw;
  const y = (v) => M.t + (1 - (v - m.yMin) / (m.yMax - m.yMin)) * ih;
  const f = (n) => n.toFixed(1);
  const priors = E.priorPrices(recs);
  const tip = (r) => `${r.from} ～ ${r.to ?? '無迄日'}：${E.stateLabel(r, priors.get(r), 'cell')}${r.from > T ? '（預告）' : ''}`;
  const parts = [];

  parts.push(`<defs>
    <pattern id="hatchTerm" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="#FDF3F2"/><line x1="0" y1="0" x2="0" y2="8" style="stroke:var(--c-term)" stroke-width="2"/></pattern>
    <pattern id="dotsSusp" width="7" height="7" patternUnits="userSpaceOnUse">
      <rect width="7" height="7" fill="#F1F1F1"/><circle cx="3.5" cy="3.5" r="1.3" style="fill:var(--c-susp)"/></pattern>
    <pattern id="crossUnknown" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="#FFF8EC"/><path d="M0 0L8 8M8 0L0 8" style="stroke:var(--c-unknown)" stroke-width="1"/></pattern>
    <pattern id="lineZero" width="10" height="6" patternUnits="userSpaceOnUse">
      <rect width="10" height="6" fill="#F4F1EB"/><line x1="0" y1="3" x2="10" y2="3" style="stroke:var(--c-susp)" stroke-width="0.8"/></pattern>
  </defs>`);

  // 區塊：終止／此前無有價的 0 元／暫停／異常／空窗
  for (const b of m.bands) {
    parts.push(`<rect class="band-${BAND_CLASS[b.kind]}${b.upcoming ? ' band-upcoming' : ''}" data-band="${b.kind}"
      x="${f(x(b.x0))}" y="${M.t}" width="${f(Math.max(1, x(b.x1) - x(b.x0)))}" height="${ih}"><title>${esc(tip(b.record))}</title></rect>`);
  }
  for (const g of m.gaps) {
    parts.push(`<rect class="band-gap" x="${f(x(g.x0))}" y="${M.t}" width="${f(Math.max(1, x(g.x1) - x(g.x0)))}" height="${ih}">
      <title>${esc(`${E.fromDayNumber(g.x0)} ～ ${E.fromDayNumber(g.x1 - 1)}：此期間無支付紀錄（空窗）`)}</title></rect>`);
  }

  // 格線與座標軸
  const hasPrice = m.lines.length > 0;
  if (hasPrice) {
    for (const v of E.niceTicks(m.yMin, m.yMax, 5)) {
      parts.push(`<g class="grid"><line x1="${M.l}" x2="${W - M.r}" y1="${f(y(v))}" y2="${f(y(v))}"/></g>
        <text x="${M.l - 6}" y="${f(y(v) + 4)}" text-anchor="end">${esc(E.fmtMoney(v))}</text>`);
    }
    parts.push(`<text x="${M.l - 6}" y="${M.t - 4}" text-anchor="end">元</text>`);
  }
  const y0 = +E.fromDayNumber(m.xMin).slice(0, 4);
  const y1 = +E.fromDayNumber(m.xMax).slice(0, 4);
  const maxTicks = Math.max(3, Math.floor(iw / 70));   // 年份標籤約 70px 一個，避免重疊
  const step = [1, 2, 5, 10, 20].find((s) => (y1 - y0) / s <= maxTicks) || 20;
  for (let yr = Math.ceil((y0 + 1) / step) * step; yr <= y1; yr += step) {
    const xv = x(E.dayNumber(`${yr}-01-01`));
    if (xv < M.l || xv > W - M.r) continue;
    parts.push(`<g class="axis"><line x1="${f(xv)}" x2="${f(xv)}" y1="${H - M.b}" y2="${H - M.b + 4}"/></g>
      <text x="${f(xv)}" y="${H - M.b + 16}" text-anchor="middle">${yr}</text>`);
  }
  parts.push(`<g class="axis"><line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/></g>`);

  // 今日
  if (m.today >= m.xMin && m.today <= m.xMax) {
    const tx = f(x(m.today));
    parts.push(`<g class="today"><line x1="${tx}" x2="${tx}" y1="${M.t}" y2="${H - M.b}"/></g>
      <text x="${tx}" y="${M.t - 4}" text-anchor="middle">今日</text>`);
  }

  // 價格線段、垂直連接、事件標記
  for (const c of m.connectors) {
    parts.push(`<line class="price${c.upcoming ? ' upcoming' : ''}" x1="${f(x(c.x))}" x2="${f(x(c.x))}" y1="${f(y(c.y0))}" y2="${f(y(c.y1))}"/>`);
  }
  for (const l of m.lines) {
    const t = `<title>${esc(tip(l.record))}</title>`;
    const coords = `x1="${f(x(l.x0))}" x2="${f(x(l.x1))}" y1="${f(y(l.y))}" y2="${f(y(l.y))}"`;
    parts.push(`<line class="price${l.upcoming ? ' upcoming' : ''}" ${coords}/><line class="hit" ${coords}>${t}</line>`);
  }
  for (const k of m.markers) {
    const cx = x(k.x);
    const cy = y(k.y);
    const d = k.type === 'increase' ? `M${f(cx)} ${f(cy - 6)}L${f(cx + 5)} ${f(cy + 3)}L${f(cx - 5)} ${f(cy + 3)}Z`
      : k.type === 'decrease' ? `M${f(cx)} ${f(cy + 6)}L${f(cx + 5)} ${f(cy - 3)}L${f(cx - 5)} ${f(cy - 3)}Z`
        : `M${f(cx)} ${f(cy - 6)}L${f(cx + 5)} ${f(cy)}L${f(cx)} ${f(cy + 6)}L${f(cx - 5)} ${f(cy)}Z`;
    parts.push(`<path class="marker ${k.type}${k.upcoming ? ' upcoming' : ''}" d="${d}"><title>${esc(tip(k.record))}</title></path>`);
  }

  const desc = hasPrice
    ? `共 ${m.lines.length} 段有價區間、${m.bands.length} 段非有價區間、${m.gaps.length} 段空窗；逐筆數值見下方歷史表。`
    : '此代號沒有有價紀錄，圖中只標示非有價區間；逐筆數值見下方歷史表。';
  const svg = `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chartSvgTitle chartSvgDesc"
    data-lines="${m.lines.length}" data-bands="${m.bands.length}" data-gaps="${m.gaps.length}">
    <title id="chartSvgTitle">健保支付價走勢圖</title><desc id="chartSvgDesc">${esc(desc)}</desc>${parts.join('')}</svg></div>`;

  const notes = [];
  if (!hasPrice) notes.push('此代號沒有有價紀錄。');
  else if (m.yMin > 0) notes.push('縱軸未由 0 起算，以便看出小幅調價；請以刻度數值判讀幅度。');
  if (m.skipped) notes.push(`${m.skipped} 筆起日異常遙遠的紀錄未繪製（見歷史表）。`);

  return `${svg}${notes.map((n) => `<p class="axis-note">${esc(n)}</p>`).join('')}${legend(m)}
    <label class="chart-opts"><input type="checkbox" data-action="cb-safe"${document.body.classList.contains('cb-safe') ? ' checked' : ''}> 色盲友善配色</label>`;
}

const sw = (inner) => `<svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">${inner}</svg>`;
// 圖例只列本圖實際出現的區塊類型（「此前無有價的 0 元」與「終止支付」分開，§5.3）
function legend(m) {
  const kinds = new Set(m.bands.map((b) => b.kind));
  const items = [
    `<span>${sw('<line x1="1" x2="25" y1="6" y2="6" style="stroke:var(--c-line)" stroke-width="2.5"/>')}支付價</span>`,
    `<span>${sw('<line x1="1" x2="25" y1="6" y2="6" style="stroke:var(--c-upcoming)" stroke-width="2.5" stroke-dasharray="6 4"/>')}預告（尚未生效）</span>`,
    `<span>${sw('<path d="M13 1L18 10L8 10Z" style="fill:var(--c-term)"/>')}調升</span>`,
    `<span>${sw('<path d="M13 11L18 2L8 2Z" style="fill:var(--c-line)"/>')}調降</span>`,
    `<span>${sw('<path d="M13 0L19 6L13 12L7 6Z" style="fill:var(--c-unknown)"/>')}恢復支付</span>`,
  ];
  if (kinds.has('terminated')) items.push(`<span data-legend="terminated">${sw('<rect width="26" height="12" fill="url(#hatchTerm)"/>')}終止支付</span>`);
  if (kinds.has('unpriced_zero')) items.push(`<span data-legend="unpriced_zero">${sw('<rect width="26" height="12" fill="url(#lineZero)"/>')}健保支付價 0 元（此前無有價紀錄）</span>`);
  if (kinds.has('suspended')) items.push(`<span data-legend="suspended">${sw('<rect width="26" height="12" fill="url(#dotsSusp)"/>')}暫停支付</span>`);
  if (kinds.has('unknown')) items.push(`<span data-legend="unknown">${sw('<rect width="26" height="12" fill="url(#crossUnknown)"/>')}來源資料異常</span>`);
  if (m.gaps.length) items.push(`<span data-legend="gap">${sw('<rect width="26" height="12" fill="#F3EFE8" stroke="#CFC6B8"/>')}空窗（無紀錄）</span>`);
  return `<div class="legend">${items.join('')}</div>`;
}

// ── 歷史表（spec §8.3、E3）──────────────────────────────────────
const EVENT_TEXT = {
  initial: '最早紀錄', first_priced: '首次有價', increase: '調升', decrease: '調降',
  unchanged: '同價續期', terminated: '終止支付', suspended: '暫停支付',
  relisted: '恢復支付（跨越停止期間）', unknown: '變動無法判定',
};
const INVALID_TEXT = { blank_start: '起日空白', invalid_date: '日期無法解析', inverted_interval: '起日晚於迄日' };
const CHANGE_TYPES = new Set(['increase', 'decrease', 'relisted']);

function eventText(r, prior) {
  if (r.eventType === 'unchanged' && r.priceState !== 'priced') return '同狀態續期';
  // 此前從未有價的 0 元：事件欄不得稱「終止」（§5.3，codex R3）
  if (r.eventType === 'terminated' && E.isUnpricedZero(r, prior)) return '0 元（此前無有價紀錄）';
  return EVENT_TEXT[r.eventType] || r.eventType;
}

function renderTable(entry, T) {
  const priors = E.priorPrices(entry.records);
  const rows = entry.records.map((r) => {
    const prior = priors.get(r);
    const upcoming = r.from > T;
    const current = E.isEffective(r, T);
    const to = r.to ?? (upcoming ? '—（預告，無迄日）' : '—（持續有效）');
    const stop = (r.priceState === 'terminated' && !E.isUnpricedZero(r, prior)) || r.priceState === 'suspended';
    const tags = [
      current ? '<span class="tag now">現行</span>' : '',
      upcoming ? '<span class="tag info">預告</span>' : '',
      `<span class="tag${stop ? ' stop' : ''}">${esc(eventText(r, prior))}</span>`,
      r.flags.includes('gap_before') ? '<span class="tag warn">前有空窗</span>' : '',
      r.flags.includes('conflicting_price_interval') ? '<span class="tag warn">來源紀錄衝突</span>' : '',
      r.flags.includes('overlap') ? '<span class="tag warn">重疊</span>' : '',
    ].join('');
    const change = CHANGE_TYPES.has(r.eventType);
    const price = r.priceState === 'priced'
      ? `<span class="mono">${esc(r.rawPrice)}</span>`
      : esc(E.stateLabel(r, prior, 'cell'));
    return `<tr class="${current ? 'is-current' : ''}${upcoming ? ' is-upcoming' : ''}" data-kind="record">
      <td class="date">${esc(r.from)}</td><td class="date">${esc(to)}</td>
      <td class="num${r.priceState === 'priced' ? '' : ' label'}" title="原始值：${esc(r.rawPrice)}">${price}</td>
      <td class="num mono">${change && r.absoluteChange !== null ? esc(E.fmtSigned(E.fmtMoney(r.absoluteChange))) : '—'}</td>
      <td class="num mono">${change && r.percentChange !== null ? esc(E.fmtPct(r.percentChange)) : '—'}</td>
      <td><div class="cell-state">${tags}</div></td></tr>`;
  });
  if (state.newestFirst) rows.reverse();
  const invalid = entry.invalidRecords.map((r) => `<tr class="is-invalid" data-kind="invalid">
      <td class="date">${esc(r.rawFrom) || '（空白）'}</td><td class="date">${esc(r.rawTo) || '（空白）'}</td>
      <td class="num mono">${esc(r.rawPrice) || '（空白）'}</td><td class="num">—</td><td class="num">—</td>
      <td><div class="cell-state"><span class="tag warn">日期異常：${esc(INVALID_TEXT[r.error] || r.error)}</span></div></td></tr>`);
  return `<table class="history">
    <thead><tr><th scope="col">生效日</th><th scope="col">迄日</th><th scope="col">支付價（元）</th>
      <th scope="col">與前次差額</th><th scope="col">變動 %</th><th scope="col">狀態</th></tr></thead>
    <tbody>${rows.join('')}${invalid.join('')}</tbody></table>`;
}

// ── 預告中心（spec-upcoming.md §5）────────────────────────────────
// 兩個日期必須分別呈現，不得互相代替（§2）：
//   D＝upcoming.buildDate  已發布的這份預告是哪一天產生的
//   T＝state.today         瀏覽器本地日期，決定每列是「預告」或「已生效（資料待更新）」
// 「已生效」提示以 T 對 effectiveDate 判定，獨立於過期警示（以最後檢查日判定）：
// 最後檢查日很新時不得因此壓掉到期提示。
function upcomingBadgeText() {
  const snap = state.upcoming.snapshot;
  if (!snap) return '預告';
  return `預告 ${E.upcomingPendingCount(snap.payload.items, state.today).toLocaleString('zh-TW')}`;
}

function renderUpcomingBadge() {
  $('upcomingBadge').textContent = upcomingBadgeText();
}

async function loadUpcoming({ force = false } = {}) {
  const u = state.upcoming;
  if (state.core === 'loading') {        // 版本驗證需要 meta；核心資源落定後 route() 會再進來
    state.upcoming = { ...u, phase: 'loading' };
    renderUpcoming();
    return;
  }
  // 只有「當代」的在途請求才擋住新請求：離開預告頁時 upcomingSeq 已遞增，
  // 此時舊請求即使還在途，重新進入也必須能建立新一代請求，否則畫面會卡在骨架
  if (state.upcomingInflight && state.upcomingInflight === state.upcomingSeq) return;
  if (!force && u.phase === 'ready') return;
  const seq = ++state.upcomingSeq;
  state.upcomingInflight = seq;
  performance.mark('upcoming-fetch-start');          // U14 量測起點：點擊徽章那一刻
  // 請求進行中：快照與「更新失敗」標示原封不動，只標記 refreshing
  state.upcoming = { ...u, phase: u.snapshot ? 'ready' : 'loading', refreshing: true, error: null, reason: null };
  renderUpcoming();

  const fail = (err, reason) => ({ phase: 'error', snapshot: null, error: err, reason, updateFailed: null, refreshing: false });
  let next;
  try {
    const payload = await fetchJSON('data/upcoming.json', TIMEOUT.upcoming);
    const v = E.validateUpcoming(payload, state.meta);
    if (!state.meta) {
      // meta 不可用 → 無法驗證版本，視同不可用；不得略過版本檢查逕行渲染（§5.5）
      next = fail(new LoadError('invalid', '無法驗證資料版本'), 'unavailable');
    } else if (v.ok) {
      // 快照帶走當時的最後檢查日：更新失敗時不得配上新的最後檢查日（§5.5）
      next = {
        phase: 'ready',
        snapshot: { payload, checkedAt: state.statusSettled ? (state.status?.lastCheckedAt ?? null) : null },
        error: null, reason: null, updateFailed: null, refreshing: false,
      };
    } else next = { phase: 'error', snapshot: null, error: null, reason: v.reason, updateFailed: null, refreshing: false };
  } catch (e) {
    const err = e instanceof LoadError ? e : new LoadError('invalid', String(e));
    // 網路／HTTP／逾時：已有經驗證的快照就保留舊清單，連同當時的 buildDate 與檢查日一起標示；
    // 內容不合法與版本不符則不得保留——新資料證明來源已壞（§5.5）
    if (err.kind === 'invalid') next = fail(err, 'invalid');
    else if (state.upcoming.snapshot) {
      next = { ...state.upcoming, phase: 'ready', error: null, reason: null, updateFailed: err, refreshing: false };
    } else next = fail(err, 'unavailable');
  }
  if (state.upcomingInflight === seq) state.upcomingInflight = 0;   // 只清掉自己這一代
  if (seq !== state.upcomingSeq) return;          // 已有較新的請求：丟棄本次結果
  state.upcoming = next;
  renderUpcomingBadge();
  renderUpcoming();
}

const UPCOMING_ERROR_TEXT = {
  version_mismatch: '資料已更新，請重新整理頁面。',
  invalid: '預告資料內容不合法，無法顯示。',
  unavailable: '無法取得預告資料。',
};

function upcomingDatesHTML() {
  const u = state.upcoming;
  const d = u.snapshot?.payload.buildDate;
  // 更新失敗時顯示快照當時的檢查日，不得換成新的（§5.5）
  const checked = u.updateFailed
    ? (u.snapshot?.checkedAt ? twTime(u.snapshot.checkedAt) : '無法取得')
    : (state.statusSettled ? (state.status?.lastCheckedAt ? twTime(state.status.lastCheckedAt) : '無法取得') : '載入中…');
  return `資料產生日 <span class="mono">${d ? esc(d) : '—'}</span>・最後檢查 ${checked}`;
}

function renderUpcoming() {
  if ($('upcomingView').hidden) return;
  const u = state.upcoming;
  const list = $('upcomingList');
  const status = $('upcomingStatus');
  $('upcomingDates').innerHTML = upcomingDatesHTML();

  if (u.phase === 'loading') {
    status.textContent = '預告資料載入中…';
    $('upcomingBanner').innerHTML = '';
    $('upcomingControls').hidden = true;
    list.innerHTML = '<div class="skeleton" aria-hidden="true"></div>'.repeat(3);
    return;
  }
  if (u.phase !== 'ready') {
    status.textContent = '';
    list.innerHTML = '';
    $('upcomingControls').hidden = true;        // 資料不可用時篩選與匯出一併停用
    const retry = u.reason === 'version_mismatch'
      ? '<button type="button" data-action="reload">重新整理</button>'
      : '<button type="button" data-action="retry-upcoming">重試</button>';
    const detail = u.error?.message ? `（${esc(u.error.message)}）` : '';
    $('upcomingBanner').innerHTML = `<div class="alert alert--error">${UPCOMING_ERROR_TEXT[u.reason] || UPCOMING_ERROR_TEXT.unavailable}${detail}${retry}</div>`;
    return;
  }

  const payload = u.snapshot.payload;
  const banners = [];
  if (u.updateFailed) {
    banners.push(`<div class="alert alert--warn">更新失敗（${esc(u.updateFailed.message)}），顯示的是 ${esc(payload.buildDate)} 的資料。`
      + '<button type="button" data-action="retry-upcoming">重試</button></div>');
  }
  if (state.today < payload.buildDate) {
    banners.push(`<div class="alert alert--warn">本站資料產生於 ${esc(payload.buildDate)}，晚於你的裝置日期；清單可能未涵蓋該日之後的公告。</div>`);
  }
  $('upcomingBanner').innerHTML = banners.join('');

  const items = payload.items;
  const refreshing = u.refreshing ? '・更新中…' : '';
  if (items.length === 0) {
    $('upcomingControls').hidden = true;
    status.textContent = `目前資料中無未生效的公告。${refreshing}`;
    list.innerHTML = '';
    return;
  }
  const params = E.upcomingParams(new URLSearchParams(location.search), items);
  syncUpcomingControls(items, params);
  const model = E.upcomingModel(items, params);

  if (model.rows.length === 0) {
    // 不得只顯示「查無」：N 為篩選前的總列數，讓使用者知道清單本身有資料
    status.textContent = `目前篩選條件下沒有符合的公告（清單共 ${model.total} 筆）。${refreshing}`;
    list.innerHTML = '';
    return;
  }
  // 「其中 N 筆尚未生效」必須對**目前呈現的列**計數：沿用全清單的數字會出現
  // 「符合篩選條件 1 筆（清單共 82 筆），其中 82 筆尚未生效」這種自相矛盾的句子。
  // 徽章維持全清單計數（§5.1），兩者語意不同
  const pending = E.upcomingPendingCount(model.rows.map((r) => r.it), state.today);
  const filtered = model.rows.length !== model.total;
  const scope = filtered
    ? `符合篩選條件 ${model.rows.length} 筆（清單共 ${model.total} 筆）`
    : `共 ${model.total} 筆公告`;
  // 未篩選時用 §2 指定的句子；篩選後的「已無未生效」只能宣稱篩選結果，不能宣稱整份資料
  const noneLeft = filtered ? '其中已無未生效的公告' : '目前資料中已無未生效的公告';
  status.textContent = (pending === 0
    ? `${scope}；${noneLeft}，以下為本站資料產生後已生效、尚未重建的紀錄。`
    : `${scope}，其中 ${pending} 筆尚未生效。`) + refreshing;
  list.innerHTML = model.groups
    ? model.groups.map((g) => `<section class="upcoming-group">
        <h3>${esc(g.date)} 起（${g.rows.length} 品項）</h3>
        ${g.rows.map(({ it, dec }) => upcomingRowHTML(it, dec)).join('')}
      </section>`).join('')
    : model.rows.map(({ it, dec }) => upcomingRowHTML(it, dec)).join('');
  // 終點＝版本驗證通過且完整清單已渲染（骨架可捲動不算，§8.1）
  if (performance.getEntriesByName('upcoming-fetch-start').length) {
    performance.measure('upcoming-fetch-to-rendered', 'upcoming-fetch-start');
    performance.clearMarks('upcoming-fetch-start');
  }
}

const UPCOMING_CONTROLS = { upType: 'type', upAtc: 'atc', upDate: 'date', upQ: 'q', upSort: 'sort' };

/** 依目前清單填 ATC 與批次日選項；只在資料換過時重填，避免每次輸入都重建 DOM。 */
let upcomingOptionsFor = null;
function syncUpcomingControls(items, params) {
  const box = $('upcomingControls');
  box.hidden = false;
  if (upcomingOptionsFor !== items) {
    const opt = (v, text) => `<option value="${esc(v)}">${esc(text)}</option>`;
    $('upAtc').innerHTML = opt('', '全部') + E.upcomingAtcLetters(items).map((c) => opt(c, c)).join('');
    $('upDate').innerHTML = opt('', '全部') + E.upcomingDates(items).map((d) => opt(d, d)).join('');
    upcomingOptionsFor = items;
  }
  for (const [id, key] of Object.entries(UPCOMING_CONTROLS)) {
    if ($(id).value !== params[key]) $(id).value = params[key];
  }
}

/** 篩選狀態序列化進 URL（可分享、可重整），但不寫入 localStorage：這是一次性檢視。 */
function writeUpcomingURL() {
  const p = new URLSearchParams({ view: 'upcoming' });
  for (const [id, key] of Object.entries(UPCOMING_CONTROLS)) {
    const v = $(id).value;
    if (v && !(key === 'type' && v === 'all') && !(key === 'sort' && v === 'date_asc')) p.set(key, v);
  }
  history.replaceState(history.state, '', `?${p}`);
}

function onUpcomingControl() {
  const t0 = performance.now();
  writeUpcomingURL();
  renderUpcoming();
  performance.measure('upcoming-rerender', { start: t0 });
}

let upcomingFrame = 0;
function scheduleUpcomingRender() {
  cancelAnimationFrame(upcomingFrame);
  upcomingFrame = requestAnimationFrame(onUpcomingControl);
}



// 標籤底色只反映事件性質，不新增語彙（§4.1）
const UPCOMING_TAG_CLASS = {
  terminated: 'stop', suspended: 'warn', other: 'warn',
  increase: 'info', decrease: 'info', relisted: 'info', first_priced: 'info', unchanged: 'info',
};

function upcomingRowHTML(it, dec = E.upcomingDecision(it)) {
  const expired = it.effectiveDate <= state.today;
  const sub = [it.ingredient, it.strength ? `${it.strength}${it.strengthUnit ? ` ${it.strengthUnit}` : ''}` : '', it.dosageForm]
    .filter(Boolean).map(esc).join('・');
  return `<div class="upcoming-row" data-code="${esc(it.code)}" data-date="${esc(it.effectiveDate)}" data-type="${dec.type}" data-rule="${dec.rule}"${expired ? ' data-expired' : ''}>
    <div class="r-top"><span class="r-name">${dash(it.chName)}</span><span class="r-code mono">${esc(it.code)}</span></div>
    <div class="r-en">${dash(it.enName)}</div>
    ${sub ? `<div class="r-sub">${sub}</div>` : ''}
    <div class="r-price">
      <span class="tag ${UPCOMING_TAG_CLASS[dec.type] || 'warn'}" data-label>${esc(dec.label)}</span>
      <span data-sub>${esc(dec.sub)}</span>
      ${expired ? '<span class="tag warn" data-expired-tag>已生效（本站資料尚未重建）</span>' : ''}
    </div>
    <div class="r-meta">ATC ${dash(it.atcCode)}・<a href="?code=${encodeURIComponent(it.code)}" data-code="${esc(it.code)}" data-action="to-detail">查看歷史 ↗</a> ${flagTags(it.flags)}</div>
  </div>`;
}

/** §5.4 匯出目前篩選後的結果；資料不可用（版本不符或內容不合法）時一併停用。 */
function exportUpcomingCSV() {
  const u = state.upcoming;
  if (u.phase !== 'ready' || !u.snapshot) return;
  const payload = u.snapshot.payload;
  const items = payload.items;
  const params = E.upcomingParams(new URLSearchParams(location.search), items);
  const csv = E.upcomingCSV(E.upcomingModel(items, params).rows, {
    buildDate: payload.buildDate,
    params,
    today: state.today,
    // 保留舊快照時匯出沿用舊快照，並於檔頭註明；請求進行中不得先行解除此註記（§5.5）
    staleNote: u.updateFailed ? `更新失敗，本檔沿用 ${payload.buildDate} 的資料` : '',
  });
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `nhi_upcoming_${payload.buildDate}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function showUpcoming() {
  state.detailSeq++;                   // 丟棄尚未回應的詳細頁請求
  state.current = null;
  state.today = E.localISODate();      // 每次進入取一次 T，該次檢視內不跨午夜更新（§2）
  $('searchView').hidden = true;
  $('detailView').hidden = true;
  $('detail').innerHTML = '';
  $('upcomingView').hidden = false;
  document.title = `預告中心 — ${APP_TITLE}`;
  renderUpcoming();
  loadUpcoming({ force: true });       // 每次進入都重取：清單很小，且使 §5.5 的「更新失敗」可達
}

// ── 事件 ────────────────────────────────────────────────────────
function bind() {
  const q = $('q');
  q.addEventListener('input', (e) => { if (!e.isComposing) scheduleSearch(); });
  q.addEventListener('compositionend', scheduleSearch);
  $('showTerminated').addEventListener('change', (e) => {
    try { localStorage.setItem('showTerminated', e.target.checked ? '1' : ''); } catch { /* 無 storage：僅本次有效 */ }
    scheduleSearch();
  });

  $('results').addEventListener('click', (e) => {
    const a = e.target.closest('a.result');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.dataset.code);
  });

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], #backLink');
    if (!el) return;
    const action = el.id === 'backLink' ? 'to-search' : el.dataset.action;
    if (action === 'to-search') {
      e.preventDefault();
      if (history.state?.fromSearch) history.back();
      else { history.pushState(null, '', location.pathname); showSearch(); }
    } else if (action === 'to-upcoming') {
      e.preventDefault();
      history.pushState({ fromSearch: true }, '', '?view=upcoming');
      showUpcoming();
      window.scrollTo(0, 0);
    } else if (action === 'to-detail') {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(el.dataset.code);
    } else if (action === 'upcoming-csv') {
      exportUpcomingCSV();
    } else if (action === 'retry-upcoming') {
      loadUpcoming({ force: true });
    } else if (action === 'retry-core') {
      loadCore();
    } else if (action === 'retry-shard') {
      if (new URLSearchParams(location.search).get('code')?.trim().toUpperCase() === el.dataset.code) showDetail(el.dataset.code);
    } else if (action === 'reload') {
      location.reload();
    } else if (action === 'toggle-sort' && state.current) {
      state.newestFirst = !state.newestFirst;
      renderDetail();
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-action="cb-safe"]')) {
      document.body.classList.toggle('cb-safe', e.target.checked);
      try { localStorage.setItem('cbSafe', e.target.checked ? '1' : ''); } catch { /* 私密模式等：僅本次有效 */ }
    }
  });

  for (const id of ['upType', 'upAtc', 'upDate', 'upSort']) {
    $(id).addEventListener('change', onUpcomingControl);
  }
  $('upQ').addEventListener('input', (e) => { if (!e.isComposing) scheduleUpcomingRender(); });
  $('upQ').addEventListener('compositionend', scheduleUpcomingRender);

  window.addEventListener('popstate', route);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.current && Math.abs(measureChartWidth() - chartWidth) > 40) renderDetail();
    }, 200);
  });
}

try {
  if (localStorage.getItem('cbSafe') === '1') document.body.classList.add('cb-safe');
  if (localStorage.getItem('showTerminated') === '1') $('showTerminated').checked = true;
} catch { /* 無 storage */ }
bind();
loadCore();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 離線快取失敗不影響查詢 */ });
}
