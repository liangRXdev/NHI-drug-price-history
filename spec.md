# NHI Drug Price History

> 台灣健保藥價歷史查詢 — Product & Technical Specification
>
> 建議 repository：`liangRXdev/NHI-drug-price-history`
>
> 修訂紀錄：
> - v0.1 初稿
> - v0.2（2026-09-11）依實際 CSV profiling（§3.1）與需求確認結果修訂：價格狀態語意、預告區間、調價次數定義、資料過期警示、Phase 1 golden 驗收
> - v0.3（2026-09-11）依 `/codex-checkplan` 覆核結果（`.ai-review/plan-verdict.md`）修訂：詳細頁改由完整 history 推導、事件互斥優先序、invalidRecords、dataVersion、描述欄位變體、前端失敗狀態、workflow 並行
>
> 文件分工：**資料模型與規則以本文件為準；驗收條件以 `.ai-review/plan.md` §5（A1–E7）為準。**

## 0. Architecture Decision

### 決策

本專案**建立新的 repository**，不直接併入 `TFDA-drug-info-search`。

- `TFDA-drug-info-search`：TFDA-first、current-state、快速藥品資訊查詢。
- `NHI-drug-price-history`：NHI-first、time-series、健保支付價歷史分析。
- 兩者共用部分 NHI ETL 邏輯，但資料輸出、前端互動與效能需求不同。
- 舊專案未來僅增加 deep link，例如由 `nhiDrugCode` 開啟本專案的價格歷史頁。

### 關鍵資料策略

**不要以 `TFDA-drug-info-search` 的 Git commit history 作為主要歷史資料來源。**

現有 `build_data.py` 已從健保署下載完整 NHI CSV，而該 CSV 本身就包含同一藥品代號的歷次紀錄（`支付價`、`有效起日`、`有效迄日`）。舊專案為了 current-state 查詢，會將同一藥品代號的歷史列收斂成「今天有效的最新一筆」。

本專案應直接重用相同 NHI data source，但在 ETL 階段**保留完整歷史列**。

Git history 僅作為 repository audit trail，不作為 price-history database。

---

## 1. Product Goal

建立一個純前端、可部署於 GitHub Pages / Cloudflare Pages 的「台灣健保藥價歷史查詢」工具，讓藥師或其他使用者能快速回答：

1. 某個健保藥品代號目前支付價是多少？
2. 過去曾調整過幾次？
3. 每次調價的生效日期與幅度為何？
4. 最新一次是漲價、降價、停止支付，還是重新納入？
5. 從最早可取得紀錄到現在，支付價總變化多少？
6. 同一藥品代號是否存在未連續的支付期間？

核心定位：

> Government Open Data → longitudinal history → pharmacist-readable price timeline

---

## 2. Terminology

UI 與文件統一使用：

- **健保支付價**：來源欄位 `支付價`。
- **有效起日 / 有效迄日**：某筆支付價紀錄的適用區間。
- **藥品代號**：NHI drug code；本專案的主要 identity key。
- **有效區間**：閉區間 `[有效起日, 有效迄日]`，兩端皆含當日；迄日 `null` 表示無迄日。
- **現行支付價**：目前日期落在有效區間內的紀錄之支付價。「目前日期」＝瀏覽器本地日期，於頁面載入與每次選定藥品時取用，不做跨午夜自動更新（UI 標示參考日期）。
- **參考日期**：摘要統計的截止日。index（搜尋卡）＝ build 日；詳細頁＝瀏覽器本地日期。
- **終止支付**：來源 `支付價` 為 `0` / `0.00`。依 NHI 慣例（臨床藥師確認）代表健保支付終止。
- **暫停支付**：來源 `支付價` 為 `-`、`－`、`—`。依臨床藥師判斷「應為」暫停支付；因非 100% 確定，UI 一律併列原始標記（見 §5.3）。其他非數字標記（`N/A`、`NA`、`無` 等）不在此判斷範圍內，歸為 `malformed`。
- **預告**：`有效起日` 晚於目前日期的紀錄（已公告、尚未生效）。

### 禁止用語

不可將健保支付價描述為：

- 醫院實際採購價
- 市售零售價
- 病人實際自付價格
- 藥品的 normalized cost per mg

除非另有資料來源與明確換算規則。

UI 必須顯示：

> 「本系統顯示中央健康保險署公告之健保支付價，不代表醫療院所實際採購價、零售價或病人自付金額。」

---

## 3. Official Data Source

### Primary source

中央健康保險署「健保用藥品項查詢項目檔」

- resource ID：`A21030000I-E41001-001`
- 下載端點：`https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001`
- 格式：CSV，UTF-8 with BOM，約 96 MB
- 更新頻率：每月
- 來源資料包含歷次紀錄（已實測證實，見 §3.1）
- 目前資料規模約 22 萬筆以上；實際筆數每次建置重新計算，不寫死於 UI

### Source metadata（官方資料更新日）

下載端點的 HTTP 回應**不含** `Last-Modified`，官方更新日改由 data.gov.tw 資料集 metadata 取得：

- 端點：`GET https://data.gov.tw/api/v2/rest/dataset/23715`（免 API key；搜尋端點才需 key）
- 使用欄位：`result.modifiedDate`（例：`2026-08-28 07:05:11`）
- UI 標示為「data.gov.tw 資料集更新時間」，不宣稱為 CSV 內容的精確異動時間
- 取得失敗（非 200、欄位缺漏）：build log 明確記 warning，欄位存 `null`，UI 顯示「無法取得」；**不使 build 失敗**（非核心資料）
- 同一 metadata 的 `coverageStartedDate`（2015-11-11）與實際資料不符，**不可採用**

### 主要欄位

CSV 共 20 欄。至少保留：

- `異動`
- `藥品代號`
- `藥品英文名稱`
- `藥品中文名稱`
- `成分`
- `規格量`
- `規格單位`
- `單複方`
- `支付價`
- `有效起日`
- `有效迄日`
- `藥商`
- `製造廠名稱`
- `劑型`
- `藥品分類`
- `分類分組名稱`
- `ATC代碼`
- `給付規定章節`
- `藥品代碼超連結`（實測指向 **TFDA** `lmspiq.fda.gov.tw` 許可證頁，非健保署頁）
- `給付規定章節連結`（健保署給付規定 PDF；約 41.5% 有值）

### Coverage rule

不可假設歷史資料起始於政府資料集上架日。

每次 build 應由實際資料計算：

- `coverageStart`
- `coverageEnd`
- `sourceRowCount`
- `uniqueDrugCodeCount`

並寫入 `data/meta.json`。

### 3.1 實測特性（2026-09-11 profiling）

以下為單次實測結果，作為設計依據；**不寫死於程式或 UI**，build 時仍須重新計算並以 guard 檢查。

