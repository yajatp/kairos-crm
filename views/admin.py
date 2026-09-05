import streamlit as st

from db import queries
from utils.constants import CADENCE_CHANNELS

# Same keyed-container trick as the accounts list: Streamlit has no native
# striping or header row for st.columns lists.
_LIST_CSS = """
<style>
[class*="st-key-admin_header"],
[class*="st-key-admin_row_"] {
    padding: 0.15rem 0.6rem;
    border-radius: 0.5rem;
}
[class*="st-key-admin_header"] {
    background-color: rgba(151, 166, 195, 0.35);
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
}
[class*="st-key-admin_row_even"] {
    background-color: rgba(151, 166, 195, 0.12);
}
[class*="st-key-admin_row_"] button,
[class*="st-key-admin_row_"] button p {
    white-space: nowrap;
}
</style>
"""

_LIST_WIDTHS = [3, 1, 1]

st.title("Settings")
st.caption(
    "Users and channel types are editable here without a code deploy. "
    "Deactivate rather than delete — historical records keep their references."
)
st.markdown(_LIST_CSS, unsafe_allow_html=True)


def _list_header(key: str, name_label: str) -> None:
    with st.container(key=f"admin_header_{key}"):
        cols = st.columns(_LIST_WIDTHS, vertical_alignment="center")
        cols[0].markdown(f"**{name_label}**")
        cols[1].markdown("**Status**")


st.subheader("Users", divider=True)
with st.form("add_user", clear_on_submit=True):
    c1, c2 = st.columns([3, 1], vertical_alignment="bottom")
    name = c1.text_input("New user name")
    if c2.form_submit_button("Add user", icon=":material/person_add:"):
        if name.strip():
            queries.add_user(name.strip())
            st.rerun()

_list_header("users", "Name")
for i, user in enumerate(queries.list_users(active_only=False)):
    parity = "even" if i % 2 == 0 else "odd"
    with st.container(key=f"admin_row_{parity}_user_{user['id']}"):
        c1, c2, c3 = st.columns(_LIST_WIDTHS, vertical_alignment="center")
        c1.write(user["name"])
        c2.write("Active" if user["active"] else "Inactive")
        toggle_label = "Deactivate" if user["active"] else "Reactivate"
        if c3.button(toggle_label, key=f"user_toggle_{user['id']}", use_container_width=True):
            queries.set_user_active(user["id"], not user["active"])
            st.rerun()

st.subheader("Channel types", divider=True)
with st.form("add_channel", clear_on_submit=True):
    c1, c2 = st.columns([3, 1], vertical_alignment="bottom")
    label = c1.text_input("New channel type")
    if c2.form_submit_button("Add channel", icon=":material/add:"):
        if label.strip():
            queries.add_channel_type(label.strip())
            st.rerun()

_list_header("channels", "Channel")
for i, channel in enumerate(queries.list_channel_types(active_only=False)):
    parity = "even" if i % 2 == 0 else "odd"
    with st.container(key=f"admin_row_{parity}_channel_{channel['id']}"):
        c1, c2, c3 = st.columns(_LIST_WIDTHS, vertical_alignment="center")
        c1.write(channel["label"])
        c2.write("Active" if channel["active"] else "Inactive")
        toggle_label = "Deactivate" if channel["active"] else "Reactivate"
        if c3.button(toggle_label, key=f"channel_toggle_{channel['id']}", use_container_width=True):
            queries.set_channel_type_active(channel["id"], not channel["active"])
            st.rerun()

st.subheader("Cadences", divider=True)
st.caption(
    "Follow-up sequences. Enroll an account from its detail page; logging an "
    "activity there schedules the next step automatically. Day gaps count from "
    "the previous step, and due dates roll forward past weekends."
)

with st.form("add_cadence", clear_on_submit=True):
    c1, c2, c3 = st.columns([2, 3, 1], vertical_alignment="bottom")
    cadence_name = c1.text_input("New cadence name")
    cadence_desc = c2.text_input("Description")
    if c3.form_submit_button("Add cadence", icon=":material/add:"):
        if cadence_name.strip():
            queries.create_cadence({
                "name": cadence_name.strip(),
                "description": cadence_desc.strip() or None,
            })
            st.rerun()

