// 前端驗收：plan.md §5 C1、C3–C8、E3–E5（DOM、viewport、route mock）。
import { test, expect } from '@playwright/test';
import { buildData, mockSite, statusDaysAgo } from './mock.mjs';

const detail = (page) => page.locator('#detail');
// 先清空並等「請輸入」提示出現，再輸入：避免上一次查詢的結果讓本次斷言假通過（codex T4）
const search = async (page, q) => {
  const input = page.locator('#q');
  await expect(input).toBeEnabled();
  await input.fill('');
  await expect(page.locator('#searchStatus')).toHaveText(/請輸入/);
  await expect(page.locator('.result')).toHaveCount(0);
  await input.fill(q);
  await expect(page.locator('#searchStatus')).not.toHaveText(/載入中|請輸入/);
};

// ── C1 現行價判定：前一天／當天／後一天 × 搜尋卡與詳細頁 ──────────────
for (const [today, card, cur, upcoming] of [
  ['2026-09-30', '245.00', '245.00', '2026-10-01 起終止支付'],
  ['2026-10-01', '已終止支付（終止前 245.00 元）', '已終止支付（終止前 245.00 元）', null],
  ['2026-10-02', '已終止支付（終止前 245.00 元）', '已終止支付（終止前 245.00 元）', null],
]) {
  test(`C1 BC05037209 預告終止 @ ${today}`, async ({ page }) => {
    await mockSite(page, { today });
    await page.goto('/');
    await search(page, 'BC05037209');
    const first = page.locator('.result').first();
    await expect(first).toContainText(card);
    if (upcoming) await expect(first.locator('.tag.warn')).toContainText(upcoming);
    else await expect(first).not.toContainText('預告');

    await first.click();
    const key = detail(page).locator('.metric.key');
    await expect(key).toContainText(cur);
    if (upcoming) await expect(key.locator('[data-upcoming]')).toContainText(upcoming);
    else await expect(key).toContainText('無已公告的預告異動');
    await expect(detail(page)).toContainText(`參考日期：${today}`);
  });
}

test('C1 AB47689100 預告調價：前一天顯示現價與調整標籤、當天為新價', async ({ page }) => {
  await mockSite(page, { today: '2026-09-30' });
  await page.goto('/?code=AB47689100');
  const key = detail(page).locator('.metric.key');
  await expect(key).toContainText('6.90');
  await expect(key).toContainText('2026-10-01 起調整為 7.90 元（+14.49%）');
});

test('C1 AB47689100 當天', async ({ page }) => {
  await mockSite(page, { today: '2026-10-01' });
  await page.goto('/?code=AB47689100');
  await expect(detail(page).locator('.metric.key .val')).toContainText('7.90');
});

test('C1 window 耗盡：搜尋卡顯示「需更新」且無確定價格；詳細頁仍由 history 判定', async ({ page }) => {
  // AC48867100 的 window 只有 [2026-04-01, null]；把它改成有迄日，模擬 build 後又跨過下一筆
  const data = buildData();
  const w = data.index.drugs.find((d) => d.code === 'AC48867100').window[0];
  w.to = '2026-09-30';
  await mockSite(page, { today: '2026-10-05', data });
  await page.goto('/');
  await search(page, 'AC48867100');
  const first = page.locator('.result').first();
  await expect(first).toContainText('需更新，請開啟詳細頁');
  await expect(first.locator('.r-price .val')).toHaveCount(0);
  await first.click();                                          // 詳細頁仍由完整 history 判定（shard 未改）
  await expect(detail(page).locator('.metric.key .val')).toContainText('12.50');
});

// ── C3 過期警示 ─────────────────────────────────────────────────
for (const [days, level] of [[21, null], [22, 'yellow'], [45, 'yellow'], [46, 'red']]) {
  test(`C3 最後檢查 ${days} 天前 → ${level || '無警示'}`, async ({ page }) => {
    await mockSite(page, { today: '2026-09-11', status: statusDaysAgo('2026-09-11', days) });
    await page.goto('/?code=AC48092100');
    await expect(detail(page).locator('.metric.key')).toBeVisible();
    const banner = page.locator('#banners [data-stale]');
    if (level) await expect(banner).toHaveAttribute('data-stale', level);
    else await expect(banner).toHaveCount(0);
    await expect(detail(page).locator('[data-stale-note]')).toHaveCount(level === 'red' ? 1 : 0);
  });
}

