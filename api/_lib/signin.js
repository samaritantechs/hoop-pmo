import { createHash } from 'node:crypto';
import { todayKey } from './time.js';

/* =========================================================================================
   THE DOOR'S OWN LOG.

     IT SOP D  "Monitoring: monitor for unauthorized access and act immediately on any breach,
                including changing the affected password."

   THE SENTENCE THIS SYSTEM COULD NOT ANSWER. audit_log covers what somebody did once they
   were inside, and audited() runs AFTER the door -- so a REFUSED sign-in threw before it and
   left no trace anywhere. Somebody could sit and guess access codes all night and the system's
   record of that night would be empty. Until this file, "we monitor for unauthorized access"
   was not a true sentence about this deployment.

   THREE RULES, and the first is the one that matters.

   1. NOTHING WRITTEN HERE IS A WORKING CREDENTIAL. A security log holding the keys is a bigger
      hole than the one it was dug to watch -- and this one is read behind a nav that will be
      ticked for more than one person. So the code is stored twice, in two useless-alone forms:
        code_key     truncated SHA-256, which GROUPS a hundred attempts at one wrong code into
                     one line, and cannot be typed into the sign-in box
        code_masked  first character and length -- "K•••••" -- which is what a person needs to
                     recognise their own typo, and nothing to anybody else
      The code itself is never written, on a failure or a success.

   2. IT CAN NEVER BREAK A SIGN-IN. Every failure here is swallowed, including the table not
      existing at all, which is every deployment's state until somebody runs the migration.
      A door that could be closed by its own logging is worse than an unwatched door.

      It IS awaited, for the reason audit.js explains: on Vercel a function can be frozen the
      moment it returns, so an insert nobody waited for may never leave the process -- and the
      writes most likely to be lost are the ones on the slowest requests, which are not a
      random sample. Swallowing every error is what makes the await safe.

   3. SUCCESSES ARE KEPT ONCE A DAY, NOT ONCE A REQUEST. Every portal call passes this door, so
      a row per call would be tens of thousands a day and would bury the twelve that matter.
      One row per code per door per EAT day answers "who used the system on Tuesday", which is
      the shape of the actual question, for a rounding error of the writes.
   ========================================================================================= */

/** Which door. The portal and the upload page take an access code; the phone app takes a
    phone number with either an access code or the shared team code. */
export const SIGNIN_DOORS = ['portal', 'upload', 'app'];

/* WHY it was refused -- set at the throw, never guessed from the wording of a message. A
   regex over a bilingual sentence is a classification that breaks the day somebody improves
   the English half of it. */
export const SIGNIN_OUTCOMES = ['ok', 'invalid', 'suspended', 'closed', 'switched_off',
  'unknown_phone', 'view_only', 'refused'];

/* The failures a person should look at, as opposed to the ones that are the system working:
   `closed` is the admin's own switch turning everybody away and says nothing about anybody. */
export const SIGNIN_ALARMING = ['invalid', 'suspended', 'switched_off', 'unknown_phone', 'view_only'];

/** A stable, non-reversible handle for one secret, for GROUPING attempts. Sixteen hex
    characters: long enough that two different codes will not collide in any register this
    company will ever have, short enough to read across a table. */
export function codeKeyOf(secret) {
  const s = String(secret == null ? '' : secret).trim();
  if (!s) return null;
  /* Upper-cased first, because the door itself matches case-insensitively (see
     caseInsensitiveCode in auth.js) -- "k4m9" and "K4M9" are one code being tried twice, and
     a log that split them into two lines would hide exactly the pattern this exists to show. */
  return createHash('sha256').update(s.toUpperCase()).digest('hex').slice(0, 16);
}

/** The first character and the length. Enough for somebody to recognise their own typo;
    nothing to anybody else. An empty string masks to null rather than to a lie. */
export function maskSecret(secret) {
  const s = String(secret == null ? '' : secret).trim();
  if (!s) return null;
  if (s.length === 1) return '•';
  return s.slice(0, 1) + '•'.repeat(Math.min(11, s.length - 1));
}

/** A phone number keeps its LAST three digits rather than its first: the leading digits of a
    Tanzanian number are the network and are the same for millions of people, so masking from
    the front hides nothing and masking from the back hides the only part that identifies. */
export function maskPhone(phone) {
  const d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (!d) return null;
  if (d.length <= 3) return '•'.repeat(d.length);
  return '•'.repeat(Math.min(9, d.length - 3)) + d.slice(-3);
}

