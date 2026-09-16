// e2e mock 資料：以 golden 凍結快照（tests/fixtures/golden_frontend_2026-09-11.json）組出
// meta／index／status／shards，並可逐項注入失敗（404、損毀、延遲、版本不一致）。
import { readFileSync } from 'node:fs';

const front = JSON.parse(readFileSync(new URL('../tests/fixtures/golden_frontend_2026-09-11.json', import.meta.url), 'utf8'));
export const DATA_VERSION = 'sha256:e2e-v1';

// 額外 120 個只存在於 index 的代號，用來驗「> 50 筆候選時完全相符仍排第一」
const FILLER = Array.from({ length: 120 }, (_, i) => ({
  code: `AC48${String(i).padStart(3, '0')}900`,
  chName: `填充藥品${i}`, enName: `FILLER ${i}`, ingredient: 'AC4809 FILLER',
  strength: '', strengthUnit: '', dosageForm: '錠劑', atcCode: '', manufacturer: '',
  window: [], historyCount: 0, priceChangeCount: 0, firstEffectiveDate: null, lastPriceChangeDate: null, flags: [],
}));

export function buildData() {
  const shards = {};
  for (const [code, entry] of Object.entries(front.shards)) {
    const p = code.slice(0, 4);
    (shards[p] ||= { shardVersion: `sha256:e2e-${p}`, drugs: {} }).drugs[code] = structuredClone(entry);
  }
  const files = Object.keys(shards).sort();
  const meta = {
    dataVersion: DATA_VERSION,
    generatedAt: '2026-09-11T23:07:52+08:00',
    coverageStart: '1995-03-01', coverageEnd: '2026-10-01',
    sourceRowCount: 114, uniqueDrugCodeCount: 11,
    shards: { prefixLength: 4, files, versions: Object.fromEntries(files.map((p) => [p, shards[p].shardVersion])) },
    source: 'NHIA A21030000I-E41001-001',
  };
  const index = { dataVersion: DATA_VERSION, drugs: [...Object.values(structuredClone(front.index)), ...FILLER] };
  // 預告清單同樣由 Python 生成器產出（golden fixture 的 upcoming 區塊），只換資料版本
  const upcoming = { ...structuredClone(front.upcoming), dataVersion: DATA_VERSION };
  return { meta, index, shards, upcoming };
}

/** lastCheckedAt 為 today（+08:00）往前 days 天。 */
export function statusDaysAgo(today, days) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return {
    lastCheckedAt: `${d.toISOString().slice(0, 10)}T02:00:00+08:00`,
    lastCheckResult: 'unchanged', dataVersion: DATA_VERSION, sourceModifiedAt: '2026-08-28 07:05:11',
  };
}

const json = (route, body, delay = 0) => new Promise((ok) => setTimeout(ok, delay)).then(() =>
  route.fulfill({ status: 200, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) }));

/**
 * 攔截 data/ 請求。opts：
 *   today        固定瀏覽器日期（YYYY-MM-DD，台北 10:00）
 *   data         buildData() 結果（可先改寫）
 *   status       status 物件｜'404'｜'corrupt'｜'pending'（永不回應）
 *   timeouts     覆寫 app 的 fetch 逾時（window.NHI_FETCH_TIMEOUTS）
 *   index/meta   '404'｜'corrupt'｜物件覆寫
 *   indexDelay   index 延遲毫秒
 *   shard        (prefix, attempt, route, data) => 自訂處理；回傳 false 走預設
 *   upcoming     '404'｜'corrupt'｜'pending'｜'network'｜HTTP 狀態碼｜物件覆寫；給陣列則依請求次數逐一套用
 *   upcomingDelay  upcoming 延遲毫秒
 */
export async function mockSite(page, opts = {}) {
  const today = opts.today || '2026-09-11';
  await page.clock.setFixedTime(new Date(`${today}T10:00:00+08:00`));
  if (opts.timeouts) await page.addInitScript((t) => { window.NHI_FETCH_TIMEOUTS = t; }, opts.timeouts);
  const data = opts.data || buildData();
  const status = opts.status ?? statusDaysAgo(today, 1);
  const attempts = {};
  const calls = [];

  await page.route('**/data/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/data\//, '');
    calls.push(path);
    const special = (v) => (v === '404' ? route.fulfill({ status: 404, body: 'not found' })
      : v === 'corrupt' ? json(route, '{"broken": ') : null);
    if (path === 'status.json') {
      if (status === 'pending') return new Promise(() => {});        // 永不回應：模擬連線卡住
      return special(status) ?? json(route, status);
    }
    if (path === 'meta.json') return special(opts.meta) ?? json(route, typeof opts.meta === 'object' ? opts.meta : data.meta);
    if (path === 'drug_index.json') {
      return special(opts.index) ?? json(route, typeof opts.index === 'object' ? opts.index : data.index, opts.indexDelay || 0);
    }
    if (path === 'upcoming.json') {
      attempts.upcoming = (attempts.upcoming || 0) + 1;
      const v = Array.isArray(opts.upcoming)
        ? opts.upcoming[Math.min(attempts.upcoming, opts.upcoming.length) - 1]
        : opts.upcoming;
      if (v === 'pending') return new Promise(() => {});
      if (v === 'network') return route.abort('failed');
      if (typeof v === 'number') return route.fulfill({ status: v, body: 'server error' });
      return special(v) ?? json(route, typeof v === 'object' && v !== null ? v : data.upcoming,
        opts.upcomingDelay || 0);
    }
    const m = /^history\/([^/]+)\.json$/.exec(path);
    if (m) {
      const prefix = decodeURIComponent(m[1]);
      attempts[prefix] = (attempts[prefix] || 0) + 1;
      if (opts.shard) {
        const handled = await opts.shard(prefix, attempts[prefix], route, data);
        if (handled !== false) return undefined;
      }
      return data.shards[prefix] ? json(route, data.shards[prefix]) : route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  return { data, calls, attempts, json };
}
