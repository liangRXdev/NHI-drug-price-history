# 實作覆審判定書（spec-startup.md）

- 判定日期：2026-11-17　原始意見：`.ai-review/codex-review-startup.md`
- 覆核方式：逐項回去讀程式碼／測試／規格原文；未重跑 Codex 的探針。行號以 `57d0bbf` 為準。
- 統計：**接受 12／部分接受 6／拒絕 0**（C2 與 R2–R4 重複，不另計）

| # | 項目 | Codex 嚴重度 | 判定 | 理由 |
|---|------|------|------|------|
| R1 | index 轉換例外逃出狀態機，停在 loading | High | **接受（High）** | `app.js:122–123` 的 `prepareIndex()`／`new Map()` 無保護；`validateIndex()`（`engine.js:530–538`）只驗外層，`{drugs:[null]}` 會在 `engine.js:445` 的 `d.code` 拋錯。此時 `indexState` 仍是 `loadIndex()` 設的 `loading`（`app.js:143`），`renderBanners()` 不會執行 → 無錯誤、無重試。**屬回歸**：基準 `7ac1760` 的 `loadCore()` 把 `validateIndex`／`prepareIndex` 包在 try/catch 內。觸發需要「同版本但條目損毀」的 index，管線不會產生，機率低；但後果是風險排序第 3 類（靜默失敗），修法單純 |
| R2 | 比較頁壞條目被快取，重試沿用同一份 | Medium | **接受** | `loadShard()` 只看外層與版本就寫快取（`app.js:1291–1294`）；`compare-retry` 只對 `contradiction` 清快取（`app.js:1974`）。條目結構壞（`app.js:1342–1343`）的重試必然讀回同一份。詳情頁的 `retry-shard` 無條件清快取（`app.js:1986`），兩視圖行為不一致。違反 §5.3「結構不合法者不得留在快取」的可重試意圖 |
| R3 | 資料矛盾更正重畫整個比較主體 | Medium | **接受** | `app.js:557` 更正後呼叫 `renderCompare()`，後者整段重設 `#compareBody.innerHTML`（`app.js:1417`）。D4.3 寫「只影響該代號，其他品項不動」，D4.4 明言「不得擴大解讀為主體可重畫」。重畫後內容相同（missing 與 error 都不進圖表），使用者可見影響限於 focus／crosshair 中斷一次，但確實違反規格字面 |
| R4 | 比較頁不顯示「分片內容不合法」 | Medium | **接受** | `app.js:1425` 只在 `d.contradiction` 時輸出 `d.error`；條目結構壞只顯示通用的「資料載入失敗」。D4.2 寫「歸入 `error`「分片內容不合法」」，S9(f) 亦以該文案為結果。測試 `e2e/startup-notfound.spec.mjs` 的「S9(f) 比較頁：一個代號的條目結構壞 → 該代號為「分片內容不合法」，不是 missing」只斷言 `data-status="error"`，標題宣稱的文案沒有斷言——假綠燈形態 |
| T1 | S6「最新事件生效日」錨在歷史表首列 | High | **部分接受（Medium）** | 屬實：`goldenExpectation()` 取所有 records 的最大 `from`（含未來列），斷言 `table.history` 首列；摘要的「最新一次調整」（`app.js:677`）沒有斷言。2026-11-17 補的 6 支 S6 補測沿用同一寫法，同樣有此缺口。嚴重度下修：`summaryAt`／`latestEventLabel` 本分支未改動（`git diff 7ac1760 f5125bd -- engine.js` 不含兩者），且 `tests-js/engine.test.mjs`、`tests-js/golden.test.mjs` 另有覆蓋；S6 的「index 未到與已發布逐字相同」仍涵蓋該 metric 的 index 無關性。但 S6 規格明列此項，驗收文件標 ✅ 過強 |
| T2 | 真實資料 smoke 非有價分支只驗無單位 | Medium | **部分接受（Low）** | 屬實（`e2e/real-data.spec.mjs` 的 else 分支只驗 `.val small` 為 0）。但固定代號 A020296321 現行為有價（2014-07-01 起 20.50），該分支目前不會執行；只有該品項日後終止或暫停時才生效 |
| T3 | S9 比較頁缺 index 先到情境；壞條目未驗原因 | Medium | **接受** | 「S9(b)」只走詳情頁；比較頁只有先 missing 後更正與 index 不含該碼。後半即 R4 |
| T4 | body 未完測試未確認 headers 已抵達 | Medium | **接受** | `gate.mjs:78` 在攔截當下計數，`body-slow` 之後才 `route.continue()`。`e2e/server.mjs` 自己的註解寫明「若 body 請求尚未抵達，抵達時直接送完整內容」——`finish()` 早於請求抵達伺服器時，整段 body 一次送完，被測階段根本不存在而測試仍通過 |
| T5 | 放行後只等固定時間 | Medium | **部分接受（Low–Medium）** | 屬實：`release()` 之後以 `waitForTimeout(SETTLE_MS)` 作負向斷言（S5b(d)、S11）。本機 `route.fulfill` 到 app 處理通常遠小於 250 ms，只會在很慢的機器上假通過、不會假失敗。修法成立：先等該回應完成（如 `page.waitForResponse`）再斷言 |
| T6 | S12 觀察器只看回呼當下的 DOM | Medium | **部分接受（Low）** | 屬實（`gate.mjs:140–145` 不檢查 `addedNodes`）。但同一 task 內插入又移除的節點不會被繪出，使用者看不到；規格關心的外洩是可見內容。補 `addedNodes` 檢查成本低，可做 |
| T7 | S13 mutation 白名單未錨定品項；預告只觀察清單 | Medium | **接受** | `startup-deeplink.spec.mjs` 最後一支只要求每筆記錄符合 `/compare-name/`（`gate.mjs:157` 的描述不含代號），另一品項的 `.compare-name` 被錯改也會通過。預告只監看 `#upcomingList` |
| T8 | S5 未揭露的組合與斷言缺口 | Medium | **接受** | M11 只測 deep link（index idle），沒有「首頁先啟動 index、meta 未到就導覽到比較／預告」的 loading 組合；M13 只有 loading／error／mismatch，且未斷言搜尋框、結果節點、請求數。S5 規格要求「逐組合斷言：顯示文案、搜尋框可否操作、結果節點有無、請求數」。驗收文件只列 M4 idle 一個缺口，低報 |
| C1 | S14 守門檢查內部模型而非實際產物 | High | **部分接受（Medium）** | 屬實：`routing_errors(shards, index_drugs)`（`build_price_history.py:422`）驗的是 `render()` 之前的模型；§5.6 原文是「對實際產出」。嚴重度下修：`render()`（`build_price_history.py:145–150`）是對同一個 `shards` dict 的一對一序列化，meta 的 `files` 也是 `sorted(shards)`，目前沒有可使兩者分歧的路徑。但守門的目的就是防未來的改動，改為解析 `files` 的 bytes 成本低且符合規格字面 |
| C2 | D4.2–D4.4、§5.3 三項承諾未落實 | Medium | **接受（與 R2–R4 重複）** | 同 R2、R3、R4 |
| C3 | 共同 routing fixture 未由 JS 使用 | Medium | **接受** | `tests/fixtures/shard_routing_cases.json` 只有 `tests/test_build.py:788` 讀取；`tests-js/engine.test.mjs`「shardPrefix 以最長符合前綴選檔，不寫死長度」用另一組寫死的案例。S14 原文：「同一份 fixture 對 JS 的 `shardPrefix()` 斷言相同的獨立預期歸屬」。驗收文件 S14 ✅ 有誤 |
| C4 | S6 缺「現行有價、單一區間」與摘要事件 | Medium | **接受** | golden 11 筆的 records 數為 6–24，沒有單一區間；合成的單筆案例是尚未生效品項。後半同 T1 |
| C5 | 作廢區塊未保留已取得原始值 | Medium | **部分接受（Low）** | 屬實：`measure_startup.mjs` 的 `block()` 在樣本失敗時直接 `return { void, partial: out }`，當前代號的 `raw` 尚未寫入 `out.detail`。§7 要求「原始數據與原因照樣記錄」。本次 0 作廢，S1–S3 數字不受影響；屬工具缺陷 |
| C6 | 終點檢查的縫隙 | Low | **接受** | `probe()` 只驗 `#sumTitle` 與 table 的尺寸；`pressedAfter === pressedBefore` 的比較會把屬性被移除（null）當成翻轉。Codex 同時確認腳本有強制 layout、兩個 frame 與另一端日期檢查，沒有停在 DOM 寫入 |

