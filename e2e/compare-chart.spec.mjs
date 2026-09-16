// 多序列圖表（spec-compare.md §4）：M8 band、M9 首列 0 元、M11 無線狀態、
// M12 空窗、M13 crosshair、§4.2.1 可見性與選定集合的分野。
import { test, expect } from '@playwright/test';
import { mockSite } from './mock.mjs';

const FOUR = 'A035680329,AC48867100,B009254100,A020296321';
const chart = (page) => page.locator('.cmp-chart');
const legend = (page) => page.locator('.cmp-legend-item');
const cross = (page) => page.locator('#compareCross');

const open = async (page, codes = FOUR, opts = {}) => {
  await mockSite(page, { today: '2026-09-11', ...opts });
  await page.goto(`/?codes=${codes}`);
  await expect(chart(page)).toBeVisible();
};

const bandsOf = (page, code) => page.locator(`.cmp-chart rect[data-kind]`).evaluateAll(
  (els, c) => els.map((el) => el.querySelector('title').textContent).filter((t) => t.startsWith(c)), code);

test('M8 每個代號的 band 區間與 tooltip 逐段正確', async ({ page }) => {
  await open(page);
  const a = await bandsOf(page, 'A035680329');
  // 共用 X 軸自 1995-03-01（四碼中最早的 from）起，因此該代號首段是「尚未有紀錄」
  expect(a[0]).toBe('A035680329 1995-03-01 ～ 1997-02-28：尚未有紀錄');
  expect(a[1]).toBe('A035680329 1997-03-01 ～ 2001-03-31：60.00 元（1997-03-01 ～ 2001-03-31）');
  expect(a.at(-2)).toBe('A035680329 2010-09-01 ～ 2010-09-30：此日期無支付紀錄');
  expect(a.at(-1)).toBe('A035680329 2010-10-01 ～ 2026-09-11：已終止支付（終止前 23.80 元）');

  const b = await bandsOf(page, 'B009254100');
  expect(b.at(-2)).toBe('B009254100 2014-08-01 ～ 2015-01-31：暫停支付（來源標示「-」，暫停前 4.81 元）');
  expect(b.at(-1)).toBe('B009254100 2015-02-01 ～ 2026-09-11：已終止支付（終止前 4.81 元）');
});

test('M9 首列 0 元的 band 不得稱終止；同圖的真正終止必須稱終止', async ({ page }) => {
  await open(page);
  const z = await bandsOf(page, 'A020296321');
  expect(z[0]).toBe('A020296321 1995-03-01 ～ 1998-02-28：健保支付價 0 元（此前無有價紀錄）');
  expect(z[0]).not.toContain('終止');
  const t = await bandsOf(page, 'AC48867100');
  expect(t.some((x) => x.includes('已終止支付（終止前 29.80 元）'))).toBe(true);
});

test('M8 主圖非有價區間既無區塊也無 0 值線', async ({ page }) => {
  await open(page);
  // 主圖只有 .cmp-line；非有價一律不產生線段
  const ys = await page.locator('.cmp-line').evaluateAll((els) => els.map((el) => Number(el.getAttribute('y1'))));
  expect(ys.length).toBeGreaterThan(20);
  const axisY = await chart(page).evaluate((svg) => Number(svg.querySelector('.axis line').getAttribute('y1')));
  expect(Math.max(...ys)).toBeLessThan(axisY);        // 沒有任何線貼在 0 值軸上
  // band 只出現在狀態帶區（軸線以下）
  const bandY = await page.locator('.cmp-band').first().evaluate((el) => Number(el.getAttribute('y')));
  expect(bandY).toBeGreaterThan(axisY);
});

