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

## Standing rule shipped 2026-08-15 (the "nb")

**Locked 7+ but past day 45 is NOT Hoop's responsibility.** The app's Lock 7+ tab and the
Locked 7+ tiles (portal dashboard + app strip) count only locked-7+ customers still inside
the 45-day window. Beyond-45 customers stay on the deck and remain visible in the 45+ tab —
they are simply not this team's call burden.
