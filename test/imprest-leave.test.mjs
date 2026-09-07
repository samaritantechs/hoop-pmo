import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch, sendMail, noticeHtml } from '../api/_lib/mail.js';
import { todayKey, addDaysKey } from '../api/_lib/time.js';

/* =========================================================================================
   IMPREST AND LEAVE: five panes, five grants, two forms the office already prints.

     "they need to make imprest requests that will be approved by their admnistrator and a
      copy stays for the gm review ... request tab, approval tab and imprest reports tab ...
      they want to be asking for leaves in app (another nav), and hr approves or rejects
      there (another one)"

   The same rule as the advance tests: THE PERMISSION IS THE NAV. Nothing here names an
   administrator, a CEO or HR; the fixtures hold panes, and a test that asserted on a role
   name would be testing a rule the code deliberately does not have.
   ========================================================================================= */
const ASKER = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['impreq', 'leavereq'], readOnly: false };
const ADMIN_IMP = { code: 'D1', name: 'NEEMA M', role: 'OFFICER', teams: null, tabs: ['impappr'], readOnly: false };
const CEO = { code: 'G1', name: 'BOSS', role: 'MANAGER', teams: null, tabs: ['imprep'], readOnly: false };
const HR = { code: 'H1', name: 'SIPHO K', role: 'HR', teams: null, tabs: ['leaveappr'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['impreq', 'impappr', 'leavereq', 'leaveappr'], readOnly: true };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const impDb = (o = {}) => fakeDb({
  imprest_roles: o.roles || [{ role: 'CREDIT', accommodation_per_day: 40000 }, { role: 'RSM', accommodation_per_day: 70000 }],
  imprest_requests: o.requests || [], imprest_retirements: o.retirements || [], imprest_photos: o.photos || [],
  leave_requests: o.leaves || [], settings: o.settings || [],
});
const GOOD_ASK = {
  fullName: 'Juma Gwaho', mobile: '0712000000', email: 'juma@hoop.co.tz', imprestRole: 'credit',
  payMode: 'MPESA', accountNo: '0712000000', travelDate: '2026-09-15', destination: 'Morogoro',
  fareTrips: 2, farePerTrip: 15000, accomDays: 3, other1Desc: 'Chakula', other1Amount: 20000,
  purpose: 'Kufuatilia wateja wa Morogoro',
};
const aRequest = o => ({
  id: o.id, requested_at: o.at || '2026-09-01T08:00:00Z', staff_code: o.code || 'A1',
  staff_name: o.name || 'JUMA G', staff_role: 'OFFICER', full_name: o.fullName || 'Juma Gwaho',
  email: 'juma@hoop.co.tz', imprest_role: o.role || 'CREDIT', pay_mode: 'MPESA', account_no: '0712',
  travel_date: o.travel || '2026-09-15', destination: o.dest || 'Morogoro',
  fare_trips: 2, fare_per_trip: 15000, fare_amount: 30000, accom_days: 3, accom_rate: 40000, accom_amount: 120000,
  other1_desc: 'Chakula', other1_amount: 20000, other2_amount: 0, other3_amount: 0,
  total_amount: o.total == null ? 170000 : o.total, purpose: 'Wateja', status: o.status || 'pending',
  approved_amount: o.approved == null ? null : o.approved, comment: o.comment || null,
  decided_by: o.by || null, decided_at: o.decidedAt || null,
  retired_at: o.retiredAt || null, retire_total: o.retireTotal == null ? null : o.retireTotal,
  retire_balance: o.retireBalance == null ? null : o.retireBalance,
});
// A tiny, valid JPEG-shaped data URL of the given decoded size -- what the phone sends after shrinking.
const photoOf = bytes => 'data:image/jpeg;base64,' + Buffer.alloc(bytes, 7).toString('base64');

/* Email is observed, never sent: swap the transport and record what would have gone. */
function captureMail() {
  const sent = [];
  const prev = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  _setFetch(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ id: 'msg_' + sent.length }) };
  });
  return { sent, restore() { _setFetch(null); if (prev == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; } };
}

/* ---------------------------------------------------------------------------------------- */
test('the five panes are five separate grants, and view-only codes can look but not write', async () => {
  const d = impDb({ requests: [aRequest({ id: uid('r1') })] });
  const denied = async (fn, user, args) => {
    await assert.rejects(() => _FNS[fn](d, user, args || {}), e => e.status === 403,
      fn + ' must refuse a user who was never granted its pane');
  };
  // impreq is the right to ASK and to retire one's own trip; nothing else.
  await denied('impQueue', ASKER); await denied('impDecide', ASKER, { id: uid('r1'), approve: true });
  await denied('impReport', ASKER); await denied('impRoleSave', ASKER, { role: 'X', rate: 1 });
  // impappr decides and owns the rate table; it does not file the CEO's report.
  await denied('impMine', ADMIN_IMP); await denied('impReport', ADMIN_IMP);
  await denied('impRetire', ADMIN_IMP, { id: uid('r1') });
  // imprep reviews; it neither asks nor decides.
  await denied('impMine', CEO); await denied('impQueue', CEO);
  await denied('impDecide', CEO, { id: uid('r1'), approve: true }); await denied('impRoleSave', CEO, { role: 'X', rate: 1 });
  // Leave: the asker cannot sit at HR's desk, HR cannot ask on the asker's pane.
  await denied('leaveQueue', ASKER); await denied('leaveDecide', ASKER, { id: uid('r1'), approve: true });
  await denied('leaveMine', HR);
  // A view-only code holding every nav still cannot write a thing.
  for (const [fn, args] of [['impRequest', GOOD_ASK], ['impDecide', { id: uid('r1'), approve: true }],
    ['impRoleSave', { role: 'X', rate: 1 }], ['impRoleDelete', { role: 'CREDIT' }],
    ['impRetire', { id: uid('r1') }], ['leaveRequest', {}], ['leaveDecide', { id: uid('r1'), approve: true }]]) {
    await denied(fn, VIEWER, args);
  }
  assert.equal(d._dump('imprest_requests').length, 1, 'nothing was written by any refused call');
  // ADMIN IS FULL ACCESS EVERYWHERE WE DEVELOP.
  const q = await _FNS.impQueue(d, OWNER, {});
  assert.equal(q.rows.length, 1);
  const lq = await _FNS.leaveQueue(d, OWNER, {});
  assert.ok(Array.isArray(lq.rows));
});

