# Spec — 預告中心（Upcoming Changes）

> NHI-drug-price-history 功能規格 **v0.3**（2026-09-14；修訂紀錄見 §12）
> 上位文件：`spec.md`（資料模型與規則）、`.ai-review/plan.md` §5（驗收條件）
> 本文件只定義本功能；與上位文件衝突時以上位文件為準。
> 對應 §18 版本：`v0.2.0`——但 `spec.md` §18 的 v0.2.0 定義為「export / filters / ATC 搜尋 / 深色模式」，未含「預告中心」這個 view，深色模式亦不在本規格範圍。**`spec.md` §18 須一併更新**，否則版號與內容對不上。
> **狀態：已通過兩輪覆審，可動工。** 第二輪無新 Blocker，架構決策全部確立；剩餘修正皆為契約細化，不需第三輪。

---

## 1. 目標與非目標

### 目標

回答藥師在單品項查詢之外的第二類問題：**「接下來會變動的是哪些藥？」**

1. 未來哪些健保代號已公告調價／終止／恢復支付？
2. 生效日是哪一天、批次規模多大？
3. 每一筆從多少元變成多少元、幅度多少？
4. 這些品項在我的關注清單（ATC、成分、關鍵字）裡嗎？

### 非目標（明確排除）

| 排除項 | 理由 |
|---|---|
| 推論調價原因、政策解讀 | `spec.md` §9 NOT IN MVP |
| 以「停產」「註銷」「下架」描述預告終止 | 本站只有健保支付狀態，無 TFDA 許可證狀態（§8.1 決策） |
| 訂閱／推播／Email 通知 | 需後端；純前端範圍外 |
| 以預告資料回推採購建議、備藥量 | 無申報量資料 |
| 影響首頁 `drug_index.json` 的載入路徑 | E7 效能尚未達標，不得再加首屏成本 |

---

## 2. 判定基準與日期語意

沿用 `spec.md` §5.5「參考日期」框架，但本功能有**兩個日期**，必須分清：

| 符號 | 定義 | 用途 |
|---|---|---|
| `D` | build 日（+08:00） | 決定哪些 record 被寫進 `upcoming.json` |
| `T` | 瀏覽器本地日期 | 決定每一筆在畫面上是「預告」或「已生效（資料待更新）」 |

**預告 record 定義**：完整 history（`data/history/*.json` 的 `records`）中 `from > D` 者。`invalidRecords` 不納入。

實測基準（2026-09-11）：82 列 / 79 個代號，最遠 2028-10-01。

> **不得**以 `drug_index.json` 的 `window` 產生本檔。`window` 最多只帶一筆未來區間（§5.1），同一代號若有兩筆以上預告會漏。必須由完整 history 產生。

### `D` 與 `T` 落差的處理（必要）

build 為每週一次，`T` 可能已越過某些 `effectiveDate`。

| 條件 | 畫面行為 |
|---|---|
| `effectiveDate > T` | 正常顯示為預告 |
| `effectiveDate ≤ T` | 該列仍**保留在清單中**，標籤改為「已生效（本站資料尚未重建）」，並套用 §8.6 過期警示樣式 |
| 清單中所有列皆 `≤ T` | 顯示「目前資料中已無未生效的公告」，**下方仍列出全部已生效列**，不得顯示為空白頁 |
| `T < D`（使用者裝置日期早於 build 日） | 照常顯示，另加一行「本站資料產生於 YYYY-MM-DD，晚於你的裝置日期；清單可能未涵蓋該日之後的公告」 |

理由：讓使用者看得出「不是沒有預告，是本站資料舊了」。直接濾掉會製造靜默錯誤。

**兩個日期必須分別呈現，不得互相代替**（plan-verdict-upcoming M3）：

| 欄位 | 來源 | 語意 |
|---|---|---|
| 資料產生日 `D` | `upcoming.buildDate` | **目前已發布的這份 upcoming 是哪一天產生的** |
| 最後檢查日 | `status.lastCheckedAt` | 排程最後一次向上游確認的時間 |

`D` 在三種情形會前進：來源 CSV 有變、build 日跨過某預告生效日（§3.3）、首次交付或版本遷移（§3.3.1）。其餘的例行檢查只更新最後檢查日。因此**兩者可以相差很遠且都是正常的**。因此：

- §8.6 的過期警示以**最後檢查日**判定
- 「已生效（本站資料尚未重建）」的到期提示以 **`T` 對 `effectiveDate`** 判定，**獨立於**過期警示：最後檢查日很新時，不得因此壓掉到期提示
- `T` 於進入頁面時取得一次，該次檢視內不跨午夜自動更新（沿用 `spec.md` §5.5 的取日慣例）

---

## 3. 資料層

### 3.1 輸出檔

`data/upcoming.json`——由 `build_price_history.py` 在 history shards 產生後、寫檔前計算。

```jsonc
{
  "dataVersion": "sha256:<同 meta.json>",
  "buildDate": "2026-09-14",          // D，ISO date，+08:00
  "count": 82,
  "codeCount": 79,
  "items": [
    {
      "code": "BC05037209",
      "chName": "範例藥品",
      "enName": "EXAMPLE TABLETS",
      "ingredient": "EXAMPLE",
      "strength": "10",
      "strengthUnit": "MG",
      "dosageForm": "TABLET",
      "atcCode": "A00AA00",
      "manufacturer": "EXAMPLE PHARMA",

      "effectiveDate": "2026-10-01",  // record.from
      "endDate": null,                 // record.to
      "eventType": "terminated",       // 同 §5.4
      "priceState": "terminated",      // 同 §5.3
      "price": null,
      "rawPrice": "0.00",
      "previousPrice": 245.0,          // 直接取 record.previousPrice（事件語意，可能為 null）
      "pricedBefore": 245.0,           // 該列之前最後一個 priced 金額（狀態語意，獨立於事件）
      "previousState": "priced",       // 預告列之前一筆 record 的 priceState；無前筆為 null
      "absoluteChange": null,
      "percentChange": null,
      "crossesStop": false,
      "everPriced": true,              // === (pricedBefore !== null)
      "flags": ["..."]                 // record flags ∪ 代號層 flags
    }
  ]
}
```

欄位取用規則：

| 欄位 | 來源 | 備註 |
|---|---|---|
| 描述欄位（品名／成分／規格／劑型／ATC／藥商） | §6.6 規則、以 `D` 選列 | **不得**以預告列本身回填（`BC26467100` 成分欄損毀前例） |
| `eventType`／`previousPrice`／`absoluteChange`／`percentChange`／`crossesStop` | 直接取 record 既有欄位 | 不重算，避免與詳細頁雙重真相 |
| `previousState` | 排序後前一筆 record 的 `priceState` | 無前筆（預告列即首列）→ `null` |
| **`pricedBefore`** | 該列**之前**最後一個 `priced` 金額，無則 null | **狀態語意**，與事件無關。沿用 `engine.js:151` 既有的 `pricedBefore()` 邏輯 |
| `everPriced` | `pricedBefore !== null` | 驅動 §5.3 首列 0 元例外。**定義為衍生值**，不獨立計算，避免與 `pricedBefore` 漂移 |
| `flags` | record flags 與代號層 flags 聯集，去重 | 用於畫面品質提示 |

