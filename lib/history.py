"""價格歷史的純邏輯：正規化、排序、品質標記、事件推導、window、摘要。

全部為純函式（不做 I/O），規則對應 spec.md：
- §5.4 事件互斥優先序    → derive_events()
- §5.5 參考日摘要        → summary_at()
- §5.1 window 組成       → build_window()
- §6.1 invalidRecords    → normalize_rows()
- §6.3／§6.4 衝突、重疊、空窗 → annotate_flags()
- §6.6 描述欄位選列      → select_meta_row()、meta_payload()
"""

from collections import defaultdict
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from lib.nhi import FIELDS, classify_date, classify_price

FIELD_ORDER = tuple(FIELDS)          # 去重與 deterministic 排序用的完整欄位順序

# shard meta 保存的描述欄位（含兩個連結）；index 只放搜尋卡需要的子集
DESCRIPTIVE_FIELDS = (
    "chName", "enName", "ingredient", "strength", "strengthUnit", "compound",
    "manufacturer", "maker", "dosageForm", "drugClass", "groupName", "atcCode",
    "ruleChapter", "tfdaLink", "nhiRuleLink",
)
INDEX_META_FIELDS = (
    "chName", "enName", "ingredient", "strength", "strengthUnit",
    "dosageForm", "atcCode", "manufacturer",
)
QUESTION_MARK_FIELDS = ("chName", "enName", "ingredient")

UNKNOWN_STATES = frozenset({"missing", "malformed"})
CHANGE_EVENTS = frozenset({"increase", "decrease"})
CENT = Decimal("0.01")
ONE_DAY = timedelta(days=1)


# ── 正規化 ──────────────────────────────────────────────────────
def normalize_rows(rows):
    """來源列（已 strip）→ ({code: {"records": [...], "invalid": [...]}}, stats)。

    20 欄全同的列去重；無法形成有效 interval 的列進 invalid，保留原值、
    不參與任何時間推導（spec §6.1）。空白代號的列無法歸屬，只計數。
    """
    stats = defaultdict(int)
    stats["sourceRowCount"] = len(rows)
    seen = set()
    by_code = defaultdict(lambda: {"records": [], "invalid": []})

    for row in rows:
        key = tuple(row[k] for k in FIELD_ORDER)
        if key in seen:
            stats["duplicateRowsRemoved"] += 1
            continue
        seen.add(key)

        value, state = classify_price(row["price"])
        if state == "malformed":
            stats["malformedPriceRows"] += 1
        elif state == "missing":
            stats["missingPriceRows"] += 1

        code = row["code"]
        if not code:
            stats["blankCodeRows"] += 1
            continue

        start, s_status = classify_date(row["from"], is_end=False)
        end, e_status = classify_date(row["to"], is_end=True)
        error = None
        if s_status == "blank":
            error = "blank_start"
        elif "invalid" in (s_status, e_status):
            error = "invalid_date"
        elif end is not None and start > end:
            error = "inverted_interval"

        if error:
            stats["invalidRecords"] += 1
            by_code[code]["invalid"].append({
                "rawFrom": row["from"], "rawTo": row["to"], "rawPrice": row["price"],
                "error": error, "row": row,
            })
            continue

        if row["from"] == "9991231":
            stats["startSentinelRows"] += 1   # 起日出現開放哨兵：照常解析，僅警告
        by_code[code]["records"].append({
            "from": start, "to": end, "value": value, "rawPrice": row["price"],
            "priceState": state, "changeFlag": row["changeFlag"], "row": row,
            "flags": set(),
        })

    for entry in by_code.values():
        entry["records"].sort(key=record_sort_key)
        entry["invalid"].sort(key=lambda r: (r["rawFrom"], r["rawTo"], r["rawPrice"],
                                              tuple(r["row"][k] for k in FIELD_ORDER)))
    return dict(by_code), dict(stats)


def record_sort_key(r):
    """起日升冪 → 迄日升冪（null 最後）→ rawPrice → 全欄位，確保與輸入順序無關。"""
    return (r["from"], r["to"] or date.max, r["rawPrice"],
            tuple(r["row"][k] for k in FIELD_ORDER))


# ── 品質標記 ────────────────────────────────────────────────────
def _price_identity(r):
    return (r["priceState"], r["value"])


def annotate_flags(records):
    """就地加上 record flags；回傳代號層 flags（set）。

    衝突：同 (from, to) 有兩種以上價格／狀態。重疊與空窗以閉區間、
    對「累計最大迄日」比較，避免長區間包覆短區間時誤報空窗（spec §6.4）。
    """
    groups = defaultdict(list)
    for r in records:
        groups[(r["from"], r["to"])].append(r)
    for group in groups.values():
        if len({_price_identity(r) for r in group}) > 1:
            for r in group:
                r["flags"].add("conflicting_price_interval")

    max_end = None          # 已處理區間的最大迄日
    open_seen = False       # 是否已出現無迄日的區間
    for i, r in enumerate(records):
        r["_overlapConflict"] = False
        if i > 0:
            if open_seen or r["from"] <= max_end:
                r["flags"].add("overlap")
                r["_overlapConflict"] = any(
                    (p["to"] is None or p["to"] >= r["from"])
                    and _price_identity(p) != _price_identity(r)
                    for p in records[:i]
                )
            elif r["from"] > max_end + ONE_DAY:
                r["flags"].add("gap_before")
        if r["to"] is None:
            open_seen = True
        else:
            max_end = r["to"] if max_end is None else max(max_end, r["to"])

    code_flags = set()
    for r in records:
        if "gap_before" in r["flags"]:
            code_flags.add("gap")
        if "overlap" in r["flags"]:
            code_flags.add("overlap")
        if "conflicting_price_interval" in r["flags"]:
            code_flags.add("conflict")
    return code_flags


