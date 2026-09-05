from __future__ import annotations

from datetime import timedelta

import streamlit as st

from db import queries
from utils.constants import (
    ACTIVITY_TYPES,
    CADENCE_CHANNELS,
    COMPETITOR_TOOLS,
    DECISION_MAKER_REACHED,
    DEMO_STATUSES,
    LOST_REASONS,
    PIPELINE_STAGES,
    STALE_DAYS,
)
from utils.dedup import find_duplicates
from utils.tz import add_days_skip_weekend, central_today, parse_date

_users_all = queries.list_users(active_only=False)
_channels_all = queries.list_channel_types(active_only=False)
_user_name = {u["id"]: u["name"] for u in _users_all}
_channel_name = {c["id"]: c["label"] for c in _channels_all}


def _id_options(rows: list[dict], keep_id=None) -> list:
    ids = [r["id"] for r in rows if r["active"] or r["id"] == keep_id]
    return [None] + ids


_ADD_HELP = "Not in the list? Type it here and pick the \"Add\" option that appears."


def _owner_select(label: str, key: str, current_id=None):
    """Returns an existing user id, or a typed-in name as a str for the caller
    to create on submit."""
    default = current_id if current_id is not None else st.session_state["current_user"]["id"]
    options = _id_options(_users_all, keep_id=current_id)
    index = options.index(default) if default in options else 0
    return st.selectbox(
        label, options, index=index, key=key,
        format_func=lambda i: i if isinstance(i, str) else (_user_name.get(i, "—") if i else "—"),
        accept_new_options=True,
        help=_ADD_HELP,
    )


def _channel_select(label: str, key: str, current_id=None):
    options = _id_options(_channels_all, keep_id=current_id)
    index = options.index(current_id) if current_id in options else 0
    return st.selectbox(
        label, options, index=index, key=key,
        format_func=lambda i: i if isinstance(i, str) else (_channel_name.get(i, "—") if i else "—"),
        accept_new_options=True,
        help=_ADD_HELP,
    )


def _nullable_select(label: str, values: list[str], key: str, current=None):
    options = ["—"] + list(values)
    if current and current not in options:
        options.append(current)
    index = options.index(current) if current in options else 0
    picked = st.selectbox(
        label, options, index=index, key=key,
        accept_new_options=True, help=_ADD_HELP,
    )
    if picked == "—" or not picked:
        return None
    return picked.strip()


def _custom_select(label: str, values: list[str], key: str, current=None, default_val=None):
    options = list(values)
    if current and current not in options:
        options.append(current)
    val = current or default_val
    index = options.index(val) if val in options else 0
    picked = st.selectbox(
        label, options, index=index, key=key,
        accept_new_options=True, help=_ADD_HELP,
    )
    return picked.strip() if picked else val
