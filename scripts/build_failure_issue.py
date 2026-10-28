#!/usr/bin/env python3
"""build-data 連續失敗 ≥ 2 次自動開 issue；之後成功即自動關閉。

由 build-data workflow 的 report-failure job 呼叫（needs: build、if: always()）：
  python3 scripts/build_failure_issue.py --result <needs.build.result>

- 只用標準函式庫（job 不裝 uv）；GitHub REST API 以 GITHUB_TOKEN 呼叫
- 「連續」以本 workflow 在 main 上已完成的 run 計算，加上本次 run；
  cancelled／skipped 既不計入也不中斷（concurrency 排隊或手動取消不代表來源恢復）
- 同時只維持一張 open issue：已存在則留言更新次數，不重複開
"""

import argparse
import json
import os
import sys
import urllib.request

TITLE_PREFIX = "[build-data] 排程建置連續失敗"
LABELS = ["bug"]
THRESHOLD = 2
FAILED = frozenset({"failure", "timed_out", "startup_failure"})
NEUTRAL = frozenset({"cancelled", "skipped", "neutral", "action_required", "stale"})


def consecutive_failures(previous_runs, current_failed):
    """previous_runs：已完成的 run，新 → 舊。回傳含本次在內的連續失敗次數。"""
    if not current_failed:
        return 0
    n = 1
    for r in previous_runs:
        c = r.get("conclusion")
        if c in NEUTRAL:
            continue
        if c not in FAILED:
            break
        n += 1
    return n


def failed_streak(previous_runs):
    """連續失敗的那幾次 run（新 → 舊），供 issue 內文列出連結。"""
    out = []
    for r in previous_runs:
        c = r.get("conclusion")
        if c in NEUTRAL:
            continue
        if c not in FAILED:
            break
        out.append(r)
    return out


def _body(count, run_url, streak):
    lines = [
        f"build-data workflow 已**連續 {count} 次**失敗，`data/status.json` 的 "
        "`lastCheckedAt` 不會前進，前端將在逾期後顯示過期警示（spec §8.6）。",
        "",
        "| 次序 | 觸發 | 時間（UTC） | 結果 |",
        "|---|---|---|---|",
        f"| 本次 | — | — | [failure]({run_url}) |",
    ]
    for r in streak:
        lines.append(f"| 前次 | {r.get('event', '')} | {r.get('created_at', '')} | "
                     f"[{r.get('conclusion')}]({r.get('html_url', '')}) |")
    lines += [
        "",
        "**排查順序**",
        "1. 開啟上方 run 的 `Build price history` 步驟：`✗ 來源錯誤` 多為健保署端點斷線"
        "（RemoteDisconnected／逾時），`✗ GUARD` 為資料異常，`Run unit tests` 為程式問題",
        "2. 來源錯誤：白天以 workflow_dispatch 手動重跑；若持續失敗，確認端點是否改版",
        "3. GUARD 失敗：依 step summary 判讀；僅語意 guard 可勾選 `allow_anomaly` 人工放行",
        "",
        "下次建置成功時本 issue 會自動關閉。",
    ]
    return "\n".join(lines)


def report(api, result, previous_runs, run_url):
    """依本次結果開／更新／關閉 issue。api 需提供 find_open_issue／create_issue／comment／close。"""
    existing = api.find_open_issue()
    if result == "success":
        if existing:
            api.close(existing["number"], f"建置已恢復成功：{run_url}")
        return
    count = consecutive_failures(previous_runs, current_failed=result in FAILED)
    if count < THRESHOLD:
        return
    body = _body(count, run_url, failed_streak(previous_runs))
    if existing:
        api.comment(existing["number"], body)
    else:
        api.create_issue(f"{TITLE_PREFIX}（連續 {count} 次）", body, LABELS)


class GitHubAPI:
    def __init__(self, repo, token, api_url="https://api.github.com"):
        self.repo, self.token, self.api_url = repo, token, api_url

    def _call(self, method, path, payload=None):
        req = urllib.request.Request(
            f"{self.api_url}/repos/{self.repo}{path}", method=method,
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.token}",
                     "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read() or b"null")

    def previous_runs(self, workflow, current_id, limit=20):
        data = self._call("GET", f"/actions/workflows/{workflow}/runs"
                                 f"?branch=main&status=completed&per_page={limit}")
        return [r for r in data["workflow_runs"] if r["id"] != current_id]

    def find_open_issue(self):
        issues = self._call("GET", "/issues?state=open&labels=bug&per_page=100")
        return next((i for i in issues if "pull_request" not in i
                     and i["title"].startswith(TITLE_PREFIX)), None)

    def create_issue(self, title, body, labels):
        self._call("POST", "/issues", {"title": title, "body": body, "labels": labels})

    def comment(self, number, body):
        self._call("POST", f"/issues/{number}/comments", {"body": body})

    def close(self, number, body):
        self.comment(number, body)
        self._call("PATCH", f"/issues/{number}", {"state": "closed", "state_reason": "completed"})


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--result", required=True, help="needs.build.result")
    p.add_argument("--workflow", default="build-data.yml")
    args = p.parse_args(argv)

    repo, run_id = os.environ["GITHUB_REPOSITORY"], int(os.environ["GITHUB_RUN_ID"])
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/{run_id}"
    api = GitHubAPI(repo, os.environ["GH_TOKEN"])
    previous = api.previous_runs(args.workflow, run_id) if args.result != "success" else []
    report(api, args.result, previous, run_url)
    print(f"report-failure：result={args.result}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
