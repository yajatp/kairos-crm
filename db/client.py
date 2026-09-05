from __future__ import annotations

import os

import streamlit as st
from supabase import Client, create_client


def _secret(name: str) -> str:
    value = os.getenv(name, "")
    if not value:
        try:
            value = st.secrets.get(name, "")
        except Exception:
            value = ""
    return value


@st.cache_resource
def get_client() -> Client:
    url = _secret("SUPABASE_URL")
    key = _secret("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL / SUPABASE_KEY not configured. This CRM requires its "
            "dedicated Supabase project (being created by Tanush) — set the "
            "credentials in .env or Streamlit secrets and run schema.sql there "
            "first. Do not point this at the lead-gen project or a local Postgres."
        )
    return create_client(url, key)
