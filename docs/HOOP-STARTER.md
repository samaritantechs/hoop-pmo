# HOOP PMO — Starter Pack

**Paste this whole file as the FIRST message of the new Claude Code session for the `hoop-pmo`
repo.** It carries everything that session needs: what Hoop is, how it maps onto the HOPE
system it will be built from, the 8-hour presentation plan, the schema draft, the importer
spec, the setup runbook, and the standing rules.

Written 14 August 2026, from the owner's Hoop training notes. Owner: samaritantechs.

---

## 1. What Hoop is

**Hoop Ltd** is a sister company to Hope Microcredit. It is a **phone dealership agent for
Watu Credit (watu simu)**: Hoop buys phones (Samsung A05/A06/A07, prices vary over time),
registers them into Watu's system, and Watu pays Hoop the loan value — e.g. a phone bought at
400k registered into watu-simu owes 500k from Watu, so ~100k margin per unit.

**The lock is the whole mechanism.** Watu locks the phone remotely; each daily installment
paid auto-unlocks it for that many days (pay 2 days' worth → unlocked 2 days). 7 days grace
from disbursement, daily payments from day 8. There is **no "defaulter" state** — a customer
who missed days and then pays gets unlocked as usual; their contract just stretches. The
pressure is entirely in the follow-up call.

**The 45-day window.** Watu sends Hoop a daily list (random customers, date ranges) for
follow-up. Hoop's credit team owns customers for **45 days from disbursement**; after day 45
the burden returns to Watu. Hoop is held to a **7% default rate** within that window — and the
rate "washes" as cohorts age out, good or bad. This is Hoop's version of Hope's count 1-6
duty: two companies keeping each other's attention on the same book.

**The commission audit problem.** Hoop records sales same-day in its own system
(hoopltd.shop); Watu's sales report arrives **the next morning**. The accountant can only pay
agent/RSM commissions after matching yesterday's Hoop sales against today's Watu report —
because a sale recorded in Hoop that never appears in Watu is fraud. This match is manual
today. **An automatic sales audit (watu × hoop) is a core ask.**

### The people

| Role | Like Hope's | Who | What they do |
|---|---|---|---|
| Finance/Administrator | — | Peter Kisoli | administration |
| Accountant | — | Madam Janeth | pays commissions AFTER the watu×hoop match |
| Store Keeper | — | Mr Sipho | warehouse: purchases, stock to RSMs, aging stock, movement between dormant/active holders |
| Regional Sales Manager (RSM) | team | e.g. Anold Sawe | acquires + distributes stock, recruits agents, target 500 pcs/month; agents/team-leaders request stock from RSM, RSM from storekeeper |
| Agents / Team leaders | officers | freelancers/shop owners | sell to the customer |
| **Credit team** | **PMO follow-up** | e.g. Ainea | **calls locked customers within the 45-day window — THE APP IS FOR THEM** |
| General duty | credit analysts | e.g. Mwinyi | verify sales: receipt picture, IMEI, names, dates match |
| IT support | — | Gilbert | registers agents, liaises with Watu, trains |

### Departments seen in training, and what they lack today

- **CREDIT**: works off a locked-7-days export (see §5 for its exact columns). Missing from
  their data: guarantor info, total arrears, follow-up comments (those live only in
  hoopltd.shop). To request from Watu: payment progress / records to date. They also want the
  full Watu data uploaded to compute a portfolio offline rate.
- **GENERAL DUTY**: approves sales from screenshot + ETR receipt + watu app image; pending
  list has weekly payment/watu price/IMEI/guarantor, but the sales report has only customer +
  model unless searched one-by-one by IMEI. Commissions (e.g. 75k per sale to agent, ~30k +5
  per sale to RSM). Receipt purchases not recording; receipt transfers between super-agent →
  RSM → agents need receive-confirmation. Stock requests RSM→general duty. Target analysis
  per RSM (name, sold, gap, achievement, commission), branched into agents. Sales reversal →
  back to stock. Aged stock (transfers renew age — a flaw to fix: track TRUE age). Can only
  see ~30 of 150 receipts/day; mobile re-login pain; wants receipt history. Wants sales
  report by date range showing phones + price owed per watu value. Wants a timestamp camera.
- **WAREHOUSE**: product master/register; purchases assigned to super-agent; stock level by
  holder (super-agent, RSM, team leader, agent) with aging (e.g. 1.9k of 2.2k pcs by days);
  role summaries (phone type + qty per RSM); replacements; field stock follow-up; stock
  requests by level. **Cannot see stock holding per date** to trace reduced sales per date
  per role — a point-in-time stock view is wanted.
- FINANCE and IT: notes pending — ask.

---

## 2. Build it FROM the HOPE codebase

The fastest correct path — and the one the owner chose — is to **adapt `samaritantechs/hope-pmo-v2`**,
which already solved every hard problem this project has: sliced uploads, a working register
the phones read, offline-tolerant call app, leader scoping, reports, exports, speed budgets.

In the new session, first run: **add repo `samaritantechs/hope-pmo-v2` (read)** — then copy
files from it rather than rewriting from memory.

### The mapping

| HOPE | HOOP | notes |
|---|---|---|
| defaulter deck upload (Mon–Sat) | **watu daily list upload** | same rhythm, different columns |
| `followup_status` (working register) | locked-customer register | keyed on **IMEI**, not loan ref |
| customer ref | **IMEI** | the natural key; client mobile is the contact |
| team | **RSM region / shop** | scoping works identically |
| PMO / collection officers | **credit team callers** | the app users |
| credit analysts | general duty | sale verification |
| count 1-6 window | **45-day lifetime window** | computed from `disbursed_date` |
| defaulter status | **days offline / locked 4+/7+** | no defaulting concept — locking instead |
| HOPE Calls (`/call`) | **HOOP Calls** | same app, rebranded, list = today's watu upload |
| Ripoti (COL/REC/%pf + call icon) | same | carries over as-is |

### Standing rules — carried over verbatim, they are conditions not preferences

1. **Additive only, whole files.** Never destroy working behaviour.
2. **`npm test` is the acceptance gate.** Copy Hope's test harness (fake-db) on day one.
3. **Server logic in `api/_lib/`**, pages served as written from `public/` — no build step.
4. **Team (RSM/shop) scoping at the database**, not in the page.
5. **The Postgres budget** — the owner's permanent instruction, quoted: *"from now on on
   whatever we implement, we go into postgress war… it's a forever instruction."* Every
   change states its round trips (warm, the second handset), row bounds, and whether reads
   were shared. Read `ARCHITECTURE.md § the Postgres budget` in hope-pmo-v2 and copy that
   section into the new repo's ARCHITECTURE.md.
6. **PostgREST silently caps reads at 1000 rows** — use Hope's `fetchAll`/`rpcAll` pattern
   everywhere (copy `api/_lib/supabase.js`).
7. **An upsert updates exactly the columns in the payload** — to preserve a value, don't
   mention it. This fixed two data-loss bugs in Hope; don't relearn it.
8. **EAT clock (UTC+3)** via Hope's `time.js`.
9. Deploy after every fix; PR → merge → Vercel auto-deploys.

---

## 3. The 8-hour plan (morning presentation)

**Goal: a working system + linked call app to present, then amend from that primary build.**

Must land (in order):

1. **Hour 0–1: scaffold.** Copy from hope-pmo-v2: `api/_lib/supabase.js`, `parse.js`,
   `time.js`, auth pattern, test harness, `package.json`, `vercel.json`. New `db/schema.sql`
   (see §4). Run schema in Supabase SQL editor.
2. **Hour 1–3: the watu importer + upload page.** Columns in §5. Key on IMEI. Slice at 1000
   rows/request like Hope. Replace-by-day semantics: today's upload IS today's list.
3. **Hour 3–5: HOOP Calls.** Copy `call.html`, rebrand (HOOP Calls, colors when provided),
   point Leo at the uploaded day list: name, phone, model, price, days offline, locked
   badge, days-in-lifetime (45 − days since disbursement), call + log + comment + promise.
   Registration by team code = RSM/region code.
4. **Hour 5–6: Ripoti + recovery report.** Copy Hope's Ripoti (COL/REC/%pf + officer call
   icon). Recovery view: of the uploaded locked list, who paid after our call window
   (has_ever_paid / days_offline deltas between consecutive uploads).
