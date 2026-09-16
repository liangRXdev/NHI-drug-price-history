# 覆核判定 — 預告中心（PR #4）Codex 獨立覆審

> 覆核日期：2026-09-16／覆核者：Claude（主持人）
> Codex 原始輸出：`.ai-review/codex-review-upcoming.md`（未修飾）
> 覆核範圍：`f9c0b9d..d83a70d`（main）
> **每一項都回讀了該檔該行；R4／R6／R10 另以實跑驗證。**

## 統計

| 判定 | 數 |
|---|---|
| 接受 | 14 |
| 部分接受 | 3 |
| 拒絕 | 0 |
| 無發現（依指定排除範圍，判定合理） | 3 |

Codex 未出現幻覺引用：抽驗的 `app.js:687/704/722`、`engine.js:608/619`、
`lib/history.py:464`、`build_price_history.py:320` 皆存在且描述與實際相符。

## 1. Code review

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| R1 | 更新尚未成功就撤掉舊快照警示 | High | **接受** | `app.js:687` 在發出新請求時 `updateFailed: null` 但保留 `phase: 'ready'` 與舊 `payload`。實際後果：重試進行中的畫面看起來是正常的最新資料，`exportUpcomingCSV()`（`app.js:877`）此時匯出的 CSV 也不帶「沿用舊快照」註記。`spec-upcoming.md` §5.5 明文「保留舊清單時，必須連同當時的 `buildDate`、版本與『更新失敗』標示一起保留，不得配上新的成功狀態」。快照未保存當時的 `lastCheckedAt`（`app.js:722` 讀共享的 `state.status`）亦屬同一問題。修法採 Codex 建議：把「最後一次成功快照」與「目前請求狀態」分開存放，只有新資料驗證成功才解除警示 |
| R2 | `upcomingSeq` 過期回應防護不可達 | Medium | **部分接受** | 屬實：`showSearch()`／`showDetail()` 只遞增 `detailSeq`，`upcomingSeq` 只在 `loadUpcoming()` 內遞增（`app.js:684`），而重新進入被 `upcomingInflight`（`:682`）擋住，因此 `:708` 的序號分支在正常流程中確實永遠不成立。**但嚴重度應降為 Low**：`renderUpcoming()` 開頭的 `if ($('upcomingView').hidden) return;`（`app.js:727`）已使過期回應無法覆蓋畫面，目前沒有可觀察的錯誤行為（e2e 已驗）。修法不需 AbortController：離開預告頁時 `state.upcomingSeq += 1`，並讓 `upcomingInflight` 的清除綁定請求身分即可 |
| R3 | 進入預告中心未重新取得 T | Medium | **接受** | `state.today` 只在初始化（`app.js:22`）與 `showDetail()`（`:316`）更新，`showUpcoming()` 未更新。跨午夜後從搜尋頁進入預告中心，到期標示、徽章數字與 CSV 的「檢視日期」都會沿用昨天。§2 的取日慣例是「**進入頁面時**取得一次、該次檢視內不跨午夜更新」，預告中心本身就是一次檢視 |
| R4 | Python／JS 日期驗證不等價 | Medium | **接受** | 實跑確認：JS `validateUpcoming` 接受 `effectiveDate = '2027-02-30'`（`engine.js:26` 的 `ISO_DATE` 只驗外形），空清單時連 `buildDate = '2026-13-01'` 都通過；Python `_is_iso_date()`（`lib/history.py:464`）以 `date.fromisoformat()` 解析，兩者皆拒絕。反向亦不等價：Python 接受基本格式 `'20260911'`，JS 拒絕。目前生成器一律用 `.isoformat()`，不會產出鎖死資料，但**跨語言雙 validator 的等價性正是它的價值所在**，不等價等於防線有洞。修法：兩端都「正規表示式 ＋ 真實日曆日」，並共用同一組合法／非法日期案例 |
| R5 | 遷移判定讀工作目錄而非已發布版本 | Medium | **部分接受** | 屬實：`build_price_history.py:320` 讀 `data_dir/upcoming.json`，註解卻寫「判定對象是已發布版本」，與 §3.3.1 用語不符。**但嚴重度應降為 Low**：正式發布只在 Actions 的乾淨 checkout 執行，工作目錄即已發布版本；且失敗時一個位元組都不寫，不會留下殘留檔。Codex 建議的「由發布流程傳入已提交基準」在本專案的 CI-only 發布模型下過重。修法：優先讀 `git show HEAD:data/upcoming.json`，取不到再退回檔案；並補 T3 指出的殘留情境測試 |
| R6 | 首次交付漏掉 meta 統計 | Low | **接受**（嚴重度提高為 Medium） | 實測 `data/meta.json` 確實沒有 `upcomingRows`／`upcomingCodes`。成因是我把 `data/upcoming.json` 手工產出後單獨 commit（`.ai-review/upcoming-acceptance.md` §3 有記錄），沒有同批更新 meta——這正好違反 §3.3.1 自己定的完成定義「經驗證的產物與 meta 已同批進入 commit 才算完成」。更糟的是目前 `generatorVersion` 已相符，`migration` 永遠為 False，來源不變就永遠補不回來。修法：把「meta 缺 upcoming 統計」也納入遷移觸發條件，讓下一次 build 強制走有差異批次補齊 |
| R7 | 篩選後摘要沿用全清單未生效數 | Medium | **接受** | `app.js:763` 的 `pending` 在篩選前算出，`:784` 卻接在「符合篩選條件 N 筆」後面。篩出 1 筆時會顯示「符合篩選條件 1 筆（清單共 82 筆），其中 82 筆尚未生效」，數字互相矛盾。徽章維持全清單計數是對的（§5.1），但摘要句必須改對 `model.rows` 計數 |
| R8 | body 接收階段逾時被誤判為內容損毀 | Medium | **接受** | `app.js:54–56`：`res.json()` 失敗時一律回 `LoadError('invalid', …)`，即使是 abort 造成。依 `loadUpcoming()`（`:703`）的分流，逾時會被當成「內容不合法」而**清空舊快照**，與 §5.5「網路／HTTP／逾時 → 保留舊清單」相反。修法：`fetchJSON` 在 `ctrl.signal.aborted` 時一律歸 `network`，只有真正的 JSON 語法錯誤才歸 `invalid` |
| R9 | 畫面未呈現恢復支付的差額金額 | Medium | **接受** | `engine.js:690–695` 的序 11 副標只帶百分比，`absoluteChange` 只進了 CSV。§4.2 明文「`relisted` 的 `absoluteChange`／`percentChange`／`crossesStop` 在 record 上已有值，**必須呈現**」，U4 亦寫「序 11 恢復支付必須顯示差額與百分比」。這是我的測試把驗收條件抄弱了（只斷言副標字串）而非實作意外。修法：序 11 副標加入差額金額，並同步修訂 §4.1 的副標模板（與 §4.2／U4 對齊）；序 13 是否比照辦理另請使用者決定 |
| R10 | 內容非法沒有 console 紀錄 | Low | **接受** | `app.js` 全檔無 `console.*`。§5.5 的「JSON 損毀、缺欄位，或任一列不合法」列明「並於 console 記錄」。修法：記錄資源名稱與驗證原因即可，不輸出整份資料 |
| — | 重複實作 | — | **無發現（合理）** | Codex 依指定排除範圍未提出；並正確辨識出 `upcomingLabel()`（搜尋卡／詳細頁預告標籤）與 `upcomingDecision()`（預告中心決策表）承擔不同規格契約，不應合併 |

