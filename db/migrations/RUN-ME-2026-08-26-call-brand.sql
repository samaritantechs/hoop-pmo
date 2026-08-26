-- =====================================================================================
-- THE LAST PLACE THE OLD NAME WAS STILL LIVING.
--
--   "set CALL_BRAND to HOOPLOAN"
--
-- Every file in the repo said HOOPLOAN, the APK said HOOPLOAN on the launcher, and
-- /api/call went on answering {"brand":"HOOP CALLS"} -- because the name was ALSO a row in
-- the settings table, planted by db/seed.sql before the rename, and a settings row outranks
-- the constant in call-core.js. A rename that greps the source can never find that.
--
-- The seed no longer plants it (see db/seed.sql), so a fresh deployment now takes
-- APP.BRAND and there is one name in one place. But `on conflict (key) do nothing` never
-- updated an existing row and never will, so a database seeded before today still holds the
-- old string. This is the one statement that clears it.
--
-- DELETE rather than UPDATE, on purpose. Setting the row to 'HOOPLOAN' would leave the same
-- trap armed for the next rename: a copy of the name sitting in the database, outranking the
-- code, waiting to disagree. Removing it hands the question back to APP.BRAND, which is
-- where the answer belongs. Anyone who genuinely wants a different brand on the calls app
-- can still set it from Portal -> Settings, and that choice will then be a real decision
-- rather than a leftover.
--
-- Safe to re-run. Safe on a database that never had the row.
-- =====================================================================================

delete from settings where key = 'CALL_BRAND';

-- Check: this should come back empty, and /api/call api_brand should answer HOOPLOAN.
--   select key, value from settings where key = 'CALL_BRAND';
