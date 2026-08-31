-- =============================================================================================
-- SALARY ADVANCE: one row per request, from the ask to the money.
-- =============================================================================================
--   "hoop users should get a nav pane and be able to make advance requests, their leaders will
--    be assigned with another approval nav ... there is salary advance report nav that I'll
--    grant to hr which hr will use for filing and bank payment report"
--
-- Three panes, ONE table. A request, a decision on it, and the bank details the payment needs
-- are the same fact at three moments -- splitting them across tables would mean a report that
-- joins to find out what happened to an ask, and a join is a place for a row to go missing.
--
-- WHO THE REQUESTER IS, WRITTEN DOWN RATHER THAN LOOKED UP.
-- ---------------------------------------------------------------------------------------------
--   "hope uses DB ours uses accesscode data"
--
-- HOOP has no staff table. A person is whichever access code they signed in with, and that row
-- already carries their name and their role. So both are STAMPED here at the moment of asking,
-- not joined at read time.
--
-- That is deliberate and it matters for money: a code can be renamed, a role can change, a code
-- can be deleted outright. A payment record that rewrites itself when the register changes is
-- not a record. What this table says is what was true when the person asked.
--
-- WHY approved_amount IS ITS OWN COLUMN.
-- ---------------------------------------------------------------------------------------------
--   "may comment that give this 200k request just 100k"
--
-- The approver may grant LESS than was asked for. Overwriting `amount` would destroy the
-- question the decision was an answer to -- and the bank pays the approved figure while the
-- staff member remembers the requested one, which is exactly the argument this column prevents.
-- Both numbers survive, and the report shows both.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

create table if not exists staff_advances (
  id              uuid primary key default gen_random_uuid(),

  -- THE TIMESTAMP COLUMN ON THE REPORT: when the application was made in the system. Not the
  -- same fact as apply_date below, and the report shows both because they answer different
  -- questions -- "when did this reach us" versus "which date is this advance against".
  requested_at    timestamptz not null default now(),

  -- WHO ASKED, as their access code said at the time. staff_code is kept so a duplicate name
  -- can still be told apart; it is never shown on the report, which is a payroll document.
  staff_code      text,
  staff_name      text not null,
  staff_role      text,

  apply_date      date,                    -- the requester's own calendar pick
  amount          integer not null,        -- what was asked for: 50/100/150/200 thousand

  -- THE DECISION. `status` is the state; approved_amount is what the bank actually pays and is
  -- null until somebody decides. A declined row keeps its comment and its null amount, which is
  -- the honest record of a refusal.
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'declined')),
  approved_amount integer,
  comment         text,
  decided_by      text,
  decided_at      timestamptz,

  -- WHERE THE MONEY GOES, filled by the requester because they are the only one who knows it.
  -- Carrier as well as bank: half of Tanzania is paid to a phone wallet, not an account.
  bank_name       text,
  account_no      text,

  updated_at      timestamptz not null default now()
);

comment on table staff_advances is
  'One salary advance request from ask to payment. Requester identity is STAMPED from the access '
  'code at request time, never joined -- a payment record must not change when the register does.';
comment on column staff_advances.amount is
  'What was requested. Never overwritten by a decision: see approved_amount.';
comment on column staff_advances.approved_amount is
  'What was actually granted, which may be LESS than requested. Null until decided, and null on '
  'a decline.';
comment on column staff_advances.requested_at is
  'When the application was made in the system. Distinct from apply_date, which the requester '
  'picks themselves.';

-- The approval queue reads pending-first, and the report reads newest-first. One index serves
-- both, because both start from "when did this happen".
create index if not exists staff_advances_requested_at_idx on staff_advances (requested_at desc);
-- The approver's pane asks for exactly one thing: what is still waiting on me.
create index if not exists staff_advances_status_idx on staff_advances (status) where status = 'pending';
-- A requester's own pane shows their history, and that is a lookup by the code they signed in with.
create index if not exists staff_advances_staff_code_idx on staff_advances (staff_code);