> **`pricedBefore` 為什麼非有不可**（v0.2 的缺漏，plan-verdict-r2 F1）：
>
> §4.1 要求「終止支付續期／暫停支付續期」顯示停止前金額，但 `spec.md` §5.4 序 3／序 5 明定這兩種續期的 `previousPrice` 就是 **null**——資料不在 record 上。實測全量：`terminated → terminated` **52 列**、`suspended → suspended` **24 列**，共 76 列受影響。
>
> 這與 Phase 2 在 index window 踩到的是同一個坑（`plan.md` v2.2：實測 45 個代號，解法就是加 `pricedBefore`）。v0.2 把需求寫進 §4.1 卻沒補欄位，等於要求前端拿不存在的資料。
>
> `previousPrice`（事件語意，可為 null）與 `pricedBefore`（狀態語意）**並存且分開定義**，不可互相取代。

### 3.2 Determinism 契約

- `upcoming.json` 與 `drug_index.json` 同類：**相同 source input ＋相同 build 日 → 完全相同 JSON**。
- 不影響 `dataVersion` 的計算（`dataVersion` 仍只由 shard hashes 決定，§5.2）。
- 序列化規則同 §6.2（`sort_keys`、`ensure_ascii=False`、固定分隔符）。
- 排序：`effectiveDate` asc → `eventType` 字典序 → `code` asc → **原 records 索引 asc**。
  - 第四鍵為必要：同代號同日同事件的多列，前三鍵無法區分，輸出順序會隨來源列順序改變而破壞 determinism（plan-verdict-r2 U2）。

### 3.3 Diff 與 commit 規則

`upcoming.json` 依 `D` 變動，即使來源沒變也可能因跨越生效日而 diff。

- **不納入** §12 的 diff check（diff check 仍只比 `drug_index.json` + `history/`）
- commit 規則：**與 `drug_index.json` 完全同進退**——`drug_index.json` 進 commit 時 `upcoming.json` 一起進，反之不動

> 這一條唯一的判準就是 `drug_index.json` 動不動，沒有第二條規則。
>
> 實務上有兩種情形會讓 `drug_index.json` 變動：(1) 來源 CSV 有變；(2) 來源未變但 build 日 `D` 跨過某個預告生效日——`window` 會位移，見 `plan.md` B5。**第 (2) 種正是 `upcoming.json` 最需要更新的時刻**（剛有列離開預告集合），所以不得再疊加「來源無變 → 不動」的例外。
>
> 原 v0.1 同時寫了「與 index 同進退」與「來源無變 → 不動 upcoming.json」，兩條在第 (2) 種情形下答案相反（plan-verdict-upcoming H2）。以「與 index 同進退」為準。

### 3.3.1 首次交付與版本遷移（v0.1 缺漏）

「與 index 同進退」只描述**穩定態**的例行檢查。以下兩種情形不受它管轄：

**觸發條件**（可重現，判定對象是**已發布版本**，不是工作目錄）：

| 情形 | 判定 | 規則 |
|---|---|---|
| **功能首次上線** | 已發布版本中不存在 `data/upcoming.json` | 無條件產出一份經驗證的檔案 |
| **生成規則修正** | 已發布的 `upcoming.generatorVersion` ≠ 本次程式碼內建的 `GENERATOR_VERSION` 常數 | 無條件重產 |

**發布完成的定義**（v0.2 缺漏，plan-verdict-r2 F4）：

> **產出檔案 ≠ 發布檔案。** 已核實 `build-data.yml:58` 以
> `git diff --staged --quiet -- data/drug_index.json data/history` 判定 changed，**無差異分支只 commit `status.json`**。
> 所以首次上線當天若來源未變、index 也未變，新產生的 `upcoming.json` 會留在工作目錄裡進不了 commit，功能上線即空。

因此：

- 首次／遷移 build 必須**強制進入有差異分支**，把 `upcoming.json` 與相應 `meta.json` **同批 commit**
- 只有「經驗證的產物與 meta 已同批進入 commit」才算完成
- 產生或驗證失敗時**不得**推進完成狀態；下次執行仍視為未完成的首次／遷移
- 失敗後重跑必須重新判定，不得因為檔案已存在於工作目錄就跳過

### 3.3.2 `generatorVersion`

`upcoming.json` 攜帶一個字串常數 `generatorVersion`（例：`"upcoming/1"`），前端比對自己內建的期望值，不符即走 §5.5 的「請重新整理」。

> **為什麼需要它**（plan-verdict-r2 F5）：§3.3.1 允許生成規則修正而 `dataVersion` 不變（`dataVersion` 只依來源內容）。此時舊 `upcoming.json` 與新 `meta.json` 版本相等、也都通過結構驗證，U11 完全偵測不到「舊規則產物被當成已遷移資料」。B2 移除 SW 不影響 HTTP／CDN 快取，`plan.md` D10 已記錄這類混批風險。
>
> **範圍刻意限制在最小**：只加一個字串欄位。**不動 `dataVersion`、不動 history shard、不引入 SW、不建立額外的產物辨識體系。**

遷移與例行 build 分別驗收（U7a／U7b）。`dataVersion` 維持只依來源內容，不因遷移改變。

### 3.4 Guards 與 meta

`meta.json` 新增（僅記錄，不擋 build）：

```jsonc
"upcomingRows": 82,
"upcomingCodes": 79
```

| 條件 | 處理 |
|---|---|
| `upcomingRows = 0` | WARNING（可能為真，健保公告有空窗期），不 fail |
| `upcomingCodes ÷ uniqueDrugCodeCount > 5%` | WARNING 並寫入 step summary，不 fail |
| **`upcoming.json` 產生或驗證失敗** | **exit 1，整批不發布**——`data/` 與 `status.json` 皆維持位元組不變 |

> 最後一條在 v0.1 原本寫成「不得使整個 build fail、其餘照常發布」，那是**部分發布**，與既有的全有全無契約（`plan.md` B8：任一 guard 失敗 → `data/`、`status.json` 皆不寫入）衝突（plan-verdict-upcoming B1）。
>
> 更具體的後果：upcoming 失敗但其餘照常發布 → 舊的 `upcoming.json` 留在原地、`meta.dataVersion` 已更新 → 直接觸發本規格 §5.5 的「dataVersion 不一致 → 不渲染清單」，功能鎖死且沒有自我修復路徑，要等下一次來源變動才會解。
>
> 若日後真的要讓衍生檔可獨立失敗，那是修改發布契約本身，須另行提案，不得在本功能裡默默引入。

### 3.5 體積

82 列 × 約 400 bytes ≈ 33 KB raw / 約 6 KB gzip。若某次 build 超過 **500 KB raw**，build WARNING（來源結構可能異常）。

---

## 4. 標籤與文案

事件標籤沿用 §5.3／§5.4，**不新增語彙**。

**主鍵是 `priceState` ＋ 該列之前有無 `priced`，不是 `eventType`。** v0.1 以 `eventType` 為索引鍵是錯的（plan-verdict-upcoming H1）：

