"""`drug_index.json` 的 `columnar/1` 表示法：常數與 validator（spec-index-format.md v0.4）。

**這是唯一一份 Python validator**（§5.7）：builder 的發布路徑與一次性轉換器都呼叫
`validate_index`，不得各寫一套——兩套 validator 漂移正是既有日期 validator 教訓的形態。

驗證分兩層（§4.1）：
- **共通層**：與 `engine.js` 的 `validateIndex`＋`prepareIndex` 等價，同一 fixture 必須得到
  同樣的 `{ok, reason}`（F7a）
- **builder 層**：只有這裡驗。runtime 刻意不驗（F7b 釘住），逐欄 type 的防線就在這一層，
  任何一格漏驗都等於零防線，而不是少一道防線

驗證對象是 **columnar 物件本身**（`rows` 與位置），不是轉換前的 legacy dict——
後者驗不到「組 row 時欄位順序錯」這類錯誤。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date

INDEX_FORMAT = "columnar/1"

# §3.3 前綴欄位，順序即位置。engine.js 的 INDEX_FIELDS／INDEX_WINDOW_FIELDS 必須逐字相同，
# 由 tests/fixtures/index_format_cases.json 的 `constants` 兩端各自比對擋漂移。
FIELDS = [
    "code", "chName", "enName", "ingredient", "dosageForm", "strength", "strengthUnit",
    "atcCode", "manufacturer", "firstEffectiveDate", "lastPriceChangeDate",
    "historyCount", "priceChangeCount", "flags",
]
WINDOW_FIELDS = [
    "from", "to", "price", "rawPrice", "previousPrice", "pricedBefore", "priceState",
    "eventType", "crossesStop", "changeFlag", "absoluteChange", "percentChange", "flags",
]

# §3.3.1 值域——由規格列舉，不引用實作檔
PRICE_STATES = frozenset({"priced", "terminated", "suspended", "missing", "malformed"})
EVENT_TYPES = frozenset({"initial", "unknown", "unchanged", "terminated", "suspended",
                         "increase", "decrease", "relisted", "first_priced"})

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 位置由常數表推導，不寫死數字（§3.7 前綴相符後，前 14／13 個位置固定）
_D = {k: i for i, k in enumerate(FIELDS)}
_W = {k: i for i, k in enumerate(WINDOW_FIELDS)}
_D_STR = [_D[k] for k in ("dosageForm", "strength", "strengthUnit", "atcCode", "manufacturer")]
_D_HAY = [_D[k] for k in ("chName", "enName", "ingredient")]
_W_NUM = [_W[k] for k in ("price", "previousPrice", "pricedBefore", "absoluteChange", "percentChange")]


class IndexFormatError(ValueError):
    """逐筆檢查失敗時內部使用；`validate_index` 一律轉成 `invalid`。"""


@dataclass(frozen=True)
class Result:
    ok: bool
    reason: str | None = None          # None | 'invalid' | 'version_mismatch'
    error: str | None = None           # 人看的失敗位置與原因
    drugs: int = 0                     # 實際走訪並通過的 drug row 數（F12：不得回報 len）
    windows: int = 0                   # 實際走訪並通過的 window 列數


# ── 型別判斷（§3.3.2 跨語言邊界）────────────────────────────────
def is_number(v) -> bool:
    """JS 的 `typeof v === 'number'`。**排除 bool**——Python 的 bool 是 int 子型別。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_finite_number(v) -> bool:
    return is_number(v) and math.isfinite(v)


def is_non_neg_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def is_calendar_date(v) -> bool:
    """精確 `YYYY-MM-DD` 且為真實日曆日。`2027-02-30` 與 `20260911` 都要拒絕。"""
    if not isinstance(v, str) or not ISO.match(v):
        return False
    try:
        date(int(v[0:4]), int(v[5:7]), int(v[8:10]))
    except ValueError:
        return False
    return True


def _is_str_list(v) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _prefix_matches(arr, want) -> bool:
    return (isinstance(arr, list)
            and len(arr) >= len(want)
            and arr[:len(want)] == want
            and all(isinstance(k, str) and k for k in arr)
            and len(set(arr)) == len(arr))


def _fail(where, msg):
    raise IndexFormatError(f"{where}: {msg}")


# ── 共通層：與 engine.js 等價（F7a）──────────────────────────────
def _check_drug_common(r, i, n_fields, prev_code):
    where = f"rows[{i}]"
    if not isinstance(r, list) or len(r) != n_fields + 1:
        _fail(where, "長度不符")
    code = r[_D["code"]]
    if not isinstance(code, str) or not code:
        _fail(where, "code 必須是非空字串")
    if code <= prev_code:
        _fail(where, f"code 未嚴格遞增（{prev_code!r} -> {code!r}）")
    for j in _D_HAY:
        if not isinstance(r[j], str):
            _fail(where, f"{FIELDS[j]} 必須是字串（haystack）")
    if not is_number(r[_D["historyCount"]]) or not is_number(r[_D["priceChangeCount"]]):
        _fail(where, "historyCount／priceChangeCount 必須是 number")
    if not isinstance(r[_D["flags"]], list):
        _fail(where, "flags 必須是陣列")
    if not isinstance(r[n_fields], list):
        _fail(where, "window 必須是陣列")
    return code


