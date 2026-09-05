"""Query helpers per table. Supabase is the single source of truth — every
view reads fresh through these; nothing is cached across reruns."""

from datetime import datetime, timezone

from db.client import get_client


def list_users(active_only: bool = True) -> list[dict]:
    q = get_client().table("users").select("*").order("name")
    if active_only:
        q = q.eq("active", True)
    return q.execute().data


def add_user(name: str) -> int:
    """Idempotent by name: inline creation from a dropdown can fire twice for the
    same typed name (re-saving a form), and duplicate owners are hard to unpick."""
    existing = get_client().table("users").select("id").ilike("name", name).execute().data
    if existing:
        set_user_active(existing[0]["id"], True)
        return existing[0]["id"]
    res = get_client().table("users").insert({"name": name}).execute()
    return res.data[0]["id"]


def set_user_active(user_id: int, active: bool) -> None:
    get_client().table("users").update({"active": active}).eq("id", user_id).execute()


def list_channel_types(active_only: bool = True) -> list[dict]:
    q = get_client().table("channel_types").select("*").order("label")
    if active_only:
        q = q.eq("active", True)
    return q.execute().data


def add_channel_type(label: str) -> int:
    existing = get_client().table("channel_types").select("id").ilike("label", label).execute().data
    if existing:
        set_channel_type_active(existing[0]["id"], True)
        return existing[0]["id"]
    res = get_client().table("channel_types").insert({"label": label}).execute()
    return res.data[0]["id"]


def set_channel_type_active(channel_id: int, active: bool) -> None:
    get_client().table("channel_types").update({"active": active}).eq("id", channel_id).execute()


def list_accounts(
    owner_id: int | None = None,
    stage: str | None = None,
    channel_id: int | None = None,
    city: str | None = None,
    search: str | None = None,
) -> list[dict]:
    q = get_client().table("account_overview").select("*")
    if owner_id is not None:
        q = q.eq("kairos_owner_id", owner_id)
    if stage:
        q = q.eq("pipeline_stage", stage)
    if channel_id:
        q = q.eq("channel_type_id", channel_id)
    if city:
        q = q.ilike("city", f"%{city}%")
    if search:
        q = q.ilike("practice_name", f"%{search}%")
    return q.order("practice_name").execute().data


def get_account(account_id: int) -> dict | None:
    rows = (
        get_client().table("account_overview").select("*").eq("id", account_id).execute().data
    )
    return rows[0] if rows else None


def create_account(fields: dict) -> dict:
    return get_client().table("accounts").insert(fields).execute().data[0]


def update_account(account_id: int, fields: dict) -> None:
    get_client().table("accounts").update(fields).eq("id", account_id).execute()


def delete_account(account_id: int) -> None:
    get_client().table("accounts").delete().eq("id", account_id).execute()


def list_contacts(account_id: int) -> list[dict]:
    return (
        get_client().table("contacts").select("*").eq("account_id", account_id)
        .order("name").execute().data
    )


def create_contact(fields: dict) -> None:
    get_client().table("contacts").insert(fields).execute()


def update_contact(contact_id: int, fields: dict) -> None:
    get_client().table("contacts").update(fields).eq("id", contact_id).execute()


def delete_contact(contact_id: int) -> None:
    get_client().table("contacts").delete().eq("id", contact_id).execute()


def list_activities(account_id: int) -> list[dict]:
    return (
        get_client().table("activities").select("*").eq("account_id", account_id)
        .order("date", desc=True).order("id", desc=True).execute().data
    )


def list_recent_activities(limit: int = 20) -> list[dict]:
    return (
        get_client().table("activities").select("*, accounts(practice_name)")
        .eq("is_system", False)
        .order("date", desc=True).order("id", desc=True).limit(limit).execute().data
    )


def log_activity(fields: dict) -> None:
    # The activities_sync_next_action trigger updates the parent account's
    # next_action fields atomically with this insert — do not update here too.
    get_client().table("activities").insert(fields).execute()


