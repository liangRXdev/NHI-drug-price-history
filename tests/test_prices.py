"""A2 價格狀態（單列分類；逐筆守恆見 test_history.py）。"""

from decimal import Decimal

import pytest

from lib.nhi import classify_price


@pytest.mark.parametrize("raw,expected", [
    ("12.50", (Decimal("12.50"), "priced")),
    (" 9.90 ", (Decimal("9.90"), "priced")),
    ("0", (None, "terminated")),
    ("0.00", (None, "terminated")),
    ("-", (None, "suspended")),
    ("－", (None, "suspended")),
    ("—", (None, "suspended")),
    ("", (None, "missing")),
    ("abc", (None, "malformed")),
    ("-5", (None, "malformed")),
    ("-0", (None, "malformed")),
    ("N/A", (None, "malformed")),       # 藥師的「暫停」判斷只針對 "-"
    ("NA", (None, "malformed")),
    ("無", (None, "malformed")),
    ("NaN", (None, "malformed")),
    ("inf", (None, "malformed")),
    ("1,234.00", (None, "malformed")),
])
def test_classify_price(raw, expected):
    assert classify_price(raw) == expected


def test_priced_value_keeps_numeric_equality_but_raw_is_separate():
    value, state = classify_price("12.50")
    assert state == "priced" and value == Decimal("12.5") and float(value) == 12.5
