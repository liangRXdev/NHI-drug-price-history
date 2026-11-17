// spec-startup.md §8：S13 比較頁與預告中心 deep link 不依賴 index；index 發布時主體不重畫。
import { test, expect } from '@playwright/test';
import { buildData } from './mock.mjs';
import { gatedSite, watchMutations, mutations, waitSearchReady, SETTLE_MS, TEXT } from './gate.mjs';

const A = 'AC48092100';          // 現行 4.12 元；撫緒膜衣錠20毫克
const B = 'B009254100';          // 現行已終止支付；低落美膜衣錠２５公絲
const N = 'AC48000001';          // 合成：尚無已生效紀錄（selectMeta 回 null）
const summary = (page) => page.locator('.cmp-summary');
const summaryRow = (page, label) => summary(page).locator('tbody tr').filter({ has: page.locator('th', { hasText: new RegExp(`^${label}$`) }) }).locator('td');
const chipNames = (page) => page.locator('#compareTray .tray-name');

test('S13 ?codes= 兩個有效代號（index 永不回應）→ 圖表 2 條序列，摘要兩欄等於 golden 預期值', async ({ page }) => {
  const site = await gatedSite(page, { plan: { index: 'pending' } });
  await page.goto(`/?codes=${A},${B}`);
  await expect(summary(page)).toBeVisible();
  await site.waitCount('index', 1);
  await expect(page.locator('.cmp-legend-item')).toHaveCount(2);
  await expect(page.locator(`.cmp-line[data-code="${A}"]`).first()).toBeAttached();     // SVG 水平線的外框高度為 0，不能用 toBeVisible
  await expect(page.locator(`.cmp-line[data-code="${B}"]`).first()).toBeAttached();
  await expect(summary(page).locator('thead th .mono')).toHaveText([A, B]);
  await expect(summaryRow(page, '中文品名')).toHaveText(['撫緒膜衣錠20毫克', '低落美膜衣錠２５公絲']);
  await expect(summaryRow(page, '現行支付價').nth(0)).toContainText('4.12');
  await expect(summaryRow(page, '現行支付價').nth(1)).toContainText('已終止支付');
  await expect(chipNames(page)).toHaveCount(0);             // index 未發布：chip 無品名
});

test('S13 ?view=upcoming（index 永不回應）→ 列數等於 golden 預期值', async ({ page }) => {
  const site = await gatedSite(page, { plan: { index: 'pending' } });
  await page.goto('/?view=upcoming');
  await expect(page.locator('.upcoming-row')).toHaveCount(3);
  await site.waitCount('index', 1);
  await expect(page.locator('.upcoming-row')).toHaveCount(3);
});

test('S13 比較頁 shard 500（index 永不回應）→ 該視圖現有的錯誤文案', async ({ page }) => {
  await gatedSite(page, { plan: { index: 'pending', 'shard:B009': 500 } });
  await page.goto(`/?codes=${A},${B}`);
  await expect(page.locator('#compareBanner')).toContainText('以下品項的資料載入失敗');
  await expect(page.locator('#compareBanner')).toContainText(B);
  await expect(page.locator(`.compare-code[data-code="${A}"]`)).toHaveAttribute('data-status', 'ok');
});

test('S13 預告中心 upcoming.json 版本不符（index 永不回應）→ 該視圖現有的錯誤文案', async ({ page }) => {
  const data = buildData();
  data.upcoming.dataVersion = 'sha256:other-batch';
  await gatedSite(page, { data, plan: { index: 'pending' } });
  await page.goto('/?view=upcoming');
  await expect(page.locator('#upcomingBanner')).toContainText(TEXT.coreMismatch);
  await expect(page.locator('.upcoming-row')).toHaveCount(0);
});

test('S13 index 之後發布：預告主體零 mutation', async ({ page }) => {
  const site = await gatedSite(page, { plan: { index: 'hold' } });
  await page.goto('/?view=upcoming');
  await expect(page.locator('.upcoming-row')).toHaveCount(3);
  await expect(page.locator('#upcomingDates')).not.toContainText('載入中');      // status 已落定
  await site.waitHeld('index');
  await watchMutations(page, '#upcomingView');              // 整個預告主體（控制項、狀態列、清單），不只清單
  await site.release('index');
  await waitSearchReady(page);
  await page.waitForTimeout(SETTLE_MS);
  expect(await mutations(page, '#upcomingView')).toEqual([]);
});

test('S13 index 之後發布：比較主體零 mutation，比較籃 chip 補上 golden 品名', async ({ page }) => {
  const site = await gatedSite(page, { plan: { index: 'hold' } });
  await page.goto(`/?codes=${A},${B}`);
  await expect(summary(page)).toBeVisible();
  await site.waitHeld('index');
  await expect(chipNames(page)).toHaveCount(0);
  await watchMutations(page, '#compareBody');
  await site.release('index');
  await expect(chipNames(page)).toHaveText(['撫緒膜衣錠20毫克', '低落美膜衣錠２５公絲']);
  await page.waitForTimeout(SETTLE_MS);
  expect(await mutations(page, '#compareBody')).toEqual([]);
});

test('S13 selectMeta 回 null 的代號（合成）：發布後品名補為 index 的 chName，mutation 只落在該品名節點', async ({ page }) => {
  const data = buildData();
  const base = data.shards.AC48.drugs[A];
  data.shards.AC48.drugs[N] = { ...structuredClone(base), records: [{ ...structuredClone(base.records[base.records.length - 1]), from: '2026-12-01', to: null }] };
  data.index.drugs.push({ ...data.index.drugs.find((d) => d.code === A), code: N, chName: '合成待生效品' });
  const site = await gatedSite(page, { data, plan: { index: 'hold' } });
  await page.goto(`/?codes=${N},${B}`);
  await expect(summary(page)).toBeVisible();
  await site.waitHeld('index');
  const name = page.locator(`.compare-code[data-code="${N}"] .compare-name`);
  await expect(name).toHaveText('');
  await watchMutations(page, '#compareBody');
  await site.release('index');
  await expect(name).toHaveText('合成待生效品');
  await page.waitForTimeout(SETTLE_MS);
  const records = await mutations(page, '#compareBody');
  expect(records.length, 'mutation 筆數').toBeGreaterThan(0);
  // 錨定到「該代號」的品名節點：錯改另一品項的 .compare-name 不得通過
  for (const r of records) expect(r, 'mutation 位置').toMatch(new RegExp(`compare-name>?\\[${N}\\]$`));
  await expect(page.locator(`.compare-code[data-code="${B}"] .compare-name`)).toHaveText('低落美膜衣錠２５公絲');
});
