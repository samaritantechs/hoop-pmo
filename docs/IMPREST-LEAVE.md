# Imprest and leave — ask, decide, retire, review

> "they need to make imprest requests that will be approved by their admnistrator and a copy
> stays for the gm review: since am using tabs as roles so request tab, approval tab and
> imprest reports tab. No accountants intergration yet ... so the gm and administrator email get
> set in settings ... requests logs (pending approvals, rejected and approved), retirement log
> [when someone gets where he was destinated for their tasks they fill retirement with 3 pictures
> (optimize for storage as business operator does) to keep reference of actual incurred costs]
> and widget dashboards for that. when someone is requesting they choose role so at approver
> widget there have to be role setiings where adminstrator can add roles and their accomodation
> per day ... also they want to be asking for leaves in app (another nav), and hr approves or
> rejects there (another one)"

Five navs. **Grant them in Portal → Access codes → roles**, one tick each. Nothing in the
code knows the words "administrator", "CEO" or "HR" — which pane a person sees is which nav
they hold, and that is the whole permission model. **ADMIN is full access everywhere**, by
standing rule; a read-only `AUDITOR` code sees every pane and can change nothing.

| nav | pane | who you would tick it on |
|---|---|---|
| `impreq` | Omba imprest / Imprest request | anybody who travels for the company |
| `impappr` | Idhini ya imprest / Imprest approval | the administrator — decides, and owns the rate table |
| `imprep` | Ripoti ya imprest / Imprest reports | the CEO — the review copy |
| `leavereq` | Omba likizo / Leave request | everybody |
| `leaveappr` | Idhini ya likizo / Leave approval | HR |
| `leaverep` | Ripoti ya likizo / Leave reports | the CEO, HR and Finance |

> "All staff can request leaves / HR can grant leave / REPORTS are seen by CEO, Admin, HR and
> Finance." Tick `imprep` and `leaverep` on the CEO, HR and Finance roles; ADMIN holds every
> pane already.

## Before anybody opens a pane

1. **Run `db/migrations/RUN-ME-2026-09-07-imprest-leave.sql`** in Supabase. Until it is run
   every one of the five panes says so, naming this file, instead of showing an empty table.
   Safe to run more than once.
2. **Tick the navs** on the roles above.
3. **Rates.** Open Idhini ya imprest as the administrator and fill **Viwango vya malazi**: one
   row per role (CREDIT, RSM, CEO…) with its accommodation per day in TZS. Until a role has a
   rate, the request form cannot offer it — and a request for a role with no rate is refused
   with "ask the approver to add it".
4. **Email, optional.** Settings → `IMPREST_ADMIN_EMAIL`, `IMPREST_CEO_EMAIL`, `HR_EMAIL`
   (several addresses separated by commas), and `EMAIL_FROM` (a verified sender such as
   `HOOPLOAN <no-reply@hoop.co.tz>`; blank falls back to Resend's onboarding sender, which
   lands in spam). Then set **`RESEND_API_KEY`** on Vercel — it is a secret, so it is an
   environment variable, never a settings row. Same provider and the same two knobs as HOPE's
   weekly report.

## The imprest, start to finish

