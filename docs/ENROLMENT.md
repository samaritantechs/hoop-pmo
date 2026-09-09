# Enrolment — the details, the check, and the RSM being told

> **IT SOP A — Agent / Team Leader Enrollment Procedure**
> A.1 *Collect the required details: **full name, ID number, contact information, and referees**, from the RSM/team leader.*
> A.2 *Enter the details into the system accurately and completely.*
> A.3 ***Verify data completeness before activating the account.***
> A.4 *Notify the RSM/General Manager once enrollment is complete.*
>
> **RSM SOP E.1** *Confirm with the IT Officer that all agents/team leaders are enrolled with correct, complete details.*
> **CSM SOP H.1** *…properly enrolled in the system with correct and complete details.*

## Three SOPs ask one question, and nothing could answer it

The staff register arrives by uploading Sipho's SyscoPos page. That gives a **list** — with no
notion of a field being missing, no notion of a record having been **checked**, and no way to
tell an RSM their person is on it.

So *"are all your agents enrolled with complete details?"* was answered by scrolling.

## What to do

1. Run `db/migrations/RUN-ME-2026-09-10-enrolment.sql` in Supabase.
2. Tick the **`enrol`** nav on IT (and whoever else the owner chooses). ADMIN holds it already.
3. Optional Settings: `ENROL_EMAIL` — either plain addresses, or one `BRANCH=address` per line
   so each region's RSM hears about their own people. A branch with no line of its own falls
   back to any plain address, then to `GM_EMAIL`. Blank means nobody is emailed and the pane is
   still the record.

The desk still lists everybody before the migration is run — taking the register down between a
deploy and somebody pasting SQL would be a worse failure than the one being fixed — and it says
plainly that nothing can be verified until the columns exist.

## A.3 is the only gate here

Everything else on this desk is bookkeeping. A.3 says completeness is verified **before** the
account is activated, which means activation has to be an **act** rather than a column that
arrives set to `true`. So there is exactly one way to switch an account on — **Thibitisha na
washa** — and it counts the missing fields first and refuses, naming them.

The count is taken **from the stored row**, never from anything the client sends. A completeness
check the caller can assert is not a check.

There is no "active" box on the form. Switching somebody back on after a spell off goes through
the same button, which is right: the SOP says completeness is verified before an account is
activated, *every time*.

### What the gate deliberately does not do

It does not reach back and switch off the people who were already on the register. Their rows
show as **unverified**, and the desk has a tile counting exactly them — *hai bila kukaguliwa*,
live and never checked. Deactivating a working company to satisfy a checklist is not what A.3
means. The gate governs activation from here on, and the tile is the backlog.

## The required details (A.1)

| field | why |
|---|---|
| Full name | A.1 |
| ID number | A.1 |
| Phone | A.1 "contact information" — and the register's own primary key |
| Role | which SOP the person is working under |
| Branch | whose RSM is told (A.4), and whose question E.1 is |
| First referee + number | A.1 |
| **Second referee + number** | A.1 says **referees**, plural |

The register had **one** next-of-kin slot. A second pair of columns is added rather than the
first being reinterpreted: a column that quietly changes meaning is worse than one that is
missing.

**Email is not on the list.** "Contact information" is satisfied by the phone number, which is
always present; insisting on an address as well would mark half the field officers incomplete
for something the SOP does not ask for. It is on the form, for whoever has one.

This list lives in code rather than as `NOT NULL` constraints, because the register is *also*
filled by the SyscoPos upload — a constraint would make that upload fail on somebody else's
missing field instead of showing it as a gap.

## Accuracy without pretending to know the format (A.2)

A national ID that is present but of an unusual length is **flagged, never refused**. It is the
one field where a slip is invisible — every other field is a name a person would notice — but
the register holds real numbers of nineteen digits and real ones written with dashes. A rule
that threw those out in the name of accuracy would cost more than it found.

An edit that **empties** a required field clears the verification stamp: verification is about
the details as they stood when somebody looked at them, so a row that has lost one is a row
nobody has checked. It does **not** switch the account off — a typo must not cost somebody their
working day — and "live but never checked" is counted separately instead.

## Telling the RSM (A.4)

**Toa taarifa kwa RSM** is refused before A.3, because A.4 says *"once enrollment is complete"*.
When it goes, the row records **who** was told and **when** — not merely that somebody meant to.

## On the register is not the same as using the system

RSM SOP E.1 asks whether people are *enrolled*, and the honest answer has two halves: their row
exists, and they have actually signed a handset on. Only the second proves the details reached
them. The desk shows both, per person and per branch.

## Files

| file | what changed |
|---|---|
| `db/migrations/RUN-ME-2026-09-10-enrolment.sql` | the second referee, the four stamps, `ENROL_EMAIL` |
| `api/portal.js` | `ENROL_FIELDS`, `enrolGaps`, `phone0`; `enrolQueue`, `enrolSave`, `enrolUpdate`; the `enrol` nav |
| `public/portal.html` | the Usajili wa wafanyakazi pane |
| `test/enrolment.test.mjs` | eight tests, most of them about the gate |
