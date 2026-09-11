# NHI Drug Price History — 動工前規劃

> 版本：v2（2026-09-11 23:00 +08:00），對應 `spec.md` v0.3
> 文件分工（覆蓋規則）：**資料模型、欄位、規則以 `spec.md` 為準；驗收條件以本文件 §5 為準**（`spec.md` §20 僅引用本文件編號）。兩者若有衝突，資料模型取 spec、驗收取本文件，並回報修正。
> 驗收條件編號（A1、B3、C2、D1、E4…）供後續 `/codex-review` 區塊 4 比對。
> 修訂依據：`.ai-review/plan-verdict.md`（文末修訂紀錄）

---

## 1. 目標與非目標

### 目標（MVP，v0.1.0）

1. 以**健保藥品代號**為單位，呈現 1995-03-01 至今（含已公告未生效）的完整健保支付價 interval 歷史。
2. 回答：現行支付價、調價次數、每次調價日期與幅度、最新事件（調價／終止／暫停／恢復）、總變化、是否有空窗。
3. 純靜態前端（GitHub Pages），資料由 GitHub Actions 每週自動更新；`?code=` 可分享單一藥品頁。
4. 對臨床藥師可讀：狀態語意（終止／暫停／預告／衝突）明確，不以 0 元連續線誤導。

### 非目標（本次不做）

- 多藥品代號比較、不同規格 normalized price、ingredient／ATC 層級市場價趨勢
- 將不同代號依成分／ATC／品名自動合併成同一條歷史
- TFDA 仿單整合；複製 TFDA `drugs_data.json`
- 健保申報量加權、expenditure trend
- AI 解讀或自動推論調價原因
- 醫院採購價、零售價、病人自付額（UI 必須聲明支付價 ≠ 上述任一）
- 修補來源資料錯誤（`?` 字元、損毀欄位、壞日期）——只偵測、保留原值、標示
- 使用者帳號、後端 API、資料庫、sql.js／SQLite-wasm
- 以 Git commit history 作為價格歷史來源
- 部署後的線上自動驗證 job（由 §8.6 過期警示承擔線上可觀察性）
- 像素層級的圖表自動化測試（以設定斷言＋人工截圖審查替代）

### 後續版本（明確延後）

- v0.2.0：CSV export、ATC filter／ATC prefix 搜尋、狀態篩選（只看現行有價／即將終止）、深色模式
- v0.3.0：多代號比較
- Phase 3：`TFDA-drug-info-search` 各 `nhiMatches` 加「查看健保藥價歷史 ↗」deep link

---

## 2. 架構決策與理由

