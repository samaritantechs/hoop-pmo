import { randomUUID } from 'node:crypto';
import { supabase, fetchAll } from './_lib/supabase.js';
import { withApi, gatedUser, isReadOnly } from './_lib/auth.js';
import { audited, AUDITED, auditList } from './_lib/audit.js';
import { todayKey } from './_lib/time.js';
import { summaryFor, reportCore, lifeDayOf, fuStatusConfig, pnorm, rosterFull,
  agentIndex, nameKey, dealMap, WINDOW_DAYS, FU_STATUSES } from './_lib/call-core.js';

/* =====================================================================================
   POST /api/portal   { code, fn, args }

   The HOOP portal backend: tiles, Teams & codes, Ripoti, Recovery, staff, settings.
   Every write passes through audited() -- who did what lands in audit_log, never the
   payload. A read-only code (AUDITOR) sees everything and changes nothing.

   THE POSTGRES BUDGET, warm, per fn:
     boot       auth+gate (cached) + summary (2-min cache; miss = 3 scoped reads)
                + 1 teams read
     report     3 reads, date-bounded + team-scoped at the database (call-core's own)
     recovery   2 tiny indexed date lookups + 2 day-bounded scoped reads of watu_snapshots
     customers  2 tiny indexed date lookups + 1 deck read + 1 prev-day snapshot read
                + 1 register read (imei,agent,team only) + 1 keyed settings read; all scoped
     portalAddComment  1 stub upsert + 1 comment insert + 1 keyed status update (3 writes)
     customerComments  1 read, keyed by IMEI, newest 100
     teams      1 read;   saveTeam / newTeamCode: 1 read + 1 write
     officers   1 read;   officerActive: 1 write
     codes      3 parallel reads (codes, roles, 1 keyed setting);
                saveAccessCode / deleteAccessCode: 1 write
                deleteRole: 1 bounded codes read + 1 keyed delete + 1 keyed read + 1 write
     settings   1 `in` read; settingSet: 1 write
     salesAudit / agentScore   3 parallel bounded reads each (sales by date range,
                register imei+agent columns / scoped register, agents ~1k) -- see the
                fns' own headers; both are reads, nothing audited
     staffDirectory  1 bounded read (~1k agents);  stockView  2 parallel bounded reads
     navsFor / requireNav  ZERO reads -- pure functions over the already-resolved tabs
                (the permanent postgres rule: a permission check must never buy a trip)
   Row bounds: recovery reads two DAYS of snapshots, team-scoped; nothing reads the whole
   history; the audit list is capped at 200 newest.
   ===================================================================================== */

AUDITED.add('newTeamCode');
AUDITED.add('officerActive');
AUDITED.add('renameAccessCode');
AUDITED.add('portalAddComment');
AUDITED.add('deleteRole');
/* Locking somebody's phone is the most consequential write this system has. */
AUDITED.add('deviceEnrol');
AUDITED.add('deviceSetState');
/* A read, audited: it hands out a handset credential, so who asked for which one is kept. */
AUDITED.add('deviceToken');
/* An eraser. Once this runs the audit entry is the only record that phone was ever here. */
AUDITED.add('deviceDelete');

const K = s => String(s == null ? '' : s).trim().toUpperCase();
const num = v => (typeof v === 'number' ? v : Number(v) || 0);

/* IS THIS LOAN STILL ON THE BOOK, ON A GIVEN DAY. The 45-day window (WINDOW_DAYS carries the
   owner's 2 days of calendar grace on top), measured against the day being ASKED ABOUT rather
   than against today -- so a week re-read next month keeps the bars it had at the time, and
   every locked-7 figure on every screen answers with the same arithmetic. */
const inWinOn = (r, day) => {
  const l = lifeDayOf(r.disbursed_date, day);
  return l != null && l <= WINDOW_DAYS;
};

/* WHAT SETTINGS ARE, AND WHY THIS IS ONE LIST RATHER THAN TWO.
   =======================================================================================
   `settings` decides what the pane SHOWS and `settingSet` decides what it may SAVE, and
   for a while those were two hand-kept copies of nearly the same array. They drifted, in
   the way two copies always do: the five DEVICE_* keys below were written up in
   docs/DEVICE-LOCKING.md as "these live in settings rather than in the APK", read by
   device-core.js on every heartbeat -- and were in neither list, so the pane never showed
   them and settingSet refused to write them. The number a stranded customer is told to
   call could not be set by anybody, from anywhere, and the doc said it could.

   The keys are also the pane's ORDER, top to bottom, so device settings sit together. */
const EDITABLE_SETTINGS = [
  'SYSTEM_OPEN', 'CALL_BRAND', 'CALL_LOGO_URL', 'FU_STATUSES',
  'CALL_SYNC_SECONDS', 'CALL_MIN_SECS', 'OFFLINE_PACK', 'SALES_DAILY_TARGET',
  // The locked handset's four lines, plus how long silence is forgiven. See device-core.js.
  'DEVICE_LOCK_BRAND', 'DEVICE_LOCK_MESSAGE', 'DEVICE_HELP_PHONE', 'DEVICE_LOCK_REASON',
  'DEVICE_OFFLINE_GRACE_HOURS',
];

/* =======================================================================================
   A PERSON TYPING SOMETHING WRONG IS NOT A SERVER FAILURE.

   Every `throw new Error(...)` in this file lands in withApi, which stamps anything without
   its own `.status` as a 500. Most of the throws here are validation -- "Weka IMEI", "Sababu
   inahitajika", "IMEI nyingi mno" -- so an officer forgetting a field was being recorded,
   and charted, as the server falling over. That is how a deployment ends up reporting a 9.5%
   failure rate while working exactly as designed, and it buries the failures that ARE real
   under a pile of the ones that are not.

   `bad()` is what a validation throw should have been all along: 400, the client's problem,
   with the same bilingual message the screen already shows. */
function bad(msg) {
  const e = new Error(msg); e.status = 400; throw e;
}

/* A table that has not been created yet. PostgREST says so in a few different ways depending
   on version, so this matches on what they all share rather than on one code. Used to let a
   pane whose migration has not been run read as EMPTY instead of throwing a 500 at somebody
   who has done nothing wrong except open it early. */
function tableMissing(err) {
  const s = String((err && (err.message || err.code)) || err || '');
  return /does not exist|Could not find the table|42P01|PGRST205/i.test(s);
}

function requireWrite(user) {
  if (isReadOnly(user)) {
    const e = new Error('Msimbo huu ni wa kuangalia tu. / This is a view-only code.'); e.status = 403; throw e;
  }
}
/* ADMIN sees all -- the same rule auth.js's resolveTabs and can() apply, repeated here so
   the portal's own gates can never drift from the enforcement (the owner's word, and the
   bug Hope once had when UI and gate read different rules). */
const isAdminRole = user => String((user && user.role) || '').trim().toUpperCase() === 'ADMIN';
function requireSettings(user) {
  if (isAdminRole(user)) return;
  if (!(user.tabs || []).includes('settings')) {
    const e = new Error('Settings permission is required.'); e.status = 403; throw e;
  }
}
const scopeQ = (user, q) => (user.teams && user.teams.length) ? q.in('team', user.teams.map(K)) : q;

/* ---------- PER-ROLE NAVIGATION -- the owner decides every pane ----------
   ONE list is the source of truth for which panes exist. A future nav is added HERE
   and nowhere else: the roles editor renders its checkbox from this list via
   accessCodes.navTabs, boot hands each user their allowed set, and requireNav
   enforces it -- UI and enforcement read the same rule.
   ADMIN holds everything; a read-only code (AUDITOR) SEES everything and changes
   nothing; a role whose tabs never chose any nav keeps the old defaults so existing
   codes do not go dark the day this shipped. */
/* No 'teams' pane: Hoop has no teams model. Fraud audit, Agent scorecards and Stock are
   THREE first-class panes (the owner's call), each grantable on its own; the retired
   'sales' key remains a stored alias that grants all three, so roles saved under it
   keep every door they had. */
/* 'devices' is the phone-locking registry's own pane. It is NOT folded into the 'sales'
   alias below with fraud/scorecards/stock/movement: locking somebody's phone is a
   different power from reading a stock report, and it is granted on purpose or not at
   all. ADMIN and AUDITOR still see every pane, as everywhere. */
const NAV_TABS = ['dashboard', 'customers', 'reports', 'recovery', 'fraud', 'scorecards', 'stock', 'movement', 'devices', 'staff', 'codes', 'settings'];
const LEGACY_NAVS = ['dashboard', 'customers', 'reports', 'recovery', 'staff'];
function navsFor(user) {
  if (isAdminRole(user) || isReadOnly(user)) return NAV_TABS.slice();
  const t = (user.tabs || []).map(x => String(x).toLowerCase());
  if (t.includes('sales')) t.push('fraud', 'scorecards', 'stock', 'movement');
  const chosen = NAV_TABS.filter(k => t.includes(k));
  // 'dashboard' and 'settings' were the OLD vocabulary too -- a role carrying only
  // those was saved before panes were choosable and must keep the old defaults, or
  // yesterday's codes go dark today. Any OTHER nav key means the owner chose deliberately.
  if (chosen.some(k => k !== 'dashboard' && k !== 'settings')) return chosen;
  const base = LEGACY_NAVS.slice();
  if (t.includes('settings')) base.push('codes', 'settings');
  if (t.includes('settings') || t.includes('upload')) base.push('fraud', 'scorecards', 'stock', 'movement');
  return base;
}
function requireNav(user, k) {
  if (!navsFor(user).includes(k)) {
    const e = new Error('Your role has no access to the ' + k + ' pane.');
    e.status = 403; throw e;
  }
}
/* Same rule, any ONE of several panes -- for an answer that legitimately appears on more
   than one screen. recoveryWeek is the first: it draws the Recovery pane's own trend AND
   the credit chart that sits on the DASHBOARD, so gating it on 'recovery' alone put an
   error string on the dashboard of anyone who holds dashboard without recovery. The data
   is the same team-scoped data either way; what differs is only which screen asked. */
function requireAnyNav(user, keys) {
  const have = navsFor(user);
  if (!keys.some(k => have.includes(k))) {
    const e = new Error('Your role has no access to the ' + keys[0] + ' pane.');
    e.status = 403; throw e;
  }
}


const dayShift = (key, days) =>
  new Date(Date.parse(key + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

/* Hope's phone-safe alphabet: no 0/O, no 1/I/L -- these get read out loud. */
const CODE_ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function mintCode(existing) {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)];
    if (!existing.has(c)) return c;
  }
  throw new Error('Could not mint a unique team code.');
}

/* A dashboard is opened in bursts (everyone at 8am); the trend is the same answer for
   all of them, so it is computed once every five minutes, not once per open. */
const trendCache = new Map();

/* =========================================================================================
   THE MONDAY PROBLEM -- why every weekly chart went blank this morning.

     "Locked 7+ -- wiki hii and Credit -- 7+ recovery kwa wiki are no longer dropping their
      graphs at dashboard, sales too"

   All three charts show a FIXED Monday-to-Sunday week, which is the right call: a rolling
   seven days shifts its own start every morning, so two people comparing the chart on
   different days would be comparing different weeks. But it has one ugly consequence nobody
   sees until it happens -- at 09:00 on a Monday the current week contains nothing at all,
   and every one of these cards renders empty. Sunday evening they were full. Nothing broke;
   the week simply turned over, and a dashboard that goes blank every Monday morning until
   somebody remembers to upload is a dashboard people stop opening.

   So: when nobody asked for a particular week and the current one has no data yet, these
   fall back to the newest week that DOES -- and say which week they are showing rather than
   quietly pretending it is this one. `weekOf` is that decision, made once here so the three
   charts cannot drift into disagreeing about which week the dashboard is looking at.

   Costs one bounded read (newest row, one column, indexed) and only when the caller did not
   name a week. An explicitly requested week is never overridden -- sliding back to a genuinely
   empty week must still show it empty, or the arrows would lie. */
const mondayOf = d => dayShift(d, -((new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay() + 6) % 7));

async function weekOf(db, user, args, table, col) {
  const asked = String((args && args.week) || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(asked)) {
    const from = mondayOf(asked);
    return { from, to: dayShift(from, 6), thisWeek: from === mondayOf(todayKey()), fellBack: false };
  }
  const thisMon = mondayOf(todayKey());
  let latest = null;
  try {
    const { data } = await scopeQ(user, db.from(table).select(col)
      .not(col, 'is', null).order(col, { ascending: false }).limit(1));
    latest = data && data[0] ? String(data[0][col]).slice(0, 10) : null;
  } catch (e) { latest = null; }        // never let the peek break the chart
  // Only ever slides BACKWARD. A stray future-dated row must not drag the dashboard
  // forward into a week that has not happened.
  const from = (latest && mondayOf(latest) < thisMon) ? mondayOf(latest) : thisMon;
  return { from, to: dayShift(from, 6), thisWeek: from === thisMon, fellBack: from !== thisMon };
}

