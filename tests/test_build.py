"""B1–B8 建置與 CI 安全（plan.md §5）。"""

import json
import re
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest
import requests

import build_price_history as bph
from build_price_history import BuildError, GuardConfig, check_guards, gzip_size, run
from lib import nhi
from tests.helpers import HEADER, SNAPSHOT, make_row, rows_to_csv, tree_hash

CHECKED = "2026-09-11T12:00:00+08:00"
D = date(2026, 9, 11)
ROOT = Path(__file__).resolve().parent.parent


def build(tmp, raw=None, cfg=None, **kw):
    kw.setdefault("build_date", D)
    kw.setdefault("checked_at", CHECKED)
    return run(raw or SNAPSHOT.read_bytes(), data_dir=tmp, source_modified=None,
               cfg=cfg or GuardConfig(min_rows=1, min_codes=1), fixtures_dir="__none__", **kw)


# ── B1 來源失敗不覆寫 ───────────────────────────────────────────
class FakeResp:
    def __init__(self, status=200, body=b""):
        self.status_code, self.body = status, body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}", response=self)

    def iter_content(self, chunk_size):
        yield self.body


def fake_get(*outcomes):
    calls = []

    def get(url, **kw):
        calls.append(kw)
        outcome = outcomes[min(len(calls), len(outcomes)) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome
    return get, calls


@pytest.mark.parametrize("outcome,expected_calls,expected_sleeps", [
    (FakeResp(500), 3, [5, 10]),
    (FakeResp(429), 3, [5, 10]),
    (requests.Timeout("timeout"), 3, [5, 10]),
    (requests.exceptions.SSLError("bad cert"), 3, [5, 10]),
    (FakeResp(404), 1, []),                                  # 4xx（非 429）不重試
])
def test_download_failures_raise_after_policy(outcome, expected_calls, expected_sleeps):
    get, calls = fake_get(outcome)
    sleeps = []
    with pytest.raises(nhi.SourceError):
        nhi.download("https://x.invalid", "t", get=get, sleep=sleeps.append)
    assert len(calls) == expected_calls and sleeps == expected_sleeps
    assert all(kw.get("verify", True) is True for kw in calls)   # 不得關閉 TLS 驗證


def test_download_recovers_on_retry():
    get, _ = fake_get(FakeResp(503), FakeResp(200, b"ok"))
    assert nhi.download("https://x.invalid", "t", get=get, sleep=lambda s: None) == b"ok"


BAD_BODIES = {
    "html_error_page": lambda: b"<!DOCTYPE html><html><body>Service Unavailable</body></html>\n",
    "truncated_no_newline": lambda: SNAPSHOT.read_bytes()[:-40],
    "truncated_missing_fields": lambda: SNAPSHOT.read_bytes().rsplit(b",", 3)[0] + b"\n",
    "empty": lambda: b"",
    "header_only": lambda: SNAPSHOT.read_bytes().split(b"\n", 1)[0] + b"\n",
}


@pytest.mark.parametrize("kind", sorted(BAD_BODIES))
def test_invalid_http_200_content_is_rejected(kind):
    with pytest.raises(nhi.SourceError):
        nhi.parse_csv(BAD_BODIES[kind]())


@pytest.mark.parametrize("kind", ["source_error", "html_error_page", "truncated_no_newline"])
def test_main_source_failure_leaves_data_untouched(tmp_path, monkeypatch, kind):
    build(tmp_path)
    before = tree_hash(tmp_path)

    def bad_download(*a, **kw):
        if kind == "source_error":
            raise nhi.SourceError("HTTP 500")
        return BAD_BODIES[kind]()
    monkeypatch.setattr(nhi, "download", bad_download)
    code = bph.main(["--data-dir", str(tmp_path), "--no-metadata", "--checked-at",
                     "2026-09-18T02:00:00+08:00"], cfg=GuardConfig(min_rows=1, min_codes=1))
    assert code == 1
    assert tree_hash(tmp_path) == before                       # status.json 也不得更新


# ── B2 schema ───────────────────────────────────────────────────
@pytest.mark.parametrize("drop", ["藥品代號", "支付價", "有效起日", "有效迄日"])
def test_missing_required_column_fails(drop):
    header = [h for h in HEADER if h != drop]
    with pytest.raises(nhi.SourceError):
        nhi.parse_csv(rows_to_csv([make_row()], header=header))


def test_ambiguous_required_column_fails():
    header = [h for h in HEADER if h != "支付價"] + ["支付價A", "支付價B"]
    with pytest.raises(nhi.SourceError, match="多個候選"):
        nhi.parse_csv(rows_to_csv([make_row()], header=header))


def test_column_order_does_not_change_output(tmp_path):
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    build(tmp_path / "a", raw=rows_to_csv(rows))
    build(tmp_path / "b", raw=rows_to_csv(rows, header=list(reversed(HEADER))))
    assert tree_hash(tmp_path / "a") == tree_hash(tmp_path / "b")


# ── B3 guard 邊界 ───────────────────────────────────────────────
def stats(rows=200_000, codes=45_000, invalid=0, malformed=0, missing=0):
    return {"sourceRowCount": rows, "uniqueDrugCodeCount": codes, "invalidRecords": invalid,
            "malformedPriceRows": malformed, "missingPriceRows": missing}


def errors_for(s, prev_meta=None, prev_codes=frozenset(), new_codes=frozenset(),
               shard_files=None, cfg=GuardConfig(), allow=False):
    return check_guards(s, prev_meta, set(prev_codes), set(new_codes), shard_files or {},
                        cfg, allow)


@pytest.mark.parametrize("s,prev,fails", [
    (stats(rows=99_999), None, True),
    (stats(rows=100_000), None, False),
    (stats(codes=4_999), None, True),
    (stats(codes=5_000), None, False),
    (stats(rows=198_999), {"sourceRowCount": 201_010}, True),    # 98.99%
    (stats(rows=198_990), {"sourceRowCount": 201_000}, False),   # 99.00%
    (stats(rows=200_000, invalid=2_020), None, True),            # 1.01%
    (stats(rows=200_000, invalid=2_000), None, False),           # 1.00%
    (stats(), None, False),                                       # 合法候選必須通過
])
def test_guard_boundaries(s, prev, fails):
    errors, _, _ = errors_for(s, prev_meta=prev)
    assert bool(errors) == fails


def test_guard_failure_writes_nothing(tmp_path):
    build(tmp_path)
    before = tree_hash(tmp_path)
    with pytest.raises(BuildError):
        build(tmp_path, cfg=GuardConfig(min_rows=10_000_000), checked_at="2026-09-18T02:00:00+08:00")
    assert tree_hash(tmp_path) == before


# ── B4 metadata 失敗不擋 build ─────────────────────────────────
class JsonResp(FakeResp):
    def __init__(self, status=200, payload=None, bad_json=False):
        super().__init__(status)
        self.payload, self.bad_json = payload, bad_json

    def json(self):
        if self.bad_json:
            raise ValueError("not json")
        return self.payload


@pytest.mark.parametrize("outcome", [
    JsonResp(500),
    requests.Timeout("timeout"),
    JsonResp(bad_json=True),
    JsonResp(payload={"result": {}}),
    JsonResp(payload={"result": {"modifiedDate": None}}),
])
def test_metadata_failure_returns_none_with_warning(outcome, capsys):
    get, _ = fake_get(outcome)
    assert nhi.fetch_source_modified(get=get) is None
    assert "WARNING" in capsys.readouterr().err


def test_metadata_success_is_kept_exactly():
    get, _ = fake_get(JsonResp(payload={"result": {"modifiedDate": "2026-08-28 07:05:11"}}))
    assert nhi.fetch_source_modified(get=get) == "2026-08-28 07:05:11"


def test_main_publishes_prices_when_metadata_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(nhi, "download", lambda *a, **kw: SNAPSHOT.read_bytes())
    monkeypatch.setattr(nhi, "fetch_source_modified", lambda: None)
    code = bph.main(["--data-dir", str(tmp_path), "--checked-at", CHECKED],
                    cfg=GuardConfig(min_rows=1, min_codes=1))
    status = json.loads((tmp_path / "status.json").read_text("utf-8"))
    assert code == 0 and status["sourceModifiedAt"] is None
    assert (tmp_path / "drug_index.json").exists()


# ── B5 diff 行為 ────────────────────────────────────────────────
def snapshot_files(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in Path(root).rglob("*") if p.is_file()}


def changed_files(before, after):
    return {k for k in before.keys() | after.keys() if before.get(k) != after.get(k)}


def test_unchanged_input_only_updates_status(tmp_path):
    build(tmp_path)
    before = snapshot_files(tmp_path)
    result = build(tmp_path, checked_at="2026-09-18T02:00:00+08:00")
    after = snapshot_files(tmp_path)
    assert result["changed"] is False
    assert changed_files(before, after) == {"status.json"}
    status = json.loads(after["status.json"])
    assert status["lastCheckedAt"] == "2026-09-18T02:00:00+08:00"
    assert status["lastCheckResult"] == "unchanged"


def test_single_price_change_touches_only_its_shard(tmp_path):
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    build(tmp_path, raw=rows_to_csv(rows))
    before = snapshot_files(tmp_path)
    target = next(r for r in rows if r["code"] == "A017014321" and r["to"] == "9991231")
    target["price"] = "27.50"
    build(tmp_path, raw=rows_to_csv(rows), checked_at="2026-09-18T02:00:00+08:00")
    touched = changed_files(before, snapshot_files(tmp_path))
    assert touched == {"drug_index.json", "meta.json", "status.json",
                       str(Path("history") / "A017.json")}


def test_crossing_effective_date_updates_index_not_history(tmp_path):
    build(tmp_path, build_date=date(2026, 9, 11))
    before = snapshot_files(tmp_path)
    result = build(tmp_path, build_date=date(2026, 10, 1), checked_at="2026-10-01T02:00:00+08:00")
    touched = changed_files(before, snapshot_files(tmp_path))
    assert result["changed"] is True
    assert touched == {"drug_index.json", "meta.json", "status.json"}


# ── B6 shard size guard ─────────────────────────────────────────
def test_shard_size_boundaries_use_gzip_size():
    data = json.dumps({"x": "藥" * 50_000}).encode()        # 高壓縮率：raw 遠大於 gzip
    size = gzip_size(data)
    base = GuardConfig(min_rows=1, min_codes=1)
    files = {"history/A000.json": b"{}", "history/B000.json": b"{}", "history/C000.json": data}

    def result(**cfg):
        errors, warnings, _ = errors_for(stats(), shard_files=files, cfg=replace(base, **cfg))
        return bool(errors), any("C000" in w for w in warnings)

    assert result(shard_warn_gzip_bytes=size) == (False, False)          # 等於門檻 → 通過
    assert result(shard_warn_gzip_bytes=size - 1) == (False, True)       # 超過 warning（第 3 片）
    assert result(shard_fail_gzip_bytes=size) == (False, False)
    assert result(shard_fail_gzip_bytes=size - 1)[0] is True
    assert len(data) > 10 * size                                          # 證明比的是 gzip 而非 raw
    assert result(shard_warn_gzip_bytes=len(data) // 2) == (False, False)


# ── B7 並行（workflow 靜態檢查）────────────────────────────────
def test_build_workflow_serializes_and_never_force_pushes():
    yml = (ROOT / ".github" / "workflows" / "build-data.yml").read_text("utf-8")
    assert re.search(r"concurrency:\s*\n\s+group:\s*build-data\s*\n\s+cancel-in-progress:\s*false", yml)
    assert "git push" in yml
    assert not re.search(r"git push[^\n]*(--force|-f\b|\+)", yml)
    assert "github.event_name == 'workflow_dispatch' && inputs.allow_anomaly" in yml


# ── B8 語意異常 guard ───────────────────────────────────────────
@pytest.mark.parametrize("s,prev_codes,new_codes,fails", [
    (stats(rows=200_000, malformed=1_020, missing=1_000), (), (), True),        # 1.01%
    (stats(rows=200_000, malformed=1_000, missing=1_000), (), (), False),       # 1.00%
    (stats(), range(10_000), range(101, 10_000), True),                          # 消失 1.01%
    (stats(), range(10_000), range(100, 10_000), False),                         # 消失 1.00%
])
def test_semantic_guard_boundaries(s, prev_codes, new_codes, fails):
    errors, _, _ = errors_for(s, prev_codes=prev_codes, new_codes=new_codes)
    assert bool(errors) == fails


def test_allow_anomaly_overrides_only_semantic_guards():
    s = stats(rows=200_000, malformed=5_000)
    errors, warnings, overridden = errors_for(s, allow=True)
    assert errors == [] and overridden and any("人工放行" in w for w in warnings)
    errors, _, _ = errors_for(stats(rows=99_999, malformed=5_000), allow=True)
    assert any("來源列數" in e for e in errors)                                   # 不擴及其他 guard


@pytest.mark.parametrize("event,refused", [("schedule", True), ("push", True),
                                           ("workflow_dispatch", False)])
def test_allow_anomaly_rejected_outside_workflow_dispatch(tmp_path, monkeypatch, event, refused):
    monkeypatch.setenv("GITHUB_EVENT_NAME", event)
    monkeypatch.setattr(nhi, "download", lambda *a, **kw: SNAPSHOT.read_bytes())
    code = bph.main(["--data-dir", str(tmp_path), "--no-metadata", "--allow-anomaly",
                     "--checked-at", CHECKED], cfg=GuardConfig(min_rows=1, min_codes=1))
    assert (code == 1) == refused
    assert (tmp_path / "status.json").exists() != refused
