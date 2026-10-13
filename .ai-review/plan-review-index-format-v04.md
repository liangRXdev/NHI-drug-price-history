# Codex 規格覆審 — spec-index-format v0.4（B 方案重啟）

- **審查日期**：2026-10-13
- **覆審員**：Codex（codex-cli 0.153.4，model `gpt-5.6-sol`，`mcp__codex__codex`，sandbox `read-only`、approval-policy `never`）
  - 註：`~/.codex/config.toml` 的預設 `gpt-6-sol` 對 ChatGPT 帳號回 400，本次以 model override 執行，未改設定檔
- **規劃文件**：`spec-index-format.md` v0.4，commit `00125b1`（分支 `feat/index-columnar-b`）
- **範圍**：只審 v0.4 修訂（§11 v0.4 表）
- **指令**：`/codex-checkplan`

> 以下為 Codex 原始輸出，**未經修飾、未刪改**。逐項判定見 `plan-verdict-index-format-v04.md`。

---

## 1. 需求與邊界缺漏

### 1.1 High — 判定關鍵欄漏列 `chName`、`enName`、`ingredient`

- **嚴重度：High**
- **問題：**三欄直接參與搜尋 haystack，錯型別會靜默改變搜尋命中。`prepareIndex` 將它們插入模板字串後 `.toLowerCase()`，因此 number/object 不會 crash，而會成為 `"123"`／`"[object Object]"` 等可搜尋內容：[engine.js:403](C:/Users/liang/projects/NHI-main-fix/engine.js:403)、[engine.js:476](C:/Users/liang/projects/NHI-main-fix/engine.js:476)。這正符合 §4.1 自訂的「靜默改變搜尋命中」入選準則，但現行表未列入，並錯稱 drug 字串欄型別錯誤只影響顯示：[spec-index-format.md:279](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:279)、[spec-index-format.md:303](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:303)。§10「不會改變搜尋命中」也因此不成立：[spec-index-format.md:750](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:750)。
- **為什麼現在不修之後會更貴：**B 方案完成後，這三欄會失去 runtime type 防線；builder validator 一旦漏驗，錯誤會偽裝成「查無結果」或錯誤命中，正中本案最高權重風險。屆時需重開 runtime 邊界、F7a、F7b、F13 與殘餘風險描述。
- **建議修法：**把 drug `chName`、`enName`、`ingredient` 的 `typeof === 'string'` 納入共通層；同步從 F7b 的泛稱「drug 層字串欄非字串」排除這三欄，改放 F7a／F13；修正 §4.1 與 §10 的殘餘風險敘述。這不是新增需求，而是依既有入選準則補漏。

其餘已列欄位均有必要，未見可刪項：

- `from`／`to` 影響有效區間與隱藏判定。
- `priceState`／`eventType` 影響卡片 kind、標籤或 `not_yet`／`gap` 分支。
- window `flags`、drug `flags` 有 `.some()`／`.map()` crash 或靜默判定風險。
- `pricedBefore` 會進 `fmtMoney().toFixed()`。
- 兩個 count 未經 `esc` 進 `innerHTML`，保留 number 檢查合理：[app.js:251](C:/Users/liang/projects/NHI-main-fix/app.js:251)。

詳細頁 header 沒再漏 index 欄位：index drug 只先用 `chName` 設 `document.title`；可見 header 內容來自 shard 的 `meta`，且經 `dash`／`esc`：[app.js:370](C:/Users/liang/projects/NHI-main-fix/app.js:370)、[app.js:425](C:/Users/liang/projects/NHI-main-fix/app.js:425)。

### 1.2 Medium — 規格沒有精確區分「載入期例外」與「ready 後例外」

- **嚴重度：Medium**
- **問題：**若漏驗欄位在 `prepareIndex` 拋錯，外層 `loadCore` 會捕捉，實際狀態是 `core: 'error'`、`coreError.kind: 'invalid'`，使用者看到「無法載入藥價資料……目前無法查詢」及重試按鈕：[app.js:109](C:/Users/liang/projects/NHI-main-fix/app.js:109)、[app.js:131](C:/Users/liang/projects/NHI-main-fix/app.js:131)、[app.js:155](C:/Users/liang/projects/NHI-main-fix/app.js:155)。但若漏驗資料到達 `terminatedMask`／`renderCard`，`runSearch` 與 rAF 呼叫鏈沒有 catch，會成為未捕捉例外，且既有 DOM 可能停留：[app.js:255](C:/Users/liang/projects/NHI-main-fix/app.js:255)、[app.js:282](C:/Users/liang/projects/NHI-main-fix/app.js:282)、[app.js:305](C:/Users/liang/projects/NHI-main-fix/app.js:305)。
- **為什麼現在不修之後會更貴：**F13 目前寫「core 判 `invalid`」，可能被實作成測 validator reason，而沒有驗證真實 app 狀態及使用者文案；這會放過 ready 後的 uncaught crash。
- **建議修法：**在規格中明訂 F13 的期望是 `state.core === 'error'` 且錯誤種類為 `invalid`，並以初始載入路徑完成 fail-closed。另把「若錯誤漏到 ready 後，現行搜尋路徑沒有 catch」記為判定關鍵欄完整性的理由。不是要求新增全域 catch。

