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
| **NEW STOCK** | every IMEI in `devices` — we locked it — **plus** any old-stock IMEI that has since **sold** | we enrolled it, or the deck shows it sold |
| **OLD STOCK** | everything on Sipho's list that is in **neither** | it was on the list and we have not caught up with it |

**Nothing marks a row as moved.** A handset is in OLD STOCK exactly while it is absent from the
register *and* absent from the deck — both asked at read time. A `moved` column would be a second
opinion about a question the data already answers, and the day the two disagreed a phone would be
on both lists or on neither. There is no Done button because there is nothing to tick.

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
| `db/RUN-ME-2026-09-12-sipho-september-load.sql` | the September list: staff + stock |
| `api/portal.js` | `oldStockIndex`, `daysApart`, `ageToday`, the `oldStock` fn, the `oldstock` nav, NEW STOCK's sold-but-never-locked join, `stockAgingIndex` repointed |
| `public/portal.html` | the catalog entry, `OSQ`/`osAge`/`drawOldStock`, `nsCell` collapsed to name+number |
| `public/upload.html` | the aged-stock chip disabled, and the sniffer no longer routes to it |
| `test/old-stock.test.mjs` | ten tests |
