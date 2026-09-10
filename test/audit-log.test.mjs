import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { audited, auditList, auditPrune, AUDIT_KEEP_DAYS } from '../api/_lib/audit.js';
import { callApi } from '../api/_lib/call-core.js';

/* =========================================================================================
   THE AUDIT LOG -- who did what, when, from where, and what the value was before and after.

     "Implement audit log tab too at admin - who did what what, when, where, value b4 and
      after {auto-delete history of 15 days+}"

   THE DIFF IS DECLARED, NEVER DISCOVERED. AUDIT_DIFF names the table a call changes, how to
   find the row, and WHICH FIELDS may be recorded. A field nobody listed is not written --
   which is the old rule ("never the payload") kept rather than abandoned, because the whole
   point of an audit log is that it can be shown to people, and one carrying whole rows would
   be a second unguarded copy of the payroll and the customer book.

   IT CAN NEVER BREAK THE SAVE IT WATCHES. That rule predates this change and survives it: the
   two extra reads a diff costs are swallowed like everything else here, and a save whose diff
   failed is still a save.
   ========================================================================================= */
const ADMIN = { code: 'A1', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
const BOSS = { code: 'M1', name: 'Neema', role: 'MANAGER', teams: null, tabs: ['audit'], readOnly: false };
const OUT = { code: 'Z1', name: 'Mtu', role: 'STORE', teams: null, tabs: ['stock'], readOnly: false };
const WHERE = { ip: '41.222.180.4', ua: 'Mozilla/5.0 (Linux; Android 13; SM-A075F)' };

const auditDb = (extra = {}) => fakeDb({
  audit_log: [], settings: [], roles: [], access_codes: [], hoop_agents: [], ...extra,
});
const only = db => db._dump('audit_log');

/* ---------------------------------------------------------------------------------------- */
test('a setting change records who, what, where, and the value each side of it', async () => {
  const db = auditDb({ settings: [{ key: 'GM_EMAIL', value: 'old@hoop.co.tz' }] });
  await audited(db, ADMIN, 'settingSet', { key: 'GM_EMAIL', value: 'new@hoop.co.tz' },
    () => db.from('settings').update({ value: 'new@hoop.co.tz' }).eq('key', 'GM_EMAIL'),
    WHERE);

  const [row] = only(db);
  assert.equal(row.actor_name, 'Peter');           // who
  assert.equal(row.actor_code, 'A1');
  assert.equal(row.action, 'settingSet');          // what
  assert.equal(row.ok, true);
  assert.equal(row.ip, WHERE.ip);                  // where, as far as a server can know it
  assert.equal(row.ua, WHERE.ua);
  assert.deepEqual(row.before, { value: 'old@hoop.co.tz' });   // and the value each side
  assert.deepEqual(row.after, { value: 'new@hoop.co.tz' });
});

test('only the fields that MOVED are kept, and a save that changed nothing writes no diff', async () => {
  const db = auditDb({ access_codes: [
    { code: 'GD', name: 'Asha', role: 'SALES COORDINATOR', teams: null, tabs: ['devunlock'], active: true },
  ] });
  /* ONE FIELD MOVED. The name, the teams and the active flag are all in the allow-list and
     all unchanged, so none of them is written: a diff listing five fields to say one of them
     changed is a diff nobody reads twice. */
  await audited(db, ADMIN, 'saveAccessCode', { code: 'GD' },
    () => db.from('access_codes').update({ tabs: ['devunlock', 'newstock'] }).eq('code', 'GD'),
    WHERE);
  let [row] = only(db);
  assert.deepEqual(Object.keys(row.after), ['tabs'], 'only the field that moved');
  assert.equal(row.before.tabs, 'devunlock');
  assert.equal(row.after.tabs, 'devunlock newstock', 'an array reads as a list, not as JSON');

  /* NOTHING MOVED. The honest answer is no diff at all -- somebody pressed Save and the row
     is as it was, which two empty columns would misrepresent as a lost record. */
  await audited(db, ADMIN, 'saveAccessCode', { code: 'GD' }, () => Promise.resolve({}), WHERE);
  row = only(db)[1];
  assert.equal(row.before, null);
  assert.equal(row.after, null);
});

test('a field nobody listed is never recorded', async () => {
  /* THE OLD RULE, KEPT. An audit log readable by everyone the nav is ticked for must not
     become a second copy of what it watches, so the diff is an ALLOW-list: `passcode_hash`
     sits on the same row and is not in it, so it cannot leak by somebody adding a column. */
  const db = auditDb({ access_codes: [
    { code: 'GD', name: 'Asha', role: 'STORE', teams: null, tabs: [], active: true,
      passcode_hash: 'sha256:secret', phone: '0712000111' },
  ] });
  await audited(db, ADMIN, 'saveAccessCode', { code: 'GD' },
    () => db.from('access_codes').update({ passcode_hash: 'sha256:changed', active: false }).eq('code', 'GD'),
    WHERE);
  const [row] = only(db);
  assert.deepEqual(row.after, { active: 'false' }, 'the listed field, and only it');
  const text = JSON.stringify(row);
  assert.ok(!/secret|sha256|0712000111/.test(text), 'nothing unlisted reached the table');
});

test('a refused attempt is recorded, with what it tried to overwrite and no after', async () => {
  /* FAILED ATTEMPTS ARE WORTH MORE THAN SUCCESSFUL ONES -- somebody reaching for a row they
     may not touch is precisely what this exists to show. It changed nothing, so there is no
     "after", and saying so is the point rather than an omission. */
  const db = auditDb({ settings: [{ key: 'SYSTEM_OPEN', value: 'yes' }] });
  await assert.rejects(() => audited(db, OUT, 'settingSet', { key: 'SYSTEM_OPEN', value: 'no' },
    () => { const e = new Error('no access to the settings pane'); throw e; }, WHERE));
  const [row] = only(db);
  assert.equal(row.ok, false);
  assert.match(row.error, /no access to the settings pane/);
  assert.deepEqual(row.before, { value: 'yes' }, 'what they were reaching for');
  assert.equal(row.after, null, 'and nothing moved');
  assert.equal(row.actor_name, 'Mtu');
});

test('a bulk order has no single before and after, and does not invent one', async () => {
  /* deviceSetState takes a LIST. A diff describing one of four hundred handsets would be a
     lie about the other 399, so it is deliberately absent from AUDIT_DIFF -- the entry still
     records who, what, when and where. */
  const src = fs.readFileSync(new URL('../api/_lib/audit.js', import.meta.url), 'utf8');
  const spec = src.slice(src.indexOf('const AUDIT_DIFF = {'), src.indexOf('const K_ ='));
  assert.ok(!/^\s*deviceSetState:/m.test(spec), 'a list of phones has no one row to diff');
  assert.match(spec, /deviceDelete:/, 'but one handset by IMEI does');

  const db = auditDb({ devices: [{ imei: 'D1', state: 'locked', holder: 'SIPHO' }] });
  await audited(db, ADMIN, 'deviceSetState', { imeis: ['D1', 'D2'], state: 'enrolled' },
    () => Promise.resolve({ changed: 2 }), WHERE);
  const [row] = only(db);
  assert.equal(row.action, 'deviceSetState');
  assert.equal(row.actor_name, 'Peter');
  assert.equal(row.before, null);
  assert.equal(row.after, null);
});

test('the diff can never break the save it is watching', async () => {
  /* RULE 3, WHICH PREDATES ALL OF THIS AND SURVIVES IT. The two extra reads a diff costs are
     swallowed exactly like the write is: a save whose diff failed is still a save, and an
     audit log that could fail one would turn every write in the system into two things that
     must both succeed. */
  const db = auditDb();          // no access_codes table at all, so the diff read throws
  const out = await audited(db, ADMIN, 'saveAccessCode', { code: 'GD' },
    () => Promise.resolve({ ok: true, saved: 1 }), WHERE);
  assert.deepEqual(out, { ok: true, saved: 1 }, 'the handler\'s own answer, untouched');
});

/* =========================================================================================
   FIFTEEN DAYS, AND THE APP IS WHAT DELETES.

   There is no scheduler in this project, and a retention rule that depends on a cron nobody
   set up is a rule that silently does not exist -- the worst state for a promise about
   deleting data. So it happens where the table is already being touched.
   ========================================================================================= */
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

test('entries past the window are deleted, and the window is a setting', async () => {
  const db = auditDb({ audit_log: [
    { at: daysAgo(1), action: 'settingSet', actor_code: 'A1' },
    { at: daysAgo(14), action: 'saveRole', actor_code: 'A1' },
    { at: daysAgo(16), action: 'saveTeam', actor_code: 'A1' },
    { at: daysAgo(400), action: 'saveTeam', actor_code: 'A1' },
  ] });
  assert.equal(AUDIT_KEEP_DAYS, 15);
  await auditPrune(db, { force: true });
  assert.deepEqual(only(db).map(r => r.action), ['settingSet', 'saveRole'],
    'fifteen days and under survive; older is gone');

  /* THIRTY WITHOUT A DEPLOY. The window is a settings row, so it can be widened by the owner
     the same way every other number in this system is. */
  const wide = auditDb({
    settings: [{ key: 'AUDIT_KEEP_DAYS', value: '30' }],
    audit_log: [{ at: daysAgo(16), action: 'saveTeam' }, { at: daysAgo(40), action: 'saveTeam' }],
  });
  await auditPrune(wide, { force: true });
  assert.equal(only(wide).length, 1, 'sixteen days is inside a thirty-day window');
});

test('a nonsense window does not empty the log', async () => {
  /* A zero or a minus typed into that settings row by hand would delete everything the moment
     somebody opened the pane. The floor is one day. */
  for (const value of ['0', '-5', '', 'lots']) {
    const db = auditDb({
      settings: [{ key: 'AUDIT_KEEP_DAYS', value }],
      audit_log: [{ at: daysAgo(1), action: 'saveTeam' }],
    });
    await auditPrune(db, { force: true });
    assert.equal(only(db).length, 1, 'AUDIT_KEEP_DAYS=' + JSON.stringify(value));
  }
});

test('opening the pane prunes, and reading it never fails over the pruning', async () => {
  const db = auditDb({ audit_log: [
    { at: daysAgo(2), action: 'settingSet', actor_name: 'Peter', actor_code: 'A1', ok: true },
    { at: daysAgo(90), action: 'saveTeam', actor_name: 'Asha', actor_code: 'GD', ok: true },
  ] });
  const d = await auditList(db, {});
  assert.equal(d.available, true);
  assert.equal(d.keepDays, 15, 'the pane says how long it keeps things');
  assert.deepEqual(d.rows.map(r => r.action), ['settingSet'], 'the old one went on the way in');
  assert.deepEqual(d.actors, ['Peter']);
});

test('before the migration the pane says which file to run, rather than reading as empty', async () => {
  /* An empty table is the one conclusion an audit log must never invite by accident: "nobody
     has done anything" is exactly what a missing table looks like. */
  const db = fakeDb({ settings: [] }, { missingColumns: { audit_log: ['at'] } });
  const d = await auditList(db, {});
  assert.equal(d.available, false);
  assert.match(d.note, /RUN-ME-2026-09-13-audit-log\.sql/);
  assert.deepEqual(d.rows, []);
});

test('an audit_log without the new columns reads, and says what is missing', async () => {
  /* THE COLUMN CHECK COMES FIRST, the same trap the devices pane fell into: a table that
     predates the before/after columns must read as "run the newer migration", never as "there
     is no audit log" -- which would send an admin hunting for a table full of rows. */
  const db = fakeDb({
    settings: [],
    audit_log: [{ at: daysAgo(1), action: 'saveRole', actor_name: 'Peter', actor_code: 'A1', ok: true }],
  }, { missingColumns: { audit_log: ['ip', 'ua', 'before', 'after'] } });
  const d = await auditList(db, {});
  assert.equal(d.available, true, 'the log still reads');
  assert.equal(d.rows.length, 1);
  assert.match(d.note, /before\/after columns are missing|RUN-ME-2026-09-13/);
});

/* =========================================================================================
   THE OTHER DOOR.

     "i didnt mean sales fraud audit but system audit of system users ... or through app"

   The log watched /api/portal only, so half this system's users -- the ones who work from a
   handset all day -- did not appear in it at all.
   ========================================================================================= */
const appDb = (extra = {}) => fakeDb({
  audit_log: [], settings: [], followup_status: [], followup_comments: [],
  call_users: [{ user_id: 'U1', device_id: 'dev-1', name: 'Ainea', role: 'PCO', active: true }],
  ...extra,
});

test('a follow-up logged from the app lands in the same log, with the state each side', async () => {
  const db = appDb({ followup_status: [{ imei: '4471', fu_status: 'hakupatikana', promise_date: null }] });
  await callApi(db, 'api_callAddComment',
    ['dev-1', { ref: '4471', team: 'KINONDONI', fu: 'ahadi', comment: 'atalipa Ijumaa',
      promiseDate: '2026-09-19', promiseAmt: 50000, name: 'Alafati' }],
    Date.now(), { ip: '41.222.180.9', ua: 'HOOPLOAN/1.4 (Android 13)' });

  const [row] = only(db);
  assert.equal(row.action, 'callAddComment');
  assert.equal(row.actor_name, 'Ainea');           // who, read from the register
  assert.equal(row.actor_role, 'PCO');
  assert.equal(row.actor_code, 'dev-1', 'the device id IS the credential out there');
  assert.equal(row.ref, '4471');                   // what it was about
  assert.equal(row.ip, '41.222.180.9');            // where
  assert.match(row.subject, /ref=4471/);
  assert.match(row.subject, /stage=ahadi/);
  // THE STATE EACH SIDE, which is the one part of a comment that is a value.
  assert.equal(row.before.fu_status, 'hakupatikana');
  assert.equal(row.after.fu_status, 'ahadi');
  assert.equal(row.after.promise_date, '2026-09-19');

  /* AND NOT THE PAYLOAD. The comment's text, the amount promised and any new number live in
     followup_comments behind team scoping; this table must not become a second copy. */
  const text = JSON.stringify(row);
  assert.ok(!/atalipa Ijumaa|50000/.test(text));
});

test('the name is read from the register, never taken from the request', async () => {
  /* A name the CLIENT supplied would make the whole log worth nothing. An unregistered device
     leaves it blank and the entry still lands -- somebody working from a device id nobody
     granted is exactly the row an audit is opened for. */
  const db = appDb({ followup_status: [] });
  await assert.rejects(() => callApi(db, 'api_callAddComment',
    ['dev-STRANGER', { ref: '9', name: 'Ainea' }], Date.now(), { ip: '1.2.3.4' }));
  const [row] = only(db);
  assert.equal(row.ok, false, 'it was refused, and the attempt is the point');
  assert.equal(row.actor_code, 'dev-STRANGER');
  assert.equal(row.actor_name, null, 'no name, because no registered user answers to it');
  assert.match(row.error, /not registered/i);
});

test('a timer is not a person, and does not flood the log', async () => {
  /* RULE 1, KEPT RATHER THAN WIDENED. api_callSync runs every five minutes on every handset:
     seven officers over fifteen days is ten thousand rows of a background heartbeat, burying
     the entries somebody opened this pane to find. */
  const src = fs.readFileSync(new URL('../api/_lib/call-core.js', import.meta.url), 'utf8');
  const spec = src.slice(src.indexOf('const CALL_AUDIT = {'), src.indexOf('const CALL_DIFF'));
  assert.match(spec, /api_callRegister:/);
  assert.match(spec, /api_callAddComment:/);
  for (const quiet of ['api_callSync', 'api_callNotifSeen', 'api_callBoot', 'api_callList']) {
    assert.ok(!new RegExp('^\\s*' + quiet + ':', 'm').test(spec), quiet + ' must stay out of the log');
  }
});

test('registering on the app creates a system user, and the log says so', async () => {
  /* The door watch answers "who was turned away"; this answers "who is now able to work",
     which is what an admin asks when a name they do not recognise appears on a deck. */
  const src = fs.readFileSync(new URL('../api/_lib/call-core.js', import.meta.url), 'utf8');
  const reg = src.slice(src.indexOf('await noteSignin(db, { ...base, ok: true,'));
  assert.match(reg.slice(0, 900), /action: 'callRegister'/);
  assert.match(reg.slice(0, 900), /actorCode: String\(a\[REG_ARG\.device\]/);
  // Only the successful case: a refused attempt never made a user, and signin_attempts has it.
  const failPath = src.slice(src.indexOf('catch (e) {', src.indexOf('out = await h(db, a, nowMs);')));
  assert.ok(!/auditedApp/.test(failPath.slice(0, 200)));
});

test('the pane says which door each entry came through', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const draw = html.slice(html.indexOf('function drawAudit('), html.indexOf('function drawNewStock('));
  /* Read off the action rather than stored twice -- every app entry is written under a name
     this list already owns, and a second column that could disagree with the first is a
     column that eventually will. */
  assert.match(draw, /\/\^call\/\.test\(r\.action\|\|''\)\?'App':'Portal'/);
});

/* ---------------------------------------------------------------------------------------- */
test('it is a nav, ticked like any other, and it is a read', async () => {
  const db = auditDb({ audit_log: [{ at: daysAgo(1), action: 'saveRole', actor_code: 'A1', ok: true }] });
  /* IT USED TO BE GATED ON requireSettings, which meant the only way to let a supervisor read
     the log was to hand them the pane that edits every setting in the system -- backwards for
     a screen whose whole job is oversight. */
  assert.equal((await _FNS.audit(db, BOSS, {})).rows.length, 1, 'the tick is the permission');
  assert.equal((await _FNS.audit(db, ADMIN, {})).rows.length, 1, 'and ADMIN has it already');
  await assert.rejects(() => _FNS.audit(db, OUT, {}), /audit/);

  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  assert.match(api, /'itrep', 'audit', 'staff'/, 'audit is a real nav in NAV_TABS');
  // A log whose readers can edit it is not a log: there is no way to remove a row from here.
  const fn = api.slice(api.indexOf('  async audit(db, user, args) {'));
  assert.ok(!/delete\(\)|\.update\(|\.insert\(/.test(fn.slice(0, fn.indexOf('\n  },'))));
});

test('the pane asks the five questions in the order somebody asks them', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const draw = html.slice(html.indexOf('function drawAudit('), html.indexOf('function drawNewStock('));
  const at = t => { const i = draw.indexOf(t); assert.ok(i > 0, 'missing: ' + t); return i; };
  assert.ok(at('Lini / when') < at('Nani / who'));
  assert.ok(at('Nani / who') < at('Alifanya nini / what'));
  assert.ok(at('Alifanya nini / what') < at('Wapi / where'));
  assert.ok(at('Wapi / where') < at('Ilikuwa → imekuwa / before → after'));
  // The retention is stated on the pane, in the number the server actually uses.
  assert.match(draw, /d\.keepDays\|\|15/);
  assert.match(draw, /zinafutwa zenyewe baada ya siku/);
  /* AND EVERY FILTER SAYS WHAT IT FILTERS. Two bare date boxes side by side are
     indistinguishable, and which end is which is the one thing somebody needs to know. */
  assert.match(draw, /fld\('Kitendo \/ action',/);
  assert.match(draw, /fld\('Kuanzia \/ from',/);
  assert.match(draw, /fld\('Hadi \/ to',/);

  // A refused attempt keeps its reason and is not dressed as an ordinary row.
  assert.match(draw, /r\.ok===false/);
  assert.match(draw, /imekataliwa \/ refused/);
});
