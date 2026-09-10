import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';

/* =========================================================================================
   AN ISSUE GOES TO A ROLE, AND OPTIONALLY TO ONE PERSON IN IT.

     "So when someone reports an issue they choose who to report to by choosing role and next
      (option) user in the role, so on the desks every user sees what they have on desk -- one
      issue for all in the role or for the directed individual."

   THE DEPARTMENT WAS A FIXED LIST IN CODE: eight names chosen once, with no relationship to
   the roles the owner actually creates in Access codes. So an issue could be filed to "IT"
   while the person who does IT work holds a role called something else, and the desk showed
   everybody everything regardless.

   A ROLE IS WHAT THE OWNER ALREADY MAINTAINS -- the same list they tick navs on -- so routing
   needs no second vocabulary that will drift out of step with the first.

   TO_NAME BLANK IS NOT A MISSING VALUE. It is the raiser saying "whoever gets to it first".
   ========================================================================================= */
const RAISER = { code: 'R1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['issuereq'], readOnly: false };
const ITDESK = { code: 'I1', name: 'GILBERT', role: 'IT', teams: null, tabs: ['issues'], readOnly: false };
const ITMATE = { code: 'I2', name: 'ASHA M', role: 'IT', teams: null, tabs: ['issues'], readOnly: false };
const STORE = { code: 'S1', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['issues'], readOnly: false };
const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const iss = o => ({
  id: o.id, raised_at: o.at || '2026-09-01T09:00:00Z',
  staff_code: 'R1', staff_name: 'JUMA G', staff_role: 'OFFICER',
  department: o.dept === undefined ? 'IT' : o.dept, kind: 'issue',
  subject_type: null, subject: null, title: o.title || 'Watu haifunguki', details: null,
  contact: null, verified: false, referred_to: null, external_ref: null,
  status: o.status || 'open', assigned_to: null, resolution: null,
  escalated_by: null, escalated_at: null, resolved_by: null, resolved_at: null,
  updated_by: 'JUMA G', updated_at: '2026-09-01T09:00:00Z',
  to_role: o.toRole === undefined ? null : o.toRole,
  to_name: o.toName === undefined ? null : o.toName,
});
const isDb = (o = {}) => fakeDb({
  issues: o.issues || [], issue_notes: [], settings: o.settings || [],
  access_codes: o.codes || [
    { code: 'I1', name: 'GILBERT', role: 'IT' }, { code: 'I2', name: 'ASHA M', role: 'IT' },
    { code: 'S1', name: 'SIPHO', role: 'STORE' },
  ],
});
const ids = d => d.rows.map(r => r.id).sort();

/* ---------------------------------------------------------------------------------------- */
test('a role with nobody named is on every holder’s desk; a name puts it on one', async () => {
  const db = isDb({ issues: [
    iss({ id: uid('a'), toRole: 'IT', toName: null }),        // anybody in IT
    iss({ id: uid('b'), toRole: 'IT', toName: 'ASHA M' }),    // Asha's alone
    iss({ id: uid('c'), toRole: 'STORE', toName: null }),     // not IT's at all
  ] });
  assert.deepEqual(ids(await _FNS.issueQueue(db, ITDESK, {})), [uid('a')].sort(),
    'Gilbert sees the role’s, not the one addressed to Asha');
  assert.deepEqual(ids(await _FNS.issueQueue(db, ITMATE, {})), [uid('a'), uid('b')].sort(),
    'Asha sees the role’s AND her own');
  assert.deepEqual(ids(await _FNS.issueQueue(db, STORE, {})), [uid('c')].sort());

  const asha = await _FNS.issueQueue(db, ITMATE, {});
  assert.equal(asha.counts.mine, 2);
  assert.equal(asha.counts.directed, 1, 'and it says how many are hers by name');
  assert.equal(asha.view, 'mine', 'the desk is my desk by default');
});

test('a supervisor sees everything, and anybody can ask for the whole log', async () => {
  const db = isDb({ issues: [
    iss({ id: uid('a'), toRole: 'IT' }), iss({ id: uid('c'), toRole: 'STORE' }),
  ] });
  /* Supervision that can only see its own desk is not supervision, and ADMIN IS FULL ACCESS
     EVERYWHERE WE DEVELOP -- the standing rule. */
  const boss = await _FNS.issueQueue(db, ADMIN, {});
  assert.equal(boss.view, 'all');
  assert.equal(boss.rows.length, 2);
  const viewer = { ...ITDESK, code: 'V1', name: 'Auditor', role: 'AUDITOR', readOnly: true };
  assert.equal((await _FNS.issueQueue(db, viewer, {})).rows.length, 2);
  // And a desk that wants the whole queue asks for it.
  assert.equal((await _FNS.issueQueue(db, STORE, { view: 'all' })).rows.length, 2);
  assert.deepEqual(ids(await _FNS.issueQueue(db, STORE, { view: 'all', toRole: 'it' })), [uid('a')],
    'narrowed by role, case-insensitively');
});

test('an issue filed before routing existed stays on everybody’s desk', async () => {
  /* THE DEPLOY-DAY HAZARD. Matching the old department against somebody's role would have
     been a guess, and a wrong guess means an old issue quietly falling off every desk in the
     company. It was filed when the desk WAS one queue; that is what it was addressed to. */
  const db = isDb({ issues: [
    iss({ id: uid('old'), dept: 'FINANCE', toRole: null }),
    iss({ id: uid('new'), toRole: 'IT' }),
  ] });
  assert.deepEqual(ids(await _FNS.issueQueue(db, STORE, {})), [uid('old')],
    'the store keeper still sees the unrouted one, and only the unrouted one');
  assert.deepEqual(ids(await _FNS.issueQueue(db, ITDESK, {})), [uid('new'), uid('old')].sort());
});

test('raising picks a role, and the person is optional', async () => {
  const prev = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const db = isDb();
    const out = await _FNS.issueRaise(db, RAISER, { toRole: 'it', title: 'Printa imekufa' });
    assert.equal(out.toRole, 'IT');
    assert.equal(out.toName, '');
    const row = db._dump('issues')[0];
    assert.equal(row.to_role, 'IT');
    assert.equal(row.to_name, null, 'blank is "whoever gets to it first", not a missing value');
    assert.equal(row.department, 'IT', 'and the department still follows where the role is one of the eight');

    const one = await _FNS.issueRaise(db, RAISER, { toRole: 'IT', toName: 'ASHA M', title: 'Kwa Asha' });
    assert.equal(one.toName, 'ASHA M');
    // A role the department list has never heard of routes fine and simply has no department.
    await _FNS.issueRaise(db, RAISER, { toRole: 'Regional_Manager', title: 'Kwa RSM' });
    const rsm = db._dump('issues').find(r => r.title === 'Kwa RSM');
    assert.equal(rsm.to_role, 'REGIONAL_MANAGER');
    assert.equal(rsm.department, null,
      'refusing this because the owner’s vocabulary moved on would stop the log rather than route it');

    await assert.rejects(() => _FNS.issueRaise(db, RAISER, { title: 'x' }),
      /Chagua wadhifa|Choose the role/, 'an issue addressed to nobody is a note, not an issue');
    // The old department field still files, so a screen that has not reloaded keeps working.
    const legacy = await _FNS.issueRaise(db, RAISER, { department: 'STORE', title: 'Ya zamani' });
    assert.equal(legacy.department, 'STORE');
  } finally { if (prev == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; }
});

test('the form is offered the roles and the people, and never an access code', async () => {
  const db = isDb();
  const d = await _FNS.issueTargets(db, RAISER);
  const it = d.roles.find(r => r.role === 'IT');
  assert.deepEqual(it.people, ['ASHA M', 'GILBERT'], 'the people in that role, by name');
  assert.ok(d.roles.some(r => r.role === 'FINANCE'),
    'and the eight names this log was born with, so an office mid-move can address either way');
  /* THE ACCESS CODES NEVER TRAVEL. This is the only place outside Access codes that reads that
     table, and a raise form has no business carrying anybody's credential. */
  assert.ok(!JSON.stringify(d).includes('"I1"') && !JSON.stringify(d).includes('"S1"'),
    'no code value anywhere in the answer');
  // Behind either issue nav -- the person filing chooses where it goes, and will not hold Settings.
  assert.equal((await _FNS.issueTargets(db, ITDESK)).ok, true);
  const outsider = { code: 'Z', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };
  await assert.rejects(() => _FNS.issueTargets(db, outsider), /no access to the issuereq pane/);
});

test('before the migration the log still files and still reads, and says routing is off', async () => {
  const bare = fakeDb({ issues: [iss({ id: uid('a'), dept: 'IT', toRole: null })], issue_notes: [],
    settings: [], access_codes: [] }, { missingColumns: { issues: ['to_role', 'to_name'] } });
  const d = await _FNS.issueQueue(bare, ITDESK, {});
  assert.equal(d.routed, false);
  assert.match(d.routeNote, /RUN-ME-2026-09-10-issue-routing\.sql/);
  assert.equal(d.view, 'all', 'nothing is routed, so "my desk" would read as the log having emptied');
  assert.equal(d.rows.length, 1);

  const prev = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    /* A raise between the deploy and the paste must still FILE -- unrouted -- rather than be
       refused. The row lands with a department so nothing downstream has a null it never
       expected. */
    await _FNS.issueRaise(bare, RAISER, { toRole: 'Regional_Manager', title: 'Kabla ya migration' });
    const row = bare._dump('issues').find(r => r.title === 'Kabla ya migration');
    assert.ok(row, 'it filed');
    assert.equal(row.to_role, undefined);
    assert.equal(row.department, 'GENERAL_DUTY');
  } finally { if (prev == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; }
});
