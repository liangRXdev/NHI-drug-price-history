"""D2／D3：golden 代號的反例性質（凍結快照＋固定參考日期），以及 D1 人工核對 fixture 比對。

反例斷言直接由 2026-09-11 凍結快照推導，與日曆脫鉤：10/1 之後照樣可重現預告案例。
D1 的 golden_<code>.json 須經藥師於健保署網站核對後由 scripts/golden_sheet.py --freeze
產生；尚未核對的代號以 skip 顯示（Phase 1 在全部產生前不算完成）。
"""

import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from lib.golden import GOLDEN_CODES, golden_view
from lib.history import build_code, normalize_rows
from lib.nhi import parse_csv
from tests.helpers import SNAPSHOT

FIXTURES = Path(__file__).parent / "fixtures"
ROWS = parse_csv(SNAPSHOT.read_bytes())
BEFORE, AFTER = "2026-09-11", "2026-10-01"


def view(code):
    return golden_view(code, ROWS)


def test_snapshot_contains_exactly_the_golden_codes():
    assert {r["code"] for r in ROWS} == {c for c, _, _ in GOLDEN_CODES}
    assert sum(1 for _, _, counter in GOLDEN_CODES if counter) == 8


# ── D2 反例性質綁定 ─────────────────────────────────────────────
def test_AC48867100_relisting_compares_to_price_before_stop_and_is_not_counted():
    v = view("AC48867100")
    relisted = [e for e in v["events"] if e["eventType"] == "relisted"]
    assert len(relisted) == 1
    assert relisted[0]["previousPrice"] == "29.80" and relisted[0]["crossesStop"] is True
    changes = sum(e["eventType"] in ("increase", "decrease") for e in v["events"])
    assert v["summaries"][BEFORE]["priceChangeCount"] == changes


def test_A020296321_first_priced_not_relisted_and_leading_zero_has_no_prior_price():
    v = view("A020296321")
    assert [e["eventType"] for e in v["events"][:2]] == ["initial", "first_priced"]
    assert v["intervals"][0]["priceState"] == "terminated"
    assert v["events"][0]["previousPrice"] is None     # 前端據此顯示「此前無有價紀錄」


def test_B009254100_suspended_row_is_kept_with_raw_marker():
    v = view("B009254100")
    suspended = [i for i in v["intervals"] if i["priceState"] == "suspended"]
    assert suspended == [{"from": "2014-08-01", "to": "2015-01-31", "rawPrice": "-",
                          "priceState": "suspended"}]


@pytest.mark.parametrize("code,gap_day", [("BC23981100", "2020-06-01"),
                                          ("A035680329", "2010-09-15")])
def test_gaps_are_flagged_and_not_filled(code, gap_day):
    from lib.history import annotate_flags, derive_events, summary_at
    v = view(code)
    assert sum("gap_before" in e["flags"] for e in v["events"]) == 1
    by_code, _ = normalize_rows([r for r in ROWS if r["code"] == code])
    recs = by_code[code]["records"]
    annotate_flags(recs)
    derive_events(recs)
    assert summary_at(recs, date.fromisoformat(gap_day))["status"] == "gap"


def test_AB47689100_upcoming_price_is_not_current_before_effective_date():
    s = view("AB47689100")["summaries"]
    assert s[BEFORE]["current"]["rawPrice"] != "7.90"
    assert s[BEFORE]["upcoming"]["rawPrice"] == "7.90"
    assert s[AFTER]["current"]["rawPrice"] == "7.90"


def test_BC05037209_upcoming_termination_is_not_current():
    s = view("BC05037209")["summaries"]
    assert s[BEFORE]["status"] == "priced" and s[BEFORE]["current"]["rawPrice"] == "245.00"
    assert s[AFTER]["status"] == "terminated"
    assert s[AFTER]["latestEvent"] == {"eventType": "terminated", "from": "2026-10-01",
                                       "previousPrice": "245.00"}


def test_BC26467100_metadata_never_taken_from_corrupted_upcoming_row():
    assert "2412402210" not in view("BC26467100")["meta"][BEFORE]["ingredient"]
    by_code, _ = normalize_rows([r for r in ROWS if r["code"] == "BC26467100"])
    _, index_entry, flags = build_code("BC26467100", by_code["BC26467100"], date(2026, 9, 11))
    assert "2412402210" not in index_entry["ingredient"]
    assert "inconsistent_metadata" in flags


def test_percent_values_are_decimal_strings():
    for code, _, _ in GOLDEN_CODES:
        for e in view(code)["events"]:
            if e["percentChange"] is not None:
                assert Decimal(e["percentChange"]).as_tuple().exponent == -2


# ── D1 人工核對 fixture ─────────────────────────────────────────
@pytest.mark.parametrize("code", [c for c, _, _ in GOLDEN_CODES])
def test_output_matches_pharmacist_verified_golden(code):
    path = FIXTURES / f"golden_{code}.json"
    if not path.exists():
        pytest.skip(f"golden_{code}.json 尚未產生：等待藥師於健保署網站核對（plan.md D1）")
    golden = json.loads(path.read_text(encoding="utf-8"))
    assert golden["verifiedBy"] and golden["verifiedAt"]
    expected = {k: golden[k] for k in ("intervals", "invalidRecords", "events", "summaries", "meta")}
    actual = {k: v for k, v in view(code).items() if k != "code"}
    assert actual == expected
