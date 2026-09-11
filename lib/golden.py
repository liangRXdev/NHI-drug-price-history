"""Golden 代號清單與 golden 檢視（Phase 1 驗收，見 .ai-review/plan.md §5 D1–D3）。

擷取凍結快照、產生人工核對表、凍結 fixture、build 時比對「已核對區間是否
被改寫」皆共用這裡的清單與 golden_view()，避免各處各自維護而漂移。
"""

from datetime import date

SNAPSHOT_DATE = "2026-09-11"
SNAPSHOT_FILE = f"tests/fixtures/source_snapshot_{SNAPSHOT_DATE}.csv"

# 固定參考日期：預告日前與預告生效日，使預告案例在 10/1 之後仍可重現
REFERENCE_DATES = ("2026-09-11", "2026-10-01")

# (代號, 驗證情境, 是否為反例代號)
GOLDEN_CODES = (
    ("A017014321", "最長歷史（24 列），含同價續期 94→94", False),
    ("AC48092100", "一般多次降價", False),
    ("AC48867100", "終止後恢復支付（29.80 → 0 → 22.90）", True),
    ("AC48845100", "現行已終止", False),
    ("B009254100", "有價 → 暫停 → 終止", True),
    ("BC23981100", "現行暫停，含 12 個月空窗", True),
    ("A035680329", "1 個月空窗後終止", True),
    ("BC05037209", "預告終止（2026-10-01）", True),
    ("AB47689100", "預告調價（2026-10-01 → 7.90）", True),
    ("BC26467100", "預告列成分欄損毀；metadata 不得取該列", True),
    ("A020296321", "首列 0 元後首次有價（first_priced）", True),
)


def _num(d):
    return None if d is None else str(d)


def _summary_json(s):
    cur, latest, total = s["current"], s["latestEvent"], s["totalChange"]
    return {
        "status": s["status"],
        "current": cur and {"from": cur["from"].isoformat(), "rawPrice": cur["rawPrice"]},
        "upcoming": s["upcoming"] and {"from": s["upcoming"]["from"].isoformat(),
                                       "rawPrice": s["upcoming"]["rawPrice"],
                                       "eventType": s["upcoming"]["eventType"]},
        "latestEvent": latest and {"eventType": latest["eventType"],
                                   "from": latest["from"].isoformat(),
                                   "previousPrice": _num(latest["previousPrice"])},
        "priceChangeCount": s["priceChangeCount"],
        "pricedCount": s["pricedCount"],
        "totalChange": total and {"absoluteChange": _num(total["absoluteChange"]),
                                  "percentChange": _num(total["percentChange"])},
    }


def golden_view(code, rows):
    """單一代號的來源列 → golden 預期值（intervals、事件、固定參考日摘要、描述欄位）。

    金額以字串保存（Decimal 原值），避免浮點表示在 fixture 中造成假差異。
    """
    from lib.history import (annotate_flags, derive_events, normalize_rows,
                             select_meta_row, summary_at)

    by_code, _ = normalize_rows([r for r in rows if r["code"] == code])
    entry = by_code[code]
    records = entry["records"]
    annotate_flags(records)
    derive_events(records)

    summaries, meta = {}, {}
    for ref in REFERENCE_DATES:
        day = date.fromisoformat(ref)
        summaries[ref] = _summary_json(summary_at(records, day))
        row = select_meta_row(records, day)
        meta[ref] = row and {k: row[k] for k in ("chName", "enName", "ingredient", "manufacturer")}

    return {
        "code": code,
        "intervals": [{"from": r["from"].isoformat(),
                       "to": r["to"].isoformat() if r["to"] else None,
                       "rawPrice": r["rawPrice"], "priceState": r["priceState"]}
                      for r in records],
        "invalidRecords": [{"rawFrom": r["rawFrom"], "rawTo": r["rawTo"],
                            "rawPrice": r["rawPrice"], "error": r["error"]}
                           for r in entry["invalid"]],
        "events": [{"eventType": r["eventType"], "previousPrice": _num(r["previousPrice"]),
                    "absoluteChange": _num(r["absoluteChange"]),
                    "percentChange": _num(r["percentChange"]), "crossesStop": r["crossesStop"],
                    "flags": sorted(r["flags"])}
                   for r in records],
        "summaries": summaries,
        "meta": meta,
    }