| # | 決策 | 為什麼不選另一個 |
|---|---|---|
| D1 | **新 repo**，不併入 `TFDA-drug-info-search` | 舊專案是 TFDA-first、current-state、單一 JSON；本專案是 time-series、分片載入。併入會拖大舊專案首頁 payload。 |
| D2 | 歷史來源 = **NHI CSV 本身的歷次列**（實測回溯至 1995-03-01） | Git history 只有建站後 snapshot。 |
| D3 | ETL 用 **Python + GitHub Actions**（uv） | GAS 6 分鐘上限且 .gov.tw 對 Google IP 回 500；96 MB CSV。舊專案已證實 runner 可連 `info.nhi.gov.tw`。 |
| D4 | **靜態 JSON**：搜尋 index 一檔 + history 依前綴分片、選定後才 fetch | 不用後端：零維運。不用 sql.js：多 ~1 MB wasm 且換不到 MVP 功能。不用單一 history 檔：全量 raw ≈ 30 MB，行動裝置解析成本高。 |
| D5 | **現行支付價由前端依瀏覽器日期判定**。詳細頁一律由完整 history 推導；index 的 `window`（現行＋下一個預告）僅供搜尋卡 | build 時寫死會在週 build 之間跨生效日顯示錯價。詳細頁用完整 history 可避免 index／history 雙重真相（verdict 4.1）；window 耗盡只影響搜尋卡，且有明確「需更新」狀態（verdict 1.1）。代價：依賴裝置日期。 |
| D6 | 0 元 = `terminated`；`-`／`－`／`—` = `suspended`（UI 併列原始標記）；其他未知 marker = `malformed` | 0 元經藥師確認；`-` 為藥師判斷（僅針對 `-`，故不擴及 `N/A`／`NA`／`無`，實測 0 次）。 |
| D7 | `data/status.json` **每次成功檢查都 commit**；大型資料檔只在差異時 commit | 區分「官方沒更新」與「build 壞了」；避免 60 天無活動停用排程。 |
| D8 | 分片清單在 `meta.json`，前端依最長符合前綴選檔 | 日後細分只改 build 端。 |
| D9 | 描述欄位：build 日有效列 → 已生效列中最新者 → 無則顯示代號＋「—」；**不以預告列回填**。shard 保存「各列不一致時的所有變體」，詳細頁依瀏覽器日期套用同一規則 | 來源以現況回填（非歷史值）；預告列實測出現損毀。shard 存變體可維持 shard 與 build 日無關。 |
| D10 | 每個 shard 帶**自己內容的 `shardVersion`**；`meta.shards.versions` 列出各片 hash，`dataVersion`＝該對照表的 hash，寫入 meta、index、status。前端比對 index↔meta 與 shard↔meta，不一致 → 不組合摘要、提示重新整理 | Pages CDN 快取約 10 分鐘，舊頁面或新載入都可能混到不同批次（verdict 2.1）。每片只帶自己的 hash：若每片都帶全域版本，改一個價格就會改寫全部 348 片，違反 B5（Phase 1 實作時發現，2026-09-11 修正）。hash 只依來源內容，shard 跨 build 日維持 deterministic。 |
| D11 | build workflow 使用 `concurrency` group（排隊、不取消）；push 被拒一律 fail，不 force push；Pages 由 main 分支根目錄部署 | 排程與手動觸發重疊時，避免較舊結果覆蓋較新結果（verdict 2.2）。 |
| D12 | 前端樣式沿用 `pharmacy-tool-style`；Chart.js stepped line，`spanGaps: false` | 臨床工具群視覺一致；step chart 反映區間內固定值。 |

---

## 3. 平台限制

- **GitHub Pages**：純靜態；單檔硬上限 100 MB、網站 1 GB、頻寬軟上限 100 GB／月；CDN 快取約 10 分鐘（→ D10）。
- **GitHub Actions**：scheduled workflow 在 repo 60 天無活動後停用（→ D7）；runner 對 `data.gov.tw` 可達性**未驗證**（失敗不擋 build）。
- **來源端點**：CSV 約 96 MB、下載約 18 秒；HTTP 無 `Last-Modified`；官方更新日取 data.gov.tw dataset 23715 `modifiedDate`。
- **瀏覽器**：index raw ≈ 22 MB、最大 shard `A0` raw ≈ 11 MB（gzip ≈ 1.84 MB／677 KB）；行動裝置解析時間未實測（E7）。
- **Git repo 成長**：官方月更 → 每月一次大型 diff；每週一次 status.json 小 commit。
- **資料本身**（spec §3.1）：224,811 列、45,179 代號；每代號恰 1 列 `9991231`；6 碼日期帶前綴空白；69% 現行為 0 元；82 列預告；衝突 0、重疊 0、壞日期 0、空窗 2 代號；描述欄位非歷史值；含字面 `?`。

---

## 4. 資料流

