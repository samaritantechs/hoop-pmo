-- THE ONE PASTE: the whole HOOP database, from any starting state, in one transaction.

-- Order: repairs -> guarded reshape of the followup tables -> creations -> indexes.

create extension if not exists "pgcrypto";


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

-- HOOP's follow-up book is keyed on IMEI; a table that arrived in HOPE's shape (keyed
-- on ref) cannot take a single HOOP row. Guarded: refuses if any data would be lost.
do $$
declare n bigint := 0; has_imei boolean := false;
begin
  begin
    select count(*) into n from followup_status;
    select exists (select 1 from information_schema.columns
      where table_name = 'followup_status' and column_name = 'imei') into has_imei;
  exception when undefined_table then n := 0; has_imei := true;
  end;
  if not has_imei then
    if n > 0 then
      raise exception 'followup_status holds % rows -- stopping so nothing is lost.', n;
    end if;
    drop table if exists followup_comments;
    drop table if exists followup_status;
  end if;
end $$;

create table if not exists teams (
  team text primary key,
  team_code text,            
                             
                             
                             
  rsm text,                  
  rsm_no text,               
  updated_at timestamptz not null default now()
);

create table if not exists access_codes (
  code text primary key,
  name text not null,
  role text not null,
  teams text[],              
  tabs text[],
  created_at timestamptz not null default now()
);

create table if not exists roles (
  role text primary key,
  tabs text[]
);

create table if not exists settings (
  key text primary key,
  value text
);

create table if not exists hints (
  id uuid primary key default gen_random_uuid(),
  tab text,
  message text,
  sw_message text
);

create table if not exists watu_loans (
  imei text primary key,             
  client_name text,
  client_mobile text,                
                                     
                                     
                                     
                                     
                                     
  shop text,                         
  agent text,
  agent_id text,
  team text references teams(team),  
                                     
  model text,                        
  model_details text,                
  disbursed_date date,               
  price numeric(14,2),
  has_ever_paid boolean,
  days_offline integer,
  onboarding_min integer,            
  app_signed_up boolean,
  locked4 boolean,                   
  locked7 boolean,                   
  snapshot_date date,                
  upload_batch uuid,                 
                                     
  updated_at timestamptz not null default now()
);

create table if not exists watu_snapshots (
  id uuid primary key default gen_random_uuid(),
  imei text not null,
  client_name text,
  client_mobile text,
  shop text,
  agent text,
  agent_id text,
  team text,
  model text,
  model_details text,
  disbursed_date date,
  price numeric(14,2),
  has_ever_paid boolean,
  days_offline integer,
  onboarding_min integer,
  app_signed_up boolean,
  locked4 boolean,
  locked7 boolean,
  snapshot_date date not null,
  upload_batch uuid,
  created_at timestamptz not null default now()
);

create table if not exists followup_status (
  imei text primary key,
  team text references teams(team),
  client_name text,
  contact text,                      
  model text,
  price numeric(14,2),
  disbursed_date date,
  lifetime_day integer,              
                                     
                                     
                                     
  days_offline integer,
  locked4 boolean,
  locked7 boolean,
  has_ever_paid boolean,
  fu_status text,
  promise_date date,
  promise_amt numeric(14,2),
  last_comment text,
  comment_by text,
  comment_at timestamptz,
  deck_date date,                    
                                     
                                     
  updated_at timestamptz not null default now()
);

create table if not exists followup_comments (
  id uuid primary key default gen_random_uuid(),
  imei text not null references followup_status(imei) on delete cascade,
  team text,
  client_name text,
  comment text,
  fu_status text,
  promise_date date,
  promise_amt numeric(14,2),
  new_number text,                   
  created_by text,
  created_at timestamptz not null default now(),
  upload_date date,                  
  upload_batch uuid                  
                                     
);

create table if not exists call_users (
  user_id text primary key,
  name text,
  team text references teams(team),
  role text,
  is_leader boolean not null default false,
  leader_teams text[],
  device_id text,
  phone text unique,
  passcode_hash text,                
  passcode_salt text,                
  passcode_set_at timestamptz,
  created_by text,
  active boolean not null default true,
  registered_at timestamptz not null default now(),
  last_sync timestamptz,
  last_ts bigint
);

create table if not exists call_logs (
  id text primary key,               
  user_id text references call_users(user_id),
  officer text,
  team text,
  phone text,
  direction text check (direction in ('IN','OUT')),
  call_date date not null,
  call_time time,
  duration integer default 0,
  portfolio boolean default false,
  match_type text,
  ref text,                          
                                     
  customer text,
  synced_at timestamptz not null default now(),
  outcome text check (outcome in ('CONNECTED','MISSED','REJECTED','BLOCKED')),
  category text check (category in ('EXPECTED','DEFAULTER'))
                                     
                                     
                                     
                                     
);

create table if not exists announcement (
  id boolean primary key default true check (id),
  image_url text,
  text text,
  is_on boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_code text,
  actor_name text,
  actor_role text,
  action text not null,
  ref text,                          
  team text,
  subject text,
  ok boolean not null default true,
  error text,
  ms integer
);

create unique index if not exists idx_teams_code on teams(upper(btrim(team_code)))
  where team_code is not null and btrim(team_code) <> '';

create index if not exists idx_hints_tab on hints(tab);

create index if not exists idx_watu_loans_team on watu_loans(team);

create index if not exists idx_watu_loans_disb on watu_loans(disbursed_date);

create index if not exists idx_watu_loans_snap on watu_loans(snapshot_date);

create index if not exists idx_watu_snap_lookup on watu_snapshots(snapshot_date, imei);

create index if not exists idx_watu_snap_team on watu_snapshots(snapshot_date, team);

create index if not exists idx_watu_snap_batch on watu_snapshots(snapshot_date, upload_batch);

create index if not exists idx_fu_status_team on followup_status(team);

create index if not exists idx_fu_status_deck_date on followup_status(deck_date);

create index if not exists idx_fu_comments_imei on followup_comments(imei, created_at desc);

create index if not exists idx_call_users_active on call_users(device_id) where active;

create index if not exists idx_call_logs_date_team on call_logs(call_date, team);

create index if not exists idx_call_logs_user_date on call_logs(user_id, call_date);

insert into announcement (id) values (true) on conflict do nothing;

create index if not exists idx_audit_at on audit_log(at desc);

create index if not exists idx_audit_actor on audit_log(actor_code, at desc);

grant select, insert on table audit_log to anon, authenticated, service_role;
