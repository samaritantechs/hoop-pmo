-- =============================================================================================
-- IMPREST AND LEAVE: two requests, two approvals, one review copy.
-- =============================================================================================
--   "they need to make imprest requests that will be approved by their admnistrator and a copy
--    stays for the gm review: since am using tabs as roles so request tab, approval tab and
--    imprest reports tab. No accountants intergration yet."
--   "we have requests logs (pending approvals, rejected and approved), retirement log [when
--    someone gets where he was destinated for their tasks they fill retirement with 3 pictures
--    (optimize for storage as business operator does) to keep reference of actual incurred
--    costs] and widget dashboards for that."
--   "when someone is requesting they choose role so at approver widget there have to be role
--    setiings where adminstrator can add roles and their accomodation per day"
--   "also they want to be asking for leaves in app (another nav), and hr approves or rejects
--    there (another one)"
--
-- Five panes, four tables. Same shape as staff_advances and for the same reasons: the
-- requester is STAMPED from the access code at the moment of asking, never joined -- a money
-- record must not rewrite itself when the register changes -- and status is the state, with
-- the decision's own columns beside it rather than in a second table a report would have to
-- join to find.
--
-- WHAT IS DIFFERENT FROM ADVANCES, and why.
-- ---------------------------------------------------------------------------------------------
-- An advance is one number. An imprest is a COSTED TRIP: a fare (trips x cost per trip), nights
-- away (days x a rate that depends on WHO is travelling), and up to three other lines. The
-- amounts are kept as the parts they were built from, not just the total, because the
-- retirement afterwards is compared line by line against what was actually spent -- and a
-- report that only knew the total could not say WHERE a trip came in over.
--
-- THE ACCOMMODATION RATE IS THE APPROVER'S NUMBER, NOT THE REQUESTER'S. imprest_roles holds a
-- rate per role (a credit officer, an RSM and the GM do not sleep in the same hotel), and the
-- server multiplies days by THAT rate at request time, ignoring any figure the form sent. The
-- rate in force is also stamped onto the request (accom_rate), so a later change to the table
-- does not silently reprice trips already filed.
--
-- THE RETIREMENT IS ITS OWN ROW, AND THE PHOTOS ARE THEIR OWN ROWS AGAIN.
-- ---------------------------------------------------------------------------------------------
-- "3 pictures ... optimize for storage". Receipts arrive as JPEG data URLs, already shrunk on
-- the phone (long side <= 1024px, quality ~0.6, roughly 60-120KB each) and refused by the
-- server above 200KB. They live in imprest_photos, NOT on the request or retirement row: every
-- list this feature draws selects requests and retirements, and a list that dragged three
-- photos per row across the wire would make the GM's report unusable on a phone. Photos are
-- fetched one request at a time, when somebody presses "Picha".
--
-- LEAVE follows the HR form the company already prints, field for field, so HR can read a row
-- here the way they read the paper one. Working days are counted Monday-Friday by the server.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. WHO PAYS WHAT PER NIGHT. Edited from the approval pane's "Viwango / Rates" widget.
-- ---------------------------------------------------------------------------------------------
create table if not exists imprest_roles (
  role                   text primary key,          -- stored UPPER-CASED, matched the same way
  accommodation_per_day  integer not null default 0 check (accommodation_per_day >= 0),
  updated_at             timestamptz not null default now(),
  updated_by             text
);
comment on table imprest_roles is
  'Accommodation rate per day for each role a traveller may claim as. The requester picks one '
  'of these on the form; the server multiplies nights by THIS rate and ignores any figure the '
  'form sent. Managed from the imprest approval pane.';

