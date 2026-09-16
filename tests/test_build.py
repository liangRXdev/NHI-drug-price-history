"""B1–B8 建置與 CI 安全（plan.md §5）。"""

import json
import re
import subprocess
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest
import requests

import build_price_history as bph
from build_price_history import BuildError, GuardConfig, check_guards, gzip_size, run
from lib import history, nhi
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
               shard_files=None, cfg=GuardConfig(), allow=False,
               upcoming_errors=(), upcoming_bytes=b""):
    return check_guards(s, prev_meta, set(prev_codes), set(new_codes), shard_files or {},
                        cfg, allow, upcoming_errors, upcoming_bytes)


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
    assert touched == {"drug_index.json", "upcoming.json", "meta.json", "status.json",
                       str(Path("history") / "A017.json")}


def test_crossing_effective_date_updates_index_not_history(tmp_path):
    build(tmp_path, build_date=date(2026, 9, 11))
    before = snapshot_files(tmp_path)
    result = build(tmp_path, build_date=date(2026, 10, 1), checked_at="2026-10-01T02:00:00+08:00")
    touched = changed_files(before, snapshot_files(tmp_path))
    assert result["changed"] is True
    # upcoming.json 與 index 同進退（spec-upcoming §3.3）：跨生效日正是它最需要更新的時刻
    assert touched == {"drug_index.json", "upcoming.json", "meta.json", "status.json"}


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


# ── U5–U7 預告清單的發布契約（spec-upcoming.md §3.3、§3.4）──────
UPCOMING = "upcoming.json"


def read_upcoming(root):
    return json.loads((Path(root) / UPCOMING).read_text("utf-8"))


def item_of(payload, code):
    return next(it for it in payload["items"] if it["code"] == code)


def brief(payload):
    return [(it["code"], it["effectiveDate"], it["rawPrice"], it["eventType"])
            for it in payload["items"]]


SNAPSHOT_UPCOMING = [("AB47689100", "2026-10-01", "7.90", "increase"),
                     ("BC05037209", "2026-10-01", "0.00", "terminated"),
                     ("BC26467100", "2026-10-01", "0", "terminated")]


def test_u5_independent_builds_are_byte_identical(tmp_path):
    """來源列順序不同、固定 D → 位元組相同，且內容正確（不是兩次都空）。"""
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    first, second = tmp_path / "first", tmp_path / "second"
    build(first, raw=rows_to_csv(rows))
    build(second, raw=rows_to_csv(list(reversed(rows))), checked_at="2026-09-18T02:00:00+08:00")

    assert (first / UPCOMING).read_bytes() == (second / UPCOMING).read_bytes()
    payload = read_upcoming(first)
    assert brief(payload) == SNAPSHOT_UPCOMING
    assert payload["count"] == 3 and payload["codeCount"] == 3


def test_u5_reverse_sentinel_changes_the_expected_item_values(tmp_path):
    """指名反向哨兵：改 AB47689100 的 2026-10-01 價格 → 該列金額精確變成新值。

    只斷言「檔案不同」會被 dataVersion 變動蒙混過去，upcoming 內容其實沒動。
    """
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    build(tmp_path, raw=rows_to_csv(rows))
    before = item_of(read_upcoming(tmp_path), "AB47689100")
    assert (before["price"], before["rawPrice"], before["previousPrice"],
            before["absoluteChange"], before["percentChange"]) == (7.9, "7.90", 6.9, 1.0, 14.49)

    target = next(r for r in rows if r["code"] == "AB47689100" and r["from"] == "1151001")
    target["price"] = "9.00"
    build(tmp_path, raw=rows_to_csv(rows), checked_at="2026-09-18T02:00:00+08:00")
    after = item_of(read_upcoming(tmp_path), "AB47689100")
    assert (after["price"], after["rawPrice"], after["previousPrice"],
            after["absoluteChange"], after["percentChange"]) == (9.0, "9.00", 6.9, 2.1, 30.43)
    assert after["eventType"] == "increase" and after["pricedBefore"] == 6.9