- `eventType` 表裡沒有 `initial`，但首列即 0 元的代號其事件就是 `initial`（實例 `A020296321`：1995-03-01 起 `priceState: terminated`、`rawPrice: "0.00"`、`eventType: initial`）——這類列在 v0.1 裡沒有任何標籤可用。
- `spec.md` §5.3 的首列 0 元例外本來就以「priceState ＋ 此前有無 priced」定義，與事件名稱無關。
- 「終止→終止續期」「暫停→暫停續期」的事件都是 `unchanged`，v0.1 一律標成「續期（價格未變）」，等於把 0 元說成「價格不變」。

### 4.1 呈現決策表

`everPriced` 一律指「**該列之前**是否存在 `priced` 紀錄」，只看排序在前的列，**不是整個代號的布林值**，也不受後續恢復支付影響。

**由上而下取第一個符合的規則（互斥優先序）**，比照 `spec.md` §5.4 的寫法。X ＝ `pricedBefore`，Y ＝ 本列 `price`。

| 序 | 條件 | 標籤 | 副標 |
|---|---|---|---|
| 1 | 帶 `conflicting_price_interval` flag，**或** `eventType = unknown` | 無法判定 | `來源資料異常，請開啟詳細頁確認` |
| 2 | `priceState = malformed` | 資料格式異常 | `YYYY-MM-DD 起（原始值：<rawPrice>）` |
| 3 | `priceState = missing` | 來源無支付價資料 | `YYYY-MM-DD 起；請開啟詳細頁確認` |
| 4 | `priceState = terminated`，`everPriced = false` | **健保支付價 0 元** | `YYYY-MM-DD 起（此前無有價紀錄）`——**不得出現「終止」字樣** |
| 5 | `priceState = terminated`，`previousState = terminated` | 終止支付續期 | `YYYY-MM-DD 起仍為 0 元；終止前 X 元` |
| 6 | `priceState = terminated` | 終止支付 | `YYYY-MM-DD 起；終止前 X 元` |
| 7 | `priceState = suspended`，`everPriced = false` | 暫停支付 | `YYYY-MM-DD 起（此前無有價紀錄，來源標示「<rawPrice>」）` |
| 8 | `priceState = suspended`，`previousState = suspended` | 暫停支付續期 | `YYYY-MM-DD 起仍為暫停；暫停前 X 元` |
| 9 | `priceState = suspended` | 暫停支付 | `YYYY-MM-DD 起；暫停前 X 元（來源標示「<rawPrice>」）` |
| 10 | `priceState = priced`，`everPriced = false` | 首次有價 | `YYYY-MM-DD 起 Y 元` |
| 11 | `priceState = priced`，`previousState ∈ {terminated, suspended}` | 恢復支付 | `YYYY-MM-DD 起 X → Y 元（±Z%，跨越停止期間）` |
| 12 | `priceState = priced`，`previousState = priced`，`Y = previousPrice` | 續期（支付價不變） | `YYYY-MM-DD 起 Y 元，與前期相同` |
| 13 | `priceState = priced`，`previousState = priced` | 調升／調降 | `YYYY-MM-DD 起 X → Y 元（±Z%）` |
| 14 | 以上皆不符 | 無法判定 | 同序 1 |

> v0.2 的表以 `(priceState, everPriced, previousState)` 三欄並列，**既不窮盡也不互斥**（plan-verdict-r2 F2）：
>
> - `[10, missing, 12]` 的末筆是 `priced`、`everPriced = true`、`previousState = missing`——v0.2 的四個 `priced` 列全不符合，**落不進任何一列**。而 `plan.md` **A3 明確把 `[10, "", 12]` → `[initial, unknown, unknown]` 列為必過案例**，不是假想輸入。
> - 帶 `conflicting_price_interval` 的 `priced` 列同時符合第一列與末列，沒有優先序。
> - `spec.md` §5.4 的 `eventType = unknown` 涵蓋範圍比 `conflicting_price_interval` 更廣（含異價 overlap），只用 flag 兜底會把不可判定事件重新標成確定的調升／調降——所以序 1 同時檢查兩者。
>
> 序 14 是安全網：任何未預期組合一律落到「無法判定」，**不得靜默顯示成確定的價格事件**。
>
> 實測現況 `missingPriceRows = 0`、`malformedPriceRows = 0`、`conflictCodes = 0`、`overlapCodes = 0`，序 1–3 與序 14 **在真實資料裡不會自然出現**，必須用合成 fixture 驗（見 §9.1）。

### 4.1.1 篩選分類映射

§5.3 的 `type` 參數**不得**直接使用原始 `eventType`，否則同一列在標籤與篩選會分到兩個類別（例如首列 0 元的標籤是「健保支付價 0 元」，卻可能因 `priceState = terminated` 被歸進「終止支付」篩選；或因 `eventType = initial` 在所有具名選項中消失）。

映射以 **§4.1 的序號**為唯一依據：

| §4.1 序 | `type` |
|---|---|
| 13（調降） | `decrease` |
| 13（調升） | `increase` |
| 5、6 | `terminated` |
| 8、9 | `suspended` |
| 11 | `relisted` |
| 4、7、10 | `first_priced` |
| 12 | `unchanged` |
| 1、2、3、14 | `other` |

- 序 4（首列 0 元）歸入 `first_priced` 而非 `terminated`：與它的標籤一致，避免使用者用「終止支付」篩選時看到一列寫著「此前無有價紀錄」的品項
- `type=all` 涵蓋全部
- 此表即 §5.3 中 `type` 合法值的完整值域

### 4.2 金額欄位取用

- **前價（X）**：`terminated`／`suspended` 取「該列之前最後一個 `priced` 金額」；`priced` 取前一筆 `priced` 金額。null 時整段前價敘述**省略**，不得轉為 0。
- **差額與百分比**：只在前價與新價**皆為正數**時計算與顯示。`relisted` 的 `absoluteChange`／`percentChange`／`crossesStop` 在 record 上已有值，**必須呈現**，v0.1 只顯示新價是漏用既有資料。
- **暫停原始標記**：顯示該列的實際 `rawPrice`，不得固定寫死 `-`。`spec.md` §5.3 定義的 `suspended` 來源值有三種：`-`、`－`、`—`。
- 以上一律直接取 record 既有欄位，**不重算**，避免與詳細頁雙重真相。

頁面固定顯示（沿用 §2 禁止用語）：

> 本系統顯示中央健康保險署公告之健保支付價，不代表醫療院所實際採購價、零售價或病人自付金額。預告內容以健保署最新公告為準。

**禁止**：「停產」「註銷」「下架」「藥價黑洞」「政策性降價」，以及任何對調價原因的敘述。

---

## 5. 前端規格

### 5.1 路由與入口

- URL：`?view=upcoming`，可疊加 `&date=YYYY-MM-DD`、`&type=<eventType>`、`&q=<keyword>`、`&atc=<prefix>`
- 入口：header 放一個徽章。**未載入 `upcoming.json` 前只顯示「預告」，不帶數字**；載入後才顯示依 `T` 計算的 `effectiveDate > T` 列數
- **lazy fetch**：點擊後才 fetch `upcoming.json`。首屏不得增加任何 blocking request

