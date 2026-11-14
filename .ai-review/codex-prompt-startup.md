你是獨立覆審員。**唯讀模式：禁止寫入或修改任何檔案，只輸出報告文字。**

審查對象：一份**尚未實作**的規格 `spec-startup.md`（全文附於本 prompt 末尾）。
這是**規格層審查**：不審程式碼品質、**不要給程式碼實作建議**。你可以讀 repo 內既有檔案
（`app.js`、`engine.js`、`sw.js`、`spec.md`、`e2e/`、`scripts/measure_e7.mjs`、`build_price_history.py`）
來查證規格對現況的描述是否屬實——**規格中對現況的事實陳述若與程式碼不符，請明確指出**。

目的：在還沒寫任何 code 之前抓出方向性錯誤。

---

# 專案前提（必讀；違反這些前提的建議一律無效）

## (a) 架構限制與刻意取捨

1. **前端是零建置的靜態站**：`index.html` + `app.js` + `engine.js` + `styles.css`，原生 ES module，
   無 bundler、無 npm runtime 依賴、無框架。部署在 GitHub Pages 專案頁（子路徑）。
   無法自訂回應標頭；CDN `max-age=600`，同一次開站各檔案可能來自不同批次。
   「拆模組／加 TypeScript／導入框架／加 build step／改用有後端的主機」不是可接受的建議。
2. **`engine.js` 是純邏輯層（無 DOM、無 I/O）**，同時給瀏覽器與 `node --test` 用；`app.js` 負責 DOM 與資源載入。
3. **`data/` 完全不經 Service Worker**（`sw.js`：`if (url.pathname.includes('/data/')) return;`）。
   這是刻意的：藥價資料若來自 SW 快取會繞過 `dataVersion` 驗證與過期警示。
   建議用 SW／IndexedDB／localStorage 快取資料者視為與前提衝突（本案非目標 N3）。
4. **前端不得寫死分片前綴長度**（`spec.md` §7）：shard 檔名必須由 `meta.json` 的分片清單決定。
5. **全有全無的發布契約**：任一 guard 失敗 → `exit 1`，`data/` 一個位元組都不寫。不得引入部分發布。
6. **Python 端與 JS 端刻意各實作一次同一規則**，由 golden fixture 交叉比對，是跨語言縱深防禦，不是重複實作缺陷。
7. **高密度斷言與變異測試是本專案的既有紀律**。本專案的失效模式是**假綠燈**
   （斷言錨錯位置、驗收條件被實作者抄弱、效能終點停在 DOM 寫入而非可互動），不是測試過多。
   「測試可精簡」「合併案例」不是有效發現。
8. **CJK 顯示字串由規格逐字定義**。建議改寫文案者，除非能指出誤導使用者的具體風險，否則視為誤判。
9. **前案教訓（本案必須避開）**：`spec-index-format.md` 兩度因效能改善落在量測輪間變異之內而停工／終止
   （門檻 500 ms、輪間變異約 300 ms）；原型的驗證強度比正式實作弱，導致原型數字沒有兌現。
   index 表示法路線已終止，**不要建議重啟 columnar 或壓縮 index 表示法**。
10. 本規格的六項產品決策已由使用者（臨床藥師）確認：(1) 目標是首訪冷載入；(2) deep link 為主要驗收對象；
    (3) index 晚到失敗時詳情保留不撤下；(4) 詳情頁價格只認 shard 一個來源；(5) 查無從嚴；
    (6) deep link 入口等 shard 落定才開始抓 index。**你可以指出這些決策有未被察覺的後果，但不要單純因偏好不同而建議推翻。**

## (b) 威脅模型與風險權重

- **無認證、無 session、無 cookie、無使用者資料、無後端、無病患資料**。純靜態公開查詢站。
- **本站最怕的是「顯示錯誤的健保支付價」**：使用者是臨床藥師與醫療人員，金額、終止／暫停狀態、
  生效日若錯誤或誤導，會直接影響用藥與採購判斷。
- 風險排序（高 → 低）：
  1. **同一畫面混用兩批資料**，或把無法驗證版本的資料當正常資料顯示
  2. **把查得到的藥說成「查無」**（使用者會以為該品項未納入健保），或把載入中／錯誤顯示成查無
  3. **靜默失敗**：錯誤被吞掉而畫面看起來正常；資料缺陷被新的判定路徑遮蔽
  4. **假綠燈**：驗收條件通過但功能其實是壞的
  5. 可用性與效能
- 寧可多讓使用者等、或多顯示一次錯誤訊息，也不可顯示錯的價格或錯的「查無」。