@pytest.mark.parametrize("failure", ["generator", "validator"])
def test_u6_upcoming_failure_publishes_nothing(tmp_path, monkeypatch, failure):
    """生成失敗與驗證失敗都必須整批不發布：檔案內容與**檔案集合**皆不得變動。"""
    build(tmp_path)
    before_hash, before_files = tree_hash(tmp_path), set(snapshot_files(tmp_path))

    if failure == "generator":
        monkeypatch.setattr(bph.history, "build_upcoming",
                            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    else:
        monkeypatch.setattr(bph.history, "validate_upcoming", lambda *a, **kw: ["注入的驗證失敗"])

    with pytest.raises(BuildError):
        build(tmp_path, checked_at="2026-09-18T02:00:00+08:00")
    assert tree_hash(tmp_path) == before_hash
    assert set(snapshot_files(tmp_path)) == before_files


def test_u6_main_exits_non_zero_on_upcoming_validation_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(nhi, "download", lambda *a, **kw: SNAPSHOT.read_bytes())
    monkeypatch.setattr(bph.history, "validate_upcoming", lambda *a, **kw: ["注入的驗證失敗"])
    code = bph.main(["--data-dir", str(tmp_path), "--no-metadata", "--checked-at", CHECKED],
                    cfg=GuardConfig(min_rows=1, min_codes=1))
    assert code == 1
    assert not (tmp_path / UPCOMING).exists() and not (tmp_path / "status.json").exists()


def test_u6_valid_input_publishes_upcoming(tmp_path, monkeypatch):
    """正對照：同一條路徑在合法輸入下確實會發布。"""
    monkeypatch.setattr(nhi, "download", lambda *a, **kw: SNAPSHOT.read_bytes())
    code = bph.main(["--data-dir", str(tmp_path), "--no-metadata", "--checked-at", CHECKED],
                    cfg=GuardConfig(min_rows=1, min_codes=1))
    assert code == 0 and brief(read_upcoming(tmp_path)) == SNAPSHOT_UPCOMING


def test_u7a_unchanged_source_without_crossing_keeps_upcoming_untouched(tmp_path):
    build(tmp_path)
    before = snapshot_files(tmp_path)
    result = build(tmp_path, checked_at="2026-09-18T02:00:00+08:00")
    assert result["changed"] is False
    assert changed_files(before, snapshot_files(tmp_path)) == {"status.json"}
    assert brief(read_upcoming(tmp_path)) == SNAPSHOT_UPCOMING


def test_u7a_crossing_effective_date_removes_the_row_that_took_effect(tmp_path):
    """來源沒變、D 跨過生效日 → 與 index 一起更新，剛生效的列必須離開清單。

    只改 buildDate／版本而沒移除該列的實作，會被日期與完整內容斷言擋下。
    """
    build(tmp_path, build_date=date(2026, 9, 11))
    assert brief(read_upcoming(tmp_path)) == SNAPSHOT_UPCOMING
    before = snapshot_files(tmp_path)

    result = build(tmp_path, build_date=date(2026, 10, 1),
                   checked_at="2026-10-01T02:00:00+08:00")
    payload = read_upcoming(tmp_path)
    assert result["changed"] is True
    assert payload["buildDate"] == "2026-10-01"
    assert payload["items"] == [] and payload["count"] == 0 and payload["codeCount"] == 0
    assert "drug_index.json" in changed_files(before, snapshot_files(tmp_path))


def test_u7a_changed_source_updates_upcoming_content(tmp_path):
    rows = nhi.parse_csv(SNAPSHOT.read_bytes())
    build(tmp_path, raw=rows_to_csv(rows))
    next(r for r in rows if r["code"] == "AB47689100" and r["from"] == "1151001")["to"] = "1151231"
    rows.append(make_row(code="AB47689100", price="6.00", frm="1160101", to="9991231"))
    build(tmp_path, raw=rows_to_csv(rows), checked_at="2026-09-18T02:00:00+08:00")
    assert brief(read_upcoming(tmp_path)) == [
        ("AB47689100", "2026-10-01", "7.90", "increase"),
        ("BC05037209", "2026-10-01", "0.00", "terminated"),
        ("BC26467100", "2026-10-01", "0", "terminated"),
        ("AB47689100", "2027-01-01", "6.00", "decrease")]


# ── U7b 首次交付與版本遷移（§3.3.1）────────────────────────────
def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)


