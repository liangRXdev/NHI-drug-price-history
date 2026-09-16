// §6／§6.1 輸出完整性矩陣與競態：M2、M3、M6、M7、M16。
// 本功能最主要的靜默錯誤風險是「載入失敗被呈現成空窗或查無」——使用者會以為比較是完整的。
import { test, expect } from '@playwright/test';
import { buildData, mockSite } from './mock.mjs';

const FOUR = 'A035680329,AC48867100,B009254100,A020296321';
const SAME_SHARD = 'AC48867100,AC48845100';          // 同一片 AC48
const summary = (page) => page.locator('.cmp-summary');
const eventRows = (page) => page.locator('.cmp-events tbody tr');
const codeRows = (page) => page.locator('.compare-code');
const banner = (page) => page.locator('#compareBanner');
const chart = (page) => page.locator('.cmp-chart');

const stateOf = (page, code) => codeRows(page).filter({ hasText: code }).locator('.compare-state').innerText();

// ── M2：同片共享請求、快取、引用計數 ────────────────────────────
test('M2 同片冷啟動且延遲時恰一個請求，兩碼各自拿到正確資料', async ({ page }) => {
  const seen = [];
  await mockSite(page, {
    today: '2026-09-11',
    shard: async (prefix, attempt, route, data) => {
      seen.push(prefix);
      await new Promise((ok) => setTimeout(ok, 400));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.shards[prefix]) });
    },
  });
  await page.goto(`/?codes=${SAME_SHARD}`);
  await expect(summary(page)).toBeVisible();
  expect(seen.filter((p) => p === 'AC48')).toHaveLength(1);
  const priceRow = summary(page).locator('tbody tr', { hasText: '現行支付價' }).locator('td');
  await expect(priceRow.nth(0)).toHaveText('12.50 元');                       // AC48867100
  await expect(priceRow.nth(1)).toHaveText('已終止支付（終止前 4.88 元）');    // AC48845100
});

test('M2 快取再訪零新增請求', async ({ page }) => {
  const { calls } = await mockSite(page, { today: '2026-09-11' });
  await page.goto(`/?codes=${SAME_SHARD}`);
  await expect(summary(page)).toBeVisible();
  const before = calls.filter((c) => c.startsWith('history/')).length;
  await page.locator('#compareView .back a').click();
  await page.locator('#compareTray button', { hasText: '開始比較' }).click();
  await expect(summary(page)).toBeVisible();
  expect(calls.filter((c) => c.startsWith('history/')).length).toBe(before);
});

// 三碼同片：移除一碼後仍有 2 碼，才不會觸發 §3.3「只剩一碼轉詳細頁」
const SAME_SHARD_3 = 'AC48867100,AC48845100,AC48092100';

test('M2 重試中移除同片的一碼：請求繼續，另一碼仍正確取得', async ({ page }) => {
  let attempt = 0;
  let release;
  const gate = new Promise((ok) => { release = ok; });
  await mockSite(page, {
    today: '2026-09-11',
    shard: async (prefix, n, route, data) => {
      if (prefix !== 'AC48') return false;
      attempt += 1;
      if (attempt === 1) return route.fulfill({ status: 500, body: 'boom' });
      await gate;                                   // 第 2 次（重試）掛著
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.shards[prefix]) });
    },
  });
  await page.goto(`/?codes=${SAME_SHARD_3}`);
  await expect(banner(page)).toContainText('AC48867100');
  await banner(page).getByRole('button', { name: '重試' }).click();
  await expect(codeRows(page).filter({ hasText: 'AC48867100' })).toContainText('重試中');

  expect(attempt).toBe(2);        // 同片兩碼的重試共享同一個請求

  // 重試在途時移除其中一碼：移除的是「需求」，不是請求——請求必須繼續
  await codeRows(page).filter({ hasText: 'AC48845100' }).getByRole('button', { name: '移除' }).click();
  release();
  await expect(codeRows(page).filter({ hasText: 'AC48867100' })).not.toContainText('失敗');
  await expect(summary(page).locator('tbody tr', { hasText: '現行支付價' }).locator('td').nth(0))
    .toHaveText('12.50 元');       // 留下的那一碼仍正確取得資料
});

