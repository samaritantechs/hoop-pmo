import { fetchAll } from './supabase.js';
import { teamAllowed } from './auth.js';
import { TZ_OFFSET_MS, todayKey, addDaysKey, weekMondayKey } from './time.js';
import { isSystemOpen } from './system-gate.js';

/* =====================================================================================
   THE HOOP CALLS BACKEND -- Hope's call-core, translated to the Watu book.

   Same endpoint names, same response shapes, so the adapted call.html only changes what
   it PRINTS. What changed underneath:

     the list      = the newest Watu deck (followup_status rows carrying the latest
                     deck_date), scoped to the caller's team at the database
     the customer  = one phone, keyed on IMEI (rides in the `ref` field end to end)
     the urgency   = days offline / locked 4+ / locked 7+ / day N of the 45-day window
     no guarantors = the Watu feed has none (starter section 5); the row says so honestly

   THE POSTGRES BUDGET (permanent rule), per handler, warm, on the second handset:
     boot           4 reads  (teams 1-col, settings x7 in ONE `in` query, device row,
                              today's own logs) + gate read (cached 30s)
     list           3 reads  (device row, newest deck_date by index limit 1, deck rows
                              team-scoped .in) + called-set (cached 30s company-wide)
     sync           2 reads  (device, DATA_VERSION) + phone index (cached vs DATA_VERSION)
                    + 2 writes (logs upsert, watermark update)
     summary        cached 2 min per team-set; a miss = 2 counted reads + 1 small read
     comments       2 keyed reads; addComment = 1 stub upsert + 1 insert + 1 update
   Row bounds: every list read is bounded by the day's deck for the caller's teams; no
   handler reads the whole snapshots history; nothing reads call_logs beyond one day
   except the leader report, which is date-bounded and team-scoped at the database.
   ===================================================================================== */

export const APP = { BRAND: 'HOOP LTD', MOTTO: 'WATU SIMU' };

/* The follow-up vocabulary of THIS trade: a locked phone, a promise, a new number. Same
   behaviour wiring as Hope -- a promise opens a date, a new number opens a number box,
   OTHERS demands a comment -- and the list is editable in Settings (FU_STATUSES), where a
   new word is always a plain comment. */
export const FU_STATUSES = [
  'AMETOA AHADI', 'ANALIPA LEO', 'HAPATIKANI', 'HANA USHIRIKIANO',
  'SIMU IPO KWA MTU MWINGINE', 'SIMU IMEIBIWA / IMEPOTEA', 'ANA NAMBA NYINGINE', 'OTHERS',
];
export const FU_NEED_DATE = ['AMETOA AHADI'];
export const FU_NEED_COMMENT = ['SIMU IMEIBIWA / IMEPOTEA', 'OTHERS'];
export const FU_NEED_NUMBER = ['ANA NAMBA NYINGINE'];
export const FU_STATUS_KEY = 'FU_STATUSES';

export function parseFuStatuses(raw) {
  // Newlines OR commas: the Settings box is a one-line input, so a comma-separated
  // paste must work exactly like the newline shape the API docs describe.
  const list = String(raw == null ? '' : raw).split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const x of list) { const k = x.toUpperCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out.length ? out : FU_STATUSES.slice();
}
export function fuStatusShape(list) {
  const has = new Set(list.map(x => String(x).trim().toUpperCase()));
  const keep = arr => arr.filter(x => has.has(x.toUpperCase()));
  return { fuStatuses: list, fuNeedDate: keep(FU_NEED_DATE), fuNeedComment: keep(FU_NEED_COMMENT),
    fuNeedNumber: keep(FU_NEED_NUMBER), fuBuiltIn: FU_STATUSES.slice() };
}
/** The FU list for this database: the FU_STATUSES setting, defaults otherwise. One read. */
export async function fuStatusConfig(db) {
  const raw = await settingGet(db, FU_STATUS_KEY);
  return fuStatusShape(parseFuStatuses(raw));
}

/* ---------- small ports, byte-faithful to Hope ---------- */
export function pnorm(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.indexOf('255') === 0) d = d.slice(3);
  d = d.replace(/^0+/, '');
  return d.slice(-9);
}
export function h36(s) {
  s = String(s == null ? '' : s);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const K = s => String(s == null ? '' : s).trim().toUpperCase();
const num = v => (typeof v === 'number' ? v : Number(v) || 0);
function eatStamp(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16);
}
function eatDate(ms) { return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10); }
function eatTime(ms) { return new Date(ms + TZ_OFFSET_MS).toISOString().slice(11, 16); }

async function settingGet(db, key) {
  const { data } = await db.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}
/** Several settings, ONE round trip (Hope's Monday-morning fix, kept). */
async function settingsMany(db, keys) {
  const rows = await fetchAll(() => db.from('settings').select('key, value').in('key', keys));
  const by = {};
  for (const r of rows) by[String(r.key)] = r.value;
  return k => (by[k] == null ? null : by[k]);
}

