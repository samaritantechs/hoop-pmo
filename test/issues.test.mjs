import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';
import { callApi } from '../api/_lib/call-core.js';

/* =========================================================================================
   ISSUES: one log for everything somebody has to chase, three panes, three grants.

     RSM SOP C   "Log every issue raised by an agent or team leader using the designated
                  complaint link/tool, which routes the issue to the appropriate department"
     Credit SOP C "Register the complaint on the complaints form ... refer the matter to the
                  WATU Credit Department ... Escalate complex or unresolved complaints to the
                  General Manager"
     IT SOP C    "log them with the WATU support system and Samsung shop ... Register the log
                  book of the resolved matter"
     GD SOP B    "Maintain a log of all pending tasks ... Record the resolution and closing date"

   THE PERMISSION IS THE NAV, as everywhere here: "remember I implement tasks/roles by nav tabs
   not role based". Nothing below names a department head or a GM; the fixtures hold panes.
   The DEPARTMENT on a row is a label the desk filters on, never a grant of its own.
   ========================================================================================= */
const RAISER = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['issuereq'], readOnly: false };
const DESK = { code: 'D1', name: 'NEEMA M', role: 'OFFICER', teams: null, tabs: ['issues'], readOnly: false };
const HEAD = { code: 'G1', name: 'BOSS', role: 'MANAGER', teams: null, tabs: ['issuerep'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['issuereq', 'issues', 'issuerep'], readOnly: true };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
const DEPTS = ['STORE', 'FINANCE', 'IT', 'HR', 'CREDIT', 'SALES', 'GENERAL_DUTY', 'ADMIN'];

const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const dayOf = iso => String(iso).slice(0, 10);
const anIssue = o => {
  const at = o.at || daysAgo(o.age == null ? 1 : o.age);
  return {
    id: o.id, raised_at: at, staff_code: o.code || 'A1', staff_name: o.name || 'JUMA G', staff_role: 'OFFICER',
    department: o.department || 'IT', kind: o.kind || 'issue', subject_type: o.subjectType || null, subject: o.subject || null,
    title: o.title || 'Simu haiwaki', details: o.details || null, contact: o.contact || null, verified: !!o.verified,
    referred_to: o.referredTo || null, external_ref: o.externalRef || null, status: o.status || 'open',
    assigned_to: o.assignedTo || null, resolution: o.resolution || null, escalated_by: null, escalated_at: null,
    resolved_by: o.resolvedBy || null, resolved_at: o.resolvedAt || null, updated_by: 'JUMA G', updated_at: o.updatedAt || at,
  };
};
const issDb = (o = {}) => fakeDb({ issues: o.issues || [], issue_notes: o.notes || [], settings: o.settings || [] });

/* Email is observed, never sent. */
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
test('issues: three panes are three grants, view-only codes look but never write, ADMIN holds all', async () => {
  const d = issDb({ issues: [anIssue({ id: uid('i1') })] });
  const denied = async (fn, user, args) => {
    await assert.rejects(() => _FNS[fn](d, user, args || {}), e => e.status === 403,
      fn + ' must refuse a user who was never granted its pane');
  };
  // issuereq raises and reads its own; it is neither the desk nor the book.
  await denied('issueQueue', RAISER); await denied('issueReport', RAISER);
  // issues works the desk; it is not the raiser's list, nor the report.
  await denied('issueMine', DESK); await denied('issueReport', DESK);
  // issuerep reads the book; it neither raises, lists, works nor moves anything.
  await denied('issueMine', HEAD); await denied('issueQueue', HEAD);
  await denied('issueRaise', HEAD, { department: 'IT', title: 'x' });
  await denied('issueUpdate', HEAD, { id: uid('i1'), note: 'x' });
  // View-only: every read answers, every write is refused.
  assert.ok(Array.isArray((await _FNS.issueMine(d, VIEWER)).rows));
  assert.ok(Array.isArray((await _FNS.issueQueue(d, VIEWER, {})).rows));
  assert.ok((await _FNS.issueReport(d, VIEWER, {})).totals);
  await assert.rejects(() => _FNS.issueRaise(d, VIEWER, { department: 'IT', title: 'x' }), e => e.status >= 400 && e.status < 500);
  await assert.rejects(() => _FNS.issueUpdate(d, VIEWER, { id: uid('i1'), note: 'x' }), e => e.status >= 400 && e.status < 500);
  assert.equal(d._dump('issues').length, 1); assert.equal(d._dump('issue_notes').length, 0);
  // "ADMIN IS FULL ACCESS EVERYWHERE WE DEVELOP"
  assert.equal((await _FNS.issueQueue(d, OWNER, {})).rows.length, 1);
  assert.ok((await _FNS.issueReport(d, OWNER, {})).totals);
  assert.ok(Array.isArray((await _FNS.issueMine(d, OWNER)).rows));
  const r = await _FNS.issueUpdate(d, OWNER, { id: uid('i1'), status: 'waiting', note: 'WATU wanaangalia' });
  assert.equal(r.change, 'open>waiting');
});

test('issues: the three navs are on the list the role editor is built from, and the writes are audited', () => {
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const m = /const NAV_TABS = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'NAV_TABS is a literal list');
  for (const k of ['issuereq', 'issues', 'issuerep']) {
    assert.ok(m[1].includes(`'${k}'`), k + ' must be a nav the owner can tick, or nobody can ever be granted it');
  }
  for (const fn of ['issueRaise', 'issueUpdate']) {
    assert.match(src, new RegExp("AUDITED\\.add\\('" + fn + "'\\)"), fn + ' is a write and lands in the audit log');
  }
  const ed = /const EDITABLE_SETTINGS = \[([\s\S]*?)\]/.exec(src);
  assert.ok(ed, 'EDITABLE_SETTINGS is a literal list');
  for (const k of ['ISSUES_EMAIL', 'GM_EMAIL']) assert.ok(ed[1].includes(`'${k}'`), k + ' can be set from the Settings pane');
  // The department labels the server accepts are the ones the migration's CHECK accepts.
  const depts = /const ISSUE_DEPTS = \[([^\]]+)\]/.exec(src);
  assert.ok(depts);
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-08-issues.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists issues\b/); assert.match(sql, /create table if not exists issue_notes\b/);
  for (const k of DEPTS) {
    assert.ok(depts[1].includes(`'${k}'`), k + ' is a department the server offers');
    assert.ok(sql.includes(`'${k}'`), k + ' is a department the CHECK admits');
  }
  assert.match(sql, /'ISSUES_EMAIL'/); assert.match(sql, /'GM_EMAIL'/);
});

