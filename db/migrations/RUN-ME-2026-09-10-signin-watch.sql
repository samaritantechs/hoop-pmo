-- =============================================================================================
-- THE DOOR'S OWN LOG -- who tried to get in, and who got in.
-- =============================================================================================
--   IT SOP D  "Access Controls: set and maintain user access controls so only authorized
--              personnel can view or edit sensitive information."
--   IT SOP D  "Monitoring: MONITOR FOR UNAUTHORIZED ACCESS and act immediately on any breach,
--              including changing the affected password."
--   IT SOP E  the weekly report to the General Manager on "system performance ... and technical
--              issues", of which the door is the first line.
--
-- THE ONE SENTENCE THIS SYSTEM COULD NOT ANSWER. audit_log records what people DID once they
-- were inside, and it is written by audited() in api/_lib/audit.js -- which runs AFTER the
-- door. A refused sign-in threw before it and left nothing anywhere: somebody could sit and
-- guess access codes all night and the system's own record of the night would be empty. "We
-- monitor for unauthorized access" was, until this table, not true.
--
-- NOTHING HERE IS A WORKING CREDENTIAL, and that is the whole design.
--   * code_key is a SHA-256 of the code, truncated. It groups a hundred attempts at the same
--     wrong code into one line, and it cannot be typed into the sign-in box.
--   * code_masked is the first character and the length -- "K•••••" -- which is what a person
--     needs to recognise their own typo, and useless to anybody else.
--   * the code itself is never written, not on a failure and not on a success.
-- A security log that holds the keys is a bigger hole than the one it was dug to watch.
--
-- SUCCESSES ARE KEPT ONCE A DAY, NOT ONCE A REQUEST. Every portal call goes through the same
-- door, so a row per call would be tens of thousands a day and would bury the twelve that
-- matter. One row per code per door per EAT day answers "who used the system on Tuesday" --
-- which is the shape of the question -- for a rounding error of the writes.
--
-- Safe to run more than once.
-- =============================================================================================

create table if not exists signin_attempts (
  id           uuid primary key default gen_random_uuid(),
  at           timestamptz not null default now(),

  -- The EAT day, stored as text, because "once a day" has to be keyed on the day in Dar es
  -- Salaam and not the day in UTC -- a night shift signing in at 01:00 is still that night.
  day          text not null,

  -- WHICH DOOR. The portal and the upload page share one (an access code); the phone app has
  -- its own (a phone number with either an access code or the team code).
  door         text not null check (door in ('portal', 'upload', 'app')),

  ok           boolean not null default false,
  -- WHY it was refused, from the throw itself rather than guessed from its wording.
  --   invalid      no such code / no such team code
  --   suspended    a real code, refused because that person is away (SOP: access controls)
  --   closed       the admin's system switch is off; everybody is refused
  --   switched_off the app account is inactive
  --   unknown_phone a phone that is not on the agents register tried to register
  --   view_only    an AUDITOR code tried to take a handset
  --   refused      anything else the door said no to
  outcome      text not null,

  -- WHAT WAS TRIED, in a form that can be counted and cannot be used. See the header.
  code_key     text,
  code_masked  text,
  -- The app door is keyed on a phone number, which IS the identity there; masked the same way.
  phone_masked text,
  device       text,

  -- WHO, when the code resolved to somebody real (a suspended code, or any success). Stamped
  -- from the row at the time, never joined afterwards.
  who_name     text,
  who_role     text,

  detail       text,
  ip           text,
  ua           text,

  -- SOP D's second half: "act immediately on any breach". What was actually done about it,
  -- by whom, so a line that has been dealt with stops shouting and the answer is on the row.
  reviewed_by  text,
  reviewed_at  timestamptz,
  review_note  text
);
comment on table signin_attempts is
  'Every refusal at the door, and one row per code per day for the sign-ins that worked '
  '(IT SOP D "monitor for unauthorized access"). Holds no working credential: the code is '
  'stored as a truncated SHA-256 for grouping and as a first-character mask for recognition.';

create index if not exists signin_attempts_at_idx on signin_attempts (at desc);
create index if not exists signin_attempts_bad_idx on signin_attempts (at desc) where not ok;
create index if not exists signin_attempts_key_idx on signin_attempts (code_key, at desc);
create index if not exists signin_attempts_day_idx on signin_attempts (day);

-- ONE SUCCESS PER CODE PER DOOR PER DAY. The writer upserts and ignores the duplicate, so the
-- several serverless instances serving one morning cannot each add their own copy.
create unique index if not exists signin_attempts_ok_once
  on signin_attempts (day, door, code_key) where ok;

-- HOW MANY FAILURES IN A ROW COUNT AS SOMEBODY TRYING RATHER THAN SOMEBODY TYPING BADLY.
-- Five is the SOP's spirit rather than its letter -- it names no number -- and it is a setting
-- so the office can move it without a deploy. Blank falls back to 5.
insert into settings (key, value) values
  ('SIGNIN_ALERT_FAILS', '5')
on conflict (key) do nothing;

-- WHO IS TOLD when the door has a bad night. Blank means nobody and the pane is still the
-- record, exactly as with every other email key here.
insert into settings (key, value) values
  ('SECURITY_EMAIL', '')
on conflict (key) do nothing;
