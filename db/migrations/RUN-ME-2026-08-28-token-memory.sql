-- =============================================================================================
-- ONE IMEI, ONE TOKEN, EVEN ACROSS A DELETE.
-- =============================================================================================
--   "then futa shouldnt lose token record"
--
-- Deleting a device row destroyed its token, and re-enrolling the same IMEI minted a new one.
-- That is correct for a handset genuinely leaving the register for good -- and catastrophic for
-- the far commoner case, a phone being started over on a bench, because the HANDSET still holds
-- the old token and nothing wiped it.
--
-- From that moment the register and the phone are two different opinions. Every beat comes back
-- 403: no lock, no unlock, no release. Worse, the way out is blocked too -- the phone is still
-- Device Owner, so it refuses the factory reset that would clear it, and the office cannot
-- release it because the release travels through a token the phone does not recognise. A brick,
-- produced by pressing a delete button.
--
-- So the token outlives the row. On delete it is remembered here; on enrolment an IMEI that has
-- been here before gets ITS OWN token back rather than a new one. A phone that was never wiped
-- simply works again.
--
-- WHAT THIS DELIBERATELY DOES NOT KEEP: history.
--
--   "I used futa at devices I expect non of its previous histories"
--
-- device_events is still deleted with the row, and stays deleted. Those are two different asks
-- and both are right: the operator wants the phone's PAST gone, not its IDENTITY changed. This
-- table holds one string per IMEI and nothing else -- no states, no reasons, no dates of things
-- that happened.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

create table if not exists device_tokens (
  imei        text primary key,
  enrol_token text not null,
  retired_at  timestamptz not null default now(),
  retired_by  text
);

comment on table device_tokens is
  'Remembers the enrol_token of a deleted device row so re-enrolling the same IMEI hands the '
  'handset back the identity it is still carrying. Identity only -- history is not kept here, '
  'and device_events is still deleted with the row.';
comment on column device_tokens.enrol_token is
  'The token this IMEI last held. Re-enrolment reuses it rather than minting, so a phone that '
  'was deleted but never wiped keeps working.';
