# Sales targets — set them, then measure the month against them

> CSM SOP B.3 "**Set regional targets for each RSM** and monitor performance against them."
> CSM SOP A.2 "Hold RSMs accountable for the performance of their respective regions."
> RSM SOP B.1 "**Set and monitor sales targets for each agent/team leader**, in line with the
> overall targets set by the company."
> RSM SOP B.3 "Review performance data weekly and monthly, and identify reasons for any decline."
> RSM SOP B.5 "Document the actions taken and the results achieved."

The Sales performance board answers *how much did we sell*. It could never answer *against
what*, because nothing in this system held a target for a **person** — only
`SALES_DAILY_TARGET`, one company-wide number per day. A regional target and an agent's target
are different numbers set by different people, and the SOP asks for both.

| nav | pane | who you would tick it on |
|---|---|---|
| `targets` | Malengo ya mauzo / Sales targets | the CSM (who sets RSM targets) and the RSMs (who set their agents') |

Setting and monitoring are the same job for the same person, so they are one pane and one nav.

## Before anybody opens it

1. **Run `db/migrations/RUN-ME-2026-09-09-targets.sql`** in Supabase. It creates
   `sales_targets` and adds one column, `manager`, to the agents register. Safe to run more
   than once; until it is run the pane says so and still shows the month's sales.
2. **Tick `targets`** on the roles above.

## Four scopes, one read

`agent`, `rsm`, `branch` and `company` are the same sales counted by a different key — that is
what a pivot is — so it is one read, not four. Sales come from `watu_loans` by
`disbursed_date`, the same book every other sales figure here reads.

**A row with a target and no sales is the point, not an omission.** An agent who sold nothing
against a target of thirty is exactly who this pane exists to name, so every target appears
whether or not there is a sale behind it.

Two rules the numbers follow:

- **No target, no percentage.** Somebody with sales and no target shows a dash, never 0%. An
  empty bar is a claim about attainment, and nobody made that claim.
- **Zero is a real target** — a month off — and blank is no target at all. Setting zero and
  removing the target are different facts, and the pane keeps them different.

## Who an agent rolls up to

An agent's sales land on their RSM's line. The register now carries a `manager` column, but you
do **not** have to fill it a thousand times: leave it blank and the server derives the RSM from
the branch — the `Regional_Manager` standing in the same branch. Fill it only where somebody
reports across a branch line.

Edit it on **Staff**, in the *Reports to* column. Blank shows as "kwa tawi / by branch", so the
fallback is visible rather than looking like missing data.

## The note

Each target carries a short note — RSM SOP B.5, "document the actions taken and the results
achieved". The long version belongs in the **issues log** as an issue of kind *performance*,
which is what that kind is for.

## Files

| file | what |
|---|---|
| `db/migrations/RUN-ME-2026-09-09-targets.sql` | `sales_targets`, and `manager` on the register |
| `api/portal.js` | `targetsView`, `targetSave`, `targetDelete`, `staffManager`; `managerIndex` is the roll-up |
| `public/portal.html` | the targets pane, the drawer, the Reports-to column on Staff |
| `test/targets.test.mjs`, `test/portal-html.test.mjs` | the rules above, pinned |
