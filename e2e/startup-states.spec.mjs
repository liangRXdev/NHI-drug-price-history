// spec-startup.md §8：S5 可達狀態、S5b 轉移、S6 詳情與 index 無關且內容正確、S7 index 晚到失敗不撤不重畫。
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildData } from './mock.mjs';
import {
  gatedSite, trackText, everSaid, trackIndexLeak, indexLeak, watchMutations, mutations, routeTo,
  waitSearchReady, expectSearchFinds, SETTLE_MS, TEXT,
} from './gate.mjs';

const front = JSON.parse(readFileSync(new URL('../tests/fixtures/golden_frontend_2026-09-11.json', import.meta.url), 'utf8'));
const TODAY = '2026-09-11';
const APP_TITLE = '健保藥價歷史查詢';
const A = 'AC48092100';
const B = 'B009254100';
const detail = (page) => page.locator('#detail');
const banners = (page) => page.locator('#banners');
const q = (page) => page.locator('#q');
const results = (page) => page.locator('#results .result');
const status = (page) => page.locator('#searchStatus');
const stale = (data) => ({ json: { ...data.index, dataVersion: 'sha256:other-batch' } });

/** 詳情內容正確（A 的 golden 預期值，人工由 fixture 讀出）。 */
async function expectDetailA(page) {
  await expect(detail(page).locator('.detail-head .code')).toHaveText(A);
  await expect(detail(page).locator('.detail-head h2')).toHaveText('撫緒膜衣錠20毫克');
  await expect(detail(page).locator('.metric.key .val')).toContainText('4.12');
  await expect(detail(page).locator('table.history tbody tr')).toHaveCount(8);
}

async function expectSearchLoading(page) {
  await expect(page.locator('#searchView')).toBeVisible();
  await expect(q(page)).toBeDisabled();
  await expect(status(page)).toHaveText(TEXT.coreLoading);
  await expect(results(page)).toHaveCount(0);
}

// ── S5：搜尋視圖 M1–M7 ──────────────────────────────────────────
test('S5 M1 搜尋｜meta loading｜index loading → 載入中、搜尋框停用、無結果、不得出現「查無」', async ({ page }) => {
  await trackText(page, ['查無']);
  const site = await gatedSite(page, { plan: { meta: 'hold', index: 'hold' } });
  await page.goto('/');
  await site.waitHeld('meta');
  await site.waitHeld('index');
  await expectSearchLoading(page);
  expect(await everSaid(page, '查無')).toBe(false);
});

test('S5 M2 搜尋｜meta loading｜index idle（其他入口後導覽至搜尋）→ 同 M1，且 index 尚未請求', async ({ page }) => {
  await trackText(page, ['查無']);
  const site = await gatedSite(page, { plan: { meta: 'hold' } });
  await page.goto(`/?code=${A}`);
  await site.waitHeld('meta');
  await page.locator('#backLink').click();
  await expectSearchLoading(page);
  await site.expectCountStays('index', 0);
  expect(await everSaid(page, '查無')).toBe(false);
  await site.release('meta');                               // meta ready 後的首個視圖是零請求的搜尋頁
  await site.waitCount('index', 1);
  await expectSearchFinds(page, A);
});

test('S5 M3 搜尋｜meta error｜index 已回 200（不可達組合的對外結果）→ 錯誤＋重試、搜尋框停用、無結果', async ({ page }) => {
  await trackText(page, ['查無']);
  await trackIndexLeak(page);
  const site = await gatedSite(page, { plan: { meta: 500 } });
  await page.goto('/');
  await expect(banners(page)).toContainText(TEXT.coreError);
  await expect(banners(page).getByRole('button', { name: '重試' })).toBeVisible();
  await site.waitCount('index', 1);
  await page.waitForTimeout(SETTLE_MS);
  await expect(q(page)).toBeDisabled();
  await expect(results(page)).toHaveCount(0);
  expect(await indexLeak(page)).toEqual({ result: false, link: false, trayName: false });
  expect(await everSaid(page, '查無')).toBe(false);
});

test('S5 M4 搜尋｜meta ready｜index loading（首頁入口）→ 同 M1', async ({ page }) => {
  await trackText(page, ['查無']);
  const site = await gatedSite(page, { plan: { index: 'hold' } });
  await page.goto('/');
  await site.waitHeld('index');
  await expect(page.locator('#sourceInfo')).toContainText('涵蓋期間');     // meta 已 ready
  await expectSearchLoading(page);
  expect(await everSaid(page, '查無')).toBe(false);
});

