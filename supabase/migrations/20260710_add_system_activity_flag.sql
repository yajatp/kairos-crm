-- Audit-log support: auto-generated change records (details edited, contact
-- added, demo updated, ...) live in activities flagged is_system so the UI can
-- de-emphasize them. Derived state (current state, last action, staleness)
-- ignores them - editing a text box is not a sales touch.
-- Run in the Supabase SQL editor (or supabase db push).

alter table activities add column is_system boolean not null default false;

drop view account_overview;
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
