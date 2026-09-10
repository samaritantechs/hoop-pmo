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
| `advappr` | Idhini ya advance / Advance approval | the one person who decides |
| `advrep` | Ripoti ya advance / Advance report | HR — the filing copy and the bank run |

**Run `db/migrations/RUN-ME-2026-08-29-salary-advance.sql` first** — the `staff_advances`
table. Until it is run, every advance pane says so in plain words rather than showing an empty
table, and names the file. "No rows" and "no table" must never look the same on a screen about
money.

### SIMPLIFIED 2026-09-07: one approver, the nav is the whole grant

> "Hoop doesnt need the deprt leader approval for salary advance they want just requests and
> approval or rejection with comments: so people will only request then then approval nav is
> done by a single person and we stay with reports, so kill the kiongozi column and its working
> scheme just a approval nav will be granted to approver"

The approval pane is granted like every other pane: tick `advappr` on the approver's role, and
that is the permission. The approver sees **every** request in the company and decides any of
them. There is no department filter and no per-person switch.

What was removed: the **Kiongozi** column and button in Access codes, the switch on the new-code
form, the `accessCodeLeader` endpoint, and the same-role filter on the queue and on `advDecide`.
The `is_leader` column that `RUN-ME-2026-08-31-advance-leader.sql` added stays in the database
untouched and unread — a column that exists harms nothing, and a migration that drops one can.
You need not run that migration on a fresh database; sign-in no longer asks for the column.

**The report is company-wide**, as it always was: HR files and pays for everybody.

**ADMIN is full access everywhere**, by standing rule. A read-only `AUDITOR` code sees all of it
too and can change none of it.

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

---

## 8. Achia, enrol it again, Funga

> "all i need is to connect phone(s), copy cmd and lock, and unlock should work as long as i
> have not achia.. if i achia and re-enloll the same phone pick its old imei so that funga works"

**The identity half was already solved, and by a migration.** `device_tokens` remembers the
string, so a handset that comes back is handed the token it is still carrying rather than a
second one. That is what stops the register and the phone from disagreeing, and it holds.

**The state half was not.** Achia leaves the row reading `released`. Re-enrolling only updated
its batch, so the row stayed `released` — and Funga then hit the released-and-silent refusal.
The operator had just re-provisioned that phone by cable, which is the one honest reason the
override exists, and was made to argue with a warning about it anyway. A confirmation you
dismiss on every phone is a confirmation nobody reads by the third one.

Enrolling a handset **is** the statement that it is under our control again, so it is now
recorded as one: `released` → `enrolled`, `released_at` cleared, and a row in Historia so
*"why is this enrolled when I released it in March"* has an answer.

**Only from `released`, and that limit is the whole safety of it.** A **locked** phone stays
locked. If enrolment reset state generally, plugging a defaulter's dark handset into the bench
and running the same command anyone can copy off the screen would quietly free it — a lock
bypass with no decision behind it and nothing in the register to show one was made. `lost` is
held for the same reason: writing a handset off is a judgement, and a cable is not an appeal.

**No migration.** Every column involved has existed since the register did.

### The bench round trip, end to end

Enrol → Achia → enrol again → Funga is now one test, and it asserts the phone keeps `tok-p1`
throughout. One caveat that is physics, not code: Achia makes the handset **drop Device
Owner**, so re-enrolling it needs `dpm set-device-owner` to succeed again — which Android
refuses if any account has been added to the phone since. That is a factory reset, and no
amount of server code changes it.

## 9. Clicking a tile stopped re-downloading the register

`drawDevices` was one function: blank the pane, fetch, render. But only three of the five tiles
are questions for the **database** — `enrolled`, `locked`, `released` are `state` on a row.
The other two are not: **"Hazijawahi kuongea"** and **"Kimya / silent"** filter on flags the
server stamps onto each row as it sends it, so narrowing to them is arithmetic on rows the
browser is already holding.

Both kinds went through the same path, so clicking Kimya threw away a screen of rows, waited
out a round trip, and painted back the same bytes it had just discarded. On office wifi that is
a blink; in a room on a borrowed connection it is a second of grey where the fleet used to be,
every time somebody presses the tile you brought them there to look at.