## 2. 架構風險

### 2.1 High — §9.2 第 3 點錯稱「單列錯位由長度檢查擋住」

- **嚴重度：High**
- **問題：**長度檢查只能擋缺欄、多欄或整體位移造成長度改變，擋不住同長度 swap、同型別欄位互換，或某一列把值放到錯誤位置。規格自己先前已正確指出「單列錯位後仍是合法 JSON」：[spec-index-format.md:326](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:326)，但 §9.2 又宣稱由全量長度檢查擋住：[spec-index-format.md:722](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:722)。例如 `chName`／`enName` 互換仍同長、同型別，runtime shape 與 builder type 都會通過。
- **為什麼現在不修之後會更貴：**這是推翻第二輪 2.7 的主要安全論據之一；若以錯誤論據完成實作，後續會高估 runtime 防線，並錯寫殘餘風險與驗收覆蓋。
- **建議修法：**把第 3 點限縮為「長度檢查擋缺欄／多欄造成的結構錯位」；同長度、型別相容的錯位明列為 builder／F1／F4 防線及接受的殘餘風險。無須引入 representation hash，故不衝突於 (a)。

其餘三點在既定威脅模型下成立：

1. builder 是唯一發布寫入者，但前提是 §5.7 真正接上發布路徑。
2. 正常 CDN 混批只帶來版本組合，不會自行產生新型別。
3. runtime type 驗證本來就擋不住「型別正確但值被替換」。

### 2.2 Medium — F12「先完成」只有敘述，尚未成為可驗收依賴

- **嚴重度：Medium**
- **問題：**§9.2 要求 F12 先於 runtime 精簡：[spec-index-format.md:732](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:732)，但 F10、F13 沒明訂其執行前提為「同一 revision 的 F12 已通過」。目前可以先精簡 runtime、先量到 F10 綠燈，再補 builder；單看各報告會出現一段假綠。
- **為什麼現在不修之後會更貴：**一旦效能數字先被採認，後續 builder validator 若增加成本或改變產物，可能不會重跑同一組驗收，重演 v0.3「量到另一個方案」。
- **建議修法：**把 F12 設為 F10／F13 的明確 gate；三者必須針對相同 revision 與相同 index artifact。若所有變更單一原子合併，無須要求每個中間 commit 都可部署。

### 2.3 Low — §10 同時保留 v0.3 與 v0.4 互斥敘述

- **嚴重度：Low**
- **問題：**§10 先稱「§4.1.1 runtime 全量驗證」覆蓋 decoder 系統性錯誤，下一段才說 v0.4 runtime 不再全量驗 type：[spec-index-format.md:745](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:745)、[spec-index-format.md:750](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:750)。前段沒有標為歷史敘述或已被取代。
- **為什麼現在不修之後會更貴：**後續風險評估可能引用錯段，誤認 runtime 仍有完整 type 防線。
- **建議修法：**以 v0.4 單一現行敘述取代舊段，或明確標注舊段只適用 v0.3。

最難回頭的決策是把信任邊界由「builder＋runtime 雙重全量 type」移到「builder 全量＋runtime 選定欄位」。它不改資料格式，但會同步固化驗收、殘餘風險與效能門檻；尤其 F7b 還把「JS 必須放行」寫成契約，日後補回任何廉價檢查都會被視為回歸。

## 3. 驗證策略缺口

### 3.1 Medium — F7a 可被「漏驗 code」及過度拒絕型 validator 通過

- **嚴重度：Medium**
- **問題：**弱化實作可完全不驗 `code` 的非空字串性，只驗排序；F7a 列出的反例沒有 code 非字串／空字串：[spec-index-format.md:575](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:575)。另一弱化版本可對多數輸入一律回 `invalid`，只特判 mismatch fixtures；F7a 沒要求合法共通層 fixture 回 `ok`。
- **為什麼現在不修之後會更貴：**code 是排序、byCode、URL 與 exact match 的共同鍵；漏驗會擴散到所有入口。過度拒絕則可能直到真實資料載入才被發現。
- **建議修法：**新增斷言：
  - code 空字串、number、null 各自為 `invalid`。
  - 最小合法 fixture 與含合法附加欄位 fixture，JS/Python 都必須 `ok`。
  - reason 優先序使用明確組合矩陣：最小結構錯＋mismatch、format mismatch＋schema 錯、dataVersion mismatch＋schema 錯。
  - 補入 `chName`／`enName`／`ingredient` 的逐欄錯型別案例。

### 3.2 Medium — F7b 的「等」允許只驗代表欄位

