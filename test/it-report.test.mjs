import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';
import { weekMondayKey, addDaysKey } from '../api/_lib/time.js';

/* =========================================================================================
   THE WEEKLY IT REPORT -- IT SOP E.

     E    "Prepare and SUBMIT regular IT reports to the General Manager on SYSTEM PERFORMANCE,
           ENROLLMENT STATUS, and TECHNICAL ISSUES RESOLVED, and ensure all system activities
           comply with company policy and data protection regulations. REPORTS ARE DUE ON A
           WEEKLY BASIS."
     C.2  "Monitor system uptime and performance across inventory, sales and finance modules,
           on a DAILY basis" -- the daily check the weekly report is made of.

   THREE SECTIONS BECAUSE THE SOP NAMES THREE, and every number in them already exists
   somewhere: the door's log (SOP D), the staff register (SOP A), the issues log (SOP C), the
   daily uploads, the handsets' heartbeats. This composes; it keeps no copy of anything.

   Except one thing. SOP E's verb is SUBMIT, and "did last week's go?" is a fact about the past
   that cannot be recomputed from this week's numbers -- so that, and only that, is a table.

   THE PERMISSION IS THE NAV, as everywhere here.
   ========================================================================================= */
const IT = { code: 'I1', name: 'GILBERT', role: 'OFFICER', teams: null, tabs: ['itrep'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['itrep'], readOnly: true };
const OTHER = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const MON = weekMondayKey();                       // this EAT week's Monday
const SUN = addDaysKey(MON, 6);
const D = n => addDaysKey(MON, n);
const iso = (day, hh) => day + 'T' + (hh || '09') + ':00:00.000Z';
const NID = '19950923141260000121';

const agent = (o = {}) => ({
  phone: o.phone || '0712000001', name: 'RISHADI C',
  national_id: o.nid === undefined ? NID : o.nid, email: null,
  role: 'Field_Officer', branch: o.branch || 'ILALA', manager: null,
  active: o.active !== false, joined_date: '2026-02-21',
  kin_name: 'ATHUMANI D', kin_phone: '0670306780', kin_relationship: 'BABA',
  kin2_name: 'AGNES L', kin2_phone: '0673506061', kin2_relationship: 'MAMA',
  enrolled_by: o.enrolledBy || null, enrolled_at: o.enrolledAt || null,
  verified_by: o.verifiedBy || null, verified_at: o.verifiedAt || null,
  notified_at: o.notifiedAt || null, notified_to: null, enrol_note: null,
  updated_at: iso(MON),
});
const issue = (o = {}) => ({
  id: o.id, raised_at: o.raised || iso(D(1)), department: o.dept || 'IT', kind: 'system',
  title: o.title || 'Watu haifunguki', status: o.status || 'open', assigned_to: null,
  resolved_by: o.by || null, resolved_at: o.resolved || null,
});
const irDb = (o = {}) => fakeDb({
  watu_snapshots: o.snaps || [], hoop_sales: o.sales || [], hoop_aged_stock: o.aged || [],
  signin_attempts: o.door || [], devices: o.devices || [], call_users: o.users || [],
  call_logs: o.calls || [], hoop_agents: o.agents || [], issues: o.issues || [],
  audit_log: o.audit || [], access_codes: o.codes || [], it_reports: o.sent || [],
  settings: o.settings || [],
});
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
test('the week is Monday to Sunday on the EAT clock, and the SOP’s three sections are all there', async () => {
  const d = await _FNS.itWeekly(irDb(), IT, {});
  assert.equal(d.from, MON, 'somebody opening this on a Friday means this week');
  assert.equal(d.to, SUN);
  assert.equal(d.days.length, 7);
  for (const k of ['performance', 'enrolment', 'issues', 'compliance']) {
    assert.ok(d[k], k + ' is one of the things SOP E names');
  }
  /* An empty deployment must read as an empty report rather than as a failure -- every one of
     these tables arrives with its own hand-run migration. */
  assert.equal(d.performance.missingDays, 21, 'three files x seven days, none of them arrived');
  assert.equal(d.enrolment.total, 0);
  assert.equal(d.submitted, false);
});

test('C.2: a day a module had no file at all is counted and named', async () => {
  const db = irDb({
    // The Watu deck arrived every day but Wednesday; sales only on Monday; nothing aged at all.
    snaps: [0, 1, 3, 4, 5, 6].map(n => ({ imei: '35' + n, snapshot_date: D(n) })),
    sales: [{ imei: '351', sale_date: MON }],
  });
  const d = await _FNS.itWeekly(db, IT, {});
  const by = Object.fromEntries(d.performance.feeds.map(f => [f.key, f]));
  assert.equal(by.finance.arrived, 6);
  assert.deepEqual(by.finance.missing, [D(2)], 'the missing day is NAMED, not merely counted');
  assert.equal(by.sales.arrived, 1);
  assert.equal(by.inventory.arrived, 0);
  assert.equal(d.performance.missingDays, 1 + 6 + 7);
  // The three modules SOP C.2 names, and nothing invented alongside them.
  assert.deepEqual(d.performance.feeds.map(f => f.key), ['finance', 'sales', 'inventory']);
});

test('system performance carries the handsets, the app and the door', async () => {
  const db = irDb({
    devices: [
      { imei: '1', state: 'enrolled', last_seen: iso(D(2)) },
      { imei: '2', state: 'locked', last_seen: iso(D(3)) },
      { imei: '3', state: 'locked', last_seen: '2026-01-01T00:00:00Z' },   // silent since January
      { imei: '4', state: 'released', last_seen: null },                    // never spoke
    ],
    users: [{ phone: '0712000001', last_sync: iso(D(1)), active: true },
      { phone: '0712000002', last_sync: null, active: false }],
    calls: [{ id: 'c1', call_date: D(1) }, { id: 'c2', call_date: D(2) }, { id: 'c3', call_date: '2026-01-01' }],
    door: [
      { id: 'a', at: iso(D(1)), day: D(1), door: 'portal', ok: true, outcome: 'ok', code_key: 'aaaa', code_masked: 'K•' },
      { id: 'b', at: iso(D(1)), day: D(1), door: 'portal', ok: false, outcome: 'invalid', code_key: 'bbbb', code_masked: 'Z•' },
      { id: 'c', at: iso(D(2)), day: D(2), door: 'portal', ok: false, outcome: 'closed', code_key: 'cccc', code_masked: 'Q•' },
    ],
  });
  const p = (await _FNS.itWeekly(db, IT, {})).performance;
  assert.equal(p.devices.total, 4);
  assert.equal(p.devices.seen, 2);
  assert.equal(p.devices.dark, 2, 'never spoke, and has not spoken since before the week began');
  assert.equal(p.devices.locked, 2);
  assert.equal(p.app.syncedThisWeek, 1);
  assert.equal(p.app.calls, 2, 'and January is not this week');
  assert.equal(p.door.ok, 1);
  assert.equal(p.door.fails, 2);
  assert.equal(p.door.alarming, 1, 'the admin’s own system switch is not a break-in');
});

test('enrolment status is counted by the same rules as the enrolment desk', async () => {
  const db = irDb({
    agents: [
      agent({ phone: '0712000001', verifiedAt: iso(D(1)), verifiedBy: 'GILBERT', notifiedAt: iso(D(1)),
        enrolledAt: iso(D(1)), enrolledBy: 'GILBERT' }),
      agent({ phone: '0712000002', verifiedAt: iso(D(2)) }),      // verified, nobody told
      agent({ phone: '0712000003', nid: '' }),                    // a gap, and live
    ],
    users: [{ phone: '0712000001', last_sync: iso(D(1)), active: true }],
  });
  const d = await _FNS.itWeekly(db, IT, {});
  const desk = await _FNS.enrolQueue(db, { ...IT, tabs: ['enrol'] }, {});
  /* ONE RULE, TWO READERS. Two copies of "what counts as complete" is how a report and a desk
     come to disagree about the same register in the same week. */
  for (const k of ['total', 'gaps', 'unverified', 'liveUnverified', 'unnotified', 'inApp']) {
    assert.equal(d.enrolment[k], desk.counts[k], k + ' must match the desk exactly');
  }
  assert.equal(d.enrolment.gaps, 1);
  assert.equal(d.enrolment.liveUnverified, 1);
  assert.equal(d.enrolment.unnotified, 1);
  // Whether the desk did any work this week, as opposed to what the register looks like.
  assert.equal(d.enrolment.newThisWeek, 1);
  assert.equal(d.enrolment.verifiedThisWeek, 2);
});

test('“technical issues resolved” counts the resolving, not the raising, and names what was fixed', async () => {
  const db = irDb({
    issues: [
      // Raised in January, resolved THIS week: resolved work, not new work.
      issue({ id: 'i1', raised: '2026-01-05T09:00:00Z', resolved: iso(D(2)), status: 'resolved', by: 'GILBERT', title: 'Printa ya Ilala' }),
      // Raised and resolved this week.
      issue({ id: 'i2', raised: iso(D(1)), resolved: iso(D(3)), status: 'resolved', by: 'GILBERT', title: 'Watu haifunguki' }),
      // Raised this week, still open.
      issue({ id: 'i3', raised: iso(D(1)), status: 'open', dept: 'FINANCE' }),
      // Old and still open -- the oldest thing on the desk.
      issue({ id: 'i4', raised: '2026-01-05T09:00:00Z', status: 'escalated' }),
    ],
  });
  const d = await _FNS.itWeekly(db, IT, {});
  assert.equal(d.issues.raised, 2, 'raised THIS week');
  assert.equal(d.issues.resolved, 2, 'resolved this week, whenever they were raised');
  assert.equal(d.issues.open, 2);
  assert.equal(d.issues.escalated, 1);
  assert.ok(d.issues.oldestOpenDays > 100, 'and the oldest open one is the number that shames');
  /* A LIST BEFORE IT IS A NUMBER. A GM reading "2" learns less than a GM reading two titles. */
  assert.equal(d.issues.resolvedRows.length, 2);
  assert.equal(d.issues.resolvedRows[0].title, 'Watu haifunguki', 'newest first');
  assert.ok(d.issues.resolvedRows.some(r => r.title === 'Printa ya Ilala'));
  const it = d.issues.byDept.find(x => x.department === 'IT');
  assert.equal(it.resolved, 2);
  assert.equal(d.issues.byDept.find(x => x.department === 'FINANCE').open, 1);
});

test('compliance answers the SOP’s last clause with counts, and never with a code', async () => {
  const db = irDb({
    audit: [{ id: 'a1', at: iso(D(1)) }, { id: 'a2', at: iso(D(2)) }, { id: 'a3', at: '2026-01-01T00:00:00Z' }],
    codes: [
      { code: 'SECRET1', role: 'ADMIN', suspend_from: null, suspend_to: null },
      { code: 'SECRET2', role: 'AUDITOR', suspend_from: null, suspend_to: null },
      { code: 'SECRET3', role: 'OFFICER', suspend_from: '2020-01-01', suspend_to: null },
    ],
  });
  const d = await _FNS.itWeekly(db, IT, {});
  assert.equal(d.compliance.audited, 2, 'this week only');
  assert.equal(d.compliance.codes, 3);
  assert.equal(d.compliance.readOnlyCodes, 1);
  assert.equal(d.compliance.suspendedCodes, 1);
  /* A report whose last section is about data protection must not itself be a list of the
     company's keys. Nothing anywhere in it may carry one. */
  assert.ok(!JSON.stringify(d).includes('SECRET'), 'the codes themselves never travel');
});

test('SOP E’s verb is SUBMIT: the report goes, and the record of it going is kept and copied', async () => {
  const mail = captureMail();
  try {
    const db = irDb({
      snaps: [{ imei: '351', snapshot_date: MON }],
      agents: [agent({ phone: '0712000003', nid: '' })],
      issues: [issue({ id: 'i1', raised: iso(D(1)), resolved: iso(D(2)), status: 'resolved', by: 'GILBERT' })],
      settings: [{ key: 'IT_REPORT_EMAIL', value: 'gm@hoop.co.tz' }],
    });
    assert.equal((await _FNS.itWeekly(db, IT, {})).submitted, false);

    const out = await _FNS.itWeeklySend(db, IT, {});
    assert.equal(out.sent, true);
    assert.equal(out.to, 'gm@hoop.co.tz');
    assert.equal(out.recorded, true);
    const body = mail.sent[0].body;
    assert.match(body.subject, /ripoti ya IT|weekly IT report/i);
    for (const section of [/SYSTEM PERFORMANCE/i, /ENROLMENT STATUS/i, /TECHNICAL ISSUES/i, /COMPLIANCE/i]) {
      assert.match(body.html, section, 'the email carries the sections the SOP names');
    }

    /* "DID LAST WEEK'S GO?" is answered from the table, not by recomputing this week. */
    const after = await _FNS.itWeekly(db, IT, {});
    assert.equal(after.submitted, true);
    assert.equal(after.sent.length, 1);
    assert.equal(after.sent[0].by, 'GILBERT');
    assert.equal(after.sent[0].to_, 'gm@hoop.co.tz');
    /* AND THE SUMMARY IS COPIED. Opening a June submission next January must show what was
       SENT in June, not what June looks like after six months of re-uploads. */
    assert.match(after.sent[0].summary, /rejista 1 \(hazijakamilika 1\)/);
    const frozen = after.sent[0].summary;
    await _FNS.enrolSave(db, { ...IT, tabs: ['enrol'] }, {
      phone: '0712000003', name: 'RISHADI C', nationalId: NID, role: 'Field_Officer', branch: 'ILALA',
      kinName: 'A', kinPhone: '0670306780', kin2Name: 'B', kin2Phone: '0673506061',
    });
    const later = await _FNS.itWeekly(db, IT, {});
    assert.equal(later.enrolment.gaps, 0, 'the live numbers move');
    assert.equal(later.sent[0].summary, frozen, 'and what was already sent does not');

    /* Re-sending after fixing something is legitimate and is its own line -- a unique row per
       week would quietly hide that it happened twice. */
    await _FNS.itWeeklySend(db, IT, {});
    assert.equal((await _FNS.itWeekly(db, IT, {})).sent.length, 2);

    const quiet = irDb();
    await assert.rejects(() => _FNS.itWeeklySend(quiet, IT, {}), /haikutumwa|was not sent/i,
      'silence would look exactly like a report the GM had received');
  } finally { mail.restore(); }
});

test('the nav is the permission, and a report that went is not called unsent because a table is missing', async () => {
  const db = irDb();
  for (const fn of ['itWeekly', 'itWeeklySend']) {
    await assert.rejects(() => _FNS[fn](db, OTHER, {}), /no access to the itrep pane/i, fn + ' is behind the nav');
  }
  assert.equal((await _FNS.itWeekly(db, OWNER, {})).ok, true, 'ADMIN is full access everywhere');
  assert.equal((await _FNS.itWeekly(db, VIEWER, {})).ok, true, 'supervision reads it');
  await assert.rejects(() => _FNS.itWeeklySend(db, VIEWER, {}), /kuangalia tu|view-only/i,
    'and changes nothing, including sending mail out of the building');

  const mail = captureMail();
  try {
    /* BEFORE THE MIGRATION the report still reads and still sends -- every number in it lives
       somewhere else. What is missing is the RECORD, and that is said plainly rather than
       reported as a failed send: the GM has the email either way, and the person needs to know
       which of the two things to chase. */
    const bare = fakeDb({ it_reports: [], settings: [{ key: 'IT_REPORT_EMAIL', value: 'gm@hoop.co.tz' }] },
      { missingColumns: { it_reports: ['week_from', 'id'] } });
    const d = await _FNS.itWeekly(bare, IT, {});
    assert.equal(d.sentNotReady, true);
    assert.match(d.notReadyNote, /RUN-ME-2026-09-10-it-report\.sql/);
    const out = await _FNS.itWeeklySend(bare, IT, {});
    assert.equal(out.sent, true, 'the report itself went');
    assert.equal(out.recorded, false);
    assert.match(out.recordNote, /RUN-ME-2026-09-10-it-report\.sql/);
  } finally { mail.restore(); }
});