若你的某項建議與上述任一前提衝突，**請明說衝突點並改提相容的替代作法**。

---

# 要求產出的四個區塊

每一項都要有：**嚴重度 / 問題 / 為什麼現在不修之後會更貴 / 建議修法（規格層，不是程式碼）**。
請為每一項編號（1.1、1.2、2.1 …）。

1. **需求與邊界缺漏** — 未定義的失敗路徑、邊界值、空資料、非 200、併發／重入／競態。
   請特別檢查：規格 §5.2 狀態矩陣與 §5.3 競態是否有未涵蓋的狀態組合或轉移
   （例如 `popstate` 在各資源各狀態下、重試期間的導覽、同一 shard 被詳情頁與比較頁同時請求、
   `meta` 重試後版本改變時已顯示的視圖、3,000 ms 提前啟動與落定同時發生）。
2. **架構風險** — 決策是否會撞到已聲明的平台限制；哪個決策最難回頭；
   D3「推翻 `spec.md` §7 的混批規則」的論證是否有漏洞；D4 把查無判定從 index 移到 shard 是否有未列出的後果。
3. **驗證策略缺口** — **針對 S1–S17 每一條回答：什麼樣的弱化實作能讓這條通過、但功能其實是壞的？**
   凡答得出來者即為缺口，請提出堵死該弱化版本的斷言寫法。特別找兩種：
   「涵蓋各種案例」但沒指名反例類別的；寫「驗證某物」而非「驗證某性質」的。
   另請審 §7 量測方法：終點定義、M0 變異量測、門檻與變異的關係，是否會重演前案「結果由當天機器狀態決定」。
4. **更簡單的替代方案** — 是否 over-engineering；能否用更少的元件達成同樣的目標與非目標邊界。

## 嚴重度定義（「發現得越晚越貴」軸）

- **Blocker** — 方向錯，寫完要整段重來
- **High** — 要改架構或資料模型
- **Medium** — 要多寫／改程式，但不動架構
- **Low** — 文件或命名層級

## 其他規定

- **不要新增「目標與非目標」以外的需求**。若真心認為某項缺漏是必要的，須標注 `[新增需求]`
  並說明不做的具體、可觀察的後果——由使用者決定，不預設納入。
- 最後請給一行總結：Blocker／High／Medium／Low 各幾項。
- 以繁體中文輸出。

---

# 規格全文（`spec-startup.md` v0.1）

# Spec — 首訪啟動策略（Startup Fast Path）

- 版本：v0.1（2026-11-14，待 `/codex-checkplan` 覆審）
- 基準 commit：`7ac1760`（main）
- 上位規格：`spec.md`（§7、§8.7、§16）。本文件與上位規格衝突時，以本文件明列的「推翻」為準，其餘一律沿用
- 前案：`spec-index-format.md`（分支 `feat/index-columnar-b`，**已終止、不得合併**）

---

## 1. 問題

`app.js` 的 `loadCore()` 對 `meta.json` 與 `drug_index.json` 做 `await Promise.all(...)`，
兩者都到齊才進 `state.core = 'ready'`；`showDetail()`、`showCompare()` 都以 `state.core !== 'ready'` 擋下。
因此帶代號的 deep link（`?code=<NHI_CODE>`，來源為 `TFDA-drug-info-search` 的「查看健保藥價歷史」）
必須先付完整份 index，才看得到一個藥的價格。

實測（`spec-index-format.md` §1，2026-09-23，CPU 4x、9 Mbps／60 ms、冷 cache）：
index fetch→parsed 4,433 ms、parsed→可搜尋 382 ms，合計 4,815 ms。index gzip 約 3.3 MB、raw 約 30 MB。

2026-11-14 對 `data/`（`dataVersion` 同 `7ac1760`）全量查核的事實：

| 事實 | 結果 |
|---|---|
| index 代號集合 vs 348 片 shard 代號集合 | 皆 45,224；雙向差集 0 |
| shard `meta` 的 8 個描述欄位（`atcCode` `chName` `enName` `dosageForm` `ingredient` `manufacturer` `strength` `strengthUnit`）vs index | 差異 0 筆 |
| `renderDetail()` 讀取的資料 | 只讀 `state.current.entry`（shard）、`state.today`、`stale()`（來自 `status.json`）；**不讀 index** |
| `showDetail()` 對 index 的依賴 | 僅兩處：`state.byCode.get(code)` 判定「查無此代號」、`drug.chName` 設 `document.title` |
| 比較頁對 index 的依賴 | `trayChipHTML()` 的品名、`renderCompare` 的品名 fallback（已是 `?.`，缺值時顯示空字串） |
| 預告中心對 index 的依賴 | 無（只需 `meta` 驗版本） |
| 最大 shard（`AC49`） | gzip ≈ 0.14 MB、raw ≈ 1.47 MB |
| GitHub Pages 對 `drug_index.json` | `ETag` ＋ `Cache-Control: max-age=600`；`If-None-Match` 回 304（curl 驗證，瀏覽器內未量） |

