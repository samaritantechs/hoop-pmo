-- THE OFFLINE QUEUE LANDED (2026-08-17) -- and with it, at last, GUARANTORS.
-- The credit team's Watu portfolio sheet carries Customer, Customer Phone,
-- Guarantor ("name | phone" in one cell), Agent, Branch and Sale Date per IMEI.
-- PENDING #1's trigger has fired: these columns join the REGISTER (watu_loans),
-- where the shared agent index already reads -- so the phone card, the Wateja tab
-- and the register search all pick them up with ZERO new round trips.
-- (The daily deck file still has no guarantor columns, so followup_status and
-- watu_snapshots stay as they are -- header-presence rule.)

alter table if exists watu_loans add column if not exists guarantor_name  text;
alter table if exists watu_loans add column if not exists guarantor_phone text;
-- Watu's own zone / dealer label from the offline queue ("Dar es salaam",
-- "Phonehive store"...). NOT our teams column and no FK -- display only.
alter table if exists watu_loans add column if not exists branch text;

comment on column watu_loans.guarantor_name  is 'From the offline-queue sheet: "name | phone" split. Rides the customer card beside the agent.';
comment on column watu_loans.guarantor_phone is 'From the offline-queue sheet. The card offers it as a call button.';
comment on column watu_loans.branch          is 'Watu''s zone/dealer label from the offline queue. Display only -- never a fence, never a team.';
