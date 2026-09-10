# Two device desks: locking and unlocking

> *"We now want storekeeper to always lock and general duty will be unlocking at customer
> screening-pos … all see the devices but no unlocking button in locking … but the lockers will
> be able to relock the devices."*
>
> *"Remember we working on amendments — more than 200 phones are in regions kilometers away,
> don't distract the locking and unlocking mechanism."*

## Nothing a handset observes has changed

That second sentence is the one most of this work was about.

A handset learns what it should be doing from `commandFor(state)` in `api/_lib/device-core.js`,
over `/api/device`, using its own per-device token. It has never known what a nav is, and after
this change it still does not. The state names, the four transitions, the beat contract, the
token, the offline grace — all untouched.

**This is a permission change and only a permission change.** A test asserts it: `commandFor`
still maps `locked`/`lost` → `lock` and `enrolled`/`released` → `unlock`, and neither
`device-core.js` nor `api/device.js` contains the string `requireNav`, `devlock` or `devunlock`.

## The two desks

| nav | pane | who | may order |
|---|---|---|---|
| `devlock` | Kufunga simu / Locking | the store keeper | **Funga** (lock), **re-lock**, **Imepotea** (write off), enrol, mint a token, delete a row |
| `devunlock` | Kufungua simu / Unlocking | general duty, at customer screening / POS | **Fungua** (unlock), **Achia** (release) |

**Both see every phone.** Splitting the *reading* would leave the store keeper unable to tell
whether the handset they are about to ship is locked, which is the one thing they must know. What
is split is what each may **do**.

Both panes are the same `drawDevices` — one implementation, so the two halves cannot drift into
disagreeing about the fleet. `DEVMODE` is derived from `TAB` on every draw rather than set by the
dispatch, so it can never be left pointing at the pane somebody just left.

## The gate is on the transition, not on the pane

`deviceSetState` is **one door** for all four state changes. A pane that merely hides its unlock
button is a suggestion — curl does not read HTML — so the server asks which nav the *asked-for
state* requires:

```js
const DEVICE_STATE_NAV = { locked: 'devlock', lost: 'devlock',
                           enrolled: 'devunlock', released: 'devunlock' };
```

Written as data rather than as branches inside the handler: a fifth state added later with no
entry here is refused outright by the `hasOwnProperty` check above it. A missing case that fell
through to "allowed" is how a nav split quietly stops splitting anything.

This is also what makes **re-locking** work. A locker sending `locked` against a released phone is
still asking to lock, and that is theirs to ask — including the released-but-still-listening case
the register was built to keep reachable.

### Why write-off sits with the locker

`lost` is stock accountability: the store keeper holds the consignment and is the one who knows a
handset is gone. It also keeps the phone shut (`commandFor('lost') === 'lock'`), so it belongs with
the desk that shuts phones. Loss *valuation and recovery* remain Finance's, on the `loss` nav.

## Nobody went dark the morning this shipped

Every role and code in the field carries the old `devices` tick. Splitting the nav without
expanding that grant would have taken the bench away from the store keeper and the POS desk away
from general duty, on a deploy nobody asked for.

So `devices` **remains as a legacy alias**, expanded in `navsFor` to both halves — the same shape
the retired `sales` key already uses:

```js
if (t.includes('devices')) t.push('devlock', 'devunlock');
```

It is no longer offered as a tick box, and `saveRole` still *accepts* it so re-saving a role does
not silently drop a grant everybody holding that role depends on.

**To actually separate the two desks, the owner re-ticks:** `devlock` on the store role,
`devunlock` on general duty, then unticks `devices`. Until then everything behaves exactly as it
did yesterday.

## The row panel obeys the split too

> *"Now the unlocking needs the achia button — it shouldn't be at locking."*

The split shipped on the bulk bar and stopped there. The **per-row drawer** — which only ever
opens from the locking bench — went on offering all four orders, so **Fungua** and **Achia** sat
there for the store keeper to press and the only thing behind them was the server's 403.

That refusal is the rule working, and it is still the wrong screen: a button whose only possible
answer is a refusal teaches the operator that the system is broken rather than that the order was
never theirs to give.

The panel now reads the same `DEVMODE` the pane derives, so the drawer and the bar cannot disagree
about which half of the registry somebody is standing on. It is tested by **running** it in both
modes, not by grepping for a button string — a button that is written down is not the same as a
button that is drawn.

## The paste: both desks work from lists

> *"Add the 4th on the right 'Release/Achia Bulk' so that the general duty can paste a list of imeis
> as we paste at enrolling bulk … since sales are many they can't just tick one by one imei, so they
> paste a list of verified sales imeis and release at once."*