結論：詳情頁所需資料 = `meta.json`（31 KB raw）＋ 一片 shard。**阻塞在 index 上純粹是載入狀態機的設計，不是資料依賴。**

---

## 2. 目標與非目標

### 目標

- **G1**：deep link（`?code=`）進站時，詳情頁在 `meta.json` ＋ 對應 shard 到齊並驗證通過後即顯示，不等 index。
- **G2**：同一套狀態機套用到比較頁 deep link（`?codes=`）與預告中心（`?view=upcoming`）：只等它們實際需要的資源。
- **G3**：首頁（無參數）入口行為與耗時不變。
- **G4**：順帶量測回頭客（HTTP cache 暖）開站耗時，**只記錄、不設門檻、不做任何優化**。

### 非目標（本案一律不做）

- **N1**：不改任何資料檔的格式、欄位、分片規則（`drug_index.json`、shard、`meta.json`、`status.json`、`upcoming.json`）。`build_price_history.py` 與 `lib/` 不動（§5.6 的建置守門除外，見該節）。
- **N2**：不拆 index、不改 index 表示法、不合併 `feat/index-columnar-b`。拆 index 屬第二期（§10），另開規格。
- **N3**：不改 Service Worker「`data/` 完全不經 SW」的設計；不引入 IndexedDB／localStorage 資料快取。
- **N4**：不改任何判定邏輯（`summaryAt`、`selectMeta`、`searchCard`、`terminatedMask`、標籤決策表）與任何顯示文案，§5.5 明列的新增文案除外。
- **N5**：不改比較頁、預告中心既有的效能門檻（`spec-compare.md` §8.1、`spec-upcoming.md` §8.2）。
- **N6**：不加 `<link rel="preload">`、不做推測性 fetch（在 `meta` 未到前猜 shard 檔名）。`spec.md` §7 規定前端不得寫死分片前綴長度。
- **N7**：不處理 dependabot PR。

---

## 3. 平台限制

- GitHub Pages 專案頁：純靜態、無法自訂回應標頭、CDN `max-age=600`。同一次開站的各檔案可能來自不同批次（混批）。
- 前端零建置：原生 ES module、無 bundler、無 runtime 依賴。`engine.js` 為純邏輯層（無 DOM、無 I/O），`app.js` 負責 DOM 與載入。
- 所有資料請求皆 `fetch(url, { cache: 'no-cache' })`（條件式請求）。
- Service Worker 只快取外殼。本案會改 `app.js`（可能含 `engine.js`），**必須升 `sw.js` 的 `CACHE` 版本號**。

---

## 4. 架構決策

### D1　把單一 `state.core` 拆成兩個獨立資源狀態

| 資源 | 狀態 | 誰需要 |
|---|---|---|
| `meta` | `loading`／`ready`／`error` | 所有視圖 |
| `index` | `idle`（尚未開始）／`loading`／`ready`／`error`／`mismatch` | 只有搜尋頁，以及比較籃 chip 的品名 |

- 詳情頁、比較頁、預告中心的閘門改為 **`meta === 'ready'`**。
- 搜尋頁的閘門為 **`index === 'ready'`**。
- **為什麼不保留單一 `core` 加一個旁路旗標**：旁路會讓「index 失敗時詳情是否仍可用」散落在各個 `if`，
  本案的全部風險就在這些分支；兩個明確的狀態變數讓每個視圖的閘門只有一句判斷，且可被測試窮舉（§8 S5）。

### D2　index 的啟動時機

| 入口 | index 何時開始 fetch |
|---|---|
| 首頁（無參數） | 立即，與 `meta` 平行（**與現況相同**） |
| `?code=`、`?codes=`、`?view=upcoming` | 該視圖的**主要資源落定**後（成功或失敗皆算落定） |

「主要資源落定」定義：

- `?code=`：`meta` 失敗；或該代號的 shard 請求 resolve／reject；或判定為不需要 shard（§5.2 的查無）。
- `?codes=`：`meta` 失敗；或該次比較的所有 shard 請求皆已 settle。
- `?view=upcoming`：`meta` 失敗；或 `upcoming.json` 請求 settle。