5. **Hour 6–7: portal shell.** Dashboard tiles: uploaded today, locked 4+/7+, inside-45-days
   count, calls made today, % reached. Teams (RSM) screen. Access codes. Upload page.
6. **Hour 7–8: deploy, seed with the sample rows (§5), rehearse the demo path**, and write
   the roadmap slide: sales audit (watu×hoop), commissions, stock — phases 2–3, not built
   tonight, shown as designs.

**Cut tonight (present as roadmap):** commissions engine, receipts flow, stock module, sales
reversal, timestamp camera, point-in-time stock. Do NOT attempt these in the 8 hours.

---

## 4. Schema draft (v1)

```sql
-- The customer/loan register: one row per phone, keyed on IMEI.
create table if not exists watu_loans (
  imei text primary key,
  client_name text,
  client_mobile text,          -- 2557..., the number the credit team rings
  shop text,                   -- "Hoop Limited, Kinondoni"
  agent text, agent_id text,
  team text,                   -- RSM region; references teams(team)
  model text, model_details text,
  disbursed_date date,         -- 45-day window computed from this
  price numeric,
  has_ever_paid boolean,
  days_offline integer,
  onboarding_min integer,
  app_signed_up boolean,
  locked4 boolean, locked7 boolean,
  snapshot_date date not null, -- the day this state was uploaded (watu daily list)
  upload_batch text,
  updated_at timestamptz default now()
);
-- history of states, append-only (like Hope's snapshots):
create table if not exists watu_snapshots ( like watu_loans including all_but_pk... );
-- in practice: same columns + id, no PK on imei, indexed (snapshot_date, imei)

-- Working register the phones read (Hope's followup_status, keyed on imei):
create table if not exists followup_status (
  imei text primary key, client_name text, contact text, team text,
  model text, price numeric, days_offline integer, locked7 boolean,
  disbursed_date date, lifetime_day integer,        -- day N of 45
  fu_status text, promise_date date, promise_amt numeric,
  comment_by text, comment_at timestamptz
);

-- Copied from Hope nearly verbatim:
--   teams (team = RSM/region, team_code, rsm, rsm_no, ...), access_codes, roles,
--   call_users, call_logs, followup_comments, settings, hints, audit_log

-- Phase 2 (design now, build later):
--   hoop_sales (hoop's own daily record), watu_sales_report (the next-morning file),
--   sales_audit view: hoop_sales left join watu_sales_report on imei
--     -> MATCHED (pay commission) / HOOP-ONLY (fraud flag) / WATU-ONLY (unrecorded)
--   commission_rules (role, per_sale, bonus), commission_runs
-- Phase 3: products, stock_moves (holder->holder, preserves TRUE age), stock_requests
```