/* ---------------------------------------------------------------------------------------- */
test('issues: a raised issue is stamped from the session, opens OPEN, and goes where it was pointed', async () => {
  const d = issDb();
  const r = await _FNS.issueRaise(d, RAISER, {
    department: ' credit ', kind: 'COMPLAINT', subjectType: 'IMEI', subject: ' 351929937378664 ',
    title: 'Simu imefungwa ingawa amelipa', details: 'Amelipa 20,000 jana kwa M-Pesa', contact: '0712 000 000',
    // Whatever the client says about who it is or where the row stands is not believed.
    staffName: 'SOMEBODY ELSE', staffCode: 'ZZ', status: 'resolved', verified: true, assignedTo: 'me',
  });
  assert.ok(r.id, 'the new id comes back so the page can open it');
  assert.equal(r.department, 'CREDIT');
  const [row] = d._dump('issues');
  assert.equal(row.staff_code, 'A1'); assert.equal(row.staff_name, 'JUMA G'); assert.equal(row.staff_role, 'OFFICER');
  assert.equal(row.status, 'open', 'nobody files their own issue as resolved');
  assert.equal(row.verified, undefined, 'the verified tick is the desk\'s, never the raiser\'s');
  assert.equal(row.assigned_to, undefined);
  assert.equal(row.department, 'CREDIT'); assert.equal(row.kind, 'complaint');
  assert.equal(row.subject_type, 'imei'); assert.equal(row.subject, '351929937378664', 'trimmed, so the call card finds it');
  assert.equal(row.title, 'Simu imefungwa ingawa amelipa'); assert.equal(row.contact, '0712 000 000');
  assert.equal(row.updated_by, 'JUMA G'); assert.equal(row.updated_at, row.raised_at);
  // The spelling the SOP uses is accepted for the label with an underscore.
  const g = await _FNS.issueRaise(d, RAISER, { department: 'general duty', title: 'Risiti za wiki' });
  assert.equal(g.department, 'GENERAL_DUTY');
  assert.equal(d._dump('issues')[1].kind, 'issue', 'the kind defaults to a plain issue');
  assert.equal(d._dump('issues')[1].subject_type, null);
});

