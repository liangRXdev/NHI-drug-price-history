# Codex 獨立覆審原始輸出 — 預告中心（PR #4）

> 審查日期：2026-09-16
> Codex：codex-cli 0.153.4（plugin openai-codex 1.0.6，背景 `task --prompt-file`，`sandbox: read-only`）
> 審查範圍：`f9c0b9d..d83a70d`（main 上已合併的 PR #4），prompt 見 `.ai-review/codex-prompt-upcoming.md`
> Codex session：01a0a7d0-f213-7d51-af17-28512e125a58
>
> **以下為 Codex 原始輸出，未經修飾或刪改。**覆核判定見 `.ai-review/verdict-upcoming.md`。

---

**結論：不建議將 PR #4 視為 U1–U15 全部驗收完成。** 主要問題集中在前端新鮮度與競態處理、日期驗證的假綠燈，以及首次交付的完成判定。

審查範圍為 `f9c0b9d..d83a70d`；全程未修改檔案。

- 實跑 JS：**154／154 通過**。
- 獨立比對已提交產物與完整 history：**82 筆逐筆相符**，涵蓋起迄日、價格、事件、前價、前狀態與變動值。
- Python 執行遭環境權限拒絕；未執行會產生檔案的 Python／E2E 測試。驗收文件中的其他測試數字不視為本次重新驗證。

**1. Code review**

**R1 — 更新尚未成功，就撤掉舊快照警示**

- **位置／嚴重度：** `app.js:687`、`app.js:704`、`app.js:722`、`app.js:877`／**High**
- **問題：** 更新失敗後保留舊資料，再按重試或重新進入預告中心，立刻清除 `updateFailed`，但 `phase` 仍為 `ready`、舊 payload 仍可顯示與匯出。等待新請求期間，畫面恢復成沒有失敗警示的正常狀態，CSV 也不再帶沿用舊快照註記。另外，快照未保存當時的最後檢查狀態；日期始終讀共享的 `state.status`。
- **重現：** 記憶體內執行得到 `{phase:'ready', hasPayload:true, updateFailed:null}`，此時重試尚未完成。
- **建議：** 將「正在更新」與「最後一次成功快照」分開保存；只有新資料驗證成功才能解除舊資料警示。快照一併保存檢查日期／狀態，畫面與 CSV 使用同一份快照資訊。
- **規格：** §5.5，尤其 `spec-upcoming.md:387`、`:391`；U10。

**R2 — `upcomingSeq` 的過期回應防護實際不可達**

- **位置／嚴重度：** `app.js:286`、`:682`、`:684`、`:708`、`:889`／**Medium**
- **問題：** 離開預告頁不增加 `upcomingSeq`；舊請求在途時，重新進入會被 `upcomingInflight` 擋住，無法建立新請求。因而舊回應仍被接受，`:708` 的序號不符分支在正常流程中無法發揮作用。
- **重現：**「進入→離開→立即再進入」只產生 **1 次請求、seq=1**，舊回應最後變成 `ready`。
- **建議：** 離開時使請求失效或中止；重新進入建立新一代請求。清除 inflight 狀態也須確認請求身分，避免舊請求清掉新請求的狀態。
- **規格：** §5.5 `spec-upcoming.md:380`；U10。

**R3 — 進入預告中心未重新取得 T**

- **位置／嚴重度：** `app.js:22`、`:316`、`:889`／**Medium**
- **問題：** T 只在初始化與進入詳細頁時更新。搜尋頁跨午夜後才進入預告中心，或隔日重新進入，仍沿用昨天日期；當日已生效列可能繼續顯示為未生效，徽章與 CSV 檢視日期亦錯。
- **建議：** 每次開始新的預告檢視時取得本地日期，並同步更新徽章與過期橫幅；同次檢視內仍不自動跨午夜更新。
- **規格：** §2 `spec-upcoming.md:73`；U8。

**R4 — Python／JS 日期驗證不等價，JS 接受不存在的日期**

- **位置／嚴重度：** `engine.js:30`、`:608`、`:619`；`lib/history.py:464`／**Medium**
- **問題：** JS 只驗 `YYYY-MM-DD` 外形；Python 使用日曆解析。實測 JS 接受 `effectiveDate='2027-02-30'`、`endDate='2027-02-30'`，空清單也接受 `buildDate='2026-13-01'`。反向而言，Python `date.fromisoformat()` 接受的基本格式比 JS 正規表示式寬。
- **建議：** 兩端都限定相同的 `YYYY-MM-DD` 型別、格式與真實日曆日期；加入同一組合法／非法日期 fixture。保留跨語言雙 validator。
- **規格：** §5.5.1 `spec-upcoming.md:405`、`:409`；U15。
- **界線：** 現有生成器使用 `.isoformat()`，本次未發現正常來源會因此產出鎖死資料；問題是防禦契約不等價。

