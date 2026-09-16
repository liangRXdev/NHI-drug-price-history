"""U1–U3 預告清單資料層（spec-upcoming.md §9）。

真實資料的母體不足以驗到大部分規則（§9.1）：`everPriced = false` 的未生效
`terminated` 0 列、有 ≥2 筆未生效紀錄的代號全不在凍結快照內、missing／malformed／
衝突六類零實例。因此逐條以合成 fixture 補足，並保留可用的真實案例作正對照。
"""

import json
from collections import Counter
from datetime import date
from pathlib import Path

import pytest

from build_price_history import build_outputs
from lib import history, nhi
from tests.helpers import SNAPSHOT, make_row

D = date(2026, 9, 11)
ROOT = Path(__file__).resolve().parent.parent

# 預告列上取自 record 的欄位；描述欄位另由 U3 驗（來源是 build 日有效列，不是預告列）
RECORD_FIELDS = ("effectiveDate", "endDate", "price", "rawPrice", "priceState", "eventType",
                 "previousPrice", "absoluteChange", "percentChange", "crossesStop",
                 "previousState", "pricedBefore", "everPriced")
META_FIELDS = history.INDEX_META_FIELDS


def upcoming(rows, build_date=D):
    return build_outputs(rows, build_date)[2]


def by_code(items, code):
    return [it for it in items if it["code"] == code]


def shape(item):
    """可比較的完整內容（含代號與 flags），供雙向逐筆對應。"""
    return (item["code"], *(item[k] for k in RECORD_FIELDS), tuple(item["flags"]))


# ── U1 與完整 history 雙向逐筆對應 ──────────────────────────────
def test_u1_items_correspond_to_every_future_record_in_history():
    """items ↔ 完整 history 中所有 from > D 的 record：無多、無漏、重數相同。

    預期值取自 shard（record_json／build_code 產生），與待驗的 build_upcoming()
    不同路徑；只支援快照裡那幾個代號、或漏掉同代號的第二筆都會在這裡紅。
    """
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    shards, _, items, stats = build_outputs(rows, D)

    expected = []
    for shard in shards.values():
        for code, entry in shard.items():
            # previousState／pricedBefore／everPriced 由 shard 的 records 自行推導，
            # 不向待驗的 build_upcoming() 借（U1：預期值不得由待驗生成器產生）
            last_priced = None
            for i, rec in enumerate(entry["records"]):
                if rec["from"] > D.isoformat():
                    expected.append((
                        code, rec["from"], rec["to"], rec["price"], rec["rawPrice"],
                        rec["priceState"], rec["eventType"], rec["previousPrice"],
                        rec["absoluteChange"], rec["percentChange"], rec["crossesStop"],
                        entry["records"][i - 1]["priceState"] if i else None,
                        last_priced, last_priced is not None,
                        tuple(sorted(set(rec["flags"]) | set(entry["flags"]))),
                    ))
                if rec["priceState"] == "priced":
                    last_priced = rec["price"]

    assert expected, "凍結快照必須含未生效列，否則本測試等於沒執行"
    assert Counter(shape(it) for it in items) == Counter(expected)
    assert len(items) == len(expected)
    assert stats["upcomingRows"] == len(items)
    assert stats["upcomingCodes"] == len({it["code"] for it in items})


def test_u1_count_and_code_count_agree_with_items():
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    _, _, items, _ = build_outputs(rows, D)
    payload = {"count": len(items), "codeCount": len({it["code"] for it in items})}
    assert payload["count"] == 3 and payload["codeCount"] == 3     # 快照實測基準


def test_u1_records_starting_on_build_date_are_excluded():
    """from = D 的列已生效，必須排除；`>=` 的實作會在這裡紅。"""
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    assert upcoming(rows, date(2026, 10, 1)) == []                 # 快照的 3 列皆為 10-01 起

    same_day = make_row(code="S000000100", price="10.00", frm="1150101", to="1150930")
    future = make_row(code="S000000100", price="11.00", frm="1151001", to="9991231")
    items = upcoming([same_day, future], date(2026, 10, 1))
    assert items == []
    items = upcoming([same_day, future], date(2026, 9, 30))
    assert [it["effectiveDate"] for it in items] == ["2026-10-01"]