test('issues: what the form must carry -- a department, a title, and the thing an IMEI-type issue is about', async () => {
  const d = issDb();
  const bad = async (args, why) => {
    await assert.rejects(() => _FNS.issueRaise(d, RAISER, args), e => e.status === 400 && why.test(e.message), JSON.stringify(args));
  };
  await bad({ title: 'x' }, /idara|department/i);
  await bad({ department: 'MARKETING', title: 'x' }, /idara|department/i);
  await bad({ department: 'IT' }, /kichwa|title/i);
  await bad({ department: 'IT', title: '   ' }, /kichwa|title/i);
  await bad({ department: 'IT', title: 'x', kind: 'gossip' }, /aina|kind/i);
  await bad({ department: 'IT', title: 'x', subjectType: 'planet' }, /aina|subject/i);
  await bad({ department: 'CREDIT', title: 'x', subjectType: 'imei' }, /IMEI/);
  await bad({ department: 'SALES', title: 'x', subjectType: 'agent', subject: '' }, /ajenti|agent/i);
  // 'system' and 'other' need no subject: the thing is the system.
  await _FNS.issueRaise(d, RAISER, { department: 'IT', title: 'App inafunga yenyewe', subjectType: 'system' });
  await _FNS.issueRaise(d, RAISER, { department: 'HR', title: 'Kadi ya bima', subjectType: 'other' });
  assert.equal(d._dump('issues').length, 2);
});

test('issues: the department is told by email when ISSUES_EMAIL names it, and the row is filed either way', async () => {
  const cap = captureMail();
  try {
    const d = issDb({ settings: [{ key: 'ISSUES_EMAIL',
      value: 'IT = it@hoop.co.tz, tech@hoop.co.tz\nCREDIT=credit@hoop.co.tz\nthis line means nothing\nGeneral Duty: gd@hoop.co.tz' }] });
    const r1 = await _FNS.issueRaise(d, RAISER, { department: 'CREDIT', kind: 'complaint', title: 'Malalamiko ya mteja', subjectType: 'imei', subject: '351' });
    assert.equal(r1.emailed, true); assert.equal(cap.sent.length, 1);
    const b1 = JSON.stringify(cap.sent[0].body);
    assert.ok(b1.includes('credit@hoop.co.tz'), 'CREDIT\'s address'); assert.ok(!b1.includes('tech@hoop.co.tz'), 'and nobody else\'s');
    assert.match(cap.sent[0].body.subject, /CREDIT/); assert.match(cap.sent[0].body.subject, /Malalamiko ya mteja/);
    assert.match(b1, /JUMA G/, 'the department knows who raised it');
    // A department with no line: no email, a note saying so, and the row still lands.
    const r2 = await _FNS.issueRaise(d, RAISER, { department: 'STORE', title: 'Simu 3 hazina boksi' });
    assert.equal(r2.emailed, false); assert.match(r2.emailNote, /STORE/); assert.equal(cap.sent.length, 1);
    assert.equal(d._dump('issues').length, 2, 'no address never stops the row');
    // Several addresses on one line, and a label spelt with a space and a colon.
    const r3 = await _FNS.issueRaise(d, RAISER, { department: 'IT', title: 'Printer' });
    assert.equal(r3.emailed, true); assert.ok(JSON.stringify(cap.sent[1].body).includes('tech@hoop.co.tz'));
    const r4 = await _FNS.issueRaise(d, RAISER, { department: 'GENERAL_DUTY', title: 'Risiti' });
    assert.equal(r4.emailed, true); assert.ok(JSON.stringify(cap.sent[2].body).includes('gd@hoop.co.tz'));
    // No setting at all: the same quiet no.
    const bare = issDb();
    const r5 = await _FNS.issueRaise(bare, RAISER, { department: 'IT', title: 'x' });
    assert.equal(r5.emailed, false); assert.equal(bare._dump('issues').length, 1);
  } finally { cap.restore(); }
});

