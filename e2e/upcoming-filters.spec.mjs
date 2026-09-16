// U8（D／T 落差的日期語意）與 U9（篩選、排序、URL 契約）。
// 母體以合成資料組成：§4.1.1 的 8 個 type 值有 6 個在真實資料裡零實例。
import { test, expect } from '@playwright/test';
import { buildData, mockSite, upcomingItem, upcomingPayload } from './mock.mjs';

const rows = (page) => page.locator('.upcoming-row');
const codes = (page) => rows(page).locator('.r-code');
const status = (page) => page.locator('#upcomingStatus');

const priced = (o) => upcomingItem({ priceState: 'priced', everPriced: true, previousState: 'priced', ...o });

// §4.1.1 的 8 個 type：每個都有正例；序 4／7（0 元、暫停但此前無有價）必須落在
// first_priced，不得落在 terminated／suspended
const ITEMS = [
  priced({ code: 'A000000001', chName: '甲降藥', ingredient: 'ALPHAINE', atcCode: 'A01AA01', effectiveDate: '2026-10-01', price: 8, rawPrice: '8.00', previousPrice: 10, pricedBefore: 10, eventType: 'decrease', absoluteChange: -2, percentChange: -20 }),
  priced({ code: 'B000000002', chName: '乙升藥', ingredient: 'BETAINE', atcCode: 'B01AB01', effectiveDate: '2026-10-01', price: 7.9, rawPrice: '7.90', previousPrice: 6.9, pricedBefore: 6.9, eventType: 'increase', absoluteChange: 1, percentChange: 14.49 }),
  upcomingItem({ code: 'C000000003', chName: '丙終止藥', ingredient: 'GAMMAINE', atcCode: 'C09DX01', effectiveDate: '2026-11-01', eventType: 'terminated', previousState: 'priced', everPriced: true, pricedBefore: 245, previousPrice: 245 }),
  upcomingItem({ code: 'K000000011', chName: '庚終止藥', ingredient: 'KAPPAINE', atcCode: 'D02AA01', effectiveDate: '2026-11-01', eventType: 'terminated', previousState: 'priced', everPriced: true, pricedBefore: 12, previousPrice: 12 }),
  upcomingItem({ code: 'D000000004', chName: '丁暫停藥', ingredient: 'DELTAINE', atcCode: 'D01AA01', effectiveDate: '2026-11-01', priceState: 'suspended', rawPrice: '-', eventType: 'suspended', previousState: 'priced', everPriced: true, pricedBefore: 18, previousPrice: 18 }),
  priced({ code: 'E000000005', chName: '戊恢復藥', ingredient: 'EPSILONINE', atcCode: 'A01AA02', effectiveDate: '2026-12-01', price: 22.9, rawPrice: '22.90', previousState: 'terminated', previousPrice: 29.8, pricedBefore: 29.8, eventType: 'relisted', absoluteChange: -6.9, percentChange: -23.15, crossesStop: true }),
  priced({ code: 'F000000006', chName: '己首價藥', ingredient: 'ZETAINE', atcCode: 'B01AB02', effectiveDate: '2026-12-01', price: 12.5, rawPrice: '12.50', everPriced: false, pricedBefore: null, previousState: null, previousPrice: null, eventType: 'first_priced' }),
  upcomingItem({ code: 'G000000007', chName: '辛零元藥', ingredient: 'ETAINE', atcCode: 'C09DX02', effectiveDate: '2026-12-01', eventType: 'initial' }),
  priced({ code: 'H000000008', chName: '壬續期藥', ingredient: 'THETAINE', atcCode: 'D01AA02', effectiveDate: '2027-01-01', price: 94, rawPrice: '94.00', previousPrice: 94, pricedBefore: 94, eventType: 'unchanged' }),
  priced({ code: 'I000000009', chName: '癸異常藥', ingredient: 'IOTAINE', atcCode: 'A01AA03', effectiveDate: '2027-01-01', price: 30, rawPrice: '30.00', previousPrice: 20, pricedBefore: 20, eventType: 'unknown', percentChange: 50 }),
];

