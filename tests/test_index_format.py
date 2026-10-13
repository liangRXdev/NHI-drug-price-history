"""spec-index-format.md v0.4：F7a／F7b（Python 側）、F12、validator 單一實作。

expected 一律讀 tests/fixtures/index_format_cases.json（逐案手寫，不由受測程式產生）。
JS 側在 tests-js/index-format.test.mjs 各自對同一份 expected 驗證——兩端不互比。
"""

import importlib.util
import json
from datetime import date
from pathlib import Path

import pytest

import build_price_history as bph
from build_price_history import BuildError, GuardConfig, run
from lib import index_format
from tests.helpers import SNAPSHOT, tree_hash

ROOT = Path(__file__).resolve().parent.parent
CASES_DOC = json.loads((ROOT / "tests/fixtures/index_format_cases.json").read_text("utf-8"))
CASES = CASES_DOC["cases"]
CHECKED = "2026-09-11T12:00:00+08:00"


def load_converter():
    spec = importlib.util.spec_from_file_location("convert_index_columnar",
                                                  ROOT / "scripts/convert_index_columnar.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── 常數漂移（engine.js 在 JS 測試側比對同一份）──────────────────
def test_constants_match_spec_fixture():
    c = CASES_DOC["constants"]
    assert index_format.INDEX_FORMAT == c["indexFormat"]
    assert index_format.FIELDS == c["fields"]
    assert index_format.WINDOW_FIELDS == c["windowFields"]
    assert index_format.PRICE_STATES == set(c["priceStates"])
    assert index_format.EVENT_TYPES == set(c["eventTypes"])


# ── F7a／F7b：Python 對 expect.py 驗證 ─────────────────────────
@pytest.mark.parametrize("case", CASES, ids=[f"{c['layer']}:{c['name']}" for c in CASES])
def test_f7_python_matches_expected(case):
    r = index_format.validate_index(case["index"], case["meta"])
    assert {"ok": r.ok, "reason": r.reason} == case["expect"]["py"], r.error


def test_f7_fixture_covers_every_layer_and_has_positive_cases():
    """防「validator 一律回 invalid」：每層都要有 ok 正例，且矩陣不得縮水。"""
    by_layer = {}
    for c in CASES:
        by_layer.setdefault(c["layer"], []).append(c)
    assert any(c["expect"]["py"]["ok"] for c in by_layer["common"])
    assert all(c["expect"]["py"]["ok"] and c["expect"]["js"]["ok"] for c in by_layer["builder-edge"])
    assert all(not c["expect"]["py"]["ok"] and c["expect"]["js"]["ok"] for c in by_layer["builder"])
    # 每個 builder 層欄位都至少有一案（§3.3 逐欄矩陣，不得只驗代表欄位）
    builder_only = {"dosageForm", "strength", "strengthUnit", "atcCode", "manufacturer",
                    "firstEffectiveDate", "lastPriceChangeDate", "historyCount", "priceChangeCount",
                    "from", "to", "price", "rawPrice", "previousPrice", "pricedBefore",
                    "crossesStop", "changeFlag", "absoluteChange", "percentChange", "flags"}
    names = " ".join(c["name"] for c in by_layer["builder"])
    assert {f for f in builder_only if f not in names} == set()


def test_common_layer_only_mode_accepts_builder_layer_errors():
    """`builder=False` 只跑共通層——它對 builder 層 fixture 的結果必須等於 JS 的 expected。"""
    for c in CASES:
        r = index_format.validate_index(c["index"], c["meta"], builder=False)
        assert {"ok": r.ok, "reason": r.reason} == c["expect"]["js"], c["name"]


# ── F12：builder 發布路徑全量驗證 ───────────────────────────────
def build(tmp, **kw):
    kw.setdefault("checked_at", CHECKED)
    kw.setdefault("cfg", GuardConfig(min_rows=1, min_codes=1))
    return run(SNAPSHOT.read_bytes(), data_dir=tmp, build_date=date(2026, 9, 11),
               source_modified=None, fixtures_dir="__none__", **kw)


def test_f12_success_baseline_reports_dynamic_counts(tmp_path):
    """成功基準：不注入時 build 必須成功，且回報的筆數是**實際走訪數**，與寫出的檔案獨立計算相符。"""
    result = build(tmp_path)
    written = json.loads((tmp_path / "drug_index.json").read_text("utf-8"))
    n = len(written["fields"])
    assert result["indexValidated"] == {
        "drugs": len(written["rows"]),
        "windows": sum(len(r[n]) for r in written["rows"]),
    }
    assert result["indexValidated"]["drugs"] >= 3          # 首／中／尾要是不同列


def _inject(monkeypatch, where, which, field, value):
    """把 builder 組好的 columnar 物件在指定位置改壞——模擬 builder 組 row 的 bug。"""
    real = bph.index_columnar

    def broken(index_drugs, version):
        doc = real(index_drugs, version)
        rows = doc["rows"]
        n = len(doc["fields"])
        if where == "drug":
            pos = {"first": 0, "middle": len(rows) // 2, "last": len(rows) - 1}[which]
            rows[pos][doc["fields"].index(field)] = value
        else:
            with_w = [i for i, r in enumerate(rows) if r[n]]
            flat = [(i, k) for i in with_w for k in range(len(rows[i][n]))]
            i, k = flat[{"first": 0, "middle": len(flat) // 2, "last": len(flat) - 1}[which]]
            rows[i][n][k][doc["windowFields"].index(field)] = value
        return doc
    monkeypatch.setattr(bph, "index_columnar", broken)


# 每個位置各一個共通層錯誤與一個 builder 層錯誤（§7.1 F12）
F12_CASES = [
    (where, which, layer, field, value)
    for which in ("first", "middle", "last")
    for where, layer, field, value in (
        ("drug", "common", "chName", 1),
        ("drug", "builder", "firstEffectiveDate", "2027-02-30"),
        ("window", "common", "priceState", "bogus"),
        ("window", "builder", "price", "10"),
    )
]


@pytest.mark.parametrize("where,which,layer,field,value", F12_CASES,
                         ids=[f"{w}-{p}-{lay}-{f}" for w, p, lay, f, _ in F12_CASES])
def test_f12_injected_error_fails_build_and_writes_nothing(tmp_path, monkeypatch,
                                                           where, which, layer, field, value):
    build(tmp_path)                                     # 先有一版已發布資料
    before = tree_hash(tmp_path)
    _inject(monkeypatch, where, which, field, value)
    with pytest.raises(BuildError) as exc:
        build(tmp_path, checked_at="2026-09-18T02:00:00+08:00")
    assert "drug_index.json 驗證失敗" in str(exc.value.args[0])
    assert tree_hash(tmp_path) == before                # data/ 與 status.json 均未變動


def test_f12_builder_and_converter_call_the_same_validator(tmp_path, monkeypatch):
    """§5.7 validator 只有一份：兩條路徑都必須經過 lib.index_format.validate_index。"""
    calls = []
    real = index_format.validate_index

    def spy(*a, **kw):
        calls.append("x")
        return real(*a, **kw)
    monkeypatch.setattr(index_format, "validate_index", spy)

    build(tmp_path)
    assert len(calls) == 1

    conv = load_converter()
    assert conv.index_format is index_format            # 轉換器 import 的是同一個模組
    legacy = {"dataVersion": "v1", "drugs": [
        {**{k: v for k, v in zip(index_format.FIELDS, CASES[0]["index"]["rows"][0])},
         "window": [dict(zip(index_format.WINDOW_FIELDS, CASES[0]["index"]["rows"][0][-1][0]))]}]}
    conv.to_columnar(legacy)
    assert len(calls) == 2


def test_converter_rejects_builder_layer_error():
    """轉換器走的是完整 validator（含 builder 層），不是只驗 key。"""
    conv = load_converter()
    row = CASES[0]["index"]["rows"][0]
    d = {**dict(zip(index_format.FIELDS, row)),
         "window": [dict(zip(index_format.WINDOW_FIELDS, row[-1][0]))]}
    d["window"][0]["from"] = "2027-02-30"
    with pytest.raises(conv.ConvertError, match="from 不是真實日曆日"):
        conv.to_columnar({"dataVersion": "v1", "drugs": [d]})


# ── F9：index size guard 經完整 build 路徑 ─────────────────────
def _index_gzip_size(tmp_path):
    from build_price_history import gzip_size
    build(tmp_path / "probe")
    return gzip_size((tmp_path / "probe" / "drug_index.json").read_bytes())


def test_f9_index_size_guard_boundaries_on_publish_path(tmp_path, capsys):
    from dataclasses import replace
    size = _index_gzip_size(tmp_path)
    base_cfg = GuardConfig(min_rows=1, min_codes=1)

    def cfg(warn, fail):
        return replace(base_cfg, index_warn_gzip_bytes=warn, index_fail_gzip_bytes=fail)

    # 等於門檻 → 通過、無 warning
    r = build(tmp_path / "eq", cfg=cfg(size, size))
    assert not any("drug_index.json gzip" in w for w in r["warnings"])
    # 超 1 byte（門檻 = size-1）→ warning，build 照常完成
    r = build(tmp_path / "warn", cfg=cfg(size - 1, size))
    assert any(f"drug_index.json gzip {size:,} bytes > {size - 1:,}" in w for w in r["warnings"])
    # 超 1 byte 於 fail 門檻 → build fail，data/ 與 status.json 均未變動
    target = tmp_path / "fail"
    build(target)
    before = tree_hash(target)
    with pytest.raises(BuildError, match="drug_index.json gzip"):
        build(target, cfg=cfg(size - 1, size - 1), checked_at="2026-09-18T02:00:00+08:00")
    assert tree_hash(target) == before


def test_f9_warning_appears_in_build_output(tmp_path, monkeypatch, capsys):
    from dataclasses import replace
    from lib import nhi
    size = _index_gzip_size(tmp_path)
    monkeypatch.setattr(nhi, "download", lambda *a, **kw: SNAPSHOT.read_bytes())
    monkeypatch.setattr(nhi, "fetch_source_modified", lambda: None)
    code = bph.main(["--data-dir", str(tmp_path / "out"), "--checked-at", CHECKED],
                    cfg=replace(GuardConfig(min_rows=1, min_codes=1), index_warn_gzip_bytes=size - 1))
    out = capsys.readouterr()
    assert code == 0
    assert f"drug_index.json gzip {size:,} bytes" in out.err
    assert "drug_index.json 全量驗證：drug rows" in out.out          # F12 動態計數也在 build 輸出


# ── F11：前次 index 的消費者（消失代號 guard）支援 legacy 與 columnar ──
def _snapshot_rows():
    from lib import nhi
    return nhi.parse_csv(SNAPSHOT.read_bytes())


def _codes(rows):
    return sorted({r["code"] for r in rows})


def _build_rows(tmp, rows, **kw):
    from tests.helpers import rows_to_csv
    kw.setdefault("checked_at", CHECKED)
    return run(rows_to_csv(rows), data_dir=tmp, build_date=date(2026, 9, 11), source_modified=None,
               cfg=GuardConfig(min_rows=1, min_codes=1, min_row_pct_of_previous=0),
               fixtures_dir="__none__", **kw)


def _write_legacy_prior(tmp, codes):
    tmp.mkdir(parents=True, exist_ok=True)
    (tmp / "drug_index.json").write_text(json.dumps(
        {"dataVersion": "sha256:legacy", "drugs": [{"code": c} for c in codes]}), "utf-8")


def test_f11a_legacy_prior_guard_actually_blocks(tmp_path):
    rows = _snapshot_rows()
    codes = _codes(rows)
    _write_legacy_prior(tmp_path, codes + ["ZZ99999999"])        # 前次多一個本次沒有的代號
    before = tree_hash(tmp_path)
    with pytest.raises(BuildError, match="消失"):
        _build_rows(tmp_path, rows)
    assert tree_hash(tmp_path) == before


def test_f11a_legacy_prior_migrates_to_columnar(tmp_path):
    rows = _snapshot_rows()
    _write_legacy_prior(tmp_path, _codes(rows))
    _build_rows(tmp_path, rows)
    out = json.loads((tmp_path / "drug_index.json").read_text("utf-8"))
    assert out["indexFormat"] == "columnar/1"


def test_f11b_columnar_prior_guard_actually_blocks(tmp_path):
    rows = _snapshot_rows()
    _build_rows(tmp_path, rows)                                   # 第一次：產出 columnar/1
    prior = json.loads((tmp_path / "drug_index.json").read_text("utf-8"))
    assert prior["indexFormat"] == "columnar/1"
    dropped = _codes(rows)[0]
    before = tree_hash(tmp_path)
    with pytest.raises(BuildError, match="消失"):                 # `.get("drugs", [])` 會讓這裡靜默通過
        _build_rows(tmp_path, [r for r in rows if r["code"] != dropped],
                    checked_at="2026-09-18T02:00:00+08:00")
    assert tree_hash(tmp_path) == before


def test_f11b_columnar_prior_row_pct_and_diff_detection(tmp_path):
    from tests.helpers import rows_to_csv
    rows = _snapshot_rows()
    _build_rows(tmp_path, rows)
    # publish 差異判定：來源未變 → unchanged
    r = _build_rows(tmp_path, rows, checked_at="2026-09-18T02:00:00+08:00")
    assert r["changed"] is False
    # min_row_pct_of_previous 仍讀得到前次 meta
    with pytest.raises(BuildError, match="來源列數"):
        run(rows_to_csv(rows[: len(rows) // 2]), data_dir=tmp_path, build_date=date(2026, 9, 11),
            checked_at="2026-09-25T02:00:00+08:00", source_modified=None,
            cfg=GuardConfig(min_rows=1, min_codes=1, max_disappeared_pct=100),
            fixtures_dir="__none__")


def test_f11_unknown_prior_format_fails_loud(tmp_path):
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / "drug_index.json").write_text(json.dumps({"dataVersion": "x", "rows": []}), "utf-8")
    with pytest.raises(ValueError, match="無法辨識"):
        _build_rows(tmp_path, _snapshot_rows())
