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
adb shell dpm set-device-owner com.samaritantechs.hooploanlock/.LockAdmin
adb shell am broadcast -a com.samaritantechs.hooploanlock.ENROL \
    -n com.samaritantechs.hooploanlock/.EnrolReceiver \
    -e server https://hoop-pmo.vercel.app \
    -e token <that phone's token>
```

Install the APK first (`adb install public/HOOPLOAN-Lock.apk`, or download it on the phone
from `/HOOPLOAN-Lock.apk`).

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

## Settings

| Key | Default | What it does |
|---|---|---|
| `DEVICE_LOCK_MESSAGE` | Swahili/English default | the words on the lock screen |
| `DEVICE_HELP_PHONE` | — | the number shown to call |
| `DEVICE_OFFLINE_GRACE_HOURS` | `168` | silence before a customer's phone self-locks |

These live in settings rather than in the APK because the number a stranded customer is told
to call is exactly the kind of thing that changes on a Tuesday.

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
- **None of this has been run on a real handset yet.** It compiles in CI; that is not the
  same as tested. The first phone through the station is the real test, and the honest
  expectation is that something will need fixing.