Split into `drawDevices` (fetch) and `devPaint_` (draw). The render body moved **verbatim** —
proven byte-identical after a two-space dedent. The flag tiles repaint; everything else still
fetches, including the one case where a flag tile has to: clearing a live state chip *widens*
what the server would send, and those extra rows are by definition not in hand.

**What the split costs, on screen rather than hidden.** Repainting shows the register as of the
last read. So the chip bar now carries **`Ilisomwa 14:32`** and a **↻** button. A screen that is
slightly behind and says so is honest; one that is slightly behind and looks live is the exact
failure this pane has been fixed for twice.

---

## 10. Away today — suspending a person for a date range

> "I need a feature to suspend a user at (Access codes — mfumo (portal)) so that they don't
> appear anywhere unless reactivated, e.g one credit aint there today so if I suspend him the
> customer distribution of today is auto to the available ones"
> "so suspension is recorded by date picker start and end date"

**Run `db/migrations/RUN-ME-2026-08-31-access-suspend.sql`.**

A new **Yupo?** column in Access codes, between Kiongozi and Hariri. Click it, set two dates,
and that person is away for those days.

**A window, not a switch.** A switch has to be turned back on by somebody remembering to; an
absence has an end that is already known on the day it is entered. Recording the end means the
person comes back *by themselves* on the right morning — which is the difference between a
feature that gets used and one that quietly leaves half the company switched off. There is no
scheduler anywhere in this system and this needs none: the window is read against today's date
in EAT, wherever it is asked about.

Both ends count. The 3rd to the 5th is three days off. Leave the end empty for "until further
notice"; an end with no start is not a window at all and is refused rather than half-stored.

### What it reaches

- **Sign-in.** Refused, and told *which window* — somebody on leave should not spend the
  morning convinced they have forgotten their code. It is the one message here that cannot help
  an attacker, since you must hold a valid code to ever see it.
- **The credit round.** The deal is recomputed from the roster on every read and nothing is
  stored, so taking somebody out of the roster **is** the redistribution: today's customers are
  dealt among the officers who are present, with no orphans and no assignment to migrate. The
  test runs 60 customers over 4 officers, suspends one, and asserts all 60 are still dealt and
  the three who remain carry equal shares.

**ADMIN is never suspended.** It is the standing rule everywhere in this system, and here it is
also the lockout guard: a window set on the last admin — by a slip of the date picker, or by an
admin suspending themselves — would leave nobody able to lift it. The pane refuses to set one.

### Two things to know

**The link between an access code and an app account is the NAME.** Suspension is recorded on
`access_codes`; the credit roster is `call_users`. Those two tables describe the same people
with no foreign key and no shared id — they genuinely do not know about each other. The name is
all they share, so that is what is matched, token-sorted and case-folded (so "Juma Ally" and
"ALLY JUMA" are one person). If the two spellings differ, the suspension will stop the sign-in
and **not** change the distribution.

**The credits board still re-deals past days with today's roster.** That was already true before
this — `recoveryWeek` recomputes the last seven days on every read — but suspension makes it
visible: suspend somebody at 11am and last week's per-officer numbers shift. `suspendedNamesOn`
already takes a day so it can be judged correctly per-day; wiring the weekly board to use it is
the follow-up.

---

## 11. One phone, on its own screen

> "when the list is getting high suffocates so put them on a button 'locking' on each row before
> the token button so that we deal with each imei on its interface"

The four bulk buttons live at the **foot** of the table. That is right for a bench of twenty and
wrong for a register of four hundred: to act on one handset you tick its row, scroll past
everything else to reach the buttons, then scroll back to check you ticked the right one.

Every row now carries **Kufunga**, first in the actions cell, before Token. It opens a panel for
that one handset with Funga, Fungua, Achia and Imepotea on it — and with the three facts the
decision actually turns on, which are otherwise spread across a table you have just scrolled
sideways through:

- what was **last ordered**, and when, and by whom;
- what the **phone itself says** it is doing;
- **when it last spoke**, in red if it has gone quiet.

