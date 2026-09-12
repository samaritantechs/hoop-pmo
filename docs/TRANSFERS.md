# Transfers — the store keeper's hand-off, signed on screen

> *"store keeper needs the transfer doc to be blue ink signed online on a transfers navigation
> by sender and receiver so that we could export and print. as the signing feature we
> implemented in hopeloan customer onboarding just on screen signature not biometrics."*
>
> *"it could be between super agent/store and rsm, rsm and rsm, agent and agent, agent and
> super agent — all possibilities between these people, but an agent can't transfer to another
> rsm's agent unless [it goes] through rsm or superagent."*

## What this is

The paper slip a store keeper already keeps by hand whenever stock physically moves — from the
store to an RSM, RSM to agent, agent to agent, agent back up — reproduced on screen: one shared
item name and unit price for the whole batch, a pasted list of IMEIs, and two signatures captured
with a finger or a mouse rather than on paper. See `db/migrations/RUN-ME-2026-09-16-transfers.sql`
for the schema.

A transfer is opened once (`transferCreate`), then signed by the sender and the receiver, in
either order, each **once** (`transferSign`). There is no re-sign endpoint — a mis-signed transfer
is corrected with a fresh transfer, the same discipline a mis-posted payment gets everywhere else
in this system, not by editing a document a printed copy may already be holding a different
version of.

| status | meaning |
|---|---|
| `pending` | opened, neither side has signed |
| `partial` | one side has signed |
| `complete` | both sides have signed |

## The hierarchy rule

Nobody types a role on the form — sender and receiver are typed as plain names, exactly like
every other free-text field in this system, and the rule below is resolved off the same staff
register (`hoop_agents`) and the same manager-derivation the sales-targets roll-up already uses
(`managerIndex`, see `RUN-ME-2026-09-09-targets.sql`).

Every pairing is a normal hand-off **except one**: two field agents (`Field_Officer`/
`Team_Leader`) who report to two *different* RSMs, transferring stock straight to each other and
skipping the chain of custody both RSMs are meant to see. That one pairing is refused with a
clear reason; every other combination — store ↔ RSM, RSM ↔ RSM even across regions, agent ↔ agent
under the *same* RSM, agent ↔ the super agent, or either side being a name that is not in the
staff register at all (the store desk, or anyone the register does not know) — goes through
unrestricted.

An agent's RSM is whatever the sales-targets roll-up would say it is: the register's own
`manager` column if somebody set one, else the `Regional_Manager` standing in the same branch.
"SUPER AGENT" is not a separate role in the schema — it is the specific name the owner uses for
the top-level distribution point, registered as an ordinary `Regional_Manager`-tier row, which is
exactly why it is never on the restricted side of the rule.

## What is deliberately not here

- **No new UI for picking a role or an RSM.** The rule is enforced server-side against the
  existing register; the store keeper still just types two names, the way every other pane in
  this system already asks for a name.
- **No signature re-do.** See above — a fresh transfer, not an edit.
- **No link to `devices` or `hoop_aged_stock`.** A transfer can cover stock that was never
  locked, so `transfer_items.imei` is plain text, the same tolerance `old_stock` has always had.
