-- =============================================================================================
-- ONE TEST HANDSET, TAKEN BACK OUT -- IMEI 350115221882295
-- =============================================================================================
--   "this in my own phone in new stock i was trying to enroll it and making transfers between
--    hope and hoop i need it deleted in db too"
--
-- A handset that was only ever a rehearsal leaves rows in more places than the one pane it is
-- showing on. Enrolment writes the register row AND the credential kept beside it; the NEW STOCK
-- pane reads a stamp of its own, which is why a serial keeps appearing there after the register
-- row is gone; every lock, shift and hand-over writes a history line; and a transfer document
-- remembers a serial whether or not the phone was ever enrolled at all. Delete `devices` on its
-- own and the serial is still standing in somebody's stock tomorrow morning.
--
-- WHAT THIS DELETES -- the handset's own rows, and nothing that is merely about it:
--   devices           the register row (this one: unlocked, never checked in)
--   device_tokens     the enrol token remembered so a re-enrolled phone keeps its identity
--   device_events     its history -- enrolled, locked, shifted, handed over
--   stock_audit       the NEW STOCK stamp; the row that keeps the serial on that pane
--   old_stock         the OLD STOCK list, if it ever reached it
--   hoop_aged_stock   the aged-stock feed's row -- the same serial in warehouse clothes
--   transfer_items    any transfer line still naming it
--
-- WHAT THIS ONLY COUNTS, and names on the way past:
--   hoop_sales, watu_loans        other people's uploads, re-loaded every morning. A row deleted
--                                 here is back by lunchtime, so the fix for those is the
--                                 spreadsheet, not the database.
--   issues, loss_cases, topups, stock_handover_items
--                                 documents ABOUT a handset, not the handset. Deleting one from
--                                 under the pane that owns it leaves somebody waiting on a
--                                 ticket that no longer exists; they are closed on their own
--                                 screen.
--
-- Every table is looked up before it is touched, so this runs on a database that has not had all
-- the migrations yet and SAYS which ones it skipped rather than dying on the first one missing.
-- Safe to run more than once: the second run deletes nothing and reports zero.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- STEP 1. The delete, one line of output per table. Read the notices.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  target text   := '350115221882295';
  mine   text[] := array[
    'devices:imei', 'device_tokens:imei', 'device_events:imei', 'stock_audit:imei',
    'old_stock:imei', 'hoop_aged_stock:serial', 'transfer_items:imei'];
  theirs text[] := array[
    'hoop_sales:imei', 'watu_loans:imei', 'issues:imei', 'loss_cases:imei',
    'topups:imei', 'stock_handover_items:imei'];
  spec   text;
  t      text;
  c      text;
  n      integer;
  total  integer := 0;
  gone   integer := 0;
begin
  foreach spec in array mine loop
    t := split_part(spec, ':', 1);
    c := split_part(spec, ':', 2);
    if to_regclass('public.' || t) is null then
      gone := gone + 1;
      raise notice '%  --  haipo kwenye database hii / no such table here, skipped', t;
      continue;
    end if;
    execute format('delete from public.%I where %I = $1', t, c) using target;
    get diagnostics n = row_count;
    total := total + n;
    raise notice '%  --  % row(s) deleted', t, n;
  end loop;

  raise notice '-----------------------------------------------------------------';
  raise notice 'IMEI %  --  % row(s) removed altogether%', target, total,
               case when gone > 0 then ', ' || gone || ' table(s) skipped as missing' else '' end;

  foreach spec in array theirs loop
    t := split_part(spec, ':', 1);
    c := split_part(spec, ':', 2);
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('select count(*) from public.%I where %I = $1', t, c) into n using target;
    if n > 0 then
      raise notice 'LEFT ALONE: %  --  % row(s) still name this serial; read the header first.', t, n;
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------------------------------
-- STEP 2. What is left of it. No rows is the right answer.
-- ---------------------------------------------------------------------------------------------
select 'devices'      as jedwali, imei, holder::text as mikononi, state::text as hali, enrolled_at as lini
  from devices     where imei = '350115221882295'
union all
select 'stock_audit', imei, agent::text,               null::text,                     first_at
  from stock_audit where imei = '350115221882295'
union all
select 'old_stock',   imei, agent::text,               rsm::text,                      added_at
  from old_stock   where imei = '350115221882295';


-- ---------------------------------------------------------------------------------------------
-- STEP 3. WHILE YOU ARE HERE: where the training acceptances left the stock. Nothing is changed.
--
-- Accepting a transfer IS the write that moves stock: the holder on every serial in the document
-- is overwritten to the receiver -- `devices.holder` on the register, `old_stock.agent` and the
-- `rsm` beside it on the old list -- and from that moment those handsets are in the receiver's
-- Stock window, their NEW STOCK and their OLD STOCK, exactly as if they had been handed over at
-- the counter. Deleting the document afterwards moves nothing back, and the previous holder is
-- deleted with it.
--
-- What survives a deleted document is the clock. An acceptance stamps `updated_at` on every row
-- it touched, all of them to the same instant, so the groups below ARE those acceptances: one
-- group per document, `idadi` is how many serials it moved and `mikononi` is who is holding them
-- today. A group sitting under a training receiver is stock that has not been put back.
--
-- To put a group back, send it: open Transfers -> Tuma as that receiver (or have them do it),
-- paste the serials from `imei` below, and send them to whoever should be holding them. That is
-- the same write, run the right way round, and it leaves a document saying so.
-- ---------------------------------------------------------------------------------------------
select x.orodha,
       x.mikononi,
       x.updated_at                              as ilihamishwa,
       count(*)                                  as idadi,
       string_agg(x.imei, ', ' order by x.imei)  as imei
  from (
         select 'devices'   as orodha, imei, holder as mikononi, updated_at from devices
         union all
         select 'old_stock',           imei, agent,               updated_at from old_stock
       ) x
 where x.updated_at >= timestamptz '2026-09-16 00:00:00+03'
   and x.updated_at <  timestamptz '2026-09-17 00:00:00+03'
 group by x.orodha, x.mikononi, x.updated_at
 order by x.updated_at;
