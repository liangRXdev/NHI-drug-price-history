// U10／U11 的「更新失敗」矩陣與競態（Codex 覆審 R1／R2／R3／R7／R8、T2／T6）。
//
// 這些情境的共同點：**畫面看起來正常，但顯示的其實是舊資料或錯的數字**。
// 前一版的測試只驗到「首次載入失敗」與「離開後頁面仍隱藏」，全部漏在這裡。
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildData, mockSite, upcomingItem, upcomingPayload } from './mock.mjs';

const rows = (page) => page.locator('.upcoming-row');
const banner = (page) => page.locator('#upcomingBanner');
const badge = (page) => page.locator('#upcomingBadge');
const status = (page) => page.locator('#upcomingStatus');
const back = (page) => page.locator('#upcomingView .back a');

const enter = async (page) => {
  await badge(page).click();
  await expect(page.locator('#upcomingView')).toBeVisible();
};

const csvText = async (page) => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#upCsv').click(),
  ]);
  return readFileSync(await download.path(), 'utf8');
};

// ── R1：更新尚未成功前，不得撤掉舊快照的警示 ─────────────────────
test('R1 重試在途時仍顯示「更新失敗」，CSV 仍帶沿用舊快照註記', async ({ page }) => {
  await mockSite(page, { upcoming: [undefined, 'network', 'pending'], timeouts: { upcoming: 30_000 } });
  await page.goto('/?view=upcoming');
  await expect(rows(page)).toHaveCount(3);

  await back(page).click();
  await enter(page);                                   // 第 2 次：網路失敗 → 保留舊清單
  await expect(banner(page).locator('.alert--warn')).toContainText('更新失敗');

  // 第 3 次：請求掛著不回應。警示不得因為「正在重試」而消失
  await banner(page).getByRole('button', { name: '重試' }).click();
  await expect(status(page)).toContainText('更新中…');
  await expect(banner(page).locator('.alert--warn')).toContainText('更新失敗');
  await expect(rows(page)).toHaveCount(3);
  expect(await csvText(page)).toContain('更新失敗，本檔沿用 2026-09-11 的資料');
});

// 註：目前 status.json 只在頁面載入時取一次，因此「舊快照配上新檢查日」在現行流程中
// 還觀察不到；快照保存 checkedAt 是為了讓日後若改為重取 status，不會靜默把舊資料
// 配上新的檢查日。本測試驗的是日期列確實取自快照。
test('R1 更新失敗時日期列取自快照（buildDate 與當時的檢查日）', async ({ page }) => {
  const { data } = await mockSite(page, {
    upcoming: [undefined, 'network'],
    status: { lastCheckedAt: '2026-09-10T02:00:00+08:00', lastCheckResult: 'unchanged', dataVersion: 'sha256:e2e-v1', sourceModifiedAt: null },
  });
  expect(data.upcoming.buildDate).toBe('2026-09-11');
  await page.goto('/?view=upcoming');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('#upcomingDates')).toContainText('最後檢查 2026-09-10');

  await back(page).click();
  await enter(page);
  await expect(banner(page).locator('.alert--warn')).toContainText('更新失敗');
  await expect(page.locator('#upcomingDates')).toContainText('資料產生日 2026-09-11');
  await expect(page.locator('#upcomingDates')).toContainText('最後檢查 2026-09-10');
});