test('the new navs are on the list the role editor is built from', async () => {
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const m = /const NAV_TABS = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'NAV_TABS is a literal list');
  for (const k of ['impreq', 'impappr', 'imprep', 'leavereq', 'leaveappr']) {
    assert.ok(m[1].includes(`'${k}'`), k + ' must be a nav the owner can tick, or nobody can ever be granted it');
  }
});

/* ---------------------------------------------------------------------------------------- */
test('a request is stamped from the session and costed by the server from its parts', async () => {
  const d = impDb();
  const r = await _FNS.impRequest(d, ASKER, Object.assign({}, GOOD_ASK, {
    // Whatever the client sends for totals or identity is not believed.
    staffName: 'SOMEBODY ELSE', staffCode: 'ZZ', status: 'approved', total: 1, totalAmount: 1,
    fareAmount: 1, accomAmount: 1, accomRate: 999999,
  }));
  assert.equal(r.total, 2 * 15000 + 3 * 40000 + 20000, 'fare 30,000 + nights 120,000 + other 20,000');
  assert.equal(r.accomRate, 40000, 'the CREDIT rate, from the approver\'s table, case-insensitively');
  const [row] = d._dump('imprest_requests');
  assert.equal(row.staff_code, 'A1'); assert.equal(row.staff_name, 'JUMA G'); assert.equal(row.staff_role, 'OFFICER');
  assert.equal(row.status, 'pending', 'nobody may post their own request in as approved');
  assert.equal(row.imprest_role, 'CREDIT', 'stored upper-cased, as the rate table keys it');
  assert.equal(row.fare_amount, 30000); assert.equal(row.accom_amount, 120000); assert.equal(row.accom_rate, 40000);
  assert.equal(row.total_amount, 170000);
  assert.equal(row.recipient_name, 'Juma Gwaho', 'a blank recipient means the requester');
  assert.equal(row.other2_amount, 0);
});

test('a request is refused for the reasons the paper form would be sent back', async () => {
  const d = impDb();
  const bad = async (patch, re) => {
    await assert.rejects(() => _FNS.impRequest(d, ASKER, Object.assign({}, GOOD_ASK, patch)), re);
  };
  await bad({ fullName: ' ' }, /jina|name/i);
  await bad({ email: 'not-an-email' }, /barua|email/i);
  await bad({ imprestRole: '' }, /wadhifa|role/i);
  await bad({ imprestRole: 'CEO' }, /kiwango|no rate/i);            // a role with no rate yet
  await bad({ travelDate: '15/09/2026' }, /tarehe|date/i);
  await bad({ purpose: '' }, /madhumuni|purpose/i);
  await bad({ fareTrips: 1.5 }, /namba nzima|whole/i);
  await bad({ other2Amount: 5000, other2Desc: '' }, /eleza|describe/i); // a figure with no name
  await bad({ fareTrips: 0, farePerTrip: 0, accomDays: 0, other1Amount: 0 }, /gharama|no costs/i);
  assert.equal(d._dump('imprest_requests').length, 0, 'and nothing was written');
});

test('the rate table is the approver\'s: upsert by role, whole numbers, case-folded', async () => {
  const d = impDb({ roles: [] });
  await _FNS.impRoleSave(d, ADMIN_IMP, { role: ' credit ', rate: '40000' });
  await _FNS.impRoleSave(d, ADMIN_IMP, { role: 'CREDIT', rate: 45000 });   // same role, new figure
  await _FNS.impRoleSave(d, ADMIN_IMP, { role: 'ceo', rate: 0 });
  const roles = (await _FNS.impRoles(d, ASKER)).roles;           // the requester may read it
  assert.deepEqual(roles.map(r => [r.role, r.rate]), [['CEO', 0], ['CREDIT', 45000]], 'one row per role, sorted');
  assert.equal(roles[0].by, 'NEEMA M');
  await assert.rejects(() => _FNS.impRoleSave(d, ADMIN_IMP, { role: 'RSM', rate: 12.5 }), /namba nzima|whole/i);
  await assert.rejects(() => _FNS.impRoleSave(d, ADMIN_IMP, { role: '', rate: 1 }), /jina|role name/i);
  await _FNS.impRoleDelete(d, ADMIN_IMP, { role: 'ceo' });
  assert.deepEqual((await _FNS.impRoles(d, CEO)).roles.map(r => r.role), ['CREDIT']);
});

test('a later rate change never reprices a trip already filed', async () => {
  const d = impDb();
  await _FNS.impRequest(d, ASKER, GOOD_ASK);
  await _FNS.impRoleSave(d, ADMIN_IMP, { role: 'CREDIT', rate: 90000 });
  const [row] = d._dump('imprest_requests');
  assert.equal(row.accom_rate, 40000, 'the rate in force was stamped');
  assert.equal(row.accom_amount, 120000);
  const mine = await _FNS.impMine(d, ASKER);
  assert.equal(mine.rows[0].accomRate, 40000);
  assert.equal(mine.roles.find(r => r.role === 'CREDIT').rate, 90000, 'the form previews the NEW rate for the next trip');
});

