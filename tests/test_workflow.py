"""build-data workflow 的排程與失敗通知（H1）。

2026-10-11／10-18／10-25 三次排程皆在台灣凌晨 04–05 點（UTC 18:00 排程＋GitHub 延遲）
因 RemoteDisconnected 失敗，同週白天手動 dispatch 均成功。排程必須落在台灣白天，
且要有備援排程，否則一次失敗就整週沒有檢查。
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = (ROOT / ".github" / "workflows" / "build-data.yml").read_text(encoding="utf-8")

# 台灣 08:00–17:59 ＝ UTC 00:00–09:59；GitHub 排程常延遲 1–2 小時，取 UTC 00–07 保留餘裕
DAYTIME_UTC_HOURS = range(0, 8)


def crons():
    return re.findall(r"^\s*-\s*cron:\s*'([^']+)'", WORKFLOW, re.M)


def test_schedule_has_primary_and_backup():
    entries = crons()
    assert len(entries) >= 2, entries
    weekdays = {c.split()[4] for c in entries}
    assert len(weekdays) >= 2, f"備援排程須落在不同日：{entries}"


def test_every_schedule_runs_in_taiwan_daytime():
    for c in crons():
        minute, hour, dom, month, dow = c.split()
        assert hour.isdigit() and int(hour) in DAYTIME_UTC_HOURS, c
        assert dom == "*" and month == "*", c
        # 整點排程是 GitHub 最壅塞時段（延遲最久），避開 :00
        assert minute.isdigit() and int(minute) != 0, c


def test_job_timeout_covers_full_retry_budget():
    """6 次下載 × 單次逾時 180s ＋ 退避 750s ＝ 1,830s；舊的 30 分鐘不夠。"""
    from lib import nhi
    budget = nhi.MAX_RETRIES * nhi.TIMEOUT_SEC + sum(
        nhi.retry_wait(n) for n in range(1, nhi.MAX_RETRIES))
    build = WORKFLOW.split("\n  build:", 1)[1].split("\n  report-failure:", 1)[0]
    minutes = int(re.search(r"timeout-minutes:\s*(\d+)", build).group(1))
    assert minutes * 60 >= budget + 10 * 60, (minutes, budget)   # 另留 10 分鐘給安裝與建置


def test_failure_report_job_is_least_privilege_and_always_runs():
    assert "\n  report-failure:" in WORKFLOW
    job = WORKFLOW.split("\n  report-failure:", 1)[1]
    assert "needs: build" in job
    assert "always()" in job and "cancelled" in job
    assert re.search(r"issues:\s*write", job) and re.search(r"actions:\s*read", job)
    assert "scripts/build_failure_issue.py" in job
    # issues:write 只給通知 job；build job（contents:write）不得順帶取得
    build = WORKFLOW.split("\n  build:", 1)[1].split("\n  report-failure:", 1)[0]
    assert "issues:" not in build
    top = WORKFLOW.split("\njobs:", 1)[0]
    assert "issues:" not in top and "contents: write" not in top