-- ---------------------------------------------------------------------------------------------
-- 2. THE REQUEST, from the ask to the decision to the retirement summary.
-- ---------------------------------------------------------------------------------------------
create table if not exists imprest_requests (
  id                uuid primary key default gen_random_uuid(),
  requested_at      timestamptz not null default now(),

  -- WHO ASKED, as their access code said at the time. staff_code is the sign-in credential and
  -- never leaves the server; the two names beside it are what the report prints.
  staff_code        text,
  staff_name        text not null,                  -- from the session
  staff_role        text,                           -- from the session

  -- THE FORM, as the person filled it. full_name is what they typed and may differ from
  -- staff_name (a code shared by a desk, a nickname on the register); recipient_name is the
  -- name on the bank account when that is somebody else again.
  full_name         text not null,
  mobile            text,
  recipient_name    text,
  email             text,
  imprest_role      text not null,                  -- the role chosen on the form (rate lookup)
  pay_mode          text,                           -- MPESA / CRDB / CASH ...
  account_no        text,
  travel_date       date not null,
  destination       text,

  -- THE COSTING, kept as its parts. Every *_amount is computed by the server from the two
  -- numbers beside it; the client's totals are not trusted.
  fare_trips        integer not null default 0 check (fare_trips >= 0),
  fare_per_trip     integer not null default 0 check (fare_per_trip >= 0),
  fare_amount       integer not null default 0,
  accom_days        integer not null default 0 check (accom_days >= 0),
  accom_rate        integer not null default 0,     -- the role's rate IN FORCE when asked
  accom_amount      integer not null default 0,
  other1_desc       text,  other1_amount integer not null default 0 check (other1_amount >= 0),
  other2_desc       text,  other2_amount integer not null default 0 check (other2_amount >= 0),
  other3_desc       text,  other3_amount integer not null default 0 check (other3_amount >= 0),
  total_amount      integer not null check (total_amount >= 0),
  purpose           text not null,

  -- THE DECISION. approved_amount may be LESS than total_amount and is what the cashier pays.
  status            text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected')),
  approved_amount   integer,
  comment           text,
  decided_by        text,
  decided_at        timestamptz,

  -- THE RETIREMENT, summarised here so every list can show it without a join. The line-level
  -- actuals and the photos live in the two tables below.
  retired_at        timestamptz,
  retire_total      integer,
  -- approved_amount - retire_total. Positive: the traveller returns the difference. Negative:
  -- the company owes them. Null until retired.
  retire_balance    integer,

  updated_at        timestamptz not null default now()
);
comment on table imprest_requests is
  'One imprest (travel/task cash) request from ask to decision to retirement. Requester is '
  'STAMPED from the access code; amounts are computed server-side from their parts; the '
  'accommodation rate in force is stamped so later rate changes never reprice old trips.';
comment on column imprest_requests.accom_rate is
  'The imprest_roles rate for imprest_role at the moment of asking. Stamped, not joined.';
comment on column imprest_requests.retire_balance is
  'approved_amount minus what was actually spent. Positive = traveller refunds; negative = '
  'company reimburses. Null until a retirement is filed.';

create index if not exists imprest_requests_requested_at_idx on imprest_requests (requested_at desc);
create index if not exists imprest_requests_status_idx on imprest_requests (status) where status = 'pending';
create index if not exists imprest_requests_staff_code_idx on imprest_requests (staff_code);
create index if not exists imprest_requests_travel_date_idx on imprest_requests (travel_date);

-- ---------------------------------------------------------------------------------------------
-- 3. THE RETIREMENT: what the trip actually cost, line by line. One per request, ever.
-- ---------------------------------------------------------------------------------------------
create table if not exists imprest_retirements (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null unique references imprest_requests (id) on delete cascade,
  filed_at        timestamptz not null default now(),
  filed_by_code   text,
  filed_by_name   text,
  fare_actual     integer not null default 0 check (fare_actual >= 0),
  accom_actual    integer not null default 0 check (accom_actual >= 0),
  other1_actual   integer not null default 0 check (other1_actual >= 0),
  other2_actual   integer not null default 0 check (other2_actual >= 0),
  other3_actual   integer not null default 0 check (other3_actual >= 0),
  total_actual    integer not null check (total_actual >= 0),
  notes           text,
  photo_count     integer not null default 0
);
comment on table imprest_retirements is
  'Actual spend against an approved imprest, filed once by the traveller on arrival. The photos '
  'that evidence it are in imprest_photos, deliberately not here -- see that table.';

