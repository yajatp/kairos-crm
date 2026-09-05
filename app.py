import streamlit as st
from dotenv import load_dotenv
import requests
import os
import html
from datetime import datetime
from streamlit_cookies_controller import CookieController
from utils.tz import CENTRAL

load_dotenv()

controller = CookieController()

st.set_page_config(
    page_title="Kairos CRM",
    layout="wide",
    initial_sidebar_state="expanded",
)

from utils.ui import GLOBAL_PREMIUM_CSS
st.markdown(GLOBAL_PREMIUM_CSS, unsafe_allow_html=True)

from db import queries

if st.session_state.get("current_user"):
    with st.sidebar:
        st.markdown("""
            <style>
            /* Target the button immediately following this anchor and style it like a nav item */
            div.element-container:has(.user-btn-anchor) + div.element-container {
                position: absolute !important;
                top: 1rem !important;
                left: 1rem !important;
                width: auto !important;
                max-width: calc(100% - 2.5rem) !important;
                z-index: 9999 !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button {
                background-color: transparent !important;
                color: rgba(26, 26, 26, 0.8) !important;
                border: none !important;
                box-shadow: none !important;
                padding: 0.125rem 0.5rem !important; /* nav link: paddingLeft/Right spacing.sm, marginTop/Bottom threeXS */
                border-radius: 0.5rem !important; /* nav link: radii.default */
                font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
                font-size: 0.875rem !important; /* nav label: fontSizes.sm */
                font-weight: 600 !important;
                line-height: 2 !important; /* nav link: lineHeights.menuItem */
                display: flex !important;
                align-items: center !important;
                justify-content: flex-start !important;
                gap: 0.5rem !important; /* nav link: spacing.sm */
                width: 100% !important;
                transition: background-color 0.2s ease, color 0.2s ease !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button [data-testid="stMarkdownContainer"] {
                flex: 0 1 auto !important;
                white-space: nowrap !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button p {
                font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
                font-size: 0.875rem !important; /* nav label: fontSizes.sm */
                font-weight: 600 !important;
                line-height: 2 !important;
                text-align: left !important;
                white-space: nowrap !important;
                margin: 0 !important;
                padding: 0 !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button span[data-testid="stIconMaterial"] {
                font-size: 1rem !important; /* nav icon: DynamicIcon size "base" = iconSizes.base = 1rem */
                width: 1rem !important;
                font-weight: 600 !important;
                color: inherit !important;
            }
            [data-testid="stSidebar"] [data-testid="stChatMessageContent"],
            [data-testid="stSidebar"] [data-testid="stChatMessageContent"] p {
                font-size: 0.75rem !important;
            }
            [data-testid="stSidebar"] [data-testid="stChatMessage"] {
                padding: 0.25rem 0.25rem !important;
                gap: 0.5rem !important;
            }
            [data-testid="stSidebar"] [data-testid^="stChatMessageAvatar"] {
                width: 1.25rem !important;
                height: 1.25rem !important;
                flex-shrink: 0 !important;
            }
            [data-testid="stSidebar"] [data-testid^="stChatMessageAvatar"] svg {
                width: 0.75rem !important;
                height: 0.75rem !important;
            }
            [data-testid="stSidebar"] [data-testid="stChatMessageAvatarAssistant"] {
                background-color: #1b3d2c !important; /* Kairos deep forest green */
            }
            [data-testid="stSidebar"] [data-testid="stChatMessageAvatarUser"] {
                background-color: #4c9e6b !important; /* Kairos accent green */
            }
            [data-testid="stSidebar"] [data-testid^="stChatMessageAvatar"] svg {
                color: #ffffff !important;
                fill: #ffffff !important;
            }
            [data-testid="stSidebar"] [data-testid="stChatInput"] textarea,
            [data-testid="stSidebar"] [data-testid="stChatInput"] textarea::placeholder {
                font-size: 0.75rem !important; /* match chat message text */
            }
            [data-testid="stSidebar"] [data-testid="stChatInput"],
            [data-testid="stSidebar"] [data-testid="stChatInput"] > div {
                align-items: center !important;
                min-height: 0 !important;
            }
            [data-testid="stSidebar"] [data-testid="stChatInput"] textarea {
                min-height: 1.75rem !important;
                max-height: 1.75rem !important;
                padding-top: 5px !important;
                padding-bottom: 0 !important;
                line-height: 1.75rem !important;
            }
            [data-testid="stSidebar"] [data-testid="stChatInputSubmitButton"] {
                align-self: center !important;
                margin-bottom: 0 !important;
            }
            [data-testid="stSidebar"] [data-testid="stChatInputSubmitButton"] svg {
                width: 1.1rem !important;
                height: 1.1rem !important;
            }
            [data-testid="stSidebar"] [data-testid="stSpinner"],
            [data-testid="stSidebar"] [data-testid="stSpinner"] * {
                font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
                font-size: 0.75rem !important;
                font-weight: 400 !important;
            }
            [data-testid="stSidebar"] [data-testid="stSpinner"] {
                padding-left: 0.25rem !important;
            }
            [data-testid="stSidebar"] div[data-testid="stChatMessage"] + div[data-testid="stChatMessage"] {
                margin-top: 0 !important;
            }
            [data-testid="stSidebar"] [data-testid="stVerticalBlock"]:has(> [data-testid="stChatMessage"]) {
                gap: 0.25rem !important;
            }
            [data-testid="stSidebar"] [data-testid="stVerticalBlockBorderWrapper"]:has([data-testid="stChatMessage"]) > div,
            [data-testid="stSidebar"] [data-testid="stVerticalBlockBorderWrapper"]:has([data-testid="stChatMessage"]) [data-testid="stElementContainer"] {
                padding-left: 0.25rem !important;
                padding-right: 0.25rem !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button:hover {
                background-color: rgba(182, 182, 164, 0.15) !important;
                color: rgb(26, 26, 26) !important;
                border: none !important;
                box-shadow: none !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button:hover p {
                color: rgb(26, 26, 26) !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button:active {
                background-color: rgba(182, 182, 164, 0.25) !important;
                font-weight: 600 !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button:active p {
                font-weight: 600 !important;
            }
            div.element-container:has(.user-btn-anchor) + div.element-container div.stButton button span {
                color: inherit !important;
            }
            /* Tighten up spacing around the navigation menu */
            [data-testid="stSidebarNav"] {
                margin-top: 0.25rem !important;
                margin-bottom: 0 !important;
                padding-bottom: 0 !important;
            }
            [data-testid="stSidebarUserContent"] {
                padding-top: 0 !important;
                margin-top: -1rem !important;
            }
            [data-testid="stSidebarNavSeparator"], [data-testid="stSidebar"] hr {
                transform: translateY(-20px) !important;
                margin-bottom: 0.5rem !important;
                border: none !important;
                background: transparent !important;
            }
            [data-testid="stSidebar"] {
                min-width: 23rem !important;
                width: 23rem !important;
            }
            .kb-chat { display: flex; flex-direction: column; gap: 0.5rem; }
            .kb-msg { display: flex; gap: 0.5rem; align-items: stretch; }
            .kb-pill { width: 3px; border-radius: 9999px; flex-shrink: 0; }
            .kb-msg.kb-user .kb-pill { background-color: #4c9e6b; } /* Kairos accent green */
            .kb-msg.kb-bot .kb-pill { background-color: #1b3d2c; } /* Kairos deep forest green */
            .kb-body { display: flex; flex-direction: column; gap: 0.0625rem; min-width: 0; }
            .kb-text { font-size: 0.75rem; line-height: 1.45; color: #1a1a1a; white-space: pre-wrap; word-break: break-word; }
            .kb-time { font-size: 0.625rem; color: rgba(26, 26, 26, 0.45); }
            </style>
            <div class="user-btn-anchor"></div>
        """, unsafe_allow_html=True)
        if st.button(f"Logged in as {st.session_state['current_user']['name']}", icon=":material/person:", use_container_width=True, help="Click to switch user"):
            st.session_state["current_user"] = None
            st.session_state.pop("filters_persist", None)
            # Donut Scraper view state is per-user (scrape runs, open run detail) — never
            # let it survive a user switch, or the next user can land on someone else's run.
            for key in list(st.session_state.keys()):
                if key == "_donut_pipeline" or key == "_ds_view_run" or key == "_ds_open_expander" or key.startswith("ds_"):
                    st.session_state.pop(key, None)
            controller.remove("kairos_user_id")
            st.rerun()

