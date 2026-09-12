# 獨立覆審請求：NHI-drug-price-history Phase 2 前端

**唯讀模式：禁止寫入或修改任何檔案，只輸出報告文字。**

審查範圍：`git diff 29f146c..30a955e`（兩個 commit：`2c4f496` index window 加 `pricedBefore`；`30a955e` Phase 2 前端）。
重點檔案：`engine.js`、`app.js`、`index.html`、`styles.css`、`sw.js`、`lib/history.py`（`priced_before`／`window_json`）、`tests-js/*.test.mjs`、`e2e/*.mjs`、`playwright.config.mjs`、`.github/workflows/test.yml`、`scripts/export_golden_frontend.py`、`scripts/measure_e7.mjs`。
規格：`spec.md`（資料模型與規則）、`.ai-review/plan.md` v2.2（驗收條件 §5，以此為準）、`.ai-review/phase2-acceptance.md`（E7 量測與 C2 截圖紀錄）。

## 專案前提（請先讀，評分須依此）

### (a) 架構限制與刻意取捨

- **零建置靜態站**，部署於 GitHub Pages（main 根目錄、專案子路徑 `/NHI-drug-price-history/`）。無 bundler、無框架、無 npm runtime 依賴；`package.json` 只為測試（`@playwright/test`）。建議「導入 React／bundler／TypeScript」等同重寫，不是有效發現；請改提在原生 ES module 下可做的替代。
- **不引入外部 JS 函式庫**（臨床工具群 house style），圖表手刻 SVG（plan D12，2026-09-12 由使用者選定，取代原 Chart.js）。Google Fonts（Noto Sans TC）是刻意允許的唯一外部資源；**不做 dark mode** 是設計決策。
- **前端刻意重算摘要**：spec §5.5／plan D5 規定詳細頁「一律由完整 history 以瀏覽器本地日期推導」，所以 `engine.js summaryAt()` 與 `lib/history.py summary_at()` 是**規格明列的雙語實作**，以 `tests-js/golden.test.mjs` 對同一份凍結快照交叉比對防漂移。這組重複不算缺陷；但若你發現**兩端規則實際不一致**（任何輸入下結果不同），那是正確性問題，請列出。
- index（`data/drug_index.json`，raw ~30 MB／gzip ~3.3 MB）單檔全量載入是 D4 決策；history 依前 4 碼分 348 片、選定後才載入。
- DOM 以 template string＋`innerHTML` 產生，所有來源字串經 `esc()`；外部連結只接受 http(s)。
- Service worker 只快取網站外殼（network-first），`data/` 刻意不經 SW（避免繞過 dataVersion 與過期警示）。
- **高密度斷言與變異測試**：本專案的失效模式是假綠燈（斷言錨錯位置、測試只驗最終狀態漏掉中間態），不是測試過多。「測試可精簡」「移除重複測試」不是有效發現。

### (b) 威脅模型與風險權重

- 無認證、無 session、無機密、無病患資料；資料是政府開放資料（健保署支付價），站台公開。
- 使用者是臨床藥師，查詢型工具。**最大風險是誤導**：把已終止品項顯示為有價、把暫停／終止畫成 0 元連續價格、把預告當現行、搜尋卡顯示過期的確定價格、資料過期卻無警示、混批資料（index／shard／meta 版本不一）組合出錯誤摘要、競態使 A 藥的價格出現在 B 藥頁面、首列 0 元被標成「終止」。
- XSS：資料來自健保署 CSV，經 ETL（TLS 驗證）產生後由本 repo commit；渲染端 XSS 竊取不到憑證，嚴重度低於「顯示錯誤價格」。資料入口（ETL 下載、Actions 權限）已於 Phase 1 審過，本次不重審。
- 請以「藥師看到錯誤或誤導資訊的機率與後果」為嚴重度主軸。

**若某項建議與上述架構限制衝突，須明說衝突並改提相容的替代作法。**

## 請輸出以下區塊

每項發現須含：**檔案:行號 / 嚴重度（Critical|High|Medium|Low）/ 問題描述 / 建議修法**。

### 1. Code review

邏輯錯誤、日期／時區邊界、競態、例外處理不足、可維護性。特別檢查：

- `engine.js` 的 `searchCard()`、`summaryAt()`、`selectMeta()`、`chartModel()`、`staleness()`、`decimalChange()` 在邊界輸入（衝突、重疊、空窗、無迄日、只有未來列、只有 invalidRecords、起日 9991231 哨兵、0 與負數百分比）是否會產生誤導文字或價格。
- `app.js` 的 `showDetail()` 競態序號、`loadCore()` 重試、`route()`／`popstate`、快取（`shardCache`）與版本比對、resize 重繪是否有狀態殘留或誤顯示他代號內容的路徑。
- 標籤文字是否違反 spec §5.3 首列 0 元例外（此前從未有價者不得出現「終止」字樣），含搜尋卡、摘要卡、預告標籤、歷史表、圖表 tooltip。

**重複實作**另列：同一規則／表格／轉換邏輯在兩處以上各寫一遍（或既有函式已有該能力卻另寫），須引用兩端 file:line 並說明漂移時的錯誤結果。範圍排除：測試檔、驗證器、規格明列的雙語實作（見前提 a）。例：`app.js` 內自行計算 prior／pricedBefore 的迴圈與 `engine.pricedBefore()` 是否等價。

### 2. Test gap analysis

現有測試（`tests-js/`、`e2e/`、`tests/test_golden_frontend.py`、`tests/test_history.py` 的 pricedBefore 案例）未涵蓋的正常流程、邊界值、失敗情境；特別指出「測試只驗最終狀態、漏掉中間態」或「斷言錨在不會變的東西上」的弱點。

### 3. Dependency audit

`package.json`／`package-lock.json`、workflow 中 actions（是否 pin SHA）、Google Fonts 外部資源、SW 快取策略。

### 4. 規格符合度稽核

讀 `.ai-review/plan.md` 的驗收條件（C1–C8、E1–E7）與架構決策（D5、D9、D10、D12、D13），以及 `spec.md` §5.1（window 與搜尋卡判定，含新增 `pricedBefore`）、§5.3、§5.5、§6.6、§8.1–§8.7，逐條指出**規格宣稱有、但實作實際沒做到或做弱了**的項目。特別注意三種形態：

- **驗證只驗了較弱的性質** —— 規格說「驗證 A 與 B 一一對應」，實作只檢查 A 的格式
- **宣稱的欄位從未產生** —— 前端讀某欄位，但管線從不寫入，功能靜默不存在
- **宣稱的失敗處理未實際觸發** —— 錯誤分支存在但條件永遠不成立，或訊息與實際行為不符

這不是找新需求，是查核既有承諾。每項須引用「規格條款編號 + 實作檔案:行號」兩端。