for (const status of ['404', 'corrupt', { lastCheckedAt: 'yesterday' }]) {
  test(`C3 status 無法使用（${JSON.stringify(status)}）→ 紅`, async ({ page }) => {
    await mockSite(page, { status });
    await page.goto('/?code=AC48092100');
    await expect(page.locator('#banners [data-stale]')).toHaveAttribute('data-stale', 'red');
    await expect(detail(page).locator('[data-stale-note]')).toHaveCount(1);
    await expect(page.locator('#sourceInfo')).toContainText('無法取得');
  });
}

// ── C4 搜尋 ─────────────────────────────────────────────────────
test('C4 代號完全相符排第一（> 50 筆候選）；最多 render 50 筆', async ({ page }) => {
  await mockSite(page);
  await page.goto('/');
  await search(page, 'AC48092100');
  await expect(page.locator('.result').first()).toHaveAttribute('data-code', 'AC48092100');
  await search(page, 'ac4809');
  await expect(page.locator('#searchStatus')).toContainText('僅顯示前 50 筆');
  await expect(page.locator('.result')).toHaveCount(50);
  await expect(page.locator('.result[data-code="AC48092100"]')).toHaveCount(1);
});

test('C4 中文／英文／成分；終止品項不排除；空白與不存在', async ({ page }) => {
  await mockSite(page);
  await page.goto('/');
  for (const q of ['撫緒', 'CAREMOD'.toLowerCase(), 'paroxetine']) {
    await search(page, q);
    await expect(page.locator('.result[data-code="AC48092100"]'), q).toHaveCount(1);
  }
  await search(page, 'AC48845100');            // 現行已終止
  await expect(page.locator('.result').first()).toContainText('已終止支付');
  await page.locator('#q').fill('   ');
  await expect(page.locator('#searchStatus')).toHaveText(/請輸入/);
  await expect(page.locator('.result')).toHaveCount(0);
  await search(page, 'no-such-drug-xyz');
  await expect(page.locator('#searchStatus')).toContainText('查無符合');
});

// ── C5 deep link ────────────────────────────────────────────────
for (const [code, name, price] of [['AC48092100', '撫緒', /^\d+\.\d{2}\s*元$/], ['B009254100', '', /已終止支付（終止前 4\.81 元）/]]) {
  test(`C5 ?code=${code} 直接開啟與重新整理`, async ({ page }) => {
    const { data } = await mockSite(page);
    await page.goto(`/?code=${code}`);
    const records = data.shards[code.slice(0, 4)].drugs[code].records;
    const last = records[records.length - 1];
    for (let i = 0; i < 2; i++) {
      await expect(detail(page).locator('.detail-head .code')).toHaveText(code);
      if (name) await expect(detail(page).locator('.detail-head h2')).toContainText(name);
      // 現行價須與 URL 代號的 history 相符（codex T8）
      await expect(detail(page).locator('.metric.key .val')).toHaveText(price);
      if (last.priceState === 'priced') await expect(detail(page).locator('.metric.key .val')).toContainText(last.rawPrice);
      await expect(detail(page).locator('tr[data-kind="record"]')).toHaveCount(records.length);
      await expect(detail(page).locator('tr[data-kind="record"]').first()).toContainText(last.from);
      await expect(page).toHaveTitle(new RegExp(code));
      await page.reload();
    }
  });
}