```
[info.nhi.gov.tw CSV] ──download（TLS 驗證；retry 5/10/20s；4xx 除 429 不重試）──┐
[data.gov.tw metadata 23715] ──失敗僅 warning──> sourceModifiedAt | null         │
                                                                                v
         decode（BOM）→ 內容驗證（非 CSV／HTML 錯誤頁／截斷 → FAIL）→ schema（必要欄位缺或歧義 → FAIL）
                                                                                v
   normalize：strip → ROC 6/7 碼 → ISO；9991231 → null；壞日期列 → invalidRecords（比例 > 1% → FAIL）
              支付價 → priced / terminated / suspended / missing / malformed
                                                                                v
   group by 代號 → 排序 → 去重（20 欄 strip 後全同）→ 衝突／overlap／gap（累計最大迄日）→ 只標記、不補值
                                                                                v
   事件推導（spec §5.4 互斥優先序）→ shards（含描述欄位變體、連結、flags）→ dataVersion = hash(shards)
                                                                                v
   index：描述欄位（D9，build 日）＋ window（build 日）＋ 搜尋卡摘要（參考日 = build 日）＋ flags
                                                                                v
   guards（spec §14）+ pytest + golden（凍結快照）──任一失敗 → FAIL：data/ 與 status.json 皆不動、不 commit
                                                                                v
   golden 代號的已核對區間在最新來源中被改寫 → WARNING（step summary），不 FAIL
                                                                                v
   diff（只比 drug_index.json + history/）
     有差異 → commit 資料 + meta.json + status.json
     無差異 → 只 commit status.json（result=unchanged）
   （concurrency group 排隊；push 被拒 → FAIL）
                                                                                v
                                         GitHub Pages（main 根目錄）
                                                                                v
   前端：載入 index + meta + status → 驗 dataVersion → 搜尋 → 選定 → fetch shard → 驗 dataVersion
         詳細頁：由 shard 完整 history 依瀏覽器日期推導現行價／摘要；搜尋卡：由 index window 判定
```

### 失敗行為總表

| 失敗 | 行為 |
|---|---|
| CSV 下載非 200／逾時／TLS 錯誤／HTTP 200 但內容非 CSV／截斷 | workflow fail；`data/`、`status.json` 不變；不 commit；GitHub 內建通知信 |
| 必要欄位缺失或模糊比對歧義 | fail，同上 |
| guards 任一不過（spec §14） | fail，同上 |
| data.gov.tw metadata 非 200／逾時／非 JSON／缺欄位 | 繼續；`sourceModifiedAt = null`；log warning；UI「無法取得」 |
| 單一 shard gzip > 2 MB／> 5 MB | warning（仍發布）／fail |
| 兩個 workflow 重疊 | concurrency 排隊；後者基於最新 main 重新 build；push 被拒 → fail |
| 前端 index／meta 載入失敗或 JSON 損毀 | 錯誤狀態＋重試；不得顯示「查無」 |
| 前端 shard 404／損毀／缺預期代號 | 錯誤狀態＋重試；不得顯示「0 筆歷史」或他代號內容 |
| 前端 `status.json` 載入失敗或時間無法解析 | 視同 > 45 天（紅色） |
| 前端 dataVersion 不一致 | 不組合摘要／圖表；提示「資料已更新，請重新整理」 |
| 使用者先選 A 再選 B，A 較晚回應 | 丟棄 A 的回應；畫面只顯示 B |
| 搜尋卡 window 耗盡（瀏覽器日期超過 window 最後一筆迄日） | 搜尋卡顯示「需更新，請開啟詳細頁」，不顯示確定價格 |

---

## 5. 驗收條件

每條均寫成可證偽斷言。「弱化」列出可能讓測試通過但功能壞掉的實作，以及斷言如何堵住。

### A. ETL／資料正確性

