你是獨立覆審員。**唯讀模式：禁止寫入或修改任何檔案，只輸出報告文字。**

這是 `spec-startup.md` 的**第二輪**規格覆審。第一輪你審的是 v0.1；主持人逐項判定後修訂為 **v0.2**（全文附於末尾）。
判定書也附在後面。這仍是**規格層審查**：不審程式碼品質、**不要給程式碼實作建議**。
你可以讀 repo 內既有檔案查證規格對現況的描述。

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

# 第二輪要求

v0.2 相對 v0.1 的主要變動：新增不變量 I1（`meta` ready 後不重抓）與 I2（index 驗版後才發布）；
刪除 3,000 ms 計時器，改為 T1／T2 兩個啟動觸發；D4 加判定順序與「資料矛盾」規則；
守門語意改為「每碼恰在最長前綴所選的那一片」；量測改為 5 區塊配對；S1–S17 全部改寫並新增 S5b。

請產出三個區塊，每一項都要有：**嚴重度 / 問題 / 為什麼現在不修之後會更貴 / 建議修法（規格層）**，並編號（A1、B1、C1 …）。

**A. 第一輪項目的修訂是否到位**
逐一檢查判定書中「接受」「部分接受」的項目：v0.2 是否真的堵住了你指出的問題？
只列**未到位**或**修歪了**的項目；已到位的不必逐條覆述，最後用一行列出已到位的編號即可。
對判定書中你不同意的「部分接受」（1.3、1.6、3.10、3.16、3.18），若認為主持人的理由不成立，請具體反駁；若成立就說成立。

**B. v0.2 新引入的問題**
重點檢查新東西：
- I1／I2 是否自洽、是否與現有程式行為或其他規格（`spec-compare.md` §6、`spec-upcoming.md` §5.5）衝突；
  I1 之下是否有任何路徑仍會重抓 `meta`（例如既有的重試、預告中心自身的載入流程）。
- T1／T2 的定義是否有無法判定或互相矛盾的情境；刪除計時器後是否有 index 永不啟動的路徑。
- D4.1 十列的順序是否完備、互斥；D4.3 的「有限例外」是否會被擴大解讀。
- §5.2 的可達組合是否有遺漏的可達狀態，或把可達的列為不可達。
- §5.6 守門的定義是否可由 Python 端明確實作而不依賴前端程式（跨語言各實作一次是本專案慣例）。
- §7 的區塊設計與 §7.2 判定規則是否有可被操弄或自相矛盾之處。

**C. S1–S17、S5b 的殘餘弱化版本**
只列你**仍能具體說出弱化實作**的條目；說不出來的不要列。

## 嚴重度定義（「發現得越晚越貴」軸）

- **Blocker** — 方向錯，寫完要整段重來
- **High** — 要改架構或資料模型
- **Medium** — 要多寫／改程式，但不動架構
- **Low** — 文件或命名層級

## 其他規定

- **不要新增「目標與非目標」以外的需求**。真心認為必要者標注 `[新增需求]` 並說明不做的具體、可觀察後果。
- 不要為了湊數而列項。若 v0.2 已可動工，請直說。
- 最後給一行總結：Blocker／High／Medium／Low 各幾項，以及你的結論——**可以動工** 或 **需再修訂**。
- 以繁體中文輸出。

---

# 第一輪判定書（`.ai-review/plan-verdict-startup.md`）

# 規格覆審判定書 — spec-startup.md（第一輪）

> 判定日期：2026-11-14
> 受審：`spec-startup.md` v0.1；Codex 原文：`.ai-review/plan-review-startup.md`
> 結果：接受 24／部分接受 5／拒絕 0（其中範圍蔓延 2，皆為部分接受項內被拒的部分）
> 修訂後版本：`spec-startup.md` v0.2

Codex 對現況的查證（HEAD、`loadCore()`、詳情由 shard 推導、代號集合 45,224／348 片、`validateShard` 合併兩種 reason、
發布路徑無代號集合守門）與 v0.1 §1 一致，無事實性爭議。

