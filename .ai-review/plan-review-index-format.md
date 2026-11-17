# Codex 規格覆審 — spec-index-format v0.1

- **審查日期**：2026-09-23
- **覆審員**：Codex（`mcp__codex__codex`，sandbox `read-only`、approval-policy `never`）
- **規劃文件**：`spec-index-format.md` v0.1（2026-09-23 建立，未覆審）
- **指令**：`/codex-checkplan`

> 以下為 Codex 原始輸出，**未經修飾、未刪改**。逐項判定見 `plan-verdict-index-format.md`。

---

# 獨立規格覆審報告

結論：`spec-index-format.md v0.1` 尚不適合進入正式實作。方向本身合理，columnar 並非明顯 over-engineering；但目前有兩個 Blocker：

- 驗收所需的「舊格式獨立基準」沒有被保存或指定，F1／F2／F4 很容易變成循環驗證。
- F10 尚無數值、統計方法與候選方案決策規則，因此本版規格依自己的流程仍不可驗收。

另有數項 High：抽驗無法支撐臨床資料完整性、missing→null 是有損轉換、schema 與部署混批契約不完整。

---

## 1. 需求與邊界缺漏

### 1.1 舊格式基準產物未定義

- 嚴重度：Blocker
- 問題：F1、F2、F4 都需要「轉換前後兩份資料」，但 PR 合併後只保留新格式；規格未指定舊檔從哪裡取得、以何種 hash 鎖定。CI 若只 checkout 新 commit，極可能只剩新檔。
- 為什麼現在不修之後會更貴：實作者可能由新格式反解出「舊格式」，再與同一份新格式比較，形成自我證明；等發現時，舊格式基準可能已不易從自動化流程重現。
- 建議修法：規格指定一份不可由待測轉換器產生的 legacy oracle，包括來源位置、精確 SHA-256、筆數與 `dataVersion`。F1／F2／F4 必須直接讀此基準，而非先從新檔重建。

### 1.2 missing→null 與「內容不變」矛盾

- 嚴重度：High
- 問題：§3.2 規定舊格式缺 key 時寫 `null`，這是有損轉換；反轉後無法區分「原本缺 key」與「原本存在且為 null」。因此不可能同時滿足 F4 的原檔逐欄相等。
- 為什麼現在不修之後會更貴：一旦 `columnar/1` 發布，missing/null 語意即成為永久格式契約；之後只能升版或接受既有資料不可逆。
- 建議修法：二選一並寫死：

  - `columnar/1` 只接受所有規定 key 都存在；缺 key 視為轉換失敗，不得發布。
  - 或正式定義哪些欄位以 missing≡null 正規化，並將「逐筆逐欄相等／內容一位元不變」改成明確的正規化後語意相等。

  查證目前 45,179 筆 index 與 45,258 筆 window row，所列欄位均無缺 key，因此首案對本次遷移可行。

### 1.3 window 索引公式有歧義

- 嚴重度：High
- 問題：§3.1 寫「`rows[i][N][k]` 對應 `windowFields[k]`」，但 `rows[i][N]` 是 window rows 陣列，`[k]` 取到的是第 k 個 window row，不是 row 中第 k 個欄位。
- 為什麼現在不修之後會更貴：JS、Python、轉換器可能各自做出不同解讀，且都能生成合法 JSON。
- 建議修法：明確寫成三維座標，例如第 `r` 個 window row 的第 `k` 欄；同時明訂每個 window row 長度必須恆等於 `windowFields.length`。

### 1.4 必要欄位集合不完整

- 嚴重度：High
- 問題：§4.1 只要求「至少 haystack 四欄與 searchCard 所需」，但搜尋卡 UI 還讀取 `strength`、`strengthUnit`、`dosageForm`、`lastPriceChangeDate`、`historyCount`、`priceChangeCount`、藥品層 `flags`。`windowFields` 更沒有定義 validator 必須包含哪些欄位。
- 為什麼現在不修之後會更貴：缺欄可能通過 validator，直到特定搜尋結果才顯示錯值、`undefined` 或失敗；這正是格式錯位最危險的延遲發現方式。
- 建議修法：把 §3.3 的 14 個 drug fields 與 13 個 window fields 定義為 `columnar/1` 的完整 mandatory set。可允許未知附加欄位以支援向前相容，但所有既定欄位都不得缺漏。

### 1.5 值域與型別契約不足