**It reimplements none of the safety.** The reason a lock demands, the sentence Achia has to be
answered with, the override for a released handset that stopped listening, and the in-flight
guard against a double-click all live in one shared function that both the bulk bar and this
panel call — with a list of many, or a list of one. Safety kept in two copies is safety that
will one day disagree with itself, and a test asserts the panel contains no `prompt`, no
`confirm` and no call to the server.

The panel closes only when an order actually went out. A cancelled prompt leaves it open, on the
phone the operator is still deciding about.

**The bulk bar is untouched** — this is a second way in, not a replacement. A hub of twenty
phones is still one tick-all and one press, which is the flow the multi-enrol work exists to
serve.

---

## 12. The orders moved above the table, and new phones float to the top

> "These buttons are so important but giving me headeche to find them on bottom
> (Zilizochaguliwa / Funga / Fungua / Achia / Imepotea) — put them on top of the table and all
> recent added imeis should be on top so that i dont hustle finding them"

### The four orders now sit above the register

They were at the foot because that is where a selection *ends* — you tick your way down the rows
and the buttons are waiting. That reasoning holds for twenty rows and collapses for four hundred:
the operator ticks a row near the top, then scrolls the whole register to reach the thing that
acts on it, with the tick out of sight the entire way.

Above the table they are always on screen, beside the tiles and the chips — which is where
everything else that *acts* on this pane already lives. **The count moved with them**, because a
number that tells you how many phones are about to go dark belongs next to the button, not a
scroll away; that was the whole reason it exists.

Nothing is left under the table, and a test asserts there is no second copy.

### Phones enrolled today ride on top

The existing order is deliberate and **stays**: written off, then a lock nobody has confirmed,
then silence — problems before routine, so the register opens on whatever needs a person. That
is right for a fleet at rest and useless at a bench, where the phones that matter are the ones
plugged in five minutes ago, and the sort buried them among hundreds by IMEI.

So a **band**, not a new sort. Anything enrolled in the last **24 hours** floats to the top,
newest first. Everything below keeps exactly the order it always had.

A day, because that is the length of a bench session and the life of an enrol batch — so by the
next morning these are just phones again and the fleet's own priorities take over, with nothing
to switch off and nothing to remember.

## 13. SHIPPED 2026-09-07: imprest and leave — ask, decide, retire, review

Five navs, two forms the office already prints. The full story is
[`docs/IMPREST-LEAVE.md`](IMPREST-LEAVE.md); the short version:

| nav | pane | who |
|---|---|---|
| `impreq` | Omba imprest / Imprest request | anybody who travels |
| `impappr` | Idhini ya imprest / Imprest approval | the administrator — and the **Viwango** rate table |
| `imprep` | Ripoti ya imprest / Imprest reports | the CEO's review copy |
| `leavereq` | Omba likizo / Leave request | everybody |
| `leaveappr` | Idhini ya likizo / Leave approval | HR |
| `leaverep` | Ripoti ya likizo / Leave reports | the CEO, HR and Finance |

**Do, in this order:**

1. Run `db/migrations/RUN-ME-2026-09-07-imprest-leave.sql` in Supabase — every pane names it
   until it is run.
2. Tick the five navs on the right roles in Access codes.
3. As the administrator, fill **Viwango vya malazi** on the approval pane: one row per role
   with accommodation per day. The request form offers only roles that have a rate.
4. Optional email: Settings → `IMPREST_ADMIN_EMAIL`, `IMPREST_CEO_EMAIL`, `HR_EMAIL`,
   `EMAIL_FROM`; then `RESEND_API_KEY` on Vercel. Blank means no email; the panes are the
   record either way.

The rate is looked up and **stamped** at request time, so a later rate change never reprices an
old trip. Receipts are shrunk on the phone (1024px JPEG, ~60–120KB), refused above 200KB by the
server, stored in their own table and fetched per request — no list ever carries a photo. The
one-week rule on the leave form is **flagged** for HR, never enforced, because the form's own
exceptions (illness, bereavement) make it HR's call.

## 14. SHIPPED 2026-09-08: issues — one log for everything somebody has to chase