| # | 項目 | Codex 嚴重度 | 判定 | 理由與修訂 |
|---|------|------|------|------|
| 1.1 | `meta` 失敗後已取得的 index 無轉移契約 | High | 接受 | 屬實：`validateIndex()` 無 `meta` 時回成功。修法比 Codex 提的兩案更簡單——**index 只在 `meta` ready 後才發布**；非首頁入口在 `meta` ready 前不 fetch index，首頁入口平行 fetch 但結果扣住，`meta` 失敗即丟棄。「取得但未驗版本」狀態因此不存在（v0.2 I2、D2） |
| 1.2 | 序號只保障畫面，快取與共用狀態無有效範圍 | High | 接受 | 屬實。v0.2 以 I1（`meta` ready 後本次頁面生命週期不重抓）消去「世代切換」整類問題；另明定 shard 快取只保存已通過版本比對者、詳情與比較共用同一 loader、視圖層狀態只在該視圖序號仍有效時寫入（§5.3） |
| 1.3 | 3,000 ms 的起算、重設與同時觸發未定義 | Medium | 部分接受 | 問題屬實，但修法不是補定義而是**刪掉計時器**：所有請求都有 fetch 逾時，落定必然發生；使用者一導覽就啟動 index（T2）。計時器唯一的受益者是比較籃 chip 品名，不值得一整類邊界 |
| 1.4 | 比較頁無請求、轉址、部分失敗的落定有缺口 | Medium | 接受 | 改以「首個視圖的載入工作落定」統一定義，零請求即立即落定；選定集合改變屬導覽，直接觸發 T2。比較／預告自身狀態明寫沿用各自規格，僅換閘門（D2、§5.2） |
| 1.5 | D4 條件優先序有歧義 | Medium | 接受 | 區分「輸入語法無效」（不依賴資料，任何 `meta` 狀態下皆可判）與「資料中不存在」（須 `meta` ready）；補判定順序與 S8 反例（空碼、空白、合法非 10 碼） |
| 1.6 | 無匹配前綴＝查無，新增對 shard map 完整性的依賴 | High | 部分接受 | 問題屬實、修法接受；嚴重度應為 Medium（只強化 `validateMeta` 的合法性條件，不動架構或資料模型）。v0.2 §5.7 定義 shard map 合法性，不合法 → `meta` error，不得落到查無 |
| 2.1 | D3 論證未涵蓋同畫面的 index 品名 | High | 接受 | 屬實：比較籃 chip 與比較主體 fallback 會顯示 index 品名。論證改寫為「畫面上每個 index 衍生內容都必須來自已對目前 `meta` 驗證成功的 index」；error／mismatch 時 `byCode`／`prepared` 為空（I2、D3） |
| 2.2 | mismatch 不代表目前頁面是更新前的資料 | Medium | 接受 | 屬實（新 `meta`＋新 shard＋舊 index 亦可能）。文案改為不斷言方向；`status.json` 不在同批保證內列為限制 L4 |
| 2.3 | 代號聯集相等無法保證前端找得到代號 | High | 接受 | 屬實：錯片、重複皆不改變聯集。守門改為「每個代號恰存在於一片，且該片等於依同份 shard map 最長前綴選中的檔案」，不可由 `allow_anomaly` 豁免（§5.6）。嚴重度以工作量論為 Medium，但它是 D4 安全性的前提，維持 High |
| 2.4 | 事後更正只寫一種到達順序，且與禁止重畫衝突 | Medium | 接受 | 改為與到達順序無關的資料錯誤定義，兩個評估時點；明列為禁止重畫的有限例外；比較頁同規則（D4.3） |
| 3.1 | S1 互動終點可提前，失敗樣本會消失 | Medium | 接受 | 終點改為點擊排序後**表格首列內容符合預期順序**且經兩個 animation frame；任一樣本未達終點 → 整輪作廢重跑，不得剔除（§7） |
| 3.2 | S2 可搜尋未定義為搜尋真的完成 | Medium | 接受 | 終點改為固定查詢得到預期首筆結果；首頁另量自身變異 `V_home` |
| 3.3 | S3 單一數字掩蓋搜尋可用性差異 | Medium | 接受 | 同三碼、逐碼判定；被動等待 `search-ready` 後才切搜尋並驗證 300 ms 內得到預期結果，避免量測本身觸發 T2 |
| 3.4 | S4 驗不到 `meta` 等待與 body 階段 | Medium | 接受 | 分別扣住 `meta`、shard body（`e2e/server.mjs` 已有 stall-body 能力），並補失敗落定路徑 |
| 3.5 | S5 每列一支不等於窮舉 | Medium | 接受 | I1／I2 讓可達組合大幅減少；v0.2 §5.2 列出全部可達組合與不可達理由，另加轉移測試（S5b） |
| 3.6 | S6 兩邊相同不代表任一邊正確 | Medium | 接受 | 先以 golden 獨立預期值核對內容，再比對相等；補 `document.title`；固定 `status` |
| 3.7 | S7 根節點 expando 擋不住重畫子內容 | Medium | 接受 | 改用 `MutationObserver` 斷言 index 落定期間 `#detail` 子樹零 mutation，並保存子節點身分與已切換的排序狀態 |
| 3.8 | S8 只指名一種結構錯誤 | Medium | 接受 | 逐條列出 `validateShard` 的每個結構條件作反例 |
| 3.9 | S9 更正可能套到已離開的品項 | Medium | 接受 | 補離頁、返回、`retry-shard`、mismatch index 不得作為更正證據 |
| 3.10 | S10 未禁止太早、未測全部觸發入口 | Medium | 部分接受 | 計時器已刪（見 1.3），「focus 搜尋框」觸發一併刪除（搜尋框在其他視圖是隱藏的，不可達）。其餘接受：落定前斷言 0、落定後 1、每種導覽入口各測 |
| 3.11 | S11 重抓隔離不等於重試正確 | Medium | 接受 | 補重試成功後搜尋恢復、失敗可再試、mismatch 不開放 |
| 3.12 | S12 disabled 不是未驗資料沒有外洩 | Medium | 接受 | 補無結果節點、無可進入連結、`meta` 重試成功後恢復 |
| 3.13 | S13「正常顯示」未指定正確性與保留性質 | Medium | 接受 | 補具體內容斷言與主體零 mutation（chip 區除外） |
| 3.14 | S14 直接測 guard 證明不了零寫入 | Medium | 接受 | 改由正式發布入口 `run()` 注入，對預先存在的 `data/` 比對前後位元組；四種注入 |
| 3.15 | S15 real-data smoke 可完全沒走 fast path | Medium | 接受 | smoke 扣住 index 並核對內容；`e2e/server.mjs` 本來就掛 `/NHI-drug-price-history/` 子路徑，走子路徑零成本 |
| 3.16 | S16 字面升版不能證明新外殼可更新 | Medium | 部分接受 | SW 邏輯本案不改，且外殼為 network-first（線上時一律取新檔，`CACHE` 版本只影響離線）。接受「不能只看字面」：改為靜態斷言 `PREFIX` 不變、`CACHE` 改變、`SHELL` 清單與 `data/` 旁路不變，加人工目檢一項。**拒絕**新增 SW 更新流程的 e2e（Playwright 設定全域封鎖 SW，等同新建測試基礎設施）——範圍蔓延，移至 §11 後續 |
| 3.17 | S17 gzip server 量不出條件式快取 | Medium | 接受 | 改對**線上 GitHub Pages**（部署後）量測，同一 browser context 重新導覽，經 CDP 分別記錄狀態碼、傳輸量、解碼後大小 |
| 3.18 | M0 兩輪 median 接近不足以證明變異受控 | Medium | 部分接受 | 接受：多區塊、平衡順序、兩側 gzip 預熱一致、報配對改善分布、預先凍結證據不足時的處置。**不採**更複雜的統計判準（信賴區間等）：5 個區塊的全距已足以回答「門檻是否遠離變異」，再複雜即是對一個預期秒級的改善過度設計 |
| 4.1 | 選擇性快取失效是不必要的複雜度 | Low | 接受 | 採更強的簡化：I1（`meta` ready 後不重抓，換批只能 reload），shard 快取因此在頁面生命週期內永不失效 |

## 範圍蔓延處置

- 3.16 的 SW 更新流程 e2e：移至 `spec-startup.md` §11「後續版本」。
- 3.18 的進階統計判準：不採，理由如上。

## 是否需重審

需要。1.1、1.2、2.1、2.3 與 1.3／4.1 的簡化共同改寫了 v0.1 的狀態契約（新增不變量 I1／I2、刪除計時器、守門語意改變）。
v0.2 的狀態契約是新的東西，送第二輪。

---

# 規格全文（`spec-startup.md` v0.2）

# Spec — 首訪啟動策略（Startup Fast Path）

- 版本：v0.2（2026-11-14，第一輪 `/codex-checkplan` 覆審後修訂；待第二輪）
- 基準 commit：`7ac1760`（main）
- 上位規格：`spec.md`（§7、§8.7、§16）。本文件與上位規格衝突時，以本文件明列的「推翻」為準，其餘一律沿用
- 前案：`spec-index-format.md`（分支 `feat/index-columnar-b`，**已終止、不得合併**）
- 覆審紀錄：`.ai-review/plan-review-startup.md`、`.ai-review/plan-verdict-startup.md`

---

## 1. 問題

`app.js` 的 `loadCore()` 對 `meta.json` 與 `drug_index.json` 做 `await Promise.all(...)`，
兩者都到齊才進 `state.core = 'ready'`；`showDetail()`、`showCompare()` 都以 `state.core !== 'ready'` 擋下。
因此帶代號的 deep link（`?code=<NHI_CODE>`，來源為 `TFDA-drug-info-search` 的「查看健保藥價歷史」）
必須先付完整份 index，才看得到一個藥的價格。

