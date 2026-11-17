# 首訪啟動策略 驗收紀錄（spec-startup.md §8）

> 版本：2026-11-17　規格：`spec-startup.md` v0.3.2　分支：`feat/startup-fastpath`（HEAD `f5125bd`）
> 基準（legacy）：`7ac1760`　原始數據：`.ai-review/startup-measure.json`、`.ai-review/startup-m0.json`
>
> 狀態圖例：✅ 達標／⚠️ 部分達標（缺口明列）／⏳ 尚未執行。**未達標者直接寫未達標，不以較弱的版本代替。**

## 1. S1–S3 量測（§7、§7.2）

**指令**：`node scripts/measure_startup.mjs --a <legacy worktree 7ac1760> --b . --out .ai-review/startup-measure.json --blocks 5`

**條件**：CPU 4x、9 Mbps／60 ms、gzip level 6、冷 cache、SW 封鎖、Google Fonts abort；Chromium 158.0.8127.18；
兩側共用同一份 `data/`（`7ac1760..HEAD` 的 `data/` 無差異；dataVersion `sha256:a81eb238…`）。
5 個區塊、0 個作廢。代號與查詢為動工前凍結的腳本常數，未更動。

**環境**：AC 供電（BatteryStatus=2）、Windows 電源模式「最佳效能」（overlay `ded574b5`），起跑前後皆同。

| 固定工作量（單執行緒，8 次） | 中位數 | 全距 |
|---|---|---|
| 起跑前 | 2,277.9 ms | 1.4%（門檻 5%） |
| 跑完當下 | 2,533.3 ms（**+11.2%**） | 2.5% |
| 跑完後數分鐘再測 | 2,548.8 ms（**+11.9%**） | 3.4% |

> **使用者 2026-11-17 裁定：接受此漂移，本次量測有效，不重量。**
> 背景：跑後漂移 +11.2%，超過 M0 當時採用的作廢慣例 10%。
> 該 10% 不在 `spec-startup.md` 內（規格只凍結 §7 條件與 §7.2 判定），是 M0 起跑前另行約定的；本次量測前沒有重新約定。
> 事實：量測期間機器整體變慢約一成，legacy 與 candidate 的絕對值都隨區塊上升（見下表區塊 2–3）。
> 推論（非量測結果）：ABBAAB／BAABBA 交替使兩側承受相近的漂移；S1 最小餘裕 1,466.8 ms、S3 最小餘裕 928.2 ms，
> 遠大於一成漂移可造成的配對差；S2 餘裕 250.7 ms 相對較小，但 5 個差值有正有負、未隨漂移單向變化。
> 本工作目錄與量測基準程式（固定工作量）不同於 M0 當時所用，兩次的絕對值不可互比，只能各自看前後比。

### S1 `?code=` 導覽開始 → 詳情可互動（配對改善值＝legacy − candidate，ms）

| 代號（片） | 區塊 0 | 1 | 2 | 3 | 4 | 最小 | median |
|---|---|---|---|---|---|---|---|
| AC49155265（最大片） | 3,900.5 | 3,477.8 | 3,546.4 | 3,977.7 | 3,720.4 | 3,477.8 | 3,720.4 |
| B004922277（中位片） | 3,501.6 | 3,621.8 | 3,641.8 | 3,692.1 | 3,565.0 | 3,501.6 | 3,621.8 |
| NB01043100（最小片） | 3,475.4 | 3,466.8 | 3,663.5 | 3,869.1 | 3,704.9 | 3,466.8 | 3,663.5 |

各區塊 3 次的 median（legacy → candidate）：AC49155265 5,239.7→1,339.2／4,866.3→1,388.5／5,028.2→1,481.8／5,536.1→1,558.4／5,178.8→1,458.4；
B004922277 4,725.5→1,223.9／4,780.7→1,158.9／4,956.1→1,314.3／5,159.2→1,467.1／4,889.7→1,324.7；
NB01043100 4,605.0→1,129.6／4,611.7→1,144.9／4,974.5→1,311.0／5,303.2→1,434.1／5,016.5→1,311.6。

**判定（§7.2 第一列）**：15 個配對改善值全部 ≥ 2,000 ms（最小 3,466.8）→ **通過**，不需補測。前提 M0 的 V=113.5 ms ≤ 400 ms 成立。
假設 H2（改善約 4 秒）實測為約 3.5–4.0 秒。

### S2 首頁入口 導覽開始 → 可搜尋（配對差值＝candidate − legacy，ms）

| 區塊 0 | 1 | 2 | 3 | 4 | median | 門檻 |
|---|---|---|---|---|---|---|
| −108.5 | −63.9 | 74.5 | −289.6 | 33.9 | **−63.9** | ≤ V_home＝186.8 |

**判定**：median −63.9 ≤ 186.8 → **通過**。備註：區塊 3 的 |−289.6| 大於 M0 的 V_home（186.8），方向為 candidate 較快；
規格的判定量是 median，不是單一區塊，此處照規格判定並如實記錄。

### S3 `?code=` 入口 搜尋可用時刻的劣化（配對差值＝candidate − legacy，ms）