**R5 — 遷移判定讀工作目錄，並非已發布版本**

- **位置／嚴重度：** `build_price_history.py:320`／**Medium**
- **問題：** 註解宣稱判定已發布版本，實際直接讀 `data_dir/upcoming.json`。若工作目錄已有同版本產物、但尚未與相應 meta 完成提交，便可能被當成遷移完成。
- **建議：** 由發布流程提供已提交基準，例如讀取基準 commit 的產物版本，再傳入純 build 流程；不能只憑工作目錄檔案存在判定完成。
- **規格：** §3.3.1 `spec-upcoming.md:164`、`:180`、`:182`；U7b。
- **界線：** 乾淨 Actions checkout 降低此風險，但沒有實現規格明訂的工作目錄殘留情境。

**R6 — 首次交付漏掉 meta 統計，無差異 build 不會補齊**

- **位置／嚴重度：** `data/meta.json:1`、`build_price_history.py:321`、`:326`；`.ai-review/upcoming-acceptance.md:56`／**Low**
- **問題：** PR 已提交 `upcoming.json`，但 meta 缺少 `upcomingRows`、`upcomingCodes`。目前產物為 82 列／79 碼，generator 已是 `upcoming/1`；來源與 index 不變時，migration／changed 都不會補寫 meta。
- **建議：** 將這次不完整交付視為尚未完成，透過正常全批發布補齊產物與 meta；完成條件同時驗證 meta。若修復批次可能只有 meta 變動，workflow 必須有明確方式讓該批次進入 commit。
- **規格：** §3.4、§3.3.1。

**R7 — 篩選後摘要使用全清單未生效數**

- **位置／嚴重度：** `app.js:763`、`:781`–`:786`／**Medium**
- **問題：** `pending` 在篩選前計算，卻放進「符合篩選條件 N 筆，其中 M 筆尚未生效」。例如篩出 1 筆，可能宣稱其中 82 筆尚未生效；只篩出已到期批次時也會誤導。
- **建議：** 徽章維持全清單計數；結果摘要另對 `model.rows` 計數，或明確標示該數字屬全清單。
- **規格：** §2、§5.3 的篩選結果呈現。

**R8 — 接收 response body 時逾時，被誤判為內容損毀**

- **位置／嚴重度：** `app.js:54`–`:56`、`:703`／**Medium**
- **問題：** headers 已到、JSON body 尚未收完時觸發 abort，會拋出 `LoadError('invalid', '連線逾時')`。預告更新因此清空舊快照，違反逾時應保留舊快照的分流。
- **建議：** `res.json()` 失敗時先區分 abort／傳輸失敗與真正 JSON 語法錯誤；前者走網路類，後者才走內容非法。
- **規格：** §5.5 `spec-upcoming.md:387`–`:389`；U10。
- **範圍：** `fetchJSON()` 為既有共用程式，但新增功能直接依其錯誤分類決定是否保留資料。

**R9 — 畫面未呈現恢復支付的差額金額**

- **位置／嚴重度：** `engine.js:690`–`:695`、`app.js:858`–`:859`／**Medium**
- **問題：** `absoluteChange` 有產出，也有匯出 CSV，但恢復支付畫面只顯示前後價與百分比，未呈現差額金額。
- **建議：** 保留 §4.1 逐字副標，另外顯示既有 `absoluteChange`，不重算、不改寫指定文案。
- **規格：** §4.2 `spec-upcoming.md:288`、U4。
- **規格張力：** §4.1 副標模板本身只列百分比；新增獨立差額欄位可同時滿足兩項承諾。

**R10 — 內容非法沒有規格要求的 console 紀錄**

- **位置／嚴重度：** `app.js:698`、`:703`／**Low**
- **問題：** 結構驗證失敗與 JSON 損毀都有錯誤畫面，但沒有 console 診斷紀錄。
- **建議：** 記錄資源名稱與驗證原因，不必輸出整份資料。
- **規格：** §5.5 `spec-upcoming.md:377`。

已核對、**不列為缺陷**的項目：

- `build_upcoming()` 正確依 D 選描述列，區分 `previousPrice`／`pricedBefore`，並衍生 `everPriced`。
- `build_outputs()` 依代號、records 順序附加；前三鍵相同時 stable sort 確實保留第四鍵。
- 14 條決策採優先序且有最後兜底，未發現未匹配組合靜默落成確定事件。
- guard 拒絕發生在 `publish()` 前；未發現新增的部分發布路徑。逐檔 atomic write 不等同多檔交易，但這不是本 PR 新增的 guard 繞過。
- workflow 加入 `data/upcoming.json` 能讓正常首次／升版批次進入有差異分支；不能把這項必要例外本身判為違規。
- `data/` 未加入 SW，前端未新增 runtime 依賴。

