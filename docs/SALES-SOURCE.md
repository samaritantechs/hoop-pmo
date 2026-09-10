# Who sold it: the Watu deck

> *"I said we trace sales in the watu deck uploaded by credits."*

## Two books about the same phones

| table | what it is | keyed on |
|---|---|---|
| `watu_loans` | **the Watu deck**, uploaded by credits | the agent Watu itself credits, dated by `disbursed_date` |
| `hoop_sales` | the shop's own book from hoopltd.shop | the **payout phone** written against each receipt |

The second answers *"who did the shop intend to pay?"* — a different question from *"who
financed this handset?"*, and the two drift.

## What was already right, and what was not

Everywhere that matters already drove off the deck:

- `targetsView` measures achievement against `watu_loans`.
- `commBuild` builds the commission sheet from `watu_loans`, and treats a shop disagreement as a
  **DISPUTE** that is not paid this cycle.
- `salesWeek`, `customers`, `customerSearch`, `topupRequest`, `priceList` all read the deck.

**The agent scorecard was the odd one out.** Its *sales* column counted receipts out of
`hoop_sales`, keyed on `commission_phone` — so an agent could look busy on this pane for phones
the loan book had never heard of.

## The change

The scorecard's sales half now counts the **deck**, over the same window, with the deck's own
price. The shop book stays **beside it as a cross-check** rather than being dropped:

| column | from |
|---|---|
| Sales (deki), TZS (deki) | `watu_loans` — the count and the money |
| Duka | `hoop_sales` — how many receipts the shop credited to the same person |
| Tofauti | the gap between them |

A blind spot traded for another blind spot is not a fix. The gap is the most interesting number
on the row, so it is a column — and a seller the shop pays that the deck **cannot account for at
all** gets a red `duka pekee` chip and a banner counting them.

`salesSource: 'watu_loans'` rides on the response and the heading says it, because a column
headed *"sales"* that quietly changed meaning is worse than one that says which book it came
from.

### One human, one row

The deck spells a name its own way; the shop writes a payout phone. A hit in the agents register
is the only spelling both books can be pulled onto, so it wins — the same resolution `commBuild`
uses when deciding whether a phone is disputed. Failing that, each book's own name stands for
itself.

### A gap the change exposed

`agentScore`'s deck read never selected `price` — it did not need it while the money came from
the shop book. Reading it without that would have made every deck amount silently **zero**, which
is the kind of nothing that looks like an answer. `price` now rides along in both column tiers.

## What still reads both books, on purpose

- **`salesAudit`** — holding the shop's book against the deck and naming the drift *is* that
  pane's whole job (OK / DRIFT / BULK / PENDING / HAKUNA_WATU).
- **`commBuild`** — pays from the deck and refuses to pay a phone the shop credits to somebody
  else.

Neither may quietly become single-source; that would delete the check rather than tidy it, and a
test asserts both still read both.

## What to do

Nothing. No migration, no setting. The numbers on **Agent scorecards → Sellers** will move,
because they are now counting the book the amendment names — and where they move by a lot, the
`Tofauti` column says why.

## Files

| file | what changed |
|---|---|
| `api/portal.js` | `agentScore`'s seller buckets, `price` in the deck read, `salesSource` and `totals` |
| `public/portal.html` | the sellers table: deck columns, shop column, gap, `duka pekee`, banner |
| `test/sales-source.test.mjs` | six tests |
