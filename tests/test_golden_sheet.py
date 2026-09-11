"""golden 核對表：公式參照正確，以及 --freeze 的拒絕規則（plan.md D1、D3）。

LibreOffice 不在本機，無法預先重算；改為檢查公式字串的參照範圍，
並以 Python 依相同規則計算預期值比對。
"""

import json
import shutil

import pytest
from openpyxl import load_workbook

from lib.golden import GOLDEN_CODES
from lib.nhi import parse_csv
from scripts import golden_sheet as gs
from tests.helpers import SNAPSHOT

ROWS = parse_csv(SNAPSHOT.read_bytes())


@pytest.fixture
def sheet(tmp_path, monkeypatch):
    monkeypatch.setattr(gs, "OUT", tmp_path / "check.xlsx")
    monkeypatch.setattr(gs, "FIXTURES", tmp_path / "fixtures")
    (tmp_path / "fixtures").mkdir()
    gs.generate(ROWS)
    return tmp_path / "check.xlsx"


def fill(path, marks="✓", note="", verifier="王○明", when="2026-09-20", site=None, skip=()):
    """模擬藥師填表：所有代號（skip 除外）三欄填 marks；網站列數預設等於 CSV 列數。"""
    wb = load_workbook(path)
    table, summary, readme = wb["核對表"], wb["代號摘要"], wb["說明"]
    counts = {}
    for row in table.iter_rows(min_row=2):
        code = row[0].value
        counts[code] = counts.get(code, 0) + 1
        if code in skip:
            continue
        for cell in row[9:12]:
            cell.value = marks
        row[12].value = note
    for r in range(2, 2 + len(GOLDEN_CODES)):
        code = summary.cell(row=r, column=1).value
        if code not in skip:
            summary.cell(row=r, column=5).value = counts[code] if site is None else site
    for r in range(1, readme.max_row + 1):
        label = readme.cell(row=r, column=1).value
        if label == "核對人":
            readme.cell(row=r, column=2).value = verifier
        elif label == "核對日期（YYYY-MM-DD）":
            readme.cell(row=r, column=2).value = when
    wb.save(path)


def frozen(tmp_path):
    return sorted(p.stem.removeprefix("golden_") for p in (tmp_path / "fixtures").glob("*.json"))


def test_summary_formulas_reference_the_table(sheet):
    wb = load_workbook(sheet)
    summary, table = wb["代號摘要"], wb["核對表"]
    last = table.max_row
    for r in range(2, 2 + len(GOLDEN_CODES)):
        count = summary.cell(row=r, column=4).value
        assert count == f"=COUNTIF('核對表'!$A$2:$A${last},$A{r})"
        for col in (8, 9, 10, 11):
            formula = summary.cell(row=r, column=col).value
            assert all(f"'核對表'!${c}$2:${c}${last}" in formula for c in "JKL")
    codes_in_table = [row[0].value for row in table.iter_rows(min_row=2)]
    assert len(codes_in_table) == sum(1 for r in ROWS)
    assert {c for c, _, _ in GOLDEN_CODES} == set(codes_in_table)


def test_raw_price_text_keeps_trailing_zero(sheet):
    table = load_workbook(sheet)["核對表"]
    raws = [row[4].value for row in table.iter_rows(min_row=2)]
    assert "245.00" in raws and "22.90" in raws


def test_leading_zero_row_is_not_labelled_terminated(sheet):
    table = load_workbook(sheet)["核對表"]
    first = next(row for row in table.iter_rows(min_row=2) if row[0].value == "A020296321")
    assert first[5].value == "健保支付價 0 元（此前無有價紀錄）"
    assert "終止" not in first[5].value


def test_freeze_all_checked(sheet, tmp_path):
    fill(sheet)
    gs.freeze(sheet, ROWS)
    assert frozen(tmp_path) == sorted(c for c, _, _ in GOLDEN_CODES)
    data = json.loads((tmp_path / "fixtures" / "golden_BC05037209.json").read_text("utf-8"))
    assert data["verifiedBy"] == "王○明" and data["intervals"]


def test_freeze_skips_codes_with_mismatch_or_blank(sheet, tmp_path):
    fill(sheet, skip={"AB47689100"})
    wb = load_workbook(sheet)
    table = wb["核對表"]
    next(r for r in table.iter_rows(min_row=2) if r[0].value == "AC48092100")[10].value = "✗"
    wb.save(sheet)
    gs.freeze(sheet, ROWS)
    assert "AB47689100" not in frozen(tmp_path) and "AC48092100" not in frozen(tmp_path)
    assert len(frozen(tmp_path)) == len(GOLDEN_CODES) - 2


def test_unverifiable_rows_require_note(sheet, tmp_path):
    fill(sheet, marks="不可核對", note="")
    gs.freeze(sheet, ROWS)
    assert frozen(tmp_path) == []
    fill(sheet, marks="不可核對", note="網站無早期歷史，已抽核 CSV 原檔")
    gs.freeze(sheet, ROWS)
    assert len(frozen(tmp_path)) == len(GOLDEN_CODES)


def test_site_row_count_difference_requires_explanation(sheet, tmp_path):
    fill(sheet, site=1)
    gs.freeze(sheet, ROWS)
    assert frozen(tmp_path) == []


def test_missing_verifier_refuses(sheet):
    fill(sheet, verifier="")
    with pytest.raises(SystemExit):
        gs.freeze(sheet, ROWS)


def test_tampered_table_refuses(sheet):
    fill(sheet)
    wb = load_workbook(sheet)
    wb["核對表"]["E2"].value = "99.99"
    wb.save(sheet)
    with pytest.raises(SystemExit):
        gs.freeze(sheet, ROWS)


def test_existing_golden_is_never_overwritten(sheet, tmp_path):
    fill(sheet)
    target = tmp_path / "fixtures" / "golden_A017014321.json"
    target.write_text('{"sentinel": true}\n', encoding="utf-8")
    gs.freeze(sheet, ROWS)
    assert json.loads(target.read_text("utf-8")) == {"sentinel": True}


def test_generated_workbook_matches_committed_copy(tmp_path, monkeypatch):
    """docs/ 內提交的核對表必須由目前的程式與快照產生（內容逐格一致）。"""
    committed = gs.Path("docs") / "golden_check_2026-09-11.xlsx"
    if not committed.exists():
        pytest.skip("docs/golden_check_2026-09-11.xlsx 尚未產生")
    shutil.copy(committed, tmp_path / "committed.xlsx")
    monkeypatch.setattr(gs, "OUT", tmp_path / "fresh.xlsx")
    gs.generate(ROWS)
    a = load_workbook(tmp_path / "committed.xlsx")["核對表"]
    b = load_workbook(tmp_path / "fresh.xlsx")["核對表"]
    cells = lambda ws: [[c.value for c in row[:9]] for row in ws.iter_rows()]  # noqa: E731
    assert cells(a) == cells(b)
