-- =====================================================================================
-- First-run seed -- run ONCE after schema.sql (Supabase SQL Editor -> paste -> Run).
--
-- Creates the first access code so the portal and upload page are reachable at all.
-- CHANGE THE CODE VALUE BELOW before running -- it is effectively a password.
-- teams = null means ALL teams (Hope's convention, kept by the copied auth layer).
--
-- Idempotent: safe to re-run; an existing code/role/setting is left untouched.
-- =====================================================================================

insert into access_codes (code, name, role, teams, tabs)
values ('CHANGE-ME-1234', 'Administrator', 'ADMIN', null, array['upload', 'settings'])
on conflict (code) do nothing;

insert into roles (role, tabs)
values ('ADMIN', array['upload', 'settings', 'dashboard'])
on conflict (role) do nothing;

-- The copied system gate reads SYSTEM_OPEN and defaults to CLOSED when the key is
-- absent -- without this row the whole system politely refuses everyone on day one.
insert into settings (key, value) values ('SYSTEM_OPEN', 'YES')
on conflict (key) do nothing;

-- The call app's brand line until Hoop's real logo/colors arrive (starter section 7).
insert into settings (key, value) values ('CALL_BRAND', 'HOOP CALLS')
on conflict (key) do nothing;
