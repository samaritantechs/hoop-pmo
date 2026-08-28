# Locking HOOP's phones

> "the stock is too large and hoop agents are stealing stock thats why the stock needs to be
> pre-locked before unboxing — or unbox if it becomes a must"

This is the whole feature written down in one place: what actually locks a phone, what the
server knows, what the station has to do, and — the part worth reading twice — what this
cannot do.

---

## The thing to understand first

**You cannot lock a phone by IMEI.** Not with this system, and not with any of the services
that advertise it that way.

An IMEI is a serial number. It identifies a handset; it grants nobody any power over one.
There is no remote command in the GSM network, and none at Samsung or Tecno or Itel, that
takes an IMEI and locks the phone it belongs to. When SMF, Datacultr, Zyntro or LimaxPay say
"lock by IMEI", what they mean is: *their app is already installed on that phone, and the
IMEI is how their dashboard addresses it.* The IMEI is the address on the envelope, never the
hand that closes the door.

So the answer to "do those companies need us to unbox?" is **yes, exactly as we do.** Their
app has to reach the handset before anything can be locked, and the only ways an app becomes
unremovable are performed with the phone in your hands. The one route that skips unboxing is
Android zero-touch (or Samsung Knox Mobile Enrolment), where the *seller* registers the
device to you before it ever ships — and that requires buying through an authorised
distributor. HOOP buys "from random sellers chasing profit", so that door is closed. Nobody
can sell us a way around it; the unboxing is the price of the mechanism, for us and for them.

**What actually locks the phone is Device Owner.** An app made Device Owner can pin the
screen with no way out, block factory reset and safe boot, and refuse to be uninstalled.
That status can only be granted on a phone with no accounts on it — fresh from the box, or
fresh from a factory reset — which is precisely why the boxes have to be opened.

---

## The two halves

| | Where it lives | What it does |
|---|---|---|
| **Registry** | `api/portal.js`, `devices` table | who is enrolled, what state each phone is *meant* to be in |
| **Handset** | `android/lock/`, `/api/device` | draws the lock screen, reports in, asks what it should be doing |

They are joined by **IMEI** in the register — because that is the one identifier Sipho's
stock report, the Watu register, the sales book and the officers' deck already share, so a
device row joins to everything we know with no new plumbing.

But the handset is **not** identified by IMEI. It carries a **token**, minted once at
enrolment and written into that one phone. Three ordinary reasons the IMEI could not do that
job: from Android 10 a normal app is refused it outright; a dual-SIM phone has *two* and
which one Sipho wrote down is a coin toss; and the getter changed shape across the Android
versions this stock spans. An honest phone reading the wrong slot would have looked exactly
like an attack. The token cannot be wrong about which row it speaks for.

### Ordered is not confirmed

`state` is what the office decided. `reported` is what the phone last said about itself.
A phone told to lock that has not checked in is **pending** — not locked, and not a failure.
The register sorts worst-first and counts pending locks separately, because a screen that
blurs those two cannot be trusted to chase anything.

---

## What the station does

Every phone gets three things: enrolled on the register, made Device Owner, handed its token.

### Sipho's card — the whole loop, per phone

1. **Portal → Devices → + Sajili simu.** Paste the day's IMEIs (up to 500 at once). Copy the
   token list it shows — it shows each token **once**.
2. **On the handset:** skip every account in the setup wizard → Settings → About phone →
   Software information → tap **Build number** 7× → back → Developer options → **USB
   debugging** on → plug in the cable → accept **Allow USB debugging** on the phone.
3. **On the laptop:** `scripts\lock-bench.bat` on Windows (or the three commands below for
   one phone). Takes about ten seconds per handset.
4. **Watch it appear** on Devices while the box is still open. If it does not, provisioning
   did not take — fix it now, not after it has been reboxed.
5. **Funga → reason → wait for CONFIRMED**, not pending. Only then power off and box it.

Steps 1, 3, 4 and 5 are near-instant. **Step 2 is the day**: two to three minutes of tapping
per phone that no script can reach, which at 200 phones is about ten hours of one person's
time. The only ways to spend less are to run phones in parallel on a powered USB hub — the
bench script is built for exactly that — or to buy through a Knox-participating reseller, the
one route where a handset provisions itself at first boot with nobody touching it.