**提前啟動條件**（任一成立即立刻開始，不等落定）：

1. 使用者切到搜尋頁（含 `popstate`、點「回搜尋頁」、對搜尋框 focus）。
2. 自導覽開始已過 **3,000 ms** 而主要資源仍未落定（防止 shard 卡住時搜尋永遠不啟動）。

index 在一次頁面生命週期內**只啟動一次**；「重試」另計（§5.4）。

- **為什麼不同時抓**：9 Mbps 下 3.3 MB 的 index 會與 shard 互搶頻寬，直接削弱 G1。（使用者決策，2026-11-14）
- **為什麼不延到使用者點搜尋才抓**：第一次搜尋要等完整冷載入；詳情頁閱讀期間的頻寬是閒置的。（使用者決策）

### D3　index 晚到後失敗或版本不符：已顯示的視圖保留

詳情頁的正確性依據是 **shard 對 `meta.shards.versions[prefix]` 的版本比對**，與 index 無關。
因此 index 進入 `error`／`mismatch` 時，已顯示的詳情（比較頁、預告中心亦同）**不撤下、不重畫**，
只在既有的橫幅區（`renderBanners()`）顯示 §5.5 的訊息。（使用者決策，2026-11-14）

- **推翻的上位規則**：`spec.md` §7「`index.dataVersion ≠ meta.dataVersion` → 不組合摘要與圖表」。
  在本案下，這條只適用於**需要 index 的視圖**（搜尋結果）。shard 與 `meta` 的版本比對規則一字不改。
- **為什麼可以推翻**：該規則防的是「同一畫面混用兩批資料」。詳情頁只用 `meta` ＋ shard，
  兩者之間的混批仍由 `validateShard` 的 `version_mismatch` 擋下；index 不參與詳情頁的任何數字（§1 事實表）。
- **殘餘情況（明列，接受）**：`meta` 為舊批、index 為新批時，使用者看到的是**自洽的舊批詳情**加上「資料已更新，請重新整理」橫幅。
  這與現況「整頁只剩一句請重新整理」相比，多顯示了一份較舊但內部一致的資料；橫幅必須在同一畫面可見（§8 S7）。

### D4　「查無此代號」改由 `meta` ＋ shard 判定，且從嚴

現況以 `state.byCode.get(code)`（index）判定。改為：

| 條件 | 顯示 |
|---|---|
| 代號為空字串，或含 `[A-Z0-9]` 以外字元（已先 `trim().toUpperCase()`） | **查無**；不發 shard 請求 |
| `meta` 已就緒，`shardPrefix(code, meta.shards)` 回 `null` | **查無**；不發 shard 請求 |
| shard 取得且 `shardVersion` 相符，`shard.drugs` **沒有該 key**（`Object.hasOwn` 為 false） | **查無** |
| shard 取得且版本相符，該 key 存在但結構不合法 | **錯誤**「分片內容不合法」＋重試（不是查無） |
| shard 版本不符 | 「資料已更新，請重新整理頁面」（現況） |
| shard 請求失敗（network／http／invalid JSON） | 錯誤＋重試（現況） |
| `meta` 未就緒或失敗 | 載入中／錯誤＋重試；**絕不顯示查無** |

- **不檢查代號長度**。現有代號全為 10 碼，但長度不是 `spec.md` 的契約；用長度短路會在來源改制時把查得到的藥說成查無。（對 2026-11-14 需求摘要「非 10 碼英數直接查無」的修正）
- 現行 `validateShard` 把「key 不存在」與「key 存在但結構壞」都回 `missing_code`。本案須把兩者分開（新增一個 reason 或等價作法），
  否則第 3、4 列無法區分。既有呼叫端（比較頁的 `missing`／`error` 分類）行為不得改變：比較頁對 `missing_code` 現況顯示「查無」類狀態，
  拆分後「key 不存在」維持原狀態，「結構壞」歸入 `error`「分片內容不合法」。**這是比較頁的一個可觀察行為變更，列入 §8 S9。**
- **查無的事後更正**：以前「index 有、shard 無」會顯示錯誤「分片中缺少此代號」，能暴露建置缺陷；改由 shard 判定後這類缺陷會被顯示成查無。
  補償措施二選一都做：(1) index 就緒後，若目前畫面是第 3 列的查無且 `byCode` 有該代號，改顯示錯誤「分片中缺少此代號」＋重試；(2) §5.6 的建置守門。

### D5　`document.title` 的品名來源改為與頁面 H2 相同

