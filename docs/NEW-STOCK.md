# NEW STOCK — the sale behind every handset we have locked

> *"I need an audit of our existing imeis since we started locking on our own — Imei, Rsm, rsm no,
> agent, agent no, customer, customer no, price, guarantor, guaranto no, status (locked, unlocked,
> achia), by (who promted that status), last read (last sync date&time). So that we could always
> sort locked and sort by sync to know our lost or stock that needs verification."*
>
> *"It should always read and stamp the sales first imei sales info from watu deck upload, since
> watu always omit data so when we stamp once we are done for the missing column info, the rest
> until obtained — if watu removes sales data, we already stamped ours."*

## Two kinds of fact on one row

This is the whole design, and everything else follows from it.

| | | |
|---|---|---|
| **The sale** | RSM, agent, customer, price, guarantor and their numbers | **stamped** — captured the first time any feed can answer, never overwritten |
| **The state** | locked / unlocked / achia, who ordered it, when it last spoke | **read live** — never stamped, on every open |

Everywhere else in this system, writing down something you could derive is the mistake: a stored
total is a lie the moment its inputs move. Here the opposite is true, and the difference is **which
way the input moves**.

- A derived **total** goes *stale* when its inputs change → never store it.
- A captured **sale** goes *missing* when its input is deleted → store it, or lose it.

Watu re-uploads its deck over itself, with columns blank and rows gone. Who bought a handset on the
13th of July does not stop being true because a spreadsheet stopped mentioning it. A status, by
contrast, is a lie within the hour of being written down — and this is the pane read to decide
whether a phone needs chasing.

## First catch wins, and it says who caught it

Each column is filled the first time any feed can answer it and is then **left alone for good**.
That is what makes the stamp worth having: a second upload that has gone blank cannot un-say what
the first one said.

Because some of these are captured rather than witnessed — and the RSM is *derived* — the
provenance travels with the value. `src` is one `jsonb` column mapping field → feed, and the pane
prints it in small grey type **under the cell**, because "where did this come from" is asked of
exactly the cells somebody is already looking at.

### The order the feeds are asked

The owner named it, and it is an order of *trustworthiness about a sale*:

| # | feed | what it alone can answer |
|---|---|---|
| 1 | **`watu_loans`** — the Watu deck | agent, customer + number, price, model, sale date, team |
| 2 | **the offline queue** (merged onto the same row) | **guarantor + number** — nowhere else has one |
| 3 | **`hoop_sales`** — the shop book | customer, the payout number of whoever is owed |
| 4 | **`hoop_agents`** — the staff register | the agent's own number, their branch |
| 5 | **`hoop_aged_stock`** | who was *holding* it — the weakest claim to having sold it, hence last |

1 and 2 are the same table today and are still listed apart, because they are different
**uploads**: the daily deck carries the sale, the offline-queue sheet is the only place a guarantor
was ever written down. Naming them separately is what lets a stamped guarantor say where it came
from.

**The earliest receipt wins** where the shop wrote more than one for an IMEI. A later receipt is a
top-up or a correction; "first catch" has to mean the first *sale*, or the audit quietly
re-attributes a handset to whoever touched it most recently.

### A blank is not a value

`''`, whitespace and a price of **0** are all *unanswered*, not answers. Stamping them would close
the column for good against the upload that finally carries the number — the opposite of what the
stamp is for. A zero price is a missing price, not a free handset.

## Where the RSM comes from

No sale feed knows our hierarchy — Watu has never heard of it. So the RSM is walked up the staff
register from the agent: **Field_Officer → Team_Leader → Regional_Manager**, using the same
`salesTree` the target cascade already builds. A manager who sold a phone themselves is their own
RSM, which is the honest answer. A register that names a loop costs that row its RSM and nothing
else.

Where no Regional_Manager exists above somebody, the column stays **open** rather than being filled
with the nearest available name.

## The population is the register

*"Our existing imeis since we started locking on our own."* One row per IMEI in `devices`. A phone
that appears in the sales books but was never locked is somebody else's audit and does not appear
here — and is not stamped either.

## What is on screen

**Tiles:** all · locked · unlocked · achia · not reporting (with *silent 7+* underneath). Clicking
one filters the table; the tiles always count the **whole** fleet, never the filtered slice.

**Columns**, in the order they were dictated, with the disbursement date second: IMEI ·
**Tarehe / disb date** · RSM · RSM no · Agent · Agent no · Customer · Customer no · Price ·
Guarantor · Guarantor no · Status · By · Last read.

The date cell prints the day **as stored**. An ISO day sorts as text exactly the way it sorts as a
date; prettifying it to "13 Jul" would put August above July on every click.

