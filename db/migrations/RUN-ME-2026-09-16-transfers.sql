-- =============================================================================================
-- TRANSFERS -- a stock hand-off, signed on screen by both the sender and the receiver.
-- =============================================================================================
--   "store keeper needs the transfer doc to be blue ink signed online on a transfers
--    navigation by sender and receiver so that we could export and print. as the signing
--    feature we implemented in hopeloan customer onboarding just on screen signature not
--    biometrics."
--
-- WHAT THIS IS. The paper trail a store keeper already keeps by hand when stock physically
-- moves from one person to another (an agent handing a consignment to another agent, a branch
-- releasing phones to a store keeper, and back) -- reproduced as the same kind of document the
-- POS side already prints (From/To, a reference, a dated list of serials, a total), except
-- BOTH signatures are captured on screen, on the device that is actually at the counter, the
-- same canvas-and-finger capture already proven in hopeloan's customer onboarding: a pen
-- stroke, not a fingerprint sensor.
--
-- WHY A SEPARATE TABLE FOR THE ITEMS, kept off the transfers row -- the same reason imprest's
-- receipts are kept off imprest_requests (RUN-ME-2026-09-07-imprest-leave.sql): a transfer of
-- forty phones is forty rows nobody wants dragged along on every list read. The list reads
-- item_count/total_qty/total_amount, stamped on the row at creation; the detail/print view is
-- the only place that ever asks transfer_items for the serials themselves.
--
-- WHY THE SIGNATURES ARE COLUMNS, NOT A THIRD TABLE -- unlike the items, there are always
-- exactly two possible signatures, never a variable list, so a table would only buy a join
-- for no reason. Kept OFF the list read the same way the photos are: deviceList-style callers
-- name their columns rather than `*`, and the two _signature columns are named ONLY by
-- transferGet (the single-record detail/print read).
--
-- Safe to run more than once.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. THE TRANSFER. `ref` is a readable stand-in for the uuid, so a printed document can be
--    found again by the number on it -- built in JS at insert time (api/portal.js), not by a
--    database default: the fake database every test here runs against knows nothing about
--    column defaults, and this needs to behave identically in both places.
-- ---------------------------------------------------------------------------------------------
create table if not exists transfers (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,           -- e.g. TR-20260912-LMX3F9K, stamped at insert
  created_at        timestamptz not null default now(),
  created_by        text,                            -- the access code that opened this transfer

  -- WHO IS HANDING OVER, AND WHO IS RECEIVING. Free text on purpose: a transfer often names
  -- somebody who has never held an access code at all (an agent, a customer's guarantor at a
  -- branch handover), so this is not a foreign key to any staff or agents table.
  from_name         text not null,
  from_phone        text,
  to_name           text not null,
  to_phone          text,

  note              text,

  -- STAMPED AT CREATION FROM transfer_items, so every list row can show a count and a total
  -- without joining. See the header note above.
  item_count        integer not null default 0 check (item_count >= 0),
  total_qty         integer not null default 0 check (total_qty >= 0),
  total_amount      numeric not null default 0 check (total_amount >= 0),

  -- THE TWO SIGNATURES. Each is a PNG data URL from the same on-screen pad hopeloan's
  -- onboarding already uses (canvas, pointer events, no hardware fingerprint reader) --
  -- text, not bytea, so the print view can put it straight into an <img> with no decoding
  -- step. Null until that party has actually signed; a signature, once written, is never
  -- overwritten by this API -- a mis-signed transfer is corrected by a fresh transfer, the
  -- same way a mis-posted payment is, not by editing history.
  sender_signature    text,
  sender_signed_by    text,
  sender_signed_at    timestamptz,
  receiver_signature  text,
  receiver_signed_by  text,
  receiver_signed_at  timestamptz,

  updated_at        timestamptz not null default now()
);
comment on table transfers is
  'A stock hand-off between two named parties, with a printable document and two on-screen '
  'signatures. item_count/total_qty/total_amount are stamped from transfer_items at creation '
  'so the list needs no join; the signature columns are named only by the single-record read.';
comment on column transfers.ref is
  'Human-readable reference printed on the document, e.g. TR-20260912-LMX3F9K. Generated in '
  'JS at insert time (api/portal.js), never recomputed.';
comment on column transfers.sender_signature is
  'PNG data URL from the on-screen signature pad. Null until the sender has signed. Never '
  'overwritten once set -- see the note above.';
comment on column transfers.receiver_signature is
  'PNG data URL from the on-screen signature pad. Null until the receiver has signed. Never '
  'overwritten once set -- see the note above.';

create index if not exists transfers_created_at_idx on transfers (created_at desc);
create index if not exists transfers_created_by_idx on transfers (created_by);
-- Open transfers -- missing either signature -- are the ones a store desk actually watches.
create index if not exists transfers_open_idx on transfers (created_at)
  where sender_signature is null or receiver_signature is null;

-- ---------------------------------------------------------------------------------------------
-- 2. THE SERIALS, one row each. Small, separate, read only by the detail/print view.
-- ---------------------------------------------------------------------------------------------
create table if not exists transfer_items (
  id            uuid primary key default gen_random_uuid(),
  transfer_id   uuid not null references transfers (id) on delete cascade,
  imei          text not null,
  item          text,                                -- model name, e.g. "SAMSUNG A07-64GB"
  qty           integer not null default 1 check (qty > 0),
  price         numeric not null default 0 check (price >= 0),
  unique (transfer_id, imei)
);
comment on table transfer_items is
  'One serial per row for one transfer. Deliberately not a foreign key to devices -- a '
  'transfer covers stock that may never have been enrolled in the lock register at all '
  '(new or old stock still on its way there).';

create index if not exists transfer_items_transfer_id_idx on transfer_items (transfer_id);
create index if not exists transfer_items_imei_idx on transfer_items (imei);

-- Verify: every column above should show up here.
-- select column_name from information_schema.columns where table_name = 'transfers' order by 1;
-- select column_name from information_schema.columns where table_name = 'transfer_items' order by 1;
