# Top-ups (credit sales) — request, verify, pay, unlock

> Finance SOP B.1 "Receive the top-up request together with **proof** of the client's upfront
> payment."
> B.2 "**Verify the IMEI number** before processing the payment."
> B.3 "Verify the payer's name and check the payment against bank/mobile-money records."
> B.4 "Calculate the remaining balance required to complete the full phone price."
> B.5 "Send the top-up payment **immediately** so the system can unlock the device for the
> client — **this step must never be delayed** — and share confirmation in the respective
> WhatsApp group."
> B.6 "Confirm with the agent/client that the device has been unlocked successfully."
> B.7 "Log the completed transaction in the system."

**B.5 is the only step in any of these SOPs with the words "must never be delayed."** That is
why this is a table rather than a WhatsApp thread. A customer whose phone is still locked after
they have paid is the worst thing this company can do to somebody, and the only way to stop it
happening quietly is to make the waiting visible and count the minutes.

| nav | pane | who you would tick it on |
|---|---|---|
| `topupreq` | Omba top-up / Request a top-up | agents, team leaders, the credit desk |
| `topups` | Top-up (Finance) | Finance — verifies, pays, and confirms the unlock |

## Before anybody opens a pane

1. **Run `db/migrations/RUN-ME-2026-09-09-topups.sql`** in Supabase. Safe to run more than once.
2. **Tick the navs** on the roles above.
3. Optional: Settings → `TOPUP_EMAIL`, so Finance hears the moment one is waiting. The notice
   carries the reason it is urgent, not just the fact.

## Four stamps, not one status

Requested, verified, paid, unlocked. The gap between any two of them is somebody's afternoon,
and a single status column cannot show a gap. The desk pane:

- orders by **who has waited longest**, which is the only order a rule like B.5 can be served by;
- draws the wait in minutes, amber after half an hour and **red after two**;
- puts a banner at the top when anybody has been waiting two hours or more;
- **stops the clock at the payment**, not at the paperwork — a paid top-up is not still accruing
  a wait just because nobody has confirmed the unlock yet.

## The steps, one at a time

The drawer offers exactly the step the row is ready for.

- **Verify** (B.2 and B.3) takes **both** ticks: the IMEI, and the payer checked against the
  bank record. Verifying "the IMEI" without checking who actually paid is how a top-up gets sent
  against somebody else's money. The full price can be corrected here and the balance is
  recomputed.
- **Pay** (B.5) needs a payment reference and is refused before the row is verified.
- **Confirm the unlock** (B.6) needs somebody to say they actually rang the customer. Recording
  an unlock nobody confirmed is the one lie this table exists to prevent.

Rejecting takes a reason. Two desks paying the same top-up produce one payment: the update is
guarded on the status that was read.

## The balance

The full price is looked up from the loan book by IMEI, so nobody types it; the balance is
price minus what the client paid (B.4). A phone the book does not know opens with **no price and
no balance** rather than a wrong one, and the price can be filled in at verification.

## The audit checklist

Four rows, filed against every transaction: the request from the agent, the payment to the
requested number, WATU's sales verification, and the auditor's sign-off. A row already ticked is
shown ticked and **disabled** — an audit tick is not a toggle.

## Files

| file | what |
|---|---|
| `db/migrations/RUN-ME-2026-09-09-topups.sql` | `topups` and `TOPUP_EMAIL` |
| `api/portal.js` | `topupRequest`, `topupMine`, `topupQueue`, `topupUpdate` |
| `public/portal.html` | both panes, the shared request form, the step drawer |
| `test/topups.test.mjs`, `test/portal-html.test.mjs` | the rules above, pinned |
