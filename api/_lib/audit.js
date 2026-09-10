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

   3. IT CAN NEVER BREAK A SAVE. Every failure is swallowed -- including the table not existing
      at all, which is every deployment's state until somebody runs the migration. An audit log
      that could fail a save would turn every write in the system into two things that must both
      succeed, which is a worse system than one with no audit log.

      It IS waited for, though, which is not the same thing. It was fire-and-forget until an
      audit of the salary-advance panes pointed out what that means on Vercel: a serverless
      function can be frozen the moment it returns its response, so an insert nobody waited for
      may never leave the process -- and the entries most likely to be lost are the ones on the
      slowest requests, which are not a random sample. Swallowing every error is what makes
      waiting safe; see auditWrite.

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
  /* Suspending somebody stops them signing in AND takes them out of the credit round, so the
     customers they would have been dealt go to other people. That is a change to who may work
     and to who is carrying whose book, which is exactly what this log exists for. `code` is in
     KEEP below, so the entry names whose window was set; the dates themselves are not kept and
     need not be -- the row in access_codes is always the current answer. */
  'accessCodeSuspend',
  'saveCallAgent', 'removeCallUser', 'saveOfficerAccount', 'deleteOfficerAccount',
  // settings & the system switch
  'settingSet', 'settingDelete', 'systemOpenSet', 'commissionSave', 'announceSave',
  'fuStatusesSave',
  // the customer registers
  'addComment', 'addComplaint', 'saveComplaint', 'resolveComplaint', 'deleteComplaint',
  'addRestructure', 'decideRestructure', 'addDemandNotice',
  // destructive maintenance
  'purgeSnapshots', 'purgeSuperseded', 'followupClean',
  /* SALARY ADVANCE -- money, so both ends of it are logged. advRequest records that somebody
     asked; advDecide records who granted or refused it. Neither the amount nor the bank
     details reach this table: KEEP below drops everything it is not told to keep, and an
     audit log readable by whoever holds the switch must never become a second copy of the
     payroll. Who decided on which request is what a supervisor needs; the figures live in
     staff_advances, behind the advrep nav. */
  'advRequest', 'advDecide',
]);

/** The ONLY argument fields that ever reach the table. Anything not named here is dropped --
    which is the point, and is why this is a list of what is kept rather than a list of what is
    stripped. A new argument nobody thought about is excluded by default. */
/* `id` earns its place the hard way: without it, the two salary-advance entries recorded WHO
   and WHAT but not WHICH. "NEEMA M — advDecide — 14:03" with a null subject cannot be tied to
   a payment, which is precisely the question an audit log about money exists to answer. It is
   a row identifier and never a payload, so it carries nothing the log should not hold. */
const KEEP = ['ref', 'team', 'key', 'code', 'role', 'name', 'stage', 'date', 'weekday', 'id'];

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
  /* THE ONE PAYLOAD VALUE KEPT: where an email setting was pointed. Whoever holds Settings can
     redirect the CEO's copy of every approved imprest, and a line reading only "IMPREST_CEO_EMAIL
     changed" cannot answer "to where". An address is not payroll, so it is kept for those keys
     and those keys alone. */
  if (/EMAIL/.test(String(args.key || '')) && typeof args.value === 'string' && args.value.trim()) {
    bits.push('value=' + args.value.trim().slice(0, 80));
  }
  return bits.length ? bits.join(' ').slice(0, 240) : null;
}

/* =======================================================================================
   WHAT THE VALUE WAS BEFORE, AND WHAT IT IS NOW.

     "who did what what, when, where, value b4 and after"

   THE DIFF IS DECLARED, NEVER DISCOVERED. Each entry names the table a call changes, how to
   find the row it changes, and WHICH FIELDS may be recorded. Everything else about that row
   is invisible to this log -- which is rule 2 kept rather than abandoned: a field nobody
   listed is not written, so adding one is a deliberate line of code rather than an accident
   of a handler gaining a column.

   That is why this is a list of tables and not a `select *`. Storing the whole row would turn
   audit_log into a second, unguarded copy of whatever it watched -- the payroll, the customer
   book -- readable by everyone the audit nav is ever ticked for.

   ONLY THE FIELDS THAT MOVED are kept. A save that rewrote nothing writes no diff at all,
   which is the honest answer: somebody pressed Save and the row is as it was.

   AND ONLY WHERE A ROW CAN BE NAMED. A bulk call that touches four hundred handsets has no
   single before and after; those entries still record who, what, when and where, and the
   count they changed is in the handler's own answer. A diff that quietly described one of
   four hundred rows would be worse than none. */
