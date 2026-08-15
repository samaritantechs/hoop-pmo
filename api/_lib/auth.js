import { supabase, runQuery, friendlyDbError } from './supabase.js';
import { requireSystemOpen } from './system-gate.js';

/** Same shape and job as auth_() in Code.gs: resolve an access code to
    {code, name, role, teams, tabs}. Throws on an invalid code -- callers don't need to
    re-check, same as before. */
/* `db` defaults to the real client. It exists so the door can be tested -- who gets in and who
   does not is the single most consequential rule in this system, and it was the one rule with
   no test at all, because the client was reached for directly instead of passed in. Every
   caller still calls authCode(code) and nothing about them changes. */
export async function authCode(code, db = supabase) {
  if (!code) throw new AuthError('Access code required.');
  // Sign-in is the one request EVERYTHING else waits behind, so it is the one that most needs
  // to survive a momentary blip rather than turn the whole company away at the door.
  const { data: exact, error } = await runQuery(() =>
    db.from('access_codes').select('code, name, role, teams, tabs').eq('code', code).maybeSingle());
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
  const data = exact || await caseInsensitiveCode(code, db);
  if (!data) throw new AuthError('Invalid access code.');
  return {
    code: data.code,
    name: data.name,
    role: data.role,
    teams: data.teams && data.teams.length ? data.teams : null,   // null = ALL teams, matching Code.gs's convention
    tabs: data.tabs || [],
  };
}

/** The same code, matched without regard to case. Returns a row only when EXACTLY ONE code
    matches: two codes differing only in case are a real (if unlikely) possibility, and guessing
    between them would hand somebody another person's teams. Better to refuse and be told the
    code is invalid than to sign the wrong person in. */
async function caseInsensitiveCode(code, db) {
  const pattern = String(code).replace(/([\\%_])/g, '\\$1');
  const { data, error } = await runQuery(() =>
    db.from('access_codes').select('code, name, role, teams, tabs').ilike('code', pattern).limit(2));
  if (error) throw new AuthError(friendlyDbError(error));
  return (data && data.length === 1) ? data[0] : null;
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
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  };
}
