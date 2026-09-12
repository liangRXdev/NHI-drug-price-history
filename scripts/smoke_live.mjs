// 線上站 smoke check（部署後手動執行；非 CI）：子路徑、deep link、搜尋、SW、資料版本一致。
// 用法：node scripts/smoke_live.mjs [base-url]
import { chromium } from '@playwright/test';

const BASE = process.argv[2] || 'https://liangrxdev.github.io/NHI-drug-price-history/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const out = {};

await page.goto(`${BASE}?code=BC05037209`);
await page.locator('#detail .metric.key').waitFor({ timeout: 90_000 });
out.deepLinkCode = await page.locator('#detail .detail-head .code').textContent();
out.currentPrice = (await page.locator('#detail .metric.key .val').textContent()).trim();
out.upcoming = (await page.locator('#detail [data-upcoming]').textContent().catch(() => null))?.trim() ?? null;
out.banners = (await page.locator('#banners').textContent()).trim() || '(無)';
out.lastChecked = (await page.locator('#sourceInfo dd').first().textContent()).trim();

await page.locator('#backLink').click();
await page.locator('#q').fill('paroxetine');
await page.locator('.result').first().waitFor();
out.searchStatus = await page.locator('#searchStatus').textContent();
out.stoppedCardDash = (await page.locator('.result .r-price').allTextContents()).filter((t) => /—\s*元/.test(t)).length;

out.versions = await page.evaluate(async () => {
  const [m, i, s] = await Promise.all(['meta', 'drug_index', 'status'].map((f) => fetch(`data/${f}.json`, { cache: 'no-cache' }).then((r) => r.json())));
  return { meta: m.dataVersion.slice(7, 19), index: i.dataVersion.slice(7, 19), status: s.dataVersion.slice(7, 19) };
});
out.serviceWorker = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.scope : null;
});
out.errors = errors;
console.log(JSON.stringify(out, null, 2));
await browser.close();
