// spec-startup.md §8：S4 請求順序、S10 啟動觸發、S11 只重試 index、S12 未驗版本的 index 不外洩。
// 「請求數」一律是測試端攔截到的網路請求計數（e2e/gate.mjs）。
import { test, expect } from '@playwright/test';
import { buildData } from './mock.mjs';
import {
  gatedSite, trackIndexLeak, indexLeak, watchMutations, mutations, routeTo,
  expectSearchFinds, SETTLE_MS, TEXT,
} from './gate.mjs';

const A = 'AC48092100';          // 片 AC48
const B = 'B009254100';          // 片 B009
const C = 'A035680329';          // 片 A035
const detail = (page) => page.locator('#detail');
const banners = (page) => page.locator('#banners');
const shown = (page) => detail(page).locator('.metric.key');

// ── S4 請求順序 ─────────────────────────────────────────────────
test('S4(a)(b)(c) meta 扣住 → shard 與 index 皆 0；shard body 未完 → index 0；body 完成 → index 1', async ({ page }) => {
  const site = await gatedSite(page, { plan: { meta: 'hold', 'shard:AC48': 'body-slow' } });
  await page.goto(`/?code=${A}`);
  await site.waitHeld('meta');
  await page.waitForTimeout(SETTLE_MS);
  expect(site.count('shard:AC48'), '(a) meta 未到時 shard 請求數').toBe(0);
  expect(site.count('index'), '(a) meta 未到時 index 請求數').toBe(0);

  await site.release('meta');
  await site.waitCount('shard:AC48', 1);                    // headers 已送、body 停在半途
  await site.expectCountStays('index', 0);                  // (b)
  await expect(shown(page)).toHaveCount(0);

  await site.finish('shard:AC48');
  await expect(shown(page)).toBeVisible();
  await site.waitCount('index', 1);                         // (c)
  await site.expectCountStays('index', 1);
});

for (const [name, mutate, plan] of [
  ['(d) shard 回 500', null, { 'shard:AC48': 500 }],
  ['(e) shard 版本不符', (d) => { d.shards.AC48.shardVersion = 'sha256:stale'; }, {}],
]) {
  test(`S4${name} → 失敗也算落定，index 請求數為 1`, async ({ page }) => {
    const data = buildData();
    if (mutate) mutate(data);
    const site = await gatedSite(page, { data, plan });
    await page.goto(`/?code=${A}`);
    await expect(detail(page).locator('.alert--error')).toBeVisible();
    await site.waitCount('index', 1);
    await site.expectCountStays('index', 1);
  });
}

// ── S10 啟動觸發 ────────────────────────────────────────────────
// (a) T1 已由 S4(a)(b)(c) 涵蓋。
const T2_ENTRIES = [
  ['popstate', async (page) => {
    await page.evaluate(() => {
      history.replaceState(null, '', location.pathname);
      history.pushState(null, '', `?code=AC48092100`);
      history.back();
    });
  }],
  ['點「回搜尋」', async (page) => { await page.locator('#backLink').click(); }],
  ['點「預告」', async (page) => { await page.locator('#upcomingBadge').click(); }],
];
for (const [name, act] of T2_ENTRIES) {
  test(`S10(b)(c) T2：shard 未落定時${name} → index 立即啟動，shard 之後落定仍只有 1 次`, async ({ page }) => {
    const site = await gatedSite(page, { plan: { 'shard:AC48': 'hold' } });
    await page.goto(`/?code=${A}`);
    await site.waitHeld('shard:AC48');
    await site.expectCountStays('index', 0);
    await act(page);
    await site.waitCount('index', 1);
    await site.release('shard:AC48');                       // (c) T2 之後 shard 才落定
    await site.expectCountStays('index', 1);
  });
}

test('S10(b)(c) T2：比較頁 shard 未落定時移除比較籃品項 → index 立即啟動，之後仍只有 1 次', async ({ page }) => {
  const site = await gatedSite(page, { plan: { 'shard:AC48': 'hold', 'shard:B009': 'hold', 'shard:A035': 'hold' } });
  await page.goto(`/?codes=${A},${B},${C}`);
  await site.waitHeld('shard:AC48');
  await site.expectCountStays('index', 0);
  await page.locator(`#compareTray [data-action="tray-remove"][data-code="${C}"]`).click();
  await site.waitCount('index', 1);
  await site.release('shard:AC48');
  await site.release('shard:B009');
  await site.expectCountStays('index', 1);
});

