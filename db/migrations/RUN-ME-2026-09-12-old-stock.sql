-- =============================================================================================
-- OLD STOCK -- the handsets we hold that were never enrolled into our lock.
-- =============================================================================================
--   "For an OLD STOCK new nav pane for all those stock that imei no does not exist in our new
--    enrolled phones. So we have NEW STOCK and OLD STOCK (never enrolled)."
--
--   "They start reading with those aging days off, so everyday that goes they've not yet been
--    enrolled they continue to count aging."
--
--   "We'll conduct ground visits to all our previous agents and lock all stock we find, and once
--    a stock in OLD STOCK is enrolled into our lock then it moves to list of NEW STOCK."
--
-- WHY THIS IS A LIST AND NOT A FLAG. Every phone in it is one we have never touched: no device
-- row, no token, no beat. There is nowhere else to put it -- `devices` is the register of what we
-- CONTROL, and writing an un-enrolled handset in there would make every locked-phone count wrong
-- on every pane that reads it.
--
-- THE AGE CARRIES ITS OWN ZERO DATE, and that is the whole of the ageing rule.
-- ---------------------------------------------------------------------------------------------
-- `age_days` is what the stock report said ON `as_of` -- a number that was true one morning. The
-- age today is therefore `age_days + (today - as_of)`, worked out on every read, and it keeps
-- climbing for as long as the phone stays un-enrolled. Storing "the age" as one number and
-- re-saving it daily would need a job nobody would run; storing the number AND the day it was
-- true needs nothing at all and cannot drift.
--
-- NOTHING MARKS A ROW AS MOVED, either. A handset is in OLD STOCK exactly while it is absent from
-- `devices` and absent from the sale book -- both of which are asked at read time. A `moved`
-- column would be a second opinion about a question the data already answers, and the day the two
-- disagreed the phone would be in both lists or neither.
--
-- Safe to run more than once.
-- =============================================================================================

create table if not exists old_stock (
  imei        text primary key,          -- the serial as the stock report spells it: 15 digits
  item        text,                      -- SAMSUNG A07-64GB, ITEL A100Cs 64GB, ...
  agent       text,                      -- who is holding it
  agent_phone text,
  rsm         text,                      -- and who they answer to, as the sheet pairs them
  rsm_phone   text,
  /* THE TWO HALVES OF AN AGE. Neither is any use without the other: a number with no day is a
     figure that quietly stops being true, and a day with no number is not an age at all. */
  age_days    integer,
  as_of       date not null,
  source      text,                      -- which list this row came off, for when two disagree
  added_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists old_stock_agent_idx on old_stock (agent);
create index if not exists old_stock_rsm_idx   on old_stock (rsm);
create index if not exists old_stock_as_of_idx on old_stock (as_of);

comment on table old_stock is
  'Stock we hold that has never been enrolled into the lock. A row leaves this list by appearing '
  'in `devices` (we locked it) or in the sale book (it sold) -- both asked at read time, so '
  'nothing here has to be marked as moved.';
comment on column old_stock.age_days is
  'The age in days AS OF the `as_of` date. Today''s age is age_days + (today - as_of): the number '
  'and the day it was true, so the age keeps climbing without anything having to re-save it.';
comment on column old_stock.as_of is
  'The day age_days was true. Never null -- an age with no zero date cannot be read.';