test('the request pane shows you your own trips and nobody else\'s', async () => {
  const d = impDb({ requests: [
    aRequest({ id: uid('m1'), code: 'A1', at: '2026-09-01T08:00:00Z' }),
    aRequest({ id: uid('m2'), code: 'A1', at: '2026-09-03T08:00:00Z' }),
    aRequest({ id: uid('theirs'), code: 'B2', name: 'ANOTHER' }),
  ] });
  const r = await _FNS.impMine(d, ASKER);
  assert.deepEqual(r.rows.map(x => x.id), [uid('m2'), uid('m1')], 'own rows only, newest first');
  assert.ok(r.rows.every(x => x.mine));
  assert.ok(!('staffCode' in r.rows[0]) && !('staff_code' in r.rows[0]), 'the access code never rides the wire');
});

/* ---------------------------------------------------------------------------------------- */
test('the approver sees every request, counts over the whole table, pending first', async () => {
  const d = impDb({ requests: [
    aRequest({ id: uid('p1'), code: 'A1', at: '2026-09-01T08:00:00Z' }),
    aRequest({ id: uid('ok1'), code: 'B2', status: 'approved', approved: 170000, at: '2026-09-02T08:00:00Z' }),
    aRequest({ id: uid('ok2'), code: 'C3', status: 'approved', approved: 100000, retiredAt: '2026-09-05T08:00:00Z', retireTotal: 90000, retireBalance: 10000 }),
    aRequest({ id: uid('no1'), code: 'B2', status: 'rejected', comment: 'Hapana' }),
    aRequest({ id: uid('p2'), code: 'D4', at: '2026-09-04T08:00:00Z' }),
  ] });
  const all = await _FNS.impQueue(d, ADMIN_IMP, {});
  assert.deepEqual(all.counts, { pending: 2, approved: 2, rejected: 1, toRetire: 1 });
  assert.deepEqual(all.rows.slice(0, 2).map(r => r.id), [uid('p2'), uid('p1')], 'pending first, newest of those first');
  const pend = await _FNS.impQueue(d, ADMIN_IMP, { state: 'pending' });
  assert.equal(pend.rows.length, 2);
  assert.deepEqual(pend.counts, all.counts, 'narrowing the list does not move the widgets');
  const toRet = await _FNS.impQueue(d, ADMIN_IMP, { state: 'toRetire' });
  assert.deepEqual(toRet.rows.map(r => r.id), [uid('ok1')], 'approved, paid, and no receipts back yet');
  const dec = await _FNS.impQueue(d, ADMIN_IMP, { state: 'decided' });
  assert.equal(dec.rows.length, 3);
});

test('an approver may grant less than was asked but never more, and a rejection must say why', async () => {
  const d = impDb({ requests: [aRequest({ id: uid('r1'), total: 170000 })] });
  const r = await _FNS.impDecide(d, ADMIN_IMP, { id: uid('r1'), approve: true, approvedAmount: '150000', comment: 'Bila chakula' });
  assert.equal(r.status, 'approved'); assert.equal(r.granted, 150000);
  const row = d._dump('imprest_requests')[0];
  assert.equal(row.total_amount, 170000, 'what was ASKED survives the decision');
  assert.equal(row.approved_amount, 150000); assert.equal(row.decided_by, 'NEEMA M'); assert.equal(row.comment, 'Bila chakula');
  await assert.rejects(() => _FNS.impDecide(d, ADMIN_IMP, { id: uid('r1'), approve: false, comment: 'x' }), /tayari|already/i,
    'a decided request is not decided twice');

  const d2 = impDb({ requests: [aRequest({ id: uid('r2'), total: 50000 })] });
  await assert.rejects(() => _FNS.impDecide(d2, ADMIN_IMP, { id: uid('r2'), approve: true, approvedAmount: 60000 }), /zaidi|more than/i);
  await assert.rejects(() => _FNS.impDecide(d2, ADMIN_IMP, { id: uid('r2'), approve: true, approvedAmount: 0 }), /namba nzima|whole/i);
  await assert.rejects(() => _FNS.impDecide(d2, ADMIN_IMP, { id: uid('r2'), approve: false, comment: '  ' }), /sababu|comment is required/i);
  assert.equal(d2._dump('imprest_requests')[0].status, 'pending', 'and nothing was written');
  // Blank amount on approve means "as asked".
  await _FNS.impDecide(d2, ADMIN_IMP, { id: uid('r2'), approve: true, approvedAmount: '' });
  assert.equal(d2._dump('imprest_requests')[0].approved_amount, 50000);
  await assert.rejects(() => _FNS.impDecide(d2, ADMIN_IMP, { id: 'not-a-uuid', approve: true }), /chagu|chosen/i);
});

test('two approvers pressing at once: the second is told, not silently overwritten', async () => {
  const d = impDb({ requests: [aRequest({ id: uid('r1') })] });
  const real = d.from.bind(d);
  let raced = false;
  d.from = name => {
    const q = real(name);
    if (name === 'imprest_requests' && !raced) {
      // The first read sees "pending"; by the time the guarded update runs, somebody else decided.
      const exec = q._exec.bind(q);
      q._exec = () => { const out = exec(); if (q.mode === 'select' && !raced) { raced = true; d._dump('imprest_requests')[0].status = 'rejected'; } return out; };
    }
    return q;
  };
  await assert.rejects(() => _FNS.impDecide(d, ADMIN_IMP, { id: uid('r1'), approve: true }), /mtu mwingine|somebody else/i);
  assert.equal(d._dump('imprest_requests')[0].status, 'rejected', 'the earlier decision stands');
});