Four SOPs (RSM C, Credit C, IT C, General Duty B) describe the same shape, so it is one table
and three navs. The full story is [`docs/ISSUES.md`](ISSUES.md); the short version:

| nav | pane | who |
|---|---|---|
| `issuereq` | Toa taarifa ya suala / Raise an issue | everybody |
| `issues` | Dawati la masuala / Issues desk | whoever works issues — ONE grant, a department chip to narrow |
| `issuerep` | Ripoti ya masuala / Issues report | the CEO and department heads |

**Do, in this order:**

1. Run `db/migrations/RUN-ME-2026-09-08-issues.sql` in Supabase — every pane names it until
   it is run.
2. Tick the three navs on the right roles in Access codes.
3. Optional email: Settings → `ISSUES_EMAIL` (one line per department, `IT=addr,addr`) and
   `GM_EMAIL` for escalations. Blank means no email; the desk is the record either way.

The department is a **label on the row**, never a nav: the rule since the advance was
simplified is one queue, one grant. A customer's complaint is an issue whose subject is an
IMEI, and the call card lists those above the customer's history so the officer sees an open
complaint before dialling.

## 15. SHIPPED 2026-09-09: credit follow-up — the script, the six-outcome report, the KPI

Ripoti za simu counts calls; it could never say what came of them. The full story is
[`docs/CREDIT-FOLLOWUP.md`](CREDIT-FOLLOWUP.md); the short version:

| nav | pane | who |
|---|---|---|
| `furep` | Ripoti ya ufuatiliaji / Follow-up report | credit officers, and whoever reads their day |

**Nothing to run — no migration.** The report is a read over tables this system already keeps.

**Do:**

1. Tick `furep` on the right roles in Access codes.
2. Settings → `CALL_SCRIPT` (the company script, shown on the customer card in the app;
   blank = no script panel), `KPI_DEFAULT_RATE` (the ceiling in percent, 5 if unset),
   and `GM_EMAIL` if the **Tuma kwa GM** button should actually send.

Two follow-up statuses were added: `MATENGENEZO` and `IMEPELEKWA KWA RSM`, both requiring a
comment. Adding words takes nothing away from handsets already in the field.

Six buckets that **partition** the customer (paid, unpaid, not available, stolen, maintenance,
unresponded) plus an honest seventh, "not called". A promise is unpaid. The bucket is read from
the WORDS of the status, so a status the office invents still counts. The default-rate KPI sits
on the Recovery pane and says plainly that it is this system's proxy, not WATU's own figure.

## 16. SHIPPED 2026-09-09: stock requests, the aging gate, and the handover note

The Store SOP's core gap. The full story is [`docs/STOCK-REQUESTS.md`](STOCK-REQUESTS.md); the
short version:

| nav | pane | who |
|---|---|---|
| `stockreq` | Omba stoo / Stock request | RSMs, team leaders, anybody who asks |
| `stockappr` | Idhini ya stoo / Stock approval | the store keeper — decides and hands over |
| `stockrep` | Ripoti ya stoo / Stock reports | the GM, Finance, the store manager |

**Do, in this order:**

1. Run `db/migrations/RUN-ME-2026-09-09-stock-requests.sql` in Supabase — every pane names it
   until it is run.
2. Tick the three navs on the right roles in Access codes.
3. Optional Settings: `STOCK_EMAIL`, `STOCK_AGING_DAYS` (5 if unset), `STOCK_LOW_ALERT` (1500).
4. **Keep uploading the Aged Stock report** — the gate and the tracker read it.

The gate (SOP E) is the point: the desk cannot release new stock to somebody holding stock past
the threshold without ticking an override AND writing a reason, which is kept and counted.
Rejecting is never gated. The gate is recomputed live at decision time, not read off the stamp.
The handover note (B.5–B.9) refuses to record without the joint count and a signature, caps the
IMEIs at what was approved, and moves the phone registry's holder for every IMEI it knows.

## 17. SHIPPED 2026-09-09: sales targets, and who an agent reports to

The Sales performance board says how much we sold; nothing said against what. The full story is
[`docs/TARGETS.md`](TARGETS.md); the short version:

