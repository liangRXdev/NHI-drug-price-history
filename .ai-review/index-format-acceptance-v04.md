# spec-index-format v0.4 驗收紀錄（B 方案）

- **日期**：2026-10-13
- **分支**：`feat/index-columnar-b`
- **被測 commit**：`43e0e1967a6d86427c7793e9d27fe33f988b118d`（工作樹 clean）
- **結論**：**F10 未通過 → 依 §6.2（v0.4 註記）本案終止**，不得合併 main

## F10（§9.2 驗收 gate：同一 commit、同一份 index）

| 項目 | 值 |
|---|---|
| 工具 | `scripts/measure_columnar_ab.mjs`（v0.3 驗收時使用的同一支，未修改） |
| 條件 | 7 輪交錯、每次冷 cache、CPU 4x、9 Mbps／60 ms、gzip level 6 |
| Chromium | 153.0.8010.12（Playwright 1.63.0） |
| `engine.js` SHA-256 | `44617977b2c41ac7f7d6b600fe900e84b04cb7c5ed708bd0d9aae71a5f5ee33e` |
| `data/drug_index.json` SHA-256 | `05aa7d066c85d345380268a52a71070da7aa818bea8e365db6ff4316e4f9effe` |
| legacy oracle SHA-256 | `92c388e9a7005227a22a54aed71451ec1d7ae8f68e7e1909e593de168ca1b9d2`（與 §7.0 鎖定值相符） |

| 對象 | fetchParse | prepare | **合計 median** |
|---|---|---|---|
| legacy | 3,442 | 194 | **3,656 ms** |
| current（B 正式實作） | 2,990 | 258 | **3,242 ms** |

原始合計值（不剔除離群）：

- legacy：3814, 3684, 3548, 3644, 3656, 3620, 3657
- current：3468, 3197, 3279, 3212, 3169, 3417, 3242

- 合計 ≤ 3,800 ms：**通過**（3,242）
- 相對同輪 legacy 改善 ≥ 500 ms：**未通過**（**414 ms**，11.3%）

量測只跑一次，不重跑。重跑到過門檻為止，就是 §7.1 F10 明文禁止的「取單次最佳值」。

### 帳目（與 v0.3 §9.1 對照，僅供歸因，不作驗收依據）

| | v0.3（2026-09-23） | v0.4（本次） |
|---|---|---|
| fetchParse 差（legacy − current） | 747 ms | **452 ms** |
| prepare 差（current − legacy） | +271 ms | **+64 ms** |
| 淨改善 | 460 ms | 414 ms |

- **B 方案在它負責的那一段生效了**：runtime 驗證成本從 +271 ms 降到 +64 ms（−207 ms），符合 §9.2 的預期。
- **淨改善反而下降，是因為 fetchParse 的差距縮水**：從 747 ms 降到 452 ms。兩次量的是同一份 index bytes（columnar 檔案沒變），legacy 也是同一個 oracle。
  - 這段差距純粹來自檔案大小（gzip 小 22.3%）和 `JSON.parse`，程式碼沒有動過，所以兩輪相差將近 300 ms，只能歸因於量測環境。
  - **推論**：fetchParse 差距的輪間變異約 300 ms，而 500 ms 門檻就落在這個變異範圍裡。這是觀察，不是調門檻的理由：§6.2 明文禁止事後調整門檻，也禁止換條件重量。

## 其餘驗收（同一 commit）

| 編號 | 結果 |
|---|---|
| F1 | 135,701 次比對（唯一 T 750 個），**0 差異** |
| F1-S | 注入 `A000015421` 的 `priceState`，差異**確實歸因到該 code** |
| F2 | 587,327 次比對（13 個 T），**0 差異**；今日 mask 同時含 true 31,337／false 13,842 |
| F4 | 轉換器 round-trip、determinism 通過；輸出 bytes 與 `data/drug_index.json` 完全相同 |
| F5 | e2e 4 案（缺漏／錯值／非字串／legacy 物件）→ `data-core=mismatch`、搜尋停用、只有 reload、`pageerror` 0 |
| F6 | 27 欄 × 4 種破壞 ＝ 108 案皆 `invalid`；附加欄位正例 `ok` |
| F7a／F7b | 共用 fixture 144 案（共通 81／builder 55／邊界正例 8），JS 與 Python 各自對 expected 全過 |
| F8 | pytest 414／node 476／e2e 203，0 failure、0 skip、0 todo |
| F9 | 經 `run()`／`main()` 完整路徑：等於門檻通過、超 1 byte 分別 warning／fail、fail 時零寫入 |
| F11a／F11b | legacy prior 與 columnar prior 下，消失代號 guard 都真的擋下；`min_row_pct_of_previous` 與差異判定正常 |
| F12 | 首／中／尾 × drug／window × 共通／builder 共 12 案皆 build fail、零寫入；成功基準回報動態計數；builder 與轉換器呼叫同一個 validator |
| F13 | e2e 28 案（14 欄 × 非法／合法鄰近值）：非法 → `data-core=error`＋`data-core-error=invalid`，合法 → ready 且可搜尋；`pageerror` 0 |

### 反向哨兵（確認測試抓得到弱化實作，驗完已還原）

- 拿掉 runtime `pricedBefore` 檢查 → F7a 兩案轉紅
- 在 runtime 加回 `from` 日曆日檢查 → F7b 兩案轉紅
- 拿掉 runtime drug `flags` 檢查 → F13 非法案轉紅
- `index_codes` 對 columnar 回空集合（模擬 `.get()`） → F11b 轉紅
