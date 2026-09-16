# NHI Drug Price History — 台灣健保藥價歷史查詢

以健保藥品代號為單位，呈現 1995-03-01（健保開辦）至今、含已公告未生效的完整健保支付價歷史。

> 本系統顯示中央健康保險署公告之健保支付價，不代表醫療院所實際採購價、零售價或病人自付金額。

- 規格（資料模型與規則）：[`spec.md`](spec.md)
- 功能規格：[`spec-upcoming.md`](spec-upcoming.md)（預告中心）、[`spec-compare.md`](spec-compare.md)（多代號比較）
- 驗收條件（A1–E7）：[`.ai-review/plan.md`](.ai-review/plan.md)
- 資料來源：健保署「健保用藥品項查詢項目檔」（`A21030000I-E41001-001`），每週檢查、官方月更

## 目前進度

- [x] Phase 1 資料層：ETL、index／history shards、guards、單元測試、CI workflow
- [x] Phase 1 golden 人工核對：11 個代號、114 列於健保署查詢網站核對全數相符（2026-09-11），已凍結為 `tests/fixtures/golden_*.json`
- [x] Phase 2 前端 dashboard：搜尋、摘要、手刻 SVG 階梯圖、歷史表、`?code=` deep link、過期警示、四態載入與競態（驗收紀錄：[`.ai-review/phase2-acceptance.md`](.ai-review/phase2-acceptance.md)；`/codex-review` 判定：[`.ai-review/verdict.md`](.ai-review/verdict.md)）
  - C2 截圖藥師目檢通過；E7 兩項未達目標，MVP 接受現況（2026-09-12）
- [x] 上線：https://liangrxdev.github.io/NHI-drug-price-history/
- [x] Phase 3：`TFDA-drug-info-search` 健保代號表新增「健保藥價歷史 → 查看 ↗」欄（2026-09-12，`62de833`，線上端到端驗證通過）
- [ ] Phase 5 多代號比較（`spec-compare.md`）：實作中
- [x] Phase 4 預告中心（`spec-upcoming.md`）：`data/upcoming.json`、`?view=upcoming` 清單、事件標籤、篩選排序分組、CSV 匯出（驗收紀錄：[`.ai-review/upcoming-acceptance.md`](.ai-review/upcoming-acceptance.md)；藥師目檢待執行）

## 資料語意（摘要）

| 來源支付價 | 狀態 | UI |
|---|---|---|
| 正數 | `priced` | 金額 |
| `0`／`0.00` | `terminated` | 健保支付價 0 元（已終止支付）；此前從未有價者改為「此前無有價紀錄」 |
| `-`／`－`／`—` | `suspended` | 暫停支付（來源標示 `-`） |
| 空白 | `missing` | 來源無支付價資料 |
| 其他 | `malformed` | 資料格式異常（顯示原始值） |

有效迄日 `9991231` 為開放迄日。現行支付價由前端依瀏覽器日期判定；詳細頁由完整 history 推導。

### `data/upcoming.json`（預告清單）

build 日 `D` 當下**尚未生效**（`from > D`）的全部紀錄，一列一筆，不合併同代號的多筆預告。

- 描述欄位（品名／成分／規格／劑型／ATC／藥商）取自 `D` 當日有效列，不取預告列本身；只有未來列的代號一律為 `null`
- `previousPrice` 是事件語意（終止／暫停續期依 `spec.md` §5.4 為 `null`），`pricedBefore` 是狀態語意（該列之前最後一個有價金額），兩者並存不可互相取代
- **「資料產生日」（`buildDate`）與「最後檢查日」（`status.json`）是兩個不同的日期**，相差數週屬正常：`buildDate` 只在來源有變、build 日跨過預告生效日、或生成規則遷移時才前進
- 與 `drug_index.json` 完全同進退；產生或驗證失敗 → exit 1，整批不發布

## 預告中心（`?view=upcoming`）

已公告、尚未生效的支付價異動清單，依生效日分組，可依事件型別／ATC／生效日／關鍵字篩選並匯出 CSV。
篩選狀態只寫在網址列（可分享、可重整），不寫 localStorage。

已知限制：