/** Day N of 45, computed live so a stale deck still tells the truth about the window. */
export function lifeDayOf(disbursedDate, nowKey) {
  const d = String(disbursedDate || '').slice(0, 10);
  if (!d) return null;
  const ms = Date.parse(nowKey + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z');
  if (isNaN(ms)) return null;
  return Math.floor(ms / 86400000) + 1;
}

/* ---------- users (verbatim Hope mechanics) ---------- */
async function userByDevice(db, dev) {
  dev = String(dev == null ? '' : dev).trim();
  if (!dev) return null;
  const { data, error } = await db.from('call_users').select('*').eq('device_id', dev).limit(1);
  if (error) throw new Error(error.message);
  const cu = (data && data[0]) || null;
  if (!cu) return null;
  if (cu.active === false) { const e = new Error('ACCOUNT_OFF'); e.accountOff = true; throw e; }
  return cu;
}
async function userByDeviceSoft(db, dev) {
  try { return await userByDevice(db, dev); }
  catch (e) { if (e && e.accountOff) return null; throw e; }
}
export function pseudoUser(cu) {
  const lt = cu.leader_teams;
  const teams = !cu.is_leader ? (K(cu.team) ? [K(cu.team)] : null)
    : (!lt || !lt.length || lt.some(t => K(t) === 'ALL')) ? null
    : lt.map(t => K(t)).filter(Boolean);
  return { name: cu.name, role: cu.role, teams };
}
async function teamList(db) {
  const rows = await fetchAll(() => db.from('teams').select('team'));
  return rows.filter(r => r.team).map(r => r.team).sort();
}

/* ---------- boot / register ---------- */
async function boot(db, [dev], nowMs) {
  const BOOT_KEYS = ['CALL_BRAND', 'CALL_LOGO_URL', 'CALL_SYNC_SECONDS', 'CALL_LOGOUT_ENABLED',
    FU_STATUS_KEY, 'DATA_VERSION', 'OFFLINE_PACK'];
  let cu = null, accountOff = false;
  const [setting] = await Promise.all([
    settingsMany(db, BOOT_KEYS),
    (async () => {
      try { cu = await userByDevice(db, dev); }
      catch (e) { if (e && e.accountOff) accountOff = true; else throw e; }
    })(),
  ]);
  const brand = setting('CALL_BRAND') || APP.BRAND;
  const logo = setting('CALL_LOGO_URL') || '';
  const systemOpen = await isSystemOpen(db, nowMs);
  if (!cu) return { ok: false, error: accountOff ? 'ACCOUNT_OFF' : 'DEVICE_NOT_REGISTERED',
    teams: [], brand, motto: APP.MOTTO, logo, systemOpen };
  const today = todayKey(nowMs);
  const logs = await fetchAll(() => db.from('call_logs').select('duration, portfolio')
    .eq('user_id', cu.user_id).eq('call_date', today));
  const syncSec = parseInt(setting('CALL_SYNC_SECONDS'), 10);
  const logoutSetting = K(setting('CALL_LOGOUT_ENABLED'));
  return {
    ok: true,
    systemOpen,
    userId: cu.user_id, name: cu.name, team: cu.team, role: cu.role,
    leader: !!cu.is_leader,
    expdfLeader: false,      // Hope's rotation tab -- not part of the Hoop book
    expdfOwner: false,
    leaderTeams: cu.is_leader ? (!cu.leader_teams || !cu.leader_teams.length ? 'ALL' : cu.leader_teams.join(',')) : '',
    teams: [],               // never handed to a handset; kept for shape compatibility
    watermark: num(cu.last_ts),
    ...fuStatusShape(parseFuStatuses(setting(FU_STATUS_KEY))),
    brand, motto: APP.MOTTO, logo,
    dataVersion: setting('DATA_VERSION') || '',
    offlinePack: ['YES', 'TRUE', '1', 'ON'].includes(K(setting('OFFLINE_PACK'))),
    syncEverySec: (!syncSec || isNaN(syncSec)) ? 300 : Math.max(60, Math.min(3600, syncSec)),
    logoutEnabled: logoutSetting !== 'NO' && logoutSetting !== 'FALSE' && logoutSetting !== '0',
    today: {
      calls: logs.length,
      duration: logs.reduce((s, r) => s + num(r.duration), 0),
      portfolio: logs.filter(r => !!r.portfolio).length,
    },
  };
}

/** Identity keyed by PHONE; the team code decides WHICH team -- verbatim Hope flow,
    including the live (uncached) teams read so a rotated code cuts instantly. */
async function register(db, [dev, name, team, accessCode, phone, passcode, location], nowMs) {
  dev = String(dev == null ? '' : dev).trim();
  if (!dev) throw new Error('Missing device id.');
  name = String(name == null ? '' : name).trim();
  const phoneD = pnorm(phone);
  if (!phoneD) throw new Error('Enter your phone number.');
  team = String(team == null ? '' : team).trim();
  const loc = String(location == null ? '' : location).trim();
  const code = String(accessCode == null ? '' : accessCode).trim();
  let role = 'OFFICER', leader = false, leaderTeams = null;
  const teams = await teamList(db);
  if (code) {
    const { data: u } = await db.from('access_codes').select('*').eq('code', code).maybeSingle();
    if (!u) throw new Error('Invalid access code.');
    if (['AUDITOR', 'READONLY', 'READ ONLY', 'READ-ONLY'].includes(K(u.role || ''))) {
      throw new Error('Msimbo huu ni wa kuangalia tu — tumia mfumo (portal). '
        + '/ This is a view-only code: use the portal, where every screen is open.');
    }
    leader = true;
    role = u.role || 'LEADER';
    leaderTeams = (u.teams && u.teams.length) ? u.teams : null;
    const home = team || (leaderTeams && leaderTeams[0]) || '';
    team = teams.find(t => K(t) === K(home)) || null;
    name = u.name || name;
    const { data: off } = await db.from('call_users').select('active').eq('phone', phoneD).maybeSingle();
    if (off && off.active === false) throw new Error('Akaunti yako imezimwa. / Your account has been switched off. Ask your admin.');
  } else {
    const pass = String(passcode == null ? '' : passcode).trim();
    if (!pass) throw new Error('Weka msimbo wa timu yako. / Enter your team code.');
    const codeKey = K(pass).replace(/[^0-9A-Z]/g, '');
    const teamRows = await fetchAll(() => db.from('teams').select('*'));
    const match = teamRows.find(t => K(t.team_code || '').replace(/[^0-9A-Z]/g, '') === codeKey && codeKey);
    if (!match) throw new Error('Msimbo wa timu si sahihi. / That team code is not correct. Ask your admin.');
    team = match.team;
    role = 'OFFICER';
    /* AGENTS SIGN IN WITH PHONE + THE SHARED CODE, NOTHING ELSE (the owner: "their
       sign in code should be their registered phone number and agent code ... read
       their names and branch from system"). The register IS the identity: canonical
       name, branch as location. An unknown phone cannot register as an agent at all --
       the fence fails closed at the front door, not just on the list. Budget: the
       shared cached agent index -- no extra round trip warm. */
    if (K(match.team) === 'AGENT') {
      role = 'AGENT';
      const agents = await agentIndex(db, nowMs);
      const known = agents.byPhone[phoneD] || null;
      if (!known) throw new Error('Namba yako haipo kwenye rejista ya mawakala. '
        + '/ Your phone number is not on the agents register yet — ask the office to add you, then sign in again.');
      name = known.name || name || 'Agent';
      team = known.branch || loc || 'AGENT';
    } else if (!name) throw new Error('Andika jina lako. / Enter your name.');
    const { data: acct } = await db.from('call_users').select('active').eq('phone', phoneD).maybeSingle();
    if (acct && acct.active === false) throw new Error('Akaunti yako imezimwa. / Your account has been switched off. Ask your admin.');
  }
  if (!name) throw new Error('Could not find a name on file for that access code.');
  const uid = 'U' + h36(phoneD);
  const now = new Date(nowMs).toISOString();
  const { data: existing } = await db.from('call_users').select('user_id, registered_at, last_sync, last_ts').eq('phone', phoneD).maybeSingle();
  const vals = {
    user_id: uid, name, team, role, is_leader: leader, leader_teams: leaderTeams,
    device_id: dev, phone: phoneD,
    registered_at: (existing && existing.registered_at) || now,
    last_sync: (existing && existing.last_sync) || null,
    last_ts: (existing && existing.last_ts) || null,
  };
  // Never write passcode_hash / passcode_salt / active from here (Hope rule: registration
  // must not be a way to re-enable a switched-off account).
  const { error } = await db.from('call_users').upsert(vals, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  const { error: e2 } = await db.from('call_users').update({ device_id: null }).eq('device_id', dev).neq('user_id', uid);
  if (e2) throw new Error(e2.message);
  return { ok: true, userId: uid, name, team, leader, leaderTeams: leaderTeams ? leaderTeams.join(',') : (leader ? 'ALL' : '') };
}

/* ---------- "amepigiwa leo" -- Hope's warm set, verbatim mechanics ---------- */
const CALL_MIN_SECS_DEFAULT = 5;
const CALLED_TTL_MS = 30000;
const calledCache = new WeakMap();
function noteCalledToday(db, nowMs, records) {
  const hit = calledCache.get(db);
  if (!hit || hit.day !== todayKey(nowMs)) return;
  for (const r of records || []) {
    if (r.call_date !== hit.day) continue;
    if (num(r.duration) <= hit.min) continue;
    const d = pnorm(r.phone);
    if (d) hit.value[d] = 1;
  }
}
async function calledTodaySet(db, nowMs) {
  const day = todayKey(nowMs);
  const hit = calledCache.get(db);
  if (hit && hit.day === day && hit.at <= nowMs && (nowMs - hit.at) < CALLED_TTL_MS) return hit.value;
  const raw = parseInt(String(await settingGet(db, 'CALL_MIN_SECS') || '').replace(/[^0-9]/g, ''), 10);
  const min = (isNaN(raw) || raw < 0) ? CALL_MIN_SECS_DEFAULT : raw;
  const rows = await fetchAll(() => db.from('call_logs').select('phone, duration').eq('call_date', day));
  const set = {};
  for (const r of rows) {
    if (num(r.duration) <= min) continue;
    const d = pnorm(r.phone); if (d) set[d] = 1;
  }
  calledCache.set(db, { at: nowMs, day, min, value: set });
  return set;
}

/* ---------- THE WORKLOAD DEAL ----------
   "Kinondoni is company location, not customers." The team on a row is the BRANCH that
   sold the phone, never a fence around who calls whom. The deck is ONE company pool,
   dealt like cards: customers sorted by IMEI, active credit users sorted by user_id,
   customer i belongs to officer i % n. Nothing is stored, so registering another credit
   user changes n and the deal rebalances ITSELF on the next refresh -- the owner's
   "automatic distribution continues". Leaders are dealt a share like everyone; their
   oversight lives in Ripoti. */
/* Only CREDIT people are dealt shares -- every other role opens the WHOLE book (the
   owner's rule; per-agent views come in a later stage). The app registers company-code
   users as OFFICER, so both spellings count as credit. All credits share EQUALLY:
   round-robin gives every roster member the same count, plus-minus one. */
const CREDIT_ROLES = new Set(['CREDIT', 'OFFICER', 'CREDIT OFFICER', 'CREDIT TEAM']);
/* EXPLICIT roles only -- no fallback. An old trial account with a blank role must NOT
   be dealt a share by default (that bug put the admin's own phone into the deal). A
   person registered with a personal CREDIT access code counts, leader flag or not. */
const isCredit = cu => CREDIT_ROLES.has(K(cu && cu.role));
/* AGENTS -- the owner's coming stage, arrived (2026-08-17): "agents should see only
   their data". One shared AGENT sign-in code (rotated in the WhatsApp group exactly like
   the staff code); the agent's own PHONE is the identity -- it must match Sipho's
   register (hoop_agents), which maps their name onto every IMEI they sold in the Watu
   register. No per-agent codes to mint or track. Agents are never dealt shares and never
   join the credit roster; if the index fails or the phone is unknown the agent sees an
   EMPTY book, never somebody else's -- this fence fails closed. */
const isAgent = cu => K(cu && cu.role) === 'AGENT';
/** The deal's roster WITH NAMES -- same single read; names ride along so every list row
    can say which credit person is chasing that customer (the third chip on the card).
    Exported: the portal's Wateja shows the same dealt names -- one deal, two screens. */
export async function rosterFull(db) {
  const rows = await fetchAll(() => db.from('call_users').select('user_id, name, role, active'));
  const on = rows.filter(r => r.active !== false && CREDIT_ROLES.has(K(r.role)))
    .sort((a, b) => (String(a.user_id) < String(b.user_id) ? -1 : 1));
  const names = {};
  for (const r of on) names[String(r.user_id)] = r.name || '';
  return { ids: on.map(r => String(r.user_id)), names };
}
async function activeRoster(db) { return (await rosterFull(db)).ids; }
/* THE WINDOW IS 45 DAYS PLUS TWO OF GRACE. The owner (2026-08-17): "i have 49 and they
   had 52 and my number of days are like 2 infront since months vary lengths -- add two
   more days to the calendar we are pulling so that we get all customers we should."
   Watu keeps a customer about two days longer than plain day arithmetic, so the window
   follows Watu -- otherwise we drop customers Watu still counts as Hoop's. The label
   stays "/45" everywhere: the BUSINESS window is 45; the +2 is calendar slack. */
export const WINDOW_DAYS = 47;
const inWindowOf = (r, day) => { const l = lifeDayOf(r.disbursed_date, day); return l != null && l <= WINDOW_DAYS; };

/* THE EQUAL DEAL, PER KIND. One round-robin over the whole book looked equal ("all
   credits should get equal distribution") yet the owner saw "3 got 12 and one got 9" on
   a tab: an officer's share can happen to hold fewer locked-7 customers. So the deal is
   cut per stratum -- locked 7+ in window, locked 4-6 in window, the rest of the window,
   beyond the window -- each dealt round-robin by IMEI. Every officer's every TAB is now
   equal, plus-minus one. Nothing is stored; the deal still re-cuts itself the moment
   the roster changes. Exported: the portal's Wateja must run the SAME deal. */
export function dealMap(rows, rosterIds, day) {
  const out = {};
  if (!rosterIds || !rosterIds.length) return out;
  const strata = { L7: [], L4: [], IN: [], OUT: [] };
  for (const r of rows) {
    const k = !inWindowOf(r, day) ? 'OUT' : (r.locked7 === true ? 'L7' : (r.locked4 === true ? 'L4' : 'IN'));
    strata[k].push(r);
  }
  for (const k of ['L7', 'L4', 'IN', 'OUT']) {
    strata[k].sort((a, b) => (String(a.imei) < String(b.imei) ? -1 : 1))
      .forEach((r, i) => { out[String(r.imei)] = String(rosterIds[i % rosterIds.length]); });
  }
  return out;
}
/** This user's cut of the rows under the stratified deal; a device outside the roster
    peeks at the whole book, exactly as before. */
function shareOf(rows, roster, uid, day) {
  if (!roster.length || roster.indexOf(String(uid)) < 0) return rows;
  const deal = dealMap(rows, roster, day);
  return rows.filter(r => deal[String(r.imei)] === String(uid));
}

/* WHO SOLD THIS PHONE, on the card -- the agent holds Hope's guarantor slot until
   Watu's reports carry real guarantors (PENDING #1). The register knows the agent per
   IMEI; Sipho's register knows the agent's own phone by name. Cached against
   DATA_VERSION like the phone index; a failed build must NEVER break the list -- the
   card just shows a dash. Budget: warm = 1 keyed DATA_VERSION read; a version change
   or 15-minute lapse costs 2 bounded reads (register imei+agent, agents name+phone). */
/* Names arrive in any order and any casing -- Watu writes "Anord Sawe", SyscoPos may
   hold "SAWE Anord". A token-sorted key lets every spelling of the same person meet:
   the tokens, uppercased, sorted, rejoined. */
export const nameKey = s => K(s).split(/\s+/).filter(Boolean).sort().join(' ');
const agentIdxCache = new WeakMap();
export async function agentIndex(db, nowMs) {
  const version = (await settingGet(db, 'DATA_VERSION')) || '';
  const hit = agentIdxCache.get(db);
  if (hit && hit.version === version && (nowMs - hit.at) < 15 * 60000) return hit;
  const byImei = {}, phoneByName = {}, byPhone = {};
  try {
    // Guarantors landed with the offline queue (2026-08-17). Until the migration has
    // run, PostgREST refuses the WHOLE select for the unknown columns -- so fall back
    // to the old shape rather than letting the agent fence and the card go dark.
    const [reg, agents, sales] = await Promise.all([
      fetchAll(() => db.from('watu_loans').select('imei, agent, agent_id, branch, guarantor_name, guarantor_phone'))
        .catch(() => fetchAll(() => db.from('watu_loans').select('imei, agent, agent_id'))),
      fetchAll(() => db.from('hoop_agents').select('name, phone, branch')),
      // The sales report carries the agent's payout number per sale (the owner: "sales
      // report of store keeper sipho has the agents numbers") -- a SECOND source of
      // agent phones, so a card need not wait for the agent's register page to land.
      fetchAll(() => db.from('hoop_sales').select('commission_agent, commission_phone')
        .not('commission_phone', 'is', null)).catch(() => []),
    ]);
    for (const r of reg) if (r.agent || r.branch || r.guarantor_name || r.guarantor_phone)
      byImei[String(r.imei)] = { name: r.agent || '', id: r.agent_id || '', branch: r.branch || '',
        gName: r.guarantor_name || '', gPhone: r.guarantor_phone || '' };
    for (const a of agents) if (a.name) {
      phoneByName[nameKey(a.name)] = a.phone || '';
      // The reverse map is the AGENT sign-in fence: their registered phone -> who they
      // are. branch rides along because it IS the agent's location (the owner: "the
      // agents location are the branch column" of Sipho's report).
      const p = pnorm(a.phone);
      if (p && !byPhone[p]) byPhone[p] = { name: a.name, key: nameKey(a.name), branch: a.branch || '' };
    }
    // Sipho's register wins on a clash; sales phones fill only the gaps.
    for (const s of sales) if (s.commission_agent && s.commission_phone) {
      const k = nameKey(s.commission_agent);
      if (!phoneByName[k]) phoneByName[k] = s.commission_phone;
    }
  } catch (e) { /* decoration for the card; the agent fence fails CLOSED on empty maps */ }
  const value = { version, at: nowMs, byImei, phoneByName, byPhone };
  agentIdxCache.set(db, value);
  return value;
}

/* ---------- the list: the newest Watu deck ---------- */
const DECK_COLS = 'imei, client_name, contact, team, model, price, disbursed_date, '
  + 'days_offline, locked4, locked7, has_ever_paid, fu_status, deck_date, updated_at';

/** One tiny indexed read answers "which deck is newest"; the deck itself is one
    team-scoped read. Nothing ever reads the whole register onto a handset. */
async function latestDeckDate(db) {
  const { data, error } = await db.from('followup_status')
    .select('deck_date').not('deck_date', 'is', null)
    .order('deck_date', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return (data && data[0] && data[0].deck_date) ? String(data[0].deck_date).slice(0, 10) : null;
}

async function list(db, [dev], nowMs) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) return { ok: false, error: 'DEVICE_NOT_REGISTERED' };
  const [called, deckDate, rosterAll, agents] = await Promise.all([
    calledTodaySet(db, nowMs), latestDeckDate(db), rosterFull(db), agentIndex(db, nowMs)]);
  const roster = rosterAll.ids;
  if (!deckDate) return { ok: true, rows: [], asOf: null, stale: false, narrowed: null, note: null };
  // The WHOLE deck -- no team fence (the team column is the selling branch) -- then this
  // officer's dealt share of it. Budget: the deck read is the same one as before; the
  // roster is one extra bounded read.
  const fu = await fetchAll(() => db.from('followup_status').select(DECK_COLS).eq('deck_date', deckDate));
  const today = todayKey(nowMs);
  let mine, note = null;
  if (isAgent(cu)) {
    // The agent fence: their registered phone names them on Sipho's register; the Watu
    // register names them on each IMEI. No match -> EMPTY book (fails closed) + why.
    const me = agents.byPhone[pnorm(cu.phone)] || null, myKey = me ? me.key : '';
    mine = myKey ? fu.filter(r => { const ag = agents.byImei[String(r.imei)]; return ag && nameKey(ag.name) === myKey; }) : [];
    if (!myKey) note = 'Your phone number is not on the agents register yet — ask the office to add it, then reopen the app.';
    else if (!mine.length) note = 'Safi! Hakuna mteja wako kwenye orodha ya leo. / None of the customers you sold are on today’s locked list.';
  } else {
    mine = shareOf(fu, roster, cu.user_id, today);
  }
  const hit = c => !!called[pnorm(c)];
  // WHO IS CHASING each customer: the SAME stratified deal, labeled -- so a leader, an
  // agent or any whole-book viewer sees the responsible credit person on every card.
  const deal = dealMap(fu, roster, today);
  const holdsOf = {};
  for (const k of Object.keys(deal)) holdsOf[k] = rosterAll.names[deal[k]] || '';
  const rows = mine.map(r => {
    const life = lifeDayOf(r.disbursed_date, today);
    const ag = agents.byImei[String(r.imei)] || null;
    return {
      // Hope-shaped keys so the page machinery carries over; ref IS the IMEI. The
      // guarantor slot is REAL now -- fed by the offline-queue upload via the register.
      ref: r.imei, name: r.client_name, contact: r.contact,
      gName: ag ? (ag.gName || '') : '', gContact: ag ? (ag.gPhone || '') : '',
      agentName: ag ? ag.name : '', agentId: ag ? ag.id : '',
      agentPhone: ag && ag.name ? (phoneByNameOf(agents, ag.name)) : '',
      heldBy: holdsOf[String(r.imei)] || '',
      amt: num(r.price), installment: null,
      custStatus: r.locked7 ? 'LOCKED 7+' : (r.locked4 ? 'LOCKED 4+' : ''),
      fuStatus: r.fu_status || '',
      ds: life == null ? '' : life + '/45',
      days: r.days_offline == null ? '' : r.days_offline,
      // The offline queue's BRANCH is the location the owner wants read out loud;
      // the deck's shop-derived team is only the fallback.
      team: (ag && ag.branch) || r.team,
      called: hit(r.contact),
      // Hoop's own facts, printed by the adapted page.
      model: r.model || '', lifeDay: life,
      // The credits want the ACTUAL date, not just the day-of-45 count -- ds already says
      // "39/45", this says which day that count is counted FROM. Same column, read once,
      // just carried onto the row instead of being consumed only by lifeDayOf above.
      disbursedDate: r.disbursed_date ? String(r.disbursed_date).slice(0, 10) : null,
      daysOff: r.days_offline == null ? null : num(r.days_offline),
      locked4: !!r.locked4, locked7: !!r.locked7,
      paid: r.has_ever_paid === true,
      inWindow: life != null && life <= WINDOW_DAYS,
    };
  });
  // Most-offline first -- the deepest-locked phone is the call that matters most.
  rows.sort((a, b) => (num(b.daysOff) - num(a.daysOff)) || (num(b.amt) - num(a.amt)));
  const stale = deckDate < today;
  return { ok: true, rows, asOf: deckDate, stale, narrowed: null, note };
}

function phoneByNameOf(agents, name) { return agents.phoneByName[nameKey(name)] || ''; }

/* ---------- the phone index (who is this number) ---------- */
/* Cached against DATA_VERSION exactly as Hope's is: an upload moves the version, the next
   sync rebuilds. One read of the register's four columns + the comments that carry a new
   number -- never the whole comment history. */
const phoneIdxCache = new WeakMap();
async function phoneIndex(db, nowMs, dataVersion) {
  const hit = phoneIdxCache.get(db);
  if (hit && hit.ver === String(dataVersion || '') && (nowMs - hit.at) < 3600000) return hit.value;
  const value = await phoneIndexCompute(db);
  phoneIdxCache.set(db, { at: nowMs, ver: String(dataVersion || ''), value });
  return value;
}
async function phoneIndexCompute(db) {
  const [fu, cm, reg, ags, sales] = await Promise.all([
    fetchAll(() => db.from('followup_status').select('imei, client_name, contact, team')),
    fetchAll(() => db.from('followup_comments').select('imei, new_number, client_name, team')
      .not('new_number', 'is', null).neq('new_number', '')),
    // GUARANTOR AND AGENT CALLS ARE PORTFOLIO WORK (the owner's rule): ringing the
    // guarantor IS chasing that customer, ringing the agent is chasing their sales.
    // Guarantor numbers point at the customer's IMEI; agent numbers carry the agent's
    // own name with no team, so the portfolio flag holds for every caller.
    fetchAll(() => db.from('watu_loans').select('imei, client_name, team, guarantor_phone')
      .not('guarantor_phone', 'is', null)).catch(() => []),
    fetchAll(() => db.from('hoop_agents').select('name, phone')).catch(() => []),
    fetchAll(() => db.from('hoop_sales').select('commission_agent, commission_phone')
      .not('commission_phone', 'is', null)).catch(() => []),
  ]);
  const byNum = {};
  const add = (numRaw, name, ref, team, kind) => {
    const d = pnorm(numRaw);
    if (!d || byNum[d]) return;
    byNum[d] = { K: d, N: name || '', R: ref || '', T: team || '', C: kind || 'C', S: 'LOCKED' };
  };
  // Customers first -- a number that is both a customer's and an agent's is a customer.
  fu.forEach(r => add(r.contact, r.client_name, r.imei, r.team));
  const refName = {}, refTeam = {};
  Object.values(byNum).forEach(o => { if (o.R) { refName[o.R] = o.N; refTeam[o.R] = o.T; } });
  cm.forEach(r => {
    const nn = String(r.new_number == null ? '' : r.new_number).trim();
    if (!nn) return;
    const ref = String(r.imei || '');
    add(nn, refName[ref] || r.client_name || '', ref, refTeam[ref] || r.team);
  });
  reg.forEach(r => add(r.guarantor_phone, (r.client_name || '') + ' (mdhamini)', r.imei, r.team, 'GUARANTOR'));
  ags.forEach(a => add(a.phone, 'Agent: ' + (a.name || ''), '', '', 'AGENT'));
  sales.forEach(s => add(s.commission_phone, 'Agent: ' + (s.commission_agent || ''), '', '', 'AGENT'));
  return byNum;
}

/* ---------- sync ---------- */
const OUTCOMES = { CONNECTED: 1, MISSED: 1, REJECTED: 1, BLOCKED: 1 };
async function sync(db, [dev, calls], nowMs) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) return { ok: false, error: 'DEVICE_NOT_REGISTERED' };
  const user = pseudoUser(cu);
  calls = calls || [];
  let wm = num(cu.last_ts);
  const dataVersion = (await settingGet(db, 'DATA_VERSION')) || '';
  if (!calls.length) return { ok: true, added: 0, dup: 0, watermark: wm, portfolio: 0, nonPortfolio: 0, dataVersion };
  const byNum = await phoneIndex(db, nowMs, dataVersion);
  const records = [];
  const seenBatch = {};
  let pf = 0, npf = 0, batchDup = 0;
  for (const c of calls) {
    const ts = num(c.ts);
    if (!ts) continue;
    const d = pnorm(c.num);
    const dur = Math.max(0, num(c.dur));
    let outcome = String(c.outcome || 'CONNECTED').toUpperCase();
    if (!OUTCOMES[outcome]) outcome = 'CONNECTED';
    const id = 'C' + h36(dev + '|' + d + '|' + ts + '|' + dur + '|' + outcome);
    if (seenBatch[id]) { batchDup++; continue; }
    seenBatch[id] = 1;
    const m = byNum[d];
    // Portfolio = THEIR book (Hope rule): a match on a team outside the caller's scope is
    // named but not counted as portfolio work.
    const mine = !!m && (!m.T || teamAllowed(user, m.T));
    records.push({
      id, user_id: cu.user_id, officer: cu.name, team: cu.team, phone: d,
      direction: c.dir === 'in' ? 'IN' : 'OUT',
      call_date: eatDate(ts), call_time: eatTime(ts), duration: dur,
      portfolio: mine, match_type: m ? (m.C === 'AGENT' ? 'AGENT' : m.C === 'GUARANTOR' ? 'GUARANTOR' : 'CUSTOMER') : null,
      ref: m ? m.R : null, customer: m ? m.N : null,
      synced_at: new Date(nowMs).toISOString(),
      // category deliberately null: Hoop has ONE book (the locked list), so the
      // expected/defaulter split does not exist here and the CHECK stays untouched.
      outcome, category: null,
    });
    if (mine) pf++; else npf++;
    if (ts > wm) wm = ts;
  }
  if (!records.length) return { ok: true, added: 0, dup: batchDup, watermark: wm, portfolio: 0, nonPortfolio: 0, dataVersion };
  const { data: inserted, error } = await db.from('call_logs')
    .upsert(records, { onConflict: 'id', ignoreDuplicates: true }).select('id');
  if (error) throw new Error(error.message);
  const added = (inserted || []).length;
  noteCalledToday(db, nowMs, records);
  const { error: e2 } = await db.from('call_users')
    .update({ last_sync: new Date(nowMs).toISOString(), last_ts: wm }).eq('user_id', cu.user_id);
  if (e2) throw new Error(e2.message);
  return { ok: true, added, dup: batchDup + (records.length - added), watermark: wm, portfolio: pf, nonPortfolio: npf, dataVersion };
}

