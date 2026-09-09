import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';

/* =========================================================================================
   ENROLMENT -- IT SOP A.

     A.1   "Collect the required details: FULL NAME, ID NUMBER, CONTACT INFORMATION, and
            REFEREES, from the RSM/team leader."
     A.2   "Enter the details into the system accurately and completely."
     A.3   "VERIFY DATA COMPLETENESS BEFORE ACTIVATING THE ACCOUNT."
     A.4   "Notify the RSM/General Manager once enrollment is complete."
     RSM SOP E.1 / CSM SOP H.1   the same question from the other side: are all my agents
            enrolled with correct, complete details?

   Three SOPs ask one question and nothing could answer it: the register arrives by uploading
   Sipho's SyscoPos page, which has no notion of a missing field, no notion of a record having
   been CHECKED, and no way to tell an RSM their person is on it.

   A.3 IS THE ONLY GATE HERE, and every test about it is really about one thing: the check
   comes BEFORE the activation, and it is counted from the stored row rather than asserted by
   whoever pressed the button.

   THE PERMISSION IS THE NAV, as everywhere here.
   ========================================================================================= */
const IT = { code: 'I1', name: 'GILBERT', role: 'OFFICER', teams: null, tabs: ['enrol'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['enrol'], readOnly: true };
const OTHER = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const NID = '19950923141260000121';               // twenty digits, as NIDA writes them
/** A register row with everything SOP A.1 asks for; `o` takes any of it away. */
const agent = (o = {}) => ({
  phone: o.phone || '0712000001', name: o.name === undefined ? 'RISHADI C' : o.name,
  national_id: o.nid === undefined ? NID : o.nid, email: 'r@hoop.co.tz',
  role: o.role === undefined ? 'Field_Officer' : o.role,
  branch: o.branch === undefined ? 'ILALA' : o.branch,
  manager: o.manager || null, active: o.active !== false,
  joined_date: '2026-02-21',
  kin_name: o.kin === undefined ? 'ATHUMANI D' : o.kin,
  kin_phone: o.kinPhone === undefined ? '0670306780' : o.kinPhone,
  kin_relationship: 'BABA',
  kin2_name: o.kin2 === undefined ? 'AGNES L' : o.kin2,
  kin2_phone: o.kin2Phone === undefined ? '0673506061' : o.kin2Phone,
  kin2_relationship: 'MAMA',
  enrolled_by: o.enrolledBy || null, enrolled_at: o.enrolledAt || null,
  verified_by: o.verifiedBy || null, verified_at: o.verifiedAt || null,
  notified_at: o.notifiedAt || null, notified_to: o.notifiedTo || null,
  enrol_note: null, updated_at: '2026-09-01T08:00:00Z',
});
const enDb = (o = {}) => fakeDb({
  hoop_agents: o.agents || [], call_users: o.users || [], settings: o.settings || [],
});
const FULL = {
  phone: '0755111222', name: 'NEEMA MTUI', nationalId: NID, email: 'n@hoop.co.tz',
  role: 'Field_Officer', branch: 'ILALA',
  kinName: 'JUMA G', kinPhone: '0712000009', kinRel: 'KAKA',
  kin2Name: 'ASHA G', kin2Phone: '0712000008', kin2Rel: 'DADA',
};
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
const rowOf = async (db, phone) =>
  (await db.from('hoop_agents').select('*')).data.find(r => r.phone === phone);

/* ---------------------------------------------------------------------------------------- */
test('A.1: the desk names exactly what is missing, per person and per branch', async () => {
  const db = enDb({
    agents: [
      agent({ phone: '0712000001', branch: 'ILALA' }),                          // complete
      agent({ phone: '0712000002', branch: 'ILALA', nid: '' }),                 // no ID number
      agent({ phone: '0712000003', branch: 'UBUNGO', kin2: '', kin2Phone: '' }), // one referee only
    ],
    users: [{ phone: '0712000001' }],
  });
  const d = await _FNS.enrolQueue(db, IT, {});
  assert.equal(d.counts.total, 3);
  assert.equal(d.counts.gaps, 2);

  const byPhone = Object.fromEntries(d.rows.map(r => [r.phone, r]));
  assert.deepEqual(byPhone['0712000002'].gaps, ['nationalId']);
  /* "REFEREES", PLURAL, IN THE SOP. The register had one slot; a row with one referee is not
     a complete row, and saying so is the entire reason the second pair of columns exists. */
  assert.deepEqual(byPhone['0712000003'].gaps.sort(), ['kin2Name', 'kin2Phone']);
  assert.equal(byPhone['0712000001'].complete, true);

  /* ON THE REGISTER IS NOT THE SAME AS USING THE SYSTEM -- RSM E.1 asks whether people are
     enrolled, and only a handset that has actually signed on proves the details reached them. */
  assert.equal(byPhone['0712000001'].inApp, true);
  assert.equal(byPhone['0712000002'].inApp, false);
  assert.equal(d.counts.inApp, 1);

  // Worst first, so the desk opens on the work rather than on the alphabet.
  assert.ok(!d.rows[0].complete && !d.rows[1].complete, 'incomplete rows come first');

  const ilala = d.byBranch.find(b => b.branch === 'ILALA');
  assert.equal(ilala.total, 2);
  assert.equal(ilala.gaps, 1, 'an RSM asks the question about their own region (SOP E.1)');
});

test('A.3: an account cannot be activated while anything is missing, and the check is not the caller’s word', async () => {
  const db = enDb({ agents: [agent({ phone: '0712000002', nid: '', active: false })] });
  await assert.rejects(
    () => _FNS.enrolUpdate(db, IT, { phone: '0712000002', step: 'verify' }),
    /Bado hakijakamilika[\s\S]*ID number/,
    'the refusal names the field, or the person is left guessing which one');
  assert.equal((await rowOf(db, '0712000002')).active, false, 'and nothing was switched on');

  /* THE COUNT IS TAKEN FROM THE STORED ROW. A completeness check the caller can assert is not
     a check -- so claiming it is complete changes nothing. */
  await assert.rejects(
    () => _FNS.enrolUpdate(db, IT, { phone: '0712000002', step: 'verify', complete: true, gaps: [] }),
    /Bado hakijakamilika/);

  await _FNS.enrolSave(db, IT, { ...FULL, phone: '0712000002', nationalId: NID });
  const out = await _FNS.enrolUpdate(db, IT, { phone: '0712000002', step: 'verify' });
  assert.equal(out.verified, true);
  const row = await rowOf(db, '0712000002');
  assert.equal(row.verified_by, 'GILBERT');
  assert.ok(row.verified_at);
  // A.3 in one line: the check and the activation are the same act, so there is no way to
  // have one without the other.
  assert.equal(row.active, true);
});

test('A.2: a new enrolment starts switched off, and the ID is checked rather than believed', async () => {
  const db = enDb();
  const out = await _FNS.enrolSave(db, IT, FULL);
  assert.equal(out.created, true);
  assert.equal(out.complete, true);
  const row = await rowOf(db, '0755111222');
  /* THE COLUMN'S OWN DEFAULT IS TRUE, so a row created here has to say otherwise out loud --
     and that is the whole reason activation is an act rather than a flag. */
  assert.equal(row.active, false, 'nothing enrolled here is live until A.3 has been done');
  assert.equal(row.enrolled_by, 'GILBERT');
  assert.ok(row.enrolled_at);

  // A phone number is the register's primary key, so two spellings of one number are two people.
  const again = await _FNS.enrolSave(db, IT, { ...FULL, phone: '+255 755 111 222', name: 'NEEMA M MTUI' });
  assert.equal(again.created, false, 'the same number in another spelling is the same person');
  assert.equal((await db.from('hoop_agents').select('*')).data.length, 1);
  assert.equal((await rowOf(db, '0755111222')).name, 'NEEMA M MTUI');
  await assert.rejects(() => _FNS.enrolSave(db, IT, { ...FULL, phone: '12' }), /si sahihi|not a Tanzanian/i);
  await assert.rejects(() => _FNS.enrolSave(db, IT, { ...FULL, name: '' }), /jina kamili|full name/i);

  /* AN ID OF THE WRONG LENGTH IS FLAGGED, NEVER REFUSED. It is the one field where a slip is
     invisible, and the register holds real numbers of nineteen digits and real ones written
     with dashes -- a rule that threw those out would cost more than it found. */
  const odd = await _FNS.enrolSave(db, IT, { ...FULL, phone: '0755111333', nationalId: '1234' });
  assert.equal(odd.idOdd, true, 'said back at the moment of saving');
  assert.equal(odd.complete, true, 'but it is present, so it is not a gap');
  assert.ok(await rowOf(db, '0755111333'), 'and the row is saved either way');
});

test('an edit that empties a required field undoes the check, without switching anybody off', async () => {
  const db = enDb({ agents: [agent({ phone: '0712000001', verifiedBy: 'GILBERT', verifiedAt: '2026-09-01T09:00:00Z' })] });
  await _FNS.enrolSave(db, IT, {
    phone: '0712000001', name: 'RISHADI C', nationalId: NID, role: 'Field_Officer', branch: 'ILALA',
    kinName: 'ATHUMANI D', kinPhone: '0670306780', kin2Name: '', kin2Phone: '',
  });
  const row = await rowOf(db, '0712000001');
  /* Verification is about the details AS THEY STOOD when somebody looked at them, so a row
     that has lost one is a row nobody has checked. */
  assert.equal(row.verified_at, null);
  assert.equal(row.verified_by, null);
  /* But a typo must not cost somebody their working day, so the account is NOT switched off --
     the desk counts "live but never checked" as its own number instead. */
  assert.equal(row.active, true);
  const d = await _FNS.enrolQueue(db, IT, {});
  assert.equal(d.counts.liveUnverified, 1);
  assert.equal(d.counts.unverified, 1);
});

test('A.4: the RSM is told once it is complete, by branch, and never before', async () => {
  const mail = captureMail();
  try {
    const settings = [{ key: 'ENROL_EMAIL', value: 'ILALA=rsm.ilala@hoop.co.tz\nUBUNGO=rsm.ubungo@hoop.co.tz\ngm@hoop.co.tz' },
      { key: 'GM_EMAIL', value: 'ceo@hoop.co.tz' }];
    const db = enDb({ agents: [agent({ phone: '0712000001', branch: 'ILALA' }),
      agent({ phone: '0712000004', branch: 'MOROGORO' })], settings });

    await assert.rejects(() => _FNS.enrolUpdate(db, IT, { phone: '0712000001', step: 'notify' }),
      /Thibitisha kwanza|Verify it before/,
      'A.4 says "once enrollment is complete", so it cannot come before A.3');

    await _FNS.enrolUpdate(db, IT, { phone: '0712000001', step: 'verify' });
    const out = await _FNS.enrolUpdate(db, IT, { phone: '0712000001', step: 'notify' });
    assert.equal(out.emailed, true);
    assert.equal(out.to, 'rsm.ilala@hoop.co.tz', 'each region’s RSM hears about their own people');
    assert.match(mail.sent[0].body.subject, /usajili umekamilika|enrolment complete/i);
    const row = await rowOf(db, '0712000001');
    assert.ok(row.notified_at, 'WHO was told and WHEN, not merely that somebody meant to');
    assert.equal(row.notified_to, 'rsm.ilala@hoop.co.tz');

    // A branch with no line of its own still reaches somebody: the plain address, then the GM.
    await _FNS.enrolUpdate(db, IT, { phone: '0712000004', step: 'verify' });
    const other = await _FNS.enrolUpdate(db, IT, { phone: '0712000004', step: 'notify' });
    assert.equal(other.to, 'gm@hoop.co.tz');

    const quiet = enDb({ agents: [agent({ phone: '0712000001', verifiedAt: '2026-09-01T09:00:00Z' })] });
    await assert.rejects(() => _FNS.enrolUpdate(quiet, IT, { phone: '0712000001', step: 'notify' }),
      /haikutumwa|was not sent/i,
      'silence would look exactly like an RSM who had been told');
  } finally { mail.restore(); }
});

test('switching an account off takes a reason, and the register stays honest', async () => {
  const db = enDb({ agents: [agent({ phone: '0712000001' })] });
  await assert.rejects(() => _FNS.enrolUpdate(db, IT, { phone: '0712000001', step: 'off' }),
    /sababu|reason/i, 'a register that only ever grows cannot be read');
  await _FNS.enrolUpdate(db, IT, { phone: '0712000001', step: 'off', note: 'Ameacha kazi Agosti' });
  const row = await rowOf(db, '0712000001');
  assert.equal(row.active, false);
  assert.equal(row.enrol_note, 'Ameacha kazi Agosti');
  /* Switching somebody back on goes through A.3 again -- which is right: the SOP says
     completeness is verified before an account is activated, every time. */
  await _FNS.enrolUpdate(db, IT, { phone: '0712000001', step: 'verify' });
  assert.equal((await rowOf(db, '0712000001')).active, true);
  await assert.rejects(() => _FNS.enrolUpdate(db, IT, { phone: '0712000001', step: 'on' }), /Hatua si sahihi|Unknown step/);
});

test('the nav is the permission, and the desk still lists people before the migration is run', async () => {
  const db = enDb({ agents: [agent({})] });
  for (const [fn, args] of [['enrolQueue', {}], ['enrolSave', FULL], ['enrolUpdate', { phone: '0712000001', step: 'verify' }]]) {
    await assert.rejects(() => _FNS[fn](db, OTHER, args), /no access to the enrol pane/i, fn + ' is behind the nav');
  }
  await assert.rejects(() => _FNS.enrolSave(db, VIEWER, FULL), /kuangalia tu|view-only/i);
  await assert.rejects(() => _FNS.enrolUpdate(db, VIEWER, { phone: '0712000001', step: 'verify' }), /kuangalia tu|view-only/i);
  assert.equal((await _FNS.enrolQueue(db, OWNER, {})).ok, true, 'ADMIN is full access everywhere');
  assert.equal((await _FNS.enrolQueue(db, VIEWER, {})).ok, true, 'and supervision reads it');

  /* BEFORE THE MIGRATION the new columns are not there. The register still LISTS -- taking the
     staff pane down between a deploy and somebody pasting SQL would be a worse failure than
     the one being fixed -- and the desk says plainly that nothing can be verified yet. */
  const old = fakeDb({ hoop_agents: [{ phone: '0712000001', name: 'RISHADI C', national_id: NID,
    role: 'Field_Officer', branch: 'ILALA', kin_name: 'A', kin_phone: '0670306780', active: true }],
    call_users: [], settings: [] },
    { missingColumns: { hoop_agents: ['kin2_name', 'verified_at', 'enrolled_by', 'manager'] } });
  const d = await _FNS.enrolQueue(old, IT, {});
  assert.equal(d.columnsReady, false);
  assert.equal(d.counts.total, 1, 'the list still reads');
  assert.match(d.notReadyNote, /RUN-ME-2026-09-10-enrolment\.sql/);
  await assert.rejects(() => _FNS.enrolUpdate(old, IT, { phone: '0712000001', step: 'verify' }),
    /RUN-ME-2026-09-10-enrolment\.sql/, 'and the write path names the file too');
});

test('the desk filters the way the questions are actually asked', async () => {
  const db = enDb({
    agents: [
      agent({ phone: '0712000001', branch: 'ILALA', verifiedAt: '2026-09-01T09:00:00Z', notifiedAt: '2026-09-01T10:00:00Z' }),
      agent({ phone: '0712000002', branch: 'ILALA', verifiedAt: '2026-09-01T09:00:00Z' }),
      agent({ phone: '0712000003', branch: 'UBUNGO', nid: '' }),
      agent({ phone: '0712000004', branch: 'UBUNGO', active: false }),
    ],
  });
  const only = async q => (await _FNS.enrolQueue(db, IT, q)).rows.map(r => r.phone).sort();
  assert.deepEqual(await only({ state: 'gaps' }), ['0712000003']);
  assert.deepEqual(await only({ state: 'unnotified' }), ['0712000002'], 'verified, nobody told (A.4)');
  assert.deepEqual(await only({ state: 'live' }), ['0712000003'],
    'live and never checked -- and a switched-off row is not on this list');
  assert.deepEqual(await only({ state: 'off' }), ['0712000004']);
  assert.deepEqual(await only({ branch: 'UBUNGO' }), ['0712000003', '0712000004']);
  assert.deepEqual(await only({ q: '0712000001' }), ['0712000001']);
  const d = await _FNS.enrolQueue(db, IT, {});
  assert.equal(d.counts.unnotified, 1);
  assert.equal(d.counts.active, 3);
});
