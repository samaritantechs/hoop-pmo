# Credit follow-up — the script, the six-outcome report, and the KPI

> Credit SOP A.3 "Call clients according to the follow-up schedule ... **using the company
> script**."
> A.4 "Log the outcome of every call."
> A.5 "**Generate a report** covering: stolen devices, maintenance, not available, paid,
> unpaid, and unresponded calls."
> A.6 "**Send the report to the General Manager**."
> B.5 "Follow up with the agent and guarantor if the client does not respond, **escalating to
> the RSM** as a last resort."
> D "KPI Target: the credit department's **default rate** on the WATU system **must not exceed
> 5%**."
> E.5 "Use the company script when calling clients."

Ripoti za simu counts **calls** — how many, how long, who made them. It could never answer
A.5, because a call is not an outcome: two hundred calls and no idea how many phones turned out
to be stolen is exactly the gap the SOP was written against. This adds the outcome side.

Everything here is granted by **nav tab**, never by role name.

| nav | pane | who you would tick it on |
|---|---|---|
| `furep` | Ripoti ya ufuatiliaji / Follow-up report | the credit officers, and whoever reads their day |

`CALL_SCRIPT` and `KPI_DEFAULT_RATE` are Settings keys, not navs. The KPI card is drawn on the
existing **Marejesho / Recovery** pane.

## Nothing to run

No migration. The follow-up log (`followup_comments`), the calls (`call_logs`) and the deck
(`followup_status`) are tables this system already keeps; the report is a read over them.

**Do:**

1. Tick `furep` on the roles that should see the report.
2. Settings → `CALL_SCRIPT`: paste the company script. Line breaks are kept. Blank means the
   card shows no script panel at all.
3. Settings → `KPI_DEFAULT_RATE`: the ceiling in percent. Blank or nonsense falls back to **5**,
   the SOP's own figure.
4. Settings → `GM_EMAIL` (the same key the issues desk escalates to) so the **Tuma kwa GM**
   button has somewhere to send. Blank means no email; the pane is still the report.

## The two new follow-up words

`MATENGENEZO` (maintenance) and `IMEPELEKWA KWA RSM` (escalated to the RSM) joined the built-in
`FU_STATUSES`. Both require a comment: neither is worth anything without a sentence saying what
and why. A phone in the shop is not a customer refusing to pay, and an RSM's file is not
`OTHERS` — without the two words both were landing in the same bucket, which is where a report
goes to die.

**Handsets already in the field are safe.** Adding a word takes nothing away: an old app simply
does not offer the new options, and the whole list stays overridable in Settings → `FU_STATUSES`.

## The six buckets

One row per **customer**, in buckets that **partition** — so the numbers add to the book and a
GM can read them as shares. A customer counted twice is worse than a customer missed.

| bucket | how a customer lands in it |
|---|---|
| Paid | the follow-up says they paid or are paying |
| Unpaid | reached, no payment — **a promise is not money**, so `AMETOA AHADI` is here |
| Not available | the follow-up says they cannot be reached |
| Stolen | the phone was stolen or lost |
| Maintenance | the phone is in for repair |
| Unresponded | dialled in the period, **nothing logged** |
| Not called | on today's deck, never rung in the period — the seventh, honest number |

The bucket is decided by the **words** of the status, not by a list of exact strings, because
`FU_STATUSES` is editable: a report keyed to the built-ins would silently stop counting the day
somebody adds a word of their own. A status nobody planned for lands in *unpaid* rather than
vanishing.

Two rules worth knowing:

- **The last word of the day wins.** "Hapatikani" at nine and "analipa leo" at four is a
  customer who paid.
- **A note with no status is contact that produced nothing.** It counts as unpaid, never as
  paid.

The period is **EAT days**, converted for the timestamp column, so a follow-up logged at 01:30
in Dar es Salaam is filed under today rather than yesterday. Today by default; the pane has
Leo, Siku 7, and a date pair.

## Send to the GM

**Tuma kwa GM** emails `GM_EMAIL` the same six numbers the pane is showing, with their
percentage shares, the period and who sent it. It is built from the same report the screen
draws, so the two can never disagree. It is a write: view-only codes do not get the button, and
who sent which period lands in the audit log.

## The KPI card

On the Recovery pane, above the tiles: the share of loans still inside the 45-day window that
Watu marks 7+ days offline, against the `KPI_DEFAULT_RATE` ceiling. Green under, red over.

The card **says what it is measuring**. Hoop cannot read Watu's own default figure, so this is
the closest proxy this system has, labelled as a proxy rather than passed off as Watu's number.
It uses the same locked-7 arithmetic as every other screen here, so it moves with the charts
beside it. It draws on the very first upload too, when there is no recovery to compare yet.

## Files

| file | what |
|---|---|
| `api/_lib/call-core.js` | the two statuses, `fuBucketOf`, `CALL_SCRIPT` on boot |
| `api/portal.js` | `fuOutcomes`, `fuOutcomesSend`, the KPI inside `recovery` |
| `public/portal.html` | the `furep` pane, `kpiCard`, the Settings help |
| `public/call.html` | the folded script panel on the customer card |
| `test/fu-report.test.mjs`, `test/portal-html.test.mjs` | the rules above, pinned |
