# Codex 實作覆審原始輸出（spec-startup.md）

- 審查日期：2026-11-17
- Codex：codex-cli 0.164.0（plugin 1.0.6，read-only task，job task-mwjzfkfh-88zf3k）
- 審查範圍：`7ac1760..f5125bd`，加上當時未提交的 `.ai-review/startup-acceptance.md`、`startup-measure.json`
- 啟動時 commit：`f5125bd`；規格 v0.3.1（覆審進行中規格升為 v0.3.2、補測 commit `57d0bbf`，Codex 自陳不計入）
- prompt：`.ai-review/codex-prompt-startup-impl.md`

以下為原始輸出，未經修飾。

---

**結論：建議暫緩合併。** 發現 index 處理例外會靜默卡住、比較頁重試無法取得修正資料，以及建置守門未檢查最終序列化產物等問題。另有多項未列入驗收文件的假綠燈缺口。

審查基準為 `7ac1760..f5125bd`，加上指定的兩份未提交驗收文件。覆審途中另出現的測試追加修改不計入證據。全程未寫入檔案。

本次重跑 `node --test`：315 passed。未重跑會產生檔案的完整 pytest／Playwright suite。另完成目前 `data/` 全量唯讀核對：348 片、45,224 碼；雙向差集、重複歸屬、錯片與版本不符均為 0。

## 1. Code review

**R1｜High｜index 轉換例外逃出狀態機，永久停在 loading**

- **位置：** `app.js:111–145`、`app.js:148–159`；相關呼叫 `engine.js:431–446`。
- **問題：** `settleIndex()` 的 `prepareIndex()`、建立 Map 及發布流程沒有例外處理。`validateIndex()` 只驗外層，因此同版本的 `{ drugs: [null] }` 可通過驗證，隨後在 `prepareIndex()` 拋錯。唯讀探針已重現：例外逃出，`indexState` 仍為 `loading`，沒有錯誤橫幅或重試入口。原本 `loadCore()` 的 catch 可以接住這類例外，本分支失去這層處理。
- **建議修法：** 將轉換與建立 Map 放在受保護的區段，先完成區域結果，再一次發布；任何例外轉成 index error，保留目前主體，提供既有重試入口。補同版本但條目損毀的案例。

**R2｜Medium｜比較頁的壞條目被快取，重試永遠沿用同一份錯誤**

- **位置：** `app.js:1288–1295`、`app.js:1342–1343`、`app.js:1970–1975`。
- **問題：** shard 外層與版本正常、但條目 `records` 非陣列時，loader 已將 shard 存入快取；比較頁隨後分類為 error。按重試只有 `contradiction` 才清快取，這種 error 會一直讀舊 shard。探針中第一次與重試後請求數都為 1，即使後續來源已修正仍不能恢復。
- **建議修法：** 比較頁重試前，清除所有待重試失敗代號所屬片的快取，並依 prefix 去重；保留既有 in-flight 共享。補「壞條目 → 修正回應 → 重試成功」案例。

**R3｜Medium｜資料矛盾更正會重畫整個比較主體**

- **位置：** `app.js:557`、`app.js:1396–1428`。
- **問題：** index 發布發現比較頁 missing 與 index 矛盾時，直接呼叫 `renderCompare()`；後者重新指定整個 `#compareBody.innerHTML`。這超出 D4.4 的局部更正例外，會替換其他品項的圖表、表格及控制節點，破壞 focus、crosshair 等當下互動狀態。探針確認此路徑確實呼叫整體 render。
- **建議修法：** 局部更新矛盾品項的狀態、錯誤文字與必要 banner；保留其他品項及控制節點。測試同時保存另一品項的節點身分與 MutationObserver 記錄。

**R4｜Medium｜比較頁沒有顯示「分片內容不合法」的錯誤原因**

- **位置：** `app.js:1342–1343`、`app.js:1384–1388`、`app.js:1425`。
- **問題：** 條目結構壞時雖然儲存 `error: '分片內容不合法'`，實際 render 只在 `contradiction` 時輸出 `d.error`。使用者只看到一般「資料載入失敗」，規格要求的分類文案從未出現。
- **建議修法：** 在該代號的錯誤位置輸出經 escape 的具體原因，並斷言畫面含「分片內容不合法」，不能只驗 `data-status="error"`。

**重複實作獨立檢查：** 未找到符合本次排除條件之外、應另列缺陷的重複實作。Python／JS 最長前綴規則、validators、測試及規格明列的兩視圖行為，均未當成重複實作問題。

I1、I2、D4 判定順序、詳情頁 D4.3 目前代號資格，以及主要 T1／T2 路徑，未發現可證實的錯誤；`sw.js` 也僅變更 CACHE。

