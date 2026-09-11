-- =============================================================================================
-- THE SHIFT -- handing a phone to another office's system, without a cable and without a reset.
-- =============================================================================================
--   "and a phone 'achia' from hope or hope can be re-enrolled in the other company and works
--    with its same token and also we need shift action for one or bulk as lock and unlock does
--    so another button for shift so that hoop can shift a device to hope and viceversa saving
--    re-enlorrment energy"
--   "when we shift it goes with current state"
--
-- WHAT A SHIFT IS, AND WHAT IT IS DELIBERATELY NOT. A handset can hold exactly one Device
-- Owner. It cannot be re-pointed at a different owner without dropping that role first, and
-- dropping it needs a factory reset -- the very cost this was asked to remove. So a shift never
-- touches Device Owner at all: it only changes WHICH SERVER this phone's next beat is sent to,
-- and WHICH TOKEN it presents there. Everything else -- the lock screen, whether the screen is
-- currently up, the restrictions -- rides along untouched, which is the whole of "goes with
-- current state": nobody has to implement that, because nothing here writes over it.
--
-- WHY THE SERVER URL IS NEVER TYPED BY THE OPERATOR. EnrolReceiver already refuses to change a
-- phone's server after first enrolment, on purpose: an exported receiver that accepted one would
-- let any app on the phone re-point it at a server of its choosing, which is a complete bypass.
-- A shift does not reopen that door -- it fires from a BEAT RESPONSE, which only the office this
-- phone is CURRENTLY reporting to can shape, and that office already has the power to tell this
-- phone to lock. Handing it the power to say where the phone reports next is not a larger claim.
-- What DOES need guarding is a typo or a compromised session redirecting the fleet to the wrong
-- place -- so the destination address lives in `settings.DEVICE_SHIFT_TARGETS`, set once by an
-- administrator, and the operator issuing a shift only ever PICKS a name off that list. The one
-- thing they paste is the TOKEN the destination minted for this one IMEI -- the same shape as
-- pasting a token into an enrol command today, and no more dangerous than that already is.
--
-- Safe to re-run.

alter table devices add column if not exists shift_target text;
alter table devices add column if not exists shift_server text;
alter table devices add column if not exists shift_token text;
alter table devices add column if not exists shift_requested_at timestamptz;
alter table devices add column if not exists shift_requested_by text;

create index if not exists idx_devices_shift_pending on devices(shift_target)
  where shift_target is not null;

comment on column devices.shift_target is
  'Short key naming which office system this phone is being handed to, e.g. HOPE. Matched '
  'against settings.DEVICE_SHIFT_TARGETS; null means no shift pending.';
comment on column devices.shift_server is
  'The destination''s beat URL, copied from settings.DEVICE_SHIFT_TARGETS at the moment the '
  'shift was issued -- never typed by the operator, so a redirect can only come from what an '
  'administrator configured, not from a slip on this form.';
comment on column devices.shift_token is
  'The token the DESTINATION system minted for this IMEI, pasted in by the operator issuing '
  'the shift. This phone presents it on its first beat to the new office.';
comment on column devices.shift_requested_at is
  'When the shift was queued. Compared against last_seen to tell a shift that landed (this '
  'IMEI has gone quiet since) from one that has not (it kept beating here, so the token or '
  'address the other office handed over was wrong).';
comment on column devices.shift_requested_by is
  'The signed-in code that issued the shift, for the same reason every other order here is '
  'stamped with one.';

-- =============================================================================================
-- THE ALLOWLIST. Empty until an administrator fills it in, which is deliberate: the Shift
-- button ships with nothing to offer until somebody who holds Settings has typed a real office
-- and a real URL, exactly like every other "not configured yet" pane in this system.
--
-- Shape: {"HOPE": {"label": "HOPE LOAN", "server": "https://hope-pmo.vercel.app"}}
-- =============================================================================================
insert into settings (key, value) values
  ('DEVICE_SHIFT_TARGETS', '{}')
on conflict (key) do nothing;

-- Verify: every column above should show up here.
-- select column_name from information_schema.columns
--  where table_name = 'devices' and column_name like 'shift_%' order by 1;