/* ---------------------------------------------------------------------------------------- */
test('the retirement is the traveller\'s own, on an approved trip, once, with small photos', async () => {
  const d = impDb({ requests: [
    aRequest({ id: uid('ok'), code: 'A1', status: 'approved', approved: 150000 }),
    aRequest({ id: uid('pend'), code: 'A1' }),
    aRequest({ id: uid('theirs'), code: 'B2', status: 'approved', approved: 100000 }),
  ] });
  const good = { id: uid('ok'), fareActual: 30000, accomActual: 100000, other1Actual: 15000, notes: 'Hoteli ilikuwa rahisi',
    photos: [photoOf(50 * 1024), photoOf(80 * 1024), photoOf(120 * 1024)] };
  // Somebody else's trip reads as "no such request" -- the right to ask is not the right to learn what exists.
  await assert.rejects(() => _FNS.impRetire(d, ASKER, Object.assign({}, good, { id: uid('theirs') })), /halipo|no longer exists/i);
  await assert.rejects(() => _FNS.impRetire(d, ASKER, Object.assign({}, good, { id: uid('pend') })), /idhinish|approved request/i);
  await assert.rejects(() => _FNS.impRetire(d, ASKER, Object.assign({}, good, { photos: [] })), /picha|photo/i);
  await assert.rejects(() => _FNS.impRetire(d, ASKER, Object.assign({}, good, { photos: [photoOf(10), photoOf(10), photoOf(10), photoOf(10)] })), /3/);
  await assert.rejects(() => _FNS.impRetire(d, ASKER, Object.assign({}, good, { photos: [photoOf(201 * 1024)] })), /kubwa|too large/i);
  await assert.rejects(() => _FNS.impRetire(d, ASKER, Object.assign({}, good, { photos: ['data:text/html;base64,PHNjcmlwdD4='] })), /halali|valid image/i);
  await assert.rejects(() => _FNS.impRetire(d, ASKER, Object.assign({}, good, { fareActual: 'abc' })), /namba nzima|whole/i);
  assert.equal(d._dump('imprest_retirements').length, 0, 'nothing filed by any refused call');
  assert.equal(d._dump('imprest_photos').length, 0);

  const r = await _FNS.impRetire(d, ASKER, good);
  assert.equal(r.total, 145000); assert.equal(r.approved, 150000);
  assert.equal(r.balance, 5000, 'positive: the traveller brings 5,000 back');
  assert.equal(r.photos, 3);
  const ret = d._dump('imprest_retirements')[0];
  assert.equal(ret.request_id, uid('ok')); assert.equal(ret.filed_by_name, 'JUMA G'); assert.equal(ret.total_actual, 145000);
  assert.equal(ret.photo_count, 3);
  const ph = d._dump('imprest_photos');
  assert.deepEqual(ph.map(p => p.seq), [1, 2, 3]);
  assert.deepEqual(ph.map(p => p.bytes), [50 * 1024, 80 * 1024, 120 * 1024], 'the weight is measured here, not trusted');
  const row = d._dump('imprest_requests').find(x => x.id === uid('ok'));
  assert.ok(row.retired_at); assert.equal(row.retire_total, 145000); assert.equal(row.retire_balance, 5000);

  // Once, ever.
  await assert.rejects(() => _FNS.impRetire(d, ASKER, good), /tayari|already been retired/i);
  assert.equal(d._dump('imprest_retirements').length, 1);
});

test('the photos are fetched one request at a time, and never ride along with a list', async () => {
  const d = impDb({
    requests: [aRequest({ id: uid('ok'), code: 'A1', status: 'approved', approved: 100000, retiredAt: '2026-09-05T08:00:00Z', retireTotal: 90000, retireBalance: 10000 }),
      aRequest({ id: uid('theirs'), code: 'B2', status: 'approved', approved: 100000, retiredAt: '2026-09-05T08:00:00Z' })],
    photos: [{ request_id: uid('ok'), seq: 2, data: photoOf(20), bytes: 20 }, { request_id: uid('ok'), seq: 1, data: photoOf(10), bytes: 10 },
      { request_id: uid('theirs'), seq: 1, data: photoOf(30), bytes: 30 }],
  });
  const wire = JSON.stringify([await _FNS.impMine(d, ASKER), await _FNS.impQueue(d, ADMIN_IMP, {}), await _FNS.impReport(d, CEO, {})]);
  assert.ok(!wire.includes('base64'), 'no list carries a photo');
  const mine = await _FNS.impPhotos(d, ASKER, { id: uid('ok') });
  assert.deepEqual(mine.photos.map(p => p.seq), [1, 2], 'in order, whatever order the table returned');
  await assert.rejects(() => _FNS.impPhotos(d, ASKER, { id: uid('theirs') }), /halipo|no longer exists/i,
    'a requester sees only their own receipts');
  const gm = await _FNS.impPhotos(d, CEO, { id: uid('theirs') });
  assert.equal(gm.photos.length, 1, 'a reviewer sees anybody\'s');
  const adm = await _FNS.impPhotos(d, ADMIN_IMP, { id: uid('theirs') });
  assert.equal(adm.photos.length, 1);
  await assert.rejects(() => _FNS.impPhotos(d, HR, { id: uid('ok') }), e => e.status === 403);
});

