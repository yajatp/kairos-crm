-- Text bot migration for a database that already ran schema.sql before
-- 2026-07-07. Fresh installs get all of this from schema.sql itself.
-- Run in the Supabase SQL editor (or supabase db push).

alter table users add column phone text;

create table bot_messages (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,
    role text not null check (role in ('user', 'model')),
    content text not null,
    created_at timestamptz not null default now()
);

create index bot_messages_user_idx on bot_messages (user_id, created_at desc);

create table bot_pending_writes (
    user_id bigint primary key references users(id) on delete cascade,
    calls jsonb not null,
    created_at timestamptz not null default now()
);

-- Yajat is not in the seeded users; the bot needs a users row per texter.
insert into users (name)
select 'Yajat'
where not exists (select 1 from users where name = 'Yajat');

-- The bot identifies who is texting by this number; anyone not listed is
-- ignored. Fill in each person's real cell in E.164 before running.
-- update users set phone = '+1XXXXXXXXXX' where name = 'Tanush';
-- update users set phone = '+1XXXXXXXXXX' where name = 'Aditya';
-- update users set phone = '+1XXXXXXXXXX' where name = 'Sanjana';
-- update users set phone = '+1XXXXXXXXXX' where name = 'Adhira';
-- update users set phone = '+1XXXXXXXXXX' where name = 'Yajat';