/* ---------- comments / follow-up ---------- */
const COMMENT_LIMIT = 100;
async function comments(db, [dev, ref]) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) return { ok: false, error: 'DEVICE_NOT_REGISTERED' };
  const { data, error } = await db.from('followup_comments')
    .select('comment, fu_status, created_by, created_at')
    .eq('imei', String(ref)).order('created_at', { ascending: false }).limit(COMMENT_LIMIT);
  if (error) throw new Error(error.message);
  const items = (data || []).map(c => ({
    by: c.created_by || '', at: c.created_at ? eatStamp(Date.parse(c.created_at)) : '',
    fu: c.fu_status || '', comment: c.comment || '',
  }));
  return { ok: true, items, complaints: [], capped: items.length >= COMMENT_LIMIT };
}
async function addComment(db, [dev, p], nowMs) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) throw new Error('Device not registered.');
  p = p || {};
  const ref = String(p.ref == null ? '' : p.ref).trim();
  if (!ref) throw new Error('ref is required');
  const fu = p.fu || '';
  if (FU_NEED_DATE.includes(fu) && !p.promiseDate) throw new Error('A promise date is required for "Ametoa Ahadi".');
  if (FU_NEED_COMMENT.includes(fu) && !p.comment) throw new Error('A comment is required for that follow-up status.');
  if (FU_NEED_NUMBER.includes(fu) && !p.newNo) throw new Error('A new phone number is required for "Ana namba nyingine".');
  const now = new Date(nowMs).toISOString();
  // A customer not on the register yet still gets a home for their history (Hope's stub).
  const { error: sErr } = await db.from('followup_status')
    .upsert({ imei: ref, team: p.team || null, client_name: p.name || null }, { onConflict: 'imei', ignoreDuplicates: true });
  if (sErr) throw new Error(sErr.message);
  const { error: cErr } = await db.from('followup_comments').insert({
    imei: ref, team: p.team || null, client_name: p.name || null, comment: p.comment || null,
    fu_status: fu || null, promise_date: p.promiseDate || null, promise_amt: p.promiseAmt || null,
    new_number: p.newNo ? pnorm(p.newNo) : null, created_by: cu.name, created_at: now,
  });
  if (cErr) throw new Error(cErr.message);
  const { error: uErr } = await db.from('followup_status').update({
    fu_status: fu || null, promise_date: p.promiseDate || null, promise_amt: p.promiseAmt || null,
    last_comment: p.comment || null, comment_by: cu.name, comment_at: now, updated_at: now,
  }).eq('imei', ref);
  if (uErr) throw new Error(uErr.message);
  return { ok: true, ref, savedAt: now };
}