for (const [name, url] of [
  ['語法無效的代號', '/?code=AC48-0921'],
  ['前綴不在清單', '/?code=ZZ00000000'],
  ['?codes= 零個有效代號', '/?codes=bad!,x'],
]) {
  test(`S10(d) 零請求的首個視圖（${name}）→ meta ready 後 index 請求數為 1`, async ({ page }) => {
    const site = await gatedSite(page, { plan: { meta: 'hold' } });
    await page.goto(url);
    await site.waitHeld('meta');
    await site.expectCountStays('index', 0);                // meta ready 之前不 fetch index
    await site.release('meta');
    await site.waitCount('index', 1);
    await site.expectCountStays('index', 1);
    expect(Object.keys(site.data.shards).reduce((n, p) => n + site.count(`shard:${p}`), 0), 'shard 請求數').toBe(0);
  });
}

test('S10(e) ?codes= 兩片：一片完成、另一片 body 未完 → index 0；皆落定後恰為 1', async ({ page }) => {
  const site = await gatedSite(page, { plan: { 'shard:B009': 'body-slow' } });
  await page.goto(`/?codes=${A},${B}`);
  await site.waitCount('shard:AC48', 1);
  await site.waitCount('shard:B009', 1);
  await site.expectCountStays('index', 0);
  await site.finish('shard:B009');
  await expect(page.locator('.cmp-summary')).toBeVisible();
  await site.waitCount('index', 1);
  await site.expectCountStays('index', 1);
});

test('S10(f) ?view=upcoming：upcoming.json body 未完 → index 0；落定後恰為 1', async ({ page }) => {
  const site = await gatedSite(page, { plan: { upcoming: 'body-slow' } });
  await page.goto('/?view=upcoming');
  await site.waitCount('upcoming', 1);
  await site.expectCountStays('index', 0);
  await site.finish('upcoming');
  await expect(page.locator('.upcoming-row').first()).toBeVisible();
  await site.waitCount('index', 1);
  await site.expectCountStays('index', 1);
});

test('S10(g) ?codes= 單一有效代號轉詳情：shard body 未完 → index 0；落定後恰為 1', async ({ page }) => {
  const site = await gatedSite(page, { plan: { 'shard:AC48': 'body-slow' } });
  await page.goto(`/?codes=${A}`);
  await site.waitCount('shard:AC48', 1);
  await site.expectCountStays('index', 0);
  await site.finish('shard:AC48');
  await expect(shown(page)).toBeVisible();
  await site.waitCount('index', 1);
  await site.expectCountStays('index', 1);
});

// ── S11 只重試 index ────────────────────────────────────────────
async function indexFailedOnDetail(page, second) {
  const site = await gatedSite(page, { plan: { index: [500, second] } });
  await page.goto(`/?code=${A}`);
  await expect(shown(page)).toBeVisible();
  await expect(banners(page)).toContainText(TEXT.indexError);
  await expect(banners(page)).toContainText(TEXT.indexErrorTail);
  await expect(page.locator('#sourceInfo')).toContainText('資料無變動');        // status 已落定（落定時會重畫詳情）
  await watchMutations(page, '#detail');
  expect(site.count('meta')).toBe(1);
  expect(site.count('shard:AC48')).toBe(1);
  expect(site.count('index')).toBe(1);
  return site;
}

async function expectOnlyIndexRetried(page, site, indexCount) {
  await site.waitCount('index', indexCount);
  await page.waitForTimeout(SETTLE_MS);
  expect(site.count('meta'), 'meta.json 請求數不得增加').toBe(1);
  expect(site.count('shard:AC48'), 'shard 請求數不得增加').toBe(1);
  expect(await mutations(page, '#detail'), '#detail 的 mutation').toEqual([]);
}

const retryIndex = (page) => banners(page).getByRole('button', { name: '重試' }).click();

test('S11 重試成功 → 只多一次 index 請求、詳情零 mutation、搜尋可用、橫幅消失', async ({ page }) => {
  const site = await indexFailedOnDetail(page, 'ok');
  await retryIndex(page);
  await expectOnlyIndexRetried(page, site, 2);
  await expect(banners(page)).not.toContainText(TEXT.indexError);
  await page.locator('#backLink').click();
  await expectSearchFinds(page, A);
});

test('S11 重試再失敗 → 橫幅仍在、可再按', async ({ page }) => {
  const site = await indexFailedOnDetail(page, 500);
  await retryIndex(page);
  await expectOnlyIndexRetried(page, site, 2);
  await expect(banners(page)).toContainText(TEXT.indexError);
  await retryIndex(page);
  await expectOnlyIndexRetried(page, site, 3);
});