| 項目 | 實測值 | 設計影響 |
|---|---|---|
| 列數 / 欄數 | 224,811 列 / 20 欄；欄位數異常列 0 | — |
| 唯一藥品代號 | 45,179（全部 10 碼） | — |
| 有效起日範圍 | 1995-03-01（健保開辦日）～ 2028-10-01；14,044 個代號自 1995-03-01 起算 | 「完整歷史」前提成立 |
| 日期格式 | 僅民國 6 碼（**前綴空白**，如 `"  860301"`）或 7 碼；無西元、無空白、無無效值 | 解析前必須 strip |
| 開放迄日 | 每個代號**恰好 1 列**為 `9991231`；無空白迄日 | `9991231` → `null`（§6.1） |
| 支付價 | 有價 187,656 / `0.00` 36,180 / `-` 975 / 空白 0 / 無法解析 0 | §5.3 |
| 現行狀態（每代號） | 有價 13,808 / **終止 31,324（69%）** / 暫停 47 / 無現行區間 0 | 終止為主流狀態，非邊界 |
| 狀態轉換 | 有價→終止 32,444；終止→有價 4,742；有價→暫停 936；暫停→有價 622；暫停→終止 282 | 恢復支付為常見事件 |
| 首列即為 0 元 | 3,387 個代號（其中 3,385 個之後首次有價） | 需 `first_priced` 事件（§5.4）與首列 0 元標籤例外（§5.3） |
| 同價續期 | 1,564 對相鄰區間 | `unchanged` 為真實事件 |
| 區間連續性 | 179,630 對相鄰區間皆為「前段迄日 +1 日」；overlap 0；gap 僅 2 個代號（`A035680329` 缺 1 個月、`BC23981100` 缺 12 個月） | overlap/gap 偵測保留作防護 |
| 重複 / 衝突 | 完全重複 0；同區間不同價 0 | 偵測保留作防護 |
| 預告列 | 82 列 / 79 個代號；其中 62 列為轉 0 元（預告終止）；最遠 2028-10-01 | §5.1 window、§8.2 預告標籤 |
| `異動` 欄 | `Y` 共 2,963 列，每代號至多 1 列，多為早期列；語意不明 | 原值保存，不推導事件 |
| 描述欄位 | 同代號所有列的品名／藥商／ATC 相同（以現況回填，非歷史值）；唯一例外 `BC26467100` 最新（預告）列之成分欄損毀 | metadata 取 build 日有效列（§6.6） |
| 字元損毀 | 來源含字面 `?`（罕用字遭上游替換，例 `BC22198212`「萬?特…葡萄?腹膜透析液」）；品名或成分含 `?` 的代號共 422 個 | 統計並 log，不自行補字（§6.7） |
| 規格量 / 規格單位 | 填寫率 47.4% | UI 須容許空值 |
| 分片（實際輸出） | 前 2 碼時 `A0` 單片 gzip 3.35 MB / raw 35.7 MB（超過 warning）；改前 4 碼共 348 片，最大 `AC49` gzip 0.14 MB / raw 1.47 MB | §7 |
| search index（實際輸出） | gzip 3.14 MB / raw 29.35 MB（含 window 完整 record 欄位） | §16；raw 偏大，Phase 2 須實測解析時間 |

---

## 4. Reuse from `TFDA-drug-info-search`

### 可直接重用或抽出

從現有 `build_data.py` 抽出至 `lib/nhi.py`：

- `download()`
- `is_retryable()`
- `smart_decode()`
- `classify_roc_date()`
- retry / TLS / timeout logic

### 抽出後必須改寫

| 既有函式 | 問題 | 本專案作法 |
|---|---|---|
| `fetch_nhi_csv()` | 失敗時印錯誤後回傳 `[]`，下游可能把空資料當正常 | 失敗一律 raise，由 build 中止（§13）；HTTP 200 的內容也必須通過內容驗證（非 CSV、HTML 錯誤頁、截斷 → raise） |
| `detect_field()` | 模糊比對命中多個候選時只警告，採第一個 | 必要欄位（`藥品代號`、`支付價`、`有效起日`、`有效迄日`）出現歧義 → raise；非必要欄位維持警告 |
| `NO_PRICE_MARKERS` | 含 `N/A`、`NA`、`無`，但藥師的「暫停支付」判斷只針對 `-` | 拆分：`SUSPENDED_MARKERS = {"-", "－", "—"}`；其餘歸 `malformed` |
| `parse_roc_date()` | 無 `9991231` 哨兵處理；無西元備援 | 新增 `9991231` → `null`；保留 8 碼西元備援作防禦（實測未出現） |
| `price_value()` | 無法解析或空白一律回 `0.0`，混淆終止／缺值／格式錯誤 | **不沿用**；改寫為 `classify_price(raw) -> (price, state)`（§5.3） |
| `price_is_malformed()` | 語意可併入 `classify_price()` | 併入 |
| `nhi_is_current()` | 僅供 build 時決定 index window；前端另行判定現行價 | 保留，限 build 用途 |

### 必須修改的既有邏輯

舊專案會：

1. group by `藥品代號`
2. 只挑目前有效的紀錄
3. 多筆現行資料取 `有效起日` 最新者
4. 將 `支付價 <= 0` 或無價格標記排除

上述策略**不可直接沿用至 history dataset**。

本專案應：

- 保存所有有效歷史列
- 保存 `0`、`-`、空白等非正常數字價格狀態
- 將其標準化為明確 state，而非整筆刪除
- current-state 僅作為 derived summary

---

## 5. Data Model

### 5.1 Search index

`data/drug_index.json`

**僅供搜尋頁與搜尋卡使用**。詳細頁一律由完整 history（§5.2）推導，不讀 index 的摘要欄位（避免 index／history 雙重真相）。

每個 `藥品代號` 一筆，僅保留搜尋與搜尋卡所需欄位。

```json
{
  "dataVersion": "sha256:<meta.shards.versions 的 hash>",
  "drugs": [
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
      "window": [
        { "from": "2024-08-01", "to": "2026-09-30", "price": 245.0, "rawPrice": "245.00",
          "priceState": "priced", "eventType": "unchanged", "previousPrice": 245.0,
          "absoluteChange": null, "percentChange": null, "crossesStop": false, "flags": [] },
        { "from": "2026-10-01", "to": null, "price": null, "rawPrice": "0.00",
          "priceState": "terminated", "eventType": "terminated", "previousPrice": 245.0,
          "absoluteChange": null, "percentChange": null, "crossesStop": false, "flags": [] }
      ],
      "historyCount": 6,
      "priceChangeCount": 3,
      "firstEffectiveDate": "2015-01-01",
      "lastPriceChangeDate": "2019-05-01",
      "flags": []
    }
  ]
}
```

- `window` 每筆與 §5.2 的 record 同構（含 `rawPrice`、`eventType`、`previousPrice`），另加 `pricedBefore`；搜尋卡的「暫停支付（`-`）」、「終止前 X 元」、「調整為 X 元（±Y%）」皆由此取得。
- `pricedBefore`（僅 index window）：該列**之前**最後一個 `priced` 金額，無則 null；只看排序在前的列，不受未來恢復支付影響。搜尋卡的「終止前／暫停前 X 元」取此值，並以它是否為 null 判斷首列 0 元例外（§5.3）。理由：「終止→終止續期」的 `eventType` 為 `unchanged`、`previousPrice` 為 null（§5.4 序 3），搜尋卡只有 window 無法回看歷史（Phase 2 實作時發現，2026-09-12 實測 45 個代號受影響）。詳細頁有完整 history，不需此欄。
- `flags`（代號層）：`gap`、`overlap`、`conflict`、`invalid_records`、`question_mark`、`inconsistent_metadata`；供搜尋卡顯示品質提示。
- 描述欄位依 §6.6 規則以 build 日選列。
- `historyCount`、`priceChangeCount`、`lastPriceChangeDate` 以 **build 日為參考日期**（§5.5）。
- `historyCount`＝records＋invalidRecords 數（與詳細頁表格列數一致）；`lastPriceChangeDate`＝已生效紀錄中最後一個 `eventType ∉ {initial, unchanged}` 者的起日（含終止、暫停、恢復）。

#### `window` 組成（build 日 D）

| 情況 | `window` |
|---|---|
| D 有有效區間 | [D 有效區間, 最早的 `from > D` 區間（若有）] |
| D 有多筆有效區間（衝突／重疊） | [排序第一筆（帶 `conflict` flag）, 最早未生效區間（若有）] |
| D 無有效區間、有未來區間 | [最早的 `from > D` 區間] |
| D 無有效區間、無未來區間 | [] |

#### 搜尋卡判定（瀏覽器本地日期 T）