**重複實作**

依指定排除範圍，**未確認需獨立修正的非刻意重複實作**。既有 `upcomingLabel()` 與新增 `upcomingDecision()` 分別承擔規格明訂的不同呈現契約，不建議合併其文案規則。

**2. Test gap analysis**

| 發現／嚴重度 | 檔案：行號 | 問題與建議 |
|---|---|---|
| **T1 日期測試假綠燈／Medium** | `tests-js/upcoming.test.mjs:165`；`engine.js:608` | `2026-13-01` 晚於 fixture 的 `2026-10-01`，測試被「effectiveDate 未晚於 buildDate」擋下，不是日曆驗證。改用空清單測非法 buildDate，另測晚於合法 D 的 `2027-02-30`。 |
| **T2 競態測試錨錯性質／Medium** | `e2e/upcoming.spec.mjs:125` | 只驗離開後頁面仍隱藏；舊回應即使被接受也會通過。應重新進入，注入不同內容的 A／B 回應並反序完成，驗請求次數、最終資料與匯出內容。 |
| **T3 遷移測試未涵蓋工作目錄殘留／Medium** | `tests/test_build.py:450`、`:506` | 基準均先 commit；失敗又發生於寫檔前，因此沒有驗到「工作目錄有新檔、已發布版本仍舊」。新增這個獨立情境並驗 meta 同批 staging。 |
| **T4 U1／U7a 完整內容宣稱過強／Medium** | `tests/test_upcoming.py:23`、`:38`；`tests/test_build.py:319`、`:403`、`:430` | U1 shape 未含 `previousState`／`pricedBefore`／`everPriced`；U7a 的 `brief()` 只比四欄。既有 golden 能保護部分基準，但不等於各路徑完整逐欄對應。補獨立預期與停止續期等合成案例。 |
| **T5 U12 並非逐列逐欄／Medium** | `tests-js/upcoming.test.mjs:244`–`:268` | 全列比較只覆蓋部分欄位，金額只核對前兩列；暫停續期前價全部輸出空欄仍可能通過。應獨立列出完整 16 欄預期矩陣，含重複列與排序後匯出。 |
| **T6 更新失敗矩陣缺漏／Medium** | `e2e/upcoming.spec.mjs:106`、`:117`、`:143`、`:219` | 未驗成功後版本不符、成功後合法 JSON 壞列、body 逾時、重試在途警示與 CSV；匯出停用只專測 404。逐條補入，不能以首次失敗測試代替。 |
| **T7 U14 終點偏早／Medium** | `app.js:795`、`:832`；`scripts/measure_upcoming.mjs:62`、`:74` | 記錄的是 DOM 修改完成；重繪測試雖等待兩次 rAF，最後仍讀等待前的 measure。尚未證明規格要求的實際可互動終點。應將 layout／呈現完成納入計時，再依相同條件重測三次中位數。 |
| **T8 U8／U15 整合證據不足／Low** | `e2e/upcoming-filters.spec.mjs:191`、`:211`；`tests-js/upcoming.test.mjs:145` | U8 部分情境只驗列數及少數指定列；U15 null 案例只驗 validator，未驗實際畫面「—」。補完整代號多重集合、各列到期狀態與 null 的 DOM 驗證。 |

另外，`tests-js/upcoming.test.mjs:79`–`:112` 有幾個測試直接斷言 `CASES` 的預期值，而非呼叫函式。但 `:68`–`:70` 已逐案比較實際輸出，因此**不能據此宣稱整個 U4 沒有驗到實作**。真正缺口是差額金額沒有列入預期。

**3. Dependency audit**

**未確認本 PR 新增的漏洞、不必要依賴或授權缺陷。**

| 範圍 | 核對結果 |
|---|---|
| Python | `pyproject.toml:9` 僅 requests runtime；`uv.lock:277` 固定 requests 2.34.2、`:292` 固定 urllib3 2.7.0。workflow 使用 `uv sync --locked`，不能僅因宣告下限較寬就判定實際安裝舊版。 |
| JS | `package.json:12` 僅 Playwright devDependency；lockfile 固定版本與 integrity，無前端 runtime 套件。 |
| Actions | `build-data.yml:30`、`:33`；`test.yml:26`、`:29`、`:46`、`:49` 均為完整 SHA pin；本 PR 未改動這些 pin。 |
| 授權 | npm lockfile 中 Playwright 系列為 Apache-2.0；未見本次新增授權衝突。未完成所有 Python 間接依賴的逐份授權文件稽核。 |

