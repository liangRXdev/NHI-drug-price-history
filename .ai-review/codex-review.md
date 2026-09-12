# Codex 獨立覆審原始輸出

- 審查日期：2026-09-12
- Codex：codex-cli 0.153.4（codex plugin 1.0.6 背景 task，read-only）
- 範圍：29f146c..30a955e（2c4f496 pricedBefore、30a955e Phase 2 前端）
- commit：30a955e
- Prompt：.ai-review/codex-prompt.md

---

**結論：此範圍有應修正的正確性問題，不能僅憑現有測試綠燈判定 Phase 2 完成。**最重要的是：正式 `data/` 尚未包含 `pricedBefore`，以及重疊區間跨生效日時，搜尋卡可能仍顯示確定價格。

本次以 `29f146c..30a955e` 為準，全程未修改檔案。已執行 **87 項 Node 測試，全數通過**，並以實際資料與合成輸入重現下列問題。Python 執行器因權限限制無法啟動；未執行會產生測試產物的 Playwright、截圖與效能腳本。覆審期间工作樹的驗收紀錄另有修改，不納入指定 commit 的判定。

**1. Code review**

**R1｜High｜正式資料缺少新增欄位，搜尋卡已出現錯誤標籤**

- **位置：**`engine.js:308`、`engine.js:192`、`engine.js:399`；產生端 `lib/history.py:350`、`lib/history.py:385`；發布資料 `data/drug_index.json:1`。
- **問題：**新程式直接使用 `r.pricedBefore`，但指定 commit 的正式 index 中，**45,179 個代號的 window 都缺少此欄位**。`validateIndex()` 仍判定成功。缺值是 `undefined`，不會命中 `prior === null` 的首列 0 元例外。
- **實際重現：**
  - `AC48845100` →「已終止支付（終止前 — 元）」。
  - `BC23981100` →「暫停支付（來源標示 -），暫停前 — 元」。
  - 從未有價的 `A025546100` →「已終止支付（終止前 — 元）」，直接違反首列 0 元語意。
- **建議修法：**前端發布前同步重新產生正式 index；驗證每筆 window 的 `pricedBefore` 存在且為 null 或正數。缺欄位應顯示「需更新」，不能直接視為 null，否則又會把真正終止品項誤標為從未有價。新增欄位相容性不能只靠目前的內容版本字串判定。

**R2｜High｜跨生效日出現重疊時，搜尋卡仍報單一確定價格**

- **位置：**`engine.js:295`、`engine.js:301`；配合 `lib/history.py:209`、`lib/history.py:215`。
- **問題：**`searchCard()` 使用第一個有效 window row，僅檢查該列的 `conflict`。build 時只有一筆現行列，但預告生效後與其重疊，搜尋卡不會重新辨識衝突。
- **已重現：**window 為「2020 起無迄日、10 元」＋「2026-10-01 起無迄日、0 元」。10 月 1 日搜尋卡顯示 **10 元**，詳細頁卻正確顯示「來源紀錄衝突，無法判定單一支付價」。
- **建議修法：**先計算 T 當日全部有效 window rows；多筆即停止顯示單一價格。管線也須處理最早預告有多筆候選、但 window 只保留一筆的情況，提供足夠的衝突資訊，或保守要求開啟詳細頁。

**R3｜Medium｜首列 0 元例外未覆蓋圖例、事件標籤與通用聲明**

- **位置：**`engine.js:483`、`engine.js:258`；`app.js:460`、`app.js:516`、`app.js:537`、`app.js:560`；`index.html:52`。
- **問題：**
  - 所有 `terminated` 都畫成同一種斜線區塊，圖例統一稱「終止支付」。已查看 `A020296321_mobile.png`：首段此前無有價的 0 元區間確實套用此圖例。
  - 合法序列「暫停 → 0 元，之前從未有價」會產生 `terminated` 事件；最新調整及歷史表事件欄仍出現「終止支付」。
  - 通用聲明無條件寫「支付價 0 元視為終止支付」，與例外標籤互相矛盾。
- **建議修法：**將「此前無有價的 0 元」納入圖表呈現與事件文字的共同分類，給予獨立圖例；最新事件與表格狀態同步套用。聲明補上例外。`spec §5.5` 的 null previousPrice 終止文案也應同步修正，避免與 §5.3 衝突。

**R4｜Medium｜同起日的 metadata 變體無法對應選定紀錄**

