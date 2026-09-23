# spec-index-format — `drug_index.json` 表示法瘦身

> 版本 **v0.3**（2026-09-23，**兩輪覆審後定案**，可進入 §6 原型階段）
> 本文件只定義 `data/drug_index.json` 的**序列化表示法**。資料模型、判定規則、
> shard 格式一律仍以 `spec.md` 為準，本文件不新增也不移除任何欄位語意。
> 與 `spec.md` §7 衝突時，以本文件對 index 表示法的定義為準；其餘以 `spec.md` 為準。
>
> 修訂依據：`.ai-review/plan-verdict-index-format.md`（第一輪）、
> `.ai-review/plan-verdict-index-format-r2.md`（第二輪）。修訂紀錄見 §11。

---

## 1. 問題

`drug_index.json` 是首屏的阻塞路徑：`app.js` 對 `meta.json` 與 index 做
`await Promise.all(...)`，兩者都到齊才進 `core: 'ready'`，使用者才能搜尋。

2026-09-23 實測（`scripts/measure_e7.mjs`，CPU 4x throttle、9 Mbps／60 ms latency、gzip level 6）：

| 指標 | 現況 |
|---|---|
| `indexFetchToParsedMs` | **4,433 ms** |
| `parsedToSearchableMs` | **382 ms** |
| 合計到可搜尋 | **4,815 ms** |

檔案 gzip **3,283,972 B**（raw 30,256,858 B、45,179 筆、45,258 個 window 列）。
9 Mbps 下純下載約 2.9 秒。

Service Worker 為 network-first 且 `data/` 完全不經快取，因此**回頭客每次開站都實付這 3.28 MB**。

### 1.1 成本歸屬（實測，非估算）

逐欄位移除後重新 gzip 量測的真實貢獻：

| 欄位 | gzip 貢獻 | 佔比 | 參與搜尋 |
|---|---|---|---|
| `window` | 808,401 B | 24.6% | searchCard／terminatedMask |
| `chName` | 615,965 B | 18.8% | ✅ haystack |
| `ingredient` | 550,466 B | 16.8% | ✅ haystack |
| `enName` | 535,890 B | 16.3% | ✅ haystack |
| `manufacturer` | 246,493 B | 7.5% | ❌（UI 詳情頁讀） |
| `code` | 223,887 B | 6.8% | ✅ haystack |
| `atcCode` | 169,001 B | 5.1% | ❌（UI 詳情頁讀） |
| 其餘 7 欄合計 | 617,000 B | 18.8% | 部分 |

**`window` 不含可裁的歷史列**：實測平均 1.00 列／筆（45,100 筆 1 列、79 筆 2 列、最長 2 列），
裁切「只留現行列及其後」的模擬省 **0 B**。歷史事件本來就在 shard。

### 1.2 方案比較（全部實跑 gzip，非估算）

> ⚠ **v0.3 更正**：本表在 v0.1–v0.2 是錯的。原量測腳本的欄位清單手打時漏了
> `atcCode`、`manufacturer`、`changeFlag`、`absoluteChange`、`percentChange` 共 5 欄，
> 因此「欄位陣列化 33.8%」其實是**偷偷砍掉 5 欄**的數字。下表由轉換器
> （`scripts/convert_index_columnar.py`）的欄位常數重新量測，不再手打清單。

| 方案 | gzip | 省下 | 裁欄位？ |
|---|---|---|---|
| 現況 | 3,283,972 | — | — |
| 移走 `manufacturer`+`atcCode`（物件格式） | 2,872,472 | 12.5% | 砍 2 欄 |
| 稀疏序列化（物件格式） | 2,751,544 | 16.2% | 砍 2 欄 |
| **欄位陣列化，完整 14+13 欄（本案採用）** | **2,552,937** | **22.3%** | **不砍** |
| 欄位陣列化 ＋ 砍 `manufacturer`/`atcCode` | 2,241,040 | 31.8% | 砍 2 欄 |
| （參考下限）只留 code ＋ 搜尋字串 | 1,386,240 | 57.8% | 砍 10 欄 |

raw 大小：30,256,857 → **14,387,179 B（-52.4%）**。raw 減半對 `JSON.parse` 的影響
由 §6 原型實測，不在此推估。

**本案採用「不裁任何欄位」的欄位陣列化（22.3%）**，理由是它在不動任何欄位語意的前提下
效果最大（22.3% vs 12.5%／16.2%），判定邏輯一行不改，可用逐筆等價驗證證明無損。

> v0.1–v0.2 曾寫「砍功能反而比不砍差」——**那個論據來自上述壞掉的量測，是假的**。
> 實際上砍掉 `manufacturer`／`atcCode` 會再多省 9.5 個百分點（31.8% vs 22.3%）。
> 「不裁欄位」的決策仍然成立，但理由只剩風險最低，不包含「更省」。

---

## 2. 目標與非目標

**目標**：降低 `drug_index.json` 的傳輸與解析成本，縮短「開站到可搜尋」。

**非目標**（本案一律不碰）：
- shard 的格式、分片規則、`meta.json`、`status.json`、`upcoming.json`
- 任何臨床判定邏輯（`searchCard`、`terminatedMask`、標籤決策表）
- UI、版面、預告中心與比較頁的效能門檻
- 欄位的新增或移除（**表示法改變，語意一位元不變**）

---