歷史實測（`spec-index-format.md` §1，2026-09-23，CPU 4x、9 Mbps／60 ms、冷 cache；**本案未重量，僅作背景**）：
index fetch→parsed 4,433 ms、parsed→可搜尋 382 ms，合計 4,815 ms。index gzip 約 3.3 MB、raw 約 30 MB。

2026-11-14 對 `data/`（`dataVersion` 同 `7ac1760`）全量查核的事實（Codex 第一輪獨立複核一致）：

| 事實 | 結果 |
|---|---|
| index 代號集合 vs 348 片 shard 代號集合 | 皆 45,224；雙向差集 0 |
| shard `meta` 的 8 個描述欄位（`atcCode` `chName` `enName` `dosageForm` `ingredient` `manufacturer` `strength` `strengthUnit`）vs index | 差異 0 筆 |
| `metaVariants` 條目 | 0 筆 |
| `renderDetail()` 讀取的資料 | 只讀 `state.current.entry`（shard）、`state.today`、`stale()`（來自 `status.json`）；**不讀 index** |
| `showDetail()` 對 index 的依賴 | 僅兩處：`state.byCode.get(code)` 判定「查無此代號」、`drug.chName` 設 `document.title` |
| 比較頁對 index 的依賴 | `trayChipHTML()` 的品名、`renderCompare` 的品名 fallback（已是 `?.`，缺值時顯示空字串） |
| 預告中心對 index 的依賴 | 無（只需 `meta` 驗版本） |
| 最大 shard（`AC49`） | gzip 134,943 B、raw 1,474,406 B；`meta.json` 31,328 B |
| `validateShard()` | 「key 不存在」與「key 存在但結構壞」都回 `missing_code` |
| `validateMeta()` | 只檢查外層型別；空 `files`、成員型別錯、`files` 與 `versions` 不一致都會通過 |
| `validateIndex(index, meta)` | `meta` 為 falsy 時**不比對版本即回成功** |
| 發布路徑 | 沒有對實際產物檢查 index／shard 代號集合；僅 `tests/test_history.py` 在 fixture 上斷言 |
| GitHub Pages 對 `drug_index.json` | `ETag` ＋ `Cache-Control: max-age=600`；`If-None-Match` 回 304（curl 驗證，瀏覽器內未量） |

結論：詳情頁所需資料 = `meta.json` ＋ 一片 shard。**阻塞在 index 上是載入狀態機的設計，不是資料依賴。**

---

## 2. 目標與非目標

### 目標

- **G1**：deep link（`?code=`）進站時，詳情頁在 `meta.json` ＋ 對應 shard 到齊並驗證通過後即顯示，不等 index。
- **G2**：同一套狀態機套用到比較頁 deep link（`?codes=`）與預告中心（`?view=upcoming`）：只等它們實際需要的資源。
- **G3**：首頁（無參數）入口行為與耗時不變。
- **G4**：順帶量測回頭客（HTTP cache 暖）開站耗時，**只記錄、不設門檻、不做任何優化**。

### 非目標（本案一律不做）

- **N1**：不改任何資料檔的格式、欄位、分片規則。`build_price_history.py` 與 `lib/` 只加 §5.6 的守門，不改任何輸出內容。
- **N2**：不拆 index、不改 index 表示法、不合併 `feat/index-columnar-b`。拆 index 屬第二期（§10），另開規格。
- **N3**：不改 Service Worker「`data/` 完全不經 SW」的設計；不引入 IndexedDB／localStorage 資料快取。
- **N4**：不改任何判定邏輯（`summaryAt`、`selectMeta`、`searchCard`、`terminatedMask`、標籤決策表）與任何既有顯示文案；新增文案僅限 §5.5。
- **N5**：不改比較頁、預告中心既有的效能門檻與其自身的載入／失敗狀態（`spec-compare.md` §6、§8.1；`spec-upcoming.md` §5.5、§8.2）。
- **N6**：不加 `<link rel="preload">`、不做推測性 fetch。`spec.md` §7 規定前端不得寫死分片前綴長度。
- **N7**：不做「`meta` 換批時最大化快取重用」之類的錯誤恢復最佳化（見 I1）。
- **N8**：不處理 dependabot PR。

---

## 3. 平台限制

- GitHub Pages 專案頁：純靜態、無法自訂回應標頭、CDN `max-age=600`。同一次開站的各檔案可能來自不同批次（混批）。
- 前端零建置：原生 ES module、無 bundler、無 runtime 依賴。`engine.js` 為純邏輯層（無 DOM、無 I/O），`app.js` 負責 DOM 與載入。
- 所有資料請求皆 `fetch(url, { cache: 'no-cache' })`，且各有逾時（`TIMEOUT`：meta 30 s、index 120 s、shard 45 s、upcoming 30 s）。**任何請求必然在有限時間內落定。**
- Service Worker 只快取外殼（network-first）。本案會改 `app.js`／`engine.js`，須升 `sw.js` 的 `CACHE` 版本號。

---

## 4. 架構決策

### 兩條不變量（整份規格的基礎）

- **I1　`meta` 一旦 ready，本次頁面生命週期內不再重抓。** 要換批只能整頁重新整理（`reload`）。
  `retry-core` 只有在 `meta` 為 error 時才會重抓 `meta`——此時沒有任何依賴 `meta` 的視圖或快取存在。
  後果：不存在「`meta` 世代切換」；shard 快取在頁面生命週期內不需失效。
- **I2　index 只在通過對目前 `meta` 的版本比對後才「發布」。** 發布＝寫入 `state.prepared`／`state.byCode` 並開放搜尋。
  未發布時這兩者為空；畫面上任何 index 衍生內容（搜尋結果、比較籃 chip 品名、比較主體的品名 fallback）只能來自已發布的 index。
  index 為 error／mismatch 時視同未發布（已發布過的不會回到未發布，見 §5.4）。

### D1　把單一 `state.core` 拆成兩個獨立資源狀態

| 資源 | 狀態 | 誰需要 |
|---|---|---|
| `meta` | `loading`／`ready`／`error` | 所有視圖 |
| `index` | `idle`（尚未開始或已丟棄）／`loading`／`ready`（已發布）／`error`／`mismatch` | 搜尋頁；比較籃 chip 與比較主體的品名 fallback |

- 詳情頁、比較頁、預告中心的閘門改為 **`meta === 'ready'`**；搜尋頁的閘門為 **`index === 'ready'`**。
- **為什麼不保留單一 `core` 加旁路旗標**：旁路會讓「index 失敗時詳情是否仍可用」散落在各個判斷式，本案的風險全在這些分支；
  兩個明確的狀態變數讓每個視圖的閘門只有一句，且可達組合可被列舉（§5.2）。

### D2　index 的啟動時機

**首頁（無參數）入口**：`meta` 與 index 平行 fetch（**與現況相同**，G3）。index 的結果（成功或失敗）扣住，等 `meta` 落定：