def log_account_creation(account: dict) -> None:
    """Log how an account came to exist as the first entry in its activity log,
    instead of a separate always-visible box on the account page. Called right
    after create_account, regardless of source (manual, chatbot, donut_scrape,
    csv_import) — every path funnels through here so the log entry format stays
    consistent."""
    from utils.tz import central_today

    source = account.get("creation_source") or "manual"
    user_id = account.get("creation_user_id")
    user_name = None
    if user_id:
        users = list_users(active_only=False)
        user_name = next((u["name"] for u in users if u["id"] == user_id), None)

    if source == "manual":
        summary = "Created manually"
    elif source == "chatbot":
        summary = "Created via chatbot"
    elif source == "donut_scrape":
        run_label = None
        if account.get("donut_run_id"):
            run = get_donut_run(account["donut_run_id"])
            run_label = (run or {}).get("run_name") or f"Run #{account['donut_run_id']}"
        summary = f"Created from Donut Scrape — {run_label}" if run_label else "Created from Donut Scrape"
    elif source == "csv_import":
        summary = "Created via CSV import"
    else:
        summary = f"Created ({source})"

    if user_name:
        summary += f" by {user_name}"

    reason = account.get("creation_reason")
    if reason:
        summary += f" — {reason}"

    log_activity({
        "account_id": account["id"],
        "date": central_today().isoformat(),
        "kairos_owner_id": user_id,
        "activity_type": "Account created",
        "summary": summary,
        "is_system": True,
    })


def list_demos(account_id: int) -> list[dict]:
    return (
        get_client().table("demos").select("*").eq("account_id", account_id)
        .order("demo_date", desc=True).execute().data
    )


def list_all_demos() -> list[dict]:
    return get_client().table("demos").select("*").execute().data


def create_demo(fields: dict) -> None:
    get_client().table("demos").insert(fields).execute()


def update_demo(demo_id: int, fields: dict) -> None:
    get_client().table("demos").update(fields).eq("id", demo_id).execute()


def delete_demo(demo_id: int) -> None:
    get_client().table("demos").delete().eq("id", demo_id).execute()


def list_cadences(active_only: bool = True) -> list[dict]:
    q = get_client().table("cadences").select("*").order("name")
    if active_only:
        q = q.eq("active", True)
    return q.execute().data


def create_cadence(fields: dict) -> None:
    get_client().table("cadences").insert(fields).execute()


def update_cadence(cadence_id: int, fields: dict) -> None:
    get_client().table("cadences").update(fields).eq("id", cadence_id).execute()


def list_cadence_steps(cadence_id: int) -> list[dict]:
    return (
        get_client().table("cadence_steps").select("*").eq("cadence_id", cadence_id)
        .order("step_order").order("id").execute().data
    )


def create_cadence_step(fields: dict) -> None:
    get_client().table("cadence_steps").insert(fields).execute()


def update_cadence_step(step_id: int, fields: dict) -> None:
    get_client().table("cadence_steps").update(fields).eq("id", step_id).execute()


def delete_cadence_step(step_id: int) -> None:
    get_client().table("cadence_steps").delete().eq("id", step_id).execute()


def get_template(template_id: int) -> dict | None:
    rows = (
        get_client().table("email_templates").select("*").eq("id", template_id).execute().data
    )
    return rows[0] if rows else None


def list_templates(category: str | None = None) -> list[dict]:
    q = get_client().table("email_templates").select("*").order("name")
    if category:
        q = q.eq("category", category)
    return q.execute().data


def create_template(fields: dict) -> None:
    get_client().table("email_templates").insert(fields).execute()


def update_template(template_id: int, fields: dict) -> None:
    get_client().table("email_templates").update(fields).eq("id", template_id).execute()


def delete_template(template_id: int) -> None:
    get_client().table("email_templates").delete().eq("id", template_id).execute()


def get_distinct_column_values(table: str, column: str) -> list[str]:
    res = get_client().table(table).select(column).execute()
    vals = {r[column] for r in res.data if r.get(column)}
    return sorted(list(vals))


def list_bot_messages(session_id: int, limit: int = 50) -> list[dict]:
    data = (
        get_client().table("bot_messages").select("*")
        .eq("session_id", session_id)
        .order("id", desc=True).limit(limit).execute().data
    )
    return list(reversed(data))


def list_chat_sessions(user_id: int) -> list[dict]:
    return (
        get_client().table("chat_sessions").select("*")
        .eq("user_id", user_id)
        .order("last_message_at", desc=True).execute().data
    )


def get_or_create_default_session(user_id: int) -> dict:
    existing = (
        get_client().table("chat_sessions").select("*")
        .eq("user_id", user_id).eq("is_default", True).limit(1).execute().data
    )
    if existing:
        return existing[0]
    return (
        get_client().table("chat_sessions")
        .insert({"user_id": user_id, "title": "Texts", "is_default": True})
        .execute().data[0]
    )


