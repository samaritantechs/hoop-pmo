/* PGWAR/MONEY -- round-trip tests for the office panes named in the postgres-war audit
   (2026-09-20): commRates, advReport/impReport/leaveReport/issueReport, topupQueue,
   issueTargets, advRequest/advMine, staffDirectory, itWeekly.

   These are COST tests, not a second copy of the behavioural suites that already cover this
   ground (advance-rules, advance-once-a-month, imprest-leave, issues, topups, it-report):
   every test here either counts round trips and rows with the same counting() proxy
   test/speed.test.mjs uses (copied here rather than imported, so this file owns its own
   fixtures and does not re-run speed.test.mjs's own tests as a side effect of importing it),
   or proves a bounded read returns exactly what the old full-table-plus-JS-filter read did.

   THE PERMISSION IS THE NAV, as everywhere else in this codebase's tests. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { todayKey, addDaysKey } from '../api/_lib/time.js';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
const { _FNS } = await import('../api/portal.js');

/** Counts every request the code sends, exactly as fetchAll issues them: one trip per awaited
    builder, rows counted where they are answered. Copied from test/speed.test.mjs's own
    counting() (that file is not edited by this batch, and importing it here would re-run its
    module-level tests as a side effect of the import). */
function counting(tables, opts) {
  const db0 = fakeDb(tables, opts);
  let trips = 0, rows = 0;
  const wrap = q => new Proxy(q, { get(o, p) {
    if (p === 'then') return (res, rej) => o.then(r => {
      trips++; if (Array.isArray(r.data)) rows += r.data.length; return res(r);
    }, rej);
    const v = o[p];
    return typeof v === 'function' ? (...a) => { const out = v.apply(o, a); return out === o ? wrap(o) : out; } : v;
  } });
  return { db: { from: n => wrap(db0.from(n)), rpc: (n, a) => wrap(db0.rpc(n, a)), _dump: n => db0._dump(n) },
           stat: () => ({ trips, rows }) };
}
/** Bumps DATA_VERSION in a counting() fixture's own store, exactly as an upload would --
    api/upload.js upserts this same key on the last slice of every upload. */
function bumpDataVersion(c, value) {
  const rows = c.db._dump('settings');
  const row = rows.find(r => r.key === 'DATA_VERSION');
  if (row) row.value = value; else rows.push({ key: 'DATA_VERSION', value });
}

const ADMIN = { code: 'A1', name: 'PETER ADMIN', role: 'ADMIN', teams: null,
  tabs: ['commission', 'commappr', 'staff', 'issuereq', 'issues', 'itrep',
    'advreq', 'advrep', 'imprep', 'leaverep', 'issuerep', 'topups'], readOnly: false };
const D = n => addDaysKey(todayKey(), -n);        // n days before today, 'YYYY-MM-DD'

/* =========================================================================================
   FIX 1 -- commRates: the role/model dropdowns memoised per db against DATA_VERSION.
   ========================================================================================= */