| 情況 | 搜尋卡顯示 |
|---|---|
| T 落在某筆 window 區間內 | 該筆的價格或狀態標籤；若其後還有 window 區間 → 附預告標籤 |
| T 當日有兩筆以上 window 區間有效（build 後預告生效又與現行重疊），或該筆帶 `conflict`／`conflicting_price_interval` flag | 「來源紀錄衝突，無法判定單一支付價」 |
| 該筆只帶 `overlap` flag（重疊對象可能不在 window 內） | 「來源紀錄區間重疊，請開啟詳細頁確認」，不顯示確定價格 |
| window 中非有價列缺 `pricedBefore`（舊版 index） | 「需更新，請開啟詳細頁」，不顯示確定價格 |
| T 早於 window 第一筆的 `from` | 「尚未生效；YYYY-MM-DD 起 …」（D 無有效區間時）或「此日期無支付紀錄」 |
| T 晚於 window 最後一筆的非 null `to`（**window 耗盡**） | 「需更新，請開啟詳細頁」，**不得顯示任何確定價格** |
| `window` 為空 | 「目前無有效支付紀錄」 |

build 日後、下次 build 前跨過預告生效日時，搜尋卡的 `priceChangeCount` 可能暫時少算 1 次；詳細頁不受影響（由 history 以 T 重新計算）。

### 5.2 Historical records

保留每個藥品代號的完整 normalized intervals。shard 檔結構：

```json
{
  "shardVersion": "sha256:<本片 drugs 內容的 hash>",
  "drugs": {
    "A123456100": {
      "meta": { "chName": "…", "enName": "…", "ingredient": "…", "strength": "…",
                "strengthUnit": "…", "dosageForm": "…", "atcCode": "…", "manufacturer": "…",
                "tfdaLink": "<藥品代碼超連結>", "nhiRuleLink": "<給付規定章節連結或 null>" },
      "records": [ "…見下…" ],
      "invalidRecords": [],
      "flags": []
    }
  }
}
```

- `meta`：同代號所有列的描述欄位一致時使用。**不一致時**改為 `metaVariants: [{ "from": "<該變體首次出現之 record from>", "recordIndex": <該 record 在 records 中的索引>, …同 meta 欄位 }]`（依 records 順序），由前端依 §6.6 規則以瀏覽器日期選出 record，再取 `recordIndex` ≤ 該 record 索引的最後一個變體；shard 因此不依賴 build 日。只比 `from` 在「同起日、不同描述」時會選錯列（2026-09-12 codex R4）。
- `invalidRecords`：無法形成有效 interval 的來源列（§6.1），保留原值：`{ "rawFrom", "rawTo", "rawPrice", "error": "blank_start|invalid_date|inverted_interval" }`；不參與排序、事件、coverage 與圖表，但必須出現在詳細頁歷史表並標「日期異常」。
- `shardVersion`：本片 `drugs` 內容 canonical 序列化之 sha256。每片**只帶自己的 hash**，不帶全域版本，否則改一個價格就會改寫全部 shard（違反 plan.md B5）。
- `dataVersion`：`meta.shards.versions`（各片 hash 對照表）的 sha256；寫入 `meta.json`、`drug_index.json`、`status.json`。只依來源內容，不依 build 日。

每筆 record：

```json
{
  "records": [
    {
      "from": "2024-04-01",
      "to": "2025-03-31",
      "price": 15.0,
      "rawPrice": "15.00",
      "priceState": "priced",
      "changeFlag": "",
      "eventType": "decrease",
      "previousPrice": 16.1,
      "absoluteChange": -1.1,
      "percentChange": -6.83,
      "crossesStop": false,
      "flags": []
    },
    {
      "from": "2025-04-01",
      "to": null,
      "price": null,
      "rawPrice": "0.00",
      "priceState": "terminated",
      "changeFlag": "",
      "eventType": "terminated",
      "previousPrice": 15.0,
      "absoluteChange": null,
      "percentChange": null,
      "crossesStop": false,
      "flags": []
    }
  ]
}
```

- `price`：僅 `priced` 有數值；其他狀態一律 `null`（避免前端誤畫成 0 元連續價格）。
- `rawPrice`：strip 後的原字串，**任何精簡都不得刪除**（`12.50` 不能以 `12.5` 冒充）。
- `changeFlag`：來源 `異動` 欄原值；語意不明，**僅保存，不用於任何推導**。
- record `flags`：`gap_before`、`overlap`、`conflicting_price_interval`。
- history shard **不含**任何依 build 日變動的欄位（預告與否、描述欄位選用皆由前端依日期判定），以維持 shard 跨 build 日的 determinism。

### 5.3 Price state

| `priceState` | 來源值 | UI 標籤 |
|---|---|---|
| `priced` | 可 parse 且 > 0 | 支付價金額 |
| `terminated` | `0`、`0.00` | 健保支付價 0 元（已終止支付） |
| `suspended` | `-`、`－`、`—` | 暫停支付（來源標示 `-`；顯示實際原始值） |
| `missing` | 空白 | 來源無支付價資料 |
| `malformed` | 其他：無法 parse、負數、`NaN`、`inf`、`N/A`、`NA`、`無` 等 | 資料格式異常（原始值：…） |

`rawPrice` 永遠保留，以利 audit。

`suspended` 語意為臨床藥師判斷而非官方文件定義，故 UI 必須併列原始標記，讓使用者可自行查核。

**首列 0 元例外**（2026-09-11 定案）：`terminated` 區間若**之前從未有 `priced` 紀錄**（實測 3,387 個代號首列即 0 元，例 `A020296321`），`priceState` 仍為 `terminated`，但 UI 標籤改為「**健保支付價 0 元（此前無有價紀錄）**」，不得出現「終止」字樣。理由：只陳述資料可見的事實，不推論是終止或尚未核價。此規則適用於歷史表（支付價欄與事件欄）、圖表區塊與圖例（獨立區塊樣式）、搜尋卡、摘要卡、預告標籤與頁尾聲明。

### 5.4 Derived event

對每個代號依 §6.2 排序後的 `records`（不含 `invalidRecords`），逐筆相對「前一筆」判定。**由上而下取第一個符合的規則**（互斥）：

| 序 | 條件 | `eventType` | `previousPrice` | 差額 / % | 計入 `priceChangeCount` |
|---|---|---|---|---|---|
| 1 | 該代號第一筆 | `initial` | null | 無 | 否 |
| 2 | 本筆或前筆為 `missing`／`malformed`；或本筆帶 `conflicting_price_interval`；或本筆與不同價格／狀態之列 overlap | `unknown` | null | 無 | 否 |
| 3 | 本筆 `terminated`，前筆 `terminated` | `unchanged` | null | 無 | 否 |
| 4 | 本筆 `terminated` | `terminated` | 本筆之前最後一個 `priced` 金額（無則 null） | 無 | 否 |
| 5 | 本筆 `suspended`，前筆 `suspended` | `unchanged` | null | 無 | 否 |
| 6 | 本筆 `suspended` | `suspended` | 同序 4 | 無 | 否 |
| 7 | 本筆 `priced`，前筆 `priced`，同價 | `unchanged` | 前筆金額 | 無 | 否 |
| 8 | 本筆 `priced`，前筆 `priced`，不同價 | `increase`／`decrease` | 前筆金額 | 計算 | **是** |
| 9 | 本筆 `priced`，前筆 `terminated`／`suspended`，且更早曾有 `priced` | `relisted` | 停止前最後一個 `priced` 金額 | 計算；`crossesStop: true` | 否 |
| 10 | 本筆 `priced`，之前從未有 `priced`（實測 3,387 個代號首列即 0 元） | `first_priced` | null | 無 | 否 |