/* ---------------------------------------------------------------------------------------- */
test('issues: the raiser sees only their own, unresolved first, with the lists the form is built from', async () => {
  const d = issDb({ issues: [
    anIssue({ id: uid('a'), code: 'A1', status: 'resolved', age: 1, resolvedAt: daysAgo(0) }),
    anIssue({ id: uid('b'), code: 'A1', status: 'open', age: 5 }),
    anIssue({ id: uid('c'), code: 'A2', name: 'ASHA K', status: 'open', age: 2 }),
  ] });
  const r = await _FNS.issueMine(d, RAISER);
  assert.deepEqual(r.rows.map(x => x.id), [uid('b'), uid('a')], 'own rows only; open before resolved even when older');
  assert.ok(r.rows.every(x => x.mine));
  assert.deepEqual(r.departments, DEPTS);
  assert.deepEqual(r.kinds, ['issue', 'complaint', 'document', 'performance', 'system']);
  assert.deepEqual(r.subjects, ['imei', 'agent', 'receipt', 'system', 'other']);
  assert.equal(r.rows[0].ageDays, 5, 'how long it has been open');
  assert.equal(r.rows[1].ageDays, 1, 'or was open, for a resolved one');
});

test('issues: the desk is ONE queue -- unresolved by default, a department chip narrows, the counts say where the work is', async () => {
  const d = issDb({ issues: [
    anIssue({ id: uid('q1'), department: 'IT', status: 'open', age: 3 }),
    anIssue({ id: uid('q2'), department: 'IT', status: 'waiting', age: 2 }),
    anIssue({ id: uid('q3'), department: 'CREDIT', status: 'escalated', age: 10 }),
    anIssue({ id: uid('q4'), department: 'CREDIT', status: 'resolved', age: 4, resolvedAt: daysAgo(3) }),
    anIssue({ id: uid('q5'), department: 'STORE', status: 'open', age: 1 }),
  ] });
  const q = await _FNS.issueQueue(d, DESK, {});
  assert.deepEqual(q.rows.map(x => x.id), [uid('q5'), uid('q2'), uid('q1'), uid('q3')], 'not resolved, newest first');
  assert.deepEqual(q.counts, { open: 2, waiting: 1, escalated: 1, resolved: 1,
    byDept: { STORE: 1, FINANCE: 0, IT: 2, HR: 0, CREDIT: 1, SALES: 0, GENERAL_DUTY: 0, ADMIN: 0 } },
    'the chips count what is still to do, per department, over the whole table');
  assert.equal((await _FNS.issueQueue(d, DESK, { department: 'it' })).rows.length, 2, 'the label, case-insensitively');
  assert.equal((await _FNS.issueQueue(d, DESK, { department: 'credit' })).rows.length, 1, 'the resolved one stays hidden');
  assert.equal((await _FNS.issueQueue(d, DESK, { department: 'credit', state: 'all' })).rows.length, 2);
  assert.equal((await _FNS.issueQueue(d, DESK, { state: 'all' })).rows.length, 5);
  assert.deepEqual((await _FNS.issueQueue(d, DESK, { state: 'resolved' })).rows.map(x => x.id), [uid('q4')]);
  assert.deepEqual((await _FNS.issueQueue(d, DESK, { state: 'escalated' })).rows.map(x => x.id), [uid('q3')]);
  assert.equal((await _FNS.issueQueue(d, DESK, { department: 'HR' })).rows.length, 0);
});