# ── 事件推導（spec §5.4，由上而下取第一個符合者）────────────────
def _change(prev, new):
    abs_change = (new - prev).quantize(CENT, rounding=ROUND_HALF_UP)
    pct = ((new - prev) / prev * 100).quantize(CENT, rounding=ROUND_HALF_UP)
    return abs_change, pct


def derive_events(records):
    """就地寫入 eventType／previousPrice／absoluteChange／percentChange／crossesStop。"""
    last_priced = None
    for i, r in enumerate(records):
        prev = records[i - 1] if i else None
        r.update(eventType=None, previousPrice=None, absoluteChange=None,
                 percentChange=None, crossesStop=False)
        state = r["priceState"]

        if prev is None:                                                    # 序 1
            r["eventType"] = "initial"
        elif (state in UNKNOWN_STATES or prev["priceState"] in UNKNOWN_STATES
              or "conflicting_price_interval" in r["flags"] or r.get("_overlapConflict")):
            r["eventType"] = "unknown"                                      # 序 2
        elif state in ("terminated", "suspended"):
            if prev["priceState"] == state:
                r["eventType"] = "unchanged"                                # 序 3／5
            else:
                r["eventType"] = state                                      # 序 4／6
                r["previousPrice"] = last_priced
        elif prev["priceState"] == "priced":
            r["previousPrice"] = prev["value"]
            if r["value"] == prev["value"]:
                r["eventType"] = "unchanged"                                # 序 7
            else:
                r["eventType"] = "increase" if r["value"] > prev["value"] else "decrease"
                r["absoluteChange"], r["percentChange"] = _change(prev["value"], r["value"])
        elif last_priced is not None:                                       # 序 9
            r["eventType"] = "relisted"
            r["previousPrice"] = last_priced
            r["crossesStop"] = True
            r["absoluteChange"], r["percentChange"] = _change(last_priced, r["value"])
        else:                                                               # 序 10
            r["eventType"] = "first_priced"

        if state == "priced":
            last_priced = r["value"]


# ── window 與描述欄位 ───────────────────────────────────────────
def is_effective(r, day):
    return r["from"] <= day and (r["to"] is None or r["to"] >= day)


def build_window(records, build_date):
    """spec §5.1：[build 日有效區間, 最早未生效區間]；回傳 (record, extra_flags) 清單。"""
    current = [r for r in records if is_effective(r, build_date)]
    upcoming = next((r for r in records if r["from"] > build_date), None)
    window = []
    if current:
        window.append((current[0], {"conflict"} if len(current) > 1 else set()))
    if upcoming is not None:
        window.append((upcoming, set()))
    return window


def select_meta_row(records, day):
    """spec §6.6：day 當日有效列 → from ≤ day 中 from 最晚者 → None（不以預告列回填）。"""
    current = [r for r in records if is_effective(r, day)]
    if current:
        return current[0]["row"]
    past = [r for r in records if r["from"] <= day]
    if past:
        latest = max(r["from"] for r in past)
        return next(r for r in reversed(past) if r["from"] == latest)["row"]
    return None


def _descriptive(row):
    return {k: row[k] for k in DESCRIPTIVE_FIELDS}


def meta_payload(records, invalid):
    """一致 → ("meta", dict)；不一致 → ("metaVariants", [...])，不依 build 日。

    不一致時每個變體記錄其首次出現之 record 的 from，由前端依日期套用
    §6.6 規則；shard 因此跨 build 日維持 deterministic。
    """
    all_rows = [r["row"] for r in records] + [r["row"] for r in invalid]
    distinct = {tuple(_descriptive(row).items()) for row in all_rows}
    if len(distinct) <= 1:
        return "meta", _descriptive(all_rows[0]), False
    # recordIndex：變體首次出現之 record 的索引。只記 from 時，同起日、不同描述的兩列
    # 無法對應回 select_meta_row 選中的那一列（codex R4）
    variants, last = [], None
    for i, r in enumerate(records):
        d = _descriptive(r["row"])
        if d != last:
            variants.append({"from": r["from"].isoformat(), "recordIndex": i, **d})
            last = d
    if not variants:   # 只有 invalid 列時退回第一列，避免詳細頁無品名可顯示
        return "meta", _descriptive(all_rows[0]), True
    return "metaVariants", variants, True


def has_question_mark(records, invalid):
    rows = [r["row"] for r in records] + [r["row"] for r in invalid]
    return any("?" in row[k] for row in rows for k in QUESTION_MARK_FIELDS)


