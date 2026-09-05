-- Kairos CRM schema. Run once in the dedicated CRM Supabase project's SQL editor.
-- No auth by design (internal trusted team) — leave RLS disabled on all tables.

create table users (
    id bigint generated always as identity primary key,
    name text not null,
    active boolean not null default true,
    -- E.164, e.g. +13125550100. Identity for the SendBlue text bot: inbound
    -- texts are matched against this and unknown numbers are ignored.
    phone text
);

create table channel_types (
    id bigint generated always as identity primary key,
    label text not null,
    active boolean not null default true
);

create table cadences (
    id bigint generated always as identity primary key,
    name text not null,
    description text,
    active boolean not null default true
);

-- Donut Scraper runs (pipeline/ + views/donut_scraper.py). Scraped clinics
-- stage in donut_run_results until promoted into accounts. Defined before
-- accounts so accounts.donut_run_id can reference it.
create table donut_runs (
    id bigint generated always as identity primary key,
    run_name text not null,
    area_name text,
    polygon_geojson jsonb,
    buffer_miles numeric(4,2),
    total_clinics int not null default 0,
    new_clinics int not null default 0,
    reused_clinics int not null default 0,
    status text not null default 'pending',  -- pending | confirmed | archived
    created_by bigint references users(id),
    created_at timestamptz not null default now()
);

create table accounts (
    id bigint generated always as identity primary key,
    practice_name text not null,
    practice_email text,
    practice_phone text,
    website text,
    city text,
    state text,
    kairos_owner_id bigint references users(id),
    channel_type_id bigint references channel_types(id),
    source_detail text,
    initial_encounter_summary text,
    pipeline_stage text not null default 'New Lead',
    next_action text,
    next_action_due_date date,
    created_at timestamptz not null default now(),
    lost_reason text,
    competitor_tool text,
    pms text,
    best_contact text,
    best_contact_email text,
    best_contact_phone text,
    decision_maker text,
    decision_maker_email text,
    decision_maker_phone text,
    decision_maker_reached text not null default 'Unknown',
    cadence_id bigint references cadences(id),
    cadence_step_order int,
    cadence_paused boolean not null default false,
    creation_source text not null default 'manual',  -- CREATION_SOURCES in utils/constants.py
    creation_reason text,
    creation_user_id bigint references users(id),
    donut_run_id bigint references donut_runs(id)
);

create table contacts (
    id bigint generated always as identity primary key,
    account_id bigint not null references accounts(id) on delete cascade,
    name text not null,
    role text,
    email text,
    phone text
);

-- is_system marks auto-generated change records (details edited, contact
-- added, demo updated, ...) so the UI can de-emphasize them and derived state
-- (current state, last action, staleness) can ignore them.
create table activities (
    id bigint generated always as identity primary key,
    account_id bigint not null references accounts(id) on delete cascade,
    date date not null,
    kairos_owner_id bigint references users(id),
    activity_type text not null,
    summary text,
    next_action text,
    next_action_due_date date,
    is_system boolean not null default false,
    created_at timestamptz not null default now()
);

create table demos (
    id bigint generated always as identity primary key,
    account_id bigint not null references accounts(id) on delete cascade,
    demo_date date,
    attendees text,
    status text not null default 'Scheduled',
    pain_points text,
    objections text,
    follow_up_required text,
    created_at timestamptz not null default now()
);

-- promoted_account_id is set null on account delete so deleting a promoted
-- account unlinks the staging row instead of failing.
create table donut_run_results (
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
    call_status text not null default 'Not Called',  -- DONUT_CALL_STATUSES in utils/constants.py
    call_notes text,
    promoted_account_id bigint references accounts(id) on delete set null,
    promoted_by bigint references users(id),
    promoted_at timestamptz,
    updated_by bigint references users(id),
    updated_at timestamptz,
    created_at timestamptz not null default now()
);

create index donut_run_results_run_idx on donut_run_results (donut_run_id);

-- Pre-CRM calling activity log for staged clinics.
create table donut_result_activities (
    id bigint generated always as identity primary key,
    donut_run_result_id bigint not null references donut_run_results(id) on delete cascade,
    user_id bigint references users(id),
    activity_type text not null default 'Note',  -- 'Scraped', 'Call Update', 'Note', 'Status Change'
    summary text not null,
    notes text,
    created_at timestamptz not null default now()
);

create index donut_result_activities_result_idx on donut_result_activities (donut_run_result_id);

create table email_templates (
    id bigint generated always as identity primary key,
    name text not null,
    category text not null,
    situation text,
    subject text,
    body text,
    notes text
);

-- day_gap_min/max are calendar days after the previous step (step 1: after
-- enrollment). min is the scheduling default; max is shown as guidance.
create table cadence_steps (
    id bigint generated always as identity primary key,
    cadence_id bigint not null references cadences(id) on delete cascade,
    step_order int not null,
    channel text not null,
    day_gap_min int not null default 0,
    day_gap_max int,
    note text,
    email_template_id bigint references email_templates(id) on delete set null
);