/* ---------------------------------------------------------------------------------------- */
test('issues: the desk moves an issue -- resolving needs a resolution, every move is a note, the stamps are the desk\'s', async () => {
  const d = issDb({ issues: [anIssue({ id: uid('i1'), updatedAt: '2026-09-01T08:00:00Z' })] });
  await assert.rejects(() => _FNS.issueUpdate(d, DESK, { id: uid('i1'), status: 'resolved' }),
    e => e.status === 400 && /tatuliwa|resolved/i.test(e.message), 'resolved without saying how is refused');
  assert.equal(d._dump('issues')[0].status, 'open');
  const r = await _FNS.issueUpdate(d, DESK, { id: uid('i1'), status: 'resolved', resolution: 'Simu imebadilishwa Samsung',
    assignedTo: 'Kelvin', referredTo: 'SAMSUNG', externalRef: 'SS-1234', verified: true });
  assert.equal(r.change, 'open>resolved'); assert.equal(r.status, 'resolved');
  const [row] = d._dump('issues');
  assert.equal(row.status, 'resolved'); assert.equal(row.resolution, 'Simu imebadilishwa Samsung');
  assert.equal(row.resolved_by, 'NEEMA M'); assert.ok(row.resolved_at, 'the closing date GD SOP B.3 asks for');
  assert.equal(row.assigned_to, 'Kelvin'); assert.equal(row.referred_to, 'SAMSUNG'); assert.equal(row.external_ref, 'SS-1234');
  assert.equal(row.verified, true);
  assert.equal(row.updated_by, 'NEEMA M'); assert.notEqual(row.updated_at, '2026-09-01T08:00:00Z');
  assert.equal(row.staff_name, 'JUMA G', 'the raiser is never restamped');
  let notes = d._dump('issue_notes');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].issue_id, uid('i1')); assert.equal(notes[0].by_name, 'NEEMA M'); assert.equal(notes[0].by_code, 'D1');
  assert.equal(notes[0].change, 'open>resolved'); assert.equal(notes[0].note, 'open → resolved', 'a move with no words is still written down');
  // Reopened: the closing stamps go, the resolution stays as history, the note says why.
  const r2 = await _FNS.issueUpdate(d, DESK, { id: uid('i1'), status: 'open', note: 'Imerudi tena na tatizo lile lile' });
  assert.equal(r2.change, 'resolved>open');
  assert.equal(row.status, 'open'); assert.equal(row.resolved_by, null); assert.equal(row.resolved_at, null);
  assert.equal(row.resolution, 'Simu imebadilishwa Samsung');
  notes = d._dump('issue_notes');
  assert.equal(notes.length, 2); assert.equal(notes[1].note, 'Imerudi tena na tatizo lile lile'); assert.equal(notes[1].change, 'resolved>open');
  // A note alone is a note alone; a resolution typed without resolving is kept for later.
  const r3 = await _FNS.issueUpdate(d, DESK, { id: uid('i1'), note: 'Nimempigia', resolution: 'Itakuwa: badilisha betri' });
  assert.equal(r3.change, null); assert.equal(row.status, 'open'); assert.equal(row.resolution, 'Itakuwa: badilisha betri');
  assert.equal(d._dump('issue_notes').length, 3);
  // Same status again is not a move, and nothing at all is refused.
  await assert.rejects(() => _FNS.issueUpdate(d, DESK, { id: uid('i1'), status: 'open' }), e => e.status === 400 && /badilika|nothing/i.test(e.message));
  await assert.rejects(() => _FNS.issueUpdate(d, DESK, { id: uid('i1') }), e => e.status === 400);
  await assert.rejects(() => _FNS.issueUpdate(d, DESK, { id: uid('i1'), status: 'lost', note: 'x' }), e => e.status === 400 && /hali|status/i.test(e.message));
  await assert.rejects(() => _FNS.issueUpdate(d, DESK, { id: uid('zz'), note: 'x' }), e => e.status === 400 && /halipo|no longer/i.test(e.message));
  await assert.rejects(() => _FNS.issueUpdate(d, DESK, { id: 'not-a-uuid', note: 'x' }), e => e.status === 400);
  assert.equal(d._dump('issue_notes').length, 3, 'a refused move writes no note');
});

