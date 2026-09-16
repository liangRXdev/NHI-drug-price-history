// 預告中心前端驗收（spec-upcoming.md §9）：U10 四態與兩種失敗、U11 版本一致性。
import { test, expect } from '@playwright/test';
import { buildData, mockSite } from './mock.mjs';

const list = (page) => page.locator('#upcomingList');
const rows = (page) => page.locator('.upcoming-row');
const banner = (page) => page.locator('#upcomingBanner');
const badge = (page) => page.locator('#upcomingBadge');

const open = async (page, opts = {}) => {
  const mock = await mockSite(page, opts);
  await page.goto('/?view=upcoming');
  return mock;
};

const expectUnusable = async (page) => {
  await expect(banner(page).locator('.alert--error')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(list(page)).not.toContainText('BC05037209');
};

// ── 入口與 lazy fetch（§5.1、§8）────────────────────────────────
test('U10 首屏不取 upcoming.json；徽章未載入前不帶數字', async ({ page }) => {
  const { calls } = await mockSite(page, {});
  await page.goto('/');
  await expect(page.locator('#q')).toBeEnabled();
  await expect(badge(page)).toHaveText('預告');
  expect(calls.filter((c) => c === 'upcoming.json')).toHaveLength(0);

  await badge(page).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(badge(page)).toHaveText('預告 3');          // T=2026-09-11：3 筆皆未生效
  expect(calls.filter((c) => c === 'upcoming.json')).toHaveLength(1);
  expect(new URL(page.url()).search).toBe('?view=upcoming');
});

test('U10 成功載入：兩個日期分別呈現，回搜尋不留下預告頁', async ({ page }) => {
  await open(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('#upcomingDates')).toContainText('資料產生日 2026-09-11');
  await expect(page.locator('#upcomingDates')).toContainText('最後檢查 2026-09-10');
  await expect(page.locator('#upcomingStatus')).toContainText('共 3 筆公告，其中 3 筆尚未生效');

  await page.locator('#upcomingView .back a').click();
  await expect(page.locator('#searchView')).toBeVisible();
  await expect(page.locator('#upcomingView')).toBeHidden();
});

test('U10 空清單：顯示「無未生效的公告」而非錯誤或空白', async ({ page }) => {
  const data = buildData();
  data.upcoming = { ...data.upcoming, count: 0, codeCount: 0, items: [] };
  await open(page, { data });
  await expect(page.locator('#upcomingStatus')).toContainText('目前資料中無未生效的公告');
  await expect(banner(page).locator('.alert--error')).toHaveCount(0);
  await expect(badge(page)).toHaveText('預告 0');
});

test('U10 載入中顯示骨架與「載入中」，不得顯示「無預告」', async ({ page }) => {
  await open(page, { upcoming: 'pending' });
  await expect(page.locator('#upcomingStatus')).toContainText('載入中');
  await expect(page.locator('.skeleton').first()).toBeVisible();
  await expect(list(page)).not.toContainText('無未生效');
  await expect(banner(page).locator('.alert--error')).toHaveCount(0);
});

// ── U10 首次載入失敗：六種皆不得呈現清單 ────────────────────────
const brokenRow = () => {
  const data = buildData();
  data.upcoming = structuredClone(data.upcoming);
  data.upcoming.items[1].price = 12.5;          // terminated 卻有正數價格：§5.5.1 不一致
  return data;
};

for (const [name, opts] of [
  ['404', { upcoming: '404' }],
  ['非 2xx', { upcoming: 500 }],
  ['網路中斷', { upcoming: 'network' }],
  ['逾時', { upcoming: 'pending', timeouts: { upcoming: 400 } }],
  ['損毀 JSON', { upcoming: 'corrupt' }],
  ['合法 JSON 但一列不合法', { data: brokenRow() }],
]) {
  test(`U10 首次載入失敗（${name}）不呈現清單`, async ({ page }) => {
    await open(page, opts);
    await expectUnusable(page);
    await expect(badge(page)).toHaveText('預告');                 // 徽章維持字樣，不另設 404 規則
  });
}

test('U10 壞列不得被靜默跳過（整份損毀）', async ({ page }) => {
  await open(page, { data: brokenRow() });
  await expect(rows(page)).toHaveCount(0);
  await expect(banner(page)).toContainText('內容不合法');
});

test('U10 第一次失敗、第二次成功 → 完整恢復', async ({ page }) => {
  await open(page, { upcoming: ['404', undefined] });
  await expectUnusable(page);
  await banner(page).getByRole('button', { name: '重試' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(banner(page).locator('.alert--error')).toHaveCount(0);
  await expect(badge(page)).toHaveText('預告 3');
});

// ── U10 更新失敗：網路類保留舊清單，內容／版本類清空 ─────────────
test('U10 更新失敗（網路）保留舊清單並標示舊 buildDate', async ({ page }) => {
  await open(page, { upcoming: [undefined, 'network'] });
  await expect(rows(page)).toHaveCount(3);

  await page.locator('#upcomingView .back a').click();
  await badge(page).click();                                     // 再次進入 → 第二次請求失敗
  await expect(banner(page).locator('.alert--warn')).toContainText('更新失敗');
  await expect(banner(page)).toContainText('顯示的是 2026-09-11 的資料');
  await expect(rows(page)).toHaveCount(3);
});

test('U10 更新失敗（內容不合法）必須清空舊清單', async ({ page }) => {
  await open(page, { upcoming: [undefined, 'corrupt'] });
  await expect(rows(page)).toHaveCount(3);
  await page.locator('#upcomingView .back a').click();
  await badge(page).click();
  await expectUnusable(page);
});

test('U10 延遲的舊回應不得覆蓋新畫面', async ({ page }) => {
  await open(page, { upcomingDelay: 1500 });
  await expect(page.locator('.skeleton').first()).toBeVisible();
  await page.locator('#upcomingView .back a').click();           // 回搜尋：舊回應稍後才到
  await expect(page.locator('#searchView')).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.locator('#upcomingView')).toBeHidden();
  await expect(page.locator('#searchView')).toBeVisible();
});

// ── U11 版本一致性 ──────────────────────────────────────────────
const mutate = (fn) => {
  const data = buildData();
  data.upcoming = structuredClone(data.upcoming);
  fn(data);
  return data;
};

for (const [name, data] of [
  ['upcoming 舊、meta 新', mutate((d) => { d.upcoming.dataVersion = 'sha256:old'; })],
  ['upcoming 新、meta 舊', mutate((d) => { d.meta.dataVersion = 'sha256:old'; d.index.dataVersion = 'sha256:old'; })],
  ['upcoming 缺 dataVersion', mutate((d) => { delete d.upcoming.dataVersion; })],
  ['generatorVersion 不符', mutate((d) => { d.upcoming.generatorVersion = 'upcoming/0'; })],
]) {
  test(`U11 版本不一致（${name}）不渲染清單`, async ({ page }) => {
    await open(page, { data });
    await expectUnusable(page);
  });
}

test('U11 upcoming 舊、meta 新 → 提示重新整理', async ({ page }) => {
  await open(page, { data: mutate((d) => { d.upcoming.dataVersion = 'sha256:old'; }) });
  await expect(banner(page)).toContainText('請重新整理');
  await expect(banner(page).getByRole('button', { name: '重新整理' })).toBeVisible();
});

test('U11 meta.json 不可用 → 視同不可用，不得略過版本檢查', async ({ page }) => {
  await open(page, { meta: '404' });
  await expectUnusable(page);
});

test('U11 版本不一致後取得一致資料 → 恢復', async ({ page }) => {
  const stale = structuredClone(buildData().upcoming);
  stale.dataVersion = 'sha256:old';
  await open(page, { upcoming: [stale, undefined] });
  await expectUnusable(page);
  // 版本不一致的出口是重新整理（§5.5），不是原地重試
  await banner(page).getByRole('button', { name: '重新整理' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(banner(page).locator('.alert--error')).toHaveCount(0);
});

// ── §4.1 標籤（U4 的整合面；逐條字串在 tests-js/upcoming.test.mjs）──
test('U13 每列都有事件標籤與金額變化，flags 提示歸屬正確的代號', async ({ page }) => {
  await open(page);
  const row = (code) => rows(page).filter({ has: page.locator(`.r-code:text-is("${code}")`) });
  await expect(row('AB47689100').locator('[data-label]')).toHaveText('調升');
  await expect(row('AB47689100').locator('[data-sub]')).toHaveText('2026-10-01 起 6.90 → 7.90 元（+14.49%）');
  await expect(row('BC05037209').locator('[data-label]')).toHaveText('終止支付');
  await expect(row('BC05037209').locator('[data-sub]')).toHaveText('2026-10-01 起；終止前 245.00 元');
  // BC26467100 的描述欄位不一致（預告列成分欄損毀）→ 品質提示只出現在這一列
  await expect(row('BC26467100').locator('.tag.warn')).toContainText('描述欄位不一致');
  await expect(row('AB47689100').locator('.tag.warn')).toHaveCount(0);
  // 描述欄位取自 build 日有效列，不得取預告列本身
  await expect(row('BC26467100')).toContainText('AMLODIPINE BESYLATE');
  await expect(row('BC26467100')).not.toContainText('2412402210');
});

test('U13 行動裝置寬度下免責聲明全文可見', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const note = page.locator('#upcomingView .hint').nth(1);
  await expect(note).toContainText('不代表醫療院所實際採購價、零售價或病人自付金額');
  await expect(note).toContainText('預告內容以健保署最新公告為準');
  const clipped = await note.evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

// ── §6 與詳細頁的整合 ───────────────────────────────────────────
test('§6 詳細頁：依自己的 history 判定是否顯示預告中心入口', async ({ page }) => {
  await mockSite(page, { today: '2026-09-11' });
  await page.goto('/?code=BC05037209');
  const entry = page.locator('#detail').getByRole('link', { name: /前往預告中心/ });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('#detailView')).toBeHidden();
});

test('§6 詳細頁：已無未生效紀錄時不顯示入口', async ({ page }) => {
  await mockSite(page, { today: '2026-10-02' });
  await page.goto('/?code=BC05037209');
  await expect(page.locator('#detail')).toContainText('已終止支付');
  await expect(page.locator('#detail').getByRole('link', { name: /前往預告中心/ })).toHaveCount(0);
});
