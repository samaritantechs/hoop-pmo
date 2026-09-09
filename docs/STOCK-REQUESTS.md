# Stock requests, the aging gate, and the handover note

> Store SOP B.1 "Receive the stock request from the RSM in the system."
> B.2 "Confirm the RSM/agent has **no outstanding aging stock**."
> B.4 "Obtain written approval from the General Manager before releasing any stock."
> B.5 "Prepare a **pre-numbered delivery/handover note** listing IMEIs, quantities, and condition."
> B.6 "Conduct a **joint physical count** with the RSM/agent before handover."
> B.7 "**Photograph** the sealed boxes and IMEI list at the point of handover."
> B.8 "Obtain the RSM/agent's **signature**, retain a copy, and upload it to the system the same day."
> B.9 Courier dispatch: the delivery note, IMEI list and handover confirmation must "be verified
> as complete before dispatch."
> B.11 "the Store Keeper must maintain a **distribution report** recording every device reallocation."
> E "No new stock is released to any RSM/agent with outstanding aging stock until it is fully
> sold, returned, or reconciled." Threshold: **5 days**.
> G "Alert management promptly when stock levels are running low — defined as market stock
> falling below **1,500 pieces**."

**The gate is the point of this feature.** Everything else is the request shape this system
already has three of — ask, decide, record. What is new is an approval that **arithmetic can
refuse**: the store desk cannot quietly release new stock to somebody sitting on old stock.

Granted by **nav tab**, never by role name.

| nav | pane | who you would tick it on |
|---|---|---|
| `stockreq` | Omba stoo / Stock request | RSMs, team leaders, anybody who asks for stock |
| `stockappr` | Idhini ya stoo / Stock approval | the store keeper — decides and records the handover |
| `stockrep` | Ripoti ya stoo / Stock reports | the GM, Finance, the store manager |

## Before anybody opens a pane

1. **Run `db/migrations/RUN-ME-2026-09-09-stock-requests.sql`** in Supabase. Until it is run
   every pane says so, naming this file. Safe to run more than once.
2. **Tick the navs** on the roles above.
3. Optional Settings: `STOCK_EMAIL` (who hears about a new request), `STOCK_AGING_DAYS`
   (the threshold, **5** if unset) and `STOCK_LOW_ALERT` (**1500** if unset). Both numbers are
   settings rather than constants, because a policy that needs a deploy to change is a policy
   nobody changes.

**Keep uploading the Aged Stock report.** The gate and the tracker read `hoop_aged_stock` —
the shop's own daily file, which already carries `age_days` per serial per agent. That is
deliberate: the gate and the Aging Stock Tracker are then one file, never a second private idea
of what "old" means. No upload means no aging position, which reads as *not blocked*.

## The gate

A holder is blocked when the newest aged-stock upload shows **any** piece older than
`STOCK_AGING_DAYS` against their name. Names are matched case- and spacing-insensitively.

- **On the request pane**, the asker sees their own position before they file, so nobody
  submits a request the desk is bound to refuse. They may still ask.
- **On the approval pane**, each row carries the position *as it stands now* — a request filed
  on Monday is a different question by Wednesday, so the gate is **recomputed live** and never
  read off the stamp. What the tracker said at filing time is kept on the row too, so a release
  that should not have happened stays visible as one.
- **Approving a blocked holder** takes an explicit tick *and* a written reason. Either alone is
  not an override. The reason is stored and counted on the report.
- **Rejecting is never gated.** The gate exists to stop stock leaving, not to stop a no.

## The handover note

Only on an approved request, and only once. The server refuses the handover without:

- the **joint physical count** confirmed (B.6), and
- a **name** for who received and signed it (B.8).

A courier dispatch (B.9) additionally requires its documents confirmed complete. IMEIs are
digits-only, de-duplicated, length-checked, and never more than were approved — a note listing
more phones than were released is a shortage waiting to be argued about. Up to three photos
(B.7) are shrunk on the phone and capped at 200KB each by the server, kept in their own table
so no list ever drags them across the wire.

**Every IMEI on the note that the phone registry already knows has its `holder` moved.** "Who
has this phone" stops being two different answers in two different panes. An IMEI not in the
registry is normal and is skipped quietly; only enrolled phones are there.

Two store keepers pressing at once produce one note: the request is claimed with a guarded
update before any photo is written, and the database has a unique index behind that.

## The reports

One pane, two things the SOP asks for separately:

- **The Aging Stock Tracker** (E.3): every holder, pieces held, how many are past the
  threshold, the oldest, and the models. Worst first.
- **The distribution book** (B.11): every request in a period with what was actually released
  against it, plus how often the gate was overridden and by whom.

The **low-stock banner** (G) appears when the newest upload's total falls below
`STOCK_LOW_ALERT`. No upload at all is not an alarm — it is no information.

## Files

| file | what |
|---|---|
| `db/migrations/RUN-ME-2026-09-09-stock-requests.sql` | the four tables and the three settings |
| `api/portal.js` | `stockRequest`, `stockMine`, `stockQueue`, `stockDecide`, `stockIssue`, `stockHandover`, `stockPhotos`, `stockReqReport`; `stockAgingIndex` is the gate |
| `public/portal.html` | the three panes, the decide drawer, the handover form, the note reader |
| `test/stock-requests.test.mjs`, `test/portal-html.test.mjs` | the rules above, pinned |