test('R1 更新成功才解除警示', async ({ page }) => {
  await mockSite(page, { upcoming: [undefined, 'network', undefined] });
  await page.goto('/?view=upcoming');
  await back(page).click();
  await enter(page);
  await expect(banner(page).locator('.alert--warn')).toContainText('更新失敗');
  await banner(page).getByRole('button', { name: '重試' }).click();
  await expect(banner(page).locator('.alert--warn')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  expect(await csvText(page)).not.toContain('更新失敗');
});

// ── R8：body 接收階段逾時屬網路類，必須保留舊快照 ────────────────
test('R8 body 逾時保留舊清單，不得當成內容損毀清空', async ({ page }) => {
  await mockSite(page, { upcoming: [undefined, 'body-stall'], timeouts: { upcoming: 500 } });
  await page.goto('/?view=upcoming');
  await expect(rows(page)).toHaveCount(3);

  await back(page).click();
  await enter(page);
  await expect(banner(page).locator('.alert--warn')).toContainText('更新失敗');
  await expect(banner(page)).toContainText('連線逾時');
  await expect(rows(page)).toHaveCount(3);                       // 舊清單仍在
  await expect(banner(page).locator('.alert--error')).toHaveCount(0);
});

test('R8 真正的 JSON 語法錯誤仍屬內容不合法，必須清空', async ({ page }) => {
  await mockSite(page, { upcoming: [undefined, 'corrupt'] });
  await page.goto('/?view=upcoming');
  await back(page).click();
  await enter(page);
  await expect(banner(page).locator('.alert--error')).toContainText('內容不合法');
  await expect(rows(page)).toHaveCount(0);
});

// ── T6：成功後的版本不符與壞列，一律清空 ─────────────────────────
test('T6 成功後版本不符：清空清單並停用匯出', async ({ page }) => {
  const stale = structuredClone(buildData().upcoming);
  stale.dataVersion = 'sha256:old';
  await mockSite(page, { upcoming: [undefined, stale] });
  await page.goto('/?view=upcoming');
  await expect(rows(page)).toHaveCount(3);
  await back(page).click();
  await enter(page);
  await expect(banner(page)).toContainText('請重新整理');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#upCsv')).toBeHidden();
});

test('T6 成功後 generatorVersion 不符：同樣清空', async ({ page }) => {
  const stale = structuredClone(buildData().upcoming);
  stale.generatorVersion = 'upcoming/0';
  await mockSite(page, { upcoming: [undefined, stale] });
  await page.goto('/?view=upcoming');
  await back(page).click();
  await enter(page);
  await expect(banner(page)).toContainText('請重新整理');
  await expect(rows(page)).toHaveCount(0);
});

test('T6 成功後合法 JSON 但一列不合法：清空，不得部分渲染', async ({ page }) => {
  const broken = structuredClone(buildData().upcoming);
  broken.items[1].price = 12.5;                                  // terminated 卻有正數價格
  await mockSite(page, { upcoming: [undefined, broken] });
  await page.goto('/?view=upcoming');
  await expect(rows(page)).toHaveCount(3);
  await back(page).click();
  await enter(page);
  await expect(banner(page).locator('.alert--error')).toContainText('內容不合法');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#upCsv')).toBeHidden();
});

// ── R2／T2：過期回應不得覆蓋新一代請求的結果 ─────────────────────
test('T2 舊回應晚到不得覆蓋新回應的內容', async ({ page }) => {
  const slowOld = upcomingPayload([upcomingItem({ code: 'OLD0000001', chName: '舊回應藥' })]);
  const fastNew = upcomingPayload([
    upcomingItem({ code: 'NEW0000001', chName: '新回應藥' }),
    upcomingItem({ code: 'NEW0000002', chName: '新回應藥二' }),
  ]);
  let call = 0;
  await mockSite(page, {
    upcoming: [slowOld, fastNew],
    // 第一次延遲 2.5 秒，第二次立刻回
    upcomingDelay: 0,
    timeouts: { upcoming: 30_000 },
  });
  // upcomingDelay 是全域的，改用逐次攔截：重新掛一層 route 只處理 upcoming.json
  await page.route('**/data/upcoming.json', async (route) => {
    call += 1;
    const body = call === 1 ? slowOld : fastNew;
    if (call === 1) await new Promise((ok) => setTimeout(ok, 2500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/?view=upcoming');
  await expect(page.locator('.skeleton').first()).toBeVisible();
  await back(page).click();
  await enter(page);                                             // 第 2 次請求（快）
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('NEW0000001');

  await page.waitForTimeout(3000);                               // 舊回應此時才抵達
  expect(call).toBe(2);
  await expect(rows(page)).toHaveCount(2);                       // 不得被舊回應蓋掉
  await expect(page.locator('#upcomingList')).not.toContainText('OLD0000001');
  expect(await csvText(page)).not.toContain('OLD0000001');
});

// ── R3：進入預告中心時重新取得 T ─────────────────────────────────
test('R3 跨午夜後重新進入，到期標示與徽章依新日期重算', async ({ page }) => {
  const items = [
    upcomingItem({ code: 'AA00000001', effectiveDate: '2026-09-20' }),
    upcomingItem({ code: 'AA00000002', effectiveDate: '2026-10-01' }),
  ];
  const data = buildData();
  data.upcoming = upcomingPayload(items);
  await mockSite(page, { today: '2026-09-19', data });
  await page.goto('/?view=upcoming');
  await expect(rows(page).locator('[data-expired-tag]')).toHaveCount(0);
  await expect(badge(page)).toHaveText('預告 2');

  await back(page).click();
  await page.clock.setFixedTime(new Date('2026-09-20T10:00:00+08:00'));
  await enter(page);
  await expect(rows(page).locator('[data-expired-tag]')).toHaveCount(1);
  await expect(badge(page)).toHaveText('預告 1');
  expect(await csvText(page)).toContain('檢視日期 2026-09-20');
});

// ── R7：篩選後的「尚未生效」數字只能宣稱篩選結果 ──────────────────
test('R7 篩選後的未生效數對應呈現的列，徽章仍為全清單', async ({ page }) => {
  const items = [
    upcomingItem({ code: 'BB00000001', atcCode: 'A01AA01', effectiveDate: '2026-09-20' }),
    upcomingItem({ code: 'BB00000002', atcCode: 'B01AA01', effectiveDate: '2026-12-01' }),
    upcomingItem({ code: 'BB00000003', atcCode: 'B01AA02', effectiveDate: '2026-12-01' }),
  ];
  const data = buildData();
  data.upcoming = upcomingPayload(items);
  await mockSite(page, { today: '2026-09-25', data });           // 第 1 列已生效

  await page.goto('/?view=upcoming');
  await expect(status(page)).toHaveText('共 3 筆公告，其中 2 筆尚未生效。');
  await expect(badge(page)).toHaveText('預告 2');

  await page.goto('/?view=upcoming&atc=A');                      // 只剩已生效那一列
  await expect(rows(page)).toHaveCount(1);
  await expect(status(page)).toContainText('符合篩選條件 1 筆（清單共 3 筆）');
  await expect(status(page)).toContainText('其中已無未生效的公告');
  await expect(status(page)).not.toContainText('其中 2 筆尚未生效');
  await expect(badge(page)).toHaveText('預告 2');                 // 徽章維持全清單計數
});