| 代號 | 區塊 0 | 1 | 2 | 3 | 4 | median | 上限 |
|---|---|---|---|---|---|---|---|
| AC49155265 | 200.7 | 613.6 | 617.0 | 571.8 | 521.7 | **571.8** | 1,500 |
| B004922277 | 497.7 | 344.4 | 425.6 | 597.1 | 489.5 | **489.5** | 1,500 |
| NB01043100 | 380.8 | 372.3 | 497.8 | 364.8 | 339.1 | **372.3** | 1,500 |

**判定**：三碼 median 皆 ≤ 1,500 ms → **不觸發停工**。限制 L1（`?code=` 入口的可搜尋時間變慢）實測約 0.4–0.6 秒。
每次量測皆通過事後驗證（`search-ready` 當下搜尋框非 disabled、切到搜尋頁後 300 ms 內得到預期首筆），否則該區塊會作廢；本次 0 作廢。

## 2. S1–S17 逐條狀態

| # | 狀態 | 證據 |
|---|---|---|
| S1 | ✅（環境漂移經使用者接受，見 §1） | §1；終點由 `scripts/measure_startup.mjs` 的 `probe()` 判定：強制 layout、點排序、等兩個 frame、首列日期等於另一端且 `aria-pressed` 翻轉 |
| S2 | ✅（同上） | §1；終點為固定查詢的結果首筆 `dataset.code` 等於該代號，不是搜尋框啟用 |
| S3 | ✅（同上） | §1；逐碼記錄，另含事後驗證 |
| S4 | ✅ | `e2e/startup-order.spec.mjs`「S4(a)(b)(c) meta 扣住 → shard 與 index 皆 0；shard body 未完 → index 0；body 完成 → index 1」（`expectCountStays('index', 0)`／`waitCount('index', 1)`）；「S4(d) shard 回 500」「S4(e) shard 版本不符」→「失敗也算落定，index 請求數為 1」 |
| S5 | ⚠️ | `e2e/startup-states.spec.mjs`「S5 M1」–「S5 M13」各組合。**缺口：M4 的「index idle」**在搜尋頁對外不可觀察（進搜尋頁即觸發 T2），現以兩條 loading 路徑代替（「S5 M4 …（首頁入口）」「S5 M4 … 由 T2 啟動後 loading（其他入口）」）。是否接受此替代**待使用者裁定** |
| S5b | ✅ | 同檔「S5b(a)」「S5b(b)」「S5b(c)」「S5b(d)」四支，標題即規格 (a)–(d) |
| S6 | ✅（一項未核對，見右） | 同檔「S6 <代號>（<類別>）：內容等於獨立預期值，且 index 未到與已發布時 #detail 逐字相同」共 14 支（golden 11 ＋合成 3），另「S6 補測 <代號>＠<參考日>（…）」6 支（2026-11-17 補，涵蓋 overlap、conflict、`pricedBefore` 三態）。§8.1 類別覆蓋見 §3。**殘餘缺口：「現行有價、單一區間」未逐筆核對是否有符合的代號** |
| S7 | ✅ | 同檔「S7(a) HTTP 500」「S7(b) 非 JSON」「S7(c) dataVersion 不符」「S7(d) body 逾時」→「#detail 零 mutation、節點仍在、排序不變、shard 不重抓、橫幅可操作」 |
| S8 | ✅ | `e2e/startup-notfound.spec.mjs`「S8 meta 永不回應＋合法代號」「S8 meta 500」「S8 shard 在途（第 4a 列）」、參數化的「S8 <條件> → 「<文案>」，不是查無」、「S8 shard map 不合法（<條件>）→ meta error，不是查無、不發 shard」、「S8 <空碼／非法字元>｜meta <狀態> → 查無此代號，shard 請求數 0」、「S8 前綴不在清單」、「S8 合法英數但非 10 碼…（不以長度短路）」；實際 `data/meta.json`：`e2e/real-data.spec.mjs`「正式資料：meta.json 的 shard map 通過 validateMeta」 |
| S9 | ✅ | 同檔「S9(a)」「S9(b)」「S9(c)」（詳情與比較頁各一組）「S9(d)」「S9(e)」「S9(f)(g) 比較頁」「S9(f) 比較頁：一個代號的條目結構壞」「S9(h)」「S9(i)」。(i) 為使用者 2026-11-16 指示後的版本 |
| S10 | ✅ | `e2e/startup-order.spec.mjs`：(a) 由 S4(a)(b)(c) 涵蓋；「S10(b)(c) T2：…popstate／點「回搜尋」／點「預告」」「…移除比較籃品項」；「S10(d)」三種零請求視圖；「S10(e)」「S10(f)」「S10(g)」。2026-11-17 補 3 支：「S10(b) 比較籃「增」：shard 未落定時無「＋比較」可按；落定後加入 → 不重新載入，index 請求數維持 1」、「…按比較籃「開始比較」」、「…按比較籃「清空」」。規格 v0.3.2（2026-11-17，使用者決策）已把 S10(b) 改為明列三個會重新載入的比較籃操作，並新增 (b′)「加入不是 T2 入口」；上述 3 支加上既有的「移除比較籃品項」即對應 (b) 的比較籃部分與 (b′) |
| S11 | ✅ | 同檔「S11 重試成功」「S11 重試再失敗」「S11 重試得到版本不符」「S11 重試在途時導覽到另一代號」；共用斷言「meta.json 請求數不得增加」「shard 請求數不得增加」「#detail 的 mutation」為空 |
| S12 | ✅ | 同檔「S12 meta 放行且版本相符」「S12 meta 放行但版本不符」「S12 meta 500 → 維持無外洩；retry-core 後 …」兩支；扣住期間以 `trackIndexLeak` 持續觀察，斷言「index 衍生內容曾經出現過」為全 false |
| S13 | ✅ | `e2e/startup-deeplink.spec.mjs` 7 支「S13 …」（兩個有效代號、`?view=upcoming`、兩種主要資源失敗、預告零 mutation、比較零 mutation＋chip 品名、`selectMeta` 回 null 的合成代號） |
| S14 | ✅ | `tests/test_build.py`：`test_s14_routing_guard_fails_publish_and_writes_nothing`（四種注入 × `allow_anomaly`）、`test_s14_longest_prefix_matches_independent_expectation`、`test_s14_routing_guard_honours_nested_prefixes`。實際資料的證據依規格為排程 build 本身，**合併後首次排程 build 尚未發生** |
| S15 | ✅ | pytest／`npm test`／`npm run e2e`；`e2e/real-data.spec.mjs`「正式資料：?code= 在 index 扣住時顯示詳情，內容等於由 shard 獨立算出的預期值；放行後可搜尋」 |
| S16 | ⚠️ | 自動部分 ✅：`tests-js/sw.test.mjs`「S16 sw.js：CACHE 值與基準不同」「…PREFIX、SHELL 清單、data/ 旁路判斷式與基準逐字相同」「…除 CACHE 一行外…」。**人工部分（已安裝舊版的裝置取得新版外殼，§8.2）未執行** |
| S17 | ⏳ | 部署後才能量（線上 GitHub Pages）。未執行 |