test('S5 M4 搜尋｜meta ready｜index 由 T2 啟動後 loading（其他入口）→ 同 M1', async ({ page }) => {
  await trackText(page, ['查無']);
  const site = await gatedSite(page, { plan: { index: 'hold', 'shard:AC48': 'hold' } });
  await page.goto(`/?code=${A}`);
  await site.waitHeld('shard:AC48');
  expect(site.count('index')).toBe(0);                      // 此刻 index 為 idle
  await page.locator('#backLink').click();
  await expectSearchLoading(page);
  await site.waitHeld('index');
  await expectSearchLoading(page);
  expect(await everSaid(page, '查無')).toBe(false);
});

test('S5 M5 搜尋｜meta ready｜index ready → 正常', async ({ page }) => {
  await gatedSite(page);
  await page.goto('/');
  await expectSearchFinds(page, A);
});

test('S5 M6 搜尋｜meta ready｜index error → 錯誤＋重試', async ({ page }) => {
  await gatedSite(page, { plan: { index: 500 } });
  await page.goto('/');
  await expect(banners(page)).toContainText(TEXT.coreError);
  await expect(banners(page).getByRole('button', { name: '重試' })).toBeVisible();
  await expect(q(page)).toBeDisabled();
  await expect(results(page)).toHaveCount(0);
});

test('S5 M7 搜尋｜meta ready｜index mismatch → 請重新整理', async ({ page }) => {
  const data = buildData();
  await gatedSite(page, { data, plan: { index: stale(data) } });
  await page.goto('/');
  await expect(banners(page)).toContainText(TEXT.coreMismatch);
  await expect(banners(page).getByRole('button', { name: '重新整理' })).toBeVisible();
  await expect(q(page)).toBeDisabled();
  await expect(results(page)).toHaveCount(0);
});

// ── S5：詳情視圖 M8–M10 ─────────────────────────────────────────
for (const [indexState, entry] of [['idle', 'deep'], ['loading', 'home']]) {
  for (const [row, code, text] of [[2, A, TEXT.coreLoading], [1, 'AC48-0921', TEXT.notFound]]) {
    test(`S5 M8 詳情｜meta loading｜index ${indexState}｜D4.1 第 ${row} 列`, async ({ page }) => {
      await trackText(page, ['查無']);
      const site = await gatedSite(page, { plan: { meta: 'hold', index: 'hold' } });
      if (entry === 'deep') {
        await page.goto(`/?code=${code}`);
        await site.waitHeld('meta');
      } else {
        await page.goto('/');
        await site.waitHeld('meta');
        await site.waitHeld('index');
        await routeTo(page, `?code=${code}`);
      }
      await expect(page.locator('#detailView')).toBeVisible();
      await expect(detail(page)).toContainText(text);
      await page.waitForTimeout(SETTLE_MS);
      expect(site.count('index')).toBe(entry === 'deep' ? 0 : 1);
      expect(site.count('shard:AC48')).toBe(0);
      expect(await everSaid(page, '查無')).toBe(row === 1);
    });
  }
}

for (const [row, code, text] of [[3, A, TEXT.coreError], [1, 'AC48-0921', TEXT.notFound]]) {
  test(`S5 M9 詳情｜meta error｜index idle｜D4.1 第 ${row} 列`, async ({ page }) => {
    await trackText(page, ['查無']);
    const site = await gatedSite(page, { plan: { meta: 500 } });
    await page.goto(`/?code=${code}`);
    await expect(banners(page)).toContainText(TEXT.coreError);
    await expect(detail(page)).toContainText(text);
    if (row === 3) await expect(detail(page).getByRole('button', { name: '重試' })).toBeVisible();
    await site.expectCountStays('index', 0);
    expect(site.count('shard:AC48')).toBe(0);
    expect(await everSaid(page, '查無')).toBe(row === 1);
  });
}