## 2. Test gap analysis

**T1｜High｜S6 的「最新事件生效日」斷言錨在歷史表首列**

- **位置：** `e2e/startup-states.spec.mjs:326–335、378–382`；真正摘要位置為 `app.js:677`。
- **問題：** 預期值取所有 records 的最大 `from`，斷言歷史表首列，沒有檢查「最新一次調整」摘要。未來紀錄也會成為最大日期。**把摘要最新事件改成錯誤日期、空字串或未來事件，歷史表保持正常，整組 S6 仍會通過。**
- **建議修法：** 為每個案例獨立列出參考日下的最新事件及生效日，斷言對應摘要 metric；歷史表首列另行保留。

**T2｜Medium｜真實資料 smoke 的非有價分支只驗「沒有單位」**

- **位置：** `e2e/real-data.spec.mjs:61–65`。
- **問題：** 非有價情境只檢查 `.val small` 數量為 0。**把已終止、暫停、空窗一律顯示成任意無 `<small>` 的錯誤文字，這個分支仍通過。**
- **建議修法：** 從 shard 獨立推導預期狀態，精確核對狀態標籤；有價時核對金額。無法唯一判定時，明確斷言其分類。

**T3｜Medium｜S9 比較頁缺少 index 先到的無前綴情境，壞條目也未驗原因**

- **位置：** `e2e/startup-notfound.spec.mjs:184–193、216–244、265–273`。
- **問題：** index 先發布的測試只走詳情頁；比較頁只測先 missing 再更正及 index 不含該碼。壞條目案例也只驗 error 與代號。**比較頁若僅實作晚到更正、漏掉 index 先到判定，或完全不顯示壞條目原因，仍會通過。** R4 正是後者。
- **建議修法：** 補 S9(g)(b) 比較頁案例，持續記錄不得出現 missing；壞條目必須精確驗證「分片內容不合法」。

**T4｜Medium｜body 未完測試沒有確認 headers 確實已抵達**

- **位置：** `e2e/startup-order.spec.mjs:26–31、107–113`；`e2e/gate.mjs:62–67、105–111`。
- **問題：** 計數在攔截時增加，當時 `slow_put` 甚至可能尚未完成。250 ms 後就放行 body，慢機器可能根本沒經歷被測的「headers 已到、body 未完」階段。**錯誤實作在 headers 到達就啟動 index，在這種排程下仍可能通過。** 請求計數本身符合本案定義，缺的是階段證據。
- **建議修法：** 增加伺服器送出前半 body／瀏覽器收到 response 的確認訊號，確認該階段後才開始負向觀察；S10(e) 也要確認第一片已完成解析。

**T5｜Medium｜放行後只等固定時間，尚未證明舊回應或重試結果已處理**

- **位置：** `e2e/startup-states.spec.mjs:311–315`；`e2e/startup-order.spec.mjs:156–161、202–207`。
- **問題：** `release()` 只是解開攔截器，不代表 app 已處理結果。**移除詳情序號防護，讓 A 在 250 ms 之後才覆蓋 B，S5b(d) 仍可先行通過；重試結果晚到才拉回舊視圖，也可逃過 S11。**
- **建議修法：** 等待被放行回應完成及其處理機會，再檢查畫面、title、mutation；index 成功分支應等發布與實際查詢成功，不能以請求數代替完成。

**T6｜Medium｜S12 的「期間任何時刻」觀察器只看回呼時的 DOM**

- **位置：** `e2e/gate.mjs:137–145`；`e2e/startup-order.spec.mjs:220–230`。
- **問題：** observer 不檢查 MutationRecord 的新增節點，只重新查當下 DOM。**先插入未驗版結果／chip，再於同一個 task 移除的錯誤實作，會留下全 false。** 此外，固定等 250 ms 不能證明 index 已完整處理後仍被扣住。
- **建議修法：** 檢查 `addedNodes` 及其子樹，保存曾出現的違規節點證據；先確認 index 完整抵達，再維持 meta 扣住進行輸入與觀察。

**T7｜Medium｜S13 的 mutation 白名單未錨定指定品項；預告只觀察清單**

- **位置：** `e2e/startup-deeplink.spec.mjs:59–63、88–96`；`e2e/gate.mjs:157–158`。
- **問題：** fallback 測試只要求 mutation 描述含 `compare-name`，沒有節點身分或代號。**同時錯改其他品項的 `.compare-name` 也會通過。** 預告則只監看 `#upcomingList`；發布時重畫預告控制項或狀態區仍可通過。
- **建議修法：** 用實際 MutationRecord target 驗證只落在指定代號的品名節點；預告觀察完整主體範圍，排除規格允許的外部橫幅。

