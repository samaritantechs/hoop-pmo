-- =============================================================================================
-- OLD STOCK GAINS A LOCATION, so a ground visit can be planned by where it is going.
-- =============================================================================================
--   "add location column in old stock since this operation to visit it is better when we can
--    pivot by not just RSM but location too - the location we used as in PCOs calling not the
--    kinondoni default"
--
-- WHICH LOCATION, AND WHY THAT ONE.
-- ---------------------------------------------------------------------------------------------
-- There are two location-shaped fields on the loan book and only one of them is a place:
--
--   watu_loans.team    derived from the shop string "Hoop Limited, Kinondoni", so it reads
--                      KINONDONI for EVERY row this dealer has. It is the company's own
--                      address, not the customer's or the agent's, and pivoting by it gives
--                      one bar. This is the "kinondoni default" and it is not used here.
--
--   watu_loans.branch  the real branch, which rides in on the offline queue -- the PCOs' own
--                      portfolio sheet, the one they work their calls from. That is the
--                      location the office already talks in, so it is the one this uses.
--
-- THE COLUMN IS WHERE THE ANSWER IS KEPT, not merely where a future sheet could put one.
-- Sipho's September list carried no location, so the pane works one out from the HOLDER -- their
-- branch on the staff register first, then the branch their own sales carry on the loan book --
-- AND THEN WRITES IT DOWN.
--
--   "we always fall to another alternative if that data is not somewhere, and if such data is
--    permanent stamp it permanent rather always fetching yet watu deletes the data per time"
--
-- That is the whole reason this is a column and not a join. The loan book is re-uploaded over
-- itself with rows gone, so an agent whose sales have since been trimmed out of the deck would
-- lose their location on the next read -- the pane would go from naming a town to a dash, with
-- nothing on screen to say why, on the list a van is dispatched from. Worked out once, stamped,
-- and never overwritten.
--
-- location_from REMEMBERS WHICH KIND OF ANSWER IT WAS, because the stamp would otherwise make a
-- derived place indistinguishable from a declared one the moment it landed -- and they are
-- different claims. `stated` was written on the handset; `staff` and `sales` were worked out.
--
-- A HANDSET WITH NO KNOWN LOCATION READS AS UNKNOWN, never as Kinondoni and never as blank-
-- means-head-office. Guessing a place would send a van to it.
--
-- Safe to run more than once.
-- =============================================================================================

alter table old_stock add column if not exists location      text;
alter table old_stock add column if not exists location_from text;

create index if not exists old_stock_location_idx on old_stock (location);

comment on column old_stock.location is
  'Where this handset is, for planning a visit. STAMPED, not joined: worked out once from the '
  'holder and written here, because the loan book it is derived from is re-uploaded with rows '
  'deleted and a location that vanished would send nobody anywhere. Never watu_loans.team -- '
  'that reads KINONDONI for every row this dealer has, because it is the shop''s own address.';
comment on column old_stock.location_from is
  'stated = written on the handset itself; staff = the holder''s branch on the staff register; '
  'sales = the branch their own sales carry. A stamped guess must not read as a declared fact.';

-- DID IT LAND?
-- select column_name from information_schema.columns
--   where table_name = 'old_stock' and column_name in ('location', 'location_from');
--
-- HOW MUCH OF THE MAP IS FILLED IN, after the pane has been opened once:
-- select coalesce(location_from, '(not worked out yet)') as source, count(*)
--   from old_stock group by 1 order by 2 desc;