> v0.1 讓徽章初值取自 `status.json` 的 `upcomingRows`，有兩個問題（plan-verdict-upcoming M2）：(1) §3.4 只說寫進 `meta.json`、§5.1／§7 又說讀 `status.json`，資料契約沒定案；(2) 預先算好的數字是 **D 基準**的列數，§5.1 要的卻是 **T 基準**，fetch 前後數字會跳動，而使用者無從解釋為什麼「預告 82」變成「預告 79」。
>
> 因此**不新增 `upcomingRows` 到 `status.json`**。`meta.json` 的統計欄位（§3.4）僅供建置紀錄與 guard，不供前端顯示。
- 返回搜尋：`?view=upcoming` 移除即回原頁，不做 history hack

### 5.2 版面

```
┌────────────────────────────────────────────┐
│ 預告中心            資料產生 2026-09-14      │
│ [免責聲明一行]                               │
├────────────────────────────────────────────┤
│ 篩選列：[事件型別 ▾][ATC ▾][關鍵字____][匯出CSV]│
├────────────────────────────────────────────┤
│ ■ 2026-10-01 起（62 品項）                   │
│   ┌ BC05037209 範例藥品 EXAMPLE TABLETS      │
│   │ 終止支付 · 終止前 245 元 · A00AA00        │
│   │                            [查看歷史 ↗]  │
│   └ ...                                     │
│ ■ 2027-01-01 起（12 品項）                   │
└────────────────────────────────────────────┘
```

- **依 `effectiveDate` 分組**，組標題顯示日期與該批品項數
- 每列必含：代號、中文品名、英文品名、事件標籤、金額變化、ATC、`查看歷史 ↗`（連至 `?code=<code>`）
- `flags` 非空 → 顯示品質提示 chip（同搜尋卡慣例）
- 行動裝置：卡片式單欄，事件標籤置於品名下方第一行

### 5.3 篩選與排序

| 控制項 | URL 參數 | 合法值 | 預設 | 無效值處理 |
|---|---|---|---|---|
| 事件型別 | `type` | `all`／`decrease`／`increase`／`terminated`／`suspended`／`relisted`／`other` | `all` | 忽略該參數，回預設，不報錯 |
| ATC | `atc` | 單一大寫英文字母 A–V，且須存在於本份清單 | 全部 | 同上 |
| 關鍵字 | `q` | 任意字串，長度 ≤ 100 | 空 | 截斷至 100 |
| 生效日 | `date` | `YYYY-MM-DD`，且須精確等於清單中某個批次日 | 全部 | 同上 |
| 排序 | `sort` | `date_asc`／`date_desc`／`change_desc` | `date_asc` | 同上 |

- `type=other` 的集合明確定義為：`first_priced`、`missing`、`malformed`、無法判定。**不是「以上皆非」的殘集**
- `date` 的語意是**精確批次**，不是區間起點
- 關鍵字比對 code／chName／enName／ingredient，不分大小寫子字串
- 「幅度 desc」依 `percentChange` 的**絕對值**由大到小（調降 −30% 與調升 +30% 同級）；無 `percentChange` 者一律置底，**不得**視為 0%。同值時以 `effectiveDate` asc → `code` asc 決定順序
- 排序與分組的優先關係：`date_asc`／`date_desc` 時**維持 §5.2 的日期分組**；`change_desc` 時**取消分組**，改為單一平坦清單（否則「幅度最大」會被切散在各批次裡而看不出來）
- 各參數為 AND 關係
- 篩選狀態序列化進 URL（可分享），但**不**寫入 localStorage（與搜尋頁的「顯示已終止」勾選框不同：那是長期偏好，這是一次性檢視）
- 篩選後為空 → 「目前篩選條件下沒有符合的公告（清單共 N 筆）」，N 為**篩選前**的總列數，不得只顯示「查無」

### 5.4 CSV 匯出

- 零依賴，前端組字串 + `Blob`
- 檔名：`nhi_upcoming_<buildDate>.csv`
- 欄位：生效日／代號／中文品名／英文品名／成分／規格／劑型／ATC／藥商／事件／變動前支付價／變動後支付價／差額／變動%／原始支付價字串／備註
- UTF-8 **with BOM**
- 匯出**目前篩選後**的結果，第一列之上加一行來源、篩選條件與免責註記
- `rawPrice` 必須逐字輸出（`12.50` 不得變成 `12.5`、`0.00` 不得變成 `0`），含逗號／引號／換行／中文時依 RFC 4180 跳脫
- 備註欄須帶上畫面已顯示的到期標示（「已生效（本站資料尚未重建）」）與品質提示 `flags`
- 版本不一致或資料不合法時（§5.5）**停用匯出**

> v0.1 寫「以文字欄位處理（避免 Excel 把 `0.00` 變成 `0`）」——CSV 沒有型別，BOM 與引號都不保證 Excel 保留尾隨零（plan-verdict-upcoming M6）。
>
> 因此**驗收只斷言檔案位元組層**（見 U12），Excel 的型別推斷改列為 §11 已知限制，並在 README 附建議匯入方式（資料 → 從文字/CSV → 該欄指定為文字）。不把驗收綁在特定 Office 版本的行為上。

### 5.5 四態與競態（沿用 §8.7）

| 情況 | 行為 |
|---|---|
| `upcoming.json` 載入中 | 骨架列 + 「載入中」，不得顯示「無預告」 |
| 不可用（404／其他非 2xx／網路錯誤／逾時） | 錯誤狀態 + 重試鈕；徽章維持「預告」字樣（見 §7） |
| JSON 損毀、缺欄位，或**任一列不合法** | 同上，並於 console 記錄；**不部分渲染，不跳過壞列** |
| `upcoming.dataVersion ≠ meta.dataVersion` | 不渲染清單，且**匯出一併停用**，提示「資料已更新，請重新整理」 |
| `meta.json` 本身不可用 | 無法驗證版本 → 視同不可用，不得略過版本檢查逕行渲染 |
| 使用者快速切換 view | 丟棄過期回應，僅渲染最後一次請求 |
| `items` 為空陣列 | 「目前資料中無未生效的公告」＋資料產生日與最後檢查日（§2） |

**失敗必須分兩種，規則不同**（v0.2 把兩者寫成互相矛盾的規則，plan-verdict-r2 F6）：

| | **首次載入失敗**（尚無經驗證的快照） | **更新失敗**（已有經驗證的快照） |
|---|---|---|
| 網路／HTTP／逾時 | 不呈現清單，錯誤態＋重試 | **保留舊清單**，橫幅標「更新失敗，顯示的是 YYYY-MM-DD 的資料」；匯出**沿用舊快照**並於檔頭註明 |
| 內容不合法（§5.5.1） | 同上 | **不得保留**——清空清單並顯示錯誤，因為新資料證明來源已壞 |
| `dataVersion` 或 `generatorVersion` 不符 | 同上 | **不得保留**——顯示「資料已更新，請重新整理」，清單與匯出皆停用 |

- 保留舊清單時，**必須連同當時的 `buildDate`、版本與「更新失敗」標示一起保留**，不得配上新的成功狀態或新的最後檢查日
- 版本不一致與內容非法**優先於**保留規則

