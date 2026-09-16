// 摘要對照表、合併事件時間表與 CSV（spec-compare.md §5）：M1、M14、M15。
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { mockSite } from './mock.mjs';

const FOUR = 'A035680329,AC48867100,B009254100,A020296321';
const summary = (page) => page.locator('.cmp-summary');
const eventRows = (page) => page.locator('.cmp-events tbody tr');

const open = async (page, codes = FOUR, opts = {}) => {
  await mockSite(page, { today: '2026-09-11', ...opts });
  await page.goto(`/?codes=${codes}`);
  await expect(summary(page)).toBeVisible();
};

const csvText = async (page) => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#cmpCsv').click(),
  ]);
  return readFileSync(await download.path(), 'utf8');
};

const parseCSV = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
};

// ── M1：比較頁與詳細頁的每代號摘要必須相同 ──────────────────────
test('M1 摘要欄位與詳細頁一致（同一個 T、同一組函式）', async ({ page }) => {
  await open(page);
  const cells = async (code) => {
    const col = (await summary(page).locator('thead th').allTextContents()).findIndex((t) => t.includes(code));
    return summary(page).locator('tbody tr').evaluateAll(
      (trs, i) => trs.map((tr) => [tr.querySelector('th').textContent.trim(), tr.querySelectorAll('td')[i]?.textContent.trim()]), col - 1);
  };
  const compare = Object.fromEntries(await cells('AC48867100'));
  expect(compare['現行支付價']).toBe('12.50 元');
  expect(compare['歷史調價次數']).toBe('9 次');

  await page.goto('/?code=AC48867100');
  const detail = page.locator('#detail');
  await expect(detail.locator('.metric.key')).toContainText('12.50');
  await expect(detail).toContainText('9');
  // 兩頁的同一指標字串必須一模一樣（詳細頁標題為「最新一次調整」，比較頁為「最近一次調整」）
  const detailLatest = await detail.locator('.metric', { hasText: '最新一次調整' }).locator('.val').first().innerText();
  expect(detailLatest.replace(/\s+/g, '')).toBe(compare['最近一次調整'].replace(/\s+/g, ''));
});

test('M1 每個代號的欄位歸屬正確，不得接錯代號', async ({ page }) => {
  await open(page);
  const head = await summary(page).locator('thead th').allTextContents();
  expect(head.slice(1).map((t) => t.trim())).toEqual(FOUR.split(','));
  const rowOf = (label) => summary(page).locator('tbody tr', { hasText: label }).locator('td');
  await expect(rowOf('現行支付價').nth(0)).toHaveText('已終止支付（終止前 23.80 元）');   // A035680329
  await expect(rowOf('現行支付價').nth(1)).toHaveText('12.50 元');                      // AC48867100
  await expect(rowOf('現行支付價').nth(2)).toHaveText('已終止支付（終止前 4.81 元）');    // B009254100
  await expect(rowOf('現行支付價').nth(3)).toHaveText('20.50 元');                      // A020296321
});

// ── M14：禁止任何跨代號算術 ────────────────────────────────────
test('M14 摘要表無合計／平均／差額／排名，但自身歷次差額仍在', async ({ page }) => {
  await open(page);
  const text = await summary(page).innerText();
  for (const word of ['合計', '平均', '中位', '總和', '排名', '最便宜', '最貴', '差額比較']) {
    expect(text).not.toContain(word);
  }
  // 每一列的欄位數 = 1（指標）+ 4（代號），沒有多出來的「差異」欄
  const widths = await summary(page).locator('tbody tr').evaluateAll((trs) => trs.map((tr) => tr.children.length));
  expect(new Set(widths)).toEqual(new Set([5]));
  // 同代號自身的差額照常呈現
  await expect(page.locator('.cmp-events tbody tr').first()).toBeVisible();
  const diffs = await page.locator('.cmp-events tbody tr td:nth-child(6)').allTextContents();
  expect(diffs.some((d) => /[+−]/.test(d))).toBe(true);
});

test('M14 CSV 也不得含跨代號算術', async ({ page }) => {
  await open(page);
  const text = await csvText(page);
  for (const word of ['合計', '平均', '排名', '較便宜', '可替代']) expect(text).not.toContain(word);
  const header = parseCSV(text.slice(1))[1];
  expect(header).toEqual(['生效日', '迄日', '代號', '品名', '支付價', '原始支付價字串',
    '與前次差額', '變動%', '狀態', '備註']);
});

// ── M15：三個輸出各有自己的分母，逐筆對應 ───────────────────────
test('M15 合併事件表 = 通過篩選的 records + invalidRecords，逐筆唯一對應', async ({ page }) => {
  await open(page);
  const expected = await page.evaluate(async (codes) => {
    const out = [];
    for (const code of codes) {
      const shard = await (await fetch(`data/history/${code.slice(0, 4)}.json`)).json();
      const e = shard.drugs[code];
      e.records.forEach((r, i) => out.push(`${code}-r${i}`));
      e.invalidRecords.forEach((r, i) => out.push(`${code}-x${i}`));
    }
    return out.sort();
  }, FOUR.split(','));
  const shown = await eventRows(page).evaluateAll((trs) => trs.map((tr) => tr.dataset.row).sort());
  expect(shown).toEqual(expected);                       // 無重複、無遺漏
  expect(new Set(shown).size).toBe(shown.length);
});