test('S5 M10 詳情｜meta ready｜index idle（shard 在途，第 4a 列）→ 載入中，無錯誤、無查無、無 index 訊息', async ({ page }) => {
  await trackText(page, ['查無', TEXT.shardError, '搜尋功能', '搜尋資料']);
  const site = await gatedSite(page, { plan: { 'shard:AC48': 'hold' } });
  await page.goto(`/?code=${A}`);
  await site.waitHeld('shard:AC48');
  await expect(detail(page)).toContainText(TEXT.shardLoading);
  await site.expectCountStays('index', 0);
  for (const t of ['查無', TEXT.shardError, '搜尋功能', '搜尋資料']) expect(await everSaid(page, t), t).toBe(false);
});

test('S5 M10 詳情｜meta ready｜index loading → 詳情正確、不顯示任何 index 訊息', async ({ page }) => {
  await trackText(page, ['搜尋功能', '搜尋資料']);
  const site = await gatedSite(page, { plan: { index: 'hold' } });
  await page.goto(`/?code=${A}`);
  await expectDetailA(page);
  await site.waitHeld('index');
  await page.waitForTimeout(SETTLE_MS);
  await expectDetailA(page);
  for (const t of ['搜尋功能', '搜尋資料']) expect(await everSaid(page, t), t).toBe(false);
});

test('S5 M10 詳情｜meta ready｜index ready → 詳情正確、無橫幅', async ({ page }) => {
  await trackText(page, ['搜尋功能', '搜尋資料']);
  await gatedSite(page);
  await page.goto(`/?code=${A}`);
  await expectDetailA(page);
  await waitSearchReady(page);
  await expectDetailA(page);
  for (const t of ['搜尋功能', '搜尋資料']) expect(await everSaid(page, t), t).toBe(false);
});

test('S5 M10 詳情｜meta ready｜index error → 詳情正確＋§5.5 錯誤橫幅', async ({ page }) => {
  await gatedSite(page, { plan: { index: 500 } });
  await page.goto(`/?code=${A}`);
  await expect(banners(page)).toContainText(TEXT.indexError);
  await expect(banners(page)).toContainText(TEXT.indexErrorTail);
  await expect(banners(page).getByRole('button', { name: '重試' })).toBeVisible();
  await expectDetailA(page);
});

test('S5 M10 詳情｜meta ready｜index mismatch → 詳情正確＋§5.5 版本不一致橫幅', async ({ page }) => {
  const data = buildData();
  await gatedSite(page, { data, plan: { index: stale(data) } });
  await page.goto(`/?code=${A}`);
  await expect(banners(page)).toContainText(TEXT.indexMismatch);
  await expect(banners(page).getByRole('button', { name: '重新整理' })).toBeVisible();
  await expectDetailA(page);
});

// ── S5：比較與預告 M11–M13 ──────────────────────────────────────
for (const [view, url, loadingSel, loadingText] of [
  ['比較', `/?codes=${A},${B}`, '#compareBody', TEXT.coreLoading],
  ['預告', '/?view=upcoming', '#upcomingStatus', '預告資料載入中…'],
]) {
  test(`S5 M11 ${view}｜meta loading → 該視圖現有的載入中，index 未請求`, async ({ page }) => {
    const site = await gatedSite(page, { plan: { meta: 'hold' } });
    await page.goto(url);
    await site.waitHeld('meta');
    await expect(page.locator(loadingSel)).toContainText(loadingText);
    await site.expectCountStays('index', 0);
  });

  test(`S5 M12 ${view}｜meta error → 該視圖現有的錯誤，index 未請求`, async ({ page }) => {
    const site = await gatedSite(page, { plan: { meta: 500 } });
    await page.goto(url);
    await expect(banners(page)).toContainText(TEXT.coreError);
    if (view === '比較') await expect(page.locator('#compareBody')).toContainText(TEXT.coreError);
    else {
      await expect(page.locator('#upcomingBanner .alert--error')).toBeVisible();
      await expect(page.locator('.upcoming-row')).toHaveCount(0);
    }
    await site.expectCountStays('index', 0);
  });

  for (const indexState of ['loading', 'error', 'mismatch']) {
    test(`S5 M13 ${view}｜meta ready｜index ${indexState} → 主體照常顯示`, async ({ page }) => {
      const data = buildData();
      const plan = { index: indexState === 'loading' ? 'hold' : indexState === 'error' ? 500 : stale(data) };
      const site = await gatedSite(page, { data, plan });
      await page.goto(url);
      if (view === '比較') await expect(page.locator('.cmp-summary')).toBeVisible();
      else await expect(page.locator('.upcoming-row')).toHaveCount(3);
      if (indexState === 'loading') {
        await site.waitHeld('index');
        await page.waitForTimeout(SETTLE_MS);
        await expect(banners(page)).not.toContainText('搜尋');
      } else {
        await expect(banners(page)).toContainText(indexState === 'error' ? TEXT.indexError : TEXT.indexMismatch);
      }
      if (view === '比較') {
        await expect(page.locator('.cmp-summary thead th .mono')).toHaveText([A, B]);
        await expect(page.locator('#compareTray .tray-name')).toHaveCount(0);      // 未發布：chip 品名為空
      } else await expect(page.locator('.upcoming-row')).toHaveCount(3);
    });
  }
}