| nav | pane | who |
|---|---|---|
| `targets` | Malengo ya mauzo / Sales targets | the CSM and the RSMs |

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-09-targets.sql` — it creates `sales_targets` and adds a
   `manager` column to the agents register.
2. Tick `targets` on the right roles.

Four scopes off one read (agent, RSM, branch, company), measured against `watu_loans` by
disbursed date. A target with no sales still appears — that is the row worth reading. No target
means no percentage, never 0%. Zero is a real target; removing one is a different fact.

An agent rolls up to their RSM: blank `manager` derives it from the branch, so the roll-up works
before anybody edits anything. Override it per person on Staff → Reports to.

Also in this change: `tableMissing` now recognises PostgREST's PGRST204 ("could not find the 'x'
column of 'y' in the schema cache"). Migrations here are run by hand, so between a deploy and
the paste a WRITE hits a column the schema has not got. The read path already said "run the
migration"; the write path used to 500 on the identical cause.

## 18. SHIPPED 2026-09-09: commission — rates, the run, the sheet, and the cleared stamp

Finance SOP A, end to end. The full story is [`docs/COMMISSION.md`](COMMISSION.md); the short
version:

| nav | pane | who |
|---|---|---|
| `commission` | Kamisheni / Commission | Finance: rates, build, record the payment |
| `commappr` | Idhini ya kamisheni / Commission sign-off | the Administration approval group |

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-09-commission.sql`.
2. Tick the two navs — deliberately two, so nobody builds a sheet and signs it off alone.
3. Set the rates on the commission pane. Nothing is priced until somebody does.

The point is A.6: a cycle is unique per period and kind, and once `cleared_at` is stamped no
second payment is possible — the update is guarded on it, so a double press produces one
payment. Recording a payment needs all five audit-checklist rows and a reference. Two kinds of
phone are held back and explained rather than paid: disputed ones (the shop credits a different
agent than Watu does) and unpriced ones. A draft can be rebuilt; a signed sheet cannot.

Also here: the test fake now fills a missing `id` with a real UUID instead of "gen-1", which is
what `gen_random_uuid()` does. Any path that inserts a row and then reads it back by id was
previously untestable — the caller's own isUuid guard rejected the fake's id.

## 19. SHIPPED 2026-09-09: the salary advance rules (SOP G.4, G.5, G.6)

No new navs — the three advance panes gain the rules the SOP always had. The full story is
[`docs/ADVANCE-RULES.md`](ADVANCE-RULES.md); the short version:

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-09-advance-rules.sql`. Everything keeps working before it
   is run; requests are simply not flagged yet.
2. Enter salaries on Staff → Mishahara, keyed by access code. Without them the 40% cap cannot
   be applied and the report says so.
3. Optional Settings: `ADVANCE_DEADLINE_DAY` (15), `ADVANCE_MAX_PCT` (40).

G.4 is a FLAG, measured against the applicant's own date — a deadline that blocks the form
leaves an emergency nowhere to go. G.5 is a LOCK, with the ceiling frozen at the ask so a later
raise cannot re-justify an approval; no salary on file means no cap, counted and named rather
than silently passed. G.6 is two stamps: Pay records the money and its reference, Deduct records
which payroll month took it back, each once and in that order.

Not built, deliberately: SOP G.2/G.3's HR-then-Finance routing. The owner replaced that with a
single approval nav on 2026-09-07 and that decision stands.

Also here: `isMonth` now rejects month 13. Three features store a period as TEXT, so there is no
date column to catch a nonsense month afterwards.

## 20. SHIPPED 2026-09-09: loss and damage — the price list, the case, the acknowledgement

Four SOPs point at one process (Finance H, Store C.7, RSM F, CSM G) and none of them could open
a case. The full story is [`docs/LOSS-DAMAGE.md`](LOSS-DAMAGE.md); the short version:

| nav | pane | who |
|---|---|---|
| `lossreq` | Toa taarifa ya upotevu / Report a loss | the store keeper, RSMs, anybody who finds a shortage |
| `loss` | Upotevu na uharibifu / Loss and damage | Finance |

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-09-loss-damage.sql`.
2. Tick the two navs.
3. Fill in the price list on the Finance pane — without it a case opens unvalued, and the desk
   has a tile counting exactly those.