-- ---------------------------------------------------------------------------------------------
-- 4. THE RECEIPTS. Small, separate, fetched only when somebody asks to see them.
-- ---------------------------------------------------------------------------------------------
create table if not exists imprest_photos (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references imprest_requests (id) on delete cascade,
  seq         integer not null check (seq between 1 and 3),
  -- A JPEG data URL, already shrunk on the phone and refused above 200KB by the server. Text
  -- rather than bytea so the one client this system has (a browser) can put it straight into
  -- an <img> with no decoding step.
  data        text not null,
  bytes       integer not null,
  unique (request_id, seq)
);
comment on table imprest_photos is
  'Up to three receipt photos per imprest retirement, compressed client-side (long side <= '
  '1024px, JPEG ~0.6) and capped at 200KB each server-side. Kept off the request and retirement '
  'rows so every list stays light; fetched per request on demand.';

-- ---------------------------------------------------------------------------------------------
-- 5. LEAVE, field for field from the HR form.
-- ---------------------------------------------------------------------------------------------
create table if not exists leave_requests (
  id              uuid primary key default gen_random_uuid(),
  requested_at    timestamptz not null default now(),

  staff_code      text,
  staff_name      text not null,                    -- from the session
  staff_role      text,                             -- from the session

  employee_id     text,
  department      text,                             -- "Department / Position"
  supervisor      text,                             -- "Immediate Supervisor"
  leave_type      text not null
                    check (leave_type in ('annual', 'sick', 'maternity', 'paternity',
                                          'compassionate', 'other')),
  other_type      text,                             -- when leave_type = 'other'
  from_date       date not null,
  to_date         date not null,
  working_days    integer not null default 0,       -- Mon-Fri inclusive, computed by the server
  resume_date     date,
  reason          text,
  contact         text,                             -- "Contact Number During Leave"
  handed_to       text,                             -- "Duties Handed Over To"
  declared        boolean not null default false,   -- the form's declaration, ticked
  -- The form says: submit at least one week ahead, except emergency, sudden illness or
  -- bereavement. Rather than refuse a late annual request outright, the server marks it so HR
  -- sees the policy breach at a glance and decides.
  short_notice    boolean not null default false,

  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected')),
  comment         text,                             -- "HR Decision / Comments"
  decided_by      text,
  decided_at      timestamptz,
  updated_at      timestamptz not null default now()
);
comment on table leave_requests is
  'One leave request per the HOOP COMPANY LIMITED Leave Request Form, from application to HR '
  'decision. Requester identity is STAMPED from the access code; working days are counted '
  'Monday-Friday by the server; short_notice flags a non-emergency request filed under a week '
  'ahead for HR to weigh rather than for the system to refuse.';

create index if not exists leave_requests_requested_at_idx on leave_requests (requested_at desc);
create index if not exists leave_requests_status_idx on leave_requests (status) where status = 'pending';
create index if not exists leave_requests_staff_code_idx on leave_requests (staff_code);
create index if not exists leave_requests_from_date_idx on leave_requests (from_date);

-- ---------------------------------------------------------------------------------------------
-- 6. WHERE THE COPIES GO. Settings, so the office can change a recipient without a deploy.
--    Blank means "do not email" -- the panes still work; email is a courtesy on top of them.
--    Sending needs RESEND_API_KEY set on the deployment (a secret, so an env var, not a row).
-- ---------------------------------------------------------------------------------------------
insert into settings (key, value) values
  ('IMPREST_ADMIN_EMAIL', ''),
  ('IMPREST_GM_EMAIL', ''),
  ('HR_EMAIL', ''),
  ('EMAIL_FROM', '')
on conflict (key) do nothing;
