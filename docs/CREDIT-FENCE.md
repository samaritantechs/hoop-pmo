# The credit fence — AGENT, RSM and TEAM LEADER see only their own pivot

> *"for team leader, agent and RSM roles, they only should ever see their data (pivoted of
> imeis they are assigned too — as hope pmo does to its users) from the calls app to all
> system nav tabs."*

## What existed before this

Two fences already lived in this system, built at different times for different screens,
and neither reached the other:

- **The stock fence** (`stockAllow`, Transfers / OLD STOCK / NEW STOCK, 2026-09-16):
  AGENT sees their own hands; RSM sees their own hands and their agents'.
- **The calls-app agent fence** (`isAgent`, the handset's own list and dashboard strip,
  2026-08-17): a shared AGENT sign-in code sees only the customers their own name sold,
  matched off Sipho's register.

RSM and TEAM LEADER never had an equivalent on the credit side. An RSM (or a team leader,
which was not even a real access-code role yet) opening the calls app or the portal's
customer panes saw the same whole-team book everyone else did.

## What this is now

**TEAM LEADER is a real access-code role**, minted the same way RSM or STORE is — pick it
on the Access codes screen (it needed adding to the suggested list; nothing auto-mints it
the way stock auto-mints RSM/AGENT codes from the register).

**One fence, three roles, everywhere a row can be attributed to a person.** AGENT reads
their own name; RSM and TEAM LEADER read their own name plus everyone beneath them in the
staff register (`hoop_agents`), **at any depth** — the same `salesTree.descendants` walk
NEW STOCK's RSM column and the targets roll-up already used. A field officer two rungs
under an RSM, with a team leader in between, is still the RSM's — the walk does not stop
at direct reports.

**Fails closed, exactly like the stock fence.** A name the register cannot place, or a
register that cannot be read, gives an empty "mine" set and therefore an empty book, never
somebody else's.

## Where it reaches

**The calls app** (`api/_lib/call-core.js`):
- `list()` — the deck a handset shows. AGENT/RSM/TEAM LEADER see only rows their pivot
  sold; everyone else keeps the round-robin credit deal (`isFenced`, `fenceSetOf`).
- the dashboard strip (`dailySummary` → `summaryForRole`, replacing the AGENT-only
  `summaryForAgent`) — list/locked7/inWindow/calls/reached/weekAvg, all narrowed the same
  way.
- `summaryFor` — the SAME function the portal's `boot()` calls for its dashboard tile.
  There is no separate role dispatch on the portal side, so the fence had to move into
  this function directly rather than living only in the calls app's own dispatch.

**The portal** (`api/portal.js`), via the new `creditAllow(db, user)` — the credit-side
twin of `stockAllow`:

| function | pane | what is fenced |
|---|---|---|
| `customers` | Wateja | `leo45`, `leo45plus`, `jana` |
| `recovery` | Recovery | the diff rows, and the KPI's own denominator |
| `recoveryWeek` | Recovery / dashboard trend | the week's points and the per-credit split |
| `recoveryDayList` | Recovery's day-eye | that day's names |
| `lockedTrend` | dashboard / Recovery chart | the 7+ trend bars |
| `notifications` | the bell | which comments a fenced code is told about |
| `fuOutcomesCore` | Ripoti ya ufuatiliaji (`furep`) | notes, calls and the deck denominator |
| `salesAudit` | Mauzo / fraud | which sales are audited |
| `salesWeek`, `agentScore` | scorecards | which agents' rows are pivoted and scored |

Every one of these already had a **team scope** (`scopeQ`, an access code's `teams`
column). The credit fence sits **on top of** it, never instead of it: a fenced code's rows
are narrower still, and an unfenced code (STORE, ADMIN, HR, the credit desk's own
OFFICER/CREDIT accounts) reads exactly as it always has — `creditAllow` returns `null` for
every role outside the three, which every caller reads as "unchanged."

Each of these responses now carries a `fence` field (`{role, name, reports}` or `null`),
the same convention `stockAllow.info` already established, so a screen can say whose data
it is showing.

**`stockAllow` was corrected while the tree was being shared.** Its RSM branch used to be a
one-level check — "is this agent's `manager` literally me" — which was already quietly
wrong the moment a team leader stood between an RSM and their agents: the agent's manager
names the team leader, not the RSM, and a one-level check misses them. It now walks
`salesTree.descendants` too, a superset of what the old check ever found, and TEAM LEADER
gets the identical branch.

## Not fenced, and why

- **`reportCore` / Ripoti's own `report()`** — a roster of **call officers** (`call_users`),
  a different population from the sales hierarchy this fence pivots on. There is no IMEI on
  that roster to pivot by.
- **Requests-and-approvals queues** (advances, imprest, leave, top-ups, loss & damage,
  issues) — already scoped "a requester sees only their own, an approver or the desk sees
  any," which answers the same question a different way for a different kind of row.
- **Writes** (`portalAddComment`) — this change is about what these three roles can *see*.
  A write still only checks the code's team scope, as before.

## The one place this all comes from

`salesTree`, `managerIndex`, `tierOf`, `roleKey` and `TARGET_TIERS` moved from
`api/portal.js` to `api/_lib/call-core.js` (2026-09-18) so the calls app could walk the
same staff hierarchy the portal already had — portal.js imports them back. One definition
of "who reports to whom," read by both entry points, per the house rule.

`api/_lib/call-core.js`: `TARGET_TIERS`, `tierOf`, `managerIndex`, `salesTree`,
`FENCED_ROLES`, `isFenced`, `fenceKeyOf`, `fenceSetOf`, `agentIndex` (now also builds and
caches `.tree`), `summaryForRole`, `summaryFor`/`summaryCompute` (generalized).
`api/portal.js`: `STOCK_SCOPED_ROLES`, `stockAllow`, `CREDIT_FENCE_ROLES`, `creditAllow`,
`SUGGESTED_ROLES`.