外部核查中，Requests 官方 releases 列出 2.34.2；urllib3 所查兩項公告的修正版為 2.7.0，repo 已採用該版本。[Requests releases](https://github.com/psf/requests/releases)、[urllib3 redirect advisory](https://github.com/urllib3/urllib3/security/advisories/GHSA-qccp-gfcp-xxvc)、[urllib3 changelog](https://urllib3.readthedocs.io/en/2.7.0/changelog.html)。

這是有限公告核查，**不是完整漏洞掃描通過的證明**，亦未據此宣稱所有依賴皆為最新版本。

**4. 規格符合度稽核**

下表逐條核對 `.ai-review/upcoming-acceptance.md:31`–`:46` 的 ✅。缺口修法與嚴重度沿用上述 R／T 編號。

| 驗收條款 | 覆審結果 | 實作／測試證據與缺口 |
|---|---|---|
| **U1** | 部分支持 | `tests/test_upcoming.py:64` 有真正雙向重數比較，但不是所有欄位；見 T4。本次另確認正式產物 82 筆指定事件欄位相符。 |
| **U2** | 大致支持 | `tests/test_upcoming.py:110`、`:121`、`:140` 確有合成多筆與全量三碼正對照；同日案例未逐筆驗 endDate，真實案例也未比 endDate。建議補入；**Low**。 |
| **U3** | 支持 | `tests/test_upcoming.py:171`–`:214` 四種選列與真實案例均比較全部描述欄位。 |
| **U4** | 部分支持 | 14 序與精確字串確實測到，但 `absoluteChange` 未呈現，測試仍宣稱差額已驗；見 R9。 |
| **U5** | 大致支持 | `tests/test_build.py:329`、`:342` 有獨立目錄與精確價格哨兵。兩次 checked_at 並非規格要求的相同值，但這反而額外驗了 upcoming 不依檢查時間，不單獨列缺陷。 |
| **U6** | 靜態支持 | `tests/test_build.py:362` 注入兩種失敗，檢查內容與集合不變；另有 main exit 與成功正對照。本次未實跑 Python。 |
| **U7a** | 部分支持 | 三路徑存在，但完整內容斷言弱化為四欄；見 T4。 |
| **U7b** | 未完整達成 | 正常 staging 路徑有驗；已發布基準／工作目錄殘留與首次 meta 完整性未達成，見 R5、R6、T3。 |
| **U8** | 未完整達成 | 固定日期案例有覆蓋，但進入時取 T 未實作，且集合斷言部分只驗數量；見 R3、T8。 |
| **U9** | 部分支持 | type × ATC 四類母體確實存在，沒有縮成剛好等於交集。`e2e/upcoming-filters.spec.mjs:82` 未實測英文名搜尋；`:153` 未含非 null 同幅度與 0% 對 null 的排序邊界。建議補正例／排除例；**Low**。 |
| **U10** | 未完整達成 | 六種首次失敗有測；更新失敗、競態及保留快照契約不足，見 R1、R2、R8、T2、T6。 |
| **U11** | 部分支持 | 首次混版与重新整理恢復有測；沒有成功快照後再混版，以及各混版情境匯出不可用的直接斷言；見 T6。 |
| **U12** | 部分支持 | BOM、特殊字元、rawPrice 保真有實測；「逐列逐欄」宣稱超出斷言，見 T5。 |
| **U13** | 大致支持 | `e2e/upcoming-filters.spec.mjs:175` 有分組列數對應；`e2e/upcoming.spec.mjs:178` 品質 chip 有正反例，`:193` 檢查手機裁切。未在本次重新執行。 |
| **U14** | 證據不足以維持 ✅ | `.ai-review/upcoming-acceptance.md:17`、`:18` 的數字基於偏早終點；見 T7。不是判定效能必然不達標，而是現有量測未證明達標。 |
| **U15** | 未完整達成 | 合法 null 的 validator／CSV 有測，但缺 DOM 驗證；日期合法性存在假綠燈，見 R4、T1、T8。 |

§2–§8 中另外明確未完成的承諾為：**§3.4 首次 meta 統計、§4.2 差額呈現、§5.5 舊快照與競態、§5.5.1 真實日期驗證、§8.1 量測終點**，均已在上文引用實作位置。

`.ai-review/upcoming-acceptance.md:60` 的臨床藥師目檢、`:66` 的線上手動 dispatch 本來就標示待辦；這兩项屬**明示尚未驗收**，不應改算成已完成，也不屬假綠燈。

Codex session ID: 01a0a7d0-f213-7d51-af17-28512e125a58
Resume in Codex: codex resume 01a0a7d0-f213-7d51-af17-28512e125a58
