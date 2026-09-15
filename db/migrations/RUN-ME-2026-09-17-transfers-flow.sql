-- =============================================================================================
-- TRANSFERS, SECOND HALF: SENT / ACCEPTED / DECLINED, AND WHO IS WHO.
-- =============================================================================================
--   "RSM requests stock from sipho.
--    1. Sipho / Store transfers them to RSM -- IMEI, To and Fro names, Tarehe, Qty, Model
--    2. RSM to Agents -- supplying
--    3. Agent to RSM (the returns for re-allocations)
--    4. RSM / Agent to Sipho / Store
--    5. RSM to RSM (Sipho does it on system, they log in to sign)"
--   "Transfers -- Window 3: Stock (each can see stock in their possession), Send (can select
--    imei no or input list of imei nos and search system user to send to), Receive (find
--    received and decline or accept to overwrite stock ownership)"
--
-- RUN db/migrations/RUN-ME-2026-09-16-transfers.sql FIRST. That file is the document; this one
-- is what happens to it. Paste the WHOLE FILE into the Supabase SQL editor and run it once.
-- Safe to re-run: every statement is `add column if not exists` / `create index if not exists`,
-- and the one UPDATE only touches rows that have no status yet.
--
-- WHAT CHANGES. A transfer now has a STATUS: `sent` while it waits for the receiver, `accepted`
-- once they have signed for it -- which is also the moment the holder on every handset in it is
-- overwritten (devices.holder, old_stock.agent) -- or `declined`, with a reason, and nothing
-- moved. The two parties are SYSTEM USERS (access codes with the RSM / AGENT / STORE role) and
-- their role is stamped on the document, so the printed copy says an RSM handed to an agent
-- without anybody having to look it up later.
--
-- UNTIL THIS RUNS, the Transfers pane still opens and still prints; Send and Receive say which
-- file to run. Nothing 500s.
-- =============================================================================================

alter table transfers add column if not exists status         text not null default 'sent';
alter table transfers add column if not exists from_role      text;
alter table transfers add column if not exists to_role        text;
alter table transfers add column if not exists accepted_at    timestamptz;
alter table transfers add column if not exists accepted_by    text;
alter table transfers add column if not exists declined_at    timestamptz;
alter table transfers add column if not exists declined_by    text;
alter table transfers add column if not exists decline_reason text;
-- How many handsets actually changed hands on acceptance (a serial the system did not know is
-- on the document but has no holder to overwrite -- the printed copy still lists it).
alter table transfers add column if not exists moved          integer;

-- The status can only ever be one of three words. Added as a separate statement so a database
-- that already carries the column (a re-run) is not refused for the constraint existing.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transfers_status_check') then
    alter table transfers add constraint transfers_status_check
      check (status in ('sent', 'accepted', 'declined'));
  end if;
end $$;

-- A document opened before this file existed had no status: both signatures meant "done".
update transfers set status = 'accepted'
 where receiver_signed_by is not null and status = 'sent';

create index if not exists transfers_to_name_idx   on transfers (to_name);
create index if not exists transfers_from_name_idx on transfers (from_name);
create index if not exists transfers_status_idx    on transfers (status) where status = 'sent';

-- Each line remembers where the serial was found when the document was opened -- the register
-- (`devices`), the old-stock list (`old_stock`), or nowhere we knew (`unknown`) -- and whose
-- hands it was in. That is what the printed copy shows under "from", per handset, and what
-- acceptance overwrites.
alter table transfer_items add column if not exists source      text;
alter table transfer_items add column if not exists prev_holder text;

comment on column transfers.status is
  'sent = waiting for the receiver; accepted = receiver signed and every handset''s holder was '
  'overwritten to them; declined = receiver refused, with decline_reason, and nothing moved.';
comment on column transfers.from_role is
  'The role on the sender''s access code (RSM / AGENT / STORE / ADMIN) when the document was opened.';
comment on column transfers.to_role is
  'The role on the receiver''s access code when the document was opened.';
comment on column transfer_items.source is
  'Where this serial was found when the document was opened: devices, old_stock, or unknown.';
comment on column transfer_items.prev_holder is
  'Whose hands it was in then -- what acceptance overwrote.';