- `meta` ready → 對 index 做版本比對 → `ready`／`mismatch`／`error`。
- `meta` error → **丟棄** index 結果，index 回 `idle`。`retry-core` 重抓兩者（現況行為）。

**其他入口**（`?code=`、`?codes=`、`?view=upcoming`）：`meta` ready 之前**不 fetch index**。`meta` ready 後，下列任一事件發生即開始 fetch，且一次頁面生命週期內**只啟動一次**（重試另計，§5.4）：

- **T1　首個視圖的載入工作落定。**「首個視圖」＝`meta` ready 後第一次 `route()` 進入的視圖；「載入工作」＝該次進入所發出的全部資料請求；
  「落定」＝這些請求全部 resolve 或 reject **且其驗證已完成**（HTTP 成功但驗證失敗也算落定）。該次進入**沒有發出任何請求**時（例如查無、零個有效代號、全部命中快取）立即落定。
  比較頁在單一有效代號時轉為詳情（現況行為）——以轉入後的詳情為首個視圖。
- **T2　任何後續導覽。** 首次 `route()` 之後的任一次 `route()`／`navigate()`（含 `popstate`、頁內連結、比較籃增刪導致的重新載入）。

`meta` 為 error 時不啟動 index；`retry-core` 成功後重新 `route()`，上述規則以新的首個視圖重新適用。

- **為什麼不同時抓**：9 Mbps 下 3.3 MB 的 index 會與 shard 互搶頻寬，直接削弱 G1。（使用者決策，2026-11-14）
- **為什麼不延到使用者點搜尋才抓**：第一次搜尋要等完整冷載入；詳情頁閱讀期間的頻寬是閒置的。（使用者決策）
- **為什麼沒有「等太久就提前啟動」的計時器**（v0.1 有，v0.2 刪除）：所有請求都有逾時，T1 必然發生；使用者一離開該視圖 T2 即觸發。
  計時器只能讓比較籃 chip 的品名早幾秒出現，卻帶來起算點、重設、與落定同時觸發等一整類邊界。

### D3　index 晚到後失敗或版本不符：已顯示的視圖保留

詳情頁（比較頁、預告中心主體亦同）的正確性依據是 **shard／`upcoming.json` 對 `meta` 的版本比對**，與 index 無關。
index 進入 `error`／`mismatch` 時，已顯示的主體**不撤下、不重畫**，只在橫幅區顯示 §5.5 的訊息。（使用者決策，2026-11-14）

- **推翻的上位規則**：`spec.md` §7「`index.dataVersion ≠ meta.dataVersion` → 不組合摘要與圖表」。在本案下只適用於需要 index 的內容。
  shard 與 `meta` 的版本比對規則一字不改。
- **為什麼可以推翻**：該規則防的是「同一畫面混用兩批資料」。本案以 I2 維持同一性質：
  **畫面上每個 index 衍生內容都來自已對目前 `meta` 驗證成功的 index**；index 為 error／mismatch 時這些內容為空，不會出現「舊 shard 的價格配另一批的品名」。
- **同批保證的範圍（明列）**：`meta`、shard、`upcoming.json`、已發布的 index。**`status.json` 不在其內**——它沒有與 `meta` 的版本連動（現況即如此，本案不改），見 L4。
- **mismatch 時不知道誰新誰舊**：版本雜湊只能判斷不同。`meta` 舊＋index 新、或 `meta` 新＋index 舊都可能。§5.5 文案不得斷言方向。

### D4　「查無此代號」改由 `meta` ＋ shard 判定，且從嚴

#### D4.1　判定順序（由上而下，第一個成立者決定顯示）

| 順序 | 條件 | 顯示 | 請求 |
|---|---|---|---|
| 1 | **輸入語法無效**：`trim().toUpperCase()` 後為空字串，或含 `[A-Z0-9]` 以外字元 | 「查無此代號」（現有文案） | 不發 shard。此判定不依賴資料，**任何 `meta` 狀態下皆成立** |
| 2 | `meta` 為 `loading` | 「資料載入中…」 | — |
| 3 | `meta` 為 `error`（含 shard map 不合法，§5.7） | 錯誤＋重試 | — |
| 4 | `shardPrefix(code, meta.shards)` 回 `null` | 「查無此代號」 | 不發 shard |
| 5 | shard 請求失敗（network／http／逾時／非 JSON） | 錯誤＋重試（現況） | 1 |
| 6 | shard 外層結構不合法（非物件、`shardVersion` 非字串、`drugs` 非物件） | 錯誤「分片內容不合法」＋重試 | 1 |
| 7 | `shardVersion` 與 `meta.shards.versions[prefix]` 不符 | 「資料已更新，請重新整理頁面」（現況） | 1 |
| 8 | `shard.drugs` **沒有該 own key** | 「查無此代號」；另受 D4.3 約束 | 1 |
| 9 | own key 存在但條目結構不合法（值非物件、`records` 非陣列、`invalidRecords` 非陣列、`meta` 非物件且 `metaVariants` 非陣列） | 錯誤「分片內容不合法」＋重試。**不是查無** | 1 |
| 10 | 以上皆否 | 完整詳情 | 1 |

- **不檢查代號長度**。現有代號全為 10 碼，但長度不是 `spec.md` 的契約；合法英數而非 10 碼的代號若存在於 shard，必須正常顯示。（對需求摘要「非 10 碼英數直接查無」的修正）
- 第 1 列與第 4、8 列顯示同一句文案，但語意不同：第 1 列是輸入問題，第 4、8 列是「資料中不存在」，後者**必須 `meta` ready 才可能出現**。

#### D4.2　`validateShard` 的 reason 拆分

現行 `missing_code` 拆為「key 不存在」與「條目結構不合法」兩個 reason。既有呼叫端的行為：

- 詳情頁：依 D4.1 第 8、9 列。
- 比較頁：「key 不存在」維持現有 `missing` 狀態；「條目結構不合法」歸入 `error`「分片內容不合法」。**這是比較頁的可觀察行為變更**（現況兩者都顯示為 `missing`）。

#### D4.3　資料矛盾：與到達順序無關

**定義**：已發布的 index 含某代號，而通過版本比對的對應 shard 沒有該 own key。這是建置缺陷，不是「查無」。

- 顯示：錯誤「分片中缺少此代號」＋重試（現有文案，現況在此情境即顯示這句）。
- **兩個評估時點**，結果必須相同：
  1. shard 判定出 D4.1 第 8 列時，若 index 已發布 → 直接依本節顯示錯誤，不顯示查無。
  2. index 發布時，若**目前視圖**正顯示**目前代號**的第 8 列查無 → 改為錯誤。
- 第 2 點是 §5.3「index 落定不得重畫主體」的**唯一例外**，範圍限於：目前視圖、目前代號、畫面為第 8 列查無。已離開該代號者不得被回頭更正。
- index 為 mismatch／error 時不是已發布，**不得作為更正證據**。
- 比較頁同規則：某代號為 `missing` 且已發布的 index 含該代號 → 該代號改為 `error`「分片中缺少此代號」；只影響該代號，其他品項不動。
- 另有 §5.6 的建置守門從源頭阻止此缺陷進入發布。

