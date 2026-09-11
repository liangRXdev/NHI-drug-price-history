#!/usr/bin/env python3
"""從完整來源 CSV 擷取 golden 代號的原始列，存為凍結快照。

逐位元組保留原始行（含 BOM、前綴空白、引號），只做「挑行」不做任何正規化，
使 golden test 驗證的是與正式 build 完全相同的解析路徑。

用法：
  uv run python scripts/extract_snapshot.py .cache/nhi_raw_2026-09-11.csv
"""

import csv
import hashlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.golden import GOLDEN_CODES, SNAPSHOT_DATE, SNAPSHOT_FILE  # noqa: E402

BOM = b"\xef\xbb\xbf"


def main(src_path):
    raw = Path(src_path).read_bytes()
    if not raw.startswith(BOM):
        sys.exit("✗ 來源不是 UTF-8 BOM 開頭，與 2026-09-11 實測格式不符，中止")

    lines = raw[len(BOM):].split(b"\r\n") if b"\r\n" in raw else raw[len(BOM):].split(b"\n")
    newline = b"\r\n" if b"\r\n" in raw else b"\n"
    header, body = lines[0], [ln for ln in lines[1:] if ln]

    wanted = {code for code, _, _ in GOLDEN_CODES}
    picked = []
    for ln in body:
        # 以 csv 解析取代號（第 2 欄），避免品名中的逗號造成誤判
        fields = next(csv.reader(io.StringIO(ln.decode("utf-8"))))
        if len(fields) > 1 and fields[1].strip() in wanted:
            picked.append(ln)

    found = {next(csv.reader(io.StringIO(ln.decode("utf-8"))))[1].strip() for ln in picked}
    missing = sorted(wanted - found)
    if missing:
        sys.exit(f"✗ 來源缺少 golden 代號：{missing}")

    out = Path(SNAPSHOT_FILE)
    out.write_bytes(BOM + newline.join([header] + picked) + newline)

    sidecar = out.with_suffix(".meta.json")
    sidecar.write_text(json.dumps({
        "snapshotDate": SNAPSHOT_DATE,
        "sourceFile": Path(src_path).name,
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "sourceBytes": len(raw),
        "sourceRowCount": len(body),
        "codes": sorted(wanted),
        "pickedRowCount": len(picked),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"✓ 擷取 {len(picked)} 列（{len(wanted)} 個代號）→ {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