- **A1 日期正規化**：fixture 必含下列輸入並得到指定結果——
  `"  860301"` → `1997-03-01`；`"1040201"` → `2015-02-01`；迄日 `"9991231"` → `null`；迄日 `""` → `null`；**起日** `"9991231"` → 正常解析為 2910-12-31 且列入 build log 警告（不得套用開放哨兵）；**起日** `""` → invalidRecord（`blank_start`）；`"1041301"` → invalidRecord（`invalid_date`）；`"1050229"`（2016 閏年）→ `2016-02-29`；`"1060229"`（非閏年）→ invalidRecord；`"20150201"` → `2015-02-01`；迄日 `"abc"` → invalidRecord，**不得**成為 `to=null`；起日晚於迄日 → invalidRecord（`inverted_interval`）。
  - 弱化：只測 7 碼、把非法迄日當開放區間 → 由上列必含輸入堵住。
- **A2 價格狀態與逐筆守恆**：`12.50` → `(12.5, priced, raw "12.50")`；`0`、`0.00` → terminated；`-`、`－`、`—` → suspended；`""` → missing；`abc`、`-5`、`N/A`、`NA`、`無`、`NaN`、`inf` → malformed；非 priced 之 `price` 一律 `null`；`rawPrice` 等於 strip 後原字串。**全量**：每個代號的 `records` ∪ `invalidRecords` 與該代號來源列（去重後）**逐筆一一對應**，起迄日原值、`rawPrice`、`priceState` 全部相符。
  - 弱化：刪一筆終止列同時重複一筆有價列，總數仍守恆 → 由逐筆對應堵住。
- **A3 事件推導（依 spec §5.4 互斥優先序）**：序列 `[10, 10, 8, 0.00, 9, -, 9, 0.00]` →
  `[initial, unchanged, decrease(−2, −20.00%), terminated(previousPrice 8), relisted(previousPrice 8, +1, +12.50%, crossesStop), suspended(previousPrice 9), relisted(previousPrice 9, 0, 0.00%, crossesStop), terminated(previousPrice 9)]`，`priceChangeCount = 1`。
  另須通過：`[0.00, 12]` → `[initial, first_priced]`（差額 null）；`[10, 12]` → increase(+2, +20.00%)；`[3, 2]` → decrease(−1, −33.33%)（四捨五入）；`[10, "", 12]` → `[initial, unknown, unknown]`，`priceChangeCount = 0`；`["abc", 0.00]` → `[initial, unknown]`；`[0.00, 0.00]` → `[initial, unchanged]`；`[-, -]` → `[initial, unchanged]`；`[10, -, 0.00]` → `[initial, suspended(10), terminated(10)]`。
  - 弱化：差額全填 null、relisted 對比 0 元、relisted 計入次數 → 由精確數值與次數堵住。
- **A4 重複與衝突**：三列 20 欄（strip 後）全同 → 保留 1、`duplicateRowsRemoved = 2`；僅「藥商」不同 → 兩列都保留，且兩列之間事件為 `unchanged`、不增加 `priceChangeCount`；同代號＋同起迄日、三種不同價格 → 三列都保留、皆帶 `conflicting_price_interval`、`conflictingIntervals = 1`（計數單位＝(代號, from, to) 組）、相關事件為 `unknown`。
- **A5 gap／overlap**（累計最大迄日判定、閉區間）：前段迄日次日開始 → 無 gap；缺 1 天 → gap，flag 在空窗後那筆、空窗日期精確；端點同日 → overlap；長區間包覆兩筆短區間 → overlap、**不得**報 gap；開放區間後又有列 → overlap；任何情況 intervals 數不因偵測而增加。
- **A6 window 與 metadata**（build 日 D）：[現行, 預告 1, 預告 2] → window = [現行, 預告 1]（預告 1 為最早未生效者）；無預告 → 長度 1；D 無有效列但有未來列 → window = [最早未生效列]；D 無有效列且無未來列 → window 為空。所有描述欄位（中英文名、成分、規格、劑型、ATC、藥商）皆取 D9 規則選出之列；預告列成分損毀時不得被採用。D 當日有衝突 → window 該筆帶 conflict flag。
- **A7 determinism**：固定 input、build 日、檢查時間，兩個獨立 process（不同 `PYTHONHASHSEED`）→ `data/` 全部 byte-identical；只改檢查時間 → 僅 `status.json` 的時間欄位不同；來源列**任意重排**後 → 資料檔 byte-identical；同 input 不同 build 日 → `history/*.json` byte-identical 且 `dataVersion` 不變。
- **A8 全量集合一致**：來源去重後代號集合 = index 代號集合 = 所有 shard 代號聯集；shard 間無重複；每個 shard 內代號的 records 皆來自該代號；`meta.shards.files` 所列檔案全部存在；混合長短前綴時選最長符合者。

