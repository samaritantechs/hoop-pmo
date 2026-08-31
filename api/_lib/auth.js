import { supabase, runQuery, friendlyDbError } from './supabase.js';
import { requireSystemOpen } from './system-gate.js';
/* EAT, never the server's clock. Vercel runs in UTC and Dar es Salaam is three hours ahead, so
   a suspension compared against `new Date()` would begin at 21:00 the night before and end at
   21:00 the night before that -- locking somebody out of an evening they were meant to work and
   letting them back in for the first three hours of a day they are meant to be off. */
import { todayKey } from './time.js';

/** Same shape and job as auth_() in Code.gs: resolve an access code to
    {code, name, role, teams, tabs}. Throws on an invalid code -- callers don't need to
    re-check, same as before. */
/* `db` defaults to the real client. It exists so the door can be tested -- who gets in and who
   does not is the single most consequential rule in this system, and it was the one rule with
   no test at all, because the client was reached for directly instead of passed in. Every
   caller still calls authCode(code) and nothing about them changes. */
/* THE COLUMN LIST SIGN-IN ASKS FOR, and the narrower one it falls back to.
   ---------------------------------------------------------------------------------------------
   is_leader arrives with db/migrations/RUN-ME-2026-08-31-advance-leader.sql. PostgREST refuses a
   WHOLE select when one named column is unknown -- so naming it here without a fallback would
   not darken some pane, it would fail THE SIGN-IN QUERY, and every person in the company would
   be told their access code is invalid until somebody ran a migration. That is the worst failure
   this file is capable of, so the narrower list is kept and used the instant the wider one is
   refused for mentioning the column. */
/* IT IS A CASCADE NOW, because there are two of these columns and there will be a third one
   day. Widest first; each rung drops the newest column and is used the instant the one above it
   is refused for naming a column this database has not been given yet. The rule that matters is
   unchanged and is the reason this shape exists at all: a select that names an unknown column
   fails ENTIRELY, and the select in question is the sign-in.

   The INDEX of the rung that worked is what the caller reads afterwards, so "we did not ask"
   stays distinguishable from "we asked and the answer was no" -- see leader/suspended below,
   both of which are three-state for that reason. */
const CODE_COL_TIERS = [
  'code, name, role, teams, tabs, is_leader, suspend_from, suspend_to',
  'code, name, role, teams, tabs, is_leader',
  'code, name, role, teams, tabs',
];
const TIER_ALL = 0, TIER_NO_SUSPEND = 1;
const missingCol = err =>
  /is_leader|suspend_from|suspend_to/i.test(String((err && (err.message || err.details || err.code)) || ''));

/** Runs `ask(cols)` down the cascade until one is not refused for an unknown column.
    Returns { data, error, tier } -- tier being the rung that actually answered. */
async function downTheTiers(ask, from = 0) {
  let out = { data: null, error: null, tier: from };
  for (let tier = from; tier < CODE_COL_TIERS.length; tier++) {
    const { data, error } = await ask(CODE_COL_TIERS[tier]);
    out = { data, error, tier };
    if (!error || !missingCol(error)) return out;
  }
  return out;
}