test('M15 CSV 的資料列等於當前合併事件表的列', async ({ page }) => {
  await open(page);
  const shown = await eventRows(page).evaluateAll(
    (trs) => trs.map((tr) => [tr.children[0].textContent.trim(), tr.children[2].textContent.trim()]));
  const data = parseCSV((await csvText(page)).slice(1)).slice(2);
  expect(data.length).toBe(shown.length);
  expect(data.map((r) => [r[0], r[2]])).toEqual(shown);
});

test('M15 表格篩選後，CSV 隨之改變且仍逐列對應', async ({ page }) => {
  await open(page);
  const before = await eventRows(page).count();
  await page.locator('[data-action="cmp-filter"][data-code="B009254100"]').click();
  const after = await eventRows(page).count();
  expect(after).toBeLessThan(before);
  await expect(page.locator('.cmp-events tbody')).not.toContainText('B009254100');
  const data = parseCSV((await csvText(page)).slice(1)).slice(2);
  expect(data.length).toBe(after);
  expect(data.some((r) => r[2] === 'B009254100')).toBe(false);
});

test('§5.2 invalidRecords 置於全表末尾，不得硬排成有效日期', async ({ page }) => {
  const data = (await import('./mock.mjs')).buildData();
  const entry = data.shards.A035.drugs.A035680329;
  entry.invalidRecords = [{ rawFrom: '1041301', rawTo: '9991231', rawPrice: '5.00', error: 'invalid_date' }];
  await open(page, FOUR, { data });
  const rows = await eventRows(page).evaluateAll((trs) => trs.map((tr) => tr.dataset.row));
  expect(rows.at(-1)).toBe('A035680329-x0');
  await expect(eventRows(page).last()).toContainText('日期異常（日期無法解析）');
  await expect(eventRows(page).last()).toContainText('1041301');
});

test('§5.2 排序切換只反轉有效列，異常列仍在末尾', async ({ page }) => {
  await open(page);
  const desc = await eventRows(page).evaluateAll((trs) => trs.map((tr) => tr.children[0].textContent.trim()));
  await page.locator('[data-action="cmp-sort"]').click();
  const asc = await eventRows(page).evaluateAll((trs) => trs.map((tr) => tr.children[0].textContent.trim()));
  expect(asc).toEqual([...desc].reverse());
});

// ── §5.3 匯出條件 ───────────────────────────────────────────────
test('§5.3 未完整成功時停用匯出', async ({ page }) => {
  await open(page, FOUR, {
    shard: (prefix, attempt, route) => (prefix === 'A035' ? route.fulfill({ status: 500, body: 'x' }) : false),
  });
  await expect(page.locator('#cmpCsv')).toBeDisabled();
  await expect(page.locator('#cmpCsv')).toHaveAttribute('title', '部分品項尚未載入完成');
});

test('§5.3 檔名含所有代號與參考日期，內容有 BOM 與前言', async ({ page }) => {
  await open(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#cmpCsv').click(),
  ]);
  expect(download.suggestedFilename())
    .toBe('nhi_compare_A035680329_AC48867100_B009254100_A020296321_2026-09-11.csv');
  const text = readFileSync(await download.path(), 'utf8');
  expect(text.codePointAt(0)).toBe(0xfeff);
  const rows = parseCSV(text.slice(1));
  expect(rows[0][0]).toContain('參考日期 2026-09-11');
  expect(rows[0][0]).toContain('並列呈現不表示品項可互相替代');
});

test('§6.1 非成功代號的摘要欄保留，值改為取得狀態', async ({ page }) => {
  await open(page, 'A035680329,AC48867100,BAD0000000', {
    shard: (prefix, attempt, route) => (prefix === 'A035' ? route.fulfill({ status: 404, body: 'x' }) : false),
  });
  const head = await summary(page).locator('thead th').allTextContents();
  expect(head.slice(1).map((t) => t.trim())).toEqual(['A035680329', 'AC48867100', 'BAD0000000']);
  const priceRow = summary(page).locator('tbody tr', { hasText: '現行支付價' }).locator('td');
  await expect(priceRow.nth(0)).toHaveText('資料載入失敗');
  await expect(priceRow.nth(1)).toHaveText('12.50 元');
  await expect(priceRow.nth(2)).toHaveText('查無此代號');
  // 合併事件表只含成功代號，且表頭明示
  await expect(page.locator('.cmp-card', { hasText: '合併事件時間表' })).toContainText('不含 2 個尚未取得資料的品項');
});