/* ---------------------------------------------------------------------------------------- */
test('the CEO\'s report: by travel date, with the retirement beside each row and honest totals', async () => {
  const d = impDb({
    requests: [
      aRequest({ id: uid('a'), travel: '2026-09-03', status: 'approved', approved: 170000, retiredAt: '2026-09-06T08:00:00Z', retireTotal: 150000, retireBalance: 20000 }),
      aRequest({ id: uid('b'), travel: '2026-09-10', status: 'approved', approved: 100000, retiredAt: '2026-09-12T08:00:00Z', retireTotal: 130000, retireBalance: -30000 }),
      aRequest({ id: uid('c'), travel: '2026-09-20', status: 'approved', approved: 80000 }),
      aRequest({ id: uid('d'), travel: '2026-09-21' }),
      aRequest({ id: uid('e'), travel: '2026-09-22', status: 'rejected', comment: 'no' }),
      aRequest({ id: uid('old'), travel: '2026-08-15', status: 'approved', approved: 500000 }),
    ],
    retirements: [
      { request_id: uid('a'), filed_at: '2026-09-06T08:00:00Z', filed_by_name: 'JUMA G', fare_actual: 30000, accom_actual: 100000, other1_actual: 20000, other2_actual: 0, other3_actual: 0, total_actual: 150000, notes: 'ok', photo_count: 3 },
      { request_id: uid('b'), filed_at: '2026-09-12T08:00:00Z', filed_by_name: 'JUMA G', fare_actual: 30000, accom_actual: 100000, other1_actual: 0, other2_actual: 0, other3_actual: 0, total_actual: 130000, notes: null, photo_count: 2 },
    ],
  });
  const r = await _FNS.impReport(d, CEO, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.totals.count, 5, 'August\'s trip is outside the period');
  assert.deepEqual(r.totals, { count: 5, pending: 1, rejected: 1, approved: 3, approvedAmount: 350000,
    retired: 2, toRetire: 1, spent: 280000, toRefund: 20000, toReimburse: 30000 });
  const a = r.rows.find(x => x.id === uid('a'));
  assert.equal(a.retirement.total, 150000); assert.equal(a.retirement.photos, 3); assert.equal(a.retirement.by, 'JUMA G');
  assert.equal(r.rows.find(x => x.id === uid('c')).retirement, null);
  assert.deepEqual((await _FNS.impReport(d, CEO, { from: '2026-09-01', to: '2026-09-30', status: 'retired' })).rows.map(x => x.id).sort(), [uid('a'), uid('b')].sort());
  assert.deepEqual((await _FNS.impReport(d, CEO, { from: '2026-09-01', to: '2026-09-30', status: 'toRetire' })).rows.map(x => x.id), [uid('c')]);
  assert.deepEqual((await _FNS.impReport(d, CEO, { from: '2026-09-01', to: '2026-09-30', status: 'pending' })).rows.map(x => x.id), [uid('d')]);
  assert.equal((await _FNS.impReport(d, CEO, {})).totals.count, 6, 'no dates means everything');
});

test('each imprest pane says which migration to run instead of failing', async () => {
  const d = fakeDb({ imprest_requests: [], imprest_roles: [], imprest_retirements: [], leave_requests: [], settings: [] },
    { missingColumns: { imprest_requests: ['id'], imprest_roles: ['role'], leave_requests: ['id'] } });
  for (const [fn, user] of [['impMine', ASKER], ['impQueue', ADMIN_IMP], ['impReport', CEO], ['impRoles', ASKER], ['leaveMine', ASKER], ['leaveQueue', HR]]) {
    const r = await _FNS[fn](d, user, {});
    assert.equal(r.notReady, true, fn + ' reports not-ready rather than throwing');
  }
  await assert.rejects(() => _FNS.impRequest(d, ASKER, GOOD_ASK), /RUN-ME-2026-09-07-imprest-leave\.sql/);
});

/* ---------------------------------------------------------------------------------------- */
test('email is a courtesy: the administrator is nudged, the CEO gets the approval copy, and nothing depends on it', async () => {
  const cap = captureMail();
  try {
    const d = impDb({ settings: [{ key: 'IMPREST_ADMIN_EMAIL', value: 'admin@hoop.co.tz; second@hoop.co.tz' },
      { key: 'IMPREST_CEO_EMAIL', value: 'gm@hoop.co.tz' }, { key: 'EMAIL_FROM', value: 'HOOPLOAN <no-reply@hoop.co.tz>' }] });
    const ask = await _FNS.impRequest(d, ASKER, GOOD_ASK);
    assert.equal(ask.emailed, true);
    assert.equal(cap.sent.length, 1);
    assert.deepEqual(cap.sent[0].body.to, ['admin@hoop.co.tz', 'second@hoop.co.tz'], 'several addresses, split on ; or ,');
    assert.equal(cap.sent[0].body.from, 'HOOPLOAN <no-reply@hoop.co.tz>');
    assert.match(cap.sent[0].body.subject, /imprest/i);
    assert.match(cap.sent[0].body.html, /170,000/);
    assert.ok(!cap.sent[0].body.html.includes('<script'), 'facts are escaped into the notice');

    const id = d._dump('imprest_requests')[0].id;
    // The fake gives inserted rows a non-uuid id; decide by the same shape the client would send.
    d._dump('imprest_requests')[0].id = uid('sent');
    const dec = await _FNS.impDecide(d, ADMIN_IMP, { id: uid('sent'), approve: true, approvedAmount: 160000 });
    assert.deepEqual(dec.emailed, { ceo: true, requester: true });
    assert.equal(cap.sent.length, 3);
    assert.deepEqual(cap.sent[1].body.to, ['gm@hoop.co.tz'], 'the copy that "stays for the gm review"');
    assert.match(cap.sent[1].body.html, /160,000/);
    assert.deepEqual(cap.sent[2].body.to, ['juma@hoop.co.tz'], 'the requester, at the address on the form');
    void id;
  } finally { cap.restore(); }
});