test('M11 三種無線狀態在圖例各自可分辨', async ({ page }) => {
  await open(page, 'A035680329,A020296321');
  await page.getByRole('button', { name: '相對變化' }).click();
  await page.getByRole('button', { name: '近 3 年' }).click();
  // A035680329 2010-10-01 起已終止 → 有基準但此區間無有價紀錄
  await expect(legend(page).filter({ hasText: 'A035680329' }))
    .toContainText('此區間無有價紀錄（基準 1997-03-01／60.00 元）');
  // A020296321 近 3 年內無任何 from，但持續有價 → 必須畫線（§4.1.2）
  await expect(legend(page).filter({ hasText: 'A020296321' })).toContainText('基準 1998-03-01／34.00 元');
  await expect(page.locator('.cmp-line.s2')).not.toHaveCount(0);
});

test('M10 切換 preset 不改變基準，只改變可見範圍', async ({ page }) => {
  await open(page, 'AC48867100,A020296321');
  await page.getByRole('button', { name: '相對變化' }).click();
  const base = () => legend(page).filter({ hasText: 'AC48867100' }).innerText();
  const all = await base();
  await page.getByRole('button', { name: '近 5 年' }).click();
  expect(await base()).toBe(all);
  await expect(chart(page)).toHaveAttribute('data-x-min', '2021-09-11');
  await page.getByRole('button', { name: '全部' }).click();
  // 「全部」的左界是**兩碼**中最早的 from（A020296321 的 1995-03-01），不是各自的
  await expect(chart(page)).toHaveAttribute('data-x-min', '1995-03-01');
});

test('M12 空窗段不得有線段跨越', async ({ page }) => {
  await open(page, 'A035680329,AC48092100');
  const gapTitle = (await bandsOf(page, 'A035680329')).find((t) => t.includes('此日期無支付紀錄'));
  expect(gapTitle).toBe('A035680329 2010-09-01 ～ 2010-09-30：此日期無支付紀錄');
  // 該代號（序位 1）的線段不得覆蓋空窗：所有線段的 x 區間都不包含空窗中點
  const segs = await page.locator('.cmp-line.s1').evaluateAll(
    (els) => els.map((el) => [Number(el.getAttribute('x1')), Number(el.getAttribute('x2'))]));
  const bandRect = await page.locator('.cmp-chart rect[data-kind]').filter({ hasText: '此日期無支付紀錄' }).first()
    .evaluate((el) => [Number(el.getAttribute('x')), Number(el.getAttribute('width'))]);
  const mid = bandRect[0] + bandRect[1] / 2;
  expect(segs.some(([a, b]) => a < mid && b > mid)).toBe(false);
});

test('M13 crosshair 列出所有選定代號在該日的狀態', async ({ page }) => {
  await open(page);
  const box = await chart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3);
  await expect(cross(page)).toBeVisible();
  await expect(cross(page).locator('.cross-row')).toHaveCount(4);
  const day = await cross(page).getAttribute('data-day');
  expect(day > '2020-01-01' && day <= '2026-09-11').toBe(true);
  // 四個代號都要有一列，缺一不可
  for (const code of FOUR.split(',')) await expect(cross(page)).toContainText(code);
});

test('M13 觸控點擊定位 crosshair，再點空白處取消', async ({ page }) => {
  await open(page);
  const box = await chart(page).boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
  await expect(cross(page)).toBeVisible();
  const day = await cross(page).getAttribute('data-day');
  await page.locator('#compareTitle').click();
  await expect(cross(page)).toBeHidden();
  // 同一位置點擊應得到同一日期（與滑鼠移動一致）
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
  await expect(cross(page)).toHaveAttribute('data-day', day);
});