def test_u1_invalid_records_are_excluded():
    """invalidRecords 不納入；同時確認 fixture 真的走到 invalid 路徑（反向哨兵）。"""
    good = make_row(code="S000000100", price="10.00", frm="1150101", to="9991231")
    bad = make_row(code="S000000100", price="99.00", frm="1160230", to="9991231")  # 2/30
    shards, _, items, stats = build_outputs([good, bad], D)
    entry = shards["S000"]["S000000100"]
    assert [r["rawFrom"] for r in entry["invalidRecords"]] == ["1160230"]
    assert stats["invalidRecords"] == 1
    assert items == []


# ── U2 同代號多筆未生效紀錄 ─────────────────────────────────────
MULTI = [
    make_row(code="M000000100", price="10.00", frm="1090101", to="1150930"),
    make_row(code="M000000100", price="12.00", frm="1151001", to="1151231"),
    make_row(code="M000000100", price="13.00", frm="1160101", to="1160331"),
    make_row(code="M000000100", price="0.00", frm="1160401", to="9991231"),
]


def test_u2_all_future_records_of_one_code_are_listed():
    items = by_code(upcoming(MULTI), "M000000100")
    assert [(it["effectiveDate"], it["endDate"], it["rawPrice"], it["eventType"]) for it in items] == [
        ("2026-10-01", "2026-12-31", "12.00", "increase"),
        ("2027-01-01", "2027-03-31", "13.00", "increase"),
        ("2027-04-01", None, "0.00", "terminated"),
    ]
    assert [it["previousPrice"] for it in items] == [10.0, 12.0, 13.0]
    assert [it["pricedBefore"] for it in items] == [10.0, 12.0, 13.0]


def test_u2_same_day_distinct_records_are_both_listed():
    """同代號同日 2 筆不同紀錄：上位去重只消除 20 欄全同者，兩筆都必須出現。"""
    rows = MULTI[:2] + [make_row(code="M000000100", price="13.50", frm="1151001", to="1151231")]
    items = by_code(upcoming(rows), "M000000100")
    assert len(items) == 2
    assert [it["rawPrice"] for it in items] == ["12.00", "13.50"]
    assert {it["effectiveDate"] for it in items} == {"2026-10-01"}
    assert all("conflicting_price_interval" in it["flags"] for it in items)
    assert all(it["eventType"] == "unknown" for it in items)


def test_u2_fully_identical_rows_are_deduplicated_not_doubled():
    rows = MULTI[:2] + [dict(MULTI[1])]
    assert len(by_code(upcoming(rows), "M000000100")) == 1


MULTI_UPCOMING_CODES = ("X000342121", "X000346219", "X000359219")


def test_u2_real_data_multi_upcoming_codes_are_complete():
    """全量資料正對照：已發布的 upcoming.json 必須含這 3 個代號的**全部**未生效列。

    快照 11 碼無一有多筆未生效列（§9.1），只靠合成 fixture 無法證明正式產物沒漏。
    """
    published = json.loads((ROOT / "data" / "upcoming.json").read_text(encoding="utf-8"))
    build_date = published["buildDate"]
    for code in MULTI_UPCOMING_CODES:
        shard = json.loads((ROOT / "data" / "history" / f"{code[:4]}.json")
                           .read_text(encoding="utf-8"))
        expected = [(r["from"], r["rawPrice"], r["eventType"], r["priceState"])
                    for r in shard["drugs"][code]["records"] if r["from"] > build_date]
        actual = [(it["effectiveDate"], it["rawPrice"], it["eventType"], it["priceState"])
                  for it in published["items"] if it["code"] == code]
        assert len(expected) >= 2, f"{code} 已不再是多筆未生效案例，母體需重選"
        assert actual == expected


# ── U3 描述欄位選列（§6.6，以 D 選列）───────────────────────────
def desc_row(**kw):
    base = dict(chName="舊名", enName="OLD", ingredient="OLD INGREDIENT", strength="10",
                strengthUnit="MG", dosageForm="錠劑", atcCode="A00AA00", manufacturer="舊藥商")
    base.update(kw)
    return base


CURRENT = desc_row()
FUTURE = desc_row(chName="新名", enName="NEW", ingredient="CORRUPTED", strength="99",
                  strengthUnit="ML", dosageForm="注射劑", atcCode="Z99ZZ99", manufacturer="新藥商")