Indexes from day one: `watu_snapshots(snapshot_date, imei)`, `call_logs(call_date, team)`,
plus whatever the reports actually filter on — and the budget stated in every PR.

---

## 5. The watu importer — exact columns (from the locked-7-days export)

```
Shop | Agent | Agent ID | Client Name | Client Mobile | Model | Model Details |
Disbursed Date | IMEI | Price | Has Ever Paid | Days Offline | Onboarding Time (Min) |
App Signed Up | Locked 4+ Days | Locked 7+ Days
```

Sample rows (use as test fixtures and demo seed):

```
Hoop Limited, Kinondoni | Denis John | 120405 | Alafati Kalikawe Selemani | 255716548153 | A07 | A07 (SM-A075F/DS) 64GB/4GB | 13-Jul-26 | 351929937378664 | 450000 | FALSE | 21 | 375 | TRUE | TRUE | TRUE
Hoop Limited, Kinondoni | Adolph Steven | 96231 | Yuda M Japhet | 255773460588 | A07 | A07 (SM-A075F/DS) 64GB/4GB | 30-Jun-26 | 351738748292885 | 450000 | TRUE | 12 | 25 | TRUE | TRUE | TRUE
Hoop Limited, Kinondoni | Frument Theonest | 115443 | Rinus Njunwa Paschar | 255650793471 | A07 | A07 (SM-A075F/DS) 64GB/4GB | 29-Jun-26 | 351929937369465 | 450000 | TRUE | 10 | 59 | TRUE | TRUE | TRUE
```

Importer notes (learned the hard way in Hope — copy its `parse.js`):

- **Dates are `13-Jul-26`** (day-MonthName-2-digit-year) — a different shape from Hope's
  numeric dates; write a dedicated parser, test all 12 month names.