**Ask** (`impreq`). The form is the office's Imprest Requisition Form, field for field: full
name (pre-filled from the code), mobile, recipient account name if different, email, **role**
(a dropdown built from the administrator's rate table, showing the nightly rate beside each),
payment mode (MPESA / CRDB / CASH / …) and account or MOMO number, travel date, destination,
then the costing — fare as *trips × cost per trip*, accommodation as *nights × the role's
rate*, up to three other lines with a description each — a live total, and the purpose.

**The figures are previewed on the phone and computed on the server.** The form sends the
parts (trips, cost per trip, nights, other amounts) and never a total; the server multiplies
them itself, takes the nightly rate from **its** table for the role chosen, and **stamps that
rate onto the request** so a later change to the table never reprices a trip already filed.
An "other" amount with no description is refused: a figure with no name is a figure nobody can
retire against.

The requester sees their **own** trips under the form — not their colleagues'. Holding the
right to ask is not the right to read what others are claiming.

**Decide** (`impappr`). The administrator's queue is every request in the company, pending
first. The widgets above it count the whole table — waiting, approved, rejected, and **bila
retirement**: paid out with no receipts back yet, the number an administrator chases. The
decide drawer shows the purpose and the costing line by line; the approve box opens at the
full amount and can be **lowered but never raised** — approving more than was asked is not a
decision anybody delegated. A rejection must carry a comment. Two approvers pressing at once:
the second is told "somebody else just decided this one" and nothing is overwritten. Deciding
your own request is allowed, and noted on the drawer, for the reason the advance gives: the
tick is the owner's grant, and the code does not overrule it.

**Retire** (`impreq`, on your own approved trip). On arrival the traveller presses **Retire**
on the trip: actual fare, actual accommodation, actuals for each other line — each pre-filled
with what was asked, so only the lines that differed are edited — notes, and **up to three
receipt photos**. The drawer shows the actual total and the balance as it is typed:
positive means the traveller brings change back, negative means the company owes them. Filed
once, ever; a second attempt is refused and the database's own unique key on `request_id`
backs that up.

**The photos are shrunk on the phone before they are sent.** A phone camera writes 3–8MB a
shot; three of those per trip would fill the table in a month. Each receipt is redrawn on a
canvas at a long side of 1024px and saved as JPEG at quality 0.6 — usually 60–120KB and still
legible — and shrunk again, smaller, if that is still over the server's **200KB** ceiling,
which the server enforces regardless of what the phone did. They are stored as data URLs in
their own table (`imprest_photos`), **never on the request row**: every list this feature draws
stays light, and a receipt is fetched only when somebody presses **Picha**. A requester may
see only their own; the administrator and the CEO may see anybody's.

**Review** (`imprep`). The CEO's copy is a period of trips — **by travel date**, this month by
default like the advance report — every row with its retirement beside it: fare, accommodation,
others, requested, status, approved, decided by, retired when, actual spent, balance, receipts.
Seven widgets: requests, waiting, approved (TZS), spent (actuals filed), not yet retired,
**to be refunded** (travellers who owe change), **to be reimbursed** (trips that cost more than
was advanced). Filter by any status, by "retired" or "not retired", or by all dates.

**Email, as a courtesy on top.** A new request nudges `IMPREST_ADMIN_EMAIL`; an approval sends
the **CEO copy** to `IMPREST_CEO_EMAIL` and tells the requester at the address on the form; a
rejection tells the requester only. The pane is the system of record and email can never break
it: a request whose mail did not go is still filed, and the toast says *email haikutumwa* with
the reason so the person can tell the approver in words.

## Leave

**Ask** (`leavereq`). The HOOP COMPANY LIMITED Leave Request Form, field for field: employee
ID, department/position, immediate supervisor, **type** (annual, sick, maternity, paternity,
compassionate/bereavement, other — with "other" spelled out), from and to, reason, contact
number during leave, duties handed over to, and the **declaration as a required tick**. The
form previews **working days (Monday–Friday)** and the **resumption date** (the first working
day after the leave ends); the server counts both again and stores its own answer.

**The one-week rule is marked, not enforced.** The form says requests are due at least one
week ahead except emergency, sudden illness or bereavement. A non-sick, non-compassionate
request filed under a week ahead is accepted, **flagged "taarifa fupi"** on HR's desk and on
the form itself as it is typed, and counted in its own widget — so HR sees the policy breach at
a glance and decides, which is what the form's own exceptions make it.

**Decide** (`leaveappr`). HR's desk: everybody's requests, pending first; widgets for waiting,
short notice, **on leave today**, approved. Approve, or reject with a comment. Guarded like
every decision here: a request already decided is not decided twice.

**Report** (`leaverep`). A period of leave, company-wide, read by the leave's **start date**,
this month by default. Six widgets: requests, waiting, approved with the **working days
granted**, rejected, short notice, and **on leave today** — that last one counted over the whole
table rather than the period, because somebody whose leave began last month is still away this
morning. Filter by status, by short notice, by away today, or by all dates. Every row opens the
same details drawer HR sees.

A new leave request emails `HR_EMAIL` when it is set, on the same best-effort terms.

## What is deliberately NOT here

- **No accountant step.** "No accountants intergration yet" — approval is the last decision.
  The report's "to be refunded / to be reimbursed" widgets are the figures an accountant would
  start from when that pane is wanted.
- **No department scoping on the imprest approval.** The administrator is an administrator for
  the company, so there is no per-person switch and no same-role filter. The advance approval
  works the same way since 2026-09-07.
- **No editing a request after it is sent.** The retirement is the correction mechanism.
- **Leave balances.** The form has no entitlement field and neither does this; HR decides
  against whatever record they keep.

## Where things are

| what | where |
|---|---|
| tables | `db/migrations/RUN-ME-2026-09-07-imprest-leave.sql` — `imprest_roles`, `imprest_requests`, `imprest_retirements`, `imprest_photos`, `leave_requests` |
| server | `api/portal.js` — `impRoles/impRoleSave/impRoleDelete`, `impRequest/impMine`, `impQueue/impDecide`, `impRetire/impPhotos`, `impReport`, `leaveRequest/leaveMine`, `leaveQueue/leaveDecide`, `leaveReport` |
| email | `api/_lib/mail.js` — `sendMail`, never throws |
| page | `public/portal.html` — `drawImpReq`, `drawImpAppr`, `drawImpRep`, `drawLeaveReq`, `drawLeaveAppr`, `drawLeaveRep` |
| audit | every write is on the audit list; the audit line keeps the request id and the role name, never an amount, never a photo |
| tests | `test/imprest-leave.test.mjs` (server), the imprest/leave block at the end of `test/portal-html.test.mjs` (page) |
