-- SALES PERFORMANCE -- who to credit a sale to, beyond the seller the file already names.
--
--   recorded_by   the hoopltd.shop USER who entered the sale -- the general-duty person.
--                 The current sales_details.xlsx export has NO such column, so this stays
--                 null until their export grows one (RECORDED_BY / USER / CASHIER /
--                 SERVED_BY / SOLD_BY are all recognised the moment they appear).
--   uploaded_by   who LOADED the day's sales book into this system, stamped from the
--                 signed-in code at /upload. Until recorded_by exists this is the honest
--                 general-duty attribution there is: the person who did the day's book.
--
-- The daily target lives in `settings` (key SALES_DAILY_TARGET, TZS per day) -- no new
-- table; the Settings pane's ordinary key/value editor writes it.
--
-- Safe to re-run.

alter table hoop_sales add column if not exists recorded_by text;
alter table hoop_sales add column if not exists uploaded_by text;

-- DID IT LAND?
-- select column_name from information_schema.columns
--   where table_name = 'hoop_sales' and column_name in ('recorded_by', 'uploaded_by');