pages = st.navigation(
    [
        st.Page("views/dashboard.py", title="Dashboard", icon=":material/dashboard:", default=True),
        st.Page("views/overview.py", title="Team Overview", icon=":material/groups:"),
        st.Page("views/accounts.py", title="Accounts", icon=":material/business:"),
        st.Page("views/donut_scraper.py", title="Donut Scraper", icon=":material/map:"),
        st.Page("views/email_templates.py", title="Email Templates", icon=":material/mail:"),
        st.Page("views/csv_import.py", title="CSV Import", icon=":material/upload_file:"),
        st.Page("views/admin.py", title="Settings", icon=":material/settings:"),
    ]
)

if st.session_state.get("current_user") is None:
    try:
        users = queries.list_users()
    except Exception as e:
        st.error(str(e))
        st.stop()
        
    saved_user_id = controller.get("kairos_user_id")
    if saved_user_id:
        for u in users:
            if str(u["id"]) == str(saved_user_id):
                st.session_state["current_user"] = u
                st.rerun()

    st.title("Kairos CRM")
    st.subheader("Who are you?")
    st.caption(
        "Your selection pre-fills the Kairos Owner field on new records. "
        "It is always editable per-entry."
    )
    if not users:
        st.warning("No active users found. Run schema.sql to seed the users table.")
        st.stop()
    cols = st.columns(min(len(users), 4))
    for i, user in enumerate(users):
        if cols[i % len(cols)].button(
            user["name"], key=f"pick_user_{user['id']}", use_container_width=True
        ):
            st.session_state["current_user"] = user
            controller.set("kairos_user_id", str(user["id"]))
            st.rerun()
    st.stop()

