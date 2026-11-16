// spec-startup.md §8：S8 查無從嚴（D4.1）、S9 資料矛盾與到達順序無關（D4.3）。
import { test, expect } from '@playwright/test';
import { buildData } from './mock.mjs';
import {
  gatedSite, trackText, everSaid, watchMutations, mutations, routeTo, waitSearchReady, SETTLE_MS, TEXT,
} from './gate.mjs';

const APP_TITLE = '健保藥價歷史查詢';
const A = 'AC48092100';          // 片 AC48
const B = 'B009254100';          // 片 B009
const Z = 'ZZ00000000';          // 無匹配前綴
const detail = (page) => page.locator('#detail');
const banners = (page) => page.locator('#banners');
const MISSING_KEY = '分片中缺少此代號';
const NO_PREFIX = '分片清單中找不到此代號';
const BAD_SHARD = '分片內容不合法';

const shardCount = (site) => Object.keys(site.data.shards).reduce((n, p) => n + site.count(`shard:${p}`), 0) + site.count('shard:ZZ00');

// ── S8 反例：不得顯示「查無」，且錯誤分類正確 ────────────────────
test('S8 meta 永不回應＋合法代號 → 載入中，不是查無', async ({ page }) => {
  await trackText(page, ['查無']);
  const site = await gatedSite(page, { plan: { meta: 'pending' } });
  await page.goto(`/?code=${A}`);
  await site.waitCount('meta', 1);
  await expect(detail(page)).toContainText(TEXT.coreLoading);
  await page.waitForTimeout(SETTLE_MS);
  expect(await everSaid(page, '查無')).toBe(false);
  expect(shardCount(site)).toBe(0);
});

test('S8 meta 500 → 錯誤＋重試，不是查無', async ({ page }) => {
  await trackText(page, ['查無']);
  await gatedSite(page, { plan: { meta: 500 } });
  await page.goto(`/?code=${A}`);
  await expect(detail(page)).toContainText(TEXT.coreError);
  expect(await everSaid(page, '查無')).toBe(false);
});

test('S8 shard 在途（第 4a 列）→ 載入中，不含查無、不含錯誤文案', async ({ page }) => {
  await trackText(page, ['查無', TEXT.shardError, BAD_SHARD]);
  const site = await gatedSite(page, { plan: { 'shard:AC48': 'hold' } });
  await page.goto(`/?code=${A}`);
  await site.waitHeld('shard:AC48');
  await expect(detail(page)).toContainText(TEXT.shardLoading);
  await page.waitForTimeout(SETTLE_MS);
  for (const t of ['查無', TEXT.shardError, BAD_SHARD]) expect(await everSaid(page, t), t).toBe(false);
});

const entryOf = (data) => data.shards.AC48.drugs[A];
const SHARD_CASES = [
  // [名稱, 行為或資料改寫, 預期文字, 逾時設定]
  ['shard 500', { plan: 500 }, 'HTTP 500'],
  ['shard 非 JSON', { plan: 'corrupt' }, '內容不是有效的 JSON'],
  ['shard body 逾時', { plan: 'body-stall', timeouts: { shard: 700 } }, '連線逾時'],
  ['shard 整體為陣列', { plan: { json: [] } }, BAD_SHARD],
  ['shard 整體為 null', { plan: { json: null } }, BAD_SHARD],
  ['shardVersion 非字串', { mutate: (d) => { d.shards.AC48.shardVersion = 7; d.meta.shards.versions.AC48 = 'sha256:e2e-AC48'; } }, BAD_SHARD],
  ['drugs 非物件', { mutate: (d) => { d.shards.AC48.drugs = []; } }, BAD_SHARD],
  ['shard 版本不符', { mutate: (d) => { d.shards.AC48.shardVersion = 'sha256:stale'; } }, TEXT.coreMismatch],
  ['條目值為 null', { mutate: (d) => { d.shards.AC48.drugs[A] = null; } }, BAD_SHARD],
  ['條目 records 非陣列', { mutate: (d) => { entryOf(d).records = {}; } }, BAD_SHARD],
  ['條目 invalidRecords 非陣列', { mutate: (d) => { entryOf(d).invalidRecords = 'x'; } }, BAD_SHARD],
  ['條目 invalidRecords 缺', { mutate: (d) => { delete entryOf(d).invalidRecords; } }, BAD_SHARD],
  ['條目 meta 非物件且 metaVariants 非陣列', { mutate: (d) => { entryOf(d).meta = null; entryOf(d).metaVariants = {}; } }, BAD_SHARD],
];
for (const [name, { plan, mutate, timeouts }, text] of SHARD_CASES) {
  test(`S8 ${name} → 「${text}」，不是查無`, async ({ page }) => {
    await trackText(page, ['查無']);
    const data = buildData();
    if (mutate) mutate(data);
    const site = await gatedSite(page, { data, timeouts, plan: plan === undefined ? {} : { 'shard:AC48': plan } });
    await page.goto(`/?code=${A}`);
    await expect(detail(page).locator('.alert--error')).toContainText(text);
    await page.waitForTimeout(SETTLE_MS);                   // index 發布後也不得翻成查無
    await expect(detail(page).locator('.alert--error')).toContainText(text);
    expect(await everSaid(page, '查無')).toBe(false);
    expect(site.count('shard:AC48')).toBe(1);
  });
}