- 金額運算以 `rawPrice` 的十進位值計算（避免浮點誤差）；`absoluteChange` 取小數 2 位。
- `percentChange = (newPrice − previousPrice) / previousPrice × 100`，僅在兩者皆為正數時計算；四捨五入（half away from zero）至小數 2 位。
- 同價的 overlap 不視為衝突，照序 3–10 判定，只加 `overlap` flag。
- 空窗後的紀錄照上表判定，另加 `gap_before` flag；UI 表格標註「前有空窗」。

### 5.5 Summary 衍生規則

所有摘要以**參考日期 R** 計算（index＝build 日；詳細頁＝瀏覽器本地日期）。只有 `from ≤ R` 的紀錄算「已生效」；預告區間一律不計入統計。

- **現行支付價**：R 落在其閉區間內的紀錄。
  - 多筆（衝突／異價重疊）→「來源紀錄衝突，無法判定單一支付價」＋列出候選
  - 無，且 R 位於兩筆之間 →「此日期無支付紀錄（空窗）」
  - 無，且 R 早於第一筆 →「尚未生效」
- **預告標籤**：R 之後最早的一筆紀錄（若有）。
- **歷史調價次數**：已生效紀錄中 `increase`／`decrease` 的個數。
- **最新一次調整**：已生效紀錄中，最後一筆 `eventType ≠ unchanged` 者：
  - `increase`／`decrease`／`relisted` → 差額與 %（`relisted` 加註「跨越停止期間」）
  - `terminated` →「已終止支付（終止前 X 元，YYYY-MM-DD 起）」，X＝**該事件的 `previousPrice`**；null（此前從未有價）時依 §5.3 首列 0 元例外為「健保支付價 0 元（此前無有價紀錄，YYYY-MM-DD 起）」，不得含「終止」（原文「已終止支付（無先前有價紀錄）」與 §5.3 衝突，2026-09-12 修正）
  - `suspended` →「暫停支付（暫停前 X 元，YYYY-MM-DD 起）」，規則同上
  - `unknown` →「最近一次變動無法判定（來源資料異常）」
  - 只有 `initial`／`first_priced` →「無調價紀錄」
- **總變化**（§1 目標 5）：已生效紀錄中，第一筆 `priced` 金額 → 最後一筆 `priced` 金額。
  - 現行非 `priced` 時標「至終止前」或「至暫停前」
  - 無 `priced` →「無有價紀錄」
  - 僅一筆 `priced` →「僅一筆有價紀錄」

---

## 6. Historical Integrity Rules

### 6.1 Date normalization

- 先 `strip()`（民國 6 碼日期實測帶前綴空白）
- 民國 6 碼 / 7 碼日期轉 ISO `YYYY-MM-DD`
- 有效迄日 `9991231`（開放迄日哨兵）→ `null`
- 空白有效迄日 → `null`（實測未出現，防禦用）
- 8 碼西元日期 → 直接轉換（實測未出現，防禦用）
- `9991231` 只在**迄日**視為開放哨兵；出現在起日時照常解析並列 build log 警告
- 以下列入 `invalidRecords`（§5.2），保留原值、不參與時間推導，**不得**轉成 `to = null`：
  - 空白有效起日 → `blank_start`
  - 無法解析的非空起日或迄日（含非法月日、非閏年 2/29）→ `invalid_date`
  - 起日晚於迄日 → `inverted_interval`
- **壞日期比例** ＝ invalidRecords 列數 ÷ 來源列數（同一列兩個日期都壞只計 1 列）；> 1% 時 build fail
- 空白藥品代號的列無法歸屬任何代號：計入 `blankCodeRows`，並併入上述異常比例的分子
- 守恆：Σ(records) ＋ Σ(invalidRecords) ＋ `blankCodeRows` ＋ `duplicateRowsRemoved` ＝ `sourceRowCount`，且逐筆可對應回來源列

### 6.2 Sorting

同一 code：

1. `有效起日` ascending
2. `有效迄日` ascending/null last
3. deterministic secondary key：`rawPrice`，再以全欄位字串 tuple 排序

輸出必須 deterministic：

- history shards 與 `dataVersion`：相同 source input → 完全相同 JSON，**與 build 日無關**，且與來源列順序無關
- `drug_index.json`：相同 source input **＋相同 build 日** → 完全相同 JSON（`window` 依 build 日決定，跨越區間邊界時會自然產生 diff）
- `status.json`：僅時間與結果欄位隨檢查變動
- JSON 序列化固定：`sort_keys`、`ensure_ascii=False`、固定分隔符、浮點數不帶多餘尾零

### 6.3 Duplicate rows

「完全相同」定義為 **20 欄各自 strip 後的字串全部相同**（最保守，不會誤刪）。實測 0 筆，偵測保留作防護。

完全相同的歷史列可 deduplicate（保留 1 列），但必須計數至：

```json
"duplicateRowsRemoved": 123
```

若同一 code + from + to 存在不同支付價：

- 不可靜默覆蓋，所有列都保留
- 每列加 `conflicting_price_interval` flag；事件依 §5.4 序 2 記為 `unknown`
- `conflictingIntervals` 計數單位＝有兩種以上價格的 (代號, from, to) 組數
- 受影響日期的顯示依 §5.5：「來源紀錄衝突，無法判定單一支付價」＋列出候選；**不得**以排序結果作為價格優先權
- build log 顯示數量

### 6.4 Overlap / gap

以閉區間、依排序逐筆比對「**累計最大迄日**」（不只比相鄰兩列，以正確處理長區間包覆短區間）：

- 本筆 `from` ≤ 累計最大迄日 → overlap（開放迄日視為無限大）
- 本筆 `from` ＞ 累計最大迄日 ＋ 1 日 → gap，flag 加在空窗後那筆
- 本筆 `from` ＝ 累計最大迄日 ＋ 1 日 → 連續

不要自行補值；偵測不得增加 records 數。

圖表遇到 gap 必須中斷，不可視為上一價格持續有效。

### 6.5 Same price, new interval

如果有效期間更新但價格未改：

- raw history 保留
- `eventType = unchanged`
- 不計入 `priceChangeCount`

### 6.6 Descriptive metadata

來源的品名／藥商／ATC 等描述欄位在同一代號各列相同（以現況回填，**非歷史值**），UI 不得將其呈現為「當時的品名」。

描述欄位（含兩個連結）的選列規則，以日期 X（index＝build 日；詳細頁＝瀏覽器本地日期）依序：

1. X 當日有效之列
2. 否則，`from ≤ X` 的列中 `from` 最晚者
3. 否則（只有未來列）→ 顯示代號，其餘描述欄位顯示「—」

**不以預告列回填**（最新列可能為預告列，實測曾出現成分欄損毀）。

- 同代號描述欄位一致時，shard 存單一 `meta`；不一致時存 `metaVariants`（§5.2），加代號層 `inconsistent_metadata` flag，build log 列出代號與差異欄位，不自動修正

#### 畫面資訊對照

| 畫面資訊 | 來源欄位 | 輸出位置 | 缺值行為 |
|---|---|---|---|
| 品名、成分、劑型、ATC、藥商 | 同名欄位 | index（搜尋）；shard `meta`／`metaVariants`（詳細頁） | 顯示「—」 |
| 規格 | `規格量`＋`規格單位` | 同上 | 省略（填寫率 47%） |
| 暫停原始標記 | `支付價` | index `window[].rawPrice`；shard `records[].rawPrice` | — |
| 終止前／暫停前價格 | 推導 | index `window[].previousPrice`；shard `records[].previousPrice` | 「無先前有價紀錄」 |
| TFDA 許可證連結 | `藥品代碼超連結` | shard `meta.tfdaLink` | 不顯示連結 |
| 健保給付規定 PDF | `給付規定章節連結` | shard `meta.nhiRuleLink` | 不顯示連結 |
| 代號層品質提示 | 推導 | index `flags`；shard `flags` | 不顯示 |
| 紀錄層品質提示 | 推導 | shard `records[].flags` | 不顯示 |
| 日期異常列 | 原始列 | shard `invalidRecords` | — |

