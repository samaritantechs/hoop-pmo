-- =====================================================================================
-- HOOPLOAN -- PostgreSQL schema v1 (Supabase)
-- =====================================================================================
-- Hoop Ltd is a phone dealership agent for Watu Credit: phones sold on daily-installment
-- lock contracts. Watu sends a daily follow-up list; Hoop's credit team owns each
-- customer for 45 days from disbursement. This schema is the Hoop translation of
-- hope-pmo-v2's proven shape -- same patterns, different book:
--
--   HOPE                       HOOP
--   defaulter deck upload  ->  watu daily list upload (watu_snapshots)
--   followup_status (ref)  ->  followup_status (IMEI -- the natural key)
--   team                   ->  RSM region / shop
--   count 1-6 window       ->  45-day lifetime window from disbursed_date
--   defaulter status       ->  days offline / locked 4+ / locked 7+
--
-- IMEI is TEXT everywhere, end to end. It is a 15-digit identifier, not a number:
-- Excel destroys it as a number (precision loss past 15 significant digits), exactly
-- like the phone columns in Hope. The same applies on every future export.
--
-- Run this once against the fresh Supabase project: Dashboard -> SQL Editor -> paste
-- this whole file -> Run. It is idempotent (safe to re-run) via IF NOT EXISTS.
-- =====================================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- =====================================================================================
-- ADAPTATION MAP -- where copied hope-pmo-v2 code meets THIS schema.
--
-- Verbatim-compatible, no edits needed: access_codes, roles, settings, hints,
-- call_users, call_logs, announcement, audit_log -- including the whole team-code
-- sign-in flow (register() matches teams.team_code, writes call_users, checks active).
--
-- Rename surface -- one-line edits where copied code names Hope columns:
--   followup_status:   ref -> imei,  full_name -> client_name,  disb_date -> disbursed_date
--   followup_comments: ref -> imei,  full_name -> client_name
--   PAGE_KEY map (api/_lib/supabase.js): followup_status pages order by 'ref' -> 'imei'
--   upsertTables (api/upload.js): followup_status conflict key 'ref' -> 'imei'
--
-- Not carried over (Hope-only): status, ds, dc, days_elapsed, arrears, rejesho and the
-- guarantor_* columns -- the Watu feed carries none of them (starter section 5 lists the
-- known gaps; don't invent columns). Hoop shows days_offline / locked4 / locked7 /
-- lifetime_day instead. teams: Hope's per-function contact columns (opm, gmo, manager,
-- bike, credit, recovery, expected, collection) become rsm / rsm_no here -- copied
-- selects like `select('team, gmo, manager, bike')` must shrink to what exists.
-- =====================================================================================

-- =====================================================================================
-- REFERENCE / CONFIG
-- =====================================================================================

-- A team is an RSM region / shop ("Kinondoni"). Same scoping mechanism as Hope: the
-- team column on every data table is what the database filters by, so scoping lives
-- here and not in the page.
create table if not exists teams (
  team text primary key,
  team_code text,            -- the everyday sign-in for credit-team callers. CLEAR TEXT
                             -- on purpose, same rationale as Hope: a code must be
                             -- readable out over the phone and rotatable the moment it
                             -- leaks. Rotating releases every handset on the team.
  rsm text,                  -- Regional Sales Manager name
  rsm_no text,               -- their phone, TEXT (leading zeros, +255)
  updated_at timestamptz not null default now()
);
-- Two teams sharing a code would silently put callers on the wrong book.
create unique index if not exists idx_teams_code on teams(upper(btrim(team_code)))
  where team_code is not null and btrim(team_code) <> '';

