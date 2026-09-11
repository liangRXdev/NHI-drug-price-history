#!/usr/bin/env python3
"""Golden 代號人工核對表：產生 xlsx，或將核對完成的 xlsx 凍結為 golden fixture。

  產生：uv run python scripts/golden_sheet.py
        → docs/golden_check_2026-09-11.xlsx（黃底欄位由藥師於健保署查詢網站核對後填寫）
  凍結：uv run python scripts/golden_sheet.py --freeze docs/golden_check_2026-09-11.xlsx
        → tests/fixtures/golden_<code>.json（僅限該代號所有列皆已核對且無 ✗）

凍結規則（plan.md D1）：
- 核對人、核對日期必填
- 每列三個核對欄只能是 ✓ 或「不可核對」；有 ✗ 或空白的代號不凍結
- 標「不可核對」的列必須在備註寫明替代核對方式（例：抽核 CSV 原檔）
- 網站列數必填；與 CSV 列數不同時必須填寫漏列／多列說明
- 核對表內容必須與凍結快照逐列一致（防止拿過期的表凍結）
- 已存在的 golden 檔一律不覆寫（需重新核對時由人手動刪除舊檔）
"""

import argparse
import json
import sys
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.golden import GOLDEN_CODES, SNAPSHOT_DATE, SNAPSHOT_FILE, golden_view  # noqa: E402
from lib.nhi import parse_csv  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

OUT = Path(f"docs/golden_check_{SNAPSHOT_DATE}.xlsx")
FIXTURES = Path("tests/fixtures")
CHECK_VALUES = ("✓", "✗", "不可核對")

FONT = "Arial"
YELLOW = PatternFill("solid", fgColor="FFFF00")
HEAD = PatternFill("solid", fgColor="D9D9D9")
THIN = Side(style="thin", color="A6A6A6")

STATE_LABEL = {
    "priced": "有價",
    "terminated": "健保支付價 0 元（已終止支付）",
    "suspended": "暫停支付（來源標示 -）",
    "missing": "來源無支付價資料",
    "malformed": "資料格式異常",
}
EVENT_LABEL = {
    "initial": "首筆", "increase": "漲價", "decrease": "降價", "unchanged": "未變動",
    "terminated": "終止支付", "suspended": "暫停支付", "relisted": "恢復支付（跨越停止期間）",
    "first_priced": "首次有價", "unknown": "無法判定",
}

TABLE_HEAD = ["代號", "序", "有效起日", "有效迄日", "CSV 支付價原字串", "本站判定狀態",
              "本站事件", "前次有價", "變動 %",
              "網站：起迄日相符", "網站：支付價相符", "狀態判定同意", "備註"]
INPUT_COLS = "JKLM"          # 核對表中由藥師填寫的欄
SUMMARY_HEAD = ["代號", "驗證情境", "反例", "CSV 列數", "網站列數", "列數差",
                "漏列／多列說明", "✓ 數", "✗ 數", "不可核對數", "未填數", "狀態"]


def state_label(interval, event):
    """首列 0 元例外（spec §5.3）：此前從未有價的 0 元區間不得標為「終止」。"""
    if interval["priceState"] == "terminated" and event["eventType"] == "initial":
        return "健保支付價 0 元（此前無有價紀錄）"
    if interval["priceState"] == "terminated" and event["previousPrice"] is None:
        return "健保支付價 0 元（此前無有價紀錄）"
    return STATE_LABEL[interval["priceState"]]


def table_rows(rows):
    """→ [(code, 序, from, to, raw, 狀態, 事件, 前次價, %)]，順序即凍結快照的排序。"""
    out = []
    for code, _, _ in GOLDEN_CODES:
        v = golden_view(code, rows)
        for i, (iv, ev) in enumerate(zip(v["intervals"], v["events"]), start=1):
            out.append((code, i, iv["from"], iv["to"] or "（持續有效）", iv["rawPrice"],
                        state_label(iv, ev), EVENT_LABEL[ev["eventType"]],
                        ev["previousPrice"] or "", ev["percentChange"] or ""))
        for j, inv in enumerate(v["invalidRecords"], start=len(v["intervals"]) + 1):
            out.append((code, j, inv["rawFrom"], inv["rawTo"], inv["rawPrice"],
                        f"日期異常（{inv['error']}）", "", "", ""))
    return out