const AUDIT_DIFF = {
  /* Settings are configuration, not payload, and "who pointed the CEO's imprest mail
     somewhere else, and where was it before" is the single most useful line this log holds. */
  settingSet:      { table: 'settings', key: a => ({ key: a.key }), fields: ['value'] },
  settingDelete:   { table: 'settings', key: a => ({ key: a.key }), fields: ['value'] },

  /* PERMISSIONS. What a role or a code may reach is the thing an audit is opened for after
     somebody saw a pane they should not have. */
  saveRole:        { table: 'roles', key: a => ({ role: K_(a.role) }), fields: ['tabs'] },
  deleteRole:      { table: 'roles', key: a => ({ role: K_(a.role) }), fields: ['tabs'] },
  saveAccessCode:  { table: 'access_codes', key: a => ({ code: a.code }),
                     fields: ['name', 'role', 'teams', 'tabs', 'active'] },
  deleteAccessCode:{ table: 'access_codes', key: a => ({ code: a.code }),
                     fields: ['name', 'role', 'teams', 'tabs', 'active'] },
  renameAccessCode:{ table: 'access_codes', key: a => ({ code: a.code }), fields: ['name'] },
  accessCodeSuspend:{ table: 'access_codes', key: a => ({ code: a.code }),
                     fields: ['suspend_from', 'suspend_to'] },
  officerActive:   { table: 'access_codes', key: a => ({ code: a.code }), fields: ['active'] },

  /* WHO WORKS HERE, and under whom. staffActive shuts a login; staffManager moves somebody
     onto a different RSM, which moves every target and every commission that hangs off it. */
  staffActive:     { table: 'hoop_agents', key: a => ({ phone: a.phone }), fields: ['active'] },
  staffManager:    { table: 'hoop_agents', key: a => ({ phone: a.phone }), fields: ['manager'] },
  staffChannelSave:{ table: 'hoop_agents', key: a => ({ phone: a.phone }),
                     fields: ['role', 'manager', 'branch'] },

  /* MONEY, AND ONLY ITS DECISION. `status` is who let it through; the amount stays in
     staff_advances behind the advrep nav, where it belongs. */
  advDecide:       { table: 'staff_advances', key: a => ({ id: a.id }), fields: ['status'] },
  advPay:          { table: 'staff_advances', key: a => ({ id: a.id }), fields: ['status'] },
  impDecide:       { table: 'imprest_requests', key: a => ({ id: a.id }), fields: ['status'] },
  impRetire:       { table: 'imprest_requests', key: a => ({ id: a.id }), fields: ['status'] },
  leaveDecide:     { table: 'leave_requests', key: a => ({ id: a.id }), fields: ['status'] },
  topupUpdate:     { table: 'topups', key: a => ({ id: a.id }), fields: ['status'] },
  stockDecide:     { table: 'stock_requests', key: a => ({ id: a.id }), fields: ['status'] },
  stockIssue:      { table: 'stock_requests', key: a => ({ id: a.id }), fields: ['status'] },
  commDecide:      { table: 'commission_runs', key: a => ({ id: a.id }), fields: ['status'] },
  commPay:         { table: 'commission_runs', key: a => ({ id: a.id }), fields: ['status'] },
  lossUpdate:      { table: 'loss_cases', key: a => ({ id: a.id }), fields: ['status'] },
  issueUpdate:     { table: 'issues', key: a => ({ id: a.id }),
                     fields: ['status', 'to_role', 'to_code'] },

  /* ONE HANDSET, ONE ORDER. deviceSetState takes a LIST and is deliberately absent: a diff
     that described one of four hundred phones would be a lie about the other 399. */
  deviceDelete:    { table: 'devices', key: a => ({ imei: a.imei }), fields: ['state', 'holder'] },
};
const K_ = s => String(s == null ? '' : s).trim().toUpperCase();

/** Read the one row a call is about, or null. Never throws: a diff is a nicety and the save
    it accompanies is not. */
async function auditRowOf(db, spec, args) {
  try {
    const where = spec.key(args || {});
    for (const v of Object.values(where)) if (v == null || v === '') return null;
    let q = db.from(spec.table).select(spec.fields.join(', '));
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { data, error } = await q.limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  } catch (e) { return null; }
}

/** What actually moved, as two objects holding the SAME keys. Values are shortened, because a
    tabs array can be forty entries long and a log is read by a person. */
function auditDiff(before, after, fields) {
  if (!before && !after) return null;
  const b = {}, a = {};
  let moved = 0;
  for (const f of fields) {
    const x = before ? before[f] : undefined;
    const y = after ? after[f] : undefined;
    if (JSON.stringify(x === undefined ? null : x) === JSON.stringify(y === undefined ? null : y)) continue;
    b[f] = auditVal(x); a[f] = auditVal(y); moved++;
  }
  return moved ? { before: b, after: a } : null;
}
/** One value, made readable and made small. An array becomes a joined string because that is
    how a tab list is read; anything longer than a line is cut, with the cut made visible. */