test('issues: escalating stamps who and when, and tells GM_EMAIL', async () => {
  const cap = captureMail();
  try {
    const d = issDb({ issues: [anIssue({ id: uid('e1'), department: 'SALES', title: 'Ajenti hajaleta risiti kwa wiki mbili' })],
      settings: [{ key: 'GM_EMAIL', value: 'gm@hoop.co.tz' }] });
    const r = await _FNS.issueUpdate(d, DESK, { id: uid('e1'), status: 'escalated', note: 'RSM amefuatilia mara tatu, hakuna jibu' });
    assert.equal(r.change, 'open>escalated'); assert.equal(r.emailed, true);
    const [row] = d._dump('issues');
    assert.equal(row.status, 'escalated'); assert.equal(row.escalated_by, 'NEEMA M'); assert.ok(row.escalated_at);
    assert.equal(cap.sent.length, 1);
    const b = JSON.stringify(cap.sent[0].body);
    assert.ok(b.includes('gm@hoop.co.tz'));
    assert.match(cap.sent[0].body.subject, /SALES/); assert.match(cap.sent[0].body.subject, /Ajenti hajaleta/);
    assert.match(b, /RSM amefuatilia/, 'the note travels with the escalation');
    // Nobody set: escalated all the same, and the answer says the mail did not go.
    const quiet = issDb({ issues: [anIssue({ id: uid('e2') })] });
    const r2 = await _FNS.issueUpdate(quiet, DESK, { id: uid('e2'), status: 'escalated', note: 'x' });
    assert.equal(r2.emailed, false); assert.ok(r2.emailNote); assert.equal(quiet._dump('issues')[0].status, 'escalated');
    assert.equal(cap.sent.length, 1);
    // Moving it somewhere else sends nothing.
    await _FNS.issueUpdate(d, DESK, { id: uid('e1'), status: 'waiting', note: 'GM ameuliza RSM' });
    assert.equal(cap.sent.length, 1);
  } finally { cap.restore(); }
});

test('issues: a raiser may talk on their own issue, never move it, and never see another\'s', async () => {
  const d = issDb({ issues: [anIssue({ id: uid('mine'), code: 'A1' }), anIssue({ id: uid('theirs'), code: 'A2', name: 'ASHA K' })] });
  const r = await _FNS.issueUpdate(d, RAISER, { id: uid('mine'), note: 'Nimeambatanisha risiti leo',
    status: 'resolved', resolution: 'nimemaliza', assignedTo: 'me', verified: true, referredTo: 'WATU' });
  assert.equal(r.change, null); assert.equal(r.status, 'open');
  const mine = d._dump('issues').find(x => x.id === uid('mine'));
  assert.equal(mine.status, 'open'); assert.equal(mine.assigned_to, null); assert.equal(mine.verified, false);
  assert.equal(mine.referred_to, null); assert.equal(mine.resolution, null);
  assert.equal(mine.updated_by, 'JUMA G', 'the note still counts as touching it');
  const notes = d._dump('issue_notes');
  assert.equal(notes.length, 1); assert.equal(notes[0].by_name, 'JUMA G'); assert.equal(notes[0].change, null);
  // Not yours reads as not there.
  await assert.rejects(() => _FNS.issueUpdate(d, RAISER, { id: uid('theirs'), note: 'hello' }),
    e => e.status === 400 && /halipo|no longer/i.test(e.message));
  await assert.rejects(() => _FNS.issueNotes(d, RAISER, { id: uid('theirs') }), e => e.status === 400);
  await assert.rejects(() => _FNS.issueUpdate(d, RAISER, { id: uid('mine') }), e => e.status === 400, 'nothing to say');
  assert.equal(d._dump('issue_notes').length, 1);
  // The conversation: the raiser reads their own; the desk and the book read any.
  assert.equal((await _FNS.issueNotes(d, RAISER, { id: uid('mine') })).notes.length, 1);
  assert.deepEqual((await _FNS.issueNotes(d, DESK, { id: uid('theirs') })).notes, []);
  const n = await _FNS.issueNotes(d, HEAD, { id: uid('mine') });
  assert.equal(n.notes[0].by, 'JUMA G'); assert.equal(n.notes[0].note, 'Nimeambatanisha risiti leo'); assert.ok(n.notes[0].at);
  await assert.rejects(() => _FNS.issueNotes(d, DESK, { id: 'nope' }), e => e.status === 400);
});