> v0.2 的 §5.5 寫「已成功渲染後重試又失敗 → 保留現有清單」，U10 卻把「成功後再失敗殘留舊列」列為應殺掉的弱化實作——**同一次編輯裡寫進了兩條互相矛盾的規則**，相同操作序列無法同時滿足。上表為定案。

**逾時**：fetch 以 `spec.md` §8.7 既有的 `TIMEOUT` 慣例設上限，不得無限等待。

### 5.5.1 「合法」的判準

v0.1 只寫「缺欄位」，會被實作成寬鬆解析（跳過壞列照樣渲染）（plan-verdict-upcoming M5）。完整判準：

| 層級 | 條件 |
|---|---|
| 檔案層 | `dataVersion`、`generatorVersion`、`buildDate`、`count`、`codeCount`、`items` 皆存在且型別正確 |
| 一致性 | `count` 等於 **原始完整 `items`** 的長度；`codeCount` 等於其中相異 `code` 數；`buildDate` 為合法 ISO date |
| 列層必要欄位 | `code`(str)、`effectiveDate`(ISO date)、`priceState`(§5.3 五種之一)、`eventType`(§5.4 十種之一)、`rawPrice`(str)、`everPriced`(bool)、`flags`(array) |
| **狀態與價格一致性** | `priceState = "priced"` ⟺ `price` 為正數；其餘四種狀態 `price` **必須**為 null |
| **`everPriced` 一致性** | `everPriced === (pricedBefore !== null)` |
| 日期關係 | `effectiveDate > buildDate`（本檔定義即未生效列）；`endDate` 為 null 或 ≥ `effectiveDate` |
| 合法 null | `endDate`、`price`、`previousPrice`、`pricedBefore`、`previousState`、`absoluteChange`、`percentChange` 可為 null |
| **合法缺值** | 描述欄位（品名／成分／規格／劑型／ATC／藥商）在「只有未來列」時為 **`null`**（不是空字串、不是省略鍵）；畫面顯示「—」 |

**任一列不合法 → 整份視為損毀**，不渲染、不匯出。理由同 (b) 威脅模型：靜默跳過一列，使用者看到的是一份看起來完整但其實缺項的清單。

> v0.2 只寫「缺欄位」與「六個欄位可為 null、其餘不可」，未閉合（plan-verdict-r2 F3）：`price` 沒有與 `priceState` 綁定（`priced + null`、`terminated + 正數` 都能通過字面檢查）；型別與列舉值未限定；而 U3 又要求「只有未來列時描述為缺值」，與「其餘不可為 null」直接衝突——**會讓合法資料被判為損毀**。在 B1 全有全無之下，一次錯誤驗證就擋掉整批發布。
>
> `count` 的比對對象必須是**原始完整 `items`**，不是經 `T`、篩選或去重後的集合；同代號同日多列也不得先合併。

---

## 6. 與既有功能的整合

| 既有元件 | 變更 |
|---|---|
| 搜尋卡預告標籤（§5.1） | 不變，資料來源仍為 `window` |
| 詳細頁摘要卡預告標籤（§8.2） | 不變 |
| 詳細頁 | 該代號依 history 判定有未生效紀錄時，新增一個**無條件**的「前往預告中心 ↗」入口 |
| `TFDA-drug-info-search` | 本階段不動；Phase 5 再考慮 |

**不得**讓詳細頁改讀 `upcoming.json` 取得預告資訊——詳細頁的單一真相仍是完整 history（§8.2）。

> v0.1 寫「若該代號**在預告清單中**」，等於要求詳細頁知道一份依 `D` 產生的清單成員資格，但同一段又禁止詳細頁讀 `upcoming.json`（plan-verdict-upcoming M7）。而且兩者跨日後本來就可能不一致：詳細頁依 `T` 判預告、清單依 `D` 產生。
>
> 改為無條件入口後，詳細頁只依自己的 history 決定要不要顯示入口，不宣稱該品項一定在當前清單裡。

---

## 7. 相容性

- `upcoming.json` 404（舊部署或尚未遷移）→ 徽章仍顯示「預告」；點擊後落到 §5.5 的不可用狀態＋重試鈕。**不另設一套 404 專屬徽章規則**（v0.1 的 §7「徽章不顯示」與 §5.5 的「徽章改為『—』」互相衝突，plan-verdict-upcoming M5）
- **Service worker：`upcoming.json` 與其他 `data/` 檔案一樣完全不經 SW。**

> v0.1 要求 `upcoming.json` 走 network-first ＋ 離線 fallback，直接違反既有設計（plan-verdict-upcoming B2）。`sw.js` 的 `if (url.pathname.includes('/data/')) return;` 是刻意的，檔頭寫明理由：藥價資料若從 SW 快取取得，會繞過 `dataVersion` 與過期警示的設計。
>
> 而且它與本規格 §5.5 互咬：離線 fallback 取到舊的 `upcoming.json`、`meta.json` 走網路取到新的 → 永久 `dataVersion` mismatch → 依 §5.5 永遠不渲染清單。離線時正確的行為是明確顯示「無法取得」，不是顯示一份無法驗證新鮮度的舊清單。

---

## 8. 效能目標

| 項目 | 目標 |
|---|---|
| 首屏**預告資料**傳輸增加 | **0 bytes**——未進入預告頁前不得 fetch `upcoming.json` |
| 首屏外殼增量（HTML／CSS／`engine.js`） | 無門檻，但**須實測記錄**於驗收文件 |
| `upcoming.json` gzip | < 20 KB（實測基準 82 列 ≈ 6 KB；500 KB raw 的 build WARNING 見 §3.5 不變） |
| fetch 開始 → 清單首次可捲動 | < 200 ms（CPU 4x throttle + Fast 4G，冷快取，不含 `meta.json`／字型） |
| 篩選／排序重繪 | < 50 ms |

> v0.1 寫「首屏成本增加 0 bytes（lazy fetch）」，字面不可驗收（plan-verdict-upcoming M8）：lazy fetch 只保證**資料**不載入，新增的 HTML、CSS 與共用 `engine.js` 的增量仍在首屏，原生 ES module 不會自動排除未使用的程式碼。因此把 0 bytes 精確限定在預告資料，外殼增量改為量測並記錄。
>
> gzip 門檻由 v0.1 的 100 KB 收到 20 KB：實測 82 列 ≈ 33 KB raw／6 KB gzip，100 KB 的門檻永遠不會紅，等於沒有守門作用。

### 8.1 量測契約

| 項目 | 定案 |
|---|---|
| 資料集 | 全量真實資料，**非空清單**（至少當期的 82 列） |
| 網路／CPU | CPU 4x throttle、9 Mbps／1.5 Mbps／60 ms、gzip level 6（同 E7 條件） |
| `meta.json` 前置 | **視為已完成**（首屏已載入），量測起點為點擊徽章那一刻 |
| 終點「可捲動」 | **版本驗證通過且完整清單已渲染**——骨架可捲動不算 |
| 次數與統計 | 每項 3 次取**中位數** |
| SW | 不涉及（`data/` 不經 SW） |