function auditVal(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) v = v.join(' ');
  if (typeof v === 'object') { try { v = JSON.stringify(v); } catch (e) { v = '?'; } }
  const s = String(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

const short = v => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, 240) || null);

/** Awaited, but incapable of failing. Returns a promise that ALWAYS resolves, and throws
    nothing, ever.

    IT USED TO BE FIRE-AND-FORGET, and on Vercel that is a hole. A serverless function can be
    frozen the moment it returns its response, so an insert nobody waited for is an insert that
    may never leave the process -- and the entries most likely to be lost are the ones on the
    slowest requests, which are not a random sample. A log with holes is worse than none: it
    invites the conclusion that what is missing did not happen, and for the salary-advance
    entries that means "nobody approved this".

    Rule 3 still holds and is what makes the await safe: every failure is swallowed here, so
    waiting for the write cannot turn a save into two things that must both succeed. The cost
    is a few milliseconds on the dozen writes a day this covers. */
export function auditWrite(db, row) {
  try {
    const p = db.from('audit_log').insert([row]);
    // Some callers hand back a thenable, some a promise; either way nothing may escape from it.
    if (p && typeof p.then === 'function') return p.then(() => {}, () => {});
  } catch (e) { /* no table, no permission, no network -- the save it accompanied still stands */ }
  return Promise.resolve();
}

/** Wraps one dispatched call. The handler's own result and its own errors pass straight
    through; this only watches. */
export async function audited(db, user, fn, args, run, where) {
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
    /* WHERE, as far as a server can honestly know it: what came with the request. Not a place
       on a map -- what tells an admin that a code was used from an address it has never been
       used from before. */
    ip: short(where && where.ip),
    ua: short(where && where.ua),
  };
  /* THE ROW AS IT STANDS, read BEFORE the handler runs, because afterwards it is gone. Only
     for the calls AUDIT_DIFF names, only the fields it names, and never at the cost of the
     save: auditRowOf swallows everything. */
  const spec = AUDIT_DIFF[fn] || null;
  const before = spec ? await auditRowOf(db, spec, args) : null;
  try {
    const out = await run();
    const d = spec ? auditDiff(before, await auditRowOf(db, spec, args), spec.fields) : null;
    await auditWrite(db, { ...base, ok: true, error: null, ms: Date.now() - started,
      before: d ? d.before : null, after: d ? d.after : null });
    return out;
  } catch (e) {
    /* A REFUSED ATTEMPT CHANGED NOTHING, so there is no "after" -- and saying so is the point.
       `before` still rides along: what somebody tried to overwrite is half of what a refused
       attempt is worth reading for. */
    await auditWrite(db, { ...base, ok: false, error: short(e && e.message) || 'failed',
      ms: Date.now() - started,
      before: before && spec ? pick_(before, spec.fields) : null, after: null });
    throw e;   // the handler's own error, unchanged: auditWrite cannot reject
  }
}
const pick_ = (row, fields) => {
  const out = {};
  for (const f of fields) out[f] = auditVal(row[f]);
  return out;
};

/** THE OTHER DOOR. Everything above wraps a call to /api/portal; this wraps one to /api/call,
    so the same pane answers "who did what" whether somebody worked from the office or from a
    handset in the field.

    IT TAKES THE SAME SHAPE AND MAKES THE SAME PROMISES: only calls that CHANGE something, only
    the fields a spec names, never the payload, and it can never break the thing it watches.

    WHO IS DIFFERENT, AND HONESTLY SO. There is no access code out there -- the device id IS the
    credential -- so that is what lands in actor_code, with the name and role read off the
    registered user. Anonymising it as "the app" would put a hundred officers' work under one
    name, which is the opposite of an audit. */
export async function auditedApp(db, entry, run) {
  const started = Date.now();
  const spec = entry.diff || null;
  const before = spec ? await auditRowOf(db, spec, entry.args) : null;
  const base = {
    actor_code: short(entry.actorCode),
    actor_name: short(entry.actorName),
    actor_role: short(entry.actorRole),
    action: entry.action,
    ref: short(entry.ref),
    team: short(entry.team),
    subject: short(entry.subject),
    ip: short(entry.ip),
    ua: short(entry.ua),
  };
  try {
    const out = await run();
    const d = spec ? auditDiff(before, await auditRowOf(db, spec, entry.args), spec.fields) : null;
    await auditWrite(db, { ...base, ok: true, error: null, ms: Date.now() - started,
      before: d ? d.before : null, after: d ? d.after : null });
    return out;
  } catch (e) {
    await auditWrite(db, { ...base, ok: false, error: short(e && e.message) || 'failed',
      ms: Date.now() - started,
      before: before && spec ? pick_(before, spec.fields) : null, after: null });
    throw e;
  }
}