export async function authCode(code, db = supabase) {
  if (!code) throw new AuthError('Access code required.');
  // Sign-in is the one request EVERYTHING else waits behind, so it is the one that most needs
  // to survive a momentary blip rather than turn the whole company away at the door.
  /* tier tells us what this database HAS been told about. leaderKnown=false means "not told
     about leaders yet", which is a different fact from "this person is not a leader" -- and the
     approval pane says which, rather than showing an empty queue that would read as "nobody has
     asked for anything". suspendKnown carries the same distinction for the absence window. */
  const first = await downTheTiers(cols => runQuery(() =>
    db.from('access_codes').select(cols).eq('code', code).maybeSingle()));
  let { data: exact, error } = first;
  const leaderKnown = first.tier <= TIER_NO_SUSPEND;
  const suspendKnown = first.tier === TIER_ALL;
  if (error) throw new AuthError(friendlyDbError(error));
  /* CASE IS NOT PART OF THE SECRET.
     The sign-in box used to carry autocapitalize="characters", so on a phone the code was
     upper-cased before it ever got here and an exact match was enough. Masking the box takes
     that away -- a password field turns the browser's own autocapitalize off -- so somebody
     typing their code in lower case would suddenly be told it was invalid, with the box showing
     dots and nothing to check it against.

     The exact match still runs first and still wins, so nothing about an existing code changes.
     This is only a second look for the same code typed in a different case. `code` is escaped
     for LIKE first: `%` and `_` are wildcards there, and a code containing one would otherwise
     match more rows than itself. */
  const found = await caseInsensitiveCode(code, db, first.tier);
  const data = exact || found.row;
  if (!data) throw new AuthError('Invalid access code.');
  const knowSuspend = suspendKnown && found.suspendKnown;
  /* AWAY TODAY, AND THEREFORE NOT AT THE DOOR EITHER.
     -------------------------------------------------------------------------------------
       "I need a feature to suspend a user at (Access codes - mfumo (portal)) so that they
        don't appear anywhere unless reactivated"

     "Anywhere" has to include the sign-in, or the person is still very much here. The refusal
     names the window rather than saying "invalid access code": somebody whose code is correct
     and is simply on leave should not spend the morning convinced they have forgotten it, and
     it is the one message here that cannot help an attacker -- you have to hold a valid code
     to ever see it.

     ADMIN IS NEVER SHUT OUT. It is the standing rule everywhere in this system, and here it is
     also the lockout guard: a window set on the last admin -- by a slip of the date picker, or
     by an admin suspending themselves -- would leave nobody able to lift it. Every other role
     is subject to this.

     AND IF THE COLUMNS ARE NOT THERE, NOBODY IS SUSPENDED. Three states, not two: the
     un-migrated database cannot say "yes", so it says nothing and the door works exactly as it
     did before the migration. A missing column must never be able to lock the company out. */
  if (knowSuspend && !isAdminRole({ role: data.role }) && suspendedOn(data, todayKey())) {
    throw new AuthError(suspendMessage(data));
  }
  return {
    code: data.code,
    name: data.name,
    role: data.role,
    teams: data.teams && data.teams.length ? data.teams : null,   // null = ALL teams, matching Code.gs's convention
    tabs: data.tabs || [],
    /* Three states, not two: true, false, and null for "the column is not there yet". */
    leader: (leaderKnown && found.leaderKnown) ? !!data.is_leader : null,
    // Same three states. Only ever false here -- a suspended code never gets this far.
    suspended: knowSuspend ? false : null,
  };
}

/* WHEN A WINDOW IS OPEN, in one place so nothing can hold a second opinion about it.
   =============================================================================================
     "so suspension is recorded by date picker start and end date"

   BOTH ENDS INCLUSIVE. A window of the 3rd to the 5th is three days off, which is what anybody
   filling in two date boxes means by it -- reading the end exclusively would put somebody back
   at work a day early, silently, with nothing anywhere to show the arithmetic was the cause.

   AN OPEN END IS INDEFINITE. "From Monday, until further notice" is a real thing to want and
   the natural way to express it is to leave the second box empty.

   AN OPEN START IS NOT. A `to` with no `from` would mean "suspended since the beginning of
   time", which nobody ever means by filling in one box, so it is read as no window at all --
   the safe direction, since the failure is somebody staying at work rather than an entire
   department being locked out by a half-filled form.

   COMPARED AS TEXT, ON PURPOSE. These are ISO dates, so string order IS date order, and the
   comparison never touches a Date object -- which is exactly where a UTC server three hours
   behind Dar es Salaam would put somebody back to work at 21:00 the night before. `day` comes
   from todayKey(), which is EAT. */
/* WHO IS ADMIN, in one place. It lived as a private const in portal.js, and the moment a
   second file needed the same question -- the door, refusing a suspended code -- keeping it
   there would have meant two copies of the most consequential rule in this system. Two copies
   is how the UI and the gate once came to read different rules in Hope. */
export const isAdminRole = user =>
  String((user && user.role) || '').trim().toUpperCase() === 'ADMIN';

export function suspendedOn(row, day) {
  const from = String((row && row.suspend_from) || '').slice(0, 10);
  const to = String((row && row.suspend_to) || '').slice(0, 10);
  const d = String(day || '').slice(0, 10);
  if (!from || !d) return false;
  if (d < from) return false;
  return !to || d <= to;
}

