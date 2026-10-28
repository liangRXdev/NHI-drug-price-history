#!/usr/bin/env python3
"""建置後、commit 前的全量對帳：upcoming.json 必須逐代號等於 history 分片的**全部**未生效列。

由 build-data workflow 在 `build_price_history.py` 之後執行，驗的是**本次新產物**
（spec-upcoming §9.1 U2）。原本這條在 pytest 內讀已發布的 data/，而 pytest 在 build
之前跑——驗到的是上一批，且未生效列自然歸零時會讓建置前測試失敗、整週不更新。

- 不符 → exit 1（workflow 停在 commit 前，產物不發布）
- 未生效列為 0（健保公告空窗期，可能為真）→ 只 WARNING，exit 0

用法：uv run python scripts/verify_upcoming.py data
"""

import json
import sys
from pathlib import Path


def _rows(data_dir):
    data_dir = Path(data_dir)
    published = json.loads((data_dir / "upcoming.json").read_text(encoding="utf-8"))
    build_date = published["buildDate"]
    expected = {}
    for path in sorted((data_dir / "history").glob("*.json")):
        shard = json.loads(path.read_text(encoding="utf-8"))
        for code, drug in shard["drugs"].items():
            rows = [(r["from"], r["rawPrice"], r["eventType"], r["priceState"])
                    for r in drug["records"] if r["from"] > build_date]
            if rows:
                expected[code] = rows
    actual = {}
    for it in published["items"]:
        actual.setdefault(it["code"], []).append(
            (it["effectiveDate"], it["rawPrice"], it["eventType"], it["priceState"]))
    return build_date, expected, actual


def reconcile(data_dir):
    """→ (errors, warnings)；errors 非空即不得發布。"""
    build_date, expected, actual = _rows(data_dir)
    errors, warnings = [], []
    for code in sorted(set(expected) | set(actual)):
        want, got = expected.get(code, []), actual.get(code, [])
        if want != got:
            errors.append(f"{code}：history 未生效列 {want} ≠ upcoming.json {got}")
    if not expected and not errors:
        warnings.append(f"history 在 buildDate {build_date} 之後無任何未生效列"
                        "（可能為真，健保公告有空窗期），對帳無母體")
    return errors, warnings


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    data_dir = argv[0] if argv else "data"
    errors, warnings = reconcile(data_dir)
    for m in warnings:
        print(f"⚠ WARNING：{m}", file=sys.stderr)
    for m in errors[:50]:
        print(f"✗ 對帳失敗：{m}", file=sys.stderr)
    if errors:
        print(f"✗ upcoming.json 與 history 不符 {len(errors)} 個代號，不得發布", file=sys.stderr)
        return 1
    print("✓ upcoming.json 與 history 全量對帳一致", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
