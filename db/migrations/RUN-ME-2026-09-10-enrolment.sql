-- =============================================================================================
-- ENROLMENT: the required details, the completeness check, and the RSM being told.
-- =============================================================================================
--   IT SOP A.1  "Collect the required details: FULL NAME, ID NUMBER, CONTACT INFORMATION, and
--                REFEREES, from the RSM/team leader."
--   IT SOP A.2  "Enter the details into the system accurately and completely."
--   IT SOP A.3  "VERIFY DATA COMPLETENESS BEFORE ACTIVATING THE ACCOUNT."
--   IT SOP A.4  "Notify the RSM/General Manager once enrollment is complete."
--   RSM SOP E.1 "Confirm with the IT Officer that all agents/team leaders are enrolled with
--                correct, complete details."
--   CSM SOP H.1 "...properly enrolled in the system with correct and complete details."
--
-- THREE SOPs ASK THE SAME QUESTION AND NOTHING COULD ANSWER IT. The register (hoop_agents)
-- arrives by uploading Sipho's SyscoPos page: it is a list, with no notion of a field being
-- missing, no notion of a record being CHECKED, and no way to tell an RSM their person is on
-- it. So "are all your agents enrolled with complete details" was answered by scrolling.
--
-- A.3 IS THE ONLY STEP HERE THAT IS A GATE. Everything else in this file is bookkeeping; A.3
-- says completeness is verified BEFORE the account is activated, which means activation has to
-- be a thing somebody does rather than a column that arrives set to true. So there is exactly
-- one way to switch an account on, and it counts the missing fields first and refuses.
--
-- REFEREES IS PLURAL IN THE SOP AND SINGULAR IN THE TABLE. There was one next-of-kin slot.
-- A second is added rather than the first being reinterpreted, because a column that quietly
-- changes meaning is worse than a column that is missing.
--
-- Safe to run more than once.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. THE SECOND REFEREE (SOP A.1, "referees").
-- ---------------------------------------------------------------------------------------------
alter table hoop_agents add column if not exists kin2_name text;
alter table hoop_agents add column if not exists kin2_phone text;
alter table hoop_agents add column if not exists kin2_relationship text;
comment on column hoop_agents.kin2_name is
  'The SECOND referee. SOP A.1 says "referees"; the register had one slot, and a slot that '
  'quietly starts meaning something else is worse than one that is missing.';

-- ---------------------------------------------------------------------------------------------
-- 2. WHO ENTERED IT, WHO CHECKED IT, AND WHO WAS TOLD (SOP A.2, A.3, A.4).
--    Stamped from the session at the time, never joined afterwards -- the same rule every
--    other table here follows.
-- ---------------------------------------------------------------------------------------------
alter table hoop_agents add column if not exists enrolled_by text;
alter table hoop_agents add column if not exists enrolled_at timestamptz;

-- A.3. The account is activated by the same act that records the check, so there is no way to
-- have one without the other.
alter table hoop_agents add column if not exists verified_by text;
alter table hoop_agents add column if not exists verified_at timestamptz;

-- A.4. WHO was told, and WHEN -- not merely that somebody meant to.
alter table hoop_agents add column if not exists notified_at timestamptz;
alter table hoop_agents add column if not exists notified_to text;

-- Why an account was switched off, so a register that only ever grew can be read honestly.
alter table hoop_agents add column if not exists enrol_note text;

comment on column hoop_agents.verified_at is
  'IT SOP A.3: the moment somebody confirmed every required detail was present. Setting this '
  'and setting active=true are one act, so an account cannot be live without having been '
  'checked. A later edit that empties a required field clears it again.';

create index if not exists hoop_agents_verified_idx on hoop_agents (verified_at);
create index if not exists hoop_agents_branch_idx on hoop_agents (branch);

-- ---------------------------------------------------------------------------------------------
-- 3. WHO IS TOLD (SOP A.4, "the RSM/General Manager").
--    Either plain addresses, or one BRANCH=address per line so each region's RSM hears about
--    their own people -- the same shape as ISSUES_EMAIL. A branch with no line of its own
--    falls back to any plain address here, and then to GM_EMAIL. Blank means nobody is
--    emailed and the pane is still the record.
-- ---------------------------------------------------------------------------------------------
insert into settings (key, value) values
  ('ENROL_EMAIL', '')
on conflict (key) do nothing;