test('C5 index 載入中不顯示「查無」；?code=ZZZ →「查無此代號」且不殘留前一品項', async ({ page }) => {
  await mockSite(page, { indexDelay: 1500 });
  await page.goto('/?code=AC48092100');
  await expect(detail(page)).toContainText('資料載入中');
  await expect(page.locator('body')).not.toContainText('查無');
  await expect(detail(page).locator('.detail-head .code')).toHaveText('AC48092100');

  // 站內切換（不重新載入頁面）到不存在的代號
  await page.evaluate(() => { history.pushState(null, '', '?code=ZZZ'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(detail(page)).toContainText('查無此代號');
  await expect(detail(page)).not.toContainText('AC48092100');
  await expect(detail(page).locator('.metric')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/AC48092100/);
});

test('C7 站內從 A 切到 B、B 載入期間：不殘留 A 的內容', async ({ page }) => {
  await mockSite(page, {
    shard: async (prefix, attempt, route, data) => {
      if (prefix !== 'B009') return false;
      await new Promise((r) => setTimeout(r, 1500));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.shards.B009) })
        .catch(() => {});
    },
  });
  await page.goto('/?code=AC48092100');
  await expect(detail(page).locator('.metric.key')).toBeVisible();
  await page.evaluate(() => { history.pushState(null, '', '?code=B009254100'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(detail(page)).toContainText('載入');
  await expect(detail(page)).not.toContainText('AC48092100');
  await expect(detail(page).locator('.metric')).toHaveCount(0);
  await expect(detail(page).locator('.detail-head .code')).toHaveText('B009254100');
});

test('C7 站內從 A 切到 shard 失敗的 B：不殘留 A 的內容', async ({ page }) => {
  await mockSite(page, {
    shard: (prefix, attempt, route) => (prefix === 'B009' ? route.fulfill({ status: 404, body: '' }) : false),
  });
  await page.goto('/?code=AC48092100');
  await expect(detail(page).locator('.metric.key')).toBeVisible();
  await page.evaluate(() => { history.pushState(null, '', '?code=B009254100'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(detail(page).locator('.alert--error')).toContainText('B009254100');
  await expect(detail(page)).not.toContainText('AC48092100');
  await expect(detail(page).locator('.metric')).toHaveCount(0);
});

test('C5 專案子路徑 /NHI-drug-price-history/ 下有效', async ({ page }) => {
  await mockSite(page);
  await page.goto('/NHI-drug-price-history/?code=BC23981100');
  await expect(detail(page).locator('.detail-head .code')).toHaveText('BC23981100');
  await expect(detail(page).locator('.metric.key')).toContainText('暫停支付（來源標示 -）');
});

test('C5 由搜尋進入詳細頁再按返回 → 回到搜尋結果', async ({ page }) => {
  await mockSite(page);
  await page.goto('/');
  await search(page, '撫緒');
  await page.locator('.result').first().click();
  await expect(page).toHaveURL(/\?code=AC48092100/);
  await page.locator('#backLink').click();
  await expect(page.locator('#searchView')).toBeVisible();
  await expect(page.locator('.result[data-code="AC48092100"]')).toHaveCount(1);
});

// ── C6 聲明 ─────────────────────────────────────────────────────
for (const width of [1280, 390]) {
  test(`C6 免責聲明於 ${width}px 完整可讀（搜尋頁與詳細頁）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockSite(page);
    for (const url of ['/', '/?code=A017014321']) {
      await page.goto(url);
      await expect(page.locator('#q')).toBeEnabled();
      const d = page.locator('.disclaimer');
      await d.scrollIntoViewIfNeeded();
      await expect(d).toBeVisible();
      await expect(d).toContainText('不代表醫療院所實際採購價、零售價或病人自付金額');
      const box = await d.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const clipped = await d.evaluate((el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
      expect(clipped).toBe(false);
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(pageOverflow).toBe(false);
    }
  });
}

// ── C7 shard 失敗與競態 ─────────────────────────────────────────
test('C7 shard 第一次 404、按重試後呈現完整歷史', async ({ page }) => {
  await mockSite(page, {
    shard: (prefix, attempt, route) => (attempt === 1 ? route.fulfill({ status: 404, body: '' }) : false),
  });
  await page.goto('/?code=AC48092100');
  const err = detail(page).locator('.alert--error');
  await expect(err).toContainText('HTTP 404');
  await expect(detail(page)).not.toContainText('0 筆');
  await expect(detail(page).locator('.metric')).toHaveCount(0);
  await err.getByRole('button', { name: '重試' }).click();
  await expect(detail(page).locator('.alert--error')).toHaveCount(0);
  await expect(detail(page).locator('.detail-head .code')).toHaveText('AC48092100');
  await expect(detail(page).locator('.metric.key')).toBeVisible();
});

test('C7 shard 損毀或缺預期代號 → 錯誤狀態', async ({ page }) => {
  await mockSite(page, {
    shard: (prefix, attempt, route, data) => (prefix === 'AC48'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"shardVersion":' })
      : route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...data.shards[prefix], drugs: {} }) })),
  });
  await page.goto('/?code=AC48092100');
  await expect(detail(page).locator('.alert--error')).toContainText('不是有效的 JSON');
  await page.goto('/?code=B009254100');
  await expect(detail(page).locator('.alert--error')).toContainText('缺少此代號');
  await expect(detail(page).locator('.metric')).toHaveCount(0);
});

test('C7 競態：選 A（回應由測試控制）後立即選 B → A 回應當下與之後都只有 B', async ({ page }) => {
  let releaseA;
  const aHeld = new Promise((r) => { releaseA = r; });
  let aArrived;
  const aRequested = new Promise((r) => { aArrived = r; });
  await mockSite(page, {
    shard: async (prefix, attempt, route, data) => {
      if (prefix !== 'AC48') return false;
      aArrived();
      await aHeld;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.shards.AC48) })
        .catch(() => {});
    },
  });
  await page.goto('/');
  await search(page, 'AC48092100');
  await page.locator('.result').first().click();              // A：AC48 分片被扣住
  await aRequested;
  await page.goBack();
  await search(page, 'B009254100');
  await page.locator('.result').first().click();              // B：即時
  await expect(detail(page).locator('.detail-head .code')).toHaveText('B009254100');

  // 記錄 A 回應釋放後的每一次 DOM 變動：任何時刻都不得出現 A 的代號（codex T5）
  await page.evaluate(() => {
    window.__sawA = false;
    new MutationObserver(() => { if (document.getElementById('detail').textContent.includes('AC48092100')) window.__sawA = true; })
      .observe(document.getElementById('detail'), { childList: true, subtree: true, characterData: true });
  });
  releaseA();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__sawA)).toBe(false);
  await expect(detail(page).locator('.detail-head .code')).toHaveText('B009254100');
  await expect(page).toHaveURL(/code=B009254100/);
});

// ── C8 核心資源失敗、E6 混批 ────────────────────────────────────
for (const [what, opt] of [['index 404', { index: '404' }], ['index 損毀', { index: 'corrupt' }],
  ['meta 404', { meta: '404' }], ['meta 損毀', { meta: 'corrupt' }]]) {
  test(`C8 ${what} → 錯誤＋重試，不回報「查無」`, async ({ page }) => {
    await mockSite(page, opt);
    await page.goto('/?code=AC48092100');
    await expect(page.locator('#banners .alert--error')).toContainText('無法載入藥價資料');
    await expect(page.locator('#banners button', { hasText: '重試' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('查無');
    await expect(page.locator('#q')).toBeDisabled();
  });
}

test('C8 index 先失敗、重試成功後可查詢', async ({ page }) => {
  let n = 0;
  const data = buildData();
  await mockSite(page, { data });
  await page.route('**/data/drug_index.json', (route) => (++n === 1
    ? route.fulfill({ status: 500, body: '' })
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.index) })));
  await page.goto('/');
  await page.locator('#banners button', { hasText: '重試' }).click();
  await expect(page.locator('#q')).toBeEnabled();
  await search(page, '撫緒');
  await expect(page.locator('.result[data-code="AC48092100"]')).toHaveCount(1);
});

test('C8 重試載入期間重試鈕消失、不可重複觸發；完成後可查詢（codex R6）', async ({ page }) => {
  const data = buildData();
  let n = 0;
  let release;
  const held = new Promise((r) => { release = r; });
  // status 永不回應：避免 status handler 順手重繪橫幅而遮蔽「載入開始時未清橫幅」的缺陷
  await mockSite(page, { data, status: 'pending' });
  await page.route('**/data/drug_index.json', async (route) => {
    n += 1;
    if (n === 1) return route.fulfill({ status: 500, body: '' });
    await held;                                                // 重試那次被扣住
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.index) }).catch(() => {});
  });
  await page.goto('/');
  const retry = page.locator('#banners button', { hasText: '重試' });
  await retry.click();
  await expect(retry).toHaveCount(0);                          // 載入中：舊錯誤訊息與重試鈕已清除
  await expect(page.locator('#banners .alert--error')).toHaveCount(0);
  await expect(page.locator('#q')).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('查無');
  release();
  await expect(page.locator('#q')).toBeEnabled();
  expect(n).toBe(2);                                           // 沒有第三次請求
  await search(page, '撫緒');
  await expect(page.locator('.result[data-code="AC48092100"]')).toHaveCount(1);
});

test('C8 status 卡住期間：查詢照常可用，來源資訊顯示載入中（codex R7）', async ({ page }) => {
  await mockSite(page, { status: 'pending' });                              // 預設逾時 20 秒，測試期間不會到
  await page.goto('/?code=AC48092100');
  await expect(detail(page).locator('.metric.key')).toBeVisible();          // 不被 status 阻塞
  await expect(page.locator('#sourceInfo')).toContainText('載入中');
  await expect(page.locator('#banners [data-stale]')).toHaveCount(0);
});

test('C3 status 永不回應 → 逾時後轉紅並於現行價旁加註（codex R7）', async ({ page }) => {
  await mockSite(page, { status: 'pending', timeouts: { status: 800 } });
  await page.goto('/?code=AC48092100');
  await expect(page.locator('#banners [data-stale]')).toHaveAttribute('data-stale', 'red');
  await expect(detail(page).locator('[data-stale-note]')).toHaveCount(1);
  await expect(page.locator('#sourceInfo')).toContainText('無法取得');
});

test('E6 index 與 meta 版本不一致 → 提示重新整理，不可搜尋', async ({ page }) => {
  const data = buildData();
  await mockSite(page, { data, index: { ...data.index, dataVersion: 'sha256:other' } });
  await page.goto('/?code=AC48092100');
  await expect(page.locator('#banners')).toContainText('資料已更新，請重新整理');
  await expect(detail(page).locator('.metric')).toHaveCount(0);
  await expect(page.locator('#q')).toBeDisabled();
});

test('E6 shard 與 meta 版本不一致 → 不顯示摘要與圖表', async ({ page }) => {
  await mockSite(page, {
    shard: (prefix, attempt, route, data) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...data.shards[prefix], shardVersion: 'sha256:stale' }) }),
  });
  await page.goto('/?code=AC48092100');
  await expect(detail(page)).toContainText('資料已更新，請重新整理');
  await expect(detail(page).locator('.metric, svg.chart, table')).toHaveCount(0);
});

// ── C2（DOM 側）、E3–E5 ─────────────────────────────────────────
test('C2 BC23981100 圖表：有價線段非空、空窗 1 段', async ({ page }) => {
  await mockSite(page);
  await page.goto('/?code=BC23981100');
  const svg = detail(page).locator('svg.chart');
  await expect(svg).toHaveAttribute('data-gaps', '1');
  expect(Number(await svg.getAttribute('data-lines'))).toBeGreaterThan(0);
  await expect(svg.locator('text', { hasText: /^2910$/ })).toHaveCount(0);
});

test('E3 表格列數＝records＋invalidRecords；日期異常列照實顯示', async ({ page }) => {
  const data = buildData();
  const entry = data.shards.AC48.drugs.AC48092100;
  entry.invalidRecords = [{ rawFrom: '1041301', rawTo: '9991231', rawPrice: '12.00', error: 'invalid_date' }];
  entry.flags = [...entry.flags, 'invalid_records'];
  await mockSite(page, { data });
  await page.goto('/?code=AC48092100');
  await expect(detail(page).locator('table.history tbody tr')).toHaveCount(entry.records.length + 1);
  const bad = detail(page).locator('tr[data-kind="invalid"]');
  await expect(bad.locator('td').nth(0)).toHaveText('1041301');
  await expect(bad.locator('td').nth(1)).toHaveText('9991231');
  await expect(bad.locator('td').nth(2)).toHaveText('12.00');
  await expect(bad).toContainText('日期異常');
  await expect(detail(page).locator('#tableTitle')).toContainText(`${entry.records.length + 1} 筆`);
  // 逐列比對：新→舊排序下，第 i 列＝records 倒數第 i 筆的起日、迄日、rawPrice（codex T11）
  const rows = detail(page).locator('tr[data-kind="record"]');
  const expected = [...entry.records].reverse();
  for (let i = 0; i < expected.length; i++) {
    const r = expected[i];
    const cells = rows.nth(i).locator('td');
    await expect(cells.nth(0)).toHaveText(r.from);
    if (r.to) await expect(cells.nth(1)).toHaveText(r.to);
    await expect(cells.nth(2)).toHaveAttribute('title', `原始值：${r.rawPrice}`);
    if (r.priceState === 'priced') await expect(cells.nth(2)).toHaveText(r.rawPrice);
  }
});

test('E4 品質標記只出現在對應代號', async ({ page }) => {
  await mockSite(page);
  await page.goto('/?code=BC23981100');
  await expect(detail(page).locator('.warnings .alert--warn')).toContainText('支付空窗');
  await expect(detail(page).locator('tr', { hasText: '前有空窗' })).toHaveCount(1);
  await page.goto('/?code=AC48092100');
  await expect(detail(page).locator('.detail-head')).toBeVisible();
  await expect(detail(page).locator('.warnings')).toHaveCount(0);
  await expect(detail(page).locator('.tag.warn')).toHaveCount(0);
});

test('E5 TFDA 連結文字與 href；給付規定連結為空不顯示', async ({ page }) => {
  const { data } = await mockSite(page);
  await page.goto('/?code=BC05037209');
  const m = data.shards.BC05.drugs.BC05037209.meta;
  const link = detail(page).getByRole('link', { name: /TFDA 許可證資料/ });
  await expect(link).toHaveAttribute('href', m.tfdaLink);
  await expect(detail(page).getByRole('link', { name: /健保給付規定/ })).toHaveCount(0);
});

test('§5.3 A020296321：首列 0 元在歷史表整列、圖表區塊與圖例皆不稱「終止」', async ({ page }) => {
  await mockSite(page);
  await page.goto('/?code=A020296321');
  const firstRow = detail(page).locator('tr[data-kind="record"]').last();   // 新→舊排序，最舊在最後
  await expect(firstRow).toContainText('健保支付價 0 元（此前無有價紀錄）');
  await expect(firstRow).not.toContainText('終止');                          // 整列（含事件欄），codex T3
  const svg = detail(page).locator('svg.chart');
  await expect(svg.locator('[data-band="unpriced_zero"]')).toHaveCount(1);
  await expect(svg.locator('[data-band="terminated"]')).toHaveCount(0);
  await expect(svg.locator('[data-band="unpriced_zero"] title')).not.toContainText('終止');
  await expect(detail(page).locator('[data-legend="unpriced_zero"]')).toHaveText(/健保支付價 0 元（此前無有價紀錄）/);
  await expect(detail(page).locator('[data-legend="terminated"]')).toHaveCount(0);
});

test('§5.3 暫停 → 0 元、此前從未有價：事件欄、最新調整、圖例皆不稱「終止」', async ({ page }) => {
  // golden 無此形態（terminated 事件且 previousPrice 為 null），以 A020296321 為底改寫成合成案例
  const data = buildData();
  const entry = data.shards.A020.drugs.A020296321;
  const base = entry.records[0];
  entry.records = [
    { ...base, from: '1995-03-01', to: '1996-12-31', rawPrice: '-', priceState: 'suspended', eventType: 'initial', previousPrice: null },
    { ...base, from: '1997-01-01', to: null, rawPrice: '0.00', priceState: 'terminated', eventType: 'terminated', previousPrice: null },
  ];
  await mockSite(page, { data });
  await page.goto('/?code=A020296321');
  const rows = detail(page).locator('tr[data-kind="record"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('0 元（此前無有價紀錄）');
  await expect(rows.first()).not.toContainText('終止');
  await expect(detail(page).locator('.metric', { hasText: '最新一次調整' })).not.toContainText('終止');
  await expect(detail(page).locator('.metric.key')).not.toContainText('終止');
  await expect(detail(page).locator('[data-legend="terminated"]')).toHaveCount(0);
});

test('§5.3 一般終止（AC48867100）仍以終止區塊與圖例呈現', async ({ page }) => {
  await mockSite(page);
  await page.goto('/?code=AC48867100');
  await expect(detail(page).locator('svg.chart [data-band="terminated"]')).toHaveCount(1);
  await expect(detail(page).locator('[data-legend="terminated"]')).toHaveText(/終止支付/);
  await expect(detail(page).locator('[data-legend="unpriced_zero"]')).toHaveCount(0);
});
