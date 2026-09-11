-- =====================================================================================
--  RUN ME.  MOVING A HANDSET TO THE OTHER COMPANY -- three columns, nothing else.
-- =====================================================================================
--
--    "another button for shift so that hoop can shift a device to hope and viceversa
--     saving re-enlorrment energy"
--
--  Paste the WHOLE FILE into the Supabase SQL editor and run it once. Safe to re-run:
--  every statement is `add column if not exists`, so a second run changes nothing.
--
--  UNTIL THIS RUNS, SHIFT SIMPLY DOES NOTHING -- not fails, does nothing. deviceShift
--  writes these three columns; beat() and byToken() in api/_lib/device-core.js both read
--  them with a pre-migration fallback, exactly like every other device column added after
--  the first register migration (RUN-ME-2026-08-24-devices.sql). A handset asks its usual
--  questions, gets its usual answers, and never hears about a shift that was never written
--  down.
--
--  WHAT THESE HOLD. `shift_server` and `shift_batch` are the order sitting on a row: which
--  other office this handset should move to, and the batch token (minted by THAT office's
--  own Sajili simu / Enrol) it will use to prove itself there. The handset reads them on
--  its next beat and clears them itself once the claim lands -- see Shift.java in
--  android/lock, and `shifted` in api/_lib/device-core.js, which is what a departing
--  handset calls to tell THIS office it left. `shift_at` is stamped for the same reason
--  enrol_batch_at carries one: so a stale order sitting unconfirmed for weeks is a fact the
--  register can show, not a silent question mark.
-- =====================================================================================

alter table devices add column if not exists shift_server text;
alter table devices add column if not exists shift_batch  text;
alter table devices add column if not exists shift_at     timestamptz;

-- =====================================================================================
--  DID IT LAND?
-- =====================================================================================
-- select imei, shift_server, shift_at from devices where shift_server is not null;