def create_chat_session(user_id: int, title: str | None = None) -> dict:
    return (
        get_client().table("chat_sessions")
        .insert({"user_id": user_id, "title": title})
        .execute().data[0]
    )


def rename_chat_session(session_id: int, title: str | None) -> None:
    get_client().table("chat_sessions").update({"title": title}).eq("id", session_id).execute()


def delete_chat_session(session_id: int) -> None:
    get_client().table("chat_sessions").delete().eq("id", session_id).execute()


# ── Donut Runs ───────────────────────────────────────────────────────────────

def create_donut_run(fields: dict) -> dict:
    return get_client().table("donut_runs").insert(fields).execute().data[0]


def get_donut_run(run_id: int) -> dict | None:
    rows = get_client().table("donut_runs").select("*").eq("id", run_id).execute().data
    return rows[0] if rows else None


def list_donut_runs(user_id: int | None = None) -> list[dict]:
    query = get_client().table("donut_runs").select("*")
    if user_id is not None:
        query = query.eq("created_by", user_id)
    return query.order("created_at", desc=True).execute().data


def update_donut_run(run_id: int, fields: dict) -> None:
    get_client().table("donut_runs").update(fields).eq("id", run_id).execute()


# ── Donut Run Results ────────────────────────────────────────────────────────

def create_donut_run_result(fields: dict) -> dict:
    return get_client().table("donut_run_results").insert(fields).execute().data[0]


def log_donut_result_activity(
    result_id: int,
    user_id: int | None,
    activity_type: str,
    summary: str,
    notes: str | None = None,
    created_at: str | None = None,
) -> dict | None:
    """Record a pre-CRM activity for a donut run result (status update, call note, etc.)."""
    payload = {
        "donut_run_result_id": result_id,
        "user_id": user_id,
        "activity_type": activity_type,
        "summary": summary,
        "notes": notes.strip() if notes else None,
    }
    if created_at:
        payload["created_at"] = created_at
    try:
        res = get_client().table("donut_result_activities").insert(payload).execute()
        return res.data[0] if res.data else None
    except Exception:
        # Fallback if table doesn't exist yet
        return None


def list_donut_result_activities(result_id: int) -> list[dict]:
    """Fetch all pre-CRM activity log entries for a result in chronological order."""
    try:
        return (
            get_client().table("donut_result_activities").select("*")
            .eq("donut_run_result_id", result_id)
            .order("created_at", desc=False).execute().data or []
        )
    except Exception:
        return []


def bulk_create_donut_run_results(rows: list[dict], user_id: int | None = None) -> list[dict]:
    if not rows:
        return []
    inserted = get_client().table("donut_run_results").insert(rows).execute().data
    if inserted:
        user_name = "Team User"
        if user_id:
            users = list_users(active_only=False)
            user_name = next((u["name"] for u in users if u["id"] == user_id), "Team User")
        for res_row in inserted:
            log_donut_result_activity(
                result_id=res_row["id"],
                user_id=user_id,
                activity_type="Scraped",
                summary=f"Scraped and added to list by {user_name}",
            )
    return inserted


def list_donut_run_results(run_id: int) -> list[dict]:
    return (
        get_client().table("donut_run_results").select("*")
        .eq("donut_run_id", run_id)
        .order("clinic_name").execute().data
    )


def update_donut_run_result(result_id: int, fields: dict, user_id: int | None = None) -> None:
    payload = dict(fields)
    if user_id is not None:
        payload["updated_by"] = user_id
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        get_client().table("donut_run_results").update(payload).eq("id", result_id).execute()
    except Exception as e:
        # Fallback if attribution columns (updated_by/updated_at) don't exist in Supabase DB yet
        if user_id is not None and ("updated_by" in payload or "updated_at" in payload):
            try:
                get_client().table("donut_run_results").update(fields).eq("id", result_id).execute()
            except Exception:
                pass
        else:
            raise e

    # Automatically record a pre-CRM activity entry if call_status or call_notes changed
    if "call_status" in fields or "call_notes" in fields:
        user_name = "Team User"
        if user_id:
            users = list_users(active_only=False)
            user_name = next((u["name"] for u in users if u["id"] == user_id), "Team User")

        new_status = fields.get("call_status")
        notes = fields.get("call_notes")
        summary_parts = []
        if new_status:
            summary_parts.append(f"Updated call status to '{new_status}' by {user_name}")
        if notes:
            summary_parts.append(f"Call Note: {notes}")

        summary = " — ".join(summary_parts) if summary_parts else f"Updated by {user_name}"
        log_donut_result_activity(
            result_id=result_id,
            user_id=user_id,
            activity_type="Call Update" if new_status else "Note",
            summary=summary,
            notes=notes,
        )
        
        # If already promoted to CRM, also log this update to the CRM activities
        # so the bot and account view can see the new call notes/status.
        r = get_client().table("donut_run_results").select("promoted_account_id").eq("id", result_id).execute().data
        if r and r[0].get("promoted_account_id"):
            log_activity({
                "account_id": r[0]["promoted_account_id"],
                "date": datetime.now(timezone.utc).date().isoformat(),
                "kairos_owner_id": user_id,
                "activity_type": "Call" if new_status else "Note",
                "summary": f"Scraper Checklist: {summary}",
                "is_system": False,
            })


