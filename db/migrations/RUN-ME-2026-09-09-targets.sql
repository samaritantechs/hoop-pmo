-- =============================================================================================
-- SALES TARGETS, AND WHO AN AGENT REPORTS TO.
-- =============================================================================================
--   CSM SOP B.3  "Set regional targets for each RSM and monitor performance against them"
--   CSM SOP A.2  "Hold RSMs accountable for the performance of their respective regions"
--   RSM SOP B.1  "Set and monitor sales targets for each agent/team leader, in line with the
--                 overall targets set by the company"
--   RSM SOP B.3  "Review performance data weekly and monthly, and identify reasons for any
--                 decline"
--
-- The Sales performance board already answers "how much did we sell". It cannot answer "against
-- what", because nothing in this system has ever held a target for a PERSON -- only
-- SALES_DAILY_TARGET, one company-wide number per day. A regional target and an agent's target
-- are different numbers set by different people, and the SOP asks for both.
--
-- ONE ROW PER PERIOD, SCOPE AND NAME. The scope says what the name means: an agent, an RSM, a
-- branch, or the company. That is one table instead of four, because they are the same fact --
-- somebody is expected to sell this much this month -- and four tables would drift.
--
-- A month, not a week: "review performance data weekly and monthly" is two views of one target,
-- and a weekly target that has to be re-typed every Monday is a target nobody sets.
--
-- Safe to run more than once.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. WHO AN AGENT REPORTS TO, so the roll-up has a line to climb.
-- ---------------------------------------------------------------------------------------------
-- The register carries a role and a branch but never said WHICH RSM an agent belongs to, so an
-- agent's numbers could not be added to their manager's. This is the exception column: leave it
-- blank and the server derives the manager from the branch (the Regional_Manager standing in
-- the same branch), which is right for almost everybody. Fill it only where somebody reports
-- across a branch line.
alter table hoop_agents add column if not exists manager text;
comment on column hoop_agents.manager is
  'The RSM this agent reports to, by name. Blank means "derive it from the branch" -- the '
  'Regional_Manager in the same branch. An override for the exceptions, not a field to fill 1,000 times.';

-- ---------------------------------------------------------------------------------------------
-- 2. THE TARGETS.
-- ---------------------------------------------------------------------------------------------
create table if not exists sales_targets (
  id            uuid primary key default gen_random_uuid(),

  -- 'YYYY-MM'. A month is the unit the SOP reviews and the unit somebody will actually keep up.
  period        text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),

  -- WHAT THE NAME MEANS. agent = one seller, rsm = a regional manager and everyone under them,
  -- branch = a region however it is staffed, company = the whole book, and ROLE = every holder
  -- of that role in the register ("target will be set by role not a single staff").
  scope         text not null check (scope in ('agent', 'rsm', 'branch', 'company', 'role')),
  -- The person or place, as the register spells it. 'ALL' for the company scope.
  name          text not null,

  -- EITHER OR BOTH. Some targets are "thirty phones", some are "forty million shillings", and
  -- a target of zero is a real answer (a month off) -- so null means "not set", not zero.
  target_qty    integer check (target_qty is null or target_qty >= 0),
  target_amount numeric check (target_amount is null or target_amount >= 0),

  -- RSM SOP B.5 "Document the actions taken and the results achieved" -- the short version.
  -- The long version is an issue of kind 'performance' in the issues log.
  note          text,

  set_by        text,
  set_at        timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One target per person per month. Re-setting it updates rather than adding a second.
  unique (period, scope, name)
);
comment on table sales_targets is
  'Sales targets per month and per scope (agent / rsm / branch / company). Set by whoever holds '
  'the targets nav -- the CSM sets RSM targets, the RSM sets agent targets. Attainment is '
  'measured against watu_loans by disbursed_date, the same book every sales figure here reads.';

create index if not exists sales_targets_period_idx on sales_targets (period);
create index if not exists sales_targets_name_idx on sales_targets (scope, name);