test('S11 重試得到版本不符 → mismatch 橫幅、搜尋不可用', async ({ page }) => {
  const stale = { ...buildData().index, dataVersion: 'sha256:other-batch' };
  const site = await indexFailedOnDetail(page, { json: stale });
  await retryIndex(page);
  await expectOnlyIndexRetried(page, site, 2);
  await expect(banners(page)).toContainText(TEXT.indexMismatch);
  await expect(banners(page).getByRole('button', { name: '重新整理' })).toBeVisible();
  await page.locator('#backLink').click();
  await expect(page.locator('#q')).toBeDisabled();
  await expect(page.locator('#results .result')).toHaveCount(0);
});

test('S11 重試在途時導覽到另一代號 → 重試結果抵達後視圖仍為該代號', async ({ page }) => {
  const site = await indexFailedOnDetail(page, 'hold');
  await retryIndex(page);
  await site.waitHeld('index');
  await routeTo(page, `?code=${B}`);
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  await site.release('index');
  await page.waitForTimeout(SETTLE_MS);
  await expect(page.locator('#detailView')).toBeVisible();
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  await expect(page).toHaveTitle(new RegExp(B));
  expect(site.count('meta')).toBe(1);
});

// ── S12 未驗版本的 index 不外洩 ─────────────────────────────────
// 首頁入口：index 已完整回 200，meta 的 body 持續扣住。
async function indexArrivedMetaHeld(page) {
  await trackIndexLeak(page);
  await page.addInitScript((code) => {
    sessionStorage.setItem('compareCodes', JSON.stringify([{ code, slot: 0, valid: true }]));
  }, A);
  const site = await gatedSite(page, { plan: { meta: 'hold' } });
  await page.goto('/');
  await site.waitHeld('meta');
  await site.waitCount('index', 1);
  await page.waitForTimeout(SETTLE_MS);                     // index 的 200 已送達頁面
  await expect(page.locator('#q')).toBeDisabled();
  // 對搜尋框輸入不產生結果（即使繞過 disabled 直接派送 input 事件）
  await page.evaluate((code) => {
    const q = document.querySelector('#q');
    q.value = code;
    q.dispatchEvent(new Event('input', { bubbles: true }));
  }, A);
  await page.waitForTimeout(SETTLE_MS);
  await expectNoLeak(page);
  return site;
}

async function expectNoLeak(page) {
  await expect(page.locator('#results .result')).toHaveCount(0);
  await expect(page.locator('#compareTray .tray-name')).toHaveCount(0);
  expect(await indexLeak(page), 'index 衍生內容曾經出現過').toEqual({ result: false, link: false, trayName: false });
}

test('S12 meta 放行且版本相符 → 搜尋可用、比較籃補上品名', async ({ page }) => {
  const site = await indexArrivedMetaHeld(page);
  await site.release('meta');
  await expectSearchFinds(page, A);
  await expect(page.locator('#compareTray .tray-name')).toHaveText('撫緒膜衣錠20毫克');
});

test('S12 meta 放行但版本不符 → mismatch，仍無外洩', async ({ page }) => {
  const site = await indexArrivedMetaHeld(page);
  await site.release('meta', { json: { ...site.data.meta, dataVersion: 'sha256:other-batch' } });
  await expect(banners(page)).toContainText(TEXT.coreMismatch);
  await expect(page.locator('#q')).toBeDisabled();
  await expectNoLeak(page);
});

for (const [name, secondIndex, ok] of [
  ['index 版本相符 → 搜尋可用', 'ok', true],
  ['index 版本不符 → mismatch、搜尋不可用', 'stale', false],
]) {
  test(`S12 meta 500 → 維持無外洩；retry-core 後 ${name}`, async ({ page }) => {
    const site = await indexArrivedMetaHeld(page);
    await site.release('meta', 500);
    await expect(banners(page)).toContainText(TEXT.coreError);
    await expect(page.locator('#q')).toBeDisabled();
    await expectNoLeak(page);

    site.set('meta', 'ok');
    site.set('index', secondIndex === 'ok' ? 'ok' : { json: { ...site.data.index, dataVersion: 'sha256:other-batch' } });
    await banners(page).getByRole('button', { name: '重試' }).click();
    if (ok) {
      await expectSearchFinds(page, A);
    } else {
      await expect(banners(page)).toContainText(TEXT.coreMismatch);
      await expect(page.locator('#q')).toBeDisabled();
      await expectNoLeak(page);
    }
  });
}