// ── S5b 轉移 ────────────────────────────────────────────────────
test('S5b(a) 詳情顯示中、index loading 時 popstate 回搜尋 → M4；index 到後 → M5', async ({ page }) => {
  await trackText(page, ['查無']);
  const site = await gatedSite(page, { plan: { index: 'hold' } });
  await page.goto(`/?code=${A}`);
  await expectDetailA(page);
  await site.waitHeld('index');
  await page.evaluate((code) => {
    history.replaceState(null, '', location.pathname);
    history.pushState(null, '', `?code=${code}`);
    history.back();
  }, A);
  await expectSearchLoading(page);
  expect(await everSaid(page, '查無')).toBe(false);
  await site.release('index');
  await expectSearchFinds(page, A);
  expect(site.count('index')).toBe(1);
});

test('S5b(b) meta error → retry-core 成功 → 原視圖正常載入，index 依 D2 於 shard 落定後啟動', async ({ page }) => {
  const site = await gatedSite(page, { plan: { meta: [500, 'ok'], 'shard:AC48': 'hold' } });
  await page.goto(`/?code=${A}`);
  await expect(detail(page)).toContainText(TEXT.coreError);
  expect(site.count('index')).toBe(0);
  await detail(page).getByRole('button', { name: '重試' }).click();
  await site.waitHeld('shard:AC48');
  await site.expectCountStays('index', 0);
  await site.release('shard:AC48');
  await expectDetailA(page);
  await site.waitCount('index', 1);
  expect(site.count('meta')).toBe(2);
});

test('S5b(c) index error → 導覽到另一代號 → 新詳情正常、橫幅仍在', async ({ page }) => {
  await gatedSite(page, { plan: { index: 500 } });
  await page.goto(`/?code=${A}`);
  await expect(banners(page)).toContainText(TEXT.indexError);
  await routeTo(page, `?code=${B}`);
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  await expect(detail(page).locator('table.history tbody tr')).toHaveCount(9);
  await expect(banners(page)).toContainText(TEXT.indexError);
});

test('S5b(d) 詳情 A 在途時導覽到 B → 畫面只出現 B；A 的回應抵達後畫面與標題仍為 B', async ({ page }) => {
  await trackText(page, ['撫緒膜衣錠20毫克']);
  const site = await gatedSite(page, { plan: { 'shard:AC48': 'hold' } });
  await page.goto(`/?code=${A}`);
  await site.waitHeld('shard:AC48');
  await routeTo(page, `?code=${B}`);
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  await site.release('shard:AC48');
  await page.waitForTimeout(SETTLE_MS);
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  await expect(page).toHaveTitle(`低落美膜衣錠２５公絲（${B}）— ${APP_TITLE}`);
  expect(await everSaid(page, '撫緒膜衣錠20毫克'), 'A 的內容曾出現').toBe(false);
});

// ── S6 詳情與 index 無關，且內容正確 ────────────────────────────
// 預期值由 golden fixture 的 records 獨立算出（不經 engine.js）；現行價欄的預期文字為人工由 fixture 讀出。
const CURRENT_TEXT = {
  A017014321: '28.10', A020296321: '20.50', A035680329: '已終止支付', AB47689100: '6.90',
  AC48092100: '4.12', AC48845100: '已終止支付', AC48867100: '12.50', B009254100: '已終止支付',
  BC05037209: '245.00', BC23981100: '暫停支付', BC26467100: '7.40',
};