test('a rejection copies the requester but not the CEO; a mail provider that is down loses no request', async () => {
  const cap = captureMail();
  try {
    const d = impDb({ requests: [aRequest({ id: uid('r1') })], settings: [{ key: 'IMPREST_CEO_EMAIL', value: 'gm@hoop.co.tz' },
      { key: 'IMPREST_ADMIN_EMAIL', value: 'admin@hoop.co.tz' }] });
    const dec = await _FNS.impDecide(d, ADMIN_IMP, { id: uid('r1'), approve: false, comment: 'Safari si ya lazima' });
    assert.equal(dec.emailed.ceo, false); assert.equal(dec.emailed.requester, true);
    assert.equal(cap.sent.length, 1);
    assert.match(cap.sent[0].body.html, /REJECTED/);

    // The provider falls over.
    _setFetch(async () => { throw new Error('ECONNRESET'); });
    const r = await _FNS.impRequest(d, ASKER, GOOD_ASK);
    assert.equal(r.emailed, false); assert.match(r.emailNote, /ECONNRESET/);
    assert.equal(d._dump('imprest_requests').length, 2, 'the request was filed regardless');
    // The provider answers with an error.
    _setFetch(async () => ({ ok: false, status: 422, json: async () => ({ message: 'Invalid `from` field' }) }));
    const r2 = await _FNS.impRequest(d, ASKER, GOOD_ASK);
    assert.equal(r2.emailed, false); assert.match(r2.emailNote, /Invalid `from` field/);
  } finally { cap.restore(); }
});

test('without a key or an address, sendMail says so and never throws', async () => {
  const prev = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const d = fakeDb({ settings: [{ key: 'HR_EMAIL', value: 'hr@hoop.co.tz' }] });
    const r = await sendMail(d, { toKey: 'HR_EMAIL', subject: 's', html: 'h' });
    assert.equal(r.sent, false); assert.match(r.reason, /RESEND_API_KEY/);
    process.env.RESEND_API_KEY = 'k';
    _setFetch(async () => { throw new Error('must not be called with no recipient'); });
    const r2 = await sendMail(d, { toKey: 'IMPREST_CEO_EMAIL', subject: 's', html: 'h' });
    assert.equal(r2.sent, false); assert.match(r2.reason, /IMPREST_CEO_EMAIL/);
    const r3 = await sendMail(d, { to: 'garbage', subject: 's', html: 'h' });
    assert.equal(r3.sent, false);
    assert.match(noticeHtml('T <b>', [['k', '<i>'], ['n', 1234567]], '<f>'), /T &lt;b&gt;[\s\S]*&lt;i&gt;[\s\S]*1,234,567 TZS[\s\S]*&lt;f&gt;/);
  } finally { _setFetch(null); if (prev == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; }
});

test('the email settings are editable from the Settings pane and the writes are audited', () => {
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  for (const k of ['IMPREST_ADMIN_EMAIL', 'IMPREST_CEO_EMAIL', 'HR_EMAIL', 'EMAIL_FROM']) {
    assert.match(src, new RegExp(`EDITABLE_SETTINGS[\\s\\S]{0,800}'${k}'`), k + ' must be a setting the office can change without a deploy');
  }
  for (const f of ['impRequest', 'impDecide', 'impRetire', 'impRoleSave', 'impRoleDelete', 'leaveRequest', 'leaveDecide']) {
    assert.ok(src.includes(`AUDITED.add('${f}')`), f + ' is audited');
  }
  /* AND THE AUDIT LOG NEVER HOLDS A RECEIPT. impRetire's arguments carry up to three photos;
     the audit helper keeps only the identifying fields it is told to, so a 600KB payload
     leaves one short line. Pinned here because a future "keep everything" would be silent. */
  const audit = fs.readFileSync(new URL('../api/_lib/audit.js', import.meta.url), 'utf8');
  const keep = /const KEEP = \[([^\]]+)\]/.exec(audit);
  assert.ok(keep && !/photos|data/.test(keep[1]), 'photos never reach the audit table');
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-07-imprest-leave.sql', import.meta.url), 'utf8');
  for (const t of ['imprest_roles', 'imprest_requests', 'imprest_retirements', 'imprest_photos', 'leave_requests']) {
    assert.match(sql, new RegExp('create table if not exists ' + t + ' \\('), t + ' is created idempotently');
  }
  assert.match(sql, /on conflict \(key\) do nothing/, 'the settings seed never overwrites an address the office already set');
  assert.match(sql, /request_id\s+uuid not null unique/, 'one retirement per request, enforced by the database too');
  assert.match(sql, /unique \(request_id, seq\)/);
});

/* ---------------------------------------------------------------------------------------- */
const today = todayKey();
const inDays = n => addDaysKey(today, n);
const GOOD_LEAVE = { type: 'annual', from: inDays(14), to: inDays(18), reason: 'Kupumzika', declared: true,
  employeeId: 'HP-017', department: 'Credit', supervisor: 'Neema', contact: '0712', handedTo: 'Ally' };