### 6.7 Character corruption

來源含字面 `?`（上游將罕用字替換為 `?`）。

- 統計 `藥品中文名稱`／`藥品英文名稱`／`成分` 含 `?` 的代號數，寫入 `meta.json` 的 `questionMarkCodes` 並列入 build log
- **不自行猜字修補**
- 已知影響：以正確字搜尋時可能查不到該品項（例：以「葡萄糖」搜不到「葡萄?」）

### 6.8 Open-ended row check

實測每個代號恰好 1 列 `9991231`。build 時統計不符此規則之代號數（0 列或多列），寫入 build log 作為來源結構變動的早期警訊（warning，不 fail）。

---

## 7. Storage Strategy

### Search index

`data/drug_index.json`

包含所有 unique NHI drug codes 的精簡 metadata；首頁只載入此檔供即時搜尋。

### History shards

不要把 22 萬多筆完整 metadata 全塞進首頁 payload。

歷史資料依 NHI code 前 4 字元分片（見下方 Shard map）：

```text
data/history/
  A000.json
  A001.json
  ...
  AC49.json
  ...
```

每個 shard 結構見 §5.2（`{ dataVersion, drugs: { <code>: {...} } }`）。

### Data version

- `meta.json`：`dataVersion` ＋ `shards.versions`（`{ <prefix>: <shardVersion> }`）
- `drug_index.json`：`dataVersion`；每個 shard：自己的 `shardVersion`；`status.json`：其檢查所對應的 `dataVersion`
- 前端載入時比對：`index.dataVersion ≠ meta.dataVersion`，或 `shard.shardVersion ≠ meta.shards.versions[prefix]` → **不組合摘要與圖表**，提示「資料已更新，請重新整理」
- 目的：GitHub Pages CDN 快取約 10 分鐘，已開啟的頁面或全新載入都可能取得不同批次的檔案

使用者選定藥品後才 fetch 對應 shard。

### Shard map

前端**不得寫死**分片前綴長度。`meta.json` 帶分片清單：

```json
"shards": { "prefixLength": 4, "files": ["A000", "A001", "..."], "versions": { "A000": "sha256:…" } }
```

若日後因 size guard 改用更細 prefix（或針對單一大片細分），只需改 build 端與 `meta.json`，前端依清單以「最長符合前綴」決定要 fetch 的檔案。

**採用前 4 碼（Phase 1 實作時依本節規則調整）**：前 2 碼分片時，`A0` 單片實際輸出 gzip 3.35 MB／raw 35.7 MB，已超過 2 MB warning，行動裝置解析過重。前 4 碼共 348 片，最大一片（`AC49`）gzip ≈ 0.14 MB／raw ≈ 1.47 MB。

### Build-time size guard

建置時輸出每個 shard：

- raw bytes
- gzip estimated bytes
- record count

若單一 shard gzip > 2 MB，build warning；若 > 5 MB，build fail 並改用更細 prefix。

---

## 8. Frontend Requirements

樣式沿用既有臨床工具的 house style（`pharmacy-tool-style`：design tokens、card／metric／table 元件、色盲安全配色、免責聲明與來源標示慣例），不做視覺創新。

### 8.1 Home / Search

搜尋欄支援：

- 健保藥品代號 exact / prefix
- 中文品名 contains
- 英文品名 contains
- 成分 contains

比對規則：
- 「contains」＝**不分大小寫的子字串比對**，搜尋範圍為 index 全部代號（不是前 50 筆）
- 排序：代號完全相符 → 代號前綴相符 → 其他；同級依代號排序
- 空白查詢：不列結果，只顯示提示
- 終止支付品項不排除
- ATC prefix 搜尋不屬 MVP（移至 §9 SHOULD）

結果最多 render 50 筆，避免一次 render 大量 DOM；超過時顯示「共 N 筆，請縮小搜尋範圍」。

每筆搜尋結果顯示：

- 中文品名
- 英文品名
- 健保代號
- 成分 / 規格 / 劑型（規格量實測填寫率僅 47%，須容許空值）
- 現行支付價，或狀態標籤（已終止支付／暫停支付），依 §5.1「搜尋卡判定」
- 預告標記（若 `window` 含尚未生效之區間）
- 最近一次價格異動日期
- `歷史 N 次`
- 品質提示（index `flags` 非空時）

~~終止支付品項（實測占 69%）預設不隱藏~~ → **2026-09-12 使用者改決策**：搜尋框下方加勾選框「顯示已終止支付品項」，**預設不勾＝隱藏**瀏覽器日期當日「現行為健保支付 0 元」的品項（含此前從未有價的 0 元）。規則：

- 判定與搜尋卡相同：當日恰一筆有效 window 列、無衝突／重疊旗標、`priceState = terminated`；暫停支付、預告終止（現行仍有價）、衝突、window 耗盡一律**不藏**（寧可多顯示也不誤藏）
- **代號完全相符一律顯示**，不受篩選（輸入完整代號不得像「查無」）
- 結果列顯示「另有 N 筆已終止支付品項未顯示」；全部被篩掉時顯示「沒有符合的現行支付品項；另有 N 筆…」，**不得只說「查無」**
- 勾選狀態存於瀏覽器（localStorage），僅供該使用者便利
- 文字採「已終止支付」而非「已註銷」：本站只有健保支付狀態，沒有 TFDA 許可證狀態

篩選（見 §9 SHOULD）：

- 只看現行有價品項
- 即將終止支付（`window` 含尚未生效之 `terminated` 區間）

### 8.2 Detail dashboard

選定一個 NHI code 後，fetch 對應 shard，**所有摘要由完整 history 以瀏覽器本地日期為參考日期推導**（§5.5），不讀 index 的摘要欄位。頁面標示「參考日期：YYYY-MM-DD」。

#### Summary cards

1. 現行支付價（§5.5 現行支付價規則）；若有預告，旁附標籤：
   - 「⚠ YYYY-MM-DD 起終止支付」
   - 「YYYY-MM-DD 起調整為 X 元（+/−Y%）」
   - 「YYYY-MM-DD 起恢復支付 X 元」
2. 最新一次調整（§5.5）
3. 歷史調價次數（§5.5）
4. 最早可取得紀錄日期
5. 總變化（§5.5）

#### Price chart

必須使用 **stepped line chart**，不可使用平滑曲線或線性內插。

X-axis：effective date

Y-axis：健保支付價（NTD）

需求：

- increase / decrease event marker
- hover 顯示 from / to / price / 狀態
- gap 中斷
- `terminated` 區間：線段中斷，以標示區塊呈現「已終止支付」，不畫成 0 元連續價格
- `suspended` 區間：線段中斷，以灰色區塊呈現「暫停支付」
- `missing`／`malformed` 區間與 invalidRecords：不繪製價格
- 預告區間：虛線或淡色，標示「預告」
- 開放迄日（`to: null`）的區間畫至 max(今天, 最後預告區間起日)，不延伸至 2910 年

實作採**手刻 SVG**（2026-09-12 定案，沿用 `pharmacy-tool-style`「不引入外部 JS 函式庫」；原建議 Chart.js 撤回）。圖表先由純函式產生「區段模型」再繪製：只有 `priced` 區間產生水平價格線段，相鄰有價區間以垂直線相接（step）；非有價區間與空窗不產生價格點（不得以 0 代替）；終止／暫停以區塊標示。開放迄日畫至 max(今日, 最後一筆起日)，右側另留少量邊界供預告區間可見。

### 8.3 History table

欄位：

| 生效日 | 迄日 | 支付價 | 與前次差額 | 變動 % | 狀態 |
|---|---|---:|---:|---:|---|

