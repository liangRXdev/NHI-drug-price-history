"""A2（逐筆守恆）、A3–A8、E1–E2（plan.md §5）。"""

import json
import os
import random
import subprocess
import sys
from collections import Counter
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from build_price_history import build_outputs, run
from lib.history import (annotate_flags, build_code, build_window, derive_events,
                         normalize_rows, select_meta_row, summary_at)
from lib.nhi import classify_date, classify_price, parse_csv
from tests.helpers import SNAPSHOT, make_row, roc, rows_to_csv, seq_rows, tree_hash

CODE = "A000000100"
D = date(2026, 9, 11)


def records_of(rows, code=CODE):
    by_code, _ = normalize_rows(rows)
    records = by_code[code]["records"]
    annotate_flags(records)
    derive_events(records)
    return records


def events(prices):
    return [r["eventType"] for r in records_of(seq_rows(prices))]


def money(x):
    return None if x is None else Decimal(x)


# ── A2 逐筆守恆 ─────────────────────────────────────────────────
def test_every_unique_source_row_maps_to_exactly_one_output():
    rows = (seq_rows(["10.00", "0.00", "-", "", "abc", "12.50"])
            + [make_row(code="B000000100", frm="", price="5.00")]            # blank_start
            + [make_row(code="B000000100", frm="1150101", to="1041301")]     # invalid_date
            + seq_rows(["7.00"], code="C000000100"))
    rows.append(dict(rows[0]))                                               # 完全重複列
    shards, _, _, stats = build_outputs(rows, D)

    expected = Counter()
    for r in {tuple(sorted(x.items())): x for x in rows}.values():
        start, s = classify_date(r["from"], False)
        end, e = classify_date(r["to"], True)
        if s in ("ok",) and e in ("ok", "open") and not (end and start > end):
            _, state = classify_price(r["price"])
            expected[(r["code"], start.isoformat(), end.isoformat() if end else None,
                      r["price"], state)] += 1
        else:
            expected[(r["code"], r["from"], r["to"], r["price"], "invalid")] += 1

    actual = Counter()
    for drugs in shards.values():
        for code, entry in drugs.items():
            for rec in entry["records"]:
                actual[(code, rec["from"], rec["to"], rec["rawPrice"], rec["priceState"])] += 1
            for inv in entry["invalidRecords"]:
                actual[(code, inv["rawFrom"], inv["rawTo"], inv["rawPrice"], "invalid")] += 1

    assert actual == expected
    assert stats["duplicateRowsRemoved"] == 1
    assert sum(actual.values()) + stats["duplicateRowsRemoved"] == stats["sourceRowCount"]


def test_non_priced_records_have_null_price_and_keep_raw():
    recs = [r for d in build_outputs(seq_rows(["0.00", "-", "", "abc", "12.50"]), D)[0].values()
            for r in d[CODE]["records"]]
    assert [(r["price"], r["rawPrice"]) for r in recs] == [
        (None, "0.00"), (None, "-"), (None, ""), (None, "abc"), (12.5, "12.50")]


# ── A3 事件推導 ─────────────────────────────────────────────────
def test_event_sequence_with_exact_values():
    recs = records_of(seq_rows(["10.00", "10.00", "8.00", "0.00", "9.00", "-", "9.00", "0.00"]))
    got = [(r["eventType"], r["previousPrice"], r["absoluteChange"], r["percentChange"],
            r["crossesStop"]) for r in recs]
    assert got == [
        ("initial", None, None, None, False),
        ("unchanged", money("10.00"), None, None, False),
        ("decrease", money("10.00"), money("-2.00"), money("-20.00"), False),
        ("terminated", money("8.00"), None, None, False),
        ("relisted", money("8.00"), money("1.00"), money("12.50"), True),
        ("suspended", money("9.00"), None, None, False),
        ("relisted", money("9.00"), money("0.00"), money("0.00"), True),
        ("terminated", money("9.00"), None, None, False),
    ]
    assert sum(r["eventType"] in ("increase", "decrease") for r in recs) == 1
    assert summary_at(recs, date(2030, 1, 1))["priceChangeCount"] == 1   # relisted 不計入


