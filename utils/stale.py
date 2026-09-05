"""Dashboard bucketing: Due Today / Overdue / Stale / Upcoming (spec section 6).

Works on account_overview rows (which carry the derived last_action_date and
latest_activity_summary). An account can legitimately appear in more than one
section — overdue accounts also show under Stale by design.
"""

from __future__ import annotations

from datetime import date, timedelta

from utils.constants import CLOSED_STAGES, STALE_DAYS, WAITING_STALE_DAYS
from utils.tz import end_of_week, parse_date


def categorize(accounts: list[dict], demos_by_account: dict, today: date) -> dict:
    due_today, overdue, stale, upcoming = [], [], [], []
    week_end = end_of_week(today)

    for acct in accounts:
        due = parse_date(acct.get("next_action_due_date"))
        last_action = parse_date(acct.get("last_action_date"))
        stage = acct.get("pipeline_stage")
        open_stage = stage not in CLOSED_STAGES
        has_next = bool((acct.get("next_action") or "").strip())

        if due == today:
            due_today.append({"account": acct})

        if due and due < today and open_stage:
            overdue.append({"account": acct, "days_overdue": (today - due).days})

        if open_stage:
            reasons = []
            if due and due < today:
                reasons.append(f"Next action {(today - due).days}d overdue")
            if not has_next:
                reasons.append("No next action set")
            if last_action and last_action <= today - timedelta(days=STALE_DAYS):
                reasons.append(f"No activity in {(today - last_action).days}d")
            if stage == "Demo Scheduled" and not has_next:
                demos = demos_by_account.get(acct.get("id"), [])
                if any(d.get("status") == "Completed" for d in demos):
                    reasons.append("Demo completed but no next action")
            if (
                stage in ("Interested", "Waiting on Decision")
                and last_action
                and last_action <= today - timedelta(days=WAITING_STALE_DAYS)
            ):
                reasons.append(f"In {stage} with no activity for {(today - last_action).days}d")
            if reasons:
                stale.append({"account": acct, "reasons": reasons})

        if due and today < due <= week_end:
            upcoming.append({"account": acct})

    overdue.sort(key=lambda r: -r["days_overdue"])
    upcoming.sort(key=lambda r: parse_date(r["account"].get("next_action_due_date")))
    return {"due_today": due_today, "overdue": overdue, "stale": stale, "upcoming": upcoming}