**gzip 門檻的性質**：20 KB 是**功能驗收**門檻，不是資料 guard。合法公告量成長導致超標時 → 驗收記錄為超標並**重新評估門檻**，**不得**因此刪減資料或擋下發布。資料層的 guard 仍是 §3.5 的 500 KB raw WARNING（不 fail）。

> v0.2 把效能目標升格為 U14 卻沒定義量測契約（plan-verdict-r2 F7）：「不含 meta」未說是預先完成還是事後扣除，而 §5.5 又禁止未驗版本就呈現清單；未固定樣本與統計量；gzip 收緊後合法成長該算什麼也沒交代。上表為定案。

---

## 9. 驗收條件（U1–U12）

比照 `.ai-review/plan.md` §5 的可證偽寫法。

**每一條都必須能回答「什麼樣的實作會讓這條通過但功能其實是壞的」，並把那個弱化版本堵死。** v0.1 的 U1–U12 全數未通過這個檢驗（plan-verdict-upcoming §3），以下為改寫後版本；每條附註它要殺掉的弱化實作。

| # | 斷言 | 殺掉的弱化實作 | 測試位置 |
|---|---|---|---|
| **U1** | 以凍結快照與固定 `D`，`items` 與「完整 history 中所有 `from > D` 的 record」**雙向逐筆對應**：無多、無漏、重數相同，且每筆所有欄位相符。同驗 `count`／`codeCount` 與 `items` 自洽；`from = D` 的列**必須被排除**；`invalidRecords` 必須被排除。預期值**不得由待驗生成器產生** | 只支援快照裡那 3 個代號；或預期 fixture 與輸出由同一套錯誤邏輯產生，逐欄比對照樣全綠 | `tests/test_upcoming.py` |
| **U2** | 合成 fixture 含「同代號 3 筆未生效紀錄」與「同代號同日 2 筆**不同**紀錄」（須確保是上位去重規則會保留的不同紀錄，否則會被消除而測不到），全部列出且逐筆比對起迄日、`rawPrice`、事件與重數。另以全量資料斷言 `X000342121`、`X000346219`、`X000359219` 的**全部**未生效列都在 | 只遍歷凍結快照 → 測試根本不執行（快照 11 碼無一有多筆未生效列）；或只驗列數，漏一列再重複另一列 | `tests/test_upcoming.py` |
| **U3** | 描述欄位以 §6.6 規則、以 `D` 選列：覆蓋 (a) `D` 有有效列、(b) `D` 落在空窗取最近過去列、(c) 只有未來列時描述為缺值、(d) 同起日不同描述依 `recordIndex` 選列。**比對全部描述欄位的值**，不只斷言污染字串不存在。真實案例 `BC26467100` 另列一條 | 特判 `BC26467100`；或所有代號永遠取第一筆描述——該案例仍會通過 | `tests/test_upcoming.py` |
| **U4** | **§4.1 的 14 個序號每一個都要有合成案例，斷言標籤與副標精確字串**。至少含：序 4 的三種 `eventType`（`initial`／`unchanged`／`terminated`，後者例如「暫停後轉 0 元」）；序 5／8 的續期**必須顯示 `pricedBefore` 金額**；序 11 恢復支付**必須顯示差額與百分比**；序 1／2／3／14 必須顯示「無法判定」而非確定事件。另含「曾有價後終止」的**正對照**，標籤必須含「終止」 | 回傳空字串即可不含「終止」；或把所有終止一律改稱 0 元；或通過首列 0 元測試，卻把續期前價全省略、恢復支付差額省略、`unknown` 顯示成確定事件 | `tests-js/upcoming.test.mjs` |
| **U5** | 兩次**獨立乾淨** build，固定 `D` 與檢查時間、來源列順序不同 → 產出正確且位元組相同。**反向哨兵須指名**：改動 `AB47689100` 的 2026-10-01 那筆價格 → 斷言 `items` 中該筆的 `price`／`rawPrice`／`absoluteChange`／`percentChange` **精確變成預期新值**，不只斷言「檔案不同」 | 完全不寫檔、固定輸出空檔、第二次沿用第一次結果，三者都 byte-identical；反向哨兵只靠 `dataVersion` 改變就通過，upcoming 的價格內容其實沒變 | `tests/test_build.py` |
| **U6** | **兩種失敗都要注入**：(a) `build_upcoming()` 拋例外、(b) 生成成功但**驗證**拒絕 → 皆 exit 非 0，`data/` 與 `status.json` 全部位元組不變、**檔案集合也不增減**、無任何發布。另有合法輸入成功發布的正對照 | 只處理拋例外，卻在「生成成功、驗證失敗」時繼續發布；或在已有檔案的目錄中拋錯後什麼都不做，檔案仍在而被當成「正常寫入」 | `tests/test_build.py` |
| **U7a** | 例行三路徑，每條都比對**該 `D` 的完整預期 items 內容**與發布結果：來源無變且未跨生效日 → 不變；來源無變但 `D` 跨過生效日 → 與 `drug_index.json` 一起更新，且**剛生效的那列必須已從 items 移除**；來源有變 → 內容與新 history 一致 | 跨日分支只改了 `buildDate`／版本而沒移除剛生效的列，日期錯誤被版本變動掩蓋 | `tests/test_build.py` |
| **U7b** | 三條遷移路徑分開驗：(a) 已發布版本無 `upcoming.json` 且來源未變 → 產出**且進入 commit**；(b) 已發布版本有舊檔但 `generatorVersion` 不符 → **重產且進入 commit**；(c) 遷移中失敗 → 不推進完成狀態，下次執行仍視為未完成。三者皆斷言 `git diff --staged` 實際包含 `data/upcoming.json` | 「只在檔案不存在時生成」即可通過——已有舊檔則永不遷移；或產出了檔案卻沒進 commit（`build-data.yml:58` 的無差異分支只 commit `status.json`） | `tests/test_build.py` |
| **U8** | 固定系統時間於生效日**前一天／當天／後一天**各跑一次，每次斷言**完整的列集合**：未到期列仍為預告、到期列改標「已生效（本站資料尚未重建）」但**價格與事件不變**。另驗混合、全數到期、真正空清單、**`T < D`** 四種情形。並驗「最後檢查日很新」時不得壓掉到期提示 | 所有列永遠標「已生效」；或只保留測試指名的那一列；或完全忽略 `T < D` 仍通過其餘案例 | `e2e/upcoming.spec.mjs` |
| **U9** | 以「兩條件皆符合／只符 `type`／只符 `atc`／皆不符」四類資料，斷言呈現結果**精確等於交集**（不只檢查下拉選項的值）。**§4.1.1 映射表的 8 個 `type` 值每個都須有正例與排除例**，含 `first_priced`（序 4 首列 0 元必須在此類、不得在 `terminated`）與 `other`。`q`／`date`／`sort` 依 §5.3 契約分別驗重整、分享、返回與組合；無效值回預設 | 只支援 `decrease`／`increase` 的交集，`initial`／各種 `unchanged`／`unknown` 歸類全錯仍通過；只還原下拉選項而結果顯示全部或全空 | `e2e/upcoming.spec.mjs` |
| **U10** | **依 §5.5 的兩種失敗分別驗**。首次載入失敗：404／非 2xx／網路中斷／逾時／損毀 JSON／合法 JSON 但一列不合法，六種皆不得呈現清單或匯出。更新失敗：網路類須**保留舊清單並標示舊 `buildDate`**；內容非法與版本不符須**清空**。第一次失敗、第二次成功 → 須實際恢復完整結果。另驗延遲的舊回應不得覆蓋新畫面 | 顯示錯誤與重試鈕但重試無效；壞列被靜默跳過；或把兩種失敗混為一談（v0.2 的 §5.5 與 U10 曾互相矛盾） | `e2e/upcoming.spec.mjs` |
| **U11** | 版本不一致時清單與**匯出皆不可用**；一致且合法時完整呈現。分別注入：舊 upcoming／新 meta 的 `dataVersion` 不符、反向組合、缺 `dataVersion`、`meta.json` 不可用，以及 **`dataVersion` 相同但 `generatorVersion` 不符**（同來源的規則遷移）。重新取得一致資料後須恢復 | 舊規則產物與新 meta 的 `dataVersion` 相同，被當成一致資料照常呈現；或永遠顯示「請重新整理」；或只在首次載入比對版本 | `e2e/upcoming.spec.mjs` |
| **U15** | **合法缺值必須被接受**：只有未來列的代號，描述欄位為 `null` → 載入成功、畫面顯示「—」、CSV 輸出空欄。反向：`priced + price=null`、`terminated + price=正數`、`everPriced` 與 `pricedBefore` 不一致 → **整份判為損毀** | §5.5.1 的驗證器把合法缺值誤判為損毀，在 B1 之下擋掉整批發布 | `tests-js/upcoming.test.mjs` |
| **U12** | 解析匯出的 CSV 後**逐列逐欄**對應篩選結果，含順序與重數；資料列數排除前言與標頭。內容必含 `12.50`、`0.00`、三種暫停標記（`-`／`－`／`—`）、空值、逗號、引號、換行與中文，斷言原始字串保真與 RFC 4180 跳脫；BOM 存在 | 每列都重複第一筆，總數仍相等；所有 `rawPrice` 輸出 `"0"`；加上引號就自稱「文字欄位」 | `tests-js/upcoming.test.mjs` |
| **U13** | §5.2 分組標題的品項數等於該批次實際呈現列數；`flags` 非空的列必有品質提示 chip，且歸屬正確的代號；行動裝置寬度下免責聲明全文可見 | 元件測試全過，但整合時分組計數與清單脫節 | `e2e/upcoming.spec.mjs` |
| **U14** | §8 效能依 §8.1 的定案量測契約實測並記錄。終點定義：**「可捲動」＝版本驗證通過且完整清單已渲染**，不是骨架可捲動 | 以空清單／少量資料量測；或讓骨架提前可捲動就報達標；或只報 JS 工作完成而非實際可互動 | `.ai-review/upcoming-acceptance.md` |