現況 `drug.chName`（index）；改為 `E.selectMeta(entry, T)?.chName`，為空時退回代號。
與 H2（`renderDetail` 的 `meta?.chName`）同源，避免標題與頁面兩個來源。

- 可觀察差異：`selectMeta` 回 `null`（尚無已生效紀錄）時，標題由「index 品名（代號）」變為「代號（代號）」樣式的退回值。
  具體退回字串於實作時沿用既有樣板 `${name || code}（${code}）— ${APP_TITLE}`，不新增文案。

### D6　`state.current` 不再持有 index 條目

`state.current = { code, entry }`。`state.current.drug` 目前無讀取端（2026-11-14 grep 確認）。

---

## 5. 行為規格

### 5.1 載入序列（`?code=`）

```
t0  導覽開始
    ├─ fetch status.json（輔助，不阻塞，現況）
    └─ fetch meta.json
t1  meta 到 → validateMeta → shardPrefix → fetch shard
t2  shard 到 → validateShard → renderDetail → 「詳情可互動」
    └─ 此刻才開始 fetch drug_index.json（D2）
t3  index 到 → validateIndex → prepareIndex → 搜尋可用；比較籃 chip 補上品名
```

`meta` 與 shard 是**串行**的兩次往返（N6）。

### 5.2 各視圖在各狀態下的顯示（狀態矩陣）

`—` 表示該視圖不看這個資源。

| 視圖 | `meta` | `index` | 顯示 |
|---|---|---|---|
| 搜尋 | loading | 任意 | 載入中；搜尋框停用；**不得出現「查無結果」類文案** |
| 搜尋 | ready | idle／loading | 同上 |
| 搜尋 | ready | ready | 正常 |
| 搜尋 | ready | error | 錯誤＋重試（現況文案） |
| 搜尋 | ready | mismatch | 「資料已更新，請重新整理頁面」（現況） |
| 搜尋 | error | 任意 | 錯誤＋重試（現況文案） |
| 詳情 | loading | — | 「資料載入中…」 |
| 詳情 | error | — | 錯誤＋重試 |
| 詳情 | ready | 任意 | 依 D4 表；成功時為完整詳情 |
| 比較／預告 | loading／error | — | 現況的載入中／錯誤 |
| 比較／預告 | ready | 任意 | 正常；比較籃 chip 品名在 `index` 非 ready 時為空，ready 後補上 |

### 5.3 競態

- 沿用現有序號機制（`coreSeq`、`detailSeq`、`compareSeq`、`upcomingSeq`）。`meta` 與 `index` 各自要能丟棄過期回應。
- index 回應晚於使用者的任何導覽時，**只更新搜尋相關狀態與橫幅**，不得呼叫會重畫目前詳情／比較／預告主體的路徑
  （現況 `loadCore()` 結尾無條件 `route()`，會重跑 `showDetail` 並重新 fetch／重畫；本案必須避免）。
- `meta` 就緒時才 `route()` 一次（讓等待 `meta` 的視圖開始載入）。
- `state.shardCache`：現況在 core ready 時 `clear()`。改為**只在 `meta` 被重新載入且 `dataVersion` 或該片 `shardVersion` 改變時**失效；
  index 就緒不得清 shard 快取（否則剛畫好的詳情其 shard 會被丟掉，切回時重抓）。

### 5.4 重試

| 按鈕 | 行為 |
|---|---|
| `retry-core`（`meta` 失敗時） | 重新載入 `meta`；成功後 `route()`；index 依 D2 規則重新判定啟動時機 |
| `retry-core`（只有 index 失敗時） | **只重抓 index**，並與**目前持有的 `meta`** 比對版本；不重抓 `meta`、不重畫目前視圖 |
| `retry-shard` | 現況 |
| `reload` | 現況（整頁重新整理） |

只有 index 失敗時不重抓 `meta` 的理由：重抓 `meta` 若拿到新批，已顯示的詳情就失去版本依據，
等於在使用者沒要求的情況下讓畫面與其版本基準脫鉤。要換批一律走 `reload`。

### 5.5 橫幅文案（唯一新增的文案）

目前視圖**不是**搜尋頁，且 index 為下列狀態時，在橫幅區顯示：

| index 狀態 | 文案 | 按鈕 |
|---|---|---|
| `error` | 搜尋功能暫時無法使用（`<原因>`）。目前頁面的資料不受影響。 | 重試（`retry-core`） |
| `mismatch` | 資料已更新，請重新整理頁面以使用搜尋。目前頁面顯示的是更新前的資料。 | 重新整理（`reload`） |