4. Optional: `LOSS_EMAIL` so the GM hears the same day.

Theft is refused without a police report (H.1, the one document the SOP names outright). The
value is COPIED from the price list when the case opens, so changing a price never re-prices a
debt already signed for (H.2). A case cannot be acknowledged before it has a value — nobody
signs for a number nobody has worked out (H.5 after H.2). Money in is capped at the value and
settles the case by itself when it reaches it. Writing a debt off takes a reason.

## 21. SHIPPED 2026-09-09: top-ups (credit sales) — request, verify, pay, unlock

Finance SOP B, the last of the Finance gaps. The full story is [`docs/TOPUPS.md`](TOPUPS.md);
the short version:

| nav | pane | who |
|---|---|---|
| `topupreq` | Omba top-up / Request a top-up | agents, team leaders, the credit desk |
| `topups` | Top-up (Finance) | Finance |

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-09-topups.sql`.
2. Tick the two navs.
3. Optional: `TOPUP_EMAIL`, so Finance hears the moment one is waiting.

B.5 is the only step in any of these SOPs with the words "must never be delayed", so the desk
pane counts MINUTES, orders by who has waited longest, turns red after two hours and banners it.
The clock stops at the payment, not the paperwork. Four stamps rather than one status, because
the gap between two of them is somebody's afternoon. Verifying takes both the IMEI (B.2) and the
payer against the bank (B.3); paying is refused before that; confirming the unlock (B.6) needs
somebody to say they actually rang the customer.

## 22. SHIPPED 2026-09-10: the door — sign-in monitoring (IT SOP D)

The audit log records what somebody did once they were inside, and it is written after the
door — so a refused sign-in threw before it and left nothing anywhere. Somebody could try
access codes all night and the record of that night would be empty. The full story is
[`docs/SIGNIN-WATCH.md`](SIGNIN-WATCH.md); the short version:

| nav | pane | who |
|---|---|---|
| `security` | Usalama wa kuingia / Sign-in security | IT, and whoever else the owner ticks |

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-10-signin-watch.sql`.
2. Tick the `security` nav.
3. Optional Settings: `SIGNIN_ALERT_FAILS` (5), `SECURITY_EMAIL`.

Nothing written down is a working credential — that is the whole design. A code is stored as a
truncated hash (so a hundred tries at one wrong code are ONE line) and as `K•••••` (so a person
recognises their own typo), and never as itself. A phone is masked from the back, because the
front of a Tanzanian number is the network and identifies nobody.

All three doors are watched: the portal, the upload page (reachable from any origin by design,
so it is the one somebody guessing would find first), and the phone's registration. Successes
are kept once per code per door per day rather than once per call — every portal call passes the
same door, and a row per call would bury the twelve that matter.

SOP D's second sentence — "act immediately on any breach" — is a decision, so the pane records
one, stamped against the ATTEMPTS rather than the code: a line somebody has handled stops
shouting, and one new attempt puts it straight back on the desk. Changing a code stays in Access
codes; the drawer points there rather than keeping a second copy of that authority.

## 23. SHIPPED 2026-09-10: enrolment — the details, the check, the RSM being told (IT SOP A)

Three SOPs ask whether everybody is "enrolled with correct and complete details" (IT A, RSM
E.1, CSM H.1) and nothing could answer it: the register arrives by uploading Sipho's page, which
has no notion of a missing field, no notion of a record having been checked, and no way to tell
an RSM their person is on it. The full story is [`docs/ENROLMENT.md`](ENROLMENT.md); the short
version:

| nav | pane | who |
|---|---|---|
| `enrol` | Usajili wa wafanyakazi / Enrolment | IT |

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-10-enrolment.sql`.
2. Tick the `enrol` nav.
3. Optional: `ENROL_EMAIL`, either plain addresses or one `BRANCH=address` per line so each
   region's RSM hears about their own people.

A.3 is the only gate: completeness is verified BEFORE the account is activated, so activation is
a button that counts the missing fields first and refuses, naming them — and the count is taken
from the stored row, never from what the caller sends. There is no "active" box on the form, and
switching somebody back on later goes through the same check.

What the gate deliberately does not do is switch off the people already on the register. They
show as unverified and the desk has a tile counting exactly them; deactivating a working company
to satisfy a checklist is not what A.3 means.

"Referees" is plural in the SOP and was singular in the table, so a second pair of columns is
added rather than the first being reinterpreted. An ID of an unusual length is FLAGGED, never
refused — the register holds real nineteen-digit numbers and real ones written with dashes. An
edit that empties a required field clears the verification stamp but does not switch the account
off: a typo must not cost somebody their working day.

Also here: on the register is not the same as using the system. The desk shows, per person and
per branch, whether that phone has actually signed a handset on — which is the half of RSM E.1
that proves the details reached them.

## 24. SHIPPED 2026-09-10: the weekly IT report (IT SOP E)

The last of the IT SOP gaps. Three sections because the SOP names three — system performance,
enrolment status, technical issues resolved — in the SOP's own order, plus the compliance clause
it ends on. The full story is [`docs/IT-REPORT.md`](IT-REPORT.md); the short version:

| nav | pane | who |
|---|---|---|
| `itrep` | Ripoti ya IT / Weekly IT report | IT, and the GM if they want to read it themselves |

**Do:**

1. Run `db/migrations/RUN-ME-2026-09-10-it-report.sql`.
2. Tick the `itrep` nav.
3. Optional: `IT_REPORT_EMAIL` — blank falls back to `GM_EMAIL`, which is who SOP E names.

Every number in the report already exists somewhere: the door's log, the staff register, the
issues log, the daily uploads, the handsets' heartbeats. The pane composes and keeps no copy —
with one exception. SOP E's verb is SUBMIT, and "did last week's go?" is a fact about the past
that cannot be recomputed, so that alone is a table, and the summary is COPIED onto the row so
an old submission shows what was sent rather than what the data looks like now.

SOP C.2's daily check is the heart of the performance section: for each of the three modules it
names, did that file arrive on each of the seven days? Asked with a HEAD request per file per
day — twenty-one counts and no rows — and a missing day is named, not just counted. The date is
the day the file is FOR, because a Tuesday deck pasted on Wednesday still left Tuesday's phones
on Monday's book.

Enrolment status is computed by the same function the enrolment desk uses, and a test asserts
the two agree exactly: two copies of "what counts as complete" is how a report and a desk come
to disagree about one register in one week. Issues count the RESOLVING and the raising over
different windows, and the resolved ones are named — a GM reading "7" learns less than a GM
reading seven titles.

Also here: the wiring test that checks every sidebar tab reaches a draw function was reading a
fixed 2,000 characters after `function draw()`, so it had quietly stopped covering the last few
tabs as panes were added. It now reads the whole dispatch.

## 25. SHIPPED 2026-09-10: two device desks — locking and unlocking

The store keeper always locks; general duty unlocks at customer screening/POS. The full story is
[`docs/DEVICE-DESKS.md`](DEVICE-DESKS.md); the short version:

| nav | pane | may order |
|---|---|---|
| `devlock` | Kufunga simu / Locking | Funga, **re-lock**, Imepotea, enrol, token, delete |
| `devunlock` | Kufungua simu / Unlocking | Fungua, Achia |

**Do:** tick `devlock` on the store role and `devunlock` on general duty, then untick `devices`.

Until you do, nothing changes: `devices` remains as a legacy alias expanded to both halves, the
same way the retired `sales` key already works. No migration, no SQL.

Both panes show every phone — a store keeper who cannot see whether the handset in their hand is
locked cannot do the one job they have. What is split is what each may DO, and the gate is on the
TRANSITION rather than on the pane: `deviceSetState` is one door for all four state changes, and a
pane that merely hides its unlock button is a suggestion, because curl does not read HTML.

**Nothing a handset observes changed.** A phone learns what to do from `commandFor(state)` over
`/api/device` with its own token; it has never known what a nav is. The states, the beat contract,
the token and the offline grace are untouched, and a test asserts that the phone-facing files
contain no nav at all. Two hundred locked handsets are kilometers away; this had to be a
permission change and only a permission change.
