-- NEW STOCK (2026-09-11) -- one row per IMEI we have locked, and the sale that goes with it.
--
--   "I need an audit of our existing imeis since we started locking on our own -- Imei, Rsm,
--    rsm no, agent, agent no, customer, customer no, price, guarantor, guarantor no, status
--    (locked, unlocked, achia), by (who promted that status), last read (last sync date&time),
--    so that we could always sort locked and sort by sync to know our lost or stock that needs
--    verification."
--
--   "It should always read and stamp the sales first imei sales info from watu deck upload,
--    since watu always omit data so when we stamp once we are done for the missing column
--    info, the rest until obtained -- if watu removes sales data, we already stamped ours."
--
-- WHY THIS IS A TABLE AND NOT A VIEW. Everything in it can be worked out by joining five feeds
-- that already exist, and for most of this system that is exactly what we do -- a derived
-- number written down is a lie the moment its inputs move. This is the one case where the
-- opposite is true: THE INPUTS DISAPPEAR. The Watu deck is re-uploaded over itself, and Watu
-- omits and removes rows as it pleases. A join answers "what does the deck say today"; the
-- question here is "who bought this handset", which is a fact about a day in the past and does
-- not stop being true because a spreadsheet stopped mentioning it.
--
-- FIRST CATCH WINS, AND NOTHING IS EVER OVERWRITTEN. Each column is filled the first time any
-- feed can answer it and is then left alone for good. That is what makes the stamp worth
-- having: a second upload that has gone blank cannot un-say what the first one said.
--
-- WHAT IS NOT HERE: status, who ordered it, and when the handset last spoke. Those live on
-- `devices` and are read live every time the pane opens. They are the opposite kind of fact --
-- they CHANGE rather than disappear -- and a stamped status would be a lie within the hour.

create table if not exists stock_audit (
  imei            text primary key,
  -- The sale, stamped once. Every one of these is nullable: an unanswered column is an
  -- unanswered column, and inventing a value to avoid a blank is the failure this exists to
  -- prevent.
  rsm             text,
  rsm_phone       text,
  agent           text,
  agent_phone     text,
  customer        text,
  customer_phone  text,
  price           numeric(14,2),
  guarantor       text,
  guarantor_phone text,
  -- Context that makes a row readable without opening another pane.
  branch          text,
  model           text,
  sale_date       date,
  /* WHICH FEED ANSWERED WHICH COLUMN. A stamped value with no provenance is a number you
     cannot argue with -- and some of these are DERIVED (the RSM is read off the staff
     hierarchy, not off any sale), which the reader is entitled to know. One jsonb column
     rather than thirteen text ones: {"agent":"watu_loans","rsm":"hierarchy",...} */
  src             jsonb not null default '{}'::jsonb,
  first_at        timestamptz not null default now(),   -- when this IMEI was first stamped
  stamped_at      timestamptz not null default now()    -- when a column was last filled in
);

create index if not exists idx_stock_audit_agent on stock_audit (agent);
create index if not exists idx_stock_audit_rsm   on stock_audit (rsm);
create index if not exists idx_stock_audit_cust  on stock_audit (customer_phone);

comment on table  stock_audit is
  'One row per locked IMEI: the sale behind it, each column stamped the FIRST time any feed could answer it and never overwritten. Status, who ordered it and the last beat are NOT here -- they are read live from devices.';
comment on column stock_audit.src is
  'field -> which feed stamped it (watu_loans | offline_queue | hoop_sales | hoop_agents | hoop_aged_stock | hierarchy). Provenance, so a stamped value can be argued with.';
comment on column stock_audit.rsm is
  'Derived from the staff hierarchy at stamp time, not from any sale feed -- the regional manager above this handset''s agent on the day it was first seen.';