def _account_form(form_key: str, defaults: dict, is_new: bool = False) -> dict | None:
    """Shared add/edit account form: reference facts entered once. Key people
    live on the Contacts tab; next action is set from the Activity Log only."""
    with st.form(form_key):
        c1, c2, c3 = st.columns(3)
        with c1:
            practice_name = st.text_input("Practice name *", value=defaults.get("practice_name") or "")
            practice_email = st.text_input("Practice email", value=defaults.get("practice_email") or "")
            practice_phone = st.text_input("Practice phone", value=defaults.get("practice_phone") or "")
            website = st.text_input("Website", value=defaults.get("website") or "")
        with c2:
            city = st.text_input("City", value=defaults.get("city") or "")
            state = st.text_input("State", value=defaults.get("state") or "")
            pms = st.text_input("PMS", value=defaults.get("pms") or "")
            source_detail = st.text_input("Source detail", value=defaults.get("source_detail") or "")
        with c3:
            owner_id = _owner_select("Kairos owner", f"{form_key}_owner", defaults.get("kairos_owner_id"))
            channel_id = _channel_select("Channel type", f"{form_key}_channel", defaults.get("channel_type_id"))

            stage_dynamic = queries.get_distinct_column_values("accounts", "pipeline_stage")
            stage_options = sorted(list(set(PIPELINE_STAGES) | set(stage_dynamic)))
            stage = _custom_select(
                "Pipeline stage", stage_options,
                current=defaults.get("pipeline_stage") or "New Lead",
                key=f"{form_key}_stage", default_val="New Lead",
            )
            
            lost_reasons_dynamic = queries.get_distinct_column_values("accounts", "lost_reason")
            lost_reasons_options = sorted(list(set(LOST_REASONS) | set(lost_reasons_dynamic)))
            lost_reason = _nullable_select(
                "Lost reason (Closed Lost only)", lost_reasons_options, f"{form_key}_lost", defaults.get("lost_reason")
            )
            
            competitor_tools_dynamic = queries.get_distinct_column_values("accounts", "competitor_tool")
            competitor_tools_options = sorted(list(set(COMPETITOR_TOOLS) | set(competitor_tools_dynamic)))
            competitor_tool = _nullable_select(
                "Current tool", competitor_tools_options, f"{form_key}_tool", defaults.get("competitor_tool")
            )
        initial_summary = st.text_area(
            "Initial encounter summary", value=defaults.get("initial_encounter_summary") or ""
        )
        creation_reason = None
        if is_new:
            creation_reason = st.text_input(
                "Reason for adding this account",
                placeholder="e.g. referral from Dr. Smith, met at conference…",
            )
        if not st.form_submit_button("Save", icon=":material/save:"):
            return None

    if not practice_name.strip():
        st.error("Practice name is required.")
        return None

    if isinstance(owner_id, str):
        owner_id = queries.add_user(owner_id.strip()) if owner_id.strip() else None
    if isinstance(channel_id, str):
        channel_id = queries.add_channel_type(channel_id.strip()) if channel_id.strip() else None
    payload = {
        "practice_name": practice_name.strip(),
        "practice_email": practice_email.strip() or None,
        "practice_phone": practice_phone.strip() or None,
        "website": website.strip() or None,
        "city": city.strip() or None,
        "state": state.strip() or None,
        "kairos_owner_id": owner_id,
        "channel_type_id": channel_id,
        "source_detail": source_detail.strip() or None,
        "initial_encounter_summary": initial_summary.strip() or None,
        "pipeline_stage": stage,
        "lost_reason": lost_reason,
        "competitor_tool": competitor_tool,
        "pms": pms.strip() or None,
    }
    if is_new:
        # Only set on creation — the edit form reuses this same builder and must
        # never overwrite an already-recorded creation reason with None.
        payload["creation_reason"] = (creation_reason or "").strip() or None
    return payload


def _log_system(account_id: int, activity_type: str, summary: str | None = None) -> None:
    """Auto-generated change record: shows dimmed in the Activity Log and is
    excluded from current state, last action, and staleness."""
    queries.log_activity({
        "account_id": account_id,
        "date": central_today().isoformat(),
        "kairos_owner_id": st.session_state["current_user"]["id"],
        "activity_type": activity_type,
        "summary": summary,
        "is_system": True,
    })


def _changed_fields(before: dict, payload: dict) -> list[str]:
    return [
        k.replace("_", " ")
        for k, v in payload.items()
        if (before.get(k) or None) != (v or None)
    ]


def _show_matches(matches: list[dict]) -> None:
    for m in matches:
        row = m["match"]
        where = f"import row {m['batch_row'] + 1}" if "batch_row" in m else "existing account"
        st.warning(
            f"**{row.get('practice_name')}** ({row.get('city') or 'no city'}, "
            f"{row.get('practice_phone') or 'no phone'}) — {where}: "
            + "; ".join(m["reasons"])
        )


def _cadence_gap_label(step: dict) -> str:
    gap_min = step["day_gap_min"]
    gap_max = step.get("day_gap_max") or gap_min
    if gap_max > gap_min:
        return f"{gap_min}-{gap_max} days"
    return f"{gap_min} day" + ("" if gap_min == 1 else "s")


def _cadence_step_action(step: dict, index: int, total: int) -> str:
    label = f"Cadence step {index}/{total}: {step['channel']}"
    if step.get("note"):
        label += f" — {step['note']}"
    return label