### B. Build／CI 安全

- **B1 來源失敗不覆寫**：mock CSV 端點分別回 500、逾時、TLS 錯誤、HTTP 200 + HTML 錯誤頁、HTTP 200 + 截斷 CSV → 皆非 0 結束；`data/` 與 `status.json` hash 不變；無 commit。4xx（非 429）不重試；暫時性錯誤重試 3 次、間隔 5/10/20 秒。
- **B2 schema 失敗**：必要欄位（`藥品代號`、`支付價`、`有效起日`、`有效迄日`）任一缺失 → fail；必要欄位模糊比對命中多個候選 → fail；欄位順序重排但內容相同 → 輸出與原序 byte-identical。
- **B3 guards 邊界**：列數 99,999 → fail、100,000 → pass；代號數 4,999 → fail、5,000 → pass；列數為前次已發布的 98.99% → fail、99.00% → pass；壞日期列比例 1.01% → fail、1.00% → pass（分母＝列數；同列雙日期錯誤計 1 列）；上述之外皆正常的合法候選 → pass。fail 時 `data/`、`status.json` 不變。
- **B4 metadata 失敗不擋 build**：data.gov.tw 回 500、逾時、非 JSON、缺 `modifiedDate` → build 成功、價格資料照常更新、`sourceModifiedAt = null`、log 含 warning；回應成功 → `sourceModifiedAt` 精確等於回應值。
- **B5 diff 行為**：同 input 第二次 build → `git diff --name-only` 僅 `data/status.json`，且 `lastCheckedAt` = 第二次檢查時間、`lastCheckResult = unchanged`；改一個代號的一個價格 → 該代號所在 shard、index、meta 更新，其他 shard 不變；同 CSV 但 build 日跨過某預告生效日 → index 更新、`history/` 不變。
- **B6 shard size guard**：注入 gzip 略低於／等於／略高於 warning 與 fail 門檻的 shard → 精確得到 無／無／warning 與 無／無／fail；超標者為第 N 片（非第一片）時同樣觸發；gzip 大小以實際壓縮計算，不得以 raw 冒充。
- **B7 並行**：兩個 build 同時觸發 → 依序執行；後執行者以最新 main 為基準；模擬 push 被拒 → fail，無 force push。
- **B8 語意異常 guard**（2026-09-11 使用者確認納入，verdict 2.6）：malformed + missing 價格列比例 1.01% → fail、1.00% → pass；前次已發布代號消失比例 1.01% → fail、1.00% → pass；fail 時 `data/`、`status.json` 不變。
  - 放行：同樣的 1.01% 輸入，以 `workflow_dispatch` + `allow_anomaly=true` 執行 → 發布成功，step summary 含觸發條件與數值；**排程觸發**帶同參數 → 仍 fail；`allow_anomaly=true` 時列數 99,999（B3）→ 仍 fail（放行不得擴及其他 guard）。

### C. 前端

