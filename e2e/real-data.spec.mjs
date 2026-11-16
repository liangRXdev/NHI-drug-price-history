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

// spec-startup S15：真實 data/、GitHub Pages 的專案子路徑、deep link。index 扣住期間詳情就必須正確，
// 預期值由該片 shard 的 records 獨立算出（不經 engine.js、不綁特定價格）。
test('正式資料：?code= 在 index 扣住時顯示詳情，內容等於由 shard 獨立算出的預期值；放行後可搜尋', async ({ page, request }) => {
  const BASE = '/NHI-drug-price-history';
  const CODE = 'A020296321';
  const meta = await (await request.get(`${BASE}/data/meta.json`)).json();
  const prefix = meta.shards.files.filter((f) => CODE.startsWith(f)).sort((a, b) => b.length - a.length)[0];
  expect(prefix, '分片清單須有此代號的前綴').toBeTruthy();
  const shard = await (await request.get(`${BASE}/data/history/${encodeURIComponent(prefix)}.json`)).json();
  const entry = shard.drugs[CODE];
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const effective = entry.records.filter((r) => r.from <= today && (r.to === null || r.to >= today));

  let release;
  const gate = new Promise((ok) => { release = ok; });
  let indexRequests = 0;
  await page.route('**/data/drug_index.json', async (route) => {
    indexRequests += 1;
    await gate;
    await route.continue();
  });

  await page.goto(`${BASE}/?code=${CODE}`);
  const detail = page.locator('#detail');
  await expect(detail.locator('.detail-head .code')).toHaveText(CODE, { timeout: 30_000 });
  await expect(detail.locator('table.history tbody tr')).toHaveCount(entry.records.length + entry.invalidRecords.length);
  if (effective.length === 1 && effective[0].priceState === 'priced') {
    await expect(detail.locator('.metric.key .val')).toContainText(effective[0].rawPrice);
  } else {
    await expect(detail.locator('.metric.key .val small')).toHaveCount(0);       // 非有價：不得顯示金額
  }
  await expect.poll(() => indexRequests).toBe(1);
  await expect(page.locator('#q')).toBeDisabled();                               // index 仍扣住

  release();
  await page.locator('#backLink').click();
  const input = page.locator('#q');
  await expect(input).toBeEnabled({ timeout: 60_000 });
  await input.fill(CODE);
  await expect(page.locator('#results .result').first()).toHaveAttribute('data-code', CODE);
});

// spec-startup S8：實際發布的 meta.json 須通過 §5.7 的 shard map 合法性
test('正式資料：meta.json 的 shard map 通過 validateMeta', async ({ request }) => {
  const { validateMeta } = await import('../engine.js');
  const meta = await (await request.get('/data/meta.json')).json();
  expect(validateMeta(meta)).toEqual({ ok: true });
  expect(meta.shards.files.length).toBeGreaterThan(0);
});

test('正式資料：index 每筆 window 的非有價列都帶 pricedBefore', async ({ request }) => {
  const res = await request.get('/data/drug_index.json');
  expect(res.ok()).toBe(true);
  const index = await res.json();
  const missing = index.drugs.filter((d) => d.window.some((w) => w.priceState !== 'priced' && !('pricedBefore' in w)));
  expect(missing.map((d) => d.code).slice(0, 5)).toEqual([]);
});
