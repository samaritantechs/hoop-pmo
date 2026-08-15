import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';

const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'], readOnly: false };
const VIEWER = { code: 'V', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['settings'], readOnly: true };

function snapsDb() {
  return fakeDb({
    watu_snapshots: [
      // yesterday
      { imei: '351929937378664', client_name: 'Alafati', team: 'KINONDONI', days_offline: 21, has_ever_paid: false, price: 450000, snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      { imei: '351738748292885', client_name: 'Yuda', team: 'KINONDONI', days_offline: 12, has_ever_paid: true, price: 450000, snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      { imei: '351929937369465', client_name: 'Rinus', team: 'TEMEKE', days_offline: 10, has_ever_paid: true, price: 450000, snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      // today: Alafati PAID (false -> true) and reconnected; Yuda sank deeper; Rinus left the list
      { imei: '351929937378664', client_name: 'Alafati', team: 'KINONDONI', days_offline: 2, has_ever_paid: true, price: 450000, snapshot_date: '2026-08-14', created_at: '2026-08-14T08:00:00Z' },
      { imei: '351738748292885', client_name: 'Yuda', team: 'KINONDONI', days_offline: 15, has_ever_paid: true, price: 450000, snapshot_date: '2026-08-14', created_at: '2026-08-14T08:00:00Z' },
    ],
  });
}

test('recovery diffs the newest two uploads per IMEI', async () => {
  const d = snapsDb();
  const r = await _FNS.recovery(d, ADMIN, {});
  assert.equal(r.latest, '2026-08-14');
  assert.equal(r.prev, '2026-08-13');
  assert.equal(r.counts.compared, 2);
  assert.equal(r.counts.paidNew, 1, 'Alafati paid for the first time');
  assert.equal(r.counts.reconnected, 1, 'Alafati\'s days offline fell 21 -> 2');
  assert.equal(r.counts.deeper, 1, 'Yuda sank 12 -> 15');
  assert.equal(r.counts.leftList, 1, 'Rinus was not on today\'s list');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].imei, '351929937378664');
  assert.equal(r.rows[0].paid, true);
});

test('recovery with one upload says so instead of inventing a comparison', async () => {
  const d = fakeDb({ watu_snapshots: [
    { imei: '1', snapshot_date: '2026-08-14', created_at: '2026-08-14T08:00:00Z' },
  ] });
  const r = await _FNS.recovery(d, ADMIN, {});
  assert.equal(r.latest, '2026-08-14');
  assert.equal(r.prev, null);
  assert.ok(r.note, 'the first upload gets an explanation, not an empty table');
});

test('newTeamCode mints a unique phone-safe code and a view-only code is refused', async () => {
  const d = fakeDb({ teams: [
    { team: 'KINONDONI', team_code: 'AB2C3D' },
    { team: 'TEMEKE', team_code: null },
  ] });
  const r = await _FNS.newTeamCode(d, ADMIN, { team: 'TEMEKE' });
  assert.match(r.code, /^[2-9A-HJKMNP-Z]{6}$/, 'no 0/O/1/I/L -- codes get read out over the phone');
  assert.notEqual(r.code, 'AB2C3D');
  const row = d._dump('teams').find(t => t.team === 'TEMEKE');
  assert.equal(row.team_code, r.code);
  await assert.rejects(() => _FNS.newTeamCode(d, VIEWER, { team: 'TEMEKE' }), /view-only/);
});

test('officerActive switches one account without touching the team code', async () => {
  const d = fakeDb({
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D' }],
    call_users: [{ user_id: 'U1', name: 'Ainea', team: 'KINONDONI', active: true }],
  });
  await _FNS.officerActive(d, ADMIN, { userId: 'U1', active: false });
  assert.equal(d._dump('call_users')[0].active, false);
  assert.equal(d._dump('teams')[0].team_code, 'AB2C3D', 'the team code must survive the cut');
});

test('settingSet refuses keys outside the whitelist', async () => {
  const d = fakeDb({ settings: [] });
  await _FNS.settingSet(d, ADMIN, { key: 'SYSTEM_OPEN', value: 'YES' });
  assert.equal(d._dump('settings')[0].value, 'YES');
  await assert.rejects(() => _FNS.settingSet(d, ADMIN, { key: 'DATA_VERSION', value: 'x' }), /not editable/);
});

test('renameAccessCode moves the secret, keeps the row, and flags self-rename', async () => {
  const d = fakeDb({ access_codes: [
    { code: '2802', name: 'MARKII', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'] },
    { code: 'OTHER', name: 'X', role: 'MANAGER', teams: null, tabs: [] },
  ] });
  const me = { ...ADMIN, code: '2802' };
  const r = await _FNS.renameAccessCode(d, me, { from: '2802', to: 'HOOP-STRONG-9' });
  assert.equal(r.self, true, 'renaming your own code must say so, so the page re-signs you in');
  const rows = d._dump('access_codes');
  assert.ok(rows.some(x => x.code === 'HOOP-STRONG-9' && x.name === 'MARKII'));
  assert.ok(!rows.some(x => x.code === '2802'));
  await assert.rejects(() => _FNS.renameAccessCode(d, me, { from: 'OTHER', to: 'HOOP-STRONG-9' }), /taken/);
  await assert.rejects(() => _FNS.renameAccessCode(d, me, { from: 'HOOP-STRONG-9', to: 'abc' }), /4 characters/);
});

test('saveRole writes the roles table and accessCodes lists every role', async () => {
  const d = fakeDb({
    access_codes: [{ code: 'X1', name: 'A', role: 'FIELD SUPERVISOR', teams: null, tabs: [] }],
    roles: [{ role: 'ADMIN', tabs: ['upload', 'settings', 'dashboard'] }],
  });
  await _FNS.saveRole(d, ADMIN, { role: 'Credit Lead', tabs: ['dashboard', 'upload', 'nonsense'] });
  const row = d._dump('roles').find(r => r.role === 'CREDIT LEAD');
  assert.deepEqual(row.tabs, ['dashboard', 'upload'], 'unknown tabs are dropped, known ones kept');
  const out = await _FNS.accessCodes(d, ADMIN, {});
  const names = out.roles.map(r => r.role);
  assert.ok(names.includes('CREDIT LEAD'), 'saved role listed');
  assert.ok(names.includes('FIELD SUPERVISOR'), 'role seen only on a code still listed');
  assert.ok(names.includes('AUDITOR'), 'suggested roles listed');
  await assert.rejects(() => _FNS.saveRole(d, VIEWER, { role: 'X', tabs: [] }), /view-only/);
});

/* ---------- the customers book ---------- */
import { todayKey } from '../api/_lib/time.js';

function dayShift(base, days) {
  const d = new Date(Date.parse(base + 'T00:00:00Z') + days * 86400000);
  return d.toISOString().slice(0, 10);
}

test('customers splits leo at day 45, keeps jana newest-per-imei, and joins the agent', async () => {
  const today = todayKey();
  const inWin = dayShift(today, -10);    // lifeDay 11 -- inside the 45-day window
  const outWin = dayShift(today, -100);  // lifeDay 101 -- Hoop's burden has lapsed
  const d = fakeDb({
    followup_status: [
      { imei: 'A1', client_name: 'Ndani', contact: '0712000001', team: 'KINONDONI', model: 'S23',
        price: 400000, disbursed_date: inWin, days_offline: 9, locked4: true, locked7: false,
        has_ever_paid: true, fu_status: null, comment_by: null, deck_date: '2026-08-14' },
      { imei: 'B2', client_name: 'Nje', contact: '0712000002', team: 'TEMEKE', model: 'A05',
        price: 300000, disbursed_date: outWin, days_offline: 30, locked4: true, locked7: true,
        has_ever_paid: false, fu_status: 'HAPATIKANI', comment_by: 'Ainea', deck_date: '2026-08-14' },
    ],
    watu_snapshots: [
      // jana carries the SAME imei twice (a re-upload) -- the newest row must win.
      { imei: 'A1', client_name: 'Ndani', client_mobile: '0712000001', team: 'KINONDONI',
        days_offline: 25, agent: 'JUMA', snapshot_date: '2026-08-13', created_at: '2026-08-13T06:00:00Z' },
      { imei: 'A1', client_name: 'Ndani', client_mobile: '0712000001', team: 'KINONDONI',
        days_offline: 11, agent: 'JUMA', snapshot_date: '2026-08-13', created_at: '2026-08-13T09:00:00Z' },
    ],
    watu_loans: [
      { imei: 'A1', agent: 'JUMA', team: 'KINONDONI' },
      { imei: 'B2', agent: 'ASHA', team: 'TEMEKE' },
    ],
    settings: [],
  });
  const r = await _FNS.customers(d, ADMIN, {});
  assert.equal(r.deckDate, '2026-08-14');
  assert.equal(r.prevDate, '2026-08-13');
  assert.equal(r.leo45.length, 1);
  assert.equal(r.leo45[0].imei, 'A1');
  assert.equal(r.leo45[0].agent, 'JUMA', 'the deck has no agent column; the register supplies it');
  assert.ok(r.leo45[0].lifeDay <= 45);
  assert.equal(r.leo45plus.length, 1);
  assert.equal(r.leo45plus[0].imei, 'B2');
  assert.equal(r.leo45plus[0].agent, 'ASHA');
  assert.equal(r.leo45plus[0].fu, 'HAPATIKANI');
  assert.equal(r.jana.length, 1, 'same-imei re-upload rows collapse to one');
  assert.equal(r.jana[0].daysOff, 11, 'the NEWEST snapshot of the day wins');
  assert.equal(r.jana[0].agent, 'JUMA', 'snapshots carry the agent themselves');
  assert.ok(Array.isArray(r.fuStatuses) && r.fuStatuses.length, 'the comment form vocabulary rides along');
});

test('customers scopes a team-bound code at the database', async () => {
  const today = todayKey();
  const d = fakeDb({
    followup_status: [
      { imei: 'A1', client_name: 'Yetu', team: 'KINONDONI', disbursed_date: dayShift(today, -5), deck_date: '2026-08-14' },
      { imei: 'B2', client_name: 'Wao', team: 'TEMEKE', disbursed_date: dayShift(today, -5), deck_date: '2026-08-14' },
    ],
    watu_snapshots: [], watu_loans: [], settings: [],
  });
  const scoped = { ...ADMIN, teams: ['KINONDONI'] };
  const r = await _FNS.customers(d, scoped, {});
  assert.equal(r.leo45.length + r.leo45plus.length, 1);
  assert.equal(r.leo45[0].imei, 'A1');
});

test('portalAddComment writes the three follow-up tables as the signed-in name', async () => {
  const d = fakeDb({
    followup_status: [{ imei: 'A1', client_name: 'Ndani', team: 'KINONDONI', fu_status: null,
      last_comment: null, comment_by: null, deck_date: '2026-08-14' }],
    followup_comments: [],
  });
  const r = await _FNS.portalAddComment(d, ADMIN, {
    imei: 'A1', team: 'KINONDONI', name: 'Ndani', fu: 'AMETOA AHADI',
    promiseDate: '2026-08-16', promiseAmt: 50000, comment: 'Ameahidi Jumamosi' });
  assert.equal(r.ok, true);
  const c = d._dump('followup_comments');
  assert.equal(c.length, 1);
  assert.equal(c[0].created_by, 'Peter', 'the access code\'s NAME signs the comment');
  assert.equal(c[0].fu_status, 'AMETOA AHADI');
  const s = d._dump('followup_status').find(x => x.imei === 'A1');
  assert.equal(s.fu_status, 'AMETOA AHADI');
  assert.equal(s.last_comment, 'Ameahidi Jumamosi');
  assert.equal(s.comment_by, 'Peter');
  assert.equal(s.deck_date, '2026-08-14', 'commenting must never move a row on or off a deck');
});

test('portalAddComment refuses a view-only code and an out-of-scope team', async () => {
  const d = fakeDb({ followup_status: [], followup_comments: [] });
  await assert.rejects(() => _FNS.portalAddComment(d, VIEWER, { imei: 'A1', comment: 'x' }), /view-only/);
  const scoped = { ...ADMIN, teams: ['KINONDONI'] };
  await assert.rejects(
    () => _FNS.portalAddComment(d, scoped, { imei: 'B2', team: 'TEMEKE', comment: 'x' }),
    /nje ya timu|outside your teams/);
});

test('portalAddComment reaches a customer with no deck row (any customer means ANY)', async () => {
  const d = fakeDb({ followup_status: [], followup_comments: [] });
  await _FNS.portalAddComment(d, ADMIN, { imei: 'Z9', team: 'TEMEKE', name: 'Mpya', comment: 'tumempata' });
  const s = d._dump('followup_status').find(x => x.imei === 'Z9');
  assert.ok(s, 'a stub row is created so the comment has a parent');
  assert.equal(s.deck_date == null, true, 'the stub joins no deck -- uploads decide the list');
  assert.equal(d._dump('followup_comments').length, 1);
});