def promote_donut_result(result_id: int, user_id: int) -> dict:
    """Create a CRM account from a donut run result, copy pre-CRM activity log to CRM, and link them."""
    from utils.tz import CENTRAL
    from datetime import date

    result = get_client().table("donut_run_results").select("*").eq("id", result_id).execute().data
    if not result:
        raise ValueError(f"Donut result {result_id} not found")
    r = result[0]
    if r.get("promoted_account_id"):
        # Already promoted
        return get_account(r["promoted_account_id"])

    call_status = r.get("call_status", "Not Called")
    pipeline_stage = "New Lead" if call_status == "Not Called" else call_status
    lost_reason = None
    if call_status == "Not Interested":
        lost_reason = "Dentist/owner not interested"
    elif call_status == "Dead":
        lost_reason = "Other"

    notes_parts = []
    if r.get("notes"):
        notes_parts.append(r["notes"])
    if r.get("call_notes"):
        notes_parts.append(f"Call Notes: {r['call_notes']}")
    initial_encounter_summary = "\n\n".join(notes_parts) if notes_parts else None

    account_fields = {
        "practice_name": r["clinic_name"],
        "practice_email": r.get("email") or None,
        "practice_phone": r.get("phone") or None,
        "website": r.get("website") or None,
        "city": _city_from_address(r.get("address", "")),
        "state": _state_from_address(r.get("address", "")),
        "pipeline_stage": pipeline_stage,
        "source_detail": f"Donut Scrape — {r.get('classification') or 'dental clinic'}",
        "initial_encounter_summary": initial_encounter_summary,
        "creation_source": "donut_scrape",
        "kairos_owner_id": user_id,
        "creation_user_id": user_id,
        "donut_run_id": r["donut_run_id"],
        "channel_type_id": _get_donut_channel_id(),
    }
    if lost_reason:
        account_fields["lost_reason"] = lost_reason
    account = create_account(account_fields)
    log_account_creation(account)

    # File all pre-CRM activity history directly into the CRM activities table
    pre_activities = list_donut_result_activities(result_id)
    if pre_activities:
        for act in pre_activities:
            act_date = date.today().isoformat()
            if act.get("created_at"):
                try:
                    act_date = datetime.fromisoformat(str(act["created_at"]).replace("Z", "+00:00")).astimezone(CENTRAL).date().isoformat()
                except Exception:
                    pass
            act_raw_type = act.get("activity_type", "Note")
            if act_raw_type == "Scraped":
                act_type = "Donut Visit"
            elif act_raw_type in ("Call Update", "Status Change"):
                act_type = "Call"
            else:
                act_type = "Note"

            summary_text = act.get("summary") or "Pre-CRM Scraper Activity"

            log_activity({
                "account_id": account["id"],
                "date": act_date,
                "kairos_owner_id": act.get("user_id") or user_id,
                "activity_type": act_type,
                "summary": summary_text,
                "is_system": False,
            })
    else:
        # Fallback if no pre-CRM activity records exist
        user_name = "Team User"
        if user_id:
            users = list_users(active_only=False)
            user_name = next((u["name"] for u in users if u["id"] == user_id), "Team User")
        log_activity({
            "account_id": account["id"],
            "date": date.today().isoformat(),
            "kairos_owner_id": user_id,
            "activity_type": "Donut Visit",
            "summary": f"Imported from Donut Scrape (Run #{r['donut_run_id']}) by {user_name}",
            "is_system": False,
        })

    now_iso = datetime.now(timezone.utc).isoformat()
    full_update = {
        "promoted_account_id": account["id"],
        "promoted_by": user_id,
        "promoted_at": now_iso,
        "updated_by": user_id,
        "updated_at": now_iso,
    }
    try:
        get_client().table("donut_run_results").update(full_update).eq("id", result_id).execute()
    except Exception:
        get_client().table("donut_run_results").update({"promoted_account_id": account["id"]}).eq("id", result_id).execute()
    return account


