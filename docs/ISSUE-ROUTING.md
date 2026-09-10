# An issue goes to a role, and optionally to one person in it

> *"So when someone reports an issue they choose who to report to by choosing role and next
> (option) user in the role, so on the desks every user sees what they have on desk — one issue
> for all in the role or for the directed individual."*

## The department was a fixed list in code

Eight names, chosen once, with no relationship to the roles the owner actually creates in Access
codes. So an issue could be filed to *"IT"* while the person who does IT work holds a role called
something else entirely — and the desk showed everybody everything regardless of either.

**A role is what the owner already maintains.** It is the same list they tick navs on, so routing
to a role needs no second vocabulary that will drift out of step with the first.

## Blank is the feature

| `to_role` | `to_name` | whose desk |
|---|---|---|
| `IT` | *blank* | **everybody holding IT** — whoever gets to it first |
| `IT` | `ASHA M` | **Asha alone** |
| *blank* | *blank* | **everybody** — filed before routing existed |

`to_name` blank is not a missing value. It is the raiser saying *"whoever gets to it first"*, and
the raise form puts that option first because it is the ordinary answer — addressing an issue to
one person is the exception and takes a deliberate second choice.

The people list is filled in **from the server** once a role is chosen, so nothing is typed and
nobody is addressed by a spelling that matches no desk.

## Nothing falls off a desk

An issue with no role on it was filed when the desk **was** one queue, and that is what it was
addressed to — so it stays addressed to it, and shows on everybody's desk.

Matching the old department against somebody's role instead would have been a guess, and a wrong
guess here means old issues quietly vanishing from every desk in the company on deploy day.

## Which view the desk opens on

Default is **my desk** — the owner's rule. Two other defaults, each with a reason:

- **ADMIN and AUDITOR see everything.** The standing rule, and supervision that can only see its
  own desk is not supervision.
- **Before the migration, everybody sees everything.** No row carries a role yet, so "my desk"
  would read as the log having emptied.

Either way the server answers back which view it chose, so the pane shows it rather than leaving
somebody to wonder where the rest went. The whole log is always one click away, and the desk tile
counts what is on **this** person's desk — with how many of those were addressed to them by name.

## The access codes never travel

`issueTargets` is the only place outside Access codes that reads that table, and it returns a
**name and a role** — nothing that could sign anybody in. It sits behind either issue nav rather
than behind Settings, because the person filing an issue is the one who has to choose where it
goes and they will not hold the codes pane.

There is deliberately **no `to_code` column**. It would have held an access code — the secret
itself — in a table more people can read. The audit log goes to some length to keep payloads out
of exactly that kind of table; putting a credential in the issues log would undo it for a column
nothing needs.

## What is kept, and what is relaxed

- **`department` stays.** Existing rows carry one and the issues report groups by it; dropping a
  column rows depend on, to satisfy a rename, is how a report goes blank. It is filled in
  automatically where the chosen role happens to be one of the eight names this log was born
  with, and left empty otherwise.
- **`department` is no longer required.** A role need not be one of those eight, and refusing an
  issue because the owner's role vocabulary has moved on would stop the log rather than route it.
- **The old department field still files**, so a screen that has not been reloaded keeps working.
- **`ISSUES_EMAIL` is asked for the role first**, then the old department name — so a settings
  block written before routing keeps working without being retyped.
- **Between the deploy and the paste**, a raise still files (unrouted, landing under
  `GENERAL_DUTY`) rather than being refused, and every read falls back to the row without the
  routing columns.

## What to do

1. Run `db/migrations/RUN-ME-2026-09-10-issue-routing.sql`.
2. Nothing else. Existing issues keep working and stay visible; new ones get a role.
3. Optional: add `ROLE=address` lines to `ISSUES_EMAIL` for roles that are not one of the old
   eight names.

## Files

| file | what changed |
|---|---|
| `db/migrations/RUN-ME-2026-09-10-issue-routing.sql` | `to_role`, `to_name`, and `department` made optional |
| `api/portal.js` | `issueSelect`, `issueOnMyDesk`, `issueTargets`; routing in `issueRaise`; the desk in `issueQueue` |
| `public/portal.html` | the role/person form, the desk toggle, the "to" column |
| `test/issue-routing.test.mjs` | six tests |
