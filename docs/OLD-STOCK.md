# OLD STOCK — what we hold, have never locked, and are going out to find

> *"For an OLD STOCK new nav pane for all those stock that imei no does not exist in our new
> enrolled phones. So we have NEW STOCK and OLD STOCK (never enrolled)."*
>
> *"They start reading with those aging days off, so everyday that goes they've not yet been
> enrolled they continue to count aging."*
>
> *"We'll conduct ground visits to all our previous agents and lock all stock we find, and once a
> stock in OLD STOCK is enrolled into our lock then it moves to list of NEW STOCK."*

## Two lists, one fleet

| | what is in it | how a handset gets in |
|---|---|---|
| **NEW STOCK** | every IMEI in `devices` — we locked it — **plus** any old-stock IMEI that has since **sold** | we enrolled it, or a sale book shows it sold |
| **OLD STOCK** | everything on Sipho's list that is in **neither** | it was on the list and we have not caught up with it |

**Nothing marks a row as moved.** A handset is in OLD STOCK exactly while it is absent from the
register *and* has no sale against it. A `moved` column would be a second opinion about a question
the data already answers, and the day the two disagreed a phone would be on both lists or on
neither. There is no Done button because there is nothing to tick.

### What counts as sold — three books, and the third is the receipt

| asked | what it is |
|---|---|
| `watu_loans` | the Watu deck |
| `hoop_sales` | our own shop's export — a **different upload of the same event** |
| `stock_audit` | what we **stamped** when it moved, where a sale was actually captured |

The first two are two ways of writing down one sale. A handset written in one and not the other
used to sit in OLD STOCK with a receipt against it — listed as never enrolled and gathering dust
while the till had already rung it up.

The third is what makes the move **permanent**. The decks are re-uploaded over themselves with rows
deleted, which is the whole reason a sale is stamped rather than joined; without this test a phone
that moved in September would walk back into the un-enrolled list in October because Watu trimmed
its export, and the ground team would be sent to fetch a phone that sold two months ago.

Membership in `stock_audit` is **not** itself evidence. That table also holds handsets merged off
the stock report alone, which says who was *holding* a phone and nothing whatever about it being
sold — and a price of zero is a missing price, not a free handset. A date, a buyer, or a price above
zero is the test. Counting membership would empty OLD STOCK of exactly the handsets it exists to
chase.

`newStock` and `oldStockIndex` ask this identical question, deliberately: the two lists are defined
against each other, so one answer is the only thing that keeps a phone off both lists or off
neither.

## Where it is, so a visit can be planned by place

> *"add location column in old stock since this operation to visit it is better when we can pivot
> by not just RSM but location too — the location we used as in PCOs calling not the kinondoni
> default."*

An RSM's round can cross three towns and a town's round can cross three RSMs, which is the whole
reason this was asked for. So `location` is a column, a filter, and a column on both the round and
the handset list.

**`branch`, never `team`.** There are two location-shaped fields on the loan book and only one of
them is a place. `team` is derived from the shop string *"Hoop Limited, Kinondoni"*, so it reads
KINONDONI for every row this dealer has — the company's own address, not the agent's. Pivoting by
it gives one bar. `branch` rides in on the offline queue, the PCOs' own portfolio sheet, and is the
location the office already talks in.

**Where the answer comes from, in order:** what somebody wrote on the handset · the holder's branch
on the staff register · the commonest branch their own sales carry. The commonest, not the first
seen — an agent who moved, or one row typed into the wrong branch, must not decide where a van is
sent.

**A place nobody knows is a dash.** Never Kinondoni, never blank-means-head-office. Guessing sends
somebody to the wrong town, which costs a day. A tile counts how many are still unknown, because a
pivot by place is only as good as how many rows have one.

### And it is stamped, because the book underneath deletes

> *"if such data is permanent stamp it permanent rather always fetching yet watu deletes the data
> per time"*

Worked out **once**, written to the row, and read off it for ever after. Watu re-uploads its export
with rows gone, so a location re-derived on every read would go from naming a town to a dash the
morning that agent's sales were trimmed — with nothing on screen to say why, on the list a van is
dispatched from. Same axis as the NEW STOCK sale audit, for the same reason.

`location_from` rides with it (`stated` · `staff` · `sales`), because the stamp would otherwise
make a derived place indistinguishable from a declared one the moment it landed, and a van is sent
on both. A stated location is never overwritten; a view-only code writes nothing; a database
without the column reads fine and stamps nothing.

## The age is arithmetic, never a stored number

`age_days` is what the list said on `as_of`. Today's age is **`age_days + (today − as_of)`**, worked
out on every read, so a handset nobody has been to see gets visibly worse without anything being
re-uploaded.

