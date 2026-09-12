// 以 repo 內實際發布的 data/ 做 smoke test（不 mock）。mock 全來自 golden fixture，
// 無法發現「正式資料缺欄位」（codex R1／T1）。斷言只檢查不變的性質，不綁特定價格，
// 避免每月資料更新造成假紅。
import { test, expect } from '@playwright/test';

test.describe.configure({ timeout: 90_000 });

test('正式資料：搜尋卡不得出現「— 元」；首列 0 元代號不稱「終止」', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('#q');
  await expect(input).toBeEnabled({ timeout: 60_000 });
  await page.getByLabel('顯示已終止支付品項').check();          // 要驗的正是終止／暫停卡，不可被預設篩選藏掉

  // 終止品項占 69%，這些常見字串的前 50 筆必含大量終止／暫停卡
  for (const q of ['錠', '注射', 'tab', 'a0']) {
    await input.fill('');
    await expect(page.locator('#searchStatus')).toHaveText(/請輸入/);
    await input.fill(q);
    await expect(page.locator('.result').first()).toBeVisible();
    const texts = await page.locator('.result .r-price').allTextContents();
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t, `${q}：${t}`).not.toMatch(/—\s*元/);
      expect(t, `${q}：${t}`).not.toContain('undefined');
    }
  }

  // A020296321 首列 0 元（golden 反例代號）
  await page.goto('/?code=A020296321');
  const firstRow = page.locator('#detail tr[data-kind="record"]').last();
  await expect(firstRow).toContainText('此前無有價紀錄', { timeout: 30_000 });
  await expect(firstRow).not.toContainText('終止');
});

test('正式資料：index 每筆 window 的非有價列都帶 pricedBefore', async ({ request }) => {
  const res = await request.get('/data/drug_index.json');
  expect(res.ok()).toBe(true);
  const index = await res.json();
  const missing = index.drugs.filter((d) => d.window.some((w) => w.priceState !== 'priced' && !('pricedBefore' in w)));
  expect(missing.map((d) => d.code).slice(0, 5)).toEqual([]);
});
