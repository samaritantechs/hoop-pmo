import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';

/* =========================================================================================
   THE THREE SALARY-ADVANCE RULES THE SOP HAS AND THIS SYSTEM DID NOT.

     Finance SOP G.4  "All salary advance requests must be submitted no later than the 15th
                       day of the month."
     Finance SOP G.5  "The approved advance amount must not exceed 40% of the employee's
                       monthly salary."
     Finance SOP G.6  "Once approved, Finance processes the advance and records it FOR
                       DEDUCTION against the employee's next payroll."

   G.4 IS A FLAG. A deadline that refuses the request leaves somebody with an emergency and no
   way to ask, and the SOP gives the judgement to the approver, not to the form.
   G.5 IS A LOCK, wherever a salary is on file. "Must not exceed" is not a suggestion.
   G.6 IS TWO STAMPS, because paying and deducting happen on different days.

   THE PERMISSION IS THE NAV, as everywhere here.

   NOT IMPLEMENTED, DELIBERATELY: SOP G.2/G.3 route the request through HR and then Finance.
   The owner replaced that with a single approval nav in 2026-09-07 ("just requests and
   approval or rejection with comments"), and that decision stands over the SOP's two steps.
   ========================================================================================= */
const ASKER = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['advreq'], readOnly: false };
const APPROVER = { code: 'D1', name: 'NEEMA M', role: 'OFFICER', teams: null, tabs: ['advappr'], readOnly: false };
const HR = { code: 'H1', name: 'SIPHO K', role: 'HR', teams: null, tabs: ['advrep', 'staff'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['advrep', 'staff'], readOnly: true };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const anAdv = o => ({ id: o.id, requested_at: o.at || '2026-09-05T06:00:00Z',
  staff_code: o.code || 'A1', staff_name: o.name || 'JUMA G', staff_role: 'OFFICER',
  apply_date: o.applyDate || '2026-09-05', amount: o.amount == null ? 200000 : o.amount,
  status: o.status || 'pending', approved_amount: o.approved == null ? null : o.approved,
  comment: null, decided_by: o.by || null, decided_at: o.decidedAt || null,
  bank_name: 'CRDB', account_no: '0150',
  late: o.late == null ? null : o.late, salary_at_request: o.salary == null ? null : o.salary,
  cap_amount: o.cap == null ? null : o.cap,
  paid_at: o.paidAt || null, paid_by: o.paidBy || null, payment_ref: o.ref || null,
  deducted_at: o.deductedAt || null, deducted_by: null, deduct_period: o.deductPeriod || null,
  updated_at: o.at || '2026-09-05T06:00:00Z' });
const advDb = (o = {}) => fakeDb({
  staff_advances: o.rows || [], staff_salaries: o.salaries || [], settings: o.settings || [],
});
const GOOD = { amount: 200000, applyDate: '2026-09-05', bank: 'CRDB', account: '0150123456' };

/* ---------------------------------------------------------------------------------------- */
test('advance rules: the migration, the settings and the audited writes', () => {
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  for (const fn of ['advPay', 'advDeduct', 'salarySave', 'salaryDelete']) {
    assert.match(src, new RegExp("AUDITED\\.add\\('" + fn + "'\\)"), fn + ' is audited');
  }
  const ed = /const EDITABLE_SETTINGS = \[([\s\S]*?)\]/.exec(src);
  for (const k of ['ADVANCE_DEADLINE_DAY', 'ADVANCE_MAX_PCT']) {
    assert.ok(ed[1].includes(`'${k}'`), k + ' is settable without a deploy');
  }
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-09-advance-rules.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists staff_salaries \(/);
  for (const c of ['late', 'salary_at_request', 'cap_amount', 'paid_at', 'paid_by',
    'payment_ref', 'deducted_at', 'deducted_by', 'deduct_period']) {
    assert.match(sql, new RegExp('add column if not exists ' + c + '\\b'), c + ' is added idempotently');
  }
  assert.match(sql, /'ADVANCE_DEADLINE_DAY', '15'/); assert.match(sql, /'ADVANCE_MAX_PCT', '40'/);
  assert.match(sql, /on conflict \(key\) do nothing/);
});

/* ---------------------------------------------------------------------------------------- */
test('G.4: a late request is FLAGGED, never refused', async () => {
  const d = advDb();
  // On the deadline day itself is in time; the day after is not.
  const onTime = await _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-09-15' });
  assert.equal(onTime.late, false);
  const late = await _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-09-16' });
  assert.equal(late.late, true, 'the 16th is after the 15th');
  assert.equal(late.deadlineDay, 15);
  const rows = d._dump('staff_advances');
  assert.equal(rows.length, 2, 'BOTH were filed: the deadline is a flag, not a lock');
  assert.equal(rows[0].late, false); assert.equal(rows[1].late, true);
  // Measured against the applicant's own date, not the day they pressed the button.
  assert.equal(rows[1].apply_date, '2026-09-16');
  // The day is a setting, with the SOP's 15 as the fallback.
  const d2 = advDb({ settings: [{ key: 'ADVANCE_DEADLINE_DAY', value: '20' }] });
  assert.equal((await _FNS.advRequest(d2, ASKER, { ...GOOD, applyDate: '2026-09-16' })).late, false);
  const d3 = advDb({ settings: [{ key: 'ADVANCE_DEADLINE_DAY', value: 'soon' }] });
  assert.equal((await _FNS.advRequest(d3, ASKER, { ...GOOD, applyDate: '2026-09-16' })).late, true);
});

test('G.5: the cap is frozen from the salary at the ask, and the approval is locked to it', async () => {
  const d = advDb({ salaries: [{ staff_code: 'A1', staff_name: 'JUMA G', monthly_salary: 300000 }] });
  const r = await _FNS.advRequest(d, ASKER, GOOD);
  assert.equal(r.salary, 300000);
  assert.equal(r.cap, 120000, '40% of 300,000');
  const [row] = d._dump('staff_advances');
  assert.equal(row.cap_amount, 120000); assert.equal(row.salary_at_request, 300000);
  const id = String(row.id);
  // 200,000 was asked for; the ceiling is 120,000, so the full amount is refused by name.
  await assert.rejects(() => _FNS.advDecide(d, APPROVER, { id, approve: true }),
    e => e.status === 400 && /G\.5/.test(e.message) && /120,000/.test(e.message));
  assert.equal(d._dump('staff_advances')[0].status, 'pending', 'and nothing was approved');
  // Under the ceiling goes through.
  const ok = await _FNS.advDecide(d, APPROVER, { id, approve: true, approvedAmount: 100000 });
  assert.equal(ok.granted, 100000);
  // A RAISE AFTER THE ASK MUST NOT WIDEN WHAT WAS ALLOWED: the cap on the row is the one used.
  const d2 = advDb({ rows: [anAdv({ id: uid('f1'), amount: 200000, salary: 250000, cap: 100000 })],
    salaries: [{ staff_code: 'A1', monthly_salary: 900000 }] });
  await assert.rejects(() => _FNS.advDecide(d2, APPROVER, { id: uid('f1'), approve: true, approvedAmount: 200000 }),
    e => e.status === 400 && /100,000/.test(e.message), 'the frozen ceiling stands, not one recomputed today');
  // The percentage is a setting.
  const d3 = advDb({ salaries: [{ staff_code: 'A1', monthly_salary: 300000 }],
    settings: [{ key: 'ADVANCE_MAX_PCT', value: '60' }] });
  assert.equal((await _FNS.advRequest(d3, ASKER, GOOD)).cap, 180000);
});

test('G.5: no salary on file means no cap, and the report says which approvals went through uncapped', async () => {
  const d = advDb();
  const r = await _FNS.advRequest(d, ASKER, GOOD);
  assert.equal(r.salary, null); assert.equal(r.cap, null);
  const id = String(d._dump('staff_advances')[0].id);
  // The rule cannot be applied to a figure nobody entered, so the office is not stopped.
  const ok = await _FNS.advDecide(d, APPROVER, { id, approve: true });
  assert.equal(ok.granted, 200000);
  // But it is counted and named, which is a prompt rather than a silent pass.
  const rep = await _FNS.advReport(d, HR, {});
  assert.equal(rep.totals.uncapped, 1);
  assert.equal(rep.rows[0].capAmount, null);
});

/* ---------------------------------------------------------------------------------------- */
test('G.6: paying and deducting are two stamps, in that order, once each', async () => {
  const d = advDb({ rows: [
    anAdv({ id: uid('p1'), status: 'approved', approved: 150000 }),
    anAdv({ id: uid('p2'), status: 'pending' }),
  ] });
  // Nothing is deducted before it is paid.
  await assert.rejects(() => _FNS.advDeduct(d, HR, { id: uid('p1'), period: '2026-10' }),
    e => e.status === 400 && /kabla haijalipwa|before it has been paid/i.test(e.message));
  // Nothing is paid before it is approved.
  await assert.rejects(() => _FNS.advPay(d, HR, { id: uid('p2'), paymentRef: 'TX1' }),
    e => e.status === 400 && /halijaidhinishwa|not approved/i.test(e.message));
  // A payment needs its reference.
  await assert.rejects(() => _FNS.advPay(d, HR, { id: uid('p1') }),
    e => e.status === 400 && /kumbukumbu|reference/i.test(e.message));
  const paid = await _FNS.advPay(d, HR, { id: uid('p1'), paymentRef: 'TX-771' });
  assert.ok(paid.paidAt);
  const row = d._dump('staff_advances').find(x => x.id === uid('p1'));
  assert.equal(row.paid_by, 'SIPHO K'); assert.equal(row.payment_ref, 'TX-771');
  assert.equal(row.status, 'approved', 'paying does not change the decision, it records the money');
  // Twice is never.
  await assert.rejects(() => _FNS.advPay(d, HR, { id: uid('p1'), paymentRef: 'TX-772' }),
    e => e.status === 400 && /tayari imelipwa|already been paid/i.test(e.message));
  assert.equal(row.payment_ref, 'TX-771', 'the first payment stands');
  // The deduction records WHICH payroll month took it back.
  await assert.rejects(() => _FNS.advDeduct(d, HR, { id: uid('p1') }), e => e.status === 400);
  await assert.rejects(() => _FNS.advDeduct(d, HR, { id: uid('p1'), period: '2026-13' }), e => e.status === 400);
  const ded = await _FNS.advDeduct(d, HR, { id: uid('p1'), period: '2026-10' });
  assert.equal(ded.deductPeriod, '2026-10');
  assert.equal(row.deduct_period, '2026-10'); assert.equal(row.deducted_by, 'SIPHO K');
  await assert.rejects(() => _FNS.advDeduct(d, HR, { id: uid('p1'), period: '2026-11' }),
    e => e.status === 400 && /tayari imekatwa|already been deducted/i.test(e.message));
});

test('G.6: the report counts what is owed out and what is owed back', async () => {
  const d = advDb({ rows: [
    anAdv({ id: uid('a'), status: 'approved', approved: 100000, applyDate: '2026-09-02' }),
    anAdv({ id: uid('b'), status: 'approved', approved: 50000, applyDate: '2026-09-03',
      paidAt: '2026-09-04T06:00:00Z', ref: 'TX-1' }),
    anAdv({ id: uid('c'), status: 'approved', approved: 200000, applyDate: '2026-09-04',
      paidAt: '2026-09-05T06:00:00Z', ref: 'TX-2', deductedAt: '2026-10-25T06:00:00Z', deductPeriod: '2026-10' }),
    anAdv({ id: uid('d'), status: 'declined', applyDate: '2026-09-05' }),
    anAdv({ id: uid('e'), status: 'approved', approved: 50000, applyDate: '2026-09-20', late: true }),
  ] });
  const r = await _FNS.advReport(d, HR, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.hasRules, true);
  assert.equal(r.totals.count, 5);
  assert.equal(r.totals.toPay, 2, 'approved and not yet out of the door');
  assert.equal(r.totals.toPayAmount, 150000);
  assert.equal(r.totals.toDeduct, 1, 'paid and payroll has not taken it back');
  assert.equal(r.totals.toDeductAmount, 50000);
  assert.equal(r.totals.deducted, 1);
  assert.equal(r.totals.late, 1);
  // The status lens narrows the table and leaves the tiles alone -- the rule this pane already had.
  const lens = await _FNS.advReport(d, HR, { from: '2026-09-01', to: '2026-09-30', status: 'declined' });
  assert.equal(lens.rows.length, 1); assert.equal(lens.totals.count, 5);
});

/* ---------------------------------------------------------------------------------------- */
test('salaries: HR sets them, they live behind the staff nav, and view-only never writes', async () => {
  const d = advDb();
  const r = await _FNS.salarySave(d, HR, { code: 'A1', name: 'JUMA G', salary: '450000' });
  assert.equal(r.salary, 450000); assert.equal(r.cap, 180000);
  const [row] = d._dump('staff_salaries');
  assert.equal(row.staff_code, 'A1'); assert.equal(row.monthly_salary, 450000);
  assert.equal(row.updated_by, 'SIPHO K');
  // Saving again corrects rather than duplicating.
  await _FNS.salarySave(d, HR, { code: 'A1', salary: 500000 });
  assert.equal(d._dump('staff_salaries').length, 1);
  assert.equal(d._dump('staff_salaries')[0].monthly_salary, 500000);
  const list = await _FNS.salaryList(d, HR);
  assert.equal(list.rows.length, 1); assert.equal(list.rows[0].cap, 200000);
  assert.equal(list.maxPct, 40);
  await assert.rejects(() => _FNS.salarySave(d, HR, { code: 'A1' }), e => e.status === 400);
  await assert.rejects(() => _FNS.salarySave(d, HR, { salary: 1 }), e => e.status === 400);
  await assert.rejects(() => _FNS.salarySave(d, HR, { code: 'A1', salary: -5 }), e => e.status === 400);
  // The advance panes cannot read or write salaries; the staff nav can.
  await assert.rejects(() => _FNS.salaryList(d, APPROVER), e => e.status === 403);
  await assert.rejects(() => _FNS.salarySave(d, ASKER, { code: 'A1', salary: 1 }), e => e.status === 403);
  // View-only reads and never writes.
  assert.ok((await _FNS.salaryList(d, VIEWER)).rows);
  await assert.rejects(() => _FNS.salarySave(d, VIEWER, { code: 'A1', salary: 1 }), e => e.status >= 400 && e.status < 500);
  await assert.rejects(() => _FNS.advPay(d, VIEWER, { id: uid('x'), paymentRef: 'T' }), e => e.status >= 400 && e.status < 500);
  await _FNS.salaryDelete(d, HR, { code: 'A1' });
  assert.equal(d._dump('staff_salaries').length, 0);
  assert.ok((await _FNS.salaryList(d, OWNER)).rows, 'ADMIN IS FULL ACCESS EVERYWHERE');
});

test('advance rules: before the migration the advance still works, unflagged', async () => {
  /* The rule columns arrive with a hand-run migration. Between the deploy and the paste the
     office must still be able to ask for, decide and read an advance -- it simply is not being
     flagged yet, which is what null means on those columns. */
  const bare = fakeDb({ staff_advances: [], staff_salaries: [], settings: [] },
    { missingColumns: { staff_advances: ['late', 'salary_at_request', 'cap_amount', 'paid_at',
      'payment_ref', 'deducted_at', 'deduct_period'] } });
  const r = await _FNS.advRequest(bare, ASKER, GOOD);
  assert.equal(r.ok, true, 'the request is still filed');
  const [row] = bare._dump('staff_advances');
  assert.equal(row.late, undefined, 'without the flag columns');
  assert.equal(row.amount, 200000);
  const mine = await _FNS.advMine(bare, ASKER);
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.rows[0].late, null, 'null is "not known", never "in time"');
  assert.equal(mine.deadlineDay, 15, 'and the form is still told the deadline');
  const q = await _FNS.advQueue(bare, APPROVER, {});
  assert.equal(q.rows.length, 1);
  const rep = await _FNS.advReport(bare, HR, {});
  assert.equal(rep.hasRules, false, 'the report says the rule columns are not there');
  assert.equal(rep.rows.length, 1);
  assert.equal(rep.totals.late, 0);
  // And the two new stamps name the migration rather than 500ing.
  const withRow = fakeDb({ staff_advances: [anAdv({ id: uid('n1'), status: 'approved', approved: 1 })] },
    { missingColumns: { staff_advances: ['paid_at'] } });
  await assert.rejects(() => _FNS.advPay(withRow, HR, { id: uid('n1'), paymentRef: 'T' }),
    e => e.status === 400 && /RUN-ME-2026-09-09-advance-rules\.sql/.test(e.message));
  const noSal = fakeDb({ staff_salaries: [] }, { missingColumns: { staff_salaries: ['staff_code'] } });
  assert.equal((await _FNS.salaryList(noSal, HR)).notReady, true);
  await assert.rejects(() => _FNS.salarySave(noSal, HR, { code: 'A1', salary: 1 }),
    e => e.status === 400 && /RUN-ME-2026-09-09-advance-rules\.sql/.test(e.message));
});