- **嚴重度：Medium**
- **問題：**弱化 validator 可只驗列出的單一 date、單一 number、`rawPrice`、一個 count 與 flags，卻漏掉其他 nullable number、`crossesStop`、其餘 drug/window 字串欄，仍宣稱涵蓋「等」：[spec-index-format.md:576](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:576)。
- **為什麼現在不修之後會更貴：**runtime 已刻意放行 builder-only 類別，任何矩陣缺口都等於零防線，而非少一道防線。
- **建議修法：**把 F7b 改為以 §3.3 的每個已知欄位為列、其允許型別/nullability/value boundary 為欄的完整矩陣；每案只破壞一個性質。另加合法邊界正例，例如 nullable 欄為 null、0 count、空 flags，Python 與 JS 均須符合該層預期。

### 3.3 Medium — F10 未綁定可稽核的實際 revision／artifact

- **嚴重度：Medium**
- **問題：**弱化流程可在較快的 engine 或舊 index 上完成量測，之後再修改正式實作；文字雖說量本分支正式實作，但報告沒有要求 commit、工作樹狀態及測量 artifact 身分：[spec-index-format.md:514](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:514)、[spec-index-format.md:579](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:579)。
- **為什麼現在不修之後會更貴：**這會再次把不存在或已改變的方案數字當成合併依據，正是 v0.3 的失敗模式。
- **建議修法：**`[新增需求]` F10 報告記錄被測 commit、engine 與 index artifact 的 hash、Chromium 版本及原始各輪數字；F7a、F12、F13 與 F10 必須對同一 revision 全綠。具體後果是無法證明效能數字屬於待合併版本。

### 3.4 Medium — F12 的筆數與尾端注入不能證明完整 traversal

- **嚴重度：Medium**
- **問題：**弱化 validator 可只驗第一列與最後一列，卻直接把 `rows.length`／總 window 長度當回報值；最後列注入與 count 仍會全過。另一版本可在發布路徑只跑 builder 層，common 層只在孤立測試跑；F12 目前只要求注入 builder 層錯誤：[spec-index-format.md:582](C:/Users/liang/projects/NHI-main-fix/spec-index-format.md:582)。
- **為什麼現在不修之後會更貴：**中段四萬多列將沒有任何 type 防線，且報表仍顯示「全量驗證」。
- **建議修法：**完整 build 路徑至少分別在第一／中間／最後 drug row 與 window row 注入錯誤，並同時涵蓋一個 common 層錯誤及一個 builder-only 錯誤；每案都須 build fail、零寫入。另明訂成功基準 build 必須完成並輸出動態計數，避免 reject-all validator。

### 3.5 Medium — F13 可被 reject-all 或錯誤狀態名稱通過

- **嚴重度：Medium**
- **問題：**弱化實作可讓所有 index 一律失敗，所有負例自然都是「不可搜尋」；F13 沒要求每個欄位的合法鄰近值通過。另「core 判 `invalid`」不是現行 app state，實際 state 是 `error`，`invalid` 是 `LoadError.kind`：[app.js:13](C:/Users/liang/projects/NHI-main-fix/app.js:13)、[app.js:131](C:/Users/liang/projects/NHI-main-fix/app.js:131)。
- **為什麼現在不修之後會更貴：**測試可能測錯屬性，或把「站台永遠不可用」當成 fail-closed 成功。
- **建議修法：**每個欄位加入合法／非法成對案例；合法案例須 `core === 'ready'` 且可搜尋，非法案例須 `core === 'error'`、錯誤種類為 `invalid`、搜尋 disabled、結果清空、顯示核心錯誤而非「查無結果」。`priceState`／`eventType` 另須測「型別正確但值域外」。

## 4. 更簡單的替代方案

### 4.1 Low — F7b 把「JS 必須回 ok」固化成負向 API 契約，略有 over-engineering

- **嚴重度：Low**
- **問題：**F7b 同時承擔兩件事：證明 Python 全量拒絕，以及禁止 JS 未來增加任何 builder-only 檢查。後者與 F10 的效能驗收重疊，且會讓日後加入成本可忽略的防禦也先造成測試失敗。
- **為什麼現在不修之後會更貴：**runtime 邊界會由效能決策變成 fixture 級永久 API；任何重新評估都需重寫大量 expected，而非只重新量測。
- **建議修法：**更簡單且與 (a) 相容的組合是：
  - 一份 Python columnar validator，builder 與轉換器共用。
  - runtime 只在既有 `prepareIndex` 必經 traversal 驗 shape＋完整判定關鍵欄。
  - F7a 驗 common semantics；F7b 只證明 Python 擋下 builder-only 矩陣。
  - 是否不慎加回昂貴 runtime 驗證由同 revision 的 F10 判定，不把「JS 必須放行每個 builder fixture」設成永久契約。

整體方案不算架構 over-engineering：一個共用 Python validator、一個既有 runtime traversal、兩層 fixture 與正式效能 gate，已接近此威脅模型下的最小組合。不能再簡化成純 shape；那會放掉搜尋命中、隱藏判定、uncaught crash 與未 escape render。

**總結：Blocker 0／High 2／Medium 6／Low 2；需修訂後動工。**