test('commRates: the role and model scans cost once, not once per open', async () => {
  const book = {
    hoop_agents: [
      { role: 'Field_Officer' }, { role: 'Field_Officer' }, { role: 'Team_Leader' },
      { role: 'Regional_Manager' }, { role: 'Store_Keeper' },
    ],
    watu_loans: [{ model: 'A' }, { model: 'A' }, { model: 'B' }, { model: 'C' }],
    commission_rates: [
      { role: 'AGENT', item: 'A', amount: 75000, updated_by: 'x', updated_at: null },
      { role: 'RSM', item: 'A', amount: 30000, updated_by: 'x', updated_at: null },
    ],
    settings: [{ key: 'DATA_VERSION', value: 'v1' }],
  };
  const c = counting(book);
  const first = await _FNS.commRates(c.db, ADMIN);
  const s1 = c.stat();
  // 4,073 became 4: DATA_VERSION check, commission_rates, hoop_agents, watu_loans.
  assert.equal(s1.trips, 4, 'cold: the version check plus the three table reads');
  assert.equal(s1.rows, 11, '0 (settings) + 2 (rates) + 5 (agents) + 4 (loans)');
  assert.deepEqual(first.roles, ['ANY', 'FIELD_OFFICER', 'REGIONAL_MANAGER', 'STORE_KEEPER', 'TEAM_LEADER']);
  assert.deepEqual(first.items, ['ANY', 'A', 'B', 'C']);

  const second = await _FNS.commRates(c.db, ADMIN);
  const s2 = c.stat();
  // Warm: only the version check and the (deliberately always-fresh) rate table.
  assert.equal(s2.trips - s1.trips, 2, 'the register and the loan book are NOT re-scanned');
  assert.equal(s2.rows - s1.rows, 2, 'only the 2-row rate table is read again');
  assert.deepEqual(second.roles, first.roles, 'the memoised answer is the same answer');

  bumpDataVersion(c, 'v2');
  await _FNS.commRates(c.db, ADMIN);
  const s3 = c.stat();
  assert.equal(s3.trips - s2.trips, 4, 'a DATA_VERSION bump forces a full re-scan');
  assert.equal(s3.rows - s2.rows, 11);
});

/* =========================================================================================
   FIX 2 -- advReport / impReport / leaveReport / issueReport: from/to bound the QUERY.
   ========================================================================================= */
test('advReport: a bounded week reads a week of staff_advances, not the 120 days behind it', async () => {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({ id: 'a' + i, requested_at: D(i) + 'T08:00:00Z', staff_code: 'G' + (i % 5),
      staff_name: 'AGENT', staff_role: 'AGENT', apply_date: D(i), amount: 100000,
      status: ['pending', 'approved', 'declined'][i % 3], approved_amount: null, comment: null,
      decided_by: null, decided_at: null, bank_name: 'CRDB', account_no: '0150' });
  }
  const from = D(30), to = D(24);   // a one-week window, 30..24 days ago
  // THE OLD EXPECTATION: what a full read plus a JS `applyDate >= from && <= to` filter gave.
  const expected = rows.filter(r => r.apply_date >= from && r.apply_date <= to).map(r => r.id).sort();
  assert.equal(expected.length, 7, 'the fixture is a row a day for 120 days');

  const c = counting({ staff_advances: rows, settings: [] });
  const r = await _FNS.advReport(c.db, ADMIN, { from, to });
  assert.deepEqual(r.rows.map(x => x.id).sort(), expected, 'the bounded query returns exactly what the old JS filter did');
  assert.equal(r.totals.count, 7);
  const s = c.stat();
  assert.equal(s.trips, 1);
  assert.equal(s.rows, 7, 'a small fraction of the 120-row table, not the whole of it');
});

test('impReport: a bounded week reads a week of imprest_requests by travel date', async () => {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({ id: 'r' + i, requested_at: D(i) + 'T08:00:00Z', staff_code: 'G1', staff_name: 'AGENT',
      staff_role: 'AGENT', full_name: 'AGENT', mobile: '0712000000', travel_date: D(i),
      destination: 'Morogoro', fare_trips: 1, fare_per_trip: 15000, fare_amount: 15000,
      accom_days: 1, accom_rate: 30000, accom_amount: 30000, total_amount: 45000, purpose: 'x',
      status: ['pending', 'approved', 'rejected'][i % 3], approved_amount: null, comment: null,
      decided_by: null, decided_at: null, retired_at: null, retire_total: null, retire_balance: null });
  }
  const from = D(30), to = D(24);
  const expected = rows.filter(r => r.travel_date >= from && r.travel_date <= to).map(r => r.id).sort();
  assert.equal(expected.length, 7);

  const c = counting({ imprest_requests: rows, imprest_retirements: [], settings: [] });
  const r = await _FNS.impReport(c.db, ADMIN, { from, to });
  assert.deepEqual(r.rows.map(x => x.id).sort(), expected);
  assert.equal(r.totals.count, 7);
  const s = c.stat();
  assert.equal(s.trips, 2, 'the bounded requests read, and the (unbounded, keyed-by-id) retirements read');
  assert.equal(s.rows, 7, 'the retirements table is empty here; the requests read is the bounded 7');
});