- **C1 現行價判定（詳細頁由 history、搜尋卡由 window）**：以下每一案例都在「生效日前一天／當天／後一天」三個瀏覽器日期，各驗證搜尋卡與詳細頁——
  priced 245 → 2026-10-01 起 terminated：前一天顯示 245＋「⚠ 2026-10-01 起終止支付」；當天、後一天顯示「已終止支付（終止前 245 元）」且無預告標籤。
  priced 10 → 預告 priced 8：前一天顯示 10＋「2026-10-01 起調整為 8 元（−20.00%）」。
  terminated（終止前 10）→ 預告 relisted 20：前一天顯示「已終止支付（終止前 10 元）」＋預告「恢復支付 20 元」；終止前價格**不得**為 20。
  suspended → priced；空窗期間的日期 → 「此日期無支付紀錄（空窗）」。
  搜尋卡 window 耗盡 → 「需更新，請開啟詳細頁」，不得顯示任何確定價格；詳細頁仍由 history 正確判定。
- **C2 圖表不誤導**：chart 設定為 stepped、`spanGaps: false`；terminated／suspended／missing／malformed 區間與空窗在 dataset 中為 `null`，不得為 0；開放迄日畫至 max(今日, 最後預告起日)，x 軸不得出現 2910 年；預告區間 dataset 樣式（虛線／淡色）與已生效區間不同；有 priced 區間的代號，其圖表 dataset 非空。Phase 2 驗收時，對 11 個 golden 代號做**人工截圖審查**並存檔於 `.ai-review/screenshots/`。
- **C3 過期警示**：天數 = 瀏覽器本地日期 − `lastCheckedAt` 的 +08:00 日期。21／22／45／46 天 → 無／黃／黃／紅；`status.json` 404、JSON 損毀、時間無法解析 → 紅；紅色時現行價旁同步加註。
- **C4 搜尋**：比對為不分大小寫的子字串（代號另支援前綴）。`AC48092100` → 第一筆為該代號，即使另有 > 50 筆候選；`ac4809` → 含該代號；「撫緒」、`caremod`、`paroxetine` → 各自含該代號；符合項位於全資料第 50 筆之後仍可找到；終止品項不被排除；空白查詢 → 顯示提示、不列結果；不存在字串 → 空結果訊息；任何查詢 render ≤ 50 筆。
- **C5 deep link**：兩個位於不同 shard 的代號，以 `?code=` 直接開啟與重新整理，標題、價格、歷史均與 URL 相符；index 載入中不顯示「查無」；`?code=ZZZ` → 「查無此代號」且不殘留前一品項內容；專案子路徑（`/NHI-drug-price-history/`）下有效。
- **C6 聲明**：搜尋頁與詳細頁，在桌面（1280px）與行動（390px）視窗中，免責聲明全文可讀、未被截斷或遮蔽。
- **C7 shard 失敗與競態**：shard 第一次 404、第二次成功 → 按重試後呈現完整歷史並解除錯誤；錯誤期間不顯示他代號內容或「0 筆」；shard JSON 損毀或缺預期代號 → 錯誤狀態；選 A（延遲 2 秒）後立即選 B（即時）→ 最終畫面只有 B。
- **C8 核心資源失敗**：index 或 meta 404／JSON 損毀 → 錯誤狀態＋重試，搜尋框不得回報「查無」；dataVersion 不一致（index、shard、meta 任兩者）→ 不顯示摘要與圖表，提示重新整理。

### D. Golden（Phase 1 完成條件）

- **D1 獨立來源雙向核對**：11 個代號，由臨床藥師於**健保署藥品查詢網站**核對。核對表逐列分三欄：網站可驗證的日期與數值、CSV 原字串、藥師判定狀態；另記錄**網站列數 vs CSV 列數**、漏列、多列、核對人、日期。網站未提供的資訊標「不可核對」，不得填 ✓。
  - 若網站**不提供完整歷史**：完成條件改為「網站可取得部分全部 ✓；其餘列由藥師抽核 CSV 原檔並註記」，於核對表明記。
- **D2 反例性質綁定**：golden fixture 除 intervals 外，須含**預期事件序列、參考日摘要（現行價、最新事件、調價次數、總變化）、選用的描述欄位列**。11 個代號全部必選，其中 8 個為反例代號，各綁定一條可執行斷言：

