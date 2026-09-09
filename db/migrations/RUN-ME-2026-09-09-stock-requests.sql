-- =============================================================================================
-- STOCK REQUESTS, THE AGING GATE, AND THE HANDOVER NOTE.
-- =============================================================================================
--   Store SOP B.1  "Receive the stock request from the RSM in the system"
--   Store SOP B.2  "Confirm the RSM/agent has no outstanding aging stock"
--   Store SOP B.4  "Obtain written approval from the General Manager before releasing any stock"
--   Store SOP B.5  "Prepare a pre-numbered delivery/handover note listing IMEIs, quantities,
--                   and condition"
--   Store SOP B.6  "Conduct a joint physical count with the RSM/agent before handover"
--   Store SOP B.7  "Photograph the sealed boxes and IMEI list at the point of handover"
--   Store SOP B.8  "Obtain the RSM/agent's signature, retain a copy, and upload it to the
--                   system the same day"
--   Store SOP B.9  "Where a consignment is dispatched via courier ... all required documents
--                   ... accompany the shipment and are verified as complete before dispatch"
--   Store SOP B.11 "the Store Keeper must maintain a distribution report recording every
--                   device reallocation"
--   Store SOP E    "No new stock is released to any RSM/agent with outstanding aging stock
--                   until it is fully sold, returned, or reconciled" (threshold: 5 days)
--
-- THE GATE IS THE POINT OF THIS FILE. Everything else here is a request table like the three
-- already in this folder; what is new is that an approval can be REFUSED by arithmetic rather
-- than by somebody remembering. The aging figures come from hoop_aged_stock -- the shop's own
-- daily upload, which already carries age_days per serial per agent -- so the gate reads the
-- same file the Aging Stock Tracker is, and never a second private idea of what is old.
--
-- The gate is stamped on the request when it is FILED (what the tracker said that morning) and
-- recomputed LIVE when somebody decides, because a request sitting for two days is a different
-- question by the time it is answered. Releasing anyway is allowed -- the SOP has escalation,
-- not a locked door -- but it takes a reason, and the reason is kept.
--
-- Safe to run more than once.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. THE REQUEST. An RSM asks; the store desk decides; the handover below records the release.
-- ---------------------------------------------------------------------------------------------
create table if not exists stock_requests (
  id              uuid primary key default gen_random_uuid(),
  requested_at    timestamptz not null default now(),

  -- WHO ASKED, as their access code said at the time. Stamped, never joined.
  staff_code      text,
  staff_name      text not null,
  staff_role      text,

  -- WHOSE SHELF IT IS GOING ON. Usually the requester; sometimes an agent under them. The
  -- aging gate is measured against THIS name, because that is whose old stock is the question.
  holder          text not null,
  destination     text,
  item            text not null,
  qty             integer not null check (qty > 0),
  reason          text,

  -- WHAT THE TRACKER SAID WHEN THEY ASKED (SOP E). Kept even after the stock is issued, so a
  -- release that should not have happened can still be seen for what it was.
  aging_count       integer,
  aging_oldest_days integer,
  aging_as_of       date,

  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected', 'issued', 'cancelled')),
  -- The desk may release fewer than were asked for; null until decided.
  approved_qty    integer check (approved_qty is null or approved_qty >= 0),
  comment         text,
  decided_by      text,
  decided_at      timestamptz,

  -- RELEASING TO SOMEBODY HOLDING AGING STOCK. Allowed, never silent.
  aging_override        boolean not null default false,
  aging_override_reason text,

  issued_at       timestamptz,
  issued_by       text,

  updated_by      text,
  updated_at      timestamptz not null default now()
);
comment on table stock_requests is
  'Stock requests from RSMs/agents (Store SOP B). The requester is STAMPED from the access '
  'code. aging_* is what the Aging Stock Tracker said when the request was filed; the gate is '
  'recomputed live at decision time and may be overridden only with a recorded reason.';

create index if not exists stock_requests_requested_idx on stock_requests (requested_at desc);
create index if not exists stock_requests_status_idx on stock_requests (status) where status = 'pending';
create index if not exists stock_requests_holder_idx on stock_requests (holder);
create index if not exists stock_requests_staff_idx on stock_requests (staff_code);

-- ---------------------------------------------------------------------------------------------
-- 2. THE HANDOVER NOTE (SOP B.5-B.9). One per request, so a release cannot be recorded twice.
-- ---------------------------------------------------------------------------------------------
create table if not exists stock_handovers (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null unique references stock_requests (id) on delete cascade,
  at              timestamptz not null default now(),
  by_code         text,
  by_name         text not null,

  -- B.5: the pre-numbered note. Typed by the store keeper from the pad in front of them.
  note_no         text,
  -- B.6: the joint count actually happened. A tick somebody had to mean.
  counted_jointly boolean not null default false,
  -- B.8: who signed for it, in their own name. Not a scribble -- the name on the note.
  received_by     text,
  condition_note  text,
  -- B.9: dispatched by courier, and the papers were checked before it left.
  courier         text,
  docs_complete   boolean not null default false,
  qty             integer not null default 0
);
comment on table stock_handovers is
  'The release itself (Store SOP B.5-B.9): the pre-numbered note, the joint count, who signed, '
  'the courier and whether its documents were verified complete before dispatch.';

-- The IMEIs on the note (B.5), one per row so a device can be traced to the note it left on.
create table if not exists stock_handover_items (
  id           uuid primary key default gen_random_uuid(),
  handover_id  uuid not null references stock_handovers (id) on delete cascade,
  imei         text not null,
  condition    text,
  unique (handover_id, imei)
);
create index if not exists stock_handover_items_imei_idx on stock_handover_items (imei);

-- The photographs (B.7), kept off every list exactly as the imprest receipts are: shrunk on the
-- phone, capped at 200KB by the server, fetched one handover at a time when somebody asks.
create table if not exists stock_handover_photos (
  id           uuid primary key default gen_random_uuid(),
  handover_id  uuid not null references stock_handovers (id) on delete cascade,
  seq          integer not null check (seq between 1 and 3),
  data         text not null,
  bytes        integer not null,
  unique (handover_id, seq)
);
comment on table stock_handover_photos is
  'Up to three handover photos -- sealed boxes and the IMEI list (Store SOP B.7) -- compressed '
  'client-side and capped at 200KB each server-side. Never selected by a list.';

-- ---------------------------------------------------------------------------------------------
-- 3. THE NUMBERS THE SOP FIXES, as settings rather than constants, because a policy that needs
--    a deploy to change is a policy nobody changes.
-- ---------------------------------------------------------------------------------------------
--   STOCK_AGING_DAYS  SOP E: "5 days from the date the consignment was issued"
--   STOCK_LOW_ALERT   SOP G: "market stock falling below 1,500 pieces"
--   STOCK_EMAIL       who hears about a new request; blank means nobody and the pane is still
--                     the record. Escalations go to GM_EMAIL, the key the issues desk uses.
insert into settings (key, value) values
  ('STOCK_AGING_DAYS', '5'),
  ('STOCK_LOW_ALERT', '1500'),
  ('STOCK_EMAIL', '')
on conflict (key) do nothing;
