-- Deleting an account that had been promoted from a donut run result hit the
-- default no-action FK on donut_run_results.promoted_account_id and failed.
-- Set null instead: the staging row survives and just loses its promotion link
-- (unpromote_donut_result already cleared the link by hand before deleting;
-- this covers the Accounts-page delete and any future path).
-- Run in the Supabase SQL editor (or supabase db push).

alter table donut_run_results
    drop constraint if exists donut_run_results_promoted_account_id_fkey;

alter table donut_run_results
    add constraint donut_run_results_promoted_account_id_fkey
    foreign key (promoted_account_id) references accounts(id) on delete set null;
