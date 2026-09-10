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

## Files

| file | what changed |
|---|---|
| `api/portal.js` | `DEVICE_STATE_NAV`; `devlock`/`devunlock` in `NAV_TABS`; the legacy expansion in `navsFor`; the gates on `deviceList`, `deviceHistory`, `deviceEnrol`, `deviceToken`, `deviceDelete`, `deviceSetState` |
| `public/portal.html` | two catalog entries, `DEVMODE`, the per-mode action bar and row buttons, the per-row **Fungua** |
| `test/device-split.test.mjs` | seven tests, one of them entirely about the field contract |
| `api/_lib/device-core.js`, `api/device.js`, `android/` | **untouched** |
