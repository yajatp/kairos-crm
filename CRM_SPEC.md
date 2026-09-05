# Kairos CRM — Feature Spec for Claude Code

**Repo:** New repo, separate from `kairosleadgen` (see rationale in Section 1).
**Status:** Ready to build. This spec is meant to be unambiguous enough that you should not need to ask Yajat clarifying questions before starting.
**How to use this document:** If a `CLAUDE.md` exists in this new repo by the time you read this, that file's hard rules (style conventions, comment policy, etc.) apply on top of this spec. This document defines feature behavior; it does not replace repo-level style conventions.

**Action required from you (Claude Code) before writing any code — see Section 9.** Two pieces of this spec (duplicate-detection logic, Google Sheet output structure) intentionally point you at the sibling `kairosleadgen` repo instead of re-specifying the logic here. Go read the actual code before building the equivalent CRM features. Do not guess at either.

---

## 1. Context — why this is a separate repo from `kairosleadgen`

`kairosleadgen` (Donut Scraper + lead-gen scoring) is a "run occasionally, get output, walk away" tool — Yajat or Tanush kicks off a search, consumes a Google Sheet, done. This CRM is the opposite: Tanush, Aditya, Sanjana, and Adhira are expected to be in it constantly, logging every visit/call/email and checking the dashboard for overdue follow-ups. That's a different reliability bar — a broken experimental deploy on the scraper side should never be able to take down the system of record the team relies on to not drop leads. Separate repo, separate deploy, on purpose.

This CRM is also relationally structured (accounts → contacts → activities, with filtering/sorting/search/duplicate-detection) rather than export-oriented like the scraper tools' Google Sheets output. It needs a real database from day one, not a Sheets writer.

**Explicit non-goal for this build:** no automatic pipe from Donut Scraper or lead-gen into this CRM. CSV import (Section 8) is the only ingestion path for now. A direct integration may happen later — don't build toward it speculatively.

---

## 2. Stack

- **Frontend:** Streamlit, same as the rest of Kairos's internal tooling — consistent with existing team tooling, fast to build, acceptable for this use case for the reason below.
- **Backend/database:** Supabase (Postgres), via `supabase-py`. **This is a hard requirement, not a suggestion** — this CRM is a real system of record with relational data (accounts, contacts, activities) and needs actual query/filter/index capability that a flat file or Sheet cannot support at this record volume.
- **Blocking dependency:** a new, dedicated Supabase project for this CRM, separate from whatever project the `kairosleadgen` migration eventually lands in. Yajat is getting this created by Tanush on the company Supabase account. **If this project doesn't exist yet when you start building, stop and flag it — do not build against a placeholder/local Postgres instance and hope to swap it later.** Connection details will be provided via `.env` / Streamlit secrets once the project exists.

### Why Streamlit is acceptable here despite being a multi-user app

Streamlit has no built-in cross-session state — two people on two devices are fully isolated `st.session_state` instances. That's fine here **only because Supabase is the single source of truth for every read and write**; nothing meaningful lives in `st.session_state` beyond ephemeral UI state (the currently-selected user, form-in-progress values, filter selections). Every list/dashboard view queries Supabase fresh. This avoids any actual state conflict between concurrent users — there's nothing to conflict, because nothing is cached across a meaningful window.

The real limitation this creates: Streamlit will not proactively push Aditya's new activity log entry onto Tanush's already-open dashboard. Tanush has to trigger a rerun to see it. Do not try to build true push/websocket-based live sync — that's real engineering effort for a problem this team can tolerate. Instead:
- Add a manual "Refresh" button, prominent, on the Dashboard and Accounts pages.
- Add a lightweight auto-refresh on the **Dashboard specifically** (e.g. `st_autorefresh` component or an equivalent rerun-on-timer, every 60 seconds) since that's the page where staleness matters most (due-today/overdue counts).
- Do not add auto-refresh to the Accounts detail/edit pages — a rerun while someone is mid-edit of a form would blow away unsaved input. Only add it to read-only dashboard views.

---

## 3. Explicit access model (no auth)

**Decision, confirmed by Yajat: no password-based authentication.** This is an internal tool for four named people who fully trust each other and are meant to see each other's data. Do not build a login system, do not add Supabase Auth, do not add row-level security scoped per-user.

