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
