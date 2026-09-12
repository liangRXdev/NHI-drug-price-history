# Codex 覆審判定（Phase 2 前端）

> 2026-09-12；原始意見：`.ai-review/codex-review.md`（範圍 29f146c..30a955e）。每項皆回原始碼該行驗證。

## 統計

接受 11／部分接受 5／拒絕 1

## 程式碼與規格符合度

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| R1 | 正式 `data/` 缺 `pricedBefore`，搜尋卡出現「終止前 — 元」、從未有價者被標「終止」 | High | **接受** | 屬實：`data/drug_index.json` 內 `"pricedBefore"` 出現 0 次（commit 前我 `git checkout -- data/`，原打算 push 後由 workflow 重建）；`engine.js:308` 以 `r.pricedBefore` 呼叫 `stateLabel`，`undefined !== null` 使 `engine.js:192` 首列 0 元例外失效。修法：資料與前端**同一個 commit** 發布（本機以 metadata 建置），前端對缺欄位的 window 保守顯示「需更新，請開啟詳細頁」而非當 null。 |
| R2 | 跨生效日出現重疊時搜尋卡仍報單一價格 | High→**Medium** | **部分接受** | 屬實：`engine.js:295` 只取第一個有效 window 列、只看該列 `conflict` flag。嚴重度下修：實測 overlap 0、每代號恰 1 列開放迄日（spec §3.1），且 overlap 為 build log 監測項。修法照建議：T 當日有效 window 列 > 1 → 衝突。 |
| R3 | 首列 0 元例外未覆蓋圖表區塊／圖例、`terminated` 事件文字、頁尾聲明 | Medium | **接受** | 屬實：`app.js` 圖表所有 `terminated` 一律 `band-term`、圖例「終止支付」；歷史表事件欄對 previousPrice 為 null 的 `terminated` 事件顯示「終止支付」；`index.html:52`「支付價 0 元視為終止支付」無例外。spec §5.3 明文「適用於歷史表、圖表區塊、搜尋卡與摘要卡」。另 spec §5.5「已終止支付（無先前有價紀錄）」與 §5.3 衝突，同步修規格。 |
| R4 | 同起日 metadata 變體無法對應選定紀錄 | Medium→**Low** | **部分接受** | 屬實：`engine.js:159` 以 `from` 對應，`lib/history.py:245-250` 依 record 順序建變體；同起日不同描述時兩端選到不同變體。下修：全資料僅 1 個代號有變體（BC26467100，起日不同）。修法：變體加 `recordIndex`（首次出現之 record 索引），JS 依選定 record 索引對應。 |
| R5 | JS 十進位語法窄於 Python `Decimal`，總變化靜默消失；`decimalChange` 未限新值 > 0 | Medium→**Low** | **部分接受** | 屬實：`engine.js:45` 不接受 `1e1`／`.5`／`10.`，`engine.js:78` 只擋舊值 0。下修：實測支付價皆為 `12.50` 型式、malformed 0 列。修法：擴充語法、新舊值皆須 > 0、計算失敗顯示「差額無法計算」而非靜默省略。 |
| R6 | 核心重試可重入，舊請求覆蓋新結果 | Medium | **接受** | 屬實：`app.js:49-58` 重試開始未重繪 banner，舊的重試鈕仍可點；`loadCore()` 無序號。修法：核心載入序號＋區域變數提交＋載入中移除重試鈕。 |
| R7 | fetch 無逾時，status 卡住會阻塞核心 UI | Medium | **接受** | 屬實：`app.js:84` `await statusP` 在所有 UI 更新之前。修法：`AbortController` 逾時；核心結果先呈現，status 回來後再更新 banner／來源資訊（逾時視同失敗 → 紅）。 |
| R8 | 「此前最後有價」前端寫三次；`stateText()` 重複 `stateLabel()` | Low | **接受** | 屬實：`engine.js:134`、`app.js:444-445`、`app.js:554-555`。目前等價，但漂移會使同一列在摘要／圖表／表格顯示不同終止前金額。修法：engine 提供一次掃描的 `priorPrices(records)` 三處共用。 |
| R9 | SW 啟用時刪除同 origin 其他專案的快取；非導覽請求也 fallback 到 HTML | **High** | **接受**（上修） | 屬實：`sw.js:13` 刪除所有 `k !== CACHE`。GitHub Pages 使用者網域 `liangrxdev.github.io` 由所有專案頁共用 origin，會清掉其他臨床工具的離線快取——跨專案破壞，上修為 High。`sw.js:32` 對 JS／CSS 回 HTML 會產生難解的語法錯誤。修法：只刪本專案前綴、HTML fallback 限 navigation。 |
| R10 | E7 時間標記未對準 | Low | **接受** | 屬實：`app.js:63` 在 meta＋index 皆完成後才標 `index-parsed`；`app.js:76` `search-ready` 早於實際啟用搜尋框。修法照建議；E7 判定（使用者已接受現況）不變。 |
| C2 | 預告 band 只降透明度，未以虛線呈現 | Low | **部分接受** | plan C2 的「虛線」指價格線段（已做到），但預告的終止／暫停區塊也應可辨識為預告。加虛線外框，成本低。 |
| — | 「全域 DM Mono 偏好」 | — | **拒絕** | 誤判：house style（`pharmacy-tool-style`）指定 `JetBrains Mono`；DM Mono 是 `vanco-auc-calc` 的例外，不是全域偏好。 |

