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
const BEAT_COLS = 'imei, item, state, state_reason, reported, enrol_token, customer, holder, sold_ref';

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
const DEFAULT_GRACE_HOURS = 24 * 7;
async function graceFor(db, dev) {
  if (!S(dev.customer) && !S(dev.sold_ref)) return null;      // still stock: never
  const rows = await fetchAll(() => db.from('settings').select('key, value')
    .in('key', ['DEVICE_OFFLINE_GRACE_HOURS']));
  const raw = rows.length ? Number(S(rows[0].value)) : NaN;
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_GRACE_HOURS;
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
  const rows = await fetchAll(() => db.from('devices').select(BEAT_COLS).eq('enrol_token', token));
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
  // A battery reading is only ever 0-100; anything else is a bug on the handset, not a fact.
  const bat = Number(p.battery);
  if (Number.isFinite(bat) && bat >= 0 && bat <= 100) patch.battery = Math.round(bat);

  let { error } = await db.from('devices').update(patch).eq('imei', imei);
  // Pre-migration: reported_imei may not be there yet. The beat itself still matters more.
  if (error && /reported_imei/.test(String(error.message || ''))) {
    const { reported_imei, ...rest } = patch;
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
    // So a released phone can stop calling home for good rather than beating forever.
    retire,
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

const FNS = { dev_hello: hello, dev_beat: beat };

/** Same transport shape as callApi: one route, a named fn, positional args. */
export async function deviceApi(db, fn, args, nowMs = Date.now()) {
  const f = FNS[S(fn)];
  if (!f) { const e = new Error('Unknown function: ' + S(fn)); e.status = 400; throw e; }
  return f(db, Array.isArray(args) ? args : [args], nowMs);
}