def unpromote_donut_result(result_id: int, user_id: int | None = None) -> None:
    """Unlink a donut run result from its CRM account and delete the account."""
    result = get_client().table("donut_run_results").select("promoted_account_id").eq("id", result_id).execute().data
    if not result:
        return
    account_id = result[0].get("promoted_account_id")

    fields = {
        "promoted_account_id": None,
        "promoted_by": None,
        "promoted_at": None,
    }
    if user_id is not None:
        fields["updated_by"] = user_id
        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        get_client().table("donut_run_results").update(fields).eq("id", result_id).execute()
    except Exception:
        get_client().table("donut_run_results").update({"promoted_account_id": None}).eq("id", result_id).execute()
        
    if account_id:
        try:
            delete_account(account_id)
        except Exception:
            pass


def bulk_promote_donut_results(
    run_id: int, user_id: int, exclude_statuses: set | None = None
) -> tuple[list[dict], list[dict], list[dict]]:
    """Promote all eligible results from a run.

    Returns (created_accounts, errors, flagged_duplicates).
    - errors: [{"clinic_name", "reason"}] for results that failed to create.
    - flagged_duplicates: [{"clinic_name", "matches"}] for results that look like
      an existing CRM account — these are *not* auto-created (dedup must warn and
      let the user decide, never silently create or silently skip); they're left
      untouched in the checklist for a manual per-result "Promote to CRM" decision.
    """
    if exclude_statuses is None:
        exclude_statuses = {"Dead", "Not Interested"}
    results = list_donut_run_results(run_id)
    created = []
    errors = []
    flagged_duplicates = []
    for r in results:
        if r.get("promoted_account_id"):
            continue
        if r.get("call_status") in exclude_statuses:
            continue
        matches = find_donut_result_duplicates(r)
        if matches:
            flagged_duplicates.append({"clinic_name": r.get("clinic_name", "Unknown"), "matches": matches})
            continue
        try:
            account = promote_donut_result(r["id"], user_id)
            created.append(account)
        except Exception as e:
            errors.append({"clinic_name": r.get("clinic_name", "Unknown"), "reason": str(e)})
    return created, errors, flagged_duplicates


def find_donut_result_duplicates(result: dict) -> list[dict]:
    """Check a donut run result against existing CRM accounts before promotion,
    using the same name/phone/domain matching as manual account creation
    (utils.dedup.find_duplicates) — promotion must warn, never silently create
    a second account for a clinic that's already in the CRM."""
    from utils.dedup import find_duplicates

    candidate = {
        "practice_name": result.get("clinic_name", ""),
        "practice_phone": result.get("phone"),
        "practice_email": result.get("email"),
        "website": result.get("website"),
        "city": _city_from_address(result.get("address", "")),
    }
    return find_duplicates(candidate, list_accounts())


def _get_donut_channel_id() -> int | None:
    """Get or create the 'Donut Visit' channel type."""
    rows = get_client().table("channel_types").select("id").ilike("label", "Donut Visit").execute().data
    if rows:
        return rows[0]["id"]
    try:
        return add_channel_type("Donut Visit")
    except Exception:
        return None


def _city_from_address(address: str) -> str | None:
    """Extract city from a formatted address like '123 Main St, Plano, TX 75024'
    or '123 Main St, Plano, TX 75024, USA' (Google Places v1 appends the country).
    The city is whatever part sits immediately before the 'STATE ZIP' segment —
    locating that segment by regex instead of counting from the front, since a
    suite/unit part or a trailing country both shift a fixed offset off by one."""
    import re

    parts = [p.strip() for p in address.split(",") if p.strip()]
    for i, part in enumerate(parts):
        if re.match(r"^[A-Z]{2}\s+\d{5}", part) and i > 0:
            return parts[i - 1]
    if len(parts) >= 2:
        return parts[-2]
    if len(parts) == 1:
        return parts[0]
    return None


def _state_from_address(address: str) -> str | None:
    """Extract state abbreviation from a formatted address."""
    import re
    parts = [p.strip() for p in address.split(",")]
    for part in reversed(parts):
        m = re.match(r"^([A-Z]{2})\s+\d{5}", part.strip())
        if m:
            return m.group(1)
    return None