- 「支付價」欄：`priced` 顯示金額；其他狀態顯示 §5.3 標籤與原始值
- 「狀態」欄併列：預告、跨越停止期間（`relisted`）、前有空窗（`gap_before`）、來源紀錄衝突、重疊
- 迄日為 `null`：已生效者顯示「—（持續有效）」；尚未生效者顯示「—（預告，無迄日）」
- `invalidRecords` 一併列出，原始起迄日照實顯示，狀態標「日期異常」；表格列數＝records＋invalidRecords

排序預設 newest first；可切換 oldest first。

### 8.4 Source links

- `藥品代碼超連結`：標示為「TFDA 許可證資料」（實測指向 TFDA，非健保署）；href＝來源值
- `給付規定章節連結`：有值時顯示「健保給付規定（PDF）」；空值不顯示
- 來源：shard `meta.tfdaLink`／`meta.nhiRuleLink`（依 §6.6 選列）

### 8.5 Data timestamp

頁面固定可見：

- 最後檢查日（`status.json` 的 `lastCheckedAt`）
- 本站資料產生時間（`meta.json` 的 `generatedAt`；為已發布資料批次的產生時間，**不代表**官方內容異動時間；官方月更，落後一個月屬正常）
- data.gov.tw 資料集更新時間（`status.json` 的 `sourceModifiedAt`；取不到顯示「無法取得」）
- coverage start / end

### 8.6 Stale data warning

天數 ＝ 瀏覽器本地日期 − `lastCheckedAt` 在 +08:00 的日期：

| 天數 | 呈現 |
|---|---|
| ≤ 21 | 無警示 |
| 22–45（連續漏 3 次以上週檢查） | 黃色橫幅：「資料可能未更新，請以健保署公告為準」 |
| ≥ 46 | 紅色橫幅，並於摘要卡現行支付價旁加註 |
| `status.json` 無法載入、JSON 損毀、時間無法解析 | 視同 ≥ 46 天 |

詳細頁的現行價由完整 history 依瀏覽器日期判定，所以過期風險主要是「新公告的調價尚未收錄」。搜尋卡在 window 耗盡時顯示「需更新」，不顯示確定價格（§5.1）。

### 8.7 Loading, failure and race states

每種資源（index、meta、status、shard）都有四種狀態：載入中／不可用（網路錯誤、404）／內容不合法（JSON 損毀、缺預期代號、dataVersion 不一致）／成功。

| 情況 | 行為 |
|---|---|
| index 或 meta 載入中 | 搜尋框顯示載入中；**不得**回報「查無」 |
| index 或 meta 不可用或不合法 | 錯誤狀態＋重試；不得回報「查無」 |
| shard 不可用或不合法 | 錯誤訊息＋重試；不得顯示「0 筆歷史」或其他代號的內容；重試成功後恢復正常 |
| dataVersion 不一致 | 不組合摘要與圖表；提示「資料已更新，請重新整理」 |
| 使用者先選 A 再選 B，A 較晚回應 | 丟棄 A 的回應，畫面只顯示 B |
| `?code=` 指向不存在的代號 | 「查無此代號」，不殘留前一品項內容 |

---

## 9. MVP Scope

### MUST

- NHI drug code search
- 中文 / 英文品名搜尋
- 成分搜尋
- 現行支付價
- 完整歷史價格 timeline
- stepped chart
- 歷史表格
- 漲跌金額 / 百分比
- 官方來源連結
- mobile responsive
- 自動更新資料
- 終止／暫停支付狀態標籤（§5.3）
- 預告標籤（§8.2）
- 資料過期警示（§8.6）
- 載入失敗與競態處理（§8.7）
- shareable URL：`?code=A123456100`（§20 驗收要求，且為 Phase 3 整合前提）

### SHOULD

- ATC filter／ATC prefix 搜尋
- 狀態篩選：只看現行有價品項／即將終止支付（§8.1）
- CSV export for selected drug code
- 深色模式

### NOT IN MVP

- 多藥品價格比較
- 不同規格之 normalized price comparison
- ingredient-level market price trend
- TFDA 仿單整合
- 健保申報量加權分析
- AI 解讀價格變動原因
- 自動推論降價政策原因

---

## 10. Cross-project Integration

### `TFDA-drug-info-search` → 本專案

未來在舊專案的 `nhiMatches` 每個健保品項旁增加：

```text
查看健保藥價歷史 ↗
```

URL：

```text
https://<host>/NHI-drug-price-history/?code=<NHI_CODE>
```

### 本專案 → `TFDA-drug-info-search`

Phase 2 才考慮。

不可在 MVP 重新複製完整 TFDA `drugs_data.json`。

---

## 11. Repository Structure

```text
NHI-drug-price-history/
├─ index.html
├─ app.js                      # DOM、資源載入、競態
├─ engine.js                   # 純邏輯（ES module）：摘要、標籤、搜尋、圖表區段模型
├─ styles.css
├─ build_price_history.py      # 建置主程式：來源 → guards → 寫檔（guard 全過才寫）
├─ lib/
│  ├─ __init__.py
│  ├─ nhi.py                   # 下載、內容驗證、schema、日期與價格分類
│  ├─ history.py               # 純邏輯：正規化、品質標記、事件、window、摘要
│  └─ golden.py                # golden 代號清單與 golden 檢視
├─ scripts/
│  ├─ profile_source.py        # 來源 profiling（§3.1 數據的重現工具）
│  ├─ extract_snapshot.py      # 從完整 CSV 擷取 golden 代號原始列（凍結快照）
│  └─ golden_sheet.py          # 產生人工核對 xlsx；--freeze 轉為 golden fixture
├─ docs/
│  └─ golden_check_2026-09-11.xlsx   # 藥師核對用（§19）
├─ data/
│  ├─ meta.json                # 資料有變才更新
│  ├─ status.json              # 每次成功檢查都更新
│  ├─ drug_index.json
│  └─ history/
│     ├─ A000.json
│     ├─ AC49.json
│     └─ ...（前 4 碼，共約 348 片）
├─ tests/
│  ├─ helpers.py
│  ├─ test_dates.py
│  ├─ test_prices.py
│  ├─ test_history.py
│  ├─ test_build.py
│  ├─ test_golden.py
│  ├─ test_golden_sheet.py
│  └─ fixtures/
│     ├─ source_snapshot_2026-09-11.csv        # 11 個 golden 代號的原始列（凍結快照）
│     ├─ source_snapshot_2026-09-11.meta.json  # 快照來源 sha256 與列數
│     └─ golden_<code>.json    # 人工核對通過的 golden 預期值（§19）
├─ .github/
│  ├─ dependabot.yml           # actions 與 uv 依賴升級一律經 PR
│  └─ workflows/
│     ├─ build-data.yml
│     └─ test.yml
├─ pyproject.toml              # uv 管理依賴（runtime + dev group）
├─ uv.lock
├─ README.md
├─ spec.md
└─ LICENSE
```

---

## 12. ETL Pipeline

```text
NHI Open Data CSV                  data.gov.tw dataset 23715 metadata
        ↓                                   ↓（失敗僅 warning）
Download + TLS validation + retry    sourceModifiedAt
        ↓
Content validation（非 CSV／HTML 錯誤頁／截斷 → FAIL）
        ↓
Schema detection（20 欄；必要欄位缺或歧義 → FAIL）
        ↓
Normalize ROC dates（strip、9991231→null、壞日期→invalidRecords）/ price states
        ↓
Group by NHI drug code
        ↓
Sort + duplicate/conflict/overlap/gap detection（累計最大迄日）
        ↓
Derive events（§5.4）→ history shards（meta/metaVariants、links、flags）→ dataVersion
        ↓
drug_index.json（build 日 window §5.1、描述欄位 §6.6、搜尋卡摘要 §5.5）+ meta.json
        ↓
Guards（§14）+ pytest + golden test（凍結快照，§19）── 任一失敗 → FAIL，data/ 與 status.json 不動
        ↓
Golden 代號已核對區間在最新來源被改寫 → WARNING（step summary），不 FAIL
        ↓
Diff check：只比 drug_index.json + history/（排除 meta.json、status.json）
        ↓
有差異 → commit 資料 + meta.json + status.json
無差異 → 只 commit status.json（lastCheckResult = unchanged）
        ↓
GitHub Pages（main 分支根目錄）
```