## 2. Test gap analysis

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| T1 | 日期測試假綠燈 | Medium | **接受** | 實跑確認 `tests-js/upcoming.test.mjs` 的 `buildDate = '2026-13-01'` 案例是被「effectiveDate 不晚於 buildDate」擋下（`'2026-10-01' <= '2026-13-01'` 字串比較），不是日曆驗證——**斷言錨在錯的位置**。修 R4 時必須同時改成空清單驗非法 `buildDate`、另以晚於合法 D 的 `'2027-02-30'` 驗日曆 |
| T2 | 競態測試錨錯性質 | Medium | **接受** | `e2e/upcoming.spec.mjs:125` 只驗「離開後預告頁仍隱藏」，舊回應即使被接受也會通過——它驗到的是 `renderUpcoming()` 的隱藏守衛，不是序號防護。與 R2 同源，須以 A／B 不同內容的回應反序完成來驗 |
| T3 | 遷移測試未涵蓋工作目錄殘留 | Medium | **接受** | `tests/test_build.py` 的三條遷移路徑基準都先 commit，且注入失敗發生在寫檔前，因此沒有任何案例呈現「工作目錄有新檔、已發布版本仍舊」。與 R5 同源 |
| T4 | U1／U7a 的「完整內容」宣稱過強 | Medium | **接受** | `tests/test_upcoming.py:23` 的 `RECORD_FIELDS` 不含 `previousState`／`pricedBefore`／`everPriced`，但 U1 寫的是「每筆**所有欄位**相符」；`tests/test_build.py` 的 `brief()` 只比四欄，U7a 要的是「該 D 的完整預期 items 內容」。屬實 |
| T5 | U12 並非逐列逐欄 | Medium | **接受** | 目前比對的是第 0／1／9／14 欄與少數 slice，U12 明文「逐列逐欄」。應改為完整 16 欄預期矩陣 |
| T6 | 更新失敗矩陣缺漏 | Medium | **接受** | 缺「成功後版本不符」「成功後合法 JSON 但壞列」「body 逾時」「重試在途的警示與 CSV」等情境；匯出停用只測 404。R1／R8 的修正必須連同這些案例一起補，否則修了也沒有防線 |
| T7 | U14 終點偏早 | Medium | **部分接受** | 屬實：`app.js:795` 的 measure 落在 `innerHTML` 指派後，未納入 layout／paint；`scripts/measure_upcoming.mjs:74` 的重繪量測雖等兩次 rAF，讀的仍是等待前的 measure。**但這不等於效能不達標**——82 列的 layout 成本遠小於現有餘裕（126 ms vs 200 ms）。修法：終點改為渲染後的下一個 frame，依相同契約重測三次取中位數，並更新驗收數字 |
| T8 | U8／U15 整合證據不足 | Low | **接受** | U8 的逐日案例確實有驗完整代號集合，但部分只驗數量；U15 的合法 null 只驗到 validator，未驗畫面實際顯示「—」。補 DOM 斷言即可 |

