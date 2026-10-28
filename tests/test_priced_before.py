"""pricedBefore 三態（spec.md §5.1、2026-10 裁決）：Python 端對照跨語言 golden。

衝突組（同 from/to 異價）之後、尚未出現單一有價列前，「之前最後一個 priced 金額」
沒有唯一答案；舊實作取組內排序最後的候選（字串序 "9.00" > "12.00"），等於以排序
結果作為價格優先權（§6.3）。預期值為人工凍結，前端 tests-js/golden.test.mjs 讀同一份。
"""

import json
from datetime import date
from pathlib import Path

import pytest

from build_price_history import build_outputs, upcoming_payload
from lib import history
from lib.history import annotate_flags, derive_events, normalize_rows
from tests.helpers import make_row

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_priced_before_ambiguous.json")
                    .read_text(encoding="utf-8"))
CODES = GOLDEN["codes"]
AMB = "AMBIGUOUS"


def rows_of(code):
    return [make_row(code=code, price=r["price"], frm=r["from"], to=r["to"])
            for r in CODES[code]["rows"]]


def all_rows():
    return [r for code in CODES for r in rows_of(code)]


def records_of(code):
    by_code, _ = normalize_rows(rows_of(code))
    recs = by_code[code]["records"]
    annotate_flags(recs)
    derive_events(recs)
    return recs


def wire(entry):
    """window／upcoming 列的 pricedBefore 線上編碼 → golden token；同時驗編碼本身合法。"""
    if entry.get("pricedBeforeAmbiguous") is not None:
        assert entry["pricedBeforeAmbiguous"] is True
        assert "pricedBefore" not in entry, "前價不唯一時不得輸出 pricedBefore 鍵（舊前端會誤判為從未有價）"
        return AMB
    assert "pricedBefore" in entry
    return entry["pricedBefore"]


def token(v):
    return AMB if v is history.AMBIGUOUS else (None if v is None else float(v))


@pytest.mark.parametrize("code", CODES)
def test_events_match_golden(code):
    assert [r["eventType"] for r in records_of(code)] == CODES[code]["events"]


@pytest.mark.parametrize("code", CODES)
def test_prior_prices_match_golden(code):
    assert [token(v) for v in history.prior_prices(records_of(code))] == CODES[code]["priors"]


@pytest.mark.parametrize("code,day", [(c, d) for c, case in CODES.items() for d in case["window"]])
def test_index_window_priced_before_matches_golden(code, day):
    _, index, _, _ = build_outputs(all_rows(), date.fromisoformat(day))
    entry = next(d for d in index if d["code"] == code)
    assert [[w["from"], wire(w)] for w in entry["window"]] == CODES[code]["window"][day]


@pytest.mark.parametrize("code,day", [(c, d) for c, case in CODES.items() for d in case["upcoming"]])
def test_upcoming_priced_before_matches_golden(code, day):
    _, _, items, _ = build_outputs(all_rows(), date.fromisoformat(day))
    got = [[it["effectiveDate"], it["rawPrice"], it["eventType"], it["previousState"], wire(it),
            it["everPriced"]] for it in items if it["code"] == code]
    assert got == CODES[code]["upcoming"][day]


@pytest.mark.parametrize("day", GOLDEN["indexDates"])
def test_upcoming_with_ambiguous_rows_passes_validator(day):
    build_date = date.fromisoformat(day)
    _, _, items, _ = build_outputs(all_rows(), build_date)
    assert history.validate_upcoming(upcoming_payload(items, "sha256:golden", build_date)) == []


def test_ambiguous_is_not_never_priced():
    """不唯一 ≠ 此前無有價紀錄：不得觸發 §5.3 首列 0 元例外（everPriced 必須為 true）。"""
    _, _, items, _ = build_outputs(all_rows(), date(2022, 6, 1))
    amb = [it for it in items if it.get("pricedBeforeAmbiguous")]
    assert amb and all(it["everPriced"] is True for it in amb)


def test_marker_is_absent_when_not_ambiguous():
    """旗標只在不唯一時出現：既有資料（0 例）重建後不得產生 diff。"""
    _, index, items, _ = build_outputs(all_rows(), date(2022, 6, 1))
    plain = [w for d in index for w in d["window"] if "pricedBefore" in w]
    plain += [it for it in items if "pricedBefore" in it]
    assert plain and all("pricedBeforeAmbiguous" not in x for x in plain)