Every table on this page sorts itself on a header click — which is the entire ask, *"so that we
could always sort locked and sort by sync"*. The **Last read** cell leads with the number of days
and carries the timestamp underneath, so the sort means what the reader thinks it means; a handset
that has never spoken sorts above every silence that has an end. Phone numbers are `tel:` links,
on the pane where somebody is chasing people.

### Where it was, under what it is doing

> *"At hali/status column, below status, add the second in one [location coordinate link] so that
> we can click to view where the phone is, and always stamp the latest read coordinates whenever
> the phone pings the system. So even if achia we'll always find the latest ping coordinate
> location."*

**The stamping was already happening.** Every heartbeat writes the handset's last known position
(`last_lat` / `last_lng` / `last_loc_acc` / `last_loc_at`), and `deviceSetState` has never touched
those columns — so **Achia does not erase it**. That is the case this is wanted for: a released
phone is one nobody is tracking any more, and its final fix is all that is left of it.

Under the status chip: a **📍 coordinate link** that opens the map, the accuracy, and the age of
the fix.

- **The fix has its own age, and it is not the beat's.** The handset reports its *last known*
  position rather than waking the GPS on every ping, so a phone that beat a minute ago can carry a
  fix from Tuesday. The two timestamps are never collapsed — the age shown is the fix's.
- **The accuracy is part of the answer.** A 2,000m fix is a suburb, not an address; anything over
  500m is marked as vague, because drawing it as a bare pin is how somebody drives to the wrong
  building.
- No fix reads as **hakuna eneo / no location**, never as an empty cell.

Before the location migration the audit still opens and says the map is unavailable — a missing
column must never read as a missing register, which is a bug this pass also fixed on the Devices
pane itself.

**The stamp is invisible, so the pane says it happened.** Under the tiles: when it read, how many
rows *gained new detail on this read*, and how many still have blanks. On the morning after a Watu
upload, the first number is the point of opening the pane; the second should be falling, and a
gap count that never falls means a feed is not arriving — invisible on a table of blanks, obvious
as one number.

## NEW SALES — the week, the month, and who is carrying them

Three cards above the register:

| card | what it shows |
|---|---|
| **NEW SALES · this week** | agents · customers · price, with the period underneath |
| **NEW SALES · this month** | the same three, month to date |
| **Juu na chini / Top and bottom** | 3×2 — name, sales, price, for the best and worst of the week |

**Counted from this pane's own stamped rows**, not from a fresh read of the deck. That is the point
rather than a shortcut: these are sales of handsets *we locked*, so the widget and the table under it
can never disagree. A card reading `watu_loans` directly would count phones this audit has never
heard of.

- **A customer is a phone number where there is one.** Two receipts spelling a name differently are
  one buyer; two buyers can share a name.
- **The bottom agent is the lowest who sold**, never the highest who did not — somebody who sold
  nothing is not on these rows at all, so the card says *how many agents it ranked* rather than
  implying it ranked the company.
- **One seller is not two rows.** With a single seller the card says so instead of printing the same
  person twice as if that were two facts.
- **A sale with no agent named still counts in the totals** — a total that does not match the board
  is a total nobody trusts — but it cannot become the week's top agent.

## What it costs

Opening the pane reads five feeds and writes back only the rows that actually **gained** something
— on a steady morning, none. A second open in the same hour writes nothing at all. A view-only code
computes the whole table and stamps nothing, as everywhere here.

A feed that has never been uploaded costs its columns and nothing else: an audit that refuses to
open because one upload has not happened is an audit nobody uses, and this one is opened precisely
when things are incomplete.

## Before the migration

The pane still **computes** — the joins underneath work perfectly well — but nothing is being kept,
and it says so in red. That is the one thing worth stating out loud rather than showing a table
that looks complete.

## What to do

1. Run `db/migrations/RUN-ME-2026-09-11-new-stock.sql`.
2. Tick **`newstock`** on the roles that should see it. It carries customer and guarantor phone
   numbers, so it is its own nav rather than riding on the stock reports.

## Files

| file | what changed |
|---|---|
| `db/migrations/RUN-ME-2026-09-11-new-stock.sql` | `stock_audit` |
| `api/portal.js` | `NEWSTOCK_*`, `unanswered`, `rsmAbove`, `newStockOffers`, `newStockFill`, `newStockRow`, the `newStock` fn, the `newstock` nav |
| `public/portal.html` | the catalog entry, `NSQ`/`NS_LABEL`/`nsCell`/`drawNewStock` |
| `test/new-stock.test.mjs` | twenty-three tests |