const withItems = (items = ITEMS, buildDate = '2026-09-11') => {
  const data = buildData();
  data.upcoming = upcomingPayload(items, buildDate);
  return data;
};

const open = async (page, { url = '/?view=upcoming', today = '2026-09-11', items, buildDate, controls = true, ...rest } = {}) => {
  await mockSite(page, { today, data: withItems(items, buildDate), ...rest });
  await page.goto(url);
  // 空清單時沒有可篩選的內容，控制項一併收起
  await expect(page.locator('#upcomingControls')).toBeVisible({ visible: controls });
};

const shownCodes = async (page) => (await codes(page).allTextContents()).map((s) => s.trim());

// ── U9 篩選：結果必須精確等於交集 ───────────────────────────────
test('U9 type × atc 四類：皆符合／只符 type／只符 atc／皆不符', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&type=terminated&atc=C' });
  expect(await shownCodes(page)).toEqual(['C000000003']);          // 交集

  await page.goto('/?view=upcoming&type=terminated');
  expect(await shownCodes(page)).toEqual(['C000000003', 'K000000011']);

  await page.goto('/?view=upcoming&atc=C');
  expect(await shownCodes(page)).toEqual(['C000000003', 'G000000007']);

  await page.goto('/?view=upcoming&type=terminated&atc=A');
  expect(await shownCodes(page)).toEqual([]);
  await expect(status(page)).toHaveText('目前篩選條件下沒有符合的公告（清單共 10 筆）。');
});

test('U9 序 4 的 0 元列屬 first_priced，不得被「終止支付」篩選撈到', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&type=first_priced' });
  expect(await shownCodes(page)).toEqual(['F000000006', 'G000000007']);
  await page.goto('/?view=upcoming&type=terminated');
  expect(await shownCodes(page)).not.toContain('G000000007');
});

for (const [type, expected] of [
  ['all', ['A000000001', 'B000000002', 'C000000003', 'K000000011', 'D000000004', 'E000000005', 'F000000006', 'G000000007', 'H000000008', 'I000000009']],
  ['decrease', ['A000000001']],
  ['increase', ['B000000002']],
  ['terminated', ['C000000003', 'K000000011']],
  ['suspended', ['D000000004']],
  ['relisted', ['E000000005']],
  ['first_priced', ['F000000006', 'G000000007']],
  ['unchanged', ['H000000008']],
  ['other', ['I000000009']],
]) {
  test(`U9 type=${type} 精確等於預期集合`, async ({ page }) => {
    await open(page, { url: `/?view=upcoming&type=${type}` });
    expect(await shownCodes(page)).toEqual(expected);
  });
}

test('U9 關鍵字比對代號／中文名／英文名／成分，不分大小寫', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&q=gammaine' });
  expect(await shownCodes(page)).toEqual(['C000000003']);
  await page.goto('/?view=upcoming&q=終止');
  expect(await shownCodes(page)).toEqual(['C000000003', 'K000000011']);
  await page.goto('/?view=upcoming&q=B00000000');
  expect(await shownCodes(page)).toEqual(['B000000002']);
});

test('U9 date 是精確批次，不是區間起點', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&date=2026-11-01' });
  expect(await shownCodes(page)).toEqual(['C000000003', 'K000000011', 'D000000004']);
  await expect(page.locator('.upcoming-group h3')).toHaveText('2026-11-01 起（3 品項）');
});

test('U9 無效值一律回預設且不報錯', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&type=bogus&atc=Z&date=2026-10-15&sort=weird&q=' });
  expect(await shownCodes(page)).toHaveLength(10);
  await expect(page.locator('#upType')).toHaveValue('all');
  await expect(page.locator('#upAtc')).toHaveValue('');
  await expect(page.locator('#upDate')).toHaveValue('');
  await expect(page.locator('#upSort')).toHaveValue('date_asc');
  await expect(page.locator('#upcomingBanner .alert--error')).toHaveCount(0);
});