- 嚴重度：High
- 問題：「型別與舊格式相同」不是可執行的 schema。未逐欄定義 string／number／boolean／null／array、nullable 欄位、日期有效性、flags 型別，以及 `priceState`、`eventType` 的允許值。
- 為什麼現在不修之後會更貴：JS 與 Python 可各自用不同推論；例如 `"0"`、`0`、`null`、空字串都可能被不一致地接受，卻不一定使 JSON 解析失敗。
- 建議修法：在規格附一張逐欄型別與 nullable 表，沿用 `spec.md` 現有語意，不新增欄位或臨床規則。型別不符必須在建置端拒絕發布。

### 1.6 rows 為空、代號重複及排序未封閉

- 嚴重度：Medium
- 問題：目前 `rows: []` 可通過；重複 `code` 也未禁止。重複代號會使搜尋陣列與 `byCode` 對同一代號呈現不同資料。
- 為什麼現在不修之後會更貴：空資料會被表現成「搜尋不到」而非資料失敗；重複 code 可能只在詳細頁與搜尋卡對不上時才被發現。
- 建議修法：將既有「每個 unique NHI code 一筆」正式列為 validator／builder invariant，並要求 code 唯一、非空且輸出順序 deterministic。
- `[新增需求]`：若要讓瀏覽器也拒絕合法 JSON 的空 index，需明訂 `rows.length > 0`，或與既有 `meta.uniqueDrugCodeCount` 相等。不做的具體後果是截斷成空陣列時網站會進 ready 狀態並誤顯示無結果。

### 1.7 一次性轉換失敗路徑未定義

- 嚴重度：Medium
- 問題：未規定輸入已是 columnar、legacy 檔損毀、round-trip 失敗、輸出中斷時的結果，也未明說失敗不得留下可被 commit 的半成品。
- 為什麼現在不修之後會更貴：一次性工具通常只執行一次，最容易在沒有第二次實戰機會時把錯誤產物納入 PR。
- 建議修法：沿用既有 builder 的 fail-closed／全有全無契約：任何輸入格式、schema、round-trip 或 determinism 失敗，都不得產生可發布結果；重跑同一 legacy 輸入必須得到相同 bytes。

### 1.8 既有 builder 的「前次 index」消費契約未涵蓋

- 嚴重度：Medium
- 問題：規格只要求 builder 產出新格式，但既有消失代號 guard、diff 判定與 migration 判定也會讀前次 index。這些行為未列入新格式遷移的保持範圍。
- 為什麼現在不修之後會更貴：首次 PR 可能正常，下一次排程才在讀前次 columnar index 時失敗或失去代號消失 guard。
- 建議修法：明訂所有既有「讀前次 index」的 guards 與 changed 判定都必須支援已發布的 `columnar/1`，並納入第二次連續 build 的驗收。

### 1.9 HTTP／逾時／重入契約只靠隱含繼承

- 嚴重度：Low
- 問題：本案沒有新的外部 API；NHI 非 200 屬既有 builder 範圍。但瀏覽器取得 index 的 404、非 JSON、timeout、重試競態，沒有在本規格明確指出不得因 `indexFormat` 改動而重新分類。
- 為什麼現在不修之後會更貴：實作者可能把所有載入失敗都歸成 `version_mismatch`，失去既有「可重試」與「重新整理」的區分。
- 建議修法：明確引用既有核心資源四態與序號式重入規則：只有成功解析後的 format/dataVersion 不符才是 mismatch；HTTP、network、timeout 仍走既有 unavailable/error，舊請求不得覆蓋新請求。

---

## 2. 架構風險

### 2.1 「同一 commit 無順序風險」不成立

- 嚴重度：High
- 問題：`spec.md` 已明載 GitHub Pages CDN 可能混批；同一 commit 並不代表 `app.js`、`engine.js`、`meta.json`、`drug_index.json` 同時切換。SW 的 shell 亦可能在離線 fallback 時提供舊前端。舊前端讀新 index 會因缺 `drugs` 走 invalid，而不是本規格承諾的 version mismatch。
- 為什麼現在不修之後會更貴：此問題只會在實際 CDN／已開啟頁面／SW 狀態下出現，本機及一般 e2e 難以重現；發布後才會看到部分使用者不可搜尋。
- 建議修法：刪除「順序風險不適用」的結論，改成明列四種混批矩陣：新前端＋新 index、新前端＋舊 index、舊前端＋新 index、舊前端＋舊 index，以及各自必須 fail closed 的 UI。若要求四種情境都顯示同一「重新整理」文案，需採相容性 rollout；這不要求 builder 同時產雙格式，但會要求過渡期 consumer 能辨識 legacy。
- 衝突說明：不能用 SW 快取 data、不能靠伺服器協調原子切換；相容作法只能放在靜態前端／發布順序與 fail-closed 行為。