create table if not exists access_codes (
  code text primary key,
  name text not null,
  role text not null,
  teams text[],              -- null/empty = ALL teams
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

-- Rotating tips shown in the apps. A tip is not identified by its tab (many tips per
-- tab, the reader cycles through them) -- Hope learned this the hard way; start with
-- the corrected shape.
create table if not exists hints (
  id uuid primary key default gen_random_uuid(),
  tab text,
  message text,
  sw_message text
);
create index if not exists idx_hints_tab on hints(tab);

-- =====================================================================================
-- THE WATU REGISTER -- one row per phone, keyed on IMEI.
-- Current state of every phone Hoop has ever seen on a Watu list. The daily upload
-- upserts here (latest state wins) and appends to watu_snapshots (history).
-- =====================================================================================

create table if not exists watu_loans (
  imei text primary key,             -- 15 digits, TEXT end to end
  client_name text,
  client_mobile text,                -- 2557..., the number the credit team rings.
                                     -- ALSO the customer's payment reference: when a
                                     -- customer pays, their payment/ref no IS this
                                     -- phone number -- so payment matching joins on
                                     -- the normalized phone (Hope's normPhone: last 9
                                     -- digits), never on IMEI
  shop text,                         -- "Hoop Limited, Kinondoni" as Watu writes it
  agent text,
  agent_id text,
  team text references teams(team),  -- derived from shop/agent at import; the importer
                                     -- upserts unknown teams first, same as Hope's does
  model text,                        -- A05 / A06 / A07
  model_details text,                -- "A07 (SM-A075F/DS) 64GB/4GB"
  disbursed_date date,               -- the 45-day window is computed from this
  price numeric(14,2),
  has_ever_paid boolean,
  days_offline integer,
  onboarding_min integer,            -- "Onboarding Time (Min)"
  app_signed_up boolean,
  locked4 boolean,                   -- "Locked 4+ Days"
  locked7 boolean,                   -- "Locked 7+ Days"
  snapshot_date date,                -- the day this state was last confirmed by an upload
  upload_batch uuid,                 -- one uuid per upload, same scheme as Hope: a
                                     -- same-date re-upload supersedes instead of doubling
  updated_at timestamptz not null default now()
);
create index if not exists idx_watu_loans_team on watu_loans(team);
create index if not exists idx_watu_loans_disb on watu_loans(disbursed_date);
create index if not exists idx_watu_loans_snap on watu_loans(snapshot_date);

-- Append-only daily history -- Hope's snapshot pattern. One row per phone per upload.
-- Recovery reads consecutive days from here: who paid after our call window
-- (has_ever_paid flips, days_offline drops between uploads).
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
create index if not exists idx_watu_snap_lookup on watu_snapshots(snapshot_date, imei);
create index if not exists idx_watu_snap_team on watu_snapshots(snapshot_date, team);
create index if not exists idx_watu_snap_batch on watu_snapshots(snapshot_date, upload_batch);

-- =====================================================================================
-- FOLLOWUP -- the working register the phones read (Hope's followup_status, keyed on
-- IMEI), plus the append-only comment history behind it.
-- =====================================================================================

create table if not exists followup_status (
  imei text primary key,
  team text references teams(team),
  client_name text,
  contact text,                      -- normalized client_mobile
  model text,
  price numeric(14,2),
  disbursed_date date,
  lifetime_day integer,              -- day N of the 45-day window, stamped at upload.
                                     -- Exact formula (calendar days? inclusive?) is an
                                     -- open question for Hoop (starter section 7 item 10);
                                     -- until answered: (upload date - disbursed_date) + 1.
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
  deck_date date,                    -- snapshot_date of the upload that last confirmed
                                     -- this customer; how a row nobody re-confirms gets
                                     -- retired (Hope's deck-date mechanism, from day one)
  updated_at timestamptz not null default now()
);
create index if not exists idx_fu_status_team on followup_status(team);
create index if not exists idx_fu_status_deck_date on followup_status(deck_date);

create table if not exists followup_comments (
  id uuid primary key default gen_random_uuid(),
  imei text not null references followup_status(imei) on delete cascade,
  team text,
  client_name text,
  comment text,
  fu_status text,
  promise_date date,
  promise_amt numeric(14,2),
  new_number text,                   -- an officer discovering a better number records it
  created_by text,
  created_at timestamptz not null default now(),
  upload_date date,                  -- Hope's upload-stamp pair: rows typed in the app
  upload_batch uuid                  -- carry NULL upload_batch and so survive a Replace
                                     -- upload by construction (uploadedOnly protection)
);
create index if not exists idx_fu_comments_imei on followup_comments(imei, created_at desc);

-- =====================================================================================
-- HOOP CALLS -- copied from Hope's call tables nearly verbatim, including the
-- officer-account columns (admin-created accounts, scrypt passcodes, active switch)
-- so self-registration is closed from day one instead of being retrofitted.
-- =====================================================================================

create table if not exists call_users (
  user_id text primary key,
  name text,
  team text references teams(team),
  role text,
  is_leader boolean not null default false,
  leader_teams text[],
  device_id text,
  phone text unique,
  passcode_hash text,                -- scrypt, per-row salt; the admin sees a passcode
  passcode_salt text,                -- once at generation and can only replace it
  passcode_set_at timestamptz,
  created_by text,
  active boolean not null default true,
  registered_at timestamptz not null default now(),
  last_sync timestamptz,
  last_ts bigint
);
-- Revocation has to be answerable in one indexed lookup on every request.
create index if not exists idx_call_users_active on call_users(device_id) where active;

create table if not exists call_logs (
  id text primary key,               -- deterministic hash id: dedup by construction
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
  ref text,                          -- the IMEI of the matched customer (kept as `ref`
                                     -- so Hope's copied call code works unchanged)
  customer text,
  synced_at timestamptz not null default now(),
  outcome text check (outcome in ('CONNECTED','MISSED','REJECTED','BLOCKED')),
  category text check (category in ('EXPECTED','DEFAULTER'))
                                     -- Hope's vocabulary, kept verbatim so copied code
                                     -- writes cleanly; widen the check when the call
                                     -- app grows Hoop-specific categories (ALTER is
                                     -- additive, a failed INSERT is data loss)
);
create index if not exists idx_call_logs_date_team on call_logs(call_date, team);
create index if not exists idx_call_logs_user_date on call_logs(user_id, call_date);

-- =====================================================================================
-- ANNOUNCEMENTS (image and/or text takeover) -- singleton row, same as Hope.
-- =====================================================================================

create table if not exists announcement (
  id boolean primary key default true check (id),
  image_url text,
  text text,
  is_on boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into announcement (id) values (true) on conflict do nothing;

-- =====================================================================================
-- WHO DID WHAT -- Hope's audit log, verbatim. Records the ACT, never the payload:
-- who, what they called, which customer/team/setting, and whether it worked. Reads
-- are not logged. A failed attempt is worth MORE than a successful one.
-- =====================================================================================

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_code text,
  actor_name text,
  actor_role text,
  action text not null,
  ref text,                          -- here: usually an IMEI
  team text,
  subject text,
  ok boolean not null default true,
  error text,
  ms integer
);
create index if not exists idx_audit_at on audit_log(at desc);
create index if not exists idx_audit_actor on audit_log(actor_code, at desc);

grant select, insert on table audit_log to anon, authenticated, service_role;

-- =====================================================================================
-- Row Level Security -- OFF by default, same trust model as Hope: the service-role key
-- lives server-side only and the API layer enforces access-code permissions and team
-- scoping. See hope-pmo-v2 ARCHITECTURE.md "Auth" for the two supported paths.
-- =====================================================================================

-- =====================================================================================
-- PHASE 2 -- designed now, built later. NOT part of tonight's build (starter section 3).
--
--   payments             -- when a payment feed arrives: the customer's payment/ref no
--                           IS their phone number, so rows join to the register via
--                           normalized client_mobile, not IMEI
--   hoop_sales           -- Hoop's own same-day sale record (from hoopltd.shop)
--   watu_sales_report    -- Watu's next-morning report, uploaded like the daily list
--   sales_audit          -- view: hoop_sales LEFT JOIN watu_sales_report ON imei
--                           -> MATCHED (pay commission) / HOOP-ONLY (fraud flag)
--                              / WATU-ONLY (unrecorded sale)
--   commission_rules     -- role, per_sale, bonus (agent 75k? RSM 30k +5? -- awaiting
--                           the rules in writing, starter section 7 item 4)
--   commission_runs      -- who was paid what, when, against which audit
--
-- PHASE 3:
--   products             -- product master (model, specs, price history over time)
--   stock_moves          -- holder -> holder transfers preserving TRUE age (transfers
--                           must NOT renew age -- the flaw Hoop wants fixed)
--   stock_requests       -- agent -> RSM -> storekeeper request chain
-- =====================================================================================
