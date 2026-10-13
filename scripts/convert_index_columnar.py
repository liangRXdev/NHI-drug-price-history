"""legacy `drug_index.json` → `columnar/1`（spec-index-format.md v0.4）。

用法：
    uv run python scripts/convert_index_columnar.py <in.json> <out.json>
    uv run python scripts/convert_index_columnar.py <in.json> --check   # 只驗不寫

fail-closed（§5.3）：任何輸入格式、schema、round-trip 或 determinism 失敗，
一律不產生可發布結果，不留半成品。
"""
from __future__ import annotations

import json
import sys

# 繁中 Windows 的 stdout 預設跟著主控台字碼頁走（CP950），印 U+2713 之類的字元會
# 直接 UnicodeEncodeError 並中止整個腳本——訊息炸掉會被誤讀成轉換失敗。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib import index_format  # noqa: E402  ——validator 只有一份（§5.7），不在此另寫

INDEX_FORMAT = index_format.INDEX_FORMAT
FIELDS = index_format.FIELDS
WINDOW_FIELDS = index_format.WINDOW_FIELDS


class ConvertError(Exception):
    """任何一種失敗都用它；呼叫端一律不寫出結果。"""


def check_legacy_keys(d, i: int) -> None:
    """legacy 物件的 key 完整性（§3.4）。

    只有這件事屬於轉換器：columnar 是位置式，表達不出「缺 key」，轉換後就驗不到了。
    型別、值域、日曆日一律交給轉換後的 `index_format.validate_index`。
    """
    where = f"drugs[{i}]"
    if not isinstance(d, dict):
        raise ConvertError(f"{where}: 不是 object")
    for k in FIELDS:
        if k not in d:
            raise ConvertError(f"{where}: 缺少欄位 {k}")
    if not isinstance(d.get("window"), list):
        raise ConvertError(f"{where}: 缺少 window 或不是陣列")
    for r_i, r in enumerate(d["window"]):
        if not isinstance(r, dict):
            raise ConvertError(f"{where}.window[{r_i}]: 不是 object")
        for k in WINDOW_FIELDS:
            if k not in r:
                raise ConvertError(f"{where}.window[{r_i}]: 缺少欄位 {k}")


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
    for i, d in enumerate(drugs):
        check_legacy_keys(d, i)
        rows.append(
            [d[k] for k in FIELDS]
            + [[[r[k] for k in WINDOW_FIELDS] for r in d["window"]]]
        )

    col = {
        "dataVersion": legacy["dataVersion"],
        "indexFormat": INDEX_FORMAT,
        "fields": list(FIELDS),
        "windowFields": list(WINDOW_FIELDS),
        "rows": rows,
    }
    # 排序、唯一、型別、值域、日曆日全部由共用 validator 判（共通層＋builder 層）
    res = index_format.validate_index(col)
    if not res.ok:
        raise ConvertError(f"轉換結果不合法（{res.reason}）：{res.error}")
    return col


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