const MAP_CASES = [
  ['files 為空', (s) => { s.files = []; s.versions = {}; }],
  ['files 成員非字串', (s) => { s.files.push(7); s.versions[7] = 'v'; }],
  ['files 成員為空字串', (s) => { s.files.push(''); s.versions[''] = 'v'; }],
  ['files 成員重複', (s) => { s.files.push('AC48'); s.versions.EXTRA = 'v'; }],
  ['versions 缺 files 的成員', (s) => { delete s.versions.B009; }],
  ['versions 多出 files 沒有的 key', (s) => { s.versions.EXTRA = 'v'; }],
  ['version 值為空字串', (s) => { s.versions.AC48 = ''; }],
  ['version 值非字串', (s) => { s.versions.AC48 = 7; }],
];
for (const [name, mutate] of MAP_CASES) {
  test(`S8 shard map 不合法（${name}）→ meta error，不是查無、不發 shard`, async ({ page }) => {
    await trackText(page, ['查無']);
    const data = buildData();
    mutate(data.meta.shards);
    const site = await gatedSite(page, { data });
    await page.goto(`/?code=${Z}`);                          // 若 map 被當真，這個代號會落到「無匹配前綴 → 查無」
    await expect(detail(page)).toContainText('meta.json 內容不合法');
    await expect(detail(page).getByRole('button', { name: '重試' })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    expect(await everSaid(page, '查無')).toBe(false);
    expect(shardCount(site)).toBe(0);
  });
}

// ── S8 正例 ─────────────────────────────────────────────────────
for (const [name, url] of [['空碼', '/?code='], ['含非法字元', '/?code=AC48-0921'], ['只有空白', '/?code=%20%20']]) {
  for (const metaState of ['ready', 'pending']) {
    test(`S8 ${name}｜meta ${metaState} → 查無此代號，shard 請求數 0`, async ({ page }) => {
      const site = await gatedSite(page, { plan: metaState === 'pending' ? { meta: 'pending' } : {} });
      await page.goto(url);
      await expect(detail(page)).toContainText(TEXT.notFound);
      await expect(page).toHaveTitle(`查無此代號 — ${APP_TITLE}`);
      await page.waitForTimeout(SETTLE_MS);
      await expect(detail(page)).toContainText(TEXT.notFound);
      expect(shardCount(site)).toBe(0);
    });
  }
}

test('S8 前綴不在清單（index 也不含）→ 查無此代號，shard 請求數 0', async ({ page }) => {
  const site = await gatedSite(page);
  await page.goto(`/?code=${Z}`);
  await expect(detail(page)).toContainText(TEXT.notFound);
  await waitSearchReady(page);
  await expect(detail(page)).toContainText(TEXT.notFound);
  expect(shardCount(site)).toBe(0);
});

test('S8 合法英數但非 10 碼、存在於 shard 的合成代號 → 完整詳情（不以長度短路）', async ({ page }) => {
  const data = buildData();
  data.shards.AC48.drugs.AC4809 = structuredClone(data.shards.AC48.drugs[A]);
  await gatedSite(page, { data });
  await page.goto('/?code=AC4809');
  await expect(detail(page).locator('.detail-head .code')).toHaveText('AC4809');
  await expect(detail(page).locator('table.history tbody tr')).toHaveCount(8);
  await expect(detail(page).locator('.metric.key .val')).toContainText('4.12');
});

// ── S9 資料矛盾（D4.3）──────────────────────────────────────────
/** 兩種矛盾：shard 缺 own key（第 8 列）、無匹配前綴（第 4 列）。index 皆含該代號。 */
const CONFLICTS = [
  { kind: '缺 key', code: A, text: MISSING_KEY, make(data) { delete data.shards.AC48.drugs[A]; return data; } },
  {
    kind: '無匹配前綴', code: Z, text: NO_PREFIX,
    make(data) { data.index.drugs.push({ ...data.index.drugs.find((d) => d.code === A), code: Z, chName: '無片品項' }); return data; },
  },
];
const withoutInIndex = (data, code) => { data.index.drugs = data.index.drugs.filter((d) => d.code !== code); return data; };
const staleIndex = (data) => ({ json: { ...data.index, dataVersion: 'sha256:other-batch' } });

for (const c of CONFLICTS) {
  test(`S9(a) ${c.kind}：先查無，index 發布且含該代號 → 改為「${c.text}」`, async ({ page }) => {
    const site = await gatedSite(page, { data: c.make(buildData()), plan: { index: 'hold' } });
    await page.goto(`/?code=${c.code}`);
    await expect(detail(page)).toContainText(TEXT.notFound);
    await site.release('index');
    await expect(detail(page).locator('.alert--error')).toContainText(c.text);
    await expect(detail(page).getByRole('button', { name: '重試' })).toBeVisible();
    await expect(detail(page)).not.toContainText(TEXT.notFound);
  });

  test(`S9(b) ${c.kind}：index 先發布 → 直接顯示「${c.text}」，過程中不得出現查無`, async ({ page }) => {
    await trackText(page, ['查無']);
    await gatedSite(page, { data: c.make(buildData()) });
    await page.goto('/');
    await waitSearchReady(page);
    await routeTo(page, `?code=${c.code}`);
    await expect(detail(page).locator('.alert--error')).toContainText(c.text);
    await page.waitForTimeout(SETTLE_MS);
    expect(await everSaid(page, '查無')).toBe(false);
  });

  test(`S9(c) ${c.kind}：index 發布且不含該代號 → 維持查無`, async ({ page }) => {
    await gatedSite(page, { data: withoutInIndex(c.make(buildData()), c.code) });
    await page.goto(`/?code=${c.code}`);
    await expect(detail(page)).toContainText(TEXT.notFound);
    await waitSearchReady(page);
    await page.waitForTimeout(SETTLE_MS);
    await expect(detail(page)).toContainText(TEXT.notFound);
    await expect(detail(page).locator('.alert--error')).toHaveCount(0);
  });

  test(`S9(e) ${c.kind}：index 為 mismatch 且其內容含該代號 → 維持查無`, async ({ page }) => {
    const data = c.make(buildData());
    await gatedSite(page, { data, plan: { index: staleIndex(data) } });
    await page.goto(`/?code=${c.code}`);
    await expect(detail(page)).toContainText(TEXT.notFound);
    await expect(banners(page)).toContainText(TEXT.indexMismatch);
    await page.waitForTimeout(SETTLE_MS);
    await expect(detail(page)).toContainText(TEXT.notFound);
    await expect(detail(page)).not.toContainText(c.text);
  });

  test(`S9(f)(g) 比較頁 ${c.kind}：index 發布前為 missing，發布後該代號改為 error，另一代號不變`, async ({ page }) => {
    const site = await gatedSite(page, { data: c.make(buildData()), plan: { index: 'hold' } });
    await page.goto(`/?codes=${c.code},${B}`);
    const row = page.locator(`.compare-code[data-code="${c.code}"]`);
    await expect(row).toHaveAttribute('data-status', 'missing');
    await expect(page.locator(`.cmp-line[data-code="${B}"]`).first()).toBeAttached();   // SVG 水平線的外框高度為 0，不能用 toBeVisible
    const linesB = await page.locator(`.cmp-line[data-code="${B}"]`).count();
    const columnB = await page.locator('.cmp-summary tbody tr td:nth-child(3)').allTextContents();
    const eventsB = await page.locator('.cmp-events tbody tr').count();

    await site.release('index');
    await expect(row).toHaveAttribute('data-status', 'error');
    await expect(page.locator('#compareBanner')).toContainText(c.code);
    await expect(page.locator('#compareView')).toContainText(c.text);
    expect(await page.locator(`.cmp-line[data-code="${B}"]`).count()).toBe(linesB);
    expect(await page.locator('.cmp-summary tbody tr td:nth-child(3)').allTextContents()).toEqual(columnB);
    expect(await page.locator('.cmp-events tbody tr').count()).toBe(eventsB);
    await expect(page.locator(`.compare-code[data-code="${B}"]`)).toHaveAttribute('data-status', 'ok');
  });

  test(`S9(c) 比較頁 ${c.kind}：index 發布且不含該代號 → 維持 missing`, async ({ page }) => {
    await gatedSite(page, { data: withoutInIndex(c.make(buildData()), c.code) });
    await page.goto(`/?codes=${c.code},${B}`);
    const row = page.locator(`.compare-code[data-code="${c.code}"]`);
    await expect(row).toHaveAttribute('data-status', 'missing');
    await waitSearchReady(page);
    await page.waitForTimeout(SETTLE_MS);
    await expect(row).toHaveAttribute('data-status', 'missing');
  });
}

test('S9(d) A 查無後導覽到 B，index 才發布且含 A → B 的畫面與標題不變', async ({ page }) => {
  const c = CONFLICTS[0];
  const site = await gatedSite(page, { data: c.make(buildData()), plan: { index: 'hold' } });
  await page.goto(`/?code=${A}`);
  await expect(detail(page)).toContainText(TEXT.notFound);
  await routeTo(page, `?code=${B}`);
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  const title = await page.title();
  await watchMutations(page, '#detail');
  await site.release('index');
  await waitSearchReady(page);
  await page.waitForTimeout(SETTLE_MS);
  expect(await mutations(page, '#detail')).toEqual([]);
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  expect(await page.title()).toBe(title);
  await expect(detail(page)).not.toContainText(MISSING_KEY);
});

test('S9(f) 比較頁：一個代號的條目結構壞 → 該代號為「分片內容不合法」，不是 missing', async ({ page }) => {
  const data = buildData();
  data.shards.AC48.drugs[A].records = {};
  await gatedSite(page, { data });
  await page.goto(`/?codes=${A},${B}`);
  await expect(page.locator(`.compare-code[data-code="${A}"]`)).toHaveAttribute('data-status', 'error');
  await expect(page.locator('#compareBanner')).toContainText(A);
  await expect(page.locator(`.compare-code[data-code="${B}"]`)).toHaveAttribute('data-status', 'ok');
});

test('S9(h) A 查無 → 離開 → 返回 A 時 index 已發布且含 A → 直接顯示錯誤', async ({ page }) => {
  const c = CONFLICTS[0];
  const site = await gatedSite(page, { data: c.make(buildData()), plan: { index: 'hold' } });
  await page.goto(`/?code=${A}`);
  await expect(detail(page)).toContainText(TEXT.notFound);
  await routeTo(page, `?code=${B}`);
  await expect(detail(page).locator('.detail-head .code')).toHaveText(B);
  await site.release('index');
  await waitSearchReady(page);
  await page.evaluate(() => {
    window.__sawNotFound = false;
    new MutationObserver(() => {
      if (document.querySelector('#detail').innerText.includes('查無')) window.__sawNotFound = true;
    }).observe(document.querySelector('#detail'), { subtree: true, childList: true, characterData: true });
  });
  await routeTo(page, `?code=${A}`);
  await expect(detail(page).locator('.alert--error')).toContainText(MISSING_KEY);
  expect(await page.evaluate(() => window.__sawNotFound), '返回過程中出現查無').toBe(false);
});

// S9(i)：規格寫「shard 第一次缺 key → retry-shard 取得含該 key 的 shard → index 才發布」。
// 但依 D4.1 第 8 列，index 未發布時缺 key 顯示的是「查無此代號」（沒有 retry-shard 按鈕）；
// retry-shard 只在 index 已發布後的錯誤畫面出現。此情境在現行規格下無法到達，待規格釐清。
test.fixme('S9(i) shard 第一次缺 key → retry-shard 成功 → index 才發布 → 詳情維持、零 mutation', async () => {});
