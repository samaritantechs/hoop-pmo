# The staff pane — each rank, and each leader's own channel

> *"I needed the staff panel to be like of hope pmo — **don't put report to**. But each person gets
> there by role, and clicking their panel needs filling who their channel data, like we start with
> 3: rsm, agent and team leader."*
>
> *"Country_Sales_Manager — this is company admin, no need to be in the list. Regional_Manager —
> these are the rsm, and on the staff pane we can activate or deactivate them, **if deactivated even
> their login attempts can't work**. Team_Leader — we expect to have them again. Field_Officer — the
> agents."*

## The edit runs the other way round

That is the whole of *"don't put report to"*.

The column underneath is the same `manager` the target cascade already walks. What changed is
**which end of the question the screen asks**. It used to be editable only from the subordinate's
row: open a field officer, type their leader's name. Nobody sits down to decide who one agent
reports to — they sit down with an RSM and decide **who is in that RSM's channel**.

So a leader's panel lists the rank directly below and you tick your way down it. The server writes
`manager` on each person that changed.

| you open | you tick |
|---|---|
| a **Regional_Manager** | their team leaders |
| a **Team_Leader** | their agents |
| a **Field_Officer** | nothing — an agent has no rank below, and the panel says so |

**Only the rank directly below.** Reaching further down would let one tick put an agent under an RSM
with a team leader standing between them — a shape the roll-up cannot then explain. A phone that is
not on that rank is **refused**, not quietly dropped: the pane cannot send one, but the pane is not
the only thing that can call the server, and silently ignoring it would report a save that did not
happen.

## What the branch derives is shown, but is not a tick

Where `manager` is blank the cascade falls back to the branch, and that is right for almost
everybody. Those people appear on the leader's panel greyed, chipped **kwa tawi / by branch**, and
with no checkbox.

A tick that stores nothing and an untick that cannot be honoured are both worse than a line of text
saying how somebody got there. It also means a save never "tidies" the branch-derived into explicit
rows — that would freeze today's branch layout into the register for ever.

**One leader's save never releases another leader's people.** Unticking only ever clears an
assignment that pointed *here*; somebody else's team is not ours to un-assign from this screen. Where
a person is assigned elsewhere the panel says whose they are, so nobody wonders.

## One column, two screens

This is not a second hierarchy. A tick here moves a number on the **targets** board, because both
read `manager` through the same `salesTree`. If the pane wrote somewhere of its own, the staff
screen and the targets board would disagree about who is under whom — and the numbers would be the
last thing anybody noticed. A test asserts the round trip.

## The three ranks, and the fourth nobody falls out of

The tabs are **RSM · Viongozi wa timu · Maajenti · Wengine**. Country_Sales_Manager is off the named
tabs as asked, but lands in **Wengine** along with any role the ladder does not recognise — a staff
register that silently drops rows is how somebody disappears from the company without anybody
deciding they should.

## Deactivating shuts the door

> *"If deactivated even their login attempts can't work."*

Two registers, one act. `hoop_agents.active` says whether somebody works here; `access_codes` is
what opens the door, and until now **nothing joined them** — a person marked inactive could still
sign in all afternoon.

**Zima / Off** now does both: marks them inactive *and* suspends any portal code in their name, open
ended (`suspend_from` = today, no end date), which `suspendedOn` reads as "until somebody lifts it".
**Washa / On** lifts it again.

Three things this says out loud rather than assuming:

- **The two registers are joined by name and nothing else.** It is the only thing they share. So
  *"no portal code in that name"* is an ordinary answer and is reported — otherwise somebody
  believes they have shut a door that is still open.
- **An ADMIN code is never suspended by this pane.** The standing rule, and here also the lockout
  guard: an admin code shut from here would leave nobody able to lift it. It is reported as skipped.
- **Before the suspend migration**, the register still changes and the toast says the door did not.
  Three states, not two.

The confirmation names the second register **before** the click, because one button reaching two
tables should never be a surprise.

## Who can do it

`staff` — the nav is the permission, as everywhere here. That means the staff nav grants suspending
a login, which is the owner's own decision (*"on the staff pane we can activate or deactivate
them"*). Both writes are in `AUDITED`, so who changed a channel and who shut a door are in the log.

## What to do

**Nothing to run.** Both columns already exist — `manager` came with the targets migration and
`suspend_from`/`suspend_to` with the access-suspend one. If either has not been run, the pane says
which file and keeps working meanwhile.

## Not changed

`staffManager` — the single-person edit — is still on the server and still tested. The pane no longer
offers it, but a genuine cross-branch exception can still be set through it, and removing a working,
tested endpoint to tidy a screen would be a trade in the wrong direction.

## Files

| file | what changed |
|---|---|
| `api/portal.js` | `staffAgents`, `staffChannel`, `staffChannelSave`, `staffActive`; both new writes in `AUDITED` |
| `public/portal.html` | `STAFF_TIERS`, `staffTierOf`, `staffChannelDrawer`, `staffActiveToggle`, `staffWireChannel`; the rank chips and the Channel column |
| `test/staff-channel.test.mjs` | twelve tests |
