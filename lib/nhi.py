"""NHI 健保用藥品項檔的來源存取與欄位解析。

自 TFDA-drug-info-search/build_data.py 抽出，並依 spec.md §4 改寫：
- 下載或內容驗證失敗一律 raise（舊版回傳 [] 會讓下游把空資料當正常）
- 必要欄位模糊比對歧義 → raise（舊版只警告，會靜默抓錯欄位）
- 價格改為 (Decimal|None, state) 五態分類，不再把缺值／格式錯誤折成 0.0
- `9991231` 只在迄日視為開放哨兵
"""

import csv
import io
import sys
import time
from datetime import date
from decimal import Decimal, InvalidOperation

import requests

NHI_CSV_URL = "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001"
DATAGOV_META_URL = "https://data.gov.tw/api/v2/rest/dataset/23715"
SOURCE_ID = "NHIA A21030000I-E41001-001"

TIMEOUT_SEC = 180
MAX_RETRIES = 3
RETRY_BASE_SEC = 5   # 指數退避：5、10、20…

OPEN_END_SENTINEL = "9991231"

# 藥師判斷「應為暫停支付」的標記僅限 "-" 系列；N/A、NA、無 等不在判斷範圍內，
# 歸 malformed（2026-09-11 實測全部 975 列皆為 "-"）
SUSPENDED_MARKERS = frozenset({"-", "－", "—"})

# canonical key → (來源欄名候選, 是否必要)
FIELDS = {
    "changeFlag":   (("異動",), False),
    "code":         (("藥品代號",), True),
    "enName":       (("藥品英文名稱",), False),
    "chName":       (("藥品中文名稱",), False),
    "ingredient":   (("成分",), False),
    "strength":     (("規格量",), False),
    "strengthUnit": (("規格單位",), False),
    "compound":     (("單複方",), False),
    "price":        (("支付價",), True),
    "from":         (("有效起日",), True),
    "to":           (("有效迄日",), True),
    "manufacturer": (("藥商",), False),
    "maker":        (("製造廠名稱",), False),
    "dosageForm":   (("劑型",), False),
    "drugClass":    (("藥品分類",), False),
    "groupName":    (("分類分組名稱",), False),
    "atcCode":      (("ATC代碼",), False),
    "ruleChapter":  (("給付規定章節",), False),
    "tfdaLink":     (("藥品代碼超連結",), False),
    "nhiRuleLink":  (("給付規定章節連結",), False),
}

# 下載／解析階段預期的例外。刻意不 catch Exception：print() 的
# UnicodeEncodeError 若被吞掉會偽裝成「下載失敗」（舊專案 2026-07-20 踩過）
FETCH_ERRORS = (requests.RequestException, csv.Error, OSError, UnicodeDecodeError)


class SourceError(Exception):
    """來源不可用或內容不合法；build 必須中止且不得覆寫既有資料。"""


def log(msg):
    print(msg, file=sys.stderr)


# ── 下載 ────────────────────────────────────────────────────────
def is_retryable(exc):
    """連線／逾時類與 429、5xx 值得重試；其他 4xx 重試也是同樣結果。"""
    resp = getattr(exc, "response", None)
    if resp is None:
        return True
    code = resp.status_code
    return code == 429 or code >= 500


def download(url, label, max_retries=MAX_RETRIES, sleep=time.sleep, get=requests.get):
    """下載並回傳 bytes；一律驗證 TLS。失敗 raise SourceError。

    本資料供臨床查詢，傳輸遭竄改等同污染藥品資料，寧可失敗也不得降級。
    `sleep`／`get` 可注入，供測試驗證重試次數與間隔。
    """
    headers = {"User-Agent": "Mozilla/5.0 NHI-PriceHistory/0.1", "Accept": "*/*"}
    for attempt in range(1, max_retries + 1):
        try:
            resp = get(url, timeout=TIMEOUT_SEC, headers=headers, stream=True)
            resp.raise_for_status()
            data = b"".join(resp.iter_content(chunk_size=1024 * 1024))
            log(f"  ✓ {label}：{len(data) / 1e6:.2f} MB")
            return data
        except requests.RequestException as e:
            if not is_retryable(e):
                raise SourceError(f"{label} 下載失敗（不可重試）：{e}") from e
            if attempt >= max_retries:
                raise SourceError(f"{label} 下載失敗（已重試 {max_retries} 次）：{e}") from e
            wait = RETRY_BASE_SEC * (2 ** (attempt - 1))
            log(f"  ⚠ {label} 第 {attempt} 次失敗，{wait} 秒後重試：{e}")
            sleep(wait)
    raise SourceError(f"{label} 下載失敗")  # max_retries < 1 時才會到這裡