def test_u3a_uses_row_effective_on_build_date():
    rows = [make_row(code="D000000100", price="10.00", frm="1150101", to="1150930", **CURRENT),
            make_row(code="D000000100", price="11.00", frm="1151001", to="9991231", **FUTURE)]
    item = upcoming(rows)[0]
    assert {k: item[k] for k in META_FIELDS} == CURRENT


def test_u3b_falls_back_to_latest_past_row_when_build_date_in_gap():
    rows = [make_row(code="D000000100", price="10.00", frm="1090101", to="1140630", **desc_row(chName="更舊")),
            make_row(code="D000000100", price="11.00", frm="1140701", to="1150630", **CURRENT),
            make_row(code="D000000100", price="12.00", frm="1151001", to="9991231", **FUTURE)]
    item = upcoming(rows)[0]
    assert {k: item[k] for k in META_FIELDS} == CURRENT


def test_u3c_descriptive_fields_are_null_when_only_future_rows_exist():
    rows = [make_row(code="D000000100", price="11.00", frm="1151001", to="9991231", **FUTURE)]
    item = upcoming(rows)[0]
    assert {k: item[k] for k in META_FIELDS} == dict.fromkeys(META_FIELDS)
    assert item["everPriced"] is False and item["pricedBefore"] is None


def test_u3d_same_start_date_picks_row_by_record_index():
    """同起日不同描述：依 §6.2 排序後的第一列，不是來源列順序。"""
    first = make_row(code="D000000100", price="10.00", frm="1150101", to="9991231", **CURRENT)
    second = make_row(code="D000000100", price="99.00", frm="1150101", to="9991231",
                      **desc_row(chName="同日第二列", ingredient="SECOND"))
    future = make_row(code="D000000100", price="11.00", frm="1160101", to="9991231", **FUTURE)
    for order in ([first, second, future], [future, second, first]):
        item = upcoming(order)[0]
        assert {k: item[k] for k in META_FIELDS} == CURRENT


def test_u3_real_bc26467100_does_not_take_metadata_from_upcoming_row():
    """真實案例：預告列成分欄損毀，描述欄位必須取自 build 日有效列。"""
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    item = by_code(upcoming(rows), "BC26467100")[0]
    assert {k: item[k] for k in META_FIELDS} == {
        "chName": "力脈樂10/160/12.5毫克膜衣錠",
        "enName": "Dafiro HCT 10/160/12.5mg Film-Coated Tablets",
        "ingredient": "VALSARTAN 160 MG+AMLODIPINE BESYLATE 10 MG+HYDROCHLOROTHIAZIDE 12.5 MG",
        "strength": "", "strengthUnit": "", "dosageForm": "膜衣錠",
        "atcCode": "C09DX01", "manufacturer": "裕利股份有限公司",
    }
    assert "2412402210" not in item["ingredient"]


# ── §3.2 determinism 的排序契約 ─────────────────────────────────
def test_sort_order_is_effective_date_then_event_then_code_then_record_index():
    """代號序與事件序刻意相反：少了 eventType 這一鍵，順序會變成代號序。"""
    rows = [
        make_row(code="Z000000100", price="10.00", frm="1090101", to="1151231"),
        make_row(code="Z000000100", price="0.00", frm="1160101", to="9991231"),
        make_row(code="Z000000200", price="10.00", frm="1090101", to="1151231"),
        make_row(code="Z000000200", price="12.00", frm="1160101", to="1160630"),
        make_row(code="Z000000200", price="13.00", frm="1160701", to="9991231"),
    ]
    items = upcoming(rows)
    assert [(it["effectiveDate"], it["eventType"], it["code"]) for it in items] == [
        ("2027-01-01", "increase", "Z000000200"),
        ("2027-01-01", "terminated", "Z000000100"),
        ("2027-07-01", "increase", "Z000000200"),
    ]


def test_sort_is_stable_for_same_code_same_day_same_event():
    """前三鍵相同的多列以原 records 索引決定順序，與來源列順序無關。"""
    a = make_row(code="Z000000100", price="12.00", frm="1160101", to="9991231")
    b = make_row(code="Z000000100", price="13.50", frm="1160101", to="9991231")
    base = make_row(code="Z000000100", price="10.00", frm="1090101", to="1151231")
    forward = [it["rawPrice"] for it in upcoming([base, a, b])]
    backward = [it["rawPrice"] for it in upcoming([b, a, base])]
    assert forward == backward == ["12.00", "13.50"]


