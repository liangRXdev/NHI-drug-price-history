// 比較籃與 URL 契約（spec-compare.md §3）：加入來源、容量、序位、sessionStorage、
// URL 優先於 session、清單長度 0／1／≥2 的去向。
import { test, expect } from '@playwright/test';
import { mockSite } from './mock.mjs';

const tray = (page) => page.locator('#compareTray');
const chips = (page) => page.locator('.tray-chip .mono');
const rows = (page) => page.locator('.compare-code');
const search = async (page, q) => {
  const input = page.locator('#q');
  await expect(input).toBeEnabled();
  await input.fill(q);
  await expect(page.locator('#searchStatus')).not.toHaveText(/載入中|請輸入/);
};

const addFromSearch = async (page, code) => {
  await search(page, code);
  await page.locator(`.result-wrap [data-cmp-slot="${code}"] button`).click();
};

const codesOf = async (page, loc) => (await loc.allTextContents()).map((s) => s.trim());

test('§3.1／§3.2 從搜尋卡加入：chip、容量與「已加入」狀態', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/');
  await expect(tray(page)).toBeHidden();

  await addFromSearch(page, 'A020296321');
  await expect(tray(page)).toBeVisible();
  await expect(tray(page)).toContainText('比較籃 1/4');
  await expect(tray(page)).toContainText('再加入 1 個品項即可比較');
  await expect(page.locator('.result-wrap [data-cmp-slot="A020296321"] button')).toBeDisabled();
  await expect(page.locator('.result-wrap [data-cmp-slot="A020296321"] button')).toHaveText('已加入');

  await addFromSearch(page, 'AC48867100');
  await expect(tray(page)).toContainText('比較籃 2/4');
  await expect(tray(page).getByRole('button', { name: '開始比較' })).toBeVisible();
});

test('§3.2 已滿 4 個時「＋比較」停用', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/');
  for (const c of ['A020296321', 'AC48867100', 'B009254100', 'A035680329']) await addFromSearch(page, c);
  await expect(tray(page)).toContainText('比較籃 4/4');
  await search(page, 'AC48092100');
  const btn = page.locator('.result-wrap [data-cmp-slot="AC48092100"] button');
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute('title', '最多 4 個，請先移除');
});

test('§3.2 序位在移除後不重新洗牌，空出的序位下次才重用', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/');
  for (const c of ['A020296321', 'AC48867100', 'B009254100']) await addFromSearch(page, c);
  const slots = () => page.locator('.tray-chip').evaluateAll(
    (els) => els.map((el) => [el.dataset.slot, el.querySelector('.mono').textContent.trim()]));
  expect(await slots()).toEqual([['1', 'A020296321'], ['2', 'AC48867100'], ['3', 'B009254100']]);

  await page.locator('.tray-chip', { hasText: 'AC48867100' }).getByRole('button').click();
  expect(await slots()).toEqual([['1', 'A020296321'], ['3', 'B009254100']]);   // 3 不得變成 2

  await addFromSearch(page, 'A035680329');
  expect(await slots()).toEqual([['1', 'A020296321'], ['3', 'B009254100'], ['2', 'A035680329']]);
});

test('§3.1 詳細頁也可加入，且與搜尋卡共用同一個籃子', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/?code=A020296321');
  await page.locator('[data-cmp-slot="A020296321"] button').click();
  await expect(tray(page)).toContainText('A020296321');
  await page.goto('/?code=AC48867100');
  await expect(tray(page)).toContainText('A020296321');      // sessionStorage 還原
  await page.locator('[data-cmp-slot="AC48867100"] button').click();
  expect(await codesOf(page, chips(page))).toEqual(['A020296321', 'AC48867100']);
});

test('§3.3 開始比較 → URL 帶 codes；移除同步更新 URL', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/');
  for (const c of ['A020296321', 'AC48867100', 'B009254100']) await addFromSearch(page, c);
  await tray(page).getByRole('button', { name: '開始比較' }).click();
  await expect(page).toHaveURL(/\?codes=A020296321%2CAC48867100%2CB009254100/);
  await expect(rows(page)).toHaveCount(3);

  await rows(page).filter({ hasText: 'AC48867100' }).getByRole('button', { name: '移除' }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('codes')).toBe('A020296321,B009254100');
});

test('§3.3 URL 一律優先於 sessionStorage', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/');
  await addFromSearch(page, 'AC48092100');                   // session 裡先放一個別的品項
  await page.goto('/?codes=A020296321,AC48867100');
  expect(await codesOf(page, rows(page).locator('.mono'))).toEqual(['A020296321', 'AC48867100']);
  expect(await codesOf(page, chips(page))).toEqual(['A020296321', 'AC48867100']);
});

test('§3.3 清單長度 1（有效）→ 轉詳細頁並提示', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/?codes=A020296321');
  await expect(page.locator('#detailView')).toBeVisible();
  await expect(page.locator('#banners')).toContainText('比較需要 2 個以上品項');
  await expect(page).toHaveURL(/\?code=A020296321/);
});

test('§3.3 清單長度 1（異常）→ 停留在比較視圖顯示該異常', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/?codes=BAD');
  await expect(page.locator('#compareView')).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('代號格式不正確');
});

test('§3.3 清單長度 0 → 代號皆無資料，URL 清空', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/?codes=');
  await expect(page.locator('#compareBody')).toContainText('代號皆無資料');
  expect(new URL(page.url()).search).toBe('');
});

test('§3.3 一個有效碼＋一個不合法碼 → 留在比較視圖，異常項目不得消失', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/?codes=A020296321,BAD');
  await expect(page.locator('#compareView')).toBeVisible();
  expect(await codesOf(page, rows(page).locator('.mono'))).toEqual(['A020296321', 'BAD']);
  await expect(rows(page).filter({ hasText: 'BAD' })).toContainText('代號格式不正確');
});

test('M4 超量時截斷並提示略過數', async ({ page }) => {
  await mockSite(page, {});
  await page.goto('/?codes=A020296321,AC48867100,B009254100,A035680329,AC48092100,AC48845100');
  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator('#compareSkipped')).toHaveText('已略過 2 個超出上限的代號。');
});

test('§2 同片多碼只 fetch 一次；不同片各一次', async ({ page }) => {
  const { calls } = await mockSite(page, {});
  await page.goto('/?codes=AC48867100,AC48845100,A020296321');
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).not.toContainText('載入中');
  const shards = calls.filter((c) => c.startsWith('history/'));
  expect(shards.sort()).toEqual(['history/A020.json', 'history/AC48.json']);
});

test('§2 查無此代號與載入失敗必須分開', async ({ page }) => {
  await mockSite(page, {
    shard: (prefix, attempt, route) => (prefix === 'A020' ? route.fulfill({ status: 404, body: 'x' }) : false),
  });
  await page.goto('/?codes=A020296321,AC48092100,B000000000');
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: 'A020296321' })).toContainText('資料載入失敗');
  await expect(rows(page).filter({ hasText: 'B000000000' })).toContainText('查無此代號');
  await expect(page.locator('#compareBanner')).toContainText('A020296321');
});