`idle`／`loading` 時非搜尋視圖**不顯示任何 index 相關訊息**。

### 5.6 建置守門（N1 的唯一例外）

查無判定由 index 移到 shard 後，「index 與 shard 代號集合相等」從隱含性質變成前端行為的前提。
現況只有 `tests/test_history.py` 在 fixture 上斷言 `source_codes == index_codes == set(shard_codes)`，**發布路徑沒有對實際產物檢查**。

本案在 `check_guards()` 加一條：實際產出的 index 代號集合與所有 shard 的代號聯集必須相等，否則 `exit 1`、不寫任何檔案（沿用全有全無契約）。
不改任何輸出內容。

### 5.7 效能標記

既有 `performance.mark`／`measure` 名稱（`index-fetch-start`、`index-parsed`、`search-ready`、`shard-fetch-parse`、`detail-render`、`compare-open-start`）
保留語意與名稱，供既有量測腳本使用。`index-fetch-start` 改在 index **實際開始 fetch** 時標記。

---

## 6. 資料流與失敗行為

| 來源 | 轉換 | 落點 | 失敗時 |
|---|---|---|---|
| `meta.json` | `validateMeta` | `state.meta` | 所有視圖顯示錯誤＋重試；不發 shard；**index 仍依 D2 啟動**（`meta` 失敗即落定） |
| shard | `validateShard`（對 `meta`） | `state.shardCache`、`state.current.entry` | D4 表 |
| `drug_index.json` | `validateIndex`（對 `meta`）→ `prepareIndex` | `state.prepared`、`state.byCode` | §5.5 橫幅；搜尋頁顯示錯誤；其他視圖不變 |
| `status.json` | 現況 | 現況 | 現況 |

`meta` 失敗而 index 成功時：`validateIndex` 沒有 `meta` 可比對版本 → index 視為**不可用**（搜尋維持錯誤狀態），不得在未驗版本下開放搜尋。

---

## 7. 量測方法（**實作前凍結**）

新腳本 `scripts/measure_startup.mjs`，沿用 `measure_e7.mjs` 的 gzip 伺服器與 CDP 節流。

| 項目 | 規定 |
|---|---|
| 條件 | CPU 4x throttle、9 Mbps／60 ms latency、gzip level 6、冷 cache（`Network.setCacheDisabled`）、SW 封鎖 |
| 對象 | **legacy**：基準 commit `7ac1760` 的前端檔，以 `git worktree` 取出、另一個 port 提供；**candidate**：本分支。兩者指向**同一份 `data/`**（同 `dataVersion`） |
| 交錯 | legacy、candidate 逐次交替，不可分批 |
| 重複 | 每個對象、每個代號 ≥ 7 次，取 median |
| 代號 | 3 個：最大片 `AC49` 內 1 個、中位大小片內 1 個、最小片內 1 個。動工前選定並寫入腳本常數，之後不得更換 |
| 驗收用的合計 | 三個代號各自的改善值都要過門檻（不是平均） |
| **終點定義** | 由**量測腳本注入的同一段觀察碼**判定，新舊共用，不依賴 app 內的 mark：`#detail` 內出現 `#sumTitle` 與圖表區後，讀一次 `offsetHeight` 強制 layout，再對「排序」按鈕派送 click 並確認 `aria-pressed` 翻轉，此刻才收秒表。未翻轉的該次數據不算並記錄原因 |
| 起點 | `navigationStart` |
| 離群 | 記錄全部原始值；不得事後剔除 |

### 7.1 M0：先量變異，再確認門檻（**寫任何實作程式碼之前**）

1. 用 legacy 對 legacy 跑兩輪（兩個 port、同一份檔案），每輪 ≥ 7 次。兩輪 median 之差的絕對值記為 **V**（三個代號取最大者）。
2. 門檻 **2,000 ms** 的成立條件：**V ≤ 400 ms**（門檻 ≥ 5V）。
3. V > 400 ms → **停下回報使用者重訂門檻**，不得自行調整門檻或量測條件。

量測腳本本身屬測試工具，可在 M0 階段先寫；`app.js`／`engine.js`／`sw.js` 在 M0 完成前不得修改。

### 7.2 中止條件

candidate 在任一代號的改善值 < 2,000 ms → 停工回報。不調門檻、不換條件、不剔除數據。

---

## 8. 驗收條件

每條附「會讓它假通過的弱化實作」及堵法。

