# 預告中心 驗收紀錄（spec-upcoming.md §9）

> 量測與逐條核對：2026-09-16
> 規格：`spec-upcoming.md` v0.3.1／實作：`feat(data): emit upcoming.json` 起共 6 個 commit

## 1. U14 效能量測（§8、§8.1 量測契約）

**量測方式**：`node scripts/measure_upcoming.mjs`（非 CI）。全量真實 `data/`（82 列 / 79 代號，
非空清單）、gzip level 6、CPU 4x throttle、9 Mbps／1.5 Mbps／60 ms、Service Worker 停用、
`meta.json` 視為已完成（首屏已載入）。起點＝點擊徽章那一刻；終點＝**版本驗證通過且完整
清單已渲染**（`upcoming-fetch-to-rendered`，骨架可捲動不算）。每項 3 次取中位數。

| 項目 | 目標 | 實測（中位數） | 判定 |
|---|---|---|---|
| 首屏預告資料傳輸增加 | 0 bytes | 進入預告頁前對 `upcoming.json` 的請求數 **0**（3 次皆是） | ✅ |
| `upcoming.json` gzip | < 20 KB | **7,861 bytes**（raw 49,696） | ✅ |
| fetch 開始 → 清單首次可捲動 | < 200 ms | **126 ms**（3 次：109／126／206） | ✅（第 3 次 206 ms 超標，見下） |
| 篩選／排序重繪 | < 50 ms | **13 ms**（每次取四種操作的最大值；3 次：12／36／13） | ✅ |
| 首屏外殼增量（HTML／CSS／engine.js／app.js） | 無門檻，須記錄 | gzip **27,694 → 38,296 bytes（+10,602，+38.3%）**<br>index.html +813／styles.css +617／engine.js +5,056／app.js +4,116 | 記錄 |

- 單次 206 ms 的離群值出現在冷啟動＋節流條件下，中位數仍為 126 ms；契約定的是中位數，判定達標。
- 外殼增量 +10.6 KB gzip 相對於首屏必載的 `drug_index.json`（3.28 MB gzip）約為 0.3%，不影響 E7 的既有瓶頸；
  E7 兩項未達標的結論不因本功能改變。
- gzip 20 KB 是**功能驗收**門檻，不是資料 guard：合法公告量成長導致超標時，記錄超標並重新評估門檻，
  不得因此刪減資料或擋下發布（§8.1）。資料層的 guard 仍是 §3.5 的 500 KB raw WARNING。

## 2. U1–U15 逐條狀態

