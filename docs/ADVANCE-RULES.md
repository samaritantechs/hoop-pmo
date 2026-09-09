# The salary advance rules — the deadline, the cap, and the two stamps

> Finance SOP G.4 "All salary advance requests must be submitted **no later than the 15th day
> of the month**."
> G.5 "The approved advance amount **must not exceed 40%** of the employee's monthly salary."
> G.6 "Once approved, Finance processes the advance and **records it for deduction against the
> employee's next payroll**."

The request, the approval and the report already existed. What was missing is everything either
side of the decision: whether it was in time, whether it is within the cap, whether the money
actually went, and whether payroll has taken it back.

**No new navs.** The three panes are unchanged: `advreq` asks, `advappr` decides, `advrep`
reports and now also records the payment and the deduction. Salaries live on `staff`.

## Before anybody notices a difference

1. **Run `db/migrations/RUN-ME-2026-09-09-advance-rules.sql`** in Supabase. It creates
   `staff_salaries` and adds nine columns to the advance table. Safe to run more than once.
   **Until it is run everything still works** — requests are simply not flagged yet.
2. **Enter salaries** on Staff → Mishahara, keyed by access code. Without them the 40% cap
   cannot be applied.
3. Optional Settings: `ADVANCE_DEADLINE_DAY` (**15** if unset) and `ADVANCE_MAX_PCT` (**40**).

## G.4 is a flag, not a lock

A deadline that refuses the request leaves somebody with an emergency and nowhere to go, and the
SOP gives the judgement to the approver, not to the form. So a request filed after the deadline
day is **stamped late** and everybody downstream sees it said so.

It is measured against the applicant's **own chosen date**, not the day they pressed the button,
so a request for the 20th still reads as late when somebody audits it next year. The form warns
before the button, using the deadline day the server sent.

## G.5 is a lock

"Must not exceed" is not a suggestion, so an approval above the ceiling is refused by name and
told what the ceiling is.

The ceiling is **frozen on the request when it is filed**, from the salary as it stood that day.
A raise between the ask and the decision must not quietly widen what was allowed.

**Where no salary is on file there is no cap**, the approval goes through, and the report counts
it as *uncapped* with a banner pointing at the Staff pane. The rule cannot be applied to a figure
nobody has entered, and refusing every advance until a salary table is filled in would stop the
office rather than protect it. Naming it is a prompt; silence would be a pass.

## G.6 is two stamps

Paying and deducting happen on different days and by different hands, and a report that cannot
tell *approved* from *paid* can chase neither.

- **Pay** records the money going out and its reference. Only on an approved row, only once.
- **Deduct** records **which payroll month** took it back. Only after it has been paid, only once.

The report gains three tiles: what is approved and not yet paid, what is paid and not yet
deducted, and how many were late.

## What is deliberately not built

SOP G.2 and G.3 route the request through HR for eligibility and then to Finance for approval.
The owner replaced that with a **single approval nav** on 2026-09-07 — *"just requests and
approval or rejection with comments"* — and that decision stands over the SOP's two steps. If
the two-step is ever wanted back, it is a second nav, not a rewrite.

## Files

| file | what |
|---|---|
| `db/migrations/RUN-ME-2026-09-09-advance-rules.sql` | `staff_salaries`, nine columns, two settings |
| `api/portal.js` | the flag and cap in `advRequest`, the lock in `advDecide`, `advPay`, `advDeduct`, `salaryList`/`salarySave`/`salaryDelete` |
| `public/portal.html` | the deadline notice, the rules chips, HR's two buttons, the salaries block |
| `test/advance-rules.test.mjs`, `test/portal-html.test.mjs` | the rules above, pinned |