/* ---------- daily summary (the strip + the portal tiles -- ONE derivation) ---------- */
/* Cached two minutes per team-set, exactly Hope's reasoning: everyone on the same teams is
   asking the identical question. A miss costs 3 reads: the deck (columns for counting),
   today's team-scoped logs, and the newest deck date. */
const SUMMARY_TTL_MS = 120000;
const summaryCache = new Map();
export function _clearSummaryCache() { summaryCache.clear(); histStore.clear(); }

/* ---------- yesterday + last week, read ONCE per day per instance ----------
   The performance bar is always YESTERDAY's reached %, plus last week's average so
   Monday knows what was what (the owner's rule). Historical deck membership comes from
   watu_snapshots (append-only); the current deck table only remembers a row's newest
   stamp. Budget: on the day's first ask -- 1 tiny date lookup + 1 ranged snapshot read
   + 1 ranged logs read; every later ask is memory. */
const histStore = new Map();
async function histFor(db, nowMs) {
  const today = todayKey(nowMs);
  const hit = histStore.get('h');
  if (hit && hit.day === today) return hit;
  const weekStart = addDaysKey(weekMondayKey(nowMs), -7);       // last week's Monday
  const yEnd = addDaysKey(today, -1);
  const one = await db.from('watu_snapshots').select('snapshot_date')
    .lt('snapshot_date', today).order('snapshot_date', { ascending: false }).limit(1);
  const yDate = one.data && one.data[0] ? String(one.data[0].snapshot_date).slice(0, 10) : null;
  const from = yDate && yDate < weekStart ? yDate : weekStart;
  const [snaps, logs, minRaw] = await Promise.all([
    // locked flags + disbursed_date ride along so yesterday's book deals by the SAME
    // strata as today's -- the bar must measure the share the officer actually held.
    fetchAll(() => db.from('watu_snapshots')
      .select('imei, client_mobile, snapshot_date, created_at, locked4, locked7, disbursed_date')
      .gte('snapshot_date', from).lte('snapshot_date', yEnd)),
    fetchAll(() => db.from('call_logs').select('user_id, phone, duration, call_date')
      .gte('call_date', from).lte('call_date', yEnd)),
    settingGet(db, 'CALL_MIN_SECS'),
  ]);
  const min = (() => { const n = parseInt(String(minRaw || '').replace(/[^0-9]/g, ''), 10);
    return (isNaN(n) || n < 0) ? CALL_MIN_SECS_DEFAULT : n; })();
  const deckByDate = new Map();
  for (const r of snaps) {
    const d = String(r.snapshot_date).slice(0, 10);
    let m = deckByDate.get(d);
    if (!m) { m = new Map(); deckByDate.set(d, m); }
    const had = m.get(String(r.imei));
    if (!had || String(r.created_at) > String(had.created_at)) m.set(String(r.imei), r);
  }
  const logsByDate = new Map();
  for (const l of logs) {
    const d = String(l.call_date).slice(0, 10);
    if (!logsByDate.has(d)) logsByDate.set(d, []);
    logsByDate.get(d).push(l);
  }
  const value = { day: today, yDate, weekStart, min, deckByDate, logsByDate };
  histStore.set('h', value);
  return value;
}
/** Reached % for one date: the dealt share when uid is given, the whole company when
    null. Yesterday's share is dealt with TODAY's roster -- a person added since then
    shifts it slightly, which is the honest cost of "nothing is stored". */