**What to build instead — a user-select landing screen:**
- On app load (or if no user is currently selected in `st.session_state`), show a simple screen with four buttons/tiles: **Tanush, Aditya, Sanjana, Adhira** (pulled from the `users` table — see Section 4 — not hardcoded, since it must be admin-editable).
- Selecting one sets `st.session_state['current_user']` for that browser session and proceeds to the app.
- The selected user is used to **pre-fill** the "Kairos Owner" field on new accounts and new activity log entries. It is always editable/overridable per-entry — someone can log an activity on Sanjana's behalf if needed, no restriction.
- Provide a small persistent element (e.g. sidebar) showing "Acting as: [name]" with a way to switch users without reloading the whole app.
- **This is a convenience default, not identity enforcement.** There is nothing stopping someone from selecting a different name than their own. That's an accepted tradeoff per Yajat's explicit call — don't over-engineer around it.

---

## 4. Admin-editable enums

Two fields must be editable by the team without a code deploy, per Yajat's explicit instruction — implement as real tables, not hardcoded Python lists/enums:

- **`users`** table: `id`, `name`, `active` (boolean). Used both for the landing-screen selector (Section 3) and the "Kairos Owner" dropdown throughout the app. Deactivating someone (rather than deleting) should remove them from the active picker/dropdown without breaking historical records that reference them.
- **`channel_types`** table: `id`, `label`, `active` (boolean). Seed with the PDF's initial list (Donut Visit, Cold Visit, Apollo Cold Outreach, Conference, Referral, Other) but the team must be able to add/deactivate entries later.

Build a simple admin/settings page in the app for managing both tables (add new, toggle active) — doesn't need to be fancy, just functional.

**Everything else enumerated in the PDF (pipeline stages, activity types, lost reasons, current-tool list, demo status) stays as fixed application-level choices for v1** — Yajat did not ask for these to be admin-editable, and expanding every enum into an editable table is scope creep beyond what was requested. If the team wants one of these editable later, it's a small follow-up, not something to speculatively build now.

---

## 5. Data model

### 5.1 `accounts`
One row per dental practice.

| Field | Notes |
|---|---|
| id | |
| practice_name | |
| practice_email | |
| practice_phone | |
| city | |
| kairos_owner_id | FK → `users` |
| channel_type_id | FK → `channel_types` |
| source_detail | free text, e.g. "PNDC 2026" |
| initial_encounter_summary | free text |
| pipeline_stage | fixed enum — see 5.2 |
| next_action | free text |
| next_action_due_date | date |
| last_action_date | date — see note below |
| created_at | timestamp, set on insert |
| lost_reason | fixed enum, nullable, only relevant if stage is Closed Lost |
| competitor_tool | fixed enum ("current tool"), nullable |
| pms | free text, nullable |
| best_contact | **free text** (confirmed) — not a FK to `contacts`. Most of the time this is a name pulled off a website/scrape that isn't yet a confirmed real Contact record, so forcing a relational link would block entry on info that usually isn't fully known. |
| decision_maker | free text, nullable |
| decision_maker_reached | enum: Yes / No / Unknown |

**`last_action_date` and "current state summary": derived, not stored.** The PDF listed "current state summary" as its own account field. Per discussion, do not store this — a manually-maintained summary field alongside a full activity log is a guaranteed drift/duplication problem (someone updates one and forgets the other). Instead:
- `last_action_date` is computed as `MAX(activities.date)` for that account (or `created_at` if no activities exist yet).
- Anywhere the UI would show "current state," display the **summary text of the most recent activity log entry** for that account, read-only, pulled live from `activities`. No separate field to keep in sync.

### 5.2 Pipeline stages (fixed enum)
New Lead, Contacted, Interested, Demo Scheduled, Waiting on Decision, Onboarding, Closed Won, Closed Lost, Nurture Later.
Follow-up is explicitly **not** a stage — it's handled via `next_action` / `next_action_due_date` on the account, per the PDF's own instruction.

### 5.3 `contacts`
Multiple per account.

| Field | Notes |
|---|---|
| id | |
| account_id | FK → `accounts` |
| name | |
| role | free text |
| email | nullable |
| phone | nullable |

### 5.4 `activities`
Activity log, multiple per account.

| Field | Notes |
|---|---|
| id | |
| account_id | FK → `accounts` |
| date | |
| kairos_owner_id | FK → `users`, pre-filled from session (Section 3), editable |
| activity_type | fixed enum: In-person visit, Phone call, Email sent, Demo scheduled, Demo completed, Follow-up completed, Pricing/onboarding info sent, No response, Other |
| summary | free text |
| next_action | free text, nullable |
| next_action_due_date | date, nullable |

**Logging a new activity with a `next_action`/`next_action_due_date` should update the parent account's `next_action`/`next_action_due_date` fields to match** (the account-level fields represent "the current single next action," the activity log is the history of how it evolved). Make this update atomic with the activity insert.