-- Named, resumable chat threads. Phone/iMessage traffic always lands in the
-- user's single default "Texts" session; the dashboard can spin up more.
create table chat_sessions (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,
    title text,
    is_default boolean not null default false,
    created_at timestamptz not null default now(),
    last_message_at timestamptz not null default now()
);

create index chat_sessions_user_idx on chat_sessions (user_id, last_message_at desc);
create unique index chat_sessions_one_default on chat_sessions (user_id) where is_default;

-- Rolling conversation history for the SendBlue text bot (supabase/functions/
-- sendblue-bot). Only user text and final bot replies are stored, not tool calls.
create table bot_messages (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,
    session_id bigint references chat_sessions(id) on delete cascade,
    role text not null check (role in ('user', 'model')),
    content text not null,
    created_at timestamptz not null default now()
);

create index bot_messages_user_idx on bot_messages (user_id, created_at desc);
create index bot_messages_session_idx on bot_messages (session_id, id);

-- Staged bot edits awaiting the user's yes-by-text. The edge function, not the
-- model, decides when these execute (code-enforced confirmation gate). Keyed per
-- session so a "yes" in one chat can't confirm a write staged in another.
create table bot_pending_writes (
    user_id bigint not null references users(id) on delete cascade,
    session_id bigint not null references chat_sessions(id) on delete cascade,
    calls jsonb not null,
    created_at timestamptz not null default now(),
    primary key (user_id, session_id)
);

create index cadence_steps_cadence_idx on cadence_steps (cadence_id, step_order);
create index accounts_stage_idx on accounts (pipeline_stage);
create index accounts_due_idx on accounts (next_action_due_date);
create index activities_account_idx on activities (account_id, date desc);
create index contacts_account_idx on contacts (account_id);
create index demos_account_idx on demos (account_id);

-- The account-level next_action fields hold "the current single next action";
-- the activity log is the history of how it evolved. Syncing in a trigger makes
-- the update atomic with the activity insert.
create function sync_account_next_action() returns trigger
language plpgsql as $$
begin
    if not new.is_system then
        update accounts
        set next_action = new.next_action,
            next_action_due_date = new.next_action_due_date
        where id = new.account_id;
    end if;
    return new;
end;
$$;


create trigger activities_sync_next_action
after insert on activities
for each row execute function sync_account_next_action();

-- last_action_date and "current state" are derived, never stored (spec 5.1).
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

insert into users (name) values ('Tanush'), ('Aditya'), ('Sanjana'), ('Adhira'), ('Yajat');

insert into channel_types (label) values
    ('Donut Visit'),
    ('Cold Visit'),
    ('Apollo Cold Outreach'),
    ('Conference'),
    ('Referral'),
    ('Other');

insert into cadences (name, description) values
    ('New Lead Outreach', 'Standard 6-touch sequence over ~2 weeks for brand new leads.'),
    ('Post-Demo Follow-up', '5-touch sequence to drive a decision after a completed demo.'),
    ('No Response Revival', '3-touch sequence to re-engage a lead that went quiet.');

insert into cadence_steps (cadence_id, step_order, channel, day_gap_min, day_gap_max, note) values
    ((select id from cadences where name = 'New Lead Outreach'), 1, 'Phone call', 0, 0, 'Intro call - ask for the office manager'),
    ((select id from cadences where name = 'New Lead Outreach'), 2, 'Email', 2, 3, 'Follow-up email referencing the call'),
    ((select id from cadences where name = 'New Lead Outreach'), 3, 'Phone call', 2, 3, 'Second call - try a different time of day'),
    ((select id from cadences where name = 'New Lead Outreach'), 4, 'Email', 3, 4, 'Value email - case study or one-pager'),
    ((select id from cadences where name = 'New Lead Outreach'), 5, 'Phone call', 3, 4, 'Call, leave a voicemail if no answer'),
    ((select id from cadences where name = 'New Lead Outreach'), 6, 'Email', 3, 4, 'Breakup email - close the loop, door stays open'),
    ((select id from cadences where name = 'Post-Demo Follow-up'), 1, 'Email', 0, 0, 'Recap email with pricing and next steps'),
    ((select id from cadences where name = 'Post-Demo Follow-up'), 2, 'Phone call', 2, 3, 'Check-in call - surface objections'),
    ((select id from cadences where name = 'Post-Demo Follow-up'), 3, 'Email', 3, 4, 'Address objections, share proof points'),
    ((select id from cadences where name = 'Post-Demo Follow-up'), 4, 'Phone call', 3, 4, 'Decision call - ask for a yes or no'),
    ((select id from cadences where name = 'Post-Demo Follow-up'), 5, 'Email', 4, 5, 'Final decision email with a deadline'),
    ((select id from cadences where name = 'No Response Revival'), 1, 'Email', 0, 0, 'Re-engagement email - new angle or recent news'),
    ((select id from cadences where name = 'No Response Revival'), 2, 'Phone call', 3, 4, 'Call - reference the email'),
    ((select id from cadences where name = 'No Response Revival'), 3, 'Email', 4, 5, 'Last attempt before Nurture Later');