function reachedOn(date, hist, uid, roster, poolFn) {
  if (!date) return null;
  const deckMap = hist.deckByDate.get(date);
  if (!deckMap || !deckMap.size) return null;
  const all = [...deckMap.values()];
  // poolFn overrides the deal: an AGENT's pool is "the customers they sold", not a share.
  const pool = poolFn ? all.filter(poolFn) : (uid == null ? all : shareOf(all, roster, String(uid), date));
  if (!pool.length) return null;
  const phones = new Set(pool.map(r => pnorm(r.client_mobile)).filter(Boolean));
  const got = new Set();
  for (const l of (hist.logsByDate.get(date) || [])) {
    if (uid != null && String(l.user_id) !== String(uid)) continue;
    if (num(l.duration) <= hist.min) continue;
    const d = pnorm(l.phone);
    if (d && phones.has(d)) got.add(d);
  }
  return { pct: phones.size ? got.size / phones.size : null, num: got.size, den: phones.size };
}
function weekAvgFor(hist, uid, roster, poolFn) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const r = reachedOn(addDaysKey(hist.weekStart, i), hist, uid, roster, poolFn);
    if (r && r.pct != null) days.push(r.pct);
  }
  return days.length ? { pct: days.reduce((a, b) => a + b, 0) / days.length, days: days.length } : { pct: null, days: 0 };
}
export async function summaryFor(db, user, nowMs) {
  const key = user.teams ? user.teams.map(K).slice().sort().join(',') : 'ALL';
  const hit = summaryCache.get(key);
  if (hit && (nowMs - hit.at) < SUMMARY_TTL_MS && hit.at <= nowMs) return { ...hit.value, cached: true };
  const value = await summaryCompute(db, user, nowMs);
  summaryCache.set(key, { at: nowMs, value });
  return { ...value, cached: false };
}
async function summaryCompute(db, user, nowMs) {
  const today = todayKey(nowMs);
  const deckDate = await latestDeckDate(db);
  const scope = q => (user.teams && user.teams.length) ? q.in('team', user.teams.map(K)) : q;
  const [deck, logs, dataVersion] = await Promise.all([
    deckDate ? fetchAll(() => scope(db.from('followup_status')
      .select('imei, contact, disbursed_date, locked4, locked7, days_offline').eq('deck_date', deckDate))) : [],
    fetchAll(() => scope(db.from('call_logs').select('phone, ref, duration, portfolio').eq('call_date', today))),
    settingGet(db, 'DATA_VERSION'),
  ]);
  const inWinOf = r => inWindowOf(r, today);
  const inWin = deck.filter(inWinOf).length;
  // Locked 7+ counts Hoop's own burden ONLY: past day 45 the customer is Watu's problem
  // (the owner's rule). The tile must agree with the app's Lock 7+ tab, which drops them.
  const locked7 = deck.filter(r => r.locked7 === true && inWinOf(r)).length;
  // The performance bar is always YESTERDAY (a finished day), never today's half-story,
  // plus last week's average -- company-wide here ("other roles get average of all
  // company"; the per-person cut lives in dailySummary and in Ripoti).
  const hist = await histFor(db, nowMs);
  const den = deck.length;
  return {
    ok: true,
    deckDate,
    list: { num: den },
    locked7: { num: locked7 },
    inWindow: { num: inWin },
    calls: { num: logs.length },
    reached: reachedOn(hist.yDate, hist, null, []) || { pct: null, num: 0, den: 0 },
    weekAvg: weekAvgFor(hist, null, []),
    asOfReached: hist.yDate,
    dataVersion: dataVersion || '',
  };
}

