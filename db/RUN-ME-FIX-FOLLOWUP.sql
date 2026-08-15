-- =====================================================================================
-- The two follow-up tables arrived in HOPE's shape (keyed on ref). HOOP's book is keyed
-- on IMEI, and a table whose PRIMARY KEY the code never writes cannot take a single row.
-- Guarded reshape: REFUSES to touch a table that already holds data.
-- =====================================================================================
do $$
declare n bigint := 0;
begin
  begin
    select count(*) into n from followup_status;
  exception when undefined_table then n := 0;
  end;
  if n > 0 then
    raise exception 'followup_status holds % rows -- stopping so nothing is lost.', n;
  end if;
  drop table if exists followup_comments;
  drop table if exists followup_status;
end $$;

create table followup_status (
  imei text primary key, team text, client_name text, contact text, model text,
  price numeric(14,2), disbursed_date date, lifetime_day integer,
  days_offline integer, locked4 boolean, locked7 boolean, has_ever_paid boolean,
  fu_status text, promise_date date, promise_amt numeric(14,2), last_comment text,
  comment_by text, comment_at timestamptz, deck_date date,
  updated_at timestamptz not null default now()
);
create index idx_fu_status_team on followup_status(team);
create index idx_fu_status_deck_date on followup_status(deck_date);

create table followup_comments (
  id uuid primary key default gen_random_uuid(),
  imei text not null references followup_status(imei) on delete cascade,
  team text, client_name text, comment text, fu_status text,
  promise_date date, promise_amt numeric(14,2), new_number text, created_by text,
  created_at timestamptz not null default now(), upload_date date, upload_batch uuid
);
create index idx_fu_comments_imei on followup_comments(imei, created_at desc);

-- The tail of FIX-ALL that never ran because it stopped at the followup index:
create index if not exists idx_call_users_active on call_users(device_id) where active;
create index if not exists idx_call_logs_date_team on call_logs(call_date, team);
create index if not exists idx_call_logs_user_date on call_logs(user_id, call_date);
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(), at timestamptz not null default now(),
  actor_code text, actor_name text, actor_role text, action text not null,
  ref text, team text, subject text, ok boolean not null default true, error text, ms integer
);
create index if not exists idx_audit_at on audit_log(at desc);
create index if not exists idx_audit_actor on audit_log(actor_code, at desc);
grant select, insert on table audit_log to anon, authenticated, service_role;
