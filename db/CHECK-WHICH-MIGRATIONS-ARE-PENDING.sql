-- =============================================================================================
-- WHICH MIGRATIONS HAVE I NOT RUN YET?
-- =============================================================================================
-- This database is built by hand, so nothing anywhere records which files have been pasted. This
-- asks the database itself: every migration creates a table or a column, so the presence of that
-- object IS the receipt.
--
-- Run it whole. Read the PENDING rows -- those are the files still to paste, oldest first.
-- Nothing here writes anything.
-- =============================================================================================
with checks(ord, file, kind, obj) as (values
  ( 1, 'RUN-ME-2026-08-15-agents.sql',            'table',  'hoop_agents'),
  ( 2, 'RUN-ME-2026-08-15-repair.sql',            'column', 'call_users.passcode_hash'),
  ( 3, 'RUN-ME-2026-08-16-sales.sql',             'table',  'hoop_sales'),
  ( 4, 'RUN-ME-2026-08-17-offline-queue.sql',     'column', 'watu_loans.guarantor_name'),
  ( 5, 'RUN-ME-2026-08-24-devices.sql',           'table',  'devices'),
  ( 6, 'RUN-ME-2026-08-24-sales-performance.sql', 'column', 'hoop_sales.uploaded_by'),
  ( 7, 'RUN-ME-2026-08-28-location.sql',          'column', 'devices.last_lat'),
  ( 8, 'RUN-ME-2026-08-28-push.sql',              'column', 'devices.fcm_token'),
  ( 9, 'RUN-ME-2026-08-28-token-memory.sql',      'table',  'device_tokens'),
  (10, 'RUN-ME-2026-08-29-salary-advance.sql',    'table',  'staff_advances'),
  (11, 'RUN-ME-2026-08-31-access-suspend.sql',    'column', 'access_codes.suspend_from'),
  (12, 'RUN-ME-2026-08-31-enrol-batch.sql',       'column', 'devices.enrol_batch_at'),
  (13, 'RUN-ME-2026-09-07-imprest-leave.sql',     'table',  'imprest_requests'),
  (14, 'RUN-ME-2026-09-08-issues.sql',            'table',  'issues'),
  (15, 'RUN-ME-2026-09-09-advance-rules.sql',     'table',  'staff_salaries'),
  (16, 'RUN-ME-2026-09-09-commission.sql',        'table',  'commission_runs'),
  (17, 'RUN-ME-2026-09-09-loss-damage.sql',       'table',  'loss_cases'),
  (18, 'RUN-ME-2026-09-09-stock-requests.sql',    'table',  'stock_requests'),
  (19, 'RUN-ME-2026-09-09-targets.sql',           'table',  'sales_targets'),
  (20, 'RUN-ME-2026-09-09-topups.sql',            'table',  'topups'),
  (21, 'RUN-ME-2026-09-10-enrolment.sql',         'column', 'hoop_agents.kin2_name'),
  (22, 'RUN-ME-2026-09-10-issue-routing.sql',     'column', 'issues.to_role'),
  (23, 'RUN-ME-2026-09-10-it-report.sql',         'table',  'it_reports'),
  (24, 'RUN-ME-2026-09-10-signin-watch.sql',      'table',  'signin_attempts'),
  (25, 'RUN-ME-2026-09-11-advance-once-a-month.sql', 'setting', 'ADVANCE_MAX_PER_MONTH'),
  (26, 'RUN-ME-2026-09-11-new-stock.sql',         'table',  'stock_audit'),
  (27, 'RUN-ME-2026-09-12-old-stock.sql',         'table',  'old_stock')
)
select
  c.ord as "#",
  case when found then '✓ done' else '❗ PENDING' end as status,
  c.file,
  c.kind || ' ' || c.obj as "the receipt it leaves"
from checks c
cross join lateral (
  select case c.kind
    when 'table'  then to_regclass('public.' || c.obj) is not null
    when 'column' then exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name  = split_part(c.obj, '.', 1)
        and column_name = split_part(c.obj, '.', 2))
    when 'setting' then exists (select 1 from settings where key = c.obj)
    else false end as found
) f
order by c.ord;

-- ---------------------------------------------------------------------------------------------
-- TWO FILES ARE NOT ON THAT LIST, ON PURPOSE, because they leave no object of their own:
--
--   RUN-ME-2026-08-17-stock-movement.sql  -- indexes only
--   RUN-ME-2026-08-26-call-brand.sql      -- a settings row you may have set by hand
--   RUN-ME-2026-08-31-advance-leader.sql  -- adds access_codes.is_leader, and the Kiongozi
--                                            switch it was for has since been removed
--   RUN-ME-2026-09-10-target-roles.sql    -- widens a CHECK constraint on sales_targets; it is
--                                            a no-op unless that table exists, and harmless
--                                            to run again either way
--
-- Run those three if you have never run them; they cost nothing on a second pass.
-- ---------------------------------------------------------------------------------------------