/** The credit user's OWN strip: their dealt share of today's deck, their own calls
    today, their own yesterday %, their own last-week average. Cached per user.
    Budget on a cache miss: 1 deck read + 1 roster read + 1 own-logs-today read
    (indexed user_id+date) + the day's shared history (memory after the first ask). */
async function summaryForOfficer(db, cu, nowMs) {
  const key = 'U:' + String(cu.user_id);
  const hit = summaryCache.get(key);
  if (hit && (nowMs - hit.at) < SUMMARY_TTL_MS && hit.at <= nowMs) return { ...hit.value, cached: true };
  const today = todayKey(nowMs);
  const deckDate = await latestDeckDate(db);
  const [deck, roster, myLogs, hist] = await Promise.all([
    deckDate ? fetchAll(() => db.from('followup_status')
      .select('imei, contact, disbursed_date, locked4, locked7, days_offline').eq('deck_date', deckDate)) : [],
    activeRoster(db),
    fetchAll(() => db.from('call_logs').select('id, duration')
      .eq('call_date', today).eq('user_id', String(cu.user_id))),
    histFor(db, nowMs),
  ]);
  const mine = shareOf(deck, roster, cu.user_id, today);
  const inWinOf = r => inWindowOf(r, today);
  const value = {
    ok: true,
    deckDate,
    list: { num: mine.length },
    locked7: { num: mine.filter(r => r.locked7 === true && inWinOf(r)).length },
    inWindow: { num: mine.filter(inWinOf).length },
    calls: { num: myLogs.length },
    reached: reachedOn(hist.yDate, hist, cu.user_id, roster) || { pct: null, num: 0, den: 0 },
    weekAvg: weekAvgFor(hist, cu.user_id, roster),
    asOfReached: hist.yDate,
    dataVersion: (await settingGet(db, 'DATA_VERSION')) || '',
  };
  summaryCache.set(key, { at: nowMs, value });
  return { ...value, cached: false };
}
/** The AGENT's strip: only the customers THEY sold -- counted with the same yesterday
    and last-week rules as everyone else. Cached per user like the officer strip.
    Budget on a cache miss: 1 deck read + 1 own-logs-today read (indexed user_id+date)
    + the day's shared history + the agent index (both memory after the first ask). */