## 3. `columnar/1` 格式契約（**原型開始前必須全部凍結**）

> 覆審 2.4：真正不可逆的是本節。`fields` 順序、null 規則、巢狀結構與型別一旦發布，
> 任何釐清都構成語意變更並迫使升 `columnar/2`。§4.2 的 (a)/(b) 是可替換的實作策略，不在此列。

### 3.1 檔案結構

```jsonc
{
  "dataVersion": "sha256:…",      // 語意同 spec.md §7，不變
  "indexFormat": "columnar/1",
  "fields": [ …14 個字串… ],       // 藥品層欄位名，順序即位置
  "windowFields": [ …13 個字串… ], // window 列的欄位名，順序即位置
  "rows": [ …每筆一個陣列… ]
}
```

### 3.2 索引公式（精確定義）

令 `N = fields.length`、`M = windowFields.length`。

- `rows[i]` 是第 `i` 筆藥品，長度**恆為 `N + 1`**
- 對 `0 ≤ j < N`：`rows[i][j]` 的值屬於欄位 `fields[j]`
- `rows[i][N]` 是**該藥品的 window 列陣列**，記為 `W`，可為 `[]`
- 對 `0 ≤ r < W.length`：`W[r]` 是第 `r` 個 window 列，長度**恆為 `M`**
- 對 `0 ≤ k < M`：`W[r][k]` 的值屬於欄位 `windowFields[k]`

> v0.1 誤寫為「`rows[i][N][k]` 對應 `windowFields[k]`」——那取到的是第 `k` 個 window
> **列**而非第 `k` 個**欄**。（覆審 1.3）

### 3.3 欄位清單與型別（mandatory set）

> 型別與 nullability 由現行資料核對；**值域依資料模型的完整集合**，
> 不以 profiling 結果為準（見 §3.3.1）。

`fields` 的**前 14 個位置**必須是下列欄位，**順序即本表順序**（其後可有附加欄位，見 §3.7）：

| # | 欄位 | 型別 | null | 備註 |
|---|---|---|---|---|
| 0 | `code` | string | ✗ | 非空、全檔唯一 |
| 1 | `chName` | string | ✗ | 可為空字串 |
| 2 | `enName` | string | ✗ | 可為空字串 |
| 3 | `ingredient` | string | ✗ | 可為空字串 |
| 4 | `dosageForm` | string | ✗ | 可為空字串 |
| 5 | `strength` | string | ✗ | 可為空字串（實測 53.7% 為空） |
| 6 | `strengthUnit` | string | ✗ | 可為空字串 |
| 7 | `atcCode` | string | ✗ | 可為空字串 |
| 8 | `manufacturer` | string | ✗ | 可為空字串 |
| 9 | `firstEffectiveDate` | string | ✗ | 真實日曆日 `YYYY-MM-DD` |
| 10 | `lastPriceChangeDate` | string \| null | ✓ | 真實日曆日；實測 4,749 筆為 null |
| 11 | `historyCount` | number（整數） | ✗ | ≥ 0 |
| 12 | `priceChangeCount` | number（整數） | ✗ | ≥ 0 |
| 13 | `flags` | array of string | ✗ | 可為 `[]`（實測 99.1%） |

`windowFields` 的**前 13 個位置**必須是下列欄位，順序即本表順序（其後可有附加欄位，見 §3.7）：

| # | 欄位 | 型別 | null | 備註 |
|---|---|---|---|---|
| 0 | `from` | string | ✗ | 真實日曆日 |
| 1 | `to` | string \| null | ✓ | 真實日曆日；null＝開放結尾（實測 99.8%） |
| 2 | `price` | number \| null | ✓ | |
| 3 | `rawPrice` | string | ✗ | 來源原字串，不得轉數字 |
| 4 | `previousPrice` | number \| null | ✓ | |
| 5 | `pricedBefore` | number \| null | ✓ | |
| 6 | `priceState` | string | ✗ | 值域見下 |
| 7 | `eventType` | string | ✗ | 值域見下 |
| 8 | `crossesStop` | boolean | ✗ | |
| 9 | `changeFlag` | string | ✗ | 可為空字串（實測 99.5%） |
| 10 | `absoluteChange` | number \| null | ✓ | |
| 11 | `percentChange` | number \| null | ✓ | |
| 12 | `flags` | array of string | ✗ | 可為 `[]`（實測 100%） |

#### 3.3.1 值域（**由本規格列舉，不以任何實作檔為權威**）

- `priceState` 恰為下列 5 個字串之一：
  `priced`、`terminated`、`suspended`、`missing`、`malformed`
- `eventType` 恰為下列 9 個字串之一：
  `initial`、`unknown`、`unchanged`、`terminated`、`suspended`、`increase`、`decrease`、`relisted`、`first_priced`

`engine.js` 的 `PRICE_STATES`／`EVENT_TYPES` 與 Python 端都**必須符合本表**。
目前兩端宣告與本表一致，但**本表才是權威來源**——
若讓實作檔定義規格，任一端增刪 enum 就會隱性改變合法值域，破壞跨語言等價與格式凍結。

> 現行資料只用到 `priceState` 的 3 個、`eventType` 的 8 個。**值域寫成當前資料的子集，
> 會讓未來出現 `missing`／`malformed` 時被自己的 validator 拒絕**——與「凍結 fixture 時
> 母體不可縮成剛好等於子集」同形（memory `fixture_frozen_vs_live_data`）。

