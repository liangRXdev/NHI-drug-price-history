"""legacy `drug_index.json` → `columnar/1`（spec-index-format.md v0.3）。

用法：
    uv run python scripts/convert_index_columnar.py <in.json> <out.json>
    uv run python scripts/convert_index_columnar.py <in.json> --check   # 只驗不寫

fail-closed（§5.3）：任何輸入格式、schema、round-trip 或 determinism 失敗，
一律不產生可發布結果，不留半成品。
"""
from __future__ import annotations

import json
import re
import sys

# 繁中 Windows 的 stdout 預設跟著主控台字碼頁走（CP950），印 U+2713 之類的字元會
# 直接 UnicodeEncodeError 並中止整個腳本——訊息炸掉會被誤讀成轉換失敗。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")
from datetime import date
from pathlib import Path

INDEX_FORMAT = "columnar/1"

# §3.3 前綴欄位，順序即位置
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
PRICE_STATES = {"priced", "terminated", "suspended", "missing", "malformed"}
EVENT_TYPES = {"initial", "unknown", "unchanged", "terminated", "suspended",
               "increase", "decrease", "relisted", "first_priced"}

DATE_FIELDS_DRUG = {"firstEffectiveDate", "lastPriceChangeDate"}
DATE_FIELDS_WIN = {"from", "to"}
NULLABLE_DRUG = {"lastPriceChangeDate"}
NULLABLE_WIN = {"to", "price", "previousPrice", "pricedBefore", "absoluteChange", "percentChange"}

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ConvertError(Exception):
    """任何一種失敗都用它；呼叫端一律不寫出結果。"""


def is_calendar_date(v) -> bool:
    """真實日曆日，不只是外形（§3.3.2）。`2027-02-30` 與 `20260911` 都要拒絕。"""
    if not isinstance(v, str) or not ISO.match(v):
        return False
    y, m, d = (int(x) for x in v.split("-"))
    try:
        date(y, m, d)
    except ValueError:
        return False
    return True


