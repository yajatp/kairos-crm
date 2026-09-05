import streamlit as st

from db import queries
from utils.constants import TEMPLATE_CATEGORIES

st.title("Email Templates")

with st.expander("Add template", icon=":material/add:"):
    with st.form("add_template", clear_on_submit=True):
        c1, c2 = st.columns(2)
        name = c1.text_input("Name *")
        category = c2.selectbox("Category", TEMPLATE_CATEGORIES)
        situation = st.text_input("Situation (when to use it)")
        subject = st.text_input("Subject")
        body = st.text_area("Body", height=200)
        notes = st.text_input("Notes")
        if st.form_submit_button("Add", icon=":material/save:"):
            if name.strip():
                queries.create_template({
                    "name": name.strip(),
                    "category": category,
                    "situation": situation.strip() or None,
                    "subject": subject.strip() or None,
                    "body": body or None,
                    "notes": notes.strip() or None,
                })
                st.rerun()
            else:
                st.error("Name is required.")

category_filter = st.selectbox("Filter by category", [None] + TEMPLATE_CATEGORIES, format_func=lambda c: c or "All")

templates = queries.list_templates(category=category_filter)
st.caption(f"{len(templates)} templates")

for tpl in templates:
    with st.expander(f"{tpl['name']} — {tpl['category']}"):
        with st.form(f"edit_template_{tpl['id']}"):
            c1, c2 = st.columns(2)
            name = c1.text_input("Name *", value=tpl["name"])
            category = c2.selectbox(
                "Category", TEMPLATE_CATEGORIES,
                index=TEMPLATE_CATEGORIES.index(tpl["category"]) if tpl["category"] in TEMPLATE_CATEGORIES else 0,
            )
            situation = st.text_input("Situation (when to use it)", value=tpl.get("situation") or "")
            subject = st.text_input("Subject", value=tpl.get("subject") or "")
            body = st.text_area("Body", value=tpl.get("body") or "", height=200)
            notes = st.text_input("Notes", value=tpl.get("notes") or "")
            if st.form_submit_button("Save"):
                queries.update_template(tpl["id"], {
                    "name": name.strip() or tpl["name"],
                    "category": category,
                    "situation": situation.strip() or None,
                    "subject": subject.strip() or None,
                    "body": body or None,
                    "notes": notes.strip() or None,
                })
                st.rerun()
        if st.button("Delete template", key=f"del_template_{tpl['id']}", icon=":material/delete:"):
            queries.delete_template(tpl["id"])
            st.rerun()