# ── 參考日摘要（spec §5.5；前端須實作相同規則）──────────────────
def summary_at(records, ref):
    """以參考日 ref 計算摘要；預告區間（from > ref）一律不計入統計。"""
    effective = [r for r in records if r["from"] <= ref]
    current = [r for r in records if is_effective(r, ref)]

    if len(current) > 1:
        status = "conflict"
    elif current:
        status = current[0]["priceState"]
    elif not records or ref < records[0]["from"]:
        status = "not_yet_effective"
    elif effective:
        # ref 之後仍有區間 → 位於空窗；否則已超過所有區間的迄日
        status = "gap" if any(r["from"] > ref for r in records) else "no_record"
    else:
        status = "no_record"

    # 最新事件跳過 unchanged；若只剩 initial／first_priced 則視為「無調價紀錄」
    latest = next((r for r in reversed(effective) if r["eventType"] != "unchanged"), None)
    if latest is not None and latest["eventType"] in ("initial", "first_priced"):
        latest = None

    priced = [r for r in effective if r["priceState"] == "priced"]
    total = None
    if len(priced) >= 2:
        first, last = priced[0]["value"], priced[-1]["value"]
        abs_change, pct = _change(first, last)
        total = {"from": first, "to": last, "absoluteChange": abs_change, "percentChange": pct}

    upcoming = next((r for r in records if r["from"] > ref), None)
    return {
        "status": status,
        "current": current[0] if len(current) == 1 else None,
        "currentCandidates": current,
        "upcoming": upcoming,
        "latestEvent": latest,
        "priceChangeCount": sum(1 for r in effective if r["eventType"] in CHANGE_EVENTS),
        "pricedCount": len(priced),
        "totalChange": total,
    }


def last_change_date(records, ref):
    """ref 之前最後一個非 initial／unchanged 事件的起日（搜尋卡「最近一次異動」）。"""
    for r in reversed(records):
        if r["from"] <= ref and r["eventType"] not in ("initial", "unchanged"):
            return r["from"]
    return None


# ── JSON 表示 ───────────────────────────────────────────────────
def _num(d):
    return None if d is None else float(d)


def record_json(r, extra_flags=()):
    return {
        "from": r["from"].isoformat(),
        "to": r["to"].isoformat() if r["to"] else None,
        "price": _num(r["value"]),
        "rawPrice": r["rawPrice"],
        "priceState": r["priceState"],
        "changeFlag": r["changeFlag"],
        "eventType": r["eventType"],
        "previousPrice": _num(r["previousPrice"]),
        "absoluteChange": _num(r["absoluteChange"]),
        "percentChange": _num(r["percentChange"]),
        "crossesStop": r["crossesStop"],
        "flags": sorted(set(r["flags"]) | set(extra_flags)),
    }


def priced_before(records, target):
    """target 之前（排序在前）最後一個 priced 金額；只看過去列，不受未來恢復支付影響。

    搜尋卡只有 window，無法回看完整歷史：「終止→終止續期」（unchanged）的
    previousPrice 依 §5.4 為 null，需此值才能顯示「終止前 X 元」，並判斷是否套用
    「此前無有價紀錄」標籤（spec §5.3）。
    """
    last = None
    for r in records:
        if r is target:
            return last
        if r["priceState"] == "priced":
            last = r["value"]
    raise ValueError("target 不在 records 中")


def window_json(records, r, extra_flags):
    return {**record_json(r, extra_flags), "pricedBefore": _num(priced_before(records, r))}


def invalid_json(r):
    return {"rawFrom": r["rawFrom"], "rawTo": r["rawTo"], "rawPrice": r["rawPrice"],
            "error": r["error"]}


def build_code(code, entry, build_date):
    """單一代號 → (shard entry, index entry, code_flags)。"""
    records, invalid = entry["records"], entry["invalid"]
    flags = annotate_flags(records)
    derive_events(records)
    if invalid:
        flags.add("invalid_records")
    if has_question_mark(records, invalid):
        flags.add("question_mark")
    meta_key, meta_value, inconsistent = meta_payload(records, invalid)
    if inconsistent:
        flags.add("inconsistent_metadata")

    shard_entry = {
        meta_key: meta_value,
        "records": [record_json(r) for r in records],
        "invalidRecords": [invalid_json(r) for r in invalid],
        "flags": sorted(flags),
    }

    meta_row = select_meta_row(records, build_date)
    summary = summary_at(records, build_date)
    last_change = last_change_date(records, build_date)
    index_entry = {
        "code": code,
        **{k: (meta_row[k] if meta_row else "") for k in INDEX_META_FIELDS},
        "window": [window_json(records, r, extra) for r, extra in build_window(records, build_date)],
        "historyCount": len(records) + len(invalid),
        "priceChangeCount": summary["priceChangeCount"],
        "firstEffectiveDate": records[0]["from"].isoformat() if records else None,
        "lastPriceChangeDate": last_change.isoformat() if last_change else None,
        "flags": sorted(flags),
    }
    return shard_entry, index_entry, flags
