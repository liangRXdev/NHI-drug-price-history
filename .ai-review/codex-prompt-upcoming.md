你是獨立覆審員。**唯讀模式：禁止寫入或修改任何檔案，只輸出報告文字。**

審查對象：本 repo（`NHI-drug-price-history`）於 commit `f9c0b9d..d83a70d`（PR #4）新增的
「預告中心」功能，以及它對既有發布管線的改動。重點檔案：

- `lib/history.py`：`build_upcoming()`／`sort_upcoming()`／`validate_upcoming()`（檔案後段新增）
- `build_price_history.py`：`build_outputs()`／`upcoming_payload()`／`check_guards()`／`publish()`／`run()`
- `.github/workflows/build-data.yml`：commit 步驟的「有無差異」判定
- `engine.js`：`validateUpcoming()`／`upcomingDecision()`／`upcomingParams()`／`upcomingModel()`／`upcomingCSV()`
- `app.js`：預告中心狀態機（`loadUpcoming()`／`renderUpcoming()`／`exportUpcomingCSV()`）與路由
- `index.html`／`styles.css`：預告中心版面與控制項
- 測試：`tests/test_upcoming.py`、`tests/test_build.py`、`tests-js/upcoming.test.mjs`、
  `e2e/upcoming.spec.mjs`、`e2e/upcoming-filters.spec.mjs`

---

# 專案前提（必讀；違反這些前提的建議一律無效）

## (a) 架構限制與刻意取捨

1. **前端是零建置的靜態站**：`index.html` + `app.js` + `engine.js` + `styles.css`，原生 ES module，
   無 bundler、無 npm runtime 依賴、無框架。部署在 GitHub Pages 專案頁（子路徑）。
   「拆模組／加 TypeScript／導入 React／注入 content hash／加 build step」等同要求導入整套工具鏈，
   **不是可接受的建議**。若某個問題只能用建置工具解，請改提在零建置前提下可行的替代作法。
2. **`engine.js` 是純邏輯層（無 DOM、無 I/O）**，同時給瀏覽器與 `node --test` 用；
   `app.js` 負責 DOM 與資源載入。跨層搬移函式請先確認不會把 DOM 依賴帶進 `engine.js`。
3. **Python 端與 JS 端刻意各實作一次同一規則**（`lib/history.py` 的 `validate_upcoming` 對
   `engine.js` 的 `validateUpcoming`；`summary_at` 對 `summaryAt`）。這是**跨語言縱深防禦**，
   由 golden fixture 交叉比對，不是「重複實作」缺陷。要求合併成單一實作者視為誤判。
4. **全有全無的發布契約**（`plan.md` B1–B3、B8）：任一 guard 失敗 → `exit 1`，
   `data/` 與 `status.json` 一個位元組都不寫。**不得引入部分發布**（例如「upcoming 失敗但其餘照常發布」）。
5. **`data/` 完全不經 Service Worker**（`sw.js` 的 `if (url.pathname.includes('/data/')) return;`）。
   這是刻意的：藥價資料若來自 SW 快取會繞過 `dataVersion` 驗證與過期警示。
   建議把 `upcoming.json` 加入離線快取者視為誤判。
6. **`dataVersion` 只依來源內容**（shard hash 的 hash），不依 build 日。因此規則變更但來源不變時
   `dataVersion` 相同，這正是新增 `generatorVersion` 字串欄位的理由（`spec-upcoming.md` §3.3.2）。
   範圍刻意限制在一個字串欄位：不動 `dataVersion`、不動 history shard、不引入 SW、不另建產物辨識體系。
7. **高密度斷言與變異測試是本專案的既有紀律**。本專案的失效模式是**假綠燈**
   （斷言錨錯位置、sentinel 讓變異假死、凍結 fixture 母體縮成剛好等於子集），不是測試過多。
   「測試可精簡」「移除重複測試案例」「合併參數化案例」**不是有效發現**。
8. **CJK 顯示字串是規格逐字定義的**（`spec-upcoming.md` §4.1 決策表的 14 條標籤與副標）。
   建議改寫文案、統一用語、引入 i18n 框架者，除非能指出與規格牴觸，否則視為誤判。
9. 前端不得新增任何 runtime 依賴；`package.json` 只有 `@playwright/test` 一個 devDependency，
   Python 只有 `requests`（測試另有 `pytest`、`openpyxl`）。

## (b) 威脅模型與風險權重

- **無認證、無 session、無 cookie、無使用者資料、無後端**。純靜態公開查詢站，
  任何人都能直接取得同一份 `data/`。因此「XSS 竊取憑證」在本站**沒有可竊之物**，
  嚴重度不得比照有登入的應用。
- **本站最怕的是「顯示錯誤的健保支付價」**：使用者是臨床藥師與醫療人員，
  金額、終止／暫停狀態、生效日若錯誤或誤導，會直接影響用藥與採購判斷。