test('leaveReport: bounded by from_date, and "on leave today" is its own read regardless of the period', async () => {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({ id: 'l' + i, requested_at: D(i) + 'T08:00:00Z', staff_code: 'G1', staff_name: 'AGENT',
      staff_role: 'AGENT', leave_type: 'annual', from_date: D(i), to_date: D(i), working_days: 1,
      resume_date: D(i - 1), reason: 'x', declared: true, short_notice: false,
      status: ['pending', 'approved', 'rejected'][i % 3] });
  }
  // Spans today, but its OWN from_date (10 days ago) sits outside the report window below --
  // it must show up in onLeaveToday all the same.
  rows.push({ id: 'away', requested_at: D(10) + 'T08:00:00Z', staff_code: 'G2', staff_name: 'OTHER',
    staff_role: 'AGENT', leave_type: 'annual', from_date: D(10), to_date: addDaysKey(todayKey(), 10),
    working_days: 20, resume_date: addDaysKey(todayKey(), 11), reason: 'x', declared: true,
    short_notice: false, status: 'approved' });

  const from = D(30), to = D(24);
  const expected = rows.filter(r => r.id !== 'away' && r.from_date >= from && r.from_date <= to)
    .map(r => r.id).sort();
  assert.equal(expected.length, 7);

  const c = counting({ leave_requests: rows, settings: [] });
  const r = await _FNS.leaveReport(c.db, ADMIN, { from, to });
  assert.deepEqual(r.rows.map(x => x.id).sort(), expected, 'the period is the bounded 7 rows');
  assert.equal(r.totals.count, 7);
  assert.equal(r.totals.onLeaveToday, 1, 'the row that spans today, found however far outside the period it started');
  const s = c.stat();
  assert.equal(s.trips, 2, 'the period read and the today read');
  assert.equal(s.rows, 8, '7 in the period + 1 on leave today, not 121');
});

test('issueReport: bounded by raised_at, with the audit.js end-of-day convention on `to`', async () => {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({ id: 'i' + i, raised_at: D(i) + 'T14:00:00Z', staff_code: 'G1', staff_name: 'AGENT',
      staff_role: 'AGENT', department: i % 2 ? 'IT' : 'CREDIT', kind: 'issue', subject_type: null,
      subject: null, title: 'x', details: null, contact: null, verified: false, referred_to: null,
      external_ref: null, status: i % 3 === 0 ? 'resolved' : 'open', assigned_to: null,
      resolution: null, escalated_by: null, escalated_at: null,
      resolved_by: null, resolved_at: null, updated_by: null, updated_at: null });
  }
  const from = D(30), to = D(24);
  const day = s => String(s).slice(0, 10);
  const expected = rows.filter(r => day(r.raised_at) >= from && day(r.raised_at) <= to).map(r => r.id).sort();
  assert.equal(expected.length, 7, 'raised at 14:00 each day, still inside the end-of-day bound on `to`');

  const c = counting({ issues: rows, settings: [] });
  const r = await _FNS.issueReport(c.db, ADMIN, { from, to });
  assert.deepEqual(r.rows.map(x => x.id).sort(), expected);
  assert.equal(r.totals.count, 7);
  // Department stays a JS lens ON the bounded set, not a second trip.
  const credit = await _FNS.issueReport(c.db, ADMIN, { from, to, department: 'CREDIT' });
  assert.equal(credit.totals.count, expected.filter(id => rows.find(r => r.id === id).department === 'CREDIT').length);
  const s = c.stat();
  assert.ok(s.trips <= 2, 'one bounded read per call');
  assert.ok(s.rows <= 14, 'two 7-row bounded reads, not two 120-row ones');
});

/* =========================================================================================
   FIX 3 -- topupQueue: the default "live" view reads only the not-yet-finished statuses.
   ========================================================================================= */