@pytest.mark.parametrize("prices,expected", [
    (["0.00", "12.00"], ["initial", "first_priced"]),
    (["10.00", "", "12.00"], ["initial", "unknown", "unknown"]),
    (["abc", "0.00"], ["initial", "unknown"]),
    (["0.00", "0.00"], ["initial", "unchanged"]),
    (["-", "-"], ["initial", "unchanged"]),
    (["10.00", "-", "0.00"], ["initial", "suspended", "terminated"]),
    (["-", "0.00", "5.00"], ["initial", "terminated", "first_priced"]),
])
def test_event_priority_table(prices, expected):
    assert events(prices) == expected


def test_first_priced_has_no_change_values():
    r = records_of(seq_rows(["0.00", "12.00"]))[1]
    assert (r["previousPrice"], r["absoluteChange"], r["percentChange"]) == (None, None, None)


@pytest.mark.parametrize("prev,new,abs_change,pct", [
    ("10.00", "12.00", "2.00", "20.00"),
    ("3.00", "2.00", "-1.00", "-33.33"),
    ("8.00", "8.01", "0.01", "0.13"),      # 0.125 → half away from zero；banker's 會得 0.12
    ("29.80", "22.90", "-6.90", "-23.15"),
])
def test_change_values_and_rounding(prev, new, abs_change, pct):
    r = records_of(seq_rows([prev, new]))[1]
    assert (r["absoluteChange"], r["percentChange"]) == (money(abs_change), money(pct))


def test_unknown_transitions_do_not_count_as_price_change():
    recs = records_of(seq_rows(["10.00", "", "12.00"]))
    assert summary_at(recs, date(2030, 1, 1))["priceChangeCount"] == 0


# ── A4 重複與衝突 ───────────────────────────────────────────────
def test_three_identical_rows_keep_one():
    row = make_row()
    by_code, stats = normalize_rows([row, dict(row), dict(row)])
    assert len(by_code[CODE]["records"]) == 1 and stats["duplicateRowsRemoved"] == 2


def test_rows_differing_only_in_manufacturer_are_kept_and_not_a_change():
    rows = [make_row(manufacturer="甲藥廠"), make_row(manufacturer="乙藥廠")]
    recs = records_of(rows)
    assert len(recs) == 2
    assert [r["eventType"] for r in recs] == ["initial", "unchanged"]


def test_conflicting_prices_in_same_interval():
    rows = seq_rows(["10.00"], last_open=False) + [
        make_row(price=p, frm="1090201", to="1090229") for p in ("11.00", "12.00", "13.00")]
    recs = records_of(rows)
    assert len(recs) == 4
    assert [r["eventType"] for r in recs] == ["initial", "unknown", "unknown", "unknown"]
    assert all("conflicting_price_interval" in r["flags"] for r in recs[1:])
    _, _, _, stats = build_outputs(rows, D)
    assert stats["conflictingIntervals"] == 1


# ── A5 gap／overlap（閉區間、累計最大迄日）──────────────────────
def interval_rows(*spans, prices=None):
    return [make_row(frm=roc(a), to=roc(b) if b else "9991231",
                     price=prices[i] if prices else f"{10 + i}.00")
            for i, (a, b) in enumerate(spans)]


def flags_of(*spans):
    return [sorted(r["flags"]) for r in records_of(interval_rows(*spans))]


def test_contiguous_intervals_have_no_gap():
    assert flags_of((date(2020, 1, 1), date(2020, 1, 31)), (date(2020, 2, 1), None)) == [[], []]


def test_one_missing_day_is_a_gap():
    assert flags_of((date(2020, 1, 1), date(2020, 1, 30)),
                    (date(2020, 2, 1), None)) == [[], ["gap_before"]]


def test_shared_endpoint_is_overlap():
    assert flags_of((date(2020, 1, 1), date(2020, 1, 31)),
                    (date(2020, 1, 31), None)) == [[], ["overlap"]]


def test_long_interval_covering_short_ones_is_overlap_not_gap():
    assert flags_of((date(2020, 1, 1), date(2020, 12, 31)),
                    (date(2020, 3, 1), date(2020, 3, 31)),
                    (date(2020, 5, 1), date(2020, 5, 31))) == [[], ["overlap"], ["overlap"]]