async function summaryForAgent(db, cu, nowMs) {
  const key = 'U:' + String(cu.user_id);
  const hit = summaryCache.get(key);
  if (hit && (nowMs - hit.at) < SUMMARY_TTL_MS && hit.at <= nowMs) return { ...hit.value, cached: true };
  const today = todayKey(nowMs);
  const deckDate = await latestDeckDate(db);
  const [deck, myLogs, hist, agents] = await Promise.all([
    deckDate ? fetchAll(() => db.from('followup_status')
      .select('imei, contact, disbursed_date, locked4, locked7, days_offline').eq('deck_date', deckDate)) : [],
    fetchAll(() => db.from('call_logs').select('id, duration')
      .eq('call_date', today).eq('user_id', String(cu.user_id))),
    histFor(db, nowMs),
    agentIndex(db, nowMs),
  ]);
  const me = agents.byPhone[pnorm(cu.phone)] || null, myKey = me ? me.key : '';
  const mineFn = r => { const ag = agents.byImei[String(r.imei)]; return !!(myKey && ag && nameKey(ag.name) === myKey); };
  const mine = deck.filter(mineFn);
  const inWinOf = r => inWindowOf(r, today);
  const value = {
    ok: true,
    deckDate,
    list: { num: mine.length },
    locked7: { num: mine.filter(r => r.locked7 === true && inWinOf(r)).length },
    inWindow: { num: mine.filter(inWinOf).length },
    calls: { num: myLogs.length },
    reached: reachedOn(hist.yDate, hist, cu.user_id, [], mineFn) || { pct: null, num: 0, den: 0 },
    weekAvg: weekAvgFor(hist, cu.user_id, [], mineFn),
    asOfReached: hist.yDate,
    onRegister: !!myKey,
    dataVersion: (await settingGet(db, 'DATA_VERSION')) || '',
  };
  summaryCache.set(key, { at: nowMs, value });
  return { ...value, cached: false };
}
async function dailySummary(db, [dev], nowMs) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) return { ok: false, error: 'DEVICE_NOT_REGISTERED' };
  // A CREDIT-role user sees THEIR share and THEIR numbers -- whether they registered
  // with the company code or their own CREDIT access code. An AGENT sees only the
  // customers they sold. Every other role (ADMIN, leads, general duty, blank trial
  // accounts) sees the whole company's average.
  if (isAgent(cu)) return summaryForAgent(db, cu, nowMs);
  if (isCredit(cu)) return summaryForOfficer(db, cu, nowMs);
  return summaryFor(db, { name: cu.name, role: cu.role, teams: null }, nowMs);
}

/* ---------- leader report (Ripoti) ---------- */
export async function reportCore(db, scopeTeams, from, to, alwaysUid, nowMs) {
  const fromKey = /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? from : addDaysKey(todayKey(nowMs), -7);
  const toKey = /^\d{4}-\d{2}-\d{2}$/.test(String(to)) ? to : todayKey(nowMs);
  let scope = null;
  if (scopeTeams) {
    scope = {};
    (Array.isArray(scopeTeams) ? scopeTeams : String(scopeTeams).split(',')).forEach(t => { const k = K(t); if (k) scope[k] = 1; });
  }
  const [users0, teamRows, logs, agIdx] = await Promise.all([
    fetchAll(() => db.from('call_users').select('*')),
    fetchAll(() => db.from('teams').select('team, rsm')),
    // Date-bounded and team-scoped AT THE DATABASE (the budget rule) on the fastest-growing table.
    fetchAll(() => {
      let q = db.from('call_logs').select('*').gte('call_date', fromKey).lte('call_date', toKey);
      if (scope && Object.keys(scope).length) q = q.in('team', Object.keys(scope));
      return q;
    }),
    // The per-place section groups by the CUSTOMER's branch (offline queue), not the
    // officer's timu -- the owner's rule. Shared cached index: no new round trips warm.
    agentIndex(db, nowMs),
  ]);
  const curTeam = {}, curName = {}, curRole = {}, curPhone = {};
  users0.forEach(r => { curTeam[r.user_id] = r.team || ''; curName[r.user_id] = r.name || ''; curRole[r.user_id] = r.role || ''; curPhone[r.user_id] = r.phone || ''; });
  const rsmOf = {};
  teamRows.forEach(t => { if (t.team) rsmOf[K(t.team)] = t.rsm || ''; });

  const rows = [];
  for (const r of logs) {
    const uid = String(r.user_id);
    const team = Object.prototype.hasOwnProperty.call(curTeam, uid) ? curTeam[uid] : r.team;
    if (scope && !scope[K(team)] && uid !== alwaysUid) continue;
    rows.push({ ...r, team, officer: curName[uid] || r.officer, uid });
  }
  const byDayUser = {}, users = {}, teams = {}, byOutcome = {};
  for (const r of rows) {
    const day = String(r.call_date), officer = String(r.officer), team = String(r.team), uid = r.uid;
    const dk = day + '|' + uid, isPf = !!r.portfolio;
    const outc = (() => { const o = K(r.outcome); return (o === 'MISSED' || o === 'REJECTED' || o === 'BLOCKED') ? o : 'CONNECTED'; })();
    const dur = num(r.duration);
    if (!byDayUser[dk]) byDayUser[dk] = { day, officer, team, calls: 0, dur: 0, pf: 0, npf: 0 };
    byDayUser[dk].calls++; byDayUser[dk].dur += dur; isPf ? byDayUser[dk].pf++ : byDayUser[dk].npf++;
    if (!users[uid]) users[uid] = { name: officer, team, role: curRole[uid] || '', phone: curPhone[uid] || '', calls: 0, dur: 0, pf: 0, npf: 0, days: {}, uniq: {}, connected: 0 };
    const u = users[uid];
    u.calls++; u.dur += dur; u.days[day] = 1;
    if (isPf) { u.pf++; u.uniq[String(r.ref || r.phone)] = 1; } else u.npf++;
    if (outc === 'CONNECTED') u.connected++;
    // "Not sort by timu but these branches": the customer's branch from the register.
    // A call to somebody outside the register (or non-portfolio) buckets as OTHER.
    const gg = r.ref && agIdx.byImei[String(r.ref)];
    const br = (gg && gg.branch) || (isPf ? String(team || 'OTHER') : 'OTHER');
    if (!teams[br]) teams[br] = { team: br, calls: 0, dur: 0, pf: 0, npf: 0 };
    teams[br].calls++; teams[br].dur += dur; isPf ? teams[br].pf++ : teams[br].npf++;
    if (!byOutcome[outc]) byOutcome[outc] = { outcome: outc, calls: 0, dur: 0 };
    byOutcome[outc].calls++; byOutcome[outc].dur += dur;
  }
  // An officer who made no calls is the POINT of this report (Hope rule, kept).
  for (const u of users0) {
    const uid = String(u.user_id);
    if (users[uid]) continue;
    if (u.active === false) continue;
    const team = u.team || '';
    if (scope && !scope[K(team)] && uid !== alwaysUid) continue;
    if (!String(u.name || '').trim()) continue;
    users[uid] = { name: u.name, team, role: u.role || '', phone: u.phone || '', calls: 0, dur: 0, pf: 0, npf: 0, days: {}, uniq: {}, connected: 0 };
  }
  const OUT_ORDER = { CONNECTED: 1, MISSED: 2, REJECTED: 3, BLOCKED: 4 };
  const totals = { calls: rows.length, duration: 0, portfolio: 0, nonPortfolio: 0 };
  rows.forEach(r => { totals.duration += num(r.duration); r.portfolio ? totals.portfolio++ : totals.nonPortfolio++; });
  totals.ratio = totals.calls ? totals.portfolio / totals.calls : 0;
  return {
    from: fromKey, to: toKey,
    byDay: Object.keys(byDayUser).sort().map(k => byDayUser[k]),
    users: Object.keys(users).sort((a, b) => users[a].name < users[b].name ? -1 : 1).map(k => {
      const u = users[k];
      return { name: u.name, team: u.team, position: u.role ? (u.role.charAt(0) + u.role.slice(1).toLowerCase()) : 'Officer',
        phone: u.phone || '', calls: u.calls, duration: u.dur,
        portfolio: u.pf, nonPortfolio: u.npf, ratio: u.calls ? u.pf / u.calls : 0,
        uniqCustomers: Object.keys(u.uniq).length, days: Object.keys(u.days).length,
        expected: 0, defaulter: 0, connected: u.connected, connectRatio: u.calls ? u.connected / u.calls : 0 };
    }),
    teams: Object.keys(teams).sort().map(k => { const t = teams[k]; return { team: t.team, calls: t.calls, duration: t.dur, portfolio: t.pf, nonPortfolio: t.npf, ratio: t.calls ? t.pf / t.calls : 0, rsm: rsmOf[K(t.team)] || '' }; }),
    byCategory: [],
    byOutcome: Object.keys(byOutcome).sort((a, b) => (OUT_ORDER[a] || 9) - (OUT_ORDER[b] || 9)).map(k => byOutcome[k]),
    totals,
  };
}
async function report(db, [dev, from, to, team], nowMs) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) return { ok: false, error: 'DEVICE_NOT_REGISTERED' };
  if (!cu.is_leader) throw new Error('Leader access only.');
  const lt = cu.leader_teams;
  const full = (!lt || !lt.length || lt.some(t => K(t) === 'ALL')) ? null : lt;
  const allTeams = await teamList(db);
  const choices = (full ? full : allTeams)
    .map(t => String(t || '').trim()).filter(Boolean)
    .filter((t, i, a) => a.findIndex(x => K(x) === K(t)) === i).sort();
  let scope = full;
  const want = String(team == null ? '' : team).trim();
  const picked = want && choices.find(t => K(t) === K(want)) || '';
  if (picked && (!scope || scope.some(t => K(t) === K(picked)))) scope = [picked];
  const filtered = !!picked;
  const alwaysUid = !filtered ? cu.user_id
    : ((scope && scope.some(t => K(t) === K(cu.team))) ? cu.user_id : null);
  const out = await reportCore(db, scope, from, to, alwaysUid, nowMs);
  out.ok = true;
  out.teamChoices = choices;
  out.team = picked;
  out.leaderChoices = [];
  out.leader = '';
  out.debugScope = scope || 'ALL';
  out.debugHomeTeam = cu.team || '';
  return out;
}

