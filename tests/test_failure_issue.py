"""連續失敗自動開 issue 的判定邏輯（H1）；GitHub API 呼叫以注入的假 client 驗證。"""

from scripts import build_failure_issue as bfi

RUN_URL = "https://github.com/o/r/actions/runs/9"


def run(i, conclusion, event="schedule"):
    return {"id": i, "conclusion": conclusion, "event": event, "status": "completed",
            "created_at": f"2026-10-{i:02d}T20:00:00Z",
            "html_url": f"https://github.com/o/r/actions/runs/{i}"}


def test_consecutive_counts_current_failure_plus_previous_streak():
    previous = [run(8, "failure"), run(7, "failure"), run(6, "success"), run(5, "failure")]
    assert bfi.consecutive_failures(previous, current_failed=True) == 3


def test_success_breaks_streak():
    assert bfi.consecutive_failures([run(8, "success"), run(7, "failure")], True) == 1
    assert bfi.consecutive_failures([run(8, "failure")], current_failed=False) == 0


def test_cancelled_and_skipped_runs_neither_count_nor_break():
    previous = [run(8, "cancelled"), run(7, "timed_out"), run(6, "skipped"), run(5, "success")]
    assert bfi.consecutive_failures(previous, True) == 2


class FakeAPI:
    def __init__(self, open_issues=()):
        self.open_issues = list(open_issues)
        self.calls = []

    def find_open_issue(self):
        return self.open_issues[0] if self.open_issues else None

    def create_issue(self, title, body, labels):
        self.calls.append(("create", title, body, labels))

    def comment(self, number, body):
        self.calls.append(("comment", number, body))

    def close(self, number, body):
        self.calls.append(("close", number, body))


def test_single_failure_does_not_open_issue():
    api = FakeAPI()
    bfi.report(api, "failure", [run(8, "success")], RUN_URL)
    assert api.calls == []


def test_second_consecutive_failure_opens_issue():
    api = FakeAPI()
    bfi.report(api, "failure", [run(8, "failure"), run(7, "success")], RUN_URL)
    [(kind, title, body, labels)] = api.calls
    assert kind == "create" and bfi.TITLE_PREFIX in title and "連續 2 次" in title
    assert RUN_URL in body and "runs/8" in body
    assert labels == ["bug"]


def test_further_failures_comment_on_existing_issue_instead_of_duplicating():
    api = FakeAPI(open_issues=[{"number": 42}])
    bfi.report(api, "failure", [run(8, "failure"), run(7, "failure")], RUN_URL)
    [(kind, number, body)] = api.calls
    assert (kind, number) == ("comment", 42) and "連續 3 次" in body


def test_success_closes_open_issue():
    api = FakeAPI(open_issues=[{"number": 42}])
    bfi.report(api, "success", [run(8, "failure")], RUN_URL)
    [(kind, number, body)] = api.calls
    assert (kind, number) == ("close", 42) and RUN_URL in body


def test_success_without_open_issue_is_noop():
    api = FakeAPI()
    bfi.report(api, "success", [run(8, "failure")], RUN_URL)
    assert api.calls == []