def test_row_after_open_interval_is_overlap():
    assert flags_of((date(2020, 1, 1), None), (date(2021, 1, 1), None)) == [[], ["overlap"]]


def test_detection_never_adds_records():
    rows = interval_rows((date(2020, 1, 1), date(2020, 1, 30)), (date(2020, 3, 1), None))
    assert len(records_of(rows)) == len(rows)


# ── A6 window 與 metadata ───────────────────────────────────────
def window_froms(rows, day=D):
    return [r["from"].isoformat() for r, _ in build_window(records_of(rows), day)]


def test_window_is_current_plus_earliest_upcoming():
    rows = interval_rows((date(2026, 1, 1), date(2026, 9, 30)),
                         (date(2026, 10, 1), date(2026, 12, 31)),
                         (date(2027, 1, 1), None))
    assert window_froms(rows) == ["2026-01-01", "2026-10-01"]


def test_window_without_upcoming_has_one_entry():
    assert window_froms(interval_rows((date(2026, 1, 1), None))) == ["2026-01-01"]


def test_window_future_only_and_expired():
    assert window_froms(interval_rows((date(2026, 10, 1), None))) == ["2026-10-01"]
    assert window_froms(interval_rows((date(2020, 1, 1), date(2020, 12, 31)))) == []


def test_window_conflict_flag_when_multiple_current():
    rows = [make_row(price="10.00", frm="1150101"), make_row(price="12.00", frm="1150101")]
    window = build_window(records_of(rows), D)
    assert "conflict" in window[0][1]


def window_of(rows, day=D):
    by_code, _ = normalize_rows(rows)
    return build_code(CODE, by_code[CODE], day)[1]["window"]


def test_window_priced_before_survives_terminated_renewal():
    # 10 → 0 → 0（終止後同為 0 元續期）：續期列 eventType=unchanged、previousPrice=null，
    # 搜尋卡仍須拿得到「終止前 10 元」
    rows = interval_rows((date(2020, 1, 1), date(2020, 12, 31)),
                         (date(2021, 1, 1), date(2025, 12, 31)),
                         (date(2026, 1, 1), None),
                         prices=["10.00", "0.00", "0.00"])
    [cur] = window_of(rows)
    assert (cur["eventType"], cur["previousPrice"], cur["pricedBefore"]) == ("unchanged", None, 10.0)


def test_window_priced_before_is_null_when_never_priced():
    rows = interval_rows((date(2020, 1, 1), date(2025, 12, 31)), (date(2026, 1, 1), None),
                         prices=["0.00", "0.00"])
    assert window_of(rows)[0]["pricedBefore"] is None


def test_window_priced_before_ignores_future_relisting():
    # 10 → 終止（現行）→ 預告恢復 20：現行列的 pricedBefore 只能是 10，不得為 20
    rows = interval_rows((date(2020, 1, 1), date(2025, 12, 31)),
                         (date(2026, 1, 1), date(2026, 9, 30)),
                         (date(2026, 10, 1), None),
                         prices=["10.00", "0.00", "20.00"])
    cur, upcoming = window_of(rows)
    assert (cur["pricedBefore"], upcoming["pricedBefore"]) == (10.0, 10.0)
    assert upcoming["eventType"] == "relisted"


def test_index_metadata_comes_from_current_row_not_upcoming():
    rows = [make_row(frm="1150101", to="1150930", chName="現行名", ingredient="GOOD 10 MG",
                     manufacturer="現行商", atcCode="C09DX01"),
            make_row(frm="1151001", to="9991231", chName="預告名", ingredient="2412402210 10 MG",
                     manufacturer="預告商", atcCode="X00")]
    by_code, _ = normalize_rows(rows)
    _, index_entry, flags = build_code(CODE, by_code[CODE], D)
    assert (index_entry["chName"], index_entry["ingredient"], index_entry["manufacturer"],
            index_entry["atcCode"]) == ("現行名", "GOOD 10 MG", "現行商", "C09DX01")
    assert "inconsistent_metadata" in flags