def _render_cadence_panel(account: dict) -> None:
    account_id = account["id"]
    with st.container(border=True):
        if not account.get("cadence_id"):
            active = queries.list_cadences()
            if not active:
                st.caption("No active cadences yet. Create one in Settings.")
                return
            c1, c2 = st.columns([3, 1], vertical_alignment="bottom")
            pick = c1.selectbox(
                "Enroll in a cadence", [c["id"] for c in active],
                format_func=lambda i: next(c["name"] for c in active if c["id"] == i),
                key="cadence_pick",
            )
            if c2.button("Enroll", icon=":material/playlist_add:", key="cadence_enroll"):
                steps = queries.list_cadence_steps(pick)
                if not steps:
                    st.error("That cadence has no steps yet. Add some in Settings.")
                else:
                    first = steps[0]
                    due = add_days_skip_weekend(central_today(), first["day_gap_min"])
                    queries.update_account(account_id, {
                        "cadence_id": pick,
                        "cadence_step_order": 1,
                        "cadence_paused": False,
                        "next_action": _cadence_step_action(first, 1, len(steps)),
                        "next_action_due_date": due.isoformat(),
                    })
                    _log_system(
                        account_id, "Cadence enrolled",
                        next(c["name"] for c in active if c["id"] == pick),
                    )
                    st.rerun()
            picked = next(c for c in active if c["id"] == pick)
            if picked.get("description"):
                st.caption(picked["description"])
            st.divider()
            st.markdown("**Or schedule a one-off follow-up** (no cadence needed)")
            q1, q2, q3, q4 = st.columns([2, 1, 3, 1], vertical_alignment="bottom")
            quick_channel = q1.selectbox(
                "Follow-up type", CADENCE_CHANNELS + ["Custom"], key="quick_channel"
            )
            quick_days = q2.number_input("In how many days", min_value=0, value=2, key="quick_days")
            quick_note = q3.text_input(
                "Note (this is the whole action when type is Custom)", key="quick_note"
            )
            if q4.button("Schedule", icon=":material/event:", key="quick_schedule", use_container_width=True):
                note = quick_note.strip()
                if quick_channel == "Custom":
                    action = note
                else:
                    action = quick_channel + (f" — {note}" if note else "")
                if not action:
                    st.error("Custom follow-ups need a note describing the action.")
                else:
                    due = add_days_skip_weekend(central_today(), int(quick_days))
                    queries.update_account(account_id, {
                        "next_action": action,
                        "next_action_due_date": due.isoformat(),
                    })
                    _log_system(
                        account_id, "Follow-up scheduled", f"{action} (due {due.isoformat()})"
                    )
                    st.rerun()
            return

        cadences = queries.list_cadences(active_only=False)
        cadence = next((c for c in cadences if c["id"] == account["cadence_id"]), None)
        steps = queries.list_cadence_steps(account["cadence_id"]) if cadence else []
        idx = account.get("cadence_step_order") or 1
        if not steps or idx > len(steps):
            st.warning("This account's cadence no longer has valid steps.")
            if st.button("Exit cadence", key="cadence_exit_invalid"):
                queries.update_account(account_id, {
                    "cadence_id": None, "cadence_step_order": None, "cadence_paused": False,
                })
                st.rerun()
            return

        step = steps[idx - 1]
        paused = " (paused)" if account.get("cadence_paused") else ""
        st.markdown(
            f"**Cadence: {cadence['name']}{paused}** — step {idx} of {len(steps)}: "
            f"{step['channel']} ({_cadence_gap_label(step)} after previous)"
        )
        if step.get("note"):
            st.caption(step["note"])
        if step.get("email_template_id"):
            template = queries.get_template(step["email_template_id"])
            if template:
                with st.expander(f"Template: {template['name']}", icon=":material/mail:"):
                    if template.get("subject"):
                        st.code(template["subject"], language=None)
                    st.code(template.get("body") or "", language=None)
        st.caption("Log an activity in the Activity Log tab to complete this step and schedule the next one.")
        c1, c2, c3 = st.columns(3)
        if idx < len(steps):
            if c1.button("Skip step", icon=":material/skip_next:", key="cadence_skip", use_container_width=True):
                nxt = steps[idx]
                due = add_days_skip_weekend(central_today(), nxt["day_gap_min"])
                queries.update_account(account_id, {
                    "cadence_step_order": idx + 1,
                    "next_action": _cadence_step_action(nxt, idx + 1, len(steps)),
                    "next_action_due_date": due.isoformat(),
                })
                _log_system(account_id, "Cadence step skipped", f"Step {idx} ({step['channel']})")
                st.rerun()
        elif c1.button("Skip step (ends cadence)", icon=":material/skip_next:", key="cadence_skip", use_container_width=True):
            queries.update_account(account_id, {
                "cadence_id": None, "cadence_step_order": None, "cadence_paused": False,
                "next_action": None, "next_action_due_date": None,
            })
            _log_system(account_id, "Cadence completed", cadence["name"])
            st.toast("Cadence complete. Consider moving this account to Nurture Later.")
            st.rerun()
        if account.get("cadence_paused"):
            if c2.button("Resume", icon=":material/play_arrow:", key="cadence_resume", use_container_width=True):
                due = add_days_skip_weekend(central_today(), step["day_gap_min"])
                queries.update_account(account_id, {
                    "cadence_paused": False,
                    "next_action": _cadence_step_action(step, idx, len(steps)),
                    "next_action_due_date": due.isoformat(),
                })
                _log_system(account_id, "Cadence resumed", cadence["name"])
                st.rerun()
        elif c2.button("Pause", icon=":material/pause:", key="cadence_pause", use_container_width=True):
            queries.update_account(account_id, {"cadence_paused": True})
            _log_system(account_id, "Cadence paused", cadence["name"])
            st.rerun()
        if c3.button("Exit cadence", icon=":material/stop:", key="cadence_exit", use_container_width=True):
            queries.update_account(account_id, {
                "cadence_id": None, "cadence_step_order": None, "cadence_paused": False,
            })
            _log_system(account_id, "Cadence exited", cadence["name"])
            st.rerun()