#### 3.3.2 跨語言必須一致的型別邊界

下列是 JS 與 Python 最容易各自「合理實作」卻不等價的地方，一律明訂：

- **所有日期字串**（`firstEffectiveDate`、`lastPriceChangeDate`、`from`、`to`）必須是
  精確 `YYYY-MM-DD` 格式**且為真實日曆日**。`2027-02-30` 與 `20260911` 都必須拒絕
  （沿用既有雙 validator 的教訓）
- **所有 number 必須是有限值**：`NaN`、`Infinity`、`-Infinity` 一律拒絕
- **boolean 不得被當成 number**：Python 的 `bool` 是 `int` 子型別，
  驗 `historyCount` 之類的整數欄位時必須先排除 `bool`，否則 `True` 會通過整數檢查
- `rawPrice` 是來源原字串，**不得轉成數字**再驗
- 價格與狀態的一致性（例如 `priced` 是否必須對應正數）**仍由 `spec.md` 既有規則負責**，
  本 validator 只驗表示法層的型別與 shape，不重複定義臨床規則

### 3.4 key 完整性：不得有缺漏

**所有 14＋13 個欄位在每一筆都必須有值（可為 `null`，但位置不得缺）。**

v0.1 曾規定「舊格式缺 key 時寫 `null`」——那是**有損轉換**，反轉後無法區分「原本缺 key」
與「原本是 null」，與 F4 的逐欄相等互相矛盾（覆審 1.2）。

實測證實不需要那條規則：45,179 筆 × 14 欄、45,258 列 × 13 欄**全部存在**，
無缺 key、無額外欄位。故：

- **轉換時遇到缺 key ＝ 轉換失敗，不得產出可發布結果**
- **builder 產出時遇到缺 key ＝ build fail**

### 3.5 排序與唯一性契約（自查 S1／S3；覆審 1.6）

- `rows` **必須依 `code` 嚴格遞增排序**
- `code` 全檔唯一、非空
- `rows.length` 必須 > 0，且等於 `meta.uniqueDrugCodeCount`
- **`meta.uniqueDrugCodeCount` 須納入 meta 的共通 schema**：必須存在、為正整數（且非 boolean）。
  現行 `validateMeta` 只驗 `dataVersion`／`shards.files`／`shards.versions`，**不驗此欄**——
  不補進去，本條就是引用一個 validator 不保證存在的欄位。
  缺漏或型別錯 → meta 判 `invalid`；存在但與 `rows.length` 不符 → index 判 `invalid`

> 為什麼排序要入契約：`engine.js` 的 `prepareIndex` 內含排序分支——若傳入的 drugs
> 未依 code 遞增就 `slice().sort()` 整份 45,179 筆，而 `search()` 依賴
> `codes`／`hays`／`drugs` 三者同序。現行資料**剛好**已排序，不寫進契約等於把一次
> 全量 sort 留在首屏路徑上靠運氣不觸發。
>
> 為什麼 `rows.length > 0` 要擋：空 index 是合法 JSON，會讓站台進 `ready` 並顯示
> 「查無結果」——把資料失敗偽裝成查詢結果，正是本專案威脅模型最怕的靜默錯誤。

### 3.6 `indexFormat` 與版本不符的行為

- 本版值固定為字串 `"columnar/1"`
- 前端內建期望值常數（比照既有 `UPCOMING_GENERATOR_VERSION`）
- **`indexFormat` 缺漏或不等於期望值 → `validateIndex` 回 `{ ok: false, reason: 'version_mismatch' }`**，
  走現有的「資料已更新，請重新整理頁面」路徑
- **不得回 `'invalid'`**：`invalid` 的文案是「內容不合法，目前無法查詢」，
  對「前端比資料新／舊」這個可自癒的情況是誤導

> 為什麼需要這個欄位：`dataVersion` 是**來源內容**的 sha256，表示法改變不會讓它變動，
> 少了 `indexFormat` 就分不出新舊表示法的產物。此理由與 `spec.md` §3.3.2 對
> `UPCOMING_GENERATOR_VERSION` 的論證同構。

### 3.7 演進規則

- **前綴相符規則**：`fields` 的**前 14 個位置**必須與 §3.3 的表完全相符（名稱與順序），
  `windowFields` 的**前 13 個位置**同理。其後**允許**附加欄位，但必須是非空、不重複的字串
- 新增欄位一律 **append 到尾端**，且**不升** `indexFormat`
- 對應地，`rows[i]` 長度為 `fields.length + 1`、window 列長度為 `windowFields.length`——
  §3.2 的公式以實際長度為準，不寫死 14／13
- 前端**不得寫死欄位順序**，必須讀 `fields` 建 name→position 映射後取值
- 移除欄位、改變既有欄位語意、改變 `rows` 巢狀結構、**改變前 14／13 個位置的任一欄**
  → **必須升** `indexFormat`

> v0.2 同時寫了「未知附加欄位允許存在」與「`fields` 恰為 14 欄」，兩者無法同時成立：
> 任何合法的附加欄位都會被 validator 判 `invalid`，向前相容承諾不可執行。
> 改用前綴相符後兩者相容。（第二輪 2.1）

---

## 4. 前端

### 4.1 驗證（`engine.js` `validateIndex`）

