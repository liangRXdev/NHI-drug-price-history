# Phase 2 驗收紀錄（前端 dashboard）

> 2026-09-12；對應 `.ai-review/plan.md` v2.2 §5。自動化測試斷言見各測試檔；本文件記錄無法自動化的 C2 人工截圖審查與 E7 效能量測。

## 自動化覆蓋

| 驗收 | 測試 | 備註 |
|---|---|---|
| C1 | `tests-js/golden.test.mjs`（BC05037209、AB47689100 真實預告）、`tests-js/engine.test.mjs`（合成案例）、`e2e/app.spec.mjs`（前一天／當天／後一天 × 搜尋卡與詳細頁） | window 耗盡：engine＋e2e |
| C2 | `engine.test.mjs`（`chartModel()` 區段模型）、e2e（空窗段數、無 2910 年刻度） | 人工截圖見下 |
| C3 | engine（21／22／45／46 天、+08:00 換日、無法解析）、e2e（橫幅與現行價旁加註、404／損毀／壞時間） | |
| C4 | engine、e2e（>50 筆候選、render ≤ 50、跨欄位邊界不誤中） | |
| C5 | e2e（兩個不同 shard 代號開啟＋重新整理、載入中不顯示查無、站內切到不存在代號不殘留、專案子路徑、返回鍵） | |
| C6 | e2e（1280／390px 搜尋頁與詳細頁：全文、未截斷、頁面無橫向捲動） | |
| C7 | e2e（404→重試、損毀、缺代號、競態 A 慢 B 快、站內切換載入期間不殘留） | |
| C8／E6 | e2e（index／meta 404 與損毀、重試成功、index↔meta 與 shard↔meta 版本不一致） | |
| D2（前端側） | `golden.test.mjs`：11 代號 × 2 參考日，JS `summaryAt()`／`selectMeta()` 與藥師核對的 golden 逐欄相符 | 前端 fixture 由 `scripts/export_golden_frontend.py` 產生，`tests/test_golden_frontend.py` 防過期 |
| E1–E5 | engine、e2e | |

變異測試（手動，2026-09-12）：engine 10 個、app 7 個變異全部被殺；唯一存活的「空窗不斷線」為等價變異（connector 本身要求相鄰），已補行為測試。

## C2 人工截圖審查

`scripts/measure_e7.mjs` 以真實 `data/` 產生，存於 `.ai-review/screenshots/`：11 個 golden 代號 × 桌面 1280／行動 390，加搜尋頁。

- [ ] 臨床藥師目檢（待）：價格線只出現在有價區間、終止／暫停為區塊、空窗中斷、預告為虛線、恢復支付不與終止前價格相連

開發者自檢（2026-09-12）：AC48867100 終止區塊兩側不相連、恢復支付以 ◆ 標示；BC23981100 空窗與暫停區塊正確；手機版初版圖表 viewBox 固定 800 寬導致文字縮至約 5px，已改為依容器寬度出圖。

## E7 效能量測

條件：Chromium 151、CPU 4x throttle、網路 9 Mbps／1.5 Mbps／60 ms（近似 DevTools Fast 4G）、gzip level 6、全量真實資料（index raw 30.26 MB／gzip 3.28 MB）。每項 3 次，取中位數。

| 項目 | 目標 | 結果 | 判定 |
|---|---|---|---|
| index fetch 開始 → 解析完成 | （記錄） | 4,395／4,679／4,634 ms，中位 4,634 | 以下載為主（3.28 MB ≈ 2.9 s） |
| 解析完成 → 可搜尋 | < 200 ms | 488／428／378 ms，中位 428 | ✗ |
| 前 50 筆 render（JS：搜尋計算＋組 HTML） | < 100 ms | 計算 11–85 ms＋render 0–19 ms | ✓ |
| 同上，至畫面繪製完成（兩個 animation frame） | — | 37–284 ms | 含 layout／字型 |
| shard 取得後詳細頁（含 chart）render | < 300 ms | JS render 4–144 ms；response 結束→繪製：已開過詳細頁 211–437 ms、首次 1,071–1,539 ms | 首次 ✗ |

### 分析

- **解析完成 → 可搜尋**：主成本是 45k 筆搜尋字串的 `toLowerCase()`（無節流約 30–45 ms，4.3M 字元多為 CJK）與 30 MB JSON 解析後的 GC。已改平行陣列、已排序時跳過排序（無節流 44–68 ms → 相當），未能再降。
- **首次開詳細頁**：對照實驗擋掉 Google Fonts 後降為 537–686 ms，約 0.5 s 為 CJK 字型子集下載與重排（house style 刻意保留 Google Fonts）。
- **精簡 index（spec §16）的效益**：window 只留搜尋卡需要的欄位、省略預設值 → raw 30.26 → 25.04 MB、解析 −34%（無節流 260 → 171 ms），但 gzip 只少 6%（3.28 → 3.07 MB）；下載才是大頭，實際省約 0.3–0.4 s。屬 Phase 1 schema 變更，**未執行，待決定**。

原始數據：`.ai-review/screenshots/e7_measurement.json`（最後一次）。
