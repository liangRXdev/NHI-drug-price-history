#!/usr/bin/env python3
"""健保藥價歷史建置腳本 build_price_history.py
===========================================
下載 NHI 健保用藥品項檔（保留全部歷次列），輸出：
  data/drug_index.json   搜尋 index（每代號一筆，含 build 日 window）
  data/history/<XX>.json 依代號前 2 碼分片的完整歷史
  data/upcoming.json     預告清單（build 日尚未生效的 record；與 index 同進退）
  data/meta.json         已發布資料批次的統計（資料有變才更新）
  data/status.json       每次成功檢查都更新（前端過期警示依據）

安全原則：所有 guard 通過之前**不寫任何檔案**；任一失敗 → exit 1，
data/ 與 status.json 維持原狀（spec §14、plan.md B1–B3）。

用法：
  uv run python build_price_history.py                          # 從官方端點下載
  uv run python build_price_history.py --source-file .cache/nhi_raw_2026-09-11.csv
選項見 --help。
"""

import argparse
import gzip
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from lib import history, nhi
from lib.golden import GOLDEN_CODES

for _stream in (sys.stdout, sys.stderr):
    # Windows 主控台預設 cp950，print emoji／罕用字會拋 UnicodeEncodeError
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

TPE = timezone(timedelta(hours=8))
# 2 碼分片時 A0 單片 gzip 3.35 MB／raw 35.7 MB（2026-09-11 實測），超過 warning 門檻且
# 行動裝置解析過重；4 碼分片共 348 片，最大 gzip ≈ 0.14 MB／raw ≈ 1.5 MB
PREFIX_LENGTH = 4


@dataclass(frozen=True)
class GuardConfig:
    """guard 門檻；比例一律以整數百分點比較，邊界值通過（spec §14）。"""
    min_rows: int = 100_000
    min_codes: int = 5_000
    min_row_pct_of_previous: int = 99
    max_invalid_pct: int = 1
    max_bad_price_pct: int = 1        # 語意 guard，可人工放行
    max_disappeared_pct: int = 1      # 語意 guard，可人工放行
    shard_warn_gzip_bytes: int = 2_000_000
    shard_fail_gzip_bytes: int = 5_000_000
    # 預告清單：兩條皆為 WARNING。列數 0 可能為真（健保公告有空窗期），
    # 佔比過高與體積暴增則多半是來源結構異常（spec-upcoming §3.4、§3.5）
    upcoming_code_pct_warn: int = 5
    upcoming_raw_warn_bytes: int = 500_000


class BuildError(Exception):
    """guard 失敗；呼叫端不得寫入任何輸出。"""


# ── 序列化 ──────────────────────────────────────────────────────
def dumps(obj):
    """固定格式：sort_keys、不跳脫中文、無多餘空白、結尾換行。"""
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n").encode("utf-8")


def gzip_size(data):
    return len(gzip.compress(data, compresslevel=6, mtime=0))


# ── 建構 ────────────────────────────────────────────────────────
def build_outputs(rows, build_date):
    """來源列 → (shards, index_drugs, upcoming_items, stats)。純計算，不做 I/O。"""
    by_code, stats = history.normalize_rows(rows)
    shards, index_drugs, code_flags = {}, [], []
    for code in sorted(by_code):
        shard_entry, index_entry, flags = history.build_code(code, by_code[code], build_date)
        shards.setdefault(code[:PREFIX_LENGTH], {})[code] = shard_entry
        index_drugs.append(index_entry)
        code_flags.append((code, flags))

    # 預告清單另一趟走完：生成失敗要能明確歸因，並轉成 guard 失敗（全有全無，
    # 整批不發布），不可讓例外逃出去變成沒有訊息的 crash（spec-upcoming §3.4）
    try:
        upcoming_items = []
        for code, flags in code_flags:   # 代號升冪、代號內依 records 順序：sort 第四鍵靠此
            upcoming_items += history.build_upcoming(code, by_code[code], build_date, flags)
        upcoming_items = history.sort_upcoming(upcoming_items)
    except Exception as e:
        raise BuildError([f"upcoming.json 產生失敗：{e!r}"], []) from e

    records = [r for e in by_code.values() for r in e["records"]]
    stats["uniqueDrugCodeCount"] = len(by_code)
    stats["recordCount"] = len(records)
    stats["coverageStart"] = min(r["from"] for r in records).isoformat() if records else None
    stats["coverageEnd"] = max(r["from"] for r in records).isoformat() if records else None
    for flag, key in (("gap", "gapCodes"), ("overlap", "overlapCodes"),
                      ("conflict", "conflictCodes"), ("question_mark", "questionMarkCodes"),
                      ("inconsistent_metadata", "inconsistentMetadataCodes")):
        stats[key] = sum(1 for d in index_drugs if flag in d["flags"])
    stats["conflictingIntervals"] = sum(
        len({(r["from"], r["to"]) for r in e["records"]
             if "conflicting_price_interval" in r["flags"]})
        for e in by_code.values())
    stats["openEndedRowAnomalies"] = sum(
        1 for e in by_code.values() if sum(1 for r in e["records"] if r["to"] is None) != 1)
    stats["upcomingRows"] = len(upcoming_items)
    stats["upcomingCodes"] = len({it["code"] for it in upcoming_items})
    return shards, index_drugs, upcoming_items, stats