test('§4.2.1 隱藏只影響主圖與 band，不改變選定集合與 crosshair', async ({ page }) => {
  await open(page);
  const s1 = () => page.locator('.cmp-line.s1');
  expect(await s1().count()).toBeGreaterThan(0);
  await legend(page).filter({ hasText: 'A035680329' }).getByRole('button').click();
  await expect(s1()).toHaveCount(0);
  await expect(legend(page)).toHaveCount(4);                     // 圖例仍在
  await expect(page.locator('.compare-code')).toHaveCount(4);    // 選定集合不變

  const box = await chart(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect(cross(page).locator('.cross-row')).toHaveCount(4);
  await expect(cross(page).locator('[data-code="A035680329"]')).toContainText('（已隱藏）');
});

test('§4.2 序位決定顏色與線型，四條線各不相同', async ({ page }) => {
  await open(page);
  const dash = await page.evaluate(() => [1, 2, 3, 4].map((i) => {
    const el = document.querySelector(`.cmp-line.s${i}`);
    return el ? getComputedStyle(el).strokeDasharray : null;
  }));
  expect(new Set(dash.filter(Boolean)).size).toBe(dash.filter(Boolean).length);
  const colors = await page.evaluate(() => [1, 2, 3, 4].map((i) => {
    const el = document.querySelector(`.cmp-line.s${i}`);
    return el ? getComputedStyle(el).stroke : null;
  }));
  expect(new Set(colors.filter(Boolean)).size).toBe(colors.filter(Boolean).length);
});

test('§6 任一 shard 載入中 → 骨架，不得先畫已到的序列', async ({ page }) => {
  let release;
  const gate = new Promise((ok) => { release = ok; });
  await mockSite(page, {
    today: '2026-09-11',
    shard: async (prefix, attempt, route, data) => {
      if (prefix === 'A020') await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.shards[prefix]) });
    },
  });
  await page.goto(`/?codes=${FOUR}`);
  await expect(page.locator('.cmp-skeleton')).toBeVisible();
  await expect(chart(page)).toHaveCount(0);
  release();
  await expect(chart(page)).toBeVisible();
  await expect(page.locator('.cmp-skeleton')).toHaveCount(0);
});

// ── M10：相對變化模式的指數值（§4.1）─────────────────────────────
test('M10 指數值以各自基準計算，基準點恆為 100.0', async ({ page }) => {
  await open(page, 'AC48867100,A020296321');
  await page.getByRole('button', { name: '相對變化' }).click();

  const idx = (code) => page.locator(`.cmp-line[data-code="${code}"][data-index]`)
    .evaluateAll((els) => els.map((el) => el.dataset.index));
  const ac = await idx('AC48867100');
  expect(ac[0]).toBe('100.0');                     // 基準列本身
  expect(ac.at(-1)).toBe('38.7');                  // 12.50 ÷ 32.30
  const a0 = await idx('A020296321');
  expect(a0[0]).toBe('100.0');                     // 1998-03-01 起 34.00
  expect(a0.at(-1)).toBe('60.3');                  // 20.50 ÷ 34.00
  // Y 軸不得標成價格或貨幣單位
  await expect(page.locator('.cmp-chart .y-unit')).toHaveText('指數（各自基準＝100）');
  await expect(page.locator('.cmp-chart .y-unit')).not.toContainText('元');
});

test('M10 絕對金額模式標示為元，且線帶原始價格', async ({ page }) => {
  await open(page, 'AC48867100,A020296321');
  await expect(page.locator('.cmp-chart .y-unit')).toHaveText('元');
  const prices = await page.locator('.cmp-line[data-code="AC48867100"][data-price]')
    .evaluateAll((els) => els.map((el) => el.dataset.price));
  expect(prices[0]).toBe('32.30');
  expect(prices.at(-1)).toBe('12.50');
});

test('M10 停止後恢復支付的區間也以同一基準計算', async ({ page }) => {
  await open(page, 'AC48867100,A020296321');
  await page.getByRole('button', { name: '相對變化' }).click();
  const idx = await page.locator('.cmp-line[data-code="AC48867100"][data-index]')
    .evaluateAll((els) => els.map((el) => el.dataset.index));
  // 2017-12-01 恢復支付 22.90 ÷ 32.30 = 70.9；終止期間不產生線段
  expect(idx).toContain('70.9');
  expect(idx.filter((v) => v === '0.0')).toHaveLength(0);
});