/** The refusal, naming the window. Only ever seen by somebody holding a valid code. */
export function suspendMessage(row) {
  const to = String((row && row.suspend_to) || '').slice(0, 10);
  return 'Umesimamishwa kwa muda' + (to ? ' hadi ' + to : '')
    + '. Wasiliana na msimamizi. / Your access is suspended'
    + (to ? ' until ' + to : ' until further notice') + ' — speak to your supervisor.';
}

/** The same code, matched without regard to case. Returns a row only when EXACTLY ONE code
    matches: two codes differing only in case are a real (if unlikely) possibility, and guessing
    between them would hand somebody another person's teams. Better to refuse and be told the
    code is invalid than to sign the wrong person in. */
async function caseInsensitiveCode(code, db, startTier = 0) {
  const pattern = String(code).replace(/([\\%_])/g, '\\$1');
  // Starts at the rung the exact-match query already proved this database can answer, so the
  // refusals are not paid for twice on every single sign-in.
  const { data, error, tier } = await downTheTiers(cols => runQuery(() =>
    db.from('access_codes').select(cols).ilike('code', pattern).limit(2)), startTier);
  if (error) throw new AuthError(friendlyDbError(error));
  return {
    row: (data && data.length === 1) ? data[0] : null,
    leaderKnown: tier <= TIER_NO_SUSPEND,
    suspendKnown: tier === TIER_ALL,
  };
}

/** Same as teamAllowed_() -- null teams (ALL access) always passes. */
export function teamAllowed(user, team) {
  if (!user.teams) return true;
  return user.teams.some(t => String(t).trim().toUpperCase() === String(team || '').trim().toUpperCase());
}

/** ADMIN always holds every tab -- that is the rule the live system's auth_() uses
    (isAdmin -> ADMIN_TABS), and it is why Upload/Settings can go missing here: an ADMIN
    row whose TABS cell happens to be blank ends up with nothing granted. Resolving tabs in
    ONE place keeps /api/me (which draws the UI) and /api/portal (which enforces) agreeing. */
export const USER_TABS = ['dashboard', 'apps', 'followup', 'assignments', 'promises', 'fureport',
  'complaints', 'restructure', 'legal', 'expected', 'defexp', 'expdfrep', 'credit', 'abnormal', 'reports',
  'weekly', 'par', 'present', 'teams', 'commission', 'calls', 'perf'];
/* `audit` is deliberately NOT in USER_TABS: it starts admin-only, and is opened to a role the
   ordinary way -- tick it on that role in Teams & Staff and both the nav item and the function
   follow. One mechanism, the same one every other tab uses. */
export const ADMIN_TABS = USER_TABS.concat(['upload', 'settings', 'audit']);
/* Tabs an admin holds that are not in USER_TABS, so a role-editing screen can offer them
   without inventing its own list. */
export const EXTRA_TABS = ['upload', 'settings', 'audit'];

/* =======================================================================================
   THE READ-ONLY ADMIN -- SUPERVISION THAT CANNOT LEAVE FINGERPRINTS.

     "I need to create an admin with [read only] user characteristics to view and try
      everything without changing nothing for the purpose of internal and external company
      supervision of the system -- their team that do so could also use ai to login and
      check whats what -- but read only"

   Give an access code the role AUDITOR (READONLY / READ ONLY / READ-ONLY are accepted
   spellings) and it sees what an admin sees -- every tab, the settings screens, the audit
   log -- while every function that CHANGES anything is refused at the one door all writes
   pass through (portalApi). Enforced at the server, not the screen: an AI, a curl, or a
   person poking buttons all hit the same wall.

   Three deliberate narrowings, each of which is the point rather than a limitation:

     upload      not granted at all -- the upload page is a pure write tool, and showing a
                 door that only ever says no is worse than not showing it
     secrets     the access-code and team-code VALUES are masked on every screen and export
                 a read-only viewer sees; a supervisor checks the system, they do not
                 collect its keys
     calls app   a view-only code does not register a handset -- the portal is the
                 supervision surface, and a phone session exists to write follow-ups
   ======================================================================================= */
const READONLY_ROLES = new Set(['AUDITOR', 'READONLY', 'READ ONLY', 'READ-ONLY']);
export function isReadOnly(user) {
  return READONLY_ROLES.has(String((user && user.role) || '').trim().toUpperCase());
}

