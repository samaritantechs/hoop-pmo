-- =============================================================================================
-- ISSUES ROUTED TO A ROLE, AND OPTIONALLY TO ONE PERSON IN IT.
-- =============================================================================================
--   "So when someone reports an issue they choose who to report to by choosing role and next
--    (option) user in the role, so on the desks every user sees what they have on desk -- one
--    issue for all in the role or for the directed individual."
--
-- THE DEPARTMENT WAS A FIXED LIST IN CODE. Eight names, chosen once, with no relationship to
-- the roles the owner actually creates in Access codes -- so an issue could be filed to "IT"
-- while the person who does IT work holds a role called something else entirely, and the desk
-- showed everybody everything regardless.
--
-- A ROLE IS WHAT THE OWNER ALREADY MAINTAINS. It is the same list they tick navs on, so routing
-- to a role needs no second vocabulary that will drift out of step with the first.
--
-- TO_NAME IS OPTIONAL, AND THAT IS THE FEATURE. Blank means the whole role -- anybody holding
-- it sees it on their desk and any of them may pick it up. Filled means one person, and it sits
-- on that person's desk alone. One column, two behaviours, and the raiser chooses.
--
-- THE DEPARTMENT COLUMN STAYS. Existing rows carry one, the issues report groups by it, and
-- dropping a column that rows depend on to satisfy a rename is how a report goes blank. It
-- simply stops being required.
--
-- Safe to run more than once.
-- =============================================================================================

-- WHOSE DESK IT LANDS ON. The role as Access codes spells it, upper-cased.
alter table issues add column if not exists to_role text;
-- ...and, optionally, WHICH person in that role. Their name as their access code says it.
alter table issues add column if not exists to_name text;

comment on column issues.to_role is
  'Whose desk this is on: the role, as Access codes spells it. Blank on rows raised before '
  'routing existed -- those fall back to `department`.';
comment on column issues.to_name is
  'One person in that role, or blank for everybody in it. Blank is not a missing value: it is '
  'the raiser saying "whoever gets to it first".';

create index if not exists issues_to_role_idx on issues (to_role) where to_role is not null;
create index if not exists issues_to_name_idx on issues (to_name) where to_name is not null;

-- THE DEPARTMENT IS NO LONGER REQUIRED. A role need not be one of the eight names this list was
-- born with, and refusing an issue because the owner's role vocabulary has moved on would stop
-- the log rather than route it.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'issues'
               and column_name = 'department' and is_nullable = 'NO') then
    alter table issues alter column department drop not null;
  end if;
end $$;