// ── M3：六個輸出面交代同一個集合 ────────────────────────────────
test('M3 存在與不存在混合時，各輸出面交代同一集合', async ({ page }) => {
  await mockSite(page, { today: '2026-09-11' });
  await page.goto('/?codes=A035680329,B000000000,AC48867100');
  await expect(summary(page)).toBeVisible();

  // 選定集合：摘要欄、crosshair、狀態列都要有三個
  expect((await summary(page).locator('thead th').allTextContents()).slice(1).map((t) => t.trim()))
    .toEqual(['A035680329', 'B000000000', 'AC48867100']);
  await expect(codeRows(page)).toHaveCount(3);
  const box = await chart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect(page.locator('#compareCross .cross-row')).toHaveCount(3);
  await expect(page.locator('#compareCross')).toContainText('查無此代號');

  // 資料子集：合併表只含有資料者，且表頭明示
  const codes = new Set(await eventRows(page).evaluateAll((trs) => trs.map((tr) => tr.children[2].textContent.trim())));
  expect([...codes].sort()).toEqual(['A035680329', 'AC48867100']);
  await expect(page.locator('.cmp-card', { hasText: '合併事件時間表' })).toContainText('不含 1 個尚未取得資料的品項');
  await expect(page.locator('#cmpCsv')).toBeDisabled();
});

test('M3 載入中不得先顯示「查無」', async ({ page }) => {
  let release;
  const gate = new Promise((ok) => { release = ok; });
  await mockSite(page, {
    today: '2026-09-11',
    shard: async (prefix, n, route, data) => {
      await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.shards[prefix]) });
    },
  });
  await page.goto('/?codes=A035680329,AC48867100');
  await expect(page.locator('.cmp-skeleton')).toBeVisible();
  await expect(page.locator('#compareBody')).not.toContainText('查無此代號');
  await expect(page.locator('#compareBody')).not.toContainText('資料載入失敗');
  release();
  await expect(summary(page)).toBeVisible();
});

test('M3 載入失敗不得判為不存在', async ({ page }) => {
  await mockSite(page, {
    today: '2026-09-11',
    shard: (prefix, n, route) => (prefix === 'A035' ? route.fulfill({ status: 404, body: 'x' }) : false),
  });
  await page.goto('/?codes=A035680329,AC48867100');
  await expect(summary(page)).toBeVisible();
  expect(await stateOf(page, 'A035680329')).toBe('資料載入失敗');
  expect(await stateOf(page, 'A035680329')).not.toBe('查無此代號');
  const priceRow = summary(page).locator('tbody tr', { hasText: '現行支付價' }).locator('td');
  await expect(priceRow.nth(0)).toHaveText('資料載入失敗');
});

// ── M6：失敗代號的精確集合與重試補齊 ────────────────────────────
test('M6 橫幅列出精確的失敗集合；重試後資料實際補齊且無重複列', async ({ page }) => {
  let fail = true;
  await mockSite(page, {
    today: '2026-09-11',
    shard: (prefix, n, route) => (fail && prefix === 'A035' ? route.fulfill({ status: 500, body: 'x' }) : false),
  });
  await page.goto(`/?codes=${FOUR}`);
  await expect(banner(page)).toContainText('A035680329');
  await expect(banner(page)).not.toContainText('AC48867100');
  const before = await eventRows(page).count();

  fail = false;
  await banner(page).getByRole('button', { name: '重試' }).click();
  await expect(banner(page).locator('.alert--error')).toHaveCount(0);
  const rows = await eventRows(page).evaluateAll((trs) => trs.map((tr) => tr.dataset.row));
  expect(new Set(rows).size).toBe(rows.length);            // 無重複列
  expect(rows.length).toBeGreaterThan(before);             // 資料確實補齊
  expect(rows.some((r) => r.startsWith('A035680329'))).toBe(true);
  await expect(page.locator('#cmpCsv')).toBeEnabled();
});

test('M6 重試期間保留已成功的結果，不整頁退回骨架', async ({ page }) => {
  let release;
  const gate = new Promise((ok) => { release = ok; });
  let attempt = 0;
  await mockSite(page, {
    today: '2026-09-11',
    shard: async (prefix, n, route, data) => {
      if (prefix !== 'A035') return false;
      attempt += 1;
      if (attempt === 1) return route.fulfill({ status: 500, body: 'x' });
      await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.shards[prefix]) });
    },
  });
  await page.goto(`/?codes=${FOUR}`);
  await expect(banner(page)).toContainText('A035680329');
  await banner(page).getByRole('button', { name: '重試' }).click();
  await expect(chart(page)).toBeVisible();                 // 仍看得到已成功的序列
  await expect(page.locator('.cmp-skeleton')).toHaveCount(0);
  await expect(summary(page)).toBeVisible();
  release();
  await expect(codeRows(page).filter({ hasText: 'A035680329' })).not.toContainText('失敗');
});

test('M6 全部失敗 → 錯誤狀態與重試，六個輸出面都不得呈現資料', async ({ page }) => {
  await mockSite(page, { today: '2026-09-11', shard: (prefix, n, route) => route.fulfill({ status: 503, body: 'x' }) });
  await page.goto('/?codes=A035680329,AC48867100');
  await expect(banner(page)).toContainText('A035680329');
  await expect(banner(page)).toContainText('AC48867100');
  await expect(eventRows(page)).toHaveCount(0);
  await expect(page.locator('.cmp-line')).toHaveCount(0);
  await expect(page.locator('#cmpCsv')).toBeDisabled();
});