test('U9 q 超過 100 字截斷', async ({ page }) => {
  const long = `${'甲'.repeat(120)}`;
  await open(page, { url: `/?view=upcoming&q=${encodeURIComponent(long)}` });
  await expect(page.locator('#upQ')).toHaveValue('甲'.repeat(100));
});

// ── U9 URL 契約：重整、分享、返回、組合 ──────────────────────────
test('U9 操作控制項會寫進 URL，重整後維持', async ({ page }) => {
  await open(page);
  await page.locator('#upType').selectOption('terminated');
  await page.locator('#upAtc').selectOption('C');
  await expect(page).toHaveURL(/type=terminated/);
  await expect(page).toHaveURL(/atc=C/);
  expect(await shownCodes(page)).toEqual(['C000000003']);

  await page.reload();
  await expect(page.locator('#upType')).toHaveValue('terminated');
  expect(await shownCodes(page)).toEqual(['C000000003']);
});

test('U9 篩選狀態不得寫入 localStorage', async ({ page }) => {
  await open(page);
  await page.locator('#upType').selectOption('terminated');
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => /type|upcoming|atc|sort/i.test(k))).toEqual([]);
});

test('U9 返回：從搜尋進入預告並篩選後，上一頁回到搜尋', async ({ page }) => {
  await mockSite(page, { today: '2026-09-11', data: withItems() });
  await page.goto('/');
  await page.locator('#upcomingBadge').click();
  await page.locator('#upType').selectOption('increase');
  expect(await shownCodes(page)).toEqual(['B000000002']);
  await page.goBack();
  await expect(page.locator('#searchView')).toBeVisible();
  await expect(page.locator('#upcomingView')).toBeHidden();
});

test('U9 組合：type＋atc＋q＋date 同時生效（AND）', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&type=terminated&atc=C&date=2026-11-01&q=丙' });
  expect(await shownCodes(page)).toEqual(['C000000003']);
  await page.goto('/?view=upcoming&type=terminated&atc=C&date=2026-11-01&q=庚');
  expect(await shownCodes(page)).toEqual([]);
});

// ── U9 排序 ─────────────────────────────────────────────────────
test('U9 幅度 desc：取絕對值、無 percentChange 置底、取消分組', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&sort=change_desc' });
  await expect(page.locator('.upcoming-group')).toHaveCount(0);
  const order = await shownCodes(page);
  expect(order.slice(0, 5)).toEqual([
    'I000000009',      // 50%
    'E000000005',      // −23.15%
    'A000000001',      // −20%
    'B000000002',      // +14.49%
    'C000000003',      // 以下皆無 percentChange：依生效日 asc → 代號 asc
  ]);
  expect(order.slice(5)).toEqual(['D000000004', 'K000000011', 'F000000006', 'G000000007', 'H000000008']);
});

test('U9 日期排序維持分組；desc 由遠到近', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&sort=date_desc' });
  await expect(page.locator('.upcoming-group h3')).toHaveText([
    '2027-01-01 起（2 品項）', '2026-12-01 起（3 品項）',
    '2026-11-01 起（3 品項）', '2026-10-01 起（2 品項）',
  ]);
});

test('U13 分組標題的品項數等於該批次實際呈現列數', async ({ page }) => {
  await open(page, { url: '/?view=upcoming&type=terminated' });
  const groups = page.locator('.upcoming-group');
  await expect(groups).toHaveCount(1);
  await expect(groups.locator('h3')).toHaveText('2026-11-01 起（2 品項）');
  await expect(groups.locator('.upcoming-row')).toHaveCount(2);
});

// ── U8 D 與 T 的落差 ────────────────────────────────────────────
const LABEL = (page, code) => rows(page).filter({ has: page.locator(`.r-code:text-is("${code}")`) });

