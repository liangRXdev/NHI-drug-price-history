// spec-index-format.md v0.4：F5（indexFormat 不符）、F13（runtime 判定關鍵欄），經 app 實際載入路徑。
// 斷言 app 的實際狀態（<html data-core／data-core-error>），不只看文案——
// core 狀態只有 loading｜ready｜error｜mismatch，`invalid` 是 coreError.kind（v0.4 覆審 3.5）。
import { test, expect } from '@playwright/test';
import { buildData, mockSite } from './mock.mjs';

const html = (page) => page.locator('html');

/** 收集未捕捉例外：F13 要求 pageerror 為 0（漏驗欄位在 ready 後 crash 正是要擋的形態） */
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function expectUnavailable(page, { core, kind, action }) {
  await expect(html(page)).toHaveAttribute('data-core', core);
  await expect(html(page)).toHaveAttribute('data-core-error', kind);
  await expect(page.locator('#q')).toBeDisabled();
  await expect(page.locator('#results .result')).toHaveCount(0);
  await expect(page.locator('#searchStatus')).toHaveText('資料無法使用，請見上方訊息。');
  await expect(page.locator('#searchStatus')).not.toContainText('查無');
  await expect(page.locator(`#banners [data-action="${action}"]`)).toHaveCount(1);
}

async function expectSearchable(page, code) {
  await expect(html(page)).toHaveAttribute('data-core', 'ready');
  const input = page.locator('#q');
  await expect(input).toBeEnabled();
  await input.fill(code);
  await expect(page.locator(`.result[data-code="${code}"]`)).toHaveCount(1);
}

// ── F5：indexFormat 缺漏／錯值／非字串 → mismatch，提供 reload 而非 retry ──
for (const [label, patch] of [
  ['缺漏', (ix) => { delete ix.indexFormat; }],
  ['錯值', (ix) => { ix.indexFormat = 'columnar/0'; }],
  ['非字串', (ix) => { ix.indexFormat = 1; }],
  ['legacy 物件格式（新前端＋舊 index 混批）', (ix) => {
    for (const k of Object.keys(ix)) if (k !== 'dataVersion') delete ix[k];
    ix.drugs = [];
  }],
]) {
  test(`F5 indexFormat ${label} → 版本不符、搜尋不可用、提供重新整理`, async ({ page }) => {
    const errors = trackErrors(page);
    const data = buildData();
    const index = structuredClone(data.index);
    patch(index);
    await mockSite(page, { data, index });
    await page.goto('/?code=AC48092100');
    await expectUnavailable(page, { core: 'mismatch', kind: '', action: 'reload' });
    await expect(page.locator('#banners [data-action="retry-core"]')).toHaveCount(0);
    await expect(page.locator('#banners')).toContainText('資料已更新，請重新整理');
    // 無舊資料可見：詳細頁不得用任何已解析內容畫出摘要
    await expect(page.locator('#detail .metric')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

// ── F13：判定關鍵欄逐欄成對案例（注入最後一個 drug row／最後一個 window 列）──
const lastDrug = (ix) => ix.rows[ix.rows.length - 1];
function lastWindowRow(ix) {
  const n = ix.fields.length;
  for (let i = ix.rows.length - 1; i >= 0; i--) {
    const w = ix.rows[i][n];
    if (w.length) return { code: ix.rows[i][0], wr: w[w.length - 1] };
  }
  throw new Error('mock index 沒有任何 window 列');
}

const DRUG = [
  // [欄位, 非法值, 合法鄰近值]
  ['chName', 1, ''],
  ['enName', null, 'X'],
  ['ingredient', [], 'Y'],
  ['historyCount', '3', 0],
  ['priceChangeCount', true, 0],
  ['flags', 'questionMark', []],
];
const WIN = [
  ['priceState', 'bogus', 'missing'],          // 型別正確但不在值域
  ['priceState', 1, 'malformed'],
  ['eventType', 'bogus', 'unknown'],
  ['eventType', null, 'first_priced'],
  ['flags', 'conflict', []],                     // 字串 flags：.includes 變成子字串比對
  ['from', 20200101, '2020-01-01'],
  ['to', 5, null],
  ['pricedBefore', '10.5', null],
];

for (const [field, bad, good] of DRUG) {
  for (const [kind, value] of [['非法', bad], ['合法鄰近值', good]]) {
    test(`F13 drug ${field} ${kind}（${JSON.stringify(value)}）`, async ({ page }) => {
      const errors = trackErrors(page);
      const data = buildData();
      const row = lastDrug(data.index);
      const code = row[0];
      row[data.index.fields.indexOf(field)] = value;
      await mockSite(page, { data });
      await page.goto('/');
      if (kind === '非法') await expectUnavailable(page, { core: 'error', kind: 'invalid', action: 'retry-core' });
      else await expectSearchable(page, code);
      expect(errors).toEqual([]);
    });
  }
}

for (const [field, bad, good] of WIN) {
  for (const [kind, value] of [['非法', bad], ['合法鄰近值', good]]) {
    test(`F13 window ${field} ${kind}（${JSON.stringify(value)}）`, async ({ page }) => {
      const errors = trackErrors(page);
      const data = buildData();
      const { code, wr } = lastWindowRow(data.index);
      wr[data.index.windowFields.indexOf(field)] = value;
      await mockSite(page, { data });
      await page.goto('/');
      if (kind === '非法') await expectUnavailable(page, { core: 'error', kind: 'invalid', action: 'retry-core' });
      else await expectSearchable(page, code);
      expect(errors).toEqual([]);
    });
  }
}
