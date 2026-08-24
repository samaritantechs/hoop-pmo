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
const BEAT_COLS = 'imei, item, state, state_reason, reported, enrol_token, customer, holder';

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

/** The lock screen's words, held in settings so they can be changed without a new APK --
    the number a stranded customer is told to call is exactly the kind of thing that
    changes on a Tuesday and must not wait for an app release to do it. */
async function lockMessage(db) {
  const rows = await fetchAll(() => db.from('settings').select('key, value')
    .in('key', ['DEVICE_LOCK_MESSAGE', 'DEVICE_HELP_PHONE']));
  const get = k => { const r = rows.find(x => S(x.key) === k); return r ? S(r.value) : ''; };
  return {
    message: get('DEVICE_LOCK_MESSAGE')
      || 'Simu hii imefungwa na HOOPLOAN. Wasiliana nasi kumaliza malipo. / This phone is locked by HOOPLOAN. Contact us to clear your balance.',
    helpPhone: get('DEVICE_HELP_PHONE') || null,
  };
}

/* ---------------------------------------------------------------------------------------
   THE HEARTBEAT. One call does both directions: the phone says what it is, and is told
   what it should be. Deliberately one round trip -- these run on cellular data in places
   with one bar, and every extra request is another chance to not arrive.
   --------------------------------------------------------------------------------------- */
async function beat(db, [payload], nowMs) {
  const p = payload || {};
  const imei = S(p.imei);
  const token = S(p.token);
  if (!imei || !token) { const e = new Error('IMEI and token required'); e.status = 400; throw e; }

  const rows = await fetchAll(() => db.from('devices').select(BEAT_COLS).eq('imei', imei));
  const dev = rows[0] || null;

  /* ONE ANSWER FOR "NOT ENROLLED" AND "WRONG TOKEN", on purpose. Telling an unknown caller
     which of the two it was turns this endpoint into an oracle for guessing valid IMEIs. */
  if (!dev || !S(dev.enrol_token) || S(dev.enrol_token) !== token) {
    const e = new Error('Not enrolled'); e.status = 403; throw e;
  }

  const at = new Date(nowMs).toISOString();
  const reported = p.locked === true ? 'locked' : p.locked === false ? 'unlocked' : null;
  const patch = { last_seen: at, updated_at: at };
  if (reported) patch.reported = reported;
  if (S(p.appVersion)) patch.app_version = S(p.appVersion).slice(0, 40);
  if (S(p.android)) patch.android = S(p.android).slice(0, 40);
  // A battery reading is only ever 0-100; anything else is a bug on the handset, not a fact.
  const bat = Number(p.battery);
  if (Number.isFinite(bat) && bat >= 0 && bat <= 100) patch.battery = Math.round(bat);

  const { error } = await db.from('devices').update(patch).eq('imei', imei);
  if (error) throw new Error(error.message);

  // History gets the transition, never the heartbeat -- see the note on BEAT_COLS.
  if (reported && reported !== S(dev.reported)) {
    await db.from('device_events').insert([{
      imei, event: 'heartbeat', from_state: dev.reported || null, to_state: reported,
      reason: 'reported by handset', actor: 'device', at }]);
  }

  const command = commandFor(dev.state);
  const words = command === 'lock' ? await lockMessage(db) : { message: null, helpPhone: null };
  return {
    ok: true,
    command,                                   // lock | unlock
    state: dev.state,
    reason: command === 'lock' ? (dev.state_reason || null) : null,
    ...words,
    // So a released phone can stop calling home for good rather than beating forever.
    retire: S(dev.state) === 'released',
  };
}

/* ---------------------------------------------------------------------------------------
   PROVISIONING. The freshly-flashed phone's first words: "here is my IMEI and the token
   that was put in me -- who am I?" It carries no status yet, so it is not a beat; it is
   the handshake that proves the token reached the right handset before the box is closed.
   --------------------------------------------------------------------------------------- */
async function hello(db, [payload], nowMs) {
  const p = payload || {};
  const imei = S(p.imei), token = S(p.token);
  if (!imei || !token) { const e = new Error('IMEI and token required'); e.status = 400; throw e; }
  const rows = await fetchAll(() => db.from('devices').select(BEAT_COLS).eq('imei', imei));
  const dev = rows[0] || null;
  if (!dev || !S(dev.enrol_token) || S(dev.enrol_token) !== token) {
    const e = new Error('Not enrolled'); e.status = 403; throw e;
  }
  const at = new Date(nowMs).toISOString();
  await db.from('devices').update({ last_seen: at, updated_at: at }).eq('imei', imei);
  return { ok: true, imei, item: dev.item || null, state: dev.state,
    command: commandFor(dev.state), ...(await lockMessage(db)) };
}

const FNS = { dev_hello: hello, dev_beat: beat };

/** Same transport shape as callApi: one route, a named fn, positional args. */
export async function deviceApi(db, fn, args, nowMs = Date.now()) {
  const f = FNS[S(fn)];
  if (!f) { const e = new Error('Unknown function: ' + S(fn)); e.status = 400; throw e; }
  return f(db, Array.isArray(args) ? args : [args], nowMs);
}