## Dependency audit

無發現（Playwright 1.63.0 → 1.65.0、pytest 9.1.1 → 9.2.0，皆 dev 依賴）。未自行複核上游公告。

## 必修項（High 且接受）

- **R1**：`settleIndex()` 的轉換與發布加保護，例外轉為 index error（保留主體、提供重試），補「同版本但條目損毀」案例。

## 建議處理順序

1. R1（回歸、靜默失敗）。
2. R2、R4、R3（比較頁；R4 最小，R3 需局部更新並以節點身分＋mutation 驗收）。
3. 補強會掩蓋上述問題的斷言：T3（含 S9(f) 文案）、T7、T4、T1／C4。
4. C1、C3（守門改驗序列化產物；JS 讀共同 fixture）。
5. T8、T5、T6、T2、C5、C6。

## 驗收文件須更正之處

`.ai-review/startup-acceptance.md` 原標 ✅ 而實際有缺口者：S9（R4、T3）、S13（T7）、S14（C1、C3）、S4（T4）、S5b／S11（T5）、S12（T6）；
S5、S6 的缺口清單低報（T8、T1、C4）。已於該文件 §7 加註。

## 與 v0.3.2 的關係

Codex 審的是 v0.3.1 與 `f5125bd`。覆審期間的 S10(b) 改寫與 9 支補測（`57d0bbf`）不在其範圍內，Codex 也沒有對 S10 提出意見。
