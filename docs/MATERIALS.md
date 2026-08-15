# MATERIALS RECEIVED — the department handover log

The owner is collecting real files from each department and will say "proceed" when the
build should start. Nothing here is built yet; this file is the durable memory of what has
landed, what it contains, and how it will join the system when the word comes.

## 2026-08-15 — from Mwinyi (general duty)

### 1. `sales_details.xlsx` — the hoopltd.shop sales export (THE reconciliation anchor)

One sheet ("Tablib Dataset"), one day (14/08/2026), 24 sales + a trailing `Total` row an
importer must drop (its Date cell literally says "Total"). Columns, verbatim:

| Column | What the real data shows |
|---|---|
| `Date` | dd/mm/yyyy |
| `Branch` | constant `HOOP LIMITED` |
| `Agent` | the sale's RECORD holder — RSM/team-leader level (Anord Sawe appears here) |
| `Client_Name` | customer |
| `Client_Id` | **always `N/A`** in this sample (receipt screenshot agrees: ID_No N/A) |
| `Client_Phone` | 07xx… — joins to Watu by `pnorm` (payment ref = customer phone, PENDING §2) |
| `Phone_Model` | e.g. `SAMSUNG A07-64GB` |
| `Receipt_Number` | joins to the hoopltd.shop receipt (e.g. #9969) |
| `Imei` | 15 digits, all valid in sample — joins straight to `watu_loans.imei` |
| `Commission_Agent` | the person actually OWED the commission — free text, spelling drifts |
| `Commission_Phone` | payout number, mixed `07…`/`255…` formats — normalize with `pnorm` |
| `Price` | TEXT like `'503000.00'`; the Total row holds a real number (12,038,400) |

**The important discovery: `Agent` ≠ `Commission_Agent`.** Eight of 24 rows differ — a sale
recorded under RSM "Anord Sawe" pays commission to "ALOBOGASTI", "Haruna Mzava", "Abas",
"Dariasy"… So commission counting keys on `Commission_Agent`+`Commission_Phone`, NOT on the
record-holder column, and the free text needs normalization before any counting: the sample
alone has `Cyprian Dotto Renatus` / `Cyprian dotto renatus` / `Cyprian Dotto Renatusi`, and
trailing-space variants of others. Normalized payout PHONE is the stable identity;
name is display.

**No guarantor columns.** PENDING §1 stays armed — this export does not trigger it.

**Price drift across sources, same model (A07-64GB):** 450,000 (Watu application screen),
440,000 (hoop receipt, 28/05/26), 503,000 (this export, 14/08/26). Keep each source's price
in its own column at reconciliation; never "correct" one from another. Price history per
model is already on the chase list.

### 2. Screenshots — the fields each screen carries

- **Watu customer app** (customer's own phone): daily payment (`Malipo ya siku` TZS 2,676),
  lock countdown `SIKU:MASAA:DAKIKA:SEKUNDE` (time until the phone locks), payment progress
  %, models on the account. Nothing to import; shows what the customer sees when our credit
  team calls.
- **hoopltd.shop sale receipt**: Rcpt_No, date, time, Agent (a THIRD agent-name spot —
  "Maria" on the sample), customer name/phone/ID_No, item + IMEI, price, "Goods Once Sold
  Cannot Be Re-Accepted". Receipt URL slug looks like `<phone><token>`.
- **Watu backoffice** (z-simu.watuafrica.com) application card: application id (57NWH220FL),
  status COMPLETED, client phone `+255…`, client name, model with SM- code, price, IMEI,
  **Front officer / Back officer** (Watu-side staff), last-update stamp.
- **hoopltd.shop "Unapproved Commissions"** grid: Date, Agent, Product, Imei, Sp,
  Commission, Status, Action — commissions await an approval step.
- **hoopltd.shop "Pending Uploads (Receipts, Releases & Watu_App_Image)"** grid: Date,
  Item, Agent, Imei — the verification queue general duty works through.

### 3. What this enables when the owner says PROCEED (not before)

1. **Sales importer** — second upload type next to the Watu list: header candidates from
   the table above, drop the Total row, price-as-text parsing, `pnorm` both phones, store
   Agent AND Commission_Agent AND (from receipts, if ever exported) the receipt agent.
2. **Sales register** (`hoop_sales` table): imei PK-ish (replacements/reversals may repeat
   an IMEI — key on imei+receipt_number), joined to `watu_loans` by IMEI at read time.
3. **Commission view**: per normalized Commission_Phone — sales counted, amount owed
   (needs the commission RULES in writing — still on the chase list), approval status when
   we get an export of the Unapproved Commissions grid.
4. **Reconciliation report**: hoopltd.shop sale ↔ Watu register row (IMEI match), naming
   sales that exist in one system and not the other.

## 2026-08-15 — from Gilbert (IT): the Watu sales report, and WHY

`WS_ Dealership Sales II Loans Table 14 AUG.csv` — Watu's own record of loans disbursed on
14/08/2026, the SAME day as Mwinyi's export. The owner's words: *"Gilbert uses watu sales
report as of credits and compares to mwinyis report to verify sales.. so as to find
fraud."* The fraud check = these two files diffed by IMEI.

Columns (16): Shop ("Hoop Limited, Kinondoni" — the region rides after the comma), Agent,
**Agent ID** (Watu's stable numeric identity — the anchor free-text names lack), Client
Name, Client Mobile (255-format), Model, Model Details (SM- code), Disbursed Date
("Aug 14, 2026" format), IMEI, Price, Has Ever Paid, Days Offline, Onboarding Time (Min),
App Signed Up, Locked 4+ Days, Locked 7+ Days. The last lock/offline columns are EMPTY on
fresh sales — **this is the same column family as the daily locked list**, so Watu exports
one loans table under different filters, and our existing watu importer's header
candidates already understand this file.

### The cross-check, actually run on the two 14-Aug files

- 23 Watu loans, 24 hoopltd.shop sales, **18 match by IMEI** — and on all 18, phone,
  price and client name agree exactly. The systems describe the same sale when they share
  an IMEI.
- **5 Watu loans with NO hoopltd.shop sale**: Yohana Athuman Ongujo (Lucas Mwita),
  Gertruda Mashaka Magulu + Shabani A Ngarago (Vanence Chelehani), Sayuni John Ngogo
  (Anord Sawe), Mzawalu J Ibrahim (ALOBOGASTI). Financed by Watu, missing from Hoop's own
  book — late receipt entry, or an off-book sale.
- **6 hoopltd.shop sales with NO Watu loan that day**: Fredy J Damasi (rcpt 9969) and
  Anastela B Dauda (rcpt 9968) by Cyprian; and **four receipts (9951/9952/9954/9955) all
  sold to "HOPE MICROCREDIT", all phone 0677111882**, by ELIA CHITUZI — reads like a bulk
  cash/manual sale to the owner's own company, not Watu-financed; owner to confirm.
- **Agent-identity drift on matched sales**: 6 sales under Watu agent Vanence Chelehani
  (id 128245) pay commission to "Cyprian dotto renatus" in Hoop's book; Watu's Grace
  Shirima and Sara Fisoo sales pay "Nestory Joseph". Sales going out under one person's
  Watu agent account with commission claimed by another — exactly the pattern the fraud
  report must surface, and why the register keys on **Watu Agent ID**, with hoopltd's
  Commission_Agent/Commission_Phone as the payout side.

### Honest limits

One day of each file. "No Watu loan that day" is not fraud by itself — a loan can land a
day late. The real report needs a ±1-day window, i.e. date-RANGE exports of BOTH files
(already on the chase list).

### When the owner says PROCEED, the fraud report is

upload both files → match by IMEI → four buckets (matched-clean, matched-with-field-drift,
watu-only, hoop-only) → agent-identity drift called out per sale, keyed on Watu Agent ID.

### The owner's full loop, in his words (2026-08-15) — the phase-2 spec

*"cover agents data per customer and know their conversion rates and performance … when
we get sales report from general duty we then match it with that of watu credit report …
auto detect fraud sales in general duty not in [watu] file and match them to
[fraudsters'] data in sipho daily."*

1. **Agent per customer** — done at the data level already: `agent` rides on
   `watu_loans`/`watu_snapshots` and shows on every Customers row and detail card.
2. **Agent scorecards** (conversion + performance): per agent — sales made (denominator,
   from the sales files), and how their customers BEHAVE (numerator, from the daily
   follow-up uploads joined by IMEI): % ever paid, % locked 4+/7+, average days offline,
   % surviving the 45-day window. An agent whose sales keep locking is a quality signal
   commissions should see before payout.
3. **Fraud autodetect**: a sale in general duty's book whose IMEI never appears in a
   Watu file (±1-day window — a loan can register a day late; and a CASH-SALE bucket so
   bulk non-Watu sales like the HOPE MICROCREDIT receipts are labeled, not accused)
   → flagged automatically on upload.
4. **Name the person**: every flagged sale resolves its seller against `hoop_agents` by
   payout phone (pnorm) — full identity on file: name, phone, national ID, **next of
   kin**. Fraud report shows the sale AND who answers for it.

## 2026-08-15 — from Sipho (warehouse): SyscoPos page saves

Twenty-four saved HTML pages from hoopltd.shop (SyscoPos by Codverts), logged in as
SIPHO: AGED_STOCK, PAGE_1…PAGE_11 (the Agents Register), and 13 per-RSM Aged Stock
saves (ANORD_SAWE … STANLEY_PHILIPO). SyscoPos tables are server-side DataTables that
fetch rows by AJAX a moment after the page opens, so a save only captures rows that had
ALREADY rendered on screen:

- **PAGE_1 captured real data: agents 1–100 of 1,046** ("Showing 1 to 100 of 1,046
  entries") — parsed, cleaned (0 duplicate phones, 0 duplicate national IDs) and turned
  into `db/migrations/RUN-ME-2026-08-15-agents.sql` (idempotent upsert on phone).
  Breakdown: 59 Field_Officers, 35 Team_Leaders, 5 Regional_Managers, 1 CSM; branches
  Dar es salaam 46, SOUTHERN HIGHLAND 19, Ubungo 14, ILALA 8, BEST SELL 5, GET RICH
  UP-COUNTRY 5, Shekigenda 2, Head Office 1. **946 agents still to capture.**
- PAGE_2…PAGE_11 and ALL 13 per-RSM aged-stock saves carry ZERO rows — saved before
  the AJAX rows rendered.
- **How to capture reliably**: Aged Stock has export buttons — click **CSV** on the
  report itself (works filtered per RSM too). For the Agents Register (no export
  button): set Show → **All**, WAIT until the rows are visible on screen, then save
  the page — PAGE_1 proves that captures everything rendered.

What the shells teach:

### Aged Stock (AGED_STOCK.html)
- Report "Aged Stock (5 days)": Agent | Item | Serial (IMEI) | Received | Age, fed by
  `/stocks/overdue_serials_table/`. The 5-day limit is a setting (Age_Limit in days).
- **The age-reset flaw, confirmed in the UI**: the Agents page carries per-agent
  "Reset Stock Age" and a global "Reset_All_Stock_Age" ("not reversible"). Age in
  SyscoPos is a mutable counter that transfers/resets renew — TRUE age since purchase is
  lost, exactly the flaw the training notes named. Our stock module (phase 3) computes
  age from the FIRST receipt of the IMEI (purchases register), immune to transfers and
  resets. This table HAS export buttons (copy/csv/excel/pdf) — a real CSV is one click.

### Agents Register (PAGE_1…9, all the same page)
- Row shape: Date joined | Name | Details | Next_Of_Kin | Role | Branch | Status.
- The add/edit form is the full staff model: Company (**multi-company: HOOP LIMITED,
  GETRICH VENTURE, Phonehive Stores**), names, email, National_Id, phone (0-format),
  Branch, **Next of kin (name/phone/relationship)**, password, commission, target,
  Agent_Type hierarchy **Country_Sales_Manager > RegionalManager > Team_Leader >
  Field_Officers**, each linked to its manager, Active/In_Active.
- This is the staff list the chase list wants — but it must arrive as DATA, not a shell.
  The Agents table has NO export button, so: select-all-copy into Excel after setting
  "Show All", or screenshots, or ask Codverts for an export.
- Security note for the owner: SyscoPos's edit endpoint (`/accs/useredit/<id>`) returns
  the agent's PASSWORD in plain text to the browser. Vendor flaw worth raising with
  Codverts; nothing for us to build on top of it.

### The full SyscoPos module map (sidebar), for the phase-3 design
Products Master (register, payment plans, categories, brands, tax, pricing zones) ·
Stock Levels (agent stocks, role summary, stock summary, assets, aged stock) ·
Stock Transfer (move, **pending receipt = the receive-confirmation step**, movement
register) · Stock Deductions · Stock Requests (new/pending/register) · Purchases
(new/pending/register/suppliers) · POS (phones, accessories, carts, sales register,
my commission) · Portfolio · Expenses · Reports (sales by company/branch/agent,
**Incomplete_Sales**, customers, purchases, serials active/sold/**unallocated**,
Imei_History, commissions register, performance analysis by role) · Administration
(agents).

## Standing rule 2026-08-15: data goes INTO the database, not just into docs

The owner's words: *"whenever i need that data please insert it directly into db."*
When a real data file lands, it gets inserted the same day, through one of two channels:
1. **An existing endpoint when one fits** — Watu-shaped files go through `/upload`
   (Gilbert's 14-Aug sales CSV is uploadable AS-IS today: same 16 columns; pick date
   2026-08-14. It seeds snapshots + the register with real customers and agents, and it
   does NOT displace a deck with a newer date — the phones list the NEWEST deck_date).
2. **Paste-ready SQL for the Supabase editor when no endpoint fits** (the proven schema
   channel) — e.g. the staff list into teams/call_users/access_codes the day it arrives.
The sandbox cannot reach the database directly; these two channels are how "directly"
happens, and docs/ entries are the memory, never the destination.

## Standing rule shipped 2026-08-15 (the "nb")

**Locked 7+ but past day 45 is NOT Hoop's responsibility.** The app's Lock 7+ tab and the
Locked 7+ tiles (portal dashboard + app strip) count only locked-7+ customers still inside
the 45-day window. Beyond-45 customers stay on the deck and remain visible in the 45+ tab —
they are simply not this team's call burden.
