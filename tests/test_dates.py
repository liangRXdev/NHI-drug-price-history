"""A1 日期正規化（plan.md §5 A1）。"""

from datetime import date

import pytest

from lib.history import normalize_rows
from lib.nhi import classify_date
from tests.helpers import make_row


@pytest.mark.parametrize("raw,is_end,expected", [
    ("  860301", False, (date(1997, 3, 1), "ok")),       # 6 碼＋前綴空白（實測格式）
    ("1040201", False, (date(2015, 2, 1), "ok")),
    ("9991231", True, (None, "open")),                   # 迄日哨兵
    ("", True, (None, "open")),                          # 空白迄日
    ("9991231", False, (date(2910, 12, 31), "ok")),      # 起日不得套用開放哨兵
    ("", False, (None, "blank")),
    ("1041301", False, (None, "invalid")),               # 非法月
    ("1050229", False, (date(2016, 2, 29), "ok")),       # 2016 閏年
    ("1060229", False, (None, "invalid")),               # 2017 非閏年
    ("20150201", False, (date(2015, 2, 1), "ok")),       # 西元 8 碼備援
    ("abc", True, (None, "invalid")),                    # 非法迄日不得變成開放
    ("10402", False, (None, "invalid")),                 # 位數不符
])
def test_classify_date(raw, is_end, expected):
    assert classify_date(raw, is_end) == expected


def _normalize_one(**kw):
    by_code, stats = normalize_rows([make_row(**kw)])
    return by_code["A000000100"], stats


@pytest.mark.parametrize("kw,error", [
    ({"frm": ""}, "blank_start"),
    ({"frm": "1041301"}, "invalid_date"),
    ({"to": "abc"}, "invalid_date"),
    ({"frm": "1060229"}, "invalid_date"),
    ({"frm": "1150301", "to": "1150201"}, "inverted_interval"),
])
def test_invalid_dates_become_invalid_records(kw, error):
    entry, stats = _normalize_one(**kw)
    assert entry["records"] == []
    assert [r["error"] for r in entry["invalid"]] == [error]
    assert stats["invalidRecords"] == 1


def test_invalid_end_date_never_becomes_open_interval():
    entry, _ = _normalize_one(to="abc")
    assert not any(r["to"] is None for r in entry["records"])


def test_start_sentinel_is_parsed_and_counted():
    entry, stats = _normalize_one(frm="9991231", to="9991231")
    assert entry["records"][0]["from"] == date(2910, 12, 31)
    assert stats["startSentinelRows"] == 1


def test_valid_boundaries_are_preserved():
    entry, _ = _normalize_one(frm="1150101", to="1150131")
    r = entry["records"][0]
    assert (r["from"], r["to"]) == (date(2026, 1, 1), date(2026, 1, 31))