## 測試缺口

| # | 缺口 | 判定 | 處理 |
|---|------|------|------|
| T1 | mock 全來自 golden fixture，未驗正式發布資料（R1 在測試全綠下發生） | **接受** | 新增一個讀真實 `data/` 的 e2e：查詢會列出終止／暫停品項的字串，斷言任何搜尋卡都不含「— 元」且首列 0 元代號不含「終止」。斷言不綁特定價格，避免資料更新造成假紅。 |
| T2 | 衝突測試手工放 flag，未測「build 時正常、T 跨入重疊」 | **接受** | 由完整 history 以 build 日組 window，移動 T 比對搜尋卡與詳細頁。 |
| T3 | 首列 0 元否定斷言只錨在支付價欄 | **接受** | 驗整列、圖表區塊 class、圖例；加「暫停 → 0、從未有價」。 |
| T4 | e2e `search()` helper 可由前次結果假通過 | **接受** | 已驗證：`e2e/app.spec.mjs` helper 只等「非載入中／非提示」，第二次呼叫即直接通過。改為先清空、等提示出現再輸入。 |
| T5 | 競態只驗 B 出現後與 2.5 秒後 | **部分接受** | 已有「B 載入期間不殘留 A」測試；補在 A 回應釋放的當下檢查 DOM。resize 交錯不補（resize 只重繪 `state.current`，由序號保護）。 |
| T6 | 核心重試只測一失敗一成功 | **接受** | 補連按重試＋舊回應較晚完成、status 永久 pending。 |
| T7 | metadata 只測不同起日；decimal 只測一般小數 | **接受** | 隨 R4、R5 補。 |
| T8 | deep link 未驗價格；window 耗盡測試名稱宣稱詳細頁但沒點進去 | **接受** | 已驗證屬實（假綠燈形態：測試名稱宣稱的性質沒被斷言）。 |
| T9 | SW 未受測 | **部分接受** | 修 R9 程式；不另建 SW e2e（需啟用 SW 的獨立設定，成本高於 MVP 價值），列為後續。 |
| T10 | C1 三日雙介面矩陣不完整 | **接受** | 在 engine 層補恢復支付、暫停→有價、空窗的三日 × 搜尋卡／詳細頁矩陣。 |
| T11 | E3 未逐列比對 | **接受** | 逐列比對日期、rawPrice。 |

## 必修（Critical／High，接受或部分接受）

1. **R1**：資料與前端同 commit 發布；缺 `pricedBefore` 時保守顯示
2. **R9**：SW 只刪本專案快取、HTML fallback 限導覽
3. **R2**（下修 Medium，但屬「顯示錯誤確定價格」風險軸，一併修）

## 處理結果（2026-09-12，使用者指示「照順序全部修完再推」）

| # | 處理 | 位置 |
|---|------|------|
| R1 | 資料以本機 CSV（含 metadata）重建，與前端同 commit；非有價 window 列缺 `pricedBefore` → 「需更新」 | `engine.js` `searchCard()`、`data/` |
| R9 | 只刪 `nhi-price-shell-` 前綴快取；HTML fallback 限 navigation；快取版本升 v2 | `sw.js` |
| R2 | T 當日多筆有效或帶 conflict／conflicting_price_interval → 衝突；單筆僅帶 overlap → 「區間重疊，請開啟詳細頁確認」 | `engine.js` `searchCard()`、spec §5.1 |
| R3 | `isUnpricedZero()`；圖表 `unpriced_zero` 區塊與獨立圖例、事件欄、最新調整、頁尾聲明；spec §5.5 文案改正 | `engine.js`、`app.js`、`index.html`、spec §5.3／§5.5 |
| R4 | `metaVariants[].recordIndex`；JS 依選定 record 索引對應 | `lib/history.py` `meta_payload()`、`engine.js` `selectMeta()`、spec §5.2 |
| R5 | 十進位語法對齊 Decimal；新舊值皆須 > 0；失敗顯示「差額無法計算」 | `engine.js` |
| R6 | 核心載入序號；載入開始即清橫幅與重試鈕 | `app.js` `loadCore()` |
| R7 | `AbortController` 逾時；status 不阻塞查詢，回來後更新橫幅／來源資訊／現行價加註 | `app.js` `fetchJSON()`、`loadCore()` |
| R8 | `engine.priorPrices()` 摘要／圖表／歷史表共用；移除 `stateText()` | `engine.js`、`app.js` |
| R10 | `index-parsed` 標在 index 解析完成、`search-ready` 標在搜尋框啟用後 | `app.js` |
| C2 | 預告區塊加虛線框 | `styles.css` |
| T1–T11 | 見 `.ai-review/phase2-acceptance.md`「/codex-review 修正後」 | `tests-js/`、`e2e/` |

## 建議處理順序

R1 → R9 → R2 → R3 → R6／R7 → R4／R5 → R8／R10／C2 → 測試 T1–T11 → 全套測試＋變異驗證 → push（資料同 commit）→ 啟用 Pages → 手動 dispatch 驗 changed／unchanged 兩條路徑。