### D5　`document.title` 的品名來源改為與頁面 H2 相同

現況 `drug.chName`（index）；改為 `E.selectMeta(entry, T)?.chName`，為空時退回代號。沿用既有樣板 `${name || code}（${code}）— ${APP_TITLE}`。
可觀察差異：`selectMeta` 回 `null`（尚無已生效紀錄）時，標題的品名位置由 index 品名變為代號。

### D6　`state.current` 不再持有 index 條目

`state.current = { code, entry }`。`state.current.drug` 無讀取端（2026-11-14 grep、Codex 複核）。

---

## 5. 行為規格

### 5.1 載入序列（`?code=`）

```
t0  導覽開始
    ├─ fetch status.json（輔助，不阻塞，現況）
    └─ fetch meta.json
t1  meta 到 → validateMeta（含 shard map 合法性）→ route() → shardPrefix → fetch shard
t2  shard 到 → validateShard → renderDetail → 「詳情可互動」
    └─ T1 成立：此刻才開始 fetch drug_index.json
t3  index 到 → validateIndex（對目前 meta）→ prepareIndex → 發布；比較籃 chip 補上品名
```

`meta` 與 shard 是**串行**的兩次往返（N6）。

### 5.2 可達狀態組合與顯示

**不可達組合**（由 I2、D2 保證，須有測試證明進不去，見 S5）：`meta` 為 `loading` 或 `error` 時，index 不可能是 `ready`／`error`／`mismatch`。

| # | 視圖 | `meta` | `index` | 何時可達 | 顯示 |
|---|---|---|---|---|---|
| M1 | 搜尋 | loading | loading | 首頁入口 | 載入中；搜尋框停用；無結果節點；**不得出現「查無」** |
| M2 | 搜尋 | loading | idle | 其他入口後導覽至搜尋，但 `meta` 尚未到 | 同 M1 |
| M3 | 搜尋 | error | idle | `meta` 失敗 | 錯誤＋重試（現有文案）；搜尋框停用；無結果節點 |
| M4 | 搜尋 | ready | idle／loading | index 尚未到 | 同 M1 |
| M5 | 搜尋 | ready | ready | — | 正常 |
| M6 | 搜尋 | ready | error | — | 錯誤＋重試（現有文案） |
| M7 | 搜尋 | ready | mismatch | — | 「資料已更新，請重新整理頁面」（現有文案） |
| M8 | 詳情 | loading | idle／loading | — | D4.1 第 1 或 2 列 |
| M9 | 詳情 | error | idle | — | D4.1 第 1 或 3 列 |
| M10 | 詳情 | ready | idle／loading／ready／error／mismatch | — | D4.1 第 4–10 列；index 為 error／mismatch 時另有 §5.5 橫幅 |
| M11 | 比較／預告 | loading | 任一可達 | — | 該視圖現有的載入中 |
| M12 | 比較／預告 | error | idle | — | 該視圖現有的錯誤 |
| M13 | 比較／預告 | ready | 任一 | — | **該視圖自身的狀態機照舊**（`spec-compare.md` §6、`spec-upcoming.md` §5.5：loading／error／mismatch／retrying 等），唯一改變是閘門由 `core` 換成 `meta`。比較籃 chip 與品名 fallback 在 index 非 `ready` 時為空，發布後補上 |

### 5.3 競態與有效範圍

每個回應抵達時，對四類目標各自的規則：

| 目標 | 何時可寫入 |
|---|---|
| **shard 快取** | 只保存**已通過 `shardVersion` 比對**的 shard。與發出請求的視圖是否仍在無關（I1 保證 `meta` 不變，故通過比對的 shard 永遠有效）。未通過比對或結構不合法者不得留在快取 |
| **視圖層狀態**（DOM、`state.current`、比較頁的每代號狀態與 `compareMismatch` 等旗標） | 只在發出請求的**該視圖序號仍為最新**時寫入。過期回應不得改動任何可觀察的視圖狀態或錯誤旗標 |
| **T1 落定通知** | 只由首個視圖的載入工作觸發一次；之後的回應不再觸發。即使該視圖已被離開（序號過期），其請求落定仍可觸發 T1——但此時 T2 已先成立，index 早已啟動，T1 為無效果 |
| **index 發布** | 只更新搜尋相關狀態、橫幅、比較籃 chip／品名 fallback，以及 D4.3 的有限例外。**不得呼叫會重畫目前詳情／比較／預告主體的路徑**（現況 `loadCore()` 結尾無條件 `route()`，本案必須避免） |

- 詳情頁與比較頁**共用同一個 shard loader**（現有 `loadShard()` 的 in-flight 共享）：同一片在途時，第二個請求者不得再發一次請求。
- `meta` ready 時 `route()` 一次；index 落定時不 `route()`（搜尋頁為目前視圖時，更新搜尋頁自身即可）。
- 過期的 `meta`／index 回應（`retry-core` 期間較舊的請求較晚完成）一律丟棄，沿用 `coreSeq` 的做法。

### 5.4 重試

| 情境 | 按鈕 | 行為 |
|---|---|---|
| `meta` error | `retry-core` | 重抓 `meta`；首頁入口同時重抓 index（現況），其他入口依 D2 |
| `meta` ready、index error | `retry-core` | **只重抓 index**，與目前的 `meta` 比對版本；不重抓 `meta`（I1）、不重畫目前主體。成功 → 發布、搜尋可用、橫幅消失；失敗 → 維持 error、可再試；版本不符 → mismatch |
| index mismatch | `reload` | 整頁重新整理（現況） |
| shard 失敗 | `retry-shard` | 現況 |

index 重試期間使用者導覽到其他視圖時，重試結果只更新搜尋相關狀態，不得把使用者拉回原視圖。

### 5.5 橫幅文案（本案唯一新增的文案）

目前視圖**不是**搜尋頁，且 index 為下列狀態時，在橫幅區顯示：

| index 狀態 | 文案 | 按鈕 |
|---|---|---|
| `error` | 搜尋功能暫時無法使用（`<原因>`）。目前頁面的資料不受影響。 | 重試（`retry-core`） |
| `mismatch` | 搜尋資料與目前頁面的資料版本不一致。請重新整理頁面。 | 重新整理（`reload`） |

`idle`／`loading` 時非搜尋視圖**不顯示任何 index 相關訊息**。

### 5.6 建置守門

查無判定改由 shard 承擔後，「前端依 shard map 找得到每個代號」成為前端行為的前提。在發布路徑加一條守門：

> 對實際產出：index 的每個代號**恰好存在於一片 shard**，且該片等於「以同一份產出的 shard map 做最長前綴比對」所選中的檔案；反之每個 shard 內的代號都在 index 內。