| 檢查 | 不符時的 reason |
|---|---|
| `indexFormat` 存在且 === 期望常數 | `version_mismatch` |
| `index.dataVersion !== meta.dataVersion` | `version_mismatch`（既有） |
| `fields` 前 14 個位置與 §3.3 相符；全體元素為非空字串且不重複 | `invalid` |
| `windowFields` 前 13 個位置與 §3.3 相符；全體元素為非空字串且不重複 | `invalid` |
| `rows` 為陣列且 `rows.length > 0` | `invalid` |
| **每一筆** drug row 長度 === `N + 1` | `invalid` |
| **每一個** window 列長度 === `M` | `invalid` |
| `code` 非空、唯一、嚴格遞增 | `invalid` |
| **每一筆的每一個已知欄位**符合 §3.3 的型別、nullability 與值域 | `invalid` |
| 附加欄位（前綴之後）的值不做型別檢查 | — |

**判定順序**（須有測試釘住，JS 與 Python 必須一致）：

1. **最小結構前提**：`index` 必須是 object（非 `null`、非陣列）、
   `index.dataVersion` 必須是字串、`index.indexFormat` 必須是字串。
   任一不成立 → **`invalid`**（不可越過此步逕判 mismatch，否則 `null` 會被誤歸版本問題）
2. `indexFormat` 不等於期望值 → **`version_mismatch`**
3. `index.dataVersion !== meta.dataVersion` → **`version_mismatch`**
4. 其餘 schema、shape、排序、唯一性檢查 → **`invalid`**

> v0.2 只寫「mismatch 排在所有 invalid 之前」，對 `null`、array、缺 `dataVersion`、
> `dataVersion` 非字串等情況不夠明確，兩端容易採不同短路順序。（第二輪 2.5）

#### 4.1.1 全量驗證，不抽驗（覆審 2.2／3.1）

v0.1 允許「抽驗前 50 列」以節省首屏成本。**這條刪除。**

位置式格式的核心風險正是**單列錯位後仍是合法 JSON** → 靜默顯示另一欄的價格或狀態，
且不觸發 `dataVersion`、不 crash。抽驗等於明確放行其餘 45,129 筆。

**抽驗沒有效能上的理由。** 實測（45,179 筆、9 次取 median）：

| | median |
|---|---|
| 純 prepare（不驗證） | 31.2 ms |
| prepare ＋合併全量驗證 | 32.2 ms |
| prepare 後另掃一次 | 32.0 ms |

全量驗證的總成本約 **1 ms**，相對 4,815 ms 的首屏可忽略；
而「合併」與「另掃一次」只差 **0.2 ms**，在噪音內（單次跨度 10+ ms）。

因此**驗證放在哪個 traversal 是實作自由**，規格只要求：
驗證必須**合併於 decode／projection／prepare 中任一個本來就必經的全量 traversal**，
不得為 validator 另外新增一趟純掃描；其成本必須計入 §6 的方案量測。

> v0.2 寫「必須與 `prepareIndex` 的 traversal 合併，才不需第二次掃描」——
> **那個理由經實測證明不成立**（差 0.2 ms），且對方案 (a)（先還原物件再交給既有
> `prepareIndex`）也不適用，因為 row shape 必須在還原**前或當下**就驗。
> 結論不變、理由更換：理由錯的規格會在下次重構時無聲失效。（自查 S5、第二輪 2.8）

### 4.2 消費

本案要求**行為等價**，不強制實作方式。兩條路擇一，原型期並存、v0.2 之後只留一條：

- **(a) 還原成物件陣列**：改動最小，但會建 45,179 個物件
- **(b) 直接吃 rows**：`codes`／`hays` 直接由 rows 建，`byCode` 存 `Map<code, rowIndex>`，
  另提供取出 logical drug 視圖的 accessor

§6 的原型必須把 (a) 與 (b) **都量過**，用數字選。

> **2026-09-23 已選定 (b)**，依據見 §9。(a) 不實作。

#### 4.2.1 架構 invariant（覆審 2.5）

**columnar 僅是輸入表示法。** row index 與欄位 position **不得**外洩成其他模組的公開契約：
`searchCard`、`terminatedMask`、render、詳細頁、比較頁看到的必須仍是舊的 logical drug 物件。
違反此條會讓欄位位置變成非正式 API，日後升版要撞上大量 consumer。

### 4.3 判定邏輯不得修改

`searchCard`、`terminatedMask` 及其呼叫的一切**不得修改**。

實查其讀取的欄位（供 F1 等價比對明列，非白名單——§3.4 要求全欄存在）：

- drug 層：`code`、`chName`、`enName`、`ingredient`（haystack）、`window`
- window 層：`from`、`to`、`priceState`、`pricedBefore`、`rawPrice`、`flags`、`eventType`、`percentChange`
- UI 另讀：`strength`、`strengthUnit`、`dosageForm`、`manufacturer`、`atcCode`、
  `lastPriceChangeDate`、`historyCount`、`priceChangeCount`、drug 層 `flags`

### 4.4 載入失敗的分類不得重新歸類（覆審 1.9）

只有**成功解析後**的 `indexFormat`／`dataVersion` 不符才是 `version_mismatch`。
HTTP 非 200、網路錯誤、timeout、非 JSON 一律仍走既有的 error 路徑（可重試），
既有的序號式重入規則（`seq !== state.coreSeq` 丟棄舊結果）不變。

---

## 5. 建置端

### 5.1 產出