def staged_check_paths():
    """workflow 實際用來判定「有差異」的路徑清單；規則漂移時本測試會紅。"""
    yml = (ROOT / ".github" / "workflows" / "build-data.yml").read_text("utf-8")
    match = re.search(r"git diff --staged --quiet -- ([^\n;]+); then", yml)
    assert match, "build-data.yml 的差異判定行已改寫，U7b 的前提需重新確認"
    return match.group(1).split()


def git_repo_with_data(tmp_path):
    """已發布狀態＝一個乾淨的 repo，data/ 已 commit。"""
    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@example.invalid")
    git(repo, "config", "user.name", "t")
    build(repo / "data")
    git(repo, "add", "data")
    git(repo, "commit", "-qm", "initial")
    return repo


def enters_changed_branch(repo):
    """模擬 workflow：git add data/ 後，判定是否進入有差異分支。"""
    git(repo, "add", "data")
    quiet = git(repo, "diff", "--staged", "--quiet", "--", *staged_check_paths())
    staged = git(repo, "diff", "--staged", "--name-only").stdout.split()
    return quiet.returncode != 0, staged


def test_u7b_first_delivery_produces_and_stages_upcoming(tmp_path):
    """已發布版本沒有 upcoming.json、來源未變 → 產出且進入 commit。

    「只在檔案不存在時生成」能通過生成，但若沒強制進入有差異分支，產物只會
    留在工作目錄裡（`build-data.yml` 的無差異分支只 commit status.json）。
    """
    repo = git_repo_with_data(tmp_path)
    (repo / "data" / UPCOMING).unlink()
    git(repo, "commit", "-qam", "remove upcoming")

    result = build(repo / "data", checked_at="2026-09-18T02:00:00+08:00")
    assert result["upcomingMigration"] is True and result["changed"] is True
    changed, staged = enters_changed_branch(repo)
    assert changed and "data/upcoming.json" in staged and "data/meta.json" in staged
    assert brief(read_upcoming(repo / "data")) == SNAPSHOT_UPCOMING


def test_u7b_generator_version_mismatch_rebuilds_and_stages(tmp_path):
    """已發布檔案的 generatorVersion 不符 → 重產且進入 commit（不是只看檔案存在）。"""
    repo = git_repo_with_data(tmp_path)
    stale = read_upcoming(repo / "data")
    stale["generatorVersion"] = "upcoming/0"
    stale["items"] = []
    (repo / "data" / UPCOMING).write_bytes(bph.dumps(stale))
    git(repo, "commit", "-qam", "stale upcoming")

    result = build(repo / "data", checked_at="2026-09-18T02:00:00+08:00")
    assert result["upcomingMigration"] is True and result["changed"] is True
    changed, staged = enters_changed_branch(repo)
    assert changed and "data/upcoming.json" in staged
    payload = read_upcoming(repo / "data")
    assert payload["generatorVersion"] == history.UPCOMING_GENERATOR_VERSION
    assert brief(payload) == SNAPSHOT_UPCOMING


def test_u7b_failed_migration_is_retried_next_run(tmp_path, monkeypatch):
    """遷移中失敗 → 不推進完成狀態；下次執行仍視為未完成的遷移。"""
    repo = git_repo_with_data(tmp_path)
    (repo / "data" / UPCOMING).unlink()
    git(repo, "commit", "-qam", "remove upcoming")
    before = tree_hash(repo / "data")

    monkeypatch.setattr(bph.history, "validate_upcoming", lambda *a, **kw: ["注入的驗證失敗"])
    with pytest.raises(BuildError):
        build(repo / "data", checked_at="2026-09-18T02:00:00+08:00")
    assert tree_hash(repo / "data") == before
    assert not (repo / "data" / UPCOMING).exists()
    assert enters_changed_branch(repo)[0] is False          # 沒有任何東西可 commit

    monkeypatch.undo()
    result = build(repo / "data", checked_at="2026-09-25T02:00:00+08:00")
    assert result["upcomingMigration"] is True
    changed, staged = enters_changed_branch(repo)
    assert changed and "data/upcoming.json" in staged