### 9.1 母體不足，必須用合成 fixture 的條件

以 `D = 2026-09-11` 重算全量 history 確認（Codex 與覆核者各自獨立得到同一組數字）：

| 事實 | 影響 |
|---|---|
| 未生效 `terminated` 共 62 列，`everPriced = false` 者 **0 列** | **U4 在真實資料裡沒有任何實例**，人工目檢也驗不到 → 必須合成 |
| 有 ≥2 筆未生效紀錄的代號只有 3 個，且**全不在凍結快照的 11 碼內** | **U2 用快照會整條跳過** → 必須合成，或擴充快照母體 |
| 全量未生效事件只有 `terminated`／`increase`／`decrease`／`unchanged` 四種 | §4 決策表中 `first_priced`、`suspended`、`relisted`、`missing`、`malformed`、衝突六類**零實例** → 逐條指名反例補足，**不得以「掃完 82 列」代替** |
| 失敗、到期、混批條件不會自然出現 | U6／U8／U10／U11 一律主動注入 |

擴充凍結快照母體時，**母體不可縮成剛好等於子集**；改完須用反向哨兵證明重現得了原本那批紅。

### 9.2 人工項目

**臨床藥師目檢**（比照 C2）一次完整清單 ＋ **上表指名的合成反例**，確認：

1. 無 §4 禁止用語
2. 無「終止／0 元」標籤誤用（特別是 `everPriced = false` 的合成案例）
3. 實際呈現的列數等於預期集合，不是「看起來有資料就算過」

---

## 10. 實作順序（建議 commit 切分）

| 序 | commit | 內容 | 可獨立驗證 |
|---|---|---|---|
| 1 | `feat(data): emit upcoming.json` | `lib/history.py` 新增 `build_upcoming()`、meta 欄位、guards（全有全無）、首次交付路徑、U1–U3、U5、U6、U7a、U7b | `uv run pytest -q` |
| 2 | `feat(ui): upcoming view skeleton` | 路由、徽章、lazy fetch、§5.5 各態與合法性判準、U10、U11 | `npm run e2e` |
| 3 | `feat(ui): upcoming labels` | §4 呈現決策表、§4.2 金額取用、U4、U13 | `npm test` |
| 4 | `feat(ui): upcoming filters and grouping` | 分組、篩選、排序、URL 序列化、日期語意、U8、U9 | `npm run e2e` |
| 5 | `feat(ui): upcoming csv export` | U12 | `npm test` |
| 6 | `chore: upcoming performance measurement` | U14，結果寫入 `.ai-review/upcoming-acceptance.md` | — |
| 7 | `chore: pharmacist review of upcoming labels` | 人工目檢紀錄（含合成反例）寫入 `.ai-review/` | — |

第 1 步完成即可線上驗證資料正確性，UI 未上線前不影響既有使用者。

---

## 11. 已知限制（須寫入 README）

1. 清單僅涵蓋健保署 CSV 中**已公告且尚未生效**的紀錄；健保署尚未寫入該檔的公告不會出現。
2. 資料每週檢查一次，官方月更；跨越生效日時清單會暫時落後，以標籤與到期提示標示。
3. 同一代號的多筆預告皆列出，**不合併**、不判斷何者「最終生效」。
4. 預告列的描述欄位取自 build 日有效列，非預告列本身；若品名在生效時一併異動，本站會落後一個 build 週期。
5. **「資料產生日」與「最後檢查日」是兩個不同的日期**，兩者相差數週屬正常。產生日只在來源有變、build 日跨過預告生效日、或版本遷移時才前進。
6. **CSV 的欄位型別由試算表軟體自行推斷**，本站無法控制。Excel 直接開啟可能把 `0.00` 顯示為 `0`、把代號當成科學記號。需要原值時請用「資料 → 從文字/CSV」匯入並將該欄指定為文字。檔案本身的位元組內容一律保真。

---

## 12. 修訂紀錄

| 版本 | 日期 | 修訂內容 | 依據 |
|---|---|---|---|
| v0.1 | 2026-09-14 | 初版 | — |
| v0.2 | 2026-09-14 | 第一輪覆審後修訂 | `.ai-review/plan-verdict-upcoming.md` |
| v0.3 | 2026-09-14 | 第二輪覆審後修訂 | `.ai-review/plan-verdict-r2.md` |

### v0.2 逐項