/* ---------- the bell ---------- */
export const notifKeyFor = who => 'NOTIF_SEEN_' + String(who || '').toUpperCase();
const NOTIF_LIMIT = 60;
export async function notifCore(db, user, seenKey, nowMs) {
  const teams = user && user.teams ? user.teams.map(K) : null;
  const today = todayKey(nowMs);
  const weekBack = addDaysKey(today, -7);
  const scoped = rows => rows.filter(r => teamAllowed(user, r.team));
  const [cmtRes, promRes, seenRes] = await Promise.all([
    (() => {
      let q = db.from('followup_comments')
        .select('id, imei, team, client_name, comment, fu_status, created_at, created_by')
        .order('created_at', { ascending: false }).limit(NOTIF_LIMIT);
      if (teams && teams.length) q = q.in('team', teams);
      return q;
    })(),
    (() => {
      // Promises come due: today and the week behind it, on customers still offline.
      let q = db.from('followup_status')
        .select('imei, team, client_name, contact, days_offline, promise_date, promise_amt, comment_by')
        .gte('promise_date', weekBack).lte('promise_date', today)
        .order('promise_date', { ascending: false }).limit(NOTIF_LIMIT);
      if (teams && teams.length) q = q.in('team', teams);
      return q;
    })(),
    db.from('settings').select('key, value').eq('key', seenKey),
  ]);
  if (cmtRes.error) throw new Error(cmtRes.error.message);
  const cmts = cmtRes.data || [];
  const proms = (promRes && !promRes.error && promRes.data) ? promRes.data : [];
  const seenAt = ((seenRes.data || [])[0] || {}).value || '';
  const items = [
    ...scoped(cmts).map(c => ({
      kind: 'comment', id: 'f' + c.id, ref: c.imei, team: c.team,
      who: c.client_name || '', by: c.created_by || '',
      what: String(c.comment || c.fu_status || 'Follow-up').slice(0, 160),
      at: String(c.created_at || ''),
    })),
    ...scoped(proms)
      .filter(p => p.promise_date && num(p.days_offline) > 0)
      .map(p => {
        const due = String(p.promise_date).slice(0, 10);
        const late = due < today;
        return {
          kind: 'promise', id: 'p' + p.imei + due, ref: p.imei, team: p.team,
          who: p.client_name || '', by: p.comment_by || '',
          what: (late ? 'Ahadi imepita / promise overdue' : 'Ahadi ya leo / promise due today')
            + (num(p.promise_amt) > 0 ? ' · TZS ' + Math.round(num(p.promise_amt)) : '')
            + ' · ' + due,
          at: due + 'T06:00:00.000Z', due, late,
        };
      }),
  ].filter(x => x.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, NOTIF_LIMIT)
    .map(x => ({ ...x, unseen: !seenAt || x.at > seenAt }));
  return { items, unseen: items.filter(x => x.unseen).length, seenAt };
}
async function callNotifications(db, [dev], nowMs) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) return { ok: false, error: 'DEVICE_NOT_REGISTERED' };
  const d = await notifCore(db, pseudoUser(cu), notifKeyFor(cu.user_id), nowMs);
  return { ok: true, ...d };
}
async function callNotifSeen(db, [dev], nowMs) {
  const cu = await userByDeviceSoft(db, dev);
  if (!cu) return { ok: false, error: 'DEVICE_NOT_REGISTERED' };
  const at = new Date(nowMs).toISOString();
  const { error } = await db.from('settings').upsert({ key: notifKeyFor(cu.user_id), value: at }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return { ok: true, seenAt: at };
}

/* ---------- brand / team code / announcement (unauthenticated by design) ---------- */
async function brand(db) {
  return { brand: (await settingGet(db, 'CALL_BRAND')) || APP.BRAND,
    motto: APP.MOTTO, logo: (await settingGet(db, 'CALL_LOGO_URL')) || '' };
}
async function teamCode(db, [code]) {
  const c = K(String(code == null ? '' : code)).replace(/[^0-9A-Z]/g, '');
  if (!c) return { ok: false };
  const teams = await fetchAll(() => db.from('teams').select('team, team_code'));
  const hit = teams.find(t => K(t.team_code || '').replace(/[^0-9A-Z]/g, '') === c);
  return hit ? { ok: true, team: hit.team } : { ok: false };
}
async function announcement(db) {
  const rows = await fetchAll(() => db.from('announcement').select('*'));
  const a = rows[0];
  if (!a || !a.is_on) return { on: false, ts: 0 };
  const ts = Date.parse(a.updated_at || '') || 0;
  return { on: true, ts, text: String(a.text || ''), image: String(a.image_url || '') };
}

/* ---------- dispatch ---------- */
const HANDLERS = {
  api_brand: brand,
  api_teamCode: teamCode,
  api_announcement: announcement,
  api_callBoot: boot,
  api_callRegister: register,
  api_callList: list,
  api_callDailySummary: dailySummary,
  api_callSync: sync,
  api_callComments: comments,
  api_callAddComment: addComment,
  api_callReport: report,
  api_callNotifications: callNotifications,
  api_callNotifSeen: callNotifSeen,
};
export async function callApi(db, fn, args, nowMs = Date.now()) {
  const h = HANDLERS[fn];
  if (!h) { const e = new Error('Unknown call API: ' + fn); e.status = 400; throw e; }
  return h(db, args || [], nowMs);
}
