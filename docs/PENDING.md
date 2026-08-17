# PENDING — standing reminders for whoever builds next

Durable memory. Each item here was promised to the owner in chat; delete an item only
when it ships, and say so in the commit that deletes it.

## 1. GUARANTORS — integrate the moment a report carries them

The owner's words: *"we'll intergarate guarantors too when we get reports with that info
later, when we land such a report remember this please."*

Today no Watu export we hold has guarantor columns (the credit team's locked-7-days file
lacks them; hoopltd.shop holds them but exports nothing). **The trigger is a landed file
with guarantor fields.** When one lands:

- Migration: add `guarantor_name`, `guarantor_phone` (and whatever else the file carries —
  header-presence rule: only columns the file actually has) to `watu_loans`,
  `watu_snapshots`, and `followup_status`.
- Importer: add the header candidates to `api/_lib/importers.js` the same way `agent` is
  matched today.
- Display: guarantor rides every customer row and the phone's detail sheet **exactly the
  slot it held in Hope** — beside the agent, who already plays that "second person to lean
  on" role for Hoop.
- Budget note as always: no new round trips — the columns join reads that already happen.

## 2. Payment reference = the CUSTOMER'S PHONE NUMBER

Stated twice by the owner: *"Their customer payment/ref no is customer phone number."*
For Hoop, a Watu payment record references the customer's phone number — **never the
IMEI**. Any future payment/recovery matching joins on `pnorm(client_mobile)`
(normalized: strip 255/leading zeros, last 9 digits — `pnorm` in `api/_lib/call-core.js`).
The schema comment on `watu_loans.client_mobile` says the same. Do not "fix" this to IMEI.

## 3. Materials still outstanding (starter §7) — chase list

Highest value first; who to lean on is from the starter's people table:

1. 2–3 **real daily follow-up files** from Watu (Mon–Sat list) — validates the importer's
   header candidates against reality. Via **Gilbert (IT)**, who liaises with Watu.
   → Half-answered 2026-08-15: the Watu SALES report (received, see MATERIALS.md) is the
   same 16-column family, so the daily list very likely is too; still want a real one.
2. **Full Watu sales report**, every column — the reconciliation anchor for commissions.
   Via **Madam Janeth (accountant)** + Gilbert. → **RECEIVED 2026-08-15** (one day,
   14 Aug; profile + the fraud cross-check against Mwinyi's export in MATERIALS.md).
   Still wanted: date-RANGE exports of both files (a loan can land a day late — the
   fraud report needs a ±1-day window).
3. **hoopltd.shop sales export** + screenshots of Pending Upload/Approval and receipts.
   Via **general duty (Mwinyi)**. → **RECEIVED 2026-08-15** (one-day export + 5 screenshots;
   full profile in docs/MATERIALS.md — no guarantor columns, §1 stays armed). Still wanted
   from the same source: a date-RANGE export (several days) and, when it exists, an export
   of the Unapproved Commissions grid.
4. **Commission rules in writing** per role/model, incl. what disqualifies a sale.
   Via **Peter Kisoli** + Janeth.
5. **Staff list** (names, phones, roles, regions) — feeds Teams & access codes the day it
   arrives, no code needed. → **PARTIALLY RECEIVED 2026-08-15**: agents 1–100 of 1,046
   from Sipho's SyscoPos save, inserted via db/migrations/RUN-ME-2026-08-15-agents.sql.
   The owner says this is Sipho's handover complete — new records happen going forward;
   if the remaining 946 are ever wanted, the capture steps are in MATERIALS.md.
6. **Watu payment-progress feed** — formally requested already; keep chasing. When it
   lands, item 2 above (phone-number ref) governs the join.
7. Later: price history per model, product/stock register (**Mr Sipho**), receipt samples,
   brand assets + domain, and the precise 45-day and 7% formulas.

## 4. Housekeeping the owner should still do

- Make the `hoop-pmo` repo **private** (it is public today).
- The admin access code and the database password were pasted in chat during setup:
  rename the admin code in Portal → Access codes → Hariri, and reset the Supabase database
  password.
- Vercel env: `SUPABASE_URL` currently holds a pasted API key; the code self-heals
  (`SUPABASE_URL_NORM`) but the honest fix is setting the real URL.

## 5. Coming stage (owner, 2026-08-17): agents see THEIR OWN customers

*"we'll move to agents seeing their customers in coming up stages."* When the word comes:
sales agents (hoop_agents) get a view of the customers THEY sold (joined by the agent
field on the register / hoop_sales by payout phone) — likely a lightweight portal role or
app mode. Distribution stays CREDIT-only; this is a viewing stage, not a dealing change.