`build_price_history.py` 直接產出新表示法，**不保留舊格式的產出路徑**。

### 5.2 一次性轉換

本案的 `data/drug_index.json` 由**既有檔純轉換**產生，不重抓 NHI 來源：

- `dataVersion` 原樣保留（來源內容未變）
- 轉換須 deterministic：同一輸入轉兩次，輸出 bytes 與 SHA-256 相同

> 不重抓的理由：來源端 `info.nhi.gov.tw` 間歇性 `RemoteDisconnected`，
> 且混入資料更新會讓「表示法改變」與「內容改變」無法歸因。

### 5.3 轉換的失敗路徑：fail-closed（覆審 1.7）

沿用既有 builder 的全有全無契約。下列任一情況**不得產生可發布結果、不得留下半成品**：

- 輸入已經是 `columnar/1`（重複轉換）
- 輸入不是合法 JSON／缺 `drugs`／`drugs` 非陣列
- 任一筆缺 §3.3 的任一 key（§3.4）
- 任一欄型別不符 §3.3
- `code` 重複、為空、或未嚴格遞增
- round-trip 自檢失敗
- 兩次轉換 bytes 不同

### 5.4 index size guard（`spec.md` §7 既有缺口）

`spec.md` §7 對 shard 有 size guard，**對 index 沒有**——3.28 MB 因此一路長上來沒被擋。補上：

- index gzip（**level 6**，與 §1 量測條件一致）> **2.5 MB** → build warning
- > **3.5 MB** → build fail，且 `data/` 與 `status.json` 均不得寫入

guard 必須接在**實際發布路徑**上（對 builder 真正要寫出的 bytes 計算），不是獨立 helper。

### 5.5 前次 index 的消費者必須一起遷移（**Blocker**，覆審 1.8 升級）

`build_price_history.py:327-328` 讀前次 index 做**消失代號 guard**：

```python
prev_index = read_json(Path(data_dir) / "drug_index.json")
prev_codes = {d["code"] for d in prev_index["drugs"]} if prev_index else set()
```

改 columnar 後 `prev_index["drugs"]` 不存在。**實測行為**：columnar dict 是 truthy，
因此會走 `prev_index["drugs"]` 而拋 **`KeyError: 'drugs'`**——是 **fail loud**，
第二次 build 直接中止，不是靜默失效。

> v0.2 曾寫成「`prev_codes` 成空集合、guard 靜默失效」，**那個歸因是錯的**，
> 由第二輪覆審指出並經實測確認。（第二輪 偏離 1）

**但有一個真正會靜默失效的修法必須禁止**：若為了消除上述 `KeyError` 而改寫成
`prev_index.get("drugs", [])`，`prev_codes` 就會變成空集合，
**guard 永遠算不出任何代號消失，且 build 照常成功**——`max_disappeared_pct=1` 形同不存在。
這是「修一個 bug 時製造新洞」的形態，實測已確認。

**禁止**以任何「缺鍵時回預設空值」的方式處理前次 index 的格式差異：
分辨不出格式時必須明確失敗，不得退回預設分類。

因此：

- 所有讀前次 index 的 guard 與 diff 判定（消失代號 guard、`min_row_pct_of_previous`、
  publish 的差異判定）**必須支援 `columnar/1`**
- 遷移期還要能讀舊格式前次檔（首次 build 時 `data/` 裡是舊格式）
- 驗收 **F11** 專門擋這條

### 5.6 Python 端 validator（覆審 2.3）

分兩層契約，避免 v0.1 §4.1 與 §5.4 的自相矛盾：

- **共通 schema／reason 規則**：JS 與 Python **必須等價**，同一 fixture 得到同樣的
  `{ok, reason}`。F7 只比較這一層。
- **驗證覆蓋範圍**：建置端全量；runtime 在 `prepareIndex` 必經 traversal 中全量驗 shape。
  兩者都是全量，不存在「一邊抽驗一邊全量」的不一致。

---

## 6. 原型、量測方法與中止條件

**動工順序**：§3 的格式契約先凍結 → 做最小原型量真實數字 → 把效能門檻寫進 §7 F10。

### 6.1 量測方法（**實作前凍結**，覆審 F10）

| 項目 | 規定 |
|---|---|
| 工具 | `scripts/measure_e7.mjs` |
| 條件 | CPU 4x throttle、9 Mbps／60 ms latency、gzip level 6、**冷 cache** |
| 瀏覽器 | 同一 Chromium 版本（記錄版本字串） |
| 資料 | 同一份來源（legacy 與 columnar 的 `dataVersion` 必須相同） |
| 對象 | legacy baseline、方案 (a)、方案 (b) **三者交錯量測**，不可分批 |
| 重複 | 每個對象 **≥ 7 次**，取 **median** |
| median 的計算對象 | **每次 run 先算該次的合計**（`indexFetchToParsedMs + parsedToSearchableMs`），
最後對各次**合計**取 median。**不得**分別取兩段 median 再相加——兩者結果不必相同 |
| 改善值 | legacy 的合計 median **減** 候選的合計 median |
| 離群 | 記錄全部原始值；不得事後剔除，median 本身即抗離群 |
| 指標 | `indexFetchToParsedMs`、`parsedToSearchableMs`、合計到可搜尋 |

**baseline 必須在同一輪重量一次**，不得沿用本文件 §1 的 4,815 ms（不同時間、不同機器狀態）。

