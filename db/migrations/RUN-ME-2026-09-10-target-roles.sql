-- =============================================================================================
-- TARGETS SET BY ROLE.
-- =============================================================================================
--   "Sales target is set per rsm like hope sets for team, so it increases to the higher
--    leadership tiers, but decrease when going down to team leaders and agents -- like it's
--    2 halves if only 2 team leaders are under the rsm. With that hierarchy down at agents
--    contributive auto target from that of rsm. And TARGET WILL BE SET BY ROLE not a single
--    staff."
--
-- ONE NEW SCOPE, AND NOTHING ELSE. `scope = 'role'` means the name is a ROLE from the register
-- -- Regional_Manager, Team_Leader, Field_Officer -- and every holder of it is expected to sell
-- that much. One row instead of one row per person, which is the difference between a target
-- somebody keeps up and a target nobody sets after the first month.
--
-- THE CASCADE NEEDS NO COLUMNS AT ALL. A share is never stored: it is worked out on every read
-- by walking `hoop_agents.manager` (and the branch, where that is blank). A share written into
-- a row would be a lie the moment somebody moves team or gains an agent -- and a lie nobody
-- could see, because it would look exactly like a number a person typed.
--
-- Safe to run more than once, and safe to run BEFORE or AFTER
-- db/migrations/RUN-ME-2026-09-09-targets.sql: it does nothing at all until that table exists.
-- =============================================================================================

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'sales_targets') then
    alter table sales_targets drop constraint if exists sales_targets_scope_check;
    alter table sales_targets add constraint sales_targets_scope_check
      check (scope in ('agent', 'rsm', 'branch', 'company', 'role'));
  end if;
end $$;