- **位置：**`engine.js:146`、`engine.js:159`；對照 `lib/history.py:219`、`lib/history.py:245`。
- **問題：**先選有效 record，再以 `variant.from <= row.from` 取最後變體。若兩列同起日、不同描述，Python 選第一筆有效列的描述，JS 卻選同日起日的最後變體。
- **已重現：**兩列皆起於 2020-01-01，第一列 metadata A、第二列 B；2020-06-01 選定第一列，但 `selectMeta()` 回傳 B。品名、成分及來源連結都可能取錯。
- **建議修法：**變體增加穩定的 record 對應鍵或索引，按已選定的 record 取得描述；只用 `from` 無法滿足一一對應。補同起日、不同迄日及不同描述案例。

**R5｜Medium｜JS 與 Python 接受的金額表示法不同，總變化靜默消失**

- **位置：**`engine.js:45`、`engine.js:75`、`engine.js:114`、`engine.js:279`；對照 `lib/nhi.py:238`、`lib/history.py:157`。
- **問題：**Python 使用 `Decimal()`，可接受 `1e1`、`.5`、`10.`；JS 正規式不接受。這些值若由管線形成 `priced`，前端現價仍可顯示，但總變化的差額與百分比會消失。
- **已重現：**JS 對 `1e1 → 2e1` 只顯示「1e1 → 2e1 元」，沒有應有的差額與百分比。Python 端結論來自程式檢查，本次未成功啟動 Python 動態交叉驗證。
- **另有邊界：**`decimalChange('10','0')` 回傳 −100%，沒有落實「兩者皆正數」；目前正常摘要會先篩選 priced，因此這部分屬函式契約缺口。
- **建議修法：**統一可接受的十進位語法，保留 `rawPrice`；計算失敗須明示異常，不可靜默省略。函式檢查新舊值皆大於 0。

**R6｜Medium｜核心重試可重入，較舊請求會覆蓋較新結果**

- **位置：**`app.js:49`、`app.js:53`、`app.js:57`、`app.js:80`、`app.js:612`。
- **問題：**重試開始只更新搜尋框與詳細頁，沒有清除 banner 裡的舊重試按鈕。使用者可再次點擊，形成多個 `loadCore()`；它不像 `showDetail()` 有序號防護，舊請求稍後失敗可把已成功狀態改回錯誤，舊 status 也可覆蓋新 status。
- **建議修法：**增加核心載入序號；meta、index、status 先存於該次呼叫的區域變數，確認序號後再提交 state。載入中移除或停用重試按鈕。

**R7｜Medium｜status 請求卡住會阻止核心成功或失敗狀態呈現**

- **位置：**`app.js:33`、`app.js:84`。
- **問題：**`fetchJSON()` 無逾時控制，且核心 UI 更新必須等待 `statusP`。即使 index／meta 已成功，甚至已明確 404，只要 status 連線仍未結束，畫面就持續載入，沒有紅色警示或重試入口。
- **建議修法：**使用原生 `AbortController` 設定逾時；status 失敗後依規格轉紅。核心結果與 status 狀態分別處理，避免輔助資源阻塞所有查詢。

**重複實作**

**R8｜Low｜「此前最後有價」在前端寫了三次**

- **位置：**`engine.js:133`；`app.js:443`、`app.js:553`。
- **判定：**目前三者對同一排序、相同 record 物件的輸入等價，**未發現當前數值不一致**。但若日後修改有效 prior 的判定，摘要／預告與表格／tooltip 可能不同步，對同一列產生不同的終止前金額或首列 0 元標籤。
- **建議修法：**在 engine 提供一次掃描建立 prior 對照表的函式，三處共用，保留 O(n)；不必在每列重新呼叫線性掃描。

`stateText()` 的 priced 分支（`app.js:429`）也重複了 `stateLabel()`（`engine.js:187`）已有能力，可直接委派。規格要求的 Python／JS 摘要雙語實作不列為重複缺陷。

**2. Test gap analysis**