---

## 13. GitHub Actions

沿用 `TFDA-drug-info-search` 的安全原則：

- `actions/checkout` 與 `astral-sh/setup-uv` pin commit SHA；以 `uv sync --locked` 安裝
- `contents: write` 僅給 data-build workflow
- source fetch failure → workflow fail，不得覆寫既有正常 data
- build 前執行 pytest
- 資料檔（`drug_index.json`、`history/`）僅在有差異時 commit
- `status.json` 每次成功檢查都 commit（`lastCheckedAt`、`lastCheckResult`、`sourceModifiedAt`）
  - 讓前端能區分「官方沒更新」與「build 壞了」（§8.6）
  - 維持 repo 活動，避免 GitHub 在 60 天無活動後自動停用排程 workflow
- workflow 失敗通知：沿用 GitHub 內建失敗通知信，不另建通道
- 待驗證：GitHub Actions runner 能否連線 `data.gov.tw`（`info.nhi.gov.tw` 已由舊專案證實可連）

### Concurrency and publishing

- build-data workflow 使用 `concurrency` group，`cancel-in-progress: false`（排隊依序執行，不取消）
- 每次 build 以 checkout 當下最新 main 為基準；前次已發布的 meta 作為 guard 基準（§14）
- push 被拒（non-fast-forward）→ workflow fail；**禁止 force push**
- `workflow_dispatch` 提供 `allow_anomaly`（boolean，預設 false），僅作用於 §14 的語意異常 guard
- Pages 發布方式：GitHub Pages 由 main 分支根目錄部署
- 不另建部署後線上驗證 job：部署失敗時 `lastCheckedAt` 不會前進，§8.6 過期警示本身就會在線上呈現

### Schedule

官方資料月更，但建議 workflow **每週檢查一次**；資料無變化時跳過資料檔 commit，**但仍 commit `status.json`**。

理由：

- 不依賴官方固定發布日
- cost 極低
- 可及早捕捉 schema / endpoint failure

---

## 14. Data Quality Guardrails

每次 build 至少檢查：

通過條件（皆為「≥／≤ 才通過」，邊界值通過）：

```text
sourceRowCount ≥ 100,000
uniqueDrugCodeCount ≥ 5,000
sourceRowCount ≥ 前次已發布 meta.sourceRowCount × 99%（歷史資料理應只增不減）
invalidRecords 列數 ÷ sourceRowCount ≤ 1%（§6.1）
all generated JSON parse successfully
golden test passes（凍結快照，§19）
```

語意異常 guard（2026-09-11 定案，plan-verdict 2.6、plan.md B8）：

```text
（malformed + missing 價格列）÷ sourceRowCount ≤ 1%
前次已發布代號中，本次來源消失者 ÷ 前次已發布代號數 ≤ 1%
```

- 實測基準：malformed、missing 皆 0 列；代號消失率尚無月對月基準
- **人工放行**：僅限這兩條語意 guard。以 `workflow_dispatch` 手動觸發並帶 `allow_anomaly=true` 重跑時，這兩條改為 warning 並照常發布；放行原因與觸發條件數值寫入 step summary。排程觸發一律不得放行
- 其他 guard（列數、代號數、壞日期、schema）**不提供**放行參數

僅記錄、不擋 build：

```text
malformedPriceRows、missingPriceRows
conflictingIntervals / overlapCodes / gapCodes
openEndedRowAnomalies（§6.8）
questionMarkCodes（§6.7）
golden 代號已核對區間被改寫（WARNING）
```

任一通過條件不成立 → fail：`data/` 與 `status.json` 皆不變、不 commit。不得因 source schema mismatch 產生空資料後自動 commit。

`meta.json`（已發布資料批次的統計；資料有變才更新）：

```json
{
  "dataVersion": "sha256:<meta.shards.versions 的 hash>",
  "generatedAt": "<本批資料產生時間，ISO 8601 +08:00>",
  "sourceRowCount": "<int>",
  "uniqueDrugCodeCount": "<int>",
  "coverageStart": "<最早有效起日>",
  "coverageEnd": "<最晚有效起日，含預告>",
  "malformedPriceRows": "<int>",
  "missingPriceRows": "<int>",
  "invalidRecords": "<int>",
  "duplicateRowsRemoved": "<int>",
  "conflictingIntervals": "<int>",
  "overlapCodes": "<int>",
  "gapCodes": "<int>",
  "questionMarkCodes": "<int>",
  "shards": { "prefixLength": 4, "files": ["<prefix>", "..."],
              "versions": { "<prefix>": "sha256:<shardVersion>" } },
  "source": "NHIA A21030000I-E41001-001"
}
```

`status.json`（每次成功檢查都更新）：

```json
{
  "lastCheckedAt": "<ISO 8601 +08:00>",
  "lastCheckResult": "changed | unchanged",
  "dataVersion": "<本次檢查後已發布資料的 dataVersion>",
  "sourceModifiedAt": "<data.gov.tw modifiedDate，或 null>"
}
```

上述數值除 `source` 外一律由 build 動態產生，不寫死。

---

## 15. Tests

測試案例與斷言**以 `.ai-review/plan.md` §5 為準**，本節只列對應的測試檔，避免兩份文件各寫一套造成分歧。

| 測試檔 | 對應驗收條件 |
|---|---|
| `tests/test_dates.py` | A1 |
| `tests/test_prices.py` | A2（單列分類部分） |
| `tests/test_history.py` | A2（逐筆守恆）、A3、A4、A5、A6、A7、A8、E1、E2 |
| `tests/test_build.py` | B1–B8（mock 來源、guard 邊界、diff、並行） |
| `tests/test_golden.py` | D2、D3（凍結快照＋固定參考日期） |
| `tests-js/*.test.mjs`（`node --test`，零依賴） | C1–C4、E1–E6 的純邏輯（`engine.js`）；golden 11 代號以同一份凍結快照交叉比對 Python 摘要 |
| `e2e/*.spec.mjs`（Playwright） | C1、C3–C8（DOM、viewport、route mock 模擬 404／延遲／損毀） |
| Phase 2 驗收紀錄 | C2 人工截圖審查、E7 效能量測 |

---

## 16. Performance Targets

### Desktop / modern mobile

- `drug_index.json` gzip target：< 5 MB
- initial interactive search：index **解析完成**後 < 200 ms 可搜尋
- result render：< 100 ms for first 50 records
- selected history shard：gzip target < 2 MB
- chart render：< 300 ms after data available

量測方式：Chrome DevTools，CPU 4x throttle + Fast 4G，全量資料。另外記錄「index fetch 開始 → 解析完成」的時間（此段為已知主要成本）。結果寫入 Phase 2 驗收紀錄（plan.md E7）。

Phase 1 實際輸出（§3.1）：index gzip 3.14 MB、raw 29.35 MB；最大 shard `AC49` gzip 0.14 MB、raw 1.47 MB。gzip 皆在目標內，但 index 的 raw 偏大，解析時間需於 Phase 2 實測。若解析過慢，精簡順序：(1) 省略可由 `rawPrice` 推導的 `price`；(2) 省略值為預設的欄位（空 `flags`、`crossesStop: false`）。**`rawPrice` 任何情況都不得刪除。**