function goldenExpectation(code, entry) {
  const maxFrom = entry.records.reduce((m, r) => (r.from > m ? r.from : m), '');
  let name;
  if (entry.meta) name = entry.meta.chName;
  else {
    // metaVariants：取「參考日當天有效的那筆紀錄」之前最後出現的變體
    const idx = entry.records.findIndex((r) => r.from <= TODAY && (r.to === null || r.to >= TODAY));
    name = entry.metaVariants.filter((v) => v.recordIndex <= idx).pop().chName;
  }
  return { rows: entry.records.length + entry.invalidRecords.length, newest: maxFrom, name };
}

/** §8.1 中 golden 快照沒有的類別以合成條目補上（驗收文件須標明為合成）。 */
function withSynthetic(data) {
  const base = structuredClone(data.shards.AC48.drugs[A]);
  // 尚無已生效紀錄：selectMeta 回 null → H2 為「—」、標題退回代號
  const future = structuredClone(base);
  future.records = [{ ...base.records[base.records.length - 1], from: '2026-12-01', to: null }];
  data.shards.AC48.drugs.AC48000001 = future;
  // 合法英數但非 10 碼
  data.shards.AC48.drugs.AC4809 = structuredClone(base);
  // 含日期異常紀錄
  const bad = structuredClone(base);
  bad.invalidRecords = [{ rawFrom: '', rawTo: '2020-01-01', rawPrice: '1.00', error: 'blank_start' }];
  bad.flags = [...(bad.flags || []), 'invalid_records'];
  data.shards.AC48.drugs.AC48000002 = bad;
  return data;
}

const S6_CASES = [
  ...Object.entries(front.shards).map(([code, entry]) => {
    const e = goldenExpectation(code, entry);
    return { code, label: 'golden', ...e, current: CURRENT_TEXT[code], title: `${e.name}（${code}）— ${APP_TITLE}`, h2: e.name };
  }),
  { code: 'AC48000001', label: '合成：尚無已生效紀錄', rows: 1, newest: '2026-12-01', current: '尚未生效', h2: '—', title: `AC48000001（AC48000001）— ${APP_TITLE}` },
  { code: 'AC4809', label: '合成：非 10 碼', rows: 8, newest: '2024-04-01', current: '4.12', h2: '撫緒膜衣錠20毫克', title: `撫緒膜衣錠20毫克（AC4809）— ${APP_TITLE}` },
  { code: 'AC48000002', label: '合成：含日期異常紀錄', rows: 9, newest: '2024-04-01', current: '4.12', h2: '撫緒膜衣錠20毫克', title: `撫緒膜衣錠20毫克（AC48000002）— ${APP_TITLE}` },
];

async function openDetail(page, code, indexBehavior) {
  const site = await gatedSite(page, { data: withSynthetic(buildData()), plan: { index: indexBehavior } });
  await page.goto(`/?code=${code}`);
  await expect(detail(page).locator('.metric.key')).toBeVisible();
  await expect(page.locator('#sourceInfo')).toContainText('資料無變動');     // status 已落定
  return site;
}

for (const c of S6_CASES) {
  test(`S6 ${c.code}（${c.label}）：內容等於獨立預期值，且 index 未到與已發布時 #detail 逐字相同`, async ({ page, context }) => {
    // index 永不回應
    const pending = await openDetail(page, c.code, 'pending');
    await pending.waitCount('index', 1);                    // 請求已發出且仍 pending
    await expect(detail(page).locator('.detail-head h2')).toHaveText(c.h2);
    await expect(detail(page).locator('.metric.key .val')).toContainText(c.current);
    await expect(detail(page).locator('table.history tbody tr')).toHaveCount(c.rows);
    await expect(detail(page).locator('table.history tbody tr[data-kind="record"]').first().locator('td.date').first()).toHaveText(c.newest);
    await expect(page).toHaveTitle(c.title);
    const htmlPending = await detail(page).innerHTML();

    // index 已發布
    const page2 = await context.newPage();
    await page2.setViewportSize(page.viewportSize());
    await openDetail(page2, c.code, 'ok');
    await waitSearchReady(page2);
    await expect(page2).toHaveTitle(c.title);
    expect(await detail(page2).innerHTML()).toBe(htmlPending);
  });
}

