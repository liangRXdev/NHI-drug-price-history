# 規格覆審判定 — spec-index-format v0.4

- **判定日期**：2026-10-13
- **對象**：`plan-review-index-format-v04.md`（Codex 原始輸出）；規格 commit `00125b1`
- **判定者**：Claude（主持人），逐項對照 `engine.js`／`app.js`／`build_price_history.py` 查證

## 統計

接受 8／部分接受 1／拒絕 1（其中範圍蔓延 0）

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| 1.1 | 判定關鍵欄漏列 `chName`／`enName`／`ingredient` | High | **接受** | 查證屬實：`engine.js:477` 用模板字串組 haystack，非字串值會被轉成 `"123"`／`"[object Object]"` 並可被搜尋命中。這正符合我自己在 §4.1 定的「靜默改變搜尋命中」準則，是套用準則時漏掉的，§10「不改變搜尋命中」的敘述因此不成立。成本也只是 3 次 `typeof` |
| 1.2 | 載入期與 ready 後例外未區分；F13 狀態名稱錯 | Medium | **接受** | 查證：`app.js:14` 的 core 狀態只有 `loading｜ready｜error｜mismatch`，`invalid` 是 `LoadError.kind`。`prepareIndex` 拋錯時由 `loadCore` 的 catch 轉成 error（`app.js:131`），`runSearch`／rAF 鏈沒有 catch。F13 改寫成實際狀態，並在 §4.1 寫明「判定關鍵欄必須在載入期擋下，因為 ready 後沒有 catch」 |
| 2.1 | §9.2 第 3 點宣稱「單列錯位由長度擋住」，說過頭 | High | **接受** | 屬實：長度相同、型別相容的欄位互換（例如 `chName`↔`enName`）runtime 和 builder 都擋不住。v0.3 的 runtime 全量 type 驗證同樣擋不住，所以不影響「B 可以推翻 2.7」的結論，但論據必須限縮，並把這類錯位列為由 builder 正確性與 F1／F4 防守的殘餘風險 |
| 2.2 | 「F12 先完成」只是敘述，不是 gate | Medium | **接受** | 正是 v0.3「量到另一個方案」的形態。F10／F13 的前提改成：同一 revision 的 F12 已通過 |
| 2.3 | §10 同時保留 v0.3 與 v0.4 互斥的敘述 | Low | **接受** | 改成單一現行敘述，v0.3 的部分標為歷史 |
| 3.1 | F7a 沒驗 code 型別，也沒有正例 | Medium | **接受** | 補 code 為空字串／number／null 的反例、最小合法 fixture 與帶合法附加欄位的正例、reason 優先序組合矩陣，以及 haystack 三欄的反例 |
| 3.2 | F7b 用「等」帶過，可只驗代表欄位 | Medium | **接受** | 改為以 §3.3 每個欄位為列的完整矩陣，每個案例只破壞一個性質，另加合法邊界正例 |
| 3.3 | F10 沒綁定被測 revision／artifact | Medium | **部分接受** | 標了 `[新增需求]`，但這不是功能範圍蔓延：它只要求驗收紀錄多寫幾個 hash，不做的後果很具體（證明不了量到的就是要合併的版本，正是 v0.3 的失敗形態）。接受記錄被測 commit、`engine.js` 與 index 的 SHA-256、Chromium 版本、各輪原始值。「工作樹必須 clean」寫成同一要求即可，不另立條目 |
| 3.4 | F12 只做尾端注入，不能證明完整 traversal | Medium | **接受** | 改成第一／中間／最後三個位置，各配一個共通層錯誤與一個 builder 層錯誤；成功的基準 build 必須完成並輸出動態計數，避免 validator 全部拒絕也算過 |
| 3.5 | F13 全部拒絕也會過；狀態名稱錯 | Medium | **接受** | 每個欄位都要有合法／非法成對案例；`priceState`／`eventType` 另測「型別正確但不在值域」 |
| 4.1 | F7b 的「JS 必須回 ok」是過度設計 | Low | **拒絕** | ① 這是使用者在需求摘要第 3 項確認的決策。② Codex 提議改由 F10 守住 runtime 不被加回昂貴驗證，但 F10 是手動量測、不在 CI 裡，擋不住日後的回歸，而 v0.3 正是因為驗證逐步加重才沒過門檻。③ 這條契約的「代價」是改邊界時要同步改規格和 expected，這個摩擦是刻意設計的：runtime 邊界變更本來就應該重評 §4.1 並重量 F10。保留，但在 §5.6 寫明這是刻意的摩擦，不是永久凍結 |

## 是否需要重審

不需要。兩項 High 都是補漏和論據限縮，**架構沒有變**（仍然是「builder 全量＋runtime 結構與判定關鍵欄」）：

- 1.1 是依既有準則多加三個 `typeof`
- 2.1 只修論據，不改結論

依 `/codex-checkplan` Step 5 的規則，沒有整段架構更動，所以不觸發重審。