test('issues: two desks cannot silently overwrite each other\'s move', async () => {
  const d = issDb({ issues: [anIssue({ id: uid('i1'), updatedAt: '2026-09-01T08:00:00Z' })] });
  /* Somebody else's update lands between this desk's read and its write: the row's updated_at
     has moved on, so the guarded update matches nothing and the desk is told to reopen it. */
  const raw = d.from.bind(d);
  d.from = name => {
    const q = raw(name);
    if (name === 'issues') {
      const u = q.update.bind(q);
      q.update = p => { d._dump('issues')[0].updated_at = '2026-09-01T09:00:00Z'; d._dump('issues')[0].status = 'waiting'; return u(p); };
    }
    return q;
  };
  await assert.rejects(() => _FNS.issueUpdate(d, DESK, { id: uid('i1'), status: 'resolved', resolution: 'done', note: 'x' }),
    e => e.status === 400 && /mtu mwingine|Somebody else/i.test(e.message));
  assert.equal(d._dump('issues')[0].status, 'waiting', 'the other desk\'s move stands');
  assert.equal(d._dump('issue_notes').length, 0, 'and no note claims a move that did not happen');
});

/* ---------------------------------------------------------------------------------------- */
test('issues: the report is a period by the date raised, with the numbers a head asks across a desk', async () => {
  const d = issDb({ issues: [
    anIssue({ id: uid('a'), department: 'IT', status: 'open', age: 3 }),
    anIssue({ id: uid('b'), department: 'IT', status: 'resolved', age: 10, resolvedAt: daysAgo(6), resolvedBy: 'NEEMA M' }),
    anIssue({ id: uid('c'), department: 'CREDIT', status: 'resolved', age: 8, resolvedAt: daysAgo(6) }),
    anIssue({ id: uid('d'), department: 'CREDIT', status: 'escalated', age: 20 }),
    anIssue({ id: uid('e'), department: 'STORE', status: 'waiting', age: 40 }),
    anIssue({ id: uid('f'), department: 'HR', status: 'open', at: '2025-01-01T08:00:00Z' }),
  ] });
  const r = await _FNS.issueReport(d, HEAD, { from: dayOf(daysAgo(30)), to: dayOf(daysAgo(0)) });
  assert.deepEqual(r.rows.map(x => x.id), [uid('a'), uid('c'), uid('b'), uid('d')], 'in the period, newest first');
  assert.equal(r.totals.count, 4);
  assert.equal(r.totals.open, 1); assert.equal(r.totals.waiting, 0); assert.equal(r.totals.escalated, 1); assert.equal(r.totals.resolved, 2);
  assert.equal(r.totals.avgDays, 3, '(4 + 2) / 2 days from raised to resolved');
  assert.equal(r.totals.oldestOpenDays, 20, 'the escalated one has waited longest');
  assert.deepEqual(r.totals.byDept, [
    { department: 'IT', count: 2, open: 1, resolved: 1 },
    { department: 'CREDIT', count: 2, open: 1, resolved: 1 },
  ], 'departments with nothing in the period are not listed');
  assert.equal(r.rows[2].resolvedBy, 'NEEMA M');
  assert.deepEqual(r.departments, DEPTS);
  // Narrowed by department, by status, and both.
  const cr = await _FNS.issueReport(d, HEAD, { from: dayOf(daysAgo(30)), to: dayOf(daysAgo(0)), department: 'credit' });
  assert.equal(cr.totals.count, 2); assert.equal(cr.rows.length, 2); assert.equal(cr.totals.byDept.length, 1);
  const rs = await _FNS.issueReport(d, HEAD, { from: dayOf(daysAgo(30)), to: dayOf(daysAgo(0)), department: 'credit', status: 'resolved' });
  assert.deepEqual(rs.rows.map(x => x.id), [uid('c')]); assert.equal(rs.totals.count, 2, 'the totals are the period\'s, the rows the filter\'s');
  // No dates is everything; a date that is not a date is ignored rather than refused.
  assert.equal((await _FNS.issueReport(d, HEAD, {})).totals.count, 6);
  assert.equal((await _FNS.issueReport(d, HEAD, { from: 'yesterday', to: 'now' })).totals.count, 6);
  assert.equal((await _FNS.issueReport(d, HEAD, { department: 'HR' })).totals.count, 1);
  assert.equal((await _FNS.issueReport(d, HEAD, { status: 'nonsense' })).rows.length, 6, 'an unknown status filter is no filter');
});

