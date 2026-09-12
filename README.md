# NHI Drug Price History — 台灣健保藥價歷史查詢

以健保藥品代號為單位，呈現 1995-03-01（健保開辦）至今、含已公告未生效的完整健保支付價歷史。

> 本系統顯示中央健康保險署公告之健保支付價，不代表醫療院所實際採購價、零售價或病人自付金額。

- 規格（資料模型與規則）：[`spec.md`](spec.md)
- 驗收條件（A1–E7）：[`.ai-review/plan.md`](.ai-review/plan.md)
- 資料來源：健保署「健保用藥品項查詢項目檔」（`A21030000I-E41001-001`），每週檢查、官方月更

## 目前進度

- [x] Phase 1 資料層：ETL、index／history shards、guards、單元測試、CI workflow
- [x] Phase 1 golden 人工核對：11 個代號、114 列於健保署查詢網站核對全數相符（2026-09-11），已凍結為 `tests/fixtures/golden_*.json`
- [x] Phase 2 前端 dashboard：搜尋、摘要、手刻 SVG 階梯圖、歷史表、`?code=` deep link、過期警示、四態載入與競態（驗收紀錄：[`.ai-review/phase2-acceptance.md`](.ai-review/phase2-acceptance.md)）
- [ ] Phase 2 待辦：C2 截圖藥師目檢、E7 兩項未達標待決定、啟用 GitHub Pages

## 資料語意（摘要）

| 來源支付價 | 狀態 | UI |
|---|---|---|
| 正數 | `priced` | 金額 |
| `0`／`0.00` | `terminated` | 健保支付價 0 元（已終止支付）；此前從未有價者改為「此前無有價紀錄」 |
| `-`／`－`／`—` | `suspended` | 暫停支付（來源標示 `-`） |
| 空白 | `missing` | 來源無支付價資料 |
| 其他 | `malformed` | 資料格式異常（顯示原始值） |

有效迄日 `9991231` 為開放迄日。現行支付價由前端依瀏覽器日期判定；詳細頁由完整 history 推導。

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
- `test.yml`：PR 與 push 時執行測試（唯讀）