def test_meta_variants_carry_record_index_for_same_start_rows():
    # 同起日、不同描述：只記 from 無法對應回 select_meta_row 選中的列（codex R4）
    rows = [make_row(frm="1090101", to="1091231", chName="甲名"),
            make_row(frm="1090101", to="1101231", chName="乙名"),
            make_row(frm="1110101", to="9991231", chName="甲名")]
    by_code, _ = normalize_rows(rows)
    shard_entry, _, _ = build_code(CODE, by_code[CODE], D)
    variants = shard_entry["metaVariants"]
    assert [(v["recordIndex"], v["from"], v["chName"]) for v in variants] == [
        (0, "2020-01-01", "甲名"), (1, "2020-01-01", "乙名"), (2, "2022-01-01", "甲名")]
    recs = by_code[CODE]["records"]
    assert select_meta_row(recs, date(2020, 6, 1))["chName"] == "甲名"   # 前端須依 recordIndex 對應到同一列


def test_metadata_fallbacks():
    past = [make_row(frm="1090101", to="1091231", chName="舊名"),
            make_row(frm="1100101", to="1101231", chName="新名")]
    assert select_meta_row(records_of(past), D)["chName"] == "新名"      # 空窗後取 from 最晚者
    future_only = records_of([make_row(frm="1160101", chName="預告名")])
    assert select_meta_row(future_only, D) is None                       # 不以預告列回填


# ── A7 determinism ──────────────────────────────────────────────
RUNNER = """
import sys
from datetime import date
from pathlib import Path
from build_price_history import GuardConfig, run
run(Path(sys.argv[1]).read_bytes(), data_dir=sys.argv[2], build_date=date.fromisoformat(sys.argv[3]),
    checked_at=sys.argv[4], source_modified=None, cfg=GuardConfig(min_rows=1, min_codes=1),
    fixtures_dir="__none__")
"""


def run_isolated(src, out, build_date="2026-09-11", checked="2026-09-11T12:00:00+08:00", seed="0"):
    env = {**os.environ, "PYTHONHASHSEED": seed}
    subprocess.run([sys.executable, "-c", RUNNER, str(src), str(out), build_date, checked],
                   check=True, env=env, cwd=Path(__file__).resolve().parent.parent)


def test_same_input_in_separate_processes_is_byte_identical(tmp_path):
    run_isolated(SNAPSHOT, tmp_path / "a", seed="1")
    run_isolated(SNAPSHOT, tmp_path / "b", seed="987654")
    assert tree_hash(tmp_path / "a") == tree_hash(tmp_path / "b")


def test_row_order_does_not_change_output(tmp_path, small_cfg):
    rows = parse_csv(SNAPSHOT.read_bytes())
    shuffled = rows[:]
    random.Random(42).shuffle(shuffled)
    kw = dict(build_date=D, checked_at="2026-09-11T12:00:00+08:00", source_modified=None,
              cfg=small_cfg, fixtures_dir="__none__")
    run(rows_to_csv(rows), data_dir=tmp_path / "a", **kw)
    run(rows_to_csv(shuffled), data_dir=tmp_path / "b", **kw)
    assert tree_hash(tmp_path / "a") == tree_hash(tmp_path / "b")


def test_history_is_independent_of_build_date(tmp_path, small_cfg):
    raw = SNAPSHOT.read_bytes()
    kw = dict(checked_at="2026-09-11T12:00:00+08:00", source_modified=None, cfg=small_cfg,
              fixtures_dir="__none__")
    a = run(raw, data_dir=tmp_path / "a", build_date=date(2026, 9, 11), **kw)
    b = run(raw, data_dir=tmp_path / "b", build_date=date(2026, 10, 1), **kw)   # 跨預告生效日
    assert tree_hash(tmp_path / "a" / "history") == tree_hash(tmp_path / "b" / "history")
    assert a["dataVersion"] == b["dataVersion"]
    assert ((tmp_path / "a" / "drug_index.json").read_bytes()
            != (tmp_path / "b" / "drug_index.json").read_bytes())