The other three buttons act on what is **ticked**. Ticking is the right verb when the phones are in
front of you — a bench of twenty, a hub, a customer at the counter. It is the wrong verb at the end
of a selling day, when the desk is holding a list that came out of somewhere else entirely and
turning it into ticks means hunting each IMEI through a register of hundreds.

> *"As achia has bulk and enroll has bulk, lock need bulk too at locking."*

So the last button takes **the list itself** — the same door the bench already uses to enrol a
batch. **Both desks get one**, because both work from lists: the store bench already pastes to
enrol a consignment, and pasting to *lock* that same consignment was the one step still asking for
four hundred clicks.

Which order the button gives is the desk's own, read from the same `DEVMODE` that decides every
other control on the pane — so a store bench cannot paste its way to a release, and a server test
holds that from the other side too. It sits apart from the rest, pushed right, because the
selection has nothing to do with it: two controls that look like a set and read different inputs is
how somebody ticks three rows, presses this one, and expects those three.

### One form, two orders — but not one warning

Everything that makes a bulk order safe is the same work for either desk, so there is one form. What
is **not** the same is what the order costs, and a warning copied across would be false on one of
the two screens:

| | what the screen says |
|---|---|
| **Achia** | one-way — the handset drops Device Owner, stops reporting, and the way back is a cable, per phone |
| **Funga** | every phone on the list goes dark to whoever holds it until **general duty** opens it; you will be asked for one reason, recorded against all of them |

Calling a lock irreversible would be a lie that makes the real warning next door mean less. A test
asserts the locking sheet never borrows the one-way sentence.

**The count under the box is the whole safety of the screen, and it is deliberately not a
validation.** It says live what the paste *parsed to* — how many IMEIs, the first one, how many were
repeats. That catches the two mistakes a paste actually makes:

| the mistake | what the count shows |
|---|---|
| a whole column arriving as one unbroken token | reads **1** |
| a header row riding along | first one reads **IMEI** |

Both **before** the confirmation rather than after the phones are gone. It cannot catch the mistake
that matters most — the right-shaped list of the wrong phones — so it does not pretend to.

**Nothing is repaired and nothing is judged.** Newlines, tabs, commas, semicolons and Excel's quotes
are separators or noise; everything else goes to the register exactly as typed. Stripping a stray
character out of `35138-8334583295` would produce a shorter number that looks as valid as a real
IMEI, and this list ends in an order that cannot be taken back. No shape rule is invented either —
this register is keyed on whatever the stock report calls a serial and has never asserted a length
anywhere else, so a fence added here would either cry wolf on real serials or teach people to ignore
it. **The register is the judge**, and it answers by name.

The order goes through `devAct_` like every other, so the one-way-door confirmation is the one
already proven rather than a second copy that will one day disagree with the first.

### And the strangers are named

`deviceSetState` has always returned `notEnrolledList`; nothing ever showed it. *"2 hazijasajiliwa"*
against a paste of eighty is the operator's problem restated — they would have to re-paste in
batches to find which two. Those IMEIs now open in a drawer, by name, with *"…na nyingine N"* when
the server's list of twenty is not all of them.

From the bulk bar this stays silent, because ticked rows are enrolled by definition — except in the
one case where it should not be silent: a row deleted by somebody else between the read and the
press.

### The ceiling

Every IMEI rides in an `in(...)` filter, which travels as a query string. Past a few hundred the URL
is refused somewhere between the portal and the database, and what comes back is a transport error
rather than an answer about phones. A paste is no longer bounded by what fits on a screen, so
`deviceSetState` now carries **the same 500 limit `deviceEnrol` already has** — one ceiling to
remember, and above the 500 rows `deviceList` shows, so tick-all on a full table still fits.

## Files

| file | what changed |
|---|---|
| `api/portal.js` | `DEVICE_STATE_NAV`; `devlock`/`devunlock` in `NAV_TABS`; the legacy expansion in `navsFor`; the gates on `deviceList`, `deviceHistory`, `deviceEnrol`, `deviceToken`, `deviceDelete`, `deviceSetState`; the 500 ceiling |
| `public/portal.html` | two catalog entries, `DEVMODE`, the per-mode action bar and row buttons, the per-row **Fungua**, the desk-aware row panel, `devParseImeis_`, `DEVBULK`/`devBulkForm`, `devUnknownDrawer_` |
| `test/device-split.test.mjs` | seven tests, one of them entirely about the field contract |
| `test/device-bulk.test.mjs` | ten tests — the desk split run in both modes, the parser, both bulk orders, the ceiling, the named strangers |
| `api/_lib/device-core.js`, `api/device.js`, `android/` | **untouched** |