def _chat_timestamp(created_at: str) -> str:
    try:
        dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00")).astimezone(CENTRAL)
    except (ValueError, TypeError):
        return ""
    if dt.date() == datetime.now(CENTRAL).date():
        return dt.strftime("%-I:%M %p")
    return dt.strftime("%b %-d, %-I:%M %p")


def _render_messages(messages: list[dict]) -> None:
    rows = []
    for msg in messages:
        css = "kb-user" if msg["role"] == "user" else "kb-bot"
        text = html.escape(msg.get("content") or "").replace("\n", "<br>")
        ts = _chat_timestamp(msg.get("created_at", ""))
        rows.append(
            f'<div class="kb-msg {css}"><div class="kb-pill"></div>'
            f'<div class="kb-body"><div class="kb-text">{text}</div>'
            f'<div class="kb-time">{ts}</div></div></div>'
        )
    st.markdown('<div class="kb-chat">' + "".join(rows) + "</div>", unsafe_allow_html=True)


# The chat is a fragment so run_every polls Supabase for messages texted from a
# phone without rerunning the main page (which would blow away unsaved edit
# forms — see CLAUDE.md). A send does a full st.rerun so page views reflect writes.
@st.fragment(run_every="30s")
def _sidebar_chat(session_id: int) -> None:
    chat_container = st.container(height=400)
    messages = queries.list_bot_messages(session_id)
    with chat_container:
        if not messages:
            st.caption("No messages yet. Try asking 'what's due today?'")
        else:
            _render_messages(messages)

    if prompt := st.chat_input("Message Kairos Bot..."):
        url = os.environ.get("SUPABASE_URL", "") + "/functions/v1/sendblue-bot?debug=1&token=" + os.environ.get("BOT_WEBHOOK_TOKEN", "")
        payload = {"user_id": st.session_state["current_user"]["id"], "session_id": session_id, "content": prompt}
        with chat_container:
            with st.spinner("Thinking..."):
                try:
                    resp = requests.post(url, json=payload, timeout=30)
                    resp.raise_for_status()
                    nav = (resp.json() or {}).get("nav")
                    st.session_state["chat_nav"] = nav if nav and nav.get("page") else None
                except Exception as e:
                    body = getattr(getattr(e, "response", None), "text", "")
                    st.error(f"Bot error: {e}" + (f" - {body}" if body else ""))
        st.rerun()