### 5.5 `demos`
One row per demo (an account could in principle have more than one over time — e.g. rescheduled counts as a status change on the same row, a second distinct demo later would be a new row). Rendered inside the account detail page per the PDF ("does not need to be a separate module") — but store it as its own table for clean structure; "not a separate module" refers to UI placement, not schema design.

| Field | Notes |
|---|---|
| id | |
| account_id | FK → `accounts` |
| demo_date | |
| attendees | free text |
| status | enum: Scheduled, Completed, No-show, Rescheduled |
| pain_points | free text |
| objections | free text |
| follow_up_required | free text or boolean + note — use free text, consistent with how the rest of the app handles this |

### 5.6 `email_templates`

| Field | Notes |
|---|---|
| id | |
| name | |
| category | fixed enum — see PDF's category list (Follow-up after in-person visit [with sub-cases for went well / neutral-poor / interested-later], Scheduling a demo after visit, Follow-up after no response, Conference follow-up, Referral follow-up, Post-demo follow-up, Pricing/onboarding follow-up, Rejection/keep-in-touch) |
| situation | free text — when to use it |
| subject | |
| body | actual copy to be filled in by the Kairos team later — build the CRUD, don't pre-populate content |
| notes | free text |

### 5.7 Fixed enum value lists (for reference, all stored as plain constants unless stated otherwise in Section 4)

- **Lost reasons:** Too expensive, Not ready for AI, Dentist/owner not interested, Office manager not interested, Uses another AI tool, Uses another patient communication tool, DSO restriction, PMS/integration concern, Bad timing, No response, Other
- **Competitor/current tool:** Weave, Adit, Dentina, NexHealth, Mango, Dental Intelligence, Patient Prism, None / front desk only, Unknown

---

## 6. Dashboard / stale-lead logic

Single dashboard page, action-center style, sections in this order:

1. **Due Today** — `next_action_due_date = today` (Central time — see Section 7).
2. **Overdue** — `next_action_due_date < today`, account not in Closed Won / Closed Lost / Nurture Later.
3. **Stale Leads** — flag if, for an account **not** in Closed Won / Closed Lost / Nurture Later, any of:
   - `next_action_due_date` has passed (same as Overdue — a stale account can also appear here, that's fine, both are legitimate signals), OR
   - account has a stage but no `next_action` set at all, OR
   - `last_action_date` is 14+ days ago, OR
   - `pipeline_stage = 'Demo Scheduled'` and the linked demo's status is `Completed` but no `next_action` is set, OR
   - `pipeline_stage` in (Interested, Waiting on Decision) for 7+ days with no activity logged in that window.
4. **Upcoming** — `next_action_due_date` falls later this week (after today, within the current week).

Each row across all sections: practice name, Kairos owner, pipeline stage, next action, due date, days overdue (if applicable), link/button to open the account.

Top-of-page banner summarizing counts, e.g. "5 overdue follow-ups and 3 actions due today" — plain text banner is sufficient for v1, no popups/notifications needed.

Auto-refresh this page every ~60 seconds (Section 2) plus a manual refresh button.

---

## 7. Timezone

**All due-date/overdue/stale logic uses Central Time (America/Chicago), unconditionally.** The whole team is DFW-based; there is no multi-timezone requirement. Store timestamps in UTC in the database (standard practice) but do all "is this due/overdue/stale today" comparisons against the current Central date. Do not build a per-user timezone display or timezone labels next to dates — this was considered and explicitly rejected as unneeded complexity for a single-timezone team.

---

## 8. CSV import

Per Yajat's explicit call: build the real column-mapping version, not a fixed-header shortcut, even though the source PDF called this "doesn't need to be perfect." Column mapping is the literal ask in the source spec and is meaningfully more usable — worth the extra build time.

Flow:
1. User uploads a CSV.
2. App shows detected columns from the CSV alongside a dropdown per column to map to a CRM `accounts` field (or "Do not import" for columns with no equivalent).
3. Preview the mapped result (first several rows) before committing.
4. Run duplicate detection (Section 9) against every row being imported, both against existing `accounts` and against other rows within the same import batch.
5. Flag likely duplicates for the user to review/skip/import-anyway before final commit — do not silently auto-skip or auto-merge.
6. Commit the non-flagged (and any user-confirmed) rows as new `accounts`.

Import is accounts-only for v1 (matches the PDF's scope) — no contacts/activities import.

---

## 9. Duplicate detection — go read the sibling repo first

There is an existing duplicate-detection script in `kairosleadgen` used to prevent duplicate entries from overlapping Google Places API calls during a Donut Scraper run. **Before building this feature, locate and read that script directly** (search the `kairosleadgen` repo — likely under `pipeline/` or `utils/` given that repo's structure — for dedup/duplicate-related logic; check `DONUT_SCRAPER_SPEC.md` in that repo for context on what it dedupes and how).

**Important scope difference — do not port the logic as-is:** the `kairosleadgen` script dedupes **exact Google Place ID matches** within a single scraper run. This CRM's duplicate problem is different: comparing a newly typed or imported account against existing CRM rows, most of which have **no Place ID at all** (Apollo leads, conference contacts, referrals aren't sourced from Google Places). So reuse the *approach/pattern* where applicable, but the actual matching logic for this feature needs to be:

- **Exact match (high confidence, always flag):** identical phone number, email, or website across accounts.
- **Fuzzy match (flag for review, don't auto-block):** similar practice name **within the same city** — use a string-similarity library (e.g. `rapidfuzz`) with a starting threshold in a similar spirit to the 0.85 IoU threshold used for the Donut Scraper's tab-matching logic (same underlying philosophy: loose enough to catch near-duplicates like "Sunshine Dentistry" vs "Sunshine Dental," strict enough not to flag unrelated practices that happen to share a common word). Tune empirically; treat as a starting default per Yajat, not a firm requirement — flag to Yajat if it's producing obviously wrong results (too many false flags, or missing clear duplicates) rather than silently adjusting and moving on.
- Applies both to manual account creation (check on save, before insert) and CSV import (Section 8).
- Always **warn and let the user decide** — never silently block or silently merge. Show what it matched against so the user can judge.

Also check the same `kairosleadgen` repo for how the lead-gen output Google Sheet is structured/formatted (headers, column order, data types) — this CRM doesn't need to write to a Sheet, but understanding that existing format will help make sensible default column-mapping suggestions in the CSV import UI (Section 8), since the sheet the team is currently tracking leads in is that tool's output.

---

## 10. Filters / search (Accounts page)

Per the PDF: add, edit, delete, search, sort, filter on the Accounts list. Required filters: Kairos owner, pipeline stage, channel type, city, due today, overdue, no activity in X+ days (X configurable input, default reasonable e.g. 14 to match stale-lead logic).

---

## 11. Where things go in the repo

New repo (name TBD by Yajat, e.g. `kairos-crm`). Suggested structure, adjust to match whatever conventions the sibling `kairosleadgen` repo uses for consistency across Kairos's internal tooling (check that repo's `CLAUDE.md` for house style — no emojis, comment conventions, etc. — and apply the same conventions here even though this is a separate repo):

- `app.py` — Streamlit entry point, `st.navigation([...])`
- `pages/` — landing/user-select, dashboard, accounts (list + detail), contacts (nested under account detail), email_templates, admin/settings, csv_import
- `db/` — Supabase client setup, query helpers per table
- `pipeline/` or `utils/` — duplicate detection logic (Section 9), stale-lead computation (Section 6), timezone helpers (Section 7)

---

## 12. Open items — flag back rather than silently deciding

- **Supabase project creation is a blocking dependency** — do not build against a placeholder and assume connection swap-in later will be trivial; confirm the project exists and get real credentials before considering this "done."
- **Fuzzy-match threshold for name-based duplicate detection** (Section 9) is a starting default, not tuned — flag to Yajat after early real usage if it's producing bad results.
- **Whether lost reasons / competitor-tool list should also become admin-editable** — not requested for v1 (Section 4), but likely to come up once the team actually uses this; small follow-up if/when asked.
- **Eventual Donut Scraper / lead-gen → CRM pipe** — explicitly out of scope for this build (Section 1); don't build toward it speculatively, but don't make a data-model choice now that would make it hard later either (e.g. keeping `source_detail` as free text rather than something too rigid helps here).

---

## 13. Definition of done

1. Four named users can select "who they are" on load with no password, and that selection pre-fills but doesn't lock the owner field on new records.
2. Accounts CRUD works end-to-end with all PDF-specified fields, filters, search, and sort.
3. Contacts are nested under accounts, multiple per account.
4. Activity log entries update the parent account's next-action fields atomically.
5. Dashboard correctly surfaces Due Today / Overdue / Stale / Upcoming per the logic in Section 6, in Central time, with manual + auto refresh.
6. Email Templates page supports full CRUD across the specified categories.
7. Lost reason and competitor/current-tool tracking work on Closed Lost accounts.
8. Demo tracking is functional from the account detail page.
9. Duplicate detection (built per Section 9's actual sibling-repo research, not guessed) fires on manual entry and CSV import, warns without blocking.
10. CSV import supports real column mapping, preview, and duplicate flagging before commit.
11. Everything runs against the real Supabase project (not a placeholder), with `users` and `channel_types` manageable from an admin page without a code deploy.