# Streamlit has no native striping or header row for st.columns lists, so the
# header and each row get keyed containers that this CSS can target.
_LIST_CSS = """
<style>
[class*="st-key-accounts_header"],
[class*="st-key-accounts_row_"] {
    padding: 0.15rem 0.6rem;
    border-radius: 0.5rem;
}
[class*="st-key-accounts_header"] {
    background-color: rgba(151, 166, 195, 0.35);
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
}
[class*="st-key-accounts_row_even"] {
    background-color: rgba(151, 166, 195, 0.12);
}
[class*="st-key-accounts_row_"] button,
[class*="st-key-accounts_row_"] button p {
    white-space: nowrap;
}
</style>
"""

_LIST_WIDTHS = [3, 2, 1.5, 2.5, 3, 2, 1.4]
_LIST_HEADERS = ["Practice", "City", "Owner", "Stage", "Next action", "Due date", ""]


def _render_list() -> None:
    if "filters_persist" not in st.session_state:
        st.session_state["filters_persist"] = {
            "search": "",
            "owner": st.session_state["current_user"]["id"],
            "stage": None,
            "channel": None,
            "city": "",
            "due_today_only": False,
            "overdue_only": False,
            "in_cadence_only": False,
            "no_activity": False,
            "stale_days": STALE_DAYS,
            "sort_by": "Practice name",
        }

    left, right = st.columns([5, 1], vertical_alignment="center")
    left.title("Accounts")
    if right.button("Refresh", icon=":material/refresh:", use_container_width=True):
        st.rerun()

    with st.expander("Add account", icon=":material/add:"):
        payload = _account_form("add_account", {}, is_new=True)
        if payload:
            payload["creation_source"] = "manual"
            payload["creation_user_id"] = st.session_state["current_user"]["id"]
            matches = find_duplicates(payload, queries.list_accounts())
            if matches:
                st.session_state["pending_account"] = payload
                st.session_state["pending_matches"] = matches
            else:
                created = queries.create_account(payload)
                queries.log_account_creation(created)
                st.success(f"Added {payload['practice_name']}.")

        if st.session_state.get("pending_account"):
            st.error("Possible duplicate — review before saving:")
            _show_matches(st.session_state["pending_matches"])
            c1, c2 = st.columns(2)
            if c1.button("Save anyway", icon=":material/warning:"):
                created = queries.create_account(st.session_state.pop("pending_account"))
                queries.log_account_creation(created)
                st.session_state.pop("pending_matches", None)
                st.rerun()
            if c2.button("Discard"):
                st.session_state.pop("pending_account", None)
                st.session_state.pop("pending_matches", None)
                st.rerun()

    with st.expander("Filters and search", icon=":material/filter_list:", expanded=True):
        f1, f2, f3, f4, f5 = st.columns(5)
        search = f1.text_input(
            "Search practice name",
            value=st.session_state["filters_persist"]["search"]
        )
        st.session_state["filters_persist"]["search"] = search

        owner_options = [None] + [u["id"] for u in _users_all]
        owner_default = st.session_state["filters_persist"]["owner"]
        owner_index = owner_options.index(owner_default) if owner_default in owner_options else 0
        owner = f2.selectbox(
            "Kairos owner", owner_options,
            index=owner_index,
            format_func=lambda i: _user_name.get(i, "All") if i else "All",
        )
        st.session_state["filters_persist"]["owner"] = owner

        stage_dynamic = queries.get_distinct_column_values("accounts", "pipeline_stage")
        stage_options = [None] + sorted(list(set(PIPELINE_STAGES) | set(stage_dynamic)))
        stage_default = st.session_state["filters_persist"]["stage"]
        stage_index = stage_options.index(stage_default) if stage_default in stage_options else 0
        stage = f3.selectbox(
            "Pipeline stage", stage_options,
            index=stage_index,
            format_func=lambda s: s or "All",
        )
        st.session_state["filters_persist"]["stage"] = stage

        channel_options = [None] + [c["id"] for c in _channels_all]
        channel_default = st.session_state["filters_persist"]["channel"]
        channel_index = channel_options.index(channel_default) if channel_default in channel_options else 0
        channel = f4.selectbox(
            "Channel type", channel_options,
            index=channel_index,
            format_func=lambda i: _channel_name.get(i, "All") if i else "All",
        )
        st.session_state["filters_persist"]["channel"] = channel

        city = f5.text_input(
            "City",
            value=st.session_state["filters_persist"]["city"]
        )
        st.session_state["filters_persist"]["city"] = city

        g1, g2, g3, g4, g5 = st.columns([1, 1, 1, 2, 2])
        due_today_only = g1.checkbox("Due today", value=st.session_state["filters_persist"]["due_today_only"])
        st.session_state["filters_persist"]["due_today_only"] = due_today_only

        overdue_only = g2.checkbox("Overdue", value=st.session_state["filters_persist"]["overdue_only"])
        st.session_state["filters_persist"]["overdue_only"] = overdue_only

        in_cadence_only = g3.checkbox(
            "In cadence", value=st.session_state["filters_persist"].get("in_cadence_only", False)
        )
        st.session_state["filters_persist"]["in_cadence_only"] = in_cadence_only

        no_activity = g4.checkbox("No activity in X+ days", value=st.session_state["filters_persist"]["no_activity"])
        st.session_state["filters_persist"]["no_activity"] = no_activity

        stale_days = g5.number_input(
            "X days", min_value=1,
            value=int(st.session_state["filters_persist"]["stale_days"]),
            disabled=not no_activity
        )
        st.session_state["filters_persist"]["stale_days"] = stale_days

        sort_by_options = ["Practice name", "Due date", "Last action (oldest first)", "Most recently added", "Least recently added", "Stage"]
        sort_by_default = st.session_state["filters_persist"]["sort_by"]
        sort_by_index = sort_by_options.index(sort_by_default) if sort_by_default in sort_by_options else 0
        sort_by = st.selectbox(
            "Sort by", sort_by_options,
            index=sort_by_index
        )
        st.session_state["filters_persist"]["sort_by"] = sort_by

    accounts = queries.list_accounts(
        owner_id=owner, stage=stage, channel_id=channel,
        city=city or None, search=search or None,
    )

    today = central_today()
    if in_cadence_only:
        accounts = [a for a in accounts if a.get("cadence_id")]
    if due_today_only:
        accounts = [a for a in accounts if parse_date(a.get("next_action_due_date")) == today]
    if overdue_only:
        accounts = [
            a for a in accounts
            if (d := parse_date(a.get("next_action_due_date"))) and d < today
        ]
    if no_activity:
        cutoff = today - timedelta(days=int(stale_days))
        accounts = [
            a for a in accounts
            if (d := parse_date(a.get("last_action_date"))) and d <= cutoff
        ]

    far_future = "9999-12-31"
    if sort_by == "Due date":
        accounts.sort(key=lambda a: str(a.get("next_action_due_date") or far_future))
    elif sort_by == "Last action (oldest first)":
        accounts.sort(key=lambda a: str(a.get("last_action_date") or ""))
    elif sort_by == "Most recently added":
        accounts.sort(key=lambda a: str(a.get("created_at") or ""), reverse=True)
    elif sort_by == "Least recently added":
        accounts.sort(key=lambda a: str(a.get("created_at") or ""))
    elif sort_by == "Stage":
        accounts.sort(key=lambda a: PIPELINE_STAGES.index(a["pipeline_stage"]))

    st.caption(f"{len(accounts)} accounts")
    st.markdown(_LIST_CSS, unsafe_allow_html=True)
    with st.container(key="accounts_header"):
        cols = st.columns(_LIST_WIDTHS, vertical_alignment="center")
        for col, label in zip(cols, _LIST_HEADERS):
            if label:
                col.markdown(f"**{label}**")
    for i, acct in enumerate(accounts):
        parity = "even" if i % 2 == 0 else "odd"
        with st.container(key=f"accounts_row_{parity}_{acct['id']}"):
            cols = st.columns(_LIST_WIDTHS, vertical_alignment="center")
            cols[0].markdown(f"**{acct['practice_name']}**")
            cols[1].write(acct.get("city") or "—")
            cols[2].write(_user_name.get(acct.get("kairos_owner_id"), "—"))
            from utils.ui import render_stage_badge
            cols[3].markdown(render_stage_badge(acct.get("pipeline_stage")), unsafe_allow_html=True)
            cols[4].write(acct.get("next_action") or "—")
            cols[5].write(str(acct.get("next_action_due_date") or "—"))
            if cols[6].button("Open", key=f"open_{acct['id']}", use_container_width=True):
                st.session_state["selected_account_id"] = acct["id"]
                st.session_state.pop("back_to_page", None)
                st.rerun()