### 6.2 中止條件

取 (a)、(b) 中較佳者，其「合計到可搜尋」的 median 相對**同輪 baseline** 的 median，
改善 **< 500 ms** → **停工並回報**。不調門檻、不硬推、不換更寬鬆的量測條件。

> 未驗證的假設：columnar 的前端還原成本不會吃掉下載省下的約 1.0 秒。
> 這是本案最大的風險，原型的第一個任務就是證偽它。

---

## 7. 驗收條件

### 7.0 Legacy oracle（**Blocker**，覆審 1.1／F4）

F1／F2／F4 需要「舊格式」作為比對基準。**禁止由待測轉換器反解產生**——
那是「斷言的期望值由受測程式產生」，會讓等價驗證變成自我證明。

規定：

- oracle ＝ **下列指定 commit 的 `data/drug_index.json`**（2026-09-23 鎖定）：

| 項目 | 值 |
|---|---|
| 來源 commit | `cee5dba5f7e3e0e6d29dd698b0720fd548d9fa7d` |
| blob 路徑 | `data/drug_index.json` |
| 落點 | `tests/fixtures/legacy_drug_index.json` |
| **SHA-256**（原始 bytes） | `92c388e9a7005227a22a54aed71451ec1d7ae8f68e7e1909e593de168ca1b9d2` |
| 檔案大小 | 30,256,858 bytes |
| 筆數 | 45,179 |
| `dataVersion` | `sha256:6a6f5791f95796065a7dc24a446b30b4d7a9af2aa4000f659a60579df9b69b1a` |
- **SHA-256 的計算對象是檔案原始 bytes**（不是 canonicalized JSON，也不做換行正規化）
- 以三者鎖定：**SHA-256**（主）、**筆數 45,179**、**`dataVersion`**（第二、三重確認）

> 「本次改版前 commit」是相對描述，會隨時間漂移；必須寫成不會變的絕對值。（第二輪 3.4）
- F1／F2／F4 一律**直接讀 oracle**，不經任何新格式的 decoder
- 測試啟動時先驗 oracle 的 SHA-256，不符即 fail

### 7.1 驗收表

| 編號 | 條件 | 堵死的弱化實作 |
|---|---|---|
| **F1** | 對 §7.0 oracle 的 45,179 筆**逐筆**、逐 §7.3 的每個 T，比較 `searchCard` 回傳值（深度相等）與是否拋例外。舊側直接用 oracle 物件，新側走 columnar consumer | 兩側都經同一個錯誤 decoder；兩側其實都讀新檔 |
| **F1-S** | **反向哨兵**：指定 code、指定欄位、指定 T 注入破壞，斷言 F1 **確實因該 code／該 T** 出現差異（不是「有差異就好」） | F1 恆真 |
| **F2** | `terminatedMask` 逐項布林相等；斷言陣列長度、每個 index 對應的 code、且 fixture **同時含 true 與 false**，並涵蓋 terminated／priced／suspended／conflict／overlap／exhausted | 測資剛好全 false 也「相等」 |
| **F3** | T 的產生規則**明寫**：每個 window 列的 `from-1`、`from`、`to`、`to+1`（`to` 非 null 時）＋固定今天＋空 window 案例。報告須輸出**實際唯一 T 數**與各反例類別命中數 | 「多個 T」實作成重複日期；只跑今天 |
| **F4** | 新格式反轉回舊格式後，以 canonical serializer 產出的 **bytes 與 oracle canonical bytes 完全相同**；另逐筆檢查 key set、陣列長度、型別、值。並驗同一輸入轉兩次 SHA-256 相同 | 由新格式反解再與自己比；只比 parse 後的值不比 key presence |
| **F5** | `indexFormat` 缺漏／錯值／非字串三案，各斷言：validator reason、core 狀態、**搜尋不可用**、無結果卡、無舊 `byCode`／`prepared` 資料可見、提供 reload 而非 retry。另含「舊前端＋新 index」混批案例 | 只驗文案，實際仍可搜尋到舊資料 |
| **F6** | 對 14 個 drug fields 與 13 個 window fields **逐一**刪除／重複／空字串／非字串，每一項都必須回 `invalid`；另正向斷言「未知附加欄位允許存在」 | 只刪一個 haystack 欄位；必要欄位清單自身有漏 |
| **F7** | 共用 fixture，**每案帶獨立 expected `{ok, reason}`**；JS 與 Python **各自對 expected 驗證**，不得互比、不得一端委派另一端。反例須含：無效日曆日、重複 fields、短／長 drug row、短／長 window row、錯型別、重複 code、未排序、空 rows、format mismatch 與 dataVersion mismatch 的優先序 | 兩端互比，兩端都錯仍全綠（＝既有日期 validator 教訓重演） |
| **F8** | 列出**必跑 suite 與本案新增的 mandatory test ID**；零 failure、零 unexpected skip/todo。測試總數只作資訊，不作主要斷言 | 刪掉重要測試補等量空測試；大量 skip 仍回綠 |
| **F9** | 經**完整 build/publish 路徑**測 size guard：對實際要寫出的 bytes、gzip level 6 計算；等於門檻通過、超 1 byte 分別 warning／fail；fail 時 `data/` 與 `status.json` 均未變動；warning 須出現在 build 輸出 | guard 只在孤立 helper 被測，從未接入發布路徑 |
| **F10** | 依 §6.1 量測，方案 (b) 的合計 median **≤ 3,800 ms**，且相對**同輪** legacy baseline 改善 **≥ 500 ms**。綠燈＝與 2026-09-23 原型實測相當（3,464 ms），**不是**達成某個絕對設計目標 | 事後填寬鬆門檻；取單次最佳值；warm cache；拿不同輪次的 baseline 與候選互比 |
| **F11a** | **legacy prior → columnar build**（首次遷移）：前次 index 是舊格式，本次產出 columnar。以實際缺少代號的資料斷言消失代號 guard **真的擋下來** | 只支援 columnar prior，首次遷移直接失敗 |
| **F11b** | **columnar prior → columnar build**（穩定態）：第二次讀第一次產出的 `columnar/1`，同樣以缺代號資料斷言 guard 擋下；並驗 `min_row_pct_of_previous` 與 publish 差異判定仍運作 | 只驗「沒有拋例外」而不驗 guard 真的生效；或用 `.get()` 讓 `prev_codes` 成空集合後 build 照樣成功 |
| **F12** | builder 全量驗證：**validated drug count === 實際 `rows.length`**、**validated window count === 所有 `W.length` 的總和**（不是寫死的數字）。報告須輸出實際驗證筆數；45,179／45,258 僅作本次 oracle fixture 的預期值。另在**最後一個 drug row** 與**最後一個 window 列**各注入一次錯誤，兩者都必須被拒絕 | 寫死筆數 ⇒ 資料成長後尾端完全不驗；或只輸出數字而未真的走到最後一列 |