_templates = queries.list_templates()
_template_name = {t["id"]: t["name"] for t in _templates}


def _step_fields(step: dict, key: str) -> dict:
    c1, c2, c3, c4 = st.columns([1, 2, 1, 1])
    order = c1.number_input("Step #", min_value=1, value=int(step.get("step_order") or 1), key=f"{key}_order")
    channel_options = list(CADENCE_CHANNELS)
    current_channel = step.get("channel") or CADENCE_CHANNELS[0]
    if current_channel not in channel_options:
        channel_options.append(current_channel)
    channel = c2.selectbox(
        "Channel", channel_options, index=channel_options.index(current_channel), key=f"{key}_channel"
    )
    gap_min = c3.number_input(
        "Days after previous (min)", min_value=0, value=int(step.get("day_gap_min") or 0), key=f"{key}_gmin"
    )
    gap_max = c4.number_input(
        "Days (max)", min_value=0, value=int(step.get("day_gap_max") or step.get("day_gap_min") or 0),
        key=f"{key}_gmax",
    )
    c5, c6, c7 = st.columns([2, 2, 2])
    custom_channel = c5.text_input(
        "Custom channel (overrides selection)", value="", key=f"{key}_custom"
    )
    note = c6.text_input("Note", value=step.get("note") or "", key=f"{key}_note")
    template_options = [None] + [t["id"] for t in _templates]
    current_template = step.get("email_template_id")
    template_id = c7.selectbox(
        "Email template", template_options,
        index=template_options.index(current_template) if current_template in template_options else 0,
        format_func=lambda i: _template_name.get(i, "—") if i else "—",
        key=f"{key}_template",
    )
    return {
        "step_order": int(order),
        "channel": custom_channel.strip() or channel,
        "day_gap_min": int(gap_min),
        "day_gap_max": max(int(gap_max), int(gap_min)),
        "note": note.strip() or None,
        "email_template_id": template_id,
    }


for cadence in queries.list_cadences(active_only=False):
    steps = queries.list_cadence_steps(cadence["id"])
    status = "" if cadence["active"] else " — inactive"
    with st.expander(f"{cadence['name']} ({len(steps)} steps){status}", icon=":material/checklist:"):
        with st.form(f"edit_cadence_{cadence['id']}"):
            c1, c2, c3 = st.columns([2, 3, 1], vertical_alignment="bottom")
            name = c1.text_input("Name", value=cadence["name"])
            desc = c2.text_input("Description", value=cadence.get("description") or "")
            if c3.form_submit_button("Save"):
                queries.update_cadence(cadence["id"], {
                    "name": name.strip() or cadence["name"],
                    "description": desc.strip() or None,
                })
                st.rerun()
        toggle_label = "Deactivate" if cadence["active"] else "Reactivate"
        if st.button(toggle_label, key=f"cadence_toggle_{cadence['id']}"):
            queries.update_cadence(cadence["id"], {"active": not cadence["active"]})
            st.rerun()

        for step in steps:
            gap = (
                f"{step['day_gap_min']}-{step['day_gap_max']}"
                if step.get("day_gap_max") and step["day_gap_max"] > step["day_gap_min"]
                else str(step["day_gap_min"])
            )
            st.markdown(
                f"**{step['step_order']}. {step['channel']}** — {gap} days after previous"
                + (f" — {step['note']}" if step.get("note") else "")
            )
            with st.popover("Edit step", use_container_width=False):
                with st.form(f"edit_step_{step['id']}"):
                    payload = _step_fields(step, f"step_{step['id']}")
                    if st.form_submit_button("Save step"):
                        queries.update_cadence_step(step["id"], payload)
                        st.rerun()
                if st.button("Delete step", key=f"del_step_{step['id']}", icon=":material/delete:"):
                    queries.delete_cadence_step(step["id"])
                    st.rerun()

        st.markdown("**Add step**")
        with st.form(f"add_step_{cadence['id']}", clear_on_submit=True):
            payload = _step_fields({"step_order": len(steps) + 1}, f"new_step_{cadence['id']}")
            if st.form_submit_button("Add step", icon=":material/add:"):
                payload["cadence_id"] = cadence["id"]
                queries.create_cadence_step(payload)
                st.rerun()
