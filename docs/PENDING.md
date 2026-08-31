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

**RUN BOTH MIGRATIONS FIRST:**

1. `db/migrations/RUN-ME-2026-08-29-salary-advance.sql` — the `staff_advances` table.
2. `db/migrations/RUN-ME-2026-08-31-advance-leader.sql` — the **Kiongozi** switch on access codes.

Until each is run, the panes that need it say so in plain words rather than showing an empty
table, and they name the exact file. "No rows" and "no table" must never look the same on a
screen about money.

### Who opens the approval pane: the nav AND the person

> "The ones i grant approval role can only see data of the same role to keep confidentiality of
> departments ... all access codes should have a button to switch that that person is a leader
> in ther role so those with that switch on can extend to approval nav"

Every other pane in this system is granted by role alone. The approval pane is the exception,
and it needs **both**:

- `advappr` ticked on the **role**, and
- **Kiongozi** ticked on the individual **access code** — a one-click button in its own column
  in the codes table, sitting just before Hariri and Futa. It confirms first, because pressing
  it hands that person the approval pane and every request their department has filed. (The
  same switch is on the form below, for setting it while creating a new code.)

Ticking `advappr` on CREDIT would otherwise hand the approval pane to every credit officer, when
what is meant is the one person who leads them. "Leads their department" is a fact about a
person, not a role, so it lives on the code.

### What they see: their own department only

An approver sees advances asked for by people carrying **the same role they do**, and can decide
only those. The amounts are the confidential part. The boundary is enforced twice — the queue
filters, and `advDecide` checks again, because a filtered view is not a control. A request from
another department answers "no such request" rather than naming the department, which would
leak the thing being protected.

**The leader must hold the same role as the people they approve for.** A code with role
`CREDIT LEAD` will not see `CREDIT` requesters — the roles must match exactly.

**The report is not scoped.** `advrep` is company-wide: HR files and pays for everybody, and
scoping it would break the bank run it exists to produce.

**ADMIN is full access everywhere**, by standing rule — every department, no Kiongozi tick
needed. A read-only `AUDITOR` code sees all of it too and can change none of it.

Four amounts only — 50,000 / 100,000 / 150,000 / 200,000 — enforced on the server as well as in
the dropdown. The requester supplies their own bank or mobile-money details at the moment of
asking, because they are the only person who knows them and a row without them stops HR's
payment run while somebody makes a phone call.

**Two figures, kept apart on purpose.** The approver's drawer opens pre-set to the full amount
requested and can be lowered but never raised, and `approved_amount` is its own column — so the
report shows what was asked AND what was granted. Overwriting one with the other would destroy
the record of a part-approval, which is exactly the gap somebody argues about at the counter.

**Holding both navs means holding both powers, own request included.** This shipped once with a
self-approval refusal, and it was wrong for this system:

> "role is navigation based so i didnt expect (This is your own request — another approver must
> decide it) if someone has both navs can do both"

The navs **are** the roles. Ticking both `advreq` and `advappr` on somebody is the owner saying,
in the only way this system has of saying it, that this person may ask **and** may decide — so a
refusal on top of that was the code overruling the grant it was handed, and it quietly made a
tick mean less than it says. **The control is who you tick `advappr` on**, not a second opinion
held by the code.

What the code keeps instead is a **record**: `decided_by` is stamped on the row, so a
self-decision reads as one on HR's report — the same person in the staff and decided-by columns —
and `advDecide` is in `AUDITED` either way. The drawer says so at the moment of pressing, as a
muted note that blocks nothing.

One control that IS enforced on the server: **two approvers pressing at once**. The update is
guarded on `status='pending'`, so the second is told it was already decided rather than silently
overwriting the first decision.

### Fixed after a live audit (2026-08-31)

The feature shipped, then an audit against real Postgres/PostgREST semantics found defects the
216-test suite could not see, because the suite runs on an in-memory fake. All are fixed and
each now has a regression test:

- **Duplicate advances.** `advRequest` appends, and was not on the client's `NO_RETRY` list — a
  dropped response (including a 504 with an HTML body) re-filed the identical request up to two
  more times, and the bank run would pay it twice. `advDecide` is on the list too: retrying it
  is harmless but tells the approver somebody else decided a request they had just decided.
- **Access codes on the wire.** `staff_code` is the login credential, and it was on every row of
  the approval queue. The server now answers the only question the screen had — "is this mine" —
  with a boolean.
- **Bank details to approvers.** The queue selected `bank_name`/`account_no` for a pane that
  never shows them. Narrowed at the SELECT.
- **The word "undefined" over three panes.** All three advance panes called `paneFailed` wrongly,
  so any load failure painted `undefined` instead of an error card.
- **Every exported heading carried the filter funnel** — `⏷` in Excel, `?` in the PDF, on every
  table in the whole portal.
- **The dispatcher answered to inherited names.** `FNS['constructor']` and friends were truthy,
  so they were called past `requireNav`, `requireWrite` and the audit log. Own properties only.
- **500s that should have been 400s** — a non-uuid id, and a date like `2026-02-30`.
- **A stale month.** The report's default range was frozen at page load, so a tab left open
  across a month end showed last month as "this month".
