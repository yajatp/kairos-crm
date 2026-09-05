from __future__ import annotations

import streamlit as st

from db import queries
from utils.stale import categorize
from utils.tz import central_today, parse_date

left, right = st.columns([5, 1], vertical_alignment="center")
left.title("Dashboard")
if right.button("Refresh", icon=":material/refresh:", use_container_width=True):
    st.rerun()

# Same keyed-container trick as the accounts list: Streamlit has no native
# striping or header row for st.columns lists.
_LIST_CSS = """
<style>
[class*="st-key-dash_header"],
[class*="st-key-dash_row_"] {
    padding: 0.15rem 0.6rem;
    border-radius: 0.5rem;
}
[class*="st-key-dash_header"] {
    background-color: rgba(151, 166, 195, 0.35);
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
}
[class*="st-key-dash_row_even"] {
    background-color: rgba(151, 166, 195, 0.12);
}
[class*="st-key-dash_row_"] button,
[class*="st-key-dash_row_"] button p {
    white-space: nowrap;
}
</style>
"""

_LIST_WIDTHS = [3, 2, 2, 3, 2, 1.4]
_LIST_HEADERS = ["Practice", "Owner", "Stage", "Next action", "Due date", ""]

users_all = queries.list_users(active_only=False)
user_name = {u["id"]: u["name"] for u in users_all}

# Let's put the owner filter selection at the top of the dashboard
current_user = st.session_state["current_user"]
owner_options = [None] + [u["id"] for u in users_all if u["active"]]

# Ensure current acting user is always in options even if inactive
default_owner = current_user["id"]
if default_owner not in owner_options:
    owner_options.append(default_owner)

owner_filter = st.selectbox(
    "Filter by owner",
    owner_options,
    index=owner_options.index(default_owner),
    format_func=lambda oid: user_name.get(oid, "All Owners") if oid else "All Owners",
)


def _open_account(account_id: int) -> None:
    st.session_state["selected_account_id"] = account_id
    st.session_state["back_to_page"] = "views/dashboard.py"
    st.switch_page("views/accounts.py")


def _rows(items: list[dict], key_prefix: str, show_days_overdue: bool = False) -> None:
    if not items:
        st.caption("Nothing here.")
        return
    with st.container(key=f"dash_header_{key_prefix}"):
        cols = st.columns(_LIST_WIDTHS, vertical_alignment="center")
        for col, label in zip(cols, _LIST_HEADERS):
            if label:
                col.markdown(f"**{label}**")
    for i, item in enumerate(items):
        acct = item["account"]
        parity = "even" if i % 2 == 0 else "odd"
        with st.container(key=f"dash_row_{parity}_{key_prefix}_{acct['id']}"):
            cols = st.columns(_LIST_WIDTHS, vertical_alignment="center")
            cols[0].markdown(f"**{acct['practice_name']}**")
            cols[1].write(user_name.get(acct.get("kairos_owner_id"), "—"))
            from utils.ui import render_stage_badge
            stage = acct.get("pipeline_stage")
            if stage:
                cols[2].markdown(render_stage_badge(stage), unsafe_allow_html=True)
            else:
                cols[2].write("—")
            cols[3].write(acct.get("next_action") or "—")
            due = parse_date(acct.get("next_action_due_date"))
            if show_days_overdue and item.get("days_overdue") is not None:
                cols[4].write(f"{due} ({item['days_overdue']}d overdue)")
            else:
                cols[4].write(str(due) if due else "—")
            if cols[5].button("Open", key=f"{key_prefix}_{acct['id']}", use_container_width=True):
                _open_account(acct["id"])
            if item.get("reasons"):
                st.caption("; ".join(item["reasons"]))


# Read-only fragment, so a 60s auto-refresh can't blow away form input
# (spec section 2 — never auto-refresh pages with edit forms).
@st.fragment(run_every=60)
def _dashboard_body(selected_owner_id: int | None) -> None:
    accounts = queries.list_accounts(owner_id=selected_owner_id)
    demos_by_account: dict[int, list[dict]] = {}
    for demo in queries.list_all_demos():
        demos_by_account.setdefault(demo["account_id"], []).append(demo)

    today = central_today()
    buckets = categorize(accounts, demos_by_account, today)

    owner_desc = user_name.get(selected_owner_id, "All Owners") if selected_owner_id else "All Owners"
    st.info(
        f"Showing accounts owned by {owner_desc}: "
        f"{len(buckets['overdue'])} overdue follow-ups, "
        f"{len(buckets['due_today'])} actions due today, "
        f"{len(buckets['stale'])} stale leads, "
        f"{len(buckets['upcoming'])} upcoming this week."
    )

    st.markdown(_LIST_CSS, unsafe_allow_html=True)

    st.subheader("Due Today", divider=True)
    _rows(buckets["due_today"], "due")

    st.subheader("Overdue", divider=True)
    _rows(buckets["overdue"], "over", show_days_overdue=True)

    st.subheader("Stale Leads", divider=True)
    _rows(buckets["stale"], "stale")

    st.subheader("Upcoming This Week", divider=True)
    _rows(buckets["upcoming"], "up")

    st.caption(f"As of {today} (Central). Auto-refreshes every 60 seconds.")


_dashboard_body(owner_filter)
