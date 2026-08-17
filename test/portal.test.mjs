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
      { imei: 'A1', agent: 'JUMA', team: 'KINONDONI', branch: 'Dar es salaam',
        guarantor_name: 'Issack daniely samawa', guarantor_phone: '0788533370' },
      { imei: 'B2', agent: 'ASHA', team: 'TEMEKE' },
    ],
    hoop_agents: [{ name: 'Juma', phone: '0712999888' }],
    call_users: [{ user_id: 'U1', name: 'Ainea', role: 'CREDIT', active: true }],
    settings: [],
  });
  const r = await _FNS.customers(d, ADMIN, {});
  assert.equal(r.leo45[0].heldBy, 'Ainea', 'Wateja names the chasing credit person -- same deal as the phones');
  assert.equal(r.deckDate, '2026-08-14');
  assert.equal(r.prevDate, '2026-08-13');
  assert.equal(r.leo45.length, 1);
  assert.equal(r.leo45[0].imei, 'A1');
  assert.equal(r.leo45[0].agent, 'JUMA', 'the deck has no agent column; the register supplies it');
  assert.equal(r.leo45[0].agentPhone, '0712999888', 'the agent\'s own number joins from Sipho\'s register');
  assert.equal(r.leo45[0].branch, 'Dar es salaam', 'the offline queue\'s branch rides the row');
  assert.equal(r.leo45[0].gName, 'Issack daniely samawa');
  assert.equal(r.leo45[0].gPhone, '0788533370');
  assert.ok(r.leo45[0].lifeDay <= 45);
  assert.equal(r.leo45plus.length, 1);
  assert.equal(r.leo45plus[0].imei, 'B2');
  assert.equal(r.leo45plus[0].agent, 'ASHA');
  assert.equal(r.leo45plus[0].gName, '', 'no guarantor on file stays an honest blank');
  assert.equal(r.leo45plus[0].fu, 'HAPATIKANI');
  assert.equal(r.jana.length, 1, 'same-imei re-upload rows collapse to one');
  assert.equal(r.jana[0].daysOff, 11, 'the NEWEST snapshot of the day wins');
  assert.equal(r.jana[0].agent, 'JUMA', 'snapshots carry the agent themselves');
  assert.ok(Array.isArray(r.fuStatuses) && r.fuStatuses.length, 'the comment form vocabulary rides along');
});

