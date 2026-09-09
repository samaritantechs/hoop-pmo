# The weekly IT report

> **IT SOP E — Reporting & Compliance**
> *Prepare and **submit** regular IT reports to the General Manager on **system performance**,
> **enrollment status**, and **technical issues resolved**, and ensure all system activities
> comply with company policy and data protection regulations. **Reports are due on a weekly
> basis.***
>
> **IT SOP C.2** *Monitor system uptime and performance across inventory, sales, and finance
> modules, on a **daily** basis.* — the daily check this weekly report is made of.

## Three sections, because the SOP names three

In the SOP's own order, and nothing else added to them. A report that answers a different
question from the one it was asked is a report nobody trusts the second week.

**Every number in it already exists somewhere.** This pane composes; it keeps no copy of
anything — the door's log (SOP D), the staff register (SOP A), the issues log (SOP C), the daily
uploads, the handsets' own heartbeats.

Except one thing. SOP E's verb is **submit**, and *"did last week's go?"* is a fact about the
past that cannot be recomputed from this week's numbers. That, and only that, is a table.

## What to do

1. Run `db/migrations/RUN-ME-2026-09-10-it-report.sql` in Supabase.
2. Tick the **`itrep`** nav on IT (and the GM, if they want to read it themselves). ADMIN holds
   it already.
3. Optional Settings: `IT_REPORT_EMAIL`. Blank falls back to `GM_EMAIL`, which is what SOP E
   names; this key exists only for an office that wants the CEO or the auditor copied in.

The report reads and sends before the migration is run — every number in it lives elsewhere.
What is missing is the **record**, and the pane says so plainly rather than reporting a failed
send: the GM has the email either way, and the person needs to know which of the two to chase.

## 1. System performance

The heart of it is **SOP C.2 asked daily and read weekly**: for each of the three modules the
SOP names, did its file arrive on each of the seven days?

| module | file | date column |
|---|---|---|
| finance | the Watu loan book | `watu_snapshots.snapshot_date` |
| sales | the sales file | `hoop_sales.sale_date` |
| inventory | the aged stock report | `hoop_aged_stock.as_of` |

The date is the day the file is **for**, not the day somebody pressed upload — which is the
honest reading, because a Tuesday deck pasted on Wednesday still leaves Tuesday's phones working
from Monday's. A missing day is **named**, not merely counted.

This is asked with a HEAD request per file per day: twenty-one tiny indexed lookups that return
a count and no rows at all. Reading the rows themselves would be tens of thousands of rows to
learn twenty-one yes-or-nos.

Alongside it: handsets that checked in and handsets that have gone dark, app accounts that
synced, calls logged, and the door's own week — refusals, the ones worth a look, and codes
awaiting a decision.

## 2. Enrolment status

The counts from the enrolment desk, **computed by the same function**. Two copies of "what
counts as complete" is how a report and a desk come to disagree about the same register in the
same week, so there is one, and a test asserts the two agree exactly.

Plus two numbers the desk does not show, because they are about the week rather than the state:
how many people were **enrolled** this week, and how many were **verified**.

## 3. Technical issues resolved

Counted over the right windows, which are not the same window:

- **Raised** — `raised_at` inside the week.
- **Resolved** — `resolved_at` inside the week, *whenever it was raised*. An issue opened in
  January and closed on Tuesday is this week's resolved work, not this week's new work.
- **Still open** — all of them, at any age, with the oldest named in days.

And a **list before it is a number**: a GM reading "7" learns less than a GM reading seven
titles, so the resolved ones are named, with who resolved each and how many days it took.

## 4. Compliance

The SOP's last clause, answered with facts rather than a promise: audit entries this week, how
many access codes exist, how many are read-only, how many are suspended today — and the two
standing data-protection properties of this system, stated as checks rather than prose:

- the door's log stores **no code** (see `docs/SIGNIN-WATCH.md`)
- the audit log carries **no payload** (see `api/_lib/audit.js`)

The access-code read here asks for **role and suspension window only**. A report whose last
section is about data protection must not itself be a list of the company's keys — and a test
asserts that no code value appears anywhere in the response.

## Submitting

**Tuma kwa GM** sends the week and writes one row: when, by whom, to whom, and a **copied**
summary of the headline numbers. Opening a June submission next January must show what was
**sent** in June, not what June looks like after six months of re-uploads and resolved issues —
the same rule the commission sheet and the loss valuation follow.

There is deliberately **no unique row per week**. Re-sending after fixing something is
legitimate, and a unique row would quietly hide that it happened twice. Every submission is its
own line.

## Files

| file | what changed |
|---|---|
| `db/migrations/RUN-ME-2026-09-10-it-report.sql` | `it_reports`, and `IT_REPORT_EMAIL` |
| `api/portal.js` | `ITREP_FEEDS`, `feedDay`, `signinWindow`; `itWeekly`, `itWeeklySend`; the `itrep` nav |
| `public/portal.html` | the Ripoti ya IT pane |
| `test/it-report.test.mjs` | eight tests |