test('topupQueue: the default view reads live rows only; a HEAD count covers the unlocked tile', async () => {
  const at = n => new Date(Date.now() - n * 60000).toISOString();
  const aTop = (id, status, mins) => ({ id, requested_at: at(mins), staff_code: 'G1', staff_name: 'AGENT',
    staff_role: 'AGENT', imei: '35100', customer: 'C', customer_phone: '0712000000', payer_name: 'C',
    paid_amount: 50000, proof_ref: 'M1', price: 450000, balance: 400000, status, comment: null,
    verified_by: null, verified_at: null, paid_by: null, paid_at: null, payment_ref: null,
    unlocked_by: null, unlocked_at: null, chk_request: false, chk_paid_to: false, chk_watu: false,
    chk_auditor: false, updated_by: null, updated_at: null });
  const rows = [
    aTop('r1', 'requested', 5), aTop('r2', 'requested', 90),   // r2 waited longer
    aTop('v1', 'verified', 20), aTop('v2', 'verified', 40),
    aTop('p1', 'paid', 10), aTop('p2', 'paid', 15),
    aTop('u1', 'unlocked', 200), aTop('u2', 'unlocked', 300), aTop('u3', 'unlocked', 400),
    aTop('x1', 'rejected', 500), aTop('x2', 'rejected', 600),
  ];   // 11 rows: 6 live, 3 unlocked, 2 rejected

  const c = counting({ topups: rows });
  const d = await _FNS.topupQueue(c.db, ADMIN, {});
  assert.equal(d.rows.length, 6, 'the six still-moving rows');
  assert.equal(d.counts.requested, 2); assert.equal(d.counts.verified, 2); assert.equal(d.counts.paid, 2);
  assert.equal(d.counts.unlocked, 3, 'the historical total, from the HEAD count, not from the live fetch');
  // SOP B.5: longest-waiting first, among the live rows.
  assert.deepEqual(d.rows.map(x => x.id), ['r2', 'r1', 'v2', 'v1', 'p2', 'p1']);
  const s = c.stat();
  assert.equal(s.trips, 2, 'the live-status read, and the one HEAD count for the unlocked tile');
  assert.equal(s.rows, 6, 'six live rows and nothing from the five finished ones');

  const cAll = counting({ topups: rows });
  const all = await _FNS.topupQueue(cAll.db, ADMIN, { state: 'all' });
  assert.equal(all.rows.length, 11, "'all' keeps the unfiltered read");
  const sAll = cAll.stat();
  assert.equal(sAll.trips, 1);
  assert.equal(sAll.rows, 11);
});

/* =========================================================================================
   FIX 4 -- issueTargets: the role -> names index memoised per db against DATA_VERSION.
   ========================================================================================= */
test('issueTargets: the access_codes scan costs once, not once per sub-tab', async () => {
  const book = {
    access_codes: [{ name: 'JUMA G', role: 'STORE' }, { name: 'ASHA', role: 'FINANCE' }, { name: 'JUMA G', role: 'STORE' }],
    settings: [{ key: 'DATA_VERSION', value: 'v1' }],
  };
  const c = counting(book);
  const first = await _FNS.issueTargets(c.db, ADMIN);
  const s1 = c.stat();
  assert.equal(s1.trips, 2, 'cold: the version check and the access_codes scan');
  assert.equal(s1.rows, 3);
  const store = first.roles.find(r => r.role === 'STORE');
  assert.deepEqual(store.people, ['JUMA G'], 'a role\'s names de-duplicate');

  await _FNS.issueTargets(c.db, ADMIN);
  const s2 = c.stat();
  assert.equal(s2.trips - s1.trips, 1, 'warm: only the version check');
  assert.equal(s2.rows - s1.rows, 0, 'access_codes is not re-scanned');

  bumpDataVersion(c, 'v2');
  await _FNS.issueTargets(c.db, ADMIN);
  const s3 = c.stat();
  assert.equal(s3.trips - s2.trips, 2, 'a DATA_VERSION bump forces a re-scan');
  assert.equal(s3.rows - s2.rows, 3);
});

