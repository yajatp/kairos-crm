-- Migration: Donut Scraper Integration + Account Creation Context
-- Run this in the Kairos CRM Supabase project SQL editor.
-- Databases that ran an earlier version of this file also need
-- supabase/migrations/20260805_promoted_account_fk_set_null.sql.

-- ─── 1. Account creation context columns ────────────────────────────────────
alter table accounts
    add column if not exists creation_source text not null default 'manual',
    add column if not exists creation_reason text,
    add column if not exists creation_user_id bigint references users(id);

-- ─── 2. Donut runs table ────────────────────────────────────────────────────
create table if not exists donut_runs (
    id bigint generated always as identity primary key,
    run_name text not null,
    area_name text,
    polygon_geojson jsonb,
    buffer_miles numeric(4,2),
    total_clinics int not null default 0,
    new_clinics int not null default 0,
    reused_clinics int not null default 0,
    status text not null default 'pending',  -- pending | confirmed | archived
    map_notes text,
    created_by bigint references users(id),
    created_at timestamptz not null default now()
);

-- ─── 3. Donut run results (staging table for scraped clinics) ───────────────
-- promoted_account_id is set null on account delete so deleting a promoted
-- account from the Accounts page unlinks the staging row instead of failing.
create table if not exists donut_run_results (
    id bigint generated always as identity primary key,
    donut_run_id bigint not null references donut_runs(id) on delete cascade,
    place_id text,
    clinic_name text not null,
    classification text,
    address text,
    lat numeric(10,7),
    lng numeric(10,7),
    inclusion_zone text,          -- 'core' | 'buffer'
    phone text,
    website text,
    email text,
    email_source text,
    head_dentist text,
    staff_source text,
    hours_json jsonb,
    notes text,
    call_status text not null default 'Not Called',
    call_notes text,
    promoted_account_id bigint references accounts(id) on delete set null,
    promoted_by bigint references users(id),
    promoted_at timestamptz,
    updated_by bigint references users(id),
    updated_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists donut_run_results_run_idx
    on donut_run_results (donut_run_id);

-- ─── 4. Add donut_run_id FK on accounts ─────────────────────────────────────
alter table accounts
    add column if not exists donut_run_id bigint references donut_runs(id);

-- ─── 5. Recreate account_overview to pick up the new accounts columns ───────
-- (a.* is frozen at view creation time)
drop view if exists account_overview;

create view account_overview as
select
    a.*,
    coalesce(la.last_date, a.created_at::date) as last_action_date,
    la.last_summary as latest_activity_summary,
    la.last_type as latest_activity_type
from accounts a
left join lateral (
    select date as last_date, summary as last_summary, activity_type as last_type
    from activities
    where account_id = a.id and not is_system
    order by date desc, id desc
    limit 1
) la on true;

-- ─── 6. Donut result activities (pre-CRM calling activity log) ──────────────
create table if not exists donut_result_activities (
    id bigint generated always as identity primary key,
    donut_run_result_id bigint not null references donut_run_results(id) on delete cascade,
    user_id bigint references users(id),
    activity_type text not null default 'Note',  -- 'Scraped', 'Call Update', 'Note', 'Status Change'
    summary text not null,
    notes text,
    created_at timestamptz not null default now()
);

create index if not exists donut_result_activities_result_idx
    on donut_result_activities (donut_run_result_id);

-- ─── 8. Add map_notes to donut_runs ─────────────────────────────────────────
alter table donut_runs
    add column if not exists map_notes text;