// ── S7 index 晚到失敗：不撤、不重畫 ─────────────────────────────
for (const [name, behavior, button, text] of [
  ['(a) HTTP 500', () => 500, '重試', TEXT.indexError],
  ['(b) 非 JSON', () => 'corrupt', '重試', TEXT.indexError],
  ['(c) dataVersion 不符', (data) => stale(data), '重新整理', TEXT.indexMismatch],
  ['(d) body 逾時', () => 'body-stall', '重試', TEXT.indexError],
]) {
  test(`S7${name} → #detail 零 mutation、節點仍在、排序不變、shard 不重抓、橫幅可操作`, async ({ page }) => {
    const data = buildData();
    // (d)：逾時從 fetch 發出起算，須長於「扣住期間的前置步驟」，否則會在放行前就先逾時
    const site = await gatedSite(page, { data, plan: { index: 'hold' }, timeouts: name.startsWith('(d)') ? { index: 4000 } : undefined });
    await page.goto(`/?code=${A}`);
    await expectDetailA(page);
    await expect(page.locator('#sourceInfo')).toContainText('資料無變動');       // status 已落定
    const sort = detail(page).locator('[data-action="toggle-sort"]');
    await sort.click();                                                          // 切到非預設方向
    await expect(sort).toHaveAttribute('aria-pressed', 'false');
    await expect(detail(page).locator('table.history tbody tr').first().locator('td.date').first()).toHaveText('2016-08-01');
    await page.evaluate(() => {
      window.__keep = [document.querySelector('#sumTitle'), document.querySelector('#detail table.history tbody tr')];
    });
    await watchMutations(page, '#detail');

    await expect(banners(page)).not.toContainText('搜尋');                         // 放行前 index 仍在途，尚未失敗
    await site.release('index', behavior(data));
    await expect(banners(page)).toContainText(text);
    if (button === '重試') await expect(banners(page)).toContainText(TEXT.indexErrorTail);
    await page.waitForTimeout(SETTLE_MS);

    expect(await mutations(page, '#detail'), '#detail 的 mutation').toEqual([]);
    expect(await page.evaluate(() => window.__keep.map((n) => n.isConnected))).toEqual([true, true]);
    await expect(sort).toHaveAttribute('aria-pressed', 'false');
    expect(site.count('shard:AC48'), 'shard 請求數').toBe(1);

    const btn = banners(page).getByRole('button', { name: button });
    await expect(btn).toBeVisible();
    if (button === '重試') {
      site.set('index', 'ok');
      await btn.click();
      await site.waitCount('index', 2);
      await expect(banners(page)).not.toContainText(text);
      expect(site.count('meta')).toBe(1);
      expect(await mutations(page, '#detail')).toEqual([]);
    } else {
      await page.evaluate(() => { window.__beforeReload = true; });
      await btn.click();
      await expect.poll(() => page.evaluate(() => window.__beforeReload === undefined)).toBe(true);   // 整頁重新整理
    }
  });
}

// ── S6 補測（2026-11-17）：§8.1 的 overlap、conflict、pricedBefore 三態 ──────────
// 資料來自 Python 生成器產出的 golden fixture（非手工合成）；預期文字由 fixture 的 records 人工讀出，
// 對照 spec.md §5.1／§5.3／§5.5 的文案，不經 engine.js。
const pbFix = JSON.parse(readFileSync(new URL('../tests/fixtures/golden_frontend_priced_before_ambiguous.json', import.meta.url), 'utf8'));
const ovFix = JSON.parse(readFileSync(new URL('../tests/fixtures/golden_frontend_same_price_overlap.json', import.meta.url), 'utf8'));
const CONFLICT_TEXT = '來源紀錄衝突，無法判定單一支付價';

function withEdgeFixtures(data, today) {
  for (const [prefix, fix] of [['P000', pbFix], ['S000', ovFix]]) {
    data.shards[prefix] = { shardVersion: `sha256:e2e-${prefix}`, drugs: structuredClone(fix.shards) };
    data.meta.shards.versions[prefix] = `sha256:e2e-${prefix}`;
    // 該日有 index 快照就一併放進 index：index 握有此代號的資料時，詳情仍不得因它而改變
    for (const d of Object.values(fix.index[today] || {})) data.index.drugs.push(structuredClone(d));
  }
  data.meta.shards.files = Object.keys(data.shards).sort();
  return data;
}