- **Tiles that moved when clicked** — totals are counted over the date range, not the status lens.
- **An audit log that could not say which request** — `id` now survives into `subject`.

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

---

## 7. The Devices pane, re-read before the presentation

> "please re-inspect all the devices pane functions are good and effecient: am going to
> presentation and more shocks like the directors meeting is unbearable"

An adversarial sweep of every function this pane calls. Nothing below was a crash — all of it
was the pane **stating something with confidence that was not true**, which in front of a room
is worse than an error, because an error is at least visibly an error.

### What the screen was getting wrong

- **Historia ran three hours behind the row above it.** `device_events.at` is a timestamptz and
  PostgREST hands it over as UTC text; the panel printed that text, while the register row
  directly above renders `last_seen` through `clock()`, which is fed milliseconds and is
  therefore local. Dar es Salaam is UTC+3. The one panel you open to prove *when* a lock was
  ordered and when the handset confirmed it disagreed with the row above it, on the same
  screen, at the same moment. The server now sends `atMs`, like every other time in this system.
- **The table stopped at 500 and the tiles did not.** `deviceList` sends the newest 500 rows and
  a count of all of them; the pane read `rows` and ignored `total`. A fleet of 640 showed tiles
  adding to 640 above a table holding 500, with nothing on screen to say which number was the
  truncated one. It now says so.
- **The count beside Funga went stale under a column funnel.** Ticks are scoped to visible rows
  on purpose — you act on what you see — so hiding a ticked row drops it from what Funga will
  touch. The tick handlers resync the count; the funnel is not a tick handler. "Zilizochaguliwa:
  35" could sit beside a button about to darken nine.
- **Achia asked nothing.** Funga and Imepotea both stop to demand a reason. Achia — which tells
  the handset to drop Device Owner and stop calling home, undoable only with a cable and the
  phone in hand — fired on the first click, on however many rows were ticked. It now confirms,
  and names the number.
- **The bulk buttons stayed live during the request**, so a double-click sent the order twice:
  two rows in Historia for one decision, and a second toast reading "Zimebadilishwa: 0".
- **Sorting "Iliongea lini" sorted on `"14:3236h"`** — the clock and its grey age subline welded
  together by `textContent`, leaving the column ordered by a leading `14`. The sort now reads
  the same value the funnel on that header already reads.
- **A view-only code got every write button** — Funga, Achia, Fungua, Imepotea, Token, Futa,
  Enrol — and discovered the 403 by pressing it. Historia is a read and stays for everyone.
- **"The line that matters is the last one" was wrong for the hub command.** One phone ends in
  one broadcast; the hub command broadcasts once *per handset* and prints a result line for
  each. An operator with nine phones told to read the last line reads one, calls the bench
  finished, and discovers the other eight missing later. It now says how many `ENROLLED` lines
  to count.
- **Historia opened below the whole table**, which on a long register is off-screen — so the
  button read as doing nothing. It scrolls to what it opened.

### What it was doing wastefully

- **Every read of the register fired a guaranteed-failing query first.** `devices` is keyed by
  IMEI and has no `id` column, but `PAGE_KEY` had no entry for it, so the paging tiebreaker
  defaulted to `id` and asked PostgREST to order by a column that does not exist. `fetchAll`
  caught the 400 and re-read the table unordered, exactly as designed — so nothing broke and
  nobody saw it. The cost was two round trips for every read, one of them certain to fail, on
  the busiest pane in the system and on every heartbeat that looks a handset up.
- **`deviceHistory`'s `.limit(100)` never applied** — `fetchAll` pages with `.range()`, which
  overwrites the Range header `limit()` set. The cap now applies where it actually works, and
  the pane is told the total so a truncated history says so.

No migration. The register itself is unchanged.

### The one that would have cost real money

**One unreachable phone cancelled the lock on the nineteen beside it.**

Funga refuses a handset that was released and has not spoken since — it dropped Device Owner
and stopped calling home, so a lock ordered against it sits unheard. That refusal is right, and
the override beside it is right too.

But it threw **before touching anything**. So ticking twenty phones with one such handset among
them locked **none of them**. The client then did exactly the right thing with the wrong facts:
it offered the confirmation and retried only the phone the server had named. The other nineteen
were never locked at all, and the toast that followed read `Zimebadilishwa: 1` — which an
operator reads as the job being done.

Twenty customers' phones left open while the register says they are shut, with nothing on
screen to suggest otherwise.

Three separate comments in this codebase — on the client, on the server, and on the test —
already described the intended behaviour, in the words *"they were locked the first time"*. The
server now does that: every reachable phone is locked first, and the 409 that follows is a
question about the ones that were held back, carrying the count of what already happened so the
dialog can say `19 already locked` instead of implying nothing did.

Two smaller things went with it: **every** unreachable IMEI is named rather than the first
twenty (the client retries exactly the list it is handed, so a truncated one is a set of phones
the override silently leaves unlocked), and `withApi` gained a third opt-in field on a refusal —
a count, never a payload.
