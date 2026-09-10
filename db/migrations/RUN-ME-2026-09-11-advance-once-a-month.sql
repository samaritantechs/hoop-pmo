-- ONE ADVANCE A MONTH (2026-09-11).
--
--   "One shouldn't be able to request advance more than once in a single month from now on.
--    One had been there and second real one already, so I rejected the 1st one with comment
--    trial -- that's why we don't need to treat the old one but treat the future, from now on."
--
-- A DECLINED REQUEST DOES NOT COUNT, and that is the shape of the whole rule rather than a
-- detail of it. The owner's own fix for the duplicate was to DECLINE the trial so the real one
-- could stand. If a decline still occupied the month that fix would not have worked, and a
-- person would be locked out of a month by somebody else's mistake. So: pending or approved
-- occupies the month, and a decline frees it.
--
-- MEASURED ON THE MONTH THE ADVANCE IS *FOR* (apply_date), not the day the button was pressed.
-- One advance against one payroll month is the point -- SOP G.5's ceiling is a percentage of
-- that month's salary -- and requested_at would let two requests for September be filed either
-- side of the 1st of October and both stand.
--
-- "FROM NOW ON" MEANS NOTHING ALREADY FILED IS TOUCHED. This migration changes no row, flags
-- nothing and deletes nothing. A month that already holds two live requests keeps both and
-- simply cannot take a third.
--
-- Safe to run more than once, like every migration in this folder.

-- The setting, so the office can relax the rule without a deploy. The server's own fallback is
-- 1, so an unset key is the rule as asked for rather than no rule at all.
insert into settings (key, value) values ('ADVANCE_MAX_PER_MONTH', '1')
on conflict (key) do nothing;

-- THE INDEX IS BELT AND BRACES, NOT THE RULE ITSELF.
-- ---------------------------------------------------------------------------------------------
-- The server refuses the second request; this closes the millisecond in which two clicks could
-- both pass that check. It is created inside a block that CANNOT FAIL THE MIGRATION, because
-- this table is live and may already hold duplicates from before the rule existed -- and a
-- migration that aborts halfway is a worse outcome than an index that is not there. If it
-- cannot be created, the notice says so and how to find the rows in the way.
do $$
begin
  create unique index if not exists staff_advances_one_per_month
    on staff_advances (staff_code, (date_trunc('month', apply_date::timestamp)))
    where status <> 'declined';
exception when others then
  raise notice 'staff_advances_one_per_month was NOT created: %', sqlerrm;
  raise notice 'The server still enforces one request per month; this index is only a race guard.';
  raise notice 'Find the rows in the way with:  select staff_code, date_trunc(''month'', apply_date), count(*) from staff_advances where status <> ''declined'' group by 1,2 having count(*) > 1;';
  raise notice 'Decline the ones that should not stand (a decline frees the month), then run this file again.';
end $$;

comment on index staff_advances_one_per_month is
  'One live advance per person per payroll month. Declined rows are excluded: a decline frees the month, which is how a mistaken request is undone.';
