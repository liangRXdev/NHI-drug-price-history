// spec-startup 驗收用的攔截工具：把每個資料請求固定在指定狀態，並計數。
//
// 資源名稱：'meta'｜'index'｜'status'｜'upcoming'｜`shard:<prefix>`
// 行為（單一值；給陣列則依該資源的請求次數逐一套用，最後一個沿用）：
//   'ok'          回預設內容（data 內對應的那份；shard 不存在則 404）
//   'hold'        扣住，直到 release(name, 行為) 才依該行為回應
//   'pending'     永不回應
//   'corrupt'     回不完整的 JSON
//   'body-stall'  headers 已送、body 永遠收不完（交給 app 的逾時）
//   'body-slow'   headers 已送、body 停在半途，finish(name) 後收完
//   <數字>        回該 HTTP 狀態碼
//   { json: x }   回 x 序列化後的內容（x 可為 null、陣列等任意值）
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { buildData, statusDaysAgo } from './mock.mjs';

const ORIGIN = 'http://127.0.0.1:8765';
export const SETTLE_MS = 250;     // 「此時請求數仍為 0」這類斷言前，給錯誤實作足夠時間露出馬腳

function nameOf(path) {
  if (path === 'meta.json') return 'meta';
  if (path === 'drug_index.json') return 'index';
  if (path === 'status.json') return 'status';
  if (path === 'upcoming.json') return 'upcoming';
  const m = /^history\/([^/]+)\.json$/.exec(path);
  return m ? `shard:${decodeURIComponent(m[1])}` : null;
}

export async function gatedSite(page, opts = {}) {
  const today = opts.today || '2026-09-11';
  await page.clock.setFixedTime(new Date(`${today}T10:00:00+08:00`));
  if (opts.timeouts) await page.addInitScript((t) => { window.NHI_FETCH_TIMEOUTS = t; }, opts.timeouts);
  const data = opts.data || buildData();
  const status = statusDaysAgo(today, 1);
  const plan = { ...(opts.plan || {}) };
  const counts = {};
  const held = {};
  const slow = {};

  const defaultBody = (name) => {
    if (name === 'meta') return data.meta;
    if (name === 'index') return data.index;
    if (name === 'status') return status;
    if (name === 'upcoming') return data.upcoming;
    return data.shards[name.slice('shard:'.length)];
  };
  const fulfillJSON = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  async function respond(route, name, behavior) {
    const b = behavior ?? 'ok';
    if (b === 'ok') {
      const body = defaultBody(name);
      return body === undefined ? route.fulfill({ status: 404, body: 'not found' }) : fulfillJSON(route, body);
    }
    if (b === 'hold') {
      const next = await new Promise((resolve) => { (held[name] ||= []).push(resolve); });
      return respond(route, name, next);
    }
    if (b === 'pending') return new Promise(() => {});
    if (b === 'corrupt') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"broken": ' });
    if (b === 'body-stall') return route.continue({ url: `${ORIGIN}/__stall_body` });
    if (b === 'body-slow') {
      const id = randomUUID();
      const put = await fetch(`${ORIGIN}/__slow_put/${id}`, { method: 'PUT', body: JSON.stringify(defaultBody(name)) });
      if (put.status !== 204) throw new Error(`slow_put 失敗：${put.status}`);
      (slow[name] ||= []).push(id);
      return route.continue({ url: `${ORIGIN}/__slow_body/${id}` });
    }
    if (typeof b === 'number') return route.fulfill({ status: b, body: 'server error' });
    if (b && typeof b === 'object' && 'json' in b) return fulfillJSON(route, b.json);
    throw new Error(`未知的行為：${JSON.stringify(b)}`);
  }

  await page.route('**/data/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/data\//, '');
    const name = nameOf(path);
    if (!name) return route.fulfill({ status: 404, body: 'not found' });
    counts[name] = (counts[name] || 0) + 1;
    const p = plan[name];
    const behavior = Array.isArray(p) ? p[Math.min(counts[name], p.length) - 1] : p;
    return respond(route, name, behavior);
  });

  const ctl = {
    data,
    count: (name) => counts[name] || 0,
    /** 之後抵達的請求改用此行為（不影響已扣住的請求）。 */
    set(name, behavior) { plan[name] = behavior; },
    /** 等到該資源有請求被扣住。 */
    async waitHeld(name, n = 1) {
      await expect.poll(() => (held[name] || []).length, { message: `等待 ${name} 被扣住` }).toBeGreaterThanOrEqual(n);
    },
    /** 放行所有被扣住的該資源請求。 */
    async release(name, behavior = 'ok') {
      await ctl.waitHeld(name);
      const list = held[name].splice(0);
      for (const resolve of list) resolve(behavior);
    },
    /** 讓 body-slow 的回應收完。 */
    async finish(name) {
      await expect.poll(() => (slow[name] || []).length, { message: `等待 ${name} 進入 body-slow` }).toBeGreaterThan(0);
      for (const id of slow[name].splice(0)) await fetch(`${ORIGIN}/__slow_release/${id}`);
    },
    /** 等到請求數達到 n。 */
    async waitCount(name, n) {
      await expect.poll(() => ctl.count(name), { message: `等待 ${name} 請求數達 ${n}` }).toBe(n);
    },
    /** 給錯誤實作時間後，斷言請求數「仍然」是 n。 */
    async expectCountStays(name, n) {
      await page.waitForTimeout(SETTLE_MS);
      expect(ctl.count(name), `${name} 請求數`).toBe(n);
    },
  };
  return ctl;
}