- 風險排序（高 → 低）：
  1. **污染資料的「入口」**：下載未驗 TLS、guard 被繞過、部分發布、
     把錯誤資料當成正常資料發布、把 0 元說成「價格不變」、把「此前無有價紀錄」說成「終止支付」
  2. **靜默失敗**：錯誤被吞掉而畫面看起來正常（例如壞列被跳過、清單看似完整其實缺項、
     版本不一致卻照常渲染、失敗後保留無法驗證新鮮度的舊資料）
  3. **決定性破壞**：相同輸入產生不同輸出，導致每次 build 都有假 diff、或 diff 遮蔽真正的變動
  4. 可用性與效能問題
  5. 渲染層 XSS（仍須修，但嚴重度為 Medium 以下；資料來源是健保署 CSV，
     且 `app.js` 已一律用 `esc()` 轉義）
- **兩個日期不可互相代替**：`upcoming.buildDate`（資料產生日 D）與 `status.lastCheckedAt`
  （最後檢查日）語意不同且可相差數週，混用會讓使用者誤以為資料是新的。

若你的某項建議與上述任一前提衝突，**請明說衝突點並改提相容的替代作法**，不要直接建議違反前提。

---

# 要求產出的區塊

每一項發現都必須含：**檔案:行號 / 嚴重度(Critical|High|Medium|Low) / 問題描述 / 建議修法**。

## 1. Code review

邏輯錯誤、安全風險、例外處理不足、可維護性問題。特別請查：

- `build_upcoming()` 的欄位取用是否與 `spec-upcoming.md` §3.1 表格一致
  （描述欄位以 build 日選列、`pricedBefore` 與 `previousPrice` 的語意分野、`everPriced` 為衍生值）
- `sort_upcoming()` 的第四排序鍵（原 records 索引）是否真的由 stable sort 保證，
  呼叫端 `build_outputs()` 的附加順序是否滿足該前提
- `run()` 中 `changed`／`migration`／`publish()` 的組合是否真的實現
  「`upcoming.json` 與 `drug_index.json` 完全同進退」＋「首次交付與版本遷移強制進入有差異批次」，
  以及失敗時是否真的一個位元組都不寫
- `build-data.yml` 的差異判定路徑清單改動，是否會讓某些情形下產物進不了 commit（功能上線即空）
- `engine.js` 的 `validateUpcoming()` 與 `lib/history.py` 的 `validate_upcoming()` 是否**等價**
  （兩端規則不一致會造成「Python 發得出去、前端拒絕渲染」的鎖死）
- `upcomingDecision()` 的 14 條是否互斥且窮盡，有無某組合落不進任何一條而靜默顯示成確定事件
- `app.js` 的 `loadUpcoming()` 狀態機：`upcomingInflight`／`upcomingSeq` 的競態處理、
  首次載入失敗與更新失敗的分流、保留舊快照時是否可能配上新的狀態或新的日期

**重複實作**請單獨列出：同一份規則／表格／轉換邏輯是否在兩處以上各寫一遍，
或既有函式已提供該能力卻另起爐灶。每項須同時引用**兩端的 file:line**，
並說明兩者漂移時會產生什麼錯誤結果。
**範圍排除**：測試檔、驗證器（validator）、規格明列的行為、以及前提 (a)3 的跨語言雙實作——
這幾類的重複是刻意的縱深防禦。

## 2. Test gap analysis

現有測試覆蓋現況，指出未涵蓋的正常流程、邊界值、失敗情境。
請特別找**假綠燈**：斷言錨錯位置（掃整個檔案找字串，證明的只是「檔案裡有這字串」）、
預期值由待驗生成器自己產生、凍結 fixture 的母體剛好等於被斷言的子集、
參數化案例看似很多但每個都走同一條分支。

## 3. Dependency audit

過期、已知漏洞、不必要、授權有疑慮的依賴（`pyproject.toml`／`uv.lock`／`package.json`／
`.github/workflows/*.yml` 的 action pin）。

## 4. 規格符合度稽核（**本區塊最重要**）

本功能的規格是 `spec-upcoming.md`（v0.3.1），上位文件是 `spec.md` 與 `.ai-review/plan.md`。
請讀 `spec-upcoming.md` 的 §2–§8 與 §9 驗收條件（U1–U15），逐條指出
**規格宣稱有、但實作實際沒做到或做弱了**的項目。特別注意這三種形態：

- **驗證只驗了較弱的性質** —— 規格說「A 與 B 一一對應」，實作只檢查 A 的格式
- **宣稱的欄位從未產生** —— 前端有 `if (x)`，但管線從不寫入 `x`，功能靜默不存在
- **宣稱的失敗處理未實際觸發** —— 錯誤分支存在但條件永遠不成立，或訊息與實際行為不符

另請一併查核 `.ai-review/upcoming-acceptance.md` 宣稱「✅」的每一條，
其列出的證據（測試檔／測試名）是否真的驗到了該條所宣稱的性質。

這不是找新需求，是查核既有承諾。每項須引用「規格條款編號 + 實作檔案:行號」兩端。

---

再次提醒：**唯讀，禁止修改任何檔案，只輸出報告文字。**
