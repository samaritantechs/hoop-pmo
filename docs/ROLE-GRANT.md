# The role's ticks are the grant

> *"Roles enrollment should be like of hopemo — I just assign someone as RSM CREDIT STORE etc and
> they get the roles I assigned; their navs by ticking and not the whole dept."*

## What was actually happening

Two separate fallbacks fired when a role had nothing ticked, and between them they handed out
panes nobody chose.

```
resolveTabs   an empty merged list fell back to USER_TABS   -- the OLD vocabulary
navsFor       a `chosen` list of only dashboard/settings fell back to LEGACY_NAVS
```

Both fallbacks are legitimate: a code saved **before panes were choosable** carries the old
vocabulary and must not go dark on a deploy day. The problem was that each fired far wider than
the case it was written for.

**Four nav keys are also old-vocabulary words:** `dashboard`, `reports`, `commission`, `settings`.

`navsFor`'s guard excluded two of them, hand-written as `k !== 'dashboard' && k !== 'settings'`.
That was correct the day it was written and quietly wrong from the day `commission` was added to
`NAV_TABS`. Nobody revisits a hand-written exclusion list.

So:

- Create a role called `STORE`. Tick nothing on it yet. Give somebody that code.
  → `resolveTabs` fell back to the old vocabulary, `reports` made `navsFor` read that as a
  deliberate choice, and the person got **Dashboard, Call reports and Commission** — the pane
  that builds sheets, sets rates and pays agents.
- Or tick **only Dashboard** on a role.
  → `chosen` came back as just `['dashboard']`, the guard read it as "nothing deliberate here",
  and answered with Customers, Call reports, Recovery and Staff as well. That is the whole
  department.

Nobody ticked any of it, and nothing on any screen said so.

## The rule now

**A tick is the grant. No tick is no grant. The fallbacks fire only for genuinely old rows.**

Three changes, all of them narrowing:

1. **`resolveTabs` takes `roleKnown`** — whether a row for this role *exists*, which is not the
   same question as whether that row ticked anything.

   | | means | resolves to |
   |---|---|---|
   | no row at all | nobody has ever configured this role | the old defaults |
   | a row, no ticks | somebody configured it and ticked nothing | **nothing** |

2. **The ambiguous set is derived, not written out.**

   ```js
   const AMBIGUOUS_NAVS = new Set(NAV_TABS.filter(k => USER_TABS.includes(k) || EXTRA_TABS.includes(k)));
   ```

   A nav that is *not* also an old word can only have been ticked on purpose, so the moment one
   appears the list is a deliberate choice and is honoured whole. It cannot go stale again: a nav
   added tomorrow is classified correctly the moment it exists.

3. **The legacy branch fires on a legacy word.**

   ```js
   const isLegacyWord = k => !NAV_TABS.includes(k) && k !== 'sales' && k !== 'devices';
   ```

   The roles editor can only ever tick a `NAV_TABS` key, and the two stored aliases are expanded
   first — so anything else on a row (`followup`, `par`, `present`, `weekly`, `upload`, `audit`)
   is a word this system can no longer hand out, and can only have been saved back when the
   vocabulary was different.

### Both sides still hold

- A **deliberate** tick of an ambiguous nav is honoured: a Finance role ticked exactly
  `commission` gets exactly Commission.
- A **never-configured** code keeps every door it had — Customers, Call reports, Recovery, Staff
  — and no longer collects Commission on the way.
- The two aliases still expand: `sales` → fraud + scorecards + stock + movement, `devices` →
  devlock + devunlock. Neither drags the legacy defaults along with it.
- ADMIN holds everything. AUDITOR sees everything and changes nothing.

## Saying so on screen

A rule this quiet needs to be visible before somebody is handed a code, not after they sign in to
an empty sidebar.

- **The access-code form previews the role.** Pick a role and the line under it says what that
  role opens, as chips — or, in red, *"haina nav hata moja"*: this role opens nothing yet, tick
  its navs under Roles first. It reads the same role rows the server sent, so it is never a
  second opinion computed on the client. It follows the picker, and follows **Hariri** filling
  the form.
- **A role chip with nothing ticked carries a red `hakuna nav`** in the Roles list, so an
  unconfigured role is visible where roles are managed and not only where codes are made.

## One behaviour change worth knowing

A role ticked with **only `settings`** used to fall through to the legacy defaults and receive
nine panes. It now receives Settings. That is the fix working as asked; `requireSettings` still
lets that person into Settings and Access codes. Any genuinely old row also carries `upload` or
an old vocabulary word, so it keeps the legacy path.

## What to do

Nothing, unless you want to. Every existing code keeps what it had. To get the behaviour the
amendment asks for, open **Access codes → Roles**, tick each role's panes, and hand people the
role — the preview will tell you what they are about to get.

## Files

| file | what changed |
|---|---|
| `api/_lib/auth.js` | `resolveTabs(user, roleTabs, roleKnown)`; `authCodeResolved` passes `!!data` |
| `api/portal.js` | `AMBIGUOUS_NAVS`, `isLegacyWord`, the two guards in `navsFor` |
| `public/portal.html` | the role preview on the access-code form; the `hakuna nav` chip |
| `test/role-grant.test.mjs` | nine tests |