def sha256(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def shard_versions(shards):
    """每片 shard 內容的 hash。每片只帶自己的 hash（不帶全域版本），
    改一個價格只會改寫該代號所在的 shard（plan.md B5），混批仍可由前端比對 meta 偵測。"""
    return {p: sha256(dumps(shards[p])) for p in sorted(shards)}


def data_version(versions):
    """全域資料版本＝各 shard hash 的 hash；只依來源內容，不依 build 日（spec §5.2）。"""
    return sha256(dumps(versions))


def render(shards, index_drugs, versions, version):
    """→ {相對路徑: bytes}（僅資料檔；meta／status 另行產生）。"""
    files = {f"history/{p}.json": dumps({"shardVersion": versions[p], "drugs": shards[p]})
             for p in sorted(shards)}
    files["drug_index.json"] = dumps({"dataVersion": version, "drugs": index_drugs})
    return files


# ── guards ──────────────────────────────────────────────────────
def pct_exceeds(part, whole, max_pct):
    """part / whole > max_pct%？以整數運算避免浮點邊界誤判（1.00% 通過、1.01% 失敗）。"""
    return whole > 0 and part * 10_000 > whole * max_pct * 100


def upcoming_payload(upcoming_items, version, build_date):
    """spec-upcoming §3.1 的輸出物件；`dataVersion` 沿用來源版本，不另計。"""
    return {
        "dataVersion": version,
        "generatorVersion": history.UPCOMING_GENERATOR_VERSION,
        "buildDate": build_date.isoformat(),
        "count": len(upcoming_items),
        "codeCount": len({it["code"] for it in upcoming_items}),
        "items": upcoming_items,
    }


def check_guards(stats, prev_meta, prev_codes, new_codes, shard_files, cfg, allow_anomaly,
                 upcoming_errors=(), upcoming_bytes=b""):
    """→ (errors, warnings, anomalies_overridden)。errors 非空即不得發布。"""
    errors, warnings, overridden = [], [], []
    rows = stats["sourceRowCount"]

    if rows < cfg.min_rows:
        errors.append(f"來源列數 {rows:,} < {cfg.min_rows:,}")
    if stats["uniqueDrugCodeCount"] < cfg.min_codes:
        errors.append(f"代號數 {stats['uniqueDrugCodeCount']:,} < {cfg.min_codes:,}")
    if prev_meta and prev_meta.get("sourceRowCount"):
        prev_rows = prev_meta["sourceRowCount"]
        if rows * 100 < prev_rows * cfg.min_row_pct_of_previous:
            errors.append(f"來源列數 {rows:,} 低於前次已發布 {prev_rows:,} 的 "
                          f"{cfg.min_row_pct_of_previous}%")
    bad_dates = stats.get("invalidRecords", 0) + stats.get("blankCodeRows", 0)
    if pct_exceeds(bad_dates, rows, cfg.max_invalid_pct):
        errors.append(f"日期／代號異常列 {bad_dates:,} 超過來源列數的 {cfg.max_invalid_pct}%")

    # 語意異常 guard：僅這兩條可由 workflow_dispatch + allow_anomaly 放行
    semantic = []
    bad_price = stats.get("malformedPriceRows", 0) + stats.get("missingPriceRows", 0)
    if pct_exceeds(bad_price, rows, cfg.max_bad_price_pct):
        semantic.append(f"價格 malformed＋missing {bad_price:,} 列超過 {cfg.max_bad_price_pct}%")
    if prev_codes:
        gone = len(prev_codes - new_codes)
        if pct_exceeds(gone, len(prev_codes), cfg.max_disappeared_pct):
            semantic.append(f"前次已發布代號有 {gone:,} 個在本次來源消失，超過 "
                            f"{cfg.max_disappeared_pct}%")
    if semantic and allow_anomaly:
        overridden.extend(semantic)
        warnings.extend(f"[人工放行] {m}" for m in semantic)
    else:
        errors.extend(semantic)

    for path, data in shard_files.items():
        size = gzip_size(data)
        if size > cfg.shard_fail_gzip_bytes:
            errors.append(f"{path} gzip {size:,} bytes > {cfg.shard_fail_gzip_bytes:,}")
        elif size > cfg.shard_warn_gzip_bytes:
            warnings.append(f"{path} gzip {size:,} bytes > {cfg.shard_warn_gzip_bytes:,}")

    # 預告清單：驗證失敗一律 error（全有全無，整批不發布）；統計異常只 WARNING
    errors.extend(f"upcoming.json 驗證失敗：{m}" for m in upcoming_errors)
    if stats.get("upcomingRows") == 0:
        warnings.append("upcoming.json 無任何未生效紀錄（可能為真，健保公告有空窗期）")
    if pct_exceeds(stats.get("upcomingCodes", 0), stats["uniqueDrugCodeCount"],
                   cfg.upcoming_code_pct_warn):
        warnings.append(f"有未生效紀錄的代號 {stats.get('upcomingCodes', 0):,} 個，"
                        f"超過全部代號的 {cfg.upcoming_code_pct_warn}%")
    if len(upcoming_bytes) > cfg.upcoming_raw_warn_bytes:
        warnings.append(f"upcoming.json raw {len(upcoming_bytes):,} bytes > "
                        f"{cfg.upcoming_raw_warn_bytes:,}（來源結構可能異常）")

    if stats.get("startSentinelRows"):
        warnings.append(f"有 {stats['startSentinelRows']} 列的有效起日為 9991231")
    if stats.get("openEndedRowAnomalies"):
        warnings.append(f"{stats['openEndedRowAnomalies']} 個代號的開放迄日列數不為 1（§6.8）")
    return errors, warnings, overridden


def golden_rewrites(shards, fixtures_dir):
    """已由藥師核對的 golden intervals 若在最新來源中被改寫 → warning 清單（不 fail）。"""
    messages = []
    for code, _, _ in GOLDEN_CODES:
        path = Path(fixtures_dir) / f"golden_{code}.json"
        if not path.exists():
            continue
        verified = json.loads(path.read_text(encoding="utf-8")).get("intervals", [])
        entry = shards.get(code[:PREFIX_LENGTH], {}).get(code)
        current = {(r["from"], r["to"], r["rawPrice"], r["priceState"])
                   for r in (entry or {}).get("records", [])}
        for iv in verified:
            key = (iv["from"], iv["to"], iv["rawPrice"], iv["priceState"])
            if key not in current:
                messages.append(f"golden {code} 已核對區間 {key} 在最新來源中不存在或被改寫")
    return messages


# ── I/O ─────────────────────────────────────────────────────────
def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def published_json(data_dir, name):
    """**已發布版本**（HEAD 的內容）的 JSON；沒發布過回 None。

    判定對象必須是已發布版本而不是工作目錄（spec-upcoming §3.3.1）：工作目錄可能
    留著上一次產出但沒進 commit 的檔案，只看檔案存在會把「產出了但沒發布」誤判成
    已完成，功能就永遠上線即空。不在 git 工作區時（本機實驗、測試 tmp 目錄）退回讀檔。
    """
    data_dir = Path(data_dir)
    if not data_dir.exists():
        return None
    git = ["git", "-C", str(data_dir)]
    try:
        inside = subprocess.run([*git, "rev-parse", "--git-dir"], capture_output=True)
        if inside.returncode != 0:
            return read_json(data_dir / name)          # 非 git 工作區：只能以檔案為準
        shown = subprocess.run([*git, "show", f"HEAD:./{name}"], capture_output=True)
        if shown.returncode != 0:
            return None                                 # 已發布版本沒有這個檔案
        return json.loads(shown.stdout.decode("utf-8"))
    except (OSError, ValueError):
        return read_json(data_dir / name)


def existing_data_files(data_dir):
    files = {}
    index = Path(data_dir) / "drug_index.json"
    if index.exists():
        files["drug_index.json"] = index.read_bytes()
    for p in sorted((Path(data_dir) / "history").glob("*.json")):
        files[f"history/{p.name}"] = p.read_bytes()
    return files


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def publish(data_dir, files, existing, meta_bytes, status_bytes, upcoming_bytes=None):
    """寫入資料檔（有差異時）與 status.json。只在所有 guard 通過後呼叫。

    `upcoming.json` 與 `drug_index.json` 完全同進退（spec-upcoming §3.3）：只在
    有差異批次寫入。它的 `buildDate` 每週都會前進，若讓它自己決定要不要寫，
    來源沒變也會每週產生一次無意義的 diff。
    """
    root = Path(data_dir)
    if meta_bytes is not None:
        for rel, data in files.items():
            if existing.get(rel) != data:
                atomic_write(root / rel, data)
        for rel in set(existing) - set(files):
            (root / rel).unlink()
        if upcoming_bytes is not None:
            atomic_write(root / "upcoming.json", upcoming_bytes)
        atomic_write(root / "meta.json", meta_bytes)
    atomic_write(root / "status.json", status_bytes)


def step_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


# ── 主流程 ──────────────────────────────────────────────────────
def run(raw, *, data_dir, build_date, checked_at, source_modified,
        cfg=GuardConfig(), allow_anomaly=False, fixtures_dir="tests/fixtures"):
    """完整 build；guard 失敗 raise BuildError（此時未寫入任何檔案）。回傳結果摘要 dict。"""
    rows = nhi.parse_csv(raw)
    shards, index_drugs, upcoming_items, stats = build_outputs(rows, build_date)
    versions = shard_versions(shards)
    version = data_version(versions)
    files = render(shards, index_drugs, versions, version)
    upcoming = upcoming_payload(upcoming_items, version, build_date)
    upcoming_errors = history.validate_upcoming(upcoming)
    upcoming_bytes = dumps(upcoming)

    prev_meta = read_json(Path(data_dir) / "meta.json")
    prev_index = read_json(Path(data_dir) / "drug_index.json")
    prev_codes = {d["code"] for d in prev_index["drugs"]} if prev_index else set()
    new_codes = {d["code"] for d in index_drugs}
    shard_files = {k: v for k, v in files.items() if k.startswith("history/")}

    errors, warnings, overridden = check_guards(
        stats, prev_meta, prev_codes, new_codes, shard_files, cfg, allow_anomaly,
        upcoming_errors=upcoming_errors, upcoming_bytes=upcoming_bytes)
    warnings += golden_rewrites(shards, fixtures_dir)
    if errors:
        raise BuildError(errors, warnings)

    existing = existing_data_files(data_dir)
    changed = existing != files
    # 首次交付與生成規則遷移（spec-upcoming §3.3.1）：判定對象是**已發布版本**。
    # 必須強制進入有差異批次，否則新產物只會留在工作目錄裡進不了 commit，
    # 功能上線即空。失敗時不寫任何檔案，下次執行仍會重新判定為未完成。
    published_upcoming = published_json(data_dir, "upcoming.json")
    published_meta = published_json(data_dir, "meta.json")
    migration = (
        not isinstance(published_upcoming, dict)
        or published_upcoming.get("generatorVersion") != history.UPCOMING_GENERATOR_VERSION
        # 完成的定義是「產物與 meta 同批進入 commit」：meta 少了 upcoming 統計，
        # 代表上次只發了一半，仍視為未完成（否則來源不變就永遠補不回來）
        or not isinstance(published_meta, dict)
        or "upcomingRows" not in published_meta
    )
    if migration:
        changed = True
    meta_bytes = None
    if changed:
        meta_bytes = dumps({
            "dataVersion": version,
            "generatedAt": checked_at,
            "source": nhi.SOURCE_ID,
            "shards": {"prefixLength": PREFIX_LENGTH, "files": sorted(shards),
                       "versions": versions},
            **{k: stats.get(k, 0) for k in (
                "sourceRowCount", "uniqueDrugCodeCount", "recordCount", "invalidRecords",
                "blankCodeRows", "malformedPriceRows", "missingPriceRows",
                "duplicateRowsRemoved", "conflictingIntervals", "conflictCodes",
                "overlapCodes", "gapCodes", "questionMarkCodes",
                "inconsistentMetadataCodes", "openEndedRowAnomalies",
                "upcomingRows", "upcomingCodes")},
            "coverageStart": stats["coverageStart"],
            "coverageEnd": stats["coverageEnd"],
        })
    status_bytes = dumps({
        "lastCheckedAt": checked_at,
        "lastCheckResult": "changed" if changed else "unchanged",
        "dataVersion": version,
        "sourceModifiedAt": source_modified,
    })
    publish(data_dir, files, existing, meta_bytes, status_bytes, upcoming_bytes)
    return {"changed": changed, "dataVersion": version, "stats": stats,
            "warnings": warnings, "overridden": overridden, "upcomingMigration": migration,
            "sizes": {k: (len(v), gzip_size(v))
                      for k, v in {**files, "upcoming.json": upcoming_bytes}.items()}}


def parse_args(argv):
    p = argparse.ArgumentParser(description="建置健保藥價歷史資料")
    p.add_argument("--source-file", help="改用本機 CSV（不下載）")
    p.add_argument("--data-dir", default="data")
    p.add_argument("--build-date", help="YYYY-MM-DD；預設為 --checked-at 的台灣日期")
    p.add_argument("--checked-at", help="ISO 8601；預設為現在（+08:00）")
    p.add_argument("--no-metadata", action="store_true", help="不查 data.gov.tw 更新時間")
    p.add_argument("--allow-anomaly", action="store_true",
                   help="人工放行語意異常 guard（僅限 workflow_dispatch 或本機）")
    return p.parse_args(argv)


def main(argv=None, cfg=GuardConfig()):
    """CLI 進入點；`cfg` 僅供測試以小型 fixture 驅動完整流程，正式執行一律用預設門檻。"""
    args = parse_args(argv)
    event = os.environ.get("GITHUB_EVENT_NAME")
    if args.allow_anomaly and event not in (None, "workflow_dispatch"):
        print(f"✗ --allow-anomaly 僅限 workflow_dispatch 使用（目前事件：{event}）", file=sys.stderr)
        return 1

    checked_at = args.checked_at or datetime.now(TPE).isoformat(timespec="seconds")
    build_date = (date.fromisoformat(args.build_date) if args.build_date
                  else datetime.fromisoformat(checked_at).astimezone(TPE).date())

    try:
        if args.source_file:
            raw = Path(args.source_file).read_bytes()
            print(f"  ✓ 讀取本機來源：{args.source_file}", file=sys.stderr)
        else:
            raw = nhi.download(nhi.NHI_CSV_URL, "NHI 健保用藥品項檔")
        source_modified = None if args.no_metadata else nhi.fetch_source_modified()
        result = run(raw, data_dir=args.data_dir, build_date=build_date,
                     checked_at=checked_at, source_modified=source_modified,
                     cfg=cfg, allow_anomaly=args.allow_anomaly)
    except nhi.SourceError as e:
        print(f"✗ 來源錯誤，未寫入任何檔案：{e}", file=sys.stderr)
        step_summary(["## ✗ 建置失敗（來源錯誤）", f"- {e}"])
        return 1
    except BuildError as e:
        errors, warnings = e.args
        for m in errors:
            print(f"✗ GUARD：{m}", file=sys.stderr)
        for m in warnings:
            print(f"⚠ {m}", file=sys.stderr)
        step_summary(["## ✗ 建置失敗（guard 未通過），未寫入任何檔案"]
                     + [f"- {m}" for m in errors] + [f"- ⚠ {m}" for m in warnings])
        return 1

    s = result["stats"]
    print(f"✓ 建置完成：{s['sourceRowCount']:,} 列、{s['uniqueDrugCodeCount']:,} 個代號、"
          f"資料{'有變動' if result['changed'] else '無變動'}（{result['dataVersion'][:19]}…）")
    for m in result["warnings"]:
        print(f"⚠ {m}", file=sys.stderr)
    largest = sorted(result["sizes"].items(), key=lambda kv: -kv[1][1])[:3]
    for path, (raw_size, gz) in largest:
        print(f"  {path}: raw {raw_size / 1e6:.2f} MB / gzip {gz / 1e6:.2f} MB")
    step_summary(
        [f"## ✓ 建置完成（資料{'有變動' if result['changed'] else '無變動'}）",
         f"- 來源列數 {s['sourceRowCount']:,}；代號 {s['uniqueDrugCodeCount']:,}；"
         f"invalidRecords {s.get('invalidRecords', 0)}；malformed {s.get('malformedPriceRows', 0)}",
         f"- 預告 {s.get('upcomingRows', 0):,} 列 / {s.get('upcomingCodes', 0):,} 個代號"
         f"{'（首次交付或規則遷移，強制重產）' if result['upcomingMigration'] else ''}"]
        + [f"- ⚠ {m}" for m in result["warnings"]])
    return 0


if __name__ == "__main__":
    sys.exit(main())