/* =======================================================================================
   FIFTEEN DAYS, AND THE APP IS WHAT DELETES.

     "{auto-delete history of 15 days+}"

   THERE IS NO SCHEDULER IN THIS PROJECT, and a retention rule that depends on a cron nobody
   set up is a retention rule that silently does not exist -- the worst possible state for a
   promise about deleting data. So the deleting happens on the two occasions this table is
   already being touched:

     when the pane is opened   whoever looks at the log gets a pruned log, every time
     behind a write            at most once an hour per running instance, so a busy morning
                               costs one small delete rather than one per save

   IT CAN NEVER BREAK A SAVE OR A READ. Every failure is swallowed, exactly like auditWrite:
   an audit log that could fail the thing it was watching is a worse system than none.

   THE WINDOW IS A SETTING so fifteen days can become thirty without a deploy, and it is read
   only here -- a prune is rare; a write is not, and it must not cost an extra read. */
export const AUDIT_KEEP_DAYS = 15;
let lastPruneMs = 0;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

async function keepDays(db) {
  try {
    const { data } = await db.from('settings').select('value').eq('key', 'AUDIT_KEEP_DAYS').maybeSingle();
    const n = parseInt((data && data.value) || '', 10);
    /* A floor of one day, because a zero or a minus read out of a settings row somebody typed
       by hand would delete the log the moment it was opened. */
    return (isFinite(n) && n >= 1) ? Math.min(3650, n) : AUDIT_KEEP_DAYS;
  } catch (e) { return AUDIT_KEEP_DAYS; }
}

/** Delete everything past the window. Returns the cutoff it used, or null if it did nothing.
    Never throws. */
export async function auditPrune(db, { force = false, nowMs = Date.now() } = {}) {
  if (!force && nowMs - lastPruneMs < PRUNE_EVERY_MS) return null;
  lastPruneMs = nowMs;
  try {
    const days = await keepDays(db);
    const cutoff = new Date(nowMs - days * 86400000).toISOString();
    const { error } = await db.from('audit_log').delete().lt('at', cutoff);
    return error ? null : cutoff;
  } catch (e) { return null; }   // no table, no permission: the log still reads
}

/** The tab. Newest first, one page at a time -- a log is read from the top and the whole of it
    is never the question. */
export async function auditList(db, { limit = 200, actor = null, action = null, from = null, to = null } = {}) {
  const n = Math.max(1, Math.min(1000, parseInt(limit, 10) || 200));
  /* PRUNED ON THE WAY IN, forced: somebody has opened the log, so this is the one moment the
     window is certain to be honest when it is read. */
  await auditPrune(db, { force: true });
  const days = await keepDays(db);
  let rows = [];
  let available = true;
  try {
    rows = await fetchAll(() => {
      let q = db.from('audit_log')
        .select('at, actor_code, actor_name, actor_role, action, ref, team, subject, ok, error, ms, ip, ua, before, after')
        .order('at', { ascending: false }).limit(n);
      if (actor) q = q.eq('actor_code', actor);
      if (action) q = q.eq('action', action);
      if (from) q = q.gte('at', from);
      if (to) q = q.lte('at', to + 'T23:59:59.999Z');
      return q;
    });
  } catch (e) {
    /* THE COLUMN CHECK COMES FIRST, and the order is the whole of it -- the same trap the
       devices pane fell into. An audit_log that predates the before/after columns must read
       as "run the newer migration", not as "there is no audit log", which would send an admin
       hunting for a table that is sitting right there full of rows. */
    if (/\b(ip|ua|before|after)\b/.test(String(e && e.message || ''))) {
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
        rows = rows.slice(0, n);
        return { rows, count: rows.length, available: true, keepDays: days,
          note: 'Safu za thamani ya awali na mpya hazipo bado — endesha '
            + 'db/migrations/RUN-ME-2026-09-13-audit-log.sql. / The before/after columns are '
            + 'missing: run that migration and new entries will carry them.',
          actors: [...new Set(rows.map(r => r.actor_name).filter(Boolean))].sort(),
          actions: [...new Set(rows.map(r => r.action).filter(Boolean))].sort() };
      } catch (ignored) { /* fall through to unavailable */ }
    }
    available = false;                 // the migration has not been run at all
  }
  rows = rows.slice(0, n);
  return {
    rows,
    count: rows.length,
    available,
    keepDays: days,
    /* Told plainly rather than shown as an empty table, which reads as "nobody has done
       anything" -- the one conclusion an audit log must never invite by accident. */
    note: available ? null
      : 'Kumbukumbu bado haijaanzishwa — endesha db/migrations/RUN-ME-2026-09-13-audit-log.sql. '
        + '/ The audit table does not exist yet — run that migration.',
    actors: [...new Set(rows.map(r => r.actor_name).filter(Boolean))].sort(),
    actions: [...new Set(rows.map(r => r.action).filter(Boolean))].sort(),
  };
}