### 1. Enrol (portal, before you touch the phones)

Devices → **+ Sajili simu**, paste the IMEIs from Sipho's report. Model and holder fill in
from the newest stock count. The screen then shows **one token per phone, once** — copy that
list; it is what you are about to write into the handsets. (A wiped phone's token can be read
back later, one at a time, with the **Token** button. That read is audited.)

### 2. Make it Device Owner

The phone must have **no Google account and no screen lock** — straight out of the box, or
straight after Settings → Reset. Either route works:

**With a laptop and a cable** (recommended at HOOP's scale — a bench already covered in
phones, and unlike a QR it gives you an error you can read):

```sh
adb install -r public/HOOPLOAN-Lock.apk
adb shell dpm set-device-owner com.samaritantechs.hooploanlock/.LockAdmin
adb shell am broadcast --include-stopped-packages \
    -a com.samaritantechs.hooploanlock.ENROL \
    -n com.samaritantechs.hooploanlock/.EnrolReceiver \
    -e server https://hoop-pmo.vercel.app \
    -e token <that phone's token>
```

Three commands, about ten seconds. **Neither half works without the other:** the APK on its
own is an ordinary app that a thief uninstalls in seconds, and `set-device-owner` names a
component that has to already be on the phone, so it fails on a handset with nothing
installed. Installing is itself an adb command, though, which is why all three are above and
why nothing here needs touching the phone's screen.

**For a batch, do not type these 200 times.** The bench script takes the IMEI/token list from
step 1, walks every phone that `adb devices` can see, and runs all three on each — matching
each phone to its own token by asking the handset for its IMEI, and refusing to guess when it
cannot read one. Both files carry the instructions in their own headers.

