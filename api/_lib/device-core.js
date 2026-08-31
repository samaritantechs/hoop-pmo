/* =======================================================================================
   THE PHONE'S END OF THE REGISTRY -- what a locked handset is allowed to say and ask.
   =======================================================================================
     "lets solve by building an app to install in those phones then"
     "and in our hoopcalls system we can get stats of those devices too"

   The registry in portal.js is the OFFICE's half: who is enrolled, what state each phone
   is meant to be in. This is the HANDSET's half, and it exists because those two fields --
   `state` and `reported` -- are worthless until something on the phone actually writes one
   of them. A lock order that nothing ever confirms is a row in a table, not a locked phone.

   WHY THIS IS NOT BEHIND THE PORTAL DOOR. A phone in a customer's hand has no access code
   and never will; asking it to sign in the way a portal user does would mean shipping a
   staff credential inside an APK that we are handing to the very people we may need to
   lock out. So the credential is per-device instead: enrolment mints one random token,
   it goes into that one phone at provisioning, and it authorises exactly one IMEI.

   WHAT A STOLEN TOKEN BUYS AN ATTACKER, stated plainly rather than assumed away: they can
   report false status for their own phone -- claim "unlocked" while locked, or the reverse
   -- and they can flatten its battery reading. They CANNOT read the register, cannot reach
   another IMEI, cannot change what the office decided, and cannot unlock anything: the
   command always flows office -> phone, and `state` is never writable from here. That
   asymmetry is the whole security model, and it is why a phone can never talk itself free.

   THE COMMAND IS DERIVED, NEVER QUEUED. There is no pending-commands table to drift out of
   step with the register; the answer to "what should I be doing" is computed from `state`
   on every beat. A phone that misses a week of heartbeats gets the CURRENT truth the
   moment it comes back, not a stale backlog replayed at it.
   ======================================================================================= */
import { fetchAll } from './supabase.js';

/* A beat is cheap and constant; an event row is not. Writing history on every heartbeat
   would bury the state changes that matter under thousands of "still locked, still 84%"
   rows, so the trail records TRANSITIONS only -- the moment a phone's own story changed. */
// sold_ref and customer are here for one reason: together they answer "has this phone left
// our hands", which is what decides whether silence may ever lock it. See graceFor().
const BEAT_COLS_LEGACY = 'imei, item, state, state_reason, reported, enrol_token, customer, holder, sold_ref';
// fcm_token is read only so the beat can tell whether the handset's address has CHANGED --
// two hundred phones beating every minute would otherwise be two hundred needless writes a
// minute. See byToken for what happens where the migration has not run yet.
const BEAT_COLS = BEAT_COLS_LEGACY + ', fcm_token';

const S = v => String(v == null ? '' : v).trim();

/* What the office's decision means as an instruction to the handset.
     enrolled  on the registry, no lock ordered -- run, stay quiet, keep reporting
     locked    lock now
     released  the loan cleared; this phone has been set free for good
     lost      written off. It stays locked: a phone we have given up on is exactly the
               one that must not quietly come back to life if somebody reinstates it. */
export function commandFor(state) {
  switch (S(state)) {
    case 'locked': return 'lock';
    case 'lost':   return 'lock';
    case 'released':
    case 'enrolled':
    default:       return 'unlock';
  }
}

/* THE FOUR LINES ON A LOCKED PHONE, and why every one of them comes from here.
   =========================================================================================
   The shape was specified by the person who has to answer the calls:

       HOOP LIMITED
       SIMU HII IMEFUNGWA NA HOOP LIMITED. WASILIANA NASI KWA NAMBA 0700000000
       IMEI: 351388334583295
       REASON: STOCK, UNSOLD

   Not one of those four lines is baked into the APK, and that is the whole point. The
   company name changes (this repo has already lived through one rename), the number a
   stranded customer is told to call changes on a Tuesday, and the reason changes per phone.
   A handset in a customer's pocket for eighteen months cannot be waiting on an app release
   for any of them, so the APK holds only the LAYOUT and the server holds every word in it.

   {brand} and {namba} are filled here rather than on the handset for the same reason: one
   substitution, on a machine we can fix, instead of the same little parser in every build
   of the app that is out there. */