---

## 8. 部署：混批矩陣（覆審 2.1）

v0.1 寫「同一 commit 切換，順序風險不適用」——**這個結論錯誤**。
`spec.md` §7 自己就載明：GitHub Pages CDN 快取約 10 分鐘，已開啟的頁面或全新載入
**都可能取得不同批次的檔案**。同一 commit 不代表 `app.js`／`engine.js`／`meta.json`／
`drug_index.json` 同時生效。

四種組合都必須 fail-closed，且文案不得誤導：

| 前端 | index | 行為 |
|---|---|---|
| 新 | 新 | 正常 |
| 新 | 舊（legacy，無 `indexFormat`） | `version_mismatch` →「資料已更新，請重新整理頁面」 |
| 舊 | 新（columnar） | 舊 `validateIndex` 因 `!Array.isArray(index.drugs)` 回 **`invalid`** →「內容不合法，目前無法查詢」。**fail closed，不會顯示錯價**，但文案誤導且舊前端無法改 |

**舊 client 的降級期間不設上限**：

- 新載入的頁面受 CDN 混批影響，通常約 10 分鐘
- **已開啟的舊頁面存活期沒有上限**——可能數小時至數天，期間按「重試」重新取核心資料時
  仍可能拿到新 index 而進入此降級

> v0.2 寫「須確認 CDN 約 10 分鐘窗口可接受」低估了範圍：若 PR 宣稱降級只有 10 分鐘，
> 超過該時間的回報會被誤判成其他故障。（第二輪 4.1）
| 舊 | 舊 | 正常 |

**不得**用「SW 快取 data」或「伺服器端協調」解決——兩者都違反既有架構限制。

PR 必須同時包含：轉換後的 `data/drug_index.json`、新 builder、新前端、新測試、
更新後的 `.ai-review/` 驗收紀錄。缺一不可合併。

---

## 9. 原型結果與方案選定（2026-09-23 實測）

依 §6.1 的凍結方法量測（7 輪交錯、每次冷 cache、CPU 4x、9 Mbps／60 ms、gzip 6、
每次先算合計再取 median）：

| 對象 | fetchParse | prepare | **合計 median** |
|---|---|---|---|
| legacy baseline | 3,921 | 271 | **4,192 ms** |
| (a) 還原成物件陣列 | 3,153 | 528 | 3,645 ms |
| **(b) 直接吃 rows（採用）** | 3,168 | 298 | **3,464 ms** |

原始合計值（不剔除離群）：

- legacy：4876, 4496, 4192, 4119, 4466, 4007, 3994
- (a)：4322, 3703, 3574, 3645, 3560, 3447, 4052
- (b)：3631, 3608, 3372, 3464, 3222, 3415, 3648

**結論：採用方案 (b)，改善 728 ms（17.4%），通過 §6.2 的 500 ms 中止條件。**

- 決定性差異在 `prepare`：(a) 要建 45,179 個物件，付出 **+230 ms**，
  把下載省下的優勢吃掉大半。兩者 `fetchParse` 幾乎相同（3,153 vs 3,168），
  證明差異不在 parse 而在物件建構
- (b) 的 prepare 比 legacy 多 **27 ms**，那是全量 shape 驗證與從 rows 取值的成本，
  遠小於 fetchParse 省下的 753 ms

> §4.1.1 引用的「全量驗證約 1 ms」是**無 CPU 節流**下的量測；
> 節流條件下實測為 +27 ms。結論不變，但那個數字不代表真實條件。

**方案 (a) 不實作。** 原型程式碼保留在 `scripts/prototype_measure.mjs` 作為選型證據。

---

## 10. 後續版本（本次明確不做）

