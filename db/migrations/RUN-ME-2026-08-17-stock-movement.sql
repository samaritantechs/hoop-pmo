-- STOCK MOVEMENT needs HISTORY: every aged-stock upload kept per date, so two uploads
-- can be diffed ("which stock got away"). The key becomes (serial, as_of) -- one row per
-- phone per report date. Safe to paste once; re-pasting errors harmlessly on the PK step.

update hoop_aged_stock set as_of = updated_at::date where as_of is null;
alter table hoop_aged_stock alter column as_of set not null;
alter table hoop_aged_stock drop constraint hoop_aged_stock_pkey;
alter table hoop_aged_stock add primary key (serial, as_of);
