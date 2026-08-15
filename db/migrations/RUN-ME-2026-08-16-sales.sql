-- HOOP SALES -- general duty's hoopltd.shop sales book, one row per phone per receipt.
-- Uploaded through /upload (the header row is recognized automatically); the fraud
-- audit and the agent scorecards read it. Safe to paste more than once.
-- sale_key is deterministic (receipt + IMEI) so a re-upload UPDATES its own rows.

create table if not exists hoop_sales (
  sale_key         text primary key,          -- 'S' + h36(receipt|imei)
  sale_date        date,
  branch           text,
  agent            text,                      -- the sale's record holder (RSM / team leader)
  client_name      text,
  client_id        text,
  client_phone     text,                      -- joins to Watu by pnorm (payment ref = phone)
  model            text,
  receipt_number   text,
  imei             text not null,             -- joins to watu_loans -- the fraud check's key
  commission_agent text,                      -- who is OWED the commission (free text)
  commission_phone text,                      -- the payout number -- the seller's stable identity
  price            numeric,
  upload_batch     uuid,
  updated_at       timestamptz default now()
);

create index if not exists idx_hoop_sales_date   on hoop_sales (sale_date);
create index if not exists idx_hoop_sales_imei   on hoop_sales (imei);
create index if not exists idx_hoop_sales_cphone on hoop_sales (commission_phone);

-- AGED STOCK -- Sipho's SyscoPos report, parsed straight from his saved HTML at /upload
-- (he cannot export Excel; the page reads the table out of the HTML and dumps the file).
-- One row per serial; as_of stamps which day's report said so -- age is only true on
-- the day it was read. Phase 3 computes TRUE age from purchases; this holds SyscoPos's
-- own numbers meanwhile.

create table if not exists hoop_aged_stock (
  serial     text primary key,               -- the IMEI in warehouse clothes
  agent      text,
  item       text,
  received   date,
  age_days   integer,
  as_of      date,
  updated_at timestamptz default now()
);

create index if not exists idx_hoop_aged_agent on hoop_aged_stock (agent);