test('a leave request follows the HR form: stamped, counted in working days, declaration required', async () => {
  const d = impDb();
  const r = await _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, {
    // Monday 2026-09-14 .. Friday 2026-09-25: two full weeks = 10 working days, resume Monday 28th.
    from: '2026-09-14', to: '2026-09-25', staffName: 'SOMEBODY', status: 'approved', workingDays: 99,
  }));
  assert.equal(r.workingDays, 10, 'Saturday and Sunday are not counted');
  assert.equal(r.resume, '2026-09-28', 'the first working day after the leave ends');
  const [row] = d._dump('leave_requests');
  assert.equal(row.staff_code, 'A1'); assert.equal(row.staff_name, 'JUMA G'); assert.equal(row.status, 'pending');
  assert.equal(row.working_days, 10); assert.equal(row.resume_date, '2026-09-28'); assert.equal(row.declared, true);
  assert.equal(row.employee_id, 'HP-017'); assert.equal(row.department, 'Credit'); assert.equal(row.handed_to, 'Ally');

  // A leave ending on a Friday resumes Monday; one ending mid-week resumes the next day.
  const r2 = await _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, { from: '2026-10-07', to: '2026-10-07' }));
  assert.equal(r2.workingDays, 1); assert.equal(r2.resume, '2026-10-08');

  const bad = async (patch, re) => assert.rejects(() => _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, patch)), re);
  await bad({ declared: false }, /tamko|declaration/i);
  await bad({ declared: 'true' }, /tamko|declaration/i);
  await bad({ type: 'holiday' }, /aina|leave type/i);
  await bad({ type: 'other', otherType: '' }, /eleza|kind of leave/i);
  await bad({ to: inDays(10) }, /kutangulia|before the start/i);
  await bad({ from: '14/09/2026' }, /tarehe|date/i);
  await bad({ reason: '' }, /sababu|reason/i);
  assert.equal(d._dump('leave_requests').length, 2);
});

test('under a week ahead is marked for HR, not refused -- except illness and bereavement', async () => {
  const d = impDb();
  const late = await _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, { from: inDays(3), to: inDays(4) }));
  assert.equal(late.shortNotice, true);
  const sick = await _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, { type: 'sick', from: today, to: inDays(1) }));
  assert.equal(sick.shortNotice, false, 'sudden illness is the form\'s own exception');
  const grief = await _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, { type: 'compassionate', from: inDays(1), to: inDays(3) }));
  assert.equal(grief.shortNotice, false);
  const ok = await _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, { from: inDays(7), to: inDays(8) }));
  assert.equal(ok.shortNotice, false, 'exactly one week ahead is in time');
  assert.equal(d._dump('leave_requests').length, 4, 'all four were filed');
  const q = await _FNS.leaveQueue(d, HR, {});
  assert.equal(q.counts.shortNotice, 1);
});

test('HR\'s desk: everyone\'s requests, who is away today, and a decision that must give a reason to refuse', async () => {
  const d = impDb({ leaves: [
    { id: uid('l1'), requested_at: '2026-09-01T08:00:00Z', staff_code: 'A1', staff_name: 'JUMA G', leave_type: 'annual',
      from_date: inDays(-2), to_date: inDays(2), working_days: 5, status: 'approved', short_notice: false },
    { id: uid('l2'), requested_at: '2026-09-02T08:00:00Z', staff_code: 'B2', staff_name: 'ASHA', leave_type: 'sick',
      from_date: inDays(1), to_date: inDays(3), working_days: 3, status: 'pending', short_notice: false },
    { id: uid('l3'), requested_at: '2026-09-03T08:00:00Z', staff_code: 'C3', staff_name: 'BAKARI', leave_type: 'annual',
      from_date: inDays(2), to_date: inDays(4), working_days: 3, status: 'pending', short_notice: true },
    { id: uid('l4'), requested_at: '2026-09-03T08:00:00Z', staff_code: 'A1', staff_name: 'JUMA G', leave_type: 'annual',
      from_date: inDays(30), to_date: inDays(31), working_days: 2, status: 'rejected', comment: 'no' },
  ] });
  const q = await _FNS.leaveQueue(d, HR, {});
  assert.deepEqual(q.counts, { pending: 2, approved: 1, rejected: 1, shortNotice: 1, onLeaveToday: 1 });
  assert.deepEqual(q.rows.slice(0, 2).map(r => r.status), ['pending', 'pending'], 'pending first');
  assert.deepEqual((await _FNS.leaveQueue(d, HR, { state: 'today' })).rows.map(r => r.id), [uid('l1')]);
  assert.equal((await _FNS.leaveQueue(d, HR, { state: 'decided' })).rows.length, 2);
  const mine = await _FNS.leaveMine(d, ASKER);
  assert.deepEqual(mine.rows.map(r => r.id), [uid('l4'), uid('l1')], 'own rows only, newest first');

  await assert.rejects(() => _FNS.leaveDecide(d, HR, { id: uid('l2'), approve: false, comment: '' }), /sababu|comment is required/i);
  await _FNS.leaveDecide(d, HR, { id: uid('l2'), approve: true });
  const l2 = d._dump('leave_requests').find(x => x.id === uid('l2'));
  assert.equal(l2.status, 'approved'); assert.equal(l2.decided_by, 'SIPHO K'); assert.ok(l2.decided_at);
  await assert.rejects(() => _FNS.leaveDecide(d, HR, { id: uid('l2'), approve: false, comment: 'x' }), /tayari|already/i);
  await _FNS.leaveDecide(d, HR, { id: uid('l3'), approve: false, comment: 'Hakuna mtu wa kukaimu' });
  assert.equal(d._dump('leave_requests').find(x => x.id === uid('l3')).status, 'rejected');
  await assert.rejects(() => _FNS.leaveDecide(d, HR, { id: uid('nope'), approve: true }), /halipo|no longer exists/i);
});

