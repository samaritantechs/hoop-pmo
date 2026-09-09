# The door — sign-in monitoring

> **IT SOP D — Data Security Procedure**
> *Access Controls: set and maintain user access controls so only authorized personnel can view
> or edit sensitive information.*
> *Monitoring: **monitor for unauthorized access** and act immediately on any breach, including
> changing the affected password.*

## The sentence this system could not answer

There has always been an audit log. It records what somebody did **once they were inside**, and
it is written by `audited()` in `api/_lib/audit.js` — which runs **after** the door.

A refused sign-in threw before it, and left nothing anywhere at all.

Somebody could sit and try access codes all night, and the system's own record of that night
would be empty. "We monitor for unauthorized access" was, until this, not a true sentence about
this deployment. It is now.

## What to do

1. Run `db/migrations/RUN-ME-2026-09-10-signin-watch.sql` in Supabase. Everything keeps working
   before it is run — the door simply is not writing anything down yet, and the pane says so and
   names the file.
2. Tick the **`security`** nav on whoever watches it (IT, and whoever else the owner chooses).
   ADMIN holds it already; an AUDITOR code reads it and changes nothing.
3. Optional Settings:
   - `SIGNIN_ALERT_FAILS` — how many refusals against one code, inside the window, stop being a
     typo and start being somebody working at it. Blank means **5**. The SOP names no number, so
     this is a judgement and it belongs where the office can move it.
   - `SECURITY_EMAIL` — who gets a copy when somebody presses **Tuma**. Blank means nobody, and
     the pane is still the record.

## The rule everything else is built around

**Nothing written here is a working credential.**

The pane will be ticked for more than one person. A security log that holds the company's keys
is a bigger hole than the one it was dug to watch. So a code is stored twice, in two forms that
are useless on their own, and never as itself:

| stored | what it is for | what it is not |
|---|---|---|
| `code_key` | a truncated SHA-256, so a hundred attempts at one wrong code are **one line** | it cannot be typed into the sign-in box |
| `code_masked` | `K•••••` — the first character and the length, so a person recognises **their own** typo | it identifies nobody else's code |

The same code typed in a different case hashes the same, because the door itself matches
case-insensitively — splitting `k4m9j2` from `K4M9J2` would hide exactly the pattern this exists
to show.

A **phone number** is masked from the *back* (`•••••••123`). The leading digits of a Tanzanian
number are the network and are shared by millions of people, so masking from the front hides
nothing; the last three are the only part that identifies, and the only part somebody recognises
as their own.

## The three doors

| door | what it is | who goes through it |
|---|---|---|
| `portal` | `/api/portal` — the whole system side | everybody with an access code |
| `upload` | `/api/upload` — reachable from any origin by design, so it is the door somebody guessing would find first | whoever holds `upload` |
| `app` | `api_callRegister` — the phone signing on | field officers, team leaders, agents |

Only **registration** is a door on the phone. Every other handler is reached by holding a device
id that was already granted, so watching them would record two hundred officers working rather
than anybody trying to get in.

## Successes are kept once a day, not once a call

Every portal call passes the same door, so a row per call would be tens of thousands a day and
would bury the twelve that matter. One row per code per door per **EAT day** answers *"who used
the system on Tuesday"*, which is the shape the question actually has, for a rounding error of
the writes. The unique index does the real work; the in-process memory only saves the trip.

## Why the refusal was refused

Set at the throw, never read off the wording of a message — a regex over a bilingual sentence is
a classification that breaks the day somebody improves the English half of it.

| outcome | meaning | worth a look? |
|---|---|---|
| `invalid` | no such code, or no such team code | **yes** |
| `suspended` | a real code, refused because that person is away | **yes** — and the line names them |
| `switched_off` | the app account is inactive | **yes** |
| `unknown_phone` | a phone not on the agents register tried to register | **yes** |
| `view_only` | an AUDITOR code tried to take a handset | **yes** |
| `closed` | the admin's system switch is off; everybody is refused | no — it says nothing about anybody |
| `refused` | anything else the door said no to | no |

## "Act immediately on any breach"

The second half of the SOP sentence is a *decision*, so the pane records one. **Fanyia kazi**
asks what was done and stamps it against every unhandled attempt on that code.

Two things follow from stamping the **attempts** rather than the code:

- A line somebody has dealt with stops shouting.
- **One new attempt afterwards puts the line straight back on the desk.** Somebody trying again
  after the code was changed is new information, and it must not hide under yesterday's note.

Changing the code itself stays in **Access codes**, where it has always lived. The drawer points
at it rather than duplicating it: two copies of a consequential rule is how a system ends up with
two opinions about who may do what.

## It can never break a sign-in

Every failure of the logging is swallowed — including the table not existing, which is every
deployment's state until somebody pastes the SQL. A door that could be closed by its own logging
is worse than an unwatched door.

It **is** awaited, which is not the same thing: on Vercel a function can be frozen the moment it
returns, so an insert nobody waited for may never leave the process — and the writes most likely
to be lost are the ones on the slowest requests, which are not a random sample. Swallowing every
error is what makes the await safe. This is the same reasoning, and the same shape, as
`auditWrite`.

One consequence worth knowing: a write refused because the migration has not been run is **not**
marked as recorded, so the morning before somebody runs it does not silently cost the whole day.

## Files

| file | what changed |
|---|---|
| `db/migrations/RUN-ME-2026-09-10-signin-watch.sql` | `signin_attempts`, its indexes, and two settings |
| `api/_lib/signin.js` | the hashing, the masking, and the write that cannot fail |
| `api/_lib/auth.js` | `AuthError` carries a `reason`, set at each throw |
| `api/_lib/call-core.js` | the phone door's refusals carry a reason; `callApi` watches registration |
| `api/portal.js` | the portal door; `signinWatch`, `signinReview`, `signinSend`; the `security` nav |
| `api/upload.js` | the upload door |
| `api/call.js` | passes the address and user-agent through for the one handler that is a door |
| `public/portal.html` | the Usalama wa kuingia pane |
| `test/signin-watch.test.mjs` | eight tests, most of them about the masking |
