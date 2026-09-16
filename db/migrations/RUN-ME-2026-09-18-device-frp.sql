-- =============================================================================================
-- WHAT EACH HANDSET SAID ABOUT ITS RESET PROTECTION -- one column on the register.
-- =============================================================================================
--   "does our lock persist through OS rebootings of (Flashing ROMs / Fastboot flashing, Odin
--    (Samsung), SP Flash Tool, Fastboot/ADB commands)"
--
-- The lock app is a Device Owner and lives in the data partition: a wipe removes it. What
-- outlives a wipe is Factory Reset Protection, which the app now sets from the Google account
-- IDs in Settings (DEVICE_FRP_ACCOUNT_IDS) on Android 11+ with Google services -- and reports
-- back on every beat what the system made of it, because "sent" is not "fenced":
--
--   set:N                   the policy holds; N accounts may set the phone up after a wipe
--   cleared                 the office blanked the setting, or the phone was released
--   unsupported:android<11  the API does not exist on this phone
--   unsupported:no-gms      no Google services, so nothing would enforce it
--   unsupported:not-owner   the app is no longer Device Owner
--   error:...               the system refused; the phone retries on its next beat
--
-- Every code path works without this column (the beat drops it from its write, the Devices
-- pane reads without it and simply cannot count the fenced phones). Safe to re-run.
-- =============================================================================================

alter table devices add column if not exists frp text;

comment on column devices.frp is
  'What the handset last reported about its Factory Reset Protection policy: set:N, cleared, '
  'unsupported:<why> or error:<why>. Written by the beat only when it changes. See Frp.java.';