| # | 條件（可證偽的斷言） | 弱化版本 → 堵法 |
|---|---|---|
| **S1** | §7 量測下，三個代號的「導覽開始 → 詳情可互動」median，candidate 各自比同輪 legacy 快 ≥ 2,000 ms；前提 M0 的 V ≤ 400 ms | 終點停在 DOM 寫入 → §7 終點含強制 layout 與互動確認；只挑小片 → 代號含最大片且動工前凍結 |
| **S2** | 首頁入口「導覽開始 → 可搜尋」median，candidate 不得比同輪 legacy 慢超過 V | 只量 deep link → 本條獨立量測、獨立通過 |
| **S3** | `?code=` 入口「導覽開始 → 可搜尋」的劣化**記錄於驗收文件**；劣化 > 1,500 ms → 停下回報 | 不量就不知道 → 列為必填數據 |
| **S4** | **請求順序**：`?code=` 入口，在 shard 回應送達之前，瀏覽器**未發出** `drug_index.json` 請求。e2e 以 route handler 扣住 shard 回應 1,000 ms，斷言這段期間 index 請求數為 0；放行後 index 請求數為 1 | 「同時發但先畫詳情」也能讓詳情先出現 → 直接斷言請求計數與時序 |
| **S5** | **狀態矩陣窮舉**：§5.2 每一列各一支 e2e，以 route handler 把資源固定在該狀態（`loading` 用永不回應的 handler），斷言顯示內容。其中搜尋頁在 index 為 `idle`／`loading` 時，頁面文字不得含「查無」 | 只測 happy path → 列數即測試數，驗收文件逐列對應測試名稱 |
| **S6** | **詳情與 index 無關**：對 §8.1 的代號集合，「index 永不回應」與「index 已就緒」兩種情況下，`#detail` 的 `innerHTML` 逐字相同（同一 `state.today`、同一視窗寬度） | 比對時兩邊其實都等到 index → handler 永不回應，並斷言 index 請求仍 pending |
| **S7** | **index 晚到失敗不撤詳情**：詳情顯示後，index 分別回 (a) HTTP 500 (b) 非 JSON (c) `dataVersion` 不符 (d) 逾時。四種情況下：`#detail` 的 `innerHTML` 與失敗前逐字相同；橫幅出現 §5.5 對應文案；shard 請求總數仍為 1（沒有因 index 落定而重抓／重畫） | 重畫出相同內容也會通過 innerHTML 比對 → 加「shard 請求數仍為 1」與在 `#detail` 根節點掛 expando 屬性、失敗後仍在（節點未被替換） |
| **S8** | **查無從嚴**（D4 表逐列）：(a) 含非法字元 → 查無且 shard 請求數 0；(b) 前綴不在清單 → 查無且 shard 請求數 0；(c) shard 有效但無該 key → 查無；(d) key 存在但 `records` 不是陣列 → **錯誤**，文字不得含「查無」；(e) `meta` 永不回應 → 文字不得含「查無」；(f) shard 回 500 → 錯誤，不得含「查無」；(g) shard 版本不符 → 「資料已更新」，不得含「查無」 | 只測 (a)–(c) 正例 → (d)–(g) 為指名反例，必測 |
| **S9** | **查無的事後更正**：情境 S8(c) 下 index 隨後就緒且**包含**該代號 → 畫面由查無改為錯誤「分片中缺少此代號」＋重試；index 就緒且**不含**該代號 → 維持查無。比較頁：key 不存在維持原「查無」類狀態，key 存在但結構壞顯示「分片內容不合法」 | 只測「不含」那一支 → 兩支都要 |
| **S10** | **提前啟動**：(a) shard 永不回應時，3,000 ms 後 index 請求數為 1；(b) shard 未回應時使用者點「回搜尋頁」→ index 請求立即發出；(c) 上述之後 shard 才回應 → index 請求數仍為 1（不重複啟動） | 只測 (a) → 三支分列 |
| **S11** | **重試隔離**：只有 index 失敗時按「重試」→ `meta.json` 請求數不增加、shard 請求數不增加、`#detail` 節點未被替換；index 請求數 +1 | 重試走整個 `loadCore` 也會成功 → 斷言請求計數 |
| **S12** | **未驗版本不開放搜尋**：`meta` 回 500、index 回 200 → 搜尋框維持停用 | — |
| **S13** | **比較頁與預告中心 deep link**：index 永不回應時，`?codes=`（2 個有效代號）圖表與表格正常顯示；`?view=upcoming` 清單正常顯示；index 就緒後比較籃 chip 出現品名 | 只測詳情 → 本條獨立 |
| **S14** | **建置守門**：注入「index 多一個代號」與「shard 多一個代號」兩個 fixture，`check_guards()` 各自失敗且未寫出任何檔案；實際 `data/` 通過 | 只斷言函式存在 → 兩個方向的注入都要 fail |
| **S15** | **不回歸**：pytest、`npm test`、`npm run e2e` 全綠；`e2e/real-data.spec.mjs` 新增至少一支以真實 `data/` 走 `?code=` 的 smoke | mock 全來自 golden fixture 驗不到真實資料 → 指定 real-data smoke |
| **S16** | `sw.js` 的 `CACHE` 版本號已遞增 | — |
| **S17** | **回頭客量測（只記錄）**：HTTP cache 暖、資料未變時，首頁與 `?code=` 的耗時、`drug_index.json` 的實際傳輸位元組數與狀態碼，寫入驗收文件 | — |