def fetch_source_modified(get=requests.get):
    """data.gov.tw 資料集 metadata 的 modifiedDate；任何失敗回傳 None 並警告。

    非核心資料：取不到不擋 build（spec §3），但必須明確記 warning，不可靜默。
    """
    try:
        resp = get(DATAGOV_META_URL, timeout=30,
                   headers={"User-Agent": "Mozilla/5.0 NHI-PriceHistory/0.1"})
        resp.raise_for_status()
        value = resp.json()["result"]["modifiedDate"]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"modifiedDate 非字串：{value!r}")
        return value.strip()
    except (requests.RequestException, ValueError, KeyError, TypeError) as e:
        log(f"  ⚠ WARNING：無法取得 data.gov.tw 資料集更新時間，sourceModifiedAt 記為 null（{e}）")
        return None


# ── 解碼與 schema ────────────────────────────────────────────────
def smart_decode(raw):
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16").lstrip("﻿")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8")
    for enc in ("utf-8", "big5", "cp950"):
        try:
            return raw.decode(enc).lstrip("﻿")
        except (UnicodeDecodeError, LookupError):
            continue
    raise SourceError("來源無法以 UTF-8／Big5／CP950 解碼")


def detect_field(fieldnames, patterns, required):
    """依 patterns 找欄位：先精確，再模糊包含。

    模糊比對命中多個候選時：必要欄位 raise（寧可失敗也不抓錯欄），
    非必要欄位警告並取第一個。
    """
    keys = [str(k).strip() for k in fieldnames]
    for p in patterns:
        if p in keys:
            return p
    for p in patterns:
        hits = [k for k in keys if p in k]
        if len(hits) > 1:
            if required:
                raise SourceError(f"必要欄位「{p}」模糊比對命中多個候選 {hits}")
            log(f"  ⚠ 欄位「{p}」模糊比對命中多個候選 {hits}，採用第一個")
        if hits:
            return hits[0]
    if required:
        raise SourceError(f"找不到必要欄位「{patterns[0]}」；來源欄位：{keys}")
    return None


def parse_csv(raw):
    """bytes → list[dict]（canonical key，值已 strip）。內容不合法一律 raise。

    HTTP 200 不代表內容正確：錯誤頁（HTML）、截斷、欄位錯位都要在這裡擋下。
    """
    try:
        text = smart_decode(raw)
    except UnicodeDecodeError as e:
        raise SourceError(f"來源解碼失敗：{e}") from e
    head = text.lstrip()[:200].lower()
    if head.startswith("<") or "<html" in head:
        raise SourceError("來源內容為 HTML（疑似錯誤頁），非 CSV")
    if text and not text.endswith(("\n", "\r")):
        raise SourceError("來源 CSV 未以換行結尾，疑似下載截斷")

    try:
        reader = csv.DictReader(io.StringIO(text))
        fieldnames = reader.fieldnames or []
        mapping = {key: detect_field(fieldnames, pats, req)
                   for key, (pats, req) in FIELDS.items()}
        rows = []
        for lineno, r in enumerate(reader, start=2):
            if None in r or any(v is None for v in r.values()):
                raise SourceError(f"第 {lineno} 行欄位數與表頭不符（疑似截斷或欄位錯位）")
            rows.append({key: (r[src] or "").strip() if src else ""
                         for key, src in mapping.items()})
    except csv.Error as e:
        raise SourceError(f"CSV 解析失敗：{e}") from e
    if not rows:
        raise SourceError("來源 CSV 無資料列")
    return rows


# ── 日期 ────────────────────────────────────────────────────────
def parse_date_token(s):
    """民國 6/7 碼或西元 8 碼 → date；無法解析回 None。呼叫端須先 strip。"""
    if not s.isdigit():
        return None
    try:
        if len(s) == 7:
            return date(int(s[:3]) + 1911, int(s[3:5]), int(s[5:7]))
        if len(s) == 6:
            return date(int(s[:2]) + 1911, int(s[2:4]), int(s[4:6]))
        if len(s) == 8:
            return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None
    return None


def classify_date(s, is_end):
    """→ (date|None, status)；status ∈ {'ok', 'open', 'blank', 'invalid'}。

    'open' 僅用於迄日（`9991231` 或空白）；起日空白回 'blank'，由呼叫端列為
    invalidRecord。非空但無法解析一律 'invalid'，不得當成開放區間。
    """
    s = (s or "").strip()
    if is_end and s in ("", OPEN_END_SENTINEL):
        return None, "open"
    if not s:
        return None, "blank"
    d = parse_date_token(s)
    return (d, "ok") if d else (None, "invalid")


# ── 價格 ────────────────────────────────────────────────────────
def classify_price(raw):
    """strip 後的原字串 → (Decimal|None, priceState)。

    priced 才有數值；terminated／suspended／missing／malformed 一律 None，
    避免任何下游把它們當成 0 元畫進圖表或參與差額計算。
    """
    s = (raw or "").strip()
    if not s:
        return None, "missing"
    if s in SUSPENDED_MARKERS:
        return None, "suspended"
    try:
        v = Decimal(s)
    except InvalidOperation:
        return None, "malformed"
    # is_signed 同時擋下負數與 "-0"；負的支付價沒有合理語意
    if not v.is_finite() or v.is_signed():
        return None, "malformed"
    if v == 0:
        return None, "terminated"
    return v, "priced"