| | Windows (HOOP's bench) | Linux / macOS |
|---|---|---|
| **Many phones** | `…lock-bench.ps1 tokens.txt` | `./scripts/lock-bench.sh tokens.txt` |
| **One phone** | `…lock-bench.ps1 -Token <token>` | `TOKEN=<token> ./scripts/lock-bench.sh` |
| **Already holds a token** | add `-ReEnrol` | prefix `REENROL=1` |

(Windows form in full: `powershell -ExecutionPolicy Bypass -File scripts\lock-bench.ps1 …`,
or double-click `scripts\lock-bench.bat`.)

> "the locking method for bulk should be one that works wether there is one connected phone
> or more"
>
> **One phone needs no file.** Writing a two-word text file to provision a single handset is
> friction with no purpose, and the single-phone case is constant — a redo, a replacement,
> one that failed the first time.
>
> **And with one phone and one token the IMEI match is skipped**, because it is protecting
> against nothing: there is no other handset to confuse it with, so the pairing cannot be
> wrong. That also skips the *"could not read this phone's IMEI"* failure, which is exactly
> what stops a single-phone job dead on Android 10+ where the modem read is refused until
> Device Owner takes. With several phones the match is back, because then there IS a wrong
> pairing to make and it costs a customer their handset.
>
> **`-ReEnrol` replaces the token a handset is already holding** — it clears the app's stored
> data first, and Device Owner survives that, so it works without a factory reset.

**Two answers that are not failures**, and both scripts now count them as done rather than
stopping: `set-device-owner` saying **device owner is already set** (arriving as a red Java
stack trace, which is not how a success usually looks), and the broadcast saying
**ALREADY ENROLLED**. Both mean the handset was provisioned before.

> The Windows version exists because the first thing the station saw was
> `'.' is not recognized as an internal or external command` — a bash script on a Windows
> bench is not a slow path, it is no path. The two must stay in step; a smoke test holds the
> PowerShell one to the same command order and the same never-guess rule, and checks both
> still name the same package and receiver.

> **`--include-stopped-packages` is not optional**, and leaving it off is the third time this
> feature has produced a failure shaped exactly like a success. A freshly installed app — and
> any app that has had `pm clear` run on it — sits in Android's **stopped** state and receives
> no broadcast at all unless the sender asks for one. Without the flag, `am` reports:
>
> ```
> Broadcast completed: result=0
> ```
>
> No result code, no message, nothing in logcat: `EnrolReceiver` is never constructed, so not
> one of its carefully-worded guards can fire. Learn the signature — **`result=0` with no
> `data=` means the receiver did not run**; `result=1..4` *with* a message means it did.
>
> Found on a real handset that had been silent for twenty hours while the register went on
> recording locks and releases against it.

**Two messages that read like failures and are not.** `set-device-owner` answering
`device owner is already set`, and the enrol broadcast answering `ALREADY ENROLLED`, both
mean the handset was provisioned before. On a phone being redone that is the finished state,
not an error — the second is the re-enrolment guard doing its job.

> **THE QR ROUTE DOES NOT WORK ON SAMSUNG — tested 27 Aug 2026 on an A07.** The six-tap
> scanner never appears: tried at first boot, after joining Wi-Fi, and after installing the
> APK by hand. Samsung has been dropping AOSP QR provisioning in favour of their own Knox
> Mobile Enrolment. Use the cable. The instructions below are kept for non-Samsung stock and
> for the day Knox is set up properly.
>
> **And the order of the two adb commands is not optional.** set-device-owner FIRST, then the
> enrol broadcast. Run them the other way round and the receiver drops the token in silence
> while adb prints `Broadcast completed: result=0`, which reads exactly like success. That
> cost an evening on the first handset; EnrolReceiver now sets a result code and a message,
> so adb prints the reason.

**By QR at the setup wizard** (better for hundreds at a time): on the very first "Hi there"
screen, tap the same spot six times to open the QR scanner, and show it a code containing:

```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
    "com.samaritantechs.hooploanlock/.LockAdmin",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "<checksum>",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
    "https://hoop-pmo.vercel.app/HOOPLOAN-Lock.apk",
  "android.app.extra.PROVISIONING_WIFI_SSID": "HOOP LIMITED",
  "android.app.extra.PROVISIONING_WIFI_PASSWORD": "<the bench wifi password>",
  "android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE": "WPA",
  "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
    "server": "https://hoop-pmo.vercel.app",
    "token": "<that phone's token>"
  },
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": true,
  "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true
}
```

`<checksum>` is published at **`/lock-provisioning.json`**, regenerated by CI from the key
that signed the current APK — so it cannot go stale and strand a batch at the wizard.

**The three WiFi lines are the whole point of this route**, and they answer the obvious
question — *"can't we put the bench wifi in it and just switch the phones on?"* Yes: with
those in the code, the handset joins the network itself, downloads the APK itself, makes
itself Device Owner and reports in, with nobody tapping through the wizard, skipping a Google
account, or toggling USB debugging. That is the ~3 minutes a phone the cable route cannot get
back.

**It still needs one QR per phone**, because the token in the bundle belongs to one register
row. A single QR for a whole batch would mean the phone asking the server for a token by
IMEI, and the register deliberately does not answer that question — see the note on
`byToken`. Worth building the day the QR route works at all; not before.

> **And on Samsung it does not work.** Tested 27 Aug 2026 on the A07: the six-tap scanner
> never appears, WiFi in the payload or not. So this saves nothing on the stock HOOP actually
> buys, and the cable is still the route. Do not plan a day around it.

**Knox Mobile Enrolment is the version of this that does work on Samsung**, and it is worth
asking the supplier about before the next big order. The seller registers the IMEIs to us
before they ship; the phones then provision themselves at first boot over WiFi, no QR and no
cable. It needs buying through a Knox-participating authorised reseller — and there is now a
reason to think that is reachable: the Watu-sourced A07 arrived carrying **Knox Guard**, which
means somebody in that supply chain already holds a Knox account.

> **Turning that JSON into a QR image is not built into the portal.** Writing a QR encoder
> that has never been scanned by a real phone would mean handing the station a code that
> might quietly be wrong, with no way to tell except a failed wizard on fifty handsets. Paste
> the JSON into any QR generator you trust — the payload above is the whole input.

### 3. Watch it appear

The phone says hello the moment it is enrolled, so it should show up on the register while
the box is still open. If it does not, provisioning did not take — check it there and then,
not after it has been reboxed.

### 4. Lock it BEFORE you box it

This is the step that makes stock locking work, and the one that is easy to get backwards.

**An order to lock only reaches a phone that is online.** The handset asks what it should be
doing every 15 minutes; a command is never queued or pushed — it is recomputed from `state`
and handed over on the next beat. A phone that is already boxed, switched off, with no SIM
and no wifi, will never hear it. Ticking **Funga** on a shelf full of boxes therefore changes
a column in the register and *nothing on the phones*, which is exactly the false sense of
security this system exists to avoid.

So while the handset is still on the bench and still online:

1. Tick it → **Funga** → reason (`stock, unsold` does fine).
2. **Wait for the register to say confirmed, not pending.** Pending means the office has
   decided and the phone has not yet agreed. Only confirmed means the lock screen is actually
   up on that handset.
3. *Then* power it off and box it.

From that moment the phone carries its own lock. `Prefs.LOCKED` is written on the handset and
`BootReceiver` restores it on every boot **with no network at all** — so a box that walks out
of the store powers on locked, stays locked through as many reboots as anyone tries, and
cannot be factory reset out of it. The thief gets a brick with our phone number on it.

Unlock is the sale: **Fungua** when the phone is handed to a customer, with the handset online
so it hears within about fifteen minutes. Record the customer or sale reference at the same
time — that is what switches the offline rule from "never self-lock" to the grace window
below, and a sold phone left looking like stock is a phone that can be kept in airplane mode
forever.

---

## Day to day

- **Lock**: tick the phones, **Funga**, give a reason. A reason is required — six months
  later "why is this locked" has to have an answer.
- **Unlock**: **Fungua**. Reaches the handset within about fifteen minutes.
- **Release**: **Achia** when the loan clears. This gives the phone back *completely* — the
  restrictions come off, Device Owner steps down, and the app stops calling home. A customer
  who has finished paying should not be left with a handset that still refuses to factory
  reset.
- **Write off**: **Imepotea**. Stays locked, deliberately — a phone we have given up on is
  exactly the one that must not quietly come back to life.

### The offline rule

A phone that cannot reach us cannot be told to lock. Do nothing about that and "keep it in
airplane mode" defeats the whole system. Lock on every missed beat and we strand a paying
customer who spent an afternoon somewhere with one bar.

The split: **stock never self-locks** (boxed phones are offline for weeks by design), and a
phone that has gone out to a customer gets a generous grace — **7 days by default**, counted
from the last beat that actually *succeeded*. Change it with the `DEVICE_OFFLINE_GRACE_HOURS`
setting; no new APK required.

A self-lock is not the handset judging anybody. It is the phone saying "I have not heard from
the office in far too long", and the moment it reaches us the office's real answer wins —
including unlocking it straight back.

---

## What a locked phone actually says

```
                    HOOP LIMITED

    SIMU HII IMEFUNGWA NA HOOP LIMITED. WASILIANA
             NASI KWA NAMBA 0700123456

           IMEI: 351388334583295
           REASON: STOCK, UNSOLD

            [ Simu ya dharura / Emergency call ]
```

**Not one of those words is in the APK.** The company name, the message, the number and the
reason all arrive on the heartbeat and are stored on the handset, so a phone that has been in
somebody's pocket for eighteen months still shows the number the office answers *today*. The
app owns the layout; the server owns every word in it.

The IMEI shown is **the register's**, not the one the handset reads off its own modem. Those
are different facts and the register's is the useful one: it is what Sipho's stock report
says, what the office will search on, and — from Android 10 — the only one an app can display
at all unless Device Owner took properly. See the note in `Imei.java`.

`{brand}` and `{namba}` in `DEVICE_LOCK_MESSAGE` are filled in by the server, so a rename or a
new phone number is one row in Settings and not a build.

## Settings

| Key | Default | What it does |
|---|---|---|
| `DEVICE_LOCK_BRAND` | `HOOP LIMITED` | the company name across the top, and `{brand}` |
| `DEVICE_LOCK_MESSAGE` | see below | the sentence under it; `{brand}` and `{namba}` are substituted |
| `DEVICE_HELP_PHONE` | — | the number to call, and `{namba}` |
| `DEVICE_LOCK_REASON` | — | the REASON line **only when nobody ordered the lock** — see below |
| `DEVICE_OFFLINE_GRACE_HOURS` | `168` | silence before a customer's phone self-locks |

The default message is `Simu hii imefungwa na {brand}. Wasiliana nasi kwa namba {namba}.` —
and, with no `DEVICE_HELP_PHONE` set, `…Wasiliana nasi kumaliza malipo.` instead. A sentence
that promises a number and then does not give one is worse than no sentence at all.

`DEVICE_LOCK_REASON` is a **fallback, not an override.** A lock ordered from the portal always
carries its own reason — Funga refuses to send one without — and that reason always wins. The
setting covers the one case with nobody to write a reason: a phone that locked *itself* on the
offline grace, in a dead spot, with the office unaware. Without it that handset shows
`REASON:` and nothing after it.

These live in settings rather than in the APK because the number a stranded customer is told
to call is exactly the kind of thing that changes on a Tuesday. Edit them in **Portal →
Settings**; every one of them is on that screen.

> They were not, until 27 Aug 2026. This document said they lived in settings, `device-core.js`
> read them on every heartbeat, and neither `settings` nor `settingSet` had ever listed them —
> so the pane did not show them and the server refused to save them. The number could not be
> set by anybody, from anywhere. Two hand-kept copies of nearly the same array are now one
> `EDITABLE_SETTINGS`, and a test asserts every key the lock screen reads can be written.

---

## Updates

Same arrangement as the HOOPLOAN app: `lock-version.json` at the repo root stamps the APK *and* is
served back at `/api/lock-version`, so the version a phone runs and the version advertised
cannot drift. One difference — the lock app **does not ask**. An officer holding the calls
app should get a prompt; nobody is holding a locked handset in a drawer, and a prompt nobody
answers means that phone stays on an old build for the rest of its loan. As Device Owner the
install happens without anyone tapping anything.

Best effort, and it says so: if a vendor build refuses the silent install, the phone keeps
running what it has and goes on reporting its `app_version`, so the register shows exactly
which handsets are behind instead of leaving anyone to guess.

---

## Stock: transfers, and the one this cannot see

> "in hazijulikani there is some transfers sipho says the imei nos are in possession of
> other owners"

Stock accountability judges a departure by comparing the newest stock report with the one
before it. Three things now happen before a phone is called **HAZIJULIKANI**:

1. **Still on the report under another name → `Zimehamishwa`.** A handover is not a loss. It
   is charged to whoever *had* it, naming whoever *has* it — the direction the question gets
   asked in. Previously this was invisible: the phone was on the report so it was never a
   departure, and the holder who passed it on just had their count drop by one.
2. **Seen on a report newer than the one it left → not missing.** Covers a same-day
   re-upload or a backfilled report.
3. **Held by somebody else at some point → a lead on the row.** The unaccounted list names
   them, with the date. It does **not** clear the phone — an old sighting proves somebody
   handled it once, and letting that empty the column would turn the one number that means
   "go and ask" into a number that means nothing.

**And the one this cannot see.** `hoop_aged_stock` lists only phones *past the age limit*,
and SyscoPos resets a handset's age when it changes hands. So a transferred phone can drop
off the aged report entirely, with no sighting anywhere to find — and from this table that is
indistinguishable from a phone that walked out of the door.

No amount of searching fixes that, because the information is not in the data. The two things
that would:

- **A transfer export from SyscoPos**, uploaded like the aged-stock file. Then transfers
  reclassify themselves and nobody marks anything by hand.
- **Recording the handover when it happens** — a button on the unaccounted IMEI that says who
  took it, audited like every other device action.

Until one of those exists, read HAZIJULIKANI as *"left the aged report and is in neither the
sales book nor Watu"* — which is what the screen says under the tile — and not as a count of
thefts.

---

## Futa, and the phone that has no office

**Futa** takes a phone off the register entirely — an eraser for a row that should not have
existed: a wrong IMEI, a test handset, a batch enrolled twice.

It refuses two cases, and both refusals are the point:

- **A locked phone.** Deleting that row leaves it locked with nothing able to unlock it.
- **A phone still under management.** Lock, unlock and release all travel through the row.
  Delete it while the handset is still provisioned and nothing can reach that phone again —
  and it refuses the factory reset that would fix it. Press **Achia** first, so the handset
  hands itself back, *then* delete.

> This guard was written on the first day the button shipped, because it happened:
> *"I used futa and removed all.. phone is on wifi still can't restore"*. One click, one
> brick. A row that never spoke is still fine to delete — provisioning did not take, so
> there is nothing on the handset to strand.

### And the handset's own way out

A phone that gets **403 — not enrolled** on every beat for **14 days** releases itself:
unlocks, drops the restrictions, steps down as Device Owner, stops calling home.

The owner asked for this outright — *"if it doesn't find it's tocken it's should release
fromm organization ownership"* — and he was right. The old rule treated a 403 as a reason to
carry on unchanged, which is a defensible-sounding sentence that produces an unrecoverable
handset.

Both halves of the rule carry weight:

- **It must happen**, or a lost row is a permanent brick.
- **It must not happen at the first 403**, or one bad deploy hands the whole fleet back to
  whoever is holding it. A migration mid-flight can 403 everything for an hour; nothing
  legitimate 403s for a fortnight.

A hostile network cannot forge it: a 403 only counts arriving over a valid TLS connection to
our own host, and anything else is silence, which never frees a phone. Somebody who can
genuinely serve our origin already owns the server and can simply mark the phone released.

---

## The way back out, over the cable

Everything above needs a handset the office can still reach. This is what to do when it
cannot — the phone is on wifi, the register says *imeachiwa*, and the handset has not spoken
for a day.

**`pm clear` does not work here, and it is worth knowing why before you try it.** Android
protects a Device Owner's data from the shell:

```
C:\Users\marki>adb shell pm clear com.samaritantechs.hooploanlock
SecurityException: PID 2000 does not have permission android.permission.CLEAR_APP_USER_DATA
```

So are the other two obvious routes: `dpm remove-active-admin` answers *"Attempt to remove
non-test admin"*, and `pm uninstall --user 0` answers `DELETE_FAILED_DEVICE_POLICY_MANAGER`.
Factory reset is blocked by our own restriction. Every door out is shut — by design, which is
the point of the lock, and which is exactly the problem when the phone is ours.

**One door is not shut: `adb install -r`.** `setUninstallBlocked` blocks *uninstall*, not
*update*. A newer APK goes on over the top of a locked, owned handset:

```
C:\Users\marki>adb install -r HOOPLOAN-Lock.apk
Performing Streamed Install
Success
```

That is the whole recovery route. The app can clear its own data even though the shell
cannot, and it can call `clearDeviceOwnerApp` on itself even though `dpm` will not. So it
carries a command for doing both:

```
adb install -r HOOPLOAN-Lock.apk
adb shell am broadcast --include-stopped-packages ^
    -a com.samaritantechs.hooploanlock.RELEASE ^
    -n com.samaritantechs.hooploanlock/.ReleaseReceiver ^
    -e token THE_TOKEN_ON_ITS_REGISTER_ROW
```

*(`^` is the line-continuation for the black cmd window. In PowerShell it is a backtick; on
one line it needs neither.)*

**`--include-stopped-packages` is not optional here either.** `adb install -r` leaves the app
in Android's STOPPED state, and a stopped app hears no broadcast at all. Without the flag you
get `Broadcast completed: result=0` and nothing happens — the same success-shaped failure the
enrol has produced three times.

Read the answer, because there are three and they mean different things:

| Answer | What happened | What next |
|---|---|---|
| `result=1 … RELEASED` | Ownership genuinely given up | Ordinary phone. Uninstall or factory reset it if you like |
| `result=3 … PARTIAL` | Unlocked, restrictions dropped, token cleared — but the system refused to give up ownership | **Re-enrol and re-lock it as it is**; a full hand-back needs the other admin cleared |
| `result=2 … TOKEN MISMATCH` | Wrong token; **nothing was changed** | Get the right one from that phone's register row |
| `result=0`, no message | The receiver never ran | You left off `--include-stopped-packages` |

**PARTIAL is not a failure of the recovery** — it is the recovery telling you the truth. The
handset is usable again either way: unlocked, with no token, which is precisely the state
`EnrolReceiver` accepts a fresh token in. On Watu-sourced stock the usual reason is Samsung
**Knox Guard** (`com.samsung.android.kgclient`), a second device admin with
`isOrganizationOwnedDevice=true` that is almost certainly the supplier's, not ours. Check with:

```
adb shell dumpsys device_policy
```

**Why an exported release does not weaken the lock.** The receiver demands that handset's own
token, which only the office holds — a sideloaded app cannot read it out of our private
storage. And reaching adb at all needs USB debugging, which needs Developer options, which
needs Settings, which a pinned lock screen never lets go of. A genuinely locked phone in a
customer's hand cannot be reached this way. This is a bench tool for a handset already in
ours.

### Then relock it, same as any other phone

After a release — by **Achia**, by this command, or by the 14-day self-release — the handset
is back to being an ordinary phone with our app on it and no token. Relocking is the normal
enrol, no factory reset:

1. Devices → **+ Sajili simu** with that IMEI → copy the new token
2. `adb shell dpm set-device-owner com.samaritantechs.hooploanlock/.LockAdmin` — skip this if
   it answers *"already set"*, which is ordinary after a PARTIAL
3. The enrol broadcast with the new token, exactly as at the bench
4. **Funga** in the portal, and wait for *imefungwa* before boxing it

**And after a real RELEASED, the app can be uninstalled** — `adb uninstall
com.samaritantechs.hooploanlock` works, and so does removing it from Settings. That is what
handing a phone back means.

After a **PARTIAL** it still cannot, and the reason is worth being exact about: it is not our
`setUninstallBlocked` — that was dropped along with everything else. Android refuses to
uninstall an app that is *still the active device owner*, whatever that flag says
(`DELETE_FAILED_DEVICE_POLICY_MANAGER`). Clear the other admin and it goes.

A released phone also **never self-locks again**, even in PARTIAL. It keeps beating, so the
office can still see it and can still change its mind — but the offline grace is switched
off on the handset the moment a release is ordered. Otherwise a released phone that spends a
week out of coverage would lock itself for a loan that is already closed.

---

## What this cannot do

Stated plainly, because a security feature oversold is worse than none.

- **It cannot reach a phone that was never provisioned.** A handset that walks out of the
  store before the station touches it is an ordinary phone. This protects stock we have
  processed, and nothing else.
- **A factory reset before provisioning wipes us.** After provisioning, reset is blocked —
  but an unenrolled phone is just a phone.
- **A determined attacker with the bootloader unlocked can flash the phone clean.** Device
  Owner survives ordinary resets, not a full firmware reflash. This raises the cost from
  "hold power and pick Reset" to "have the tools and know how"; it does not make it
  impossible.
- **Emergency calls always work.** Not negotiable, not a bug, and in most places the law.
- **A stolen token lets that one handset lie about its own status.** It cannot read the
  register, reach another IMEI, or change what the office decided — `state` is never writable
  from a phone. That asymmetry is the security model.
- **It cannot give a phone back that a second admin also holds.** Releasing drops *our*
  ownership. On stock that arrived carrying Samsung Knox Guard, that admin stays, and only
  whoever registered it can clear it. See the PARTIAL row above.
- **A released phone is genuinely released.** Once ownership is given up, the app can be
  uninstalled and the phone factory reset — by us, by the customer, by anyone holding it.
  That is the correct end of a cleared loan and not a hole in the lock, but it does mean
  **Achia** is one-way from the handset's point of view: relocking it is a fresh enrol at a
  bench, not a button in the office.
- **The first handset found three bugs the CI could not.** It compiles in CI; that has never
  been the same as tested. Expect a new model of phone to find something.
