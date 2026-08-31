-- =============================================================================================
-- AWAY TODAY: SUSPENDING A PERSON FOR A DATE RANGE.
-- =============================================================================================
--   "I need a feature to suspend a user at (Access codes — mfumo (portal)) so that they don't
--    appear anywhere unless reactivated, e.g one credit aint there today so if I suspend him
--    the customer distribution of today is auto to the available ones"
--   "so suspension is recorded by date picker start and end date"
--
-- Two dates on the person, and everything else is read from them.
--
-- WHY A WINDOW AND NOT A SWITCH.
-- ---------------------------------------------------------------------------------------------
-- A switch has to be turned back on by somebody remembering to. The thing being recorded here is
-- an absence -- leave, a course, illness -- and an absence has an end already known on the day it
-- is entered. Recording it as a window means the person comes back by themselves on the right
-- morning, which is the difference between a feature that is used and one that quietly leaves
-- half the company switched off because nobody remembered the Monday.
--
-- There is no scheduler anywhere in this system and this deliberately does not need one: the
-- window is evaluated at READ time against today's date in EAT, so it starts and ends on its own
-- with nothing running in the background.
--
-- BOTH ENDS INCLUSIVE. The 3rd to the 5th is three days off, which is what anybody filling in two
-- date boxes means by it. Reading the end exclusively would put somebody back at work a day early
-- with nothing on any screen to show that arithmetic was the cause.
--
-- AN OPEN END IS INDEFINITE -- "from Monday, until further notice" is a real thing to want, and
-- leaving the second box empty is the natural way to say it. An open START is not: a `to` with no
-- `from` would read as "suspended since the beginning of time", which nobody means by filling in
-- one box, so it counts as no window at all. That is the safe direction -- the failure is one
-- person still at work rather than a department locked out by a half-filled form.
--
-- WHAT IT REACHES.
-- ---------------------------------------------------------------------------------------------
--   * SIGN-IN. A suspended code is refused, and told which window it is in rather than "invalid
--     access code" -- somebody on leave should not spend the morning sure they have forgotten it.
--   * THE CREDIT ROSTER, which is what the owner actually asked for. The deal is recomputed from
--     the roster on every read and nothing is stored, so removing somebody from it redistributes
--     today's customers among the officers who are present, with no orphans and no migration of
--     assignments. See rosterFull() in call-core.js.
--
-- ADMIN IS NEVER SUSPENDED. It is the standing rule everywhere in this system, and here it is
-- also the lockout guard: a window set on the last admin -- a slip of the date picker, or an
-- admin suspending themselves -- would otherwise leave nobody able to lift it.
--
-- Safe to run more than once, like every migration in this folder.
-- =============================================================================================

alter table access_codes
  add column if not exists suspend_from date,
  add column if not exists suspend_to   date;

comment on column access_codes.suspend_from is
  'First day of an absence, inclusive. Null means not suspended. A suspended code cannot sign '
  'in and is dropped from the credit roster, so today''s customers are dealt among the people '
  'who are actually present. ADMIN codes are exempt -- that is the lockout guard.';
comment on column access_codes.suspend_to is
  'Last day of the absence, inclusive. Null with a suspend_from set means indefinite. A '
  'suspend_to with no suspend_from is not a window at all and is ignored.';

-- Every read of this asks "is anyone suspended today", over a table of a few dozen rows. An
-- index would be read past rather than used, exactly as with is_leader.
