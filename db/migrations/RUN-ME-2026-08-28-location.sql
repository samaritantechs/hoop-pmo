-- =============================================================================================
-- WHERE THE PHONE WAS WHEN IT LAST SPOKE.
-- =============================================================================================
--   "the management gets headache on aged stock [stolen, lost, sold-by-cash etc] am asked if
--    the app could trap last sync with location coordinates"
--
-- The accountability report can already say WHICH handsets are unaccounted for. What it cannot
-- say is where any of them is, so every unaccounted IMEI ends the same way: a name, a phone
-- call, and somebody's word about what happened to it. A coordinate on the last sync turns
-- that into a place to go -- and, just as often, into evidence that a phone reported "sold by
-- cash" has been sitting in the same shop for three weeks.
--
-- FOUR COLUMNS, AND THE FOURTH IS THE ONE THAT KEEPS THE OTHER THREE HONEST:
--
--   last_lat / last_lng  where the handset was
--   last_loc_acc         how sure it is, in metres. A 2000m fix is a suburb, not an address,
--                        and showing it as a pin would send somebody to the wrong building.
--   last_loc_at          WHEN that fix was taken -- which is NOT when the phone last beat.
--
-- That last distinction is the whole reason this is stored rather than inferred. The handset
-- reports its LAST KNOWN position, because asking for a live GPS fix on every beat would eat a
-- customer's battery for a question nobody is asking most days. So a phone that beat a minute
-- ago can be carrying a fix from Tuesday. Recording the two times separately is what stops the
-- register quietly claiming a phone is somewhere it left days earlier.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

alter table devices add column if not exists last_lat     double precision;
alter table devices add column if not exists last_lng     double precision;
alter table devices add column if not exists last_loc_acc integer;
alter table devices add column if not exists last_loc_at  timestamptz;

comment on column devices.last_lat is
  'Latitude of the handset''s last known position, as reported on a heartbeat. See last_loc_at: '
  'this is NOT necessarily where the phone was at that heartbeat.';
comment on column devices.last_loc_acc is
  'Radius of confidence in metres. Large numbers mean a cell-tower estimate, not a pin.';
comment on column devices.last_loc_at is
  'When the position fix itself was taken, which can be much earlier than last_seen. The phone '
  'reports its LAST KNOWN location rather than waking the GPS on every beat, so these two '
  'timestamps must never be collapsed into one.';

-- Finding the stock that has gone quiet is the query this exists for, and it always starts
-- from "has it got a position at all".
create index if not exists devices_last_loc_at_idx on devices (last_loc_at) where last_loc_at is not null;
