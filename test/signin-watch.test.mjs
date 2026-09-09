import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';
import { callApi } from '../api/_lib/call-core.js';
import { noteSignin, outcomeOf, codeKeyOf, maskSecret, maskPhone, _resetSeen,
  SIGNIN_OUTCOMES, SIGNIN_ALARMING } from '../api/_lib/signin.js';

/* =========================================================================================
   THE DOOR -- IT SOP D.

     "Access Controls: set and maintain user access controls so only authorized personnel can
      view or edit sensitive information."
     "Monitoring: MONITOR FOR UNAUTHORIZED ACCESS and act immediately on any breach, including
      changing the affected password."

   audit_log records what somebody did once they were INSIDE, and it is written after the
   door -- so a refused sign-in threw before it and left nothing anywhere. Somebody could sit
   and guess access codes all night and the system's own record of that night would be empty.

   The first rule of this feature is the one most of these tests are about: NOTHING WRITTEN
   HERE IS A WORKING CREDENTIAL. A security log that holds the keys is a bigger hole than the
   one it was dug to watch.

   THE PERMISSION IS THE NAV, as everywhere here.
   ========================================================================================= */
const IT = { code: 'I1', name: 'GILBERT', role: 'OFFICER', teams: null, tabs: ['security'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['security'], readOnly: true };
const OTHER = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const TODAY = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const minsAgo = n => new Date(Date.now() - n * 60000).toISOString();
/** One row as the door would have written it. */
const att = o => ({
  id: o.id, at: o.at || minsAgo(30), day: o.day || TODAY, door: o.door || 'portal',
  ok: !!o.ok, outcome: o.outcome || (o.ok ? 'ok' : 'invalid'),
  code_key: o.key === undefined ? codeKeyOf(o.code || 'K4M9J2') : o.key,
  code_masked: o.masked === undefined ? maskSecret(o.code || 'K4M9J2') : o.masked,
  phone_masked: o.phone ? maskPhone(o.phone) : null,
  device: o.device || null, who_name: o.who || null, who_role: o.role || null,
  detail: o.detail || null, ip: o.ip || '41.222.0.9', ua: o.ua || 'Mozilla/5.0',
  reviewed_by: o.reviewedBy || null, reviewed_at: o.reviewedAt || null, review_note: o.reviewNote || null,
});
const secDb = (o = {}) => fakeDb({ signin_attempts: o.rows || [], settings: o.settings || [] });

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
test('nothing the door writes down is a working credential', () => {
  const CODE = 'K4M9J2';
  const key = codeKeyOf(CODE);
  const masked = maskSecret(CODE);

  assert.ok(!key.includes(CODE) && !masked.includes(CODE), 'the code must not survive anywhere');
  assert.equal(key.length, 16, 'a stable handle, short enough to read across a table');
  assert.match(key, /^[0-9a-f]+$/, 'hex, so the review guard can insist on the shape');
  assert.notEqual(key, codeKeyOf('K4M9J3'), 'two different codes are two different lines');
  /* THE DOOR MATCHES CASE-INSENSITIVELY (caseInsensitiveCode in auth.js), so "k4m9j2" and
     "K4M9J2" are ONE code being tried twice. Splitting them into two lines would hide exactly
     the pattern this exists to show. */
  assert.equal(codeKeyOf('k4m9j2'), key, 'the same code in another case is the same line');

  assert.equal(masked, 'K' + '•'.repeat(5), 'first character and length, and nothing else');
  assert.equal(maskSecret(''), null, 'an empty box masks to nothing, never to a lie');
  assert.equal(maskSecret('Q'), '•', 'a one-character code gives away no character at all');

  /* A PHONE IS MASKED FROM THE BACK. The leading digits of a Tanzanian number are the network
     and are shared by millions of people, so hiding those hides nothing; the last three are
     the only part that identifies, and the only part a person recognises as their own. */
  assert.equal(maskPhone('0712000123'), '•'.repeat(7) + '123');
  assert.equal(maskPhone(''), null);
});

test('why the door said no is set at the throw, never read off the wording of a message', () => {
  assert.equal(outcomeOf({ reason: 'suspended' }), 'suspended');
  assert.equal(outcomeOf({ systemClosed: true }), 'closed', 'the admin’s own switch is its own answer');
  assert.equal(outcomeOf({ reason: 'nonsense' }), 'refused', 'an unknown reason is honest about not knowing');
  assert.equal(outcomeOf(new Error('Invalid access code.')), 'refused',
    'a bare Error is not classified by its English -- that is a regex that breaks on a rewording');
  for (const k of ['invalid', 'suspended', 'closed', 'switched_off', 'unknown_phone', 'view_only']) {
    assert.ok(SIGNIN_OUTCOMES.includes(k), k + ' must be a spellable outcome');
  }
  /* The system switch turning everybody away says nothing about anybody, so it must not be
     counted among the lines a person is asked to look at. */
  assert.ok(!SIGNIN_ALARMING.includes('closed'), 'a closed system is not a break-in');
  assert.ok(SIGNIN_ALARMING.includes('invalid') && SIGNIN_ALARMING.includes('suspended'));
});

test('the log can never break a sign-in, and a success is kept once a day rather than once a call', async () => {
  _resetSeen();
  /* An un-migrated database is every deployment's state until somebody pastes the SQL, and the
     door has to keep working through it. */
  const bare = fakeDb({ signin_attempts: [] }, { missingColumns: { signin_attempts: ['day'] } });
  assert.equal(await noteSignin(bare, { door: 'portal', ok: false, outcome: 'invalid', code: 'ZZ' }),
    null, 'a missing table is swallowed whole');

  const db = secDb();
  const wrote = await noteSignin(db, { door: 'portal', ok: true, code: 'K4M9J2', who: { name: 'NEEMA M', role: 'OFFICER' } });
  assert.ok(wrote && wrote.ok, 'the first sign-in of the day is recorded');
  assert.equal(wrote.code_masked, 'K' + '•'.repeat(5));
  assert.equal(await noteSignin(db, { door: 'portal', ok: true, code: 'K4M9J2' }), null,
    'the same person opening a second pane is not a second row -- every portal call passes this door');
  assert.ok(await noteSignin(db, { door: 'upload', ok: true, code: 'K4M9J2' }),
    'the upload page is a different door and is worth its own line');

  /* FAILURES ARE NEVER COLLAPSED. Five attempts is the fact; one row saying "somebody failed
     today" is the fact thrown away. */
  const before = (await db.from('signin_attempts').select('*')).data.length;
  await noteSignin(db, { door: 'portal', ok: false, outcome: 'invalid', code: 'GUESS1' });
  await noteSignin(db, { door: 'portal', ok: false, outcome: 'invalid', code: 'GUESS1' });
  const after = (await db.from('signin_attempts').select('*')).data;
  assert.equal(after.length, before + 2, 'both attempts are kept');
  assert.ok(after.every(r => !String(JSON.stringify(r)).includes('GUESS1')),
    'and neither of them wrote the code down');
});

test('the phone door is watched too -- a wrong team code is recorded, a real one signs in', async () => {
  _resetSeen();
  const db = fakeDb({
    teams: [{ team: 'KINONDONI', team_code: 'TM77' }],
    call_users: [], access_codes: [], signin_attempts: [], settings: [], hoop_agents: [],
  });
  await assert.rejects(
    () => callApi(db, 'api_callRegister', ['dev-1', 'Juma', '', '', '0712000123', 'NOPE99', ''], Date.now(), { ip: '41.1.1.1' }),
    /si sahihi|not correct/i);
  let rows = (await db.from('signin_attempts').select('*')).data;
  assert.equal(rows.length, 1, 'the refusal is on the record');
  assert.equal(rows[0].door, 'app');
  assert.equal(rows[0].outcome, 'invalid', 'a wrong team code is a wrong code, not a missing name');
  assert.equal(rows[0].phone_masked, '•'.repeat(7) + '123', 'the app door identifies by phone');
  assert.equal(rows[0].ip, '41.1.1.1');
  assert.ok(!JSON.stringify(rows[0]).includes('NOPE99'), 'the team code itself is not written down');

  await callApi(db, 'api_callRegister', ['dev-1', 'Juma', 'KINONDONI', '', '0712000123', 'TM77', ''], Date.now(), {});
  rows = (await db.from('signin_attempts').select('*')).data;
  assert.equal(rows.length, 2);
  const good = rows.find(r => r.ok);
  assert.ok(good, 'a registration that worked is a sign-in and is kept');
  assert.equal(good.who_name, 'Juma');

  /* Only registration is a door. Every other handler is reached by holding a device id already
     granted, so watching them would record two hundred officers working rather than anybody
     trying to get in. */
  const n = rows.length;
  await callApi(db, 'api_teamCode', [], Date.now(), {});
  assert.equal((await db.from('signin_attempts').select('*')).data.length, n,
    'reading the team code is not a sign-in');
});

test('the watch groups by the secret that was tried, and counts what a person should look at', async () => {
  const rows = [
    // Somebody working at one code, on two doors.
    att({ code: 'AAAA11', at: minsAgo(50) }),
    att({ code: 'AAAA11', at: minsAgo(45) }),
    att({ code: 'aaaa11', at: minsAgo(40), door: 'upload' }),   // the same code, typed in lower case
    att({ code: 'AAAA11', at: minsAgo(35), ip: '41.222.0.10' }),
    // One person on leave, whose code is real.
    att({ code: 'BBBB22', outcome: 'suspended', who: 'NEEMA M', at: minsAgo(20) }),
    // The admin's switch turning everybody away: not a break-in.
    att({ code: 'CCCC33', outcome: 'closed', at: minsAgo(15) }),
    // Two people who simply worked today.
    att({ code: 'DDDD44', ok: true, who: 'JUMA G', at: minsAgo(300) }),
    att({ code: 'EEEE55', ok: true, who: 'JANETH', at: minsAgo(200) }),
  ];
  const d = await _FNS.signinWatch(secDb({ rows, settings: [{ key: 'SIGNIN_ALERT_FAILS', value: '4' }] }), IT, {});
  assert.equal(d.alertFails, 4, 'how many tries stop being a typo is a setting, not a constant in code');
  assert.equal(d.counts.ok, 2);
  assert.equal(d.counts.people, 2, 'two different codes got in');
  assert.equal(d.counts.fails, 6);
  assert.equal(d.counts.alarming, 5, 'the closed-system refusal is not counted against anybody');

  const g = d.groups[0];
  assert.equal(g.tries, 4, 'four attempts at one code, including the one typed in lower case');
  assert.equal(g.masked, 'A' + '•'.repeat(5));
  assert.deepEqual(Object.keys(g.doors).sort(), ['portal', 'upload'], 'both doors on one line');
  assert.equal(g.ips.length, 2, 'the addresses it came from, deduplicated');
  assert.ok(g.first < g.last, 'first seen and last seen, so a night of it is visible');
  assert.equal(d.counts.watch, 1, 'one code has reached the threshold with nobody having acted');

  const susp = d.groups.find(x => x.whoName === 'NEEMA M');
  assert.ok(susp, 'a refusal against a REAL code names the person -- that is the one somebody must ring');
  assert.equal(susp.outcomes.suspended, 1);

  // The window is seven days ending today unless somebody says otherwise.
  assert.equal(d.to, TODAY);
  assert.ok(d.from < d.to, 'a week, so a pattern has room to show');
  assert.ok(d.byDay.length >= 1, 'and a line per day, so a bad night is visible without reading rows');
});

test('acting on a breach is recorded against the line, and one new attempt puts it back on the desk', async () => {
  const key = codeKeyOf('AAAA11');
  const db = secDb({ rows: [att({ id: 'a1', code: 'AAAA11' }), att({ id: 'a2', code: 'AAAA11' })] });

  await assert.rejects(() => _FNS.signinReview(db, IT, { key, note: '  ' }), /Andika ulichofanya|what was done/i,
    'SOP D asks what was DONE about it; a tick with no sentence answers nothing');
  await assert.rejects(() => _FNS.signinReview(db, IT, { key: 'not-a-key', note: 'x' }), /Hakuna msimbo|No attempt/i);
  await assert.rejects(() => _FNS.signinReview(db, VIEWER, { key, note: 'x' }), /kuangalia tu|view-only/i,
    'supervision changes nothing, here as everywhere');

  const out = await _FNS.signinReview(db, IT, { key, note: 'Nimebadilisha msimbo wake' });
  assert.equal(out.marked, 2, 'every unhandled attempt on that code is covered by the one decision');

  let d = await _FNS.signinWatch(db, IT, {});
  assert.equal(d.groups[0].reviewed, true);
  assert.equal(d.groups[0].reviewNote, 'Nimebadilisha msimbo wake');
  assert.equal(d.counts.watch, 0, 'a line somebody has dealt with stops shouting');

  await assert.rejects(() => _FNS.signinReview(db, IT, { key, note: 'again' }), /amekwisha shughulikia|already dealt/i,
    'a second press is refused rather than silently re-stamping what is already stamped');

  /* THE POINT OF MARKING PER ATTEMPT RATHER THAN PER CODE. Somebody tries again after the code
     was changed: that is new information, and it must reopen the line rather than hide under
     yesterday's note. */
  await noteSignin(db, { door: 'portal', ok: false, outcome: 'invalid', code: 'AAAA11' });
  d = await _FNS.signinWatch(db, IT, {});
  assert.equal(d.groups[0].tries, 3);
  assert.equal(d.groups[0].reviewed, false, 'a fresh attempt is not covered by an old decision');
});

test('the nav is the permission, and before the migration every pane names the file to run', async () => {
  const db = secDb({ rows: [att({ code: 'AAAA11' })] });
  for (const fn of ['signinWatch', 'signinReview', 'signinSend']) {
    await assert.rejects(() => _FNS[fn](db, OTHER, { key: codeKeyOf('AAAA11'), note: 'x' }),
      /no access to the security pane/i, fn + ' is behind the nav');
  }
  /* ADMIN IS FULL ACCESS EVERYWHERE WE DEVELOP -- the standing rule. */
  const asAdmin = await _FNS.signinWatch(db, OWNER, {});
  assert.equal(asAdmin.ok, true);
  const asViewer = await _FNS.signinWatch(db, VIEWER, {});
  assert.equal(asViewer.ok, true, 'supervision reads everything');

  const bare = fakeDb({ signin_attempts: [], settings: [] },
    { missingColumns: { signin_attempts: ['id', 'reviewed_at'] } });
  const d = await _FNS.signinWatch(bare, IT, {});
  assert.equal(d.notReady, true);
  assert.deepEqual(d.groups, []);
  assert.equal(d.alertFails, 5, 'and the SOP-shaped default still applies while it is unread');
  await assert.rejects(() => _FNS.signinReview(bare, IT, { key: codeKeyOf('A'), note: 'x' }),
    /RUN-ME-2026-09-10-signin-watch\.sql/, 'the write path names the file too, not just the read');
});

test('the window can be sent to whoever watches the door, and says so when nobody is set', async () => {
  const rows = [att({ code: 'AAAA11' }), att({ code: 'AAAA11' }), att({ code: 'AAAA11' }),
    att({ code: 'AAAA11' }), att({ code: 'AAAA11' }), att({ code: 'FFFF66', ok: true, who: 'JUMA G' })];
  const mail = captureMail();
  try {
    const db = secDb({ rows, settings: [{ key: 'SECURITY_EMAIL', value: 'it@hoop.co.tz' }] });
    const out = await _FNS.signinSend(db, IT, {});
    assert.equal(out.sent, true);
    assert.equal(mail.sent.length, 1);
    const body = mail.sent[0].body;
    assert.match(body.subject, /mlango|the door/i);
    assert.ok(body.html.includes('A' + '•'.repeat(5)), 'the masked code travels; the code does not');
    assert.ok(!body.html.includes('AAAA11'), 'an email is the least private thing here');

    const nobody = secDb({ rows });
    await assert.rejects(() => _FNS.signinSend(nobody, IT, {}), /haikutumwa|was not sent/i,
      'silence would look exactly like a report nobody needed to read');
  } finally { mail.restore(); }
});