# ── §5.5.1 驗證器 ───────────────────────────────────────────────
def valid_payload():
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    _, _, items, _ = build_outputs(rows, D)
    return {"dataVersion": "sha256:x", "generatorVersion": history.UPCOMING_GENERATOR_VERSION,
            "buildDate": D.isoformat(), "count": len(items),
            "codeCount": len({it["code"] for it in items}), "items": items}


def test_validator_accepts_generated_payload():
    assert history.validate_upcoming(valid_payload()) == []


def test_validator_accepts_legal_null_descriptive_fields():
    """只有未來列的代號描述欄位為 null——合法缺值不得被判為損毀（U15）。"""
    payload = valid_payload()
    payload["items"] = upcoming(
        [make_row(code="D000000100", price="11.00", frm="1151001", to="9991231")])
    payload["count"], payload["codeCount"] = 1, 1
    assert all(payload["items"][0][k] is None for k in META_FIELDS)
    assert history.validate_upcoming(payload) == []


@pytest.mark.parametrize("mutate,fragment", [
    (lambda p: p.update(generatorVersion="upcoming/0"), "generatorVersion"),
    (lambda p: p.update(count=99), "count"),
    (lambda p: p.update(codeCount=99), "codeCount"),
    (lambda p: p.update(buildDate="2026-13-01"), "buildDate"),
    (lambda p: p.pop("items"), "items"),
    (lambda p: p["items"][0].update(price=None, priceState="priced"), "price"),
    (lambda p: p["items"][0].update(priceState="terminated", price=12.5), "price"),
    (lambda p: p["items"][0].update(everPriced=False), "everPriced"),
    (lambda p: p["items"][0].update(pricedBefore=None), "everPriced"),
    (lambda p: p["items"][0].update(priceState="unknown"), "priceState"),
    (lambda p: p["items"][0].update(eventType="bumped"), "eventType"),
    (lambda p: p["items"][0].update(effectiveDate="2020-01-01"), "buildDate"),
    (lambda p: p["items"][0].update(endDate="2020-01-01"), "endDate"),
    (lambda p: p["items"][0].update(flags="none"), "flags"),
    (lambda p: p["items"][0].pop("pricedBefore"), "pricedBefore"),
    (lambda p: p["items"][0].update(rawPrice=12.5), "rawPrice"),
    (lambda p: p["items"][0].update(chName=123), "chName"),
])
def test_validator_rejects(mutate, fragment):
    payload = valid_payload()
    mutate(payload)
    errors = history.validate_upcoming(payload)
    assert errors and any(fragment in m for m in errors), errors


# ── 日期合法性：與 JS validator 共用同一組案例（R4／T1）────────────
DATE_CASES = json.loads((ROOT / "tests" / "fixtures" / "dates.json").read_text(encoding="utf-8"))


def test_date_validator_accepts_only_real_calendar_days():
    """`YYYY-MM-DD` 外形 ＋ 真實日曆日；基本格式 20260911 不收。

    tests-js/upcoming.test.mjs 以同一份 fixture 驗 JS 端，兩端判定必須一致。
    """
    for value in DATE_CASES["legal"]:
        assert history._is_iso_date(value) is True, value
    for value in DATE_CASES["illegal"]:
        assert history._is_iso_date(value) is False, value


@pytest.mark.parametrize("value", DATE_CASES["illegal"])
def test_validator_rejects_illegal_effective_date(value):
    payload = valid_payload()
    payload["items"] = payload["items"][:1]
    payload["count"], payload["codeCount"] = 1, 1
    payload["items"][0]["effectiveDate"] = value
    assert any("effectiveDate" in m for m in history.validate_upcoming(payload))


@pytest.mark.parametrize("value", DATE_CASES["illegal"])
def test_validator_rejects_illegal_build_date(value):
    payload = valid_payload()
    payload["items"], payload["count"], payload["codeCount"] = [], 0, 0
    payload["buildDate"] = value
    assert any("buildDate" in m for m in history.validate_upcoming(payload))
