-- Cadences + richer account contact fields, for a database that already ran
-- schema.sql. Fresh installs get all of this from schema.sql itself.
-- Run in the Supabase SQL editor (or supabase db push).

create table cadences (
    id bigint generated always as identity primary key,
    name text not null,
    description text,
    active boolean not null default true
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

create index cadence_steps_cadence_idx on cadence_steps (cadence_id, step_order);

alter table accounts
    add column state text,
    add column best_contact_email text,
    add column best_contact_phone text,
    add column decision_maker_email text,
    add column decision_maker_phone text,
    add column cadence_id bigint references cadences(id),
    add column cadence_step_order int,
    add column cadence_paused boolean not null default false;

-- account_overview selects a.*, which Postgres freezes at view creation time,
-- so it must be recreated for the new columns to appear.
drop view account_overview;
create view account_overview as
select
    a.*,
    coalesce(la.last_date, a.created_at::date) as last_action_date,
    la.last_summary as latest_activity_summary
from accounts a
left join lateral (
    select date as last_date, summary as last_summary
    from activities
    where account_id = a.id
    order by date desc, id desc
    limit 1
) la on true;

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
