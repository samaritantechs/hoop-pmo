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

-- CALL_BRAND IS DELIBERATELY NOT SEEDED, AND THAT IS THE FIX.
--
-- It used to be, as 'HOOP CALLS', from before the rename. call-core.js already falls back to
-- APP.BRAND ('HOOPLOAN') whenever the row is absent, so seeding it only ever restated the
-- code default in a second place -- and the moment the code default changed, the copy in the
-- database went on quietly outranking it. Long after every file in this repo said HOOPLOAN,
-- /api/call still answered {"brand":"HOOP CALLS"}, because a settings row beats a constant
-- and nobody thinks to look in the database for a name they have just finished renaming.
--
-- The name lives in ONE place now. The setting still exists and is still editable in
-- Portal -> Settings for a deployment that genuinely wants a different brand on the app; it
-- is simply no longer planted with a default that can go stale behind the code.
--
-- A database seeded before this keeps its old row -- `on conflict do nothing` never updated
-- one either. See db/migrations/RUN-ME-2026-08-26-call-brand.sql.
