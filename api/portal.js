import { randomUUID } from 'node:crypto';
import { supabase, fetchAll } from './_lib/supabase.js';
import { withApi, gatedUser, isReadOnly, suspendedOn, isAdminRole, USER_TABS, EXTRA_TABS } from './_lib/auth.js';
import { audited, AUDITED, auditList } from './_lib/audit.js';
import { todayKey, addDaysKey, weekMondayKey, TZ_OFFSET_MS } from './_lib/time.js';
import { sendMail, noticeHtml } from './_lib/mail.js';
import { nudge } from './_lib/push.js';
import { noteSignin, outcomeOf, ipOf, uaOf, SIGNIN_ALARMING } from './_lib/signin.js';
import { summaryFor, reportCore, lifeDayOf, fuStatusConfig, pnorm, rosterFull,
  agentIndex, nameKey, dealMap, WINDOW_DAYS, FU_STATUSES, fuBucketOf, FU_BUCKETS } from './_lib/call-core.js';

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
/* IMPREST AND LEAVE -- money and absence, so both ends of each are logged, the same way the
   advance is: who asked, who decided, who filed the retirement, who changed a rate. As with
   advances, KEEP in audit.js drops every amount and every free-text field on the way in, so the
   log names the request (`id`) and the role (`role`) and never becomes a second copy of the
   costing or of somebody's reason for leave. */
AUDITED.add('impRequest');
AUDITED.add('impDecide');
AUDITED.add('impRetire');
AUDITED.add('impRoleSave');
AUDITED.add('impRoleDelete');
AUDITED.add('leaveRequest');
AUDITED.add('leaveDecide');
/* ISSUES -- who raised what, and who moved it. `id` and `department` ride along (KEEP carries
   id; the department is not a payload). The text of the issue never reaches the log. */
AUDITED.add('issueRaise');
AUDITED.add('issueUpdate');
/* The follow-up report LEAVING the building (Credit SOP A.6 "Send the report to the General
   Manager"). The report itself is a read; sending a copy of the department's day to somebody
   outside the pane is an act, so who sent which period is kept. */
AUDITED.add('fuOutcomesSend');
/* STOCK: who asked for stock, who released it, and who overrode the aging gate to do so.
   KEEP drops the free text on the way in, so the log names the request and never becomes a
   second copy of somebody's reason. */
AUDITED.add('stockRequest');
AUDITED.add('stockDecide');
AUDITED.add('stockIssue');
/* TARGETS: who set what a person is expected to sell, and who moved an agent to another RSM.
   The numbers themselves stay out of the log; KEEP carries the name and the scope. */
AUDITED.add('targetSave');
AUDITED.add('targetDelete');
AUDITED.add('staffManager');
/* THE STAFF PANE'S TWO ACTS. Who is in whose channel decides whose sales roll up to whom, and
   deactivating somebody shuts a door they were signing in through this morning -- both are
   decisions a person makes about another person, which is what this log is for. */
AUDITED.add('staffChannelSave');
AUDITED.add('staffActive');
/* COMMISSION: money leaving the company. Who built a cycle, who signed it off, who paid it,
   and who changed a rate -- all four, because A.6 exists to stop a second payment and the log
   is how anybody proves which of them happened first. */
AUDITED.add('commBuild');
AUDITED.add('commDecide');
AUDITED.add('commPay');
AUDITED.add('commRateSave');
AUDITED.add('commRateDelete');
/* THE ADVANCE RULES (Finance SOP G.6): the money going out and payroll taking it back are two
   acts on two days, so both are logged. A salary is what the 40% cap is computed from, so who
   set one is kept too -- KEEP drops the figure itself. */
AUDITED.add('advPay');
AUDITED.add('advDeduct');
AUDITED.add('salarySave');
AUDITED.add('salaryDelete');
/* LOSS AND DAMAGE: opening a case names somebody as liable for the price of a phone, and every
   move after it decides what they owe. KEEP carries the id and the name; the money does not. */
AUDITED.add('lossRaise');
AUDITED.add('lossUpdate');
AUDITED.add('priceSave');
AUDITED.add('priceDelete');
/* TOP-UPS: money out and a customer's phone unlocked. SOP B.5 says the payment must never be
   delayed, so who did which step and when is the record that proves it was not. */
AUDITED.add('topupRequest');
AUDITED.add('topupUpdate');
/* THE DOOR (IT SOP D): who decided a run of refusals had been dealt with, and who sent the
   window out of the building. KEEP drops the note itself -- what was done is on the row. */
/* ENROLMENT: who entered somebody's details, and who ACTIVATED the account. A.3 makes the
   second one the consequential act on this desk, so it is the one that must be traceable. */
AUDITED.add('enrolSave');
AUDITED.add('enrolUpdate');
/* SOP E's verb is SUBMIT, so who sent which week out of the building is kept. */
AUDITED.add('itWeeklySend');
AUDITED.add('signinReview');
AUDITED.add('signinSend');

const K = s => String(s == null ? '' : s).trim().toUpperCase();
const num = v => (typeof v === 'number' ? v : Number(v) || 0);
/* A whole-shilling figure with thousands separators, for the subject line of an email -- the
   one place in this file a number is turned into words for a reader rather than sent as a
   number for a screen to format. */
const money0 = n => Math.round(num(n)).toLocaleString('en-US');

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

   The keys are also the pane's ORDER, top to bottom, so device settings sit together.

   CALL_SCRIPT is what the officer READS to the customer (Credit SOP A.3 "using the company
   script", E.5 "Use the company script when calling clients"); it appears on the customer card
   in the app, and blank means the card shows no script panel at all. KPI_DEFAULT_RATE is the
   department's ceiling in percent (SOP D: "must not exceed 5%"), which the Recovery pane
   measures its locked-7 share against. */
const EDITABLE_SETTINGS = [
  'SYSTEM_OPEN', 'CALL_BRAND', 'CALL_LOGO_URL', 'FU_STATUSES',
  'CALL_SCRIPT', 'KPI_DEFAULT_RATE',
  'CALL_SYNC_SECONDS', 'CALL_MIN_SECS', 'OFFLINE_PACK', 'SALES_DAILY_TARGET',
  // The locked handset's four lines, plus how long silence is forgiven. See device-core.js.
  'DEVICE_LOCK_BRAND', 'DEVICE_LOCK_MESSAGE', 'DEVICE_HELP_PHONE', 'DEVICE_LOCK_REASON',
  'DEVICE_OFFLINE_GRACE_HOURS',
  /* WHO IS TOLD, by email, when somebody asks or something is decided. Blank means nobody --
     the panes are the record and work without these; see api/_lib/mail.js. EMAIL_FROM is the
     sender, and needs a domain verified with the provider before mail stops landing in spam. */
  'IMPREST_ADMIN_EMAIL', 'IMPREST_CEO_EMAIL', 'HR_EMAIL', 'EMAIL_FROM',
  /* ISSUES_EMAIL is several lines of DEPARTMENT=address so each department hears about its
     own issues; GM_EMAIL hears about escalations. See the issues migration. */
  'ISSUES_EMAIL', 'GM_EMAIL', 'STOCK_EMAIL', 'STOCK_AGING_DAYS', 'STOCK_LOW_ALERT', 'COMMISSION_EMAIL',
  'ADVANCE_DEADLINE_DAY', 'ADVANCE_MAX_PCT', 'LOSS_EMAIL', 'TOPUP_EMAIL',
  /* THE DOOR (IT SOP D). SIGNIN_ALERT_FAILS is how many refusals against one code in the
     window stop being a typo and start being somebody working at it; SECURITY_EMAIL is
     who hears about it. Both blank-safe: 5, and nobody. */
  'SIGNIN_ALERT_FAILS', 'SECURITY_EMAIL',
  /* How many days a LOCKED handset may stay silent before the sync tracker calls it a case
     to chase. Blank means seven; see syncAging. */
  'SYNC_ALERT_DAYS',
  /* ENROLMENT (IT SOP A.4, "notify the RSM/General Manager"). Either plain addresses or one
     BRANCH=address per line, so each region's RSM hears about their own people; a branch with
     no line falls back to any plain address here and then to GM_EMAIL. */
  'ENROL_EMAIL',
  /* THE WEEKLY IT REPORT (IT SOP E, "to the General Manager"). Blank falls back to
     GM_EMAIL; this key exists for an office that wants the CEO or the auditor copied. */
  'IT_REPORT_EMAIL',
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
   who has done nothing wrong except open it early.

   PGRST204 -- "Could not find the 'x' column of 'y' in the schema cache" -- is on this list
   because of what it means HERE. Migrations in this repository are run by hand, so every
   deployment spends time between the deploy and somebody pasting the SQL; in that window a
   write names a column the schema has not got, and PostgREST answers 204 rather than 42P01.
   That is the same fact as a missing table from the caller's point of view -- run the
   migration -- and the callers that pass this to bad() name the file to run. Without it the
   read path said "run the migration" and the write path 500'd on the identical cause. */
function tableMissing(err) {
  const s = String((err && (err.message || err.code)) || err || '');
  return /does not exist|Could not find the table|42P01|PGRST205/i.test(s)
    || (/PGRST204/i.test(s) || /Could not find the '.*' column of/i.test(s));
}

function requireWrite(user) {
  if (isReadOnly(user)) {
    const e = new Error('Msimbo huu ni wa kuangalia tu. / This is a view-only code.'); e.status = 403; throw e;
  }
}
/* ADMIN sees all -- the same rule auth.js's resolveTabs and can() apply, repeated here so
   the portal's own gates can never drift from the enforcement (the owner's word, and the
   bug Hope once had when UI and gate read different rules). */
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
/* THE PHONE REGISTRY IS TWO PANES, BECAUSE IT IS TWO DEPARTMENTS.
   ---------------------------------------------------------------------------------------------
     "we now want storekeeper to always lock and general duty will be unlocking at customer
      screening-pos ... all see the devices but no unlocking button in locking .. but the
      lockers will be able to relock the devices"

   devlock     the store keeper's bench: enrol, lock, RE-lock, write off, mint a token
   devunlock   general duty at the POS: unlock, and release a finished loan

   BOTH SEE EVERY PHONE. Splitting the READING would leave the store keeper unable to tell
   whether the handset they are about to ship is locked, which is the one thing they must
   know. What is split is what each may DO.

   THE GATE IS ON THE TRANSITION, NOT ON THE PANE. deviceSetState is one door for all four
   state changes, and a pane that merely hides its unlock button is a suggestion -- curl does
   not read HTML. So the server asks which nav the ASKED-FOR state requires, and the two panes
   only stop offering what would be refused.

   NOTHING A HANDSET OBSERVES CHANGES. A phone learns what to do from commandFor(state) in
   device-core.js, over /api/device, with its own per-device token; it has never known what a
   nav is. Over two hundred locked handsets are in the field, kilometers away -- this is a
   permission change and must stay one.

   `devices` REMAINS AS A LEGACY GRANT, expanded in navsFor to both. Every code and role that
   holds it today keeps exactly what it had; the owner re-ticks at leisure, and only then does
   anybody lose the half they should not have had. ADMIN and AUDITOR see every pane, as
   everywhere. */
/* THE THREE SALARY-ADVANCE PANES, granted the ordinary way and to nobody by default.
   -------------------------------------------------------------------------------------
     "i'll grant navs to who performs what so the navs are the roles"   "not roles"

   Asking for an advance, deciding on one, and paying it are three different powers held by
   three different people, so they are three panes rather than one pane with hidden buttons.

   NOTHING IN THIS CODE EVER ASKS WHAT SOMEBODY'S ROLE IS. There is no `role === 'HR'` and no
   LEADER role; the gate is only ever "do you hold this nav". The owner makes an HR role and
   ticks advrep on it, and that IS the permission -- the role name is a container for the
   grant, never a rule the server reads.

   Adding them here grants them to no existing code: navsFor returns `chosen` for any role
   that has deliberately picked panes, so a role saved yesterday keeps exactly what it had
   until somebody ticks a new box. ADMIN and AUDITOR see every pane, as everywhere. */
/* IMPREST AND LEAVE follow the advance rule exactly: six panes, six navs, nobody by default.
     "since am using tabs as roles so request tab, approval tab and imprest reports tab"
     "All staff can request leaves / HR can grant leave / REPORTS are seen by CEO, Admin, HR and
      Finance ... so for leaves we should have requests, approval and reports"
   impreq asks, impappr decides (and keeps the per-role accommodation rates), imprep is the
   CEO's review copy -- logs, retirements, widgets. leavereq asks, leaveappr is HR's desk,
   leaverep is the report the CEO, HR and Finance read. */
/* ISSUES: raise, work, report -- the same three-nav shape. issuereq is anybody who may raise
   one (an RSM, an officer); issues is the DESK, one nav for whoever works them, with the
   department as a filter rather than a nav each; issuerep is the log book the CEO reads.
     "Log every issue raised by an agent or team leader using the designated complaint
      link/tool, which routes the issue to the appropriate department" (RSM SOP C.1) */
/* WHICH NAV EACH DEVICE TRANSITION NEEDS (the owner's split: "storekeeper to always lock and
   general duty will be unlocking at customer screening-pos").

     locked    devlock     the order that shuts a handset -- and re-shuts a released one
     lost      devlock     a write-off is the bench's own stock accountability
     enrolled  devunlock   FUNGUA: the customer paid, open the phone
     released  devunlock   ACHIA: the loan is finished, let it go for good

   Written as data rather than as branches inside the handler, because a fifth state added
   later with no entry here is refused outright by the hasOwnProperty check above -- which is
   the safe direction. A missing case that defaulted to "allowed" is how a nav split quietly
   stops splitting anything. */
const DEVICE_STATE_NAV = { locked: 'devlock', lost: 'devlock', enrolled: 'devunlock', released: 'devunlock' };
const NAV_TABS = ['dashboard', 'customers', 'reports', 'furep', 'recovery', 'fraud', 'scorecards', 'stock', 'movement', 'stockreq', 'stockappr', 'stockrep', 'newstock', 'oldstock', 'targets', 'commission', 'commappr', 'lossreq', 'loss', 'topupreq', 'topups', 'devlock', 'devunlock', 'advreq', 'advappr', 'advrep', 'impreq', 'impappr', 'imprep', 'leavereq', 'leaveappr', 'leaverep', 'issuereq', 'issues', 'issuerep', 'enrol', 'security', 'itrep', 'staff', 'codes', 'settings'];
const LEGACY_NAVS = ['dashboard', 'customers', 'reports', 'recovery', 'staff'];
/* ADMIN IS FULL ACCESS EVERYWHERE WE DEVELOP -- the owner's standing rule, stated once here
   and used by every rule that follows. A read-only AUDITOR code rides along: it is supervision,
   it sees the whole system, and requireWrite stops it changing any of it. */
const advSeesEveryRole = user => isAdminRole(user) || isReadOnly(user);

/* THE APPROVAL NAV IS THE WHOLE GRANT, like every other nav.
   ---------------------------------------------------------------------------------------------
     "Hoop doesnt need the deprt leader approval for salary advance they want just requests and
      approval or rejection with comments: so people will only request then then approval nav
      is done by a single person and we stay with reports, so kill the kiongozi column and its
      working scheme just a approval nav will be granted to approver"

   There WAS a second switch here -- Kiongozi, on the access code -- and a same-department
   filter on the queue, both from a time when each department's leader was to approve their own
   people. One approver for the company makes both of them ceremony: the owner ticks advappr on
   that one person, and the tick is the permission. The is_leader column stays in the database,
   because a column that exists harms nothing and a migration that drops one can; nothing reads
   it any more. */
/* A WORD FROM BEFORE PANES WERE CHOOSABLE. The roles editor can only ever tick a NAV_TABS
   key, and the two stored ALIASES are expanded above -- so anything else on a row (followup,
   par, present, weekly, upload, audit) is a word this system can no longer hand out, and can
   only have been saved back when the vocabulary was different.

   Derived from the live lists rather than written out, so it cannot fall out of step with
   them: a nav added tomorrow stops counting as legacy the moment it is grantable. */
const isLegacyWord = k => !NAV_TABS.includes(k) && k !== 'sales' && k !== 'devices';

/* WORDS THAT MEAN BOTH THINGS. A handful of nav keys were ALSO in the old vocabulary, so
   finding one on a row proves nothing about whether anybody ticked it: dashboard, reports,
   commission and settings all arrive by themselves on a code saved years ago.

   This list used to be written out as `k !== 'dashboard' && k !== 'settings'` -- correct when
   it was written, and quietly wrong from the day `commission` was added to NAV_TABS. Nobody
   revisits a hand-written exclusion list, so the consequence sat there: a code whose role had
   never been configured resolved to the old vocabulary, `reports` made the guard read it as a
   deliberate choice, and `commission` came along with it. Somebody nobody had ticked anything
   for could build a commission sheet and pay agents.

   Derived from the two live lists now, so it cannot go stale again. */
const AMBIGUOUS_NAVS = new Set(NAV_TABS.filter(k => USER_TABS.includes(k) || EXTRA_TABS.includes(k)));

function navsFor(user) {
  if (advSeesEveryRole(user)) return NAV_TABS.slice();
  const t = (user.tabs || []).map(x => String(x).toLowerCase());
  if (t.includes('sales')) t.push('fraud', 'scorecards', 'stock', 'movement');
  /* THE LEGACY DEVICE GRANT. A code or role ticked `devices` before the split gets both
     halves, so nobody's bench went dark the morning this shipped. Re-ticking is what
     separates them, and that is the owner's act rather than a deploy's. */
  if (t.includes('devices')) t.push('devlock', 'devunlock');
  const chosen = NAV_TABS.filter(k => t.includes(k));
  // A nav that is NOT also an old-vocabulary word can only have been ticked on purpose, so
  // the moment one appears the list is a deliberate choice and is honoured whole.
  if (chosen.some(k => !AMBIGUOUS_NAVS.has(k))) return chosen;
  /* THE TICKS ARE THE GRANT, AND THE OLD VOCABULARY IS HOW WE KNOW THERE WERE NO TICKS.
     -------------------------------------------------------------------------------------
       "their navs by ticking and not the whole dept"

     The legacy defaults below exist for one reason: a code saved BEFORE panes were choosable
     carries the old vocabulary -- followup, par, present, weekly -- and would go dark if that
     were read as "nothing ticked". LEGACY_VOCAB is exactly those words: in USER_TABS, and not
     a nav anybody can tick today. So a row carrying one of them is a row from back then.

     Anything else is a deliberate choice and is honoured EXACTLY, including a choice of one
     pane and including a choice of none. Ticking only Dashboard used to fall through here and
     quietly hand over Customers, Call reports, Recovery and Staff as well -- which is the
     "whole dept" the owner is asking us to stop doing. */
  if (t.some(isLegacyWord)) {
    const base = LEGACY_NAVS.slice();
    if (t.includes('settings')) base.push('codes', 'settings');
    if (t.includes('settings') || t.includes('upload')) base.push('fraud', 'scorecards', 'stock', 'movement');
    return base;
  }
  return chosen;
}
/* ---------- SALARY ADVANCE: the shape all three panes agree on ---------- */
/* THE ONLY AMOUNTS THERE ARE. The owner named four and the request is a dropdown, so this is
   the whole vocabulary -- and it is enforced on the SERVER as well as drawn on the screen,
   because a dropdown is only a suggestion to anything that is not a browser. The approver
   picks from the same four, which is what makes "give this 200k request just 100k" a click
   rather than a typed figure nobody can check. */
const ADV_AMOUNTS = [50000, 100000, 150000, 200000];
const ADV_COLS = 'id, requested_at, staff_code, staff_name, staff_role, apply_date, amount, '
  + 'status, approved_amount, comment, decided_by, decided_at, bank_name, account_no';
/* THE SAME COLUMNS PLUS THE THREE SOP G RULES. Kept as a separate string, and every read that
   uses it falls back to the plain one, because these columns arrive with a migration that is
   run by hand: between the deploy and the paste, a pane that insisted on them would be down. */
const ADV_COLS_RULES = ADV_COLS + ', late, salary_at_request, cap_amount, paid_at, paid_by, '
  + 'payment_ref, deducted_at, deducted_by, deduct_period';
const ADV_QUEUE_COLS_RULES = 'id, requested_at, staff_code, staff_name, staff_role, apply_date, '
  + 'amount, status, approved_amount, comment, decided_by, decided_at, late, salary_at_request, cap_amount';
const ADV_RULES_NOT_READY = 'Kanuni za advance hazijawekwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-09-advance-rules.sql kwenye Supabase. '
  + '/ The advance rule columns do not exist yet — run that migration first.';
/* A read that wants the rule columns and settles for the row without them. Returns the rows
   and whether the rules were actually there, so a caller can say so on screen. */
async function advSelect(db, build, wide, narrow) {
  try {
    return { rows: await fetchAll(() => build(wide)), rules: true };
  } catch (e) {
    if (!/late|salary_at_request|cap_amount|paid_at|deducted_at|deduct_period|payment_ref/i.test(String(e && e.message))) throw e;
    return { rows: await fetchAll(() => build(narrow)), rules: false };
  }
}
/* THE NUMBERS SOP G FIXES, as settings with the SOP's own values as the fallback, so an unset
   key is never a disabled rule. */
async function advPolicy(db) {
  const out = { deadlineDay: 15, maxPct: 40, maxPerMonth: ADV_PER_MONTH_DEFAULT };
  try {
    const rows = await fetchAll(() => db.from('settings').select('key, value')
      .in('key', ['ADVANCE_DEADLINE_DAY', 'ADVANCE_MAX_PCT', 'ADVANCE_MAX_PER_MONTH']));
    for (const r of rows) {
      const v = parseInt(String(r.value == null ? '' : r.value).replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(v)) continue;
      if (r.key === 'ADVANCE_DEADLINE_DAY' && v >= 1 && v <= 31) out.deadlineDay = v;
      if (r.key === 'ADVANCE_MAX_PCT' && v >= 1 && v <= 100) out.maxPct = v;
      if (r.key === 'ADVANCE_MAX_PER_MONTH' && v >= 1 && v <= 31) out.maxPerMonth = v;
    }
  } catch (e) { /* the SOP's own numbers stand */ }
  return out;
}
/* ONE ADVANCE A MONTH.
   =========================================================================================
     "One shouldn't be able to request advance more than once in a single month from now on.
      One had been there and second real one already, so I rejected the 1st one with comment
      trial -- that's why we don't need to treat the old one but treat the future, from now on."

   A DECLINED REQUEST DOES NOT COUNT, and that is the whole shape of this rule rather than a
   detail. The owner's own fix for the duplicate was to DECLINE the trial so the real one could
   stand; if a decline still blocked, that fix would not have worked and the person would be
   locked out of a month by a mistake somebody else made. So a decline is the eraser, and
   pending or approved is what occupies the month.

   MEASURED ON THE MONTH THE ADVANCE IS *FOR*, not the day the button was pressed. The whole
   point is one advance against one payroll month -- SOP G.5's ceiling is a percentage of that
   month's salary -- and requested_at would let two requests for September be filed either side
   of the 1st of October and both stand.

   "FROM NOW ON" means the rule governs new requests; it does not go back and change, flag or
   delete anything already filed. A month that already holds two live requests keeps them and
   simply cannot take a third. */
const ADV_PER_MONTH_DEFAULT = 1;
const monthOf = d => String(d || '').slice(0, 7);
/** The live requests this person already has for the month `applyDate` falls in. Declined rows
    are not live. Returns [] where the question cannot be asked -- no code, or no table yet --
    because a rule that cannot be checked must not become a refusal. */
async function advSameMonth(db, code, applyDate) {
  const month = monthOf(applyDate);
  if (!code || month.length !== 7) return [];
  try {
    const rows = await fetchAll(() => db.from('staff_advances')
      .select('id, apply_date, amount, status, requested_at')
      .eq('staff_code', code).neq('status', 'declined'));
    return rows.filter(r => monthOf(r.apply_date) === month);
  } catch (e) { return []; }
}
/** The staff register, with `manager` where the column exists. One reader for every pane that
    needs the hierarchy, so the directory, the channel editor and the save can never be looking
    at three different shapes of the same table. */
async function staffAgents(db) {
  const WIDE = 'name, phone, role, branch, manager, active, joined_date';
  const NARROW = 'name, phone, role, branch, active, joined_date';
  try {
    return await fetchAll(() => db.from('hoop_agents').select(WIDE));
  } catch (e) {
    if (!/manager/i.test(String(e && e.message))) throw e;
    return await fetchAll(() => db.from('hoop_agents').select(NARROW));
  }
}
/** The monthly salary on file for one access code, or null when HR has not entered one. */
async function salaryOf(db, code) {
  if (!code) return null;
  try {
    const { data } = await db.from('staff_salaries').select('monthly_salary').eq('staff_code', code).maybeSingle();
    return data && data.monthly_salary != null ? num(data.monthly_salary) : null;
  } catch (e) { return null; }
}
/* THE APPROVER'S QUEUE ASKS FOR LESS, because it is answering a smaller question.
   ---------------------------------------------------------------------------------------------
   Deciding an advance needs to know who asked, for how much, and against which date. It does
   not need to know where the money will be sent -- that is HR's job, behind the advrep nav, and
   the panes were split three ways precisely so that holding one power does not hand over the
   others. Selecting the bank columns for a pane that never displays them made advappr quietly
   include a power nobody granted it: every approver could read every colleague's bank name and
   full account number straight off the API response.

   Narrowed at the SELECT rather than dropped on the way out, so the details never leave
   Postgres for a request that has no business seeing them. */
const ADV_QUEUE_COLS = 'id, requested_at, staff_code, staff_name, staff_role, apply_date, '
  + 'amount, status, approved_amount, comment, decided_by, decided_at';
const ADV_NOT_READY = 'Jedwali la advance halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-08-29-salary-advance.sql kwenye Supabase. '
  + '/ The salary advance table has not been created yet — run that migration first.';
/* How long a phone counts as "just enrolled" and rides at the top of the register. A day,
   because that is the length of a bench session and the life of an enrol batch -- so the band
   empties itself by the next morning with nothing to switch off. */
const FRESH_ENROL_MS = 24 * 60 * 60 * 1000;

/* ---------- IMPREST AND LEAVE: the shapes all five panes agree on ---------- */
const IMP_NOT_READY = 'Jedwali la imprest halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-07-imprest-leave.sql kwenye Supabase. '
  + '/ The imprest tables have not been created yet — run that migration first.';
const LEAVE_NOT_READY = 'Jedwali la likizo halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-07-imprest-leave.sql kwenye Supabase. '
  + '/ The leave table has not been created yet — run that migration first.';
/* THE MOST A RECEIPT MAY WEIGH. The phone shrinks each photo before sending (long side 1024px,
   JPEG ~0.6, usually 60-120KB); this is the ceiling the server holds regardless of what the
   client did, because a client is not entitled to fill a table with 8MB originals. */
const IMP_PHOTO_MAX_BYTES = 200 * 1024;
const IMP_PHOTO_MAX = 3;
/* AND THE LEAST. A receipt the phone shrank to 480px is still a few kilobytes; a data URL of
   one padding character passed the old shape check with a size of minus one. Below this it is
   not a picture of anything. */
const IMP_PHOTO_MIN_BYTES = 1024;
/* How old a retirement CLAIM must be before it is wreckage rather than a filing in progress:
   longer than any serverless function is allowed to live. See impRetire. */
const RETIRE_CLAIM_MS = 2 * 60 * 1000;
const IMP_COLS = 'id, requested_at, staff_code, staff_name, staff_role, full_name, mobile, '
  + 'recipient_name, email, imprest_role, pay_mode, account_no, travel_date, destination, '
  + 'fare_trips, fare_per_trip, fare_amount, accom_days, accom_rate, accom_amount, '
  + 'other1_desc, other1_amount, other2_desc, other2_amount, other3_desc, other3_amount, '
  + 'total_amount, purpose, status, approved_amount, comment, decided_by, decided_at, '
  + 'retired_at, retire_total, retire_balance';
const IMP_RET_COLS = 'request_id, filed_at, filed_by_name, fare_actual, accom_actual, '
  + 'other1_actual, other2_actual, other3_actual, total_actual, notes, photo_count';
const LEAVE_COLS = 'id, requested_at, staff_code, staff_name, staff_role, employee_id, department, '
  + 'supervisor, leave_type, other_type, from_date, to_date, working_days, resume_date, reason, '
  + 'contact, handed_to, declared, short_notice, status, comment, decided_by, decided_at';
const LEAVE_TYPES = ['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'other'];
/* The form: "submitted at least ONE (1) WEEK before intended leave date (except emergency,
   sudden illness, or bereavement)". These two are the exceptions; everything else filed under
   a week ahead is marked, not refused -- HR weighs it. */
const LEAVE_NO_NOTICE_TYPES = ['sick', 'compassionate'];

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
/* SHAPE AND THEN CALENDAR -- the same two-step check advRequest uses, for the same reason: a
   regex says it looks like a date, and only a Date round-trip says it is one. */
const isDay = s => {
  const v = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
/* A NON-NEGATIVE WHOLE NUMBER, or nothing. Money and counts here are integers -- a fare is
   never 12,500.75 -- and a value that is not one is refused rather than rounded, because a
   silently rounded figure on a cash form is the argument the form exists to prevent. */
const intNN = v => {
  if (v === '' || v == null) return 0;
  /* A number, or the digits of one. Booleans, arrays and hex strings all coerce under Number()
     -- true is 1, [7] is 7, "0x10" is 16 -- and none of them is a shilling amount anybody typed. */
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\s*\d+(?:\.0+)?\s*$/.test(v))) return null;
  const n = Number(v);
  // Above this the integer column itself would refuse the row, as a 500 with Postgres's
  // words in it; two billion shillings is not a figure this form will ever carry honestly.
  return Number.isInteger(n) && n >= 0 && n <= MONEY_MAX ? n : null;
};
const MONEY_MAX = 2000000000;
/* A leave longer than this is not a leave request, and a span of years typed by mistake
   would otherwise be walked day by day below. */
const LEAVE_MAX_DAYS = 366;
/* MONDAY TO FRIDAY, INCLUSIVE, on the calendar the dates are written in. */
function workingDaysBetween(from, to) {
  let n = 0;
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}
/* THE FIRST WORKING DAY AFTER THE LEAVE ENDS. */
function resumeDayAfter(to) {
  let d = addDaysKey(to, 1);
  for (let i = 0; i < 7; i++) {
    const wd = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
    if (wd !== 0 && wd !== 6) return d;
    d = addDaysKey(d, 1);
  }
  return d;
}
/* A DATA URL THAT IS A SMALL IMAGE, AND ITS WEIGHT IN BYTES. Refuses anything that is not an
   image data URL outright; the caller compares bytes to the ceiling. */
function photoBytes(s) {
  const v = String(s || '');
  // Base64 as the canvas writes it: whole quartets, padding only at the end.
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(v);
  if (!m || !m[2]) return null;
  const b64 = m[2];
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - pad;
}

/* ONE SHAPE ON THE WIRE, and the access code never on it -- same rule as advRow. */
const impRow = (r, me) => ({
  id: String(r.id),
  at: r.requested_at ? Date.parse(r.requested_at) : null,
  mine: !!(me && r.staff_code && String(r.staff_code) === String(me)),
  staffName: r.staff_name || '',
  staffRole: r.staff_role || '',
  fullName: r.full_name || '',
  mobile: r.mobile || '',
  recipientName: r.recipient_name || '',
  email: r.email || '',
  imprestRole: r.imprest_role || '',
  payMode: r.pay_mode || '',
  accountNo: r.account_no || '',
  travelDate: r.travel_date ? String(r.travel_date).slice(0, 10) : '',
  destination: r.destination || '',
  fareTrips: num(r.fare_trips), farePerTrip: num(r.fare_per_trip), fareAmount: num(r.fare_amount),
  accomDays: num(r.accom_days), accomRate: num(r.accom_rate), accomAmount: num(r.accom_amount),
  other1Desc: r.other1_desc || '', other1Amount: num(r.other1_amount),
  other2Desc: r.other2_desc || '', other2Amount: num(r.other2_amount),
  other3Desc: r.other3_desc || '', other3Amount: num(r.other3_amount),
  total: num(r.total_amount),
  purpose: r.purpose || '',
  status: r.status || 'pending',
  approved: r.approved_amount == null ? null : Number(r.approved_amount),
  comment: r.comment || '',
  decidedBy: r.decided_by || '',
  decidedAt: r.decided_at ? Date.parse(r.decided_at) : null,
  /* FINISHED, not merely claimed: retired_at is stamped first as the lock a filing takes, and
     retire_total last when the receipts are in. Only the second makes a trip "retired" anywhere
     this row is read -- the queue, the report, the Retire button -- so a filing that died
     half-way shows as not retired everywhere at once. See impRetire. */
  retiredAt: (r.retired_at && r.retire_total != null) ? Date.parse(r.retired_at) : null,
  retireTotal: r.retire_total == null ? null : Number(r.retire_total),
  retireBalance: r.retire_balance == null ? null : Number(r.retire_balance),
});
const leaveRow = (r, me) => ({
  id: String(r.id),
  at: r.requested_at ? Date.parse(r.requested_at) : null,
  mine: !!(me && r.staff_code && String(r.staff_code) === String(me)),
  staffName: r.staff_name || '',
  staffRole: r.staff_role || '',
  employeeId: r.employee_id || '',
  department: r.department || '',
  supervisor: r.supervisor || '',
  type: r.leave_type || '',
  otherType: r.other_type || '',
  from: r.from_date ? String(r.from_date).slice(0, 10) : '',
  to: r.to_date ? String(r.to_date).slice(0, 10) : '',
  workingDays: num(r.working_days),
  resume: r.resume_date ? String(r.resume_date).slice(0, 10) : '',
  reason: r.reason || '',
  contact: r.contact || '',
  handedTo: r.handed_to || '',
  declared: !!r.declared,
  shortNotice: !!r.short_notice,
  status: r.status || 'pending',
  comment: r.comment || '',
  decidedBy: r.decided_by || '',
  decidedAt: r.decided_at ? Date.parse(r.decided_at) : null,
});
/* Pending first (a queue is a worklist), then newest. Shared by every queue and log here. */
const pendingFirst = (x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1)
  || (y.at || 0) - (x.at || 0);

/* ---------- ISSUES: the shapes the three panes agree on ---------- */
const ISSUE_ROUTE_NOT_READY = 'Uelekezaji bado haujawashwa. Endesha '
  + 'db/migrations/RUN-ME-2026-09-10-issue-routing.sql kwenye Supabase ili masuala '
  + 'yaelekezwe kwa wadhifa na mtu. / Routing is not switched on yet — run that migration.';
const ISSUE_NOT_READY = 'Jedwali la masuala halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-08-issues.sql kwenye Supabase. '
  + '/ The issues table has not been created yet — run that migration first.';
/* The departments the SOPs name, as labels a desk filters on. ADMIN is for the things only
   the owner decides. Held here and mirrored in the migration's CHECK, so a label the server
   would refuse is never offered on the form. */
const ISSUE_DEPTS = ['STORE', 'FINANCE', 'IT', 'HR', 'CREDIT', 'SALES', 'GENERAL_DUTY', 'ADMIN'];
const ISSUE_KINDS = ['issue', 'complaint', 'document', 'performance', 'system'];
const ISSUE_SUBJECTS = ['imei', 'agent', 'receipt', 'system', 'other'];
const ISSUE_STATES = ['open', 'waiting', 'escalated', 'resolved'];
const ISSUE_COLS_BASE = 'id, raised_at, staff_code, staff_name, staff_role, department, kind, subject_type, '
  + 'subject, title, details, contact, verified, referred_to, external_ref, status, assigned_to, '
  + 'resolution, escalated_by, escalated_at, resolved_by, resolved_at, updated_by, updated_at';
/* WHOSE DESK IT IS ON. These arrive with a hand-run migration, so every read asks for them
   and settles for the row without them -- between a deploy and somebody pasting the SQL the
   log must keep working, unrouted, rather than going dark. */
const ISSUE_COLS = ISSUE_COLS_BASE + ', to_role, to_name';
const ISSUE_ROUTE_COLS = /to_role|to_name/i;
const issueRow = (r, me, nowMs) => {
  const at = r.raised_at ? Date.parse(r.raised_at) : null;
  const closed = r.resolved_at ? Date.parse(r.resolved_at) : null;
  return {
    id: String(r.id),
    at,
    mine: !!(me && r.staff_code && String(r.staff_code) === String(me)),
    staffName: r.staff_name || '', staffRole: r.staff_role || '',
    department: r.department || '', kind: r.kind || 'issue',
    subjectType: r.subject_type || '', subject: r.subject || '',
    title: r.title || '', details: r.details || '', contact: r.contact || '',
    verified: !!r.verified, referredTo: r.referred_to || '', externalRef: r.external_ref || '',
    status: r.status || 'open', assignedTo: r.assigned_to || '', resolution: r.resolution || '',
    /* WHOSE DESK. A blank toName is not a missing value: it is the raiser saying "anybody in
       this role". The desk reads both, and so does the person looking for their own work. */
    toRole: r.to_role || '', toName: r.to_name || '',
    directed: !!String(r.to_name || '').trim(),
    escalatedBy: r.escalated_by || '', escalatedAt: r.escalated_at ? Date.parse(r.escalated_at) : null,
    resolvedBy: r.resolved_by || '', resolvedAt: closed,
    updatedBy: r.updated_by || '', updatedAt: r.updated_at ? Date.parse(r.updated_at) : null,
    // How long it has been open, or was open: the number a desk sorts by.
    ageDays: at ? Math.max(0, Math.round(((closed || nowMs || Date.now()) - at) / 86400000)) : 0,
  };
};
/** Every issue, asking for the routing columns and settling for the row without them.
    Returns the rows and whether the routing was actually there, so a pane can say so. */
async function issueSelect(db, build) {
  try {
    return { rows: await fetchAll(() => build(ISSUE_COLS)), routed: true };
  } catch (e) {
    if (!ISSUE_ROUTE_COLS.test(String((e && (e.message || e.details)) || ''))) throw e;
    return { rows: await fetchAll(() => build(ISSUE_COLS_BASE)), routed: false };
  }
}
/** IS THIS ON MY DESK? Two ways, and the blank one is the point.

      to_name set     one person's, and only theirs
      to_name blank   everybody holding to_role -- whoever gets to it first

    AN ISSUE WITH NO ROLE ON IT IS ON EVERYBODY'S DESK. It was filed when the desk WAS one
    queue, and that is what it was addressed to -- so it stays addressed to it. Matching the
    department against somebody's role instead would have been a guess, and a wrong guess here
    means an old issue quietly falling off every desk in the company on deploy day. Routing
    applies to the rows that carry it; the rest are unchanged. */
function issueOnMyDesk(r, user) {
  if (!r.toRole) return true;
  if (K(r.toRole) !== K(user && user.role)) return false;
  return !r.toName || K(r.toName) === K(user && user.name);
}

/* ISSUES_EMAIL is lines (or semicolons) of DEPARTMENT=address,address. Anything that does not
   parse is ignored rather than refused: this is a courtesy setting, and a typo in it must
   never stop an issue being filed. */
function issueDeptEmails(value, dept) {
  const want = K(dept);
  for (const line of String(value || '').split(/[\n;]/)) {
    const m = /^\s*([A-Za-z_ ]+)\s*[=:]\s*(.+)$/.exec(line);
    if (m && K(m[1]).replace(/ /g, '_') === want) return m[2].trim();
  }
  return '';
}
const issueOpenFirst = (x, y) => (x.status === 'resolved' ? 1 : 0) - (y.status === 'resolved' ? 1 : 0)
  || (y.at || 0) - (x.at || 0);

/* ---------- THE CREDIT DEPARTMENT'S DAY, in the words the SOP asks for ----------
     Credit SOP A.5 "Generate a report covering: stolen devices, maintenance, not available,
                     paid, unpaid, and unresponded calls"
     Credit SOP A.6 "Send the report to the General Manager"

   SIX BUCKETS THAT PARTITION THE CUSTOMER, not the call -- so the numbers add up and a GM can
   read them as shares of the book. A customer counted twice is worse than a customer missed:
   the follow-up that was logged decides the bucket, and only where nothing was logged does the
   dialling decide it. In order:

     something logged  -> paid / unpaid / notAvailable / stolen / maintenance, by the WORDS of
                          the status (fuBucketOf), because FU_STATUSES is editable and a report
                          keyed to exact strings stops counting the day somebody adds a word
     nothing logged, dialled     -> unresponded   ("we rang, nothing came back")
     nothing logged, never dialled -> notCalled   (not one of the six; the honest denominator,
                          the number that says how much of the book was never touched)

   A promise is NOT money: AMETOA AHADI is unpaid until the deck says otherwise. */
const FU_BUCKET_LABEL = {
  paid: 'Wamelipa / Paid',
  unpaid: 'Hawajalipa / Unpaid',
  notAvailable: 'Hawapatikani / Not available',
  stolen: 'Simu zimeibiwa au zimepotea / Stolen or lost',
  maintenance: 'Matengenezo / Maintenance',
  unresponded: 'Hawakujibu / Unresponded calls',
  notCalled: 'Hawajapigiwa / Not called in this period',
};
const FU_REPORT_KINDS = FU_BUCKETS.concat(['unresponded', 'notCalled']);
/* The EAT day a timestamp falls on. followup_comments stamps `created_at` as a timestamptz, so
   the day it belongs to is the day in Dar es Salaam, not the day in UTC -- otherwise every
   follow-up logged before 03:00 lands in yesterday's report. */
const eatDayOf = ts => {
  const ms = Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10) : '';
};

/* ---------- STOCK REQUESTS AND THE AGING GATE (Store SOP B and E) ---------- */
const STOCK_NOT_READY = 'Jedwali la maombi ya stoo halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-09-stock-requests.sql kwenye Supabase. '
  + '/ The stock request tables have not been created yet — run that migration first.';
const STOCK_STATES = ['pending', 'approved', 'rejected', 'issued', 'cancelled'];
const STOCK_COLS = 'id, requested_at, staff_code, staff_name, staff_role, holder, destination, '
  + 'item, qty, reason, aging_count, aging_oldest_days, aging_as_of, status, approved_qty, comment, '
  + 'decided_by, decided_at, aging_override, aging_override_reason, issued_at, issued_by, updated_by, updated_at';
const stockRow = (r, me) => ({
  id: String(r.id),
  at: r.requested_at ? Date.parse(r.requested_at) : null,
  mine: !!(me && r.staff_code && String(r.staff_code) === String(me)),
  staffName: r.staff_name || '', staffRole: r.staff_role || '',
  holder: r.holder || '', destination: r.destination || '',
  item: r.item || '', qty: num(r.qty), reason: r.reason || '',
  agingCount: r.aging_count == null ? null : num(r.aging_count),
  agingOldestDays: r.aging_oldest_days == null ? null : num(r.aging_oldest_days),
  agingAsOf: r.aging_as_of ? String(r.aging_as_of).slice(0, 10) : '',
  status: r.status || 'pending',
  approvedQty: r.approved_qty == null ? null : num(r.approved_qty),
  comment: r.comment || '',
  decidedBy: r.decided_by || '', decidedAt: r.decided_at ? Date.parse(r.decided_at) : null,
  agingOverride: !!r.aging_override, agingOverrideReason: r.aging_override_reason || '',
  issuedAt: r.issued_at ? Date.parse(r.issued_at) : null, issuedBy: r.issued_by || '',
  updatedAt: r.updated_at ? Date.parse(r.updated_at) : null,
});
/* PENDING FIRST, then whatever is still going to move, then the settled. A store desk's list
   is a worklist: an issued note from Tuesday is history, a request from Tuesday is not. */
const STOCK_RANK = { pending: 0, approved: 1, issued: 2, rejected: 3, cancelled: 4 };
const stockWorkFirst = (x, y) => (STOCK_RANK[x.status] - STOCK_RANK[y.status]) || (y.at || 0) - (x.at || 0);

/** How many days old is "aging" here, and how few pieces is "low". Settings, per SOP E and G,
    with the SOP's own numbers as the fallback so an unset key is never a disabled policy. */
async function stockPolicy(db) {
  const out = { agingDays: 5, lowAlert: 1500 };
  try {
    const rows = await fetchAll(() => db.from('settings').select('key, value')
      .in('key', ['STOCK_AGING_DAYS', 'STOCK_LOW_ALERT']));
    for (const r of rows) {
      const v = parseInt(String(r.value == null ? '' : r.value).replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(v) || v < 0) continue;
      if (r.key === 'STOCK_AGING_DAYS') out.agingDays = v;
      if (r.key === 'STOCK_LOW_ALERT') out.lowAlert = v;
    }
  } catch (e) { /* the SOP's own numbers stand */ }
  return out;
}

/* OLD STOCK -- what we hold and have never locked, and how old it is TODAY.
   =========================================================================================
     "For an OLD STOCK new nav pane for all those stock that imei no does not exist in our new
      enrolled phones. So we have NEW STOCK and OLD STOCK (never enrolled)."

     "They start reading with those aging days off, so everyday that goes they've not yet been
      enrolled they continue to count aging."

   THE AGE IS ARITHMETIC, NEVER A STORED NUMBER. `age_days` was true on `as_of`; today's age is
   that number plus the days since. Re-saving an age every night would need a job somebody has
   to keep alive, and the morning it did not run the whole list would quietly understate itself.

   A ROW LEAVES THIS LIST BY BEING FOUND SOMEWHERE ELSE -- in `devices` because we locked it on
   a ground visit, or in the deck because it sold. Both are asked here, at read time. A `moved`
   column would be a second opinion about a question the data already answers, and the day the
   two disagreed a handset would be on both lists or on neither. */
const OLDSTOCK_NOT_READY = 'Jedwali la OLD STOCK halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-12-old-stock.sql kwenye Supabase, kisha pakia orodha ya Sipho. '
  + '/ The old_stock table has not been created yet — run that migration, then load the list.';
/* Whole days between two ISO days. NOT daysBetween() -- that one returns the LIST of days in a
   range, which added to a number gives NaN and would have put "NaN" in the age column of every
   row. Parsed at UTC midnight so a timezone can never move an age by a day. */
const daysApart = (fromK, toK) => {
  const a = Date.parse(String(fromK || '') + 'T00:00:00Z');
  const b = Date.parse(String(toK || '') + 'T00:00:00Z');
  return (isNaN(a) || isNaN(b)) ? 0 : Math.round((b - a) / 86400000);
};
const ageToday = (r, todayK) => (r.age_days == null ? null
  : num(r.age_days) + Math.max(0, daysApart(String(r.as_of || '').slice(0, 10), todayK)));

/** Every un-enrolled handset, aged to today. One reader, so the pane, the stock report and any
    later caller cannot each hold a different idea of what is still outstanding. */
async function oldStockIndex(db) {
  const todayK = todayKey();
  let rows = [];
  let notReady = false;
  try {
    rows = await fetchAll(() => db.from('old_stock')
      .select('imei, item, agent, agent_phone, rsm, rsm_phone, age_days, as_of'));
  } catch (e) {
    if (!tableMissing(e)) throw e;
    notReady = true;
  }
  /* WHAT HAS SINCE BEEN FOUND. Every read is best-effort: a missing devices table means we have
     locked nothing, which is the honest reading, not a reason to refuse the list. */
  const locked = new Set();
  const sold = new Set();
  try {
    for (const d of await fetchAll(() => db.from('devices').select('imei'))) locked.add(String(d.imei));
  } catch (ignored) { /* nothing enrolled yet */ }

  /* SOLD MEANS SOLD, WHICHEVER BOOK SAYS SO -- and it stays sold after the book forgets.
     -------------------------------------------------------------------------------------
     Three reads, and the third is the one that makes the hand-off permanent:

       watu_loans   the Watu deck
       hoop_sales   our own shop's export -- a different upload, the same event. A handset
                    written in one and not the other used to sit in OLD STOCK with a receipt
                    against it, because only the deck was asked.
       stock_audit  what we STAMPED when it moved. The decks are re-uploaded over themselves
                    with rows gone; a phone that moved in September must not walk back into the
                    un-enrolled list in October because Watu trimmed its export. Once the sale
                    is stamped, the move is done with.

     Membership in stock_audit is not itself evidence -- that table also holds handsets merged
     off the stock report alone -- so it counts only where a sale was actually captured. */
  const feedImeis = async (table, cols) => {
    try { return await fetchAll(() => db.from(table).select(cols)); } catch (ignored) { return []; }
  };
  for (const l of await feedImeis('watu_loans', 'imei')) sold.add(String(l.imei));
  for (const s of await feedImeis('hoop_sales', 'imei')) sold.add(String(s.imei));
  for (const r of await feedImeis('stock_audit', 'imei, sale_date, customer, price')) {
    if (stampedSale(r)) sold.add(String(r.imei));
  }

  const out = rows.map(r => ({
    imei: String(r.imei), item: r.item || '',
    agent: r.agent || '', agentPhone: r.agent_phone || '',
    rsm: r.rsm || '', rsmPhone: r.rsm_phone || '',
    asOf: String(r.as_of || '').slice(0, 10),
    ageStart: r.age_days == null ? null : num(r.age_days),
    age: ageToday(r, todayK),
    lockedNow: locked.has(String(r.imei)),
    soldNow: sold.has(String(r.imei)),
  }));
  return { notReady, todayK, rows: out,
    /* STILL OUTSTANDING is the list this pane is for; the other two are counted so the pane can
       say how the ground visits are going rather than just shrinking silently. */
    open: out.filter(r => !r.lockedNow && !r.soldNow),
    gone: out.filter(r => r.lockedNow || r.soldNow) };
}

/* THE AGING STOCK TRACKER (SOP E.3), read off the shop's OWN daily upload.
   hoop_aged_stock already carries age_days per serial per agent, so the gate and the tracker
   are the same file -- never a second private idea of what "old" means. The newest as_of is
   the tracker: an aging report from last week is not evidence about this morning. */
async function stockAgingIndex(db) {
  const policy = await stockPolicy(db);
  /* THE AGEING NOW COMES FROM THE TWO STOCK PANES, not from a daily upload.
     -------------------------------------------------------------------------------------
       "So use these two navs to update data of aging stock in stock reports -- not uploading
        aged stock for now."

     OLD STOCK is the answer to the question this index asks: what is a holder still sitting
     on, and how old is it. It ages itself from the day its list was made, so it is right every
     morning without anybody uploading anything -- which is exactly why the upload is off.

     hoop_aged_stock is still read, and read FIRST where it has a newer day, because a file
     somebody does paste is more current than a list from last month. Dropping it outright
     would throw away the one feed that can still correct this, and neither list is a superset
     of the other. Where both name a serial, the newer as_of wins. */
  const todayK = todayKey();
  let uploaded = [];
  try {
    uploaded = await fetchAll(() => db.from('hoop_aged_stock').select('serial, agent, item, age_days, as_of'));
  } catch (e) { uploaded = []; }
  let asOf = null;
  for (const r of uploaded) if (r.as_of && (!asOf || String(r.as_of) > String(asOf))) asOf = String(r.as_of).slice(0, 10);
  const fromUpload = uploaded.filter(r => String(r.as_of).slice(0, 10) === asOf);

  /* The un-enrolled list, aged to TODAY rather than to the day it was written -- that is the
     whole reason it can stand in for a daily file. */
  let fromOld = [];
  try {
    const idx = await oldStockIndex(db);
    fromOld = idx.open.map(r => ({ serial: r.imei, agent: r.agent, item: r.item,
      age_days: r.age, as_of: todayK }));
  } catch (ignored) { fromOld = []; }

  const bySerial = new Map();
  for (const r of fromOld) bySerial.set(String(r.serial), r);
  for (const r of fromUpload) {
    const k = String(r.serial);
    const had = bySerial.get(k);
    // The newer day wins; a pasted file from this morning outranks a list from last month.
    if (!had || String(r.as_of || '') >= String(had.as_of || '')) bySerial.set(k, r);
  }
  const today = [...bySerial.values()];
  if (fromOld.length) asOf = asOf && asOf > todayK ? asOf : todayK;
  const by = new Map();
  let pieces = 0;
  for (const r of today) {
    pieces++;
    const k = nameKey(r.agent) || '?';
    let g = by.get(k);
    if (!g) { g = { holder: r.agent || '—', pieces: 0, aging: 0, oldest: 0, items: new Map() }; by.set(k, g); }
    g.pieces++;
    const age = r.age_days == null ? null : num(r.age_days);
    if (age != null) {
      if (age > g.oldest) g.oldest = age;
      // "Beyond the threshold" -- five days means the sixth day is late, not the fifth.
      if (age > policy.agingDays) g.aging++;
    }
    const it = String(r.item || '—');
    g.items.set(it, (g.items.get(it) || 0) + 1);
  }
  return {
    asOf, policy, pieces,
    /** What the gate says about one holder, by name, case- and spacing-insensitively. */
    for(holder) {
      const g = by.get(nameKey(holder) || '?');
      return { holder: (g && g.holder) || String(holder || ''), asOf,
        pieces: g ? g.pieces : 0, aging: g ? g.aging : 0, oldest: g ? g.oldest : 0,
        agingDays: policy.agingDays, blocked: !!(g && g.aging > 0) };
    },
    holders: [...by.values()].map(g => ({ holder: g.holder, pieces: g.pieces, aging: g.aging, oldest: g.oldest,
      items: [...g.items.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(e => e[0] + ' ×' + e[1]).join(', ') }))
      .sort((x, y) => y.aging - x.aging || y.oldest - x.oldest || y.pieces - x.pieces),
  };
}

/* ---------- TOP-UPS / CREDIT SALES (Finance SOP B) ---------- */
const TOPUP_NOT_READY = 'Jedwali la top-up halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-09-topups.sql kwenye Supabase. '
  + '/ The top-up table has not been created yet — run that migration first.';
const TOPUP_STATES = ['requested', 'verified', 'paid', 'unlocked', 'rejected'];
const TOPUP_COLS = 'id, requested_at, staff_code, staff_name, staff_role, imei, customer, '
  + 'customer_phone, payer_name, paid_amount, proof_ref, price, balance, status, comment, '
  + 'verified_by, verified_at, paid_by, paid_at, payment_ref, unlocked_by, unlocked_at, '
  + 'chk_request, chk_paid_to, chk_watu, chk_auditor, updated_by, updated_at';
/* The Top-Up Audit Checklist, in one place the pane and the gate both read. */
const TOPUP_CHECKS = [
  ['chkRequest', 'chk_request', 'Ombi la top-up kutoka kwa ajenti / Top-up request from agent'],
  ['chkPaidTo', 'chk_paid_to', 'Malipo yamekwenda kwenye namba iliyoombwa / Payment paid to the requested number'],
  ['chkWatu', 'chk_watu', 'Uthibitisho wa mauzo kutoka WATU / Approved sales verification from WATU'],
  ['chkAuditor', 'chk_auditor', 'Saini ya mkaguzi / Auditor sign-off'],
];
const topupRow = (r, me, nowMs) => {
  const at = r.requested_at ? Date.parse(r.requested_at) : null;
  const paidAt = r.paid_at ? Date.parse(r.paid_at) : null;
  /* B.5: "this step must never be delayed". The number that makes a delay visible is how long
     the customer has been waiting, and it stops counting the moment the money goes -- not when
     somebody finally ticks the row closed. */
  const waitedTo = paidAt || (nowMs || Date.now());
  return {
    id: String(r.id),
    at,
    mine: !!(me && r.staff_code && String(r.staff_code) === String(me)),
    staffName: r.staff_name || '', staffRole: r.staff_role || '',
    imei: r.imei || '', customer: r.customer || '', customerPhone: r.customer_phone || '',
    payerName: r.payer_name || '', paidAmount: num(r.paid_amount), proofRef: r.proof_ref || '',
    price: r.price == null ? null : num(r.price),
    balance: r.balance == null ? null : num(r.balance),
    status: r.status || 'requested', comment: r.comment || '',
    verifiedBy: r.verified_by || '', verifiedAt: r.verified_at ? Date.parse(r.verified_at) : null,
    paidBy: r.paid_by || '', paidAt, paymentRef: r.payment_ref || '',
    unlockedBy: r.unlocked_by || '', unlockedAt: r.unlocked_at ? Date.parse(r.unlocked_at) : null,
    checks: TOPUP_CHECKS.reduce((o, [js, col]) => { o[js] = !!r[col]; return o; }, {}),
    // Minutes from the request to the payment, or to now while it is still waiting.
    waitedMins: at ? Math.max(0, Math.round((waitedTo - at) / 60000)) : null,
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : null,
  };
};
/* Waiting first, and among those the one who has waited longest -- which is the only sort order
   a rule that says "must never be delayed" can be served by. */
const TOPUP_RANK = { requested: 0, verified: 1, paid: 2, unlocked: 3, rejected: 4 };
const topupWaitFirst = (x, y) => (TOPUP_RANK[x.status] - TOPUP_RANK[y.status]) || (x.at || 0) - (y.at || 0);

/** ONE READ, TWO READERS: the security pane and the weekly IT report both need the window,
    and two copies of "which rows count" is how two screens come to report different numbers
    for the same week. Never throws for a missing table -- that is a migration, not a fault. */
async function signinWindow(db, from, to) {
  try {
    const raw = await fetchAll(() => db.from('signin_attempts').select(SIGNIN_COLS)
      .gte('day', from).lte('day', to).order('at', { ascending: false }).limit(4000));
    return { rows: raw.map(signinRow), notReady: false };
  } catch (e) {
    if (!tableMissing(e)) throw e;
    return { rows: [], notReady: true };
  }
}
/** How many refusals against one code stop being a typo. A setting, because the SOP names no
    number; an unreadable or nonsense value falls back to the judgement in code. */
async function signinAlertFails(db) {
  try {
    const { data } = await db.from('settings').select('value').eq('key', 'SIGNIN_ALERT_FAILS').maybeSingle();
    const n = parseInt(String((data && data.value) || '').replace(/[^0-9]/g, ''), 10);
    return (Number.isFinite(n) && n >= 1 && n <= 500) ? n : SIGNIN_ALERT_DEFAULT;
  } catch (e) { return SIGNIN_ALERT_DEFAULT; }
}

/* ---------- ENROLMENT (IT SOP A; asked for again by RSM SOP E.1 and CSM SOP H.1) ---------- */
const ENROL_NOT_READY = 'Safu za usajili hazipo bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-10-enrolment.sql kwenye Supabase. '
  + '/ The enrolment columns do not exist yet — run that migration first.';
/* SOP A.1's LIST, in one place the form, the gate and the report all read.

   It is a list here rather than a set of NOT NULLs in the schema for one reason: the register
   is ALSO filled by uploading Sipho's SyscoPos page, and a constraint would make that upload
   fail on somebody else's missing field rather than showing it as a gap. A required field with
   nowhere to show the gap is a required field that stops the day's work.

   EMAIL IS NOT ON THE LIST. "Contact information" is satisfied by the phone number, which is
   the register's own key and therefore always present; insisting on an address as well would
   mark half the field officers incomplete for a thing the SOP does not ask for. It is on the
   form, where somebody can fill it in. */
const ENROL_FIELDS = [
  ['name', 'name', 'Jina kamili / Full name'],
  ['nationalId', 'national_id', 'Namba ya kitambulisho / ID number'],
  ['phone', 'phone', 'Namba ya simu / Contact number'],
  ['role', 'role', 'Wadhifa / Role'],
  ['branch', 'branch', 'Tawi / Branch'],
  ['kinName', 'kin_name', 'Mdhamini wa kwanza / First referee'],
  ['kinPhone', 'kin_phone', 'Namba ya mdhamini / First referee’s number'],
  /* "REFEREES", PLURAL, in the SOP. The register had one slot. */
  ['kin2Name', 'kin2_name', 'Mdhamini wa pili / Second referee'],
  ['kin2Phone', 'kin2_phone', 'Namba ya mdhamini wa pili / Second referee’s number'],
];
const ENROL_COLS_WIDE = 'phone, name, national_id, email, role, branch, manager, active, '
  + 'joined_date, kin_name, kin_phone, kin_relationship, kin2_name, kin2_phone, '
  + 'kin2_relationship, enrolled_by, enrolled_at, verified_by, verified_at, notified_at, '
  + 'notified_to, enrol_note, updated_at';
/* The register as it is BEFORE either hand-run migration. `manager` arrives with the targets
   file and the rest with this one, so a desk opened between a deploy and a paste still lists
   everybody -- it simply cannot verify anybody yet, and says so. */
const ENROL_COLS_NARROW = 'phone, name, national_id, email, role, branch, active, joined_date, '
  + 'kin_name, kin_phone, kin_relationship, updated_at';
const ENROL_NEW_COLS = /kin2_|enrolled_by|enrolled_at|verified_by|verified_at|notified_at|notified_to|enrol_note|manager/i;

/** THE REGISTER'S OWN PHONE FORMAT: 0-leading, as SyscoPos writes it, because `phone` is the
    primary key and two spellings of one number are two people. Returns '' for anything that is
    not a Tanzanian mobile number, so the caller can refuse rather than create a second row for
    somebody who already exists. */
function phone0(v) {
  const d = pnorm(v);                       // the last nine digits, however it was typed
  return d.length === 9 ? '0' + d : '';
}
/* AN ID THAT IS PRESENT BUT LOOKS WRONG. A.2 asks for the details "accurately", and the
   national ID is the one field where a slip is invisible -- every other field is a name a
   person would notice. Tanzanian NIDA numbers are twenty digits; the register holds a few of
   nineteen and a few written with dashes, all of them real. So this FLAGS and never refuses:
   a rule that threw out real rows in the name of accuracy would cost more than it found. */
const idLooksOdd = v => {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return !!d && (d.length < 19 || d.length > 21);
};
/** SOP A.1's fields that are not filled in, by key. The one function the form, the gate and
    the report all ask -- three copies of a completeness rule is how two screens come to
    disagree about whether somebody is enrolled. */
function enrolGaps(row) {
  const out = [];
  for (const [key, col] of ENROL_FIELDS) {
    if (!String((row && row[col]) == null ? '' : row[col]).trim()) out.push(key);
  }
  return out;
}
const enrolRow = (r, inApp) => {
  const gaps = enrolGaps(r);
  return {
    phone: r.phone || '', name: r.name || '', nationalId: r.national_id || '',
    email: r.email || '', role: r.role || '', branch: r.branch || '',
    manager: r.manager || '', active: r.active !== false,
    joined: r.joined_date ? String(r.joined_date).slice(0, 10) : '',
    kinName: r.kin_name || '', kinPhone: r.kin_phone || '', kinRel: r.kin_relationship || '',
    kin2Name: r.kin2_name || '', kin2Phone: r.kin2_phone || '', kin2Rel: r.kin2_relationship || '',
    enrolledBy: r.enrolled_by || '', enrolledAt: r.enrolled_at ? Date.parse(r.enrolled_at) : null,
    verifiedBy: r.verified_by || '', verifiedAt: r.verified_at ? Date.parse(r.verified_at) : null,
    notifiedAt: r.notified_at ? Date.parse(r.notified_at) : null, notifiedTo: r.notified_to || '',
    note: r.enrol_note || '',
    gaps, complete: gaps.length === 0,
    idOdd: idLooksOdd(r.national_id),
    /* ON THE REGISTER IS NOT THE SAME AS USING THE SYSTEM. RSM SOP E.1 asks whether agents are
       "enrolled", and the honest answer has two halves: their row exists, and they have
       actually signed a handset on. Only the second one proves the details reached them. */
    inApp: !!inApp,
  };
};
/* WORST FIRST, so the desk opens on the work rather than on the alphabet: missing fields, then
   never checked, then checked but nobody told, then everybody else. */
function enrolWorstFirst(x, y) {
  const rank = r => (r.gaps.length ? 0 : (!r.verifiedAt ? 1 : (!r.notifiedAt ? 2 : 3)));
  return (rank(x) - rank(y)) || (x.name < y.name ? -1 : 1);
}

/* ---------- THE WEEKLY IT REPORT (IT SOP E; made of IT SOP C.2's daily check) ---------- */
const ITREP_NOT_READY = 'Jedwali la ripoti za IT halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-10-it-report.sql kwenye Supabase. '
  + '/ The IT report table has not been created yet — run that migration first.';
/* THE THREE MODULES SOP C.2 NAMES, and the file that feeds each. "Monitor system uptime and
   performance across INVENTORY, SALES and FINANCE modules, on a daily basis" -- in this
   deployment a module is up on a given day if its file arrived that day, because everything
   downstream reads yesterday's upload. The date column is the day the file is FOR, not the day
   somebody pressed upload, which is the honest reading: a Tuesday deck pasted on Wednesday
   still leaves Tuesday's phones working from Monday. */
const ITREP_FEEDS = [
  ['finance', 'watu_snapshots', 'snapshot_date', 'Deki ya Watu / The Watu loan book'],
  ['sales', 'hoop_sales', 'sale_date', 'Mauzo / The sales file'],
  ['inventory', 'hoop_aged_stock', 'as_of', 'Stoo iliyokaa / The aged stock report'],
];
const ITREP_ISSUE_COLS = 'id, raised_at, department, kind, title, status, assigned_to, '
  + 'resolved_by, resolved_at';
/** Every EAT day from `from` to `to`, inclusive. The report is a week, so this is seven. */
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 62; d = dayShift(d, 1)) out.push(d);
  return out;
}
/** "Did that file arrive for that day", asked the cheapest way there is: a HEAD request that
    returns a count and no rows at all. Three files x seven days = 21 tiny indexed lookups,
    which is the price of an honest answer; reading the rows themselves would be tens of
    thousands of rows to learn twenty-one yes-or-nos. Never throws: a table that is not there
    is reported as "no file", which is what it is. */
async function feedDay(db, table, col, day) {
  try {
    const { count, error } = await db.from(table)
      .select(col, { count: 'exact', head: true }).eq(col, day);
    if (error) return 0;
    return num(count);
  } catch (e) { return 0; }
}

/* ---------- AGING BY SYNCHRONISATION: the locked phones we are not pinging ---------- */
/* HOW MANY DAYS OF SILENCE STOP BEING A FLAT BATTERY. Seven is a judgement rather than a rule
   -- long enough that a weekend, a journey and a dead charger have all had their chance, short
   enough that a month has not gone by -- and it is a setting so the office can move it without
   a deploy. Blank falls back to seven. */
const SYNC_ALERT_DEFAULT = 7;
async function syncAlertDays(db) {
  try {
    const { data } = await db.from('settings').select('value').eq('key', 'SYNC_ALERT_DAYS').maybeSingle();
    const n = parseInt(String((data && data.value) || '').replace(/[^0-9]/g, ''), 10);
    return (Number.isFinite(n) && n >= 1 && n <= 365) ? n : SYNC_ALERT_DEFAULT;
  } catch (e) { return SYNC_ALERT_DEFAULT; }
}

/* ---------- THE DOOR'S OWN LOG (IT SOP D "monitor for unauthorized access") ---------- */
const SIGNIN_NOT_READY = 'Kumbukumbu ya kuingia haijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-10-signin-watch.sql kwenye Supabase. '
  + '/ The sign-in log has not been created yet — run that migration first.';
const SIGNIN_COLS = 'id, at, day, door, ok, outcome, code_key, code_masked, phone_masked, '
  + 'device, who_name, who_role, detail, ip, ua, reviewed_by, reviewed_at, review_note';
/* HOW MANY TRIES IN THE WINDOW STOP BEING A TYPO. The SOP names no number, so five is a
   judgement, and it is a setting so the office can move it without a deploy. */
const SIGNIN_ALERT_DEFAULT = 5;
const signinRow = r => ({
  id: String(r.id),
  at: r.at ? Date.parse(r.at) : null,
  day: r.day || '', door: r.door || '', ok: !!r.ok, outcome: r.outcome || '',
  codeKey: r.code_key || '', codeMasked: r.code_masked || '', phoneMasked: r.phone_masked || '',
  device: r.device || '', whoName: r.who_name || '', whoRole: r.who_role || '',
  detail: r.detail || '', ip: r.ip || '', ua: r.ua || '',
  reviewedBy: r.reviewed_by || '',
  reviewedAt: r.reviewed_at ? Date.parse(r.reviewed_at) : null,
  reviewNote: r.review_note || '',
});
/* ONE LINE PER SECRET TRIED, which is the shape the question actually has: nobody asks "how
   many refusals were there", they ask "is somebody working on one code". Rows without a key
   (an empty box submitted) group under their own bucket rather than merging into each other. */
function signinGroups(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.ok) continue;
    const k = r.codeKey || ('~blank~' + r.door);
    let g = by.get(k);
    if (!g) {
      g = { key: r.codeKey || '', door: r.door, masked: r.codeMasked || '', phoneMasked: r.phoneMasked || '',
        whoName: r.whoName || '', tries: 0, first: r.at, last: r.at, outcomes: {}, doors: {}, ips: [],
        reviewed: true, reviewedBy: '', reviewNote: '' };
      by.set(k, g);
    }
    g.tries++;
    if (r.at != null) {
      if (g.first == null || r.at < g.first) g.first = r.at;
      if (g.last == null || r.at > g.last) g.last = r.at;
    }
    g.outcomes[r.outcome] = (g.outcomes[r.outcome] || 0) + 1;
    g.doors[r.door] = (g.doors[r.door] || 0) + 1;
    if (!g.masked && r.codeMasked) g.masked = r.codeMasked;
    if (!g.phoneMasked && r.phoneMasked) g.phoneMasked = r.phoneMasked;
    if (!g.whoName && r.whoName) g.whoName = r.whoName;
    if (r.ip && g.ips.indexOf(r.ip) < 0 && g.ips.length < 6) g.ips.push(r.ip);
    /* A GROUP IS ONLY DEALT WITH WHEN EVERY ATTEMPT IN IT IS. One new try after somebody
       wrote "spoke to her, she had the old code" puts the line back on the desk, which is
       the whole difference between a note and an acknowledgement. */
    if (!r.reviewedAt) g.reviewed = false;
    else if (!g.reviewedBy) { g.reviewedBy = r.reviewedBy; g.reviewNote = r.reviewNote; }
  }
  return [...by.values()].sort((a, b) => (b.tries - a.tries) || ((b.last || 0) - (a.last || 0)));
}

/* ---------- LOSS AND DAMAGE (Finance SOP H; opened by Store SOP C.7) ---------- */
const LOSS_NOT_READY = 'Jedwali la upotevu halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-09-loss-damage.sql kwenye Supabase. '
  + '/ The loss and damage tables have not been created yet — run that migration first.';
/* SOP H.1's four root causes. THEFT is the one that needs a police report, and the server
   refuses the case without one -- that is the whole reason the SOP names it separately. */
const LOSS_CAUSES = ['negligence', 'unresolved_sale', 'incident', 'theft'];
const LOSS_METHODS = ['lump_sum', 'salary_deduction', 'commission_deduction'];
const LOSS_STATES = ['open', 'valued', 'acknowledged', 'recovering', 'settled', 'written_off'];
const LOSS_COLS = 'id, opened_at, staff_code, staff_name, staff_role, custodian, imei, item, '
  + 'cause, police_ref, details, value_amount, value_source, recovery_method, recovery_note, '
  + 'approved_by, approved_at, acknowledged_by, acknowledged_at, status, recovered, settled_at, '
  + 'updated_by, updated_at';
const lossRow = (r, me) => {
  const value = r.value_amount == null ? null : num(r.value_amount);
  const recovered = num(r.recovered);
  return {
    id: String(r.id),
    at: r.opened_at ? Date.parse(r.opened_at) : null,
    mine: !!(me && r.staff_code && String(r.staff_code) === String(me)),
    staffName: r.staff_name || '', staffRole: r.staff_role || '',
    custodian: r.custodian || '', imei: r.imei || '', item: r.item || '',
    cause: r.cause || '', policeRef: r.police_ref || '', details: r.details || '',
    value, valueSource: r.value_source || '',
    recoveryMethod: r.recovery_method || '', recoveryNote: r.recovery_note || '',
    approvedBy: r.approved_by || '', approvedAt: r.approved_at ? Date.parse(r.approved_at) : null,
    acknowledgedBy: r.acknowledged_by || '', acknowledgedAt: r.acknowledged_at ? Date.parse(r.acknowledged_at) : null,
    status: r.status || 'open', recovered,
    // What the custodian still owes. Null while nobody has valued it -- not zero, which would
    // read as "nothing outstanding" on the one screen that exists to chase it.
    outstanding: value == null ? null : Math.max(0, value - recovered),
    settledAt: r.settled_at ? Date.parse(r.settled_at) : null,
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : null,
  };
};
/* Work first: what nobody has valued, then what nobody has signed for, then what is being
   recovered, and only then what is finished. */
const LOSS_RANK = { open: 0, valued: 1, acknowledged: 2, recovering: 3, written_off: 4, settled: 5 };
const lossWorkFirst = (x, y) => (LOSS_RANK[x.status] - LOSS_RANK[y.status]) || (y.at || 0) - (x.at || 0);

/* ---------- COMMISSION (Finance SOP A) ---------- */
const COMM_NOT_READY = 'Jedwali la kamisheni halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-09-commission.sql kwenye Supabase. '
  + '/ The commission tables have not been created yet — run that migration first.';
const COMM_COLS = 'id, period, kind, status, created_at, created_by, built_at, approved_by, approved_at, '
  + 'comment, paid_by, paid_at, payment_ref, cleared_at, chk_unpaid_list, chk_watu_verified, '
  + 'chk_advance_topups, chk_voucher, chk_bank_statement, total_qty, total_amount, disqualified, updated_at';
/* The five ticks Finance SOP A's Commission Audit Checklist demands against every cycle. Held
   here so the pane, the gate and the tests all read one list. */
const COMM_CHECKS = [
  ['chkUnpaidList', 'chk_unpaid_list', 'Orodha ya kamisheni ambazo hazijalipwa (mfumo wa Hoop) / Unpaid commission list'],
  ['chkWatuVerified', 'chk_watu_verified', 'Imehakikiwa dhidi ya data ya WATU / Verified against WATU system data'],
  ['chkAdvanceTopups', 'chk_advance_topups', 'Imekaguliwa advance yoyote iliyolipwa kwenye top-up / Checked for paid advance on top-ups'],
  ['chkVoucher', 'chk_voucher', 'Voucher ya malipo imeidhinishwa na ipo / Approved payment voucher on file'],
  ['chkBankStatement', 'chk_bank_statement', 'Imelinganishwa na statement ya benki/Yas / Compared against bank/Yas statement'],
];
const commRow = r => ({
  id: String(r.id), period: r.period || '', kind: r.kind || 'monthly', status: r.status || 'draft',
  createdAt: r.created_at ? Date.parse(r.created_at) : null, createdBy: r.created_by || '',
  builtAt: r.built_at ? Date.parse(r.built_at) : null,
  approvedBy: r.approved_by || '', approvedAt: r.approved_at ? Date.parse(r.approved_at) : null,
  comment: r.comment || '',
  paidBy: r.paid_by || '', paidAt: r.paid_at ? Date.parse(r.paid_at) : null,
  paymentRef: r.payment_ref || '', clearedAt: r.cleared_at ? Date.parse(r.cleared_at) : null,
  checks: COMM_CHECKS.reduce((o, [js, col]) => { o[js] = !!r[col]; return o; }, {}),
  totalQty: num(r.total_qty), totalAmount: num(r.total_amount), disqualified: num(r.disqualified),
});
/* A period is a DAY for the 9:00 AM schedule and a MONTH for the 1st-of-the-month one
   (SOP A.1), so the shape of the string says which run this is. */
function commRange(period, kind) {
  if (kind === 'daily') {
    if (!isDay(period)) bad('Chagua tarehe (YYYY-MM-DD). / Choose a date.');
    return { from: period, to: period };
  }
  if (!isMonth(period)) bad('Chagua mwezi (YYYY-MM). / Choose a month.');
  return monthDays(period);
}
/* WHAT ONE PHONE EARNS. The most specific row wins: this role and this model, then this role
   for anything, then anyone for this model, then the catch-all. A model nobody priced earns
   nothing and is REPORTED as unpriced rather than quietly paid at zero. */
function commRateOf(rates, role, item) {
  const r = K(role).replace(/\s+/g, '_') || 'ANY';
  const i = K(item) || 'ANY';
  for (const [rk, ik] of [[r, i], [r, 'ANY'], ['ANY', i], ['ANY', 'ANY']]) {
    const hit = rates.get(rk + '|' + ik);
    if (hit) return num(hit.amount);
  }
  return null;
}

/* ---------- SALES TARGETS (CSM SOP B.3, RSM SOP B.1/B.3) ---------- */
const TARGET_NOT_READY = 'Jedwali la malengo halijatengenezwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-09-09-targets.sql kwenye Supabase. '
  + '/ The targets table has not been created yet — run that migration first.';
/* `role` is the scope the owner asked for: one row that every holder of that role inherits,
   rather than one row per person. It is listed last because it is not a place on the board --
   nothing is measured against a role directly; it is a SOURCE the people under it draw from. */
const TARGET_SCOPES = ['agent', 'rsm', 'branch', 'company', 'role'];
/* The scopes that are actually MEASURED. A role has no sales of its own. */
const TARGET_BOARD_SCOPES = ['agent', 'rsm', 'branch', 'company'];
/* A REAL MONTH, not merely something month-shaped. '2026-13' passes a bare \d{2} and there is
   no date column to catch it afterwards -- period is stored as TEXT in sales_targets, in the
   commission runs and on a deducted advance -- so a nonsense month would sit in a table for
   ever and quietly match nothing. Checked here once, for all three. */
const isMonth = s => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
};
/** First and last day of a 'YYYY-MM'. Pure string arithmetic; no timezone is involved in a month. */
function monthDays(period) {
  const from = period + '-01';
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of next month = last of this
  return { from, to: period + '-' + String(last).padStart(2, '0') };
}
/* ---------- THE SALES HIERARCHY, and how one target becomes everybody's ----------
     "Sales target is set per rsm like hope sets for team, so it increases to the higher
      leadership tiers, but decrease when going down to team leaders and agents -- like it's
      2 halves if only 2 team leaders are under the rsm. With that hierarchy down at agents
      contributive auto target from that of rsm. And target will be set by role not a single
      staff."

   TWO SENTENCES, ONE ARITHMETIC. "Increases going up" and "decreases going down" are the same
   rule read from either end: a number set at one level is DIVIDED among the people under it,
   and the sum of those shares is the number you started with. Set thirty on an RSM with two
   team leaders and each is expected to find fifteen; add the two back up and you have thirty.

   SET BY ROLE, NOT BY A SINGLE STAFF. The scope 'role' means "every Regional_Manager is
   expected to sell this much" -- one row instead of one row per person, which is the
   difference between a target somebody keeps up and a target nobody sets after the first
   month.

   NOTHING DERIVED IS EVER STORED. A share written into a row is a lie the moment somebody
   moves team, gains an agent or leaves -- and it would be a lie nobody could see, because it
   would look exactly like a number a person typed. So the tree is walked on every read and
   the row says WHERE its number came from. */

/* The register's own ladder, top first. Anything else sits below the bottom rung and is a leaf:
   an unknown role must never accidentally become somebody's manager. */
const TARGET_TIERS = ['COUNTRY_SALES_MANAGER', 'REGIONAL_MANAGER', 'TEAM_LEADER', 'FIELD_OFFICER'];
const roleKey = r => K(r || '').replace(/[\s-]+/g, '_');
const tierOf = role => {
  const i = TARGET_TIERS.indexOf(roleKey(role));
  return i < 0 ? TARGET_TIERS.length : i;
};

/** Who reports to whom, and who is under whom. Built once per read from the register.

    THE PARENT IS THE REGISTER'S OWN ANSWER FIRST. `manager` is the exception column somebody
    fills where a person reports across a branch line; where it is blank -- which is almost
    everybody -- the parent is the nearest person ONE RUNG UP in the same branch. That is right
    for the ordinary case and means the cascade works on day one instead of after a thousand
    edits.

    A manager who is not ABOVE you is not your manager. Two field officers naming each other,
    or a typo pointing at a peer, would otherwise make a loop that the share walk would fall
    into; the tier check refuses it before it can happen. */
function salesTree(agents) {
  const live = agents.filter(a => a && a.name && a.active !== false);
  const byKey = new Map(live.map(a => [nameKey(a.name), a]));
  /* The nearest holder of each tier per branch, so a blank `manager` still finds one. First
     seen wins, which is stable across reads because the register comes back in a fixed order. */
  const upOf = new Map();                       // branch|tier -> nameKey
  for (const a of live) {
    const k = K(a.branch || '') + '|' + tierOf(a.role);
    if (!upOf.has(k)) upOf.set(k, nameKey(a.name));
  }
  const parent = new Map();
  for (const a of live) {
    const me = nameKey(a.name);
    const myTier = tierOf(a.role);
    if (myTier === 0) continue;                 // the top of the ladder answers to nobody here
    let p = '';
    const named = nameKey(a.manager || '');
    if (named && byKey.has(named) && tierOf(byKey.get(named).role) < myTier) p = named;
    if (!p) {
      // The nearest rung above, in this branch, then anywhere -- a region with no RSM of its
      // own still rolls up to the country manager rather than falling out of the tree.
      for (let t = myTier - 1; t >= 0 && !p; t--) {
        p = upOf.get(K(a.branch || '') + '|' + t) || '';
      }
      for (let t = myTier - 1; t >= 0 && !p; t--) {
        p = [...upOf.entries()].filter(([kk]) => kk.endsWith('|' + t)).map(e => e[1])[0] || '';
      }
    }
    if (p && p !== me) parent.set(me, p);
  }
  const children = new Map();
  for (const [me, p] of parent) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(me);
  }
  return {
    byKey, parent, children,
    of: k => byKey.get(k) || null,
    childrenOf: k => children.get(k) || [],
    parentOf: k => parent.get(k) || '',
    /* Everybody beneath somebody, at any depth. Used for the roll-up, and cycle-safe by the
       same visited set the share walk uses. */
    descendants(k) {
      const out = [];
      const seen = new Set([k]);
      const stack = [k];
      while (stack.length) {
        for (const c of this.childrenOf(stack.pop())) {
          if (seen.has(c)) continue;
          seen.add(c); out.push(c); stack.push(c);
        }
      }
      return out;
    },
  };
}

/* ---------- NEW STOCK: what gets stamped, and which feed is asked first ----------
   The owner named the order, and it is an order of TRUSTWORTHINESS about a sale rather than
   of convenience: the deck financed the handset, the offline queue is the only place a
   guarantor was ever written down, the shop book knows who was paid, the staff register knows
   who they are, and the stock report knows only who was holding it. */
const NEWSTOCK_NOT_READY = 'Jedwali la NEW STOCK halijatengenezwa bado — unaona takwimu lakini '
  + 'hazihifadhiwi. Endesha db/migrations/RUN-ME-2026-09-11-new-stock.sql kwenye Supabase. '
  + '/ The stock_audit table has not been created yet: the rows below are computed live but '
  + 'nothing is being STAMPED, so a feed that goes blank will take its columns with it.';
const NEWSTOCK_COLS = 'imei, rsm, rsm_phone, agent, agent_phone, customer, customer_phone, '
  + 'price, guarantor, guarantor_phone, branch, model, sale_date, src, first_at, stamped_at';
const NEWSTOCK_FIELDS = ['rsm', 'rsm_phone', 'agent', 'agent_phone', 'customer', 'customer_phone',
  'price', 'guarantor', 'guarantor_phone', 'branch', 'model', 'sale_date'];
/* The owner's three words for what a handset is doing, plus the fourth this register also has.
   Written as data so the pane, the tiles and the filter cannot each invent their own. */
const NEWSTOCK_STATE = { locked: 'locked', enrolled: 'unlocked', released: 'achia', lost: 'lost' };
const RSM_TIER = TARGET_TIERS.indexOf('REGIONAL_MANAGER');
/** Nothing has been captured for this column yet. An empty string is not a value somebody
    stamped -- it is the absence of one, and treating it as filled would close the column
    against the upload that could finally answer it. */
const unanswered = v => v == null || String(v).trim() === '';

/** DOES A STAMPED ROW ACTUALLY CARRY A SALE? stock_audit holds a row for every handset this
    audit has ever merged -- including ones stamped off the stock report alone, which says who
    was holding a phone and nothing about it being sold. So membership is not the test; a date,
    a buyer or a price is. This is what lets the hand-off between the two stock lists be
    PERMANENT without a `moved` column: the stamp is the receipt. */
const stampedSale = r => !!r && (!unanswered(r.sale_date) || !unanswered(r.customer)
  || (r.price != null && num(r.price) > 0));

/** WHO THE RSM WAS. Not on any sale feed -- Watu does not know our hierarchy -- so it is read
    off the staff register by walking up from the agent until a Regional_Manager is reached.
    A manager who sold a phone themselves is their own RSM, which is the honest answer.

    `seen` because a register that names a loop must cost a row, never the request. */
function rsmAbove(name, tree) {
  let k = nameKey(name || '');
  const seen = new Set();
  while (k && !seen.has(k)) {
    seen.add(k);
    const p = tree.of(k);
    if (p && tierOf(p.role) === RSM_TIER) return p;
    k = tree.parentOf(k);
  }
  return null;
}

/** EVERY FEED'S ANSWER FOR ONE IMEI, richest first. Each entry is [source, {field: value}] and
    a field a feed cannot speak to is simply absent -- never null, which would read as "this
    feed says there isn't one" and is a different claim entirely.

    THE DECK AND THE OFFLINE QUEUE ARE THE SAME TABLE and are still listed separately, because
    they are different UPLOADS that happen to have been merged into one row: the daily deck
    carries the sale, the offline-queue sheet is the only place a guarantor has ever been
    written down. Naming them apart is what lets a stamped guarantor say where it came from. */
function newStockOffers(imei, ctx) {
  const out = [];
  const w = ctx.watu.get(imei);
  if (w) {
    out.push(['watu_loans', {
      agent: w.agent, customer: w.client_name, customer_phone: phone0(w.client_mobile),
      /* A PRICE OF ZERO IS A MISSING PRICE, not a free handset. Stamping it would close the
         column for good against the upload that finally carries the number. */
      price: num(w.price) > 0 ? num(w.price) : undefined,
      model: w.model_details || w.model, sale_date: w.disbursed_date,
      branch: w.team || w.shop,
    }]);
    out.push(['offline_queue', {
      guarantor: w.guarantor_name, guarantor_phone: phone0(w.guarantor_phone),
      branch: w.branch,
    }]);
  }
  const s = ctx.sales.get(imei);
  if (s) {
    out.push(['hoop_sales', {
      customer: s.client_name, customer_phone: phone0(s.client_phone),
      /* commission_agent is who is OWED for the sale -- the seller. `agent` on this table is
         the record holder, which is a different person on a team leader's receipt. */
      agent: s.commission_agent || s.agent, agent_phone: phone0(s.commission_phone),
      price: num(s.price) > 0 ? num(s.price) : undefined,
      model: s.model, sale_date: s.sale_date, branch: s.branch,
    }]);
  }
  const st = ctx.aged.get(imei);
  // The stock report knows who was HOLDING it, which is the weakest claim to having sold it --
  // hence last, and only where nothing better ever turned up.
  if (st) out.push(['hoop_aged_stock', { agent: st.agent, model: st.item }]);
  return out;
}

/** ONE IMEI'S ROW, merged. Starts from what is already stamped and fills only what is still
    unanswered, so a column captured in July survives a deck that has since dropped it.
    Returns the merged values, the provenance, and how many columns were newly filled --
    which is what decides whether this row is written back at all. */
function newStockFill(imei, was, ctx) {
  const row = {};
  const src = Object.assign({}, (was && was.src) || {});
  let hits = 0;
  for (const f of NEWSTOCK_FIELDS) row[f] = was ? was[f] : null;
  const put = (field, value, from) => {
    if (!unanswered(row[field])) return;             // FIRST CATCH WINS, for good
    const v = typeof value === 'string' ? value.trim() : value;
    if (unanswered(v)) return;
    row[field] = v; src[field] = from; hits++;
  };
  for (const [from, offer] of newStockOffers(imei, ctx)) {
    for (const f of NEWSTOCK_FIELDS) if (offer[f] !== undefined) put(f, offer[f], from);
  }
  /* THE STAFF REGISTER ANSWERS LAST, and only about the person -- because it can only be asked
     once the earlier feeds have said whose name is on the sale. */
  const who = ctx.byName.get(nameKey(row.agent || ''))
    || (row.agent_phone ? ctx.byPhone.get(pnorm(row.agent_phone)) : null);
  if (who) {
    put('agent_phone', phone0(who.phone), 'hoop_agents');
    put('branch', who.branch, 'hoop_agents');
  }
  const boss = rsmAbove(row.agent || (who && who.name) || '', ctx.tree);
  if (boss) {
    put('rsm', boss.name, 'hierarchy');
    put('rsm_phone', phone0(boss.phone), 'hierarchy');
  }
  return { row, src, hits };
}

/* NEW SALES -- the week and the month, off the audit's own stamped rows.
   =========================================================================================
     "Add NEW SALES widgets at top of weekly and monthly progress showing 3: 1-no of agents,
      2-no of customers, 3-price. And another card showing top and bottom agent at once as
      weekly progress 3x2: 1-agent name, 2-no of sales, 3-price."

   COUNTED FROM THIS PANE'S OWN ROWS, not from a fresh read of the deck, and that is the point
   rather than a shortcut: these are sales OF HANDSETS WE LOCKED, stamped and kept. A widget
   reading watu_loans directly would count phones this audit has never heard of and quietly
   disagree with the table underneath it.

   A CUSTOMER IS A PHONE NUMBER WHERE THERE IS ONE. Two receipts spelling a name differently
   are one buyer; two buyers can share a name. Falling back to the name is right for a row the
   feeds never gave a number, and counting it as its own customer is the honest reading of
   "we do not know who this was".

   THE BOTTOM AGENT IS THE LOWEST WHO SOLD, never the highest who did not. Nobody who sold
   nothing is on these rows at all, so the card cannot and does not claim to rank them -- it
   says how many agents it is ranking, and the screen says the same. */
function newStockPeriod(rows, from, to) {
  const inIt = rows.filter(r => r.saleDate && r.saleDate >= from && r.saleDate <= to);
  const agents = new Set(), customers = new Set();
  let amount = 0;
  for (const r of inIt) {
    if (r.agent) agents.add(K(r.agent));
    const who = r.customerPhone || r.customer;
    if (who) customers.add(K(who));
    amount += num(r.price);
  }
  return { from, to, sales: inIt.length, agents: agents.size, customers: customers.size, amount };
}
/** Per-agent totals for one window, best first. Used for the top-and-bottom card. */
function newStockAgents(rows, from, to) {
  const by = new Map();
  for (const r of rows) {
    if (!r.saleDate || r.saleDate < from || r.saleDate > to) continue;
    if (!r.agent) continue;                 // an unattributed sale ranks nobody
    const k = K(r.agent);
    const g = by.get(k) || { name: r.agent, sales: 0, amount: 0 };
    g.sales++; g.amount += num(r.price);
    by.set(k, g);
  }
  return [...by.values()].sort((x, y) => (y.sales - x.sales) || (y.amount - x.amount)
    || String(x.name).localeCompare(String(y.name)));
}
function newStockSales(rows, nowMs, roster, weekOff) {
  const today = todayKey(nowMs);
  const week = weekMondayKey(nowMs);
  const month = today.slice(0, 7) + '-01';
  /* THE BOARD'S OWN WEEK, WHICH SLIDES WHILE THE REST OF THE PANE STANDS STILL.
     -------------------------------------------------------------------------------------
       "back and forward buttons for previous and forward week preview/excel download on the
        single widget, not changing the other widgets nor the page's data"

     `week` and `month` above are "this week" and "this month" BY DEFINITION -- the two cards
     that carry them are progress figures, and a progress figure that has quietly moved to a
     window nobody chose is worse than no figure at all. So the offset reaches exactly one
     card: its own from and to, its own ranking, its own idle list, and the rows behind them.

     FORWARD STOPS AT THIS WEEK. Nothing has been sold next week, and a card that could be
     scrolled into an empty future would read as a collapse in sales rather than as a date
     nobody has reached yet. Back is bounded too, at two years, so a stuck key cannot ask the
     server for the week of 1970. */
  const asked = Math.round(num(weekOff));
  const off = Math.max(-104, Math.min(0, isNaN(asked) ? 0 : asked));
  const from = addDaysKey(week, off * 7);
  /* THIS week runs to TODAY -- it is progress so far, not a promise about Sunday -- and every
     week behind it is whole. Using Monday+6 for the current week would date the card's own
     heading into the future. */
  const to = off === 0 ? today : addDaysKey(from, 6);
  const ranked = newStockAgents(rows, from, to);
  /* AND THE ONES WHO SOLD NOTHING, which is who "bottom" is really about.
     -------------------------------------------------------------------------------------
     These rows are sales, so an agent with none of them is not in them -- and a card ranking
     only sellers can name somebody with one sale as the week's bottom while three people sold
     nothing at all. That is the opposite of what the card is read for.

     They are COUNTED rather than named. Picking one of several zeros as "the bottom" would be
     arbitrary -- they are all equally bottom -- and naming an arbitrary person as the worst
     performer of the week is a thing a screen should not do. So the two named rows stay
     definite, and the number beside them says how many are below both. */
  const sold = new Set(ranked.map(a => K(a.name)));
  const idle = (roster || [])
    .filter(a => a && a.name && a.active !== false && tierOf(a.role) === TARGET_TIERS.length - 1)
    .filter(a => !sold.has(K(a.name)));
  return {
    /* THESE TWO NEVER MOVE. They are "this week" and "this month", whatever the board beside
       them has been slid to. */
    week: newStockPeriod(rows, week, today),
    month: newStockPeriod(rows, month, today),
    /* Top and bottom of the BOARD'S week. With one seller they are the same person, and the
       screen says so rather than printing one row twice as if it were two facts. */
    top: ranked[0] || null,
    bottom: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    ranked: ranked.length,
    idle: idle.length,
    // A few names, so "12 sold nothing" is a list somebody can act on rather than a number.
    idleNames: idle.slice(0, 8).map(a => a.name),
    /* THE BOARD'S OWN WINDOW, and the sales inside it.
       -----------------------------------------------------------------------------------
       `totals` is the same three figures the "this week" card shows, worked out for whichever
       week is on the board -- so sliding back a week answers the question that card answers,
       for that week, rather than leaving the arrows with nothing but two names to change.

       `sales` is the export. It is built here rather than on the page because the page holds
       at most 2000 rows and only the ones that passed its filter and its search: exporting
       from the screen would hand somebody a file that silently omits whatever the pane
       happened to be narrowed to, under a heading naming the whole week. */
    board: {
      off, from, to,
      atWeek: off === 0,
      totals: newStockPeriod(rows, from, to),
      sales: rows
        .filter(r => r.saleDate && r.saleDate >= from && r.saleDate <= to)
        .sort((x, y) => String(x.saleDate).localeCompare(String(y.saleDate))
          || String(x.agent || '').localeCompare(String(y.agent || ''))
          || String(x.imei).localeCompare(String(y.imei)))
        .map(r => ({
          saleDate: r.saleDate, imei: r.imei,
          rsm: r.rsm || '', rsmPhone: r.rsmPhone || '',
          agent: r.agent || '', agentPhone: r.agentPhone || '',
          customer: r.customer || '', customerPhone: r.customerPhone || '',
          guarantor: r.guarantor || '', guarantorPhone: r.guarantorPhone || '',
          price: r.price == null ? null : num(r.price),
          branch: r.branch || '', model: r.model || '',
          /* Whether we hold the lock on it. A week's sales sheet that does not say which
             handsets we never controlled is the sheet that makes the ground visits look
             unnecessary. */
          status: r.status, neverLocked: r.neverLocked === true,
        })),
    },
  };
}

/** The row as the table takes it. first_at is carried from the existing stamp rather than
    re-derived: it says when this handset first appeared in the audit, and a row that gains a
    column today did not appear today. Both timestamps are written explicitly because a column
    default cannot be relied on through an upsert that names the column. */
function newStockRow(imei, f, was, at) {
  const out = { imei, src: f.src, first_at: (was && was.first_at) || at, stamped_at: at };
  for (const k of NEWSTOCK_FIELDS) out[k] = unanswered(f.row[k]) ? null : f.row[k];
  return out;
}

/** ONE PERSON'S TARGET, and where it came from. Three answers in order of authority:

      own    somebody typed a number against this person's name
      role   somebody typed a number against their role -- every RSM is expected to sell this
      share  their manager's target, divided by how many people report to that manager

    The manager's own target is resolved the same way, so a single number set on the country
    manager reaches a field officer through however many rungs lie between. `seen` is what
    stops a register that names a loop from taking the server with it. */
function resolveTarget(key, tree, tBy, seen) {
  if (!key) return null;
  seen = seen || new Set();
  if (seen.has(key)) return null;               // a loop in `manager`: refuse rather than hang
  seen.add(key);
  const person = tree.of(key);
  const own = tBy.get('agent|' + key) || tBy.get('rsm|' + key) || null;
  if (own) {
    return { qty: own.target_qty == null ? null : num(own.target_qty),
      amount: own.target_amount == null ? null : num(own.target_amount),
      source: 'own', from: (person && person.name) || '' };
  }
  const byRole = person ? tBy.get('role|' + roleKey(person.role)) : null;
  if (byRole) {
    return { qty: byRole.target_qty == null ? null : num(byRole.target_qty),
      amount: byRole.target_amount == null ? null : num(byRole.target_amount),
      source: 'role', from: roleKey(person.role) };
  }
  const p = tree.parentOf(key);
  if (!p) return null;
  const up = resolveTarget(p, tree, tBy, seen);
  if (!up) return null;
  /* THE SHARE. Divided by how many people report to that manager -- "2 halves if only 2 team
     leaders are under the rsm". Rounded UP, because three people splitting ten phones who each
     aim at three will finish the month one short of what was asked for. */
  const n = Math.max(1, tree.childrenOf(p).length);
  const boss = tree.of(p);
  return {
    qty: up.qty == null ? null : Math.ceil(num(up.qty) / n),
    amount: up.amount == null ? null : Math.ceil(num(up.amount) / n),
    source: 'share',
    from: (boss && boss.name) || p,
    of: n,
  };
}

/* WHICH RSM AN AGENT BELONGS TO. The register's own `manager` if somebody set one, else the
   Regional_Manager standing in the same branch -- which is right for almost everybody and
   means the roll-up works on day one instead of after a thousand edits. */
function managerIndex(agents) {
  const rsmOfBranch = new Map();
  for (const a of agents) {
    const role = K(a.role || '').replace(/\s+/g, '_');
    if (!/REGIONAL|COUNTRY_SALES/.test(role)) continue;
    const b = K(a.branch || '');
    if (!b || rsmOfBranch.has(b)) continue;
    rsmOfBranch.set(b, a.name || '');
  }
  const byAgent = new Map();
  for (const a of agents) {
    const own = String(a.manager || '').trim();
    byAgent.set(nameKey(a.name), own || rsmOfBranch.get(K(a.branch || '')) || '');
  }
  return {
    of: name => byAgent.get(nameKey(name)) || '',
    branchOf: (() => {
      const m = new Map(agents.map(a => [nameKey(a.name), a.branch || '']));
      return name => m.get(nameKey(name)) || '';
    })(),
  };
}

/** The report both the pane and the email are built from, so the screen and the GM's copy can
    never disagree. Defaults to TODAY alone: this is a daily report. */
async function fuOutcomesCore(db, user, args, nowMs) {
  const a = args || {};
  const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  const to = day(a.to) || todayKey(nowMs);
  const from = day(a.from) || to;
  /* The window is EAT days; the comment column is a timestamptz. Convert once, here, rather
     than reading a wider window and hoping -- an off-by-three-hours report is worse than none. */
  const fromTs = new Date(Date.parse(from + 'T00:00:00Z') - TZ_OFFSET_MS).toISOString();
  const toTs = new Date(Date.parse(to + 'T00:00:00Z') - TZ_OFFSET_MS + 86400000).toISOString();
  // A team may be narrowed WITHIN this code's own scope, exactly as Ripoti does it.
  const want = K(a.team);
  const inTeam = r => !want || K(r.team) === want;

  const [notes, logs] = await Promise.all([
    fetchAll(() => scopeQ(user, db.from('followup_comments')
      .select('imei, team, client_name, fu_status, comment, created_at, created_by')
      .gte('created_at', fromTs).lt('created_at', toTs))),
    fetchAll(() => scopeQ(user, db.from('call_logs')
      .select('ref, outcome, portfolio, call_date, officer, team')
      .gte('call_date', from).lte('call_date', to))),
  ]);

  /* THE BOOK, for the one number that needs a denominator. Quietly optional: a report that
     refuses to open because the deck has not been uploaded is not a better report. */
  let deck = [], deckDate = null;
  try {
    const one = await db.from('followup_status').select('deck_date').not('deck_date', 'is', null)
      .order('deck_date', { ascending: false }).limit(1);
    deckDate = one.data && one.data[0] ? String(one.data[0].deck_date).slice(0, 10) : null;
    if (deckDate) {
      deck = await fetchAll(() => scopeQ(user, db.from('followup_status')
        .select('imei, client_name, team, contact, days_offline').eq('deck_date', deckDate)));
    }
  } catch (e) { deck = []; deckDate = null; }

  /* THE LATEST WORD WINS. An officer who rings twice and logs twice has one outcome, and it is
     the last one -- "hapatikani" at nine and "analipa leo" at four is a customer who paid. */
  const latest = new Map();
  for (const n of notes) {
    if (!inTeam(n)) continue;
    const k = String(n.imei || '');
    if (!k) continue;
    const had = latest.get(k);
    if (!had || String(n.created_at || '') > String(had.created_at || '')) latest.set(k, n);
  }
  const dialled = new Map();
  let calls = 0;
  for (const r of logs) {
    if (!inTeam(r)) continue;
    calls++;
    const k = String(r.ref || '');
    if (!k) continue;                       // a call to somebody off the book is not a customer
    if (!dialled.has(k)) dialled.set(k, { officer: r.officer || '', n: 0 });
    dialled.get(k).n++;
  }

  const known = new Map();                  // imei -> a name and a team, from wherever we have one
  const remember = (imei, name, team, extra) => {
    const k = String(imei || '');
    if (!k) return;
    const had = known.get(k) || { imei: k, name: '', team: '', contact: '', daysOffline: null };
    if (!had.name && name) had.name = String(name);
    if (!had.team && team) had.team = String(team);
    if (extra && extra.contact && !had.contact) had.contact = String(extra.contact);
    if (extra && extra.daysOffline != null && had.daysOffline == null) had.daysOffline = num(extra.daysOffline);
    known.set(k, had);
  };
  for (const d of deck) if (inTeam(d)) remember(d.imei, d.client_name, d.team, { contact: d.contact, daysOffline: d.days_offline });
  for (const [k, n] of latest) remember(k, n.client_name, n.team);
  for (const k of dialled.keys()) remember(k, '', '');

  const rows = [];
  const totals = { customers: 0, logged: 0, calls, dialled: dialled.size };
  for (const k of FU_REPORT_KINDS) totals[k] = 0;
  const byOfficer = new Map();
  const officer = name => {
    const key = String(name || '—');
    if (!byOfficer.has(key)) {
      const o = { officer: key, logged: 0, dialled: 0 };
      for (const b of FU_BUCKETS) o[b] = 0;
      byOfficer.set(key, o);
    }
    return byOfficer.get(key);
  };
  for (const [k, who] of dialled) officer(who.officer).dialled++;

  for (const [imei, c] of known) {
    const n = latest.get(imei);
    /* A note with no status at all is contact that produced nothing -- an officer wrote a
       sentence and did not say what came of it. It counts as unpaid, never as paid. */
    const kind = n ? (fuBucketOf(n.fu_status) || 'unpaid')
      : (dialled.has(imei) ? 'unresponded' : 'notCalled');
    totals.customers++;
    totals[kind]++;
    if (n) {
      totals.logged++;
      const o = officer(n.created_by);
      o.logged++;
      if (o[kind] != null) o[kind]++;
    }
    rows.push({ imei, kind, name: c.name || '', team: c.team || '', contact: c.contact || '',
      daysOffline: c.daysOffline, status: n ? (n.fu_status || '') : '',
      comment: n ? String(n.comment || '').slice(0, 300) : '',
      by: n ? (n.created_by || '') : (dialled.get(imei) ? dialled.get(imei).officer : ''),
      at: n ? (Date.parse(n.created_at) || null) : null,
      day: n ? eatDayOf(n.created_at) : '',
      callsMade: dialled.has(imei) ? dialled.get(imei).n : 0 });
  }
  /* Worst first: the buckets somebody has to act on before the ones already settled. */
  const RANK = { stolen: 0, maintenance: 1, unresponded: 2, notCalled: 3, unpaid: 4, notAvailable: 5, paid: 6 };
  rows.sort((x, y) => (RANK[x.kind] - RANK[y.kind]) || (y.at || 0) - (x.at || 0)
    || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const CAP = 800;
  return { ok: true, from, to, team: want || '', deckDate,
    kinds: FU_REPORT_KINDS, labels: FU_BUCKET_LABEL,
    totals,
    byOfficer: [...byOfficer.values()].sort((x, y) => y.logged - x.logged || (x.officer < y.officer ? -1 : 1)),
    notListed: Math.max(0, rows.length - CAP),
    rows: rows.slice(0, CAP) };
}

const SUSPEND_NOT_READY = 'Kusimamisha mtu hakujawekwa bado. Endesha '
  + 'db/migrations/RUN-ME-2026-08-31-access-suspend.sql kwenye Supabase, kisha rudi hapa. '
  + '/ The suspension window does not exist yet -- run that migration, then come back.';

/* The role a code holds, for the one question accessCodeSuspend has to ask before it writes:
   is this an ADMIN. Read on its own rather than trusted from the caller, because the caller is
   a browser and "which role is this code" is exactly the fact a suspension must not take on
   trust. A row that cannot be read answers {} -- and an unknown role is not ADMIN, so the guard
   fails towards refusing the write rather than towards allowing it. */
async function roleOfCode(db, code) {
  try {
    const rows = await fetchAll(() => db.from('access_codes').select('code, role').eq('code', code));
    return rows[0] || {};
  } catch (e) { return {}; }
}

/* ONE row shape, built once, so the requester's pane, the approver's queue and HR's report
   cannot drift into three slightly different opinions about the same request.

   Timestamps go out as epoch MILLISECONDS, never as text: a zone-less string is read as local
   by the browser and as UTC by this server, which is three hours of disagreement in Dar es
   Salaam on a payment record. apply_date stays a plain YYYY-MM-DD -- it is a calendar day the
   requester chose, not a moment, and giving it a time zone would be inventing precision. */
const advRow = (r, me) => ({
  id: String(r.id),
  at: r.requested_at ? Date.parse(r.requested_at) : null,
  staffName: r.staff_name || '',
  staffRole: r.staff_role || '',
  /* THE ACCESS CODE NEVER GOES OUT ON THE WIRE. staff_code is not an employee number in this
     system -- it IS the credential the person signs in with, the whole of it, and there is
     nothing else to know. Putting it on every row of the approval queue handed each approver a
     working login for every colleague who had ever asked for an advance.

     The screen only ever needed one bit of it -- "is this row mine" -- so the server answers
     that question here and sends the answer instead of the secret. */
  mine: !!(me && r.staff_code && String(r.staff_code) === String(me)),
  applyDate: r.apply_date ? String(r.apply_date).slice(0, 10) : '',
  amount: r.amount == null ? null : Number(r.amount),
  status: r.status || 'pending',
  approved: r.approved_amount == null ? null : Number(r.approved_amount),
  comment: r.comment || '',
  decidedBy: r.decided_by || '',
  decidedAt: r.decided_at ? Date.parse(r.decided_at) : null,
  bank: r.bank_name || '',
  account: r.account_no || '',
  /* THE THREE RULES (Finance SOP G.4-G.6), added 2026-09-09. Every one of these is null on a
     row filed before the migration, and every screen reads null as "not known" rather than as
     "no" -- an old request is not a late one just because nobody was stamping lateness yet. */
  late: r.late == null ? null : !!r.late,
  salaryAtRequest: r.salary_at_request == null ? null : Number(r.salary_at_request),
  capAmount: r.cap_amount == null ? null : Number(r.cap_amount),
  paidAt: r.paid_at ? Date.parse(r.paid_at) : null,
  paidBy: r.paid_by || '',
  paymentRef: r.payment_ref || '',
  deductedAt: r.deducted_at ? Date.parse(r.deducted_at) : null,
  deductedBy: r.deducted_by || '',
  deductPeriod: r.deduct_period || '',
});

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
     THE FOLLOW-UP REPORT the credit department owes the GM every day.
     =====================================================================================
       Credit SOP A.4 "Log the outcome of every call."
       Credit SOP A.5 "Generate a report covering: stolen devices, maintenance, not
                       available, paid, unpaid, and unresponded calls."
       Credit SOP A.6 "Send the report to the General Manager."

     Ripoti (the `reports` nav) counts CALLS -- how many, how long, who made them. It cannot
     answer this, because a call is not an outcome: two hundred calls and no idea how many
     phones turned out to be stolen is exactly the report this SOP was written against.

     ONE ROW PER CUSTOMER, in six buckets that partition (see FU_BUCKET_LABEL above), so the
     numbers add to the book and a GM can read them as shares. Whoever holds `furep` reads
     it; sending the copy is the same grant plus write, and audited.

     Budget: 2 window reads, both date-bounded AND team-scoped at the database
     (followup_comments by its EAT-corrected timestamp, call_logs by call_date), plus the
     deck: 1 tiny indexed lookup for the newest deck_date and 1 scoped read of that day --
     the same pair `customers` does. The deck is allowed to fail quietly: without it the six
     buckets still stand and only "not called" is unknown. */
  async fuOutcomes(db, user, args) {
    requireNav(user, 'furep');
    return fuOutcomesCore(db, user, args, Date.now());
  },

  /** SOP A.6, as a button. The pane is the report; this is the copy that leaves the building,
      so it is a write in every sense that matters and lands in the audit log. */
  async fuOutcomesSend(db, user, args) {
    requireNav(user, 'furep');
    requireWrite(user);
    const out = await fuOutcomesCore(db, user, args, Date.now());
    const t = out.totals;
    const period = out.from === out.to ? out.from : (out.from + ' → ' + out.to);
    const pct = n => (t.customers ? Math.round((n / t.customers) * 100) + '%' : '—');
    const mail = await sendMail(db, { toKey: 'GM_EMAIL',
      subject: 'HOOPLOAN — ripoti ya ufuatiliaji / credit follow-up report ' + period
        + (out.team ? ' (' + out.team + ')' : ''),
      html: noticeHtml('Ripoti ya ufuatiliaji / Credit follow-up report — ' + period,
        FU_REPORT_KINDS.map(k => [FU_BUCKET_LABEL[k], String(out.totals[k]) + ' · ' + pct(out.totals[k])])
          .concat([
            ['Wateja kwenye ripoti / Customers in the report', String(t.customers)],
            ['Wamefuatiliwa / Followed up', String(t.logged)],
            ['Simu zilizopigwa / Calls placed', String(t.calls)],
          ]),
        'Imetumwa na ' + (user.name || '—') + '. Fungua Ripoti ya ufuatiliaji kwenye portal kwa orodha kamili. '
        + '/ Open the follow-up report in the portal for the customer list.') });
    return { ok: true, from: out.from, to: out.to, totals: out.totals,
      emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
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
    if (!latest) return { ok: true, latest: null, prev: null, rows: [], counts: null, kpi: null };
    const two = await db.from('watu_snapshots').select('snapshot_date')
      .lt('snapshot_date', latest).order('snapshot_date', { ascending: false }).limit(1);
    const prev = two.data && two.data[0] && String(two.data[0].snapshot_date).slice(0, 10);
    // client_mobile, NOT contact -- snapshots carry the importer's own column names.
    // locked7 and disbursed_date ride along for the KPI below: two more columns on a read
    // that already happens, never a second read.
    const COLS = 'imei, client_name, client_mobile, team, days_offline, has_ever_paid, price, created_at, locked7, disbursed_date';
    /* =====================================================================================
       THE DEPARTMENT'S ONE KPI (Credit SOP D): "The credit department's default rate on the
       WATU system must not exceed 5%."

       Hoop does not hold Watu's own default figure, so this is stated as what this system CAN
       see and is labelled as such on the pane: of the loans still inside the 45-day window on
       today's deck, the share Watu marks 7+ days offline. That is the same locked-7 arithmetic
       every other screen here uses, so the KPI moves with the charts beside it rather than
       being a number of its own.

       KPI_DEFAULT_RATE is the ceiling in percent, 5 unless the owner sets otherwise. */
    const kpiOf = async rowsIn => {
      const seen = new Map();
      for (const r of rowsIn) {
        const k = String(r.imei);
        const had = seen.get(k);
        if (!had || String(r.created_at) > String(had.created_at)) seen.set(k, r);
      }
      let book = 0, bad = 0;
      for (const r of seen.values()) {
        if (!inWinOn(r, latest)) continue;
        book++;
        if (r.locked7 === true) bad++;
      }
      let target = 5;
      try {
        const { data: s } = await db.from('settings').select('value').eq('key', 'KPI_DEFAULT_RATE').maybeSingle();
        const v = parseFloat(String((s && s.value) || '').replace('%', '').trim());
        if (Number.isFinite(v) && v >= 0 && v <= 100) target = v;
      } catch (e) { target = 5; }
      return { book, locked: bad, pct: book ? (bad / book) * 100 : null, target, asOf: latest };
    };
    if (!prev) {
      const cur1 = await fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS).eq('snapshot_date', latest)));
      return { ok: true, latest, prev: null, rows: [], counts: null, kpi: await kpiOf(cur1),
        note: 'Upload mbili zinahitajika kupima recovery — hii ni ya kwanza. / Recovery needs two uploads; this is the first.' };
    }
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
      kpi: await kpiOf(cur),
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
      /* `price` rides along because the deck is now what the SALES half counts too (see
         below): reading the loan book without it would have made every amount silently zero,
         which is the kind of nothing that looks like an answer. */
      fetchAll(() => scopeQ(user, db.from('watu_loans')
        .select('imei, agent, agent_id, team, branch, price, has_ever_paid, locked4, locked7, days_offline, disbursed_date')))
        .catch(() => fetchAll(() => scopeQ(user, db.from('watu_loans')
          .select('imei, agent, agent_id, team, price, has_ever_paid, locked4, locked7, days_offline, disbursed_date')))),
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
    /* WHO SOLD IT IS THE DECK'S ANSWER, NOT THE SHOP'S.
       -----------------------------------------------------------------------------------
         "I said we trace sales in the watu deck uploaded by credits"

       This scoreboard used to count SALES out of hoop_sales -- the shop's own book, keyed on
       the payout phone it wrote against each receipt. That is who the shop intended to PAY,
       which is a different fact from who the deck says financed the phone, and the two drift.
       Everywhere else that matters already drives off the deck: targetsView measures against
       watu_loans, commBuild builds the sheet from watu_loans and treats a shop disagreement as
       a DISPUTE. The scorecard was the odd one out, so an agent could look busy here on
       receipts the loan book has never heard of.

       So the deck is the count, and the shop book stays as a CROSS-CHECK beside it rather
       than being dropped: a gap between the two is the most interesting number on the row,
       and losing it would trade one blind spot for another. Nothing is silently reconciled.

       Both books are bucketed on the REGISTER'S name for the person, so a payout phone and a
       deck spelling reach the same row -- the same resolution commBuild uses. */
    const agByPhone = new Map(agents.map(r => [pnorm(r.phone), r]));
    const regByNm = new Map(agents.filter(x => x.name).map(x => [nameKey(x.name), x]));
    /* ONE KEY FOR ONE HUMAN. A register hit wins, because it is the only spelling both books
       can be pulled onto; otherwise the name each book carries has to stand for itself. */
    const sellerKey = (name, phone) => {
      const byPhone = phone ? agByPhone.get(pnorm(phone)) : null;
      if (byPhone && byPhone.name) return nameKey(byPhone.name);
      return nameKey(name) || K(name) || '?';
    };
    const seller = (map, key, name, phone) => {
      let g = map.get(key);
      if (!g) {
        g = { names: {}, phone: phone || '', sales: 0, amount: 0, shopSales: 0, shopAmount: 0 };
        map.set(key, g);
      }
      if (!g.phone && phone) g.phone = phone;
      const n = String(name || '').trim();
      if (n) g.names[n] = (g.names[n] || 0) + 1;
      return g;
    };
    const bySeller = new Map();
    // THE DECK, over the same window the shop book is read for -- one read, filtered here.
    for (const r of reg) {
      const day = String(r.disbursed_date || '').slice(0, 10);
      if (!day || day < from || day > to) continue;
      const who = String(r.agent || '').trim();
      const g = seller(bySeller, sellerKey(who, ''), who || '(hakuna ajenti / no agent)', '');
      g.sales++; g.amount += num(r.price);
      if (!g.agentId && r.agent_id) g.agentId = r.agent_id;
    }
    // THE SHOP'S BOOK, beside it. A seller the shop credits and the deck does not is still a
    // row here -- being paid for phones the loan book has never seen is the whole question.
    for (const s of sales) {
      const g = seller(bySeller, sellerKey(s.commission_agent, s.commission_phone),
        s.commission_agent, s.commission_phone);
      g.shopSales++; g.shopAmount += num(s.price);
    }
    const sellers = [...bySeller.entries()].map(([key, g]) => {
      const reg2 = regByNm.get(key) || agByPhone.get(pnorm(g.phone)) || null;
      const name = (reg2 && reg2.name)
        || Object.entries(g.names).sort((x, y) => y[1] - x[1]).map(e => e[0])[0] || '';
      return { name, phone: g.phone, agentId: g.agentId || '',
        sales: g.sales, amount: g.amount,
        shopSales: g.shopSales, shopAmount: g.shopAmount,
        // Positive: the deck credits them with more than the shop did. Negative: the reverse.
        drift: g.sales - g.shopSales,
        // The row worth opening: the shop is paying somebody the loan book cannot account for.
        shopOnly: g.shopSales > 0 && g.sales === 0,
        reg: reg2 ? { name: reg2.name, role: reg2.role || '', branch: reg2.branch || '',
          kin: reg2.kin_name || '', kinPhone: reg2.kin_phone || '' } : null };
    }).sort((x, y) => y.sales - x.sales || y.shopSales - x.shopSales);
    return { ok: true, from, to,
      watuAgents: watuAgents.slice(0, 300), sellers: sellers.slice(0, 300),
      /* Said out loud on the pane, because a column headed "sales" that quietly changed
         meaning is worse than one that says which book it came from. */
      salesSource: 'watu_loans',
      totals: {
        deckSales: sellers.reduce((n, r) => n + r.sales, 0),
        shopSales: sellers.reduce((n, r) => n + r.shopSales, 0),
        shopOnly: sellers.filter(r => r.shopOnly).length,
        drifting: sellers.filter(r => r.drift !== 0).length,
      } };
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
    /* THE ROLES AS THE REGISTER SPELLS THEM. This matched the literal word RSM, and the register
       Sipho's page produces says Regional_Manager, Team_Leader, Field_Officer and
       Country_Sales_Manager -- so on live data every manager fell into the agents pivot and the
       RSM pivot was empty, while the tests passed on a fixture that spelt it RSM. Found by the
       SOP review of 2026-09-08. The store is a holder NAME before it is a role: Sipho is not on
       the agents register at all, so the name is what identifies the store. A Country Sales
       Manager holding stock is a manager's custody, which the SOP charges as an RSM's. */
    const kindOf = (holder) => {
      const reg = regBy.get(nameKey(holder || ''));
      const role = K((reg && reg.role) || '');
      if (/STORE|GHALA|SIPHO/.test(K(holder || '')) || /STORE|GHALA/.test(role)) return 'store';
      if (/RSM|REGIONAL|COUNTRY_SALES/.test(role)) return 'rsm';
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
    /* BOTH PANES SEE EVERY PHONE. A store keeper who cannot tell whether the handset in
       their hand is locked cannot do the one job they have. */
    requireAnyNav(user, ['devlock', 'devunlock']);
    const a = args || {};
    const want = String(a.state || '').trim();
    /* FIND ONE HANDSET, FAST.
       =====================================================================================
         "Add a search at unlocking before the Achia kwa wingi button. General duty need to
          unlock phones by application and finding a single phone in fast speed is hard, so
          if they search imei there it remains itself on the below list."

       IT HAS TO BE THE SERVER'S SEARCH, not the browser's. This pane holds the newest 500
       rows; the register is bigger than that and getting bigger. A filter over what is
       already on screen would answer "no such phone" about a handset that is sitting in the
       operator's hand, which is the one answer this box must never give.

       DIGITS ONLY, because an IMEI is digits. That means a paste of "IMEI: 3513 8833 4583
       295" finds the phone -- somebody reading off a handset screen or a sticker types what
       they see -- and it also means `%` and `_` can never reach the LIKE pattern, so the
       escaping question does not arise at all. */
    const find = String(a.q == null ? '' : a.q).replace(/\D/g, '');
    const CORE = 'imei, item, holder, state, state_reason, state_at, state_by, reported, '
      + 'last_seen, app_version, battery, android, sold_ref, customer, enrolled_at';
    const LOC = ', last_lat, last_lng, last_loc_acc, last_loc_at';
    const build = (cols) => {
      const qy = db.from('devices').select(cols);
      /* A SEARCH OUTRANKS THE STATE CHIP. The desk is holding ONE phone and wants THAT row.
         If the pane happened to be filtered to "tayari" and the handset is locked, an
         obedient search would report nothing found about a phone the operator can see. */
      if (find) return qy.ilike('imei', '%' + find + '%');
      if (['enrolled', 'locked', 'released', 'lost'].includes(want)) return qy.eq('state', want);
      return qy;
    };
    /* BEFORE THE MIGRATION IS RUN, this table does not exist, and PostgREST answers with a
       relation-not-found that fetchAll turns into a throw -- which withApi reports as a 500.
       So every time somebody opened this pane on a deployment where the SQL had not been run
       yet, the system logged a server failure. It was documented as "reads as empty rather
       than erroring"; it did not, and this is what makes that true.

       An empty register and a register that is not there yet are still DIFFERENT facts, so
       `notReady` rides along and the screen says which one it is looking at. */
    let rows;
    try { rows = await fetchAll(() => build(CORE + LOC)); }
    catch (e) {
      /* THE LOCATION COLUMNS MAY NOT BE THERE YET, which is a different failure from a missing
         table and must not look like one. PostgREST refuses an entire select for a single
         unknown column, so naming last_lat on a deployment whose migration has not been run
         would take the WHOLE Devices pane dark -- every phone, every state, every lock button
         -- over a feature nobody had asked for yet. The register without a map is the
         register; the register without itself is an outage. So it drops back and carries on.

         AND IT IS ASKED FIRST, because tableMissing() matches a missing COLUMN as well as a
         missing table (deliberately: for most callers both mean "run the migration"). Asked
         the other way round, a database with the devices table but no last_lat answered
         "the devices table has not been created yet" and offered the wrong migration. */
      if (/last_lat|last_lng|last_loc_acc|last_loc_at/.test(String(e && e.message || ''))) {
        rows = await fetchAll(() => build(CORE));
      } else if (tableMissing(e)) {
        return { ok: true, rows: [], total: 0, notReady: true,
          counts: { enrolled: 0, locked: 0, lockPending: 0, released: 0, lost: 0, neverSeen: 0, stale: 0 } };
      } else throw e;
    }
    const now = Date.now();
    const HOURS = 36 * 3600 * 1000;      // silent longer than this and it is worth asking why
    const out = rows.map(r => {
      const seen = r.last_seen ? Date.parse(r.last_seen) : null;
      return { ...r,
        neverSeen: !seen,
        silentHours: seen ? Math.round((now - seen) / 3600000) : null,
        /* MINUTES, BECAUSE HOURS CANNOT ANSWER THE QUESTION ANY MORE.
           -------------------------------------------------------------------------------
           "0h" is a rounded hour: it means "sometime in the last half hour", which was fine
           when the beat was every fifteen minutes and is useless now that it is every
           minute. Asked to diagnose a phone that had been ordered to unlock four minutes
           ago, the register said "0h" -- and that is compatible with a handset beating
           seconds ago AND with one that has not spoken since before the order was given.
           Two completely different faults behind one number.

           So the age is carried in minutes and the screen picks the unit. */
        silentMins: seen ? Math.max(0, Math.round((now - seen) / 60000)) : null,
        /* AND THE MOMENT ITSELF, as epoch milliseconds.
             "you said you'll 00:00:00 for last pinged so as we see actual time"

           An age cannot put two events in order. A beat "4 dk" old beside an order "4 dk"
           old could have happened either way round, and which way round it was IS the
           diagnosis: a phone that spoke after the order and stayed locked is a fault; one
           that has not spoken since is simply asleep. The clock settles it in one glance.

           A NUMBER, deliberately, not the timestamp text. A zone-less string is read as
           local by the browser and as UTC by this server -- the same row would be three
           hours out in Dar es Salaam, on the one column whose whole job is to say when. */
        seenAt: seen || null,
        stale: !seen || (now - seen) > HOURS,
        // The honest three-way reading of a lock order, never collapsed into a boolean.
        lockState: r.state !== 'locked' ? null
          : (r.reported === 'locked' ? 'confirmed' : 'pending'),
        /* WHAT WAS LAST ORDERED, AND HOW LONG AGO.
           ---------------------------------------------------------------------------------
             "simu inasema = locked but i just unlocked - maybe we add column for last action
              too that says wether lock, unlock or achia to know what i lastly commited"

           The table already held this and never said it out loud. `state` is the standing
           intent, so an unlock leaves it reading "tayari" -- true, and nothing like the
           sentence "I unlocked this two minutes ago". Beside a stale "Simu inasema: locked"
           that is genuinely unreadable: two columns, neither of them the action just taken.

           So the ORDER is named as an order. With the age beside it, because the whole
           question behind this is "has the phone had time to hear me yet" -- an unlock given
           ten seconds ago and one given yesterday mean completely different things about a
           handset still reporting locked. */
        lastOrder: r.state === 'locked' ? 'Funga' : r.state === 'released' ? 'Achia'
          : r.state === 'lost' ? 'Imepotea' : 'Fungua',
        orderAgeMins: r.state_at ? Math.max(0, Math.round((now - Date.parse(r.state_at)) / 60000)) : null,
        orderAt: r.state_at ? Date.parse(r.state_at) : null,     // same clock as seenAt, so the two compare
        orderBy: r.state_by || '',
        /* WHERE IT WAS, AND WHEN THAT WAS TRUE -- two facts, never one.
           ---------------------------------------------------------------------------------
             "am asked if the app could trap last sync with location coordinates"

           The handset reports the position the system already had rather than waking its GPS
           every minute, so the fix can be far older than the beat that carried it. Sending
           the coordinate without its age would let this column say a phone is somewhere it
           left days ago -- and somebody would drive there. locAt is what the screen shows
           beside the pin; locAcc is what stops a 2km cell-tower estimate reading as an
           address. */
        lat: r.last_lat == null ? null : Number(r.last_lat),
        lng: r.last_lng == null ? null : Number(r.last_lng),
        locAcc: r.last_loc_acc == null ? null : Number(r.last_loc_acc),
        locAt: r.last_loc_at ? Date.parse(r.last_loc_at) : null,
        // When this phone joined the register. Drives the "just enrolled" band below, and is
        // epoch ms like every other time on the wire -- never zone-less text.
        enrolledAt: r.enrolled_at ? Date.parse(r.enrolled_at) : null,
        /* ORDERED LOCKED, AND HAS NEVER ONCE SPOKEN.
           ---------------------------------------------------------------------------------
           This is the worst state a row can be in and it used to read as an ordinary pending
           lock. A pending lock means "told, waiting for it to confirm" -- a phone that will
           almost certainly report in within the quarter hour. THIS means the handset has
           never contacted us at all, in its entire life on the register, and a lock ordered
           against it was never heard by anything.

           It happens when provisioning half-succeeded: the register minted a token, and the
           broadcast that would have written that token INTO the phone bailed out -- most often
           because set-device-owner was refused for accounts on the handset. The office then
           has a row that says `locked` about a phone which is running YouTube.

           `enrol_token is not null` does NOT rule it out, and that is the trap: the token
           proves the SERVER has an identity for this IMEI, never that the phone received it. */
        lockedNeverSpoke: K(r.state) === 'LOCKED' && !r.last_seen,
      };
    }).sort((x, y) => {
      /* THE PHONES YOU JUST ADDED COME FIRST.
         -----------------------------------------------------------------------------------
           "all recent added imeis should be on top so that i dont hustle finding them"

         The ordering below is deliberate and stays: a written-off phone, then a lock nobody
         has confirmed, then silence -- problems before routine, so the register opens on what
         needs somebody. That is right for a fleet at rest and useless at the bench, where the
         phones that matter are the ones plugged in five minutes ago and the sort buries them
         among four hundred others by IMEI.

         So a band on top, and it is a BAND rather than a new sort: anything enrolled in the
         last day floats up, newest first, and everything else keeps the order it always had.
         A day because that is what a bench session is, and it matches the batch's own life --
         by tomorrow morning these are just phones and the fleet's own priorities take over
         again, with nothing to switch off and nothing to remember. */
      const justAdded = d => (d.enrolledAt && (now - d.enrolledAt) < FRESH_ENROL_MS) ? 0 : 1;
      const rank = d => (d.state === 'lost' ? 0 : d.state === 'locked' && d.lockState === 'pending' ? 1
        : d.stale ? 2 : d.state === 'locked' ? 3 : 4);
      const fx = justAdded(x), fy = justAdded(y);
      if (fx !== fy) return fx - fy;
      // Newest first WITHIN the fresh band; below it, the fleet's own order is untouched.
      if (fx === 0 && x.enrolledAt !== y.enrolledAt) return y.enrolledAt - x.enrolledAt;
      return rank(x) - rank(y) || String(x.imei).localeCompare(String(y.imei));
    });
    const count = f => out.filter(f).length;
    return { ok: true, rows: out.slice(0, 500), total: out.length,
      /* WHAT WAS SEARCHED FOR, back on the wire. The box shows the digits the server actually
         used rather than what was typed, so "IMEI: 3513 8833" reads back as 35138833 and
         nobody wonders why the spaces stopped mattering. */
      q: find, searching: !!find,
      counts: {
        enrolled: count(r => r.state === 'enrolled'),
        locked: count(r => r.state === 'locked'),
        lockPending: count(r => r.lockState === 'pending'),
        released: count(r => r.state === 'released'),
        lost: count(r => r.state === 'lost'),
        neverSeen: count(r => r.neverSeen),
        stale: count(r => r.stale && !r.neverSeen),
        /* The alarm, counted separately from everything else because it is not a category of
           phone -- it is a category of MISTAKE, and one the office cannot see any other way. */
        lockedNeverSpoke: count(r => r.lockedNeverSpoke),
      } };
  },

  /* ENROL -- take control of phones that are sitting in stock. Fed by IMEI, so the
     enrolment station can scan a box or paste a column straight out of Sipho's report;
     the stock report itself fills in model and holder where it knows them.
     Idempotent: re-enrolling a phone already on the registry is a no-op that reports
     itself, never a duplicate and never a silent state reset. */
  async deviceEnrol(db, user, args) {
    /* PROVISIONING IS THE BENCH'S OWN WORK: the store keeper puts the app on the phone,
       so enrolling belongs with locking. */
    requireWrite(user); requireNav(user, 'devlock');
    const a = args || {};
    const list = [...new Set((Array.isArray(a.imeis) ? a.imeis : String(a.imeis || '').split(/[\s,;]+/))
      .map(x => String(x || '').trim()).filter(Boolean))];
    if (!list.length) bad('Weka angalau IMEI moja. / At least one IMEI is required.');
    if (list.length > 500) bad('IMEI nyingi mno kwa mara moja (kikomo 500). / Too many at once — 500 max.');

    /* THE TOKEN OF AN IMEI WE ALREADY HOLD IS READ BACK, not replaced.
       -------------------------------------------------------------------------------------
         "achia and relock/re-enroll should repick same token used before if the imei exists"

       A handset keeps its credential through every state it can be in. Release does not
       touch it, and enrolling a known IMEI never minted a second one -- but it also handed
       the station NOTHING, so a phone being redone dropped out of the enrol flow and had to
       be chased through the Token drawer one at a time. On a bench doing twenty redos that
       is twenty detours, and the obvious shortcut is to delete the row and enrol it fresh,
       which mints a NEW token while the phone in your hand still holds the old one. That is
       precisely how a register and a handset stop agreeing.

       So a known IMEI comes back with the token it already has. Same phone, same identity,
       one command, nothing on the handset to change. */
    const [already, stock] = await Promise.all([
      fetchAll(() => db.from('devices').select('imei, enrol_token, state').in('imei', list))
        .catch(e => {
          // Pre-migration registries have no enrol_token; enrolling must still work.
          if (!/enrol_token/.test(String(e && e.message || ''))) throw e;
          return fetchAll(() => db.from('devices').select('imei, state').in('imei', list));
        }),
      fetchAll(() => db.from('hoop_aged_stock').select('serial, item, agent, as_of').in('serial', list)),
    ]);
    const have = new Set(already.map(r => String(r.imei)));
    const held = new Map(already.filter(r => r.enrol_token)
      .map(r => [String(r.imei), String(r.enrol_token)]));
    // Newest stock row per serial, so model/holder come from the latest count, not the first.
    const stockBy = new Map();
    for (const s of stock) {
      const k = String(s.serial), had = stockBy.get(k);
      if (!had || String(s.as_of) > String(had.as_of)) stockBy.set(k, s);
    }
    const fresh = list.filter(i => !have.has(i));
    /* AND AN IMEI THAT HAS BEEN HERE BEFORE GETS ITS OWN TOKEN BACK.
       -------------------------------------------------------------------------------------
         "then futa shouldnt lose token record"

       Deleting a row used to destroy the token with it, so re-enrolling the same handset
       minted a new identity while the phone in your hand still held the old one -- and that
       phone then answered every beat with a 403 and could be neither released nor reset.
       device_tokens remembers the string; this is where it comes back.

       Best effort: no table yet means no memory, and enrolment mints as it always did. */
    let remembered = new Map();
    if (fresh.length) {
      try {
        const past = await fetchAll(() => db.from('device_tokens')
          .select('imei, enrol_token').in('imei', fresh));
        remembered = new Map(past.filter(r => r.enrol_token)
          .map(r => [String(r.imei), String(r.enrol_token)]));
      } catch (ignored) { /* table not created yet */ }
    }
    const at = new Date().toISOString();
    const batch = randomUUID();
    /* Whether this batch can actually be claimed against. enrol_batch_at is what decides:
       without it the server cannot tell a batch issued minutes ago from one issued last month,
       and a bearer secret that never expires is not one worth handing out. */
    let batchReady = true;
    /* ONE TOKEN PER PHONE, minted here and nowhere else. This is the credential the handset
       will carry -- it has no access code and never will -- so it is generated at the only
       moment the phone is physically in our hands, and returned ONCE, to the station that
       is about to write it into that phone. It is never read back onto a list screen. */
    const token = () => randomUUID().replace(/-/g, '');
    // Its own token back if we have ever known one for this IMEI; a new one only for a phone
    // this register has genuinely never seen.
    const minted = new Map(fresh.map(imei => [imei, remembered.get(imei) || token()]));
    if (fresh.length) {
      const rows = fresh.map(imei => {
        const s = stockBy.get(imei);
        return { imei, enrolled_at: at, enrolled_by: user.name,
          enrol_batch: batch, enrol_batch_at: at,
          item: (s && s.item) || null, holder: (s && s.agent) || null,
          enrol_token: minted.get(imei),
          state: 'enrolled', state_by: user.name, state_at: at, updated_at: at };
      });
      // Pre-migration: a registry created before the phone half existed has no enrol_token,
      // and PostgREST refuses the whole insert for one unknown column. Enrol still works --
      // those phones simply cannot beat until the alter in RUN-ME-2026-08-24-devices.sql runs.
      let { error } = await db.from('devices').insert(rows);
      if (error && /enrol_batch_at/.test(String(error.message || ''))) {
        // Before RUN-ME-2026-08-31-enrol-batch.sql. Enrolling still works; only the
        // one-command hub claim is unavailable, and the drawer says so rather than offering a
        // command that would be refused by every handset.
        ({ error } = await db.from('devices').insert(
          rows.map(({ enrol_batch_at, ...rest }) => rest)));
        batchReady = false;
      }
      if (error && /enrol_token/.test(String(error.message || ''))) {
        minted.clear();
        ({ error } = await db.from('devices').insert(
          rows.map(({ enrol_token, enrol_batch_at, ...rest }) => rest)));
        batchReady = false;
      }
      if (error) throw new Error(error.message);
      const { error: eErr } = await db.from('device_events').insert(fresh.map(imei => ({
        imei, event: 'enrolled', from_state: null, to_state: 'enrolled', actor: user.name, at })));
      if (eErr) throw new Error(eErr.message);
    }
    /* A PHONE THE REGISTER ALREADY KNEW HAS TO JOIN THIS BATCH TOO. Its row is not
       re-inserted -- it keeps its own token, deliberately -- so without this it would still
       carry the enrol_batch of some previous session, and the hub command would refuse it.
       On the bench that reads as "this handset is broken" rather than "it was never in the
       batch you just made", which is the kind of confusion that sends somebody looking for a
       hardware fault. */
    const rejoin = list.filter(i => have.has(i));
    if (batchReady && rejoin.length) {
      const { error } = await db.from('devices')
        .update({ enrol_batch: batch, enrol_batch_at: at }).in('imei', rejoin);
      if (error && /enrol_batch_at/.test(String(error.message || ''))) batchReady = false;
      else if (error) throw new Error(error.message);
    }

    /* ACHIA, THEN ENROL IT AGAIN, AND FUNGA HAS TO JUST WORK.
       =====================================================================================
         "unlock should work as long as i have not achia.. if i achia and re-enloll the same
          phone pick its old imei so that funga works"

       The identity half of that was already solved, and by a migration: device_tokens
       remembers the string, so a handset that comes back gets the token it already carries
       instead of a second one. That part holds.

       What did not was the STATE. Achia leaves the row reading `released`, and re-enrolling
       only updated its batch -- so the row was still `released` afterwards, and Funga hit the
       released-and-silent refusal. The operator had just re-provisioned that phone by cable,
       which is the one honest reason the override exists, and was made to argue with a
       warning about it anyway. A confirmation you have to dismiss every single time is a
       confirmation nobody reads by the third phone.

       Enrolling a handset IS the statement that it is under our control again, so it is
       recorded as one.

       ONLY FROM `released`, AND THAT LIMIT IS THE WHOLE SAFETY OF THIS.
       -------------------------------------------------------------------------------------
       A LOCKED phone stays locked. Somebody's loan is in arrears and their handset is dark;
       if enrolment reset state generally, then plugging that phone in and running the same
       bench command anyone can copy would quietly free it -- a lock bypass with no decision
       behind it and nothing in the register to show one was made. `lost` stays `lost` for the
       same reason: writing a handset off is a judgement, and a cable is not an appeal.

       So: released -> enrolled, and nothing else moves. No migration -- every column here has
       existed since the register did. */
    const revive = already
      .filter(r => String(r.state) === 'released')
      .map(r => String(r.imei))
      .filter(i => list.includes(i));
    if (revive.length) {
      const { error } = await db.from('devices').update({
        state: 'enrolled', state_reason: null, state_by: user.name, state_at: at,
        // It is not released any more, and a released_at left behind on a row that is not
        // released is exactly what the stale check in deviceSetState reads.
        released_at: null, updated_at: at,
      }).in('imei', revive);
      if (error) throw new Error(error.message);
      /* It goes in the history like any other state change. "Why is this phone enrolled when
         I released it in March" is a real question, and the answer is a row, not a shrug. */
      const { error: eErr } = await db.from('device_events').insert(revive.map(imei => ({
        imei, event: 'enrolled', from_state: 'released', to_state: 'enrolled',
        reason: 'imesajiliwa upya / re-enrolled', actor: user.name, at })));
      if (eErr) throw new Error(eErr.message);
    }

    return { ok: true, enrolled: fresh.length, alreadyOn: list.length - fresh.length,
      unknownToStock: fresh.filter(i => !stockBy.has(i)).length,
      /* Said out loud on the screen, because it is a state change the operator did not
         explicitly ask for -- they asked to enrol. Silently un-releasing rows would be the
         right behaviour reported as nothing at all. */
      revived: revive.length,
      batch, batchReady,
      /* FOR THE PROVISIONING STATION ONLY, and in the order the operator typed the IMEIs so
         a paper list can be worked down without hunting. `fresh` says whether this is a new
         phone or one the register already knew: the command is identical either way, but an
         operator who sees "already on the register" and a token knows the handset kept its
         identity rather than quietly being given a new one. Empty when the token column is
         not there yet. */
      provision: list.map(imei => ({
        imei,
        token: minted.get(imei) || held.get(imei) || null,
        // "New" means a token this register has never issued for this IMEI. A row that was
        // deleted and re-enrolled is NOT new: it is the same phone, carrying the same
        // credential, and telling the operator otherwise is what sent them looking for a
        // problem that was not there.
        fresh: !have.has(imei) && !remembered.has(imei),
      })).filter(p => p.token) };
  },

  /* SET STATE -- lock, unlock, release or write off. One door for every state change, so
     the event trail cannot be bypassed by whichever screen happens to call it.

     A REASON IS REQUIRED to lock or to write a phone off. Locking somebody's phone is an
     act with a person on the other end of it; six months later "why is this locked" has to
     have an answer, and the only reliable moment to capture one is now. */
  async deviceSetState(db, user, args) {
    requireWrite(user);
    const a = args || {};
    const to = String(a.state || '').trim();
    if (!Object.prototype.hasOwnProperty.call(DEVICE_STATE_NAV, to)) {
      throw new Error('Hali si sahihi. / Unknown device state: ' + to);
    }
    /* THE GATE IS ON THE TRANSITION, NOT ON THE PANE.
       -----------------------------------------------------------------------------------
       This is ONE door for all four state changes, so a pane that merely hides its unlock
       button is a suggestion rather than a rule -- curl does not read HTML, and the whole
       point of the split is that the store keeper cannot unlock somebody's handset. Which
       nav is required is decided by the state being ASKED FOR, which is also what makes
       re-locking work: a locker sending `locked` against a released phone is still asking
       to lock, and that is theirs to ask. */
    requireNav(user, DEVICE_STATE_NAV[to]);
    const reason = String(a.reason || '').trim();
    if ((to === 'locked' || to === 'lost') && !reason) {
      bad('Sababu inahitajika. / A reason is required to lock or write off a phone.');
    }
    const list = [...new Set((Array.isArray(a.imeis) ? a.imeis : [a.imei || a.imeis])
      .map(x => String(x || '').trim()).filter(Boolean))];
    if (!list.length) bad('Weka IMEI. / An IMEI is required.');
    /* THE SAME CEILING ENROLMENT HAS, AND FOR THE SAME REASON.
       -----------------------------------------------------------------------------------
       Every IMEI in this list goes into an `in(...)` filter, which travels as a query string:
       past a few hundred the URL is refused by something between here and the database, and
       what comes back is a transport error rather than an answer about phones. A bulk release
       is now fed by a PASTE, so the list is no longer bounded by what fits on a screen -- a
       column dragged too far is a plausible accident, and the failure it causes should be a
       sentence about the limit rather than a stack trace about a URL.

       500 is deliberately the number deviceEnrol already uses: one ceiling to remember, and
       it is above the 500 rows deviceList can show, so tick-all on a full table still fits. */
    if (list.length > 500) {
      bad('IMEI nyingi mno kwa mara moja (kikomo 500). Gawa kwa makundi. '
        + '/ Too many at once — 500 max. Split the list into batches.');
    }

    const current = await fetchAll(() => db.from('devices')
      .select('imei, state, released_at, last_seen').in('imei', list));
    const known = new Map(current.map(r => [String(r.imei), r.state]));
    const missing = list.filter(i => !known.has(i));

    /* FUNGA ON A PHONE ALREADY RELEASED IS USUALLY AN ORDER NOBODY WILL EVER HEAR.
       =====================================================================================
         "funga for already achia should refuse and say you cant funga achia, proceed anyway
          if you will install app"

       Achia tells the handset to unlock, drop the restrictions, step down as Device Owner
       and STOP CALLING HOME. A phone that did all four is gone: it has no reason to ask us
       anything ever again. Ordering Funga against that row writes a decision nobody will
       collect -- the register sits on "imeagizwa · bado" for ever and the office reads it as
       a phone that is being slow, rather than one that stopped listening days ago.

       BUT NOT EVERY RELEASED PHONE IS GONE, and a blanket refusal would be wrong in the case
       that matters most. Where the step-down was REFUSED -- Knox, a vendor build, anything
       -- the handset keeps beating precisely so the office can still reach it. Those are
       re-lockable from here with no cable at all, and refusing them would send somebody
       driving to a phone they could have locked from their desk.

       The register can tell the two apart without asking anybody: has this handset spoken
       SINCE it was released? If it has, it is still listening. If it has not, it is not.

       And the override exists because there is one honest reason to order a lock a phone
       cannot currently hear: you are about to put the app back on it by cable, and you want
       the standing order waiting when it wakes up. That is a deliberate act, so it takes a
       deliberate confirmation rather than being the default. */
    const stuck = to !== 'locked' || a.force === true ? [] : list.filter(i => {
      if (known.get(i) !== 'released') return false;
      const r = current.find(x => String(x.imei) === i);
      const spoke = r && r.last_seen ? Date.parse(r.last_seen) : 0;
      const freed = r && r.released_at ? Date.parse(r.released_at) : 0;
      // Never heard from, or last heard from before we let it go: it is not listening.
      return !(spoke && freed && spoke > freed);
    });
    /* THE REFUSAL IS ABOUT THE PHONES IT NAMES, AND ONLY THOSE.
       =====================================================================================
       This used to throw HERE, before touching anything -- so one released-and-silent
       handset among twenty ticked ones refused the whole order and locked NONE of them. The
       client then offered its confirmation and, correctly, retried only the phone the server
       had named. The other nineteen were never locked at all, and the toast that followed
       read "Zimebadilishwa: 1", which an operator reads as the job being done.

       Twenty customers' phones left open while the register says they are shut is the worst
       failure this pane has, and it hid behind a refusal that looks careful.

       Three separate comments in this codebase -- on the client, on this function, and on
       the test -- already describe the OTHER behaviour: "they were locked the first time".
       That is the design; this is it being implemented. The reachable phones go through, and
       the 409 that follows is a question about the ones that did not, carrying the count of
       what already happened so the operator is never told less than the truth. */
    const held = new Set(stuck);
    const changing = list.filter(i => !held.has(i) && known.has(i) && known.get(i) !== to);
    const at = new Date().toISOString();
    let pushed = { sent: 0, failed: 0, stale: [] };
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

      /* RING THE DOORBELL. The decision is already recorded above -- this only decides
         whether the handset finds out in a second or on its next beat.
         ---------------------------------------------------------------------------------
         Awaited rather than fired and forgotten, because the operator is watching the screen
         and a lock that is "sent" before it has actually been sent is the kind of half-truth
         this system keeps having to unlearn. It cannot fail the action: nudge() swallows
         everything, returns zeros when push is not configured, and the timed beat underneath
         is untouched either way. What it costs is a second on a bulk Funga; what it buys is
         the phones going dark while somebody is still looking at the tick boxes. */
      pushed = await nudge(db, changing);
    }

    /* NOW the question about the ones that were held back -- after the rest are done, so the
       confirmation the operator is about to answer is only ever about those. `changed` rides
       on the error because the screen must be able to say what already happened: a dialog
       that mentions one phone, on a click that just locked nineteen, is a dialog that
       misleads. Every stuck IMEI is named, not the first twenty: the client retries exactly
       what it is given, so a truncated list is a set of phones silently left unlocked. */
    if (stuck.length) {
      const e = new Error('Simu iliyoachiwa haisikii tena — iliachwa na ikaacha kuongea. '
        + 'Irudishe app kwa kebo, kisha funga. / This phone was released and has not spoken '
        + 'since, so it is no longer listening: a lock order would sit unheard. Re-provision '
        + 'it by cable first, or confirm to leave the order standing for when it comes back.');
      e.status = 409;
      e.code = 'RELEASED_NOT_LISTENING';
      e.imeis = stuck;
      e.changed = changing.length;
      throw e;
    }

    return { ok: true, changed: changing.length,
      alreadyThere: list.length - changing.length - missing.length,
      notEnrolled: missing.length, notEnrolledList: missing.slice(0, 20),
      /* How many handsets were reached instantly, so the screen can say "3 zimeamshwa"
         rather than leaving somebody to guess whether the silence means anything. Zero is a
         perfectly ordinary answer: push may be unconfigured, or those phones may be off. */
      woken: pushed.sent };
  },

  /* ONE PHONE'S WHOLE STORY -- its current row and every state change ever ordered against
     it. This is what somebody opens when a customer is standing in front of them asking
     why their phone is locked. */
  async deviceHistory(db, user, args) {
    /* BOTH PANES SEE EVERY PHONE. A store keeper who cannot tell whether the handset in
       their hand is locked cannot do the one job they have. */
    requireAnyNav(user, ['devlock', 'devunlock']);
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
      fetchAll(() => db.from('device_events').select('*').eq('imei', imei).order('at', { ascending: false })),
    ]);
    /* THE CLOCK IN THIS PANEL MUST BE THE CLOCK IN THE ROW ABOVE IT.
       -------------------------------------------------------------------------------------
       `at` is a timestamptz and PostgREST hands it over as text in UTC. This panel used to
       print that text with the T knocked out, so every history line read three hours behind
       Dar es Salaam -- while the register row directly above it renders last_seen through
       clock(), which is fed epoch milliseconds and is therefore local. Two clocks, one
       screen, three hours apart, on the one panel you open to prove WHEN an order was given
       and when the handset confirmed it.

       So the number goes out instead of the text, exactly as seenAt and orderAt already do.
       `at` is left on the row untouched: it is what the audit-minded reader would quote, and
       removing a field to fix a rendering bug breaks callers to save nothing. */
    const out = events.slice(0, 100).map(e => ({ ...e, atMs: e.at ? Date.parse(e.at) : null }));
    return { ok: true, imei, device: devRows[0] || null, events: out, total: events.length };
  },

  /* THE TOKEN, HANDED BACK -- for one phone, on purpose, when it is re-flashed and has to
     be provisioned again. Enrolment shows a token once; a wiped handset needs it a second
     time, and the alternative (re-enrolling to mint a fresh one) would throw away that
     phone's whole history to solve a five-second problem.

     Treated as a WRITE even though it reads: it discloses a credential, so it takes the
     write permission and lands in the audit log with the IMEI attached. Nobody should be
     able to walk the fleet collecting tokens without that being visible afterwards. */
  async deviceToken(db, user, args) {
    /* A token is the credential that lets a handset be provisioned at all -- bench work. */
    requireWrite(user); requireNav(user, 'devlock');
    const imei = String((args && args.imei) || '').trim();
    if (!imei) bad('IMEI inahitajika. / An IMEI is required.');
    const rows = await fetchAll(() => db.from('devices').select('imei, enrol_token').eq('imei', imei));
    if (rows.length) return { ok: true, imei, token: rows[0].enrol_token || null, retired: false };
    /* AND IF THE ROW IS GONE, ASK THE MEMORY. A deleted handset is the case that needs this
       MOST, not least: it is still Device Owner and still carrying its token, so it can be
       neither released nor factory reset without that string -- and docs/DEVICE-LOCKING.md
       sends the operator to this very button to fetch it for the `-e current` recovery
       broadcast. deviceDelete has been writing the token to device_tokens all along; nothing
       could read it back, so the memory was write-only and the recovery it exists for could
       not be performed through any screen.

       `retired: true` so the drawer can say what this is: the token of a phone the register
       no longer lists, which is the whole reason somebody is looking it up. */
    try {
      const past = await fetchAll(() => db.from('device_tokens')
        .select('imei, enrol_token, retired_at, retired_by').eq('imei', imei));
      if (past.length && past[0].enrol_token) {
        return { ok: true, imei, token: String(past[0].enrol_token), retired: true,
          retiredAt: past[0].retired_at ? Date.parse(past[0].retired_at) : null,
          retiredBy: past[0].retired_by || null };
      }
    } catch (ignored) { /* migration not run: fall through to the same refusal as before */ }
    bad('Kifaa hakijasajiliwa. / That IMEI is not on the registry.');
  },

  /* TAKE A PHONE OFF THE REGISTER ENTIRELY -- for starting a handset over.
     =====================================================================================
       "i need delete button after token and historia for now b/se i want to start afresh"

     Deliberately separate from `released`. Achia is a decision about a customer's loan and
     leaves a trail; this is an eraser for a row that should not have existed -- a wrong
     IMEI, a test handset, a batch enrolled twice. So the row and its history both go, and
     the ONLY record left is the audit entry this fn is registered for.

     WHAT IT DOES NOT DO, and the screen says so before anybody presses it: the handset does
     not hear about this. It still holds its token and is still Device Owner, and its next
     beat gets a 403 -- which is NOT read as permission to unlock. A phone un-enrolled by
     somebody tampering with the database is the last one that should let itself go.

     But it does not stay that way for ever, and this is the half that used to be missing.
     Fourteen days of unbroken 403 and the handset releases itself: unlocks, drops the
     restrictions, steps down as Device Owner (see noteNotEnrolled in Beat.java). Long enough
     that a bad deploy cannot free the fleet, short enough that a deleted row is not a life
     sentence. And a phone needed back sooner than that is reachable at a bench with a cable
     -- ReleaseReceiver, docs/DEVICE-LOCKING.md -- rather than only by a factory reset the
     lock is still refusing.

     A LOCKED PHONE IS REFUSED. Deleting the row of a phone that is currently locked would
     strand it: locked forever, with nothing on the register to unlock it from. Unlock it
     first, watch it confirm, then delete. */
  async deviceDelete(db, user, args) {
    /* An eraser on the register the bench keeps. */
    requireWrite(user); requireNav(user, 'devlock');
    const imei = String((args && args.imei) || '').trim();
    if (!imei) bad('IMEI inahitajika. / An IMEI is required.');
    const rows = await fetchAll(() => db.from('devices')
      .select('imei, state, reported, last_seen, released_at, enrol_token').eq('imei', imei))
      .catch(e => {
        // Pre-migration registries have no enrol_token; deleting must still work.
        if (!/enrol_token/.test(String(e && e.message || ''))) throw e;
        return fetchAll(() => db.from('devices')
          .select('imei, state, reported, last_seen, released_at').eq('imei', imei));
      });
    const dev = rows.find(r => String(r.imei) === imei);
    if (!dev) bad('Kifaa hakijasajiliwa. / That IMEI is not on the registry.');
    if (String(dev.state) === 'locked' || String(dev.reported) === 'locked') {
      bad('Simu imefungwa. Ifungue kwanza, subiri ithibitishe, ndipo uifute. '
        + '/ This phone is locked. Unlock it and wait for it to confirm before deleting, or it stays locked with no way to reach it.');
    }
    /* AND IT MUST NOT ORPHAN A LIVE HANDSET, which is the bug this guard exists for.
       ------------------------------------------------------------------------------
       Deleting the row of a phone that is still provisioned leaves it hardened with no
       office: lock, unlock and release all travel through a row that no longer exists, and
       the handset refuses the factory reset that would fix it. That is a brick, and it was
       reachable in one click on the first day this button shipped.

       So the door is: a phone that has never once spoken (provisioning did not take, so
       there is nothing on the handset to strand), or one already RELEASED -- which is the
       state that tells the handset to hand itself back. Released-but-not-yet-heard is fine:
       the order is standing, and the phone applies it the moment it reaches us. */
    /* AND "RELEASED" IS NOT THE SAME AS "LET GO", which is the hole this closes.
       ------------------------------------------------------------------------------------
         "I used achia the phone was still owned by organization and I futa and reenrolled
          the device, now it's not locking after I funga"

       Achia asks the handset to unlock, drop its restrictions and step down as Device Owner.
       The step-down CAN be refused -- Knox does exactly that on organisation-owned stock --
       and when it is, the phone deliberately keeps beating so the office can still reach it.
       That is the design working. The register says `released`; the handset is still ours.

       Deleting that row is the trap. Futa never reaches the phone, so the handset goes on
       presenting a credential that no longer exists: every beat 403s, and both exits are
       shut at once -- it will not factory reset because it is still Device Owner, and a
       release cannot reach it through a token it does not recognise. Recovering it means
       guessing the old token or a cable. This has now cost three separate afternoons.

       THE REGISTER CAN SEE IT COMING: a phone that has spoken SINCE it was released did not
       let go. That is the same fact the lock refusal reads, inverted -- there it proves a
       released handset is still reachable and so a Funga is worth sending; here it proves
       the same handset is still ours and so the row is not ours to delete.

       Bounded by the stale window on purpose. A phone that beat after its release and then
       went silent for days is genuinely gone, and its row should not be undeletable for
       ever on the strength of one heartbeat from last week. */
    const freedAt = dev.released_at ? Date.parse(dev.released_at) : 0;
    const spokeAt = dev.last_seen ? Date.parse(dev.last_seen) : 0;
    const STILL_ALIVE_MS = 36 * 3600 * 1000;
    if (String(dev.state) === 'released' && freedAt && spokeAt > freedAt
        && (Date.now() - spokeAt) < STILL_ALIVE_MS) {
      bad('Simu iliambiwa iachiwe lakini <b>bado ni mali ya kampuni</b> — imeendelea kuongea '
        + 'baada ya kuachiwa, maana yake haikukubali kujitoa. Ukiifuta sasa, simu itabaki na '
        + 'token isiyokuwepo: haitafungwa, haitafunguliwa, na haitakubali kufutwa (factory '
        + 'reset). Itoe kwa waya kwanza (RELEASE kwa adb), ndipo uifute. '
        + '/ This handset was told to release but is STILL Device Owner — it has gone on '
        + 'beating since, which means the step-down was refused. Deleting the row now leaves '
        + 'it holding a token that no longer exists: it cannot be locked, unlocked, released '
        + 'or factory reset. Release it over the cable first, then delete. '
        + 'See docs/DEVICE-LOCKING.md.');
    }
    const spoke = !!String(dev.last_seen || '').trim();
    if (spoke && String(dev.state) !== 'released') {
      bad('Simu bado ipo chini ya udhibiti. Bonyeza <b>Achia</b> kwanza — ndipo simu ijiachie '
        + 'yenyewe — kisha uifute. / This handset is still under management. Release it first '
        + '(Achia), or deleting the row leaves it locked down with nothing able to reach it.');
    }
    /* THE TOKEN OUTLIVES THE ROW, and the history does not.
       -------------------------------------------------------------------------------------
         "then futa shouldnt lose token record"
         "I used futa at devices I expect non of its previous histories"

       Two asks that sound opposed and are not. The operator wants the phone's PAST gone --
       events, states, reasons -- and does NOT want its IDENTITY changed underneath them.
       Deleting both is what produced a phone and a register holding different tokens: the
       handset was never wiped, so it went on presenting a credential the register had just
       thrown away. Every beat 403s, and the way out is shut in both directions -- the phone
       is still Device Owner so it refuses a factory reset, and a release cannot reach it
       through a token it does not recognise.

       So one string per IMEI is remembered here and nothing else, and enrolling that IMEI
       again hands the handset back what it is still carrying. device_events is still deleted
       below, and stays deleted.

       Best effort on purpose: on a deployment that has not run the migration this table does
       not exist, and a delete that WORKS without remembering is far better than a delete
       that fails. The register is the thing that must keep working. */
    /* "BEST EFFORT" HAS TO MEAN THE MISSING TABLE AND NOTHING ELSE.
       -------------------------------------------------------------------------------------
       This read as a guarded write and was not one. The Supabase client does not throw on a
       database error unless .throwOnError() is called, which this codebase never does -- it
       RESOLVES with { data: null, error }. The result was discarded here, so the catch could
       only ever fire on a fetch-level network throw, and every database error -- a timeout, a
       permission change, a transient 503 -- passed silently into the delete below.

       That is the one failure this whole mechanism exists to prevent. The row goes, the
       memory was never written, and the handset walks away still carrying a credential the
       register can no longer name: every beat 403s, a release cannot reach it, and it refuses
       a factory reset because it is still Device Owner. A phone in that state is scrap, and
       nothing anywhere would have said so.

       So the error is now read. A table that does not exist is still waved through -- that is
       the deliberate tolerance for a deployment that has not run
       RUN-ME-2026-08-28-token-memory.sql, and a delete that works without remembering really
       is better than one that fails. Anything else stops the delete, because a Futa that
       cannot remember is a Futa that should not happen. */
    if (dev.enrol_token) {
      let remembered = null;
      try {
        remembered = await db.from('device_tokens').upsert(
          [{ imei, enrol_token: String(dev.enrol_token), retired_at: new Date().toISOString(),
             retired_by: user.name }], { onConflict: 'imei' });
      } catch (netErr) {
        remembered = { error: { message: String((netErr && netErr.message) || netErr) } };
      }
      const remErr = remembered && remembered.error;
      if (remErr && !tableMissing(remErr)) {
        const e = new Error(
          'Imeshindikana kuhifadhi kumbukumbu ya token, kwa hiyo hakijafutwa — jaribu tena. '
          + '/ The token could not be remembered, so nothing was deleted. Deleting anyway would '
          + 'strand this handset: it keeps a credential the register could no longer name, and '
          + 'a phone in that state can neither be released nor factory reset. Try again.');
        e.status = 503;
        throw e;
      }
    }
    // History first: a device_events row whose device is gone is a row nobody can read.
    await db.from('device_events').delete().eq('imei', imei);
    const { error } = await db.from('devices').delete().eq('imei', imei);
    if (error) throw new Error(error.message);
    return { ok: true, imei };
  },

  /* =====================================================================================
     SALARY ADVANCE -- ask, decide, pay.
     =====================================================================================
       "hoop users should get a nav pane and be able to make advance requests, their leaders
        will be assigned with another approval nav ... there is salary advance report nav
        that I'll grant to hr which hr will use for filing and bank payment report"

     Three panes over ONE table, gated by three navs and by nothing else. No role is ever
     named in this code: the owner grants advreq to whoever may ask, advappr to whoever may
     decide, and advrep to whoever pays. Moving the authority is moving a tick.

     WHO IS ASKING IS NOT A PARAMETER. The requester's name, role and code come off the
     signed-in access code on the server; the client cannot send them and cannot spoof them.
     They are then STAMPED on the row rather than joined later -- see the migration for why a
     payment record must not rewrite itself when the register changes. */
  async advRequest(db, user, args) {
    requireNav(user, 'advreq');
    requireWrite(user);
    const a = args || {};
    const amount = Number(a.amount);
    if (!ADV_AMOUNTS.includes(amount)) {
      bad('Chagua kiasi kutoka kwenye orodha. / Choose one of the listed amounts.');
    }
    /* THE DATE THE REQUESTER PICKS, which is not the date they pressed the button. Both are
       kept: requested_at is stamped by the database, this is the applicant's own calendar
       choice, and the report shows the two side by side. */
    const applyDate = String(a.applyDate || '').trim();
    /* SHAPE AND THEN CALENDAR. The regex only says it looks like a date: 2026-02-30 and
       2026-13-01 both pass it, and Postgres then refuses the insert with a range error that
       reaches the officer as a 500 and a raw database message. Round-tripping through Date is
       what separates "looks like a date" from "is one" -- an out-of-range field silently rolls
       over (Feb 30th becomes Mar 2nd), so a value that does not come back identical was never
       a real day. The browser's <input type="date"> cannot produce one of these, but the
       server is not entitled to assume its caller is a browser. */
    const asDay = new Date(applyDate + 'T00:00:00Z');
    /* isNaN FIRST. A month of 13 gives an Invalid Date, and calling toISOString on one THROWS
       a RangeError -- which would have escaped as the same 500 this check exists to prevent.
       Only once it is a real Date does the round-trip mean anything: an out-of-range day
       silently rolls over (Feb 30th becomes Mar 2nd), so a value that does not come back
       identical was never a real day. */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(applyDate) || isNaN(asDay.getTime())
        || asDay.toISOString().slice(0, 10) !== applyDate) {
      bad('Weka tarehe ya maombi. / Pick an application date.');
    }
    const bank = String(a.bank || '').trim();
    const account = String(a.account || '').trim();
    /* THE BANK DETAILS ARE REQUIRED AT THE ASK, not chased afterwards. HR's pane is a payment
       instruction: a row that reaches it without somewhere to send the money is a row that
       stops the run while somebody makes a phone call. The requester is the only person who
       knows these, so this is the only moment to get them. */
    if (!bank) bad('Weka jina la benki au mtandao. / Enter the bank or mobile carrier.');
    if (!account) bad('Weka namba ya akaunti. / Enter the account number.');

    const at = new Date().toISOString();
    const row = {
      requested_at: at, updated_at: at,
      staff_code: user.code || null,
      staff_name: user.name || '',
      staff_role: user.role || '',
      apply_date: applyDate,
      amount,
      status: 'pending',
      bank_name: bank.slice(0, 120),
      account_no: account.slice(0, 60),
    };
    /* THE TWO RULES THAT ARE DECIDED AT THE ASK (Finance SOP G.4 and G.5).
       G.4 is a FLAG, never a refusal: a deadline that blocks the form leaves somebody with an
       emergency and nowhere to go, and the SOP gives the judgement to the approver. Measured
       against the applicant's OWN date, so a request for the 20th reads as late for ever.
       G.5's ceiling is frozen here from the salary as it stands today, so a raise next month
       cannot retroactively justify this approval. Both columns arrive with a hand-run
       migration, so a failed insert is retried without them rather than refusing the request:
       an office that cannot ask for an advance because a rule column is missing is worse off
       than one whose lateness is not yet being recorded. */
    const policy = await advPolicy(db);
    /* ONE A MONTH, AND THIS ONE *IS* A REFUSAL -- unlike G.4's deadline, which only flags.
       The difference is who the rule is for: a late request is a judgement the approver is
       entitled to make, and a second advance against one month's salary is a thing the office
       has decided does not happen. A decline erases the month, so the way out of a mistake is
       the one the owner already used. */
    const live = await advSameMonth(db, user.code, applyDate);
    if (live.length >= policy.maxPerMonth) {
      const other = live.sort((x, y) => String(x.apply_date || '').localeCompare(String(y.apply_date || '')))[0];
      const what = other
        ? ' (' + String(other.apply_date || '').slice(0, 10) + ', '
          + (other.status === 'approved' ? 'imekubaliwa / approved' : 'inasubiri / pending') + ')'
        : '';
      bad('Tayari una ombi la advance kwa mwezi huu' + what
        + '. Ombi moja kwa mwezi. Likikataliwa, unaweza kuomba tena. '
        + '/ You already have an advance request for this month' + what
        + '. One per month; if it is declined you may ask again.');
    }
    const salary = await salaryOf(db, user.code);
    row.late = Number(applyDate.slice(8, 10)) > policy.deadlineDay;
    row.salary_at_request = salary;
    row.cap_amount = salary == null ? null : Math.floor(salary * policy.maxPct / 100);
    let { error } = await db.from('staff_advances').insert([row]);
    if (error && /late|salary_at_request|cap_amount/i.test(String(error.message))) {
      // The rules migration has not been run yet. File the request anyway, unflagged.
      const bare = { ...row };
      delete bare.late; delete bare.salary_at_request; delete bare.cap_amount;
      ({ error } = await db.from('staff_advances').insert([bare]));
    }
    if (error) {
      if (tableMissing(error)) bad(ADV_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, amount, applyDate, late: !!row.late,
      salary: salary, cap: row.cap_amount == null ? null : num(row.cap_amount),
      deadlineDay: policy.deadlineDay, maxPct: policy.maxPct };
  },

  /** A requester's own history, and only their own: this pane grants the right to ASK, which
      is not the right to read what anybody else earns or owes. Keyed on the access code they
      signed in with rather than their name, because two people can share a name. */
  async advMine(db, user) {
    requireNav(user, 'advreq');
    const policy = await advPolicy(db);
    let rows;
    try {
      rows = (await advSelect(db, cols => db.from('staff_advances').select(cols)
        .eq('staff_code', user.code || '~none~'), ADV_COLS_RULES, ADV_COLS)).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, amounts: ADV_AMOUNTS,
        deadlineDay: policy.deadlineDay, maxPct: policy.maxPct };
    }
    /* THE DEADLINE AND THE CEILING TRAVEL WITH THE FORM (Finance SOP G.4, G.5), so the page can
       say what will happen before somebody presses the button rather than after. The salary
       itself never goes out: the person is told their ceiling, not what anybody earns. */
    const salary = await salaryOf(db, user.code);
    const out = rows.map(r => advRow(r, user.code)).sort((x, y) => (y.at || 0) - (x.at || 0));
    /* WHICH MONTHS ARE ALREADY SPOKEN FOR, so the form can say it before the button rather
       than after -- the same courtesy the G.4 deadline line already gets. Computed from the
       rows this pane is holding anyway, so it costs no extra read. A declined row is not on
       this list, because a decline frees the month. */
    const usedMonths = [...new Set(out.filter(r => r.status !== 'declined')
      .map(r => monthOf(r.applyDate)).filter(mm => mm.length === 7))];
    return { ok: true, amounts: ADV_AMOUNTS,
      deadlineDay: policy.deadlineDay, maxPct: policy.maxPct,
      maxPerMonth: policy.maxPerMonth, usedMonths,
      cap: salary == null ? null : Math.floor(salary * policy.maxPct / 100),
      rows: out };
  },

  /** THE APPROVER'S QUEUE. Pending first because that is the whole job; recently decided
      below it so somebody can see what they just did and catch a slip immediately. */
  async advQueue(db, user, args) {
    requireNav(user, 'advappr');
    const a = args || {};
    let rows;
    try {
      rows = (await advSelect(db, cols => db.from('staff_advances').select(cols),
        ADV_QUEUE_COLS_RULES, ADV_QUEUE_COLS)).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, amounts: ADV_AMOUNTS, pending: 0 };
    }
    /* THE WHOLE COMPANY. One approver decides every advance, so the queue is every request --
       the same shape as the imprest queue, for the same reason. The department filter that
       used to sit here went with the Kiongozi switch; see navsFor. */
    const all = rows.map(r => advRow(r, user.code));
    const want = String(a.state || '').trim();
    const shown = want === 'decided' ? all.filter(r => r.status !== 'pending')
      : want === 'pending' ? all.filter(r => r.status === 'pending') : all;
    return { ok: true, amounts: ADV_AMOUNTS,
      pending: all.filter(r => r.status === 'pending').length,
      // Pending first, then newest -- the queue is a worklist, not a diary.
      rows: shown.sort((x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1)
        || (y.at || 0) - (x.at || 0)) };
  },

  /** APPROVE (possibly for less) OR DECLINE, with a comment either way. */
  async advDecide(db, user, args) {
    requireNav(user, 'advappr');
    requireWrite(user);
    const a = args || {};
    /* CHECKED AS A UUID, not merely as non-empty. `id` goes straight into .eq('id', id) against
       a uuid column, and Postgres answers a malformed one with "invalid input syntax for type
       uuid" -- which tableMissing does not match, so it escapes as a 500 carrying a raw database
       message instead of the plain 400 the next two lines were written to give. */
    const id = String(a.id || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      bad('Ombi halijachaguliwa. / No request chosen.');
    }
    const approve = a.approve === true;
    const comment = String(a.comment || '').trim();
    /* A REFUSAL MUST SAY WHY. An approval need not -- the money is the answer -- but "no" with
       no reason is the thing the requester brings back to the office to argue about, and the
       owner asked for the comment precisely so that conversation happens once, in writing. */
    if (!approve && !comment) {
      bad('Andika sababu ya kukataa. / A comment is required when declining.');
    }

    let rows;
    try {
      rows = (await advSelect(db, cols => db.from('staff_advances').select(cols).eq('id', id), ADV_COLS_RULES, ADV_COLS)).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(ADV_NOT_READY);
    }
    const dev = rows.find(r => String(r.id) === id);
    if (!dev) bad('Ombi halipo. / That request no longer exists.');
    if (String(dev.status) !== 'pending') {
      bad('Ombi hili tayari limeamuliwa. / That request has already been decided.');
    }
    /* DECIDING YOUR OWN REQUEST IS ALLOWED, AND THAT IS DELIBERATE. Do not "fix" this.

         "role is navigation based so i didnt expect (This is your own request — another
          approver must decide it) if someone has both navs can do both"

       This shipped once with a self-approval refusal, and it was wrong for this system. The
       whole permission model here is that the NAVS ARE THE ROLES -- "i'll grant navs to who
       performs what" -- so ticking both advreq and advappr on somebody is the owner saying, in
       the only way this system has of saying it, that this person may ask AND may decide. A
       server-side refusal on top of that is the code overruling the grant it was given, and it
       silently made a tick the owner had deliberately made mean less than it says.

       The control lives where the owner put it: in who gets advappr at all. What the code owes
       them instead is a RECORD, and it keeps one -- decided_by is stamped on the row, so a
       self-decision shows on HR's report as the same person in both columns, and advDecide is
       in AUDITED so who granted what is in the audit log either way. Visible after the fact
       beats blocked in front of it, when the person doing it was authorised to do it. */

    const asked = Number(dev.amount) || 0;
    let granted = null;
    if (approve) {
      granted = a.approvedAmount == null || a.approvedAmount === '' ? asked : Number(a.approvedAmount);
      /* LESS THAN ASKED IS THE POINT ("give this 200k request just 100k"); MORE THAN ASKED is
         somebody mis-clicking a dropdown, and an approver quietly handing out more than was
         requested is not a decision anybody asked them to be able to make. */
      if (!ADV_AMOUNTS.includes(granted)) {
        bad('Chagua kiasi kutoka kwenye orodha. / Choose one of the listed amounts.');
      }
      if (granted > asked) {
        bad('Huwezi kuidhinisha zaidi ya kilichoombwa. / You cannot approve more than was requested.');
      }
      /* FINANCE SOP G.5: "The approved advance amount must not exceed 40% of the employee's
         monthly salary." A LOCK, not a flag -- "must not exceed" is not a suggestion, and this
         is the one place a number can be checked against it.

         The cap is the one FROZEN on the request when it was filed, not one recomputed now: a
         raise between the ask and the decision must not quietly widen what was allowed. Where
         no salary was on file the cap is null and the approval goes through -- the rule cannot
         be applied to a figure nobody has entered, and refusing every advance until HR fills in
         a salary table would stop the office rather than protect it. The report says which
         approvals went through uncapped, so that is a prompt and not a silent pass. */
      const cap = dev.cap_amount == null ? null : num(dev.cap_amount);
      if (cap != null && granted > cap) {
        const policy = await advPolicy(db);
        bad('Kiasi kinazidi asilimia ' + policy.maxPct + ' ya mshahara (SOP G.5): kikomo ni TZS '
          + money0(cap) + '. / That exceeds the ' + policy.maxPct + '% salary cap; the ceiling is TZS '
          + money0(cap) + '.');
      }
    }

    const at = new Date().toISOString();
    const patch = {
      status: approve ? 'approved' : 'declined',
      approved_amount: approve ? granted : null,
      comment: comment || null,
      decided_by: user.name || '',
      decided_at: at,
      updated_at: at,
    };
    /* Guarded on status so two approvers pressing at the same moment cannot both win: the
       second update matches no row, and that person is told it was already decided rather
       than silently overwriting the first decision. */
    const { data, error } = await db.from('staff_advances')
      .update(patch).eq('id', id).eq('status', 'pending').select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) {
      bad('Ombi hili limeamuliwa na mtu mwingine sasa hivi. / Somebody else just decided this one.');
    }
    return { ok: true, id, status: patch.status, granted };
  },

  /** HR'S PANE: the filing copy and the bank payment run, in the owner's column order. */
  async advReport(db, user, args) {
    requireNav(user, 'advrep');
    const a = args || {};
    let rows, hasRules = false;
    try {
      const got = await advSelect(db, cols => db.from('staff_advances').select(cols), ADV_COLS_RULES, ADV_COLS);
      rows = got.rows; hasRules = got.rules;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, totals: { approved: 0, count: 0 } };
    }
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(a.from || '')) ? String(a.from) : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(a.to || '')) ? String(a.to) : null;
    const want = String(a.status || '').trim();
    /* FILTERED ON THE APPLICATION DATE, not on when the row was created. HR files and pays
       against the period the advance is FOR, and those two dates can fall either side of a
       month end -- which is exactly the row that goes missing from a payment run otherwise. */
    /* THE PERIOD IS THE DATE RANGE. THE STATUS IS A LENS ON IT.
       Both filters used to be applied before the totals were counted, so the tiles moved every
       time somebody narrowed the view -- and since the tiles ARE the status control, ticking
       "Za kulipa" made the tile beside it report the approved count under the words "kwenye
       kipindi hiki" (in this period). The period had not changed; only what was on screen had.
       So the totals are counted over the DATE-filtered set and stay put, and only the table
       below responds to the status lens. */
    const inPeriod = rows.map(r => advRow(r, user.code))
      .filter(r => !from || (r.applyDate && r.applyDate >= from))
      .filter(r => !to || (r.applyDate && r.applyDate <= to));
    const out = inPeriod
      .filter(r => !['pending', 'approved', 'declined'].includes(want) || r.status === want)
      .sort((x, y) => (y.at || 0) - (x.at || 0));
    /* THE THREE SOP G RULES, AS NUMBERS HR CAN CHASE (G.4, G.5, G.6). Each one counts only
       what it can honestly count: `late` is null on rows filed before the rules shipped, and an
       approval with no salary on file is `uncapped` rather than quietly compliant. */
    const approvedRows = inPeriod.filter(r => r.status === 'approved');
    return { ok: true, rows: out, hasRules,
      totals: {
        count: inPeriod.length,
        // What the bank run actually comes to. Declined and pending rows contribute nothing,
        // which is the only reading of this number that is safe to hand a cashier.
        approved: inPeriod.reduce((s, r) => s + (r.status === 'approved' ? (r.approved || 0) : 0), 0),
        late: inPeriod.filter(r => r.late === true).length,
        uncapped: approvedRows.filter(r => r.capAmount == null).length,
        // G.6: approved, but the money has not gone out yet.
        toPay: approvedRows.filter(r => !r.paidAt).length,
        toPayAmount: approvedRows.filter(r => !r.paidAt).reduce((s, r) => s + (r.approved || 0), 0),
        // G.6 again: paid, and payroll has not taken it back.
        toDeduct: approvedRows.filter(r => r.paidAt && !r.deductedAt).length,
        toDeductAmount: approvedRows.filter(r => r.paidAt && !r.deductedAt).reduce((s, r) => s + (r.approved || 0), 0),
        deducted: approvedRows.filter(r => r.deductedAt).length,
      } };
  },

  /** THE MONEY GOING OUT (Finance SOP G.6, first half). Separate from the approval because
      they happen on different days and by different hands, and a report that cannot tell
      "approved" from "paid" can chase neither. */
  async advPay(db, user, args) {
    requireNav(user, 'advrep');
    requireWrite(user);
    const a = args || {};
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    const ref = String(a.paymentRef == null ? '' : a.paymentRef).trim().slice(0, 120);
    if (!ref) bad('Andika kumbukumbu ya malipo. / Give the payment reference.');
    let rows;
    try {
      rows = (await advSelect(db, cols => db.from('staff_advances').select(cols).eq('id', id),
        ADV_COLS_RULES, ADV_COLS)).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(ADV_NOT_READY);
    }
    const r = rows.find(x => String(x.id) === id);
    if (!r) bad('Ombi halipo. / That request no longer exists.');
    if (String(r.status) !== 'approved') bad('Ombi hili halijaidhinishwa. / That request is not approved.');
    if (r.paid_at) bad('Advance hii tayari imelipwa. / That advance has already been paid.');
    const at = new Date().toISOString();
    const { data, error } = await db.from('staff_advances')
      .update({ paid_at: at, paid_by: user.name || '', payment_ref: ref, updated_at: at })
      .eq('id', id).eq('status', 'approved').is('paid_at', null).select('id');
    if (error) {
      if (/paid_at|payment_ref/i.test(String(error.message))) bad(ADV_RULES_NOT_READY);
      throw new Error(error.message);
    }
    if (!data || !data.length) bad('Advance hii imelipwa na mtu mwingine sasa hivi. / Somebody else just paid this one.');
    return { ok: true, id, paidAt: Date.parse(at), paymentRef: ref };
  },

  /** PAYROLL TAKING IT BACK (Finance SOP G.6, second half): "records it for deduction against
      the employee's next payroll". The month it came off is the fact worth keeping. */
  async advDeduct(db, user, args) {
    requireNav(user, 'advrep');
    requireWrite(user);
    const a = args || {};
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    const period = isMonth(a.period) ? String(a.period) : '';
    if (!period) bad('Chagua mwezi wa mshahara (YYYY-MM). / Choose the payroll month.');
    let rows;
    try {
      rows = (await advSelect(db, cols => db.from('staff_advances').select(cols).eq('id', id),
        ADV_COLS_RULES, ADV_COLS)).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(ADV_NOT_READY);
    }
    const r = rows.find(x => String(x.id) === id);
    if (!r) bad('Ombi halipo. / That request no longer exists.');
    if (!r.paid_at) bad('Haiwezi kukatwa kabla haijalipwa. / It cannot be deducted before it has been paid.');
    if (r.deducted_at) bad('Advance hii tayari imekatwa kwenye mshahara. / That advance has already been deducted.');
    const at = new Date().toISOString();
    const { data, error } = await db.from('staff_advances')
      .update({ deducted_at: at, deducted_by: user.name || '', deduct_period: period, updated_at: at })
      .eq('id', id).is('deducted_at', null).select('id');
    if (error) {
      if (/deducted_at|deduct_period/i.test(String(error.message))) bad(ADV_RULES_NOT_READY);
      throw new Error(error.message);
    }
    if (!data || !data.length) bad('Advance hii imekatwa na mtu mwingine sasa hivi. / Somebody else just deducted this one.');
    return { ok: true, id, deductPeriod: period, deductedAt: Date.parse(at) };
  },

  /** WHAT PEOPLE EARN, for the one rule that needs it (SOP G.5). Its own pane behind the staff
      nav, so holding any other pane never means seeing what a colleague is paid. */
  async salaryList(db, user) {
    requireNav(user, 'staff');
    const policy = await advPolicy(db);
    let rows = [];
    let notReady = false;
    try {
      rows = await fetchAll(() => db.from('staff_salaries')
        .select('staff_code, staff_name, monthly_salary, updated_by, updated_at'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      notReady = true;
    }
    return { ok: true, notReady, maxPct: policy.maxPct, deadlineDay: policy.deadlineDay,
      /* THE ACCESS CODE IS THE KEY AND NEVER THE ANSWER. It is the credential somebody signs in
         with, so the list is keyed by it on the way in and identified by NAME on the way out. */
      rows: rows.map(r => ({ code: String(r.staff_code || ''), name: r.staff_name || '',
        salary: num(r.monthly_salary), cap: Math.floor(num(r.monthly_salary) * policy.maxPct / 100),
        updatedBy: r.updated_by || '', updatedAt: r.updated_at ? Date.parse(r.updated_at) : null }))
        .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)) };
  },

  async salarySave(db, user, args) {
    requireNav(user, 'staff');
    requireWrite(user);
    const a = args || {};
    const code = String(a.code == null ? '' : a.code).trim();
    if (!code) bad('Chagua msimbo wa mfanyakazi. / Choose the staff access code.');
    if (a.salary == null || String(a.salary).trim() === '') bad('Weka mshahara wa mwezi. / Enter the monthly salary.');
    const salary = Math.round(num(a.salary));
    if (!(salary >= 0) || salary > 1e9) bad('Mshahara si sahihi. / That is not a salary.');
    const { error } = await db.from('staff_salaries').upsert([{ staff_code: code,
      staff_name: String(a.name == null ? '' : a.name).trim().slice(0, 120) || null,
      monthly_salary: salary, updated_by: user.name || '', updated_at: new Date().toISOString() }],
      { onConflict: 'staff_code' });
    if (error) {
      if (tableMissing(error)) bad(ADV_RULES_NOT_READY);
      throw new Error(error.message);
    }
    const policy = await advPolicy(db);
    return { ok: true, code, salary, cap: Math.floor(salary * policy.maxPct / 100) };
  },

  async salaryDelete(db, user, args) {
    requireNav(user, 'staff');
    requireWrite(user);
    const code = String((args && args.code) || '').trim();
    if (!code) bad('Chagua msimbo wa mfanyakazi. / Choose the staff access code.');
    const { error } = await db.from('staff_salaries').delete().eq('staff_code', code);
    if (error) {
      if (tableMissing(error)) bad(ADV_RULES_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, code };
  },

  /* =====================================================================================
     IMPREST -- ask, decide, retire, review.
     =====================================================================================
       "they need to make imprest requests that will be approved by their admnistrator and a
        copy stays for the gm review ... request tab, approval tab and imprest reports tab"

     Five functions over one request table, gated by three navs and nothing else. NOBODY'S
     ROLE IS EVER NAMED HERE: the owner ticks impreq on whoever may ask, impappr on whoever
     decides (the "administrator"), imprep on whoever reviews (the CEO). The approver sees EVERY
     request -- an administrator is an administrator for the company, not for a department --
     so there is no leader switch and no role scoping; the advance works the same way now.

     WHO ASKED comes off the signed-in code and is stamped on the row. WHAT IT COSTS is computed
     here from the parts the form sent, never taken as a total: fare = trips x per-trip,
     accommodation = nights x THE ROLE'S RATE from imprest_roles (the figure the form shows for
     that line is a preview, and ignored), others as given. The rate in force is stamped too. */

  /** The rate table, readable by anyone holding any of the three panes: the requester's form
      needs it to offer roles and preview the nightly rate; the other two panes show it. */
  async impRoles(db, user) {
    requireAnyNav(user, ['impreq', 'impappr', 'imprep']);
    let rows;
    try {
      rows = await fetchAll(() => db.from('imprest_roles').select('role, accommodation_per_day, updated_by, updated_at'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, roles: [], notReady: true };
    }
    return { ok: true, roles: rows.map(r => ({ role: K(r.role), rate: num(r.accommodation_per_day),
      by: r.updated_by || '', at: r.updated_at ? Date.parse(r.updated_at) : null }))
      .sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : 0) };
  },

  /** "administrator can add roles and their accommodation per day". Held by the approval nav,
      because the person who decides the money is the person who owns the nightly figure. */
  async impRoleSave(db, user, args) {
    requireNav(user, 'impappr');
    requireWrite(user);
    const a = args || {};
    const role = K(a.role).slice(0, 60);
    if (!role) bad('Andika jina la wadhifa. / Enter a role name.');
    // Blank is not zero: a forgotten box must not become a role that sleeps for free.
    if (a.rate === '' || a.rate == null) bad('Andika kiwango cha malazi kwa siku (0 inaruhusiwa). / Enter the nightly rate (0 is allowed).');
    const rate = intNN(a.rate);
    if (rate === null) bad('Kiwango cha malazi lazima kiwe namba nzima. / The nightly rate must be a whole number.');
    const { error } = await db.from('imprest_roles')
      .upsert({ role, accommodation_per_day: rate, updated_at: new Date().toISOString(),
        updated_by: user.name || '' }, { onConflict: 'role' });
    if (error) {
      if (tableMissing(error)) bad(IMP_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, role, rate };
  },

  async impRoleDelete(db, user, args) {
    requireNav(user, 'impappr');
    requireWrite(user);
    const role = K(args && args.role);
    if (!role) bad('Chagua wadhifa. / Choose a role.');
    const { error } = await db.from('imprest_roles').delete().eq('role', role);
    if (error) {
      if (tableMissing(error)) bad(IMP_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, role };
  },

  async impRequest(db, user, args) {
    requireNav(user, 'impreq');
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const fullName = S(a.fullName, 120);
    if (!fullName) bad('Andika jina kamili. / Enter your full name.');
    const email = S(a.email, 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Andika barua pepe sahihi. / Enter a valid email.');
    const imprestRole = K(a.imprestRole).slice(0, 60);
    if (!imprestRole) bad('Chagua wadhifa. / Choose a role.');
    const travelDate = S(a.travelDate, 10);
    if (!isDay(travelDate)) bad('Weka tarehe ya safari. / Pick a travel date.');
    const purpose = S(a.purpose, 2000);
    if (!purpose) bad('Andika madhumuni ya safari. / Describe the purpose of the trip.');

    /* THE RATE IS LOOKED UP, NOT TRUSTED. A form can send any number in the rate box; the
       server multiplies by the table's figure for the chosen role and stamps that figure. */
    let rateRows;
    try {
      rateRows = await fetchAll(() => db.from('imprest_roles').select('role, accommodation_per_day').eq('role', imprestRole));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(IMP_NOT_READY);
    }
    const rateRow = rateRows.find(r => K(r.role) === imprestRole);
    if (!rateRow) bad('Wadhifa huo hauna kiwango bado — mwidhinishaji aweke kwanza. / That role has no rate yet; ask the approver to add it.');
    const accomRate = num(rateRow.accommodation_per_day);

    const fareTrips = intNN(a.fareTrips), farePerTrip = intNN(a.farePerTrip), accomDays = intNN(a.accomDays);
    if (fareTrips === null || farePerTrip === null || accomDays === null) {
      bad('Idadi na gharama lazima ziwe namba nzima. / Trips, fares and nights must be whole numbers.');
    }
    const others = [1, 2, 3].map(i => {
      const desc = S(a['other' + i + 'Desc'], 120);
      const amt = intNN(a['other' + i + 'Amount']);
      if (amt === null) bad('Gharama nyingine lazima ziwe namba nzima. / Other amounts must be whole numbers.');
      // A figure with no name is a figure nobody can retire against.
      if (amt > 0 && !desc) bad('Eleza gharama nyingine ' + i + '. / Describe other expense ' + i + '.');
      return { desc, amt };
    });
    if (accomDays > 0 && accomRate === 0) {
      bad('Wadhifa huu una kiwango cha malazi 0 — mwidhinishaji aweke kiwango kwanza. / This role\'s nightly rate is 0; ask the approver to set it before claiming nights.');
    }
    const fareAmount = fareTrips * farePerTrip;
    const accomAmount = accomDays * accomRate;
    const total = fareAmount + accomAmount + others.reduce((s, o) => s + o.amt, 0);
    if (total <= 0) bad('Ombi halina gharama yoyote. / The request has no costs on it.');
    // The parts each fit; their products and sum must too, or the insert fails in Postgres's words.
    if ([fareAmount, accomAmount, total].some(v => v > MONEY_MAX)) {
      bad('Kiasi ni kikubwa kupita kiasi — angalia namba. / The amount is implausibly large; check the figures.');
    }

    const at = new Date().toISOString();
    const row = {
      requested_at: at, updated_at: at,
      staff_code: user.code || null, staff_name: user.name || '', staff_role: user.role || '',
      full_name: fullName, mobile: S(a.mobile, 40), recipient_name: S(a.recipientName, 120) || fullName,
      email, imprest_role: imprestRole, pay_mode: S(a.payMode, 40), account_no: S(a.accountNo, 80),
      travel_date: travelDate, destination: S(a.destination, 120),
      fare_trips: fareTrips, fare_per_trip: farePerTrip, fare_amount: fareAmount,
      accom_days: accomDays, accom_rate: accomRate, accom_amount: accomAmount,
      other1_desc: others[0].desc || null, other1_amount: others[0].amt,
      other2_desc: others[1].desc || null, other2_amount: others[1].amt,
      other3_desc: others[2].desc || null, other3_amount: others[2].amt,
      total_amount: total, purpose, status: 'pending',
    };
    const { error } = await db.from('imprest_requests').insert([row]);
    if (error) {
      if (tableMissing(error)) bad(IMP_NOT_READY);
      throw new Error(error.message);
    }
    /* THE NUDGE TO THE ADMINISTRATOR. Best effort and after the row exists -- a request is
       never lost to a mail provider. The pane says whether the nudge went. */
    const mail = await sendMail(db, { toKey: 'IMPREST_ADMIN_EMAIL',
      subject: 'HOOPLOAN — ombi la imprest / imprest request: ' + fullName + ' · ' + money0(total) + ' TZS',
      html: noticeHtml('Ombi jipya la imprest / New imprest request', [
        ['Jina / Name', fullName], ['Wadhifa / Role', imprestRole], ['Safari / Travel', travelDate],
        ['Mahali / Destination', row.destination || '—'], ['Jumla / Total', total],
        ['Madhumuni / Purpose', purpose.slice(0, 300)],
      ], 'Fungua Idhini ya imprest kuamua. / Open the imprest approval pane to decide.') });
    return { ok: true, total, accomRate, emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
  },

  /** A requester's own history, and only their own -- with the rate table so the form can
      offer roles without a second trip. */
  async impMine(db, user) {
    requireNav(user, 'impreq');
    let rows;
    try {
      rows = await fetchAll(() => db.from('imprest_requests').select(IMP_COLS)
        .eq('staff_code', user.code || '~none~'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], roles: [], notReady: true };
    }
    const roles = await FNS.impRoles(db, user);
    return { ok: true, roles: roles.roles || [],
      rows: rows.map(r => impRow(r, user.code)).sort((x, y) => (y.at || 0) - (x.at || 0)) };
  },

  /** THE ADMINISTRATOR'S QUEUE. Every request, pending first; the widgets above it are counts
      over the whole table so the numbers do not move when the list is narrowed. */
  async impQueue(db, user, args) {
    requireNav(user, 'impappr');
    const a = args || {};
    let rows;
    try {
      rows = await fetchAll(() => db.from('imprest_requests').select(IMP_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, counts: { pending: 0, approved: 0, rejected: 0, toRetire: 0 } };
    }
    const all = rows.map(r => impRow(r, user.code));
    const want = String(a.state || '').trim();
    const shown = want === 'pending' ? all.filter(r => r.status === 'pending')
      : want === 'decided' ? all.filter(r => r.status !== 'pending')
      : want === 'toRetire' ? all.filter(r => r.status === 'approved' && !r.retiredAt) : all;
    return { ok: true,
      counts: {
        pending: all.filter(r => r.status === 'pending').length,
        approved: all.filter(r => r.status === 'approved').length,
        rejected: all.filter(r => r.status === 'rejected').length,
        // Money out the door with no receipts back yet -- the number an administrator chases.
        toRetire: all.filter(r => r.status === 'approved' && !r.retiredAt).length,
      },
      rows: shown.sort(pendingFirst) };
  },

  /** APPROVE (possibly for less) OR REJECT, with a comment either way; a rejection must say why.
      Deciding your own request is allowed, and recorded, for the reason advDecide gives. */
  async impDecide(db, user, args) {
    requireNav(user, 'impappr');
    requireWrite(user);
    const a = args || {};
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    const approve = a.approve === true;
    const comment = String(a.comment || '').trim().slice(0, 1000);
    if (!approve && !comment) bad('Andika sababu ya kukataa. / A comment is required when rejecting.');
    let rows;
    try {
      rows = await fetchAll(() => db.from('imprest_requests').select(IMP_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(IMP_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    if (!row) bad('Ombi halipo. / That request no longer exists.');
    if (String(row.status) !== 'pending') bad('Ombi hili tayari limeamuliwa. / That request has already been decided.');
    const asked = num(row.total_amount);
    let granted = null;
    if (approve) {
      granted = a.approvedAmount == null ? asked : intNN(a.approvedAmount);
      if (granted === null || granted <= 0) bad('Kiasi cha kuidhinisha lazima kiwe namba nzima. / The approved amount must be a whole number.');
      // LESS THAN ASKED IS THE POINT; more than asked is not a decision anybody delegated.
      if (granted > asked) bad('Huwezi kuidhinisha zaidi ya kilichoombwa. / You cannot approve more than was requested.');
    }
    const at = new Date().toISOString();
    const patch = { status: approve ? 'approved' : 'rejected', approved_amount: approve ? granted : null,
      comment: comment || null, decided_by: user.name || '', decided_at: at, updated_at: at };
    // Guarded on status so two approvers pressing at once cannot both win.
    const { data, error } = await db.from('imprest_requests')
      .update(patch).eq('id', id).eq('status', 'pending').select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Ombi hili limeamuliwa na mtu mwingine sasa hivi. / Somebody else just decided this one.');

    /* THE COPIES. The CEO's inbox copy on approval -- "a copy stays for the gm review" -- and the
       requester told either way, at the address they wrote on the form. Both best effort. */
    const facts = [['Jina / Name', row.full_name || row.staff_name], ['Wadhifa / Role', row.imprest_role || ''],
      ['Safari / Travel', String(row.travel_date || '').slice(0, 10)], ['Mahali / Destination', row.destination || '—'],
      ['Kiliombwa / Requested', asked], ['Uamuzi / Decision', approve ? 'APPROVED · ' + money0(granted) + ' TZS' : 'REJECTED'],
      ['Maoni / Comment', comment || '—'], ['Aliyeamua / Decided by', user.name || '']];
    const ceo = approve ? await sendMail(db, { toKey: 'IMPREST_CEO_EMAIL',
      subject: 'HOOPLOAN — imprest imeidhinishwa / approved: ' + (row.full_name || row.staff_name) + ' · ' + money0(granted) + ' TZS',
      html: noticeHtml('Nakala ya CEO / CEO copy — imprest approved', facts,
        'Nakala hii ni ya kumbukumbu; fungua Ripoti ya imprest kuona kila kitu. / Filed for review; the imprest report pane has the full record.') })
      : { sent: false, reason: 'rejected: CEO not copied' };
    const requester = await sendMail(db, { to: row.email,
      subject: 'HOOPLOAN — ombi lako la imprest / your imprest request: ' + (approve ? 'imeidhinishwa / approved' : 'imekataliwa / rejected'),
      html: noticeHtml('Ombi lako la imprest / Your imprest request', facts,
        approve ? 'Ukifika, jaza retirement na picha 3 za risiti. / On arrival, file the retirement with 3 receipt photos.'
                : 'Wasiliana na mwidhinishaji ukihitaji maelezo. / Speak to the approver if you need more.') });
    return { ok: true, id, status: patch.status, granted,
      emailed: { ceo: ceo.sent, requester: requester.sent },
      emailNote: [ceo.sent ? "" : "CEO: " + ceo.reason, requester.sent ? '' : 'mwombaji / requester: ' + requester.reason].filter(Boolean).join(' · ') };
  },

  /** THE RETIREMENT. "when someone gets where he was destinated for their tasks they fill
      retirement with 3 pictures ... to keep reference of actual incurred costs". Own request,
      approved, not yet retired; once, ever. The photos are checked for size here regardless of
      what the phone did, and stored in their own table -- see the migration. */
  async impRetire(db, user, args) {
    requireNav(user, 'impreq');
    requireWrite(user);
    const a = args || {};
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    let rows;
    try {
      rows = await fetchAll(() => db.from('imprest_requests').select(IMP_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(IMP_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    /* NOT YOURS reads the same as NOT THERE, on purpose: the right to ask is not the right to
       learn which requests exist. */
    if (!row || String(row.staff_code || '') !== String(user.code || '')) bad('Ombi halipo. / That request no longer exists.');
    if (String(row.status) !== 'approved') bad('Retirement ni ya ombi lililoidhinishwa tu. / Only an approved request can be retired.');
    /* FINISHED is retire_total set -- see the write order below. A claim with no summary is a
       filing that died, or one that is going on right now; both are handled at the claim. */
    if (row.retire_total != null) bad('Ombi hili tayari lina retirement. / This request has already been retired.');

    const fare = intNN(a.fareActual), accom = intNN(a.accomActual);
    const o1 = intNN(a.other1Actual), o2 = intNN(a.other2Actual), o3 = intNN(a.other3Actual);
    if ([fare, accom, o1, o2, o3].some(v => v === null)) {
      bad('Gharama halisi lazima ziwe namba nzima. / Actual costs must be whole numbers.');
    }
    const photos = Array.isArray(a.photos) ? a.photos.filter(p => String(p || '').trim()) : [];
    if (!photos.length) bad('Weka angalau picha moja ya risiti (bora 3). / Attach at least one receipt photo (ideally 3).');
    if (photos.length > IMP_PHOTO_MAX) bad('Picha ni 3 zaidi. / At most 3 photos.');
    const sized = photos.map(p => ({ data: String(p), bytes: photoBytes(p) }));
    if (sized.some(p => p.bytes === null)) bad('Picha moja si picha halali (JPEG/PNG). / One photo is not a valid image.');
    if (sized.some(p => p.bytes > IMP_PHOTO_MAX_BYTES)) {
      bad('Picha moja ni kubwa mno (zaidi ya ' + Math.round(IMP_PHOTO_MAX_BYTES / 1024) + 'KB). Ipunguze kisha jaribu tena. '
        + '/ One photo is too large; shrink it and try again.');
    }
    if (sized.some(p => p.bytes < IMP_PHOTO_MIN_BYTES)) bad('Picha moja ni ndogo mno kuwa risiti. / One photo is too small to be a receipt.');
    const total = fare + accom + o1 + o2 + o3;
    if (total > MONEY_MAX) bad('Kiasi ni kikubwa kupita kiasi — angalia namba. / The amount is implausibly large; check the figures.');
    const approved = num(row.approved_amount);
    const balance = approved - total;
    const at = new Date().toISOString();

    /* ORDER OF WRITES -- THE REQUEST IS THE LOCK, AND IT IS TAKEN FIRST.
         1. CLAIM: stamp retired_at on the request, guarded on it being null. Of two overlapping
            presses exactly one matches the row; the other matches nothing and is told so.
            retire_total stays null, which is what "claimed, not finished" means everywhere.
         2. The retirement row, then the photos.
         3. FINISH: stamp retire_total and the balance, guarded on OUR claim stamp.
       A press that died between 1 and 3 leaves a claim with no summary. It is resumable ONLY
       once the claim is older than any serverless function can live (RETIRE_CLAIM_MS): the same
       requester re-claims -- guarded on the stale stamp, so two resumers cannot both win --
       clears the wreckage under it, and writes again. A young claim is "being filed, try again
       in a minute", never wreckage, and a finished retirement is refused before any of this. */
    const busy = () => bad('Retirement ya ombi hili inaendelea kuwasilishwa — jaribu tena baada ya dakika moja. '
      + '/ This retirement is being filed right now; try again in a minute.');
    let claim = await db.from('imprest_requests')
      .update({ retired_at: at, updated_at: at })
      .eq('id', id).eq('status', 'approved').is('retired_at', null).select('id');
    if (claim.error) throw new Error(claim.error.message);
    if (!claim.data || !claim.data.length) {
      const dead = row.retired_at && (Date.now() - Date.parse(row.retired_at)) > RETIRE_CLAIM_MS;
      if (!dead) busy();
      claim = await db.from('imprest_requests')
        .update({ retired_at: at, updated_at: at })
        .eq('id', id).eq('retired_at', row.retired_at).is('retire_total', null).select('id');
      if (claim.error) throw new Error(claim.error.message);
      if (!claim.data || !claim.data.length) busy();
      for (const t of ['imprest_photos', 'imprest_retirements']) {
        const { error } = await db.from(t).delete().eq('request_id', id);
        if (error) throw new Error(error.message);
      }
    }
    const dup = err => /duplicate|unique|23505/i.test(String((err && (err.message || err.code)) || ''));
    const { error: rErr } = await db.from('imprest_retirements').insert([{
      request_id: id, filed_at: at, filed_by_code: user.code || null, filed_by_name: user.name || '',
      fare_actual: fare, accom_actual: accom, other1_actual: o1, other2_actual: o2, other3_actual: o3,
      total_actual: total, notes: String(a.notes || '').trim().slice(0, 1000) || null, photo_count: sized.length }]);
    if (rErr) {
      if (tableMissing(rErr)) bad(IMP_NOT_READY);
      if (dup(rErr)) busy();
      throw new Error(rErr.message);
    }
    const { error: pErr } = await db.from('imprest_photos').insert(
      sized.map((p, i) => ({ request_id: id, seq: i + 1, data: p.data, bytes: p.bytes })));
    if (pErr) {
      if (dup(pErr)) busy();
      throw new Error(pErr.message);
    }
    const { data: done, error: uErr } = await db.from('imprest_requests')
      .update({ retire_total: total, retire_balance: balance, updated_at: at })
      .eq('id', id).eq('retired_at', at).select('id');
    if (uErr) throw new Error(uErr.message);
    // Cannot happen inside RETIRE_CLAIM_MS; kept so a stale re-claim can never finish over a live one.
    if (!done || !done.length) busy();
    return { ok: true, id, total, approved, balance, photos: sized.length };
  },

  /** The receipts for ONE request, on demand. A requester sees only their own; an approver or
      reviewer sees any. */
  async impPhotos(db, user, args) {
    requireAnyNav(user, ['impreq', 'impappr', 'imprep']);
    const id = String((args && args.id) || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    const navs = navsFor(user);
    const reviewer = navs.includes('impappr') || navs.includes('imprep');
    if (!reviewer) {
      let own;
      try {
        own = await fetchAll(() => db.from('imprest_requests').select('id, staff_code').eq('id', id));
      } catch (e) {
        if (!tableMissing(e)) throw e;
        return { ok: true, photos: [], notReady: true };
      }
      const r = own.find(x => String(x.id) === id);
      if (!r || String(r.staff_code || '') !== String(user.code || '')) bad('Ombi halipo. / That request no longer exists.');
    }
    let rows;
    try {
      rows = await fetchAll(() => db.from('imprest_photos').select('seq, data, bytes').eq('request_id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, photos: [] };
    }
    return { ok: true, photos: rows.map(p => ({ seq: num(p.seq), data: p.data, bytes: num(p.bytes) }))
      .sort((x, y) => x.seq - y.seq) };
  },

  /** THE CEO'S REVIEW COPY: every request in a period, with its retirement beside it, and the
      widgets -- what is waiting, what was paid, what is out with no receipts back, and the net
      balance the company is owed or owes. Filtered on TRAVEL DATE, like the advance is filtered
      on its application date: a review reads by the trip, not by the click. */
  async impReport(db, user, args) {
    requireNav(user, 'imprep');
    const a = args || {};
    let rows, rets;
    try {
      [rows, rets] = await Promise.all([
        fetchAll(() => db.from('imprest_requests').select(IMP_COLS)),
        fetchAll(() => db.from('imprest_retirements').select(IMP_RET_COLS)),
      ]);
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, totals: {} };
    }
    const from = isDay(a.from) ? String(a.from) : null;
    const to = isDay(a.to) ? String(a.to) : null;
    const want = String(a.status || '').trim();
    const retBy = new Map(rets.map(r => [String(r.request_id), r]));
    const inPeriod = rows.map(r => impRow(r, user.code))
      .filter(r => !from || (r.travelDate && r.travelDate >= from))
      .filter(r => !to || (r.travelDate && r.travelDate <= to))
      .map(r => {
        // Only a FINISHED retirement is shown beside its trip -- retiredAt, see impRow.
        const t = r.retiredAt ? retBy.get(r.id) : null;
        return Object.assign(r, { retirement: t ? {
          at: t.filed_at ? Date.parse(t.filed_at) : null, by: t.filed_by_name || '',
          fare: num(t.fare_actual), accom: num(t.accom_actual),
          other1: num(t.other1_actual), other2: num(t.other2_actual), other3: num(t.other3_actual),
          total: num(t.total_actual), notes: t.notes || '', photos: num(t.photo_count) } : null });
      });
    const shown = inPeriod.filter(r => {
      if (want === 'retired') return !!r.retiredAt;
      if (want === 'toRetire') return r.status === 'approved' && !r.retiredAt;
      return !['pending', 'approved', 'rejected'].includes(want) || r.status === want;
    }).sort((x, y) => (y.at || 0) - (x.at || 0));
    const approvedRows = inPeriod.filter(r => r.status === 'approved');
    return { ok: true, rows: shown,
      totals: {
        count: inPeriod.length,
        pending: inPeriod.filter(r => r.status === 'pending').length,
        rejected: inPeriod.filter(r => r.status === 'rejected').length,
        approved: approvedRows.length,
        // What the cashier paid out: approved rows only.
        approvedAmount: approvedRows.reduce((s, r) => s + (r.approved || 0), 0),
        retired: approvedRows.filter(r => r.retiredAt).length,
        toRetire: approvedRows.filter(r => !r.retiredAt).length,
        spent: approvedRows.reduce((s, r) => s + (r.retiredAt ? (r.retireTotal || 0) : 0), 0),
        // Positive balances: travellers who owe the company change back.
        toRefund: approvedRows.reduce((s, r) => s + (r.retireBalance != null && r.retireBalance > 0 ? r.retireBalance : 0), 0),
        // Negative balances: trips that cost more than was advanced; the company owes.
        toReimburse: approvedRows.reduce((s, r) => s + (r.retireBalance != null && r.retireBalance < 0 ? -r.retireBalance : 0), 0),
      } };
  },

  /* =====================================================================================
     LEAVE -- the HR form, then HR's decision.
     =====================================================================================
       "they want to be asking for leaves in app (another nav), and hr approves or rejects
        there (another one), hr gave me a sample"

     Field for field from HOOP COMPANY LIMITED's Leave Request Form. The server counts the
     working days (Monday-Friday) and the resumption date rather than trusting typed figures,
     and marks -- never refuses -- a non-emergency request filed under a week ahead, because
     the form's own words make that HR's call, not the system's. */
  async leaveRequest(db, user, args) {
    requireNav(user, 'leavereq');
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const type = String(a.type || '').trim().toLowerCase();
    if (!LEAVE_TYPES.includes(type)) bad('Chagua aina ya likizo. / Choose a leave type.');
    const otherType = S(a.otherType, 120);
    if (type === 'other' && !otherType) bad('Eleza aina ya likizo. / Say what kind of leave "Other" is.');
    const from = S(a.from, 10), to = S(a.to, 10);
    if (!isDay(from)) bad('Weka tarehe ya kuanza likizo. / Pick the leave start date.');
    if (!isDay(to)) bad('Weka tarehe ya kumaliza likizo. / Pick the leave end date.');
    if (to < from) bad('Tarehe ya kumaliza haiwezi kutangulia ya kuanza. / The end date cannot be before the start.');
    if (addDaysKey(from, LEAVE_MAX_DAYS) < to) bad('Likizo haiwezi kuzidi mwaka mmoja. / A leave cannot run longer than a year.');
    const reason = S(a.reason, 2000);
    if (!reason) bad('Andika sababu. / Give a reason.');
    /* THE DECLARATION IS THE SIGNATURE. The paper form carries "I confirm ... I have arranged
       for my duties to be covered"; here it is a tick, and it is required, not decorative. */
    if (a.declared !== true) bad('Thibitisha tamko. / You must confirm the declaration.');
    const workingDays = workingDaysBetween(from, to);
    const resume = resumeDayAfter(to);
    const today = todayKey();
    const shortNotice = !LEAVE_NO_NOTICE_TYPES.includes(type) && from < addDaysKey(today, 7);
    const at = new Date().toISOString();
    const row = {
      requested_at: at, updated_at: at,
      staff_code: user.code || null, staff_name: user.name || '', staff_role: user.role || '',
      employee_id: S(a.employeeId, 40) || null, department: S(a.department, 120) || null,
      supervisor: S(a.supervisor, 120) || null,
      leave_type: type, other_type: type === 'other' ? otherType : null,
      from_date: from, to_date: to, working_days: workingDays, resume_date: resume,
      reason, contact: S(a.contact, 40) || null, handed_to: S(a.handedTo, 120) || null,
      declared: true, short_notice: shortNotice, status: 'pending',
    };
    const { error } = await db.from('leave_requests').insert([row]);
    if (error) {
      if (tableMissing(error)) bad(LEAVE_NOT_READY);
      throw new Error(error.message);
    }
    const mail = await sendMail(db, { toKey: 'HR_EMAIL',
      subject: 'HOOPLOAN — ombi la likizo / leave request: ' + (user.name || '') + ' · ' + from + ' → ' + to,
      html: noticeHtml('Ombi jipya la likizo / New leave request', [
        ['Jina / Name', user.name || ''], ['Idara / Department', row.department || '—'],
        ['Aina / Type', type + (otherType ? ' (' + otherType + ')' : '')],
        ['Kuanzia / From', from], ['Hadi / To', to], ['Siku za kazi / Working days', String(workingDays)],
        ['Kurudi / Resumes', resume], ['Taarifa fupi / Short notice', shortNotice ? 'NDIYO / YES' : 'hapana / no'],
        ['Sababu / Reason', reason.slice(0, 300)],
      ], 'Fungua Idhini ya likizo kuamua. / Open the leave approval pane to decide.') });
    return { ok: true, workingDays, resume, shortNotice, emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
  },

  async leaveMine(db, user) {
    requireNav(user, 'leavereq');
    let rows;
    try {
      rows = await fetchAll(() => db.from('leave_requests').select(LEAVE_COLS).eq('staff_code', user.code || '~none~'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true };
    }
    return { ok: true, rows: rows.map(r => leaveRow(r, user.code)).sort((x, y) => (y.at || 0) - (x.at || 0)) };
  },

  /** HR'S DESK. Everybody's requests, pending first, with counts over the whole table. */
  async leaveQueue(db, user, args) {
    requireNav(user, 'leaveappr');
    const a = args || {};
    let rows;
    try {
      rows = await fetchAll(() => db.from('leave_requests').select(LEAVE_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, counts: { pending: 0, approved: 0, rejected: 0, shortNotice: 0, onLeaveToday: 0 } };
    }
    const all = rows.map(r => leaveRow(r, user.code));
    const today = todayKey();
    const want = String(a.state || '').trim();
    const shown = want === 'pending' ? all.filter(r => r.status === 'pending')
      : want === 'decided' ? all.filter(r => r.status !== 'pending')
      : want === 'today' ? all.filter(r => r.status === 'approved' && r.from <= today && r.to >= today) : all;
    return { ok: true,
      counts: {
        pending: all.filter(r => r.status === 'pending').length,
        approved: all.filter(r => r.status === 'approved').length,
        rejected: all.filter(r => r.status === 'rejected').length,
        shortNotice: all.filter(r => r.status === 'pending' && r.shortNotice).length,
        onLeaveToday: all.filter(r => r.status === 'approved' && r.from <= today && r.to >= today).length,
      },
      rows: shown.sort(pendingFirst) };
  },

  async leaveDecide(db, user, args) {
    requireNav(user, 'leaveappr');
    requireWrite(user);
    const a = args || {};
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    const approve = a.approve === true;
    const comment = String(a.comment || '').trim().slice(0, 1000);
    if (!approve && !comment) bad('Andika sababu ya kukataa. / A comment is required when rejecting.');
    let rows;
    try {
      rows = await fetchAll(() => db.from('leave_requests').select(LEAVE_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(LEAVE_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    if (!row) bad('Ombi halipo. / That request no longer exists.');
    if (String(row.status) !== 'pending') bad('Ombi hili tayari limeamuliwa. / That request has already been decided.');
    const at = new Date().toISOString();
    const patch = { status: approve ? 'approved' : 'rejected', comment: comment || null,
      decided_by: user.name || '', decided_at: at, updated_at: at };
    const { data, error } = await db.from('leave_requests')
      .update(patch).eq('id', id).eq('status', 'pending').select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Ombi hili limeamuliwa na mtu mwingine sasa hivi. / Somebody else just decided this one.');
    return { ok: true, id, status: patch.status };
  },

  /** THE LEAVE REPORT: every request in a period, company-wide, with the widgets the CEO, HR
      and Finance ask across a desk -- how many asked, how many working days were granted, what
      was filed late, who is away today. Read by the leave's START date, like the advance and
      imprest reports read by the thing they are about rather than by the click.
        "REPORTS are seen by CEO, Admin, HR and Finance ... so for leaves we should have
         requests, approval and reports"
      "Away today" is counted over the whole table, not the period: somebody whose leave began
      last month is still away this morning, and that is the question being asked. */
  async leaveReport(db, user, args) {
    requireNav(user, 'leaverep');
    const a = args || {};
    let rows;
    try {
      rows = await fetchAll(() => db.from('leave_requests').select(LEAVE_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, totals: {} };
    }
    const from = isDay(a.from) ? String(a.from) : null;
    const to = isDay(a.to) ? String(a.to) : null;
    const want = String(a.status || '').trim();
    const today = todayKey();
    const all = rows.map(r => leaveRow(r, user.code));
    const away = r => r.status === 'approved' && r.from <= today && r.to >= today;
    const inPeriod = all
      .filter(r => !from || (r.from && r.from >= from))
      .filter(r => !to || (r.from && r.from <= to));
    const shown = (want === 'today' ? all.filter(away)
      : want === 'shortNotice' ? inPeriod.filter(r => r.shortNotice)
      : inPeriod.filter(r => !['pending', 'approved', 'rejected'].includes(want) || r.status === want))
      .sort((x, y) => (y.at || 0) - (x.at || 0));
    const approved = inPeriod.filter(r => r.status === 'approved');
    return { ok: true, rows: shown,
      totals: {
        count: inPeriod.length,
        pending: inPeriod.filter(r => r.status === 'pending').length,
        approved: approved.length,
        rejected: inPeriod.filter(r => r.status === 'rejected').length,
        // Working days actually granted -- the figure payroll and cover planning start from.
        approvedDays: approved.reduce((s, r) => s + (r.workingDays || 0), 0),
        shortNotice: inPeriod.filter(r => r.shortNotice).length,
        onLeaveToday: all.filter(away).length,
      } };
  },

  /* =====================================================================================
     ISSUES -- raise, work, report.
     =====================================================================================
       RSM SOP C  "Log every issue raised by an agent or team leader ... which routes the issue
                   to the appropriate department ... Escalate unresolved or complex issues to
                   the General Manager"
       Credit C   "Register the complaint on the complaints form ... refer the matter to the
                   WATU Credit Department where applicable"
       IT C       "log them with the WATU support system and Samsung shop ... Register the log
                   book of the resolved matter"
       GD B       "Maintain a log of all pending tasks, documents, and system entries ...
                   Record the resolution and closing date"

     One table, three navs. The DEPARTMENT is a label the desk filters on, never a nav of its
     own -- the owner's rule since the advance was simplified: one queue, one grant. */

  /** Anybody who may raise, or anybody who works the desk (a desk logs on a caller's behalf --
      that is what the complaints form is). */
  async issueRaise(db, user, args) {
    requireAnyNav(user, ['issuereq', 'issues']);
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    /* WHOSE DESK THIS LANDS ON.
       -----------------------------------------------------------------------------------
         "when someone reports an issue they choose who to report to by choosing role and
          next (option) user in the role"

       The ROLE is what the owner already maintains in Access codes -- the same list they tick
       navs on -- so routing needs no second vocabulary that would drift out of step with the
       first. The PERSON is optional, and the blank is the feature: blank means anybody
       holding that role, filled means one desk and only that one. */
    const toRole = K(a.toRole).replace(/[\s-]+/g, '_');
    /* The old department list is still accepted, so a screen that has not been reloaded yet
       keeps filing. One of the two is required -- an issue addressed to nobody is a note. */
    const department = K(a.department).replace(/ /g, '_');
    const deptOk = ISSUE_DEPTS.includes(department);
    if (!toRole && !deptOk) {
      bad('Chagua wadhifa wa kupeleka suala. / Choose the role (or department) to send it to.');
    }
    const toName = S(a.toName, 120);
    const kind = String(a.kind || 'issue').trim().toLowerCase();
    if (!ISSUE_KINDS.includes(kind)) bad('Aina ya suala si sahihi. / Unknown kind of issue.');
    const subjectType = String(a.subjectType || '').trim().toLowerCase();
    if (subjectType && !ISSUE_SUBJECTS.includes(subjectType)) bad('Aina ya kitu si sahihi. / Unknown subject type.');
    const subject = S(a.subject, 120);
    if (subjectType && subjectType !== 'other' && subjectType !== 'system' && !subject) {
      bad('Andika IMEI, jina la ajenti au namba ya risiti. / Give the IMEI, agent or receipt number.');
    }
    const title = S(a.title, 160);
    if (!title) bad('Andika kichwa cha suala. / Give the issue a title.');
    const at = new Date().toISOString();
    const row = {
      raised_at: at, updated_at: at,
      staff_code: user.code || null, staff_name: user.name || '', staff_role: user.role || '',
      /* The department stays where the role happens to be one of the eight it was born with,
         so the issues report keeps grouping the way it always did. Otherwise it is simply not
         set: refusing an issue because the owner's role vocabulary has moved on would stop the
         log rather than route it. */
      department: deptOk ? department : (ISSUE_DEPTS.includes(toRole) ? toRole : null),
      kind, subject_type: subjectType || null, subject: subject || null,
      title, details: S(a.details, 4000) || null, contact: S(a.contact, 60) || null,
      status: 'open', updated_by: user.name || '',
    };
    if (toRole) { row.to_role = toRole; row.to_name = toName || null; }
    let data;
    let error;
    ({ data, error } = await db.from('issues').insert([row]).select('id'));
    /* THE ROUTING COLUMNS ARRIVE BY HAND. Between a deploy and somebody pasting the SQL an
       issue must still be filable -- unrouted, and said so -- rather than refused. */
    if (error && ISSUE_ROUTE_COLS.test(String(error.message || ''))) {
      const bare = { ...row };
      delete bare.to_role; delete bare.to_name;
      if (!bare.department) bare.department = 'GENERAL_DUTY';
      ({ data, error } = await db.from('issues').insert([bare]).select('id'));
    }
    if (error) {
      if (tableMissing(error)) bad(ISSUE_NOT_READY);
      throw new Error(error.message);
    }
    const id = data && data[0] ? String(data[0].id) : null;
    /* THE NUDGE to the department, best effort, after the row exists. */
    /* WHO IS TOLD. ISSUES_EMAIL is still keyed by name, so it is asked for the ROLE first --
       that is the address now -- and for the old department name as a fallback, so a settings
       block written before routing keeps working without being retyped. */
    let to = '';
    try {
      const { data: s } = await db.from('settings').select('value').eq('key', 'ISSUES_EMAIL').maybeSingle();
      to = issueDeptEmails(s && s.value, toRole) || issueDeptEmails(s && s.value, row.department || '');
    } catch (e) { to = ''; }
    const mail = to ? await sendMail(db, { to,
      subject: 'HOOPLOAN — suala jipya / new issue (' + (toName || toRole || row.department || '') + '): ' + title,
      html: noticeHtml('Suala jipya / New issue — ' + (toRole || row.department || ''), [
        ['Kwa / To', toName ? (toName + ' (' + toRole + ')') : (toRole || row.department || '—')],
        ['Kichwa / Title', title], ['Aina / Kind', kind],
        ['Kuhusu / About', (subjectType ? subjectType + ' ' : '') + (subject || '—')],
        ['Ameleta / Raised by', user.name || ''], ['Maelezo / Details', String(row.details || '').slice(0, 400)],
      ], 'Fungua Dawati la masuala kulifanyia kazi. / Open the issues desk to work it.') })
      : { sent: false, reason: 'ISSUES_EMAIL haina ' + (toRole || row.department || '?')
          + ' / no address set for ' + (toRole || row.department || '?') };
    return { ok: true, id, department: row.department || '',
      /* Answered back so the toast can name WHO it went to rather than which of the eight old
         labels it happened to land under. */
      toRole, toName, emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
  },

  /** The raiser's own issues, and only their own. */
  /** WHO AN ISSUE CAN BE SENT TO: every role the owner maintains, and the people holding it.

      THE ACCESS CODES NEVER TRAVEL. This is the only place outside Access codes that reads
      that table, and it reads a name and a role -- nothing that could sign anybody in. The
      raise form needs a person's NAME to address an issue to them, and that is all it gets.

      Behind either issue nav rather than behind Settings: the person filing an issue is the
      one who has to choose where it goes, and they will not hold the codes pane. */
  async issueTargets(db, user) {
    requireAnyNav(user, ['issuereq', 'issues']);
    let codes = [];
    try {
      codes = await fetchAll(() => db.from('access_codes').select('name, role'));
    } catch (e) { codes = []; }
    const by = new Map();
    for (const c of codes) {
      const role = K(c.role).replace(/[\s-]+/g, '_');
      const name = String(c.name || '').trim();
      if (!role) continue;
      if (!by.has(role)) by.set(role, new Set());
      if (name) by.get(role).add(name);
    }
    /* A role somebody holds but that no code names is still offerable -- and so are the
       departments this log was born with, so an office mid-way through moving from one
       vocabulary to the other can address an issue either way. */
    for (const d of ISSUE_DEPTS) if (!by.has(d)) by.set(d, new Set());
    return { ok: true,
      roles: [...by.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))
        .map(([role, people]) => ({ role, people: [...people].sort() })) };
  },

  async issueMine(db, user) {
    requireNav(user, 'issuereq');
    let rows;
    try {
      rows = (await issueSelect(db, cols => db.from('issues').select(cols)
        .eq('staff_code', user.code || '~none~'))).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, departments: ISSUE_DEPTS, kinds: ISSUE_KINDS, subjects: ISSUE_SUBJECTS };
    }
    return { ok: true, departments: ISSUE_DEPTS, kinds: ISSUE_KINDS, subjects: ISSUE_SUBJECTS,
      rows: rows.map(r => issueRow(r, user.code)).sort(issueOpenFirst) };
  },

  /** THE DESK. Every issue, open first; counts over the whole table and per department so the
      chips say where the work is before the list is narrowed. */
  async issueQueue(db, user, args) {
    requireNav(user, 'issues');
    const a = args || {};
    let got;
    try {
      got = await issueSelect(db, cols => db.from('issues').select(cols));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, departments: ISSUE_DEPTS, kinds: ISSUE_KINDS, subjects: ISSUE_SUBJECTS,
        routed: false, myRole: K(user.role), roles: [], mine: 0,
        counts: { open: 0, waiting: 0, escalated: 0, resolved: 0, mine: 0, directed: 0, byDept: {}, byRole: {} } };
    }
    const all = got.rows.map(r => issueRow(r, user.code));
    const dept = K(a.department).replace(/ /g, '_');
    const role = K(a.toRole).replace(/[\s-]+/g, '_');
    const want = String(a.state || '').trim();
    /* MY DESK IS THE DEFAULT, because that is what the owner asked the desk to be: "on the
       desks every user sees what they have on desk". Both other defaults have a reason:

         ADMIN and AUDITOR see everything    the standing rule, and supervision that can only
                                             see its own desk is not supervision
         nothing routed yet, everybody       before the migration no row has a role on it, so
                                             "my desk" would read as the log having emptied

       Either way `view` is answered back, so the pane shows which one it is looking at rather
       than leaving somebody to wonder where the rest went. */
    const mineRows = all.filter(r => issueOnMyDesk(r, user));
    const wide = advSeesEveryRole(user) || !got.routed;
    const view = String(a.view || (wide ? 'all' : 'mine')).trim();
    const pool = view === 'all' ? all : mineRows;
    const shown = pool
      .filter(r => !dept || r.department === dept)
      .filter(r => !role || K(r.toRole) === role)
      .filter(r => want === 'all' ? true : want ? r.status === want : r.status !== 'resolved')
      .sort(issueOpenFirst);
    const byDept = {};
    for (const d of ISSUE_DEPTS) byDept[d] = all.filter(r => r.department === d && r.status !== 'resolved').length;
    const byRole = {};
    for (const r of all) {
      if (!r.toRole || r.status === 'resolved') continue;
      byRole[r.toRole] = (byRole[r.toRole] || 0) + 1;
    }
    return { ok: true, departments: ISSUE_DEPTS, kinds: ISSUE_KINDS, subjects: ISSUE_SUBJECTS,
      /* Said plainly rather than shown as an empty desk: before the migration nothing is
         routed, so every issue is on the old department footing and "my desk" would read as
         nobody having anything. */
      routed: got.routed,
      routeNote: got.routed ? '' : ISSUE_ROUTE_NOT_READY,
      view, myRole: K(user.role), myName: user.name || '',
      roles: Object.keys(byRole).sort(),
      counts: {
        open: all.filter(r => r.status === 'open').length,
        waiting: all.filter(r => r.status === 'waiting').length,
        escalated: all.filter(r => r.status === 'escalated').length,
        resolved: all.filter(r => r.status === 'resolved').length,
        // What is on THIS person's desk, unresolved -- the number the desk exists to drive down.
        mine: mineRows.filter(r => r.status !== 'resolved').length,
        // ...and how many of those were addressed to them by name rather than to the role.
        directed: mineRows.filter(r => r.status !== 'resolved' && r.directed
          && K(r.toName) === K(user.name)).length,
        byDept, byRole,
      },
      rows: shown };
  },

  /** The conversation on one issue. A raiser sees only their own; the desk and the report see any. */
  async issueNotes(db, user, args) {
    requireAnyNav(user, ['issuereq', 'issues', 'issuerep']);
    const id = String((args && args.id) || '').trim();
    if (!isUuid(id)) bad('Suala halijachaguliwa. / No issue chosen.');
    const navs = navsFor(user);
    if (!navs.includes('issues') && !navs.includes('issuerep')) {
      let own;
      try {
        own = await fetchAll(() => db.from('issues').select('id, staff_code').eq('id', id));
      } catch (e) {
        if (!tableMissing(e)) throw e;
        return { ok: true, notes: [], notReady: true };
      }
      const r = own.find(x => String(x.id) === id);
      if (!r || String(r.staff_code || '') !== String(user.code || '')) bad('Suala halipo. / That issue no longer exists.');
    }
    let rows;
    try {
      rows = await fetchAll(() => db.from('issue_notes').select('at, by_name, note, change').eq('issue_id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, notes: [] };
    }
    return { ok: true, notes: rows.map(n => ({ at: n.at ? Date.parse(n.at) : null, by: n.by_name || '',
      note: n.note || '', change: n.change || '' })).sort((x, y) => (x.at || 0) - (y.at || 0)) };
  },

  /** MOVE IT. The desk changes status, assignment, references and the verified tick, and
      writes the note that explains the move; a raiser may only add a note to their own issue
      ("here is the document"). Resolving needs a resolution; escalating tells the GM. */
  async issueUpdate(db, user, args) {
    requireAnyNav(user, ['issuereq', 'issues']);
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Suala halijachaguliwa. / No issue chosen.');
    let rows;
    try {
      rows = (await issueSelect(db, cols => db.from('issues').select(cols).eq('id', id))).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(ISSUE_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    const desk = navsFor(user).includes('issues');
    /* NOT YOURS reads as NOT THERE, and a raiser who is not the desk may only talk. */
    if (!row || (!desk && String(row.staff_code || '') !== String(user.code || ''))) bad('Suala halipo. / That issue no longer exists.');
    const note = S(a.note, 2000);
    const at = new Date().toISOString();
    const patch = { updated_by: user.name || '', updated_at: at };
    let change = null;
    if (desk) {
      if (a.status != null && a.status !== '') {
        const status = String(a.status).trim().toLowerCase();
        if (!ISSUE_STATES.includes(status)) bad('Hali si sahihi. / Unknown status.');
        if (status !== row.status) {
          change = row.status + '>' + status;
          patch.status = status;
          if (status === 'resolved') {
            const resolution = S(a.resolution, 2000) || String(row.resolution || '');
            if (!resolution) bad('Andika jinsi lilivyotatuliwa. / Say how it was resolved.');
            patch.resolution = resolution; patch.resolved_by = user.name || ''; patch.resolved_at = at;
          } else if (row.status === 'resolved') {
            // Reopened: the closing stamps go, the resolution text stays as history.
            patch.resolved_by = null; patch.resolved_at = null;
          }
          if (status === 'escalated') { patch.escalated_by = user.name || ''; patch.escalated_at = at; }
        }
      }
      if (a.resolution != null && !patch.resolution && S(a.resolution, 2000)) patch.resolution = S(a.resolution, 2000);
      if (a.assignedTo != null) patch.assigned_to = S(a.assignedTo, 80) || null;
      if (a.referredTo != null) patch.referred_to = S(a.referredTo, 60) || null;
      if (a.externalRef != null) patch.external_ref = S(a.externalRef, 80) || null;
      if (a.verified != null) patch.verified = a.verified === true;
    }
    if (!note && !change && Object.keys(patch).length === 2) bad('Hakuna kilichobadilika. / Nothing to save.');
    /* GUARDED on what was read, so two desks cannot silently overwrite each other's move. */
    const { data, error } = await db.from('issues').update(patch).eq('id', id).eq('updated_at', row.updated_at).select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Suala hili limebadilishwa na mtu mwingine sasa hivi — lifungue upya. / Somebody else just changed this issue; reopen it.');
    if (note || change) {
      const { error: nErr } = await db.from('issue_notes').insert([{ issue_id: id, at, by_code: user.code || null,
        by_name: user.name || '', note: note || (change ? change.replace('>', ' → ') : ''), change }]);
      if (nErr) throw new Error(nErr.message);
    }
    let mail = { sent: false, reason: '' };
    if (patch.status === 'escalated') {
      mail = await sendMail(db, { toKey: 'GM_EMAIL',
        subject: 'HOOPLOAN — suala limepandishwa / issue escalated (' + row.department + '): ' + (row.title || ''),
        html: noticeHtml('Suala limepandishwa / Issue escalated', [
          ['Kichwa / Title', row.title || ''], ['Idara / Department', row.department || ''],
          ['Kuhusu / About', (row.subject_type ? row.subject_type + ' ' : '') + (row.subject || '—')],
          ['Ameleta / Raised by', row.staff_name || ''], ['Amepandisha / Escalated by', user.name || ''],
          ['Maelezo / Note', note || '—'],
        ], 'Fungua Dawati la masuala. / Open the issues desk.') });
    }
    return { ok: true, id, status: patch.status || row.status, change, emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
  },

  /** THE LOG BOOK. A period by the date raised, every department, with the widgets the CEO
      and a department head ask across a desk: how many, how many still open, how long they
      take, and where the oldest open one sits. */
  async issueReport(db, user, args) {
    requireNav(user, 'issuerep');
    const a = args || {};
    let rows;
    try {
      rows = (await issueSelect(db, cols => db.from('issues').select(cols))).rows;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, totals: {}, departments: ISSUE_DEPTS };
    }
    const from = isDay(a.from) ? String(a.from) : null;
    const to = isDay(a.to) ? String(a.to) : null;
    const dept = K(a.department).replace(/ /g, '_');
    const want = String(a.status || '').trim();
    const all = rows.map(r => issueRow(r, user.code));
    const day = ms => new Date(ms).toISOString().slice(0, 10);
    const inPeriod = all
      .filter(r => !from || (r.at && day(r.at) >= from))
      .filter(r => !to || (r.at && day(r.at) <= to))
      .filter(r => !dept || r.department === dept);
    const shown = inPeriod.filter(r => !ISSUE_STATES.includes(want) || r.status === want)
      .sort((x, y) => (y.at || 0) - (x.at || 0));
    const resolved = inPeriod.filter(r => r.status === 'resolved');
    const open = inPeriod.filter(r => r.status !== 'resolved');
    const byDept = ISSUE_DEPTS.map(d => ({ department: d,
      count: inPeriod.filter(r => r.department === d).length,
      open: inPeriod.filter(r => r.department === d && r.status !== 'resolved').length,
      resolved: inPeriod.filter(r => r.department === d && r.status === 'resolved').length,
    })).filter(x => x.count);
    return { ok: true, rows: shown, departments: ISSUE_DEPTS,
      totals: {
        count: inPeriod.length,
        open: open.filter(r => r.status === 'open').length,
        waiting: open.filter(r => r.status === 'waiting').length,
        escalated: open.filter(r => r.status === 'escalated').length,
        resolved: resolved.length,
        // Mean days from raised to resolved, for what was resolved in the period.
        avgDays: resolved.length ? Math.round(resolved.reduce((s, r) => s + r.ageDays, 0) / resolved.length) : 0,
        oldestOpenDays: open.reduce((m, r) => Math.max(m, r.ageDays), 0),
        byDept,
      } };
  },

  /* =====================================================================================
     TOP-UPS / CREDIT SALES -- request, verify, pay, unlock.
     =====================================================================================
       Finance SOP B.1  the request WITH proof of the client's upfront payment
       Finance SOP B.2  "VERIFY THE IMEI NUMBER before processing the payment"
       Finance SOP B.3  verify the payer's name against bank/mobile-money records
       Finance SOP B.4  calculate the balance to complete the full phone price
       Finance SOP B.5  "Send the top-up payment IMMEDIATELY so the system can unlock the
                         device for the client -- THIS STEP MUST NEVER BE DELAYED"
       Finance SOP B.6  confirm with the agent/client that the device has been unlocked
       Finance SOP B    the Top-Up Audit Checklist, filed against every transaction

     B.5 IS THE ONLY STEP IN ANY OF THESE SOPs WITH THE WORDS "MUST NEVER BE DELAYED", and it
     is why this is a table rather than a WhatsApp thread. A customer whose phone stays locked
     after they have paid is the worst thing this company can do to somebody, and the only way
     to stop that happening quietly is to make the waiting visible and count the minutes.

     FOUR STAMPS, NOT ONE STATUS: requested, verified, paid, unlocked. The gap between any two
     of them is somebody's afternoon, and a single status column cannot show a gap.

     Two navs: `topupreq` asks and reads its own, `topups` is Finance's desk. */

  /** Anybody who may ask, and the desk (which files one when an agent phones it in). */
  async topupRequest(db, user, args) {
    requireAnyNav(user, ['topupreq', 'topups']);
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    /* B.2: the IMEI is the thing every later step is checked against, so it is the one field
       with no way round it. */
    const imei = String(a.imei == null ? '' : a.imei).replace(/\D/g, '');
    if (!imei) bad('Weka IMEI ya simu. / Give the phone IMEI (SOP B.2).');
    if (imei.length < 14 || imei.length > 17) bad('IMEI si sahihi. / That IMEI is not a valid length.');
    const paid = Math.round(num(a.paidAmount));
    if (!(paid > 0)) bad('Weka kiasi alicholipa mteja. / Enter what the client paid up front (SOP B.1).');
    if (paid > 1e9) bad('Kiasi si sahihi. / That amount is not a payment.');
    /* B.4: the balance is only a fact alongside the price it was worked out from, so the price
       is looked up from the loan book where it is known and both are stored. */
    let price = a.price == null || String(a.price).trim() === '' ? null : Math.round(num(a.price));
    if (price == null) {
      try {
        const { data } = await db.from('watu_loans').select('price, client_name').eq('imei', imei).maybeSingle();
        if (data && data.price != null) price = Math.round(num(data.price));
        if (data && data.client_name && !a.customer) a.customer = data.client_name;
      } catch (e) { price = null; }
    }
    const at = new Date().toISOString();
    const row = {
      requested_at: at, updated_at: at,
      staff_code: user.code || null, staff_name: user.name || '', staff_role: user.role || '',
      imei, customer: S(a.customer, 160) || null, customer_phone: S(a.customerPhone, 60) || null,
      payer_name: S(a.payerName, 160) || null, paid_amount: paid,
      proof_ref: S(a.proofRef, 200) || null,
      price, balance: price == null ? null : Math.max(0, price - paid),
      status: 'requested', updated_by: user.name || '',
    };
    const { data, error } = await db.from('topups').insert([row]).select('id');
    if (error) {
      if (tableMissing(error)) bad(TOPUP_NOT_READY);
      throw new Error(error.message);
    }
    const id = data && data[0] ? String(data[0].id) : null;
    const mail = await sendMail(db, { toKey: 'TOPUP_EMAIL',
      subject: 'HOOPLOAN — top-up inasubiri / top-up waiting: ' + imei,
      html: noticeHtml('Top-up inasubiri malipo / A top-up is waiting', [
        ['IMEI', imei], ['Mteja / Customer', row.customer || '—'],
        ['Amelipa / Client paid', 'TZS ' + money0(paid)],
        ['Bei / Price', price == null ? '—' : 'TZS ' + money0(price)],
        ['Salio / Balance', row.balance == null ? '—' : 'TZS ' + money0(row.balance)],
        ['Amelipa nani / Payer', row.payer_name || '—'], ['Uthibitisho / Proof', row.proof_ref || '—'],
        ['Ameomba / Requested by', user.name || ''],
      ], 'SOP B.5: malipo haya hayapaswi kucheleweshwa — simu ya mteja imefungwa. '
       + '/ SOP B.5: this payment must never be delayed; the customer’s phone is locked.') });
    return { ok: true, id, imei, price, balance: row.balance,
      emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
  },

  /** The asker's own top-ups. */
  async topupMine(db, user) {
    requireNav(user, 'topupreq');
    let rows;
    try {
      rows = await fetchAll(() => db.from('topups').select(TOPUP_COLS).eq('staff_code', user.code || '~none~'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true };
    }
    const now = Date.now();
    return { ok: true, rows: rows.map(r => topupRow(r, user.code, now)).sort(topupWaitFirst) };
  },

  /** THE DESK. Waiting first, longest-waiting first among those, because that is the only
      order a rule that says "must never be delayed" can be served by. */
  async topupQueue(db, user, args) {
    requireNav(user, 'topups');
    const a = args || {};
    let rows;
    try {
      rows = await fetchAll(() => db.from('topups').select(TOPUP_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true,
        counts: { requested: 0, verified: 0, paid: 0, unlocked: 0, waiting: 0 },
        checks: TOPUP_CHECKS.map(([js, , label]) => ({ key: js, label })) };
    }
    const now = Date.now();
    const all = rows.map(r => topupRow(r, user.code, now));
    const want = String(a.state || '').trim();
    const shown = all
      .filter(r => want === 'all' ? true : want ? r.status === want
        : (r.status !== 'unlocked' && r.status !== 'rejected'))
      .sort(topupWaitFirst);
    const waiting = all.filter(r => r.status === 'requested' || r.status === 'verified');
    return { ok: true, rows: shown,
      checks: TOPUP_CHECKS.map(([js, , label]) => ({ key: js, label })),
      counts: {
        requested: all.filter(r => r.status === 'requested').length,
        verified: all.filter(r => r.status === 'verified').length,
        paid: all.filter(r => r.status === 'paid').length,
        unlocked: all.filter(r => r.status === 'unlocked').length,
        waiting: waiting.length,
        // The number B.5 exists to keep at zero: the longest anybody is currently waiting.
        longestWaitMins: waiting.reduce((mx, r) => Math.max(mx, r.waitedMins || 0), 0),
      } };
  },

  /** MOVE ONE (SOP B.2-B.6). Verifying, paying and confirming the unlock are three different
      acts by possibly three different people, so each is its own step with its own stamp. */
  async topupUpdate(db, user, args) {
    requireNav(user, 'topups');
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Top-up haijachaguliwa. / No top-up chosen.');
    let rows;
    try {
      rows = await fetchAll(() => db.from('topups').select(TOPUP_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(TOPUP_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    if (!row) bad('Top-up haipo. / That top-up no longer exists.');
    if (row.status === 'unlocked') bad('Top-up hii imekamilika. / That top-up is already complete.');
    const step = String(a.step || '').trim().toLowerCase();
    const at = new Date().toISOString();
    const patch = { updated_by: user.name || '', updated_at: at };
    const comment = S(a.comment, 2000);

    if (step === 'verify') {
      /* B.2 AND B.3 ARE ONE STEP AND BOTH ARE REQUIRED. Verifying "the IMEI" without checking
         who actually paid is how a top-up gets sent against somebody else's money. */
      if (a.imeiOk !== true) bad('Thibitisha IMEI kwanza (SOP B.2). / Confirm the IMEI first.');
      if (a.payerOk !== true) bad('Thibitisha jina la mlipaji dhidi ya benki (SOP B.3). / Confirm the payer against the bank record.');
      patch.status = 'verified'; patch.verified_by = user.name || ''; patch.verified_at = at;
      if (a.payerName != null && S(a.payerName, 160)) patch.payer_name = S(a.payerName, 160);
      if (a.price != null && String(a.price).trim() !== '') {
        const price = Math.round(num(a.price));
        if (!(price >= 0)) bad('Bei si sahihi. / That is not a price.');
        patch.price = price;
        patch.balance = Math.max(0, price - num(row.paid_amount));
      }
    } else if (step === 'pay') {
      if (row.status !== 'verified') bad('Thibitisha kwanza kabla ya kulipa (SOP B.2/B.3). / Verify it before paying.');
      const ref = S(a.paymentRef, 120);
      if (!ref) bad('Andika kumbukumbu ya malipo. / Give the payment reference.');
      patch.status = 'paid'; patch.paid_by = user.name || ''; patch.paid_at = at; patch.payment_ref = ref;
    } else if (step === 'unlock') {
      /* B.6: somebody actually rang the customer. Recording an unlock nobody confirmed is the
         one lie this table exists to prevent. */
      if (row.status !== 'paid') bad('Simu haiwezi kufunguliwa kabla ya malipo. / It cannot be unlocked before it is paid.');
      if (a.confirmed !== true) bad('Thibitisha na mteja au ajenti kuwa simu imefunguliwa (SOP B.6). / Confirm with the customer that the phone opened.');
      patch.status = 'unlocked'; patch.unlocked_by = user.name || ''; patch.unlocked_at = at;
    } else if (step === 'reject') {
      if (!comment) bad('Sababu inahitajika ukikataa. / A reason is required when rejecting.');
      patch.status = 'rejected';
    } else if (step !== 'note') {
      bad('Hatua si sahihi. / Unknown step.');
    }
    if (comment) patch.comment = comment;
    for (const [js, col] of TOPUP_CHECKS) if (a.checks && a.checks[js] === true) patch[col] = true;
    if (Object.keys(patch).length === 2) bad('Hakuna kilichobadilika. / Nothing to save.');
    /* GUARDED on the status that was read, so two desks cannot both pay the same top-up. */
    const { data, error } = await db.from('topups').update(patch)
      .eq('id', id).eq('status', row.status).select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Top-up hii imebadilishwa na mtu mwingine sasa hivi. / Somebody else just changed this top-up.');
    return { ok: true, id, status: patch.status || row.status };
  },

  /* =====================================================================================
     AGING BY SYNCHRONISATION -- the locked phones our server is not pinging.
     =====================================================================================
       "Issuing of stock at stock request, by using the devices synchronization we should get
        a report of never synced by days, so sortable columns of aging stock by synchronisation
        for locked phones -- here we easily trace the phones that our system is not pinging
        (could have been frauded / software booted to remove lock), so now way forward stock
        verification will require stock holders to always connect to the internet the stock
        they hold so that we analyze which phones are not syncing"

     THE AGING TRACKER ALREADY ASKS HOW LONG A PHONE HAS SAT ON A SHELF. This asks a different
     question about the same phones: how long since it last SPOKE TO US. A handset that is
     locked and has stopped beating is either off, or somewhere with no network, or no longer
     locked at all -- and the third case is the one this exists to find.

     IT DOES NOT ACCUSE. A boxed phone at the station is offline for weeks by design, and a
     region with no coverage is not a fraud. What the report does is make the silence VISIBLE
     and attach a NAME to it, so stock verification has something to ask about. The word used
     on screen is "hazipigi ripoti" -- not reporting -- and never "stolen".

     SILENCE IS MEASURED FROM TWO CLOCKS, because one of them lies. A phone locked five minutes
     ago has not had time to confirm anything, and counting it as silent would bury the real
     cases under every lock ordered today. So a row is only SUSPECT once the silence has
     outlasted the order that caused it. */

  async syncAging(db, user, args) {
    /* Three desks need this and it is a read: the store keeper who will chase the handset,
       the desk issuing stock against it, and whoever reads the tracker. */
    requireAnyNav(user, ['stockrep', 'stockappr', 'devlock']);
    const a = args || {};
    const now = Date.now();
    const alertDays = await syncAlertDays(db);

    let devs = [];
    let notReady = false;
    try {
      devs = await fetchAll(() => db.from('devices')
        .select('imei, item, holder, state, reported, last_seen, state_at, released_at'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      notReady = true;
    }
    /* WHO IS ANSWERABLE FOR IT. devices.holder is stamped once, at enrolment, from the stock
       report of that day; the aged-stock file is re-uploaded daily and is therefore the
       current answer. The newest as_of wins, and the enrolment stamp is the fallback. */
    let aged = [];
    try {
      aged = await fetchAll(() => db.from('hoop_aged_stock').select('serial, agent, item, age_days, as_of'));
    } catch (e) { aged = []; }
    const latestAsOf = aged.reduce((mx, r) => (r.as_of && String(r.as_of) > mx ? String(r.as_of) : mx), '');
    const agedBy = new Map();
    for (const r of aged) {
      if (latestAsOf && String(r.as_of || '') !== latestAsOf) continue;
      agedBy.set(String(r.serial), r);
    }

    const want = String(a.state || 'locked').trim();
    const dayOf = ms => Math.floor((now - ms) / 86400000);
    const rows = devs
      .filter(r => (want === 'all' ? true : String(r.state || '') === want))
      .map(r => {
        const seen = r.last_seen ? Date.parse(r.last_seen) : null;
        const ordered = r.state_at ? Date.parse(r.state_at) : null;
        const st = agedBy.get(String(r.imei)) || null;
        const days = seen ? Math.max(0, dayOf(seen)) : null;
        const sinceOrder = ordered ? Math.max(0, dayOf(ordered)) : null;
        /* NOT YET SUSPECT: the order is younger than the silence we would need to see. A phone
           locked this morning is not evidence of anything. */
        const ripe = sinceOrder == null || sinceOrder >= alertDays;
        return {
          imei: String(r.imei), item: r.item || (st && st.item) || '',
          holder: (st && st.agent) || r.holder || '',
          state: r.state || '', reported: r.reported || '',
          seenAt: seen, days,
          neverSeen: !seen,
          orderedAt: ordered, sinceOrderDays: sinceOrder,
          // The stock's OWN age, so one row answers both questions at once.
          agedDays: st && st.age_days != null ? num(st.age_days) : null,
          suspect: ripe && (days == null || days >= alertDays),
        };
      })
      /* WORST FIRST, and a phone that has never spoken is the worst there is: it is the one
         whose lock was possibly never applied at all. */
      .sort((x, y) => (y.neverSeen ? 1 : 0) - (x.neverSeen ? 1 : 0)
        || (y.days || 0) - (x.days || 0)
        || (y.agedDays || 0) - (x.agedDays || 0));

    const shown = String(a.holder || '').trim()
      ? rows.filter(r => K(r.holder) === K(a.holder)) : rows;

    /* PER HOLDER, because that is who stock verification actually sits down with. */
    const byHolder = {};
    for (const r of rows) {
      const k = r.holder || '(hakuna / unknown)';
      const g = byHolder[k] || (byHolder[k] = { holder: k, held: 0, quiet: 0, never: 0, worstDays: 0 });
      g.held++;
      if (r.suspect) g.quiet++;
      if (r.neverSeen) g.never++;
      if (r.days != null && r.days > g.worstDays) g.worstDays = r.days;
    }

    const band = (lo, hi) => rows.filter(r => r.days != null && r.days >= lo && (hi == null || r.days < hi)).length;
    return { ok: true, notReady, alertDays, asOf: now, state: want,
      holders: [...new Set(rows.map(r => r.holder).filter(Boolean))].sort(),
      rows: shown.slice(0, 2000),
      shown: shown.length,
      byHolder: Object.values(byHolder).sort((x, y) => (y.quiet - x.quiet) || (y.held - x.held)),
      counts: {
        total: rows.length,
        never: rows.filter(r => r.neverSeen).length,
        suspect: rows.filter(r => r.suspect).length,
        // The bands the table sorts into, so a distribution is readable without the rows.
        over30: band(30, null), d14: band(14, 30), d7: band(7, 14), d3: band(3, 7), fresh: band(0, 3),
        /* NEVER SPOKEN AND LONG SINCE ORDERED -- the sharpest line in the report. The lock was
           ordered, the handset has never once contacted us, and enough time has passed that
           "it has not got round to it" has stopped being an explanation. */
        neverAndRipe: rows.filter(r => r.neverSeen && r.suspect).length,
      } };
  },

  /* =====================================================================================
     OLD STOCK -- what we hold, have never locked, and are going out to find.
     =====================================================================================
       "We'll conduct ground visits to all our previous agents and lock all stock we find, and
        once a stock in OLD STOCK is enrolled into our lock then it moves to list of NEW STOCK."

     This is a worklist, so it is ordered like one: oldest first, and grouped by the person a
     visit is actually made to. The counts say how the visits are going -- how many have since
     been locked or sold -- because a list that only shrinks tells you nothing about whether it
     is shrinking for the right reason.
     ===================================================================================== */
  async oldStock(db, user, args) {
    requireNav(user, 'oldstock');
    const a = args || {};
    const idx = await oldStockIndex(db);
    const open = idx.open.slice();
    const q = String(a.q == null ? '' : a.q).replace(/\D/g, '');
    const who = K(a.agent || '');
    const boss = K(a.rsm || '');
    const shown = open.filter(r => {
      if (q && !String(r.imei).includes(q)) return false;
      if (who && K(r.agent) !== who) return false;
      if (boss && K(r.rsm) !== boss) return false;
      return true;
    }).sort((x, y) => (y.age == null ? -1 : y.age) - (x.age == null ? -1 : x.age)
      || String(x.agent).localeCompare(String(y.agent))
      || String(x.imei).localeCompare(String(y.imei)));

    /* PER HOLDER, because that is who a ground visit is made to -- one row per journey, with
       the oldest piece on it so the worst trip is obvious before anybody sets off. */
    const byAgent = new Map();
    for (const r of open) {
      const k = nameKey(r.agent) || '?';
      let g = byAgent.get(k);
      if (!g) {
        g = { agent: r.agent || '(hakuna jina / unnamed)', phone: r.agentPhone || '',
          rsm: r.rsm || '', rsmPhone: r.rsmPhone || '', pieces: 0, oldest: 0, over90: 0 };
        byAgent.set(k, g);
      }
      g.pieces++;
      if (r.age != null && r.age > g.oldest) g.oldest = r.age;
      if (r.age != null && r.age >= 90) g.over90++;
    }
    const band = (lo, hi) => open.filter(r => r.age != null && r.age >= lo && (hi == null || r.age < hi)).length;
    return { ok: true, notReady: idx.notReady,
      notReadyNote: idx.notReady ? OLDSTOCK_NOT_READY : '',
      asOf: Date.now(), q, agent: String(a.agent || ''), rsm: String(a.rsm || ''),
      rows: shown.slice(0, 2000), shown: shown.length,
      agents: [...new Set(open.map(r => r.agent).filter(Boolean))].sort(),
      rsms: [...new Set(open.map(r => r.rsm).filter(Boolean))].sort(),
      byAgent: [...byAgent.values()].sort((x, y) => y.oldest - x.oldest || y.pieces - x.pieces),
      counts: {
        open: open.length,
        /* HOW THE VISITS ARE GOING. A list that only shrinks says nothing about WHY: these two
           are the reason, and the difference between them matters -- one is a handset we now
           control, the other is one that got away and sold first. */
        locked: idx.rows.filter(r => r.lockedNow).length,
        sold: idx.rows.filter(r => r.soldNow && !r.lockedNow).length,
        listed: idx.rows.length,
        over180: band(180, null), d90: band(90, 180), d30: band(30, 90), fresh: band(0, 30),
        noAge: open.filter(r => r.age == null).length,
        holders: byAgent.size,
      } };
  },

  /* =====================================================================================
     NEW STOCK -- the sale behind every handset we have locked.
     =====================================================================================
       "An audit of our existing imeis since we started locking on our own -- Imei, Rsm, rsm
        no, agent, agent no, customer, customer no, price, guarantor, guaranto no, status
        (locked, unlocked, achia), by (who promted that status), last read (last sync date &
        time), so that we could always sort locked and sort by sync to know our lost or stock
        that needs verification."

       "It should always read and stamp the sales first imei sales info from watu deck upload,
        since watu always omit data so when we stamp once we are done for the missing column
        info, the rest until obtained -- if watu removes sales data, we already stamped ours."

     TWO KINDS OF FACT SIT ON ONE ROW, AND THEY ARE HANDLED IN OPPOSITE WAYS.

     THE SALE DISAPPEARS, SO IT IS STAMPED. Who bought this handset, for how much, through
     which agent, against whose guarantee -- these are facts about a day in the past. They do
     not stop being true when a spreadsheet stops mentioning them, and the Watu deck is
     re-uploaded over itself with columns blank and rows gone. Every one of them is written
     into stock_audit the FIRST time any feed can answer it and then left alone for good.

     THE STATE CHANGES, SO IT IS NEVER STAMPED. Locked or not, who ordered it, when the phone
     last spoke -- these are read live from `devices` on every open. A stamped status would be
     a lie within the hour, and this pane exists to be trusted about exactly that.

     Everywhere else in this system, writing down something you could derive is the mistake.
     Here it is the whole point, and the difference is which way the input moves: a derived
     TOTAL goes stale when its inputs change, and a captured SALE goes missing when its input
     is deleted. So the provenance travels with it -- `src` says which feed answered each
     column -- and nothing is ever overwritten, which is what makes the capture worth having.
     ===================================================================================== */
  async newStock(db, user, args) {
    requireNav(user, 'newstock');
    const a = args || {};
    const at = new Date().toISOString();
    const now = Date.now();

    let cur = [];
    let notReady = false;
    try {
      cur = await fetchAll(() => db.from('stock_audit').select(NEWSTOCK_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      /* NOT AN EMPTY AUDIT -- an audit that cannot be saved yet. The pane still computes and
         still shows every row, because the joins underneath work perfectly well; what it
         cannot do is REMEMBER, which is the one thing worth saying out loud. */
      notReady = true;
    }
    const stampedBy = new Map(cur.map(r => [String(r.imei), r]));

    /* THE POPULATION IS THE REGISTER, not the sales books: "our existing imeis since we
       started locking on our own". A phone nobody locked is somebody else's audit. */
    /* WHERE IT WAS WHEN IT LAST SPOKE, on the same row as what it is doing.
       -----------------------------------------------------------------------------------
         "At hali/status column, below status, add the second in one [location coordinate
          link] so that we can click to view where the phone is, and always stamp the latest
          read coordinates whenever the phone pings the system. So even if achia we'll always
          find the latest ping coordinate location."

       NOTHING NEW IS STAMPED HERE, because the handset has been doing it since the location
       migration: every beat writes last_lat/last_lng and, separately, WHEN that fix was taken.
       The two timestamps are never collapsed -- a phone that beat a minute ago can be carrying
       a fix from Tuesday -- so the pane shows the fix's own age rather than the beat's.

       AND ACHIA DOES NOT ERASE IT. deviceSetState writes state, reason, who and when; it has
       never touched the position columns, so the last place a released handset was seen
       survives the release. That is the case the owner asked about and the one that matters
       most: a phone let go is a phone nobody is tracking any more, and its last fix is all
       that is left of it. */
    const DEV_CORE = 'imei, item, holder, state, state_by, state_at, last_seen, customer';
    const DEV_LOC = ', last_lat, last_lng, last_loc_acc, last_loc_at';
    let devs = [];
    let noDevices = false;
    let hasLoc = true;
    try {
      devs = await fetchAll(() => db.from('devices').select(DEV_CORE + DEV_LOC));
    } catch (e) {
      /* THE COLUMN CHECK COMES FIRST, and the order is the whole of it. tableMissing() matches
         a missing COLUMN as well as a missing table -- deliberately, because for most callers
         both mean "run the migration" -- so asking it first would answer a missing `last_lat`
         with "the devices register does not exist". That is a false alarm about the wrong
         thing, on the pane somebody opens when stock has gone missing. */
      if (/last_lat|last_lng|last_loc_acc|last_loc_at/.test(String(e && e.message || ''))) {
        /* The audit without a map is still the audit; the audit without itself is an outage.
           PostgREST refuses a whole select over one unknown column, so a deployment that has
           not run the location migration drops back rather than going dark. */
        hasLoc = false;
        devs = await fetchAll(() => db.from('devices').select(DEV_CORE));
      } else if (tableMissing(e)) noDevices = true;
      else throw e;
    }

    /* THE FEEDS, ALL BEST-EFFORT. A missing one costs its columns and nothing else -- an audit
       that refuses to open because one upload has never happened is an audit nobody uses. */
    const feed = async (table, cols) => {
      try { return await fetchAll(() => db.from(table).select(cols)); } catch (ignored) { return []; }
    };
    const [watu, sales, agents, aged] = await Promise.all([
      feed('watu_loans', 'imei, client_name, client_mobile, agent, team, shop, model, '
        + 'model_details, disbursed_date, price, guarantor_name, guarantor_phone, branch'),
      feed('hoop_sales', 'imei, sale_date, branch, agent, client_name, client_phone, model, '
        + 'commission_agent, commission_phone, price'),
      feed('hoop_agents', 'phone, name, role, branch, manager, active'),
      feed('hoop_aged_stock', 'serial, agent, item'),
    ]);

    /* THE EARLIEST RECEIPT WINS where the shop wrote more than one for an IMEI. A later
       receipt against the same handset is a top-up or a correction; the ORIGINAL sale is the
       one this audit is about, and "first catch" has to mean the first sale, not the first row
       the database happened to return. */
    const salesBy = new Map();
    for (const s of sales) {
      const k = String(s.imei || '');
      if (!k) continue;
      const had = salesBy.get(k);
      if (!had || String(s.sale_date || '9999') < String(had.sale_date || '9999')) salesBy.set(k, s);
    }
    const ctx = {
      watu: new Map(watu.filter(r => r.imei).map(r => [String(r.imei), r])),
      sales: salesBy,
      aged: new Map(aged.filter(r => r.serial).map(r => [String(r.serial), r])),
      byName: new Map(agents.filter(r => r.name).map(r => [nameKey(r.name), r])),
      byPhone: new Map(agents.filter(r => r.phone).map(r => [pnorm(r.phone), r])),
      tree: salesTree(agents),
    };

    /* AND THE ONES THAT SOLD WITHOUT EVER BEING LOCKED.
       -----------------------------------------------------------------------------------
         "If a phone imei once reads in sales [in watu deck] and it was in old stock not in
          new stock, move its column data needed into NEW STOCK, so that we can always get the
          update of current activities no matter the stock age."

       The register was the whole population: we locked it, so it is ours to watch. But a
       handset off the old list that turns up SOLD is current activity by any reading -- the
       very thing this pane is opened for -- and leaving it in OLD STOCK would file a live sale
       under "never enrolled, gathering dust".

       So a sold handset joins on the strength of the sale, with no device row behind it. Its
       status reads `haijafungwa` rather than being dressed as one of the four states the
       register can hold: we do not control this phone, and the pane must not imply we do.

       ANY SALE BOOK MOVES IT, AND THE MOVE IS PERMANENT.
       -----------------------------------------------------------------------------------
       Both sale feeds are asked -- the Watu deck and our own shop's export are two uploads of
       the same event, and a handset written in one and not the other is still sold -- and so
       is the stamp we made last time. That third test is what makes this one-way: the decks
       are re-uploaded over themselves with rows deleted, and without it a phone that moved in
       September would reappear in OLD STOCK in October because Watu trimmed its export.

       oldStockIndex() asks the identical question, deliberately. The two lists are defined
       against each other, so the day they disagreed a handset would be on both or on neither
       -- and the whole point of having no `moved` column is that there is only one answer. */
    let joined = [];
    try {
      const have = new Set(devs.map(d => String(d.imei)));
      const olds = await fetchAll(() => db.from('old_stock')
        .select('imei, item, agent, agent_phone, rsm, rsm_phone'));
      joined = olds.filter(o => {
        const k = String(o.imei);
        if (have.has(k)) return false;   // locked on a visit: it is in the register on its own
        return ctx.watu.has(k) || ctx.sales.has(k) || stampedSale(stampedBy.get(k));
      });
    } catch (ignored) { joined = []; }   // no old_stock table yet: the register alone, as before

    const rows = [];
    const changed = [];
    for (const o of joined) {
      /* Stamped exactly like a locked one -- a sale is a sale -- then given the shape of a row
         with no device behind it. */
      const imei = String(o.imei);
      const was = stampedBy.get(imei) || null;
      const f = newStockFill(imei, was, ctx);
      if (f.hits) changed.push(newStockRow(imei, f, was, at));
      rows.push({
        imei,
        rsm: f.row.rsm || o.rsm || '', rsmPhone: f.row.rsm_phone || o.rsm_phone || '',
        agent: f.row.agent || o.agent || '', agentPhone: f.row.agent_phone || o.agent_phone || '',
        customer: f.row.customer || '', customerPhone: f.row.customer_phone || '',
        price: f.row.price == null ? null : num(f.row.price),
        guarantor: f.row.guarantor || '', guarantorPhone: f.row.guarantor_phone || '',
        branch: f.row.branch || '', model: f.row.model || o.item || '',
        saleDate: f.row.sale_date || null,
        status: 'unlocked', neverLocked: true,
        by: '', atMs: null,
        seenAt: null, neverSeen: true, silentDays: null,
        lat: null, lng: null, locAcc: null, locAt: null,
        gaps: NEWSTOCK_FIELDS.filter(k => unanswered(f.row[k])).length,
        src: f.src,
      });
    }
    for (const d of devs) {
      const imei = String(d.imei);
      const was = stampedBy.get(imei) || null;
      const f = newStockFill(imei, was, ctx);
      if (f.hits) changed.push(newStockRow(imei, f, was, at));
      const seen = d.last_seen ? Date.parse(d.last_seen) : null;
      rows.push({
        imei,
        rsm: f.row.rsm || '', rsmPhone: f.row.rsm_phone || '',
        agent: f.row.agent || '', agentPhone: f.row.agent_phone || '',
        /* devices.customer is stamped at the till by whoever sold it, so it stands in where
           no sales feed has ever mentioned this handset. */
        customer: f.row.customer || d.customer || '', customerPhone: f.row.customer_phone || '',
        price: f.row.price == null ? null : num(f.row.price),
        guarantor: f.row.guarantor || '', guarantorPhone: f.row.guarantor_phone || '',
        branch: f.row.branch || '', model: f.row.model || d.item || '',
        saleDate: f.row.sale_date || null,
        /* THE THREE WORDS THE OWNER USES, and the fourth this register also has. `lost` is not
           in their list because it is rare -- but calling it "locked" because that is what the
           handset does would hide a written-off phone inside the locked count, which is the
           one number this audit is read for. */
        status: NEWSTOCK_STATE[String(d.state || '')] || String(d.state || ''),
        neverLocked: false,
        by: d.state_by || '', atMs: d.state_at ? Date.parse(d.state_at) : null,
        /* The position rides under the status because they answer one question together --
           what is this handset doing, and where. `locAt` is the fix's OWN age, not the beat's:
           collapsing them would let the register claim a phone is somewhere it left days ago.
           `locAcc` travels too, because a 2,000m fix is a suburb and drawing it as a pin sends
           somebody to the wrong building. */
        lat: d.last_lat == null ? null : Number(d.last_lat),
        lng: d.last_lng == null ? null : Number(d.last_lng),
        locAcc: d.last_loc_acc == null ? null : Number(d.last_loc_acc),
        locAt: d.last_loc_at ? Date.parse(d.last_loc_at) : null,
        seenAt: seen, neverSeen: !seen,
        silentDays: seen ? Math.max(0, Math.floor((now - seen) / 86400000)) : null,
        gaps: NEWSTOCK_FIELDS.filter(k => unanswered(f.row[k])).length,
        src: f.src,
      });
    }

    /* THE STAMP. Only rows that actually GAINED something are written -- on a steady morning
       that is none of them -- and each one carries the whole merged row, so a column filled
       last month survives a feed that has since gone blank. */
    let stamped = 0;
    if (!notReady && !isReadOnly(user) && changed.length) {
      for (let i = 0; i < changed.length; i += 200) {
        const slice = changed.slice(i, i + 200);
        const { error } = await db.from('stock_audit').upsert(slice, { onConflict: 'imei' });
        /* POSTGREST REFUSES BY RESOLVING, NOT BY THROWING. A stamp that reported success on a
           write the database rejected is the exact failure this table exists to prevent: the
           deck moves on, and the office believes the sale was captured. */
        if (error) {
          if (!tableMissing(error)) throw new Error(error.message);
          notReady = true; stamped = 0; break;
        }
        stamped += slice.length;
      }
    }

    /* WORST FIRST: a handset that has never once spoken, then the longest silence. That is the
       order somebody chasing stock wants, and every column still sorts on its own click. */
    rows.sort((x, y) => (y.neverSeen ? 1 : 0) - (x.neverSeen ? 1 : 0)
      || (y.silentDays || 0) - (x.silentDays || 0)
      || String(x.imei).localeCompare(String(y.imei)));

    const want = String(a.status || '').trim();
    const q = K(a.q || '');
    const shown = rows.filter(r => {
      if (want && r.status !== want) return false;
      if (!q) return true;
      return [r.imei, r.customer, r.customerPhone, r.agent, r.rsm, r.guarantor, r.branch]
        .some(v => K(v).includes(q));
    });

    const count = st => rows.filter(r => r.status === st).length;
    return { ok: true, notReady, noDevices, hasLoc,
      /* `wk` slides the top-and-bottom board only -- never the table, the tiles or the two
         progress cards, which is why it is read here and nowhere else in this function. */
      newSales: newStockSales(rows, now, agents, a.wk),
      notReadyNote: notReady ? NEWSTOCK_NOT_READY : '',
      asOf: now, stamped,
      rows: shown.slice(0, 2000), shown: shown.length,
      status: want, q: String(a.q || ''),
      counts: {
        total: rows.length,
        locked: count('locked'), unlocked: count('unlocked'),
        achia: count('achia'), lost: count('lost'),
        never: rows.filter(r => r.neverSeen).length,
        quiet7: rows.filter(r => r.silentDays != null && r.silentDays >= 7).length,
        /* Sold, and we never had the lock on it. The number the ground visits exist to bring
           down, and the one that would be invisible if a sale on an old handset stayed filed
           under "never enrolled". */
        soldUnlocked: rows.filter(r => r.neverLocked).length,
        /* HOW MUCH OF THE SALE WE STILL DO NOT KNOW. The number that says whether the feeds
           are answering -- and the one that should be falling, upload after upload. */
        gappy: rows.filter(r => r.gaps > 0).length,
      } };
  },

  /* =====================================================================================
     LOSS AND DAMAGE -- the price list, the case, and the acknowledgement of liability.
     =====================================================================================
       Finance SOP H     valuation, liability and recovery, handled centrally by Finance
       Finance SOP H.1   the root cause; "a police report is REQUIRED for suspected theft"
       Finance SOP H.2   "The Finance Officer values the missing/damaged device using the
                          CURRENT PRICE LIST"
       Finance SOP H.3   the custodian is liable and must reimburse at the assessed value
       Finance SOP H.4   the recovery method, approved by the GM and Finance
       Finance SOP H.5   "The custodian SIGNS an acknowledgment of liability and repayment plan"
       Store SOP C.7     the store's verification opens the case
       RSM SOP F, CSM SOP G   the custodian named, at the device's prevailing value

     FOUR SOPs POINT AT THIS ONE PROCESS and none of them could open a case, because there was
     nowhere to open one. The store finds a phone missing; the RSM is liable; the CSM enforces;
     Finance values and recovers. One table, one price list, one trail.

     THE VALUE IS COPIED, NOT LOOKED UP LATER. H.2 says "the current price list", which means
     it moves -- and a price change next month must not re-price a debt somebody has already
     signed for. Two navs: `lossreq` opens and reads own, `loss` is Finance's desk. */

  /** The current price list (SOP H.2). Read by both navs; written only by the desk. */
  async priceList(db, user) {
    requireAnyNav(user, ['loss', 'lossreq']);
    let rows = [];
    let notReady = false;
    try {
      rows = await fetchAll(() => db.from('device_prices').select('item, amount, note, updated_by, updated_at'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      notReady = true;
    }
    let items = [];
    try {
      const models = await fetchAll(() => db.from('watu_loans').select('model'));
      items = [...new Set(models.map(m => K(m.model || '')).filter(Boolean))].sort();
    } catch (e) { items = []; }
    return { ok: true, notReady, items,
      prices: rows.map(r => ({ item: r.item, amount: num(r.amount), note: r.note || '',
        updatedBy: r.updated_by || '', updatedAt: r.updated_at ? Date.parse(r.updated_at) : null }))
        .sort((x, y) => (x.item < y.item ? -1 : 1)) };
  },

  async priceSave(db, user, args) {
    requireNav(user, 'loss');
    requireWrite(user);
    const a = args || {};
    const item = K(a.item);
    if (!item) bad('Chagua modeli. / Choose the model.');
    if (a.amount == null || String(a.amount).trim() === '') bad('Weka bei. / Set the price.');
    const amount = Math.round(num(a.amount));
    if (!(amount >= 0) || amount > 1e9) bad('Bei si sahihi. / That is not a price.');
    const { error } = await db.from('device_prices').upsert([{ item, amount,
      note: String(a.note == null ? '' : a.note).trim().slice(0, 500) || null,
      updated_by: user.name || '', updated_at: new Date().toISOString() }], { onConflict: 'item' });
    if (error) {
      if (tableMissing(error)) bad(LOSS_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, item, amount };
  },

  async priceDelete(db, user, args) {
    requireNav(user, 'loss');
    requireWrite(user);
    const item = K((args && args.item) || '');
    if (!item) bad('Chagua modeli. / Choose the model.');
    const { error } = await db.from('device_prices').delete().eq('item', item);
    if (error) {
      if (tableMissing(error)) bad(LOSS_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, item };
  },

  /** OPEN A CASE (Store SOP C.7). The store keeper who finds the shortage opens it; so does
      anybody else who holds the nav. Valued straight away from the price list where the model
      is on it, because a case with no number attached is a conversation, not a liability. */
  async lossRaise(db, user, args) {
    requireAnyNav(user, ['loss', 'lossreq']);
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const custodian = S(a.custodian, 120);
    if (!custodian) bad('Andika aliyekuwa na simu. / Name the custodian who held it.');
    const cause = String(a.cause || '').trim().toLowerCase();
    if (!LOSS_CAUSES.includes(cause)) bad('Chagua chanzo. / Choose the root cause.');
    /* SOP H.1: "A police report is required for suspected theft or robbery." The one place the
       SOP names a document outright, so it is the one the server insists on. */
    const policeRef = S(a.policeRef, 120);
    if (cause === 'theft' && !policeRef) {
      bad('Wizi unahitaji namba ya ripoti ya polisi (SOP H.1). / Theft needs a police report reference.');
    }
    const imei = String(a.imei == null ? '' : a.imei).replace(/\D/g, '').slice(0, 17);
    if (imei && (imei.length < 14 || imei.length > 17)) bad('IMEI si sahihi. / That IMEI is not a valid length.');
    const item = K(a.item).slice(0, 120);
    /* SOP H.2: valued from the CURRENT list, and the figure is copied onto the case. */
    let value = null, source = '';
    if (item) {
      try {
        const { data } = await db.from('device_prices').select('amount').eq('item', item).maybeSingle();
        if (data && data.amount != null) { value = num(data.amount); source = 'price list ' + item; }
      } catch (e) { value = null; }
    }
    const at = new Date().toISOString();
    const row = {
      opened_at: at, updated_at: at,
      staff_code: user.code || null, staff_name: user.name || '', staff_role: user.role || '',
      custodian, imei: imei || null, item: item || null,
      cause, police_ref: policeRef || null, details: S(a.details, 4000) || null,
      value_amount: value, value_source: source || null,
      status: value == null ? 'open' : 'valued', recovered: 0, updated_by: user.name || '',
    };
    const { data, error } = await db.from('loss_cases').insert([row]).select('id');
    if (error) {
      if (tableMissing(error)) bad(LOSS_NOT_READY);
      throw new Error(error.message);
    }
    const id = data && data[0] ? String(data[0].id) : null;
    const mail = await sendMail(db, { toKey: 'LOSS_EMAIL',
      subject: 'HOOPLOAN — simu imepotea au imeharibika / loss or damage: ' + custodian
        + (item ? ' (' + item + ')' : ''),
      html: noticeHtml('Kesi mpya ya upotevu / New loss or damage case', [
        ['Aliyekuwa nayo / Custodian', custodian], ['IMEI', imei || '—'], ['Modeli / Model', item || '—'],
        ['Chanzo / Cause', cause], ['Ripoti ya polisi / Police report', policeRef || '—'],
        ['Thamani / Assessed value', value == null ? 'haijathaminiwa / not valued yet' : 'TZS ' + money0(value)],
        ['Amefungua / Opened by', user.name || ''], ['Maelezo / Details', String(row.details || '').slice(0, 400)],
      ], 'Fungua Upotevu na uharibifu kwenye portal. / Open the loss and damage pane.') });
    return { ok: true, id, value, status: row.status, emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
  },

  /** The desk sees every case; a raiser sees only their own. */
  async lossList(db, user, args) {
    requireAnyNav(user, ['loss', 'lossreq']);
    const a = args || {};
    const desk = navsFor(user).includes('loss');
    let rows;
    try {
      rows = await fetchAll(() => {
        const q = db.from('loss_cases').select(LOSS_COLS);
        return desk ? q : q.eq('staff_code', user.code || '~none~');
      });
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, desk,
        counts: { open: 0, acknowledged: 0, recovering: 0, settled: 0 },
        totals: { value: 0, recovered: 0, outstanding: 0 } };
    }
    const all = rows.map(r => lossRow(r, user.code));
    const want = String(a.state || '').trim();
    const shown = all
      .filter(r => want === 'all' ? true : want ? r.status === want
        : (r.status !== 'settled' && r.status !== 'written_off'))
      .sort(lossWorkFirst);
    const live = all.filter(r => r.status !== 'settled' && r.status !== 'written_off');
    return { ok: true, rows: shown, desk, causes: LOSS_CAUSES, methods: LOSS_METHODS, states: LOSS_STATES,
      counts: {
        open: all.filter(r => r.status === 'open').length,
        valued: all.filter(r => r.status === 'valued').length,
        acknowledged: all.filter(r => r.status === 'acknowledged').length,
        recovering: all.filter(r => r.status === 'recovering').length,
        settled: all.filter(r => r.status === 'settled').length,
      },
      totals: {
        value: live.reduce((s, r) => s + (r.value || 0), 0),
        recovered: all.reduce((s, r) => s + r.recovered, 0),
        outstanding: live.reduce((s, r) => s + (r.outstanding || 0), 0),
        unvalued: all.filter(r => r.value == null && r.status !== 'written_off').length,
      } };
  },

  async lossNotes(db, user, args) {
    requireAnyNav(user, ['loss', 'lossreq']);
    const id = String((args && args.id) || '').trim();
    if (!isUuid(id)) bad('Kesi haijachaguliwa. / No case chosen.');
    if (!navsFor(user).includes('loss')) {
      let own;
      try {
        own = await fetchAll(() => db.from('loss_cases').select('id, staff_code').eq('id', id));
      } catch (e) {
        if (!tableMissing(e)) throw e;
        return { ok: true, notes: [], notReady: true };
      }
      const r = own.find(x => String(x.id) === id);
      if (!r || String(r.staff_code || '') !== String(user.code || '')) bad('Kesi haipo. / That case no longer exists.');
    }
    let rows = [];
    try {
      rows = await fetchAll(() => db.from('loss_case_notes').select('at, by_name, note, change').eq('case_id', id));
    } catch (e) { rows = []; }
    return { ok: true, notes: rows.map(n => ({ at: n.at ? Date.parse(n.at) : null, by: n.by_name || '',
      note: n.note || '', change: n.change || '' })).sort((x, y) => (x.at || 0) - (y.at || 0)) };
  },

  /** MOVE A CASE (SOP H.2-H.5). Valuing, agreeing the recovery, taking the custodian's
      acknowledgement, recording money in, and settling. The desk's grant; a raiser may only
      add a note to their own case. */
  async lossUpdate(db, user, args) {
    requireAnyNav(user, ['loss', 'lossreq']);
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Kesi haijachaguliwa. / No case chosen.');
    let rows;
    try {
      rows = await fetchAll(() => db.from('loss_cases').select(LOSS_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(LOSS_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    const desk = navsFor(user).includes('loss');
    if (!row || (!desk && String(row.staff_code || '') !== String(user.code || ''))) {
      bad('Kesi haipo. / That case no longer exists.');
    }
    const note = S(a.note, 2000);
    const at = new Date().toISOString();
    const patch = { updated_by: user.name || '', updated_at: at };
    let change = null;
    if (desk) {
      // SOP H.2: the valuation, whether from the list or assessed by hand.
      if (a.value != null && String(a.value).trim() !== '') {
        const v = Math.round(num(a.value));
        if (!(v >= 0) || v > 1e9) bad('Thamani si sahihi. / That is not a value.');
        patch.value_amount = v;
        patch.value_source = S(a.valueSource, 200) || 'assessed by ' + (user.name || '');
        if (row.status === 'open') { patch.status = 'valued'; change = 'open>valued'; }
      }
      // SOP H.4: the recovery method, and who approved it.
      if (a.recoveryMethod != null && String(a.recoveryMethod).trim() !== '') {
        const meth = String(a.recoveryMethod).trim().toLowerCase();
        if (!LOSS_METHODS.includes(meth)) bad('Njia ya kurejesha si sahihi. / Unknown recovery method.');
        patch.recovery_method = meth;
        patch.recovery_note = S(a.recoveryNote, 2000) || null;
        patch.approved_by = user.name || ''; patch.approved_at = at;
      }
      /* SOP H.5: the custodian signs. A case cannot be acknowledged before it has a value --
         nobody signs for a number nobody has worked out. */
      if (a.acknowledgedBy != null && String(a.acknowledgedBy).trim() !== '') {
        const value = patch.value_amount != null ? patch.value_amount
          : (row.value_amount == null ? null : num(row.value_amount));
        if (value == null) {
          bad('Thamini kwanza kabla ya saini ya mdaiwa (SOP H.2 kabla ya H.5). '
            + '/ Value the device before the custodian acknowledges it.');
        }
        patch.acknowledged_by = S(a.acknowledgedBy, 120);
        patch.acknowledged_at = at;
        if (row.status !== 'settled') { change = row.status + '>acknowledged'; patch.status = 'acknowledged'; }
      }
      // Money in. Never more than the case is worth, and reaching the value settles it.
      if (a.recovered != null && String(a.recovered).trim() !== '') {
        const got = Math.round(num(a.recovered));
        if (!(got >= 0)) bad('Kiasi kilichorejeshwa si sahihi. / That is not an amount recovered.');
        const value = patch.value_amount != null ? patch.value_amount
          : (row.value_amount == null ? null : num(row.value_amount));
        if (value != null && got > value) {
          bad('Huwezi kurejesha zaidi ya thamani ya simu (TZS ' + money0(value) + '). '
            + '/ You cannot recover more than the device was valued at.');
        }
        patch.recovered = got;
        if (value != null && got >= value) {
          patch.status = 'settled'; patch.settled_at = at; change = (row.status || 'open') + '>settled';
        } else if (got > 0 && row.status !== 'settled') {
          patch.status = 'recovering'; change = change || ((row.status || 'open') + '>recovering');
        }
      }
      // An explicit status, last, so it wins over anything inferred above.
      if (a.status != null && String(a.status).trim() !== '') {
        const st = String(a.status).trim().toLowerCase();
        if (!LOSS_STATES.includes(st)) bad('Hali si sahihi. / Unknown status.');
        if (st !== row.status) {
          change = row.status + '>' + st;
          patch.status = st;
          if (st === 'settled') patch.settled_at = at;
          if (st === 'written_off' && !note) bad('Andika sababu ya kufuta deni. / Say why it is being written off.');
        }
      }
    }
    if (!note && !change && Object.keys(patch).length === 2) bad('Hakuna kilichobadilika. / Nothing to save.');
    /* GUARDED on what was read, so two people cannot silently overwrite each other. */
    const { data, error } = await db.from('loss_cases').update(patch)
      .eq('id', id).eq('updated_at', row.updated_at).select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Kesi hii imebadilishwa na mtu mwingine sasa hivi — ifungue upya. / Somebody else just changed this case; reopen it.');
    if (note || change) {
      const { error: nErr } = await db.from('loss_case_notes').insert([{ case_id: id, at,
        by_code: user.code || null, by_name: user.name || '',
        note: note || (change ? change.replace('>', ' \u2192 ') : ''), change }]);
      if (nErr) throw new Error(nErr.message);
    }
    return { ok: true, id, status: patch.status || row.status, change };
  },

  /* =====================================================================================
     COMMISSION -- the rate table, the run, the payment sheet, and the CLEARED stamp.
     =====================================================================================
       Finance SOP A.1  the daily 9:00 AM and monthly schedules, generated by the system
       Finance SOP A.2  verify each RSM/agent's commission against the sales records
       Finance SOP A.3  "Cross-check that each phone being paid for is correctly linked to
                         the agent who sold it, before approving payment"
       Finance SOP A.4  the payment sheet -- agent name, sales quantity, commission amount,
                         phone number, and the RSM the agent falls under -- forwarded to the
                         Administration approval group for sign-off
       Finance SOP A.6  "mark the payment as 'cleared' in the system IMMEDIATELY, to prevent
                         duplicate payment"
       Finance SOP A    the Commission Audit Checklist, filed against every cycle

     THE POINT IS A.6. The arithmetic could be done in a spreadsheet; what a spreadsheet
     cannot do is refuse to pay the same period twice. A run is unique per (period, kind) in
     the database, and once it carries cleared_at nothing pays it again.

     A RUN IS A SNAPSHOT, NOT A VIEW. The lines are written down when the run is built,
     because a sheet that silently re-computes itself cannot be audited: the figure signed off
     on Tuesday must still be the figure on Friday after another deck upload lands. Rebuilding
     is allowed while it is a draft and refused the moment anybody has signed.

     Two navs: `commission` builds, pays and clears (Finance); `commappr` signs off (the
     Administration approval group). Nobody can do both halves unless the owner ticks both. */

  /** The rate table, and the words the form offers for it. */
  async commRates(db, user) {
    requireAnyNav(user, ['commission', 'commappr']);
    let rows = [];
    let notReady = false;
    try {
      rows = await fetchAll(() => db.from('commission_rates').select('role, item, amount, updated_by, updated_at'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      notReady = true;
    }
    let roles = [], items = [];
    try {
      const agents = await fetchAll(() => db.from('hoop_agents').select('role'));
      roles = [...new Set(agents.map(a => K(a.role || '').replace(/\s+/g, '_')).filter(Boolean))].sort();
    } catch (e) { roles = []; }
    try {
      const models = await fetchAll(() => db.from('watu_loans').select('model'));
      items = [...new Set(models.map(m => K(m.model || '')).filter(Boolean))].sort();
    } catch (e) { items = []; }
    return { ok: true, notReady, roles: ['ANY'].concat(roles), items: ['ANY'].concat(items),
      rates: rows.map(r => ({ role: r.role, item: r.item, amount: num(r.amount),
        updatedBy: r.updated_by || '', updatedAt: r.updated_at ? Date.parse(r.updated_at) : null }))
        .sort((x, y) => (x.role < y.role ? -1 : x.role > y.role ? 1 : (x.item < y.item ? -1 : 1))) };
  },

  async commRateSave(db, user, args) {
    requireNav(user, 'commission');
    requireWrite(user);
    const a = args || {};
    const role = K(a.role).replace(/\s+/g, '_') || 'ANY';
    const item = K(a.item) || 'ANY';
    if (a.amount == null || String(a.amount).trim() === '') bad('Weka kiasi. / Set the amount.');
    const amount = Math.round(num(a.amount));
    if (!(amount >= 0) || amount > 1e9) bad('Kiasi si sahihi. / That amount is not a rate.');
    const { error } = await db.from('commission_rates').upsert([{ role, item, amount,
      updated_by: user.name || '', updated_at: new Date().toISOString() }], { onConflict: 'role,item' });
    if (error) {
      if (tableMissing(error)) bad(COMM_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, role, item, amount };
  },

  async commRateDelete(db, user, args) {
    requireNav(user, 'commission');
    requireWrite(user);
    const a = args || {};
    const role = K(a.role).replace(/\s+/g, '_');
    const item = K(a.item);
    if (!role || !item) bad('Kiwango hakijachaguliwa. / No rate chosen.');
    const { error } = await db.from('commission_rates').delete().eq('role', role).eq('item', item);
    if (error) {
      if (tableMissing(error)) bad(COMM_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, role, item };
  },

  /** Every run, newest first, so Finance can see what is outstanding and what was cleared. */
  async commRuns(db, user, args) {
    requireAnyNav(user, ['commission', 'commappr']);
    const a = args || {};
    let rows = [];
    try {
      rows = await fetchAll(() => db.from('commission_runs').select(COMM_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, counts: { draft: 0, approved: 0, paid: 0 } };
    }
    const all = rows.map(commRow);
    const want = String(a.status || '').trim();
    return { ok: true,
      rows: all.filter(r => !want || r.status === want)
        .sort((x, y) => (y.period < x.period ? -1 : y.period > x.period ? 1 : 0) || (y.createdAt || 0) - (x.createdAt || 0)),
      counts: { draft: all.filter(r => r.status === 'draft').length,
        approved: all.filter(r => r.status === 'approved').length,
        paid: all.filter(r => r.status === 'paid').length } };
  },

  /** BUILD OR REBUILD A DRAFT (SOP A.1). Reads the sales, prices them, and writes the sheet
      down. Refused once anybody has signed: a signed sheet that moves is not a sheet. */
  async commBuild(db, user, args) {
    requireNav(user, 'commission');
    requireWrite(user);
    const a = args || {};
    const kind = String(a.kind || 'monthly').trim().toLowerCase() === 'daily' ? 'daily' : 'monthly';
    const period = String(a.period || '').trim();
    const { from, to } = commRange(period, kind);

    let existing = null;
    try {
      const rows = await fetchAll(() => db.from('commission_runs').select(COMM_COLS)
        .eq('period', period).eq('kind', kind));
      existing = rows[0] || null;
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(COMM_NOT_READY);
    }
    if (existing && existing.status !== 'draft') {
      bad('Kipindi hiki tayari kime' + (existing.status === 'paid' ? 'lipwa' : 'idhinishwa')
        + '; huwezi kukihesabu upya. / This cycle has already been signed off — it cannot be rebuilt.');
    }

    const [loans, shop, agents, rateRows] = await Promise.all([
      fetchAll(() => db.from('watu_loans').select('imei, agent, model, price, disbursed_date')
        .gte('disbursed_date', from).lte('disbursed_date', to)),
      /* SOP A.3: the shop's own book, to check each phone is credited to the agent who sold
         it. A disagreement is a DISPUTE, and a disputed phone is not paid this cycle. */
      fetchAll(() => db.from('hoop_sales').select('imei, commission_agent, commission_phone')
        .gte('sale_date', dayShift(from, -7)).lte('sale_date', dayShift(to, 7))).catch(() => []),
      fetchAll(() => db.from('hoop_agents').select('name, phone, role, branch, manager'))
        .catch(() => fetchAll(() => db.from('hoop_agents').select('name, phone, role, branch'))),
      fetchAll(() => db.from('commission_rates').select('role, item, amount')).catch(() => []),
    ]);
    const rates = new Map(rateRows.map(r => [K(r.role) + '|' + K(r.item), r]));
    const idx = managerIndex(agents);
    const regBy = new Map(agents.filter(x => x.name).map(x => [nameKey(x.name), x]));
    const shopBy = new Map();
    for (const s of shop) if (s.imei) shopBy.set(String(s.imei), s);
    const words = s => new Set(String(s || '').toUpperCase().split(/\s+/).filter(Boolean));
    const overlap = (x, y) => { for (const w of words(x)) if (words(y).has(w)) return true; return false; };

    const by = new Map();
    let disqualified = 0;
    for (const l of loans) {
      const who = String(l.agent || '').trim();
      if (!who) { disqualified++; continue; }        // nobody to pay
      const k = nameKey(who);
      let g = by.get(k);
      if (!g) {
        const reg = regBy.get(k) || null;
        g = { agent: who, agentPhone: reg ? (reg.phone || '') : '', role: reg ? (reg.role || '') : '',
          rsm: idx.of(who), qty: 0, amount: 0, disqualified: 0, noRate: 0, disputed: 0 };
        by.set(k, g);
      }
      // SOP A.3: the shop says somebody else sold it -> not paid until that is settled.
      const s = shopBy.get(String(l.imei));
      if (s && s.commission_agent && !overlap(s.commission_agent, who)) {
        g.disqualified++; g.disputed++; disqualified++; continue;
      }
      const rate = commRateOf(rates, g.role, l.model);
      if (rate == null) { g.disqualified++; g.noRate++; disqualified++; continue; }
      g.qty++; g.amount += rate;
    }
    const lines = [...by.values()].filter(g => g.qty || g.disqualified)
      .sort((x, y) => y.amount - x.amount || (x.agent < y.agent ? -1 : 1));
    const totalQty = lines.reduce((s, g) => s + g.qty, 0);
    const totalAmount = lines.reduce((s, g) => s + g.amount, 0);
    const now = new Date().toISOString();

    let runId = existing ? String(existing.id) : null;
    if (runId) {
      const { error } = await db.from('commission_runs')
        .update({ built_at: now, total_qty: totalQty, total_amount: totalAmount,
          disqualified, updated_at: now })
        .eq('id', runId).eq('status', 'draft');
      if (error) throw new Error(error.message);
      const { error: dErr } = await db.from('commission_lines').delete().eq('run_id', runId);
      if (dErr) throw new Error(dErr.message);
    } else {
      const { data, error } = await db.from('commission_runs').insert([{
        period, kind, status: 'draft', created_at: now, created_by: user.name || '', built_at: now,
        total_qty: totalQty, total_amount: totalAmount, disqualified, updated_at: now,
      }]).select('id');
      if (error) {
        if (tableMissing(error)) bad(COMM_NOT_READY);
        throw new Error(error.message);
      }
      runId = data && data[0] ? String(data[0].id) : null;
    }
    if (lines.length) {
      const note = g => [g.disputed ? g.disputed + ' mgogoro / disputed' : '',
        g.noRate ? g.noRate + ' hazina kiwango / unpriced' : ''].filter(Boolean).join('; ');
      const { error } = await db.from('commission_lines').insert(lines.map(g => ({
        run_id: runId, agent: g.agent, agent_phone: g.agentPhone || null, rsm: g.rsm || null,
        role: g.role || null, qty: g.qty, amount: g.amount, disqualified: g.disqualified,
        note: note(g) || null,
      })));
      if (error) throw new Error(error.message);
    }
    return { ok: true, id: runId, period, kind, from, to,
      totalQty, totalAmount, disqualified, agents: lines.length };
  },

  /** One run and its sheet -- the five fields SOP A.4 requires, per agent. */
  async commSheet(db, user, args) {
    requireAnyNav(user, ['commission', 'commappr']);
    const id = String((args && args.id) || '').trim();
    if (!isUuid(id)) bad('Kipindi hakijachaguliwa. / No cycle chosen.');
    let runs;
    try {
      runs = await fetchAll(() => db.from('commission_runs').select(COMM_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, run: null, lines: [], notReady: true };
    }
    const r = runs.find(x => String(x.id) === id);
    if (!r) bad('Kipindi hakipo. / That cycle no longer exists.');
    let lines = [];
    try {
      lines = await fetchAll(() => db.from('commission_lines')
        .select('agent, agent_phone, rsm, role, qty, amount, disqualified, note').eq('run_id', id));
    } catch (e) { lines = []; }
    return { ok: true, run: commRow(r), checks: COMM_CHECKS.map(([js, , label]) => ({ key: js, label })),
      lines: lines.map(l => ({ agent: l.agent, agentPhone: l.agent_phone || '', rsm: l.rsm || '',
        role: l.role || '', qty: num(l.qty), amount: num(l.amount),
        disqualified: num(l.disqualified), note: l.note || '' }))
        .sort((x, y) => y.amount - x.amount || (x.agent < y.agent ? -1 : 1)) };
  },

  /** SIGN-OFF (SOP A.4). The Administration approval group's own grant; rejecting sends the
      sheet back to draft so Finance can fix it and rebuild. */
  async commDecide(db, user, args) {
    requireNav(user, 'commappr');
    requireWrite(user);
    const a = args || {};
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Kipindi hakijachaguliwa. / No cycle chosen.');
    let runs;
    try {
      runs = await fetchAll(() => db.from('commission_runs').select(COMM_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(COMM_NOT_READY);
    }
    const r = runs.find(x => String(x.id) === id);
    if (!r) bad('Kipindi hakipo. / That cycle no longer exists.');
    if (r.status === 'paid') bad('Kipindi hiki tayari kimelipwa. / That cycle has already been paid.');
    const approve = a.approve === true;
    const comment = String(a.comment == null ? '' : a.comment).trim().slice(0, 2000);
    if (!approve && !comment) bad('Sababu inahitajika ukirudisha. / A reason is required when sending it back.');
    if (approve && !num(r.total_qty)) bad('Huwezi kuidhinisha karatasi tupu. / There is nothing on this sheet to approve.');
    const now = new Date().toISOString();
    const patch = approve
      ? { status: 'approved', approved_by: user.name || '', approved_at: now, comment: comment || null, updated_at: now }
      : { status: 'draft', approved_by: null, approved_at: null, comment, updated_at: now };
    const { data, error } = await db.from('commission_runs').update(patch)
      .eq('id', id).eq('status', r.status).select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Kipindi hiki kimebadilishwa na mtu mwingine sasa hivi. / Somebody else just changed this cycle.');
    return { ok: true, id, status: patch.status };
  },

  /** PAY AND CLEAR (SOP A.5-A.7). The checklist is a GATE: all five ticks and a payment
      reference, or nothing moves. Guarded on cleared_at being empty, which is what stops the
      same cycle being paid twice however many people press the button. */
  async commPay(db, user, args) {
    requireNav(user, 'commission');
    requireWrite(user);
    const a = args || {};
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Kipindi hakijachaguliwa. / No cycle chosen.');
    let runs;
    try {
      runs = await fetchAll(() => db.from('commission_runs').select(COMM_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(COMM_NOT_READY);
    }
    const r = runs.find(x => String(x.id) === id);
    if (!r) bad('Kipindi hakipo. / That cycle no longer exists.');
    if (r.cleared_at || r.status === 'paid') {
      bad('Kipindi hiki kimeshalipwa na kufungwa — hakiwezi kulipwa mara ya pili (SOP A.6). '
        + '/ This cycle is already paid and cleared; it cannot be paid twice.');
    }
    if (r.status !== 'approved') bad('Inahitaji idhini kabla ya malipo (SOP A.4). / It needs sign-off before payment.');
    const ref = String(a.paymentRef == null ? '' : a.paymentRef).trim().slice(0, 120);
    if (!ref) bad('Andika kumbukumbu ya malipo. / Give the payment reference (SOP A.7).');
    const checks = a.checks || {};
    const missing = COMM_CHECKS.filter(([js]) => checks[js] !== true);
    if (missing.length) {
      bad('Orodha ya ukaguzi haijakamilika: ' + missing.map(x => x[2].split(' / ')[0]).join('; ')
        + '. / The commission audit checklist is not complete.');
    }
    const now = new Date().toISOString();
    const patch = { status: 'paid', paid_by: user.name || '', paid_at: now, payment_ref: ref,
      cleared_at: now, updated_at: now };
    for (const [js, col] of COMM_CHECKS) patch[col] = true;
    /* GUARDED ON cleared_at BEING NULL. Two people pressing Pay at the same moment: the second
       update matches nothing and is told the cycle is already cleared. */
    const { data, error } = await db.from('commission_runs').update(patch)
      .eq('id', id).eq('status', 'approved').is('cleared_at', null).select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) {
      bad('Kipindi hiki kimeshalipwa sasa hivi na mtu mwingine (SOP A.6). / Somebody else just paid and cleared this cycle.');
    }
    return { ok: true, id, status: 'paid', paymentRef: ref, clearedAt: Date.parse(now) };
  },

  /* =====================================================================================
     SALES TARGETS -- set them, then measure the month against them.
     =====================================================================================
       CSM SOP B.3  "Set regional targets for each RSM and monitor performance against them"
       CSM SOP A.2  "Hold RSMs accountable for the performance of their respective regions"
       RSM SOP B.1  "Set and monitor sales targets for each agent/team leader"
       RSM SOP B.3  "Review performance data weekly and monthly, and identify reasons for
                     any decline"

     The Sales performance board answers "how much did we sell". It could never answer
     "against what", because nothing here held a target for a PERSON -- only
     SALES_DAILY_TARGET, one company-wide number per day. A regional target and an agent's
     target are different numbers set by different people, and the SOP asks for both.

     FOUR SCOPES OFF ONE READ. agent, rsm, branch and company are the same rows counted by a
     different key -- that is what a pivot is -- so this must never be four reads. The RSM
     line comes from the register: an agent's own `manager` if somebody set one, else the
     Regional_Manager in the same branch.

     A ROW WITH NO SALES IS THE POINT. An agent who sold nothing against a target of thirty
     is exactly who this report exists to name, so every target appears whether or not it has
     a sale behind it.

     Budget: 1 date-bounded, team-scoped read of watu_loans + 1 bounded register read + 1
     read of the month's targets. */
  async targetsView(db, user, args) {
    requireNav(user, 'targets');
    const a = args || {};
    const period = isMonth(a.period) ? String(a.period) : todayKey().slice(0, 7);
    const { from, to } = monthDays(period);
    /* The register's `branch` column post-dates some deployments, exactly as salesWeek found. */
    const FULL = 'imei, disbursed_date, price, agent, team, branch';
    const BARE = 'imei, disbursed_date, price, agent, team';
    let sales = [];
    try {
      sales = await fetchAll(() => scopeQ(user, db.from('watu_loans').select(FULL)
        .gte('disbursed_date', from).lte('disbursed_date', to)));
    } catch (e) {
      if (!/branch/i.test(String(e && e.message))) throw e;
      sales = await fetchAll(() => scopeQ(user, db.from('watu_loans').select(BARE)
        .gte('disbursed_date', from).lte('disbursed_date', to)));
    }
    let agents = [];
    try {
      agents = await fetchAll(() => db.from('hoop_agents').select('name, role, branch, manager, active'));
    } catch (e) {
      // Before the migration the register has no `manager`; the branch fallback still works.
      if (!/manager/i.test(String(e && e.message))) throw e;
      agents = await fetchAll(() => db.from('hoop_agents').select('name, role, branch, active'));
    }
    let targets = [];
    let notReady = false;
    try {
      targets = await fetchAll(() => db.from('sales_targets')
        .select('period, scope, name, target_qty, target_amount, note, set_by, set_at').eq('period', period));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      notReady = true;
    }
    const idx = managerIndex(agents);
    /* ONE PASS, FOUR KEYS. A sale with no agent named is still a company sale, and saying so
       is better than dropping it: a total that does not match the board is a total nobody
       trusts. */
    const buckets = { agent: new Map(), rsm: new Map(), branch: new Map(), company: new Map() };
    const add = (scope, name, price) => {
      const key = nameKey(name) || '?';
      let g = buckets[scope].get(key);
      if (!g) { g = { name: String(name || '—'), qty: 0, amount: 0 }; buckets[scope].set(key, g); }
      g.qty++; g.amount += num(price);
    };
    for (const s of sales) {
      const who = String(s.agent || '').trim();
      add('agent', who || '(hakuna ajenti / no agent)', s.price);
      const rsm = who ? idx.of(who) : '';
      add('rsm', rsm || '(hakuna RSM / no manager)', s.price);
      add('branch', String(s.branch || idx.branchOf(who) || s.team || '—'), s.price);
      add('company', 'ALL', s.price);
    }
    const tBy = new Map();
    /* A role target is keyed on the ROLE, not on a person's name, so it is normalised the way
       the register spells roles rather than the way people are spelled. */
    for (const t of targets) {
      const k = String(t.scope) === 'role' ? roleKey(t.name) : nameKey(t.name);
      tBy.set(String(t.scope) + '|' + k, t);
    }
    const pct = (got, want) => (want == null || !(num(want) > 0)) ? null : Math.round((num(got) / num(want)) * 100);
    /* THE LADDER. Built once and walked per row: a target set on an RSM (or on the role
       Regional_Manager, or on the country manager above them) reaches every agent beneath as a
       divided share, and the row says which. Nothing derived is stored -- see salesTree. */
    const tree = salesTree(agents);
    const resolved = new Map();
    const targetOf = k => {
      if (!resolved.has(k)) resolved.set(k, resolveTarget(k, tree, tBy, new Set()));
      return resolved.get(k);
    };
    const rowsFor = scope => {
      const seen = new Map();
      for (const [k, g] of buckets[scope]) seen.set(k, { ...g, scope });
      // Every target appears, sales or none: the empty row is the one worth reading.
      for (const t of targets) {
        if (String(t.scope) !== scope) continue;
        const k = nameKey(t.name);
        if (!seen.has(k)) seen.set(k, { name: t.name, qty: 0, amount: 0, scope });
      }
      /* AND EVERYBODY THE LADDER GIVES A TARGET TO. An agent who has sold nothing this month
         and was never typed into this table still has a number to answer for, the moment their
         RSM has one -- and a board that showed only the people who happened to sell would hide
         exactly the rows worth reading. */
      if (scope === 'agent' || scope === 'rsm') {
        for (const [k, a] of tree.byKey) {
          const isRsm = tierOf(a.role) <= 1;
          if ((scope === 'rsm') !== isRsm) continue;
          if (!seen.has(k) && targetOf(k)) seen.set(k, { name: a.name, qty: 0, amount: 0, scope });
        }
      }
      return [...seen.entries()].map(([k, g]) => {
        const t = tBy.get(scope + '|' + k) || null;
        /* THE NUMBER THIS PERSON ANSWERS FOR. Their own if somebody typed one, else their
           role's, else their share of the manager's -- resolveTarget decides, and `source`
           carries the answer onto the screen so nobody wonders where a figure came from. */
        const dv = (scope === 'agent' || scope === 'rsm') ? targetOf(k) : null;
        const targetQty = t && t.target_qty != null ? num(t.target_qty) : (dv ? dv.qty : null);
        const targetAmount = t && t.target_amount != null ? num(t.target_amount) : (dv ? dv.amount : null);
        const source = t ? 'own' : (dv ? dv.source : null);
        /* WHAT EVERYBODY BENEATH THEM ADDS UP TO. The other half of the owner's sentence:
           "it increases to the higher leadership tiers". Where it differs from their own
           target somebody has been overridden below, and that is worth seeing rather than
           quietly reconciling. */
        const kids = (scope === 'rsm' || scope === 'company') ? tree.descendants(k) : [];
        const rolled = kids.reduce((acc, c) => {
          const cv = targetOf(c);
          if (cv && cv.qty != null && tree.childrenOf(c).length === 0) acc += num(cv.qty);
          return acc;
        }, 0);
        return { scope, name: g.name, qty: g.qty, amount: g.amount,
          targetQty, targetAmount,
          pctQty: pct(g.qty, targetQty), pctAmount: pct(g.amount, targetAmount),
          hasTarget: !!(targetQty != null || targetAmount != null),
          // 'own' | 'role' | 'share' | null -- never a number without a provenance.
          targetSource: source,
          targetFrom: t ? '' : (dv ? (dv.from || '') : ''),
          shareOf: (dv && dv.source === 'share') ? (dv.of || 0) : 0,
          rolledQty: kids.length ? rolled : null,
          under: kids.length || 0,
          note: t ? (t.note || '') : '', setBy: t ? (t.set_by || '') : '',
          setAt: t && t.set_at ? Date.parse(t.set_at) : null,
          // Named because somebody set a target and nothing came of it.
          missed: !!((targetQty != null && g.qty < targetQty) || (targetAmount != null && g.amount < targetAmount)),
          manager: (scope === 'agent' || scope === 'rsm')
            ? ((tree.of(tree.parentOf(k)) || {}).name || idx.of(g.name) || '') : '' };
      }).sort((x, y) => (y.amount - x.amount) || (x.name < y.name ? -1 : 1));
    };
    /* The role rows are a SOURCE, not a place on the board: nothing is measured against a role,
       so they carry what was set and how many people draw from it. */
    const roleRows = targets.filter(t => String(t.scope) === 'role').map(t => {
      const rk = roleKey(t.name);
      const holders = [...tree.byKey.values()].filter(a => roleKey(a.role) === rk);
      return { scope: 'role', name: rk, holders: holders.length,
        targetQty: t.target_qty == null ? null : num(t.target_qty),
        targetAmount: t.target_amount == null ? null : num(t.target_amount),
        note: t.note || '', setBy: t.set_by || '', setAt: t.set_at ? Date.parse(t.set_at) : null };
    }).sort((x, y) => (x.name < y.name ? -1 : 1));
    const rows = { agent: rowsFor('agent'), rsm: rowsFor('rsm'), branch: rowsFor('branch'),
      company: rowsFor('company'), role: roleRows };
    const co = rows.company[0] || { qty: 0, amount: 0, targetQty: null, targetAmount: null };
    return { ok: true, period, from, to, notReady, scopes: TARGET_SCOPES, rows,
      // The names the form offers, so nobody types a target against a spelling nothing matches.
      names: {
        agent: [...new Set(agents.filter(x => x.active !== false).map(x => String(x.name || '').trim()).filter(Boolean))].sort(),
        rsm: [...new Set(agents.filter(x => /REGIONAL|COUNTRY_SALES/.test(K(x.role || '').replace(/\s+/g, '_')))
          .map(x => String(x.name || '').trim()).filter(Boolean))].sort(),
        branch: [...new Set(agents.map(x => String(x.branch || '').trim()).filter(Boolean))].sort(),
        /* The roles the register actually uses, so a target is never set against a spelling
           nobody holds. The ladder's own rungs first, then anything else somebody has typed
           into the register -- offered rather than refused, because a company that invents a
           role should still be able to give it a number. */
        role: [...new Set(agents.map(x => roleKey(x.role)).filter(Boolean))]
          .sort((x, y) => (tierOf(x) - tierOf(y)) || (x < y ? -1 : 1)),
      },
      totals: { sales: sales.length, amount: sales.reduce((s, r) => s + num(r.price), 0),
        targetQty: co.targetQty, targetAmount: co.targetAmount,
        pctQty: pct(co.qty, co.targetQty), pctAmount: pct(co.amount, co.targetAmount),
        withTarget: TARGET_BOARD_SCOPES.reduce((s, k) => s + rows[k].filter(r => r.hasTarget).length, 0),
        missed: TARGET_BOARD_SCOPES.reduce((s, k) => s + rows[k].filter(r => r.hasTarget && r.missed).length, 0),
        /* How much of the board is answering for a number NOBODY TYPED -- the cascade doing
           its job. A company where this is zero has not set anything at the top. */
        derived: TARGET_BOARD_SCOPES.reduce((s, k) =>
          s + rows[k].filter(r => r.targetSource === 'share' || r.targetSource === 'role').length, 0),
        roles: rows.role.length } };
  },

  /** SET ONE. Upserted on (period, scope, name), so re-setting a target corrects it rather
      than filing a second one beside it. */
  async targetSave(db, user, args) {
    requireNav(user, 'targets');
    requireWrite(user);
    const a = args || {};
    const period = isMonth(a.period) ? String(a.period) : '';
    if (!period) bad('Chagua mwezi (YYYY-MM). / Choose a month.');
    const scope = String(a.scope || '').trim().toLowerCase();
    if (!TARGET_SCOPES.includes(scope)) bad('Aina ya lengo si sahihi. / Unknown target scope.');
    /* A ROLE IS STORED THE WAY THE REGISTER SPELLS ROLES -- underscored and upper-cased -- so
       "regional manager", "Regional_Manager" and "REGIONAL MANAGER" are one target rather than
       three, and the tree can look it up by the same key it reads off a person's row. */
    const name = scope === 'company' ? 'ALL'
      : scope === 'role' ? roleKey(a.name).slice(0, 120)
      : String(a.name == null ? '' : a.name).trim().slice(0, 120);
    if (!name) bad(scope === 'role' ? 'Chagua wadhifa. / Choose a role.'
      : 'Andika jina. / Give the name the target is for.');
    /* A TARGET OF NOTHING IS NOT A TARGET. Zero is allowed and meaningful (a month off); both
       fields empty is somebody pressing Save on a blank form. */
    const has = v => v != null && String(v).trim() !== '';
    const qty = has(a.qty) ? Math.floor(num(a.qty)) : null;
    const amount = has(a.amount) ? Math.round(num(a.amount)) : null;
    if (qty == null && amount == null) bad('Weka idadi au kiasi. / Set a quantity or an amount.');
    if (qty != null && (qty < 0 || qty > 1000000)) bad('Idadi si sahihi. / That quantity is not a target.');
    if (amount != null && (amount < 0 || amount > 1e12)) bad('Kiasi si sahihi. / That amount is not a target.');
    const now = new Date().toISOString();
    const row = { period, scope, name, target_qty: qty, target_amount: amount,
      note: String(a.note == null ? '' : a.note).trim().slice(0, 2000) || null,
      set_by: user.name || '', set_at: now, updated_at: now };
    const { error } = await db.from('sales_targets').upsert([row], { onConflict: 'period,scope,name' });
    if (error) {
      if (tableMissing(error)) bad(TARGET_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, period, scope, name, targetQty: qty, targetAmount: amount };
  },

  /** REMOVE ONE. Setting a target to zero and deleting it are different facts: zero is "sell
      nothing this month", gone is "nobody has said". */
  async targetDelete(db, user, args) {
    requireNav(user, 'targets');
    requireWrite(user);
    const a = args || {};
    const period = isMonth(a.period) ? String(a.period) : '';
    const scope = String(a.scope || '').trim().toLowerCase();
    // Deleting a role target has to key it the same way saving one did, or it deletes nothing.
    const name = scope === 'role' ? roleKey(a.name) : String(a.name == null ? '' : a.name).trim();
    if (!period || !TARGET_SCOPES.includes(scope) || !name) bad('Lengo halijachaguliwa. / No target chosen.');
    const { error } = await db.from('sales_targets').delete()
      .eq('period', period).eq('scope', scope).eq('name', name);
    if (error) {
      if (tableMissing(error)) bad(TARGET_NOT_READY);
      throw new Error(error.message);
    }
    return { ok: true, period, scope, name };
  },

  /** WHO AN AGENT REPORTS TO (RSM SOP D, CSM SOP J). The one field of the register the office
      maintains by hand; everything else about an agent comes from the SyscoPos upload. Blank
      clears the override and the branch fallback takes over again. */
  /* =====================================================================================
     THE STAFF PANE: each rank, and each leader's own channel.
     =====================================================================================
       "I needed the staff panel to be like of hope pmo -- don't put report to. But each
        person gets there by role, and clicking their panel needs filling who their channel
        data, like we start with 3: rsm, agent and team leader."

       "Country_Sales_Manager -- this is company admin, no need to be in the list.
        Regional_Manager -- these are the rsm, and on the staff pane we can activate or
        deactivate them; if deactivated even their login attempts can't work.
        Team_Leader -- we expect to have them again.  Field_Officer -- the agents."

     THE EDIT RUNS THE OTHER WAY ROUND, and that is the whole of "don't put report to". The
     column is the same one -- `manager`, which the target cascade already walks -- but it was
     only ever editable from the SUBORDINATE's row: open a field officer, type their leader's
     name. That is the wrong end of the question. Nobody sits down to decide who one agent
     reports to; they sit down with an RSM and decide who is in that RSM's channel. So the
     leader's panel lists the rank below and you tick your way down it, and the server writes
     `manager` on each person that changed.

     WHAT IS DERIVED IS SHOWN BUT NOT TICKABLE. Where `manager` is blank the cascade falls back
     to the branch, and that is right for almost everybody -- so those people appear on the
     leader's panel as "kwa tawi / by branch", greyed, with no checkbox. Making them tickable
     would mean a tick that changes nothing and an untick that cannot be honoured.
     ===================================================================================== */
  async staffChannel(db, user, args) {
    requireNav(user, 'staff');
    const phone = String((args && args.phone) || '').trim();
    if (!phone) bad('Mfanyakazi hajachaguliwa. / No staff member chosen.');
    const agents = await staffAgents(db);
    const leader = agents.find(r => String(r.phone) === phone);
    if (!leader) bad('Mfanyakazi hayupo kwenye register. / That person is not in the register.');

    const tree = salesTree(agents);
    const myKey = nameKey(leader.name);
    const myTier = tierOf(leader.role);
    /* THE RANK DIRECTLY BELOW. An RSM fills in team leaders, a team leader fills in agents.
       Reaching further down would let one tick put an agent under an RSM with a team leader
       standing between them, which is a hierarchy the roll-up cannot then explain. */
    const below = agents.filter(r => tierOf(r.role) === myTier + 1);
    const members = below.map(r => {
      const k = nameKey(r.name);
      const named = nameKey(r.manager || '');
      return {
        name: r.name, phone: r.phone || '', role: r.role || '', branch: r.branch || '',
        active: r.active !== false,
        /* Three states, and the difference between the first two is what makes this pane
           honest: `mine` was typed by a person, `branch` was worked out by the system. */
        mine: !!named && named === myKey,
        branch: !named && tree.parentOf(k) === myKey,
        elsewhere: named && named !== myKey ? (tree.of(named) ? tree.of(named).name : r.manager) : '',
        // How many sit under them in turn, so an RSM can see the size of a channel at a glance.
        under: tree.descendants(k).length,
      };
    }).sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0)
      || (b.branch ? 1 : 0) - (a.branch ? 1 : 0)
      || String(a.name).localeCompare(String(b.name)));

    return { ok: true,
      leader: { name: leader.name, phone: leader.phone || '', role: leader.role || '',
        branch: leader.branch || '', active: leader.active !== false,
        tier: myTier, under: tree.descendants(myKey).length },
      // A field officer has no rank below them; the pane says so rather than showing an empty box.
      leaf: myTier >= TARGET_TIERS.length - 1,
      members,
      counts: { mine: members.filter(m => m.mine).length,
        branch: members.filter(m => m.branch).length, all: members.length } };
  },

  /** Who is in this leader's channel, written as `manager` on each person that changed.
      Only the rank directly below can be named, and only explicit assignments are touched --
      a person who lands here by branch has nothing stored and nothing to clear. */
  async staffChannelSave(db, user, args) {
    requireNav(user, 'staff');
    requireWrite(user);
    const a = args || {};
    const phone = String(a.phone || '').trim();
    if (!phone) bad('Mfanyakazi hajachaguliwa. / No staff member chosen.');
    const agents = await staffAgents(db);
    const leader = agents.find(r => String(r.phone) === phone);
    if (!leader) bad('Mfanyakazi hayupo kwenye register. / That person is not in the register.');
    const myKey = nameKey(leader.name);
    const myTier = tierOf(leader.role);
    const want = new Set((Array.isArray(a.members) ? a.members : [])
      .map(x => String(x || '').trim()).filter(Boolean));

    const below = agents.filter(r => tierOf(r.role) === myTier + 1);
    const byPhone = new Map(below.map(r => [String(r.phone), r]));
    /* A PHONE THAT IS NOT ON THE RANK BELOW IS REFUSED, not ignored. The pane cannot send one,
       but the pane is not the only thing that can call this, and silently dropping it would
       report a save that did not happen. */
    for (const p of want) {
      if (!byPhone.has(p)) {
        bad('Mtu huyu si wa ngazi inayofuata. / That person is not on the rank below this one.');
      }
    }
    const add = [], drop = [];
    for (const r of below) {
      const p = String(r.phone);
      const named = nameKey(r.manager || '');
      if (want.has(p) && named !== myKey) add.push(p);
      // Only ever clears an assignment that points HERE. Somebody else's people are not ours
      // to un-assign from this screen, and a branch-derived one has nothing stored at all.
      if (!want.has(p) && named === myKey) drop.push(p);
    }
    const at = new Date().toISOString();
    const write = async (phones, manager) => {
      if (!phones.length) return;
      const { error } = await db.from('hoop_agents')
        .update({ manager, updated_at: at }).in('phone', phones);
      /* POSTGREST REFUSES BY RESOLVING. A channel that reported itself saved while the column
         was missing would leave an RSM believing their team was assigned. */
      if (error) {
        if (/manager/i.test(String(error.message))) bad(TARGET_NOT_READY);
        throw new Error(error.message);
      }
    };
    await write(add, leader.name);
    await write(drop, null);
    return { ok: true, phone, added: add.length, removed: drop.length };
  },

  /* ACTIVATE OR DEACTIVATE, AND THE DOOR WITH IT.
     -------------------------------------------------------------------------------------
       "On the staff pane we can activate or deactivate them; if deactivated even their login
        attempts can't work."

     TWO REGISTERS, ONE ACT. `hoop_agents.active` says whether somebody works here;
     `access_codes` is what opens the door, and until now nothing joined them -- so a person
     marked inactive in the staff register could still sign in all afternoon. This does both,
     and REPORTS WHICH CODES IT TOUCHED rather than doing it quietly: an act that reaches a
     second table needs to say so on screen.

     The codes are matched BY NAME, because that is the only thing the two registers share.
     That is worth saying out loud rather than hiding: where nothing matches, the answer is
     "deactivated in the register, no portal code matched" -- never a silent half-success.

     ADMIN IS NEVER SHUT OUT. The standing rule, and here it is also the lockout guard: an
     admin code suspended by this pane would leave nobody able to lift it. */
  async staffActive(db, user, args) {
    requireNav(user, 'staff');
    requireWrite(user);
    const a = args || {};
    const phone = String(a.phone || '').trim();
    if (!phone) bad('Mfanyakazi hajachaguliwa. / No staff member chosen.');
    const active = a.active === true || a.active === 'true';
    const at = new Date().toISOString();
    const { data, error } = await db.from('hoop_agents')
      .update({ active, updated_at: at }).eq('phone', phone).select('phone, name');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Mfanyakazi hayupo kwenye register. / That person is not in the register.');
    const name = data[0].name || '';

    const codes = [];
    let doorKnown = true;
    try {
      const rows = await fetchAll(() => db.from('access_codes').select('code, name, role'));
      const mine = rows.filter(r => nameKey(r.name) === nameKey(name));
      for (const r of mine) {
        if (isAdminRole({ role: r.role })) { codes.push({ code: r.code, skipped: 'admin' }); continue; }
        const patch = active
          ? { suspend_from: null, suspend_to: null }
          // Open-ended: suspendedOn reads a `from` with no `to` as "from that day until lifted".
          : { suspend_from: todayKey(), suspend_to: null };
        const { error: sErr } = await db.from('access_codes').update(patch).eq('code', r.code);
        if (sErr) {
          if (/suspend_from|suspend_to/i.test(String(sErr.message))) { doorKnown = false; break; }
          throw new Error(sErr.message);
        }
        codes.push({ code: r.code, skipped: '' });
      }
    } catch (e) {
      if (!tableMissing(e)) throw e;
      doorKnown = false;
    }
    return { ok: true, phone, name, active,
      /* What actually happened at the door, in the caller's hands rather than assumed. */
      doorKnown,
      codes: codes.filter(c => !c.skipped).length,
      adminSkipped: codes.filter(c => c.skipped === 'admin').length };
  },

  async staffManager(db, user, args) {
    requireNav(user, 'staff');
    requireWrite(user);
    const a = args || {};
    const phone = String(a.phone == null ? '' : a.phone).trim();
    if (!phone) bad('Mfanyakazi hajachaguliwa. / No staff member chosen.');
    const manager = String(a.manager == null ? '' : a.manager).trim().slice(0, 120);
    const { data, error } = await db.from('hoop_agents')
      .update({ manager: manager || null, updated_at: new Date().toISOString() })
      .eq('phone', phone).select('phone');
    if (error) {
      if (/manager/i.test(String(error.message))) bad(TARGET_NOT_READY);
      throw new Error(error.message);
    }
    if (!data || !data.length) bad('Mfanyakazi hayupo kwenye register. / That person is not in the register.');
    return { ok: true, phone, manager };
  },

  /* =====================================================================================
     STOCK REQUESTS -- ask, decide against the aging gate, hand over.
     =====================================================================================
       Store SOP B.1  "Receive the stock request from the RSM in the system"
       Store SOP B.2  "Confirm the RSM/agent has no outstanding aging stock"
       Store SOP B.5-B.9  the pre-numbered note, the joint count, the photographs, the
                      signature, and the courier's documents
       Store SOP E    "No new stock is released to any RSM/agent with outstanding aging
                      stock until it is fully sold, returned, or reconciled"

     THE GATE IS THE POINT. Everything else here is the same request shape as the imprest and
     the advance; what is new is that the approval can be refused by ARITHMETIC rather than by
     somebody remembering. The figures come from hoop_aged_stock, the shop's own daily upload,
     so the gate and the Aging Stock Tracker are one file. Releasing anyway is allowed -- the
     SOP escalates, it does not lock the door -- but it takes a reason and the reason is kept.

     Three navs, granted the ordinary way: stockreq asks, stockappr decides and hands over,
     stockrep reads the tracker and the distribution report. */

  /** Anybody who may ask, and the desk (which files on an RSM's behalf when they phone in). */
  async stockRequest(db, user, args) {
    requireAnyNav(user, ['stockreq', 'stockappr']);
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    // Whose shelf it lands on. Defaults to the person asking, which is the usual case.
    const holder = S(a.holder, 120) || (user.name || '');
    if (!holder) bad('Andika anayepokea stoo. / Say who the stock is for.');
    const item = S(a.item, 120);
    if (!item) bad('Chagua modeli. / Give the model.');
    const qty = Math.floor(num(a.qty));
    if (!(qty > 0)) bad('Idadi lazima iwe zaidi ya sifuri. / The quantity must be more than zero.');
    if (qty > 5000) bad('Idadi ni kubwa mno. / That quantity is too large.');
    /* THE TRACKER AS IT STOOD THIS MORNING, stamped on the row. A request that should never
       have been filed stays visible as one even after the stock has gone out. */
    const idx = await stockAgingIndex(db);
    const gate = idx.for(holder);
    const at = new Date().toISOString();
    const row = {
      requested_at: at, updated_at: at,
      staff_code: user.code || null, staff_name: user.name || '', staff_role: user.role || '',
      holder, destination: S(a.destination, 120) || null, item, qty,
      reason: S(a.reason, 2000) || null,
      aging_count: gate.aging, aging_oldest_days: gate.oldest || null, aging_as_of: gate.asOf || null,
      status: 'pending', updated_by: user.name || '',
    };
    const { data, error } = await db.from('stock_requests').insert([row]).select('id');
    if (error) {
      if (tableMissing(error)) bad(STOCK_NOT_READY);
      throw new Error(error.message);
    }
    const id = data && data[0] ? String(data[0].id) : null;
    const mail = await sendMail(db, { toKey: 'STOCK_EMAIL',
      subject: 'HOOPLOAN — ombi la stoo / stock request: ' + item + ' ×' + qty + ' (' + holder + ')',
      html: noticeHtml('Ombi jipya la stoo / New stock request', [
        ['Kwa ajili ya / For', holder], ['Modeli / Model', item], ['Idadi / Quantity', String(qty)],
        ['Inakwenda / Destination', row.destination || '—'], ['Ameomba / Requested by', user.name || ''],
        ['Stoo iliyokaa / Aging stock', gate.aging
          ? gate.aging + ' pcs zaidi ya siku ' + gate.agingDays + ' (kongwe: ' + gate.oldest + ') — SOP E'
          : 'hakuna / none'],
        ['Sababu / Reason', String(row.reason || '').slice(0, 400)],
      ], 'Fungua Idhini ya stoo kuamua. / Open the stock approval pane to decide.') });
    return { ok: true, id, aging: gate, emailed: mail.sent, emailNote: mail.sent ? '' : mail.reason };
  },

  /** The asker's own requests, and the gate as it stands for them right now. */
  async stockMine(db, user) {
    requireNav(user, 'stockreq');
    let rows;
    try {
      rows = await fetchAll(() => db.from('stock_requests').select(STOCK_COLS).eq('staff_code', user.code || '~none~'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, aging: null };
    }
    const idx = await stockAgingIndex(db);
    return { ok: true, rows: rows.map(r => stockRow(r, user.code)).sort(stockWorkFirst),
      aging: idx.for(user.name || ''), asOf: idx.asOf };
  },

  /** THE STORE DESK. Every request, work first, each carrying the gate as it stands NOW --
      a request filed on Monday is a different question by Wednesday. */
  async stockQueue(db, user, args) {
    requireNav(user, 'stockappr');
    const a = args || {};
    let rows;
    try {
      rows = await fetchAll(() => db.from('stock_requests').select(STOCK_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, rows: [], notReady: true, counts: { pending: 0, approved: 0, issued: 0, rejected: 0, blocked: 0 } };
    }
    const idx = await stockAgingIndex(db);
    const all = rows.map(r => {
      const o = stockRow(r, user.code);
      o.agingNow = idx.for(o.holder);
      return o;
    });
    const want = String(a.state || '').trim();
    const shown = all
      .filter(r => want === 'all' ? true
        : want === 'blocked' ? (r.status === 'pending' && r.agingNow.blocked)
        : want ? r.status === want
        : (r.status === 'pending' || r.status === 'approved'))
      .sort(stockWorkFirst);
    return { ok: true, rows: shown, asOf: idx.asOf, agingDays: idx.policy.agingDays,
      counts: {
        pending: all.filter(r => r.status === 'pending').length,
        approved: all.filter(r => r.status === 'approved').length,
        issued: all.filter(r => r.status === 'issued').length,
        rejected: all.filter(r => r.status === 'rejected').length,
        blocked: all.filter(r => r.status === 'pending' && r.agingNow.blocked).length,
      } };
  },

  /** THE DECISION, AND THE GATE (SOP B.2, E). Approving somebody who is holding aging stock
      takes an explicit override and a reason; rejecting never does. */
  async stockDecide(db, user, args) {
    requireNav(user, 'stockappr');
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    let rows;
    try {
      rows = await fetchAll(() => db.from('stock_requests').select(STOCK_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(STOCK_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    if (!row) bad('Ombi halipo. / That request no longer exists.');
    if (row.status !== 'pending') bad('Ombi hili limeshaamuliwa. / That request has already been decided.');
    const approve = a.approve === true;
    const comment = S(a.comment, 2000);
    if (!approve && !comment) bad('Sababu inahitajika ukikataa. / A reason is required when rejecting.');
    const at = new Date().toISOString();
    const patch = { status: approve ? 'approved' : 'rejected', comment: comment || null,
      decided_by: user.name || '', decided_at: at, updated_by: user.name || '', updated_at: at };
    if (approve) {
      const qty = a.qty == null || a.qty === '' ? num(row.qty) : Math.floor(num(a.qty));
      if (!(qty > 0)) bad('Idadi inayotolewa lazima iwe zaidi ya sifuri. / The released quantity must be more than zero.');
      if (qty > num(row.qty)) bad('Huwezi kutoa zaidi ya kilichoombwa. / You cannot release more than was asked for.');
      patch.approved_qty = qty;
      /* THE GATE, RECOMPUTED LIVE rather than read off the stamp. */
      const gate = (await stockAgingIndex(db)).for(row.holder);
      if (gate.blocked) {
        const reason = S(a.overrideReason, 500);
        if (a.overrideAging !== true || !reason) {
          bad(row.holder + ' ana stoo ' + gate.aging + ' iliyokaa zaidi ya siku ' + gate.agingDays
            + ' (kongwe: siku ' + gate.oldest + ', deki ya ' + (gate.asOf || '—') + '). '
            + 'SOP E: hakuna stoo mpya mpaka iuzwe, irudishwe au ipatanishwe. Ukiamua kutoa hata hivyo, '
            + 'tumia "Toa hata hivyo" na uandike sababu. '
            + '/ Outstanding aging stock: no new stock until it is sold, returned or reconciled. '
            + 'Release anyway only with a recorded reason.');
        }
        patch.aging_override = true;
        patch.aging_override_reason = reason;
      }
    }
    /* GUARDED on what was read, so two desks cannot both decide the same request. */
    const { data, error } = await db.from('stock_requests').update(patch)
      .eq('id', id).eq('status', 'pending').select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) bad('Ombi hili limeamuliwa na mtu mwingine sasa hivi. / Somebody else just decided this request.');
    return { ok: true, id, status: patch.status, approvedQty: patch.approved_qty == null ? null : patch.approved_qty,
      agingOverride: !!patch.aging_override };
  },

  /** THE HANDOVER (SOP B.5-B.9). Only on an approved request, once: the note number, the joint
      count, who signed, the courier's papers, the IMEIs and up to three photographs. Any IMEI
      the phone registry already knows has its holder moved, so "who has it" stops being two
      different answers in two different panes. */
  async stockIssue(db, user, args) {
    requireNav(user, 'stockappr');
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
    const id = String(a.id || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    let rows;
    try {
      rows = await fetchAll(() => db.from('stock_requests').select(STOCK_COLS).eq('id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(STOCK_NOT_READY);
    }
    const row = rows.find(r => String(r.id) === id);
    if (!row) bad('Ombi halipo. / That request no longer exists.');
    if (row.status === 'issued') bad('Stoo hii tayari imetolewa. / That stock has already been handed over.');
    if (row.status !== 'approved') bad('Idhinisha kwanza kabla ya kutoa. / Approve the request before handing anything over.');
    /* B.6 AND B.8 ARE NOT PAPERWORK. Without the joint count and a name on the note there is
       nobody to hold accountable for a shortage, which is the whole objective of this SOP. */
    if (a.countedJointly !== true) bad('Thibitisha mmehesabu pamoja. / Confirm the joint physical count (SOP B.6).');
    const receivedBy = S(a.receivedBy, 120);
    if (!receivedBy) bad('Andika jina la aliyepokea na kusaini. / Name the person who received and signed (SOP B.8).');
    const courier = S(a.courier, 120);
    const docsComplete = a.docsComplete === true;
    if (courier && !docsComplete) {
      bad('Ikitumwa kwa kozi, thibitisha nyaraka zote zipo kabla haijaondoka. '
        + '/ For a courier dispatch, confirm the documents are complete before it leaves (SOP B.9).');
    }
    /* THE IMEIs ON THE NOTE (B.5). Digits only, de-duplicated, and never more than were
       approved -- a note that lists more phones than were released is a shortage waiting to
       be argued about. */
    const seen = new Set();
    const imeis = [];
    for (const v of (Array.isArray(a.imeis) ? a.imeis : String(a.imeis || '').split(/[\s,;]+/))) {
      const d = String(v == null ? '' : v).replace(/\D/g, '');
      if (!d) continue;
      if (d.length < 14 || d.length > 17) bad('IMEI "' + d + '" si sahihi. / That IMEI is not a valid length.');
      if (seen.has(d)) continue;
      seen.add(d); imeis.push(d);
    }
    const approved = row.approved_qty == null ? num(row.qty) : num(row.approved_qty);
    if (imeis.length > approved) {
      bad('Umeorodhesha IMEI ' + imeis.length + ' lakini zilizoidhinishwa ni ' + approved
        + '. / More IMEIs listed than were approved.');
    }
    const photos = Array.isArray(a.photos) ? a.photos.filter(p => p != null && p !== '') : [];
    if (photos.length > IMP_PHOTO_MAX) bad('Picha ni nyingi mno (kiwango ni ' + IMP_PHOTO_MAX + '). / Too many photos.');
    const sized = photos.map(p => ({ data: String(p), bytes: photoBytes(p) }));
    if (sized.some(p => p.bytes == null)) bad('Picha moja si picha. / One of those is not an image.');
    if (sized.some(p => p.bytes > IMP_PHOTO_MAX_BYTES)) {
      bad('Picha moja ni kubwa mno (zaidi ya ' + Math.round(IMP_PHOTO_MAX_BYTES / 1024) + 'KB). Ipunguze kisha jaribu tena. '
        + '/ One photo is too large; shrink it and try again.');
    }
    if (sized.some(p => p.bytes < IMP_PHOTO_MIN_BYTES)) bad('Picha moja ni ndogo mno. / One photo is too small to be a photograph.');

    const at = new Date().toISOString();
    /* CLAIM THE REQUEST FIRST, guarded on `approved`, so two store keepers pressing at once
       cannot write two handover notes for one release. The unique index on request_id would
       catch it too; this catches it before any photo is written. */
    const { data: claimed, error: cErr } = await db.from('stock_requests')
      .update({ status: 'issued', issued_at: at, issued_by: user.name || '', updated_by: user.name || '', updated_at: at })
      .eq('id', id).eq('status', 'approved').select('id');
    if (cErr) throw new Error(cErr.message);
    if (!claimed || !claimed.length) bad('Stoo hii imeshatolewa na mtu mwingine sasa hivi. / Somebody else just handed this stock over.');

    const { data: hv, error: hErr } = await db.from('stock_handovers').insert([{
      request_id: id, at, by_code: user.code || null, by_name: user.name || '',
      note_no: S(a.noteNo, 60) || null, counted_jointly: true, received_by: receivedBy,
      condition_note: S(a.conditionNote, 2000) || null, courier: courier || null,
      docs_complete: docsComplete, qty: imeis.length || approved,
    }]).select('id');
    if (hErr) throw new Error(hErr.message);
    const hid = hv && hv[0] ? String(hv[0].id) : null;
    if (imeis.length) {
      const { error: iErr } = await db.from('stock_handover_items')
        .insert(imeis.map(imei => ({ handover_id: hid, imei, condition: S(a.conditionNote, 120) || null })));
      if (iErr) throw new Error(iErr.message);
    }
    if (sized.length) {
      const { error: pErr } = await db.from('stock_handover_photos')
        .insert(sized.map((p, i) => ({ handover_id: hid, seq: i + 1, data: p.data, bytes: p.bytes })));
      if (pErr) throw new Error(pErr.message);
    }
    /* WHO HAS IT, in the one place that locks phones. Allowed to fail quietly per IMEI: a
       device not in the registry is normal (only enrolled phones are there), and a registry
       hiccup must never undo a handover the store has physically made. */
    let moved = 0;
    for (const imei of imeis) {
      try {
        const { data: up } = await db.from('devices').update({ holder: row.holder }).eq('imei', imei).select('imei');
        if (up && up.length) moved++;
      } catch (e) { /* the note is the record either way */ }
    }
    return { ok: true, id, handoverId: hid, imeis: imeis.length, photos: sized.length, holdersMoved: moved };
  },

  /** One handover note, with its IMEIs. The desk and the report see any; an asker sees only
      the note for their own request. */
  async stockHandover(db, user, args) {
    requireAnyNav(user, ['stockreq', 'stockappr', 'stockrep']);
    const id = String((args && args.id) || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    const navs = navsFor(user);
    if (!navs.includes('stockappr') && !navs.includes('stockrep')) {
      let own;
      try {
        own = await fetchAll(() => db.from('stock_requests').select('id, staff_code').eq('id', id));
      } catch (e) {
        if (!tableMissing(e)) throw e;
        return { ok: true, handover: null, items: [], notReady: true };
      }
      const r = own.find(x => String(x.id) === id);
      if (!r || String(r.staff_code || '') !== String(user.code || '')) bad('Ombi halipo. / That request no longer exists.');
    }
    let hv;
    try {
      hv = await fetchAll(() => db.from('stock_handovers').select('*').eq('request_id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, handover: null, items: [] };
    }
    const h = hv[0];
    if (!h) return { ok: true, handover: null, items: [] };
    let items = [];
    try {
      items = await fetchAll(() => db.from('stock_handover_items').select('imei, condition').eq('handover_id', String(h.id)));
    } catch (e) { items = []; }
    let photos = 0;
    try {
      photos = (await fetchAll(() => db.from('stock_handover_photos').select('seq').eq('handover_id', String(h.id)))).length;
    } catch (e) { photos = 0; }
    return { ok: true,
      handover: { id: String(h.id), at: h.at ? Date.parse(h.at) : null, by: h.by_name || '',
        noteNo: h.note_no || '', countedJointly: !!h.counted_jointly, receivedBy: h.received_by || '',
        conditionNote: h.condition_note || '', courier: h.courier || '', docsComplete: !!h.docs_complete,
        qty: num(h.qty), photos },
      items: items.map(i => ({ imei: String(i.imei), condition: i.condition || '' })).sort((x, y) => (x.imei < y.imei ? -1 : 1)) };
  },

  /** The photographs of one handover (SOP B.7), fetched only when somebody asks to see them. */
  async stockPhotos(db, user, args) {
    requireAnyNav(user, ['stockreq', 'stockappr', 'stockrep']);
    const id = String((args && args.id) || '').trim();
    if (!isUuid(id)) bad('Ombi halijachaguliwa. / No request chosen.');
    const navs = navsFor(user);
    if (!navs.includes('stockappr') && !navs.includes('stockrep')) {
      let own;
      try {
        own = await fetchAll(() => db.from('stock_requests').select('id, staff_code').eq('id', id));
      } catch (e) {
        if (!tableMissing(e)) throw e;
        return { ok: true, photos: [], notReady: true };
      }
      const r = own.find(x => String(x.id) === id);
      if (!r || String(r.staff_code || '') !== String(user.code || '')) bad('Ombi halipo. / That request no longer exists.');
    }
    let hv;
    try {
      hv = await fetchAll(() => db.from('stock_handovers').select('id').eq('request_id', id));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      return { ok: true, photos: [] };
    }
    if (!hv[0]) return { ok: true, photos: [] };
    let rows = [];
    try {
      rows = await fetchAll(() => db.from('stock_handover_photos').select('seq, data, bytes').eq('handover_id', String(hv[0].id)));
    } catch (e) { rows = []; }
    return { ok: true, photos: rows.map(p => ({ seq: num(p.seq), data: p.data, bytes: num(p.bytes) }))
      .sort((x, y) => x.seq - y.seq) };
  },

  /** THE AGING STOCK TRACKER (SOP E.3) and the distribution report (B.11), on one pane: who is
      holding what and for how long, the low-stock alert (SOP G), and every request in a period
      with what was released against it. */
  async stockReqReport(db, user, args) {
    requireNav(user, 'stockrep');
    const a = args || {};
    const idx = await stockAgingIndex(db);
    let rows = [];
    let notReady = false;
    try {
      rows = await fetchAll(() => db.from('stock_requests').select(STOCK_COLS));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      notReady = true;
    }
    const from = isDay(a.from) ? String(a.from) : null;
    const to = isDay(a.to) ? String(a.to) : null;
    const want = String(a.status || '').trim();
    const holder = K(a.holder);
    const all = rows.map(r => stockRow(r, user.code));
    const day = ms => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
    const inPeriod = all
      .filter(r => !from || (r.at && day(r.at) >= from))
      .filter(r => !to || (r.at && day(r.at) <= to))
      .filter(r => !holder || nameKey(r.holder) === nameKey(a.holder));
    const shown = inPeriod.filter(r => !STOCK_STATES.includes(want) || r.status === want)
      .sort((x, y) => (y.at || 0) - (x.at || 0));
    const issued = inPeriod.filter(r => r.status === 'issued');
    return { ok: true, rows: shown, notReady,
      aging: { asOf: idx.asOf, agingDays: idx.policy.agingDays, pieces: idx.pieces,
        lowAlert: idx.policy.lowAlert, low: idx.pieces > 0 && idx.pieces < idx.policy.lowAlert,
        holders: idx.holders },
      totals: {
        count: inPeriod.length,
        pending: inPeriod.filter(r => r.status === 'pending').length,
        approved: inPeriod.filter(r => r.status === 'approved').length,
        rejected: inPeriod.filter(r => r.status === 'rejected').length,
        issued: issued.length,
        qtyAsked: inPeriod.reduce((s, r) => s + r.qty, 0),
        qtyIssued: issued.reduce((s, r) => s + (r.approvedQty == null ? r.qty : r.approvedQty), 0),
        // SOP E again, after the fact: how often the gate was overridden, and by whom.
        overrides: inPeriod.filter(r => r.agingOverride).length,
      } };
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
    /* THE DEVICE REGISTER IS THE FOURTH PLACE AN IMEI LIVES, and it was the one the search
       could not reach -- so the single question this box exists for, "what is going on with
       this handset", was the one it could not answer. A phone reaches the register the
       moment it is enrolled, which is often BEFORE it appears on a stock report and long
       before it has a customer, so for new stock this is the only leg that finds it at all.
       Never the enrol_token: this is a search result, and the token is the handset's
       credential -- see deviceHistory, which names its columns for the same reason. */
    const dTerms = ['imei.ilike.' + pat, 'item.ilike.' + pat, 'holder.ilike.' + pat]
      .concat(dpat ? ['imei.ilike.' + dpat] : []);
    const [pe, st, dv] = await Promise.all([
      db.from('hoop_agents').select('name, phone, role, branch, active').or(pTerms.join(',')).limit(20),
      db.from('hoop_aged_stock').select('serial, item, agent, as_of')
        .or(sTerms.join(',')).order('as_of', { ascending: false }).limit(20),
      db.from('devices').select('imei, item, holder, state, state_reason, reported, last_seen, customer')
        .or(dTerms.join(',')).limit(20),
    ]);
    if (pe.error) throw new Error(pe.error.message);
    const seenS = new Set(), stock = [];
    for (const s of (st.error ? [] : (st.data || []))) {
      if (seenS.has(String(s.serial))) continue;
      seenS.add(String(s.serial));
      stock.push({ serial: s.serial, item: s.item || '', holder: s.agent || '',
        asOf: s.as_of ? String(s.as_of).slice(0, 10) : '' });
    }
    /* The devices table may not exist yet on a deployment that has not run the migration --
       the same tolerance deviceList shows. A search that 500s because ONE of four legs is
       missing is worse than a search that quietly returns the other three. */
    const now = Date.now();
    const devices = (dv.error ? [] : (dv.data || [])).map(d => {
      const seen = d.last_seen ? Date.parse(d.last_seen) : NaN;
      const hrs = Number.isFinite(seen) ? Math.round((now - seen) / 3600000) : null;
      return { imei: d.imei, item: d.item || '', holder: d.holder || '',
        customer: d.customer || '', state: d.state || '', reason: d.state_reason || '',
        reported: d.reported || '',
        /* Ordered is not confirmed, and the search result has to say which -- it is the
           same distinction the Devices tab draws with "imeagizwa · bado". */
        lockState: d.state !== 'locked' ? null : (d.reported === 'locked' ? 'confirmed' : 'pending'),
        neverSeen: !d.last_seen, silentHours: hrs };
    });
    return { ok: true, customers: cs.customers,
      people: (pe.data || []).map(p => ({ name: p.name || '', phone: p.phone || '',
        role: p.role || '', branch: p.branch || '', active: p.active !== false })),
      stock, devices };
  },

  /** THE OFFICE, not the logins: everyone on Sipho's register -- agents, team leaders,
      RSMs, the CSM -- ranked seniority-first. System logins (portal codes, app users)
      live under Access codes. Next of kin shows only to settings holders / ADMIN.
      Budget: 1 bounded read (~1k rows). */
  async staffDirectory(db, user) {
    requireNav(user, 'staff');
    /* `manager` post-dates this table (the targets migration adds it). A directory that 500s
       because one column is not there yet would take the whole staff pane down for the time
       between the deploy and somebody running the migration by hand. */
    let rows;
    try {
      rows = await fetchAll(() => db.from('hoop_agents')
        .select('name, phone, role, branch, manager, active, joined_date, kin_name, kin_phone'));
    } catch (e) {
      if (!/manager/i.test(String(e && e.message))) throw e;
      rows = await fetchAll(() => db.from('hoop_agents')
        .select('name, phone, role, branch, active, joined_date, kin_name, kin_phone'));
    }
    const RANK = { COUNTRY_SALES_MANAGER: 0, REGIONAL_MANAGER: 1, TEAM_LEADER: 2, FIELD_OFFICER: 3, FIELD_OFFICERS: 3 };
    const showKin = isAdminRole(user) || (user.tabs || []).includes('settings');
    const rank = r => { const k = K(r).replace(/\s+/g, '_'); return RANK[k] === undefined ? 9 : RANK[k]; };
    const staff = rows.map(r => {
      const o = { name: r.name || '', phone: r.phone || '', role: r.role || '',
        branch: r.branch || '', active: r.active !== false,
        // Who they report to, where somebody has said. Blank means the branch decides.
        manager: r.manager || '',
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
      /* A CASCADE, for the same reason authCode has one: PostgREST refuses the whole select
         for one unknown column, and a pane that goes dark is how somebody loses the ability to
         fix the very thing that is missing. Widest first, each rung dropping the newest
         column. */
      (async () => {
        const tiers = [
          'code, name, role, teams, tabs, suspend_from, suspend_to',
          'code, name, role, teams, tabs',
        ];
        let last;
        for (const cols of tiers) {
          try { return await fetchAll(() => db.from('access_codes').select(cols)); }
          catch (e) {
            last = e;
            if (!/suspend_from|suspend_to/i.test(String(e && e.message))) throw e;
          }
        }
        throw last;
      })(),
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
      suspendKnown: rows.some(r => 'suspend_from' in r) || !rows.length,
      /* The day the window is judged against, sent rather than worked out on the client: the
         browser's clock belongs to whoever is holding it, and this is the same EAT day the
         server uses to refuse a sign-in. A row marked "away" on this screen and let in at the
         door would be the pane and the gate disagreeing about the same person. */
      today: todayKey(),
      codes: rows.map(r => ({
        code: mask ? '••••••' : r.code, name: r.name, role: r.role,
        teams: r.teams || null, tabs: r.tabs || [],
        /* A SUSPENDED ROW STAYS ON THIS SCREEN, marked rather than hidden. Filtering it out
           would remove the one pane where the window can be lifted -- the same trap as a
           deleted role that quietly resurrects itself. */
        suspendFrom: 'suspend_from' in r ? (r.suspend_from || null) : null,
        suspendTo: 'suspend_to' in r ? (r.suspend_to || null) : null,
        suspended: 'suspend_from' in r ? suspendedOn(r, todayKey()) : null })) };
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
    /* 'sales' and 'devices' are stored ALIASES, not panes: each expands in navsFor. They stay
       allowed so a role saved under one keeps every door it had -- dropping an alias on save
       would quietly take a pane away from everybody holding that role. */
    const ALLOWED = new Set([...NAV_TABS, 'upload', 'audit', 'sales', 'devices']);
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
    // `leader`, if an older screen still sends it, is ignored: the switch is gone (see navsFor).
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

  /* =========================================================================================
     CHANGING YOUR OWN PASSCODE, FROM THE SIGN-IN SCREEN.

       "i want created users with these rolebased access codes .. can update their passcodes at
        loginpage by iputing current one and double input new one to overwrite"

     THE CURRENT CODE IS THE AUTHENTICATION. There is no session to change a code inside of --
     the point is to do it at the door -- so the caller proves who they are the only way this
     system knows how: by presenting the code that is about to be replaced. portalApi has
     already resolved it into `user` before this runs, which is exactly what makes it safe.

     IT CAN ONLY EVER CHANGE THE CALLER'S OWN ROW. The new code is the only thing taken from
     the arguments; whose code changes comes from `user.code` and cannot be steered. That is
     the difference between this and saveAccessCode, which is an admin tool that can rename
     anybody and is gated on requireSettings.

     TYPED TWICE, COMPARED HERE. The second box is checked on the server as well as on the
     screen, because a browser is not the only thing that can post to this endpoint and a
     typo that locks somebody out of a system they need is not recoverable by them.

     THE NEW CODE NEVER REACHES THE AUDIT LOG. The arguments are deliberately named `next` and
     `again` rather than `code`: KEEP in _lib/audit.js records anything called `code`, and an
     audit row carrying somebody's live passcode would be a credential sitting in a table that
     the audit nav can be granted on. The actor's OLD code identifies who did it, and by the
     time anybody reads the line that code no longer opens anything.
     ========================================================================================= */
  async changeMyCode(db, user, args) {
    requireWrite(user);
    const a = args || {};
    const next = String(a.next || '').trim();
    const again = String(a.again || '').trim();

    if (!next) bad('Weka msimbo mpya. / Enter a new code.');
    if (next !== again) {
      bad('Misimbo miwili haifanani. / The two new codes do not match.');
    }
    /* Short enough to type on a phone, long enough not to be guessed by somebody watching the
       queue. Eight is the shortest that is not trivially brute-forced by hand. */
    if (next.length < 8) {
      bad('Msimbo mpya uwe na herufi 8 au zaidi. / The new code must be at least 8 characters.');
    }
    if (/\s/.test(next)) {
      bad('Msimbo usiwe na nafasi. / The code cannot contain spaces.');
    }
    if (next === user.code) {
      bad('Msimbo mpya ni ule ule wa zamani. / That is the code you already have.');
    }

    /* CASE-INSENSITIVELY TAKEN IS STILL TAKEN. authCode falls back to a case-insensitive match
       when the exact one misses, so allowing "credit1" beside "CREDIT1" would create a pair
       that the door refuses to choose between -- and BOTH people would be told their code is
       invalid. Checked before the write rather than left to a unique index, which is on the
       exact string only. */
    const clash = await fetchAll(() => db.from('access_codes').select('code')
      .ilike('code', String(next).replace(/([\\%_])/g, '\\$1')));
    if (clash.some(r => String(r.code) !== String(user.code))) {
      bad('Msimbo huo tayari unatumika. Chagua mwingine. / That code is already in use — pick another.');
    }

    const { data, error } = await db.from('access_codes')
      .update({ code: next }).eq('code', user.code).select('code');
    if (error) throw new Error(error.message);
    if (!data || !data.length) {
      bad('Msimbo wa sasa haupo. / The current code no longer exists.');
    }
    // The caller must sign in again with the new one; nothing here hands back a session.
    return { ok: true };
  },

  /* AWAY TODAY -- an absence recorded as a window, not a switch.
     =====================================================================================
       "I need a feature to suspend a user at (Access codes - mfumo (portal)) so that they
        don't appear anywhere unless reactivated, e.g one credit aint there today so if I
        suspend him the customer distribution of today is auto to the available ones"
       "so suspension is recorded by date picker start and end date"

     Two dates and nothing else. A switch has to be turned back on by somebody remembering
     to; an absence has an end that is already known on the day it is entered, so recording
     the end means the person comes back by themselves on the right morning. There is no
     scheduler in this system and this needs none -- the window is read against today's date
     in EAT, wherever it is asked about.

     TWO COLUMNS AND NO OTHERS, exactly like accessCodeLeader beside it. Routing this through
     saveAccessCode would rewrite the whole row -- role, teams, tabs -- to change a date, and
     a save that quietly restates fields nobody touched is how a person's navs get reverted
     by somebody setting their leave. */
  async accessCodeSuspend(db, user, args) {
    requireWrite(user); requireSettings(user);
    const code = String((args && args.code) || '').trim();
    if (!code) throw new Error('code is required.');
    const clean = v => {
      const s = String(v == null ? '' : v).trim().slice(0, 10);
      if (!s) return null;
      // A calendar-valid ISO day or nothing. The picker sends this shape; a hand-built call
      // must not be able to put "31 Feb" or free text into a date column.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) bad('Tarehe si sahihi. / That date is not valid.');
      const d = new Date(s + 'T00:00:00Z');
      if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
        bad('Tarehe si sahihi. / That date is not valid.');
      }
      return s;
    };
    const from = clean(args && args.from);
    const to = clean(args && args.to);
    /* A window that ends before it begins is a typo every time, and it would read as "not
       suspended at all" -- the most confusing possible answer, because the pane would show
       two dates filled in beside somebody who is plainly still working. */
    if (from && to && to < from) {
      bad('Tarehe ya mwisho iko kabla ya ya kuanza. / The end date is before the start date.');
    }
    /* A `to` with no `from` is not a window and must not be stored as half of one -- see the
       migration. Refused rather than silently dropped, because the operator filled in a box
       and is entitled to know it did nothing. */
    if (to && !from) {
      bad('Weka tarehe ya kuanza pia. / A start date is needed as well as an end date.');
    }
    /* THE LOCKOUT GUARD. Admin is never subject to a window at sign-in, so storing one would
       be a date sitting on a screen doing nothing -- and a person reading it would believe
       that admin was away. Refused where the mistake is made instead. */
    if (from && isAdminRole(await roleOfCode(db, code))) {
      bad('Msimbo wa ADMIN hauwezi kusimamishwa — ndiyo njia ya kurudisha wengine. '
        + '/ An ADMIN code cannot be suspended: it is the way back for everybody else.');
    }
    const { data, error } = await db.from('access_codes')
      .update({ suspend_from: from, suspend_to: to }).eq('code', code).select('code');
    if (error) {
      if (/suspend_from|suspend_to/i.test(String(error.message))) bad(SUSPEND_NOT_READY);
      throw new Error(error.message);
    }
    if (!data || !data.length) throw new Error('Unknown code: ' + code);
    return { ok: true, code, from, to };
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

  /* =====================================================================================
     ENROLMENT -- the required details, the completeness check, and the RSM being told.
     =====================================================================================
       IT SOP A.1   "Collect the required details: FULL NAME, ID NUMBER, CONTACT INFORMATION,
                     and REFEREES, from the RSM/team leader."
       IT SOP A.2   "Enter the details into the system accurately and completely."
       IT SOP A.3   "VERIFY DATA COMPLETENESS BEFORE ACTIVATING THE ACCOUNT."
       IT SOP A.4   "Notify the RSM/General Manager once enrollment is complete."
       RSM SOP E.1  "Confirm with the IT Officer that all agents/team leaders are enrolled with
                     correct, complete details."
       CSM SOP H.1  the same question again, at national level.

     THREE SOPs ASK ONE QUESTION AND NOTHING COULD ANSWER IT. The register arrives by uploading
     Sipho's SyscoPos page: a list, with no notion of a missing field, no notion of a record
     having been CHECKED, and no way to tell an RSM their person is on it. "Are all your agents
     enrolled with complete details" was answered by scrolling.

     A.3 IS THE ONLY GATE HERE. It says completeness is verified BEFORE the account is
     activated, which means activation has to be an ACT rather than a column that arrives set
     to true -- so there is exactly one way to switch an account on, and it counts the missing
     fields first and refuses.

     WHAT THE GATE DOES NOT DO is reach back and switch off two hundred people who were on the
     register before it existed. Their rows are shown as unverified, and the desk has a tile
     counting exactly them; deactivating a working company to satisfy a checklist is not what
     A.3 means. The gate governs activation from here on. */

  /** The desk. Everybody on the register, worst first, with what is missing from each. */
  async enrolQueue(db, user, args) {
    requireNav(user, 'enrol');
    const a = args || {};
    let raw;
    let columnsReady = true;
    try {
      raw = await fetchAll(() => db.from('hoop_agents').select(ENROL_COLS_WIDE));
    } catch (e) {
      if (!ENROL_NEW_COLS.test(String(e && e.message))) throw e;
      columnsReady = false;
      raw = await fetchAll(() => db.from('hoop_agents').select(ENROL_COLS_NARROW));
    }
    /* WHO HAS ACTUALLY SIGNED A HANDSET ON. One read of the phone roster, keyed the way the
       app keys it (last nine digits), because the two tables describe the same humans with no
       foreign key between them. */
    let inApp = new Set();
    try {
      const users = await fetchAll(() => db.from('call_users').select('phone'));
      inApp = new Set(users.map(u => pnorm(u.phone)).filter(Boolean));
    } catch (e) { /* the roster is a nicety here; the register is the answer */ }
    const all = raw.map(r => enrolRow(r, inApp.has(pnorm(r.phone))));

    const branch = String(a.branch || '').trim();
    const state = String(a.state || '').trim();
    const q = String(a.q || '').trim().toUpperCase();
    const shown = all.filter(r => {
      if (branch && K(r.branch) !== K(branch)) return false;
      if (state === 'gaps' && r.complete) return false;
      if (state === 'unverified' && r.verifiedAt) return false;
      if (state === 'live' && (r.verifiedAt || !r.active)) return false;
      if (state === 'unnotified' && (!r.verifiedAt || r.notifiedAt)) return false;
      if (state === 'off' && r.active) return false;
      if (state === 'noapp' && r.inApp) return false;
      if (q && !((r.name + ' ' + r.phone + ' ' + r.branch + ' ' + r.role).toUpperCase().includes(q))) return false;
      return true;
    }).sort(enrolWorstFirst);

    /* PER BRANCH, because that is the shape RSM SOP E.1 asks the question in: an RSM wants
       their own region's answer, not the company's. */
    const byBranch = {};
    for (const r of all) {
      const k = r.branch || '—';
      const b = byBranch[k] || (byBranch[k] = { branch: k, total: 0, gaps: 0, unverified: 0, inApp: 0 });
      b.total++;
      if (!r.complete) b.gaps++;
      if (!r.verifiedAt) b.unverified++;
      if (r.inApp) b.inApp++;
    }
    return { ok: true,
      columnsReady,
      notReadyNote: columnsReady ? '' : ENROL_NOT_READY,
      fields: ENROL_FIELDS.map(([key, , label]) => ({ key, label })),
      branches: [...new Set(all.map(r => r.branch).filter(Boolean))].sort(),
      rows: shown.slice(0, 1500),
      shown: shown.length,
      byBranch: Object.values(byBranch).sort((x, y) => (y.gaps - x.gaps) || (y.total - x.total)),
      counts: {
        total: all.length,
        active: all.filter(r => r.active).length,
        gaps: all.filter(r => !r.complete).length,
        unverified: all.filter(r => !r.verifiedAt).length,
        // The state that should not exist and does: switched on, never checked. A.3 in one number.
        liveUnverified: all.filter(r => r.active && !r.verifiedAt).length,
        unnotified: all.filter(r => r.verifiedAt && !r.notifiedAt).length,
        inApp: all.filter(r => r.inApp).length,
        idOdd: all.filter(r => r.idOdd).length,
      } };
  },

  /** A.1 and A.2: the details, entered against the phone number the register is keyed on.
      NEVER touches active, verified or notified -- those are A.3 and A.4 and are their own
      acts, for the same reason registration must not be a way to re-enable an account. */
  async enrolSave(db, user, args) {
    requireNav(user, 'enrol');
    requireWrite(user);
    const a = args || {};
    const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 160);
    const phone = phone0(a.phone);
    if (!phone) bad('Namba ya simu si sahihi. / That is not a Tanzanian mobile number.');
    /* PostgREST reports an unknown column by RESOLVING with an error rather than by throwing,
       so this has to LOOK at it: reading only `data` turned "run the migration" into "that
       person is not in the register", which sends somebody hunting for a row that is there. */
    let before = null;
    try {
      const { data, error } = await db.from('hoop_agents').select(ENROL_COLS_WIDE).eq('phone', phone).maybeSingle();
      if (error) throw error;
      before = data || null;
    } catch (e) {
      if (!ENROL_NEW_COLS.test(String((e && (e.message || e.details)) || '')) && !tableMissing(e)) throw e;
      bad(ENROL_NOT_READY);
    }
    const at = new Date().toISOString();
    const row = {
      phone,
      name: S(a.name, 160), national_id: S(a.nationalId, 60), email: S(a.email, 160),
      role: S(a.role, 80), branch: S(a.branch, 80),
      kin_name: S(a.kinName, 160), kin_phone: S(a.kinPhone, 60), kin_relationship: S(a.kinRel, 60),
      kin2_name: S(a.kin2Name, 160), kin2_phone: S(a.kin2Phone, 60), kin2_relationship: S(a.kin2Rel, 60),
      updated_at: at,
    };
    if (a.manager != null) row.manager = S(a.manager, 120);
    if (!row.name) bad('Andika jina kamili. / A full name is required (SOP A.1).');
    if (before) {
      /* AN EDIT THAT EMPTIES A REQUIRED FIELD UNDOES THE CHECK. Verification is about the
         details as they stood when somebody looked at them, so a row that loses one is a row
         nobody has checked. The account is NOT switched off by this -- a typo must not cost
         somebody their day -- and the desk counts "live but never checked" separately. */
      const after = { ...before, ...row };
      if (enrolGaps(after).length && before.verified_at) {
        row.verified_by = null; row.verified_at = null;
      }
    } else {
      /* A.3: A NEW ENROLMENT IS NOT LIVE UNTIL IT IS CHECKED. The column's own default is
         true, so this has to say so out loud -- and it is the whole reason activation is an
         act rather than a flag somebody remembers to set. */
      row.active = false;
      row.enrolled_by = user.name || '';
      row.enrolled_at = at;
      row.joined_date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.joined || '')) ? String(a.joined) : at.slice(0, 10);
    }
    const { error } = await db.from('hoop_agents').upsert(row, { onConflict: 'phone' });
    if (error) {
      if (tableMissing(error)) bad(ENROL_NOT_READY);
      throw new Error(error.message);
    }
    const gaps = enrolGaps({ ...(before || {}), ...row });
    return { ok: true, phone, created: !before, gaps,
      complete: gaps.length === 0,
      /* Said back rather than left for somebody to notice: an ID of the wrong length is the
         one slip on this form that no human eye catches. */
      idOdd: idLooksOdd(row.national_id) };
  },

  /** A.3 and A.4, and the switch-off that keeps the register honest. Three different acts by
      possibly three different days, so each is its own step with its own stamp. */
  async enrolUpdate(db, user, args) {
    requireNav(user, 'enrol');
    requireWrite(user);
    const a = args || {};
    const phone = phone0(a.phone);
    if (!phone) bad('Mfanyakazi hajachaguliwa. / No staff member chosen.');
    let row;
    try {
      const { data, error } = await db.from('hoop_agents').select(ENROL_COLS_WIDE).eq('phone', phone).maybeSingle();
      if (error) throw error;
      row = data || null;
    } catch (e) {
      if (!ENROL_NEW_COLS.test(String((e && (e.message || e.details)) || '')) && !tableMissing(e)) throw e;
      bad(ENROL_NOT_READY);
    }
    if (!row) bad('Mfanyakazi hayupo kwenye register. / That person is not in the register.');
    const step = String(a.step || '').trim().toLowerCase();
    const at = new Date().toISOString();
    const patch = { updated_at: at };
    let mail = null;

    if (step === 'verify') {
      /* THE GATE. Counted from the row as it is stored, not from anything the client sends --
         a completeness check the caller can assert is not a check. */
      const gaps = enrolGaps(row);
      if (gaps.length) {
        const labels = ENROL_FIELDS.filter(([k]) => gaps.includes(k)).map(([, , l]) => l.split(' / ')[0]);
        bad('Bado hakijakamilika (SOP A.3): ' + labels.join(', ')
          + '. / Not complete yet — the account cannot be activated until these are filled in: '
          + ENROL_FIELDS.filter(([k]) => gaps.includes(k)).map(([, , l]) => l.split(' / ')[1] || l).join(', '));
      }
      patch.verified_by = user.name || '';
      patch.verified_at = at;
      // A.3 in one line: the check and the activation are the same act.
      patch.active = true;
    } else if (step === 'notify') {
      if (!row.verified_at) bad('Thibitisha kwanza kabla ya kutoa taarifa (SOP A.3 kabla ya A.4). '
        + '/ Verify it before announcing it — A.4 says "once enrollment is complete".');
      let to = '';
      try {
        const { data: s } = await db.from('settings').select('value').eq('key', 'ENROL_EMAIL').maybeSingle();
        to = issueDeptEmails(s && s.value, row.branch || '')
          || String((s && s.value) || '').split(/[\n;]/).map(x => x.trim()).find(x => x && !/[=:]/.test(x)) || '';
      } catch (e) { to = ''; }
      /* The GM is the standing fallback: A.4 names "the RSM/General Manager", so an office that
         has set only one address has still named somebody. */
      mail = to
        ? await sendMail(db, { to, subject: 'HOOPLOAN — usajili umekamilika / enrolment complete: ' + (row.name || phone),
          html: noticeHtml('Usajili umekamilika / Enrolment complete', [
            ['Jina / Name', row.name || ''], ['Simu / Phone', phone],
            ['Wadhifa / Role', row.role || '—'], ['Tawi / Branch', row.branch || '—'],
            ['Kitambulisho / ID', row.national_id || '—'],
            ['Amethibitishwa na / Verified by', row.verified_by || user.name || ''],
          ], 'IT SOP A.4: taarifa kwa RSM/GM baada ya usajili kukamilika. '
           + '/ IT SOP A.4: the RSM and General Manager are told once enrolment is complete.') })
        : await sendMail(db, { toKey: 'GM_EMAIL', subject: 'HOOPLOAN — usajili umekamilika / enrolment complete: ' + (row.name || phone),
          html: noticeHtml('Usajili umekamilika / Enrolment complete', [
            ['Jina / Name', row.name || ''], ['Simu / Phone', phone],
            ['Wadhifa / Role', row.role || '—'], ['Tawi / Branch', row.branch || '—'],
          ], 'IT SOP A.4. ENROL_EMAIL haijawekwa kwa tawi hili. / No ENROL_EMAIL line for this branch.') });
      if (!mail.sent) bad('Barua pepe haikutumwa: ' + mail.reason
        + ' / The email was not sent: ' + mail.reason);
      patch.notified_at = at;
      patch.notified_to = String(mail.to || '').slice(0, 200);
    } else if (step === 'off') {
      const note = String(a.note == null ? '' : a.note).trim().slice(0, 300);
      if (!note) bad('Andika sababu ya kuzima akaunti. / A reason is required to switch an account off.');
      patch.active = false;
      patch.enrol_note = note;
    } else {
      bad('Hatua si sahihi. / Unknown step.');
    }
    const { data, error } = await db.from('hoop_agents').update(patch).eq('phone', phone).select('phone');
    if (error) {
      if (tableMissing(error)) bad(ENROL_NOT_READY);
      throw new Error(error.message);
    }
    if (!data || !data.length) bad('Mfanyakazi hayupo kwenye register. / That person is not in the register.');
    return { ok: true, phone, step,
      verified: !!patch.verified_at, active: patch.active,
      emailed: !!(mail && mail.sent), to: (mail && mail.to) || '' };
  },

  /* =====================================================================================
     THE WEEKLY IT REPORT (IT SOP E).
     =====================================================================================
       IT SOP E    "Prepare and SUBMIT regular IT reports to the General Manager on SYSTEM
                    PERFORMANCE, ENROLLMENT STATUS, and TECHNICAL ISSUES RESOLVED, and ensure
                    all system activities comply with company policy and data protection
                    regulations. REPORTS ARE DUE ON A WEEKLY BASIS."
       IT SOP C.2  "Monitor system uptime and performance across inventory, sales and finance
                    modules, on a DAILY basis" -- the daily check this weekly report is made of.

     THREE SECTIONS, BECAUSE THE SOP NAMES THREE, and nothing else is added to them. A report
     that answers a different question from the one it was asked is a report nobody trusts the
     second week.

     EVERY NUMBER IS ALREADY SOMEWHERE. This composes; it does not keep its own copy of
     anything. The door's log (SOP D), the staff register (SOP A), the issues log (SOP C), the
     daily uploads, the handsets' own heartbeats.

     THE POSTGRES BUDGET, warm, per call: 21 HEAD requests (three files x seven days, counts
     and no rows) + 1 door read + 1 register read + 1 roster read + 3 bounded issues reads
     + 1 device read + 2 head counts. A weekly report read by one person; the head requests
     are what keeps "did Tuesday's file arrive" from costing tens of thousands of rows. */

  async itWeekly(db, user, args) {
    requireNav(user, 'itrep');
    const a = args || {};
    const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    /* THE WEEK, MONDAY TO SUNDAY, on the EAT clock. Somebody opening this on a Friday means
       this week; somebody writing up Monday morning means last week, which is one button. */
    let from = isDay(a.from) ? String(a.from) : weekMondayKey();
    let to = isDay(a.to) ? String(a.to) : dayShift(from, 6);
    if (from > to) { const t = from; from = to; to = t; }
    const days = daysBetween(from, to);
    const fromISO = from + 'T00:00:00.000Z';
    const toISO = to + 'T23:59:59.999Z';

    /* ---- 1. SYSTEM PERFORMANCE (SOP C.2's three modules, and the door) ---- */
    const feeds = [];
    for (const [key, table, col, label] of ITREP_FEEDS) {
      const byDay = [];
      for (const d of days) byDay.push({ day: d, rows: await feedDay(db, table, col, d) });
      feeds.push({ key, label, byDay,
        arrived: byDay.filter(x => x.rows > 0).length,
        missing: byDay.filter(x => x.rows === 0).map(x => x.day) });
    }
    const door = await signinWindow(db, from, to);
    const doorGroups = signinGroups(door.rows);
    const alertFails = await signinAlertFails(db);

    let devices = { total: 0, seen: 0, dark: 0, locked: 0, released: 0 };
    try {
      const rows = await fetchAll(() => db.from('devices').select('imei, state, last_seen'));
      const fromMs = Date.parse(fromISO);
      devices = {
        total: rows.length,
        seen: rows.filter(r => r.last_seen && Date.parse(r.last_seen) >= fromMs).length,
        // Never spoke, or has not spoken since before this week began.
        dark: rows.filter(r => !r.last_seen || Date.parse(r.last_seen) < fromMs).length,
        locked: rows.filter(r => r.state === 'locked').length,
        released: rows.filter(r => r.state === 'released').length,
      };
    } catch (e) { /* the device registry is a later migration; its absence is not a failure */ }

    let calls = 0;
    try {
      const { count } = await db.from('call_logs')
        .select('id', { count: 'exact', head: true }).gte('call_date', from).lte('call_date', to);
      calls = num(count);
    } catch (e) { calls = 0; }

    /* ---- 2. ENROLMENT STATUS (SOP A, and the question RSM E.1 asks) ---- */
    let agents = [];
    let columnsReady = true;
    try {
      agents = await fetchAll(() => db.from('hoop_agents').select(ENROL_COLS_WIDE));
    } catch (e) {
      if (!ENROL_NEW_COLS.test(String(e && e.message))) throw e;
      columnsReady = false;
      agents = await fetchAll(() => db.from('hoop_agents').select(ENROL_COLS_NARROW));
    }
    let roster = [];
    try { roster = await fetchAll(() => db.from('call_users').select('phone, last_sync, active')); }
    catch (e) { roster = []; }
    const inApp = new Set(roster.map(u => pnorm(u.phone)).filter(Boolean));
    const staff = agents.map(r => enrolRow(r, inApp.has(pnorm(r.phone))));
    const enrolment = {
      total: staff.length,
      active: staff.filter(r => r.active).length,
      gaps: staff.filter(r => !r.complete).length,
      unverified: staff.filter(r => !r.verifiedAt).length,
      liveUnverified: staff.filter(r => r.active && !r.verifiedAt).length,
      unnotified: staff.filter(r => r.verifiedAt && !r.notifiedAt).length,
      inApp: staff.filter(r => r.inApp).length,
      // Enrolled THIS WEEK -- the number that says whether the desk did any work.
      newThisWeek: staff.filter(r => r.enrolledAt && r.enrolledAt >= Date.parse(fromISO)
        && r.enrolledAt <= Date.parse(toISO)).length,
      verifiedThisWeek: staff.filter(r => r.verifiedAt && r.verifiedAt >= Date.parse(fromISO)
        && r.verifiedAt <= Date.parse(toISO)).length,
      columnsReady,
    };
    const syncedMs = Date.parse(fromISO);
    const app = {
      accounts: roster.length,
      activeAccounts: roster.filter(u => u.active !== false).length,
      syncedThisWeek: roster.filter(u => u.last_sync && Date.parse(u.last_sync) >= syncedMs).length,
      calls,
    };

    /* ---- 3. TECHNICAL ISSUES RESOLVED (SOP C, filed by the issues log) ---- */
    const issues = { raised: 0, resolved: 0, open: 0, escalated: 0, avgDays: 0,
      oldestOpenDays: 0, byDept: [], notReady: false, resolvedRows: [] };
    try {
      const [raised, closed, live] = await Promise.all([
        fetchAll(() => db.from('issues').select(ITREP_ISSUE_COLS).gte('raised_at', fromISO).lte('raised_at', toISO)),
        fetchAll(() => db.from('issues').select(ITREP_ISSUE_COLS).gte('resolved_at', fromISO).lte('resolved_at', toISO)),
        fetchAll(() => db.from('issues').select(ITREP_ISSUE_COLS).neq('status', 'resolved')),
      ]);
      issues.raised = raised.length;
      issues.resolved = closed.length;
      issues.open = live.length;
      issues.escalated = live.filter(r => r.status === 'escalated').length;
      const spans = closed.map(r => (Date.parse(r.resolved_at) - Date.parse(r.raised_at)) / 86400000)
        .filter(n => Number.isFinite(n) && n >= 0);
      issues.avgDays = spans.length ? Math.round((spans.reduce((s, n) => s + n, 0) / spans.length) * 10) / 10 : 0;
      const now = Date.now();
      issues.oldestOpenDays = live.reduce((mx, r) => {
        const d = (now - Date.parse(r.raised_at)) / 86400000;
        return Number.isFinite(d) ? Math.max(mx, Math.floor(d)) : mx;
      }, 0);
      const by = {};
      for (const r of raised) (by[r.department || '—'] = by[r.department || '—'] || { department: r.department || '—', raised: 0, resolved: 0, open: 0 }).raised++;
      for (const r of closed) (by[r.department || '—'] = by[r.department || '—'] || { department: r.department || '—', raised: 0, resolved: 0, open: 0 }).resolved++;
      for (const r of live) (by[r.department || '—'] = by[r.department || '—'] || { department: r.department || '—', raised: 0, resolved: 0, open: 0 }).open++;
      issues.byDept = Object.values(by).sort((x, y) => (y.open - x.open) || (y.raised - x.raised));
      /* WHAT WAS ACTUALLY FIXED, by name. "Technical issues resolved" is a list before it is a
         number -- a GM reading "7" learns less than a GM reading seven titles. */
      issues.resolvedRows = closed.slice(0, 40).map(r => ({
        id: String(r.id), title: r.title || '', department: r.department || '',
        kind: r.kind || '', resolvedBy: r.resolved_by || '',
        at: r.resolved_at ? Date.parse(r.resolved_at) : null,
        days: Math.max(0, Math.round((Date.parse(r.resolved_at) - Date.parse(r.raised_at)) / 86400000)),
      })).sort((x, y) => (y.at || 0) - (x.at || 0));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      issues.notReady = true;
    }

    /* ---- 4. COMPLIANCE. The SOP's last clause, answered with facts rather than a promise ---- */
    const compliance = { audited: 0, readOnlyCodes: 0, suspendedCodes: 0, codes: 0,
      maskedCodes: true, auditPayloads: false };
    try {
      const { count } = await db.from('audit_log')
        .select('id', { count: 'exact', head: true }).gte('at', fromISO).lte('at', toISO);
      compliance.audited = num(count);
    } catch (e) { /* the audit table is its own migration */ }
    try {
      /* ROLE AND WINDOW ONLY. This is a compliance count, and a report that quietly carried
         the access codes themselves would be the exact failure its own last clause names. */
      const rows = await fetchAll(() => db.from('access_codes').select('role, suspend_from, suspend_to'));
      const day = todayKey();
      compliance.codes = rows.length;
      compliance.readOnlyCodes = rows.filter(r => isReadOnly({ role: r.role })).length;
      compliance.suspendedCodes = rows.filter(r => suspendedOn(r, day)).length;
    } catch (e) { /* the narrower list is a later migration; the count simply is not offered */ }

    /* ---- WAS LAST WEEK'S ACTUALLY SENT? The one thing that cannot be recomputed ---- */
    let sent = [];
    let sentNotReady = false;
    try {
      sent = await fetchAll(() => db.from('it_reports')
        .select('id, week_from, week_to, sent_at, sent_by, sent_to, summary')
        .order('sent_at', { ascending: false }).limit(20));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      sentNotReady = true;
    }
    const sentRows = sent.map(r => ({ id: String(r.id), from: r.week_from, to: r.week_to,
      at: r.sent_at ? Date.parse(r.sent_at) : null, by: r.sent_by || '', to_: r.sent_to || '',
      summary: r.summary || '' }));

    return { ok: true, from, to, days,
      sentNotReady, notReadyNote: sentNotReady ? ITREP_NOT_READY : '',
      performance: {
        feeds,
        // The number SOP C.2 exists to keep at zero: days a module had no file at all.
        missingDays: feeds.reduce((s, f) => s + f.missing.length, 0),
        devices, app,
        door: door.notReady ? null : {
          ok: door.rows.filter(r => r.ok).length,
          people: new Set(door.rows.filter(r => r.ok).map(r => r.codeKey).filter(Boolean)).size,
          fails: door.rows.filter(r => !r.ok).length,
          alarming: door.rows.filter(r => !r.ok && SIGNIN_ALARMING.includes(r.outcome)).length,
          watch: doorGroups.filter(g => g.tries >= alertFails && !g.reviewed).length,
        },
      },
      enrolment, issues, compliance,
      sent: sentRows,
      // Whether THIS period has been submitted, which is the pane's own headline.
      submitted: sentRows.some(r => r.from === from && r.to === to),
    };
  },

  /** SOP E's verb is SUBMIT. Sends the week to the GM and records that it went -- because
      "did last week's go?" is a fact about the past and cannot be recomputed from this week's
      numbers. The summary is COPIED onto the row for the same reason. */
  async itWeeklySend(db, user, args) {
    requireNav(user, 'itrep');
    requireWrite(user);
    const d = await FNS.itWeekly(db, user, args);
    const p = d.performance;
    const rows = [
      ['Kipindi / Week', d.from + ' → ' + d.to],
      ['— Utendaji wa mfumo / SYSTEM PERFORMANCE', ''],
      ['Siku bila faili / Days a file did not arrive', String(p.missingDays)],
    ].concat(p.feeds.map(f => [f.label, f.arrived + '/' + d.days.length
      + (f.missing.length ? ' — ' + f.missing.join(', ') : '')]))
      .concat([
        ['Simu zilizoripoti / Handsets that checked in', p.devices.seen + '/' + p.devices.total
          + (p.devices.dark ? ' (kimya ' + p.devices.dark + ')' : '')],
        ['Simu za kazi zilizosync / App accounts that synced', String(p.app.syncedThisWeek)],
        ['Simu zilizopigwa / Calls logged', String(p.app.calls)],
      ])
      .concat(p.door ? [
        ['Waliokataliwa mlangoni / Refused at the door', String(p.door.fails)
          + (p.door.alarming ? ' (ya kuangaliwa ' + p.door.alarming + ')' : '')],
        ['Misimbo inayosubiri uamuzi / Codes awaiting a decision', String(p.door.watch)],
      ] : [])
      .concat([
        ['— Hali ya usajili / ENROLMENT STATUS', ''],
        ['Kwenye rejista / On the register', String(d.enrolment.total)],
        ['Hazijakamilika / Incomplete', String(d.enrolment.gaps)],
        ['Hai bila kukaguliwa / Live but never checked', String(d.enrolment.liveUnverified)],
        ['Wamesajiliwa wiki hii / Enrolled this week', String(d.enrolment.newThisWeek)],
        ['Hakuna aliyeambiwa / RSM not yet told', String(d.enrolment.unnotified)],
        ['— Masuala / TECHNICAL ISSUES', ''],
        ['Yameletwa / Raised', String(d.issues.raised)],
        ['Yametatuliwa / Resolved', String(d.issues.resolved)
          + (d.issues.avgDays ? ' (wastani siku ' + d.issues.avgDays + ')' : '')],
        ['Bado wazi / Still open', String(d.issues.open)
          + (d.issues.oldestOpenDays ? ' — kongwe siku ' + d.issues.oldestOpenDays : '')],
        ['— Uzingatiaji / COMPLIANCE', ''],
        ['Matukio kwenye kumbukumbu / Audit entries', String(d.compliance.audited)],
        ['Misimbo ya kuangalia tu / Read-only codes', String(d.compliance.readOnlyCodes)],
        ['Misimbo iliyosimamishwa / Suspended codes', String(d.compliance.suspendedCodes)],
      ]);
    let to = '';
    try {
      const { data: s } = await db.from('settings').select('value').eq('key', 'IT_REPORT_EMAIL').maybeSingle();
      to = String((s && s.value) || '').trim();
    } catch (e) { to = ''; }
    const mail = to
      ? await sendMail(db, { to, subject: 'HOOPLOAN — ripoti ya IT / weekly IT report: ' + d.from + ' → ' + d.to,
        html: noticeHtml('Ripoti ya wiki ya IT / Weekly IT report', rows,
          'IT SOP E: ripoti za IT kwa Mkurugenzi kila wiki — utendaji, usajili, na masuala '
          + 'yaliyotatuliwa. / IT SOP E: weekly IT reports to the General Manager on system '
          + 'performance, enrolment status and technical issues resolved.') })
      : await sendMail(db, { toKey: 'GM_EMAIL', subject: 'HOOPLOAN — ripoti ya IT / weekly IT report: ' + d.from + ' → ' + d.to,
        html: noticeHtml('Ripoti ya wiki ya IT / Weekly IT report', rows,
          'IT SOP E. IT_REPORT_EMAIL haijawekwa, kwa hiyo imekwenda kwa GM_EMAIL. '
          + '/ IT_REPORT_EMAIL is not set, so this went to GM_EMAIL.') });
    if (!mail.sent) bad('Barua pepe haikutumwa: ' + mail.reason
      + ' / The report was not sent: ' + mail.reason);
    /* THE SUMMARY IS COPIED. Opening a June submission next January must show what was SENT in
       June, not what June looks like after six months of re-uploads and resolved issues. */
    const summary = 'faili zilizokosekana ' + p.missingDays
      + ' · rejista ' + d.enrolment.total + ' (hazijakamilika ' + d.enrolment.gaps + ')'
      + ' · masuala yameletwa ' + d.issues.raised + ', yametatuliwa ' + d.issues.resolved
      + (p.door ? ' · waliokataliwa mlangoni ' + p.door.fails : '');
    const { error } = await db.from('it_reports').insert([{
      week_from: d.from, week_to: d.to, sent_at: new Date().toISOString(),
      sent_by: user.name || '', sent_to: String(mail.to || '').slice(0, 200),
      summary: summary.slice(0, 500),
    }]);
    if (error && !tableMissing(error)) throw new Error(error.message);
    return { ok: true, sent: true, to: mail.to, from: d.from, week: d.from + ' → ' + d.to,
      /* Told plainly rather than silently: the report DID go, and the record of it did not,
         which is a different thing and the person should know which one to chase. */
      recorded: !error, recordNote: error ? ITREP_NOT_READY : '' };
  },

  /* =====================================================================================
     THE DOOR (IT SOP D).
     =====================================================================================
       "Access Controls: set and maintain user access controls so only authorized personnel
        can view or edit sensitive information."
       "Monitoring: MONITOR FOR UNAUTHORIZED ACCESS and act immediately on any breach,
        including changing the affected password."

     audit_log answers what somebody did once they were inside. It is written by audited(),
     which runs AFTER the door -- so a refused sign-in threw before it and left nothing
     anywhere. Somebody could sit and guess access codes all night and the record of that
     night would be empty. The writing half of this lives in api/_lib/signin.js; this is the
     reading half, and the acknowledgement the SOP's second sentence asks for.

     NOTHING READ HERE IS A WORKING CREDENTIAL. The code is stored as a truncated hash (for
     grouping) and a first-character mask (for recognising your own typo), and never as
     itself -- see the migration's header. */

  /** The window, grouped by the secret that was tried. Default: the last seven days. */
  async signinWatch(db, user, args) {
    requireNav(user, 'security');
    const a = args || {};
    const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const today = todayKey();
    let to = isDay(a.to) ? String(a.to) : today;
    let from = isDay(a.from) ? String(a.from) : dayShift(to, -6);
    if (from > to) { const t = from; from = to; to = t; }
    const win = await signinWindow(db, from, to);
    if (win.notReady) {
      return { ok: true, from, to, notReady: true, rows: [], groups: [], byDay: [],
        alertFails: SIGNIN_ALERT_DEFAULT,
        counts: { ok: 0, fails: 0, alarming: 0, people: 0, watch: 0 } };
    }
    const rows = win.rows;
    const alertFails = await signinAlertFails(db);
    const groups = signinGroups(rows);
    const good = rows.filter(r => r.ok);
    const bad = rows.filter(r => !r.ok);
    /* A LITTLE BAR PER DAY, so a bad night is visible without reading a single line: a
       Tuesday with four hundred refusals looks nothing like a Tuesday with four. */
    const dayMap = new Map();
    for (const r of rows) {
      let d = dayMap.get(r.day);
      if (!d) { d = { day: r.day, ok: 0, fails: 0 }; dayMap.set(r.day, d); }
      if (r.ok) d.ok++; else d.fails++;
    }
    return { ok: true, from, to, alertFails,
      // Newest first and capped: a log is read from the top and the whole of it is never the
      // question. The groups above are computed over the WHOLE window, not over this slice.
      rows: rows.slice(0, 300),
      truncated: rows.length > 300,
      groups,
      byDay: [...dayMap.values()].sort((x, y) => (x.day < y.day ? -1 : 1)),
      counts: {
        ok: good.length,
        fails: bad.length,
        alarming: bad.filter(r => SIGNIN_ALARMING.includes(r.outcome)).length,
        // Distinct codes that got in -- "how many people used the system this week".
        people: new Set(good.map(r => r.codeKey).filter(Boolean)).size,
        // The lines a person should actually look at: enough tries to be somebody working
        // at it, and nobody has written down what was done about them yet.
        watch: groups.filter(g => g.tries >= alertFails && !g.reviewed).length,
      } };
  },

  /** "ACT IMMEDIATELY ON ANY BREACH" -- and then say what was done, against the line it was
      done about. Marks every unreviewed attempt on one code in the window; a NEW attempt
      afterwards is unreviewed again and the line comes straight back to the desk. */
  async signinReview(db, user, args) {
    requireNav(user, 'security');
    requireWrite(user);
    const a = args || {};
    const key = String(a.key || '').trim();
    if (!/^[0-9a-f]{4,64}$/i.test(key)) bad('Hakuna msimbo uliochaguliwa. / No attempt chosen.');
    const note = String(a.note == null ? '' : a.note).trim().slice(0, 500);
    if (!note) bad('Andika ulichofanya (SOP D). / Write down what was done about it.');
    const at = new Date().toISOString();
    let data, error;
    try {
      ({ data, error } = await db.from('signin_attempts')
        .update({ reviewed_by: user.name || '', reviewed_at: at, review_note: note })
        .eq('code_key', key).eq('ok', false).is('reviewed_at', null).select('id'));
    } catch (e) {
      if (!tableMissing(e)) throw e;
      bad(SIGNIN_NOT_READY);
    }
    if (error) {
      if (tableMissing(error)) bad(SIGNIN_NOT_READY);
      throw new Error(error.message);
    }
    const n = (data || []).length;
    if (!n) bad('Hakuna la kuhifadhi — mtu mwingine amekwisha shughulikia. / Nothing to mark: somebody has already dealt with these.');
    return { ok: true, marked: n };
  },

  /** The window, to whoever Settings says watches the door. A courtesy on top of the pane,
      never the record -- the pane is the record, exactly as everywhere else here. */
  async signinSend(db, user, args) {
    requireNav(user, 'security');
    requireWrite(user);
    const d = await FNS.signinWatch(db, user, args);
    if (d.notReady) bad(SIGNIN_NOT_READY);
    const watch = d.groups.filter(g => g.tries >= d.alertFails && !g.reviewed).slice(0, 20);
    const rows = [
      ['Kipindi / Period', d.from + ' → ' + d.to],
      ['Zimeingia / Sign-ins', String(d.counts.ok) + ' (watu ' + d.counts.people + ')'],
      ['Zimekataliwa / Refused', String(d.counts.fails)],
      ['Za kuangaliwa / Worth a look', String(d.counts.alarming)],
      ['Misimbo inayosubiri / Codes awaiting a decision', String(d.counts.watch)],
    ].concat(watch.map(g => [
      (g.masked || g.phoneMasked || '—') + (g.whoName ? ' (' + g.whoName + ')' : ''),
      g.tries + ' × ' + Object.keys(g.outcomes).join(', ') + ' · ' + Object.keys(g.doors).join(', '),
    ]));
    const mail = await sendMail(db, { toKey: 'SECURITY_EMAIL',
      subject: 'HOOPLOAN — mlango / the door: ' + d.from + ' → ' + d.to,
      html: noticeHtml('Kumbukumbu ya mlango / Sign-in monitoring', rows,
        'IT SOP D: fuatilia kuingia kusikoruhusiwa na chukua hatua mara moja. '
        + '/ IT SOP D: monitor for unauthorized access and act immediately on any breach.') });
    if (!mail.sent) bad('Barua pepe haikutumwa: ' + mail.reason + ' / The email was not sent: ' + mail.reason);
    return { ok: true, sent: true, to: mail.to, watch: watch.length };
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
  /* THE DOOR IS WATCHED (IT SOP D). audited() below records what somebody did once they were
     inside; it runs after this line, so until signin.js there was NO record of anybody turned
     away -- a night of guessing left an empty log. noteSignin can never throw and can never
     delay a sign-in by more than one small write; see its header. */
  let user;
  try {
    user = await gatedUser(code);
  } catch (e) {
    await noteSignin(supabase, { door: 'portal', ok: false, outcome: outcomeOf(e), code,
      who: e && e.who, detail: e && e.message, ip: ipOf(req), ua: uaOf(req) });
    throw e;
  }
  /* Once per code per day, not once per request -- see rule 3 in signin.js. */
  await noteSignin(supabase, { door: 'portal', ok: true, code,
    who: { name: user.name, role: user.role }, ip: ipOf(req), ua: uaOf(req) });
  /* OWN PROPERTIES ONLY. FNS is an object literal, so it inherits from Object.prototype, and
     `FNS['constructor']`, `FNS['toString']`, `FNS['valueOf']` and their friends are all truthy.
     Every one of them sailed past this guard's 400 and got CALLED with (supabase, user, args) --
     which means past requireNav, past requireWrite, and past the audit log, the three things
     every real handler is wrapped in. `constructor` evaluated Object(supabase) and returned the
     database client itself; it only failed to reach the caller because that object happens to
     hold a circular reference and JSON.stringify threw. A 500 by luck is not a boundary. */
  const h = Object.prototype.hasOwnProperty.call(FNS, fn) ? FNS[fn] : null;
  if (typeof h !== 'function') { const e = new Error('Unknown portal fn: ' + fn); e.status = 400; throw e; }
  return audited(supabase, user, fn, args, () => h(supabase, user, args));
});