def _render_detail(account_id: int) -> None:
    account = queries.get_account(account_id)
    if account is None:
        st.session_state.pop("selected_account_id", None)
        back_to_page = st.session_state.pop("back_to_page", None)
        if back_to_page:
            st.switch_page(back_to_page)
        else:
            st.rerun()

    back_to_page = st.session_state.get("back_to_page")
    back_label = "Back to dashboard" if back_to_page == "views/dashboard.py" else (
        "Back to overview" if back_to_page == "views/overview.py" else "Back to accounts"
    )
    if st.button(back_label, icon=":material/arrow_back:"):
        st.session_state.pop("selected_account_id", None)
        st.session_state.pop("back_to_page", None)
        if back_to_page:
            st.switch_page(back_to_page)
        else:
            st.rerun()

    from utils.ui import render_stage_badge
    c1, c2 = st.columns([5, 1], vertical_alignment="center")
    c1.title(account["practice_name"])
    c2.markdown(render_stage_badge(account.get("pipeline_stage")), unsafe_allow_html=True)
    st.caption(
        f"Owner: {_user_name.get(account.get('kairos_owner_id'), '—')} | "
        f"Channel: {_channel_name.get(account.get('channel_type_id'), '—')} | "
        f"Last action: {account.get('last_action_date') or '—'}"
    )
    # "Current state" is the latest real activity (system change records are
    # excluded in the view), read-only — derived, never stored (spec 5.1).
    if account.get("latest_activity_type"):
        st.info(
            f"**Latest activity ({account.get('last_action_date')}):** "
            f"{account['latest_activity_type']}"
            + (f" — {account['latest_activity_summary']}" if account.get("latest_activity_summary") else "")
        )
    else:
        st.info("**Latest activity:** No activity logged yet.")
    _render_cadence_panel(account)

    details, contacts, activity, demos = st.tabs(["Details", "Contacts", "Activity Log", "Demos"])

    with details:
        st.caption(
            "Reference facts about the practice, entered once. Key people live on "
            "the Contacts tab; the next action is set from the Activity Log."
        )
        payload = _account_form("edit_account", account)
        if payload:
            changed = _changed_fields(account, payload)
            queries.update_account(account_id, payload)
            if changed:
                _log_system(account_id, "Details updated", ", ".join(changed))
            st.success("Saved.")
            st.rerun()
        with st.expander("Delete account", icon=":material/delete:"):
            st.warning("Deletes the account and all its contacts, activities, and demos.")
            if st.checkbox("I understand", key="confirm_delete_account"):
                if st.button("Delete permanently", icon=":material/delete_forever:"):
                    queries.delete_account(account_id)
                    st.session_state.pop("selected_account_id", None)
                    back_to_page = st.session_state.pop("back_to_page", None)
                    if back_to_page:
                        st.switch_page(back_to_page)
                    else:
                        st.rerun()

    with contacts:
        with st.form("key_people"):
            st.markdown("**Key people**")
            b1, b2, b3 = st.columns(3)
            best_contact = b1.text_input("Best contact", value=account.get("best_contact") or "")
            best_contact_email = b2.text_input(
                "Best contact email", value=account.get("best_contact_email") or ""
            )
            best_contact_phone = b3.text_input(
                "Best contact phone", value=account.get("best_contact_phone") or ""
            )
            d1, d2, d3 = st.columns(3)
            decision_maker = d1.text_input("Decision maker", value=account.get("decision_maker") or "")
            decision_maker_email = d2.text_input(
                "Decision maker email", value=account.get("decision_maker_email") or ""
            )
            decision_maker_phone = d3.text_input(
                "Decision maker phone", value=account.get("decision_maker_phone") or ""
            )
            dm_reached = st.selectbox(
                "Decision maker reached", DECISION_MAKER_REACHED,
                index=DECISION_MAKER_REACHED.index(account.get("decision_maker_reached") or "Unknown"),
            )
            if st.form_submit_button("Save key people", icon=":material/save:"):
                payload = {
                    "best_contact": best_contact.strip() or None,
                    "best_contact_email": best_contact_email.strip() or None,
                    "best_contact_phone": best_contact_phone.strip() or None,
                    "decision_maker": decision_maker.strip() or None,
                    "decision_maker_email": decision_maker_email.strip() or None,
                    "decision_maker_phone": decision_maker_phone.strip() or None,
                    "decision_maker_reached": dm_reached,
                }
                changed = _changed_fields(account, payload)
                queries.update_account(account_id, payload)
                if changed:
                    _log_system(account_id, "Key people updated", ", ".join(changed))
                st.rerun()

        st.divider()
        with st.form("add_contact", clear_on_submit=True):
            st.markdown("**Add contact**")
            c1, c2, c3, c4 = st.columns(4)
            name = c1.text_input("Name *")
            role = c2.text_input("Role")
            email = c3.text_input("Email")
            phone = c4.text_input("Phone")
            if st.form_submit_button("Add", icon=":material/person_add:"):
                if name.strip():
                    queries.create_contact({
                        "account_id": account_id, "name": name.strip(),
                        "role": role.strip() or None, "email": email.strip() or None,
                        "phone": phone.strip() or None,
                    })
                    _log_system(account_id, "Contact added", name.strip())
                    st.rerun()
                else:
                    st.error("Name is required.")
        for contact in queries.list_contacts(account_id):
            with st.expander(f"{contact['name']} — {contact.get('role') or 'no role'}"):
                with st.form(f"edit_contact_{contact['id']}"):
                    c1, c2, c3, c4 = st.columns(4)
                    name = c1.text_input("Name *", value=contact["name"])
                    role = c2.text_input("Role", value=contact.get("role") or "")
                    email = c3.text_input("Email", value=contact.get("email") or "")
                    phone = c4.text_input("Phone", value=contact.get("phone") or "")
                    if st.form_submit_button("Save"):
                        payload = {
                            "name": name.strip() or contact["name"],
                            "role": role.strip() or None,
                            "email": email.strip() or None,
                            "phone": phone.strip() or None,
                        }
                        changed = _changed_fields(contact, payload)
                        queries.update_contact(contact["id"], payload)
                        if changed:
                            _log_system(
                                account_id, "Contact updated",
                                f"{contact['name']}: {', '.join(changed)}",
                            )
                        st.rerun()
                if st.button("Delete contact", key=f"del_contact_{contact['id']}", icon=":material/delete:"):
                    queries.delete_contact(contact["id"])
                    _log_system(account_id, "Contact removed", contact["name"])
                    st.rerun()

    with activity:
        cadence_steps: list[dict] = []
        cadence_idx = 0
        if account.get("cadence_id") and not account.get("cadence_paused"):
            cadence_steps = queries.list_cadence_steps(account["cadence_id"])
            cadence_idx = account.get("cadence_step_order") or 1
            if cadence_idx > len(cadence_steps):
                cadence_steps = []
        with st.form("add_activity", clear_on_submit=True):
            st.markdown("**Log activity**")
            c1, c2, c3 = st.columns(3)
            act_date = c1.date_input("Date", value=central_today())
            with c2:
                owner_id = _owner_select("Kairos owner", "activity_owner")

            act_types_dynamic = queries.get_distinct_column_values("activities", "activity_type")
            act_types_options = sorted(list(set(ACTIVITY_TYPES) | set(act_types_dynamic)))
            t1, t2 = st.columns(2)
            with t1:
                act_type = _custom_select("Type", act_types_options, "activity_type_select", default_val=ACTIVITY_TYPES[0])
            new_type = t2.text_input("Add new type (overrides selection)", key="activity_type_new")
            act_type = new_type.strip() or act_type

            summary = st.text_area("Summary")
            c4, c5 = st.columns(2)
            next_action = c4.text_input("Next action")
            next_due = c5.date_input("Next action due date", value=None)
            st.caption("Setting a next action here updates the account's current next action.")
            advance = False
            if cadence_steps:
                current_step = cadence_steps[cadence_idx - 1]
                advance = st.checkbox(
                    f"Completes cadence step {cadence_idx}/{len(cadence_steps)} "
                    f"({current_step['channel']}) and schedules the next step "
                    "(unless you set a next action above)",
                    value=True,
                )
            if st.form_submit_button("Log", icon=":material/add_task:"):
                if isinstance(owner_id, str):
                    owner_id = queries.add_user(owner_id.strip()) if owner_id.strip() else None
                payload = {
                    "account_id": account_id,
                    "date": act_date.isoformat(),
                    "kairos_owner_id": owner_id,
                    "activity_type": act_type,
                    "summary": summary.strip() or None,
                    "next_action": next_action.strip() or None,
                    "next_action_due_date": next_due.isoformat() if next_due else None,
                }
                account_update: dict = {}
                if advance:
                    if cadence_idx < len(cadence_steps):
                        nxt = cadence_steps[cadence_idx]
                        if not payload["next_action"] and not payload["next_action_due_date"]:
                            payload["next_action"] = _cadence_step_action(
                                nxt, cadence_idx + 1, len(cadence_steps)
                            )
                            payload["next_action_due_date"] = add_days_skip_weekend(
                                act_date, nxt["day_gap_min"]
                            ).isoformat()
                        account_update = {"cadence_step_order": cadence_idx + 1}
                    else:
                        account_update = {
                            "cadence_id": None,
                            "cadence_step_order": None,
                            "cadence_paused": False,
                        }
                        if not payload["next_action"]:
                            account_update["next_action"] = None
                            account_update["next_action_due_date"] = None
                        st.toast(
                            "Cadence complete. Consider moving this account to Nurture Later."
                        )
                queries.log_activity(payload)
                if account_update:
                    queries.update_account(account_id, account_update)
                    if account_update.get("cadence_id", "keep") is None:
                        _log_system(account_id, "Cadence completed")
                st.rerun()
        show_system = st.checkbox(
            "Show detail change history (dimmed entries)", value=True, key="show_system_log"
        )
        for entry in queries.list_activities(account_id):
            if entry.get("is_system"):
                if show_system:
                    line = f"{entry['date']} — {entry['activity_type']}"
                    if entry.get("summary"):
                        line += f": {entry['summary']}"
                    line += f" — {_user_name.get(entry.get('kairos_owner_id'), '—')}"
                    st.caption(line)
                continue
            st.markdown(
                f":primary[**{entry['date']} — {entry['activity_type']} — "
                f"{_user_name.get(entry.get('kairos_owner_id'), '—')}**]"
            )
            if entry.get("summary"):
                st.write(entry["summary"])
            if entry.get("next_action"):
                st.caption(
                    f"Next action: {entry['next_action']}"
                    + (f" (due {entry['next_action_due_date']})" if entry.get("next_action_due_date") else "")
                )
            st.divider()

    with demos:
        with st.form("add_demo", clear_on_submit=True):
            st.markdown("**Add demo**")
            c1, c2, c3 = st.columns(3)
            demo_date = c1.date_input("Demo date", value=None)
            with c2:
                demo_statuses_dynamic = queries.get_distinct_column_values("demos", "status")
                demo_statuses_options = sorted(list(set(DEMO_STATUSES) | set(demo_statuses_dynamic)))
                status = _custom_select("Status", demo_statuses_options, "demo_status_add", default_val="Scheduled")
            attendees = c3.text_input("Attendees")
            c4, c5, c6 = st.columns(3)
            pain_points = c4.text_area("Pain points")
            objections = c5.text_area("Objections")
            follow_up = c6.text_area("Follow-up required")
            if st.form_submit_button("Add", icon=":material/co_present:"):
                queries.create_demo({
                    "account_id": account_id,
                    "demo_date": demo_date.isoformat() if demo_date else None,
                    "status": status,
                    "attendees": attendees.strip() or None,
                    "pain_points": pain_points.strip() or None,
                    "objections": objections.strip() or None,
                    "follow_up_required": follow_up.strip() or None,
                })
                _log_system(
                    account_id, "Demo added",
                    f"{demo_date.isoformat() if demo_date else 'no date'} ({status})",
                )
                st.rerun()
        for demo in queries.list_demos(account_id):
            with st.expander(f"{demo.get('demo_date') or 'No date'} — {demo['status']}"):
                with st.form(f"edit_demo_{demo['id']}"):
                    c1, c2, c3 = st.columns(3)
                    demo_date = c1.date_input("Demo date", value=parse_date(demo.get("demo_date")))
                    with c2:
                        demo_statuses_dynamic = queries.get_distinct_column_values("demos", "status")
                        demo_statuses_options = sorted(list(set(DEMO_STATUSES) | set(demo_statuses_dynamic)))
                        status = _custom_select(
                            "Status", demo_statuses_options, f"demo_status_edit_{demo['id']}",
                            current=demo["status"], default_val="Scheduled"
                        )
                    attendees = c3.text_input("Attendees", value=demo.get("attendees") or "")
                    c4, c5, c6 = st.columns(3)
                    pain_points = c4.text_area("Pain points", value=demo.get("pain_points") or "")
                    objections = c5.text_area("Objections", value=demo.get("objections") or "")
                    follow_up = c6.text_area("Follow-up required", value=demo.get("follow_up_required") or "")
                    if st.form_submit_button("Save"):
                        payload = {
                            "demo_date": demo_date.isoformat() if demo_date else None,
                            "status": status,
                            "attendees": attendees.strip() or None,
                            "pain_points": pain_points.strip() or None,
                            "objections": objections.strip() or None,
                            "follow_up_required": follow_up.strip() or None,
                        }
                        changed = _changed_fields(demo, payload)
                        queries.update_demo(demo["id"], payload)
                        if changed:
                            _log_system(account_id, "Demo updated", ", ".join(changed))
                        st.rerun()
                if st.button("Delete demo", key=f"del_demo_{demo['id']}", icon=":material/delete:"):
                    queries.delete_demo(demo["id"])
                    _log_system(account_id, "Demo removed", demo.get("demo_date") or "no date")
                    st.rerun()


if st.session_state.get("selected_account_id"):
    _render_detail(st.session_state["selected_account_id"])
else:
    _render_list()