若 `drug_index.json` gzip > 5 MB：

1. 移除搜尋不需要欄位
2. 縮短 key names only if necessary
3. 再考慮分片 search index

不要優先引入 backend。

---

## 17. UX / Clinical Interpretation Rules

### 價格圖

使用 step chart，因支付價在有效期間內為離散區間值。

禁止：

- smooth curve
- linear interpolation
- 將 null／終止／暫停當 0 自動連線
- 將開放迄日延伸至 2910 年
- 將預告區間以與已生效區間相同樣式呈現

### Percentage change

```text
(newPrice - previousPrice) / previousPrice × 100%
```

只有 previous / new 均為 positive numeric price 才計算。`relisted` 的 previous 為停止前最後一個有價金額，並須標示「跨越停止期間」。

### 描述欄位

品名／藥商等描述欄位為來源以現況回填（§6.6），UI 不得呈現為「該期間當時的品名」。

### Multiple products

MVP 以 **NHI drug code** 為單位。

不得只因：

- 相同 ingredient
- 相同 ATC
- 類似品名

就自動合併成同一條 price history。

不同 NHI code 代表不同 reimbursement item；產品等同性需另行定義。

---

## 18. Versioning

### Application

Semantic Versioning：

- `v0.1.0`：MVP history search（含 `?code=` deep link）
- `v0.2.0`：預告中心（`spec-upcoming.md`）／export／filters／ATC 搜尋
- `v0.3.0`：多代號比較（`spec-compare.md`）
- `v1.0.0`：stable public release

深色模式原列於 v0.2.0，未納入預告中心規格範圍，延後至另行提案時再排版號。

### Data

`meta.json` 獨立記錄：

- source file date
- generatedAt
- row count
- coverage
- upcomingRows／upcomingCodes（預告清單統計，僅供建置紀錄與 guard，不供前端顯示）

避免將 build timestamp 寫入大型 history JSON，否則每次 build 都造成無意義 diff。

---

## 19. Phase Plan

### Phase 1 — ETL / Backfill

建立 `build_price_history.py`：

1. 從現有專案抽出 NHI fetch / parse helpers
2. 取消 current-only collapse
3. 產生完整 grouped histories
4. 建立 `drug_index.json`
5. 建立 history shards
6. 加入 pytest + data guards

**Phase 1 完成條件：** 見 `.ai-review/plan.md` §5 D1–D3（以下為摘要）。

以**獨立來源**（健保署藥品查詢網站）人工核對下列 11 個 golden codes。以 CSV 驗證 output 屬循環驗證，不採用。

| # | 代號 | 驗證情境 |
|---|---|---|
| 1 | `A017014321` | 最長歷史（24 列），含同價續期 94→94 |
| 2 | `AC48092100` | 一般多次降價 |
| 3 | `AC48867100` | 終止後恢復支付（29.80 → 0 → 22.90）【反例】 |
| 4 | `AC48845100` | 現行已終止 |
| 5 | `B009254100` | 有價 → 暫停 → 終止【反例】 |
| 6 | `BC23981100` | 現行暫停，含 12 個月空窗【反例】 |
| 7 | `A035680329` | 1 個月空窗後終止【反例】 |
| 8 | `BC05037209` | 預告終止（2026-10-01）【反例】 |
| 9 | `AB47689100` | 預告調價（2026-10-01 → 7.90）【反例】 |
| 10 | `BC26467100` | 預告列成分欄損毀；metadata 不得取該列【反例】 |
| 11 | `A020296321` | 首列 0 元後首次有價（`first_priced`）【反例】 |

流程：

1. 從 2026-09-11 的 CSV 擷取 11 個代號的原始列，存為凍結快照 `tests/fixtures/source_snapshot_2026-09-11.csv`
2. ETL 產出對照表（xlsx）：每列分「網站可驗證的日期與數值／CSV 原字串／藥師判定狀態」三欄，另記網站列數 vs CSV 列數
3. 臨床藥師於健保署查詢網站**雙向核對**（含漏列、多列），標記 ✓／✗／不可核對，記錄核對人與日期
4. ✗ 項目回查為 ETL 錯誤或來源差異，修正或記錄
5. 通過後存為 `tests/fixtures/golden_<code>.json`：含 intervals、預期事件序列、固定參考日期（2026-09-11、2026-10-01）的摘要、選用的描述欄位列
6. golden test 以凍結快照＋固定參考日期執行，與日曆脫鉤；**不得**以 ETL 輸出自動覆寫預期值

完成條件：網站可驗證的項目全部 ✓，且 golden test 通過。若網站不提供完整歷史，改為「網站可取得部分全部 ✓，其餘列由藥師抽核 CSV 原檔並註記」。

注意：#8、#9 的預告日期為 2026-10-01，**須在該日前完成網站核對**；網站在該日後可能不再顯示預告狀態。

### Phase 2 — Dashboard MVP

建立：

- search
- summary
- stepped chart
- table
- deep link
- source timestamp

### Phase 3 — Existing Project Integration

在 `TFDA-drug-info-search` 每個 `nhiMatches` 加入價格歷史連結。

### Phase 4 — Analytics

可選：

- 多 NHI code comparison
- ingredient / ATC group price distribution
- annual price-cut statistics
- newly listed / delisted dashboard
- NHI申報量 × 支付價的 expenditure trend

---

## 20. Acceptance Criteria — MVP

MVP 只有在全部符合時才算完成：

- [ ] 可使用 NHI code、中文名、英文名、成分搜尋
- [ ] 搜尋結果明確區分不同 NHI code
- [ ] 每個 code 顯示目前支付價、已終止支付、暫停支付，或目前無有效支付價
- [ ] 現行支付價由前端依瀏覽器日期判定；預告區間有明確標籤
- [ ] 顯示所有來源歷史 intervals，不只 GitHub 建站後的 snapshot
- [ ] `0` / `-` / missing 不會被靜默刪除，且以 §5.3 標籤呈現、保留原始值
- [ ] chart 為 stepped timeline
- [ ] gap 不被錯誤補值
- [ ] 顯示 absolute / percent change
- [ ] 顯示官方 source link
- [ ] 顯示資料來源與更新時間
- [ ] 明確聲明「健保支付價 ≠ 採購價 / 零售價 / 自付價」
- [ ] source fetch/schema failure 不會覆蓋既有正常資料
- [ ] 資料過期時依 §8.6 顯示警示
- [ ] data build 有 unit tests，且 11 個 golden codes 通過
- [ ] desktop / mobile responsive
- [ ] 可由 `?code=` 建立可分享單一藥品頁面
- [ ] 載入失敗、競態、dataVersion 不一致依 §8.7 處理

以上為摘要。**逐條可證偽的驗收斷言以 `.ai-review/plan.md` §5（A1–A8、B1–B8、C1–C8、D1–D3、E1–E7）為準**；本清單與 plan.md 衝突時以 plan.md 為準。

---

## 21. Recommended First Implementation Task

第一個 commit 只做資料層，不先做 UI：

```text
feat(data): preserve NHI reimbursement price history
```

完成：

1. 建立新 repo `NHI-drug-price-history`（`git init`、`uv init`、`pyproject.toml`）
2. 從 `TFDA-drug-info-search/build_data.py` 抽出 `lib/nhi.py`，並依 §4 改寫表修正
3. 寫 `build_price_history.py`
4. 輸出 `meta.json`、`status.json`、`drug_index.json`、history shards
5. 擷取凍結快照並產出 golden codes 對照表（§19），交臨床藥師核對後轉為 golden fixtures（網站核對須在 2026-10-01 前完成）

資料模型穩定後再開始 dashboard，避免 UI 先建立在錯誤的「current-only」資料結構上。