| 改動 | 依據 |
|---|---|
| §3.4 ＋ U6：預告產生／驗證失敗改為 exit 1、整批不發布（原為「其餘照常發布」＝部分發布，與 `plan.md` B8 全有全無契約衝突，且會讓舊 upcoming ＋ 新 meta 觸發 §5.5 而鎖死功能） | B1（Blocker） |
| §7：刪除 `upcoming.json` 的 SW network-first ／離線 fallback，改為與其他 `data/` 一樣完全不經 SW | B2（Blocker） |
| §4：標籤表主鍵由 `eventType` 改為 `priceState × 此前有無 priced`；補 `initial`、`missing`、`malformed`、衝突；修正「終止／暫停續期」被誤標為「價格未變」。新增 §4.2 金額取用規則（`relisted` 須呈現既有差額；暫停標記顯示實際 `rawPrice`，不寫死 `-`） | H1、M1 |
| §3.3：刪除「來源無變 → 不動 upcoming.json」，只保留「與 `drug_index.json` 同進退」（兩條在跨生效日時答案相反，而那正是最需要更新的時刻）。**未動上位 `plan.md` B5** | H2（部分接受，修正 Codex 的歸因與修法） |
| §3.3.1：新增首次交付與版本遷移路徑；對應新增 U7b | H3 |
| §5.1 ＋ §7：徽章未載入前只顯示「預告」不帶數字；**不新增** `upcomingRows` 到 `status.json`（原設計 D 基準與 T 基準混用會使數字跳動，且 §3.4／§5.1／§7 對該欄位該放哪自相矛盾） | M2 |
| §2：新增「資料產生日 vs 最後檢查日」對照，到期提示獨立於過期警示；補 `T < D` 分支 | M3 |
| §5.3：篩選／排序改為完整參數契約（合法值、預設、無效值、AND 關係、`other` 集合定義、幅度取絕對值、`change_desc` 取消分組） | M4 |
| §5.5 ＋ §5.5.1：補「合法」的四層判準；任一列不合法即整份視為損毀；統一 404 徽章規則；補 `meta.json` 不可用與「已渲染後重試失敗」 | M5 |
| §5.4 ＋ U12 ＋ §11.6：CSV 驗收改為位元組層斷言，Excel 型別推斷降為已知限制 | M6（部分接受） |
| §6：詳細頁改為無條件的「前往預告中心」入口，不判斷清單成員資格 | M7 |
| §8：0 bytes 精確限定為「預告資料」；外殼增量改為量測記錄；gzip 門檻 100 KB → 20 KB | M8 |
| §9：U1–U12 全面改寫為堵死弱化實作的斷言，每條附註所殺的弱化版本；U7 拆為 U7a／U7b；新增 U13（整合）、U14（效能）；新增 §9.1 母體不足清單（U2／U4 必須合成 fixture）與 §9.2 人工項目 | 驗證策略全項、M9 |
| §10：實作順序依新增的 U7b／U13／U14 重新切分為 7 步 | 連動 |

### v0.3 逐項（第二輪覆審後）

依 `.ai-review/plan-verdict-r2.md` 第一部分。**其中 2 項是 v0.2 修訂本身製造的新洞**（F1、F6）。

| 改動 | 依據 |
|---|---|
| §3.1 新增 `pricedBefore` 欄位（狀態語意），`everPriced` 改為其衍生值。v0.2 的 §4.1 要求「終止／暫停續期顯示停止前金額」，但 `spec.md` §5.4 序 3／5 明定該情形 `previousPrice` 就是 null——**實測 52 + 24 = 76 列受影響，資料根本不在 record 上**。同 Phase 2 在 index window 踩過的坑，`engine.js:151` 已有現成 `pricedBefore()` | F1（High，自造洞） |
| §4.1 改為 14 序的**互斥優先序表**（比照 `spec.md` §5.4 寫法），異常置前、序 14 為安全網。v0.2 的三欄並列表**不窮盡**：`[10, missing, 12]` 的末筆落不進任何一列，而 `plan.md` A3 已把它列為必過案例；亦**不互斥**：帶 `conflicting_price_interval` 的 `priced` 同時符合兩列。序 1 同時檢查 flag 與 `eventType = unknown`（後者涵蓋更廣） | F2（High） |
| §4.1.1 新增篩選分類映射表，`type` 以 §4.1 序號為唯一依據。v0.2 讓標籤與篩選各用一套分類，首列 0 元會被歸進「終止支付」或在具名選項中消失 | F2（High） |
| §3.3.1 補**發布完成的定義**。已核實 `build-data.yml:58` 的無差異分支只 commit `status.json`——**產出檔案 ≠ 發布檔案**，首次上線當天若 index 未變，新檔會留在工作目錄進不了 commit。改為強制進入有差異分支、與 meta 同批 commit 才算完成 | F4（High） |
| §3.3.2 新增 `generatorVersion` 字串常數。規則修正時 `dataVersion` 不變，舊產物與新 meta 版本相等且都通過結構驗證，U11 偵測不到。**刻意限制在一個欄位**，不動 `dataVersion`／shard／SW | F5（High，部分接受——Codex 標 `[新增需求]`，採最小形式） |
| §5.5 把失敗**拆為「首次載入失敗」與「更新失敗」**兩張規則。v0.2 的 §5.5「保留舊清單」與 U10「殘留舊列＝應殺掉的弱化實作」是**同一次編輯裡寫進的兩條矛盾規則**。定案：網路類保留舊快照並標示舊 `buildDate`；內容非法與版本不符一律清空 | F6（Medium，自造洞） |
| §5.5.1 補完合法性契約：`price` 與 `priceState` 綁定、`everPriced` 與 `pricedBefore` 一致、型別與列舉值、日期關係、**合法缺值定為 `null`**。v0.2 的「六個欄位可為 null、其餘不可」與 U3 的「只有未來列時描述為缺值」直接衝突，會讓合法資料被判損毀——在 B1 之下擋掉整批發布 | F3（Medium） |
| §3.2 排序補第四鍵「原 records 索引 asc」。前三鍵無法區分同代號同日同事件的多列，輸出順序會隨來源列順序改變 | 驗證策略 U2 |
| §8.1 新增量測契約（資料集、meta 前置、終點定義、統計量）；明定 gzip 20 KB 是功能驗收門檻而非資料 guard，合法成長不得導致刪資料或擋發布 | F7（Medium） |
| §2、§11.5 修正「資料產生日」的說明：改為「目前已發布的這份 upcoming 是哪一天產生的」，並列出三種會使它前進的情形 | F8（Low） |
| §9：U2／U4／U5／U6／U7a／U7b／U8／U9／U10／U11／U14 依第二輪指出的弱化實作再次改寫；新增 **U15**（合法缺值必須被接受，反向驗非法組合被拒） | 驗證策略全項 |

### 覆審歷程

| 輪次 | Codex thread | 原始輸出 | 判定 | 結果 |
|---|---|---|---|---|
| 1 | `01a09eff` | `plan-review-upcoming.md` | `plan-verdict-upcoming.md` | Blocker 2、High 4、Medium 9 |
| 2 | `01a09f1c` | `plan-review-upcoming-r2.md` | `plan-verdict-r2.md` | **無新 Blocker**；High 4、Medium 3、Low 1 |
