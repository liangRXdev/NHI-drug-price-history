import pytest


@pytest.fixture
def small_cfg():
    """小型 fixture 用的 guard 門檻：只放寬總量門檻，比例類 guard 維持正式值。"""
    from build_price_history import GuardConfig
    return GuardConfig(min_rows=1, min_codes=1)