## 3. Dependency audit

| 判定 | 理由 |
|---|---|
| **無發現（合理）** | 覆核同意：`pyproject.toml` 僅 `requests`、`uv.lock` 固定 requests 2.34.2／urllib3 2.7.0，workflow 用 `uv sync --locked`；`package.json` 僅 `@playwright/test` devDependency；actions 皆 SHA pin 且本 PR 未改。Codex 自述「這是有限公告核查，不是完整漏洞掃描」，覆核採同一保留 |

## 4. 規格符合度稽核

Codex 逐條核對 `.ai-review/upcoming-acceptance.md` 的 ✅，指出 **U1／U4／U7a／U7b／U8／U10／U11／U12／U14／U15 的證據不足以支撐目前的標記**。

**覆核判定：接受。** 這些 ✅ 是我自己寫的，且其中數條（U4 的差額、U12 的「逐列逐欄」、U14 的終點、U1 的「所有欄位」）**把驗收條件抄成了比原文弱的版本**——正是 `/codex-checkplan` 與 `/codex-review` 中間那道縫要補的東西。驗收文件須依修正結果重寫，不得沿用現有標記。

另有一項 Codex 無從得知、由覆核補上的事實：

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| X1 | 藥師目檢紀錄未進 main | Medium | **接受（覆核新增）** | `05b8341 chore: pharmacist review of upcoming labels` 只存在於 `origin/feat/upcoming-center`，`git merge-base --is-ancestor 05b8341 main` 為否——合併發生在該 commit 推送之前。因此 main 上的 `.ai-review/upcoming-acceptance.md:60` 仍寫著「[ ] 臨床藥師目檢」，Codex 也據此判讀。目檢本身 2026-09-16 已由臨床藥師執行並通過，需把該紀錄重新帶進 main |

## 5. 建議處理順序

1. **R1 ＋ R8 ＋ T6**（同一條防線）：舊快照的保留與解除、逾時歸類、對應的失敗矩陣測試
2. **R7、R3**：畫面上會直接被使用者讀到的錯誤數字與過期日期
3. **R9 ＋ §4.1 副標模板修訂**：規格明文要求卻沒做到的呈現
4. **R4 ＋ T1**：跨語言 validator 等價性與假綠燈測試
5. **R6 ＋ R5 ＋ T3**：發布完成定義（meta 統計補齊、遷移判定改讀已提交版本、殘留情境測試）
6. **T4 ＋ T5 ＋ T8**：把被抄弱的驗收條件補回原文強度
7. **T7**：U14 重測與數字更新
8. **R2、R10**：死守衛與診斷紀錄
9. **X1**：把目檢紀錄帶回 main，並依上述修正重寫 `.ai-review/upcoming-acceptance.md`