| # | 狀態 | 證據 |
|---|---|---|
| U1 | ✅ | `tests/test_upcoming.py::test_u1_*`：與完整 history 雙向逐筆對應（預期值取自 shard，非待驗生成器）、`from = D` 排除、`invalidRecords` 排除 |
| U2 | ✅ | `test_u2_*`：合成 fixture（同代號 3 筆未生效、同日 2 筆不同紀錄）＋全量資料正對照（`X000342121`／`X000346219`／`X000359219` 的全部未生效列） |
| U3 | ✅ | `test_u3a`–`test_u3d` 四種選列情形 ＋ 真實案例 `BC26467100`（比對全部描述欄位值） |
| U4 | ✅ | `tests-js/upcoming.test.mjs`：§4.1 的 14 個序號各有合成案例與精確字串；序 4 三種 `eventType`；序 5／8 顯示停止前金額；序 11 顯示差額百分比；序 1／2／3／14 不得顯示為確定事件 |
| U5 | ✅ | `tests/test_build.py::test_u5_*`：來源列順序不同 → 位元組相同且內容正確；反向哨兵指名 `AB47689100` 的價格與差額精確變化 |
| U6 | ✅ | `test_u6_*`：生成失敗與驗證失敗兩種注入皆 exit 非 0、檔案內容與檔案集合皆不變；另有合法輸入的正對照 |
| U7a | ✅ | `test_u7a_*`：三條例行路徑，含「跨生效日後剛生效的列必須離開清單」 |
| U7b | ✅ | `test_u7b_*`：首次交付／`generatorVersion` 不符／遷移失敗後重試三條路徑，皆以 workflow 實際使用的 `git diff --staged` 路徑清單斷言 `data/upcoming.json` 進入 commit；另有穩定態不得誤判為遷移的反向哨兵 |
| U8 | ✅ | `e2e/upcoming-filters.spec.mjs`：生效日前一天／當天／後一天、混合、全數到期、真正空清單、`T < D`，以及「最後檢查日很新時不得壓掉到期提示」 |
| U9 | ✅ | 同檔：type × atc 四類交集、§4.1.1 的 8 個 type 各自的精確集合（含 `first_priced` 正例與 `terminated` 排除例）、`q`／`date`／`sort` 的重整／分享／返回／組合、無效值回預設 |
| U10 | ✅ | `e2e/upcoming.spec.mjs`：六種首次載入失敗；更新失敗分網路類（保留舊清單與舊 `buildDate`）與內容／版本類（清空）；失敗後重試恢復；延遲的舊回應不得覆蓋新畫面 |
| U11 | ✅ | 同檔：四種版本不一致（含 `dataVersion` 相同但 `generatorVersion` 不符）、`meta.json` 不可用視同不可用、取得一致資料後恢復 |
| U12 | ✅ | `tests-js/upcoming.test.mjs`：以 RFC 4180 解析器解回後逐列逐欄對應（順序與重數）、資料列數排除前言與標頭、`12.50`／`0.00`／三種暫停標記／空值／逗號／引號／換行／中文保真、BOM 存在；`e2e` 另驗檔名與實際下載內容 |
| U13 | ✅ | `e2e`：分組標題品項數＝該批次實際呈現列數；`flags` 提示歸屬正確的代號；行動裝置（390px）免責聲明全文可見且無水平捲動 |
| U14 | ✅ | 本文件第 1 節 |
| U15 | ✅ | `tests-js/upcoming.test.mjs`：合法缺值（描述欄位 `null`）通過；`priced + price=null`、`terminated + price=正數`、`everPriced` 與 `pricedBefore` 不一致等 18 種注入皆判為損毀 |

**測試總數**：`uv run pytest -q` 222 ／ `npm test` 154 ／ `npm run e2e` 105，全綠。

## 3. 規格偏離與決議

| 項目 | 處置 |
|---|---|
| §5.3 的 `type` 值域與 `other` 集合原文（`first_priced` 同時屬 `other` 與 `first_priced`）與 §4.1.1 互相衝突 | 以 §4.1.1 為準（它自稱完整值域，U9 亦依它列舉 8 個值）；`spec-upcoming.md` 已更新為 v0.3.1 並記錄理由 |
| 「更新失敗」在只進入一次頁面時不可達 | 每次進入預告頁都重新取一次（清單 7.9 KB gzip），使 §5.5 兩種失敗都是真實可達的路徑，而非只存在於測試注入 |
| `data/upcoming.json` 首次交付 | 以與已發布 index 相同的來源與 build 日（2026-09-12）在本機產出後隨程式碼一併 commit，`dataVersion` 與 `data/meta.json` 一致；§3.3.1 的遷移路徑仍保留供 `generatorVersion` 升版使用 |

## 4. 待辦（§9.2 人工項目）

- [ ] **臨床藥師目檢**：一次完整清單（82 列）＋ §9.1 指名的合成反例，確認 (1) 無 §4 禁止用語、
      (2) 無「終止／0 元」標籤誤用（特別是 `everPriced = false` 的合成案例）、(3) 實際呈現列數等於預期集合。
      執行 `node scripts/upcoming_review.mjs` 後兩個畫面並行：
      **http://127.0.0.1:8766/?view=upcoming** 為真實清單（82 列），
      **http://127.0.0.1:8767/?view=upcoming** 為合成反例（§4.1 的 14 個序號，18 列，品名即標明它要驗的規則）。
      合成清單在送出前會先過 `validateUpcoming()`，不會拿一份自己就不合法的資料目檢。
- [ ] 上線後手動 dispatch 一次 `Build Price History Data`，確認例行路徑在真實環境仍維持
      `upcoming.json` 與 `drug_index.json` 同進退（本機測試已涵蓋，但排程管線沒跑過就是沒驗過）。
