-- =============================================================================================
-- ONE COLUMN, SO A LOCK ORDER CAN REACH A PHONE IN A SECOND INSTEAD OF A MINUTE.
-- =============================================================================================
--   "funga and fungua and release should not take even a minute"
--   "build the FCM push"
--
-- Firebase hands every installed app a "registration token" -- an address for that one
-- handset, on the connection Google already keeps open to it. The phone reports its own
-- token on the heartbeat; the office sends a wake-up to that address when somebody presses
-- Funga, Fungua or Achia, and the handset beats immediately rather than at its next turn.
--
-- THIS IS NOT THE SAME THING AS enrol_token, and confusing the two would be bad:
--
--   enrol_token  is a SECRET we minted. It is the handset's credential -- it proves a beat
--                really came from that phone, and anyone holding it can speak for that row.
--                Never leaves the server except once, to the station provisioning the phone.
--
--   fcm_token    is an ADDRESS Google minted. It is not a secret and proves nothing: holding
--                it lets you ring a doorbell, and the message we send carries no command at
--                all (see push.js). Google rotates it whenever it likes, which is why it is
--                refreshed from the phone rather than set once at enrolment.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

alter table devices add column if not exists fcm_token text;

-- The office presses Funga on twenty phones at once and we look up twenty addresses by IMEI,
-- which the primary key already serves. What this index is for is the other direction: finding
-- the handsets that CAN be woken at all, when somebody asks how much of the fleet is reachable
-- instantly and how much still waits for its beat.
create index if not exists devices_fcm_token_idx on devices (fcm_token) where fcm_token is not null;

comment on column devices.fcm_token is
  'Firebase registration token: an address for waking this handset, refreshed by the phone on '
  'its heartbeat. NOT a credential -- the wake-up carries no command, and the beat it triggers '
  'is authenticated by enrol_token exactly as every other beat is.';
