# One target, everybody's number

> *"Sales target is set per rsm like hope sets for team, so it increases to the higher leadership
> tiers, but decrease when going down to team leaders and agents — like it's 2 halves if only 2
> team leaders are under the rsm. With that hierarchy down at agents contributive auto target from
> that of rsm. And **target will be set by role not a single staff**."*

## Two sentences, one arithmetic

"Increases going up" and "decreases going down" are the same rule read from either end: a number
set at one level is **divided** among the people under it, and the sum of those shares is the
number you started with.

Set **40** on an RSM with two team leaders:

```
RSM ONE                 40      own
├── TL A                20      share of RSM ONE ÷2
│   ├── AG 1            10      share of TL A ÷2
│   └── AG 2            10
└── TL B                20
    ├── AG 3            10
    └── AG 4            10
                        ──
    everybody beneath   40      "it increases to the higher leadership tiers"
```

## Nothing derived is ever stored

A share written into a row is a lie the moment somebody moves team, gains an agent or leaves —
and a lie **nobody could see**, because it would look exactly like a number a person typed.

So the ladder is walked on every read, and **every row says where its number came from**:

| chip | meaning |
|---|---|
| `limewekwa` | somebody typed this against this person |
| `wadhifa: FIELD_OFFICER` | their role's target |
| `sehemu ya RSM ONE ÷2` | their manager's target, divided this many ways |

## Three answers, in order of authority

1. **own** — a target typed against this person's name.
2. **role** — a target typed against their role.
3. **share** — their manager's target ÷ the number of people reporting to that manager.

The manager's own target is resolved the same way, so a single number set on the country manager
reaches a field officer through however many rungs lie between.

A share is rounded **up**: three people splitting ten phones who each aim at three finish the
month one short of what was asked for.

## Set by role, not by a single staff

`scope = 'role'` means the name is a role from the register — `REGIONAL_MANAGER`,
`TEAM_LEADER`, `FIELD_OFFICER` — and every holder is expected to sell that much. **One row
instead of one row per person**, which is the difference between a target somebody keeps up and a
target nobody sets after the first month.

A role is **picked from the register's own roles**, never typed, and stored the way the register
spells them — so *"regional manager"*, *"Regional_Manager"* and *"REGIONAL MANAGER"* are one
target rather than three. Deleting keys it the same way, or it would delete nothing.

The role tab is a **source, not a scoreboard**: nothing is measured against a role, so it shows
what was set and how many people draw from it, and says so.

## The ladder

`Country_Sales_Manager → Regional_Manager → Team_Leader → Field_Officer`

The parent is the register's own `manager` where somebody filled it in; where it is blank — which
is almost everybody — it is the nearest person **one rung up in the same branch**, then anywhere.
That is right for the ordinary case and means the cascade works on day one instead of after a
thousand edits.

**A manager who is not above you is not your manager.** Two field officers naming each other, or
a typo pointing at a peer, would otherwise make a loop the share walk could fall into; the tier
check refuses it before it can form, and a visited set catches anything that slips past.

## What the board gained

- Everybody the ladder gives a target to is **on the board**, even if they sold nothing and were
  never typed into the table. A board showing only the people who happened to sell hides exactly
  the rows worth reading.
- A leader's row carries **what everybody beneath them adds up to**. Where that differs from their
  own number, somebody has been overridden below — and seeing it is the point of showing both.
- A tile counts the rows answering for a number nobody typed. Zero on a staffed company means
  nothing has been set at the top.
- **Remove** is offered only for a target somebody typed. A share is not a row; there is nothing
  to delete, and the button would promise what the server cannot do.

Achievement is still measured against `watu_loans` by `disbursed_date` — the Watu deck — and a
derived target is measured exactly like a typed one.

## What to do

1. Run `db/migrations/RUN-ME-2026-09-10-target-roles.sql`. It adds `role` to the scope
   constraint and does nothing at all until `sales_targets` exists, so it is safe before or after
   the targets migration.
2. Fill `manager` in the register only where somebody reports **across a branch line** — the
   branch derives the rest.
3. Set one number. On the role, or on an RSM, or at the top. The rest of the board fills itself in.

## Files

| file | what changed |
|---|---|
| `db/migrations/RUN-ME-2026-09-10-target-roles.sql` | the `role` scope |
| `db/migrations/RUN-ME-2026-09-09-targets.sql` | kept in step, for a database built from it alone |
| `api/portal.js` | `TARGET_TIERS`, `tierOf`, `salesTree`, `resolveTarget`; the cascade in `targetsView`; the role scope in `targetSave`/`targetDelete` |
| `public/portal.html` | `tgtSource`, the provenance chip, the roll-up, the role tab and drawer |
| `test/target-cascade.test.mjs` | eight tests, all of them about the arithmetic |