// ── M7：混批（版本不一致）任何輸出都不得呈現 ────────────────────
for (const [name, mutate] of [
  ['shardVersion 不符', (data) => { data.shards.A035.shardVersion = 'sha256:stale'; }],
  ['meta 缺該片版本', (data) => { delete data.meta.shards.versions.A035; }],
]) {
  test(`M7 冷開時混批（${name}）→ 整頁不組合`, async ({ page }) => {
    const data = buildData();
    mutate(data);
    await mockSite(page, { today: '2026-09-11', data });
    await page.goto('/?codes=A035680329,AC48867100');
    await expect(banner(page)).toContainText('請重新整理');
    await expect(summary(page)).toHaveCount(0);
    await expect(eventRows(page)).toHaveCount(0);
    await expect(page.locator('.cmp-line')).toHaveCount(0);
    await expect(page.locator('#cmpCsv')).toHaveCount(0);
  });
}

test('M7 已有結果後才混批 → 既有摘要與 CSV 一併停止呈現', async ({ page }) => {
  const good = buildData();
  const stale = buildData();
  stale.shards.A035.shardVersion = 'sha256:stale';
  let phase = 0;
  await mockSite(page, {
    today: '2026-09-11',
    shard: (prefix, n, route) => {
      const src = phase === 0 ? good : stale;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(src.shards[prefix]) });
    },
  });
  await page.goto('/?codes=AC48867100');                   // 先只載入另一片，建立成功狀態
  await page.goto('/?codes=AC48867100,A035680329');
  await expect(summary(page)).toBeVisible();

  phase = 1;
  await page.reload();                                      // 重新取得時 A035 變成舊版
  await expect(banner(page)).toContainText('請重新整理');
  await expect(summary(page)).toHaveCount(0);
});

// ── M16：狀態轉移與「完整成功」的定義 ───────────────────────────
test('M16 首次載入 → 部分失敗 → 重試 → 完整成功，六個輸出面逐態一致', async ({ page }) => {
  let fail = true;
  await mockSite(page, {
    today: '2026-09-11',
    shard: (prefix, n, route) => (fail && prefix === 'B009' ? route.fulfill({ status: 500, body: 'x' }) : false),
  });
  await page.goto(`/?codes=${FOUR}`);

  // 部分失敗：欄位不得消失、失敗者保留在 crosshair、CSV 停用
  await expect(summary(page).locator('thead th')).toHaveCount(5);
  await expect(page.locator('#cmpCsv')).toBeDisabled();
  const box = await chart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect(page.locator('#compareCross')).toContainText('資料載入失敗');
  await expect(page.locator('.cmp-line[data-code="B009254100"]')).toHaveCount(0);

  fail = false;
  await banner(page).getByRole('button', { name: '重試' }).click();
  await expect(page.locator('#cmpCsv')).toBeEnabled();
  await expect(page.locator('.cmp-line[data-code="B009254100"]')).not.toHaveCount(0);
  await expect(summary(page).locator('tbody tr', { hasText: '現行支付價' }).locator('td').nth(2))
    .toHaveText('已終止支付（終止前 4.81 元）');
});

test('M16 完整成功時，已隱藏的序列不應被畫出，但不影響摘要與 Y 軸以外的輸出', async ({ page }) => {
  await mockSite(page, { today: '2026-09-11' });
  await page.goto(`/?codes=${FOUR}`);
  await expect(summary(page)).toBeVisible();
  await page.locator('.cmp-legend-item', { hasText: 'AC48867100' }).getByRole('button').click();
  await expect(page.locator('.cmp-line[data-code="AC48867100"]')).toHaveCount(0);
  await expect(summary(page).locator('thead th')).toHaveCount(5);        // 摘要不受影響
  await expect(page.locator('#cmpCsv')).toBeEnabled();                   // 仍是完整成功
  const codes = new Set(await eventRows(page).evaluateAll((trs) => trs.map((tr) => tr.children[2].textContent.trim())));
  expect(codes.has('AC48867100')).toBe(true);                            // 合併表不受可見性影響
});

test('M16 格式不合法：序位留空、欄位保留、crosshair 保留該列', async ({ page }) => {
  await mockSite(page, { today: '2026-09-11' });
  await page.goto('/?codes=A035680329,NOTACODE');
  await expect(summary(page)).toBeVisible();
  await expect(summary(page).locator('thead th')).toHaveCount(3);
  await expect(summary(page).locator('tbody tr', { hasText: '現行支付價' }).locator('td').nth(1))
    .toHaveText('代號格式不正確');
  const box = await chart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect(page.locator('#compareCross')).toContainText('代號格式不正確');
  await expect(page.locator('#cmpCsv')).toBeDisabled();
});