# ── 產生 ────────────────────────────────────────────────────────
def style_header(ws, row, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = Font(name=FONT, bold=True)
        cell.fill = HEAD
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = Border(top=THIN, bottom=THIN, left=THIN, right=THIN)


def build_readme(ws):
    ws.title = "說明"
    lines = [
        ("健保藥價歷史 golden 代號人工核對表", True),
        (f"資料來源：健保署「健保用藥品項查詢項目檔」{SNAPSHOT_DATE} 下載之凍結快照（{SNAPSHOT_FILE}）", False),
        ("目的：以獨立來源（健保署藥品查詢網站）逐列核對本站 ETL 對 11 個代號的判讀是否正確（plan.md D1）。", False),
        ("", False),
        ("填寫方式", True),
        ("1. 只填黃底格子；其他格子為本站輸出，請勿修改。", False),
        ("2. 「核對表」每列三個核對欄請填：✓（相符）／✗（不符）／不可核對（網站未提供該資訊）。", False),
        ("3. 標「不可核對」的列，請在備註寫明替代核對方式（例：已抽核 CSV 原檔）。", False),
        ("4. 「代號摘要」請填網站上看到的列數；與 CSV 列數不同時，請寫明漏列或多列。", False),
        ("5. 最下方填寫核對人與核對日期。", False),
        ("", False),
        ("時限：AB47689100、BC05037209 的預告生效日為 2026-10-01，請於該日前完成（網站可能不再顯示預告狀態）。", True),
        ("", False),
        ("範例列（格式示意，非實際資料）", True),
    ]
    for i, (text, bold) in enumerate(lines, start=1):
        ws.cell(row=i, column=1, value=text).font = Font(name=FONT, bold=bold)

    ex_row = len(lines) + 1
    for c, h in enumerate(TABLE_HEAD, start=1):
        ws.cell(row=ex_row, column=c, value=h)
    style_header(ws, ex_row, len(TABLE_HEAD))
    example = ["AC48867100", 4, "2017-12-01", "2018-04-30", "22.90", "有價",
               "恢復支付（跨越停止期間）", "29.80", "-23.15", "✓", "✓", "✓",
               "網站顯示 22.9，與原字串 22.90 數值相符"]
    for c, v in enumerate(example, start=1):
        cell = ws.cell(row=ex_row + 1, column=c, value=v)
        cell.font = Font(name=FONT, italic=True, color="7F7F7F")
        cell.number_format = "@"

    sign_row = ex_row + 3
    for offset, label in enumerate(("核對人", "核對日期（YYYY-MM-DD）")):
        ws.cell(row=sign_row + offset, column=1, value=label).font = Font(name=FONT, bold=True)
        cell = ws.cell(row=sign_row + offset, column=2)
        cell.fill = YELLOW
        cell.font = Font(name=FONT)
        cell.number_format = "@"
    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["B"].width = 18
    for col in "CDEFGHIJKLM":
        ws.column_dimensions[col].width = 14
    return sign_row


def build_table(ws, data):
    ws.title = "核對表"
    ws.append(TABLE_HEAD)
    style_header(ws, 1, len(TABLE_HEAD))
    for r in data:
        ws.append(list(r) + ["", "", "", ""])
    last = len(data) + 1
    prev_code = None
    for row in ws.iter_rows(min_row=2, max_row=last):
        code = row[0].value
        for cell in row:
            cell.font = Font(name=FONT)
            cell.number_format = "@"             # 保留 "12.50" 等原字串的尾零
            if code != prev_code:
                cell.border = Border(top=Side(style="medium"))
        for col in INPUT_COLS:
            ws[f"{col}{row[0].row}"].fill = YELLOW
        prev_code = code

    dv = DataValidation(type="list", formula1='"' + ",".join(CHECK_VALUES) + '"',
                        allow_blank=True, showErrorMessage=True,
                        errorTitle="請選擇", error="只能填 ✓、✗ 或 不可核對")
    ws.add_data_validation(dv)
    dv.add(f"J2:L{last}")
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = f"A1:M{last}"
    for col, width in zip("ABCDEFGHIJKLM", (13, 5, 12, 13, 12, 30, 22, 10, 9, 12, 12, 12, 36)):
        ws.column_dimensions[col].width = width
    return last


def build_summary(ws, last):
    ws.title = "代號摘要"
    ws.append(SUMMARY_HEAD)
    style_header(ws, 1, len(SUMMARY_HEAD))
    rng = f"'核對表'!$A$2:$A${last}"
    for i, (code, scenario, counter) in enumerate(GOLDEN_CODES, start=2):
        checks = {mark: "+".join(f'COUNTIFS({rng},$A{i},\'核對表\'!${c}$2:${c}${last},"{mark}")'
                                 for c in "JKL")
                  for mark in ("✓", "✗", "不可核對")}
        blank = "+".join(f'COUNTIFS({rng},$A{i},\'核對表\'!${c}$2:${c}${last},"")' for c in "JKL")
        ws.append([
            code, scenario, "是" if counter else "",
            f"=COUNTIF({rng},$A{i})",
            None,
            f'=IF(E{i}="","",E{i}-D{i})',
            None,
            f"={checks['✓']}",
            f"={checks['✗']}",
            f"={checks['不可核對']}",
            f"={blank}",
            f'=IF(K{i}>0,"未完成",IF(I{i}>0,"有不符","完成"))',
        ])
        for col in "EG":
            ws[f"{col}{i}"].fill = YELLOW
    total = len(GOLDEN_CODES) + 2
    ws.cell(row=total, column=1, value="合計")
    for col in "DHIJK":
        ws[f"{col}{total}"] = f"=SUM({col}2:{col}{total - 1})"
    for row in ws.iter_rows(min_row=2, max_row=total):
        for cell in row:
            cell.font = Font(name=FONT, bold=(cell.row == total))
    ws.freeze_panes = "B2"
    for col, width in zip("ABCDEFGHIJKL", (13, 40, 6, 9, 9, 8, 30, 7, 7, 10, 8, 9)):
        ws.column_dimensions[col].width = width


def generate(rows):
    data = table_rows(rows)
    wb = Workbook()
    build_readme(wb.active)
    summary = wb.create_sheet()
    last = build_table(wb.create_sheet(), data)
    build_summary(summary, last)
    wb.move_sheet("代號摘要", offset=-1)      # 順序：說明、代號摘要、核對表
    wb.calculation.fullCalcOnLoad = True     # 無 LibreOffice 可預先重算；開檔時由 Excel 計算
    OUT.parent.mkdir(parents=True, exist_ok=True)
    wb.save(OUT)
    print(f"✓ 產生 {OUT}（{len(data)} 列、{len(GOLDEN_CODES)} 個代號）")


# ── 凍結 ────────────────────────────────────────────────────────
def freeze(xlsx, rows):
    wb = load_workbook(xlsx)
    readme, summary, table = wb["說明"], wb["代號摘要"], wb["核對表"]
    sign = {readme.cell(row=r, column=1).value: readme.cell(row=r, column=2).value
            for r in range(1, readme.max_row + 1)}
    verifier = str(sign.get("核對人") or "").strip()
    verified_at = str(sign.get("核對日期（YYYY-MM-DD）") or "").strip()
    if not verifier or not verified_at:
        sys.exit("✗ 「說明」頁的核對人與核對日期必填")

    expected = [tuple(str(x) for x in r) for r in table_rows(rows)]
    sheet_rows = [tuple("" if c.value is None else str(c.value) for c in row)
                  for row in table.iter_rows(min_row=2)]
    if [r[:9] for r in sheet_rows] != expected:
        sys.exit("✗ 核對表內容與凍結快照不一致（可能是舊版或被修改過的表），拒絕凍結")

    site_counts = {summary.cell(row=r, column=1).value:
                   (summary.cell(row=r, column=5).value, summary.cell(row=r, column=7).value)
                   for r in range(2, 2 + len(GOLDEN_CODES))}
    frozen, pending = [], []
    for code, _, _ in GOLDEN_CODES:
        mine = [r for r in sheet_rows if r[0] == code]
        problems = []
        for r in mine:
            marks, note = r[9:12], r[12].strip()
            if any(m not in ("✓", "不可核對") for m in marks):
                problems.append(f"第 {r[1]} 列核對欄為 {marks}")
            elif "不可核對" in marks and not note:
                problems.append(f"第 {r[1]} 列標不可核對但未寫替代核對方式")
        site, explain = site_counts.get(code, (None, None))
        if site in (None, ""):
            problems.append("網站列數未填")
        elif int(site) != len(mine) and not str(explain or "").strip():
            problems.append(f"網站列數 {site} ≠ CSV {len(mine)}，但未說明漏列／多列")
        path = FIXTURES / f"golden_{code}.json"
        if path.exists():
            problems.append(f"{path.name} 已存在，不覆寫")
        if problems:
            pending.append((code, problems))
            continue
        payload = {"verifiedBy": verifier, "verifiedAt": verified_at,
                   "verificationSource": "健保署藥品查詢網站",
                   "siteRowCount": int(site), "siteRowNote": str(explain or ""),
                   "notes": {str(r[1]): r[12] for r in mine if r[12].strip()},
                   **{k: v for k, v in golden_view(code, rows).items() if k != "code"}}
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        frozen.append(code)

    print(f"✓ 已凍結 {len(frozen)} 個代號：{frozen}")
    for code, problems in pending:
        print(f"⏳ {code} 未凍結：" + "；".join(problems))


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--freeze", metavar="XLSX", help="將核對完成的 xlsx 凍結為 golden fixture")
    args = p.parse_args()
    rows = parse_csv(Path(SNAPSHOT_FILE).read_bytes())
    if args.freeze:
        freeze(args.freeze, rows)
    else:
        generate(rows)


if __name__ == "__main__":
    main()