test('customers survives a database that has not run the guarantor migration yet', async () => {
  const today = todayKey();
  const d = fakeDb({
    followup_status: [
      { imei: 'A1', client_name: 'Yetu', team: 'KINONDONI', disbursed_date: dayShift(today, -5), deck_date: '2026-08-14' },
    ],
    watu_snapshots: [], settings: [],
    watu_loans: [{ imei: 'A1', agent: 'JUMA', team: 'KINONDONI' }],
    hoop_agents: [],
  }, { missingColumns: { watu_loans: ['guarantor_name', 'guarantor_phone', 'branch'] } });
  const r = await _FNS.customers(d, ADMIN, {});
  assert.equal(r.ok, true, 'the un-migrated select falls back instead of failing the tab');
  assert.equal(r.leo45[0].agent, 'JUMA', 'the agent join still works on the old columns');
  assert.equal(r.leo45[0].gName, '', 'guarantor is simply blank until the migration runs');
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

/* ---------- roles: delete only when nobody holds them ---------- */

test('deleteRole removes an unused role and refuses one still on a code', async () => {
  const d = fakeDb({
    access_codes: [{ code: 'X1', name: 'Asha', role: 'MANAGER', teams: null, tabs: [] }],
    roles: [
      { role: 'MANAGER', tabs: ['dashboard'] },
      { role: 'FIELD SUPERVISOR', tabs: [] },
    ],
    settings: [],
  });
  await assert.rejects(
    () => _FNS.deleteRole(d, ADMIN, { role: 'Manager' }),
    /bado ina watu|Still in use/, 'a held role never deletes, whatever the case of the ask');
  await _FNS.deleteRole(d, ADMIN, { role: 'FIELD SUPERVISOR' });
  assert.ok(!d._dump('roles').some(r => r.role === 'FIELD SUPERVISOR'));
  const out = await _FNS.accessCodes(d, ADMIN, {});
  const names = out.roles.map(r => r.role);
  assert.ok(!names.includes('FIELD SUPERVISOR'), 'deleted role stays gone from the list');
  assert.ok(names.includes('MANAGER'), 'the held role is untouched');
  await assert.rejects(() => _FNS.deleteRole(d, VIEWER, { role: 'STORE' }), /view-only/);
});

test('deleting a SUGGESTED role does not resurrect on the next read', async () => {
  const d = fakeDb({ access_codes: [], roles: [], settings: [] });
  let out = await _FNS.accessCodes(d, ADMIN, {});
  assert.ok(out.roles.some(r => r.role === 'STORE'), 'suggested set offers STORE');
  await _FNS.deleteRole(d, ADMIN, { role: 'STORE' });
  out = await _FNS.accessCodes(d, ADMIN, {});
  assert.ok(!out.roles.some(r => r.role === 'STORE'), 'ROLES_HIDDEN keeps it deleted');
  // Re-adding on purpose beats the hidden list: the roles table always shows.
  await _FNS.saveRole(d, ADMIN, { role: 'STORE', tabs: ['dashboard'] });
  out = await _FNS.accessCodes(d, ADMIN, {});
  assert.ok(out.roles.some(r => r.role === 'STORE'), 'an explicit re-add brings it back');
});

test('accessCodes counts holders so the page knows what is deletable', async () => {
  const d = fakeDb({
    access_codes: [
      { code: 'A', name: 'P', role: 'ADMIN', teams: null, tabs: [] },
      { code: 'B', name: 'Q', role: 'admin', teams: null, tabs: [] },
    ],
    roles: [], settings: [],
  });
  const out = await _FNS.accessCodes(d, ADMIN, {});
  const admin = out.roles.find(r => r.role === 'ADMIN');
  assert.equal(admin.inUse, 2, 'case-insensitive count');
  assert.equal(out.roles.find(r => r.role === 'STORE').inUse, 0);
});

/* ---------- mauzo: the fraud audit and the scorecards ---------- */

function mauzoDb(today) {
  return fakeDb({
    hoop_sales: [
      // in Watu under the SAME person -> OK
      { sale_key: 'S0', sale_date: dayShift(today, -4), receipt_number: '9967', client_name: 'Mussa A Iddy',
        client_phone: '0723120517', imei: '350748531117067', model: 'A07', price: 503000,
        agent: 'CYPRIAN RENATUS', commission_agent: 'Cyprian Dotto Renatus', commission_phone: '0780866571' },
      // in Watu under a different agent -> DRIFT (the real 14-Aug pattern)
      { sale_key: 'S1', sale_date: dayShift(today, -5), receipt_number: '9966', client_name: 'Musiba M Musiba',
        client_phone: '0688592516', imei: '350748531117109', model: 'A07', price: 503000,
        agent: 'CYPRIAN RENATUS', commission_agent: 'Cyprian Dotto Renatus', commission_phone: '0780866571' },
      // in Watu under a DIFFERENT agent -> DRIFT
      { sale_key: 'S2', sale_date: dayShift(today, -5), receipt_number: '9965', client_name: 'Frank George',
        client_phone: '0777735977', imei: '351481180297217', model: 'A07', price: 503000,
        agent: 'NESTORY MKONYI', commission_agent: 'Nestory Joseph', commission_phone: '0687501951' },
      // NOT in Watu, old -> HAKUNA_WATU, seller resolved from the register
      { sale_key: 'S3', sale_date: dayShift(today, -5), receipt_number: '9969', client_name: 'Fredy J Damasi',
        client_phone: '0797053513', imei: '350748531117000', model: 'A07', price: 503000,
        agent: 'CYPRIAN RENATUS', commission_agent: 'Cyprian Dotto Renatus', commission_phone: '0780866571' },
      // NOT in Watu, fresh -> PENDING
      { sale_key: 'S4', sale_date: today, receipt_number: '9970', client_name: 'Mpya Kabisa',
        client_phone: '0712000009', imei: '350000000000004', model: 'A07', price: 503000,
        agent: 'X', commission_agent: 'Y', commission_phone: '0700000004' },
      // NOT in Watu, same buyer thrice -> BULK
      { sale_key: 'S5', sale_date: dayShift(today, -6), receipt_number: '9951', client_name: 'HOPE MICROCREDIT',
        client_phone: '0677111882', imei: '351929931547231', model: 'A07', price: 503000,
        agent: 'E', commission_agent: 'ELIA CHITUZI', commission_phone: '0757578866' },
      { sale_key: 'S6', sale_date: dayShift(today, -6), receipt_number: '9952', client_name: 'HOPE MICROCREDIT',
        client_phone: '0677111882', imei: '351929931678127', model: 'A07', price: 503000,
        agent: 'E', commission_agent: 'ELIA CHITUZI', commission_phone: '0757578866' },
      { sale_key: 'S7', sale_date: dayShift(today, -6), receipt_number: '9954', client_name: 'HOPE MICROCREDIT',
        client_phone: '0677111882', imei: '351929939195892', model: 'A07', price: 503000,
        agent: 'E', commission_agent: 'ELIA CHITUZI', commission_phone: '0757578866' },
    ],
    watu_loans: [
      { imei: '350748531117067', agent: 'Cyprian Dotto Renatus', agent_id: '73963', team: 'KINONDONI',
        has_ever_paid: true, locked4: false, locked7: false, days_offline: 1, disbursed_date: dayShift(today, -8) },
      { imei: '350748531117109', agent: 'Vanence Chelehani', agent_id: '128245', team: 'KINONDONI',
        has_ever_paid: true, locked4: false, locked7: false, days_offline: 2, disbursed_date: dayShift(today, -10) },
      { imei: '351481180297217', agent: 'Sara Fisoo', agent_id: '143201', team: 'KINONDONI',
        has_ever_paid: false, locked4: true, locked7: true, days_offline: 12, disbursed_date: dayShift(today, -20) },
      { imei: '351000000000099', agent: 'Sara Fisoo', agent_id: '143201', team: 'KINONDONI',
        has_ever_paid: true, locked4: false, locked7: false, days_offline: 0, disbursed_date: dayShift(today, -100) },
    ],
    hoop_agents: [
      { phone: '0780866571', name: 'Cyprian Dotto Renatus', national_id: '111', kin_name: 'Mama Cyprian',
        kin_phone: '0700111222', role: 'Field_Officer', branch: 'Dar es salaam' },
    ],
  });
}

test('salesAudit judges every sale: OK, DRIFT, PENDING, BULK, HAKUNA_WATU', async () => {
  const today = todayKey();
  const d = mauzoDb(today);
  const r = await _FNS.salesAudit(d, ADMIN, { from: dayShift(today, -30), to: today });
  assert.equal(r.counts.total, 8);
  assert.equal(r.counts.ok, 1, 'S0: sale and loan under the same person');
  assert.equal(r.counts.drift, 2, 'S1 Cyprian-vs-Vanence and S2 Nestory-vs-Sara -- the real 14-Aug pattern');
  assert.equal(r.counts.pending, 1);
  assert.equal(r.counts.bulk, 3, 'same buyer phone three times = bulk, labeled not accused');
  assert.equal(r.counts.candidates, 1);
  const s3 = r.rows.find(x => x.saleKey === 'S3');
  assert.equal(s3.status, 'HAKUNA_WATU');
  assert.equal(s3.reg.name, 'Cyprian Dotto Renatus', 'the flagged sale names its seller from the register');
  assert.equal(s3.reg.kin, 'Mama Cyprian', 'and the next of kin rides along');
  assert.equal(r.rows[0].status, 'HAKUNA_WATU', 'worst first');
  await assert.rejects(
    () => _FNS.salesAudit(d, { ...VIEWER, readOnly: false, role: 'FINANCE', tabs: [] }, {}),
    /no access to the fraud pane/, 'a blank non-viewer is refused; the AUDITOR itself sees every pane');
});

test('agentScore scores Watu agents by their customers and sellers by their payouts', async () => {
  const today = todayKey();
  const d = mauzoDb(today);
  const r = await _FNS.agentScore(d, ADMIN, { from: dayShift(today, -30), to: today });
  const sara = r.watuAgents.find(a => a.agentId === '143201');
  assert.equal(sara.customers, 2);
  assert.equal(sara.locked7, 1);
  assert.equal(sara.paidPct, 0.5);
  assert.equal(sara.over45, 1, 'the 100-day-old loan is past the window');
  assert.equal(r.watuAgents[0].agentId, '143201', 'most locked7 first -- the one to chase');
  const cyp = r.sellers.find(s => s.phone === '0780866571');
  assert.equal(cyp.sales, 3, 'S0 + S1 + S3 all pay the same payout phone');
  assert.equal(cyp.amount, 1509000);
  assert.equal(cyp.reg.name, 'Cyprian Dotto Renatus', 'payout phone resolves the identity');
  const elia = r.sellers.find(s => s.phone === '0757578866');
  assert.equal(elia.sales, 3);
  assert.equal(elia.reg, null, 'not in the register yet -- shown as such, never invented');
});

test('ADMIN role passes every portal gate even with a blank tabs cell', async () => {
  const bareAdmin = { code: 'A0', name: 'Boss', role: 'ADMIN', teams: null, tabs: [], readOnly: false };
  const d = fakeDb({ hoop_sales: [], watu_loans: [], hoop_agents: [], access_codes: [], roles: [], settings: [] });
  const audit = await _FNS.salesAudit(d, bareAdmin, {});
  assert.equal(audit.ok, true, 'requireOps yields to the ADMIN role');
  const codes = await _FNS.accessCodes(d, bareAdmin, {});
  assert.equal(codes.ok, true, 'requireSettings yields to the ADMIN role');
  const nonAdmin = { ...bareAdmin, role: 'FINANCE' };
  await assert.rejects(() => _FNS.salesAudit(d, nonAdmin, {}), /no access to the fraud pane/,
    'a blank-tabs non-admin is still refused');
});

test('stockView groups the aged stock by holder and joins the register', async () => {
  const d = fakeDb({
    hoop_aged_stock: [
      { serial: '350115227805852', agent: 'Anord Sawe', item: 'SAMSUNG A06-64GB', received: '2026-07-03', age_days: 43, as_of: '2026-08-15' },
      { serial: '350748532603081', agent: 'Anord Sawe', item: 'SAMSUNG A07-64GB', received: '2026-08-07', age_days: 8, as_of: '2026-08-15' },
      { serial: '351929931651587', agent: 'Dariasy bakolick', item: 'SAMSUNG A07-64GB', received: '2026-08-11', age_days: 4, as_of: '2026-08-15' },
    ],
    hoop_agents: [
      { name: 'Anord Sawe', role: 'Regional_Manager', branch: 'Dar es salaam' },
    ],
  });
  const r = await _FNS.stockView(d, ADMIN, {});
  assert.equal(r.total, 3);
  assert.equal(r.asOf, '2026-08-15');
  assert.equal(r.holders[0].agent, 'Anord Sawe', 'oldest burden first');
  assert.equal(r.holders[0].pieces, 2);
  assert.equal(r.holders[0].maxAge, 43);
  assert.equal(r.holders[0].role, 'Regional_Manager', 'the register names the holder');
  assert.equal(r.holders[1].role, '', 'a holder not in the register is shown, never invented');
  assert.equal(r.serials[0].serial, '350115227805852', 'oldest serial first');
  const empty = await _FNS.stockView(fakeDb({ hoop_aged_stock: [], hoop_agents: [] }), ADMIN, {});
  assert.equal(empty.total, 0);
});

test('staffDirectory lists the whole office, seniors first, kin only for settings holders', async () => {
  const d = fakeDb({ hoop_agents: [
    { name: 'RISHADI CHELANGWA', phone: '0712657140', role: 'Field_Officer', branch: 'Dar es salaam',
      active: true, joined_date: '2026-02-21', kin_name: 'BALHATUN', kin_phone: '0715655601' },
    { name: 'Anord Sawe', phone: '0658918324', role: 'Regional_Manager', branch: 'Dar es salaam',
      active: true, joined_date: '2026-02-21', kin_name: 'Violet', kin_phone: '0682046804' },
  ] });
  const r = await _FNS.staffDirectory(d, ADMIN, {});
  assert.equal(r.total, 2);
  assert.equal(r.staff[0].name, 'Anord Sawe', 'RSM ranks above field officer');
  assert.equal(r.staff[0].kin, 'Violet', 'settings holders see the kin');
  const plain = { code: 'P', name: 'P', role: 'FINANCE', teams: null, tabs: ['dashboard', 'staff'], readOnly: false };
  const r2 = await _FNS.staffDirectory(d, plain, {});
  assert.equal(r2.staff[0].kin, undefined, 'no settings, no kin');
});

test('per-role navs: granted panes open, ungranted refuse, legacy roles keep the old doors', async () => {
  const d = fakeDb({
    watu_snapshots: [], followup_status: [], watu_loans: [], settings: [],
    roles: [], access_codes: [], hoop_agents: [],
  });
  const custOnly = { code: 'C1', name: 'Neema', role: 'CREDIT LEAD', teams: null,
    tabs: ['customers'], readOnly: false };
  const r = await _FNS.customers(d, custOnly, {});
  assert.equal(r.ok, true, 'the granted pane answers');
  await assert.rejects(() => _FNS.recovery(d, custOnly, {}), /no access to the recovery pane/);
  await assert.rejects(() => _FNS.staffDirectory(d, custOnly, {}), /no access to the staff pane/);
  const legacy = { code: 'L1', name: 'Old', role: 'MANAGER', teams: null,
    tabs: ['upload', 'settings'], readOnly: false };
  assert.equal((await _FNS.customers(d, legacy, {})).ok, true, 'legacy tabs keep the old defaults');
  assert.equal((await _FNS.recovery(d, legacy, {})).ok, true);
  assert.equal((await _FNS.salesAudit(d, legacy, {})).ok, true, 'upload/settings still grant the fraud pane');
  const salesAlias = { ...legacy, tabs: ['dashboard', 'customers', 'sales'] };
  assert.equal((await _FNS.salesAudit(d, salesAlias, {})).ok, true, "the stored 'sales' grant opens fraud");
  assert.equal((await _FNS.stockView(d, salesAlias, {})).ok, true, "...and scorecards and stock");
  assert.equal((await _FNS.customers(d, VIEWER, {})).ok, true, 'AUDITOR sees every pane');
  const out = await _FNS.accessCodes(d, ADMIN, {});
  assert.ok(Array.isArray(out.navTabs) && out.navTabs.includes('customers'),
    'the editor learns the pane list from the server');
  await _FNS.saveRole(d, ADMIN, { role: 'FINANCE', tabs: ['customers', 'sales', 'upload'] });
  const row = d._dump('roles').find(x => x.role === 'FINANCE');
  assert.deepEqual(row.tabs, ['customers', 'sales', 'upload'], 'nav keys are grantable tabs now');
});

test('stockMovement diffs both books between two dates and honors the sales alias', async () => {
  const d = fakeDb({
    hoop_aged_stock: [
      { serial: 'S1', item: 'A06', agent: 'Anord Sawe', as_of: '2026-08-14' },
      { serial: 'S2', item: 'A07', agent: 'Anord Sawe', as_of: '2026-08-14' },
      { serial: 'S2', item: 'A07', agent: 'Anord Sawe', as_of: '2026-08-15' },
      { serial: 'S3', item: 'A07', agent: 'Dariasy', as_of: '2026-08-15' },
    ],
    watu_snapshots: [
      { imei: 'W1', client_name: 'Aliyepo', agent: 'JUMA', model: 'A07', snapshot_date: '2026-08-14', created_at: '2026-08-14T08:00:00Z' },
      { imei: 'W1', client_name: 'Aliyepo', agent: 'JUMA', model: 'A07', snapshot_date: '2026-08-15', created_at: '2026-08-15T08:00:00Z' },
      { imei: 'S1', client_name: 'Mpya Kafadhiliwa', agent: 'ASHA', model: 'A06', snapshot_date: '2026-08-15', created_at: '2026-08-15T08:00:00Z' },
      { imei: 'W9', client_name: 'Ametoka', agent: 'JUMA', model: 'A07', snapshot_date: '2026-08-14', created_at: '2026-08-14T08:00:00Z' },
    ],
  });
  const r = await _FNS.stockMovement(d, ADMIN, {});
  assert.equal(r.hoopA, '2026-08-14'); assert.equal(r.hoopB, '2026-08-15');
  assert.equal(r.counts.leftHoop, 1, 'S1 left the store');
  assert.equal(r.leftHoop[0].serial, 'S1');
  assert.equal(r.counts.newInHoop, 1, 'S3 arrived');
  assert.equal(r.counts.newWatu, 1, 'S1 shows up financed into Watu -- the same phone that left the store');
  assert.equal(r.newWatu[0].imei, 'S1');
  assert.equal(r.counts.leftWatu, 1, 'W9 left the Watu book');
  const store = { code: 'S', name: 'Sipho', role: 'STORE', teams: null, tabs: ['sales'], readOnly: false };
  assert.equal((await _FNS.stockMovement(d, store, {})).ok, true, "the stored 'sales' alias opens movement");
  const noNav = { ...store, role: 'FINANCE', tabs: ['customers'] };
  await assert.rejects(() => _FNS.stockMovement(d, noNav, {}), /no access to the movement pane/);
});

test('globalSearch finds a customer by any spelling of the number, plus office and stock', async () => {
  const d = fakeDb({
    watu_loans: [
      { imei: '351416739926494', client_name: 'Jefas D Samawa', client_mobile: '255662047809',
        team: 'KINONDONI', branch: 'Dar es salaam', agent: 'Anord Sawe',
        guarantor_name: 'Issack daniely samawa', guarantor_phone: '0788533370' },
    ],
    hoop_agents: [{ name: 'Anord Sawe', phone: '0658918324', role: 'Regional_Manager', branch: 'Dar es salaam' }],
    hoop_aged_stock: [
      { serial: '350115227805852', item: 'SAMSUNG A06-64GB', agent: 'Anord Sawe', as_of: '2026-08-16' },
      { serial: '350115227805852', item: 'SAMSUNG A06-64GB', agent: 'Anord Sawe', as_of: '2026-08-15' },
    ],
    settings: [], roles: [], access_codes: [],
  });
  // The customer's phone typed the LOCAL way finds the 255-stored row.
  const r = await _FNS.globalSearch(d, ADMIN, { q: '0662047809' });
  assert.equal(r.customers.length, 1);
  assert.equal(r.customers[0].name, 'Jefas D Samawa');
  // A guarantor's name finds the customer they guarantee.
  const g = await _FNS.globalSearch(d, ADMIN, { q: 'Issack daniely' });
  assert.equal(g.customers.length, 1);
  // An agent search reaches the office register AND their customers.
  const p = await _FNS.globalSearch(d, ADMIN, { q: 'Anord Sawe' });
  assert.equal(p.people.length, 1);
  assert.equal(p.people[0].phone, '0658918324');
  assert.equal(p.customers.length, 1, 'their sold customer rides the same search');
  // A serial finds stock ONCE (newest report), not once per report date.
  const s = await _FNS.globalSearch(d, ADMIN, { q: '350115227805852' });
  assert.equal(s.stock.length, 1);
  assert.equal(s.stock[0].asOf, '2026-08-16');
});
