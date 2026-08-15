-- =====================================================================================
-- REPAIR: reconcile ANY partial or draft-made table to schema v1.
--
-- The starter pack carried a draft schema (section 4) beside the real db/schema.sql,
-- and on setup night the draft got pasted first. CREATE TABLE IF NOT EXISTS then skips
-- the half-made tables forever -- so every column the code touches is added here,
-- one ADD COLUMN IF NOT EXISTS at a time. Nothing is dropped, nothing is overwritten,
-- and a database already on v1 sails through untouched.
--
-- RUN db/schema.sql FIRST (it creates whatever tables are missing outright),
-- THEN this file. Both are idempotent -- safe to re-run any number of times.
-- =====================================================================================

alter table if exists teams add column if not exists team_code text;
alter table if exists teams add column if not exists rsm text;
alter table if exists teams add column if not exists rsm_no text;
alter table if exists teams add column if not exists updated_at timestamptz not null default now();

alter table if exists followup_status add column if not exists team text;
alter table if exists followup_status add column if not exists client_name text;
alter table if exists followup_status add column if not exists contact text;
alter table if exists followup_status add column if not exists model text;
alter table if exists followup_status add column if not exists price numeric(14,2);
alter table if exists followup_status add column if not exists disbursed_date date;
alter table if exists followup_status add column if not exists lifetime_day integer;
alter table if exists followup_status add column if not exists days_offline integer;
alter table if exists followup_status add column if not exists locked4 boolean;
alter table if exists followup_status add column if not exists locked7 boolean;
alter table if exists followup_status add column if not exists has_ever_paid boolean;
alter table if exists followup_status add column if not exists fu_status text;
alter table if exists followup_status add column if not exists promise_date date;
alter table if exists followup_status add column if not exists promise_amt numeric(14,2);
alter table if exists followup_status add column if not exists last_comment text;
alter table if exists followup_status add column if not exists comment_by text;
alter table if exists followup_status add column if not exists comment_at timestamptz;
alter table if exists followup_status add column if not exists deck_date date;
alter table if exists followup_status add column if not exists updated_at timestamptz not null default now();

alter table if exists watu_loans add column if not exists client_name text;
alter table if exists watu_loans add column if not exists client_mobile text;
alter table if exists watu_loans add column if not exists shop text;
alter table if exists watu_loans add column if not exists agent text;
alter table if exists watu_loans add column if not exists agent_id text;
alter table if exists watu_loans add column if not exists team text;
alter table if exists watu_loans add column if not exists model text;
alter table if exists watu_loans add column if not exists model_details text;
alter table if exists watu_loans add column if not exists disbursed_date date;
alter table if exists watu_loans add column if not exists price numeric(14,2);
alter table if exists watu_loans add column if not exists has_ever_paid boolean;
alter table if exists watu_loans add column if not exists days_offline integer;
alter table if exists watu_loans add column if not exists onboarding_min integer;
alter table if exists watu_loans add column if not exists app_signed_up boolean;
alter table if exists watu_loans add column if not exists locked4 boolean;
alter table if exists watu_loans add column if not exists locked7 boolean;
alter table if exists watu_loans add column if not exists snapshot_date date;
alter table if exists watu_loans add column if not exists upload_batch uuid;
alter table if exists watu_loans add column if not exists updated_at timestamptz not null default now();

alter table if exists watu_snapshots add column if not exists imei text;
alter table if exists watu_snapshots add column if not exists client_name text;
alter table if exists watu_snapshots add column if not exists client_mobile text;
alter table if exists watu_snapshots add column if not exists shop text;
alter table if exists watu_snapshots add column if not exists agent text;
alter table if exists watu_snapshots add column if not exists agent_id text;
alter table if exists watu_snapshots add column if not exists team text;
alter table if exists watu_snapshots add column if not exists model text;
alter table if exists watu_snapshots add column if not exists model_details text;
alter table if exists watu_snapshots add column if not exists disbursed_date date;
alter table if exists watu_snapshots add column if not exists price numeric(14,2);
alter table if exists watu_snapshots add column if not exists has_ever_paid boolean;
alter table if exists watu_snapshots add column if not exists days_offline integer;
alter table if exists watu_snapshots add column if not exists onboarding_min integer;
alter table if exists watu_snapshots add column if not exists app_signed_up boolean;
alter table if exists watu_snapshots add column if not exists locked4 boolean;
alter table if exists watu_snapshots add column if not exists locked7 boolean;
alter table if exists watu_snapshots add column if not exists snapshot_date date;
alter table if exists watu_snapshots add column if not exists upload_batch uuid;
alter table if exists watu_snapshots add column if not exists created_at timestamptz not null default now();

alter table if exists followup_comments add column if not exists team text;
alter table if exists followup_comments add column if not exists client_name text;
alter table if exists followup_comments add column if not exists comment text;
alter table if exists followup_comments add column if not exists fu_status text;
alter table if exists followup_comments add column if not exists promise_date date;
alter table if exists followup_comments add column if not exists promise_amt numeric(14,2);
alter table if exists followup_comments add column if not exists new_number text;
alter table if exists followup_comments add column if not exists created_by text;
alter table if exists followup_comments add column if not exists created_at timestamptz not null default now();
alter table if exists followup_comments add column if not exists upload_date date;
alter table if exists followup_comments add column if not exists upload_batch uuid;

alter table if exists call_users add column if not exists passcode_hash text;
alter table if exists call_users add column if not exists passcode_salt text;
alter table if exists call_users add column if not exists passcode_set_at timestamptz;
alter table if exists call_users add column if not exists created_by text;
alter table if exists call_users add column if not exists active boolean not null default true;

-- The indexes the reads lean on (no-ops when already there).
create index if not exists idx_fu_status_team on followup_status(team);
create index if not exists idx_fu_status_deck_date on followup_status(deck_date);
create index if not exists idx_watu_snap_lookup on watu_snapshots(snapshot_date, imei);
create index if not exists idx_watu_snap_team on watu_snapshots(snapshot_date, team);
create index if not exists idx_call_logs_date_team on call_logs(call_date, team);
create index if not exists idx_call_logs_user_date on call_logs(user_id, call_date);
create index if not exists idx_fu_comments_imei on followup_comments(imei, created_at desc);
create unique index if not exists idx_teams_code on teams(upper(btrim(team_code)))
  where team_code is not null and btrim(team_code) <> '';

-- DID IT LAND? This should return one row with every column named:
-- select deck_date, locked4, has_ever_paid, last_comment from followup_status limit 1;