def _check_window_common(wr, where, m_fields):
    if not isinstance(wr, list) or len(wr) != m_fields:
        _fail(where, "長度不符")
    st = wr[_W["priceState"]]
    if not isinstance(st, str) or st not in PRICE_STATES:
        _fail(where, f"priceState 不在值域 -> {st!r}")
    ev = wr[_W["eventType"]]
    if not isinstance(ev, str) or ev not in EVENT_TYPES:
        _fail(where, f"eventType 不在值域 -> {ev!r}")
    if not isinstance(wr[_W["flags"]], list):
        _fail(where, "flags 必須是陣列")
    if not isinstance(wr[_W["from"]], str):
        _fail(where, "from 必須是字串")
    to = wr[_W["to"]]
    if to is not None and not isinstance(to, str):
        _fail(where, "to 必須是字串或 null")
    pb = wr[_W["pricedBefore"]]
    if pb is not None and not is_number(pb):
        _fail(where, "pricedBefore 必須是 number 或 null")


# ── builder 層：只有 Python 驗（F7b）─────────────────────────────
def _check_drug_builder(r, i):
    where = f"rows[{i}]"
    for j in _D_STR:
        if not isinstance(r[j], str):
            _fail(where, f"{FIELDS[j]} 必須是字串")
    if not is_calendar_date(r[_D["firstEffectiveDate"]]):
        _fail(where, "firstEffectiveDate 不是真實日曆日")
    lpcd = r[_D["lastPriceChangeDate"]]
    if lpcd is not None and not is_calendar_date(lpcd):
        _fail(where, "lastPriceChangeDate 不是真實日曆日或 null")
    for k in ("historyCount", "priceChangeCount"):
        if not is_non_neg_int(r[_D[k]]):
            _fail(where, f"{k} 必須是非負整數（且非 bool）")
    if not _is_str_list(r[_D["flags"]]):
        _fail(where, "flags 元素必須是字串")


def _check_window_builder(wr, where):
    if not is_calendar_date(wr[_W["from"]]):
        _fail(where, "from 不是真實日曆日")
    to = wr[_W["to"]]
    if to is not None and not is_calendar_date(to):
        _fail(where, "to 不是真實日曆日或 null")
    for q in _W_NUM:
        v = wr[q]
        if v is not None and not is_finite_number(v):
            _fail(where, f"{WINDOW_FIELDS[q]} 必須是有限 number 或 null")
    if not isinstance(wr[_W["rawPrice"]], str):     # 來源原字串，不得轉數字（§3.3.2）
        _fail(where, "rawPrice 必須是字串")
    if not isinstance(wr[_W["changeFlag"]], str):
        _fail(where, "changeFlag 必須是字串")
    if not isinstance(wr[_W["crossesStop"]], bool):
        _fail(where, "crossesStop 必須是 boolean")
    if not _is_str_list(wr[_W["flags"]]):
        _fail(where, "flags 元素必須是字串")


# ── 入口 ────────────────────────────────────────────────────────
def validate_index(doc, meta=None, *, builder: bool = True) -> Result:
    """→ `Result`。判定順序（§4.1，與 engine.js 一致，F7a 釘住）：

    1. 最小結構前提（object、`dataVersion` 為字串）→ `invalid`
    2. `indexFormat` 缺漏、非字串或不符 → `version_mismatch`
    3. `dataVersion` 與 meta 不符 → `version_mismatch`
    4. 其餘 schema／shape／排序／唯一性／判定關鍵欄（＋builder 層）→ `invalid`

    `meta` 為 None 時略過第 3 步與筆數比對（轉換器沒有 meta）。
    `builder=False` 只跑共通層——**僅供 F7a 測試與 JS 對照**，發布路徑一律用預設值。
    """
    if not isinstance(doc, dict) or not isinstance(doc.get("dataVersion"), str):
        return Result(False, "invalid", "最小結構前提不成立")
    # 缺漏／非字串／錯值一律 mismatch：缺 indexFormat 就是 legacy index（§3.6、§8 混批）
    if doc.get("indexFormat") != INDEX_FORMAT:
        return Result(False, "version_mismatch", f"indexFormat 為 {doc.get('indexFormat')!r}")
    if meta is not None and doc["dataVersion"] != meta.get("dataVersion"):
        return Result(False, "version_mismatch", "dataVersion 與 meta 不符")

    fields, wfields, rows = doc.get("fields"), doc.get("windowFields"), doc.get("rows")
    if not _prefix_matches(fields, FIELDS):
        return Result(False, "invalid", "fields 前綴不符或含非法元素")
    if not _prefix_matches(wfields, WINDOW_FIELDS):
        return Result(False, "invalid", "windowFields 前綴不符或含非法元素")
    if not isinstance(rows, list) or not rows:
        return Result(False, "invalid", "rows 必須是非空陣列")
    if meta is not None and len(rows) != meta.get("uniqueDrugCodeCount"):
        return Result(False, "invalid", "rows.length 與 meta.uniqueDrugCodeCount 不符")

    n, m = len(fields), len(wfields)
    drugs = windows = 0
    prev = ""
    try:
        for i, r in enumerate(rows):
            prev = _check_drug_common(r, i, n, prev)
            if builder:
                _check_drug_builder(r, i)
            for k, wr in enumerate(r[n]):
                where = f"rows[{i}].window[{k}]"
                _check_window_common(wr, where, m)
                if builder:
                    _check_window_builder(wr, where)
                windows += 1
            drugs += 1
    except IndexFormatError as e:
        return Result(False, "invalid", str(e), drugs, windows)
    return Result(True, None, None, drugs, windows)
