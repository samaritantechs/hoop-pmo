# Issues — one log for everything somebody has to chase

> RSM SOP C.1 "Log every issue raised by an agent or team leader using the designated complaint
> link/tool, which routes the issue to the appropriate department ... Escalate unresolved or
> complex issues to the General Manager."
> Credit SOP C "Register the complaint on the complaints form ... verify the customer's identity
> ... refer the matter to the WATU Credit Department where applicable ... Escalate complex or
> unresolved complaints to the General Manager."
> IT SOP C "Report technical issues promptly and log them with the WATU support system and
> Samsung shop ... Register the log book of the resolved matter."
> General Duty SOP B "Maintain a log of all pending tasks, documents, and system entries ...
> Follow up with the relevant team until each item is cleared ... Record the resolution and
> closing date."

Four SOPs, one table, three navs. They describe the same shape — somebody raises a thing, a
department works it, it is resolved or escalated — so a customer's complaint, a missing
receipt, a Samsung repair and an agent's performance note are all **issues**, told apart by
their *kind* and by what they are *about*. The department is a **label on the row** that the
desk filters on. It is never a nav of its own: one queue, one grant, the same rule the
salary advance was simplified to.

> "remember I implement tasks/roles by nav tabs not role based so just implement the
> functionality"

**Grant the navs in Portal → Access codes → roles**, one tick each. Nothing in the code knows
the words "RSM", "Credit officer" or "GM"; which pane a person sees is which nav they hold.
**ADMIN is full access everywhere**, by standing rule; a read-only `AUDITOR` code sees every
pane and can change nothing.

| nav | pane | who you would tick it on |
|---|---|---|
| `issuereq` | Toa taarifa ya suala / Raise an issue | everybody — RSMs, agents' leaders, the office |
| `issues` | Dawati la masuala / Issues desk | whoever works issues: General Duty, the credit officer, IT, the store — one grant, they filter by department chip |
| `issuerep` | Ripoti ya masuala / Issues report | the CEO and department heads |

## Before anybody opens a pane

1. **Run `db/migrations/RUN-ME-2026-09-08-issues.sql`** in Supabase. Until it is run every
   pane says so, naming this file. Safe to run more than once.
2. **Tick the navs** on the roles above.
3. **Email, optional.** Settings → `ISSUES_EMAIL`, one line per department:
   ```
   IT=it@hoop.co.tz, tech@hoop.co.tz
   CREDIT=credit@hoop.co.tz
   STORE=stoo@hoop.co.tz
   ```
   A department with no line gets no email. `GM_EMAIL` hears about escalations. Both need
   `EMAIL_FROM` and `RESEND_API_KEY` as the imprest notices do. Blank means nobody is
   emailed and the desk is still the record: **an email that cannot be sent never stops an
   issue being filed.**

## The three panes

**Raise** (`issuereq`). Department, kind, what it is about, a title, details, a contact
number. The *about* box is enabled only for the subject types that need one — an IMEI, an
agent's name, a receipt number — and the server refuses an IMEI-type issue with no IMEI, so
the call card can always find it. Below the form: the raiser's own issues, unresolved first,
each openable to read the notes and add one ("here is the document").

**Desk** (`issues`). Four tiles — open, waiting, escalated, resolved — and one chip per
department carrying its open count, so the person sees where the work is before narrowing.
Unresolved by default; resolved ones are a toggle away, never gone. **+ Ingiza suala** logs
an issue on a caller's behalf: that is the complaints form. Each row opens a drawer with the
conversation and the controls that move it: status, assigned to, referred to (WATU, SAMSUNG…)
and their reference, the *identity verified* tick Credit SOP C.2 asks for, the resolution.

**Report** (`issuerep`). A period by the date raised, this month by default, per department:
how many, how many still open, how long they take to resolve, the oldest thing still open,
and the log book itself with who resolved what and when.

## What the server insists on

- **Stamped, never joined.** The raiser is who the access code says; whatever the form sends
  for `staffName`, `status`, `verified` or `assignedTo` is ignored. An issue opens *open*.
- **Only the desk moves it.** A raiser may add a note to their own issue and nothing else;
  another person's issue reads as "no longer exists". Resolving needs a resolution text;
  reopening clears the closing stamps and keeps the text as history. Escalating stamps who and
  when and tells `GM_EMAIL`.
- **Every move is a note.** A status change writes an `issue_notes` row with the change
  (`open>resolved`) even when nobody typed a word, so the timeline is complete.
- **Two desks cannot silently overwrite each other.** The update is guarded on the
  `updated_at` the desk read; if somebody moved the row in between, the desk is told to reopen
  it and nothing is written.
- **The call card reads it.** `api_callComments` lists the customer's issues where the subject
  is their IMEI, newest ten, as the *complaints* strip above the history — open ones in red,
  so the officer knows before dialling.

## Files

| file | what |
|---|---|
| `db/migrations/RUN-ME-2026-09-08-issues.sql` | `issues`, `issue_notes`, the two settings |
| `api/portal.js` | `issueRaise`, `issueMine`, `issueQueue`, `issueNotes`, `issueUpdate`, `issueReport`; `ISSUE_DEPTS` mirrors the CHECK |
| `api/_lib/call-core.js` | `comments()` fills `complaints` from the log |
| `public/portal.html` | the three panes, the shared raise form, the drawer |
| `test/issues.test.mjs`, `test/portal-html.test.mjs` | the rules above, pinned |