## 3. S6 的 §8.1 類別覆蓋

| 類別 | 案例 | 來源 |
|---|---|---|
| 現行有價 | AC48092100 等 | golden（是否為「單一區間」未逐筆核對） |
| 已終止 | A035680329、AC48845100、B009254100 | golden |
| 支付空窗（gap） | A035680329 等 2 筆 | golden |
| 區間重疊（overlap） | S000000101（同價重疊 → 仍顯示 10.00）、S000000102（異價重疊 → 不給確定價格），參考日 2020-08-01 | Python 生成器 fixture `golden_frontend_same_price_overlap.json`（測試用代號） |
| 來源衝突（conflict） | P000000201，參考日 2021-06-01（落在衝突組內） | Python 生成器 fixture `golden_frontend_priced_before_ambiguous.json`（測試用代號） |
| 含日期異常紀錄 | AC48000002 | **合成** |
| 有未來生效紀錄 | BC05037209、BC26467100 等 3 筆 | golden |
| `pricedBefore` 三態 | 數值：P000000204＠2023-06-01（「終止前 11.00 元」）；null：A020296321＠1996-01-01（「0 元（此前無有價紀錄）」）；前價不唯一：P000000201＠2023-06-01 | 同上 fixture；A020296321 為 golden |
| `selectMeta` 回 null | AC48000001 | **合成** |
| `metaVariants` | BC26467100 | golden |
| 紀錄數最多（24 筆） | A017014321 | golden |
| 合法英數但非 10 碼 | AC4809 | **合成** |

## 4. 測試結果（S15）

2026-11-17 於 HEAD `f5125bd`（工作目錄僅多出本文件與 `startup-measure.json`）實跑：

| 套件 | 結果 |
|---|---|
| `uv run pytest -q` | 367 passed |
| `npm test`（node --test） | 315 pass／0 fail／0 skipped |
| `npm run e2e`（Playwright，chromium） | 306 passed（補測前）；加入 S6／S10 補測 9 支後 **315 passed** |

S15 判定：✅（real-data smoke 為上表 e2e 之一）。

## 5. 尚未執行的項目（不得視為已驗）

- §8.2 藥師目檢（≥ 5 個熟悉代號，含 ≥ 1 已終止、≥ 1 有預告，與線上現行版逐項核對）。
- §8.2 手機實機 deep link 與舊版外殼更新（S16 人工部分）。
- S17 線上回頭客量測（部署後）。
- S14 的實際資料證據（合併後首次排程 build）。
- §9 step 8 `/codex-review`。

## 6. 實作期間已告知使用者的行為變更

- `e2e/app.spec.mjs` 4 支舊測試依新規格改寫（C5、C8 index 404／corrupt、E6 index mismatch）。
- e2e「M7 meta 缺該片版本」依 §5.7 改為預期 meta error。
- 比較頁在資料矛盾時顯示「資料載入失敗（分片中缺少此代號）」；顯示位置為實作者的選擇，非規格指定。