test('leave requests tell HR by email, and say so in the answer', async () => {
  const cap = captureMail();
  try {
    const d = impDb({ settings: [{ key: 'HR_EMAIL', value: 'hr@hoop.co.tz' }] });
    const r = await _FNS.leaveRequest(d, ASKER, GOOD_LEAVE);
    assert.equal(r.emailed, true);
    assert.deepEqual(cap.sent[0].body.to, ['hr@hoop.co.tz']);
    assert.match(cap.sent[0].body.subject, /likizo|leave/i);
    assert.match(cap.sent[0].body.html, /JUMA G/);
    const d2 = impDb();
    const r2 = await _FNS.leaveRequest(d2, ASKER, GOOD_LEAVE);
    assert.equal(r2.emailed, false); assert.match(r2.emailNote, /HR_EMAIL/);
    assert.equal(d2._dump('leave_requests').length, 1, 'filed regardless');
  } finally { cap.restore(); }
});

/* ---------------------------------------------------------------------------------------- */
test('a retirement that died half-way can be filed again, and a finished one still cannot', async () => {
  const d = impDb({ requests: [aRequest({ id: uid('ok'), code: 'A1', status: 'approved', approved: 150000 })] });
  const good = { id: uid('ok'), fareActual: 30000, accomActual: 100000, photos: [photoOf(100), photoOf(100)] };
  // First attempt: the photos insert fails after the retirement row is in.
  const real = d.from.bind(d);
  let blow = true;
  d.from = name => {
    const q = real(name);
    if (name === 'imprest_photos' && blow) {
      const exec = q._exec.bind(q);
      q._exec = () => (q.mode === 'insert' ? { data: null, error: { message: 'canceling statement due to statement timeout' } } : exec());
    }
    return q;
  };
  await assert.rejects(() => _FNS.impRetire(d, ASKER, good), /statement timeout/);
  assert.equal(d._dump('imprest_retirements').length, 1, 'the wreckage of the first attempt');
  assert.equal(d._dump('imprest_photos').length, 0);
  assert.equal(d._dump('imprest_requests')[0].retired_at, null, 'and the request does not claim to be retired');
  // Second attempt, provider recovered: it must not be told "already retired".
  blow = false;
  const r = await _FNS.impRetire(d, ASKER, Object.assign({}, good, { fareActual: 35000 }));
  assert.equal(r.total, 135000);
  assert.equal(d._dump('imprest_retirements').length, 1, 'one retirement, the second attempt\'s');
  assert.equal(d._dump('imprest_retirements')[0].fare_actual, 35000);
  assert.equal(d._dump('imprest_photos').length, 2);
  assert.ok(d._dump('imprest_requests')[0].retired_at);
  // And now it is finished, so a third press is refused before anything is cleared.
  await assert.rejects(() => _FNS.impRetire(d, ASKER, good), /tayari|already been retired/i);
  assert.equal(d._dump('imprest_retirements')[0].fare_actual, 35000, 'the finished retirement was not touched');
  assert.equal(d._dump('imprest_photos').length, 2);
});

test('figures the integer column could not hold are refused in words, not as a database error', async () => {
  const d = impDb();
  await assert.rejects(() => _FNS.impRequest(d, ASKER, Object.assign({}, GOOD_ASK, { farePerTrip: 3000000000 })), /namba nzima|whole/i);
  await assert.rejects(() => _FNS.impRequest(d, ASKER, Object.assign({}, GOOD_ASK, { fareTrips: 2000, farePerTrip: 2000000 })), /kikubwa|implausibly/i,
    'two parts that fit, whose product does not');
  await assert.rejects(() => _FNS.impRequest(d, ASKER, Object.assign({}, GOOD_ASK, { other1Amount: 1500000000, other2Desc: 'x', other2Amount: 1500000000 })), /kikubwa|implausibly/i,
    'or whose sum does not');
  assert.equal(d._dump('imprest_requests').length, 0);
  await assert.rejects(() => _FNS.leaveRequest(d, ASKER, Object.assign({}, GOOD_LEAVE, { from: '2026-01-01', to: '2027-01-03' })), /mwaka|a year/i,
    'a leave of more than a year is a typo, not a request');
});

test('a hung mail provider is cut off, the request is still filed, and a subject is one line', async () => {
  const prev = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  try {
    const src = fs.readFileSync(new URL('../api/_lib/mail.js', import.meta.url), 'utf8');
    assert.match(src, /const SEND_TIMEOUT_MS = 8000;/, 'eight seconds: longer than a send, shorter than the function');
    assert.match(src, /setTimeout\(\(\) => ctl\.abort\(\), SEND_TIMEOUT_MS\)/, 'and the timer really aborts the fetch');
    /* Do not wait eight real seconds. The transport below behaves as fetch does when its
       signal fires: it checks that a signal was handed to it at all, then rejects the way an
       aborted fetch rejects. What is proven is the wiring -- a signal reaches the transport
       and an abort comes back as "not sent", never as a thrown error or a lost row. */
    let sawSignal = false, subject = null;
    _setFetch(async (url, init) => {
      sawSignal = !!(init.signal && typeof init.signal.aborted === 'boolean');
      subject = JSON.parse(init.body).subject;
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    const d = impDb({ settings: [{ key: 'IMPREST_ADMIN_EMAIL', value: 'admin@hoop.co.tz' }] });
    const r = await _FNS.impRequest(d, ASKER, Object.assign({}, GOOD_ASK, { fullName: 'Juma\r\nBcc: x@y.z' }));
    assert.equal(sawSignal, true, 'the transport was given an abort signal');
    assert.equal(r.emailed, false); assert.match(r.emailNote, /aborted/);
    assert.equal(d._dump('imprest_requests').length, 1, 'filed regardless');
    assert.ok(!/[\r\n]/.test(subject), 'a line break typed into a name never becomes a second header');
    assert.match(subject, /Juma Bcc: x@y\.z/);
  } finally { _setFetch(null); if (prev == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; }
});