/* =========================================================================================
   FIX 5 -- advRequest / advMine: independent keyed reads fired together, not in a waterfall.
   ========================================================================================= */
test('advRequest: a request refused for the monthly cap costs no salary lookup', async () => {
  const ASKER = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['advreq'], readOnly: false };
  const existing = [{ id: 'e1', staff_code: 'A1', apply_date: '2026-09-05', status: 'pending',
    amount: 100000, requested_at: '2026-09-01T08:00:00Z' }];
  const c = counting({ staff_advances: existing, staff_salaries: [], settings: [] });
  await assert.rejects(
    () => _FNS.advRequest(c.db, ASKER, { amount: 100000, applyDate: '2026-09-20', bank: 'CRDB', account: '0712345678' }),
    e => e.status === 400 && /ombi la advance|advance request/i.test(e.message));
  const s = c.stat();
  assert.equal(s.trips, 2, 'advPolicy and advSameMonth, run together -- and nothing more');
  assert.equal(s.rows, 1, 'the one live row for this month; salaryOf never ran');

  // A month with nothing already filed goes through, and DOES pay for the salary lookup.
  const c2 = counting({ staff_advances: existing, staff_salaries: [], settings: [] });
  const ok = await _FNS.advRequest(c2.db, ASKER, { amount: 100000, applyDate: '2026-10-05', bank: 'CRDB', account: '0712345678' });
  assert.equal(ok.ok, true);
  const s2 = c2.stat();
  assert.equal(s2.trips, 4, 'policy + same-month check + salary + the insert');
});

test('advMine: policy, salary and the advances read are independent and cost the same three trips', async () => {
  const ASKER = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['advreq'], readOnly: false };
  const rows = [
    { id: 'a1', staff_code: 'A1', staff_name: 'JUMA G', staff_role: 'OFFICER', apply_date: '2026-09-05',
      amount: 100000, status: 'approved', approved_amount: 100000, requested_at: '2026-09-05T08:00:00Z',
      bank_name: 'CRDB', account_no: '0150' },
    { id: 'a2', staff_code: 'A1', staff_name: 'JUMA G', staff_role: 'OFFICER', apply_date: '2026-10-05',
      amount: 100000, status: 'pending', requested_at: '2026-10-05T08:00:00Z', bank_name: 'CRDB', account_no: '0150' },
  ];
  const c = counting({ staff_advances: rows, staff_salaries: [{ staff_code: 'A1', monthly_salary: 500000 }], settings: [] });
  const d = await _FNS.advMine(c.db, ASKER);
  assert.equal(d.rows.length, 2);
  assert.equal(d.cap, 200000, '40% of the salary on file');
  const s = c.stat();
  assert.equal(s.trips, 3, 'advPolicy, the advances select, salaryOf -- fired together');

  // Before the migration: the advances read fails, but the policy figures still come through,
  // because advPolicy is its own promise, resolved before the advances read is even awaited.
  const bare = fakeDb({ staff_advances: [], settings: [{ key: 'ADVANCE_DEADLINE_DAY', value: '20' }] },
    { missingColumns: { staff_advances: ['id'] } });
  const notReady = await _FNS.advMine(bare, ASKER);
  assert.equal(notReady.notReady, true);
  assert.equal(notReady.deadlineDay, 20, 'the policy read did not depend on the advances read succeeding');
});

/* =========================================================================================
   FIX 6 -- staffDirectory: the loan-book branch list memoised per db against DATA_VERSION.
   ========================================================================================= */