- 違反 → `exit 1`，`data/` 與 `status.json` 零寫入（沿用全有全無契約）。
- **不屬於語意異常，不可由 `allow_anomaly` 放行。**
- 不改任何輸出內容（N1）。

### 5.7 shard map 合法性（`validateMeta` 強化）

D4.1 第 4 列把「無匹配前綴」當作不存在的證據，前提是 shard map 可信。`meta` 必須同時滿足下列條件才算 ready，否則為 error（「meta.json 內容不合法」，現有文案）：

- `shards.files` 為**非空**陣列，成員皆為非空字串且不重複。
- `shards.versions` 的 key 集合與 `files` 的成員集合**相等**，值皆為非空字串。

實際 `data/meta.json` 須通過（S8）。

### 5.8 效能標記

既有 `performance.mark`／`measure` 名稱保留語意。`index-fetch-start` 改在 index **實際開始 fetch** 時標記；`search-ready` 維持「index 已發布且搜尋可執行」的語意。

---

## 6. 資料流與失敗行為

| 來源 | 轉換 | 落點 | 失敗時 |
|---|---|---|---|
| `meta.json` | `validateMeta`（§5.7） | `state.meta`（I1：寫入一次） | 所有視圖顯示錯誤＋重試；不發 shard；index 不啟動或被丟棄（D2） |
| shard | `validateShard`（對 `meta`） | shard 快取（僅通過比對者）、`state.current.entry` | D4.1 |
| `drug_index.json` | `validateIndex`（**必須有 `meta`**）→ `prepareIndex` | `state.prepared`、`state.byCode`（I2） | §5.5 橫幅；搜尋頁顯示錯誤；主體不變 |
| `status.json` | 現況 | 現況 | 現況 |

---

## 7. 量測方法（**實作前凍結**）

新腳本 `scripts/measure_startup.mjs`，沿用 `measure_e7.mjs` 的 gzip 伺服器與 CDP 節流。

| 項目 | 規定 |
|---|---|
| 條件 | CPU 4x throttle、9 Mbps／60 ms latency、gzip level 6、瀏覽器冷 cache（`Network.setCacheDisabled`）、SW 封鎖；記錄 Chromium 版本字串 |
| 對象 | **legacy**：基準 commit `7ac1760` 的前端檔，以 `git worktree` 取出、另一個 port 提供；**candidate**：本分支。兩者指向**同一份 `data/`** |
| 伺服器預熱 | 量測前兩側伺服器都先把所有會用到的檔案 gzip 完成（伺服器端快取就緒）；瀏覽器端仍為冷 cache |
| 代號 | 3 個：最大片 `AC49` 內 1 個、gzip 大小中位片內 1 個、最小片內 1 個。**動工前選定並寫入腳本常數，之後不得更換** |
| 區塊 | **5 個區塊**。每個區塊內，每個代號量 legacy 3 次、candidate 3 次，順序為 ABBAAB 與 BAABBA 逐區塊交替（平衡先後） |
| 區塊統計 | 每個區塊、每個代號：兩側各取 3 次的 median，相減得該區塊的**配對改善值**。全案得 5 × 3 個配對改善值 |
| 樣本有效性 | 任一次量測未達終點（見下）→ **該區塊整個作廢並重跑**，原始數據與原因照樣記錄。不得只剔除失敗樣本 |
| 記錄 | 全部原始值、每區塊配對改善值、全距；不得事後剔除 |

**終點定義**（由量測腳本注入的同一段觀察碼判定，新舊共用，**不依賴 app 內的 mark**）：

- **詳情可互動**：`#detail` 內摘要區與歷史表可見（非 `hidden`、有非零尺寸）→ 讀 `offsetHeight` 強制 layout → 記下歷史表首列的生效日文字 →
  對「排序」按鈕派送 click → 等兩個 animation frame → 歷史表首列的生效日文字**變為預期的另一端日期**（預期值由該代號 shard 的 `records` 事先算出）。此刻收秒表。
- **可搜尋**：在搜尋框輸入固定查詢（該代號本身），結果清單的首筆代號等於該代號。此刻收秒表。

起點皆為 `navigationStart`。

### 7.1 M0：先量變異（**修改 `app.js`／`engine.js`／`sw.js` 之前**）

以 legacy 對 legacy（兩個 port、同一份檔案）照上表跑 5 個區塊：

- **V** ＝ `?code=` 入口「詳情可互動」的 15 個配對差值的**最大絕對值**。
- **V_home** ＝ 首頁入口「可搜尋」的配對差值最大絕對值（首頁入口不分代號，5 個區塊得 5 個差值；查詢用固定代號）。
- 成立條件：**V ≤ 400 ms**（門檻 2,000 ms ≥ 5V）。
- V > 400 ms → **停下回報使用者重訂門檻**。不得自行調整門檻、區塊數或量測條件。

量測腳本屬測試工具，可在 M0 階段先寫。

### 7.2 S1 的判定規則（預先凍結）

| 結果 | 處置 |
|---|---|
| 15 個配對改善值**全部** ≥ 2,000 ms | 通過 |
| 任一代號的 5 個配對改善值，其 median < 2,000 ms | **停工回報** |
| 各代號 median 皆 ≥ 2,000 ms，但有個別區塊 < 2,000 ms | 「證據不足」：**補測一次**同規模 5 個區塊。合計 10 個區塊中，每個代號至多 1 個區塊 < 2,000 ms 才算通過；否則停工回報 |

不調門檻、不換條件、不再補第三次。

---

## 8. 驗收條件

每條列出「會讓它假通過的弱化實作」及堵法（第一輪覆審 3.1–3.18）。「請求數」一律指測試端攔截到的網路請求計數。

