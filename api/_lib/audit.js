import { fetchAll, runQuery } from './supabase.js';

/* =======================================================================================
   WHO DID WHAT.

     "Add an audit log nav and start with access for admin only, I may tyick it to be seen on
      others via settings as usual so that we know who did what"

   Every change to this system goes through ONE door -- portalApi dispatches every function the
   portal can call -- so this is written in exactly one place. A log that has to be remembered
   at each of a hundred call sites is a log with holes in it, and a log with holes is worse than
   none: it invites the conclusion that what is missing did not happen.

   THREE RULES, and each of them is about what NOT to record.

   1. ONLY THE CALLS THAT CHANGE SOMETHING. Two hundred officers opening a dashboard every few
      minutes would bury the twelve writes a day that matter. This table exists to be read by a
      person.

   2. NEVER THE PAYLOAD. An audit log is read by whoever is allowed to see the log, so one that
      carried its arguments in full would be a second, unguarded copy of the customer book --
      amounts, phone numbers, the text of comments -- readable by anyone the switch is ever
      ticked for. Only the few identifying fields survive. "JUMA G saved a follow-up on customer
      4471" is what a supervisor needs; the comment itself is in followup_comments, where team
      scoping applies.

   3. IT CAN NEVER BREAK A SAVE. The write is fire-and-forget and every failure is swallowed --
      including the table not existing at all, which is every deployment's state until somebody
      runs the migration. An audit log that could fail a save would turn every write in the
      system into two things that must both succeed, which is a worse system than one with no
      audit log.

   FAILED ATTEMPTS ARE WORTH MORE THAN SUCCESSFUL ONES. Somebody trying to delete a team they
   may not touch is precisely what this exists to show, so a throw is logged and then re-thrown.
   ======================================================================================= */

/** Functions that CHANGE something. Everything else is a read and is not logged.
    Kept as an explicit list rather than a name-pattern: a rule like "starts with save" quietly
    stops covering the next function somebody names differently, and the failure is invisible. */
export const AUDITED = new Set([
  // teams & staff
  'saveTeam', 'deleteTeam', 'saveStaffTeams', 'saveRole', 'deleteRole',
  'saveAccessCode', 'deleteAccessCode', 'changeMyCode',
  'saveCallAgent', 'removeCallUser', 'saveOfficerAccount', 'deleteOfficerAccount',
  // settings & the system switch
  'settingSet', 'settingDelete', 'systemOpenSet', 'commissionSave', 'announceSave',
  'fuStatusesSave',
  // the customer registers
  'addComment', 'addComplaint', 'saveComplaint', 'resolveComplaint', 'deleteComplaint',
  'addRestructure', 'decideRestructure', 'addDemandNotice',
  // destructive maintenance
  'purgeSnapshots', 'purgeSuperseded', 'followupClean',
]);

/** The ONLY argument fields that ever reach the table. Anything not named here is dropped --
    which is the point, and is why this is a list of what is kept rather than a list of what is
    stripped. A new argument nobody thought about is excluded by default. */
const KEEP = ['ref', 'team', 'key', 'code', 'role', 'name', 'stage', 'date', 'weekday'];

/** One short line describing WHICH thing was acted on, or null. Never an amount, never a phone
    number, never free text. Capped hard, because a caller can put anything in a field. */
export function subjectOf(args) {
  if (!args || typeof args !== 'object') return null;
  const bits = [];
  for (const k of KEEP) {
    const v = args[k];
    if (v == null || v === '' || typeof v === 'object') continue;
    bits.push(k + '=' + String(v).slice(0, 60));
  }
  return bits.length ? bits.join(' ').slice(0, 240) : null;
}

const short = v => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, 240) || null);

/** Fire and forget. Returns nothing and throws nothing, ever. */
export function auditWrite(db, row) {
  try {
    const p = db.from('audit_log').insert([row]);
    // Some callers hand back a thenable, some a promise; either way nothing waits on it and
    // nothing may escape from it.
    if (p && typeof p.then === 'function') p.then(() => {}, () => {});
  } catch (e) { /* no table, no permission, no network -- the save it accompanied still stands */ }
}

/** Wraps one dispatched call. The handler's own result and its own errors pass straight
    through; this only watches. */
export async function audited(db, user, fn, args, run) {
  if (!AUDITED.has(fn)) return run();
  const started = Date.now();
  const base = {
    actor_code: short(user && user.code),
    actor_name: short(user && user.name),
    actor_role: short(user && user.role),
    action: fn,
    ref: short(args && args.ref),
    team: short(args && args.team),
    subject: subjectOf(args),
  };
  try {
    const out = await run();
    auditWrite(db, { ...base, ok: true, error: null, ms: Date.now() - started });
    return out;
  } catch (e) {
    auditWrite(db, { ...base, ok: false, error: short(e && e.message) || 'failed', ms: Date.now() - started });
    throw e;
  }
}

/** The tab. Newest first, one page at a time -- a log is read from the top and the whole of it
    is never the question. */
export async function auditList(db, { limit = 200, actor = null, action = null, from = null, to = null } = {}) {
  const n = Math.max(1, Math.min(1000, parseInt(limit, 10) || 200));
  let rows = [];
  let available = true;
  try {
    rows = await fetchAll(() => {
      let q = db.from('audit_log')
        .select('at, actor_code, actor_name, actor_role, action, ref, team, subject, ok, error, ms')
        .order('at', { ascending: false }).limit(n);
      if (actor) q = q.eq('actor_code', actor);
      if (action) q = q.eq('action', action);
      if (from) q = q.gte('at', from);
      if (to) q = q.lte('at', to + 'T23:59:59.999Z');
      return q;
    });
  } catch (e) {
    available = false;                 // the migration has not been run yet
  }
  rows = rows.slice(0, n);
  return {
    rows,
    count: rows.length,
    available,
    /* Told plainly rather than shown as an empty table, which reads as "nobody has done
       anything" -- the one conclusion an audit log must never invite by accident. */
    note: available ? null
      : 'Kumbukumbu bado haijaanzishwa — endesha db/migrations/2026-08-09c-audit-log.sql. '
        + '/ The audit table does not exist yet — run db/migrations/2026-08-09c-audit-log.sql.',
    actors: [...new Set(rows.map(r => r.actor_name).filter(Boolean))].sort(),
    actions: [...new Set(rows.map(r => r.action).filter(Boolean))].sort(),
  };
}
