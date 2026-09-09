# Loss and damage — the price list, the case, and the acknowledgement of liability

> Finance SOP H "This process is managed under the Finance Department (moved from the Store
> Department) so that **valuation, liability, and recovery are handled centrally**."
> H.1 the root cause — negligence, an unresolved sale, or a genuine incident. "**A police report
> is required for suspected theft or robbery**."
> H.2 "The Finance Officer **values** the missing/damaged device **using the current price list**."
> H.3 the custodian "is held liable and must reimburse the company at the assessed value."
> H.4 the recovery method — lump sum or structured deduction — "approved by the General Manager
> and Finance Officer."
> H.5 "The custodian **signs an acknowledgment of liability** and repayment plan."
> Store SOP C.7 open a Loss/Damage case when verification finds a shortage.
> RSM SOP F and CSM SOP G the custodian is financially liable at the device's prevailing value.

**Four SOPs point at one process and none of them could open a case**, because there was
nowhere to open one. The store finds a phone missing; the RSM is liable; the CSM enforces;
Finance values and recovers.

| nav | pane | who you would tick it on |
|---|---|---|
| `lossreq` | Toa taarifa ya upotevu / Report a loss | the store keeper, RSMs, anybody who finds a shortage |
| `loss` | Upotevu na uharibifu / Loss and damage | Finance — the price list, the valuation, the recovery |

## Before anybody opens a pane

1. **Run `db/migrations/RUN-ME-2026-09-09-loss-damage.sql`** in Supabase. Safe to run more than
   once; until it is run both panes say so and name the file.
2. **Tick the navs** on the roles above.
3. **Fill in the price list** on the Finance pane. Without it a new case opens **unvalued** —
   which is honest, and the desk has a tile counting exactly those.
4. Optional: Settings → `LOSS_EMAIL`, so the GM hears the same day.

## The price list

By model, as the Watu book spells it. The case **copies the figure at the moment it is
opened**, and that is the point: H.2 says "the *current* price list", which means it moves, and
a price change next month must not re-price a debt somebody has already signed for. Changing a
price here affects new cases only.

Finance may also value a case by hand from the drawer; the case then records that it was
assessed and by whom, rather than pretending it came off a list.

## Opening a case

Custodian, model, IMEI, root cause, and what happened. **Theft is refused without a police
report reference** — it is the one document the SOP names outright, so the form asks for it the
moment theft is chosen rather than letting somebody discover the rule from a server error.

The GM is emailed the same day, with the valuation if there is one.

## Working it

The desk's drawer carries the whole of H.2 to H.5:

- **Value** it, from the list or by hand.
- **Agree the recovery**: lump sum, salary deduction or commission deduction, stamped with who
  approved it (H.4).
- **Take the acknowledgement** (H.5). A case **cannot be acknowledged before it has a value** —
  nobody signs for a number nobody has worked out.
- **Record money in.** Never more than the device was valued at, and reaching the value
  **settles the case by itself** rather than waiting for somebody to remember.

Writing a debt off takes a reason. Every move writes a line in the case's own trail, so a case
somebody argues about has its history attached.

A reporter sees only their own cases and may add notes to them; somebody else's case reads as
"no longer exists". Two people working the same case cannot overwrite each other — the second
is told to reopen it.

## Files

| file | what |
|---|---|
| `db/migrations/RUN-ME-2026-09-09-loss-damage.sql` | `device_prices`, `loss_cases`, `loss_case_notes`, `LOSS_EMAIL` |
| `api/portal.js` | `priceList`/`priceSave`/`priceDelete`, `lossRaise`, `lossList`, `lossNotes`, `lossUpdate` |
| `public/portal.html` | both panes, the shared report form, the case drawer |
| `test/loss-damage.test.mjs`, `test/portal-html.test.mjs` | the rules above, pinned |