const LOCK_SETTINGS = ['DEVICE_LOCK_BRAND', 'DEVICE_LOCK_MESSAGE', 'DEVICE_HELP_PHONE',
  'DEVICE_LOCK_REASON'];

const DEFAULT_BRAND = 'HOOP LIMITED';

function fill(text, brand, phone) {
  return S(text)
    .replace(/\{\s*(brand|kampuni)\s*\}/gi, brand)
    .replace(/\{\s*(namba|phone|simu)\s*\}/gi, phone)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function lockWords(db) {
  const rows = await fetchAll(() => db.from('settings').select('key, value')
    .in('key', LOCK_SETTINGS));
  const get = k => { const r = rows.find(x => S(x.key) === k); return r ? S(r.value) : ''; };
  const brand = get('DEVICE_LOCK_BRAND') || DEFAULT_BRAND;
  const phone = get('DEVICE_HELP_PHONE');
  /* Two defaults, not one, because "Wasiliana nasi kwa namba ." is what a single default
     with an unset number produces -- a sentence promising a number that is not there, on
     the one screen where that is worst. No number, no promise of one. */
  const raw = get('DEVICE_LOCK_MESSAGE')
    || (phone ? 'Simu hii imefungwa na {brand}. Wasiliana nasi kwa namba {namba}.'
              : 'Simu hii imefungwa na {brand}. Wasiliana nasi kumaliza malipo.');
  return {
    brand,
    message: fill(raw, brand, phone),
    helpPhone: phone || null,
    /* The reason a self-lock shows. An ordered lock always carries its own -- the portal
       refuses to send one without -- but a phone that locked itself on the offline grace was
       never given words by anybody, and REASON: (blank) on a customer's screen is worse than
       a dull sentence from settings. */
    fallbackReason: get('DEVICE_LOCK_REASON'),
  };
}

/* HOW LONG A PHONE MAY GO UNHEARD-FROM BEFORE IT LOCKS ITSELF.
   =========================================================================================
   This is the hardest honest call in the whole feature, and it belongs on the server rather
   than in the APK so it can be changed without shipping a build to every handset.

   A phone that cannot reach us cannot be told to lock. Do nothing about that and "keep it in
   airplane mode" defeats the entire system -- which is exactly what somebody who has decided
   not to pay will do. Lock on every missed beat and we strand a paying customer who spent an
   afternoon somewhere with one bar.

   The split that resolves it is whether the phone has left our hands:

     still stock   null -- NEVER self-lock. Boxed phones at the station are offline for weeks
                   by design, and a shelf full of handsets that locked themselves in the dark
                   would be a self-inflicted wound with no upside at all.
     with a customer  a real number, generously set. Counted from the last beat that actually
                   SUCCEEDED, not from the last attempt.

   A self-lock is never this phone judging the customer. It is the handset saying "I have not
   heard from the office in far too long", and the moment it reaches us again the office's
   real answer wins -- including unlocking it straight back. */
/* THE PACE, SET HERE AND NOWHERE ELSE.
   ===========================================================================================
     "app should always ping within every one minute to update state"

   Both numbers live on the server rather than in the APK, which is what makes this a decision
   rather than a release: change them and the whole fleet follows on its next beat, including
   handsets already in customers' pockets. That is deliberate -- the right pace is a business
   judgement about data cost, and it should never need an APK to revisit.

   WHAT A MINUTE COSTS, so the judgement is made with the number rather than around it. A beat
   is roughly 6 KB once the TLS handshake is counted (the connection cannot be kept alive
   across a gap this long). At sixty seconds that is ~260 MB a month per handset, against
   ~17 MB at a quarter of an hour -- and on a sold phone it is the CUSTOMER's bundle paying.
   Asked for explicitly, with that number stated; raise it again if the airtime bills argue
   back.

   AND A MINUTE IS A CEILING, NOT A PROMISE. Android's Doze defers jobs on an idle handset to
   its own maintenance windows, so a phone asleep in a drawer will drift past sixty seconds
   whatever is set here. The thing that genuinely breaks through Doze is a high-priority FCM
   message -- see push.js. Polling is the floor; push is the guarantee. */
const BEAT_SECONDS = 60;
const PENDING_BEAT_SECONDS = 25;

const DEFAULT_GRACE_HOURS = 24 * 7;
async function graceFor(db, dev) {
  if (!S(dev.customer) && !S(dev.sold_ref)) return null;      // still stock: never
  const rows = await fetchAll(() => db.from('settings').select('key, value')
    .in('key', ['DEVICE_OFFLINE_GRACE_HOURS']));
  const raw = rows.length ? Number(S(rows[0].value)) : NaN;
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_GRACE_HOURS;
}

/* THE WINDOW A LOCKED PHONE GETS WHEN IT IS SWITCHED ON AGAIN.
   =========================================================================================
     "if a locked phone is restarted give grace period of 5 minutes so that one can connect
      data or wifi -- dont leave any loophole of unlocking a phone thats already locked and
      awake and got the grace period already"

   A locked handset draws a pinned screen the moment it boots, and that screen is the reason a
   phone can be stuck for good: a customer who has PAID cannot reach Settings to turn wifi on,
   so the handset cannot call home, so it never hears it has been released. The office freed it
   hours ago and the phone will never find out. Until now the only way back was a cable.

   So a reboot buys a few minutes of ordinary use -- long enough to pull the shade down and
   turn the radio on, and no longer.

   THREE FENCES, because a window like this is exactly where a loophole would live.

     1. ONLY EVER AT BOOT. Never from a beat, never from an unlock that failed, never while
        the phone is awake. A locked handset in somebody's hand cannot talk itself into a
        window; the only way to ask for one is to power-cycle, and that is fence 2's problem.
     2. RATE-LIMITED, AND THE CLOCK SURVIVES THE REBOOT THAT WOULD RESET IT. Switching the
        phone off and on again is the first thing anybody tries, and it buys nothing: the
        second boot finds the stamp left by the first and locks immediately. This is the fence
        the ask is really about.
     3. IT ENDS THE INSTANT THE PHONE REACHES US, because at that moment it has served its
        entire purpose -- we can see the handset and it can hear us. If the register still
        says lock, it locks; if the loan was cleared, it unlocks. The window is spent, never
        waited out, so there is nothing to be gained by staying offline through it.

   BOTH NUMBERS LIVE HERE RATHER THAN IN THE APK, like the beat pace and the offline grace
   above: how long a customer needs to find the wifi toggle is a business judgement that must
   never need a release to revisit, and must reach handsets already in pockets. */
const DEFAULT_BOOT_GRACE_MINUTES = 5;
const DEFAULT_BOOT_GRACE_EVERY_HOURS = 24;
async function bootGraceFor(db) {
  const rows = await fetchAll(() => db.from('settings').select('key, value')
    .in('key', ['DEVICE_BOOT_GRACE_MINUTES', 'DEVICE_BOOT_GRACE_EVERY_HOURS']));
  const pick = (key, dflt) => {
    const hit = rows.find(r => S(r.key) === key);
    const raw = hit ? Number(S(hit.value)) : NaN;
    /* ZERO IS A REAL ANSWER and means "no window at all". Turning this off for a fleet is a
       decision the office must be able to make, so it cannot fall through to the default the
       way a blank or a typo does. Negative is a typo and is treated as one. */
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : dflt;
  };
  return {
    minutes: pick('DEVICE_BOOT_GRACE_MINUTES', DEFAULT_BOOT_GRACE_MINUTES),
    everyHours: pick('DEVICE_BOOT_GRACE_EVERY_HOURS', DEFAULT_BOOT_GRACE_EVERY_HOURS),
  };
}

/* THE TOKEN IS THE IDENTITY, and the handset's claim about itself is not.

   An earlier cut of this asked the phone for its IMEI and matched the pair. That put the
   app in the position of having to know which of a dual-SIM phone's TWO IMEIs we wrote
   down, on an API that changed shape three times across the Android versions this stock
   spans -- so the common case, an honest phone reading the wrong slot, looked exactly like
   the attack. Resolving by token instead means the app never has to be right about that:
   the token was minted against one row, so it can only ever answer for that one row.

   Every failure -- no token, unknown token, a row with no token at all -- gives the SAME
   answer, because saying which turns this endpoint into an oracle for probing the fleet. */
async function byToken(db, p) {
  const token = S(p && p.token);
  if (!token) { const e = new Error('Token required'); e.status = 400; throw e; }
  /* PRE-MIGRATION TOLERANCE, and this one is not a nicety. PostgREST refuses the WHOLE select
     for one unknown column, so naming fcm_token here on a deployment that has not run
     RUN-ME-2026-08-28-push.sql would fail every beat from every handset -- the entire fleet
     dark, at the exact moment somebody is deploying. The beat matters more than the address,
     so it falls back to the columns that have always existed and simply forgoes the "only
     write when it changed" saving until the migration lands. */
  let rows;
  try {
    rows = await fetchAll(() => db.from('devices').select(BEAT_COLS).eq('enrol_token', token));
  } catch (e) {
    if (!/fcm_token/.test(String(e && e.message || ''))) throw e;
    rows = await fetchAll(() => db.from('devices').select(BEAT_COLS_LEGACY).eq('enrol_token', token));
  }
  const dev = rows.find(r => S(r.enrol_token) === token) || null;
  if (!dev) { const e = new Error('Not enrolled'); e.status = 403; throw e; }
  return dev;
}

/* ---------------------------------------------------------------------------------------
   THE HEARTBEAT. One call does both directions: the phone says what it is, and is told
   what it should be. Deliberately one round trip -- these run on cellular data in places
   with one bar, and every extra request is another chance to not arrive.
   --------------------------------------------------------------------------------------- */
async function beat(db, [payload], nowMs) {
  const p = payload || {};
  const dev = await byToken(db, p);
  const imei = S(dev.imei);

  const at = new Date(nowMs).toISOString();
  const reported = p.locked === true ? 'locked' : p.locked === false ? 'unlocked' : null;
  const patch = { last_seen: at, updated_at: at };
  if (reported) patch.reported = reported;
  if (S(p.appVersion)) patch.app_version = S(p.appVersion).slice(0, 40);
  if (S(p.android)) patch.android = S(p.android).slice(0, 40);
  /* WHAT THE HANDSET THINKS ITS OWN IMEI IS, kept beside the registry's rather than checked
     against it. A dual-SIM phone HAS two IMEIs and getImei() is not consistent across
     Android versions, so treating a difference as proof the token walked would cry wolf on
     ordinary hardware. Recorded, surfaced on the device's own screen, and left for a person
     to judge -- which is the honest handling of a signal this noisy. */
  if (S(p.imei)) patch.reported_imei = S(p.imei).slice(0, 32);
  /* WHERE TO REACH THIS PHONE QUICKLY. Firebase rotates a registration token whenever it
     likes and a stale one fails silently, so the handset re-reports the current address on
     every beat and this simply keeps the newest. Only written when it CHANGES: two hundred
     phones beating every minute would otherwise be two hundred pointless writes a minute
     against a column nobody read. */
  if (S(p.fcmToken) && S(p.fcmToken) !== S(dev.fcm_token)) {
    patch.fcm_token = S(p.fcmToken).slice(0, 512);
  }
  // A battery reading is only ever 0-100; anything else is a bug on the handset, not a fact.
  const bat = Number(p.battery);
  if (Number.isFinite(bat) && bat >= 0 && bat <= 100) patch.battery = Math.round(bat);
  /* WHERE THE HANDSET WAS WHEN IT LAST SPOKE, with the age of the fix beside it.
     -----------------------------------------------------------------------------------------
       "am asked if the app could trap last sync with location coordinates"

     The phone reports its LAST KNOWN position rather than waking the GPS every minute, so the
     fix can be much older than the beat carrying it. `last_loc_at` is what keeps those two
     facts apart; collapse them and the register starts claiming a phone is somewhere it left
     on Tuesday, which is worse than having no position at all, because somebody drives there.

     Range-checked rather than trusted, and dropped WHOLE when it fails -- half a coordinate
     is a point in the sea. */
  const lat = Number(p.lat), lng = Number(p.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
      && !(lat === 0 && lng === 0)) {        // 0,0 is the Gulf of Guinea, i.e. "no fix"
    patch.last_lat = lat;
    patch.last_lng = lng;
    const acc = Number(p.locAcc);
    patch.last_loc_acc = Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null;
    /* Trust the handset's clock only where it produces a plausible past moment. A fix stamped
       in the future, or at the epoch, tells us the phone's clock is wrong -- not where it is
       -- so the beat's own time stands in and the age shown is honest about what we know. */
    const when = Number(p.locAt);
    patch.last_loc_at = Number.isFinite(when) && when > 946684800000 && when <= nowMs + 86400000
      ? new Date(when).toISOString() : at;
  }

  let { error } = await db.from('devices').update(patch).eq('imei', imei);
  /* Pre-migration: reported_imei, fcm_token or the location columns may not be there yet, and
     PostgREST refuses the whole update for one unknown column. The beat itself matters more
     than any of them -- a phone that cannot report its state is a phone the office has lost,
     while a phone that cannot report its battery, its push address or where it was is merely
     one the office cannot hurry or cannot find. */
  if (error && /reported_imei|fcm_token|last_lat|last_lng|last_loc_acc|last_loc_at/
        .test(String(error.message || ''))) {
    const { reported_imei, fcm_token, last_lat, last_lng, last_loc_acc, last_loc_at,
            ...rest } = patch;
    ({ error } = await db.from('devices').update(rest).eq('imei', imei));
  }
  if (error) throw new Error(error.message);

  // History gets the transition, never the heartbeat -- see the note on BEAT_COLS.
  if (reported && reported !== S(dev.reported)) {
    await db.from('device_events').insert([{
      imei, event: 'heartbeat', from_state: dev.reported || null, to_state: reported,
      reason: 'reported by handset', actor: 'device', at }]);
  }

  const command = commandFor(dev.state);
  /* THE WORDS GO DOWN ON EVERY BEAT, not only when the answer is "lock", and the reason is
     the offline grace. A phone that self-locks in a dead spot draws its screen from whatever
     it last stored -- so if we only ever sent the words alongside a lock order, the one
     handset that locks with nobody around to explain it would be the one showing a blank
     screen. Sending them while it is unlocked costs a few dozen bytes on a beat that was
     already happening. */
  const retire = S(dev.state) === 'released';
  /* WITH ONE EXCEPTION: a phone being handed back for good gets no words at all. It is
     about to unharden, drop Device Owner and stop calling home, and leaving our lock
     message sitting in a former customer's storage is the opposite of releasing it. */
  const words = retire ? { brand: null, message: null, helpPhone: null, fallbackReason: '' }
                       : await lockWords(db);
  const grace = await graceFor(db, dev);
  /* A retiring handset gets no boot window, and needs none: it is about to unharden and stop
     calling home, so there is no lock screen for a window to be a window INTO. Sending one
     would only leave a stale number in a former customer's storage. */
  const boot = retire ? { minutes: 0, everyHours: 0 } : await bootGraceFor(db);
  /* HAS THIS PHONE DONE WHAT IT WAS TOLD? Compare the order against what the handset just
     said it is doing -- `reported` from this very beat when it spoke, the stored value when
     it did not. A phone that has never reported at all counts as unlocked, which is true:
     it is not showing a lock screen. A retiring phone is never "unsettled" -- it is on its
     way out, and hurrying it changes nothing. */
  const nowLocked = S(reported || dev.reported) === 'locked';
  const settled = retire || command === (nowLocked ? 'lock' : 'unlock');
  return {
    ok: true,
    command,                                   // lock | unlock
    state: dev.state,
    /* Ordered locks carry their own reason; a self-lock has none to carry, so it gets the
       one from settings. Either way the handset is never left with an empty REASON line. */
    reason: retire ? null : (S(dev.state_reason) || words.fallbackReason || null),
    // The register's IMEI, not the handset's guess at it -- see Imei.java. This is the
    // number on Sipho's report and the one a caller will read out, and it is the only one
    // an Android 10+ phone can put on its own lock screen at all.
    imei,
    brand: words.brand,
    message: words.message,
    helpPhone: words.helpPhone,
    // -1 rather than null: the handset parses this into an int, and "never" has to survive
    // that trip as a value it can act on rather than as a missing field it has to guess at.
    graceHours: grace == null ? -1 : grace,
    /* THE BOOT WINDOW, in the same shape as graceHours above: plain integers the handset can
       parse and act on rather than fields it has to guess at. Stored on the phone so a
       handset that boots with no network still knows the rule it was last told -- which is
       the whole case this exists for. */
    bootGraceMinutes: boot.minutes,
    bootGraceEveryHours: boot.everyHours,
    // So a released phone can stop calling home for good rather than beating forever.
    retire,
    /* WHEN TO COME BACK -- decided here, because only the server knows whether an order is
       still outstanding.
       =====================================================================================
         "funga and fungua and release should not take even a minute they should all be
          immediate effect whenever online and phone pings"

       A fixed quarter-hour beat is right for a fleet at rest and far too slow the moment
       somebody presses a button. But a phone polling every thirty seconds all day would
       spend a customer's own data bundle on saying "still locked, still locked" -- roughly
       fifteen times what the fifteen-minute beat costs, on a handset the customer pays the
       airtime for.

       So the phone asks how long to wait, and the answer is short ONLY while the register
       and the handset disagree: an order given and not yet carried out. That window is
       seconds long in practice, and it closes the moment the phone confirms. Steady state --
       which is almost always -- stays at a quarter of an hour and costs what it always did.

       WHAT THIS STILL CANNOT DO, said plainly: it cannot wake a sleeping phone. The office
       presses Funga and the handset finds out at its next beat, up to fifteen minutes later;
       everything from that moment on is now seconds. Beating that first wait needs a push
       channel (FCM), which is a genuinely different piece of work. */
    nextBeatSeconds: settled ? BEAT_SECONDS : PENDING_BEAT_SECONDS,
  };
}

/* ---------------------------------------------------------------------------------------
   PROVISIONING. The freshly-flashed phone's first words: "here is the token that was put
   in me -- who am I?" It carries no status yet, so it is not a beat; it is the handshake
   that tells the station the token reached the handset before the box is closed again.
   --------------------------------------------------------------------------------------- */
async function hello(db, [payload], nowMs) {
  const p = payload || {};
  const dev = await byToken(db, p);
  const at = new Date(nowMs).toISOString();
  await db.from('devices').update({ last_seen: at, updated_at: at }).eq('imei', dev.imei);
  const words = await lockWords(db);
  return { ok: true, imei: dev.imei, item: dev.item || null, state: dev.state,
    command: commandFor(dev.state), reason: S(dev.state_reason) || words.fallbackReason || null,
    brand: words.brand, message: words.message, helpPhone: words.helpPhone };
}

/* ---------------------------------------------------------------------------------------
   THE CLAIM: a phone asks which of the batch it is, instead of being told.

     "and thats my intention of pasting multiple imei and copyng signle cmd to run and get
      many phones registered at once"

   The enrol command used to carry a token minted for ONE IMEI, so the person at the bench was
   the thing pairing handset to identity -- one cable, one phone, one line. Looping that across
   a hub is the dangerous shape: plug-in ORDER would decide who got what, and nothing catches a
   swap, because beat() resolves a handset BY ITS TOKEN and files what it says under the row
   that token belongs to. A phone handed its neighbour's token simply becomes its neighbour.

   So the command now carries a BATCH token -- the same string for every handset, which is what
   makes it safe to broadcast to all of them at once -- and the phone sends back the IMEI it
   reads off itself to collect the token minted for it.

   THE IMEI IS A SELECTOR HERE, NEVER A CREDENTIAL, and that distinction is the whole reason
   this is allowed when device-core's own rule says the handset's claim about itself is not its
   identity. It cannot be used to obtain a token on its own: it only picks between the handful
   of rows the office deliberately put in one batch, minutes earlier, and every other outcome is
   a refusal. Getting it wrong loses you a phone from the batch; it can never win you another
   phone's identity.

   BOTH SLOTS, because a dual-SIM handset has two IMEIs and which one Sipho's stock report wrote
   down is a coin toss (see Imei.java, which has said so all along). Matching on either closes
   that gap; matching on neither means this handset is simply not in this batch.

   IT FAILS CLOSED. No batch, an expired batch, an unreadable IMEI, an IMEI that is not in the
   batch, a row with no token -- every one of them is the same refusal, and the handset stays
   un-enrolled and visibly missing from the register rather than quietly becoming somebody else.
   The refusals are deliberately identical: distinguishing them would turn this into an oracle
   for asking the office which IMEIs it is holding. */
const BATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function claim(db, [payload], nowMs) {
  const p = payload || {};
  const batch = S(p && p.batch);
  const refuse = () => { const e = new Error('Not in this batch'); e.status = 403; throw e; };
  if (!batch) { const e = new Error('Batch required'); e.status = 400; throw e; }

  /* Whatever the handset managed to read. One entry on a single-SIM phone, two on a dual, and
     none at all on a build that refuses -- which is a refusal here, not a guess. */
  const said = (Array.isArray(p.imeis) ? p.imeis : [p.imei])
    .map(S).map(x => x.trim()).filter(Boolean);
  if (!said.length) refuse();

  let rows = [];
  try {
    rows = await fetchAll(() => db.from('devices')
      .select('imei, enrol_token, enrol_batch_at').eq('enrol_batch', batch));
  } catch (e) {
    // Before RUN-ME-2026-08-31-enrol-batch.sql there is no such column, so there is no batch
    // to be in. Same refusal: this endpoint never explains itself to a handset.
    if (/enrol_batch_at/i.test(String(e && e.message || ''))) refuse();
    throw e;
  }
  if (!rows.length) refuse();

  /* The batch is a bearer secret for the length of a bench session. Whoever holds it, plus an
     IMEI that is in it, can obtain that device's token -- exactly the power the bench needs and
     exactly the power nobody should still hold next week. */
  const issued = rows.map(r => Date.parse(r.enrol_batch_at || '')).filter(t => !isNaN(t));
  if (!issued.length || nowMs - Math.max(...issued) > BATCH_MAX_AGE_MS) refuse();

  const dev = rows.find(r => said.includes(S(r.imei).trim()));
  if (!dev || !S(dev.enrol_token)) refuse();
  return { ok: true, token: S(dev.enrol_token) };
}

const FNS = { dev_hello: hello, dev_beat: beat, dev_claim: claim };

/** Same transport shape as callApi: one route, a named fn, positional args. */
export async function deviceApi(db, fn, args, nowMs = Date.now()) {
  /* OWN PROPERTIES ONLY. FNS is an object literal, so `FNS['constructor']` and friends are
     truthy and would be CALLED with (db, args, nowMs) -- past every guard each real handler
     begins with. The same hole was found and closed on the portal's dispatcher; this door is
     the one that is not behind an access code at all, so it matters more here. */
  const f = Object.prototype.hasOwnProperty.call(FNS, S(fn)) ? FNS[S(fn)] : null;
  if (typeof f !== 'function') { const e = new Error('Unknown function: ' + S(fn)); e.status = 400; throw e; }
  return f(db, Array.isArray(args) ? args : [args], nowMs);
}