// rows／newest 由 fixture 的 records 讀出；conflictRows／overlapRows＝歷史表中帶該標記的列數。
const S6_EDGE = [
  { code: 'P000000201', today: '2021-06-01', label: 'conflict：參考日落在衝突組（12.00 與 9.00 並存）',
    rows: 5, newest: '2023-01-01', current: CONFLICT_TEXT, never: [], conflictRows: 2, overlapRows: 1 },
  { code: 'P000000201', today: '2023-06-01', label: 'pricedBefore＝前價不唯一（衝突組 → 暫停 → 終止）',
    rows: 5, newest: '2023-01-01', current: '已終止支付（終止前支付價不唯一（來源紀錄衝突））',
    never: [/終止前 (9|10|12)\.00 元/, '此前無有價紀錄'], conflictRows: 2, overlapRows: 1 },
  { code: 'P000000204', today: '2023-06-01', label: 'pricedBefore＝數值（衝突組後有單一有價列 11.00 → 終止）',
    rows: 5, newest: '2023-01-01', current: '已終止支付（終止前 11.00 元）',
    never: ['支付價不唯一', /終止前 (9|10|12)\.00 元/, '此前無有價紀錄'], conflictRows: 2, overlapRows: 1 },
  { code: 'A020296321', today: '1996-01-01', label: 'pricedBefore＝null（首列 0 元，此前無有價紀錄）', golden: true,
    rows: 6, newest: '2014-07-01', current: '0 元（此前無有價紀錄）', never: ['已終止支付', /終止前/], conflictRows: 0, overlapRows: 0 },
  { code: 'S000000101', today: '2020-08-01', label: 'overlap：同價重疊（10.00 與 10.00）→ 仍給單一價格',
    rows: 2, newest: '2020-07-01', current: '10.00', never: [CONFLICT_TEXT], conflictRows: 0, overlapRows: 1 },
  { code: 'S000000102', today: '2020-08-01', label: 'overlap：異價重疊（10.00 與 12.00）→ 不給確定價格',
    rows: 2, newest: '2020-07-01', current: CONFLICT_TEXT, never: [], conflictRows: 0, overlapRows: 1 },
];

async function openEdgeDetail(page, c, indexBehavior) {
  const site = await gatedSite(page, { today: c.today, data: withEdgeFixtures(buildData(), c.today), plan: { index: indexBehavior } });
  await page.goto(`/?code=${c.code}`);
  await expect(detail(page).locator('.metric.key')).toBeVisible();
  await expect(page.locator('#sourceInfo')).toContainText('資料無變動');     // status 已落定
  return site;
}

for (const c of S6_EDGE) {
  const name = c.golden ? front.shards[c.code].meta.chName : '測試藥';
  test(`S6 補測 ${c.code}＠${c.today}（${c.label}）：內容等於獨立預期值，且 index 未到與已發布時 #detail 逐字相同`, async ({ page, context }) => {
    const pending = await openEdgeDetail(page, c, 'pending');
    await pending.waitCount('index', 1);                    // 請求已發出且仍 pending
    const key = detail(page).locator('.metric.key .val');
    await expect(detail(page).locator('.detail-head h2')).toHaveText(name);
    await expect(key).toContainText(c.current);
    for (const bad of c.never) await expect(key).not.toContainText(bad);
    const rows = detail(page).locator('table.history tbody tr');
    await expect(rows).toHaveCount(c.rows);
    await expect(detail(page).locator('table.history tbody tr[data-kind="record"]').first().locator('td.date').first()).toHaveText(c.newest);
    await expect(rows.filter({ has: page.locator('.tag', { hasText: /^來源紀錄衝突$/ }) })).toHaveCount(c.conflictRows);
    await expect(rows.filter({ has: page.locator('.tag', { hasText: /^重疊$/ }) })).toHaveCount(c.overlapRows);
    await expect(page).toHaveTitle(`${name}（${c.code}）— ${APP_TITLE}`);
    const htmlPending = await detail(page).innerHTML();

    const page2 = await context.newPage();
    await page2.setViewportSize(page.viewportSize());
    await openEdgeDetail(page2, c, 'ok');
    await waitSearchReady(page2);
    await expect(page2).toHaveTitle(`${name}（${c.code}）— ${APP_TITLE}`);
    expect(await detail(page2).innerHTML()).toBe(htmlPending);
  });
}
