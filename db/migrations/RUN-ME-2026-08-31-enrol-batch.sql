-- =============================================================================================
-- ONE COMMAND, EVERY PHONE ON THE HUB.
-- =============================================================================================
--   "and thats my intention of pasting multiple imei and copyng signle cmd to run and get many
--    phones registered at once"
--
-- Enrolment used to hand each handset a token that had been minted for its IMEI, which meant
-- the person at the bench was the thing pairing phone to identity -- one cable, one phone, one
-- line, twenty times. With a USB hub that is the wrong shape, and the obvious fix is the
-- dangerous one: loop the enrol broadcast across every connected device and let plug-in ORDER
-- decide who gets what. Nothing downstream would catch a swap, because the beat resolves a
-- handset BY ITS TOKEN and files what it says under the row that token belongs to. A phone
-- given its neighbour's token simply becomes its neighbour, quietly, and the way back is a
-- factory reset.
--
-- SO THE PHONE IS ASKED WHO IT IS, INSTEAD OF BEING TOLD.
-- ---------------------------------------------------------------------------------------------
-- The command now carries a BATCH token -- the same string for every handset, so it is safe to
-- broadcast to all of them at once. On receiving it a phone reads its own IMEI (it is Device
-- Owner by that point in the command, which is what makes that readable at all), sends it to
-- the server, and is handed back the token minted for THAT IMEI. Order stops meaning anything.
--
-- It fails CLOSED, which is the property that makes this safe rather than merely convenient: a
-- handset whose IMEI is not in the batch gets no token, stays un-enrolled, and shows up as
-- missing on the register. It can never be handed somebody else's identity.
--
-- WHY THE BATCH EXPIRES.
-- ---------------------------------------------------------------------------------------------
-- The batch token is a bearer secret: whoever holds it, plus an IMEI that is in the batch, can
-- obtain that device's token. That is exactly the power the bench needs and exactly the power
-- nobody should hold a week later, so it is stamped with a time and the server refuses a claim
-- against a batch older than a day. A bench session is hours; a leaked string should not be a
-- standing key to the fleet.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

-- enrol_batch ITSELF ALREADY EXISTS -- RUN-ME-2026-08-24-devices.sql created it as "one uuid
-- per enrolment session at the station", and every enrol has been stamping it since. It was a
-- grouping label nobody read; this migration is what turns it into the thing a handset can
-- present. Only the timestamp is new, and only because the label alone cannot expire:
-- updated_at moves on every heartbeat, so it cannot say when a batch was issued.
alter table devices
  add column if not exists enrol_batch_at timestamptz;

comment on column devices.enrol_batch is
  'The batch this row was last offered under -- the same uuid across every phone in one bench '
  'session, so one broadcast can reach them all and each handset claims its OWN token by '
  'sending the IMEI it reads off itself. Overwritten by the next enrol. Never a device '
  'credential: that is enrol_token.';
comment on column devices.enrol_batch_at is
  'When the batch was issued. A claim against a batch older than a day is refused: the batch '
  'token is a bearer secret for the length of a bench session and no longer.';

-- A claim is "this batch, and one of these IMEIs" -- the batch narrows it to a handful of rows
-- and the IMEI check then runs over those. Partial, because the overwhelming majority of rows
-- carry no batch at all once their session is over.
create index if not exists devices_enrol_batch_idx
  on devices (enrol_batch) where enrol_batch is not null;