- **`indexArtifactHash`**（representation hash）：可在 runtime 偵測「合法 JSON、format 正確、
  dataVersion 正確，但某個位置的值被替換」。**本次拒絕**：需改 `meta.json` 或引入額外 manifest，
  與本案非目標直接衝突。（覆審 4.5，判定：範圍蔓延）

  **殘餘風險必須精確描述，不得宣稱已解決**：§5.3 全量 builder 驗證、§7.0 獨立 oracle、
  §4.1.1 runtime 全量驗證，覆蓋的是**轉換器／builder／decoder 的系統性錯誤**；
  **不覆蓋**發布後儲存層或 CDN 對合法值的竄改（shape 正確、型別正確、版本正確，但值被換掉）。
  本案接受此殘餘風險。（第二輪 偏離 4）
- 把 `manufacturer`／`atcCode` 移出 index 到 shard（實測另省 12.5%）

---

## 11. 修訂紀錄

**v0.2（2026-09-23）** — 依 `.ai-review/plan-verdict-index-format.md` 修訂。

| 改動 | 依據 |
|---|---|
| §3 整節重寫為「原型前必須凍結的格式契約」 | 2.4 |
| §3.2 索引公式改為三維精確定義（修正 v0.1 的錯誤公式） | 1.3 |
| §3.3 新增逐欄型別表；值域以 `engine.js` 宣告為準而非當前資料 | 1.5、自查 S4 |
| §3.4 刪除「缺 key 寫 null」，改為「缺 key ＝ 轉換失敗」 | 1.2 |
| §3.5 新增排序、唯一性、`rows.length > 0` 契約 | 自查 S1、1.6 |
| §3.7 明訂未知附加欄位允許存在 | 1.4 |
| §4.1 驗證表擴充；新增 reason 優先序 | 1.4、F7 |
| §4.1.1 **刪除抽驗，改全量**（與 prepare traversal 合併） | 2.2、3.1 |
| §4.2.1 新增架構 invariant：row 表示不得外洩 | 2.5 |
| §4.3 明列實查的欄位讀取清單（取代「所有被讀取的欄位」） | 1.4、自查 S2 |
| §4.4 新增載入失敗不得重新歸類 | 1.9 |
| §5.3 新增轉換的 fail-closed 失敗路徑 | 1.7 |
| §5.4 size guard 明訂須接在實際發布路徑 | F9 |
| §5.5 **新增 Blocker**：前次 index 消費者必須一起遷移 | 1.8（本方升級為 Blocker） |
| §5.6 validator 分兩層契約，解決 v0.1 自相矛盾 | 2.3 |
| §6.1 **新增量測方法論凍結**（交錯、≥7 次、median、冷 cache、baseline 重量） | F10 |
| §7.0 **新增 Blocker**：legacy oracle 定義與 hash 鎖定 | 1.1、F4 |
| §7.1 驗收表全部重寫，每條標明「堵死的弱化實作」；新增 F1-S、F11、F12 | F1–F10、3.1、1.8 |
| §8 **刪除「順序風險不適用」**，改為四種混批矩陣 | 2.1 |
| §10 新增「後續版本」，收納被判範圍蔓延的 representation hash | 4.5 |

**v0.3（2026-09-23）** — 依 `.ai-review/plan-verdict-index-format-r2.md`（第二輪，只審修訂本身）。

| 改動 | 依據 |
|---|---|
| §3.3 標題改為「型別由現況核對、值域依完整集合」 | R2 2.3 |
| §3.3.1 值域改由**本規格列舉** literal，不以 `engine.js` 為權威 | R2 2.2（S4 部分解決） |
| §3.3.2 新增跨語言型別邊界：真實日曆日、finite number、**Python bool 是 int 子型別**、rawPrice 不得轉數字 | R2 2.6 |
| §3.5 `meta.uniqueDrugCodeCount` 納入 meta 共通 schema（現行 `validateMeta` 不驗它） | R2 2.4 |
| §3.7 改為**前綴相符規則**，解決「附加欄位允許」vs「恰為 14／13 欄」的矛盾 | R2 2.1 |
| §3.3／§4.1 同步改為前綴相符（**修訂 §3.7 時漏改，自查補上**） | R2 2.1 |
| §4.1 驗證表新增逐欄 type／nullability／值域檢查（runtime 也全量） | R2 2.7 |
| §4.1 判定順序改為四步，先定最小結構前提再判 mismatch | R2 2.5 |
| §4.1.1 **理由改寫**：附實測數據，驗證位置改為實作自由 | 自查 S5、R2 2.8 |
| §5.5 **歸因更正**：是 `KeyError` fail loud，不是靜默失效；另新增 `.get()` 禁令 | R2 偏離 1 |
| §6.1 明訂 median 的計算對象（每次先算合計再取 median） | R2 偏離 2 |
| §7.0 oracle 改為絕對描述：commit SHA、blob 路徑、SHA-256 對原始 bytes | R2 3.4 |
| §7.1 F11 拆成 F11a（legacy prior）與 F11b（columnar prior） | R2 3.1 |
| §7.1 F12 改用動態實際筆數＋尾端注入證明 | R2 3.2 |
| §8 舊 client 降級期間不設上限 | R2 4.1 |
| §10 殘餘風險精確化：不覆蓋儲存層／CDN 的合法值竄改 | R2 偏離 4 |

**狀態**：第二輪 0 Blocker、5 High，全屬條文精確化而非架構變更，
**不觸發**再重審一輪的條件。v0.3 可進入 §6 原型階段。