// ── 頁面端觀察工具 ───────────────────────────────────────────────
/** 須在 goto 前呼叫：記錄 <main> 與橫幅區的可見文字是否「曾經」出現過指定字串。 */
export async function trackText(page, texts) {
  await page.addInitScript((list) => {
    window.__everSaid = Object.fromEntries(list.map((t) => [t, false]));
    const check = () => {
      const text = ['main', '#banners'].map((s) => document.querySelector(s)?.innerText || '').join('\n');
      for (const t of list) if (text.includes(t)) window.__everSaid[t] = true;
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener('DOMContentLoaded', check);
  }, texts);
}

export const everSaid = (page, text) => page.evaluate((t) => {
  const now = ['main', '#banners'].map((s) => document.querySelector(s)?.innerText || '').join('\n').includes(t);
  return window.__everSaid[t] || now;
}, text);

/** 須在 goto 前呼叫：記錄 index 衍生內容是否「曾經」出現（搜尋結果節點、可進詳情的連結、比較籃品名）。 */
export async function trackIndexLeak(page) {
  await page.addInitScript(() => {
    window.__leak = { result: false, link: false, trayName: false };
    const check = () => {
      if (document.querySelector('#results .result')) window.__leak.result = true;
      if (document.querySelector('#results a[href*="code="]')) window.__leak.link = true;
      if (document.querySelector('#compareTray .tray-name')) window.__leak.trayName = true;
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

export const indexLeak = (page) => page.evaluate(() => window.__leak);

/** 對 selector 掛 MutationObserver（subtree、childList、attributes、characterData）。 */
export async function watchMutations(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`watchMutations：找不到 ${sel}`);
    const records = [];
    const describe = (n) => (n.nodeType === 1 ? `${n.nodeName.toLowerCase()}${n.className && typeof n.className === 'string' ? `.${n.className.trim().replace(/\s+/g, '.')}` : ''}` : `#text<${n.parentElement?.className || ''}>`);
    const obs = new MutationObserver((list) => { for (const m of list) records.push(`${m.type}@${describe(m.target)}`); });
    obs.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    (window.__mut ||= {})[sel] = { records, obs };
  }, selector);
}

export const mutations = (page, selector) => page.evaluate((sel) => {
  const w = window.__mut[sel];
  for (const m of w.obs.takeRecords()) w.records.push(`${m.type}@pending`);
  return w.records;
}, selector);

/** 頁內導覽到另一個網址（不重新載入）：pushState 後派送 popstate，走 app 的 route()。 */
export const routeTo = (page, search) => page.evaluate((s) => {
  history.pushState(null, '', s || location.pathname);
  window.dispatchEvent(new PopStateEvent('popstate'));
}, search);

/**
 * 等到 index 已發布（I2：發布＝開放搜尋，故以搜尋框啟用為準；搜尋頁不在畫面上時也成立）。
 * 不能用 app 的 search-ready mark：page.clock 會把 performance 的 mark／getEntries 換成空實作。
 */
export async function waitSearchReady(page) {
  await expect.poll(() => page.evaluate(() => document.querySelector('#q').disabled === false),
    { message: '等待 index 發布（搜尋框啟用）' }).toBe(true);
}

/** 在搜尋頁以固定查詢確認搜尋真的可用：首筆代號須等於 code。 */
export async function expectSearchFinds(page, code) {
  const q = page.locator('#q');
  await expect(q).toBeEnabled();
  await q.fill('');
  await expect(page.locator('#results .result')).toHaveCount(0);
  await q.fill(code);
  await expect(page.locator('#results .result').first()).toHaveAttribute('data-code', code);
}

export const TEXT = {
  coreLoading: '資料載入中…',
  coreError: '無法載入藥價資料',
  coreMismatch: '資料已更新，請重新整理頁面',
  notFound: '查無此代號',
  shardLoading: '的歷史資料中',
  shardError: '的歷史資料（',
  indexError: '搜尋功能暫時無法使用',
  indexErrorTail: '目前頁面的資料不受影響',
  indexMismatch: '搜尋資料與目前頁面的資料版本不一致',
};
