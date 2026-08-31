# PENDING — standing reminders for whoever builds next

Durable memory. Each item here was promised to the owner in chat; delete an item only
when it ships, and say so in the commit that deletes it.

## 1. GUARANTORS — SHIPPED 2026-08-17 (the trigger fired)

The owner's words: *"we'll intergarate guarantors too when we get reports with that info
later, when we land such a report remember this please."* — **the report landed**: the
credit team's OFFLINE QUEUE sheet (portfolio_offline_queue export) carries Guarantor
("name | phone" in one cell), plus Customer, Customer Phone, Agent, Branch, Sale Date.

What shipped: `guarantor_name`, `guarantor_phone`, `branch` on **watu_loans only** (the
daily deck file still has no guarantor columns, so followup_status / watu_snapshots stay
untouched — header-presence rule); the offline-queue upload kind at /upload (merge, never
lose); the guarantor beside the agent on the phone card with tap-to-call, on the Wateja
tab and the register search. The sheet's Last Action comments were imported ONCE into
followup_comments (owner: commenting lives in HOOPLOAN Calls now — never pull them again).

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

## 5. SHIPPED 2026-08-17: agents see THEIR OWN customers

The stage arrived the same day it was promised. One shared AGENT sign-in code (portal →
Access codes, rotated in the WhatsApp group like the staff code); an agent registers with
name + phone + location, the phone must match `hoop_agents`, and the app shows only the
customers whose register row names them. Unknown phone = empty book (fails closed) with a
note to ask the office. Distribution stays CREDIT-only — agents never join the deal.
Remaining refinement if wanted later: an agent portal view of their sales/commissions.

## 6. SHIPPED 2026-08-31: salary advance — ask, decide, pay

Three navs, because they are three different jobs done by three different people. Grant them
in **Portal → Access codes → roles**, one tick each; holding one says nothing about the others.

| nav | pane | who |
|---|---|---|
| `advreq` | Omba advance / Advance request | anybody with a portal code you tick it on |
| `advappr` | Idhini ya advance / Advance approval | the leaders who decide |
| `advrep` | Ripoti ya advance / Advance report | HR — the filing copy and the bank run |

**RUN THE MIGRATION FIRST — `db/migrations/RUN-ME-2026-08-29-salary-advance.sql`.** Until it is
run, every one of the three panes says so in plain words rather than showing an empty table,
because "no rows" and "no table" must never look the same on a screen about money.

Four amounts only — 50,000 / 100,000 / 150,000 / 200,000 — enforced on the server as well as in
the dropdown. The requester supplies their own bank or mobile-money details at the moment of
asking, because they are the only person who knows them and a row without them stops HR's
payment run while somebody makes a phone call.

**Two figures, kept apart on purpose.** The approver's drawer opens pre-set to the full amount
requested and can be lowered but never raised, and `approved_amount` is its own column — so the
report shows what was asked AND what was granted. Overwriting one with the other would destroy
the record of a part-approval, which is exactly the gap somebody argues about at the counter.

Two financial controls worth knowing about, both enforced on the server:

- **Nobody decides their own request**, however many navs they hold. A leader who may approve
  can also ask, so the two panes meet on one person by design; this is the line between them.
- **Two approvers pressing at once**: the update is guarded on `status='pending'`, so the second
  is told it was already decided rather than silently overwriting the first decision.

Identity is **stamped, never joined** — HOOP has no staff table, a person is the access code
they signed in with, and a payment record that rewrote itself when a code was renamed or deleted
would not be a record.

The report opens on the **current month** (start and end of month already in the two date boxes)
and can be widened, narrowed by status, or set to all dates. Its total counts **approved rows
only** — the only figure safe to hand a cashier.

### Exports, including on a phone

Every table in the portal now carries **⤓ Excel** and **⤓ PDF**, and both save inside the
Android app as well as in a browser. The PDF is written by the page itself — no third-party
script is loaded anywhere in this portal — landscape, with the column headers reprinted on
every page.

The save tries three routes, best first, and the middle one is the easy one to lose:

1. `HoopLoan.saveBase64` — the wrapper writes straight into the phone's Downloads folder.
2. The **share sheet**, for handsets on an older APK with no `saveBase64` yet. Without this rung
   those officers fall to route 3, which inside a WebView is a dead end, and a report that
   exported last week would quietly stop coming out.
3. An ordinary browser download.

You export **what you see**: rows hidden by a column filter or a search box stay out of the
file, and control cells (tick boxes, action buttons) are never exported as data.