# Logical page keys the bot's nav payload can target — kept in sync with the
# st.navigation pages above so a write on any page (not just accounts) can offer
# a jump. account_id, when present, deep-links straight to that account's detail.
_CHAT_NAV_PAGES = {
    "dashboard": "views/dashboard.py",
    "overview": "views/overview.py",
    "accounts": "views/accounts.py",
    "donut_scraper": "views/donut_scraper.py",
    "email_templates": "views/email_templates.py",
    "csv_import": "views/csv_import.py",
    "admin": "views/admin.py",
}

with st.sidebar:
    _uid = st.session_state["current_user"]["id"]
    _sessions = queries.list_chat_sessions(_uid) or [queries.get_or_create_default_session(_uid)]
    _session_ids = [s["id"] for s in _sessions]
    if st.session_state.get("current_session_id") not in _session_ids:
        st.session_state["current_session_id"] = _session_ids[0]
    _labels = {s["id"]: (s["title"] or "New chat") for s in _sessions}

    _pick_col, _new_col, _menu_col = st.columns([4, 1, 1], vertical_alignment="center")
    with _pick_col:
        _picked = st.selectbox(
            "Chat session", _session_ids, format_func=lambda i: _labels.get(i, "New chat"),
            index=_session_ids.index(st.session_state["current_session_id"]),
            label_visibility="collapsed",
        )
    if _picked != st.session_state["current_session_id"]:
        st.session_state["current_session_id"] = _picked
        st.session_state["chat_nav"] = None
        st.rerun()
    with _new_col:
        if st.button("", icon=":material/add:", help="Start a new chat", key="new_chat_btn"):
            st.session_state["current_session_id"] = queries.create_chat_session(_uid)["id"]
            st.session_state["chat_nav"] = None
            st.rerun()
    _current = next((s for s in _sessions if s["id"] == st.session_state["current_session_id"]), _sessions[0])
    with _menu_col:
        with st.popover("", icon=":material/more_vert:", help="Rename or delete this chat", use_container_width=True):
            _new_title = st.text_input("Rename chat", value=_current.get("title") or "", key=f"rename_input_{_current['id']}")
            if st.button("Rename", icon=":material/edit:", use_container_width=True, key="rename_btn"):
                queries.rename_chat_session(_current["id"], _new_title.strip() or None)
                st.rerun()
            if _current.get("is_default"):
                st.caption("The Texts chat can't be deleted — phone messages land here.")
            elif st.button("Delete chat", icon=":material/delete:", use_container_width=True, key="delete_btn"):
                queries.delete_chat_session(_current["id"])
                st.session_state.pop("current_session_id", None)
                st.session_state["chat_nav"] = None
                st.rerun()

    _sidebar_chat(st.session_state["current_session_id"])
    # After a chatbot save, offer a jump to what changed (Issue 3: the user
    # shouldn't have to trust the write happened — let them go verify it).
    chat_nav = st.session_state.get("chat_nav")
    if chat_nav and chat_nav.get("page") in _CHAT_NAV_PAGES:
        if st.button(f"View {chat_nav['label']}", icon=":material/open_in_new:", use_container_width=True, key="chat_nav_view"):
            if chat_nav.get("account_id"):
                st.session_state["selected_account_id"] = chat_nav["account_id"]
            st.session_state["chat_nav"] = None
            st.switch_page(_CHAT_NAV_PAGES[chat_nav["page"]])

pages.run()