- Booleans arrive as `TRUE`/`FALSE` text.
- Phone `2557...` — normalize with Hope's phone helpers; `telHref` handles +255.
- **IMEI is the ref**: 15 digits, must stay TEXT end to end (Excel mangles it as a number —
  exports must write it as text, same trick as Hope's phone columns).
- Header-presence rule from Hope applies: only columns present in the file are written.
- Known gaps in this feed: no guarantor, no total arrears, no payment progress. Follow-up
  comments live in hoopltd.shop only. Don't invent these columns; leave room for them.

---

## 6. Setup runbook (owner does these — ~20 minutes)

1. **GitHub** — github.com/new → name `hoop-pmo`, **Private**, initialize with README →
   Create. (The Claude GitHub integration cannot create repos itself — it got 403 trying.)
2. **Supabase** — same org (already on Pro $25) → New Project `hoop-pmo`, strong DB
   password, region closest to Tanzania (eu-central). Copy **Project URL** and
   **service_role key** from Settings → API. *(≈ +$10/mo compute for a second project on
   the org — see §8.)*
3. **Vercel** — Add New… → Project → import `hoop-pmo` → Environment Variables:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` → Deploy. (No build step, same as Hope.)
4. **Claude** — new claude.ai/code session on `hoop-pmo` → paste THIS FILE as the first
   message, and tell it: *"Add repo samaritantechs/hope-pmo-v2 for reading. Follow §3."*
5. When the session hands you `db/schema.sql` → paste into Supabase SQL editor → Run →
   tell it "schema ran, success".

---

## 7. Materials to request from Hoop (ask these tomorrow — the build starts without them)

1. **The daily follow-up list** Watu sends (Mon–Sat) — 2–3 real files. *(Is it the same
   16 columns as the locked export, or different?)*
2. **Full Watu sales report** — one real export, every column. (It "composes all data watu
   provides" — this is the reconciliation anchor.)
3. **hoopltd.shop sales report export** — one real file, plus a login or screenshots of
   Pending Upload/Approval and receipts screens.
4. **Commission rules in writing** — per role and per model: agent (75k?), RSM (30k? +5?),
   who else, and what disqualifies a sale.
5. **Price history** per model over time (A05/A06/A07).
6. **Staff list**: names, phones, roles, regions — feeds access codes and teams.
7. **Product/stock register** sample from Mr Sipho (phase 3).
8. Receipt samples: sale screenshot, ETR receipt, watu app image (what general duty checks).
9. **Brand**: logo, colors, and the domain they want (or run on vercel.app first month).
10. Precisely: the 45-day rule (calendar days from disbursement? inclusive?), and the 7%
    default-rate formula they are measured by.
11. FINANCE and IT department notes (blank in training notes).
12. Payment progress feed from Watu — formally requested already; chase it.

---

## 8. Running costs — the client declaration

Owner's live bills today (for both projects together): Claude Max $100/mo, Vercel Pro
$20–25/mo, Supabase Pro $25/mo. GitHub private repos are free. A second Supabase project on
the same Pro org adds ≈ **$10/mo** compute; a second Vercel project on the same team adds
**$0** base. So Hoop's true marginal infra cost is roughly **$10–35/month**, plus its share
of the Claude subscription while being actively developed.

**The client-facing paragraph (use as written):**

> **Running costs: USD 200, covering the first 2–3 months of operation.** This provides the
> production database with daily backups and point-in-time recovery (Supabase Pro tier),
> global hosting and serverless APIs with SSL (Vercel Pro tier), the private code
> repository, AI-assisted development and operations tooling, and usage headroom as call
> officers and uploads scale up. From month 4 onward, steady-state running costs are
> expected at **USD 70–100/month** depending on usage volume, reviewed quarterly. Any months
> the $200 stretches beyond the third are carried forward as credit.

*(That last sentence is optional — drop it if you prefer silence about the remainder.)*

| Line (monthly) | List price | Notes |
|---|---|---|
| Database, auth, backups — Supabase Pro | $25 | org-level; Hoop's marginal share ≈ $10 compute |
| Hosting + serverless — Vercel Pro | $20 | multiple projects per team |
| Private repo — GitHub | $0 | |
| AI build/ops share — Claude Max | $100 total | shared across all owner projects |
| Domain (yearly ≈ $12–15) | ~$1 | optional first month |

---

## 9. Paste-ready first prompt for the new session

> This repo is HOOP PMO — read the HOOP-STARTER.md I am pasting below in full, it is the
> specification. Add repo samaritantechs/hope-pmo-v2 with read access: it is the parent
> system, copy its architecture and files as the starter instructs rather than rewriting.
> Standing rules: additive only, whole files, npm test is the gate, server logic in
> api/_lib/, team scoping at the database, and the permanent Postgres budget rule from
> hope-pmo-v2's ARCHITECTURE.md. Tonight's goal is §3 — the 8-hour presentation build.
> Work through it in order, deploy after every landed step, and give me the schema to paste
> into Supabase as your first deliverable.

---

*This file lives in hope-pmo-v2 at `docs/HOOP-STARTER.md` so the new session can also read
it directly once hope-pmo-v2 is added to its scope.*