const ALL_CODES = ITEMS.map((it) => it.code);
const expiredCodes = (page) => page.locator('.upcoming-row[data-expired] .r-code').allTextContents();

// 完整列集合每次都要對，且每一列的到期狀態都要對：只驗列數或只驗指名的那一列，
// 「所有列都標已生效」或「只留指名那列」都會綠
for (const [today, expired] of [
  ['2026-10-31', ['A000000001', 'B000000002']],
  ['2026-11-01', ['A000000001', 'B000000002', 'C000000003', 'K000000011', 'D000000004']],
  ['2026-11-02', ['A000000001', 'B000000002', 'C000000003', 'K000000011', 'D000000004']],
]) {
  test(`U8 生效日前一天／當天／後一天 @ ${today}`, async ({ page }) => {
    await open(page, { today });
    expect(await shownCodes(page)).toEqual(ALL_CODES);             // 完整列集合不變
    expect((await expiredCodes(page)).map((s) => s.trim())).toEqual(expired);
    // 價格與事件不隨 T 改變
    const row = LABEL(page, 'C000000003');
    await expect(row.locator('[data-label]')).toHaveText('終止支付');
    await expect(row.locator('[data-sub]')).toHaveText('2026-11-01 起；終止前 245.00 元');
  });
}

test('U15 只有未來列的代號：描述欄位在畫面上顯示「—」', async ({ page }) => {
  const bare = upcomingItem({
    code: 'N000000001', chName: null, enName: null, ingredient: null, strength: null,
    strengthUnit: null, dosageForm: null, atcCode: null, manufacturer: null,
    effectiveDate: '2026-12-01',
  });
  await open(page, { items: [bare] });
  const row = rows(page).first();
  await expect(row.locator('.r-name')).toHaveText('—');
  await expect(row.locator('.r-en')).toHaveText('—');
  await expect(row.locator('.r-sub')).toHaveCount(0);              // 三個欄位皆空 → 不畫這一行
  await expect(row.locator('.r-meta')).toContainText('ATC —');
  await expect(row.locator('[data-label]')).toHaveText('健保支付價 0 元');
});

test('U8 混合：已到期與未到期同時存在，徽章只算未生效', async ({ page }) => {
  await open(page, { today: '2026-11-15' });
  await expect(rows(page).locator('[data-expired-tag]')).toHaveCount(5);
  await expect(page.locator('#upcomingBadge')).toHaveText('預告 5');
  await expect(status(page)).toContainText('其中 5 筆尚未生效');
});

test('U8 全數到期：仍列出全部，不得顯示為空白頁', async ({ page }) => {
  await open(page, { today: '2027-06-01' });
  expect(await shownCodes(page)).toHaveLength(10);
  await expect(status(page)).toContainText('目前資料中已無未生效的公告');
  await expect(page.locator('#upcomingBadge')).toHaveText('預告 0');
});

test('U8 真正空清單與全數到期是兩種畫面', async ({ page }) => {
  await open(page, { items: [], today: '2026-09-11', controls: false });
  await expect(status(page)).toHaveText('目前資料中無未生效的公告。');
  await expect(rows(page)).toHaveCount(0);
});

test('U8 T < D：加註裝置日期早於資料產生日', async ({ page }) => {
  await open(page, { today: '2026-09-01', buildDate: '2026-09-11' });
  await expect(page.locator('#upcomingBanner .alert--warn'))
    .toContainText('本站資料產生於 2026-09-11，晚於你的裝置日期');
  expect(await shownCodes(page)).toHaveLength(10);
});

test('U8 最後檢查日很新時不得壓掉到期提示', async ({ page }) => {
  await open(page, { today: '2026-11-02' });                      // status 為 1 天前
  await expect(page.locator('#banners [data-stale]')).toHaveCount(0);
  await expect(rows(page).locator('[data-expired-tag]')).toHaveCount(5);   // 10-01 兩筆＋11-01 三筆
});
