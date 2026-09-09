-- =============================================================================================
-- TOP-UPS (CREDIT SALES): the request, the verification, the payment, and the unlock.
-- =============================================================================================
--   Finance SOP B.1  "Receive the top-up request together with PROOF of the client's upfront
--                     payment."
--   Finance SOP B.2  "VERIFY THE IMEI NUMBER before processing the payment."
--   Finance SOP B.3  "Verify the payer's name and check the payment against bank/mobile-money
--                     records."
--   Finance SOP B.4  "Calculate the remaining balance required to complete the full phone price."
--   Finance SOP B.5  "Send the top-up payment IMMEDIATELY so the system can unlock the device
--                     for the client -- this step must never be delayed."
--   Finance SOP B.6  "Confirm with the agent/client that the device has been unlocked."
--   Finance SOP B.7  "Log the completed transaction in the system."
--   Finance SOP B    the Top-Up Audit Checklist, filed against every transaction.
--
-- B.5 IS THE ONLY STEP IN ANY OF THESE SOPs WITH THE WORDS "MUST NEVER BE DELAYED", and it is
-- the reason this table exists rather than a WhatsApp thread: a customer whose phone is locked
-- after they have paid is the worst thing this company can do to somebody, and the only way to
-- stop it happening quietly is to make the waiting visible and count the minutes.
--
-- FOUR STAMPS, NOT ONE STATUS. Requested, verified, paid, unlocked -- because the gap between
-- any two of them is somebody's afternoon, and a single status column cannot show a gap.
--
-- Safe to run more than once.
-- =============================================================================================

create table if not exists topups (
  id             uuid primary key default gen_random_uuid(),
  requested_at   timestamptz not null default now(),

  -- WHO ASKED, as their access code said at the time. Usually the agent, sometimes the desk
  -- taking it over the phone.
  staff_code     text,
  staff_name     text not null,
  staff_role     text,

  -- WHOSE PHONE. B.2 makes the IMEI the thing that is checked before any money moves.
  imei           text not null,
  customer       text,
  customer_phone text,

  -- B.1 and B.3: what the client paid up front, who paid it, and where the proof is.
  payer_name     text,
  paid_amount    numeric(14, 2) not null check (paid_amount >= 0),
  proof_ref      text,

  -- B.4: the full price and what is left. Both stored, because "the balance" is only a fact
  -- alongside the price it was worked out from.
  price          numeric(14, 2),
  balance        numeric(14, 2),

  status         text not null default 'requested'
                   check (status in ('requested', 'verified', 'paid', 'unlocked', 'rejected')),
  comment        text,

  -- B.2/B.3: the desk confirms the IMEI and the payer against the bank record.
  verified_by    text,
  verified_at    timestamptz,
  -- B.5: the money going to Watu so the handset can be released.
  paid_by        text,
  paid_at        timestamptz,
  payment_ref    text,
  -- B.6: somebody actually confirmed the customer's phone opened.
  unlocked_by    text,
  unlocked_at    timestamptz,

  -- The Top-Up Audit Checklist, filed against every transaction.
  chk_request    boolean not null default false,   -- top-up request from agent
  chk_paid_to    boolean not null default false,   -- payment paid to the requested number
  chk_watu       boolean not null default false,   -- approved sales verification from WATU
  chk_auditor    boolean not null default false,   -- auditor sign-off

  updated_by     text,
  updated_at     timestamptz not null default now()
);
comment on table topups is
  'Top-up (credit sale) transactions, Finance SOP B. FOUR STAMPS rather than one status -- '
  'requested, verified, paid, unlocked -- because B.5 says the payment "must never be delayed" '
  'and the only way to see a delay is to see the gap between two stamps.';

create index if not exists topups_requested_idx on topups (requested_at desc);
create index if not exists topups_status_idx on topups (status) where status <> 'unlocked';
create index if not exists topups_imei_idx on topups (imei);
create index if not exists topups_staff_idx on topups (staff_code);

-- WHO IS TOLD when a top-up is waiting. Blank means nobody and the pane is still the record.
insert into settings (key, value) values
  ('TOPUP_EMAIL', '')
on conflict (key) do nothing;