1. 只涵蓋健保署 CSV 中**已公告且尚未生效**的紀錄；健保署尚未寫入該檔的公告不會出現。
2. 資料每週檢查一次、官方月更；跨越生效日時清單會暫時落後，已生效的列會標「已生效（本站資料尚未重建）」並保留在清單中。
3. 同一代號的多筆預告**全部列出**，不合併、不判斷何者「最終生效」。
4. 預告列的品名等描述欄位取自資料產生日的有效列（非預告列本身）；若品名在生效時一併異動，本站會落後一個 build 週期。
5. **「資料產生日」與「最後檢查日」是兩個不同的日期**，相差數週屬正常（見上節）。
6. **CSV 的欄位型別由試算表軟體自行推斷**，本站無法控制：Excel 直接開啟可能把 `0.00` 顯示為 `0`、把代號當成科學記號。需要原值時請用「資料 → 從文字/CSV」匯入並將該欄指定為文字；檔案本身的位元組內容一律保真（UTF-8 with BOM、RFC 4180）。

## 建置

需要 [uv](https://docs.astral.sh/uv/)。

```bash
uv sync
uv run pytest -q                                   # 單元測試（golden 未核對者顯示 skip）
uv run python build_price_history.py               # 從官方端點下載並建置 data/
uv run python build_price_history.py --source-file .cache/nhi_raw_2026-09-11.csv --no-metadata
```

前端（無 build step；`index.html` + `app.js` + `engine.js` + `styles.css`，需 Node 22+ 跑測試）：

```bash
npm ci
npm test                                           # engine.js 純邏輯 + golden 交叉比對
npx playwright install chromium                    # 首次
npm run e2e                                        # DOM／viewport／競態（route mock）
node scripts/measure_e7.mjs                        # E7 效能量測 + C2 截圖（非 CI）
node scripts/measure_upcoming.mjs                  # U14 預告中心效能量測（非 CI）
node scripts/upcoming_review.mjs                   # 預告中心藥師目檢：8766 真實清單、8767 合成反例
node scripts/measure_compare.mjs                   # M17 多代號比較效能量測（非 CI）
node scripts/compare_review.mjs                    # 多代號比較藥師目檢：8768 真實四碼、8769 合成重合情境
node scripts/smoke_live.mjs                        # 部署後線上 smoke check（deep link、搜尋、資料版本、SW）
uv run python scripts/export_golden_frontend.py    # ETL 規則變動後重產 JS 用 golden fixture
```

- 任一 guard 失敗 → exit 1，`data/` 與 `status.json` 皆不寫入
- 資料無變動時只更新 `data/status.json`（前端過期警示依據）
- 語意異常 guard（價格異常列或代號消失 > 1%）可在 GitHub Actions 以 **Run workflow → allow_anomaly** 人工放行；排程觸發不得放行

## Golden 人工核對（Phase 1 完成條件）

1. 開啟 `docs/golden_check_2026-09-11.xlsx`，只填黃底格子
2. 於健保署藥品查詢網站逐列核對：✓／✗／不可核對（不可核對須寫明替代方式）
3. 「代號摘要」填網站列數；「說明」頁填核對人與日期
4. 凍結：`uv run python scripts/golden_sheet.py --freeze docs/golden_check_2026-09-11.xlsx`
   - 只有全部核對完成且無 ✗ 的代號會轉為 `tests/fixtures/golden_<code>.json`
   - 已存在的 golden 檔不覆寫
5. `uv run pytest -q` 中對應的 skip 轉為 pass

凍結快照 `tests/fixtures/source_snapshot_2026-09-11.csv` 由 `scripts/extract_snapshot.py` 從完整 CSV 逐位元組擷取；來源 sha256 記於同名 `.meta.json`。

## 部署

- GitHub Pages：Settings → Pages → Deploy from branch → `main` / `(root)`
- `build-data.yml`：每週一 02:00（台灣）檢查；`contents: write`；actions 皆 pin commit SHA
  - info.nhi.gov.tw 偶發 `RemoteDisconnected`（2026-09-12 連三次失敗、20 分鐘後重跑成功；TFDA 專案 2026-08-30 同樣現象）。失敗時不寫入任何檔案，下次排程或手動 Run workflow 即可
- `test.yml`：PR 與 push 時執行測試（唯讀）

## 授權

本專案程式碼採 [MIT License](LICENSE)。健保署公開資料之著作權與使用條款依原始來源規定，不在本授權範圍內。