### 8.1 S6 的代號集合

至少包含下列每一類各 ≥ 1 筆；真實資料母體為 0 的類別以合成 fixture 補，並在驗收文件標明哪些是合成：

- 現行有價、單一區間
- 已終止（`priceState: terminated`）
- 有支付空窗（`gap`）
- 區間重疊（`overlap`）
- 來源衝突（`conflict`）
- 含日期異常紀錄（`invalid_records`）
- 有未來生效紀錄（`from > T`）
- `pricedBefore` 三態各一
- **`selectMeta` 回 `null`（尚無已生效紀錄）** ——標題退回值的反例
- **描述欄位不一致（`metaVariants`）** ——`selectMeta` 依日期選用的反例（2026-11-14 真實資料母體為 0，須合成）
- 紀錄數最多的代號（現況 24 筆）

### 8.2 人工項目

藥師目檢：從 `TFDA-drug-info-search` 的「查看健保藥價歷史」連結進站，挑 ≥ 5 個熟悉的代號（含 ≥ 1 個已終止、≥ 1 個有預告），
與線上現行版逐項核對現行價、調價次數、最新事件標籤、歷史表筆數。另在手機實機走一次 deep link。

---

## 9. 實作順序（建議 commit 切分）

1. `scripts/measure_startup.mjs` ＋ M0（§7.1）。**V 不合格即停。**
2. `engine.js`：`validateShard` 的 reason 拆分；`node --test`。
3. `check_guards()` 代號集合守門（S14）。
4. e2e 測試先行：S4–S13 的 route handler 工具與測試（預期紅）。
5. `app.js` 狀態機（D1–D6、§5）。
6. `sw.js` 升版；real-data smoke；全套測試。
7. S1–S3、S17 量測；驗收文件 `.ai-review/startup-acceptance.md`，每條 ✅ 指到測試名稱與斷言。
8. `/codex-review`（含區塊 4 規格符合度與驗收證據稽核）。
9. 藥師目檢。

---

## 10. 第二期：拆 index（**不在本規格範圍，另開規格**）

承諾事項（已與使用者確認）：

- 先做量測原型，**原型的驗證強度必須與正式實作一致**（前案 v0.3 停工的原因）。
- 門檻在第一期完成後，依新的 baseline 與 V 另訂，並先問使用者。
- 原型達不到門檻即停，不合併、不調門檻。
- 會動 `spec.md` §7 契約，屆時獨立跑 `/codex-checkplan`。

---

## 11. 已知限制與假設

- **假設 H1**：輪間變異 V 約 300 ms（前案 2026-10-13 的觀察，不同指標）。由 M0 驗證。
- **假設 H2**：改善幅度約 4 秒。推論依據：legacy 路徑含 3.3 MB index 下載（9 Mbps 約 2.9 秒）與 30 MB raw 的 parse／prepare；candidate 只含 31 KB ＋ ≤ 0.14 MB。**未實測**，由 S1 驗證。
- **限制 L1**：`?code=` 入口的「可搜尋」時間會變慢（index 晚啟動約等於 `meta` ＋ shard 的時間）。S3 記錄並設上限。
- **限制 L2**：D3 的殘餘情況——`meta` 舊批、index 新批時顯示自洽的舊批詳情加橫幅。
- **限制 L3**：`meta` 與 shard 串行兩次往返（N6）；高延遲網路下這是固定成本。

---

## 12. 修訂紀錄

- v0.1（2026-11-14）：初稿。依 2026-11-14 需求確認的六項決策撰寫；對需求摘要的兩處修正——
  (1) 代號格式短路不檢查長度（D4）；(2) 詳情摘要本來就只由 shard 推導，「全量逐筆比對 index 與 shard 摘要」改為 S6「詳情與 index 狀態無關」。
