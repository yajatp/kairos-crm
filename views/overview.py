from __future__ import annotations

import pandas as pd
import streamlit as st

from db import queries
from utils.constants import CLOSED_STAGES, PIPELINE_STAGES
from utils.stale import categorize
from utils.tz import central_today, end_of_week, parse_date

CLOSING_STAGES = ["Demo Scheduled", "Waiting on Decision", "Onboarding"]

# Same keyed-container trick as the accounts list: Streamlit has no native
# striping or header row for st.columns lists.
_LIST_CSS = """
<style>
[class*="st-key-overview_header"],
[class*="st-key-overview_row_"] {
    padding: 0.15rem 0.6rem;
    border-radius: 0.5rem;
}
[class*="st-key-overview_header"] {
    background-color: rgba(151, 166, 195, 0.35);
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
}
[class*="st-key-overview_row_even"] {
    background-color: rgba(151, 166, 195, 0.12);
}
[class*="st-key-overview_row_"] button,
[class*="st-key-overview_row_"] button p {
    white-space: nowrap;
}
</style>
"""

_LIST_WIDTHS = [3, 2, 2, 3, 2, 1.4]
_LIST_HEADERS = ["Practice", "Owner", "Stage", "Next action", "Due date", ""]


def _open_account(account_id: int) -> None:
    st.session_state["selected_account_id"] = account_id
    st.session_state["back_to_page"] = "views/overview.py"
    st.switch_page("views/accounts.py")


def _count_by_owner(items: list[dict]) -> dict:
    counts: dict = {}
    for item in items:
        acct = item.get("account", item)
        oid = acct.get("kairos_owner_id")
        counts[oid] = counts.get(oid, 0) + 1
    return counts


left, right = st.columns([5, 1], vertical_alignment="center")
left.title("Team Overview")
if right.button("Refresh", icon=":material/refresh:", use_container_width=True):
    st.rerun()
st.caption("Every lead across the whole team, regardless of owner or who is acting.")

accounts = queries.list_accounts()
users = queries.list_users(active_only=False)
user_name = {u["id"]: u["name"] for u in users}
demos = queries.list_all_demos()
demos_by_account: dict[int, list[dict]] = {}
for demo in demos:
    demos_by_account.setdefault(demo["account_id"], []).append(demo)

today = central_today()
week_end = end_of_week(today)
buckets = categorize(accounts, demos_by_account, today)

open_accounts = [a for a in accounts if a.get("pipeline_stage") not in CLOSED_STAGES]
won = [a for a in accounts if a.get("pipeline_stage") == "Closed Won"]
demos_this_week = [
    d for d in demos
    if d.get("status") == "Scheduled"
    and (dd := parse_date(d.get("demo_date"))) and today <= dd <= week_end
]

from utils.ui import render_kpi_card
m = st.columns(6)
m[0].markdown(render_kpi_card("Total accounts", len(accounts), "", "#475569"), unsafe_allow_html=True)
m[1].markdown(render_kpi_card("Open pipeline", len(open_accounts), "", "#2563eb"), unsafe_allow_html=True)
m[2].markdown(render_kpi_card("Due today", len(buckets["due_today"]), "", "#d97706"), unsafe_allow_html=True)
m[3].markdown(render_kpi_card("Overdue", len(buckets["overdue"]), "", "#dc2626"), unsafe_allow_html=True)
m[4].markdown(render_kpi_card("Demos this week", len(demos_this_week), "", "#7e22ce"), unsafe_allow_html=True)
m[5].markdown(render_kpi_card("Closed won", len(won), "", "#16a34a"), unsafe_allow_html=True)


st.subheader("Pipeline by stage", divider=True)
stage_counts = {s: 0 for s in PIPELINE_STAGES}
for acct in accounts:
    if acct.get("pipeline_stage") in stage_counts:
        stage_counts[acct["pipeline_stage"]] += 1
