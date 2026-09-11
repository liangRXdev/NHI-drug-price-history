"""測試共用 helper：以最少樣板產生來源列、CSV bytes 與小型 build。"""

import csv
import hashlib
import io
from datetime import date, timedelta
from pathlib import Path

from lib.nhi import FIELDS

HEADER = [pats[0] for pats, _ in FIELDS.values()]      # 20 個來源欄名（依官方順序）
KEY_BY_HEADER = {pats[0]: key for key, (pats, _) in FIELDS.items()}


def roc(d):
    """date → 民國 7 碼（年不足 3 碼補 0，parse 時與 6 碼等價）。"""
    return f"{d.year - 1911:03d}{d.month:02d}{d.day:02d}"


def make_row(code="A000000100", price="10.00", frm="1150101", to="9991231", **kw):
    """一筆 parse_csv 之後的 canonical 列（值已 strip）。"""
    row = {key: "" for key in FIELDS}
    row.update(code=code, price=price, **{"from": frm, "to": to},
               chName="測試藥", enName="TEST TAB", ingredient="TESTINE 10 MG",
               tfdaLink="https://example.invalid/tfda")
    row.update(kw)
    return row


def month_start(start, i):
    y, m = divmod(start.month - 1 + i, 12)
    return date(start.year + y, m + 1, 1)


def seq_rows(prices, code="A000000100", start=date(2020, 1, 1), last_open=True):
    """連續逐月區間：prices[i] 適用第 i 個月；最後一段預設為開放迄日。"""
    rows = []
    for i, p in enumerate(prices):
        frm = month_start(start, i)
        nxt = month_start(start, i + 1)
        to = "9991231" if (last_open and i == len(prices) - 1) else roc(nxt - timedelta(days=1))
        rows.append(make_row(code=code, price=p, frm=roc(frm), to=to))
    return rows


def rows_to_csv(rows, header=HEADER, bom=True):
    """canonical 列 → 來源格式 CSV bytes（UTF-8 BOM、CRLF）。"""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(header)
    for r in rows:
        w.writerow([r[KEY_BY_HEADER[h]] if h in KEY_BY_HEADER else "" for h in header])
    return (b"\xef\xbb\xbf" if bom else b"") + buf.getvalue().encode("utf-8")


def tree_hash(root):
    """目錄下所有檔案（相對路徑 + 內容）的 hash；目錄不存在回傳固定值。"""
    root = Path(root)
    h = hashlib.sha256()
    if root.exists():
        for p in sorted(root.rglob("*")):
            if p.is_file():
                h.update(str(p.relative_to(root)).encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


SNAPSHOT = Path(__file__).parent / "fixtures" / "source_snapshot_2026-09-11.csv"