# ── A8 全量集合一致 ─────────────────────────────────────────────
def test_code_sets_are_equal_and_shards_are_disjoint(tmp_path, small_cfg):
    raw = SNAPSHOT.read_bytes()
    run(raw, data_dir=tmp_path, build_date=D, checked_at="2026-09-11T12:00:00+08:00",
        source_modified=None, cfg=small_cfg, fixtures_dir="__none__")
    source_codes = {r["code"] for r in parse_csv(raw)}
    # columnar/1：測試自己解碼，不呼叫受測模組的 helper——否則期望值就由受測程式產生
    index_doc = json.loads((tmp_path / "drug_index.json").read_text("utf-8"))
    assert index_doc["indexFormat"] == "columnar/1"
    assert index_doc["fields"][:14] == [
        "code", "chName", "enName", "ingredient", "dosageForm", "strength", "strengthUnit",
        "atcCode", "manufacturer", "firstEffectiveDate", "lastPriceChangeDate",
        "historyCount", "priceChangeCount", "flags"]
    _ci = index_doc["fields"].index("code")
    index_codes = {r[_ci] for r in index_doc["rows"]}
    # §3.5：rows 依 code 嚴格遞增是契約（prepareIndex 不再有 fallback sort）
    _codes_in_order = [r[_ci] for r in index_doc["rows"]]
    assert _codes_in_order == sorted(_codes_in_order)
    assert len(_codes_in_order) == len(index_codes)
    meta = json.loads((tmp_path / "meta.json").read_text("utf-8"))

    shard_codes = []
    for prefix in meta["shards"]["files"]:
        drugs = json.loads((tmp_path / "history" / f"{prefix}.json").read_text("utf-8"))["drugs"]
        assert all(code.startswith(prefix) for code in drugs)
        shard_codes.extend(drugs)
    assert len(shard_codes) == len(set(shard_codes))                     # shard 間無重複
    assert source_codes == index_codes == set(shard_codes)
    on_disk = {p.stem for p in (tmp_path / "history").glob("*.json")}
    assert on_disk == set(meta["shards"]["files"])


# ── E1／E2 摘要 ────────────────────────────────────────────────
def test_total_change_excludes_upcoming():
    recs = records_of(seq_rows(["30.00", "20.00", "25.00"], start=date(2026, 6, 1)))
    s = summary_at(recs, date(2026, 7, 15))
    assert (s["totalChange"]["absoluteChange"], s["totalChange"]["percentChange"]) == (
        money("-10.00"), money("-33.33"))
    assert s["upcoming"]["value"] == money("25.00")


def test_total_change_edge_cases():
    assert summary_at(records_of(seq_rows(["0.00", "-"])), D)["pricedCount"] == 0
    single = summary_at(records_of(seq_rows(["10.00"])), D)
    assert single["pricedCount"] == 1 and single["totalChange"] is None


@pytest.mark.parametrize("prices,event,previous", [
    (["10.00", "0.00"], "terminated", "10.00"),
    (["10.00", "8.00", "8.00"], "decrease", "10.00"),      # unchanged 跳過
    (["10.00", ""], "unknown", None),
    (["0.00", "12.00"], None, None),                        # 只有 initial／first_priced
    (["10.00"], None, None),
])
def test_latest_event(prices, event, previous):
    latest = summary_at(records_of(seq_rows(prices)), date(2030, 1, 1))["latestEvent"]
    assert (latest and latest["eventType"]) == event
    if previous:
        assert latest["previousPrice"] == money(previous)


def test_terminated_before_price_ignores_future_relisting():
    """10 元 → 終止 → 預告恢復 20 元：終止前價格必須是 10，不得為 20。"""
    recs = records_of(seq_rows(["10.00", "0.00", "20.00"], start=date(2026, 8, 1)))
    s = summary_at(recs, date(2026, 9, 15))
    assert s["status"] == "terminated"
    assert s["latestEvent"]["previousPrice"] == money("10.00")
    assert s["upcoming"]["eventType"] == "relisted"


@pytest.mark.parametrize("ref,status", [
    (date(2019, 6, 1), "not_yet_effective"),
    (date(2020, 1, 31), "gap"),
    (date(2020, 3, 1), "priced"),
])
def test_current_status(ref, status):
    recs = records_of(interval_rows((date(2020, 1, 1), date(2020, 1, 30)), (date(2020, 2, 1), None)))
    assert summary_at(recs, ref)["status"] == status


def test_conflict_status():
    recs = records_of([make_row(price="10.00", frm="1150101"), make_row(price="12.00", frm="1150101")])
    s = summary_at(recs, D)
    assert s["status"] == "conflict" and s["current"] is None and len(s["currentCandidates"]) == 2
