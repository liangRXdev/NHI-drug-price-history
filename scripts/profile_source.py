#!/usr/bin/env python3
"""來源 CSV profiling：重現 spec.md §3.1「實測特性」表的數據。

使用與正式 build 相同的解析（lib.nhi／lib.history），而非另寫一套規則，
使 profiling 結果與 ETL 行為一致。

用法：
  uv run python scripts/profile_source.py .cache/nhi_raw_2026-09-11.csv [--today 2026-09-11]
"""

import argparse
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.history import annotate_flags, derive_events, is_effective, normalize_rows  # noqa: E402
from lib.nhi import parse_csv  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def profile(raw, today):
    rows = parse_csv(raw)
    by_code, stats = normalize_rows(rows)
    records = []
    current_state, transitions = Counter(), Counter()
    adjacency = Counter()
    leading_zero = upcoming_codes = 0
    for entry in by_code.values():
        recs = entry["records"]
        annotate_flags(recs)
        derive_events(recs)
        records.extend(recs)
        cur = [r for r in recs if is_effective(r, today)]
        current_state[cur[0]["priceState"] if len(cur) == 1 else
                      ("conflict" if cur else "none")] += 1
        for a, b in zip(recs, recs[1:]):
            transitions[f"{a['priceState']}→{b['priceState']}"] += 1
            if a["to"] is not None:
                gap = (b["from"] - a["to"]).days
                adjacency["contiguous" if gap == 1 else "overlap" if gap < 1 else "gap"] += 1
        leading_zero += bool(recs) and recs[0]["priceState"] == "terminated" and any(
            r["priceState"] == "priced" for r in recs)
        upcoming_codes += any(r["from"] > today for r in recs)

    return {
        "sourceRowCount": stats["sourceRowCount"],
        "uniqueCodes": len(by_code),
        "codeLength": dict(Counter(len(c) for c in by_code)),
        "fromRange": [min(r["from"] for r in records).isoformat(),
                      max(r["from"] for r in records).isoformat()],
        "openEndedRowsPerCode": dict(Counter(sum(1 for r in e["records"] if r["to"] is None)
                                             for e in by_code.values())),
        "priceStates": dict(Counter(r["priceState"] for r in records)),
        "currentStateByCode": dict(current_state),
        "stateTransitions": dict(transitions.most_common()),
        "leadingZeroThenPricedCodes": leading_zero,
        "sameValueRenewals": sum(1 for r in records if r["eventType"] == "unchanged"
                                 and r["priceState"] == "priced"),
        "adjacentIntervals": dict(adjacency),
        "upcomingRows": sum(1 for r in records if r["from"] > today),
        "upcomingCodes": upcoming_codes,
        "changeFlag": dict(Counter(r["changeFlag"] or "(blank)" for r in records)),
        "duplicateRowsRemoved": stats.get("duplicateRowsRemoved", 0),
        "invalidRecords": stats.get("invalidRecords", 0),
        "questionMarkCodes": sum(1 for e in by_code.values()
                                 if any("?" in r["row"][k] for r in e["records"]
                                        for k in ("chName", "enName", "ingredient"))),
        "fillRatePct": {k: round(100 * sum(1 for r in rows if r[k]) / len(rows), 1)
                        for k in rows[0]},
    }


def main():
    p = argparse.ArgumentParser(description="NHI 來源 CSV profiling")
    p.add_argument("csv")
    p.add_argument("--today", default=date.today().isoformat())
    args = p.parse_args()
    result = profile(Path(args.csv).read_bytes(), date.fromisoformat(args.today))
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
