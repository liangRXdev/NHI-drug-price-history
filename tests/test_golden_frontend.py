"""JS 交叉比對用的 golden 前端 fixture 必須與目前 ETL 輸出一致（否則 JS 測試比的是過期資料）。"""

from scripts.export_golden_frontend import (OUT, PB_OUT, SYNTH_OUT, render, render_priced_before,
                                            render_synthetic)


def test_golden_frontend_fixture_is_up_to_date():
    assert OUT.exists(), "請執行 uv run python scripts/export_golden_frontend.py"
    assert OUT.read_bytes() == render(), \
        "ETL 輸出已變動：請重跑 scripts/export_golden_frontend.py 並檢視 diff"


def test_synthetic_frontend_fixture_is_up_to_date():
    assert SYNTH_OUT.exists(), "請執行 uv run python scripts/export_golden_frontend.py"
    assert SYNTH_OUT.read_bytes() == render_synthetic(), \
        "ETL 輸出已變動：請重跑 scripts/export_golden_frontend.py 並檢視 diff"


def test_priced_before_frontend_fixture_is_up_to_date():
    assert PB_OUT.exists(), "請執行 uv run python scripts/export_golden_frontend.py"
    assert PB_OUT.read_bytes() == render_priced_before(), \
        "ETL 輸出已變動：請重跑 scripts/export_golden_frontend.py 並檢視 diff"