### 2.2 抽驗位置式資料與臨床風險不相稱

- 嚴重度：High
- 問題：只驗前 N 列允許第 N+1 列之後的短列、長列或 window 錯位直接進 ready。位置式格式的核心風險恰好是單列錯位後仍為合法 JSON。
- 為什麼現在不修之後會更貴：錯誤可能只影響某個低頻代號，既不觸發 `dataVersion`，也不一定 crash，而是靜默顯示另一欄的價格或狀態。
- 建議修法：規格必須要求在進入 ready 前，每個 drug row 與每個 window row 都完成形狀驗證。效能上可與必經的 prepare／projection traversal 合併，不必另做第二次 45,179 筆掃描。
- 衝突說明：這不改變全量 index 載入、不快取 data，也不改 shard；僅修正「抽驗足以保證安全」的錯誤假設。

### 2.3 JS／Python 等價與「建置端全量驗證」互相衝突

- 嚴重度：High
- 問題：§5.4 要求 Python 與 JS 做相同判定；§4.1 又允許 JS 只抽驗，並稱逐列錯誤由 Python 擋。若「相同」包含抽樣策略，Python 也不會全量擋；若 Python 全量檢查，兩者又不可能對所有 fixture 完全等價。
- 為什麼現在不修之後會更貴：兩套 validator 完成後才會發現無法同時滿足 F7 與 builder guard，必須重寫測試契約。
- 建議修法：把 validator 分成兩層契約：

  - 共通 schema／reason 規則：JS 與 Python 必須等價。
  - 驗證覆蓋範圍：建置端全量；runtime 也須在 prepare 必經 traversal 中全量驗 shape，或清楚定義不同 profile。

  F7 只比較共通規則，不應用「都抽前 50 列」達成表面一致。

### 2.4 最難回頭的是 null 與位置 schema，不是 (a)/(b)

- 嚴重度：High
- 問題：(a)/(b) 是 consumer 實作策略，可替換；真正不可逆的是 `columnar/1` 對欄位順序、missing/null、nested window 與型別的定義。
- 為什麼現在不修之後會更貴：格式發布後，任何釐清都可能構成語意變更並迫使升 `columnar/2`。
- 建議修法：在原型前先凍結完整 schema、型別表、null 規則及精確索引公式；(a)/(b) 可維持待量測決定。

### 2.5 direct rows 若外洩會形成第二套資料模型

- 嚴重度：Medium
- 問題：方案 (b) 若讓 row index／欄位 position 散落到 render、搜尋、詳細頁或比較頁，未來格式升版會撞到大量 consumer。
- 為什麼現在不修之後會更貴：初次實作可能最快，但欄位位置會成為非正式 API，日後很難證明 searchCard 收到的仍是舊 logical model。
- 建議修法：規格應把「columnar 僅是輸入表示法，對 searchCard／renderCard 可觀察的 logical drug contract 不變」列為架構 invariant；(b) 的 row 表示不得成為其他模組的公開契約。

### 2.6 `dataVersion` 保持不變是正確決策

- 嚴重度：無缺口
- 問題：無。`dataVersion` 代表來源內容，另用 `indexFormat` 表示生成規則／序列化版本，符合既有 `UPCOMING_GENERATOR_VERSION` 前例。
- 為什麼現在不修之後會更貴：不適用。
- 建議修法：保留此決策；不要把表示法變更混入來源版本，也不要為此改 data 快取策略。

---

## 3. 驗證策略缺口