/** WHY the door said no, from the throw rather than from its wording. SystemClosedError is
    the admin's own switch and carries its own flag; AuthError carries `reason`; anything else
    is 'refused', which is honest about not knowing. */
export function outcomeOf(err) {
  if (err && err.systemClosed) return 'closed';
  const r = err && err.reason;
  return (r && r !== 'ok' && SIGNIN_OUTCOMES.includes(r)) ? r : 'refused';
}

const short = (v, n) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n || 240) : null;
};

/** The caller's address, as far as it can be known behind a proxy. Vercel sets
    x-forwarded-for; the left-most entry is the client and everything after it is a hop. */
export function ipOf(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h['x-forwarded-for'] || h['X-Forwarded-For'] || '').split(',')[0].trim();
  return short(fwd || (req && req.socket && req.socket.remoteAddress) || '', 60);
}
export function uaOf(req) {
  const h = (req && req.headers) || {};
  return short(h['user-agent'] || h['User-Agent'] || '', 200);
}

/* SEEN ALREADY TODAY, in this process. The unique index is what actually makes a success
   once-a-day; this only saves the trip. Keyed by day so it empties itself, and cleared whole
   when the day turns rather than pruned entry by entry. */
let seenDay = '';
let seen = new Set();

/** Tests only: forget what this process thinks it has already written today. */
export function _resetSeen() { seenDay = ''; seen = new Set(); }

/**
 * Record one thing that happened at a door. RESOLVES ALWAYS and throws NOTHING, ever --
 * see rule 2 in the header. Returns what it wrote, or null when it wrote nothing (a repeat
 * success this process has already recorded today, or a failure of the write itself).
 *
 *   db       the supabase client
 *   door     'portal' | 'upload' | 'app'
 *   ok       did they get in
 *   outcome  one of SIGNIN_OUTCOMES; ignored when ok
 *   code     the secret that was tried -- HASHED AND MASKED HERE, never stored
 *   phone    the app door's identity
 *   who      { name, role } when the code resolved to a real person
 */
export async function noteSignin(db, opts = {}) {
  try {
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const day = todayKey(nowMs);
    const door = SIGNIN_DOORS.includes(opts.door) ? opts.door : 'portal';
    const ok = opts.ok === true;
    const codeKey = codeKeyOf(opts.code) || (opts.phone ? codeKeyOf('phone:' + String(opts.phone).replace(/\D/g, '')) : null);
    let mark = null;
    if (ok) {
      if (seenDay !== day) { seenDay = day; seen = new Set(); }
      mark = day + '|' + door + '|' + (codeKey || '~none~');
      if (seen.has(mark)) return null;
    }
    const row = {
      at: new Date(nowMs).toISOString(),
      day, door, ok,
      outcome: ok ? 'ok' : (SIGNIN_OUTCOMES.includes(opts.outcome) ? opts.outcome : 'refused'),
      code_key: codeKey,
      code_masked: maskSecret(opts.code),
      phone_masked: maskPhone(opts.phone),
      device: short(opts.device, 80),
      who_name: short(opts.who && opts.who.name, 120),
      who_role: short(opts.who && opts.who.role, 60),
      detail: short(opts.detail, 240),
      ip: short(opts.ip, 60),
      ua: short(opts.ua, 200),
    };
    /* A SUCCESS UPSERTS AND SHRUGS AT THE DUPLICATE. The several serverless instances serving
       one morning each hold their own `seen`, so without this the "once a day" row would be
       written once per warm instance. The unique index is partial (`where ok`), which is why
       the failures below go through a plain insert -- every one of them is worth its own row. */
    const q = ok
      ? db.from('signin_attempts').upsert([row], { onConflict: 'day,door,code_key', ignoreDuplicates: true })
      : db.from('signin_attempts').insert([row]);
    /* PostgREST reports a refusal by RESOLVING with an error rather than by throwing, so a
       plain await would have called an un-migrated database a successful write. Nothing here
       may reject either way -- the sign-in this accompanies still stands. */
    const res = (q && typeof q.then === 'function') ? await q.then(r => r, () => null) : null;
    if (!res || res.error) return null;
    /* MARKED SEEN ONLY ONCE IT IS ACTUALLY DOWN. Marking before the write would mean that a
       morning spent before somebody ran the migration silently costs the whole day: the write
       starts working at eleven and this process still believes it has already recorded
       everybody. */
    if (mark) seen.add(mark);
    return row;
  } catch (e) {
    /* No table, no permission, no network. The sign-in this accompanied still stands, which is
       the entire point of swallowing it. */
    return null;
  }
}