| 位置／嚴重度 | 缺口與影響 | 建議補強 |
|---|---|---|
| `e2e/mock.mjs:5`、`tests/test_golden_frontend.py:6`／**High** | 全部 mock 來自重新產生的 golden fixture；fixture 與 ETL 一致，不代表實際發布的 `data/` 一致。R1 正是在 87 項測試通過下發生。 | 加入唯讀正式 artifact 契約檢查：window 欄位完整性，以及停止／首列 0 元搜尋卡實際結果。 |
| `tests-js/engine.test.mjs:85`／**High** | 衝突案例直接手工放入 `conflict`，沒有測「build 時正常、T 跨入重疊」；無法抓到 R2。 | 從完整 history 建 window，再移動 T；比較搜尋卡與詳細頁的衝突狀態。 |
| `e2e/app.spec.mjs:359`／**Medium** | 首列 0 元的否定斷言只錨在支付價 `td`，沒檢查事件欄、圖例、SVG 描述。 | 同時驗整列及對應圖表區塊；加入「暫停 → 0、從未有價」。 |
| `e2e/app.spec.mjs:97`／**Medium** | 連續查「撫緒」「caremod」「paroxetine」均期待同一張卡；`search()` helper 只確認不是載入／提示文字，後兩次即使沒執行搜尋，舊結果仍可通過。 | 每次先清空並等待結果消失，或使用具有不同結果集合的查詢，確認本次搜尋完成。 |
| `e2e/app.spec.mjs:247`／**Medium** | A 慢 B 快案例檢查 B 出現後與 2.5 秒後的結果，未持續驗證中間沒有短暫呈現 A。現有載入中測試有價值，但不是完整的競態歷程驗證。 | 控制 A 回應釋放點並記錄 DOM 變更；補 A 回應、返回搜尋、resize 的交錯。 |
| `e2e/app.spec.mjs:282`／**Medium** | 核心重試只測一次失敗接一次成功；沒有連按重試、舊回應較晚完成、status 長時間 pending。 | 補 R6、R7 的可控制 promise 案例，確認舊回應不能改動 UI。 |
| `tests-js/engine.test.mjs:306`、`:147`／**Medium** | metadata 只測不同起日；decimal 只測一般小數。 | 補同起日變體、科學記號、前導／尾隨小數點、新值為 0。 |
| `e2e/app.spec.mjs:114`、`:49`／**Medium** | deep link 測試驗代號、列數、日期與 title，未驗現行價格；window 耗盡測試名稱宣稱詳細頁正確，實際沒有點入詳細頁。 | 對 `.metric.key .val` 驗價格；耗盡後實際進入詳細頁，確認 history 推導結果。 |
| `playwright.config.mjs:14`／**Medium** | 全部 e2e 封鎖 SW，因此 SW 啟用、跨站快取刪除、離線 fallback 都未受測。 | 獨立 SW 測試組啟用 service worker，預先建立其他站台 cache，確認不被刪除。 |
| `e2e/app.spec.mjs:35`、`tests-js/engine.test.mjs:41`／**Low** | C1 規定每個案例均測前一天／當天／後一天、搜尋卡與詳細頁；目前只有部分案例完成完整矩陣。 | 補恢復支付、暫停轉有價及空窗的三日雙介面矩陣。 |

另外，只有 invalidRecords、只有遙遠起日哨兵、同 shard 快取後切換代號、排序後再 resize，均缺少完整 DOM 驗證。`showDetail()` 在一般 A→B 路徑會先清空 `state.current`，也有回應序號檢查；本次未找到該一般路徑讓 A 價格殘留到 B 的確定缺陷。

**3. Dependency audit**