total = max(len(accounts), 1)
stage_df = pd.DataFrame(
    {
        "Stage": PIPELINE_STAGES,
        "Accounts": [stage_counts[s] for s in PIPELINE_STAGES],
        "Share": [stage_counts[s] / total for s in PIPELINE_STAGES],
    }
)
st.dataframe(
    stage_df,
    hide_index=True,
    use_container_width=True,
    column_config={
        "Share": st.column_config.ProgressColumn(
            "Share of all accounts", format="percent", min_value=0.0, max_value=1.0
        ),
    },
)

st.subheader("Team load", divider=True)
open_by_owner = _count_by_owner(open_accounts)
due_by_owner = _count_by_owner(buckets["due_today"])
overdue_by_owner = _count_by_owner(buckets["overdue"])
stale_by_owner = _count_by_owner(buckets["stale"])
won_by_owner = _count_by_owner(won)
account_owner = {a["id"]: a.get("kairos_owner_id") for a in accounts}
demo_week_by_owner = _count_by_owner(
    [{"kairos_owner_id": account_owner.get(d["account_id"])} for d in demos_this_week]
)

owner_ids = [u["id"] for u in users if u["active"] or open_by_owner.get(u["id"])]
if open_by_owner.get(None) or won_by_owner.get(None):
    owner_ids.append(None)
total_open = max(len(open_accounts), 1)
team_df = pd.DataFrame(
    [
        {
            "Owner": user_name.get(oid, "Unassigned"),
            "Open leads": open_by_owner.get(oid, 0),
            "Share of open pipeline": open_by_owner.get(oid, 0) / total_open,
            "Due today": due_by_owner.get(oid, 0),
            "Overdue": overdue_by_owner.get(oid, 0),
            "Stale": stale_by_owner.get(oid, 0),
            "Demos this week": demo_week_by_owner.get(oid, 0),
            "Closed won": won_by_owner.get(oid, 0),
        }
        for oid in owner_ids
    ]
)
st.dataframe(
    team_df,
    hide_index=True,
    use_container_width=True,
    column_config={
        "Share of open pipeline": st.column_config.ProgressColumn(
            "Share of open pipeline", format="percent", min_value=0.0, max_value=1.0
        ),
    },
)

st.subheader("Closest to close", divider=True)
st.caption("Open accounts in " + ", ".join(CLOSING_STAGES) + ", soonest next action first.")
closing = [a for a in accounts if a.get("pipeline_stage") in CLOSING_STAGES]
far_future = "9999-12-31"
closing.sort(
    key=lambda a: (
        str(a.get("next_action_due_date") or far_future),
        CLOSING_STAGES.index(a["pipeline_stage"]),
    )
)
if not closing:
    st.caption("Nothing here yet.")
else:
    st.markdown(_LIST_CSS, unsafe_allow_html=True)
    with st.container(key="overview_header"):
        cols = st.columns(_LIST_WIDTHS, vertical_alignment="center")
        for col, label in zip(cols, _LIST_HEADERS):
            if label:
                col.markdown(f"**{label}**")
    for i, acct in enumerate(closing):
        parity = "even" if i % 2 == 0 else "odd"
        with st.container(key=f"overview_row_{parity}_{acct['id']}"):
            cols = st.columns(_LIST_WIDTHS, vertical_alignment="center")
            cols[0].markdown(f"**{acct['practice_name']}**")
            cols[1].write(user_name.get(acct.get("kairos_owner_id"), "—"))
            from utils.ui import render_stage_badge
            cols[2].markdown(render_stage_badge(acct.get("pipeline_stage")), unsafe_allow_html=True)
            cols[3].write(acct.get("next_action") or "—")
            cols[4].write(str(acct.get("next_action_due_date") or "—"))
            if cols[5].button("Open", key=f"overview_open_{acct['id']}", use_container_width=True):
                _open_account(acct["id"])

st.subheader("Recent team activity", divider=True)
recent = queries.list_recent_activities(20)
if not recent:
    st.caption("No activity logged yet.")
for entry in recent:
    practice = (entry.get("accounts") or {}).get("practice_name") or "—"
    st.markdown(
        f"**{entry['date']}** — {practice} — {entry['activity_type']} — "
        f"{user_name.get(entry.get('kairos_owner_id'), '—')}"
    )
    if entry.get("summary"):
        st.caption(entry["summary"])

st.caption(f"As of {today} (Central).")
