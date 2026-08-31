-- =============================================================================================
-- THE APPROVAL NAV IS A PERSON, NOT JUST A ROLE.
-- =============================================================================================
--   "The ones i grant approval role can only see data of the same role to keep confidentiality
--    of departments so when one of the credits is granted approval then only has access to
--    credit advances but the advance report nav compose all the company ... all access codes
--    should have a button to switch that that person is a leader in ther role so those with
--    that switch on can extend to approval nav"
--
-- Two separate ideas, and this column is the second of them.
--
-- 1. CONFIDENTIALITY BY DEPARTMENT. An approver sees only advances asked for by people of
--    THEIR OWN ROLE. A credit leader approves credit advances and cannot read what the store
--    or IT are borrowing. That needs no schema: staff_role is already stamped on every
--    advance row, and the server compares it with the approver's own role.
--
-- 2. WHO IS A LEADER. Granting advappr to a role would hand the approval pane to EVERY code
--    holding that role -- every credit officer, not the one who leads them. Roles are the
--    grant mechanism everywhere else in this system and that is right, but "is this particular
--    person the leader of their department" is a fact about the PERSON, not about the role,
--    and there is nowhere else to put it.
--
-- So the approval pane needs BOTH: the nav ticked on the role, AND this switch ticked on the
-- individual. Either one alone is not enough.
--
-- WHY THE DEFAULT IS false, AND WHY THAT IS THE SAFE DIRECTION.
-- ---------------------------------------------------------------------------------------------
-- Every existing code becomes "not a leader" the moment this runs, so the approval pane closes
-- until somebody is deliberately ticked. That is the correct direction for a confidentiality
-- feature: the failure mode of a wrong default here is one person having to be re-ticked, and
-- the failure mode of the other default is every officer reading every department's borrowing.
--
-- ADMIN IS UNAFFECTED. Admin holds every pane everywhere in this system by rule, and reads
-- every role's advances regardless of this switch. So does a read-only AUDITOR code, which can
-- see everything and change nothing.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

alter table access_codes
  add column if not exists is_leader boolean not null default false;

comment on column access_codes.is_leader is
  'This person leads their role/department. Required IN ADDITION to the advappr nav before the '
  'salary-advance approval pane opens, and it is a fact about the person rather than the role -- '
  'granting advappr to CREDIT must not hand the pane to every credit officer. ADMIN and '
  'read-only AUDITOR codes bypass it entirely.';

-- The approval pane asks one question of this table -- "is the signed-in code a leader" -- and
-- it asks it by primary key, which is already indexed. No index is added here on purpose: a
-- boolean over a table of a few dozen rows would be read past, not used.