def is_finite_number(v) -> bool:
    """number 且有限；**排除 bool**——Python 的 bool 是 int 子型別（§3.3.2）。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    return v == v and v not in (float("inf"), float("-inf"))


def is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _check_str(val, key, where, *, nullable=False, calendar=False):
    if val is None:
        if not nullable:
            raise ConvertError(f"{where}: {key} 不得為 null")
        return
    if not isinstance(val, str):
        raise ConvertError(f"{where}: {key} 型別錯（期望 string，實得 {type(val).__name__}）")
    if calendar and not is_calendar_date(val):
        raise ConvertError(f"{where}: {key} 不是真實日曆日 -> {val!r}")


def validate_drug(d: dict, i: int) -> None:
    where = f"drugs[{i}]"
    if not isinstance(d, dict):
        raise ConvertError(f"{where}: 不是 object")

    for k in FIELDS:
        if k not in d:                                   # §3.4 缺 key ＝ 失敗
            raise ConvertError(f"{where}: 缺少欄位 {k}")
    if "window" not in d:
        raise ConvertError(f"{where}: 缺少 window")

    for k in FIELDS:
        v = d[k]
        if k in ("historyCount", "priceChangeCount"):
            if not is_int(v) or v < 0:
                raise ConvertError(f"{where}: {k} 必須是非負整數（且非 bool）-> {v!r}")
        elif k == "flags":
            if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
                raise ConvertError(f"{where}: flags 必須是 array of string")
        else:
            _check_str(v, k, where,
                       nullable=k in NULLABLE_DRUG,
                       calendar=k in DATE_FIELDS_DRUG)

    if not d["code"]:
        raise ConvertError(f"{where}: code 不得為空字串")

    w = d["window"]
    if not isinstance(w, list):
        raise ConvertError(f"{where}: window 必須是陣列")
    for r_i, r in enumerate(w):
        rw = f"{where}.window[{r_i}]"
        if not isinstance(r, dict):
            raise ConvertError(f"{rw}: 不是 object")
        for k in WINDOW_FIELDS:
            if k not in r:
                raise ConvertError(f"{rw}: 缺少欄位 {k}")
        for k in WINDOW_FIELDS:
            v = r[k]
            if k in ("price", "previousPrice", "pricedBefore", "absoluteChange", "percentChange"):
                if v is not None and not is_finite_number(v):
                    raise ConvertError(f"{rw}: {k} 必須是有限 number 或 null -> {v!r}")
            elif k == "crossesStop":
                if not isinstance(v, bool):
                    raise ConvertError(f"{rw}: crossesStop 必須是 boolean")
            elif k == "flags":
                if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
                    raise ConvertError(f"{rw}: flags 必須是 array of string")
            elif k == "priceState":
                if v not in PRICE_STATES:
                    raise ConvertError(f"{rw}: priceState 不在值域 -> {v!r}")
            elif k == "eventType":
                if v not in EVENT_TYPES:
                    raise ConvertError(f"{rw}: eventType 不在值域 -> {v!r}")
            else:
                _check_str(v, k, rw,
                           nullable=k in NULLABLE_WIN,
                           calendar=k in DATE_FIELDS_WIN)


def to_columnar(legacy: dict) -> dict:
    if not isinstance(legacy, dict):
        raise ConvertError("輸入不是 object")
    if legacy.get("indexFormat"):
        raise ConvertError(f"輸入已經是 {legacy['indexFormat']}，拒絕重複轉換")
    if not isinstance(legacy.get("dataVersion"), str):
        raise ConvertError("缺少 dataVersion 或型別錯")
    drugs = legacy.get("drugs")
    if not isinstance(drugs, list):
        raise ConvertError("缺少 drugs 或不是陣列")
    if not drugs:
        raise ConvertError("drugs 為空——空 index 會把資料故障偽裝成零結果（§3.5）")

    rows = []
    seen_prev = ""
    for i, d in enumerate(drugs):
        validate_drug(d, i)
        code = d["code"]
        if code <= seen_prev:                            # §3.5 嚴格遞增＋唯一
            raise ConvertError(
                f"drugs[{i}]: code 未嚴格遞增（{seen_prev!r} -> {code!r}）；"
                "重複或未排序都不合契約")
        seen_prev = code
        rows.append(
            [d[k] for k in FIELDS]
            + [[[r[k] for k in WINDOW_FIELDS] for r in d["window"]]]
        )

    return {
        "dataVersion": legacy["dataVersion"],
        "indexFormat": INDEX_FORMAT,
        "fields": list(FIELDS),
        "windowFields": list(WINDOW_FIELDS),
        "rows": rows,
    }


def to_legacy(col: dict) -> dict:
    """反轉，供 round-trip 自檢（§7.1 F4）。只接受前綴相符的 columnar/1。"""
    if col.get("indexFormat") != INDEX_FORMAT:
        raise ConvertError(f"indexFormat 不是 {INDEX_FORMAT}")
    fields, wfields = col["fields"], col["windowFields"]
    if fields[:len(FIELDS)] != FIELDS or wfields[:len(WINDOW_FIELDS)] != WINDOW_FIELDS:
        raise ConvertError("fields／windowFields 的前綴與規格不符")
    n, m = len(fields), len(wfields)
    drugs = []
    for i, row in enumerate(col["rows"]):
        if len(row) != n + 1:
            raise ConvertError(f"rows[{i}]: 長度 {len(row)} ≠ {n + 1}")
        d = {fields[j]: row[j] for j in range(n)}
        w = row[n]
        if not isinstance(w, list):
            raise ConvertError(f"rows[{i}]: window 不是陣列")
        out_w = []
        for r_i, wr in enumerate(w):
            if not isinstance(wr, list) or len(wr) != m:
                raise ConvertError(f"rows[{i}].window[{r_i}]: 長度不等於 {m}")
            out_w.append({wfields[k]: wr[k] for k in range(m)})
        d["window"] = out_w
        drugs.append(d)
    return {"dataVersion": col["dataVersion"], "drugs": drugs}


def dumps(obj) -> bytes:
    """與 builder 一致的 canonical 序列化。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def legacy_canonical(d: dict) -> bytes:
    """比對用：只取 dataVersion 與 drugs，忽略 key 順序差異。"""
    return dumps({"dataVersion": d["dataVersion"], "drugs": d["drugs"]})


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    dst_arg = sys.argv[2]
    check_only = dst_arg == "--check"

    legacy = json.loads(src.read_bytes())
    col = to_columnar(legacy)

    # ── round-trip（§5.3、F4）────────────────────────────────
    back = to_legacy(col)
    if legacy_canonical(back) != legacy_canonical(legacy):
        raise ConvertError("round-trip 不相等——轉換有損，拒絕輸出")

    # ── determinism（§5.2）──────────────────────────────────
    if dumps(to_columnar(legacy)) != dumps(col):
        raise ConvertError("兩次轉換結果不同——非 deterministic，拒絕輸出")

    payload = dumps(col)
    wrows = sum(len(r[len(FIELDS)]) for r in col["rows"])
    print(f"drug rows 驗證 {len(col['rows']):,} 筆、window 列驗證 {wrows:,} 列")
    print(f"round-trip OK  determinism OK  輸出 {len(payload):,} bytes")

    if check_only:
        print("--check：未寫出檔案")
        return 0

    dst = Path(dst_arg)
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    tmp.write_bytes(payload)                              # 全有全無：先寫暫存再 rename
    tmp.replace(dst)
    print(f"已寫出 {dst}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ConvertError as e:
        print(f"轉換失敗（fail-closed，未寫出任何結果）：{e}", file=sys.stderr)
        sys.exit(1)
