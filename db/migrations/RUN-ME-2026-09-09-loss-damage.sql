-- =============================================================================================
-- LOSS AND DAMAGE: the price list, the case, and the acknowledgement of liability.
-- =============================================================================================
--   Finance SOP H     "This process is managed under the Finance Department (moved from the
--                      Store Department) so that valuation, liability, and recovery are handled
--                      centrally."
--   Finance SOP H.1   root cause -- negligence, an unresolved sale, or a genuine incident.
--                      "A police report is required for suspected theft or robbery."
--   Finance SOP H.2   "The Finance Officer VALUES the missing/damaged device using the current
--                      price list."
--   Finance SOP H.3   the custodian is held liable and must reimburse at the assessed value
--   Finance SOP H.4   recovery method -- lump sum or structured commission/salary deduction --
--                      approved by the General Manager and Finance Officer
--   Finance SOP H.5   "The custodian SIGNS an acknowledgment of liability and repayment plan;
--                      a copy is filed with Finance and the General Manager."
--   Store SOP C.7     open a Loss/Damage case when verification finds a shortage
--   RSM SOP F / CSM SOP G   the custodian is financially liable at the device's prevailing value
--
-- FOUR SOPs POINT AT THIS ONE PROCESS and none of them could open a case, because there was
-- nowhere to open it. The store's verification finds a phone missing; the RSM is liable; the
-- CSM enforces; Finance values and recovers. One table, one price list, one trail.
--
-- THE PRICE LIST IS A TABLE, NOT A NUMBER IN CODE. H.2 says "the CURRENT price list", which
-- means it moves -- and a valuation somebody cannot point at a list for is a valuation the
-- custodian will argue about. The value is COPIED onto the case when it is opened, so a price
-- change next month never re-prices a debt somebody has already signed for.
--
-- Safe to run more than once.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. THE CURRENT PRICE LIST (SOP H.2). By model, as the Watu book spells it.
-- ---------------------------------------------------------------------------------------------
create table if not exists device_prices (
  item        text primary key,
  amount      numeric(14, 2) not null check (amount >= 0),
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
comment on table device_prices is
  'The current price list Finance values a missing or damaged device against (Finance SOP H.2). '
  'A case copies the figure at the moment it is opened, so a later price change never re-prices '
  'a liability somebody has already acknowledged.';

-- ---------------------------------------------------------------------------------------------
-- 2. THE CASE.
-- ---------------------------------------------------------------------------------------------
create table if not exists loss_cases (
  id             uuid primary key default gen_random_uuid(),
  opened_at      timestamptz not null default now(),

  -- WHO OPENED IT, as their access code said at the time. Stamped, never joined.
  staff_code     text,
  staff_name     text not null,
  staff_role     text,

  -- WHOSE CUSTODY IT WAS IN. The person SOP H.3 makes liable.
  custodian      text not null,
  imei           text,
  item           text,

  -- SOP H.1. A police report is required for theft, and the server refuses the case without one.
  cause          text not null
                   check (cause in ('negligence', 'unresolved_sale', 'incident', 'theft')),
  police_ref     text,
  details        text,

  -- SOP H.2: the assessed value, and the list it came from, both frozen here.
  value_amount   numeric(14, 2),
  value_source   text,

  -- SOP H.4: agreed with the custodian, approved by the GM and Finance.
  recovery_method text
                   check (recovery_method is null
                          or recovery_method in ('lump_sum', 'salary_deduction', 'commission_deduction')),
  recovery_note  text,
  approved_by    text,
  approved_at    timestamptz,

  -- SOP H.5: the custodian's own acknowledgement, by name and date.
  acknowledged_by text,
  acknowledged_at timestamptz,

  status         text not null default 'open'
                   check (status in ('open', 'valued', 'acknowledged', 'recovering', 'settled', 'written_off')),
  recovered      numeric(14, 2) not null default 0 check (recovered >= 0),
  settled_at     timestamptz,

  updated_by     text,
  updated_at     timestamptz not null default now()
);
comment on table loss_cases is
  'One missing or damaged consignment phone, from the shortage that found it to the money that '
  'settled it (Finance SOP H; opened by Store SOP C.7; the custodian named by RSM SOP F and '
  'CSM SOP G). The valuation is copied from the price list, not looked up later.';

create index if not exists loss_cases_opened_idx on loss_cases (opened_at desc);
create index if not exists loss_cases_status_idx on loss_cases (status) where status <> 'settled';
create index if not exists loss_cases_custodian_idx on loss_cases (custodian);
create index if not exists loss_cases_imei_idx on loss_cases (imei);

-- ---------------------------------------------------------------------------------------------
-- 3. THE TRAIL. One row per move, so a case somebody argues about has its own history.
-- ---------------------------------------------------------------------------------------------
create table if not exists loss_case_notes (
  id       uuid primary key default gen_random_uuid(),
  case_id  uuid not null references loss_cases (id) on delete cascade,
  at       timestamptz not null default now(),
  by_code  text,
  by_name  text not null,
  note     text not null,
  change   text
);
create index if not exists loss_case_notes_case_idx on loss_case_notes (case_id, at);

-- ---------------------------------------------------------------------------------------------
-- 4. WHO IS TOLD. A loss goes to the GM the same day (Store SOP C.7, RSM SOP A.7).
-- ---------------------------------------------------------------------------------------------
insert into settings (key, value) values
  ('LOSS_EMAIL', '')
on conflict (key) do nothing;