| # | 條件（可證偽的斷言） | 已堵的弱化版本 |
|---|---|---|
| **S1** | §7 量測、§7.2 判定規則下，`?code=`「導覽開始 → 詳情可互動」通過；前提 M0 的 V ≤ 400 ms | 終點停在 DOM 寫入；只改 `aria-pressed` 不排序；失敗樣本被剔除；只挑小片；門檻落在變異內 |
| **S2** | 首頁入口「導覽開始 → 可搜尋」：5 個配對差值（candidate − legacy）的 median ≤ `V_home` | 提早啟用搜尋框或提早打 mark（終點是真實查詢結果）；借用詳情指標的 V |
| **S3** | `?code=` 入口的「可搜尋」劣化（同三碼、逐碼、5 區塊配對差值的 median）記錄於驗收文件；任一代號 > 1,500 ms → 停下回報。量法：詳情可互動後**被動等待** `search-ready` mark（不導覽，以免觸發 T2），mark 出現後才切到搜尋頁輸入固定查詢，**300 ms 內**須得到預期首筆，否則該次無效（mark 過早） | 只量最小片；mark 提早；量測本身觸發提前啟動 |
| **S4** | **請求順序**（`?code=` 入口）：(a) 扣住 `meta` 回應期間，shard 與 index 請求數皆為 0；(b) `meta` 放行、shard 以「headers 已送、body 未完」停住期間，index 請求數為 0；(c) shard body 完成後 index 請求數為 1；(d) shard 回 500 → index 請求數為 1（失敗也算落定）；(e) shard 內容驗證失敗（版本不符）→ index 請求數為 1 | 「同時發但先畫詳情」；固定延遲後啟動；headers 到就啟動 |
| **S5** | **可達狀態**：§5.2 的 M1–M13 各一支 e2e，以攔截器把資源固定在該狀態（`loading` 用永不回應），斷言：顯示文案、搜尋框可否操作、結果節點有無、請求數。M1、M2、M4 的頁面文字不得含「查無」。**不可達組合**：`meta` 回 500 而 index 回 200（首頁入口）→ `state` 對外可觀察結果為 M3（無結果節點、搜尋不可用、無 index 品名） | 一支測試只替「任意」挑一個值；只驗初始畫面 |
| **S5b** | **轉移**：(a) 詳情顯示中、index loading 時 `popstate` 回搜尋 → M4，index 到後 → M5；(b) `meta` error → `retry-core` 成功 → 原視圖正常載入且 index 依 D2 啟動；(c) index error → 導覽到另一代號 → 新詳情正常、橫幅仍在；(d) 詳情 A 在途時導覽到 B → 畫面只出現 B，A 的回應抵達後畫面與 `document.title` 仍為 B | 轉移後卡住或殘留前一品項 |
| **S6** | **詳情與 index 無關，且內容正確**：對 §8.1 每個代號，先以 golden fixture 的**獨立預期值**核對現行價（或狀態標籤）、最新事件生效日、歷史表筆數、H2 品名、`document.title`；再比對「index 永不回應（斷言其請求仍 pending）」與「index 已發布」兩種情況下 `#detail` 的 `innerHTML` 逐字相同。`status.json` 固定為同一回應、同一 `today`、同一視窗寬度 | 兩邊都顯示相同的錯誤內容或空殼；`title` 不在 `#detail` 內而漏驗；兩邊其實都等到 index |
| **S7** | **index 晚到失敗不撤、不重畫**：詳情顯示且 `status` 已落定後，先把排序切到非預設方向，並對 `#detail` 掛 `MutationObserver`（subtree、childList、attributes、characterData）。index 分別回 (a) HTTP 500 (b) 非 JSON (c) `dataVersion` 不符 (d) body 逾時：**mutation 記錄數為 0**；事前保存的摘要標題節點與表格首列節點仍在文件中（`isConnected`）；排序方向不變；shard 請求數仍為 1；橫幅**可見**且文案為 §5.5 對應句；按橫幅按鈕的行為正確（a、b、d 為重試、c 為重新整理） | 保留根節點但重設 `innerHTML` 為相同內容；shard 命中快取掩蓋重畫 |
| **S8** | **查無從嚴**：D4.1 十列逐列測。指名反例（文字不得含「查無」）：`meta` 永不回應＋合法代號；`meta` 500；shard 500；shard 非 JSON；shard body 逾時；shard 外層 `drugs` 非物件；版本不符；條目為 `null`；`records` 非陣列；缺 `invalidRecords`；`meta` 非物件且無 `metaVariants`；shard map 不合法四種（`files` 為空、成員非字串、`files` 有而 `versions` 無、`versions` 有而 `files` 無）。正例：空碼與含非法字元 → 查無且 shard 請求數 0（**含 `meta` 永不回應時**）；前綴不在清單 → 查無且 shard 請求數 0；**合法英數但非 10 碼、存在於 shard 的合成代號 → 完整詳情**。實際 `data/meta.json` 通過 §5.7 | 只特判 `records`；用長度短路；`meta` 未到時把合法代號顯示成查無 |
| **S9** | **資料矛盾與到達順序無關**（D4.3）：(a) shard 缺 key、index 之後發布且含該代號 → 由查無改為「分片中缺少此代號」；(b) index 先發布、之後 shard 缺 key → **直接**顯示該錯誤，過程中不得出現查無；(c) index 發布且不含該代號 → 維持查無；(d) A 查無後導覽到 B，index 才發布且含 A → B 的畫面與標題不變；(e) index 為 mismatch 且其內容含該代號 → 維持查無；(f) 比較頁：兩個代號，一個 key 不存在且 index 含之 → 該代號為錯誤、另一代號的序列與表格不變；一個條目結構壞 → 「分片內容不合法」 | 只測 (c)；更正套到已離開的品項；用未驗證的 index 當證據 |
| **S10** | **啟動觸發**：(a) T1：shard 落定前 index 請求數 0、落定後 1；(b) T2 各入口分測——`popstate`、點「回搜尋頁」、點「前往預告中心」、比較籃增刪——shard 未落定時觸發後 index 請求數立即為 1；(c) T2 之後 shard 才落定 → index 請求數仍為 1；(d) 零請求的首個視圖（語法無效代號、前綴不在清單、`?codes=` 零個有效代號）→ `meta` ready 後 index 請求數為 1 | 只測 T1；重複啟動；零請求時永不啟動 |
| **S11** | **只重試 index**：`meta` ready、index error 時按重試 → `meta.json` 請求數不增加、shard 請求數不增加、`#detail` 零 mutation、index 請求數 +1。接著分三支：重試成功 → 切到搜尋頁以固定查詢得到預期首筆、橫幅消失；重試再失敗 → 橫幅仍在、可再按；重試得到版本不符 → mismatch 橫幅、搜尋不可用。重試在途時導覽到另一代號 → 重試結果抵達後視圖仍為該代號 | 請求數增加但結果被丟棄；未比版本就開放搜尋；把使用者拉回原視圖 |
| **S12** | **未驗版本的 index 不外洩**：首頁入口 `meta` 500、index 200 → 無結果節點、無可進入詳情的連結、對搜尋框輸入不產生結果、比較籃 chip 無品名。之後 `retry-core`（`meta` 改回 200、index 版本相符）→ 搜尋以固定查詢得到預期首筆；另一支（index 版本不符）→ mismatch、搜尋不可用 | 搜尋框 disabled 但結果已渲染；重試後永久停用 |
| **S13** | **比較頁與預告中心 deep link**（index 永不回應）：`?codes=` 兩個有效代號 → 圖表序列數為 2、摘要對照表兩欄的代號與現行價等於 golden 預期值；`?view=upcoming` → 列數等於 golden 預期值。各自的主要資源失敗（shard 500、`upcoming.json` 版本不符）→ 顯示該視圖現有的錯誤文案。index 之後發布：比較主體與預告主體**零 mutation**，比較籃 chip 的品名等於 golden 預期值 | 只畫空容器；chip 顯示任意非空字串；發布時重畫主體 |
| **S14** | **建置守門**：經正式發布入口 `run()`，對**預先存在且有內容**的 `data/` 目錄注入四種產出——index 多一碼、shard 多一碼、某碼放在非最長前綴所選的片、某碼重複於兩片——各自以非零狀態結束，且執行前後 `data/` 下**所有檔案的檔名與位元組完全相同**（含 `status.json`）；`allow_anomaly=True` 時仍失敗。實際 `data/` 通過 | 只測函式回傳值；空目錄「沒寫檔」；被 `allow_anomaly` 放行 |
| **S15** | **不回歸與真實資料**：pytest、`npm test`、`npm run e2e` 全綠。`e2e/real-data.spec.mjs` 新增一支：以真實 `data/`、走 `/NHI-drug-price-history/` 子路徑、`?code=` 一個指定代號，**扣住 index**，斷言詳情的現行價與歷史表筆數等於由該 shard 獨立算出的預期值；之後放行 index，斷言搜尋以該代號查得到 | smoke 等到 index 到齊才檢查；只驗「有畫面」 |
| **S16** | **SW**：`sw.js` 的 `CACHE` 值與基準不同、`PREFIX` 不變、`SHELL` 清單不變、`data/` 旁路判斷式不變（node 測試讀檔比對基準 commit）。人工：已安裝舊版的裝置開站後取得新版外殼（§8.2） | 只看版本字串 |
| **S17** | **回頭客量測（只記錄）**：部署後對**線上 GitHub Pages**，同一 browser context 先載入一次、等待 index 發布、再重新導覽；首頁與 `?code=` 各做。經 CDP 記錄每個資料檔的網路層狀態碼、實際傳輸位元組、解碼後大小，以及兩個終點耗時。寫入驗收文件，不設門檻 | 對固定回 200 的本機 gzip 伺服器量 |

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
- **`selectMeta` 回 `null`（尚無已生效紀錄）**——標題退回值的反例
- **描述欄位不一致（`metaVariants`）**——`selectMeta` 依日期選用的反例（真實資料母體為 0，須合成）
- 紀錄數最多的代號（現況 24 筆）
- **合法英數但非 10 碼的合成代號**——長度短路的反例