| 驗收 | 嚴重度 | 可通過但功能壞掉的弱化實作 | 為什麼晚發現更貴 | 建議改寫的斷言 |
|---|---|---|---|---|
| F1 | High | 「舊」與「新」兩邊都先經同一個錯誤 decoder，或兩邊實際都讀新檔；錯位後仍得到相同 searchCard 結果。非 searchCard 讀取欄位被破壞也完全不會被發現。 | 會把循環驗證誤當獨立 oracle，直到臨床個案才暴露。 | 舊側必須直接使用 hash 鎖定的 legacy object，不經新 decoder；新側使用 columnar consumer。逐 code、逐指定 T 比較回傳值與是否拋例外。反向哨兵須指定破壞的 code、欄位、T，並斷言測試確實因該 code/T 出現差異。 |
| F2 | High | 兩側共用同一個錯誤 drug view；或測試資料剛好沒有 `true` mask，全部回 false 仍相等。 | 終止品項可能被錯誤顯示或錯誤隱藏，且搜尋總數仍看似合理。 | 以 legacy object 直接算 expected；斷言陣列長度、每個 index 對應 code、每項布林相等，並斷言 fixture 同時含 true 與 false，以及 terminated、priced、suspended、conflict、overlap、exhausted 類別。 |
| F3 | High | 只跑「今天」與少數 2-row 項目；未覆蓋空 window、單列、open-ended、gap、overlap、conflict、各 priceState。也可能把「多個 T」實作成重複日期。 | 邊界日錯誤只會在公告生效當日出現，發布前通常無法人工發現。 | 明列 T 的產生規則：每個 window row 的 `from-1`、`from`、`to`、`to+1`（to 非 null），加固定今天；另列空 window。報告必須輸出實際唯一 T 數及各反例類別命中數，不能只寫「涵蓋多個日期」。 |
| F4 | Blocker | 由新格式反解出舊格式，再與同一反解結果比較；忽略 key presence、型別或 missing/null；只比較 JSON parse 後值，不檢查 deterministic bytes。 | 這是唯一宣稱能證明「所有欄位沒變」的條件，一旦循環，其他驗收只看部分行為。 | 使用獨立 legacy oracle；反轉後以 canonical serializer 產出，要求與 legacy canonical bytes 完全相同，並逐筆檢查 key set、陣列長度、型別與值。另要求同一 legacy 輸入轉換兩次的輸出 bytes 與 SHA-256 相同。 |
| F5 | Medium | 單元測試只驗 reason；e2e 只找到文案，但搜尋仍保持舊資料可用，或 background prepare 已執行。只測錯字串，不測缺欄位。 | 混批時可能短暫呈現舊價格，違反 fail closed。 | 分別測 indexFormat 缺漏、錯值、非字串；斷言 validator reason、core 狀態、搜尋框 disabled、無結果卡、無舊 `byCode/prepared` 可見資料、提供 reload 而非 retry。另加入舊前端＋新 index 的部署混批案例。 |
| F6 | High | 只刪除一個 haystack 欄位；validator 的「必要欄位」清單本身漏掉 UI 或 window 欄位，測試仍綠。 | 缺失欄位會在特定結果卡或特定價格狀態才暴露。 | 對 14 個 drug fields 與 13 個 window fields 逐一做刪除測試；另測 duplicate、空字串、非字串。每一項都必須回 invalid。未知附加欄位是否允許亦須有正向斷言。 |
| F7 | High | Python 直接呼叫 JS；兩邊共用同一錯誤 helper；fixture 沒有 expected，只斷言兩邊彼此相等；兩邊都錯仍全綠。 | 失去雙 validator 的縱深，與過去日期 validator 的教訓完全相同。 | fixture 每案必須帶獨立 expected `{ok, reason}`；JS 與 Python 各自對 expected 驗證，不只互比。明列反例：無效日、duplicate fields、短／長 drug row、短／長 window row、錯型別、missing/null、重複 code、空 rows、format mismatch 與 dataVersion mismatch 優先序。禁止其中一端委派另一端執行。 |
| F8 | Medium | 刪掉重要測試後補相同數量的空測試；大量 skip/todo 仍由 CI 回成功；更新 fixture 讓錯誤輸出成為新 expected。 | 「245／221／171」只能證明數量，不能證明原有性質仍被測。 | 改成列出必跑 suite 與本案新增的 mandatory test IDs；要求零 failure、零 unexpected skip/todo，並保留 hash 鎖定的 legacy oracle。測試數量只作資訊，不作主要斷言。 |
| F9 | Medium | guard 測試直接呼叫孤立 helper，但正式 build 未把 `drug_index.json` 傳入；測的是 raw bytes、錯誤 compression level，或 warning 沒有出現在 build output。 | 直到 index 再度膨脹才會發現 guard 從未接入發布路徑。 | 經完整 build/publish 路徑測試：實際生成的 index canonical bytes 以規定 gzip level 6、固定 header 計算；等於門檻通過、超 1 byte 分別 warning/fail；fail 時所有 data/status 均不變，warning 必須出現在結果與 step summary。 |
| F10 | Blocker | v0.2 可事後填入寬鬆門檻；只取一次最漂亮數字、使用 warm cache、不同 Chromium、不同資料、不同 baseline，或只量選中的方案。 | 實作完成後再定門檻會形成不可證偽的「量到什麼就接受什麼」。 | 在正式實作前凍結：legacy baseline 與 (a)/(b) 必須在同一資料、瀏覽器版本、冷 cache、4x CPU、9 Mbps/60 ms 條件交錯量測；定義重複次數、採 median 或指定 percentile、離群規則。選較佳方案後，其合計相對同輪 baseline 必須改善至少 500 ms；未達即中止。v0.2 填妥前 F10 不得標示可驗收。 |

