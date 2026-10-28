#!/usr/bin/env python3
"""把 golden 凍結快照建成前端格式（shard entry＋index entry），供 JS 測試交叉比對。

前端 engine.js 須以相同規則重算參考日摘要（spec §5.5）。JS 測試讀這份檔案，
對照 tests/fixtures/golden_<code>.json（藥師核對過的預期值），兩種語言的
實作若有分歧即失敗。本檔由 ETL 產生，tests/test_golden_frontend.py 另檢查
它與目前 ETL 輸出一致，避免過期。

用法：
  uv run python scripts/export_golden_frontend.py
"""

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from build_price_history import build_outputs, dumps, upcoming_payload  # noqa: E402
from lib.golden import SNAPSHOT_DATE, SNAPSHOT_FILE  # noqa: E402
from lib.nhi import parse_csv  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / f"golden_frontend_{SNAPSHOT_DATE}.json"
# M2 跨語言合成案例：來源列與人工凍結預期值在 golden_same_price_overlap.json，
# 這裡只把來源列建成前端格式（shard＋各 index 日的 index entry）
SYNTH_IN = ROOT / "tests" / "fixtures" / "golden_same_price_overlap.json"
SYNTH_OUT = ROOT / "tests" / "fixtures" / "golden_frontend_same_price_overlap.json"
# pricedBefore 三態跨語言案例（spec §5.1）：另含各 index 日的 upcoming payload
PB_IN = ROOT / "tests" / "fixtures" / "golden_priced_before_ambiguous.json"
PB_OUT = ROOT / "tests" / "fixtures" / "golden_frontend_priced_before_ambiguous.json"


def render():
    rows = parse_csv((ROOT / SNAPSHOT_FILE).read_bytes())
    build_date = date.fromisoformat(SNAPSHOT_DATE)
    shards, index_drugs, upcoming_items, _ = build_outputs(rows, build_date)
    return dumps({
        "buildDate": SNAPSHOT_DATE,
        "shards": {code: entry for shard in shards.values() for code, entry in shard.items()},
        "index": {d["code"]: d for d in index_drugs},
        # e2e mock 的 upcoming.json 由此產生，確保與 Python 生成器同一套規則
        "upcoming": upcoming_payload(upcoming_items, "sha256:golden", build_date),
    })


def synth_rows(path=SYNTH_IN):
    from tests.helpers import make_row   # noqa: PLC0415（測試 helper，只在合成案例使用）
    spec = json.loads(path.read_text(encoding="utf-8"))
    rows = [make_row(code=code, price=r["price"], frm=r["from"], to=r["to"])
            for code, case in spec["codes"].items() for r in case["rows"]]
    return spec, rows


def render_synthetic(path=SYNTH_IN, with_upcoming=False):
    spec, rows = synth_rows(path)
    shards, index, upcoming = {}, {}, {}
    for d in spec["indexDates"]:
        s, drugs, items, _ = build_outputs(rows, date.fromisoformat(d))
        shards = {code: entry for shard in s.values() for code, entry in shard.items()}
        index[d] = {x["code"]: x for x in drugs}
        upcoming[d] = upcoming_payload(items, "sha256:golden", date.fromisoformat(d))
    out = {"shards": shards, "index": index}
    if with_upcoming:
        out["upcoming"] = upcoming
    return dumps(out)


def render_priced_before():
    return render_synthetic(PB_IN, with_upcoming=True)


def main():
    OUT.write_bytes(render())
    SYNTH_OUT.write_bytes(render_synthetic())
    PB_OUT.write_bytes(render_priced_before())
    for path in (OUT, SYNTH_OUT, PB_OUT):
        print(f"✓ → {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