### 8.2 人工項目

- 藥師目檢：從 `TFDA-drug-info-search` 的「查看健保藥價歷史」連結進站，挑 ≥ 5 個熟悉的代號（含 ≥ 1 個已終止、≥ 1 個有預告），
  與線上現行版逐項核對現行價、調價次數、最新事件標籤、歷史表筆數。
- 手機實機走一次 deep link；該裝置先前已安裝或開過舊版，確認取得新版（S16）。

---

## 9. 實作順序（建議 commit 切分）

1. `scripts/measure_startup.mjs` ＋ M0（§7.1）。**V 不合格即停。**
2. `engine.js`：`validateShard` reason 拆分、`validateMeta` 強化（§5.7）、`validateIndex` 必須有 `meta`；`node --test`。
3. 建置守門（§5.6、S14）。
4. e2e 測試先行：S4–S13 的攔截工具與測試（預期紅）。
5. `app.js` 狀態機（I1、I2、D1–D6、§5）。
6. `sw.js` 升版；real-data smoke；全套測試。
7. S1–S3 量測；驗收文件 `.ai-review/startup-acceptance.md`，每條 ✅ 指到測試名稱與其斷言的字句。
8. `/codex-review`（含區塊 4 規格符合度與驗收證據稽核）。
9. 藥師目檢 → 合併部署 → S17 線上量測補入驗收文件。

---

## 10. 第二期：拆 index（**不在本規格範圍，另開規格**）

承諾事項（已與使用者確認）：

- 先做量測原型，**原型的驗證強度必須與正式實作一致**（前案 v0.3 停工的原因）。
- 門檻在第一期完成後，依新的 baseline 與變異另訂，並先問使用者。
- 原型達不到門檻即停，不合併、不調門檻。
- 會動 `spec.md` §7 契約，屆時獨立跑 `/codex-checkplan`。

---

## 11. 已知限制、假設與後續

- **假設 H1**：輪間變異 V ≤ 400 ms。前案 2026-10-13 觀察約 300 ms（不同指標）。由 M0 驗證。
- **假設 H2**：改善幅度約 4 秒。推論依據：legacy 路徑含 3.3 MB index 下載（9 Mbps 約 2.9 秒）與 30 MB raw 的 parse／prepare；candidate 只含 31 KB ＋ ≤ 0.14 MB。**未實測**，由 S1 驗證。
- **限制 L1**：`?code=` 入口的「可搜尋」時間會變慢（index 晚啟動約等於 `meta` ＋ shard 的時間）。S3 記錄並設上限。
- **限制 L2**：index mismatch 時，主體顯示的是與 `meta` 自洽的一批資料，但無法得知它比 index 新或舊；橫幅要求重新整理。
- **限制 L3**：`meta` 與 shard 串行兩次往返（N6）；高延遲網路下是固定成本。
- **限制 L4**：`status.json`（最後檢查時間、過期警示）與 `meta` 沒有版本連動，不在 D3 的同批保證內。現況即如此，本案不改。
- **限制 L5**：I1 之下，`meta` ready 後若線上資料換批，使用者要重新整理才會拿到新批（shard 版本不符時畫面會提示）。現況亦同。
- **後續（本次不做）**：SW 外殼更新流程的自動化 e2e（第一輪覆審 3.16；Playwright 設定全域封鎖 SW，需另建測試基礎設施）。

---

## 12. 修訂紀錄

- **v0.2（2026-11-14）**：依 `.ai-review/plan-verdict-startup.md`（第一輪，接受 24／部分接受 5／拒絕 0）。
  - 新增不變量 **I1**（`meta` ready 後不重抓）、**I2**（index 驗版後才發布）——判定 1.1、1.2、2.1、4.1
  - D2：刪除 3,000 ms 計時器與「focus 搜尋框」觸發；改為 T1（首個視圖載入工作落定）／T2（任何後續導覽）；`meta` ready 前不啟動 index——1.1、1.3、1.4、3.10
  - D3：論證改寫為 index 衍生內容的來源限制；明列同批保證範圍不含 `status.json`；mismatch 文案不斷言方向——2.1、2.2
  - D4：加判定順序（D4.1）、區分輸入無效與資料不存在、資料矛盾與到達順序無關（D4.3）——1.5、2.4
  - §5.2：改為可達狀態組合 M1–M13 與不可達理由——3.5
  - §5.3：四類寫入目標的有效範圍；詳情與比較共用 shard loader——1.2
  - §5.6：守門由「聯集相等」改為「每碼恰在最長前綴所選的那一片」，不可豁免——2.3
  - §5.7：新增 shard map 合法性——1.6
  - §7：5 區塊平衡順序、配對改善值、樣本作廢規則、終點含實際排序結果、預先凍結的證據不足處置——3.1、3.18
  - §8：S1–S17 全部依 3.1–3.17 改寫；新增 S5b
  - §11：新增 L4、L5 與後續項
- v0.1（2026-11-14）：初稿。對需求摘要的兩處修正——(1) 代號格式短路不檢查長度；(2) 詳情摘要本來就只由 shard 推導，「全量逐筆比對」改為 S6。