### 3.1 跨 F1–F10 的額外缺口

- 嚴重度：High
- 問題：目前沒有一條驗收直接要求「所有 drug row 與所有 window row 全量 shape/type 驗證後，才允許發布及進入 ready」。
- 為什麼現在不修之後會更貴：F1/F2 只驗被判定函式讀取的欄位；F4 可能被循環實作；前 50 列抽驗則明確漏掉其餘 45,129 筆。
- 建議修法：將此性質加入 F4 或 F7：builder 全量驗證 45,179 個 drug rows、45,258 個 window rows；runtime 在必要 traversal 中全量驗 shape。報告需輸出實際驗證筆數，不能只寫「驗證成功」。

---

## 4. 更簡單的替代方案

### 4.1 是否 over-engineering

- 嚴重度：Low
- 問題：columnar 加 `fields/windowFields` 看似增加 schema 元件，但實測節省 33.8%，且不裁欄位；相較於首屏阻塞 4.8 秒，複雜度有量測依據。
- 為什麼現在不修之後會更貴：若因「簡化」退回只移除 manufacturer/ATC 或 sparse serialization，只得到 12.5%／18.5%，可能無法跨過 500 ms 中止條件，之後仍要再做一次格式遷移。
- 建議修法：保留 columnar 方向，但先補齊 schema、驗證 oracle、部署混批與 F10；不建議回退到已量測較差的方案。

### 4.2 最簡單且符合既有限制的版本

- 嚴重度：Medium
- 問題：目前同時保留 (a)/(b)、一次性 converter、builder validator、JS validator、Python validator，容易各自長出不同 schema 解讀。
- 為什麼現在不修之後會更貴：若 schema 規則散落在多份敘述中，新增欄位時會重演跨語言不一致。
- 建議修法：維持一個 `columnar/1` 邏輯 schema 契約、一條 production builder 路徑、一份 hash 鎖定 legacy oracle；(a)/(b) 僅在原型期並存，v0.2 必須選定一個後刪除另一個作為正式驗收對象。這不需要雙格式 production 輸出。

### 4.3 固定 tuple、不帶 fields 的更簡單方案

- 嚴重度：Medium
- 問題：可把欄位順序直接綁在 `columnar/1`，移除 `fields/windowFields` 與 name→position mapping，格式更小、更簡單。
- 為什麼現在不修之後會更貴：它會使欄位位置成為前端硬編碼 ABI，日後任何插入、重排或跨語言偏差都必須升版，且診斷性較差。
- 建議修法：不建議採用。
- 衝突說明：此方案直接衝突於本規格「前端不得寫死欄位順序」，也削弱演進彈性；除非量測證明 `fields` mapping 本身造成不可接受成本，否則沒有足夠理由改採。

### 4.4 砍欄位、分頁、伺服器查詢或快取 data

- 嚴重度：不適用
- 問題：這些方案可能表面更簡單或更快，但分別違反「欄位不移除」、全量瀏覽器搜尋、無後端、data 不經 SW 快取等已聲明限制。
- 為什麼現在不修之後會更貴：會改變產品功能或臨床資料新鮮度模型，不是本案的等價替代。
- 建議修法：排除，不列為本案替代方案。

### 4.5 representation hash

- 嚴重度：Medium，`[新增需求]`
- 問題：`dataVersion` 不涵蓋 index 序列化 bytes，因此無法在 runtime 偵測「合法 JSON、format 正確、dataVersion 正確，但某個位置值被改壞」。
- 為什麼現在不修之後會更貴：位置式格式的有效 JSON corruption 可能靜默顯示錯價。
- 建議修法：本案可先以全量 builder驗證、獨立 round-trip oracle及 runtime shape 驗證控制風險；若仍要求 runtime 對表示法內容具密碼學完整性，才新增獨立 `indexArtifactHash`。
- 衝突說明：加入 hash 會修改 `meta.json` 或引入額外 manifest，與本案「meta.json 不碰」的非目標衝突，因此不應默認納入，需由產品方另行決定。

最小可接受修訂範圍是：補齊精確 schema、移除 missing/null 矛盾、保存獨立 legacy oracle、改為全量 shape 驗證、補部署混批矩陣，並在 v0.2 先凍結 F10 數字與量測方法。其他架構限制，包括全量載入、network-first、data 不快取、來源型 `dataVersion`、動態 shard prefix，均不應改動。