**T8｜Medium｜S5 尚有未揭露的組合與斷言缺口**

- **位置：** `e2e/startup-states.spec.mjs:218–257`；`.ai-review/startup-acceptance.md:75`。
- **問題：** M11 只測 deep link 的 index idle，未測首頁先啟動 index、meta 尚未到就導覽比較／預告的 loading 組合。M13 參數化只有 loading/error/mismatch，且沒有逐組合驗搜尋框、結果節點與請求數，也未完整交叉自身 loading/error/mismatch/retrying。**例如只在「首頁 → 比較、meta pending」提前啟用搜尋的錯誤，現有案例不會攔到。**
- **建議修法：** 建立展開組合清單，逐格指向內容、控制項及請求數斷言；不能只將 M4 idle 列為唯一缺口。

## 3. Dependency audit

**未發現需列嚴重度的依賴缺陷。**

- `package.json:12`、`package-lock.json:13–55`：Playwright 1.63.0 → 1.65.0，三個相關套件版本一致、保留 integrity，均為 dev dependency，Apache-2.0；未加入前端 runtime 依賴。1.65.0 有正式上游 release。[上游 release](https://github.com/microsoft/playwright/releases/tag/v1.65.0)
- `uv.lock:260–274`：pytest 9.1.1 → 9.2.0，仍在既有 dev group 範圍；`pyproject.toml` 未變更。9.2.0 有正式發布紀錄。[pytest 發布紀錄](https://docs.pytest.org/en/stable/announce/release-9.2.0.html)
- 本次查詢未找到上述升級版本的適用已知漏洞；上游 advisory 頁未列公開 advisory。這不等同完整供應鏈安全保證。[Playwright advisories](https://github.com/microsoft/playwright/security/advisories)、[pytest advisories](https://github.com/pytest-dev/pytest/security/advisories)

## 4. 規格符合度與驗收證據稽核

**C1｜High｜§5.6／S14 守門檢查內部模型，沒有檢查實際產物**

- **位置：** 規格 `spec-startup.md:264–271、373`；實作 `build_price_history.py:404–407、422、446–451`；測試 `tests/test_build.py:827–838`。
- **問題：** `render()` 已產生待發布 bytes，但 routing guard 仍驗原始 `shards/index_drugs`；meta map 又稍後另外組裝。測試只污染 `build_outputs()`，因此 **renderer 若漏輸出一碼、改錯 history 檔名或將碼序列化到錯片，模型仍正確，守門會放行**。這比「對實際產出、使用同一份產出的 shard map」弱。
- **建議修法：** 在寫入前，對記憶體中的最終 JSON bytes 與同一份待發布 meta map 做路由核對；保留全有全無及不可由 `allow_anomaly` 放行。測試另污染 render 產物，確認既有目錄全部位元組不變。
- **證據界線：** 本次現有資料全量核對通過，不代表這個守門已覆蓋序列化失效。

**C2｜Medium｜D4.2–D4.4、§5.3 的三項承諾未落實**

- **位置：** 規格 `spec-startup.md:153–176、233–236`；實作 `app.js:557、1288–1295、1425、1974`。
- **問題：** 分別對應 R2「壞條目重試仍讀快取」、R3「局部更正擴大為整體重畫」、R4「宣稱的錯誤原因沒有實際顯示」。
- **建議修法：** 依 R2–R4 修正，並以重試請求、節點身分、mutation 範圍及精確文案驗收。

**C3｜Medium｜S14 指定的共同 routing fixture 未由 JS 使用**

- **位置：** 規格 `spec-startup.md:373`；`tests/fixtures/shard_routing_cases.json:3–11`、`tests/test_build.py:848–852`、`tests-js/engine.test.mjs:459–463`。
- **問題：** Python 讀取共同 fixture；JS 沒有讀它，只保留另一組 AC48 測試。**若 JS 對 B0／B0123 的歸屬漂移，指定共同案例不會攔截。** 驗收文件 S14 ✅ 沒揭露這項差距。
- **建議修法：** JS 直接讀同一 fixture，對每筆獨立預期值斷言正序與反序的歸屬。

**C4｜Medium｜S6／§8.1 還缺「現行有價、單一區間」與摘要事件驗證**

- **位置：** 規格 `spec-startup.md:365、380–394`；測試 `e2e/startup-states.spec.mjs:339–362、378–382`；驗收文件 `.ai-review/startup-acceptance.md:77、94`。
- **問題：** HEAD 的 11 筆 golden 均有 6–24 筆 records；三個合成案例中唯一單筆的是尚未生效品項，不能代表現行有價單一區間。文件自己寫「未逐筆核對」，但只將 overlap/conflict/pricedBefore 列為缺口。另有 T1 的摘要日期漏驗。
- **建議修法：** 補現行有價單一區間 fixture；補摘要最新事件斷言，並更新缺口清單。

**C5｜Medium｜§7 作廢區塊沒有保留全部已取得原始值**

- **位置：** 規格 `spec-startup.md:312–313`；`scripts/measure_startup.mjs:164–184、210–214、225–227、252`。
- **問題：** 當次代號的 `raw` 尚未放進 `out.detail` 就提前返回；失敗樣本也只留下錯誤字串。若第三次量測失敗，前兩次已完成數值及該次已取得的 detail/search-ready 值均可能遺失。
- **建議修法：** 每次樣本完成就加入區塊記錄，失敗樣本保存已取得數值與原因，再將整區塊標為作廢。
- **本次影響：** 原始 JSON 為 0 作廢，因此目前 S1–S3 數字沒有受這項缺陷影響。

**C6｜Low｜§7 終點檢查仍有可接受錯誤狀態的縫隙**

- **位置：** 規格 `spec-startup.md:315–325`；`scripts/measure_startup.mjs:95–113`。
- **問題：** 可見性只檢查摘要 H2 與 table 尺寸；`aria-pressed` 只要求不同，移除 attribute 變成 null 也算翻轉。**只保留標題、隱藏摘要內容，或排序後刪除 aria attribute 的實作仍可能被計為到達終點。**
- **建議修法：** 驗完整摘要區與表格可見性；排序前後必須為明確的 `"true"`／`"false"` 反值。
- **本次判讀：** 腳本確實強制 layout、派送 click、等兩個 frame，並驗另一端日期與列數；沒有發現目前量測停在 DOM 寫入的證據。

驗收文件每個 ✅ 的核對結果如下：

| 條目 | 稽核結果 |
|---|---|
| S1–S3 | 原始樣本重算與文件一致；§7.2 套用正確。工具限制見 C5、C6。 |
| S4 | (a)–(e) 均有案例；(b) 的實際階段證據不足，見 T4。 |
| S5b | (a)–(d) 均有案例；(d) 放行後只等固定時間，見 T5。 |
| S7 | 四種失敗、mutation、節點連接、排序、請求數、可見按鈕均有斷言。 |
| S8 | 指名結構反例及主要正例有覆蓋；未發現需另列的新缺口。 |
| S9 | 尚缺比較頁 S9(g)(b)，S9(f) 未驗具體錯誤原因；另一品項只比數量與文字，攔不到 R3 的節點替換。 |
| S11 | 三種結果及導覽均有案例；在途結果與零 mutation 的完成時點不足，見 T5。 |
| S12 | 有三種 meta 結果及兩種重試；「完整回應後仍扣住」及「任何時刻」證據不足，見 T6。 |
| S13 | 主流程與失敗案例存在；mutation 範圍斷言不足，見 T7。 |
| S14 | 四種模型污染、兩種 allow_anomaly、既有目錄保護都有；實際產物與共同 JS fixture 缺口見 C1、C3。 |
| S15 | 全套測試結果為文件自陳；本次只重新確認 node 315 passed。真實資料 smoke 的條件分支弱化見 T2。 |

量測數字重算結果：

| 指標 | 重算值 | 判定 |
|---|---:|---|
| S1 最小配對改善 | 3,466.8 ms | 15 個值全部 ≥ 2,000，通過 §7.2 第一列 |
| S2 median | −63.9 ms | ≤ 已定案 `V_home=186.8`，通過 |
| S3 AC49155265 median | 571.8 ms | ≤ 1,500 |
| S3 B004922277 median | 489.5 ms | ≤ 1,500 |
| S3 NB01043100 median | 372.3 ms | ≤ 1,500 |

M0 的 `V=113.5`、`V_home=186.8` 與文件一致。接受使用者已裁定的 +11.2% 漂移，不要求重量；漂移限制了對環境穩定性的推論，沒有改變上述凍結規則的算術判定。S16 人工、§8.2 目檢與 S17 尚未完成，文件已有揭露，不能算通過，也不將部署後的 S17 當成本次合併前新增要求。

**整體結論：應阻擋目前版本合併。** 至少先處理 R1、C1，修正比較頁 R2–R4，並補上會掩蓋這些問題及錯誤事件日期的驗收斷言。效能數字達標，但目前功能與驗收證據仍不足以支持全面 ✅。

Codex session ID: 01a1e701-d63a-7330-be37-1ceb323d363e
Resume in Codex: codex resume 01a1e701-d63a-7330-be37-1ceb323d363e
