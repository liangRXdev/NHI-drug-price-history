#!/usr/bin/env python3
"""把 golden 凍結快照建成前端格式（shard entry＋index entry），供 JS 測試交叉比對。

前端 engine.js 須以相同規則重算參考日摘要（spec §5.5）。JS 測試讀這份檔案，
對照 tests/fixtures/golden_<code>.json（藥師核對過的預期值），兩種語言的
實作若有分歧即失敗。本檔由 ETL 產生，tests/test_golden_frontend.py 另檢查
它與目前 ETL 輸出一致，避免過期。

用法：
  uv run python scripts/export_golden_frontend.py
"""

import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from build_price_history import build_outputs, dumps, upcoming_payload  # noqa: E402
from lib.golden import SNAPSHOT_DATE, SNAPSHOT_FILE  # noqa: E402
from lib.nhi import parse_csv  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / f"golden_frontend_{SNAPSHOT_DATE}.json"


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


def main():
    OUT.write_bytes(render())
    print(f"✓ → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