Re-saving an age every night would need a job somebody has to keep alive, and the morning it did not
run the whole list would quietly understate itself. Each row shows today's age with *"tangu
2026-09-10: 100"* underneath — the number it started at and the day it was true.

**A handset with no age is not a handset of age zero.** Some rows on the sheet have no age; calling
those brand new would put the oldest stock at the bottom of a worklist, so they read `—` and are
counted separately.

## It opens as a worklist

**The round** comes first — one row per holder, because a ground visit is made to a *person*, with
their number to ring before setting off. Sorted by the **oldest piece**, not by how many: a bigger
pile is a bigger van, an older pile is a worse problem.

**Its three numbers open what they count.** Pieces, oldest and 90+ are buttons; pressing one opens
that holder's handsets in a drawer, leaving the pane's filter, search and scroll exactly as they
were. One server call serves all three — they are the same question with a different floor under
it (none, the figure shown, ninety), and `oldest` needs no special case because it *is* the group's
maximum age.

The cell still leads with the figure. Every table here sorts on the cell's text, so putting an icon
or a word in front of the number would make the DAYS OFF column sort alphabetically — on the one
board read to decide which visit goes first. A zero is not a link: there is nothing behind it, and
a control that answers with an empty list teaches people the numbers do not really do anything.

Then the handsets, oldest first. Filters: RSM, holder, IMEI (digits only, like the device search).

**Tiles:** outstanding · locked on a visit · sold before we got there · 180+ days · holders to visit.

The middle two matter as much as the first. A list that only shrinks says nothing about *why* — one
of those handsets we now control, the other got away and sold first.

## A sale on a never-locked handset moves to NEW STOCK

> *"If a phone imei once reads in sales and it was in old stock not in new stock, move its column
> data needed into NEW STOCK, so that we can always get the update of current activities no matter
> the stock age."*

A live sale filed under "never enrolled, gathering dust" is the opposite of current. So a sold
handset joins NEW STOCK on the strength of the sale, with the sale stamped exactly as any other —
and with **no device row behind it**.

Its status reads **Haijafungwa** rather than being dressed as one of the four states the register
can hold: we do not control that phone, and the pane must not imply we do. `soldUnlocked` counts
them, which is the number the ground visits exist to bring down.

## Names carry their numbers

> *"We could put agent and customer numbers under their names in the single double rowed row in name
> columns to reduce lengths, and replace the brand/Co.-reader under the names there e.g. watu_loans
> into 0756749261."*

On NEW STOCK, four pairs of columns became four columns: RSM, agent, customer and guarantor each
show the name with the number under it. The table was wider than any screen read at a counter, and
the space under each name was being spent on the feed that filled it.

**The provenance is not lost** — it moved to the cell's tooltip. It answers "where did this come
from", asked of one cell occasionally; the phone number answers "who do I ring", which is what the
pane is open for.

## The ageing tracker, and the upload that is off

> *"Use these two navs to update data of aging stock in stock reports — not uploading aged stock for
> now though, leave the uploading button and function just there but unclickable."*

`stockAgingIndex` now reads **OLD STOCK**, aged to today, which is exactly why the upload can be
switched off: the list is right every morning with nothing pasted.

A file somebody *does* paste is still read, and the **newer `as_of` wins** per serial. Neither list
is a superset of the other, and dropping the upload outright would throw away the one feed that can
still correct this.

On the upload page the **Aged stock** chip is `disabled` and greyed, with the reason in its tooltip.
The parser and the endpoint are untouched behind it — turning it back on is deleting one attribute.
Auto-detect no longer routes to it either: a disabled chip that the sniffer can still select is a
door that looks shut and is not.

## What to run

1. `db/migrations/RUN-ME-2026-09-12-old-stock.sql` — the table.
2. `db/RUN-ME-2026-09-12-sipho-september-load.sql` — 2,682 handsets and the staff pivot.
3. Tick **`oldstock`** on the roles that should see it.

## Files

| file | what changed |
|---|---|
| `db/migrations/RUN-ME-2026-09-12-old-stock.sql` | `old_stock` |
| `db/migrations/RUN-ME-2026-09-14-old-stock-location.sql` | `location`, `location_from` |
| `db/RUN-ME-2026-09-12-sipho-september-load.sql` | the September list: staff + stock |
| `api/portal.js` | `oldStockIndex`, `daysApart`, `ageToday`, the `oldStock` fn, the `oldstock` nav, NEW STOCK's sold-but-never-locked join, `stockAgingIndex` repointed |
| `public/portal.html` | the catalog entry, `OSQ`/`osAge`/`drawOldStock`, `nsCell` collapsed to name+number |
| `public/upload.html` | the aged-stock chip disabled, and the sniffer no longer routes to it |
| `test/old-stock.test.mjs` | twenty-four tests |