test('staffDirectory: the register is read fresh every time, the loan-book branch scan is not', async () => {
  const STAFF = { code: 'A1', name: 'PETER ADMIN', role: 'ADMIN', teams: null, tabs: ['staff'], readOnly: false };
  const book = {
    hoop_agents: [
      { name: 'A', phone: '0712000001', role: 'Field_Officer', branch: 'ARUSHA', active: true },
      { name: 'B', phone: '0712000002', role: 'Team_Leader', branch: 'MWANZA', active: true },
      { name: 'C', phone: '0712000003', role: 'Regional_Manager', branch: null, active: true },
    ],
    watu_loans: [{ branch: 'ARUSHA' }, { branch: 'DAR' }, { branch: 'DAR' }],
    settings: [{ key: 'DATA_VERSION', value: 'v1' }],
  };
  const c = counting(book);
  const first = await _FNS.staffDirectory(c.db, STAFF);
  const s1 = c.stat();
  assert.equal(s1.trips, 3, 'the register, the version check, the loan book (cold)');
  assert.equal(s1.rows, 6, '3 agents + 3 loan rows');
  assert.deepEqual(first.branches, ['ARUSHA', 'DAR', 'MWANZA']);

  await _FNS.staffDirectory(c.db, STAFF);
  const s2 = c.stat();
  assert.equal(s2.trips - s1.trips, 2, 'the register (always fresh) and the version check; the loan book is skipped');
  assert.equal(s2.rows - s1.rows, 3, 'only the register\'s 3 rows');

  bumpDataVersion(c, 'v2');
  await _FNS.staffDirectory(c.db, STAFF);
  const s3 = c.stat();
  assert.equal(s3.trips - s2.trips, 3, 'a DATA_VERSION bump forces the loan book to be re-scanned too');
  assert.equal(s3.rows - s2.rows, 6);
});

/* =========================================================================================
   FIX 7 -- itWeekly: the 21 feed-day HEAD counts run together, not in a sequential waterfall.
   ========================================================================================= */
test('itWeekly: the trip count is unchanged by running the 21 HEAD counts concurrently', async () => {
  const IT = { code: 'I1', name: 'GILBERT', role: 'OFFICER', teams: null, tabs: ['itrep'], readOnly: false };
  const book = { watu_snapshots: [], hoop_sales: [], hoop_aged_stock: [], signin_attempts: [],
    devices: [], call_users: [], call_logs: [], hoop_agents: [], issues: [], audit_log: [],
    access_codes: [], it_reports: [], settings: [] };
  const c = counting(book);
  const d = await _FNS.itWeekly(c.db, IT, {});
  assert.equal(d.days.length, 7);
  const s = c.stat();
  /* 3 files x 7 days (HEAD, no rows) + 1 door read + 1 alert-fails setting + 1 device read +
     1 call-count HEAD + 1 register read + 1 roster read + 3 parallel issues reads +
     1 audit HEAD + 1 access_codes read + 1 sent-reports read = 33, exactly what this cost
     as a sequential waterfall -- Promise.all changes the order work happens in, not how much
     of it there is. */
  assert.equal(s.trips, 33);
  assert.equal(s.rows, 0);
});

test('itWeekly: concurrency does not scramble which day belongs to which feed', async () => {
  const IT = { code: 'I1', name: 'GILBERT', role: 'OFFICER', teams: null, tabs: ['itrep'], readOnly: false };
  const from = '2026-09-14', to = '2026-09-20';   // a fixed Monday-Sunday week
  const book = {
    watu_snapshots: [{ imei: '1', snapshot_date: '2026-09-14' }, { imei: '2', snapshot_date: '2026-09-16' }],
    hoop_sales: [{ imei: '1', sale_date: '2026-09-20' }],
    hoop_aged_stock: [],
    signin_attempts: [], devices: [], call_users: [], call_logs: [], hoop_agents: [], issues: [],
    audit_log: [], access_codes: [], it_reports: [], settings: [],
  };
  const d = await _FNS.itWeekly(fakeDb(book), IT, { from, to });
  const by = Object.fromEntries(d.performance.feeds.map(f => [f.key, f]));
  assert.equal(by.finance.arrived, 2);
  assert.deepEqual(by.finance.missing, ['2026-09-15', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
  assert.equal(by.sales.arrived, 1);
  assert.equal(by.inventory.arrived, 0);
  assert.deepEqual(by.inventory.missing, d.days, 'nothing arrived on any of the seven days');
});