| 代號 | 天真規則的誤判 | 綁定斷言 |
|---|---|---|
| `AC48867100` | 恢復支付對比 0 元、或算成調價 | relisted 的 previousPrice＝29.80；不計入次數 |
| `A020296321` | 首列 0 元後首次有價被標為恢復支付；首列 0 元被標為「終止」 | 第 2 筆事件＝first_priced；首列區間 UI 標籤＝「健保支付價 0 元（此前無有價紀錄）」且不含「終止」 |
| `B009254100` | 暫停被當 0 元或被刪除 | `-` 列存在、state＝suspended、raw＝`-` |
| `BC23981100` | 空窗被補值或畫成連續 | 空窗後那筆帶 gap_before；chart dataset 在空窗期間無點 |
| `A035680329` | 同上（1 個月空窗） | 同上 |
| `AB47689100` | 預告調價被當現行 | 參考日 2026-09-11 現行價≠預告價；2026-10-01 則相等 |
| `BC05037209` | 預告終止被當現行 | 參考日 2026-09-11 現行＝245；2026-10-01 現行＝已終止（終止前 245） |
| `BC26467100` | metadata 取損毀預告列 | 參考日 2026-09-11 的 ingredient 不含 `2412402210` |

  其餘 3 個（`A017014321` 24 列＋同價續期、`AC48092100` 一般降價、`AC48845100` 現行終止）綁定完整事件序列與摘要。
- **D3 凍結快照，與日曆脫鉤**：golden test 使用 `tests/fixtures/source_snapshot_2026-09-11.csv`（上述 11 個代號的原始列）並以**固定參考日期**（2026-09-11、2026-10-01）執行，10/1 之後仍可重現預告案例。每週最新來源另檢查「已核對區間是否被改寫」：被改寫 → WARNING（step summary），不 FAIL；新增區間 → 不警告。**不得**以 ETL 輸出自動覆寫 golden 預期值。
  - 核對時限：預告日 2026-10-01 前完成（網站在該日後可能不再顯示預告狀態）。

### E. 摘要與完整性（verdict 3.25）

- **E1 總變化**：首筆有價 30、參考日前最後有價 20、未來預告 25 → 總變化 −10（−33.33%），不得用 25；從未有價 → 「無有價紀錄」；僅一筆有價 → 「僅一筆有價紀錄」；已終止者標「至終止前」。
- **E2 最新事件**：最新已生效事件為 terminated → 「已終止支付（終止前 X 元，日期）」，X＝該事件 previousPrice；最新為 unchanged → 跳過，往前找；只有 initial／first_priced → 「無調價紀錄」；最新為 unknown → 「最近一次變動無法判定（來源資料異常）」。
- **E3 表格完整性**：詳細頁歷史表列數＝該代號 records 數＋invalidRecords 數；每列顯示原始起迄日與 rawPrice；invalidRecords 標「日期異常」。
- **E4 品質標記歸屬**：gap、conflict、`?` 字元、inconsistent_metadata 旗標只出現在對應代號的詳細頁與搜尋卡；無旗標代號不顯示任何品質提示。
- **E5 連結歸屬**：`藥品代碼超連結` 顯示為「TFDA 許可證資料」且 href 等於來源值；`給付規定章節連結` 為空 → 不顯示該連結。
- **E6 混批偵測**：注入 `shard.shardVersion ≠ meta.shards.versions[prefix]`，或 `index.dataVersion ≠ meta.dataVersion` → 詳細頁不顯示摘要與圖表、提示重新整理（同 C8）。
- **E7 效能量測**：Chrome DevTools CPU 4x throttle + Fast 4G，全量資料。記錄：index fetch 開始→解析完成時間、解析完成→首次可搜尋 < 200 ms、前 50 筆 render < 100 ms、shard 取得後 chart render < 300 ms。量測結果寫入 Phase 2 驗收紀錄；解析時間過長時依 spec §16 精簡（不得刪除 rawPrice）。