- **npm：**`package.json:10` 只有精確固定的開發依賴 `@playwright/test@1.62.1`；lockfile 的 Playwright 套件版本一致，具有 integrity。網站沒有 npm runtime 依賴，符合前提。
- **Actions：**`.github/workflows/test.yml:26`、`:29`、`:46`、`:49` 全部 pin 完整 SHA；`contents: read`、`npm ci`、`uv sync --locked` 合理。未發現浮動 action tag。
- **已知公告核對：**Playwright 的 CVE-2025-59288 影響 `<1.55.1`，不涵蓋此 lockfile 的 1.62.1；此結論限該公告，並非完整漏洞掃描證明。[GitHub Advisory](https://github.com/advisories/GHSA-7mvr-c777-76hp)
- **Google Fonts：**`index.html:13` 使用 `display=swap`，CSS 有本機 fallback。保留此外部資源符合指定取捨；另載入 JetBrains Mono，與全域 DM Mono 偏好不同，但不列為價格正確性缺陷。

**R9｜Medium｜SW 啟用會刪除同 origin 其他專案的快取**

- **位置：**`sw.js:12`。
- **問題：**刪除所有名稱不等於本專案 `CACHE` 的 Cache Storage。GitHub Pages 專案子路徑共用 origin，其他臨床工具的快取也會被刪除；SW scope 不會替 Cache Storage 做站台隔離。
- **建議修法：**只刪除名稱以本專案專屬前綴開頭的舊版本。
- `sw.js:21` 確實排除 `data/`，符合外殼快取決策。另 `sw.js:32` 對缺失 JS／CSS 也 fallback 到 HTML，應限 navigation request 使用 HTML fallback，其餘資源明確回傳失敗。

**4. 規格符合度稽核**

以下與前述發現共用編號，不重複計數。

| 條款 | 判定、實作證據與必要修正 |
|---|---|
| **C1；D5；spec §5.1** | **部分不符／High。**詳細頁由 history 推導已做到（`app.js:319`）；正式 window 缺欄位及跨日重疊誤報價格見 R1、R2。 |
| **C2；D12；spec §5.3、§8.2** | **部分不符／Medium。**區段模型確實只為 priced 畫線、斷開空窗；但首列 0 元圖例仍代表終止（R3）。此外 `styles.css:160` 對預告 band 只有降低透明度，未達 plan C2「預告區段以虛線繪製」；spec §8.2 雖允許淡色，驗收依指定優先序仍取 plan。可加預告虛線邊框。 |
| **C2 人工驗收** | **尚未完成／Medium。**`.ai-review/phase2-acceptance.md:26` 明列藥師目檢待辦。已有截圖與開發者自檢，不能當作該人工關卡已完成。 |
| **C3；spec §8.6** | **基本規則符合，失敗流程不足／Medium。**`engine.js:422` 的 21／22／45／46 天與 +08:00 日界符合；status pending 無逾時及核心阻塞見 R7。 |
| **C4；spec §8.1** | 搜尋範圍、排序、空白處理與 50 筆上限符合（`engine.js:357`）。但部分 DOM 測試可能由前次結果假通過，見測試缺口。 |
| **C5** | 子路徑、代號正規化、缺代號處理與路由已有實作（`app.js:228`、`:250`）；驗收測試未完整驗價格，不能以現有斷言證明全部承諾。 |
| **C6** | 聲明存在且具 responsive 樣式；本次未重跑所有 viewport，無足夠證據判定遮蔽缺陷。聲明內容的首列 0 元例外不足見 R3。 |
| **C7；spec §8.7** | 一般 shard 失敗／重試／序號防護有實作（`app.js:276`）。網路永久 pending 沒有有限時間失敗處理（R7）；中間態驗證仍可補強。 |
| **C8、E6；D10** | 指定兩組版本字串比較有做到（`engine.js:403`、`:411`）。但版本相等不代表前端必需欄位齊全；正式舊 index 被接受見 R1。不要求新增每次下載重新 hash 的規格外需求。 |
| **E1；spec §5.5** | 一般正數小數、排除預告的規則符合；合法輸入語法跨語言不同，使差額／百分比靜默缺失，見 R5。 |
| **E2；spec §5.3、§5.5** | 跳過 unchanged、停止前金額等基本規則符合；從未有價的 terminated 事件文案與 §5.3 衝突，見 R3。應同步修正文案規格與實作。 |
| **E3；spec §8.3** | 列數與 invalidRecords 原值有實作（`app.js:556`、`:581`）。但 `e2e/app.spec.mjs:332` 只驗列數及部分異常欄位，**不足證明每列日期／rawPrice 一一對應**。建議逐列比對完整欄位；不是再加一個總數斷言。 |
| **E4** | flags 從各自 entry 渲染（`app.js:167`、`:343`），未發現他代號旗標共用。但目前 DOM 測試主要證明 gap，未完整驗 conflict、`?`、metadata 與搜尋卡。 |
| **E5；spec §8.4** | 欄位確實由管線產生：`lib/history.py:21` 包含兩種連結，`app.js:327` 讀取；不存在「連結欄位從未寫入」問題。遇同起日變體仍可能取錯連結，見 R4。 |
| **D9；spec §6.6** | **不符邊界／Medium。**一般不同起日的日期選列成立，同起日無法對應 record，見 R4。 |
| **D13** | Node 純邏輯＋Playwright DOM 的分工符合；問題在覆蓋內容與斷言強度，不在測試數量。 |

**R10｜Low｜E7 時間標記未對準宣稱的事件**

- **規格：**plan §5 E7。
- **位置：**`app.js:62`、`:76`、`:84`、`:105`；`scripts/measure_e7.mjs:60`。
- **問題：**`index-parsed` 在 meta＋index 的 `Promise.all` 完成後才標記，不一定是 index 真正解析完成；`search-ready` 又早於等待 status 與實際啟用搜尋框。meta 或 status 較慢時，量測會漏算部分「解析完成→可搜尋」時間。
- **建議修法：**在 index 自身 JSON 解析完成時標記起點；在搜尋框實際可操作、首次查詢可完成時標記終點。

指定 commit 的驗收紀錄已坦白記載 E7 未達標：可搜尋中位數 **428 ms**、首次詳細頁繪製 **1.1–1.5 秒**（`.ai-review/phase2-acceptance.md:37`、`:40`）。這是已知驗收差距，不是本次新發現。覆審途中工作樹新增了「使用者接受 MVP 現況」文字；它不在 `30a955e` 中，因此本報告保留「原條件未達標」與「後續接受取捨」的區別，不將效能優化列為新的強制重寫需求。

Codex session ID: 01a0948e-f6ee-7471-868f-f21f3b3c5fa5
Resume in Codex: codex resume 01a0948e-f6ee-7471-868f-f21f3b3c5fa5
