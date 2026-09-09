-- =============================================================================================
-- THE THREE SALARY-ADVANCE RULES THE SOP HAS AND THIS SYSTEM DID NOT.
-- =============================================================================================
--   Finance SOP G.4  "All salary advance requests must be submitted no later than the 15th day
--                     of the month."
--   Finance SOP G.5  "The approved advance amount must not exceed 40% of the employee's monthly
--                     salary."
--   Finance SOP G.6  "Once approved, Finance processes the advance and records it FOR DEDUCTION
--                     against the employee's next payroll."
--
-- The request, the approval and the report already exist. What was missing is everything that
-- happens either side of the decision: whether it was in time, whether it is within the cap,
-- whether the money actually went, and whether payroll has taken it back.
--
-- G.4 IS A FLAG, NOT A LOCK. A deadline that refuses the request leaves somebody with an
-- emergency and no way to ask, and the SOP gives the approver the judgement, not the form. The
-- request is stamped late and the approver sees it said so.
--
-- G.5 IS A LOCK, where a salary is known. "Must not exceed" is not a suggestion. It can only be
-- enforced against a figure somebody has entered, so an employee with no salary on file is
-- approved without the cap and the report says the cap could not be applied -- which is a
-- prompt to go and enter it, not a silent pass.
--
-- Safe to run more than once.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. WHAT THE MONTHLY SALARY IS. HR's figure, kept apart from everything else about a person.
-- ---------------------------------------------------------------------------------------------
-- Keyed by the ACCESS CODE, because that is what a salary advance stamps on itself. Nothing
-- else in this system needs to know a salary, so nothing else reads this table.
create table if not exists staff_salaries (
  staff_code     text primary key,
  staff_name     text,
  monthly_salary numeric(14, 2) not null check (monthly_salary >= 0),
  updated_by     text,
  updated_at     timestamptz not null default now()
);
comment on table staff_salaries is
  'Monthly salary per access code, entered by HR, read by exactly one rule: the 40% salary-'
  'advance cap in Finance SOP G.5. Kept in its own table so that holding any other pane never '
  'means seeing what a colleague earns.';

-- ---------------------------------------------------------------------------------------------
-- 2. WHAT THE ADVANCE ROW HAS TO REMEMBER.
-- ---------------------------------------------------------------------------------------------
-- G.4: was it filed by the deadline. Stamped at request time from the applicant's own date, so
-- a request filed on the 20th still reads as late next year when somebody audits it.
alter table staff_advances add column if not exists late boolean;
-- G.5: the salary the cap was computed from, and the cap itself. Both frozen on the row: a
-- raise next month must not silently re-justify last month's approval.
alter table staff_advances add column if not exists salary_at_request numeric(14, 2);
alter table staff_advances add column if not exists cap_amount numeric(14, 2);
-- G.6: the money going out, and payroll taking it back. Two different facts on two different
-- days, so two stamps -- a report that cannot tell "approved" from "paid" cannot chase either.
alter table staff_advances add column if not exists paid_at timestamptz;
alter table staff_advances add column if not exists paid_by text;
alter table staff_advances add column if not exists payment_ref text;
alter table staff_advances add column if not exists deducted_at timestamptz;
alter table staff_advances add column if not exists deducted_by text;
-- Which payroll month took it back, as 'YYYY-MM'.
alter table staff_advances add column if not exists deduct_period text;

comment on column staff_advances.late is
  'Filed after the deadline day (Finance SOP G.4). A FLAG the approver sees, never a refusal: '
  'a deadline that blocks the form leaves an emergency with nowhere to go.';
comment on column staff_advances.cap_amount is
  'The 40% ceiling (Finance SOP G.5) as it stood when the request was filed, frozen so a later '
  'raise cannot retroactively justify an approval.';

-- ---------------------------------------------------------------------------------------------
-- 3. THE TWO NUMBERS THE SOP FIXES, as settings rather than constants.
-- ---------------------------------------------------------------------------------------------
--   ADVANCE_DEADLINE_DAY  G.4: "no later than the 15th day of the month"
--   ADVANCE_MAX_PCT       G.5: "must not exceed 40% of the employee's monthly salary"
insert into settings (key, value) values
  ('ADVANCE_DEADLINE_DAY', '15'),
  ('ADVANCE_MAX_PCT', '40')
on conflict (key) do nothing;