---

## 6. 未決事項

1. ~~首列 0 元的語意~~ → **已定案（2026-09-11）**：state 維持 `terminated`；「此前從未有價」的 0 元區間 UI 標籤為「健保支付價 0 元（此前無有價紀錄）」，不得含「終止」（spec §5.3）。
2. ~~B8 語意異常 guard~~ → **已定案（2026-09-11）**：納入，附 `workflow_dispatch` + `allow_anomaly=true` 人工放行（僅限語意 guard、排程觸發不得放行）。
3. data.gov.tw 從 runner 的可達性未驗證（失敗不擋 build）。
4. 健保署查詢網站是否顯示完整歷史未確認（D1 已定義兩種完成條件）。

---

## 7. 專案前提

- 使用者：臨床藥師為主；查詢型。
- 無認證、無機密、無病患資料。
- 最大風險：**誤導**——把已終止品項顯示為有價、把暫停／終止畫成 0 元連續價格、把預告當現行、資料過期卻無警示、錯誤 build 覆寫正常資料、混批資料組合成錯誤摘要。
- 不做診斷或用藥建議；支付價 ≠ 採購價／零售價／自付額。

---

## 修訂紀錄

| 版本 | 修改 | 依據 plan-verdict |
|---|---|---|
| v1 | 初版送審 | — |
| v2 | 詳細頁改由完整 history 推導；window 僅供搜尋卡，新增「window 耗盡」狀態；無現行但有未來 → window＝[最早未生效列] | 1.1、4.1 |
| v2 | 衝突日期顯示「無法判定單一支付價」；衝突事件＝unknown | 1.2 |
| v2 | 新增 invalidRecords；守恆改逐筆對應；壞日期比例定義 | 1.3、3.1、3.2 |
| v2 | 移除 lastPricedPrice；終止前價格取事件 previousPrice；摘要以參考日期為準；最新事件跳過 unchanged | 1.4、E1、E2 |
| v2 | 事件互斥優先序表；`N/A`／`NA`／`無` 改歸 malformed | 1.5、3.3 |
| v2 | 前端各資源四態、競態、C8 | 1.6、3.21 |
| v2 | 閉區間、瀏覽器本地日期、不跨午夜更新、搜尋比對定義、空白查詢 | 1.7、3.17、3.18 |
| v2 | 文件覆蓋規則、golden 11 個、deep link 屬 MVP、門檻寫法統一 | 1.8 |
| v2 | 新增 dataVersion（D10） | 2.1、E6 |
| v2 | concurrency、不 force push、Pages 部署路徑（D11）；不另建線上驗證 job | 2.2、B7 |
| v2 | window 加 rawPrice／previousPrice／事件欄；連結放 shard；index 加 flags；描述欄位取列順序（D9） | 2.3 |
| v2 | generatedAt 標示為「本站資料產生時間」；meta＝已發布批次統計 | 2.4 |
| v2 | 效能量測方式；不得刪 rawPrice | 2.5、E7 |
| v2 | B8 語意異常 guard（待確認） | 2.6 |
| v2 | A1–A8、B1–B6 補強為邊界與性質斷言 | 3.1–3.14 |
| v2 | C1–C7 補強；圖表改設定斷言＋人工截圖 | 3.15–3.21 |
| v2 | golden 雙向核對、反例性質綁定、凍結快照與 WARNING 分工 | 3.22–3.24、4.2 |
| v2 | 新增 E 類驗收 | 3.25 |
| v2.1 | D10 改為每片 `shardVersion`＋meta 對照表（原設計與 B5 衝突，Phase 1 實作時發現）；分片改前 4 碼（2 碼時 A0 gzip 3.35 MB 超過 warning） | 實作回饋 |