test('issues: before the migration every pane says which file to run instead of failing', async () => {
  const bare = fakeDb({ issues: [], issue_notes: [] }, { missingColumns: { issues: ['id'] } });
  for (const [fn, user] of [['issueMine', RAISER], ['issueQueue', DESK], ['issueReport', HEAD]]) {
    const r = await _FNS[fn](bare, user, {});
    assert.equal(r.notReady, true, fn + ' reports not-ready rather than throwing');
    assert.deepEqual(r.rows, []);
  }
  assert.equal((await _FNS.issueNotes(bare, RAISER, { id: uid('i1') })).notReady, true);
  for (const [fn, args] of [['issueUpdate', { id: uid('i1'), note: 'x' }], ['issueRaise', { department: 'IT', title: 'x' }]]) {
    await assert.rejects(() => _FNS[fn](bare, fn === 'issueRaise' ? RAISER : DESK, args),
      e => e.status === 400 && /RUN-ME-2026-09-08-issues\.sql/.test(e.message), fn + ' names the migration');
  }
});

/* ---------------------------------------------------------------------------------------- */
test('issues: the call card reads the customer\'s issues as its complaints, open ones first by date', async () => {
  const NOW = Date.parse('2026-09-08T09:00:00+03:00');
  const base = () => ({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D', rsm: 'Anold Sawe' }],
    access_codes: [], followup_status: [], followup_comments: [], call_users: [], call_logs: [],
  });
  const d = fakeDb({ ...base(), issues: [
    anIssue({ id: uid('c1'), kind: 'complaint', subjectType: 'imei', subject: '351929937378664', department: 'CREDIT',
      title: 'Amelipa lakini simu imefungwa', status: 'open', name: 'NEEMA M', age: 1 }),
    anIssue({ id: uid('c2'), kind: 'system', subjectType: 'imei', subject: '351929937378664', department: 'IT',
      title: 'Skrini imevunjika', status: 'resolved', age: 5, resolvedAt: daysAgo(2) }),
    anIssue({ id: uid('c3'), kind: 'complaint', subjectType: 'imei', subject: '999999999999999', department: 'CREDIT', title: 'Another customer' }),
    anIssue({ id: uid('c4'), kind: 'document', subjectType: 'receipt', subject: '351929937378664', department: 'FINANCE', title: 'A receipt number that happens to match' }),
  ] });
  await callApi(d, 'api_callRegister', ['dev-1', 'Ainea', '', '', '0712345678', 'AB2C3D'], NOW);
  const r = await callApi(d, 'api_callComments', ['dev-1', '351929937378664'], NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.complaints.map(c => c.status), ['OPEN', 'RESOLVED'], 'this IMEI only, newest first, upper-cased as the card tests it');
  assert.equal(r.complaints[0].who, 'NEEMA M');
  assert.match(r.complaints[0].what, /^Amelipa lakini simu imefungwa · CREDIT$/, 'a complaint needs no tag');
  assert.match(r.complaints[1].what, /^\[system\] Skrini imevunjika · IT$/, 'anything else says what sort of thing it is');
  assert.ok(r.complaints[0].at);
  // Before the migration the card still answers, with none.
  const bare = fakeDb({ ...base(), issues: [] }, { missingColumns: { issues: ['kind'] } });
  await callApi(bare, 'api_callRegister', ['dev-1', 'Ainea', '', '', '0712345678', 'AB2C3D'], NOW);
  const r2 = await callApi(bare, 'api_callComments', ['dev-1', '351929937378664'], NOW);
  assert.equal(r2.ok, true); assert.deepEqual(r2.complaints, []);
});
