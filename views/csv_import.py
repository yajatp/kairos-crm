from __future__ import annotations

import pandas as pd
import streamlit as st

from db import queries
from utils.constants import PIPELINE_STAGES
from utils.dedup import find_batch_duplicates

st.title("CSV Import")
st.caption("Imports accounts only. Map each CSV column to a CRM field, preview, review flagged duplicates, then commit.")

_DO_NOT_IMPORT = "Do not import"

_FIELDS = [
    "practice_name",
    "practice_email",
    "practice_phone",
    "website",
    "city",
    "state",
    "source_detail",
    "initial_encounter_summary",
    "next_action",
    "next_action_due_date",
    "best_contact",
    "best_contact_email",
    "best_contact_phone",
    "decision_maker",
    "decision_maker_email",
    "decision_maker_phone",
    "pms",
]

# Defaults keyed to the lead-gen Google Sheet's headers (kairosintern
# utils/sheets.py) since that's the sheet the team currently tracks leads in.
_DEFAULT_MAP = {
    "clinic name": "practice_name",
    "practice name": "practice_name",
    "name": "practice_name",
    "phone number": "practice_phone",
    "phone": "practice_phone",
    "practice phone": "practice_phone",
    "contact email": "practice_email",
    "email": "practice_email",
    "practice email": "practice_email",
    "website": "website",
    "city": "city",
    "state": "state",
    "best contact found": "best_contact",
    "best contact": "best_contact",
    "contact role": "decision_maker",
    "notes": "initial_encounter_summary",
    "outreach notes": "initial_encounter_summary",
    "evidence / source": "source_detail",
    "follow-up date": "next_action_due_date",
}


def _clean(value) -> str | None:
    if value is None or pd.isna(value):
        return None
    s = str(value).strip()
    return s or None


uploaded = st.file_uploader("Upload CSV", type=["csv"])
if uploaded is None:
    st.stop()

try:
    df = pd.read_csv(uploaded, dtype=str)
except Exception as e:
    st.error(f"Could not read CSV: {e}")
    st.stop()

st.write(f"{len(df)} rows, {len(df.columns)} columns detected.")

st.subheader("1. Map columns", divider=True)
mapping: dict[str, str] = {}
for i in range(0, len(df.columns), 4):
    cols = st.columns(4)
    for col_widget, csv_col in zip(cols, df.columns[i : i + 4]):
        default = _DEFAULT_MAP.get(csv_col.strip().lower(), _DO_NOT_IMPORT)
        options = [_DO_NOT_IMPORT] + _FIELDS
        picked = col_widget.selectbox(csv_col, options, index=options.index(default), key=f"map_{csv_col}")
        if picked != _DO_NOT_IMPORT:
            mapping[csv_col] = picked

field_counts: dict[str, int] = {}
for f in mapping.values():
    field_counts[f] = field_counts.get(f, 0) + 1
dupes = [f for f, n in field_counts.items() if n > 1]
if dupes:
    st.error(f"Multiple columns mapped to the same field: {', '.join(dupes)}. Fix before importing.")
    st.stop()
if "practice_name" not in mapping.values():
    st.warning("Map a column to practice_name to continue.")
    st.stop()

st.subheader("2. Batch defaults", divider=True)
users = queries.list_users()
channels = queries.list_channel_types()
b1, b2, b3 = st.columns(3)
user_ids = [u["id"] for u in users]
current_id = st.session_state["current_user"]["id"]
owner_id = b1.selectbox(
    "Kairos owner for imported rows", user_ids,
    index=user_ids.index(current_id) if current_id in user_ids else 0,
    format_func=lambda i: next(u["name"] for u in users if u["id"] == i),
)
channel_id = b2.selectbox(
    "Channel type", [None] + [c["id"] for c in channels],
    format_func=lambda i: next((c["label"] for c in channels if c["id"] == i), "—"),
)
stage = b3.selectbox("Pipeline stage", PIPELINE_STAGES, index=0)

rows: list[dict] = []
skipped_no_name = 0
for _, csv_row in df.iterrows():
    payload = {field: _clean(csv_row[col]) for col, field in mapping.items()}
    if not payload.get("practice_name"):
        skipped_no_name += 1
        continue
    if payload.get("next_action_due_date"):
        parsed = pd.to_datetime(payload["next_action_due_date"], errors="coerce")
        payload["next_action_due_date"] = parsed.date().isoformat() if not pd.isna(parsed) else None
    payload["kairos_owner_id"] = owner_id
    payload["channel_type_id"] = channel_id
    payload["pipeline_stage"] = stage
    payload["creation_source"] = "csv_import"
    payload["creation_user_id"] = current_id
    rows.append(payload)

st.subheader("3. Preview", divider=True)
if skipped_no_name:
    st.warning(f"{skipped_no_name} rows have no practice name and will be skipped.")
st.dataframe(pd.DataFrame(rows).head(10), use_container_width=True)

st.subheader("4. Duplicate review", divider=True)
existing = queries.list_accounts()
flagged = find_batch_duplicates(rows, existing)

import_anyway: set[int] = set()
if not flagged:
    st.success("No likely duplicates found.")
else:
    st.warning(
        f"{len(flagged)} of {len(rows)} rows look like possible duplicates. "
        "Review each — check the box to import it anyway, leave unchecked to skip."
    )
    for idx, matches in flagged.items():
        row = rows[idx]
        with st.expander(
            f"Row {idx + 1}: {row['practice_name']} ({row.get('city') or 'no city'})",
            expanded=False,
        ):
            for m in matches:
                other = m["match"]
                where = (
                    f"row {m['batch_row'] + 1} of this import"
                    if "batch_row" in m
                    else "existing account"
                )
                st.write(
                    f"Matches {where}: **{other.get('practice_name')}** "
                    f"({other.get('city') or 'no city'}, {other.get('practice_phone') or 'no phone'}) — "
                    + "; ".join(m["reasons"])
                )
            if st.checkbox("Import anyway", key=f"import_anyway_{idx}"):
                import_anyway.add(idx)

to_import = [r for i, r in enumerate(rows) if i not in flagged or i in import_anyway]
skipped_dupes = len(rows) - len(to_import)

st.subheader("5. Commit", divider=True)
st.write(f"Ready to import {len(to_import)} accounts ({skipped_dupes} flagged rows skipped).")
if st.button(f"Import {len(to_import)} accounts", icon=":material/upload:", disabled=not to_import):
    for payload in to_import:
        created = queries.create_account(payload)
        queries.log_account_creation(created)
    st.success(f"Imported {len(to_import)} accounts. Skipped {skipped_dupes} flagged and {skipped_no_name} nameless rows.")