def test_u7b_working_tree_residue_is_not_publication(tmp_path):
    """工作目錄有產物、但已發布版本沒有 → 仍須視為未完成的首次交付。

    只看檔案存在的實作會在這裡靜默跳過遷移：產物永遠留在工作目錄，功能上線即空。
    """
    repo = git_repo_with_data(tmp_path)
    (repo / "data" / UPCOMING).unlink()
    git(repo, "commit", "-qam", "remove upcoming")          # 已發布版本沒有 upcoming.json
    build(repo / "data", checked_at="2026-09-18T02:00:00+08:00")   # 產出但先不 commit
    assert (repo / "data" / UPCOMING).exists()

    result = build(repo / "data", checked_at="2026-09-25T02:00:00+08:00")
    assert result["upcomingMigration"] is True             # 殘留檔不算已發布
    changed, staged = enters_changed_branch(repo)
    assert changed and "data/upcoming.json" in staged and "data/meta.json" in staged


def test_u7b_published_meta_without_upcoming_stats_is_incomplete(tmp_path):
    """產物已發布但 meta 缺 upcoming 統計 → 仍屬未完成，下次 build 必須補齊。

    §3.3.1 的完成定義是「經驗證的產物與 meta 已同批進入 commit」。少了這一條，
    來源不變時 generatorVersion 已相符，meta 統計就永遠補不回來。
    """
    repo = git_repo_with_data(tmp_path)
    meta_path = repo / "data" / "meta.json"
    meta = json.loads(meta_path.read_text("utf-8"))
    for key in ("upcomingRows", "upcomingCodes"):
        meta.pop(key)
    meta_path.write_bytes(bph.dumps(meta))
    git(repo, "commit", "-qam", "meta without upcoming stats")

    result = build(repo / "data", checked_at="2026-09-18T02:00:00+08:00")
    assert result["upcomingMigration"] is True
    changed, staged = enters_changed_branch(repo)
    assert changed and "data/meta.json" in staged
    assert json.loads(meta_path.read_text("utf-8"))["upcomingRows"] == 3


def test_u7b_steady_state_is_not_treated_as_migration(tmp_path):
    """反向哨兵：已有同版本產物、來源未變 → 不得每次都當成遷移重推。"""
    repo = git_repo_with_data(tmp_path)
    result = build(repo / "data", checked_at="2026-09-18T02:00:00+08:00")
    assert result["upcomingMigration"] is False and result["changed"] is False
    changed, staged = enters_changed_branch(repo)
    assert changed is False and staged == ["data/status.json"]


# ── §3.4 guards 與 meta ─────────────────────────────────────────
def test_meta_records_upcoming_counts(tmp_path):
    build(tmp_path)
    meta = json.loads((tmp_path / "meta.json").read_text("utf-8"))
    assert meta["upcomingRows"] == 3 and meta["upcomingCodes"] == 3


def test_upcoming_guards_warn_but_never_fail():
    base = stats(rows=200_000, codes=45_000)
    empty = {**base, "upcomingRows": 0, "upcomingCodes": 0}
    errors, warnings, _ = errors_for(empty)
    assert errors == [] and any("無任何未生效紀錄" in w for w in warnings)

    many = {**base, "upcomingRows": 3_000, "upcomingCodes": 2_251}    # 5.002%
    errors, warnings, _ = errors_for(many)
    assert errors == [] and any("超過全部代號的 5%" in w for w in warnings)
    boundary = {**base, "upcomingRows": 3_000, "upcomingCodes": 2_250}   # 5.00% 通過
    assert not any("超過全部代號" in w for w in errors_for(boundary)[1])

    errors, warnings, _ = errors_for({**base, "upcomingRows": 1, "upcomingCodes": 1},
                                     upcoming_bytes=b"x" * 500_001)
    assert errors == [] and any("upcoming.json raw" in w for w in warnings)


def test_upcoming_validation_errors_are_build_errors():
    errors, _, _ = errors_for(stats(), upcoming_errors=["items[0] code 為空字串"])
    assert any("upcoming.json 驗證失敗" in e for e in errors)