export function resolveTabs(user, roleTabs) {
  if (String(user.role || '').trim().toUpperCase() === 'ADMIN') return ADMIN_TABS.slice();
  // Everything an admin can SEE, none of what an admin can DO -- upload is a write tool.
  if (isReadOnly(user)) return USER_TABS.concat(['settings', 'audit']);
  const merged = [...new Set([...(user.tabs || []), ...(roleTabs || [])])];
  return merged.length ? merged : USER_TABS.slice();
}

/** Same as can_() -- checks the role's tab permissions. Extend ROLE_TABS as roles are migrated. */
export async function can(user, tab) {
  // ADMIN holds every tab, same as resolveTabs and the live system's auth_(). Without this an
  // ADMIN whose TABS cell is blank was refused by /api/upload ("Upload permission is required
  // for your access code") even though the portal UI showed the tab -- the UI and the
  // enforcement have to read the SAME rule, and this is the third caller of it.
  if (String(user.role || '').trim().toUpperCase() === 'ADMIN') return true;
  // A read-only code never holds upload, whatever its row or role says -- see resolveTabs.
  if (isReadOnly(user) && tab === 'upload') return false;
  if (user.tabs && user.tabs.includes(tab)) return true;
  const { data } = await supabase.from('roles').select('tabs').eq('role', user.role).maybeSingle();
  return !!(data && data.tabs && data.tabs.includes(tab));
}

/** authCode, then the role's tabs merged in -- the SAME two steps /api/me and /api/portal each
    used to spell out for themselves. It is the resolved list that every permission check reads
    (an ADMIN row with a blank TABS cell still holds every tab), so any route that asks "may
    this person?" has to start here rather than from the raw row. */
export async function authCodeResolved(code) {
  const user = await authCode(code);
  const { data } = await supabase.from('roles').select('tabs').eq('role', user.role).maybeSingle();
  user.tabs = resolveTabs(user, data && data.tabs);
  // Carried on the user object so every enforcement point reads ONE fact, resolved once.
  user.readOnly = isReadOnly(user);
  return user;
}

/** Every door into the system side of this deployment: identity, then the admin's open/closed
    switch. Calls has its own door (api/call.js) and is deliberately NOT behind this one -- the
    whole point of closing the system is that field officers carry on working. */
export async function gatedUser(code) {
  const user = await authCodeResolved(code);
  await requireSystemOpen(supabase, user);
  return user;
}

export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; this.status = 401; }
}

/** Wraps a Vercel API handler so AuthError/any thrown error becomes a clean JSON error
    response instead of a raw 500 -- every route below uses this. */
export function withApi(handler) {
  return async (req, res) => {
    // These endpoints are deliberately callable from another origin: the upload page carries an
    // "API endpoint" field so one deployment can feed another, and a phone that saved a
    // different site URL still has to reach this API. Without these headers the browser
    // refuses the POST before it is ever sent and the page can only report "Failed to fetch".
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
      const result = await handler(req, res);
      if (result !== undefined) res.status(200).json({ ok: true, ...result });
    } catch (e) {
      const status = e.status || 500;
      /* A REFUSAL SOMETIMES HAS TO CARRY MORE THAN A SENTENCE. Most do not -- the message is
         the whole answer, and anything else is noise on a screen. But a refusal the caller is
         meant to be able to ARGUE WITH needs to say which rows it is about, or the client can
         only offer "retry everything", which on a bulk action is a second order for the phones
         that already succeeded. Three fields, all opt-in, all set deliberately at the throw. */
      const extra = {};
      if (e.code) extra.code = e.code;
      if (Array.isArray(e.imeis)) extra.imeis = e.imeis;
      /* AND SOMETIMES THE REFUSAL FOLLOWS WORK THAT ALREADY HAPPENED. deviceSetState locks
         every phone it can reach and then asks about the ones it cannot, so the dialog the
         operator is about to answer has to be able to say what the click has already done: a
         question about one handset, on a press that just locked nineteen, is a question that
         misleads. A count, never a payload, like the other two. */
      if (typeof e.changed === 'number') extra.changed = e.changed;
      res.status(status).json({ ok: false, error: e.message || String(e), ...extra });
    }
  };
}