const FNS = {
  /* =====================================================================================
     TIPS. Short notes keyed to a tab, held in the `hints` table so they can be written by
     whoever is training people rather than by whoever edits this file.

     Both languages come back in ONE payload and the phone picks a side, because the tip
     shown is chosen client-side by tab and by language -- a round trip per tip, for text
     this short, would be a request every few minutes for nothing.

     Ungated on purpose: a hint is public help text, and the tab it belongs to is already
     the tab this person is looking at. Budget: one small read, and the client asks once
     per sign-in. */
  async hints(db, user) {
    const rows = await fetchAll(() => db.from('hints').select('tab, message, sw_message'));
    const tips = { sw: {}, en: {} };
    const push = (bag, tab, msg) => {
      const k = String(tab || 'all').trim() || 'all';
      if (!msg) return;
      (bag[k] = bag[k] || []).push(String(msg));
    };
    for (const r of rows) {
      push(tips.en, r.tab, r.message);
      // A hint with no Swahili still shows in Swahili rather than vanishing -- half the
      // office reads that side, and a blank tip teaches nobody anything.
      push(tips.sw, r.tab, r.sw_message || r.message);
    }
    const s = await fetchAll(() => db.from('settings').select('key, value')
      .in('key', ['HINT_EVERY_SEC', 'HINT_HOLD_SEC']));
    const num = k => { const r = s.find(x => String(x.key) === k); const n = Number(r && r.value); return Number.isFinite(n) && n > 0 ? n : null; };
    return { ok: true, tips, everySec: num('HINT_EVERY_SEC') || 240, holdSec: num('HINT_HOLD_SEC') || 7 };
  },

  /* =====================================================================================
     THE BELL. What an officer wrote down, surfaced to whoever supervises them without
     anybody having to go looking in the Ripoti tab for it.

     SCOPED, NOT GLOBAL: scopeQ narrows to this code's own teams exactly as every other
     read here does, so a branch supervisor sees their branch and nobody else's.

     "Unseen" is per person and kept in `settings` under a key made from their access code
     -- a last-read watermark, not a per-row read flag. That is the whole mechanism: cheap,
     needs no new table, and cannot drift out of step with the rows themselves.
     Budget: one bounded read of the newest comments plus one keyed settings read. */
  async notifications(db, user) {
    const rows = await fetchAll(() => scopeQ(user, db.from('followup_comments')
      .select('imei, team, client_name, comment, fu_status, created_by, created_at')
      .order('created_at', { ascending: false }).limit(40)));
    const seenKey = 'NOTIF_SEEN_' + String(user.code || user.name || '').toUpperCase();
    const { data } = await db.from('settings').select('value').eq('key', seenKey).maybeSingle();
    const since = data && data.value ? Date.parse(String(data.value)) : 0;
    const items = rows.slice(0, 40).map(r => ({
      imei: r.imei, who: r.client_name || r.imei, team: r.team || '',
      what: r.comment || '', status: r.fu_status || '',
      by: r.created_by || '', at: r.created_at,
      unseen: !since || Date.parse(r.created_at) > since,
    }));
    return { ok: true, items, unseen: items.filter(i => i.unseen).length };
  },

  /* The watermark moves to NOW, not to the newest row shown. A comment written while the
     drawer was open would otherwise be marked read without ever having been on screen. */
  async notifSeen(db, user) {
    const seenKey = 'NOTIF_SEEN_' + String(user.code || user.name || '').toUpperCase();
    const { error } = await db.from('settings')
      .upsert({ key: seenKey, value: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async boot(db, user) {
    const [summary, teams] = await Promise.all([
      summaryFor(db, { name: user.name, role: user.role, teams: user.teams }, Date.now()),
      fetchAll(() => db.from('teams').select('team, team_code, rsm, rsm_no')),
    ]);
    const showCodes = (user.tabs || []).includes('settings') && !isReadOnly(user);
    return {
      name: user.name, role: user.role, tabs: user.tabs, readOnly: !!user.readOnly,
      navs: navsFor(user),
      teams: teams.filter(t => !user.teams || user.teams.some(x => K(x) === K(t.team)))
        .map(t => ({ team: t.team, code: showCodes ? (t.team_code || '') : (t.team_code ? '••••••' : ''),
          rsm: t.rsm || '', rsmNo: t.rsm_no || '' }))
        .sort((a, b) => a.team < b.team ? -1 : 1),
      summary,
      today: todayKey(),
    };
  },

  /** THE WEEK'S LOCKED 7+ TREND, for the dashboard graph: one point per upload day --
      how many customers were locked a week or more AND still inside Hoop's window that
      day. Deduped per (day, IMEI) so a same-day re-upload cannot double a bar; the
      window rule is applied per day, not per today, so history stays honest.
      Budget: ONE read, date-bounded at the database and narrowed to locked7 rows only,
      three columns; cached 5 minutes because a dashboard is opened in bursts. */
  async lockedTrend(db, user, args) {
    /* GATED, and it was not. This function had no requireNav of any kind, so any signed-in
       code could read the company's 7+ trend whatever its role -- not by design, just never
       written. Widened the same way recoveryWeek is rather than closed to 'recovery' alone,
       because the dashboard draws it too and gating it narrowly would put an error string on
       the dashboard of everyone who holds dashboard without recovery. */
    requireAnyNav(user, ['recovery', 'dashboard']);
    /* THE WEEK IS MONDAY TO SUNDAY, fixed -- not a rolling seven days that shifts its
       start every morning. Monday is always the first bar, so two people comparing the
       chart on different days are comparing the same week. Days not yet uploaded come
       back null and the chart draws them as gaps. */
    const wk = await weekOf(db, user, args, 'watu_snapshots', 'snapshot_date');
    const from = wk.from, to = wk.to, days = 7;
    const ck = 'trend:' + from + ':' + to + ':' + (user.teams ? user.teams.join(',') : 'ALL');
    const hit = trendCache.get(ck);
    if (hit && (Date.now() - hit.at) < 5 * 60000) return { ...hit.value, cached: true };
    const rows = await fetchAll(() => scopeQ(user, db.from('watu_snapshots')
      .select('imei, snapshot_date, disbursed_date')
      .eq('locked7', true).gte('snapshot_date', from).lte('snapshot_date', to)));
    /* BOTH HALVES, exactly as the tile above -- Watu's locked7 column (asked of the database
       directly) AND our 45-day window. The window is measured against EACH BAR'S OWN DAY, not
       against today, so Monday's bar is the book as it stood on Monday; re-reading a past week
       next month must not quietly shrink its bars as those customers age out. */
    const seen = new Map();
    for (const r of rows) {
      const d = String(r.snapshot_date).slice(0, 10);
      if (!inWinOn(r, d)) continue;
      if (!seen.has(d)) seen.set(d, new Set());
      seen.get(d).add(String(r.imei));
    }
    const points = [];
    for (let i = 0; i < days; i++) {
      const d = dayShift(from, i);
      points.push({ date: d, num: seen.has(d) ? seen.get(d).size : null });
    }
    const value = { ok: true, from, to, points, thisWeek: wk.thisWeek, fellBack: wk.fellBack };
    trendCache.set(ck, { at: Date.now(), value });
    return { ...value, cached: false };
  },

  /* =====================================================================================
     THE WEEK'S 7+ RECOVERY -- ONE READ, TWO PICTURES.

       "at recovery pane: how many 7+ reduced daily on week trend - graphical"
       "at dashboard add credit recovery - graphical ... like Monday someone recovered
        4 of 15 Tuesday 5 of 10 - to sunday"

     OFF JANA is the 7+ column read against YESTERDAY'S upload: whoever was 7-or-more days
     offline on the previous deck is the pool that had to be chased today. RECOVERED is that
     same IMEI's days_offline having FALLEN on today's deck. Both questions -- the daily
     count for the Recovery pane's chart, and the per-credit split for the dashboard -- come
     off the SAME rows, so this is ONE bounded read serving two charts rather than two reads
     answering nearly the same question.

     Budget: one read of watu_snapshots over Monday-minus-one .. Sunday, team-scoped, seven
     columns; plus rosterFull's single call_users read. Memoised five minutes per week and
     per scope, exactly like lockedTrend above. Adding the second chart costs nothing.

     The per-credit split runs dealMap -- the SAME stratified round-robin the handsets deal
     the book by -- cut on the PREVIOUS day's rows, because that is the book that was handed
     out that morning. So the assignment shown here is the assignment the officer actually
     had, not a fresh guess made at report time. */
  async recoveryWeek(db, user, args) {
    // Drawn on the Recovery pane AND on the dashboard -- see requireAnyNav.
    requireAnyNav(user, ['recovery', 'dashboard']);
    /* THE WEEK SLIDES, BACKWARD AND FORWARD -- the same rule Hope's dashboard settled on:
       any date is accepted and snapped to its own Monday, and a FUTURE week is not clamped
       back to this one -- it simply reads whatever has been uploaded for it and shows gaps
       where nothing has landed yet. The chosen Monday is echoed back (from/to/thisWeek) so
       the screen can label where it is standing and offer the way back.

       When NOBODY asked, weekOf falls back to the newest week with uploads -- see the note
       on the Monday problem above. An explicit week is always honoured as given. */
    const wk = await weekOf(db, user, args, 'watu_snapshots', 'snapshot_date');
    const from = wk.from, to = wk.to;
    /* THE BAR IS THE DAY THE WORK WAS DONE, NOT THE DAY THE RESULT LANDED.
         "since the reduced customers we saw today are of monday put them on monday, those we
          observe tomorrow will be of tuesday. its confusing to see yesterdays work on tuesday
          bar graph for credits"

       Exactly right, and it was backwards. Monday morning the officer is handed MONDAY's list
       and chases it all Monday; TUESDAY's upload is merely when the result becomes visible.
       Bucketing by the day the result arrived put Monday's work on Tuesday's bar.

       So a day's pool is taken from that day's OWN upload, and its result is read from the
       NEXT upload -- which means the window has to run PAST Sunday to see Sunday's result,
       where it used to run one day before Monday.

       HOW FAR PAST SUNDAY, and why it is not one day:
         "sometimes its a holiday like they worked in monday and didnt come to work on
          tuesday ... so to capture recovery we should look to the next day upload evenif
          there is a day skipped but the next one [but not the last one!]"

       Nobody uploads on Maulid, or on a Sunday, or the day the office is shut. The result of
       Friday's chasing then lands in MONDAY's deck, not Saturday's. With only one day of
       lookahead that result was invisible and the day sat PENDING for good -- work done,
       credited to nobody, because the calendar had a hole in it.

       So the read runs a further week past Sunday. What it does NOT do is jump to the newest
       deck: nextOf() below takes the EARLIEST upload after the day in question, which is the
       owner's "the next one, not the last one". Reading Monday's recovery off Friday's deck
       would fold four days of other people's work into Monday's number.

       Cost: the same single indexed read over a wider date bound. */
    const readTo = dayShift(from, 14);
    const ck = 'recweek2:' + from + ':' + (user.teams ? user.teams.join(',') : 'ALL');
    const hit = trendCache.get(ck);
    if (hit && (Date.now() - hit.at) < 5 * 60000) return { ...hit.value, cached: true };

    const COLS = 'imei, snapshot_date, days_offline, created_at, disbursed_date, locked7, locked4';
    const [rows, roster] = await Promise.all([
      fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS)
        .gte('snapshot_date', from).lte('snapshot_date', readTo))),
      rosterFull(db),
    ]);

    // A same-date re-upload appends; the newest row per IMEI within the day wins -- the same
    // rule recovery() applies, so the two screens cannot disagree about a re-uploaded day.
    const byDay = new Map();
    for (const r of rows) {
      const d = String(r.snapshot_date).slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, new Map());
      const m = byDay.get(d), k = String(r.imei), had = m.get(k);
      if (!had || String(r.created_at) > String(had.created_at)) m.set(k, r);
    }
    const dates = [...byDay.keys()].sort();
    const nextOf = d => { for (const x of dates) if (x > d) return x; return null; };

    const points = [];
    const credits = new Map();
    for (const id of roster.ids) credits.set(String(id), { userId: String(id), name: roster.names[id] || '', days: {} });

    for (let i = 0; i < 7; i++) {
      const d = dayShift(from, i);                 // the day the list was WORKED
      // Nobody uploaded that day: a GAP, never a zero. "nobody uploaded" and "nobody
      // recovered" are different facts and must not look alike on a chart people act on.
      if (!byDay.has(d)) { points.push({ date: d, offJana: null, reduced: null, pending: false }); continue; }
      /* THE POOL IS THE COLUMN, INSIDE THE WINDOW. The `days_offline >= 7` half was a
         calculation of ours standing in for a fact Watu had already published, and it did not
         agree with it -- on the owner's deck Days Offline is filled on 899 rows while Locked
         7+ is filled on 2,385, so a customer Watu had flagged could be missing from this pool
         entirely just because their offline count was blank. The window half was never the
         problem and stays: a loan past day 45 is off the book, locked or not.

         Measured against THAT DAY, not today, so a past week keeps the bars it had.

         Recovery is still MEASURED by days_offline falling, further down -- that is how you
         see somebody come back. It is only "who was on the list" that the column answers. */
      const offJana = [...byDay.get(d).values()]
        .filter(r => r.locked7 === true && inWinOn(r, d));

      /* The result of that day's chasing shows up in the NEXT upload. Until it exists the day
         is PENDING, not a failure: today's officers have done the work and the answer simply
         is not in yet. Reporting that as 0 recovered would put a zero against people who are
         still waiting on tomorrow's file. */
      const n = nextOf(d);
      const nextRows = n ? byDay.get(n) : null;
      const recovered = new Set();
      if (nextRows) {
        for (const o of offJana) {
          const c = nextRows.get(String(o.imei));
          if (c && num(c.days_offline) < num(o.days_offline)) recovered.add(String(o.imei));
        }
      }
      points.push({ date: d, offJana: offJana.length,
        reduced: nextRows ? recovered.size : null, pending: !nextRows });

      // The deal that was in force THAT morning, cut on that morning's own book.
      const deal = dealMap(offJana, roster.ids, d);
      for (const o of offJana) {
        const uid = deal[String(o.imei)];
        const slot = uid && credits.get(String(uid));
        if (!slot) continue;
        if (!slot.days[d]) slot.days[d] = { assigned: 0, recovered: 0, pending: !nextRows };
        slot.days[d].assigned++;
        if (recovered.has(String(o.imei))) slot.days[d].recovered++;
      }
    }

    const value = { ok: true, from, to, points, credits: [...credits.values()], thisWeek: wk.thisWeek, fellBack: wk.fellBack };
    trendCache.set(ck, { at: Date.now(), value });
    return { ...value, cached: false };
  },

  /* THE EYE ON EACH DAY -- who exactly those customers were.
       "add an eye/view option ... to show which customers are those - listing them - so it
        should be placed on end of each dayname to view of each day independently"
       "i beleive that customer row info will show the credit name too"

     LAZY ON PURPOSE. The chart's own answer carries counts and nothing else; this list is
     fetched only when somebody actually opens a day. Folding every day's names into
     recoveryWeek would ship a few thousand rows to EVERY dashboard load to serve a panel
     that is opened occasionally -- counts are what a chart draws, names are what a question
     needs, and they should not travel together.

     Every row says who held it: the credit officer comes from the same dealMap cut on the
     same previous-day book the chart counted, so the name here and the bar there cannot
     disagree about who was chasing whom.

     Budget: two bounded, team-scoped reads (the day, and the upload before it), plus the
     already-cached roster and agent index. Nothing at all on the dashboard's own load. */
  async recoveryDayList(db, user, args) {
    requireNav(user, 'recovery');
    const day = String((args && args.date) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('date is required');
    /* FORWARD, not back -- the eye has to show what its own bar counted. A day's pool is that
       day's OWN list (the one the officer worked), and the result is read from the NEXT
       upload. Looking backwards here would list a different set of customers than the bar
       above it was drawn from, which is worse than showing nothing. */
    const two = await db.from('watu_snapshots').select('snapshot_date')
      .gt('snapshot_date', day).order('snapshot_date', { ascending: true }).limit(1);
    if (two.error) throw new Error(two.error.message);
    const next = (two.data && two.data[0] && String(two.data[0].snapshot_date).slice(0, 10)) || null;

    const COLS = 'imei, client_name, team, days_offline, created_at, disbursed_date, locked7, locked4';
    const [old, cur, roster, idx] = await Promise.all([
      fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS).eq('snapshot_date', day))),
      next ? fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS).eq('snapshot_date', next)))
           : Promise.resolve([]),
      rosterFull(db),
      agentIndex(db, Date.now()).catch(() => null),
    ]);
    // A same-date re-upload appends; newest row per IMEI wins -- the same rule everywhere else.
    const newest = list => {
      const m = new Map();
      for (const r of list) {
        const k = String(r.imei), had = m.get(k);
        if (!had || String(r.created_at) > String(had.created_at)) m.set(k, r);
      }
      return m;
    };
    const curM = newest(cur), oldM = newest(old);
    // The same pool the chart above counts, by the same rule: Watu's column AND our window,
    // measured against the day this list belongs to. If these two ever disagree, the chart
    // and the names under it are describing different books.
    const offJana = [...oldM.values()].filter(r => r.locked7 === true && inWinOn(r, day));
    const deal = dealMap(offJana, roster.ids, day);
    const out = offJana.map(o => {
      const c = next ? curM.get(String(o.imei)) : null;
      const was = num(o.days_offline);
      const now = c ? num(c.days_offline) : null;
      const uid = deal[String(o.imei)];
      const a = idx && idx.byImei && idx.byImei[String(o.imei)];
      return {
        imei: o.imei, name: o.client_name || '',
        branch: (a && a.branch) || o.team || '',
        credit: (uid && roster.names[String(uid)]) || '',
        was, now, recovered: now != null && now < was,
        // Not on the next upload at all. Only meaningful once that upload exists.
        gone: !!next && !c,
      };
    }).sort((x, y) => (y.recovered - x.recovered) || (y.was - x.was));
    return { ok: true, date: day, next, pending: !next, rows: out,
      counts: { offJana: out.length, recovered: out.filter(r => r.recovered).length } };
  },

  async report(db, user, args) {
    requireNav(user, 'reports');
    const a = args || {};
    let scope = user.teams;
    const want = String(a.team || '').trim();
    if (want && (!scope || scope.some(t => K(t) === K(want)))) scope = [want];
    const out = await reportCore(db, scope, a.from, a.to, null, Date.now());
    out.scope = scope || 'ALL';
    return out;
  },

  /* =====================================================================================
     DAILY SALES PERFORMANCE -- one week, pivoted four ways, against a target.
     =====================================================================================
       "Pivot for all: for General duty person, RSMs, Commission agents and company grand
        totals. i want to set up target in settings so we see sales performances over set
        target"

     One read of the week's hoop_sales rows answers all four pivots -- the whole point of
     a pivot is that it is the SAME rows counted by a different key, so this must never be
     four reads. Each pivot returns one row per name with a per-weekday count and amount
     (Mon-Sun, the same fixed week the credit charts use, so the two dashboards read alike)
     plus the week total; the company pivot is the same shape with one row.

     THE TARGET is SALES_DAILY_TARGET from settings (TZS/day, blank = none). It is a DAILY
     figure, so a week's target is target x (the number of days that actually had a sale is
     NOT how it works -- a target is a standing daily expectation), i.e. target x 7 for the
     week, and each day's bar is measured against the one daily target. Sent alongside so
     every screen draws the same line without re-reading the setting.

     Attribution, per the answer:
       general duty  recorded_by if the shop export ever carries it, else uploaded_by (who
                     LOADED the day's book) -- the honest general-duty signal there is today
       rsm           the AGENT column (the record-holding RSM / team leader)
       agent         commission_agent (the seller owed the commission)
       company       every sale, one row

     Roster follows the DATA, not a stored list -- a name appears the first day it sells and
     leaves when it stops, so "they will auto update by role assignements made" needs no
     wiring here: whoever the shop books credit is whoever shows up.

     Budget: one team-scoped, date-bounded read of hoop_sales (nine columns) + one settings
     read for the target. Memoised five minutes per week and scope, exactly like the trend. */
  /* =====================================================================================
     SALES ARE COUNTED FROM THE WATU DECK, NOT THE SALES UPLOAD.

       "Use disb date and price in watu deck as sales data: so ship/overwite the lifetime
        sales to read from dates by checking the watudeck for sales report, leave the sales
        upload as it is b/se there is info we need and will stay need from there, we just
        shifting where to read sales from"

     A phone leaving the shop and a phone appearing in Watu's book are the same event, and
     Watu's book is the one that decides what was actually financed. Disbursed Date is when
     it happened and Price is what it was worth, both already in the file the deck is built
     from. So the figures come from there and the sales upload stops being the source of any
     headline number.

     THE UPLOAD IS NOT RETIRED, and must not be. salesAudit compares the shop's book AGAINST
     Watu to find sales Watu never saw (HAKUNA_WATU) and agents who do not match (DRIFT);
     agentScore deliberately keeps a Watu side and a payout side unmerged. Point either at
     the Watu deck and it compares Watu with Watu, finds nothing by construction, and the
     fraud detection quietly stops working. Those two keep reading hoop_sales, which is also
     the only place commission_agent, commission_phone and the receipt live.

     ONE CONSEQUENCE WORTH KNOWING: a phone sold today reaches Watu's file tomorrow, so these
     figures follow the deck rather than the till. Yesterday is complete; today is partial
     until the next upload.

     THE PIVOTS HAD TO BE REMAPPED, not simply repointed. The sales upload carries three
     different people per sale (who recorded it, the agent, the commission earner); the Watu
     deck carries one, its own `agent`. So the four cuts are now: company, agent (Watu's own),
     branch, and shop/team -- each of which the deck can actually answer. */
  async salesWeek(db, user, args) {
    requireNav(user, 'scorecards');
    // Same Monday-problem fallback as the two recovery charts: a sales board that reads blank
    // every Monday morning until somebody uploads is one people stop opening.
    const wk = await weekOf(db, user, args, 'watu_loans', 'disbursed_date');
    const from = wk.from, to = wk.to;
    const ck = 'salesweek:watu:' + from + ':' + (user.teams ? user.teams.join(',') : 'ALL');
    const hit = trendCache.get(ck);
    if (hit && (Date.now() - hit.at) < 5 * 60000) return { ...hit.value, cached: true };

    // branch arrived with a later migration; a database without it refuses the whole select,
    // so fall back to the columns that were always there.
    const FULL = 'imei, disbursed_date, price, agent, agent_id, team, branch';
    const BARE = 'imei, disbursed_date, price, agent, agent_id, team';
    let raw;
    try {
      raw = await fetchAll(() => scopeQ(user, db.from('watu_loans').select(FULL)
        .gte('disbursed_date', from).lte('disbursed_date', to)));
    } catch (e) {
      if (!/branch/i.test(String(e && e.message))) throw e;
      raw = await fetchAll(() => scopeQ(user, db.from('watu_loans').select(BARE)
        .gte('disbursed_date', from).lte('disbursed_date', to)));
    }
    /* Named sale_date downstream so every pivot, the day map and the screen keep working off
       one shape -- the source moved, the vocabulary did not. */
    const rows = raw.filter(r => r.disbursed_date)
      .map(r => ({ ...r, sale_date: String(r.disbursed_date).slice(0, 10) }));

    const { data: sRows } = await db.from('settings').select('value').eq('key', 'SALES_DAILY_TARGET').maybeSingle();
    const dailyTarget = num((sRows && sRows.value) || 0) || null;

    const days = [];
    for (let i = 0; i < 7; i++) days.push(dayShift(from, i));
    const txt = v => { const s = String(v == null ? '' : v).trim(); return s || null; };
    const keyFns = {
      // Kept under their old names so the screen's pivot buttons need no rewiring; what each
      // one MEANS is now whatever the Watu deck can actually answer.
      general: r => txt(r.team) || '(haijulikani / unknown)',      // the shop location
      rsm:     r => txt(r.branch) || txt(r.team) || '(no branch)', // branch, where recorded
      agent:   r => txt(r.agent) || '(no agent)',                  // Watu's own agent
    };
    const pivot = keyFn => {
      const by = new Map();
      for (const r of rows) {
        const name = keyFn(r);
        const d = String(r.sale_date).slice(0, 10);
        if (!by.has(name)) by.set(name, { name, days: {}, count: 0, amount: 0 });
        const slot = by.get(name);
        if (!slot.days[d]) slot.days[d] = { count: 0, amount: 0 };
        slot.days[d].count++; slot.days[d].amount += num(r.price);
        slot.count++; slot.amount += num(r.price);
      }
      return [...by.values()].sort((a, b) => b.amount - a.amount);
    };
    // The company pivot: the same shape with one row, so the screen draws it identically.
    const companyDays = {};
    for (const r of rows) {
      const d = String(r.sale_date).slice(0, 10);
      if (!companyDays[d]) companyDays[d] = { count: 0, amount: 0 };
      companyDays[d].count++; companyDays[d].amount += num(r.price);
    }
    const value = {
      ok: true, from, to, days, thisWeek: wk.thisWeek, fellBack: wk.fellBack,
      dailyTarget, weekTarget: dailyTarget ? dailyTarget * 7 : null,
      general: pivot(keyFns.general),
      rsm: pivot(keyFns.rsm),
      agent: pivot(keyFns.agent),
      company: { days: companyDays,
        count: rows.length, amount: rows.reduce((s, r) => s + num(r.price), 0) },
    };
    trendCache.set(ck, { at: Date.now(), value });
    return { ...value, cached: false };
  },

  /* RECOVERY -- who came back after our calls. The newest two uploads, diffed per IMEI:
     paid for the first time, reconnected (days_offline fell), or sank deeper. */
  async recovery(db, user) {
    requireNav(user, 'recovery');
    const one = await db.from('watu_snapshots').select('snapshot_date')
      .order('snapshot_date', { ascending: false }).limit(1);
    if (one.error) throw new Error(one.error.message);
    const latest = one.data && one.data[0] && String(one.data[0].snapshot_date).slice(0, 10);
    if (!latest) return { ok: true, latest: null, prev: null, rows: [], counts: null };
    const two = await db.from('watu_snapshots').select('snapshot_date')
      .lt('snapshot_date', latest).order('snapshot_date', { ascending: false }).limit(1);
    const prev = two.data && two.data[0] && String(two.data[0].snapshot_date).slice(0, 10);
    if (!prev) return { ok: true, latest, prev: null, rows: [], counts: null,
      note: 'Upload mbili zinahitajika kupima recovery — hii ni ya kwanza. / Recovery needs two uploads; this is the first.' };
    // client_mobile, NOT contact -- snapshots carry the importer's own column names.
    const COLS = 'imei, client_name, client_mobile, team, days_offline, has_ever_paid, price, created_at';
    /* THE BRANCH IS THE LOCATION, HERE TOO. watu_snapshots carries only the shop-derived
       `team` -- teamFromShop() turns "Hoop Limited, Kinondoni" into KINONDONI, so every row
       of this table reads KINONDONI and the Recovery board looked like one branch owned the
       whole country. The offline-queue register knows the REAL branch per IMEI, and
       agentIndex already holds it keyed that way, cached against DATA_VERSION -- so this is
       the same overlay Wateja and the phone list already do, not a new read shape. Allowed
       to fail quietly: a missing index must cost the branch column, never the board. */
    const [cur, old, idx] = await Promise.all([
      fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS).eq('snapshot_date', latest))),
      fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS).eq('snapshot_date', prev))),
      agentIndex(db, Date.now()).catch(() => null),
    ]);
    const branchOf = imei => {
      const a = idx && idx.byImei && idx.byImei[String(imei)];
      return (a && a.branch) || '';
    };
    // A same-date re-upload appends; the newest row per IMEI within the day wins.
    const byImei = rows => {
      const m = new Map();
      for (const r of rows) {
        const k = String(r.imei);
        const had = m.get(k);
        if (!had || String(r.created_at) > String(had.created_at)) m.set(k, r);
      }
      return m;
    };
    const curM = byImei(cur), oldM = byImei(old);
    /* EVERY TILE ON THIS PANE NOW HAS ITS ROWS, and three of them never did. `deeper` and
       `leftList` were counted and thrown away, so the two numbers that mean somebody has
       got WORSE were the two you could not act on -- a screen that names the people coming
       back and hides the ones sinking has it exactly the wrong way round.

       One `kind` per row and one list, filtered on the client, rather than four arrays:
       a customer is in exactly one of these buckets, and four arrays is four chances for
       the same IMEI to appear twice with different arithmetic behind it. */
    const rows = [];
    let paidNew = 0, reconnected = 0, deeper = 0, off = 0;
    const put = (kind, imei, r, was, now, paid) => rows.push({ kind, imei,
      name: r.client_name, team: r.team, branch: branchOf(imei),
      was, now, paid: paid === true, price: num(r.price) });
    for (const [imei, c] of curM) {
      const o = oldM.get(imei);
      if (!o) continue;
      const paid = o.has_ever_paid === false && c.has_ever_paid === true;
      const dOld = num(o.days_offline), dNew = num(c.days_offline);
      const better = dNew < dOld, worse = dNew > dOld;
      if (paid) paidNew++;
      if (better) reconnected++;
      if (worse) deeper++;
      // paid outranks better outranks worse: a customer who paid for the first time is
      // that, whatever their offline count did in the same week.
      if (paid) put('paid', imei, c, dOld, dNew, true);
      else if (better) put('better', imei, c, dOld, dNew, false);
      else if (worse) put('worse', imei, c, dOld, dNew, false);
    }
    for (const [imei, o] of oldM) {
      if (curM.has(imei)) continue;
      off++;
      // No `now` to report: they are not on today's deck at all, which is the whole fact.
      put('left', imei, o, num(o.days_offline), null, false);
    }
    /* Sorted so that whichever slice is on screen opens on its most urgent row: the ones
       who came back furthest, and the ones who sank deepest. */
    const RANK = { paid: 0, better: 1, worse: 2, left: 3 };
    rows.sort((a, b) => (RANK[a.kind] - RANK[b.kind])
      || Math.abs(num(b.was) - num(b.now)) - Math.abs(num(a.was) - num(a.now)));
    /* Capped, and the cap is REPORTED. A truncated list that says nothing reads as a short
       list, and on this pane that would mean "only nine people slipped" when it was ninety. */
    const CAP = 800;
    return { ok: true, latest, prev,
      counts: { compared: [...curM.keys()].filter(k => oldM.has(k)).length,
        paidNew, reconnected, deeper, leftList: off },
      notListed: Math.max(0, rows.length - CAP),
      rows: rows.slice(0, CAP) };
  },

  /** THE CUSTOMERS BOOK, split the way Hoop reads it: today's deck inside the 45-day
      window, today's deck beyond it (Hoop's burden has lapsed), and yesterday's (jana).
      The AGENT rides on every row -- who sold the phone is who to lean on, the same
      slot the guarantor held in Hope.
      Budget: 2 tiny indexed date lookups + 1 deck read + 1 prev-day snapshot read +
      1 register read (six columns, with a pre-migration fallback) + 1 bounded
      hoop_agents read (agent phones), all team-scoped; FU vocabulary is 1 keyed read. */
  async customers(db, user) {
    requireNav(user, 'customers');
    const today = todayKey();
    const d1 = await db.from('followup_status').select('deck_date').not('deck_date', 'is', null)
      .order('deck_date', { ascending: false }).limit(1);
    if (d1.error) throw new Error(d1.error.message);
    const deckDate = d1.data && d1.data[0] ? String(d1.data[0].deck_date).slice(0, 10) : null;
    let prevDate = null;
    if (deckDate) {
      const d2 = await db.from('watu_snapshots').select('snapshot_date').lt('snapshot_date', deckDate)
        .order('snapshot_date', { ascending: false }).limit(1);
      prevDate = d2.data && d2.data[0] ? String(d2.data[0].snapshot_date).slice(0, 10) : null;
    }
    const [deck, prev, agents, hoopAgents, fu] = await Promise.all([
      // deck_date rides along so the deal's per-deck shuffle keys on the DECK's date --
      // Wateja must name the same holders the handsets show, stale deck included.
      deckDate ? fetchAll(() => scopeQ(user, db.from('followup_status')
        .select('imei, client_name, contact, team, model, price, disbursed_date, days_offline, locked4, locked7, has_ever_paid, fu_status, comment_by, deck_date')
        .eq('deck_date', deckDate))) : [],
      prevDate ? fetchAll(() => scopeQ(user, db.from('watu_snapshots')
        .select('imei, client_name, client_mobile, team, model, price, disbursed_date, days_offline, locked4, locked7, has_ever_paid, agent, created_at')
        .eq('snapshot_date', prevDate))) : [],
      // Guarantor + branch arrived with the offline queue; before the migration the
      // whole select is refused for them, so fall back to the old three columns.
      fetchAll(() => scopeQ(user, db.from('watu_loans')
        .select('imei, agent, team, branch, guarantor_name, guarantor_phone')))
        .catch(() => fetchAll(() => scopeQ(user, db.from('watu_loans').select('imei, agent, team')))),
      // The SHARED agent index: Sipho's register plus the sales report's payout
      // numbers, token-sorted names -- the same phones the app's card resolves.
      agentIndex(db, Date.now()),
      fuStatusConfig(db),
    ]);
    const regOf = {};
    agents.forEach(r => { regOf[r.imei] = r; });
    const agPhone = hoopAgents.phoneByName || {};
    /* THE SAME STRATIFIED DEAL THE PHONES RUN, shown to the office -- so Wateja names
       who is chasing whom exactly as the handsets see it, tab-equal cuts included, and
       re-deals itself the moment a credit user is added or switched off. One extra
       bounded call_users read. */
    const rosterAll = await rosterFull(db);
    const dealt = dealMap(deck, rosterAll.ids, today);
    const holdsOf = {};
    for (const k of Object.keys(dealt)) holdsOf[k] = rosterAll.names[dealt[k]] || '';
    const mk = (r, contactKey, refDay) => {
      const reg = regOf[r.imei] || {};
      const agent = r.agent !== undefined ? (r.agent || '') : (reg.agent || '');
      return {
        imei: r.imei, name: r.client_name || '', phone: r[contactKey] || '',
        team: r.team || '', branch: reg.branch || '',
        model: r.model || '', price: num(r.price),
        agent, agentPhone: agent ? (agPhone[nameKey(agent)] || '') : '',
        gName: reg.guarantor_name || '', gPhone: reg.guarantor_phone || '',
        heldBy: holdsOf[String(r.imei)] || '',
        daysOff: r.days_offline == null ? null : num(r.days_offline),
        locked7: r.locked7 === true, locked4: r.locked4 === true, paid: r.has_ever_paid === true,
        fu: r.fu_status || '', lifeDay: lifeDayOf(r.disbursed_date, refDay),
        inWindow: (() => { const l = lifeDayOf(r.disbursed_date, refDay); return l != null && l <= WINDOW_DAYS; })(),
      };
    };
    // jana: a same-date re-upload appends, so the newest row per IMEI within the day wins.
    const seen = new Map();
    prev.forEach(r => {
      const had = seen.get(r.imei);
      if (!had || String(r.created_at) > String(had.created_at)) seen.set(r.imei, r);
    });
    const jana = [...seen.values()].map(r => mk(r, 'client_mobile', prevDate));
    const leo = deck.map(r => mk(r, 'contact', today));
    // WINDOW_DAYS, not 45: the 2-day calendar grace (months vary) keeps every customer
    // Watu still counts -- "i have 49 and they had 52" must never happen again.
    const inWindow = leo.filter(r => r.inWindow);
    const beyond = leo.filter(r => !r.inWindow);
    const bySunk = (a, b) => num(b.daysOff) - num(a.daysOff);
    inWindow.sort(bySunk); beyond.sort(bySunk); jana.sort(bySunk);
    return { ok: true, deckDate, prevDate, leo45: inWindow, leo45plus: beyond, jana, ...fu };
  },

  /** EVERYONE COMMENTS. Any signed-in portal user except a view-only code can log a
      follow-up on any customer inside their team scope -- same three writes as the
      phone's addComment, actor = the access code's name. */
  async portalAddComment(db, user, args) {
    requireWrite(user);
    const a = args || {};
    const ref = String(a.imei || '').trim();
    if (!ref) bad('IMEI is required.');
    if (user.teams && a.team && !user.teams.some(t => K(t) === K(a.team))) {
      // Not 400: nothing is wrong with what they typed -- they are simply not allowed it.
      const e = new Error('Mteja huyu yuko nje ya timu zako. / That customer is outside your teams.');
      e.status = 403; throw e;
    }
    if (!a.fu && !String(a.comment || '').trim()) bad('Chagua hali au andika maoni. / Pick a status or write a comment.');
    const now = new Date().toISOString();
    const { error: sErr } = await db.from('followup_status')
      .upsert({ imei: ref, team: a.team ? K(a.team) : null, client_name: a.name || null },
        { onConflict: 'imei', ignoreDuplicates: true });
    if (sErr) throw new Error(sErr.message);
    const { error: cErr } = await db.from('followup_comments').insert({
      imei: ref, team: a.team ? K(a.team) : null, client_name: a.name || null,
      comment: a.comment || null, fu_status: a.fu || null,
      promise_date: a.promiseDate || null, promise_amt: a.promiseAmt || null,
      created_by: user.name, created_at: now });
    if (cErr) throw new Error(cErr.message);
    const { error: uErr } = await db.from('followup_status').update({
      fu_status: a.fu || null, promise_date: a.promiseDate || null, promise_amt: a.promiseAmt || null,
      last_comment: a.comment || null, comment_by: user.name, comment_at: now, updated_at: now,
    }).eq('imei', ref);
    if (uErr) throw new Error(uErr.message);
    return { ok: true, imei: ref, savedAt: now };
  },

  async customerComments(db, user, args) {
    const ref = String((args && args.imei) || '').trim();
    if (!ref) throw new Error('IMEI is required.');
    const { data, error } = await db.from('followup_comments')
      .select('comment, fu_status, promise_date, created_by, created_at')
      .eq('imei', ref).order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return { ok: true, items: data || [] };
  },

  /* ============ MAUZO: the fraud audit and the agent scorecards (phase 2) ============
     The owner's loop: general duty's sales book diffed against Watu's records finds
     the sale nobody financed; Sipho's register names who answers for it; the daily
     follow-up files say how each agent's customers BEHAVE. */

  /** Every general-duty sale in the window, judged: OK (IMEI in the Watu register),
      DRIFT (in Watu but under a different agent than the commission claims), PENDING
      (not in Watu yet, but too fresh to accuse -- a loan can land a day late), BULK
      (not in Watu, and the buyer phone bought 3+ -- a cash/bulk sale to label, not
      accuse), HAKUNA WATU (not in Watu, old enough to answer for). Every flagged row
      resolves its seller against hoop_agents by payout phone.
      Budget: 3 parallel bounded reads -- sales by date range, the register
      (imei+agent+agent_id only, the whole portfolio, paged), agents (~1k rows). */
  async salesAudit(db, user, args) {
    requireNav(user, 'fraud');
    const a = args || {};
    const today = todayKey();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(a.to || '')) ? a.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(a.from || '')) ? a.from : dayShift(today, -30);
    const [sales, reg, agents] = await Promise.all([
      fetchAll(() => db.from('hoop_sales')
        .select('sale_key, sale_date, receipt_number, client_name, client_phone, imei, model, price, agent, commission_agent, commission_phone')
        .gte('sale_date', from).lte('sale_date', to)),
      fetchAll(() => db.from('watu_loans').select('imei, agent, agent_id')),
      fetchAll(() => db.from('hoop_agents').select('phone, name, national_id, kin_name, kin_phone, role, branch')),
    ]);
    const regBy = new Map(reg.map(r => [String(r.imei), r]));
    const agBy = new Map(agents.map(r => [pnorm(r.phone), r]));
    const freshLine = dayShift(today, -2);          // sale younger than this: too fresh to accuse
    const words = s => new Set(String(s || '').toUpperCase().split(/\s+/).filter(Boolean));
    const overlap = (x, y) => { for (const w of words(x)) if (words(y).has(w)) return true; return false; };
    const notInWatu = sales.filter(s => !regBy.has(String(s.imei)));
    const buyerCount = {};
    notInWatu.forEach(s => { const k = pnorm(s.client_phone); if (k) buyerCount[k] = (buyerCount[k] || 0) + 1; });
    const rows = sales.map(s => {
      const w = regBy.get(String(s.imei)) || null;
      let status;
      if (w) status = (s.commission_agent && w.agent && !overlap(s.commission_agent, w.agent)) ? 'DRIFT' : 'OK';
      else if ((buyerCount[pnorm(s.client_phone)] || 0) >= 3) status = 'BULK';
      else if (String(s.sale_date) >= freshLine) status = 'PENDING';
      else status = 'HAKUNA_WATU';
      const reg2 = agBy.get(pnorm(s.commission_phone)) || null;
      return { saleKey: s.sale_key, date: s.sale_date, receipt: s.receipt_number || '',
        client: s.client_name || '', phone: s.client_phone || '', imei: s.imei,
        model: s.model || '', price: num(s.price), seller: s.commission_agent || s.agent || '',
        sellerPhone: s.commission_phone || '', watuAgent: w ? (w.agent || '') : null,
        watuAgentId: w ? (w.agent_id || '') : null, status,
        reg: reg2 ? { name: reg2.name, nid: reg2.national_id || '', kin: reg2.kin_name || '',
          kinPhone: reg2.kin_phone || '', role: reg2.role || '', branch: reg2.branch || '' } : null };
    });
    const RANK = { HAKUNA_WATU: 0, DRIFT: 1, BULK: 2, PENDING: 3, OK: 4 };
    rows.sort((x, y) => (RANK[x.status] - RANK[y.status]) || (x.date < y.date ? 1 : -1));
    const count = k => rows.filter(r => r.status === k).length;
    return { ok: true, from, to,
      counts: { total: rows.length, ok: count('OK'), drift: count('DRIFT'),
        pending: count('PENDING'), bulk: count('BULK'), candidates: count('HAKUNA_WATU') },
      rows: rows.slice(0, 500) };
  },

  /** Two scoreboards, deliberately NOT merged -- the identities live in different
      systems and a fuzzy merge would lie. WATU side (keyed on Watu's own Agent ID):
      how each agent's customers behave -- % ever paid, % locked, days offline, past-45
      count. SALES side (keyed on normalized payout phone): sales counted per
      commission earner, with the hoop_agents identity attached.
      Budget: 3 parallel bounded reads -- register (scoped), sales by range, agents. */
  async agentScore(db, user, args) {
    requireNav(user, 'scorecards');
    const a = args || {};
    const today = todayKey();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(a.to || '')) ? a.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(a.from || '')) ? a.from : dayShift(today, -90);
    const [reg, sales, agents] = await Promise.all([
      // BRANCH, not the deck's shop-derived team: "Kinondoni" is a company location, and
      // the real branch rides the offline queue. Pre-migration databases fall back.
      fetchAll(() => scopeQ(user, db.from('watu_loans')
        .select('imei, agent, agent_id, team, branch, has_ever_paid, locked4, locked7, days_offline, disbursed_date')))
        .catch(() => fetchAll(() => scopeQ(user, db.from('watu_loans')
          .select('imei, agent, agent_id, team, has_ever_paid, locked4, locked7, days_offline, disbursed_date')))),
      fetchAll(() => db.from('hoop_sales')
        .select('commission_agent, commission_phone, sale_date, price')
        .gte('sale_date', from).lte('sale_date', to)),
      fetchAll(() => db.from('hoop_agents').select('phone, name, role, branch, kin_name, kin_phone')),
    ]);
    // The agent's OWN location is what Sipho's register says (token-sorted match, so a
    // name written in either order still finds them); their customers' branches are the
    // fallback and the second line of the story.
    const regByName = new Map(agents.filter(a => a.name).map(a => [nameKey(a.name), a]));
    const byAgent = new Map();
    for (const r of reg) {
      const key = String(r.agent_id || K(r.agent) || '?');
      let g = byAgent.get(key);
      if (!g) { g = { agent: r.agent || '', agentId: r.agent_id || '', teams: new Set(),
        customers: 0, paid: 0, locked4: 0, locked7: 0, offSum: 0, offN: 0, over45: 0 }; byAgent.set(key, g); }
      g.customers++;
      if (r.branch || r.team) g.teams.add(r.branch || r.team);
      if (r.has_ever_paid === true) g.paid++;
      if (r.locked4 === true) g.locked4++;
      if (r.locked7 === true) g.locked7++;
      if (r.days_offline != null) { g.offSum += num(r.days_offline); g.offN++; }
      const l = lifeDayOf(r.disbursed_date, today);
      if (l != null && l > 45) g.over45++;
    }
    const watuAgents = [...byAgent.values()].map(g => {
      const rg = regByName.get(nameKey(g.agent)) || null;
      const areas = [...g.teams].sort();
      return {
      agent: g.agent, agentId: g.agentId, teams: areas,
      // Their location: the register's branch first, else where their customers are.
      branch: (rg && rg.branch) || areas[0] || '',
      role: rg ? (rg.role || '') : '', phone: rg ? (rg.phone || '') : '',
      customers: g.customers,
      paidPct: g.customers ? g.paid / g.customers : null,
      locked4: g.locked4, locked7: g.locked7,
      locked7Pct: g.customers ? g.locked7 / g.customers : null,
      avgOff: g.offN ? Math.round(g.offSum / g.offN) : null,
      over45: g.over45,
    }; }).sort((x, y) => (y.locked7Pct || 0) - (x.locked7Pct || 0) || y.customers - x.customers);
    const bySeller = new Map();
    for (const s of sales) {
      const key = pnorm(s.commission_phone) || K(s.commission_agent) || '?';
      let g = bySeller.get(key);
      if (!g) { g = { names: {}, phone: s.commission_phone || '', sales: 0, amount: 0 }; bySeller.set(key, g); }
      g.sales++; g.amount += num(s.price);
      const n = String(s.commission_agent || '').trim();
      if (n) g.names[n] = (g.names[n] || 0) + 1;
    }
    const agBy = new Map(agents.map(r => [pnorm(r.phone), r]));
    const sellers = [...bySeller.entries()].map(([key, g]) => {
      const reg2 = agBy.get(key) || null;
      const name = Object.entries(g.names).sort((x, y) => y[1] - x[1]).map(e => e[0])[0] || '';
      return { name, phone: g.phone, sales: g.sales, amount: g.amount,
        reg: reg2 ? { name: reg2.name, role: reg2.role || '', branch: reg2.branch || '',
          kin: reg2.kin_name || '', kinPhone: reg2.kin_phone || '' } : null };
    }).sort((x, y) => y.sales - x.sales);
    return { ok: true, from, to, watuAgents: watuAgents.slice(0, 300), sellers: sellers.slice(0, 300) };
  },

  /** STOO BY HOLDER -- Sipho's aged-stock report grouped per RSM / agent: pieces held,
      how old, and who they are in the register. The rows are the AGED subset SyscoPos
      reports (past its age limit), stamped as_of the day the report was read.
      Budget: 2 parallel bounded reads -- the aged table and the agents register. */
  async stockView(db, user) {
    requireNav(user, 'stock');
    const [all, agents] = await Promise.all([
      fetchAll(() => db.from('hoop_aged_stock').select('serial, agent, item, received, age_days, as_of')),
      fetchAll(() => db.from('hoop_agents').select('name, role, branch')),
    ]);
    // History is kept per report date now -- holdings are the NEWEST report only.
    let asOf = null;
    for (const r of all) if (r.as_of && (!asOf || String(r.as_of) > String(asOf))) asOf = String(r.as_of).slice(0, 10);
    const rows = all.filter(r => String(r.as_of).slice(0, 10) === asOf);
    const regBy = new Map(agents.filter(a => a.name).map(a => [nameKey(a.name), a]));
    const by = new Map();
    for (const r of rows) {
      const k = nameKey(r.agent) || '?';
      let g = by.get(k);
      if (!g) { g = { agent: r.agent || '—', pieces: 0, ageSum: 0, ageN: 0, maxAge: 0, items: {} }; by.set(k, g); }
      g.pieces++;
      if (r.age_days != null) {
        g.ageSum += num(r.age_days); g.ageN++;
        if (num(r.age_days) > g.maxAge) g.maxAge = num(r.age_days);
      }
      const it = String(r.item || '—');
      g.items[it] = (g.items[it] || 0) + 1;
    }
    const holders = [...by.entries()].map(([k, g]) => {
      const reg = regBy.get(k) || null;
      return { agent: g.agent, role: reg ? (reg.role || '') : '', branch: reg ? (reg.branch || '') : '',
        pieces: g.pieces, avgAge: g.ageN ? Math.round(g.ageSum / g.ageN) : null, maxAge: g.maxAge,
        items: Object.entries(g.items).sort((x, y) => y[1] - x[1]).slice(0, 4)
          .map(e => e[0] + ' ×' + e[1]).join(', ') };
    }).sort((x, y) => y.maxAge - x.maxAge || y.pieces - x.pieces);
    const serials = rows.map(r => ({ serial: r.serial, agent: r.agent || '', item: r.item || '',
      received: r.received ? String(r.received).slice(0, 10) : '', age: r.age_days == null ? null : num(r.age_days) }))
      .sort((x, y) => (y.age || 0) - (x.age || 0));
    /* BY ITEM, IMEI NUMBERS INCLUSIVE (the owner's shape for this report): every model
       with its piece count and ages, carrying its own serial list -- grouped over ALL
       rows of the newest report, so the counts stay true past any display cap. */
    const byItem = new Map();
    for (const r of rows) {
      const it = String(r.item || '—');
      let g = byItem.get(it);
      if (!g) { g = { item: it, pieces: 0, ageSum: 0, ageN: 0, maxAge: 0, serials: [] }; byItem.set(it, g); }
      g.pieces++;
      if (r.age_days != null) {
        g.ageSum += num(r.age_days); g.ageN++;
        if (num(r.age_days) > g.maxAge) g.maxAge = num(r.age_days);
      }
      g.serials.push({ serial: r.serial, agent: r.agent || '',
        received: r.received ? String(r.received).slice(0, 10) : '',
        age: r.age_days == null ? null : num(r.age_days) });
    }
    const items = [...byItem.values()].map(g => ({ item: g.item, pieces: g.pieces,
      avgAge: g.ageN ? Math.round(g.ageSum / g.ageN) : null, maxAge: g.maxAge,
      serials: g.serials.sort((x, y) => (y.age || 0) - (x.age || 0)).slice(0, 300) }))
      .sort((x, y) => y.pieces - x.pieces);
    return { ok: true, asOf, total: rows.length, holders, items, serials: serials.slice(0, 500) };
  },

  /** STOCK MOVEMENT -- what got away after every upload, on BOTH books, checkable by
      date. HOOP side: serials in report A missing from report B = left the store.
      WATU side: IMEIs new on list B = financed into Watu; IMEIs gone from A = left
      Watu's book. Defaults are the newest two dates of each source.
      Budget: 2 tiny ordered date lookups per source + 4 date-keyed bounded reads;
      the aged table's own dates come from the read it already makes. */
  /* =====================================================================================
     STOCK ACCOUNTABILITY -- what each holder is answerable for, and what cannot be
     accounted for at all.
     =====================================================================================
       "the stock is too large and hoop agents are stealing stock"

     A phone that leaves Sipho's stock report has exactly three honest destinations:

       SOLD        its IMEI turns up in hoop_sales -- the shop booked it
       KWA WATU    its IMEI turns up in the Watu register but NOT in our sales book --
                   financed without a sale record (salesAudit's own WATU-ONLY case; named
                   here as a separate column rather than folded into theft, because it is
                   a paperwork failure, not a missing phone)
       HAIJULIKANI it is in neither. The phone left the building and nothing anywhere says
                   where it went. THIS is the shrinkage line, and it is attributed to the
                   LAST HOLDER the stock report showed it with.

     Deliberately NOT called theft in the UI. A serial can leave a report for dull reasons
     (a swap, a warranty return, a mis-keyed serial), and a report that accuses people by
     name had better be one the numbers can carry. It says "unaccounted", names the holder,
     and lets a human ask -- which is what actually recovers a phone.

     PIVOTED FOUR WAYS, per the owner: company grand total, the STORE (Sipho), the RSMs,
     and the agents -- classified from hoop_agents.role, so a person who changes role
     changes pivot on their next report with nothing to rewire here.

     BOUNDED ON PURPOSE. Only the newest stock report and the one before it are read whole
     (stock-sized, not history-sized); the departures between them are then looked up by
     IMEI in sales and in the register with an `in` filter, so those two reads carry the
     handful that actually left rather than the whole book. If a single day's departures
     ever exceed the cap the answer SAYS so rather than quietly under-reporting a theft.

     Budget: 2 stock reads (newest + previous report), 2 keyed `in` reads bounded by the
     departure list, 1 bounded hoop_agents read. Memoised five minutes per report pair. */
  async stockAccount(db, user, args) {
    requireNav(user, 'stock');
    const a = args || {};
    const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    const latestOf = async (before, inclusive) => {
      let q = db.from('hoop_aged_stock').select('as_of').not('as_of', 'is', null)
        .order('as_of', { ascending: false }).limit(1);
      if (before) q = inclusive ? q.lte('as_of', before) : q.lt('as_of', before);
      const { data } = await q;
      return data && data[0] ? String(data[0].as_of).slice(0, 10) : null;
    };
    /* asOf MEANS "AS THE BOOK STOOD THEN", NOT "the report filed exactly that day".

       The dashboard's week control hands this the last day of whatever week is on screen,
       and stock is counted whenever somebody uploads Sipho's report -- not on Sundays. Read
       literally, an asOf of 2026-08-30 asks for a report filed on the 30th, finds none, and
       the card comes back empty on a week where the stock book is perfectly well known.

       So a date given here resolves BACKWARD to the newest report at or before it, which is
       what "how did stock stand that week" actually means. A date earlier than any report
       at all still yields nothing, and should: there is no book to show yet. */
    const asked = day(a.asOf);
    const nowDate = asked ? await latestOf(asked, true) : await latestOf(null);
    const prevDate = nowDate ? await latestOf(nowDate) : null;
    /* Declared HERE, above the cache key, because the key has to include it: staleDays is
       both an input to the `stale` counts and a field echoed back for the screen to print.
       Left out of the key, a 5-minute-cached answer computed for one staleDays would be
       served to a caller that asked for another, carrying the wrong number into their tile. */
    const STALE_DAYS = num(a.staleDays) || 45;
    const ck = 'stockacct:' + nowDate + ':' + prevDate + ':' + STALE_DAYS + ':' + (user.teams ? user.teams.join(',') : 'ALL');
    const hit = trendCache.get(ck);
    if (hit && (Date.now() - hit.at) < 5 * 60000) return { ...hit.value, cached: true };

    const COLS = 'serial, agent, item, age_days, received, as_of';
    const [now, prev, agents] = await Promise.all([
      nowDate ? fetchAll(() => db.from('hoop_aged_stock').select(COLS).eq('as_of', nowDate)) : [],
      prevDate ? fetchAll(() => db.from('hoop_aged_stock').select(COLS).eq('as_of', prevDate)) : [],
      fetchAll(() => db.from('hoop_agents').select('name, role, branch')),
    ]);

    /* WHO HOLDS EACH SERIAL NOW, not merely whether anybody does.
       ==========================================================================
         "in hazijulikani there is some transfers sipho says the imei nos are in
          possession of other owners"

       A serial that moved from one holder to another was invisible here: it is still
       somewhere on the current report, so it never counted as a departure at all, and the
       holder who passed it on simply had their `held` drop by one with nothing to show for
       it. A transfer is not a loss and it is not nothing -- it is a handover, and the
       person who made it is exactly who you ask about it later.

       BE CLEAR ABOUT WHAT THIS DOES NOT FIX. hoop_aged_stock lists only phones PAST the age
       limit, and SyscoPos resets a phone's age when it changes hands, so a transferred
       handset can drop off the aged report entirely -- and that one still lands in
       `unaccounted`, because from this table it is indistinguishable from a phone that
       walked. Naming the transfers we CAN see does not make the rest of them visible; it
       just stops the ones we can see from being counted as missing. */
    const holderNow = new Map(now.map(r => [String(r.serial), r.agent || '']));
    const nowSet = new Set(holderNow.keys());
    const gone = prev.filter(r => !nowSet.has(String(r.serial)));
    const moved = prev.filter(r => nowSet.has(String(r.serial))
      && nameKey(holderNow.get(String(r.serial)) || '') !== nameKey(r.agent || ''));
    // NO SILENT CAP: if the departures outrun one keyed read, the answer says how many it
    // could not judge rather than reporting a smaller theft than actually happened.
    const LOOKUP_CAP = 400;
    const checking = gone.slice(0, LOOKUP_CAP);
    const notChecked = gone.length - checking.length;
    const ids = checking.map(r => String(r.serial));
    /* THE THIRD PLACE TO LOOK, and it is the stock table itself.
       ==========================================================================
         "just find for transferers if the 1st hazijulikani happens to be in hands
          of another agent/rsm"

       Comparing two reports answers "is it on the newest one" and nothing else. A
       phone can be perfectly well accounted for and still fail that: reports arrive
       per holder on different days, and SyscoPos resets a handset's age when it
       changes hands, so a transfer can be absent from the newest report while
       sitting plainly in the table under somebody else's name. Both looked exactly
       like theft.

       So before a serial is called missing we ask the WHOLE table about it, and there
       are two different things worth knowing:

         seen AFTER the report it departed from -> it did not leave stock at all.
           (Fires on a same-day re-upload or a backfilled report; the ordinary
           holder-to-holder handover is caught earlier, by `moved`, because that one
           is still on the newest report.)
         held at some point by SOMEBODY ELSE -> not proof of anything, and it does
           NOT clear the phone. It is a LEAD: the chase starts with a name and a date
           instead of with nothing, which is the whole ask.

       AND THE LIMIT, because this is the case Sipho actually hit: hoop_aged_stock
       lists only phones PAST the age limit, and SyscoPos resets a handset's age when
       it changes hands. A transfer can therefore drop off the aged report entirely,
       leaving no sighting anywhere to find. Nothing in this table can distinguish
       that from a phone that walked. A real fix needs the transfer recorded at the
       moment it happens -- see docs/DEVICE-LOCKING.md. */
    const [soldRows, watuRows, seenRows] = ids.length ? await Promise.all([
      fetchAll(() => db.from('hoop_sales').select('imei, sale_date, commission_agent').in('imei', ids)),
      fetchAll(() => db.from('watu_loans').select('imei').in('imei', ids)),
      fetchAll(() => db.from('hoop_aged_stock').select('serial, agent, as_of').in('serial', ids)),
    ]) : [[], [], []];
    const soldBy = new Map(soldRows.map(r => [String(r.imei), r]));
    const inWatu = new Set(watuRows.map(r => String(r.imei)));
    // Newest sighting per serial, across every report we hold...
    const lastSeen = new Map();
    for (const r of seenRows) {
      const k = String(r.serial), had = lastSeen.get(k);
      if (!had || String(r.as_of) > String(had.as_of)) lastSeen.set(k, r);
    }
    // ...and the newest sighting under a DIFFERENT name, which is the lead.
    const otherHands = new Map();
    for (const r of seenRows) {
      const k = String(r.serial);
      const charged = checking.find(x => String(x.serial) === k);
      if (!charged || nameKey(r.agent || '') === nameKey(charged.agent || '')) continue;
      const had = otherHands.get(k);
      if (!had || String(r.as_of) > String(had.as_of)) otherHands.set(k, r);
    }

    // Role decides the pivot; hoop_agents is the roster, matched on the same token-sorted
    // name key the rest of the system uses so spelling drift cannot split a person in two.
    const regBy = new Map(agents.filter(x => x.name).map(x => [nameKey(x.name), x]));
    const kindOf = (holder) => {
      const reg = regBy.get(nameKey(holder || ''));
      const role = K((reg && reg.role) || '');
      if (/STORE|GHALA|SIPHO/.test(role)) return 'store';
      if (/RSM/.test(role)) return 'rsm';
      return 'agent';
    };

    const by = new Map();
    const slot = (holder) => {
      const k = nameKey(holder || '') || '?';
      let g = by.get(k);
      if (!g) {
        const reg = regBy.get(k);
        g = { holder: holder || '—', kind: kindOf(holder),
          role: (reg && reg.role) || '', branch: (reg && reg.branch) || '',
          held: 0, stale: 0, maxAge: 0, gone: 0, sold: 0, watu: 0, unaccounted: 0, unaccountedList: [],
          moved: 0, movedList: [] };
        by.set(k, g);
      }
      return g;
    };
    for (const r of now) {
      const g = slot(r.agent);
      g.held++;
      const age = num(r.age_days);
      if (age > g.maxAge) g.maxAge = age;
      if (age >= STALE_DAYS) g.stale++;
    }
    // Charged to whoever HAD it, naming whoever has it now -- that is the useful direction:
    // the question is always "you had this, where did it go", and now the row answers.
    for (const r of moved) {
      const g = slot(r.agent);
      g.moved++;
      if (g.movedList.length < 50) {
        g.movedList.push({ serial: String(r.serial), item: r.item || '',
          to: holderNow.get(String(r.serial)) || '—', asOf: nowDate, same: false });
      }
    }
    for (const r of checking) {
      const g = slot(r.agent);
      const id = String(r.serial);
      const seen = lastSeen.get(id);
      /* SEEN SOMEWHERE NEWER THAN THE REPORT IT LEFT means it did not leave stock at all
         -- so it is not a departure, and it must not be counted as one. Checked before
         sold/Watu because "it is on a later report" is the plainest fact of the three. */
      if (seen && String(seen.as_of) > String(prevDate)) {
        g.moved++;
        if (g.movedList.length < 50) {
          g.movedList.push({ serial: id, item: r.item || '',
            to: seen.agent || '—', asOf: String(seen.as_of).slice(0, 10),
            // Same name = never actually handed on; it simply missed the newest report.
            same: nameKey(seen.agent || '') === nameKey(r.agent || '') });
        }
        continue;
      }
      g.gone++;
      if (soldBy.has(id)) g.sold++;
      else if (inWatu.has(id)) g.watu++;
      else {
        g.unaccounted++;
        if (g.unaccountedList.length < 50) {
          const other = otherHands.get(id);
          g.unaccountedList.push({ serial: id, item: r.item || '',
            age: r.age_days == null ? null : num(r.age_days),
            // A LEAD, NOT AN ACCUSATION. This phone is still unaccounted for; somebody
            // else simply held it at some point, and that is who to ask first.
            alsoHeldBy: other ? (other.agent || '') : null,
            alsoHeldOn: other ? String(other.as_of).slice(0, 10) : null });
        }
      }
    }
    const rows = [...by.values()].sort((x, y) => y.unaccounted - x.unaccounted || y.stale - x.stale || y.held - x.held);
    const sum = (list, f) => list.reduce((s, x) => s + x[f], 0);
    const totalsOf = list => ({ holders: list.length, held: sum(list, 'held'), stale: sum(list, 'stale'),
      gone: sum(list, 'gone'), sold: sum(list, 'sold'), watu: sum(list, 'watu'),
      moved: sum(list, 'moved'), unaccounted: sum(list, 'unaccounted') });
    const pick = k => rows.filter(r => r.kind === k);
    const value = {
      ok: true, asOf: nowDate, prevAsOf: prevDate, staleDays: STALE_DAYS,
      notChecked,
      company: { rows, totals: totalsOf(rows) },
      store: { rows: pick('store'), totals: totalsOf(pick('store')) },
      rsm: { rows: pick('rsm'), totals: totalsOf(pick('rsm')) },
      agent: { rows: pick('agent'), totals: totalsOf(pick('agent')) },
    };
    trendCache.set(ck, { at: Date.now(), value });
    return { ...value, cached: false };
  },

  /* =====================================================================================
     THE DEVICE REGISTRY -- the server half of phone locking.
     =====================================================================================
       "lets solve by building an app to install in those phones then"
       "and in our hoopcalls system we can get stats of those devices too"

     One row per phone we have taken control of, keyed by IMEI -- the one identifier every
     other book here already shares (Sipho's stock serial, the Watu register, the sales
     book, the officers' deck), so a device joins to everything we know with no new
     plumbing. That is what lets the accountability report turn an unaccounted IMEI into a
     lock command rather than just a name on a list.

     TWO DIFFERENT FACTS, KEPT APART ON PURPOSE:
       state     what the OFFICE has decided this phone should be (enrolled/locked/
                 released/lost)
       reported  what the PHONE last said about itself, at last_seen

     A phone ordered to lock that has not checked in yet is neither locked nor a failure --
     it is PENDING, and a screen that blurs those two cannot be trusted to chase anything.
     deviceList counts them separately for exactly that reason.

     THE ANDROID APP DOES NOT EXIST YET, and nothing here assumes it does: with an empty
     table every screen reads "hakuna kifaa bado" and the enrolment path still works, so
     the registry can be filled from the stock report while the app is still being written.

     Budget: one bounded read of `devices` (the enrolled fleet, not the whole register),
     plus one keyed read per write. No caching -- a lock screen that shows a stale state
     is the one thing this must never do. */
  async deviceList(db, user, args) {
    requireNav(user, 'devices');
    const a = args || {};
    const want = String(a.state || '').trim();
    const build = () => {
      let q = db.from('devices').select(
        'imei, item, holder, state, state_reason, state_at, reported, last_seen, app_version, battery, android, sold_ref, customer, enrolled_at');
      if (['enrolled', 'locked', 'released', 'lost'].includes(want)) q = q.eq('state', want);
      return q;
    };
    /* BEFORE THE MIGRATION IS RUN, this table does not exist, and PostgREST answers with a
       relation-not-found that fetchAll turns into a throw -- which withApi reports as a 500.
       So every time somebody opened this pane on a deployment where the SQL had not been run
       yet, the system logged a server failure. It was documented as "reads as empty rather
       than erroring"; it did not, and this is what makes that true.

       An empty register and a register that is not there yet are still DIFFERENT facts, so
       `notReady` rides along and the screen says which one it is looking at. */
    let rows;
    try { rows = await fetchAll(build); }
    catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], total: 0, notReady: true,
        counts: { enrolled: 0, locked: 0, lockPending: 0, released: 0, lost: 0, neverSeen: 0, stale: 0 } };
    }
    const now = Date.now();
    const HOURS = 36 * 3600 * 1000;      // silent longer than this and it is worth asking why
    const out = rows.map(r => {
      const seen = r.last_seen ? Date.parse(r.last_seen) : null;
      return { ...r,
        neverSeen: !seen,
        silentHours: seen ? Math.round((now - seen) / 3600000) : null,
        stale: !seen || (now - seen) > HOURS,
        // The honest three-way reading of a lock order, never collapsed into a boolean.
        lockState: r.state !== 'locked' ? null
          : (r.reported === 'locked' ? 'confirmed' : 'pending'),
      };
    }).sort((x, y) => {
      const rank = d => (d.state === 'lost' ? 0 : d.state === 'locked' && d.lockState === 'pending' ? 1
        : d.stale ? 2 : d.state === 'locked' ? 3 : 4);
      return rank(x) - rank(y) || String(x.imei).localeCompare(String(y.imei));
    });
    const count = f => out.filter(f).length;
    return { ok: true, rows: out.slice(0, 500), total: out.length,
      counts: {
        enrolled: count(r => r.state === 'enrolled'),
        locked: count(r => r.state === 'locked'),
        lockPending: count(r => r.lockState === 'pending'),
        released: count(r => r.state === 'released'),
        lost: count(r => r.state === 'lost'),
        neverSeen: count(r => r.neverSeen),
        stale: count(r => r.stale && !r.neverSeen),
      } };
  },

  /* ENROL -- take control of phones that are sitting in stock. Fed by IMEI, so the
     enrolment station can scan a box or paste a column straight out of Sipho's report;
     the stock report itself fills in model and holder where it knows them.
     Idempotent: re-enrolling a phone already on the registry is a no-op that reports
     itself, never a duplicate and never a silent state reset. */
  async deviceEnrol(db, user, args) {
    requireWrite(user); requireNav(user, 'devices');
    const a = args || {};
    const list = [...new Set((Array.isArray(a.imeis) ? a.imeis : String(a.imeis || '').split(/[\s,;]+/))
      .map(x => String(x || '').trim()).filter(Boolean))];
    if (!list.length) bad('Weka angalau IMEI moja. / At least one IMEI is required.');
    if (list.length > 500) bad('IMEI nyingi mno kwa mara moja (kikomo 500). / Too many at once — 500 max.');

    const [already, stock] = await Promise.all([
      fetchAll(() => db.from('devices').select('imei').in('imei', list)),
      fetchAll(() => db.from('hoop_aged_stock').select('serial, item, agent, as_of').in('serial', list)),
    ]);
    const have = new Set(already.map(r => String(r.imei)));
    // Newest stock row per serial, so model/holder come from the latest count, not the first.
    const stockBy = new Map();
    for (const s of stock) {
      const k = String(s.serial), had = stockBy.get(k);
      if (!had || String(s.as_of) > String(had.as_of)) stockBy.set(k, s);
    }
    const fresh = list.filter(i => !have.has(i));
    const at = new Date().toISOString();
    const batch = randomUUID();
    /* ONE TOKEN PER PHONE, minted here and nowhere else. This is the credential the handset
       will carry -- it has no access code and never will -- so it is generated at the only
       moment the phone is physically in our hands, and returned ONCE, to the station that
       is about to write it into that phone. It is never read back onto a list screen. */
    const token = () => randomUUID().replace(/-/g, '');
    const minted = new Map(fresh.map(imei => [imei, token()]));
    if (fresh.length) {
      const rows = fresh.map(imei => {
        const s = stockBy.get(imei);
        return { imei, enrolled_at: at, enrolled_by: user.name, enrol_batch: batch,
          item: (s && s.item) || null, holder: (s && s.agent) || null,
          enrol_token: minted.get(imei),
          state: 'enrolled', state_by: user.name, state_at: at, updated_at: at };
      });
      // Pre-migration: a registry created before the phone half existed has no enrol_token,
      // and PostgREST refuses the whole insert for one unknown column. Enrol still works --
      // those phones simply cannot beat until the alter in RUN-ME-2026-08-24-devices.sql runs.
      let { error } = await db.from('devices').insert(rows);
      if (error && /enrol_token/.test(String(error.message || ''))) {
        minted.clear();
        ({ error } = await db.from('devices').insert(
          rows.map(({ enrol_token, ...rest }) => rest)));
      }
      if (error) throw new Error(error.message);
      const { error: eErr } = await db.from('device_events').insert(fresh.map(imei => ({
        imei, event: 'enrolled', from_state: null, to_state: 'enrolled', actor: user.name, at })));
      if (eErr) throw new Error(eErr.message);
    }
    return { ok: true, enrolled: fresh.length, alreadyOn: list.length - fresh.length,
      unknownToStock: fresh.filter(i => !stockBy.has(i)).length, batch,
      // For the provisioning station only. Empty when the token column is not there yet.
      provision: fresh.map(imei => ({ imei, token: minted.get(imei) || null }))
        .filter(p => p.token) };
  },

  /* SET STATE -- lock, unlock, release or write off. One door for every state change, so
     the event trail cannot be bypassed by whichever screen happens to call it.

     A REASON IS REQUIRED to lock or to write a phone off. Locking somebody's phone is an
     act with a person on the other end of it; six months later "why is this locked" has to
     have an answer, and the only reliable moment to capture one is now. */
  async deviceSetState(db, user, args) {
    requireWrite(user); requireNav(user, 'devices');
    const a = args || {};
    const to = String(a.state || '').trim();
    if (!['enrolled', 'locked', 'released', 'lost'].includes(to)) {
      throw new Error('Hali si sahihi. / Unknown device state: ' + to);
    }
    const reason = String(a.reason || '').trim();
    if ((to === 'locked' || to === 'lost') && !reason) {
      bad('Sababu inahitajika. / A reason is required to lock or write off a phone.');
    }
    const list = [...new Set((Array.isArray(a.imeis) ? a.imeis : [a.imei || a.imeis])
      .map(x => String(x || '').trim()).filter(Boolean))];
    if (!list.length) bad('Weka IMEI. / An IMEI is required.');

    const current = await fetchAll(() => db.from('devices').select('imei, state').in('imei', list));
    const known = new Map(current.map(r => [String(r.imei), r.state]));
    const missing = list.filter(i => !known.has(i));
    const changing = list.filter(i => known.has(i) && known.get(i) !== to);
    const at = new Date().toISOString();
    if (changing.length) {
      const patch = { state: to, state_reason: reason || null, state_by: user.name,
        state_at: at, updated_at: at };
      if (to === 'released') patch.released_at = at;
      const { error } = await db.from('devices').update(patch).in('imei', changing);
      if (error) throw new Error(error.message);
      const { error: eErr } = await db.from('device_events').insert(changing.map(imei => ({
        imei, event: to === 'locked' ? 'lock' : to === 'released' ? 'release' : to === 'lost' ? 'lost' : 'unlock',
        from_state: known.get(imei), to_state: to, reason: reason || null, actor: user.name, at })));
      if (eErr) throw new Error(eErr.message);
    }
    return { ok: true, changed: changing.length,
      alreadyThere: list.length - changing.length - missing.length,
      notEnrolled: missing.length, notEnrolledList: missing.slice(0, 20) };
  },

  /* ONE PHONE'S WHOLE STORY -- its current row and every state change ever ordered against
     it. This is what somebody opens when a customer is standing in front of them asking
     why their phone is locked. */
  async deviceHistory(db, user, args) {
    requireNav(user, 'devices');
    const imei = String((args && args.imei) || '').trim();
    if (!imei) bad('IMEI inahitajika. / An IMEI is required.');
    /* Columns named rather than `*` for one reason: `*` would carry enrol_token onto this
       screen. The handset's credential is a secret and this is the screen most likely to be
       open with a stranger looking over the counter. */
    const [devRows, events] = await Promise.all([
      fetchAll(() => db.from('devices').select(
        'imei, item, holder, state, state_reason, state_by, state_at, reported, last_seen, '
        + 'app_version, battery, android, sold_ref, customer, released_at, reported_imei, '
        + 'enrolled_at, enrolled_by, enrol_batch, updated_at').eq('imei', imei)),
      fetchAll(() => db.from('device_events').select('*').eq('imei', imei).order('at', { ascending: false }).limit(100)),
    ]);
    return { ok: true, imei, device: devRows[0] || null, events };
  },

  /* THE TOKEN, HANDED BACK -- for one phone, on purpose, when it is re-flashed and has to
     be provisioned again. Enrolment shows a token once; a wiped handset needs it a second
     time, and the alternative (re-enrolling to mint a fresh one) would throw away that
     phone's whole history to solve a five-second problem.

     Treated as a WRITE even though it reads: it discloses a credential, so it takes the
     write permission and lands in the audit log with the IMEI attached. Nobody should be
     able to walk the fleet collecting tokens without that being visible afterwards. */
  async deviceToken(db, user, args) {
    requireWrite(user); requireNav(user, 'devices');
    const imei = String((args && args.imei) || '').trim();
    if (!imei) bad('IMEI inahitajika. / An IMEI is required.');
    const rows = await fetchAll(() => db.from('devices').select('imei, enrol_token').eq('imei', imei));
    if (!rows.length) bad('Kifaa hakijasajiliwa. / That IMEI is not on the registry.');
    return { ok: true, imei, token: rows[0].enrol_token || null };
  },

  /* TAKE A PHONE OFF THE REGISTER ENTIRELY -- for starting a handset over.
     =====================================================================================
       "i need delete button after token and historia for now b/se i want to start afresh"

     Deliberately separate from `released`. Achia is a decision about a customer's loan and
     leaves a trail; this is an eraser for a row that should not have existed -- a wrong
     IMEI, a test handset, a batch enrolled twice. So the row and its history both go, and
     the ONLY record left is the audit entry this fn is registered for.

     WHAT IT DOES NOT DO, and the screen says so before anybody presses it: the handset does
     not hear about this. It still holds its token and is still Device Owner. Its next beat
     gets a 403, which device-core deliberately treats as "keep doing what you were doing"
     rather than as permission to unlock -- a phone un-enrolled by somebody tampering with
     the database is the last one that should let itself go. Starting that HANDSET afresh
     means a factory reset, with the phone in your hands.

     A LOCKED PHONE IS REFUSED. Deleting the row of a phone that is currently locked would
     strand it: locked forever, with nothing on the register to unlock it from. Unlock it
     first, watch it confirm, then delete. */
  async deviceDelete(db, user, args) {
    requireWrite(user); requireNav(user, 'devices');
    const imei = String((args && args.imei) || '').trim();
    if (!imei) bad('IMEI inahitajika. / An IMEI is required.');
    const rows = await fetchAll(() => db.from('devices').select('imei, state, reported').eq('imei', imei));
    const dev = rows.find(r => String(r.imei) === imei);
    if (!dev) bad('Kifaa hakijasajiliwa. / That IMEI is not on the registry.');
    if (String(dev.state) === 'locked' || String(dev.reported) === 'locked') {
      bad('Simu imefungwa. Ifungue kwanza, subiri ithibitishe, ndipo uifute. '
        + '/ This phone is locked. Unlock it and wait for it to confirm before deleting, or it stays locked with no way to reach it.');
    }
    // History first: a device_events row whose device is gone is a row nobody can read.
    await db.from('device_events').delete().eq('imei', imei);
    const { error } = await db.from('devices').delete().eq('imei', imei);
    if (error) throw new Error(error.message);
    return { ok: true, imei };
  },

  async stockMovement(db, user, args) {
    requireNav(user, 'movement');
    const a = args || {};
    const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    const latestOf = async (table, col, before) => {
      let q = db.from(table).select(col).not(col, 'is', null).order(col, { ascending: false }).limit(1);
      if (before) q = q.lt(col, before);
      const { data } = await q;
      return data && data[0] ? String(data[0][col]).slice(0, 10) : null;
    };
    const hoopB = day(a.hoopB) || await latestOf('hoop_aged_stock', 'as_of');
    const hoopA = day(a.hoopA) || (hoopB ? await latestOf('hoop_aged_stock', 'as_of', hoopB) : null);
    const watuB = day(a.watuB) || await latestOf('watu_snapshots', 'snapshot_date');
    const watuA = day(a.watuA) || (watuB ? await latestOf('watu_snapshots', 'snapshot_date', watuB) : null);
    const [hA, hB, wA, wB] = await Promise.all([
      hoopA ? fetchAll(() => db.from('hoop_aged_stock').select('serial, item, agent').eq('as_of', hoopA)) : [],
      hoopB ? fetchAll(() => db.from('hoop_aged_stock').select('serial, item, agent').eq('as_of', hoopB)) : [],
      watuA ? fetchAll(() => db.from('watu_snapshots').select('imei, client_name, agent, model, created_at').eq('snapshot_date', watuA)) : [],
      watuB ? fetchAll(() => db.from('watu_snapshots').select('imei, client_name, agent, model, created_at').eq('snapshot_date', watuB)) : [],
    ]);
    const newest = rows => {
      const m = new Map();
      for (const r of rows) {
        const had = m.get(String(r.imei));
        if (!had || String(r.created_at) > String(had.created_at)) m.set(String(r.imei), r);
      }
      return m;
    };
    const hbSet = new Set(hB.map(r => String(r.serial)));
    const haSet = new Set(hA.map(r => String(r.serial)));
    const wAm = newest(wA), wBm = newest(wB);
    const leftHoop = hA.filter(r => !hbSet.has(String(r.serial)))
      .map(r => ({ serial: r.serial, item: r.item || '', holder: r.agent || '' }));
    const newInHoop = hB.filter(r => !haSet.has(String(r.serial)))
      .map(r => ({ serial: r.serial, item: r.item || '', holder: r.agent || '' }));
    const newWatu = [...wBm.values()].filter(r => !wAm.has(String(r.imei)))
      .map(r => ({ imei: r.imei, name: r.client_name || '', agent: r.agent || '', model: r.model || '' }));
    const leftWatu = [...wAm.values()].filter(r => !wBm.has(String(r.imei)))
      .map(r => ({ imei: r.imei, name: r.client_name || '', agent: r.agent || '', model: r.model || '' }));
    return { ok: true, hoopA, hoopB, watuA, watuB,
      counts: { leftHoop: leftHoop.length, newInHoop: newInHoop.length,
        newWatu: newWatu.length, leftWatu: leftWatu.length },
      leftHoop: leftHoop.slice(0, 300), newInHoop: newInHoop.slice(0, 300),
      newWatu: newWatu.slice(0, 300), leftWatu: leftWatu.slice(0, 300) };
  },

  async saveTeam(db, user, args) {
    requireWrite(user); requireSettings(user);
    const a = args || {};
    const team = K(a.team);
    if (!team) throw new Error('Team name is required.');
    const row = { team, updated_at: new Date().toISOString() };
    if (a.rsm !== undefined) row.rsm = String(a.rsm || '').trim() || null;
    if (a.rsmNo !== undefined) row.rsm_no = String(a.rsmNo || '').trim() || null;
    const { error } = await db.from('teams').upsert(row, { onConflict: 'team' });
    if (error) throw new Error(error.message);
    return { ok: true, team };
  },

  /** Rotating a code releases every handset on the team -- that is what it is FOR. */
  async newTeamCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const team = K(args && args.team);
    if (!team) throw new Error('Team name is required.');
    const teams = await fetchAll(() => db.from('teams').select('team, team_code'));
    if (!teams.some(t => K(t.team) === team)) throw new Error('Unknown team: ' + team);
    const existing = new Set(teams.map(t => K(t.team_code || '').replace(/[^0-9A-Z]/g, '')).filter(Boolean));
    const code = mintCode(existing);
    const { error } = await db.from('teams').update({ team_code: code, updated_at: new Date().toISOString() }).eq('team', team);
    if (error) throw new Error(error.message);
    return { ok: true, team, code };
  },

  /** One box, four keys: name, phone, IMEI, agent. Team-scoped at the database.
      Budget: ONE read, or()-filtered and capped at 30 rows. */
  async customerSearch(db, user, args) {
    const q = String((args && args.q) || '').trim().replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.length < 3) return { ok: true, customers: [] };
    const pat = '*' + q + '*';
    /* A number is typed however the person remembers it -- 0712..., 255712..., or the
       bare tail. Digits get a second, normalized term (last 9), so every spelling of
       the same phone finds the same customer. Guarantors are searchable too. */
    const digits = q.replace(/\D/g, '');
    const dpat = digits.length >= 6 ? '*' + digits.slice(-9) + '*' : null;
    // Guarantor columns arrived with the offline queue; until the migration runs the
    // whole select would be refused for them, so fall back to the old shape.
    const mk = (cols, withG) => {
      const terms = ['client_name.ilike.' + pat, 'client_mobile.ilike.' + pat,
        'imei.ilike.' + pat, 'agent.ilike.' + pat];
      if (withG) terms.push('guarantor_name.ilike.' + pat, 'guarantor_phone.ilike.' + pat);
      if (dpat) {
        terms.push('client_mobile.ilike.' + dpat, 'imei.ilike.' + dpat);
        if (withG) terms.push('guarantor_phone.ilike.' + dpat);
      }
      let query = db.from('watu_loans').select(cols).or(terms.join(',')).limit(30);
      if (user.teams && user.teams.length) query = query.in('team', user.teams.map(K));
      return query;
    };
    let { data, error } = await mk('imei, client_name, client_mobile, team, agent, model, '
      + 'days_offline, locked7, snapshot_date, branch, guarantor_name, guarantor_phone', true);
    if (error) ({ data, error } = await mk('imei, client_name, client_mobile, team, agent, model, '
      + 'days_offline, locked7, snapshot_date', false));
    if (error) throw new Error(error.message);
    return { ok: true, customers: (data || []).map(r => ({
      imei: r.imei, name: r.client_name || '', phone: r.client_mobile || '',
      team: r.team || '', branch: r.branch || '', agent: r.agent || '', model: r.model || '',
      gName: r.guarantor_name || '', gPhone: r.guarantor_phone || '',
      daysOff: r.days_offline, locked7: r.locked7 === true,
      asOf: r.snapshot_date ? String(r.snapshot_date).slice(0, 10) : null })) };
  },

  /** ONE BOX FOR THE WHOLE SYSTEM: an IMEI, a name or a number, searched everywhere at
      once -- customers (guarantors included), the office (agents register) and stock
      serials. Open to every signed-in code, view-only included: reading is what a
      search is. Budget: <=3 bounded or()-filtered reads (30 + 20 + 20 rows), and only
      from 3 typed characters; the customers leg is customerSearch itself. */
  async globalSearch(db, user, args) {
    const a = args || {};
    const cs = await FNS.customerSearch(db, user, a);
    const q = String(a.q || '').trim().replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.length < 3) return { ok: true, customers: [], people: [], stock: [] };
    const pat = '*' + q + '*';
    const digits = q.replace(/\D/g, '');
    const dpat = digits.length >= 6 ? '*' + digits.slice(-9) + '*' : null;
    const pTerms = ['name.ilike.' + pat, 'phone.ilike.' + pat]
      .concat(dpat ? ['phone.ilike.' + dpat] : []);
    const sTerms = ['serial.ilike.' + pat, 'agent.ilike.' + pat, 'item.ilike.' + pat];
    const [pe, st] = await Promise.all([
      db.from('hoop_agents').select('name, phone, role, branch, active').or(pTerms.join(',')).limit(20),
      db.from('hoop_aged_stock').select('serial, item, agent, as_of')
        .or(sTerms.join(',')).order('as_of', { ascending: false }).limit(20),
    ]);
    if (pe.error) throw new Error(pe.error.message);
    const seenS = new Set(), stock = [];
    for (const s of (st.error ? [] : (st.data || []))) {
      if (seenS.has(String(s.serial))) continue;
      seenS.add(String(s.serial));
      stock.push({ serial: s.serial, item: s.item || '', holder: s.agent || '',
        asOf: s.as_of ? String(s.as_of).slice(0, 10) : '' });
    }
    return { ok: true, customers: cs.customers,
      people: (pe.data || []).map(p => ({ name: p.name || '', phone: p.phone || '',
        role: p.role || '', branch: p.branch || '', active: p.active !== false })),
      stock };
  },

  /** THE OFFICE, not the logins: everyone on Sipho's register -- agents, team leaders,
      RSMs, the CSM -- ranked seniority-first. System logins (portal codes, app users)
      live under Access codes. Next of kin shows only to settings holders / ADMIN.
      Budget: 1 bounded read (~1k rows). */
  async staffDirectory(db, user) {
    requireNav(user, 'staff');
    const rows = await fetchAll(() => db.from('hoop_agents')
      .select('name, phone, role, branch, active, joined_date, kin_name, kin_phone'));
    const RANK = { COUNTRY_SALES_MANAGER: 0, REGIONAL_MANAGER: 1, TEAM_LEADER: 2, FIELD_OFFICER: 3, FIELD_OFFICERS: 3 };
    const showKin = isAdminRole(user) || (user.tabs || []).includes('settings');
    const rank = r => { const k = K(r).replace(/\s+/g, '_'); return RANK[k] === undefined ? 9 : RANK[k]; };
    const staff = rows.map(r => {
      const o = { name: r.name || '', phone: r.phone || '', role: r.role || '',
        branch: r.branch || '', active: r.active !== false,
        joined: r.joined_date ? String(r.joined_date).slice(0, 10) : '' };
      if (showKin) { o.kin = r.kin_name || ''; o.kinPhone = r.kin_phone || ''; }
      return o;
    }).sort((a, b) => rank(a.role) - rank(b.role) || (a.name < b.name ? -1 : 1));
    const byRole = {};
    staff.forEach(r => { const k = r.role || '—'; byRole[k] = (byRole[k] || 0) + 1; });
    return { ok: true, total: staff.length, byRole, staff: staff.slice(0, 1500) };
  },

  async officers(db, user) {
    const rows = await fetchAll(() => db.from('call_users')
      .select('user_id, name, team, role, phone, is_leader, active, last_sync'));
    return { ok: true, officers: rows
      .filter(r => !user.teams || !r.team || user.teams.some(t => K(t) === K(r.team)))
      .map(r => ({ userId: r.user_id, name: r.name || '', team: r.team || '', role: r.role || '',
        phone: r.phone || '', leader: !!r.is_leader, active: r.active !== false,
        lastSync: r.last_sync || null }))
      .sort((a, b) => a.name < b.name ? -1 : 1) };
  },

  /** The one-person cut: switch an account off without rotating anybody's code. */
  async officerActive(db, user, args) {
    requireWrite(user); requireSettings(user);
    const uid = String((args && args.userId) || '').trim();
    if (!uid) throw new Error('userId is required.');
    const active = !!(args && args.active);
    const { error } = await db.from('call_users').update({ active }).eq('user_id', uid);
    if (error) throw new Error(error.message);
    return { ok: true, userId: uid, active };
  },

  async accessCodes(db, user) {
    requireSettings(user);
    const [rows, roleRows, hiddenRow] = await Promise.all([
      fetchAll(() => db.from('access_codes').select('code, name, role, teams, tabs')),
      fetchAll(() => db.from('roles').select('role, tabs')),
      db.from('settings').select('value').eq('key', 'ROLES_HIDDEN').maybeSingle(),
    ]);
    const mask = isReadOnly(user);
    let hidden = [];
    try { hidden = JSON.parse((hiddenRow.data && hiddenRow.data.value) || '[]') || []; } catch (e) { hidden = []; }
    const hiddenSet = new Set(hidden.map(K));
    // Every role that exists anywhere is offered everywhere: the roles table first (it
    // carries the tabs), then roles only seen on codes, then the suggested set -- MINUS
    // suggested names the owner has deleted, or the delete would quietly undo itself.
    const seen = new Map();
    roleRows.forEach(r => { const k = K(r.role); if (k) seen.set(k, { role: k, tabs: r.tabs || [] }); });
    rows.forEach(r => { const k = K(r.role); if (k && !seen.has(k)) seen.set(k, { role: k, tabs: [] }); });
    ['ADMIN', 'MANAGER', 'FINANCE', 'RSM', 'CREDIT LEAD', 'GENERAL DUTY', 'STORE', 'IT', 'AUDITOR']
      .forEach(k => { if (!seen.has(k) && !hiddenSet.has(k)) seen.set(k, { role: k, tabs: [] }); });
    // How many codes hold each role decides whether the page may offer to delete it.
    const useCount = {};
    rows.forEach(r => { const k = K(r.role); if (k) useCount[k] = (useCount[k] || 0) + 1; });
    return { ok: true,
      navTabs: NAV_TABS,
      roles: [...seen.values()].map(r => ({ ...r, inUse: useCount[r.role] || 0 }))
        .sort((a, b) => a.role < b.role ? -1 : 1),
      codes: rows.map(r => ({
        code: mask ? '••••••' : r.code, name: r.name, role: r.role,
        teams: r.teams || null, tabs: r.tabs || [] })) };
  },

  /** A role leaves only when NOBODY holds it -- reassign the codes first. A deleted
      suggested-set name also lands on ROLES_HIDDEN (a settings row this fn alone writes;
      it sits outside settingSet's whitelist) or the next read would resurrect it.
      Budget: 1 bounded codes read + 1 keyed delete + 1 keyed read + 1 keyed write. */
  async deleteRole(db, user, args) {
    requireWrite(user); requireSettings(user);
    const role = K(args && args.role);
    if (!role) throw new Error('Role name is required.');
    const codes = await fetchAll(() => db.from('access_codes').select('code, name, role'));
    const holders = codes.filter(c => K(c.role) === role);
    if (holders.length) {
      throw new Error('Role hii bado ina watu ' + holders.length + ' ('
        + holders.slice(0, 5).map(c => c.name || c.code).join(', ')
        + '). Wahamishie role nyingine kwanza. / Still in use -- reassign those codes first.');
    }
    const { error } = await db.from('roles').delete().eq('role', role);
    if (error) throw new Error(error.message);
    const { data } = await db.from('settings').select('value').eq('key', 'ROLES_HIDDEN').maybeSingle();
    let hidden = [];
    try { hidden = JSON.parse((data && data.value) || '[]') || []; } catch (e) { hidden = []; }
    if (!hidden.some(h => K(h) === role)) hidden.push(role);
    const { error: hErr } = await db.from('settings')
      .upsert({ key: 'ROLES_HIDDEN', value: JSON.stringify(hidden) }, { onConflict: 'key' });
    if (hErr) throw new Error(hErr.message);
    return { ok: true, role };
  },

  /** A role is a name plus the doors it opens. Tabs come from a fixed vocabulary; every
      code carrying the role inherits them at sign-in (auth.js resolveTabs). */
  async saveRole(db, user, args) {
    requireWrite(user); requireSettings(user);
    const role = K(args && args.role);
    if (!role) throw new Error('Role name is required.');
    // Every nav pane is a grantable tab, plus the two ACTIONS (upload, audit). A pane
    // added to NAV_TABS later is automatically grantable here -- one list, everywhere.
    const ALLOWED = new Set([...NAV_TABS, 'upload', 'audit', 'sales']);   // 'sales' = stored alias for the three
    const tabs = (Array.isArray(args && args.tabs) ? args.tabs : [])
      .map(t => String(t).toLowerCase()).filter(t => ALLOWED.has(t));
    const { error } = await db.from('roles').upsert({ role, tabs }, { onConflict: 'role' });
    if (error) throw new Error(error.message);
    return { ok: true, role, tabs };
  },

  async saveAccessCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const a = args || {};
    const code = String(a.code || '').trim();
    if (!code || !String(a.name || '').trim() || !String(a.role || '').trim()) {
      throw new Error('code, name and role are all required.');
    }
    // Empty is NOT quietly "all teams" -- the caller states ALL, or names the teams.
    const wantsAll = a.allTeams === true;
    const list = Array.isArray(a.teams) ? a.teams.map(K).filter(Boolean) : [];
    if (!wantsAll && !list.length) {
      bad('Chagua ALL au orodhesha timu. / State ALL, or name the teams.');
    }
    const row = { code, name: String(a.name).trim(), role: K(a.role),
      teams: wantsAll ? null : list,
      tabs: Array.isArray(a.tabs) ? a.tabs : [] };
    const { error } = await db.from('access_codes').upsert(row, { onConflict: 'code' });
    if (error) throw new Error(error.message);
    return { ok: true, code };
  },

  /** Change a code's VALUE -- your own included: the row keeps its name, role, teams
      and tabs, only the secret moves. The caller renaming themselves gets self:true so
      the page can re-sign them in with the new code instead of locking them out. */
  async renameAccessCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const from = String((args && args.from) || '').trim();
    const to = String((args && args.to) || '').trim();
    if (!from || !to) throw new Error('Both the old and the new code are required.');
    if (to.length < 4) throw new Error('The new code needs at least 4 characters.');
    if (from === to) return { ok: true, from, to, self: from === user.code };
    const { data: clash } = await db.from('access_codes').select('code').eq('code', to).maybeSingle();
    if (clash) throw new Error('That code is already taken.');
    const { data, error } = await db.from('access_codes').update({ code: to }).eq('code', from).select('code');
    if (error) throw new Error(error.message);
    if (!data || !data.length) throw new Error('Unknown code: ' + from);
    return { ok: true, from, to, self: from === user.code };
  },

  async deleteAccessCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const code = String((args && args.code) || '').trim();
    if (!code) throw new Error('code is required.');
    if (code === user.code) throw new Error('You cannot delete the code you are signed in with.');
    const { error } = await db.from('access_codes').delete().eq('code', code);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async settings(db, user) {
    requireSettings(user);
    const rows = await fetchAll(() => db.from('settings').select('key, value')
      .in('key', EDITABLE_SETTINGS));
    const by = {}; rows.forEach(r => { by[r.key] = r.value; });
    // An empty FU_STATUSES box looked like "there is no list" when the list simply
    // lives in code -- show the WORKING vocabulary so editing starts from the truth.
    if (!String(by.FU_STATUSES || '').trim()) by.FU_STATUSES = FU_STATUSES.join(', ');
    return { ok: true,
      settings: EDITABLE_SETTINGS.map(k => ({ key: k, value: by[k] == null ? '' : by[k] })) };
  },

  async settingSet(db, user, args) {
    requireWrite(user); requireSettings(user);
    const key = K(args && args.key);
    if (!EDITABLE_SETTINGS.includes(key)) {
      throw new Error('That setting is not editable here: ' + key);
    }
    const { error } = await db.from('settings')
      .upsert({ key, value: String((args && args.value) || '') }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    return { ok: true, key };
  },

  async audit(db, user, args) {
    requireSettings(user);
    return { ok: true, ...(await auditList(db, { limit: 200 })) };
  },
};

export const _FNS = FNS;   // tests only -- the fns run against the fake db

export default withApi(async (req) => {
  if (req.method !== 'POST') { const e = new Error('Method not allowed'); e.status = 405; throw e; }
  const { code, fn, args } = req.body || {};
  const user = await gatedUser(code);
  const h = FNS[fn];
  if (!h) { const e = new Error('Unknown portal fn: ' + fn); e.status = 400; throw e; }
  return audited(supabase, user, fn, args, () => h(supabase, user, args));
});
