#!/usr/bin/env python3
"""產生 F7a／F7b 共用 fixture：tests/fixtures/index_format_cases.json（spec-index-format.md v0.4 §7.1）。

**expected 由本檔逐案手寫，不呼叫任何 validator**——期望值若由受測程式產生，
等於自我證明（§7.0 的同一條教訓）。JS 與 Python 各自讀這份檔案、各自對 expected 驗證，
不互比、不委派。

- F7a（共通層）：`expect.py == expect.js`
- F7b（builder 層）：`expect.py = invalid`、`expect.js = ok`；以 §3.3 逐欄 × 逐性質列成完整矩陣，
  每案只破壞一個性質
- 注入位置一律是**最後一個 drug row／最後一個 window 列**（F13 同位置）

用法：
  uv run python scripts/gen_index_format_cases.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):          # CP950 主控台印不出部分字元
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "index_format_cases.json"

# 本檔刻意**不 import** lib.index_format：常數也手寫一份，兩端各自比對這份才擋得住漂移
FIELDS = [
    "code", "chName", "enName", "ingredient", "dosageForm", "strength", "strengthUnit",
    "atcCode", "manufacturer", "firstEffectiveDate", "lastPriceChangeDate",
    "historyCount", "priceChangeCount", "flags",
]
WINDOW_FIELDS = [
    "from", "to", "price", "rawPrice", "previousPrice", "pricedBefore", "priceState",
    "eventType", "crossesStop", "changeFlag", "absoluteChange", "percentChange", "flags",
]
PRICE_STATES = ["priced", "terminated", "suspended", "missing", "malformed"]
EVENT_TYPES = ["initial", "unknown", "unchanged", "terminated", "suspended",
               "increase", "decrease", "relisted", "first_priced"]

INF = "__INF__"          # JSON 寫不出 Infinity；輸出時換成合法 literal 1e400（JS/Python 都 parse 成 inf）
OK = {"ok": True, "reason": None}
INVALID = {"ok": False, "reason": "invalid"}
MISMATCH = {"ok": False, "reason": "version_mismatch"}
META = {"dataVersion": "v1", "uniqueDrugCodeCount": 3}


def win(**kw):
    w = {"from": "2026-01-01", "to": None, "price": 10.5, "rawPrice": "10.5",
         "previousPrice": None, "pricedBefore": None, "priceState": "priced",
         "eventType": "initial", "crossesStop": False, "changeFlag": "",
         "absoluteChange": None, "percentChange": None, "flags": []}
    w.update(kw)
    return [w[k] for k in WINDOW_FIELDS]


def drug(code, windows, **kw):
    d = {"code": code, "chName": "藥品", "enName": "Drug", "ingredient": "Ing",
         "dosageForm": "錠劑", "strength": "", "strengthUnit": "", "atcCode": "A01",
         "manufacturer": "廠商", "firstEffectiveDate": "2020-01-01",
         "lastPriceChangeDate": None, "historyCount": 1, "priceChangeCount": 0, "flags": []}
    d.update(kw)
    return [d[k] for k in FIELDS] + [windows]


def base():
    """最小合法 index：3 筆、最後一筆有 2 個 window 列（注入點都在最後）。"""
    return {
        "dataVersion": "v1", "indexFormat": "columnar/1",
        "fields": list(FIELDS), "windowFields": list(WINDOW_FIELDS),
        "rows": [
            drug("A1", [win()]),
            drug("B2", [win(priceState="terminated", rawPrice="0", price=0, pricedBefore=12.0,
                            eventType="terminated", previousPrice=12.0)]),
            drug("C3", [win(to="2026-06-30"),
                        win(**{"from": "2026-07-01"}, price=9.0, rawPrice="9", previousPrice=10.5,
                            pricedBefore=10.5, eventType="decrease", absoluteChange=-1.5,
                            percentChange=-14.29, changeFlag="-")],
                 lastPriceChangeDate="2026-07-01", historyCount=2, priceChangeCount=1),
        ],
    }


class Replace:
    def __init__(self, value):
        self.value = value


def set_drug(field, value):
    def f(doc):
        doc["rows"][-1][FIELDS.index(field)] = value
    return f


def set_win(field, value):
    def f(doc):
        doc["rows"][-1][len(FIELDS)][-1][WINDOW_FIELDS.index(field)] = value
    return f


def cases():
    out = []

    def add(layer, name, mutate, py, js):
        doc = base()
        if mutate is not None:
            r = mutate(doc)
            if isinstance(r, Replace):            # 整份換掉（null、陣列等非 object 輸入）
                doc = r.value
        out.append({"layer": layer, "name": name, "index": doc, "meta": META,
                    "expect": {"py": py, "js": js}})

    def common(name, mutate, expect=INVALID):
        add("common", name, mutate, expect, expect)

    def builder(name, mutate):
        add("builder", name, mutate, INVALID, OK)

    def edge(name, mutate):
        add("builder-edge", name, mutate, OK, OK)

    # ── F7a 正例 ─────────────────────────────────────────────
    common("最小合法 fixture", None, OK)

    def extra_fields(doc):
        doc["fields"].append("extraDrug")
        doc["windowFields"].append("extraWin")
        for r in doc["rows"]:
            w = r.pop()
            for wr in w:
                wr.append({"任意": "值"})       # 附加欄位不驗型別（§4.1）
            r.append(123)
            r.append(w)
    common("含合法附加欄位", extra_fields, OK)

    # ── F7a 最小結構前提與優先序 ─────────────────────────────
    common("index 為 null", lambda d: Replace(None))
    common("index 為陣列", lambda d: Replace([]))
    common("缺 dataVersion", lambda d: d.pop("dataVersion") and None)
    common("dataVersion 非字串", lambda d: d.update(dataVersion=1))
    # 缺 indexFormat＝legacy index（新前端＋舊 index 的 CDN 混批）→ 可自癒的 mismatch（§3.6、§8、F5）
    common("缺 indexFormat", lambda d: d.pop("indexFormat") and None, MISMATCH)
    common("indexFormat 非字串", lambda d: d.update(indexFormat=1), MISMATCH)
    common("legacy index（有 drugs、無 indexFormat）",
           lambda d: Replace({"dataVersion": "v1", "drugs": []}), MISMATCH)
    common("indexFormat 錯值", lambda d: d.update(indexFormat="columnar/0"), MISMATCH)
    common("dataVersion 與 meta 不符", lambda d: d.update(dataVersion="v2"), MISMATCH)
    common("優先序：最小結構錯＋format mismatch → invalid",
           lambda d: (d.pop("dataVersion"), d.update(indexFormat="columnar/0")) and None)
    common("優先序：format mismatch＋schema 錯 → version_mismatch",
           lambda d: d.update(indexFormat="columnar/0", rows=[]), MISMATCH)
    common("優先序：dataVersion mismatch＋schema 錯 → version_mismatch",
           lambda d: d.update(dataVersion="v2", rows=[]), MISMATCH)

    # ── F7a fields／windowFields（F6 另逐欄全量）────────────────
    common("fields 非陣列", lambda d: d.update(fields="code"))
    common("fields 缺前綴欄", lambda d: d["fields"].pop(3) and None)
    common("fields 前綴順序錯", lambda d: d.update(fields=[FIELDS[1], FIELDS[0], *FIELDS[2:]]))
    common("fields 附加欄重複", lambda d: d["fields"].append("code"))
    common("fields 附加欄為空字串", lambda d: d["fields"].append(""))
    common("fields 附加欄非字串", lambda d: d["fields"].append(1))
    common("windowFields 缺前綴欄", lambda d: d["windowFields"].pop() and None)
    common("windowFields 附加欄重複", lambda d: d["windowFields"].append("from"))

    # ── F7a rows 結構 ────────────────────────────────────────
    common("rows 非陣列", lambda d: d.update(rows={}))
    common("rows 為空", lambda d: d.update(rows=[]))
    common("rows 筆數與 meta 不符", lambda d: d["rows"].pop() and None)
    common("drug row 非陣列", lambda d: d["rows"].__setitem__(-1, {}))
    common("drug row 短一欄", lambda d: d["rows"][-1].pop(0) and None)
    common("drug row 長一欄", lambda d: d["rows"][-1].insert(0, "x"))
    common("window 非陣列", lambda d: d["rows"][-1].__setitem__(len(FIELDS), {}))
    common("window 列非陣列", lambda d: d["rows"][-1][len(FIELDS)].__setitem__(-1, {}))
    common("window 列短一欄", lambda d: d["rows"][-1][len(FIELDS)][-1].pop() and None)
    common("window 列長一欄", lambda d: d["rows"][-1][len(FIELDS)][-1].append(None))

    # ── F7a code ─────────────────────────────────────────────
    common("code 為空字串", set_drug("code", ""))
    common("code 為 number", set_drug("code", 3))
    common("code 為 null", set_drug("code", None))
    common("code 重複", set_drug("code", "B2"))
    common("code 未排序", set_drug("code", "A0"))

    # ── F7a 判定關鍵欄：錯型別／值域外 ─────────────────────────
    for f in ("chName", "enName", "ingredient"):
        common(f"drug {f} 為 number", set_drug(f, 1))
        common(f"drug {f} 為 null", set_drug(f, None))
    for f in ("historyCount", "priceChangeCount"):
        common(f"drug {f} 為字串", set_drug(f, "3"))
        common(f"drug {f} 為 boolean", set_drug(f, True))
        common(f"drug {f} 為 null", set_drug(f, None))
    common("drug flags 為字串", set_drug("flags", "x"))
    common("drug flags 為 object", set_drug("flags", {}))
    common("drug flags 為 null", set_drug("flags", None))
    common("window priceState 不在值域", set_win("priceState", "bogus"))
    common("window priceState 為 number", set_win("priceState", 1))
    common("window priceState 為 null", set_win("priceState", None))
    common("window eventType 不在值域", set_win("eventType", "bogus"))
    common("window eventType 為 null", set_win("eventType", None))
    common("window flags 為字串", set_win("flags", "conflict"))
    common("window flags 為 null", set_win("flags", None))
    common("window from 為 number", set_win("from", 20260701))
    common("window from 為 null", set_win("from", None))
    common("window to 為 number", set_win("to", 5))
    common("window pricedBefore 為字串", set_win("pricedBefore", "10.5"))
    common("window pricedBefore 為 boolean", set_win("pricedBefore", True))

    # ── F7a 判定關鍵欄：合法鄰近值 ─────────────────────────────
    common("window to 為 null（合法）", set_win("to", None), OK)
    common("window pricedBefore 為 null（合法）", set_win("pricedBefore", None), OK)
    common("window flags 為 []（合法）", set_win("flags", []), OK)
    for s in PRICE_STATES:
        common(f"window priceState={s}（合法）", set_win("priceState", s), OK)
    for e in EVENT_TYPES:
        common(f"window eventType={e}（合法）", set_win("eventType", e), OK)

    # ── F7b builder 層完整矩陣：drug ──────────────────────────
    for f in ("dosageForm", "strength", "strengthUnit", "atcCode", "manufacturer"):
        builder(f"drug {f} 為 number", set_drug(f, 1))
        builder(f"drug {f} 為 null", set_drug(f, None))
        builder(f"drug {f} 為 array", set_drug(f, []))
    builder("drug firstEffectiveDate 為 null", set_drug("firstEffectiveDate", None))
    builder("drug firstEffectiveDate 為 number", set_drug("firstEffectiveDate", 20200101))
    builder("drug firstEffectiveDate 非 YYYY-MM-DD", set_drug("firstEffectiveDate", "20200101"))
    builder("drug firstEffectiveDate 非真實日曆日", set_drug("firstEffectiveDate", "2027-02-30"))
    builder("drug lastPriceChangeDate 為 number", set_drug("lastPriceChangeDate", 20260701))
    builder("drug lastPriceChangeDate 非 YYYY-MM-DD", set_drug("lastPriceChangeDate", "2026/07/01"))
    builder("drug lastPriceChangeDate 非真實日曆日", set_drug("lastPriceChangeDate", "2026-13-01"))
    for f in ("historyCount", "priceChangeCount"):
        builder(f"drug {f} 為負數", set_drug(f, -1))
        builder(f"drug {f} 為小數", set_drug(f, 1.5))
        builder(f"drug {f} 非 finite", set_drug(f, INF))
    builder("drug flags 含非字串元素", set_drug("flags", [1]))
    builder("drug flags 含 null 元素", set_drug("flags", [None]))

    # ── F7b builder 層完整矩陣：window ────────────────────────
    builder("window from 非 YYYY-MM-DD", set_win("from", "20260701"))
    builder("window from 非真實日曆日", set_win("from", "2027-02-30"))
    builder("window to 非 YYYY-MM-DD", set_win("to", "2026-7-1"))
    builder("window to 非真實日曆日", set_win("to", "2026-02-29"))
    for f in ("price", "previousPrice", "absoluteChange", "percentChange"):
        builder(f"window {f} 為字串", set_win(f, "10"))
        builder(f"window {f} 為 boolean", set_win(f, True))
        builder(f"window {f} 非 finite", set_win(f, INF))
    builder("window pricedBefore 非 finite", set_win("pricedBefore", INF))
    builder("window rawPrice 為 number", set_win("rawPrice", 9))
    builder("window rawPrice 為 null", set_win("rawPrice", None))
    builder("window changeFlag 為 number", set_win("changeFlag", 1))
    builder("window changeFlag 為 null", set_win("changeFlag", None))
    builder("window crossesStop 為 number", set_win("crossesStop", 0))
    builder("window crossesStop 為字串", set_win("crossesStop", "true"))
    builder("window crossesStop 為 null", set_win("crossesStop", None))
    builder("window flags 含非字串元素", set_win("flags", [1]))

    # ── builder 層合法邊界正例：兩端都必須 ok ──────────────────
    edge("count 為 0", lambda d: (set_drug("historyCount", 0)(d), set_drug("priceChangeCount", 0)(d)) and None)
    edge("drug 字串欄皆為空字串", lambda d: [set_drug(f, "")(d) for f in (
        "chName", "enName", "ingredient", "dosageForm", "strength", "strengthUnit",
        "atcCode", "manufacturer")] and None)
    edge("nullable 數字欄皆為 null", lambda d: [set_win(f, None)(d) for f in (
        "price", "previousPrice", "pricedBefore", "absoluteChange", "percentChange")] and None)
    edge("lastPriceChangeDate 為 null", set_drug("lastPriceChangeDate", None))
    edge("閏年 2028-02-29", set_win("from", "2028-02-29"))
    edge("window 為空陣列", lambda d: d["rows"][-1].__setitem__(len(FIELDS), []))
    edge("flags 含字串元素", lambda d: (set_drug("flags", ["questionMark"])(d),
                                    set_win("flags", ["overlap"])(d)) and None)
    edge("price 為整數 0", set_win("price", 0))
    return out


def main():
    doc = {
        "_comment": "由 scripts/gen_index_format_cases.py 產生；expected 逐案手寫，勿手改本檔",
        "constants": {"indexFormat": "columnar/1", "fields": FIELDS, "windowFields": WINDOW_FIELDS,
                      "priceStates": PRICE_STATES, "eventTypes": EVENT_TYPES},
        "cases": cases(),
    }
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    text = text.replace(f'"{INF}"', "1e400")
    OUT.write_text(text + "\n", encoding="utf-8", newline="\n")
    counts = {}
    for c in doc["cases"]:
        counts[c["layer"]] = counts.get(c["layer"], 0) + 1
    print(f"已寫出 {OUT.relative_to(ROOT)}：{counts}")


if __name__ == "__main__":
    main()
