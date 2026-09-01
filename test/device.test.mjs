import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { deviceApi, commandFor } from '../api/_lib/device-core.js';
import { _FNS } from '../api/portal.js';

const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'], readOnly: false };
const NOW = Date.parse('2026-08-24T12:00:00Z');

function fleet(rows, settings = []) {
  return fakeDb({ devices: rows, device_events: [], settings });
}

test('the command a phone is given is derived from the office\'s decision, never queued', () => {
  assert.equal(commandFor('locked'), 'lock');
  assert.equal(commandFor('enrolled'), 'unlock', 'on the registry is not the same as locked');
  assert.equal(commandFor('released'), 'unlock');
  // A phone we have written off is exactly the one that must not come back to life.
  assert.equal(commandFor('lost'), 'lock');
  assert.equal(commandFor(''), 'unlock', 'an unknown state never locks a phone by accident');
});

test('a heartbeat records what the phone says and returns what the office decided', async () => {
  const d = fleet([{ imei: 'D1', state: 'locked', state_reason: 'Stock unaccounted',
    enrol_token: 'tok1', reported: null, last_seen: null }],
    [{ key: 'DEVICE_HELP_PHONE', value: '0700000000' }]);

  const r = await deviceApi(d, 'dev_beat',
    [{ token: 'tok1', locked: true, battery: 84, android: '13', appVersion: '1.0.2' }], NOW);

  assert.equal(r.command, 'lock');
  assert.equal(r.reason, 'Stock unaccounted', 'the phone is told WHY, so the lock screen can say it');
  assert.equal(r.helpPhone, '0700000000');
  assert.match(r.message, /HOOP LIMITED/);
  assert.equal(r.imei, 'D1', 'the lock screen shows the REGISTER\'s imei, not the modem\'s');

  const row = d._dump('devices')[0];
  assert.equal(row.reported, 'locked');
  assert.equal(row.battery, 84);
  assert.equal(row.android, '13');
  assert.equal(row.app_version, '1.0.2');
  assert.equal(row.last_seen, new Date(NOW).toISOString());
  assert.equal(row.state, 'locked', 'a handset can never write the office\'s decision');

  // The registry now reads this as a CONFIRMED lock rather than a pending one.
  const list = await _FNS.deviceList(d, ADMIN, {});
  assert.equal(list.rows[0].lockState, 'confirmed');
  assert.equal(list.counts.lockPending, 0);
});

/* ---------------------------------------------------------------------------------------
   THE FOUR LINES ON A LOCKED PHONE. Every word of this screen comes down the wire, and
   these are the cases that decide whether a stranded customer can act on what they read.
   --------------------------------------------------------------------------------------- */
test('the lock screen names the company and the number, both from settings', async () => {
  const d = fleet([{ imei: '351388334583295', state: 'locked', state_reason: 'stock, unsold',
    enrol_token: 'tok1' }], [
      { key: 'DEVICE_LOCK_BRAND', value: 'HOOP LIMITED' },
      { key: 'DEVICE_HELP_PHONE', value: '0700123456' },
    ]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: true }], NOW);

  assert.equal(r.brand, 'HOOP LIMITED');
  assert.equal(r.message, 'Simu hii imefungwa na HOOP LIMITED. Wasiliana nasi kwa namba 0700123456.');
  assert.equal(r.imei, '351388334583295');
  assert.equal(r.reason, 'stock, unsold');
});

test('a rename is one settings row, not a new APK', async () => {
  const d = fleet([{ imei: 'D1', state: 'locked', state_reason: 'r', enrol_token: 'tok1' }], [
    { key: 'DEVICE_LOCK_BRAND', value: 'HOOP TANZANIA' },
    { key: 'DEVICE_HELP_PHONE', value: '0755000111' },
  ]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: true }], NOW);
  assert.equal(r.brand, 'HOOP TANZANIA');
  assert.match(r.message, /HOOP TANZANIA/, '{brand} follows the setting into the sentence');
  assert.doesNotMatch(r.message, /HOOP LIMITED/);
});

test('a custom message may place the brand and the number wherever it likes', async () => {
  const d = fleet([{ imei: 'D1', state: 'locked', state_reason: 'r', enrol_token: 'tok1' }], [
    { key: 'DEVICE_LOCK_BRAND', value: 'HOOP LIMITED' },
    { key: 'DEVICE_HELP_PHONE', value: '0700123456' },
    { key: 'DEVICE_LOCK_MESSAGE', value: 'Piga {namba} — {brand}. / Call {namba}.' },
  ]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: true }], NOW);
  assert.equal(r.message, 'Piga 0700123456 — HOOP LIMITED. / Call 0700123456.');
});

/* A sentence that promises a number and then does not give one is worse than no sentence,
   and an unset DEVICE_HELP_PHONE is the ordinary state of a fresh deployment. */
test('with no number set, the default message stops promising one', async () => {
  const d = fleet([{ imei: 'D1', state: 'locked', state_reason: 'r', enrol_token: 'tok1' }]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: true }], NOW);
  assert.equal(r.helpPhone, null);
  assert.doesNotMatch(r.message, /namba\s*\.?$/, 'no dangling "kwa namba ."');
  assert.match(r.message, /HOOP LIMITED/, 'the company still says who it is');
});

/* THE SELF-LOCK CASE, which is the reason the words go down on every beat rather than only
   alongside a lock order. A phone that locks itself on the offline grace was never told
   anything by anybody; whatever it last stored IS its lock screen. */
test('an unlocked phone is still given the words it will need if it self-locks', async () => {
  const d = fleet([{ imei: 'D1', state: 'enrolled', enrol_token: 'tok1',
    customer: 'Asha', sold_ref: 'S-1' }], [
      { key: 'DEVICE_HELP_PHONE', value: '0700123456' },
      { key: 'DEVICE_LOCK_REASON', value: 'Simu haijaongea na ofisi kwa muda mrefu' },
    ]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: false }], NOW);

  assert.equal(r.command, 'unlock', 'nobody has ordered anything');
  assert.match(r.message, /0700123456/, 'but the words are already on the handset');
  assert.equal(r.reason, 'Simu haijaongea na ofisi kwa muda mrefu',
    'a self-lock has no ordered reason, so settings supplies one');
});

test('an ordered reason always outranks the one in settings', async () => {
  const d = fleet([{ imei: 'D1', state: 'locked', state_reason: 'Wizi — wakala Juma',
    enrol_token: 'tok1' }], [{ key: 'DEVICE_LOCK_REASON', value: 'generic fallback' }]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: true }], NOW);
  assert.equal(r.reason, 'Wizi — wakala Juma');
});

test('history keeps the transition, not the heartbeat', async () => {
  const d = fleet([{ imei: 'D1', state: 'locked', enrol_token: 'tok1', reported: null }]);
  const beat = locked => deviceApi(d, 'dev_beat', [{ imei: 'D1', token: 'tok1', locked }], NOW);

  await beat(false);
  assert.equal(d._dump('device_events').length, 1, 'first word from a phone is a transition');
  await beat(false);
  await beat(false);
  assert.equal(d._dump('device_events').length, 1, 'beating the same status writes no history');

  await beat(true);
  const ev = d._dump('device_events');
  assert.equal(ev.length, 2, 'the moment it actually changed IS kept');
  assert.equal(ev[1].event, 'heartbeat');
  assert.equal(ev[1].from_state, 'unlocked');
  assert.equal(ev[1].to_state, 'locked');
  assert.equal(ev[1].actor, 'device');
});

test('a phone can only ever speak for itself, and cannot talk its way free', async () => {
  const d = fleet([
    { imei: 'D1', state: 'locked', state_reason: 'unpaid', enrol_token: 'tok1' },
    { imei: 'D2', state: 'enrolled', enrol_token: 'tok2' },
  ]);

  // An unknown token and a missing one give the SAME answer -- otherwise this endpoint
  // becomes an oracle for probing which tokens are real.
  await assert.rejects(() => deviceApi(d, 'dev_beat', [{ token: 'nope' }], NOW), /Not enrolled/);
  await assert.rejects(() => deviceApi(d, 'dev_beat', [{ token: '' }], NOW), /required/);
  // A row that never got a token cannot be spoken for at all.
  const bare = fleet([{ imei: 'D9', state: 'locked', enrol_token: null }]);
  await assert.rejects(() => deviceApi(bare, 'dev_beat', [{ token: 'anything' }], NOW), /Not enrolled/);

  // A token answers for its OWN row and no other: tok2 cannot touch D1's state.
  await deviceApi(d, 'dev_beat', [{ token: 'tok2', locked: false }], NOW);
  assert.equal(d._dump('devices').find(x => x.imei === 'D1').reported, undefined,
    'D2\'s token left D1 completely untouched');

  // A phone claiming to be unlocked is still told to lock: state is the office's, not its.
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: false }], NOW);
  assert.equal(r.command, 'lock');
  assert.equal(d._dump('devices').find(x => x.imei === 'D1').state, 'locked');

  // ...and the registry surfaces the disagreement rather than believing either side.
  const list = await _FNS.deviceList(d, ADMIN, {});
  assert.equal(list.rows.find(x => x.imei === 'D1').lockState, 'pending',
    'ordered locked, reporting unlocked -- that is pending, and someone must look at it');
});

test('the handset\'s idea of its own IMEI is recorded, never acted on', async () => {
  // Dual-SIM phones have two IMEIs and getImei() differs by Android version -- so a
  // mismatch is a thing for a person to look at, not grounds to refuse the beat.
  const d = fleet([{ imei: 'D1', state: 'enrolled', enrol_token: 'tok1' }]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: false, imei: 'OTHER' }], NOW);
  assert.equal(r.command, 'unlock', 'the beat is served regardless');
  const row = d._dump('devices')[0];
  assert.equal(row.reported_imei, 'OTHER', 'kept, so somebody can see it');
  assert.equal(row.imei, 'D1', 'the registry\'s own key is never overwritten by the phone');
  assert.equal(d._dump('device_events').filter(e => /imei/i.test(e.event || '')).length, 0,
    'and it raises no event of its own -- that would cry wolf on ordinary hardware');
});

test('stock never self-locks in the dark; a phone with a customer does', async () => {
  // A shelf of boxed handsets is offline for weeks by design. Locking themselves there would
  // be a self-inflicted wound with no upside, so stock is told "never".
  const stock = fleet([{ imei: 'D1', state: 'enrolled', enrol_token: 'tok1' }]);
  const s = await deviceApi(stock, 'dev_beat', [{ token: 'tok1', locked: false }], NOW);
  assert.equal(s.graceHours, -1, 'still stock -- never self-lock');

  // Once it has gone out to somebody, silence has to mean something or airplane mode wins.
  const sold = fleet([{ imei: 'D2', state: 'enrolled', enrol_token: 'tok2', customer: 'Yuda' }]);
  const r = await deviceApi(sold, 'dev_beat', [{ token: 'tok2', locked: false }], NOW);
  assert.equal(r.graceHours, 24 * 7, 'a week by default -- generous, but not forever');

  // ...and the office can change that without shipping a new APK to every handset.
  const tuned = fakeDb({
    devices: [{ imei: 'D3', state: 'enrolled', enrol_token: 'tok3', sold_ref: 'R99' }],
    device_events: [], settings: [{ key: 'DEVICE_OFFLINE_GRACE_HOURS', value: '72' }],
  });
  const t = await deviceApi(tuned, 'dev_beat', [{ token: 'tok3', locked: false }], NOW);
  assert.equal(t.graceHours, 72);
});

test('a released phone is told to stop calling home', async () => {
  const d = fleet([{ imei: 'D1', state: 'released', enrol_token: 'tok1' }]);
  const r = await deviceApi(d, 'dev_beat', [{ imei: 'D1', token: 'tok1', locked: false }], NOW);
  assert.equal(r.command, 'unlock');
  assert.equal(r.retire, true, 'the loan cleared -- this phone is ours no longer');
  assert.equal(r.message, null, 'no lock screen words for a phone that is free');
});

test('a nonsense battery reading is dropped rather than stored', async () => {
  const d = fleet([{ imei: 'D1', state: 'enrolled', enrol_token: 'tok1', battery: 50 }]);
  await deviceApi(d, 'dev_beat', [{ imei: 'D1', token: 'tok1', locked: false, battery: 6000 }], NOW);
  assert.equal(d._dump('devices')[0].battery, 50, 'an impossible reading is a handset bug, not a fact');
  await deviceApi(d, 'dev_beat', [{ imei: 'D1', token: 'tok1', locked: false, battery: 12 }], NOW);
  assert.equal(d._dump('devices')[0].battery, 12);
});

test('dev_hello identifies the handset at provisioning without it reporting status', async () => {
  const d = fleet([{ imei: 'D1', item: 'A07', state: 'enrolled', enrol_token: 'tok1' }]);
  const r = await deviceApi(d, 'dev_hello', [{ imei: 'D1', token: 'tok1' }], NOW);
  assert.equal(r.imei, 'D1');
  assert.equal(r.item, 'A07');
  assert.equal(r.command, 'unlock');
  assert.equal(d._dump('devices')[0].last_seen, new Date(NOW).toISOString());
  assert.equal(d._dump('devices')[0].reported, undefined, 'a handshake is not a status report');
  assert.equal(d._dump('device_events').length, 0);
  await assert.rejects(() => deviceApi(d, 'nonsense', [{}], NOW), /Unknown function/);
});

/* ---------- what a failure is, and what it is not ---------- */

test('a person typing something wrong is a 400, not a server failure', async () => {
  // These were all bare throws, which withApi stamps 500. An officer forgetting a field was
  // being logged and charted as the server falling over -- which is how a deployment reports
  // a 9.5% failure rate while behaving exactly as designed.
  const d = fleet([{ imei: 'D1', state: 'enrolled', enrol_token: 'tok1' }]);
  const status = async fn => { try { await fn(); return 0; } catch (e) { return e.status || 500; } };

  assert.equal(await status(() => _FNS.deviceEnrol(d, ADMIN, { imeis: '' })), 400);
  assert.equal(await status(() => _FNS.deviceSetState(d, ADMIN, { imeis: ['D1'], state: 'locked' })), 400,
    'a lock with no reason is the caller\'s mistake');
  assert.equal(await status(() => _FNS.deviceToken(d, ADMIN, { imei: '' })), 400);
  assert.equal(await status(() => _FNS.deviceToken(d, ADMIN, { imei: 'GHOST' })), 400);

  // A view-only code being refused is still 403 -- nothing about that changed.
  const VIEWER = { code: 'V', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: [], readOnly: true };
  assert.equal(await status(() => _FNS.deviceEnrol(d, VIEWER, { imeis: 'D1' })), 403);
});

test('the Devices pane reads as empty before the migration, instead of throwing a 500', async () => {
  // This was DOCUMENTED as degrading to "no devices yet" and did not: PostgREST answers a
  // missing table with a relation-not-found, which became a 500 for anybody who opened the
  // pane before the SQL had been run. Every one of those was a logged server failure.
  const d = {
    from() {
      return { select() { return this; }, eq() { return this; }, order() { return this; },
        limit() { return this; }, range() { return this; },
        then(res) { return Promise.resolve({ data: null,
          error: { code: '42P01', message: 'relation "public.devices" does not exist' } }).then(res); } };
    },
    _dump: () => [],
  };
  const r = await _FNS.deviceList(d, ADMIN, {});
  assert.equal(r.ok, true, 'it answers rather than throwing');
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
  // Empty and not-there-yet are still different facts, so the screen can say which it is.
  assert.equal(r.notReady, true);
});

/* ---------- the token: minted once, never shown on a list ---------- */

test('enrolment mints one token per phone and hands it back only to the station', async () => {
  const d = fakeDb({ hoop_aged_stock: [], devices: [], device_events: [] });
  const r = await _FNS.deviceEnrol(d, ADMIN, { imeis: 'D1, D2' });
  assert.equal(r.provision.length, 2);
  const toks = r.provision.map(p => p.token);
  assert.ok(toks.every(t => t && t.length >= 24), 'a guessable token is not a credential');
  assert.notEqual(toks[0], toks[1], 'one token opens exactly one phone');

  // The minted token is the one the handset must present.
  const tok = r.provision.find(p => p.imei === 'D1').token;
  const beat = await deviceApi(d, 'dev_beat', [{ token: tok, locked: false }], NOW);
  assert.equal(beat.command, 'unlock');

  // It must NOT come back on the screen most likely to be open across a counter.
  const hist = await _FNS.deviceHistory(d, ADMIN, { imei: 'D1' });
  assert.equal(hist.device.enrol_token, undefined, 'the credential is not history');
  assert.equal(hist.device.imei, 'D1', '...but the rest of the row still is');

  // Re-provisioning a wiped phone reads it back deliberately, through an audited door.
  const back = await _FNS.deviceToken(d, ADMIN, { imei: 'D1' });
  assert.equal(back.token, tok);
  await assert.rejects(() => _FNS.deviceToken(d, ADMIN, { imei: 'GHOST' }), /not on the registry/);
});

test('enrolment still works against a registry created before the phone half existed', async () => {
  // PostgREST refuses the whole insert for one unknown column; enrol must not die of it.
  const d = fakeDb({ hoop_aged_stock: [], devices: [], device_events: [] },
    { missingColumns: { devices: ['enrol_token'] } });
  const r = await _FNS.deviceEnrol(d, ADMIN, { imeis: 'D1' });
  assert.equal(r.enrolled, 1, 'the phone is on the registry');
  assert.deepEqual(r.provision, [], 'and the station is told plainly that it has no token to write');
});

/* =========================================================================================
   FUTA -- taking a phone off the register entirely.
     "i need delete button after token and historia for now b/se i want to start afresh"

   An eraser for a row that should not have existed: a wrong IMEI, a test handset, a batch
   enrolled twice. Deliberately not the same thing as Achia, which is a decision about a
   customer's loan and is meant to leave a trail.
   ========================================================================================= */
test('deviceDelete removes the row and its history', async () => {
  const d = fakeDb({
    devices: [{ imei: 'D1', state: 'enrolled', enrol_token: 'tok1' },
              { imei: 'D2', state: 'enrolled', enrol_token: 'tok2' }],
    device_events: [{ imei: 'D1', event: 'lock' }, { imei: 'D2', event: 'lock' }],
    settings: [],
  });
  const r = await _FNS.deviceDelete(d, ADMIN, { imei: 'D1' });
  assert.equal(r.ok, true);
  assert.deepEqual(d._dump('devices').map(x => x.imei), ['D2'], 'only that phone goes');
  assert.deepEqual(d._dump('device_events').map(x => x.imei), ['D2'],
    'its history goes with it -- an event row whose device is gone is unreadable');
});

/* THE ONE IT MUST REFUSE. Deleting a locked phone's row strands the handset: locked for
   good, with nothing left on the register to unlock it from. */
test('deviceDelete refuses a locked phone rather than stranding it', async () => {
  const d = fakeDb({
    devices: [{ imei: 'D1', state: 'locked', reported: 'locked', enrol_token: 'tok1' }],
    device_events: [], settings: [],
  });
  await assert.rejects(() => _FNS.deviceDelete(d, ADMIN, { imei: 'D1' }), /imefungwa|locked/i);
  assert.equal(d._dump('devices').length, 1, 'and the row is still there');

  // Reported locked is enough on its own: the office may have unlocked it a second ago and
  // the handset may not have heard yet, which is exactly when this would strand it.
  const e = fakeDb({
    devices: [{ imei: 'D2', state: 'enrolled', reported: 'locked', enrol_token: 'tok2' }],
    device_events: [], settings: [],
  });
  await assert.rejects(() => _FNS.deviceDelete(e, ADMIN, { imei: 'D2' }), /imefungwa|locked/i);
});

/* THE BUG THIS GUARD EXISTS FOR, found on the first day the button shipped:

     "I used futa and removed all.. phone is on wifi still can't restore"

   Deleting the row of a phone that is still provisioned leaves it hardened with no office.
   Lock, unlock and release all travel through a row that no longer exists, and the handset
   refuses the factory reset that would fix it. One click, one brick. */
test('deviceDelete refuses to orphan a handset that is still under management', async () => {
  const live = fakeDb({
    devices: [{ imei: 'D1', state: 'enrolled', reported: 'unlocked',
      last_seen: '2026-08-27T09:00:00Z', enrol_token: 'tok1' }],
    device_events: [], settings: [],
  });
  await assert.rejects(() => _FNS.deviceDelete(live, ADMIN, { imei: 'D1' }), /Achia|release/i);
  assert.equal(live._dump('devices').length, 1);

  // RELEASED is the door, because that is the state that tells the handset to hand itself
  // back. Not yet heard is fine -- the order stands and the phone applies it when it can.
  const freed = fakeDb({
    devices: [{ imei: 'D2', state: 'released', reported: 'unlocked',
      last_seen: '2026-08-27T09:00:00Z', enrol_token: 'tok2' }],
    device_events: [], settings: [],
  });
  assert.equal((await _FNS.deviceDelete(freed, ADMIN, { imei: 'D2' })).ok, true);
  assert.equal(freed._dump('devices').length, 0);

  // A phone that never once spoke has nothing on it to strand: provisioning did not take,
  // so the row is the only thing that exists and deleting it is exactly right.
  const ghost = fakeDb({
    devices: [{ imei: 'D3', state: 'enrolled', enrol_token: 'tok3' }],
    device_events: [], settings: [],
  });
  assert.equal((await _FNS.deviceDelete(ghost, ADMIN, { imei: 'D3' })).ok, true);
  assert.equal(ghost._dump('devices').length, 0);
});

test('deviceDelete is audited and needs write access', async () => {
  const d = fakeDb({ devices: [{ imei: 'D1', state: 'enrolled' }], device_events: [], settings: [] });
  /* A read-only code is decided by its ROLE, not by a readOnly flag on the object --
     see isReadOnly in auth.js. Spreading ADMIN and setting readOnly:true looks like a
     view-only user and is not one, which is the wrong way for a permission test to pass. */
  const VIEWER = { code: 'V', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['devices'] };
  await assert.rejects(() => _FNS.deviceDelete(d, VIEWER, { imei: 'D1' }));
  assert.equal(d._dump('devices').length, 1, 'a view-only code cannot erase a phone');
  // Once it runs, the audit entry is the only record that phone was ever on the register.
  const { AUDITED } = await import('../api/_lib/audit.js');
  assert.ok(AUDITED.has('deviceDelete'), 'an eraser that leaves no trace at all is not acceptable');
});


/* =========================================================================================
   THE SEARCH BOX MUST FIND A HANDSET BY ITS IMEI.

     "search should also find imei from devices too"

   The register was the one place an IMEI lives that the search could not reach -- so the
   single question the box exists for, "what is going on with this handset", was the one it
   could not answer. It matters most for NEW stock: a phone joins the register the moment it
   is enrolled, which is often before it appears on any stock report and long before it has a
   customer, so for those handsets this is the only leg that finds them at all.
   ========================================================================================= */
test('globalSearch finds a phone by IMEI, and never hands back its token', async () => {
  const d = fakeDb({
    devices: [{ imei: '351388334583295', item: 'A07', holder: 'Sipho', state: 'locked',
      state_reason: 'stock, unsold', reported: 'unlocked', enrol_token: 'SECRET-TOKEN',
      last_seen: new Date(NOW - 3600000).toISOString() }],
    device_events: [], settings: [], watu_loans: [], hoop_agents: [], hoop_aged_stock: [],
  });
  const r = await _FNS.globalSearch(d, ADMIN, { q: '351388334583295' });
  assert.equal(r.ok, true);
  assert.equal((r.devices || []).length, 1, 'an enrolled handset must be findable by its IMEI');

  const hit = r.devices[0];
  assert.equal(hit.imei, '351388334583295');
  // Ordered is not confirmed, and the result has to say which -- the same distinction the
  // Devices tab draws with "imeagizwa · bado".
  assert.equal(hit.lockState, 'pending', 'state locked + reported unlocked is ORDERED, not confirmed');
  assert.equal(hit.item, 'A07');

  /* THE TOKEN IS A CREDENTIAL AND THIS IS A SEARCH RESULT -- the screen most likely to be
     open with a stranger at the counter. deviceHistory names its columns rather than using
     `*` for exactly this reason, and this leg has to hold the same line. */
  assert.ok(!JSON.stringify(r).includes('SECRET-TOKEN'),
    'globalSearch leaked enrol_token into its results');
});

test('a partial IMEI still finds the phone, and a missing devices table does not 500 the search', async () => {
  const d = fakeDb({
    devices: [{ imei: '351388334583295', item: 'A07', state: 'enrolled', enrol_token: 't' }],
    device_events: [], settings: [], watu_loans: [], hoop_agents: [], hoop_aged_stock: [],
  });
  // Nobody types fifteen digits off a report without fumbling one; a tail has to work.
  const part = await _FNS.globalSearch(d, ADMIN, { q: '583295' });
  assert.equal((part.devices || []).length, 1, 'a partial IMEI must still find the handset');

  /* A deployment that has not run the devices migration must still get customers, office and
     stock. One missing leg breaking all four is how a search stops being trusted. */
  const noTable = fakeDb({ watu_loans: [], hoop_agents: [], hoop_aged_stock: [] });
  const r = await _FNS.globalSearch(noTable, ADMIN, { q: '351388334583295' });
  assert.equal(r.ok, true, 'a missing devices table must not take the whole search down');
  assert.deepEqual(r.devices, []);
});

/* =========================================================================================
   HOW LONG UNTIL THE PHONE COMES BACK -- decided by the server, because only it knows
   whether an order is still outstanding.

     "funga and fungua and release should not take even a minute they should all be
      immediate effect whenever online and phone pings"

   A fixed quarter-hour beat is right for a fleet at rest and far too slow the moment somebody
   presses a button. But polling every half-minute all day spends a CUSTOMER's data bundle to
   say "still locked, still locked" -- and they pay that airtime, not HOOP. So the fast pace
   applies only while the register and the handset disagree, which is a window seconds long.

   Both halves are load-bearing, and a later reader tidying this into one constant would drop
   whichever half they did not have in mind -- so both are asserted.
   ========================================================================================= */
test('a phone with an order outstanding is told to come back in seconds, not a quarter hour', async () => {
  // Ordered to lock, and the handset still says unlocked: the office is waiting.
  const d = fleet([{ imei: 'D1', state: 'locked', reported: 'unlocked', enrol_token: 'tok1' }]);
  const pending = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: false }], NOW);
  assert.equal(pending.command, 'lock');
  assert.ok(pending.nextBeatSeconds > 0 && pending.nextBeatSeconds <= 60,
    'an outstanding order must bring the phone back within a minute, not fifteen');

  // And once it has done as it was told, straight back to the cheap pace.
  const done = await deviceApi(d, 'dev_beat', [{ token: 'tok1', locked: true }], NOW);
  /* The RELATIONSHIP, not the number. The ordinary pace is a business judgement about data
     cost that is meant to be changed on the server without a release -- it has already gone
     from fifteen minutes to one -- so pinning the literal here would break this test every
     time somebody exercises that freedom, and teach them to edit the test rather than think.
     What must never change is that a settled phone is CHEAPER than a waiting one. */
  assert.ok(done.nextBeatSeconds > pending.nextBeatSeconds,
    'a settled phone must beat less often than one with an order outstanding -- polling fast '
    + "forever spends the customer's own data bundle to repeat what the register already knows");
});

test('an unlock order is just as urgent as a lock, and a released phone is not hurried', async () => {
  // The customer paid; nobody should stare at a lock screen for fifteen minutes.
  const un = fleet([{ imei: 'D2', state: 'enrolled', reported: 'locked', enrol_token: 'tok2' }]);
  const r = await deviceApi(un, 'dev_beat', [{ token: 'tok2', locked: true }], NOW);
  assert.equal(r.command, 'unlock');
  assert.ok(r.nextBeatSeconds <= 60, 'an unlock the phone has not applied yet is outstanding too');

  /* A retiring phone is on its way out and hurrying it changes nothing -- and if the
     step-down keeps being refused, a fast pace would have it beating every few seconds for
     ever. */
  const rel = fleet([{ imei: 'D3', state: 'released', reported: 'locked', enrol_token: 'tok3' }]);
  const q = await deviceApi(rel, 'dev_beat', [{ token: 'tok3', locked: true }], NOW);
  assert.equal(q.retire, true);
  assert.ok(q.nextBeatSeconds > r.nextBeatSeconds,
    'a retiring phone is never put on the fast pace -- a step-down the platform keeps refusing '
    + 'would then beat every few seconds for ever');
});

/* =========================================================================================
   THE DOORBELL, AND WHY IT CARRIES NO KEY.

     "build the FCM push"
     "wont taking this to google bring bans?"

   Push is the only way an order given in the office reaches a handset in Dar in about a
   second: polling cannot beat its own interval, and Doze pushes an idle phone past even the
   sixty seconds we ask for. But it puts a third party -- Google -- on the path of a message
   about somebody's phone, so the shape of that message is the whole security question.

   IT SAYS "BEAT" AND NOTHING ELSE. The handset then asks /api/device the same question it
   always asks, with its own enrolment token, and gets the same answer it always gets. So the
   most a forged or replayed push can do is cause one extra heartbeat -- it cannot lock a
   phone, unlock one, or free one, because none of those decisions travels in it.

   These tests hold that line from the server side. The Android half is held by Push.java's
   own header and by the fact that it never reads the payload.
   ========================================================================================= */
test('the wake-up carries no command -- only an instruction to ask', async () => {
  const src = fs.readFileSync(new URL('../api/_lib/push.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function wake'));

  // Data-only, and the ONLY datum is "beat". A payload naming a state would be a command
  // travelling outside the authenticated channel -- exactly what must never happen.
  assert.match(body, /data:\s*\{\s*beat:\s*'1'\s*\}/,
    'the push payload must carry nothing but "beat"');
  for (const forbidden of ['lock', 'unlock', 'release', 'state', 'imei', 'command']) {
    assert.ok(!new RegExp('data:[^}]*\\b' + forbidden + '\\b').test(body),
      'the push payload must never carry ' + forbidden + ': a message Google relays is not '
      + 'an authenticated channel, and a command in it would be one anybody could forge');
  }

  /* And it must never draw anything on the customer's screen. A notification payload would
     be wrong twice: there is nothing for them to read, and on a locked handset the shade is
     not reachable anyway. */
  assert.ok(!/notification\s*:/.test(body), 'data-only, never a notification');
});

test('push is optional everywhere, and never fails an operator action', async () => {
  const src = fs.readFileSync(new URL('../api/_lib/push.js', import.meta.url), 'utf8');

  /* WITH NO CREDENTIALS THE FLEET BEHAVES EXACTLY AS BEFORE. Push is a shortcut on top of a
     timer that already works; a deployment without Firebase must lose the second, not the
     lock. */
  const saved = { ...process.env };
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;
  const { nudge, pushConfigured, wake } = await import('../api/_lib/push.js?nocreds');
  assert.equal(pushConfigured(), false, 'no credentials must read as "push is off"');
  assert.deepEqual(await wake(['whatever'], 1), { sent: 0, failed: 0, stale: [] },
    'wake must return quietly rather than throwing when push is not configured');

  // And a broken database must not take Funga down with it: the lock is already recorded.
  const exploding = { from() { throw new Error('database is on fire'); } };
  assert.deepEqual(await nudge(exploding, ['351388334583295'], 1), { sent: 0, failed: 0, stale: [] },
    'nudge must swallow everything -- it runs inside an operator pressing Funga, and a lock '
    + 'is not less ordered because a doorbell failed');
  Object.assign(process.env, saved);

  // The swallow is deliberate and local to this file; it must be visible as such.
  assert.match(src, /catch \(e\) \{\s*return \{ sent: 0, failed: 0, stale: \[\] \};/,
    'nudge stopped swallowing its failures, which is the one place in this system that must');
});

test('a beat carries the handset push address, and the register keeps only the newest', async () => {
  const d = fleet([{ imei: 'D9', state: 'enrolled', enrol_token: 'tok9', fcm_token: 'OLD' }]);
  await deviceApi(d, 'dev_beat', [{ token: 'tok9', locked: false, fcmToken: 'NEW' }], NOW);
  const after = (await _FNS.deviceHistory(d, ADMIN, { imei: 'D9' }));
  assert.equal(after.ok, true);
  /* Firebase rotates a registration token whenever it likes and a stale one fails silently,
     so the handset re-reports its address on every beat. What must NOT happen is a write per
     beat: two hundred phones every minute is two hundred needless writes a minute. */
  const core = fs.readFileSync(new URL('../api/_lib/device-core.js', import.meta.url), 'utf8');
  assert.match(core, /S\(p\.fcmToken\) !== S\(dev\.fcm_token\)/,
    'the push address must be written only when it has actually changed');

  /* AND A DEPLOYMENT THAT HAS NOT RUN THE MIGRATION MUST STILL BEAT. PostgREST refuses the
     whole select for one unknown column, so naming fcm_token without the fallback would take
     every handset dark at the moment somebody deploys. */
  assert.match(core, /BEAT_COLS_LEGACY/, 'the pre-migration column list was removed');
  assert.match(core, /reported_imei\|fcm_token/,
    'the update must tolerate a missing fcm_token column, as it already does reported_imei');
});

/* =========================================================================================
   FUNGA ON A PHONE ALREADY RELEASED.

     "funga for already achia should refuse and say you cant funga achia, proceed anyway if
      you will install app"

   Achia tells a handset to unlock, drop its restrictions, step down as Device Owner and STOP
   CALLING HOME. A phone that did all four has no reason to ask us anything ever again, so a
   lock ordered against that row is a decision nobody will collect: the register reads
   "imeagizwa · bado" for ever and the office waits on a phone that stopped listening days
   ago.

   BUT A BLANKET REFUSAL WOULD BE WRONG, and wrong in the case that matters most. Where the
   step-down was REFUSED -- Knox, a vendor build -- the handset keeps beating precisely so the
   office can still reach it. Refusing those would send somebody driving to a phone they could
   have locked from their desk.

   The register can separate them with no help from anybody: has this handset spoken SINCE it
   was released? Both halves are asserted, because a later reader tidying this into "refuse if
   released" would delete the half that keeps the reachable ones reachable.
   ========================================================================================= */
test('locking a released phone that went quiet is refused, and says which ones', async () => {
  const freed = new Date(NOW - 3 * 3600000).toISOString();
  const d = fleet([{ imei: 'GONE1', state: 'released', enrol_token: 't1',
    released_at: freed, last_seen: new Date(NOW - 5 * 3600000).toISOString() }]);

  await assert.rejects(
    () => _FNS.deviceSetState(d, ADMIN, { imeis: ['GONE1'], state: 'locked', reason: 'x' }),
    err => {
      assert.match(String(err.message), /haisikii|not listening/i,
        'the refusal must say WHY, not just refuse');
      assert.equal(err.code, 'RELEASED_NOT_LISTENING');
      /* It must name the rows. Without them the client can only offer "retry everything",
         which on a bulk action is a second lock order for the phones that already worked. */
      assert.deepEqual(err.imeis, ['GONE1']);
      return true;
    });

  // And the override goes through, because re-provisioning by cable is a real reason to
  // leave an order standing for a phone that is not listening yet.
  const forced = await _FNS.deviceSetState(d, ADMIN,
    { imeis: ['GONE1'], state: 'locked', reason: 'x', force: true });
  assert.equal(forced.changed, 1, 'force must be able to leave the order waiting');
});

test('a released phone still beating is NOT refused -- it is the one you can reach', async () => {
  /* The step-down was refused, so the handset kept calling home on purpose. This is the case
     the whole refusal must not catch: locking it from the office works, and sending somebody
     to it with a cable would be a wasted trip. */
  const freed = new Date(NOW - 3 * 3600000).toISOString();
  const d = fleet([{ imei: 'ALIVE1', state: 'released', enrol_token: 't2',
    released_at: freed, last_seen: new Date(NOW - 60000).toISOString() }]);
  const r = await _FNS.deviceSetState(d, ADMIN, { imeis: ['ALIVE1'], state: 'locked', reason: 'x' });
  assert.equal(r.changed, 1, 'a released phone that has spoken SINCE the release is listening');
});

test('the refusal is only about locking, and only about released phones', async () => {
  const freed = new Date(NOW - 3 * 3600000).toISOString();
  const quiet = { state: 'released', enrol_token: 't3', released_at: freed,
    last_seen: new Date(NOW - 9 * 3600000).toISOString() };

  // Unlocking or re-releasing a silent phone is harmless: neither leaves anybody waiting on
  // a lock that will not arrive, and refusing them would only be in the way.
  const a = fleet([{ imei: 'Q1', ...quiet }]);
  assert.equal((await _FNS.deviceSetState(a, ADMIN, { imeis: ['Q1'], state: 'enrolled' })).changed, 1);

  // And an ordinary enrolled phone that has never spoken is not affected -- it has not been
  // released, so nothing has told it to stop listening.
  const b = fleet([{ imei: 'NEW1', state: 'enrolled', enrol_token: 't4' }]);
  assert.equal((await _FNS.deviceSetState(b, ADMIN,
    { imeis: ['NEW1'], state: 'locked', reason: 'stock' })).changed, 1,
    'a never-seen STOCK phone must still be lockable -- that is the normal bench flow');
});

/* =========================================================================================
   ONE COMMAND, EVERY PHONE ON THE HUB.

     "and thats my intention of pasting multiple imei and copyng signle cmd to run and get
      many phones registered at once"

   The command carries a BATCH -- the same string for every handset, which is what makes it
   safe to broadcast to all of them at once -- and each phone sends back the IMEI it reads off
   itself to collect the token minted for IT. Plug-in order stops meaning anything.

   The property that makes this safe rather than merely convenient is that it FAILS CLOSED:
   every way of getting it wrong ends in no token, never in the wrong one. A handset that is
   absent from the register is a problem somebody can see; a handset quietly carrying its
   neighbour's identity is one nobody can, and the way back is a factory reset.
   ========================================================================================= */
const BATCH = '11112222-3333-4444-5555-666677778888';
const batchFleet = (over = {}) => fleet([
  { imei: '111111111111111', enrol_token: 'tok-one', state: 'enrolled',
    enrol_batch: BATCH, enrol_batch_at: '2026-08-24T11:50:00Z', ...over },
  { imei: '222222222222222', enrol_token: 'tok-two', state: 'enrolled',
    enrol_batch: BATCH, enrol_batch_at: '2026-08-24T11:50:00Z' },
  { imei: '999999999999999', enrol_token: 'tok-other', state: 'enrolled',
    enrol_batch: 'a-different-batch', enrol_batch_at: '2026-08-24T11:50:00Z' },
]);

test('a phone in the batch claims its OWN token, whatever order it was plugged in', async () => {
  const d = batchFleet();
  assert.deepEqual(
    await deviceApi(d, 'dev_claim', [{ batch: BATCH, imeis: ['111111111111111'] }], NOW),
    { ok: true, token: 'tok-one' });
  // The other phone gets the other token. Same command, same batch, different answer.
  assert.deepEqual(
    await deviceApi(d, 'dev_claim', [{ batch: BATCH, imeis: ['222222222222222'] }], NOW),
    { ok: true, token: 'tok-two' });

  /* A DUAL-SIM HANDSET OFFERS BOTH, because which IMEI the stock report wrote down is a coin
     toss -- Imei.java has said so since the beginning. Either one matching is a match. */
  assert.deepEqual(
    await deviceApi(d, 'dev_claim',
      [{ batch: BATCH, imeis: ['888888888888888', '222222222222222'] }], NOW),
    { ok: true, token: 'tok-two' });

  // Claiming twice is the same answer: a retry after a dropped reply must not be a failure.
  assert.deepEqual(
    await deviceApi(d, 'dev_claim', [{ batch: BATCH, imeis: ['111111111111111'] }], NOW),
    { ok: true, token: 'tok-one' });
});

test('every way of getting a claim wrong ends in no token, never the wrong one', async () => {
  const d = batchFleet();
  const refused = async (args, why) => {
    await assert.rejects(() => deviceApi(d, 'dev_claim', [args], NOW),
      e => e.status === 403 || e.status === 400, why);
  };
  await refused({ batch: BATCH, imeis: ['777777777777777'] },
    'an IMEI that is not in this batch gets nothing -- not the nearest row, not the first row');
  await refused({ batch: BATCH, imeis: ['999999999999999'] },
    'a phone from ANOTHER batch is not in this one');
  await refused({ batch: BATCH, imeis: [] }, 'a handset that could not read its IMEI');
  await refused({ batch: BATCH }, 'no IMEI field at all');
  await refused({ batch: 'not-a-batch-anybody-issued', imeis: ['111111111111111'] },
    'a guessed batch');
  await refused({ imeis: ['111111111111111'] }, 'no batch');

  /* THE BATCH IS A BEARER SECRET FOR THE LENGTH OF A BENCH SESSION. Whoever holds it plus an
     IMEI in it can obtain that device's token -- exactly the power the bench needs, and
     exactly the power nobody should still hold next week. */
  const later = NOW + 25 * 60 * 60 * 1000;
  await assert.rejects(
    () => deviceApi(d, 'dev_claim', [{ batch: BATCH, imeis: ['111111111111111'] }], later),
    e => e.status === 403, 'a batch older than a day is refused');

  // A row carrying no token cannot hand one out.
  const noTok = fleet([{ imei: '111111111111111', enrol_token: null, state: 'enrolled',
    enrol_batch: BATCH, enrol_batch_at: '2026-08-24T11:50:00Z' }]);
  await assert.rejects(
    () => deviceApi(noTok, 'dev_claim', [{ batch: BATCH, imeis: ['111111111111111'] }], NOW),
    e => e.status === 403);
});

test('the claim never becomes an oracle for what the office is holding', async () => {
  /* Every refusal is the same refusal. Distinguishing "not in this batch" from "no such batch"
     from "expired" would let anybody with the endpoint ask which IMEIs the office has. */
  const d = batchFleet();
  const msgs = [];
  for (const args of [
    { batch: BATCH, imeis: ['777777777777777'] },
    { batch: 'nobody-issued-this', imeis: ['111111111111111'] },
    { batch: BATCH, imeis: ['999999999999999'] },
  ]) {
    try { await deviceApi(d, 'dev_claim', [args], NOW); assert.fail('should refuse'); }
    catch (e) { msgs.push(e.message + '|' + e.status); }
  }
  assert.equal(new Set(msgs).size, 1, 'every refusal must read identically: ' + msgs.join(' / '));
});

test('the handsets\' door answers to its own functions and nothing inherited', async () => {
  /* Same hole as the portal dispatcher had, and it matters more here: this is the one door
     that is not behind an access code at all. */
  const d = batchFleet();
  for (const probe of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    await assert.rejects(() => deviceApi(d, probe, [{}], NOW),
      e => e.status === 400 && /Unknown function/.test(e.message),
      probe + ' is inherited and must not resolve to a handler');
  }
});

test('enrolling puts every phone in the call into one claimable batch', async () => {
  /* A handset the register already knew keeps its own token -- deliberately -- so its row is
     not re-inserted. Without an explicit update it would still carry a batch from some earlier
     session, and the hub command would refuse it: on the bench that reads as a broken phone
     rather than as one that was never in the batch. */
  const d = fleet([
    { imei: '111111111111111', enrol_token: 'kept', state: 'enrolled',
      enrol_batch: 'last-week', enrol_batch_at: '2026-08-01T09:00:00Z' },
  ]);
  const r = await _FNS.deviceEnrol(d, ADMIN, { imeis: '111111111111111 222222222222222' });
  assert.ok(r.batch, 'the enrol hands back the batch the command will carry');
  assert.equal(r.batchReady, true);

  const rows = d._dump('devices');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(String(row.enrol_batch), String(r.batch),
      'every phone in the call joins this batch, new or already known');
    assert.ok(row.enrol_batch_at, 'and is stamped with when, so the batch can expire');
  }
  assert.equal(rows.find(x => x.imei === '111111111111111').enrol_token, 'kept',
    'a known handset keeps the token it already holds');

  // And the phones can now claim against it.
  const got = await deviceApi(d, 'dev_claim',
    [{ batch: r.batch, imeis: ['111111111111111'] }], Date.now());
  assert.equal(got.token, 'kept');
});

/* =========================================================================================
   THE SECOND SWEEP OF THE DEVICES PANE, ahead of the presentation.

     "please re-inspect all the devices pane functions are good and effecient: am going to
      presentation and more shocks like the directors meeting is unbearable"

   None of what follows is a crash. Every one of them is the pane stating something with
   confidence that is not true -- a clock three hours out, a table quietly shorter than the
   tiles above it, a count beside an irreversible button that stopped being the number of
   phones it is about to act on. In a room, those are worse than an error, because an error
   is at least visibly an error.
   ========================================================================================= */

test('history times go out as numbers, on the same clock as the row above them', async () => {
  /* device_events.at is a timestamptz and PostgREST hands it back as UTC text. The panel used
     to print that text, while the register row directly above it renders last_seen through
     clock(), which is fed milliseconds and is therefore local. Dar es Salaam is UTC+3, so the
     one panel you open to prove WHEN a lock was ordered disagreed with the row above it by
     three hours -- on the same screen, at the same moment. */
  const d = fleet([{ imei: 'D1', state: 'enrolled', enrol_token: 't' }]);
  d._dump('device_events').push({
    id: 'e1', imei: 'D1', event: 'enrolled', from_state: null, to_state: 'enrolled',
    reason: 'x', actor: 'Peter', at: '2026-08-24T09:30:00Z' });

  const hist = await _FNS.deviceHistory(d, ADMIN, { imei: 'D1' });
  const ev = hist.events[0];
  assert.equal(typeof ev.atMs, 'number', 'the panel is fed a number it cannot misread');
  assert.equal(ev.atMs, Date.parse('2026-08-24T09:30:00Z'));
  assert.equal(ev.at, '2026-08-24T09:30:00Z',
    'and the original text stays on the row -- removing a field to fix a rendering bug breaks '
    + 'callers to save nothing');
});

test('a truncated history says how much of it you are looking at', async () => {
  /* .limit(100) never worked here: fetchAll pages with .range(), which overwrites the Range
     header limit() had set. So the cap was imaginary AND unstated. It is now applied where it
     actually applies, and the count of what was left out goes with it. */
  const d = fleet([{ imei: 'D1', state: 'enrolled', enrol_token: 't' }]);
  const evs = d._dump('device_events');
  for (let i = 0; i < 130; i++) {
    evs.push({ id: 'e' + i, imei: 'D1', event: 'lock', at: '2026-08-24T09:00:00Z' });
  }
  const hist = await _FNS.deviceHistory(d, ADMIN, { imei: 'D1' });
  assert.equal(hist.events.length, 100, 'the newest hundred');
  assert.equal(hist.total, 130, 'and the pane is told there were more, so it can say so');
});

test('reading the register does not ask for a column the table does not have', () => {
  /* devices is keyed by IMEI and has NO id column. pageKeyFor defaults to `id` for any table
     not named in PAGE_KEY, so every read of the register asked PostgREST to order by a column
     that does not exist -- a certain 400, absorbed by fetchAll's fallback and then re-issued
     unordered. Nothing broke, which is why it survived: it only ever cost a wasted round trip
     per read, on the busiest pane in the system and on every heartbeat that looks a phone up. */
  const sql = fs.readFileSync(
    new URL('../db/migrations/RUN-ME-2026-08-24-devices.sql', import.meta.url), 'utf8');
  const table = sql.slice(sql.indexOf('create table if not exists devices'));
  const body = table.slice(0, table.indexOf(');'));
  assert.ok(/imei\s+text primary key/.test(body), 'the key is the IMEI');
  assert.ok(!/^\s*id\s/m.test(body), 'and there is no id column for the default to have found');

  const supa = fs.readFileSync(new URL('../api/_lib/supabase.js', import.meta.url), 'utf8');
  const map = supa.slice(supa.indexOf('const PAGE_KEY'), supa.indexOf('/** The table a built'));
  assert.match(map, /devices:\s*'imei'/,
    'so the real key is named, and the first attempt is the only attempt');
});

test('one unreachable phone does not cancel the lock on the nineteen beside it', async () => {
  /* THE WORST BUG THIS PANE HAD, and it hid behind a refusal that looks careful.

     The released-and-silent check threw BEFORE touching anything, so one such handset among
     twenty ticked ones refused the whole order and locked NONE of them. The client then did
     the right thing with the wrong facts: it offered its confirmation and retried only the
     phone the server had named. The other nineteen were never locked at all, and the toast
     that followed read "Zimebadilishwa: 1" -- which an operator reads as the job being done.

     Twenty customers' phones left open while the office believes they are shut. Three
     separate comments -- on the client, on the server, and on the test above -- already
     described the intended behaviour in the words "they were locked the first time". */
  const freed = new Date(NOW - 3 * 3600000).toISOString();
  const rows = [{ imei: 'GONE1', state: 'released', enrol_token: 't0',
    released_at: freed, last_seen: new Date(NOW - 5 * 3600000).toISOString() }];
  for (let i = 1; i <= 19; i++) {
    rows.push({ imei: 'OK' + i, state: 'enrolled', enrol_token: 't' + i,
      last_seen: new Date(NOW).toISOString() });
  }
  const d = fleet(rows);

  await assert.rejects(
    () => _FNS.deviceSetState(d, ADMIN,
      { imeis: rows.map(r => r.imei), state: 'locked', reason: 'stock' }),
    err => {
      assert.equal(err.code, 'RELEASED_NOT_LISTENING');
      assert.deepEqual(err.imeis, ['GONE1'], 'the question is about the phone it cannot reach');
      assert.equal(err.changed, 19,
        'and it carries what the click already did, so the dialog cannot imply nothing happened');
      return true;
    });

  const after = d._dump('devices');
  assert.equal(after.filter(r => r.state === 'locked').length, 19,
    'every reachable phone is locked BEFORE the question about the one that is not');
  assert.equal(after.find(r => r.imei === 'GONE1').state, 'released',
    'and the one it asked about is untouched until the operator answers');
});

test('every unreachable phone is named, not the first twenty', async () => {
  /* The client retries exactly the list it is handed, so a truncated one is a set of phones
     the override silently leaves unlocked -- after the operator has said yes to locking them. */
  const freed = new Date(NOW - 3 * 3600000).toISOString();
  const rows = [];
  for (let i = 1; i <= 25; i++) {
    rows.push({ imei: 'GONE' + i, state: 'released', enrol_token: 't' + i,
      released_at: freed, last_seen: new Date(NOW - 5 * 3600000).toISOString() });
  }
  const d = fleet(rows);
  await assert.rejects(
    () => _FNS.deviceSetState(d, ADMIN,
      { imeis: rows.map(r => r.imei), state: 'locked', reason: 'x' }),
    err => {
      assert.equal(err.imeis.length, 25, 'all of them, or the override cannot cover them');
      assert.equal(err.changed, 0, 'and nothing was reachable to lock');
      return true;
    });
});

test('a refusal can carry the count of what already succeeded', () => {
  /* withApi forwards a deliberately narrow set of fields off a throw. `changed` is the third,
     and without it the dialog on the client cannot say "19 already locked" -- it would ask
     about one handset on a click that changed nineteen. */
  const src = fs.readFileSync(new URL('../api/_lib/auth.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const extra = {}'), src.indexOf('res.status(status).json'));
  assert.match(block, /typeof e\.changed === 'number'/);
  assert.match(block, /extra\.imeis = e\.imeis/, 'and the rows it is about still travel too');
});

/* =========================================================================================
   ACHIA, ENROL IT AGAIN, FUNGA. The whole bench round trip, in one test.

     "all i need is to connect phone(s), copy cmd and lock, and unlock should work as long as
      i have not achia.. if i achia and re-enloll the same phone pick its old imei so that
      funga works"

   The identity half was already solved by a migration: device_tokens remembers the string, so
   a handset that comes back gets the token it is still carrying rather than a second one.

   The STATE half was not. Achia leaves the row reading `released` and re-enrolling only
   updated its batch -- so Funga afterwards hit the released-and-silent refusal and made the
   operator dismiss a warning about re-provisioning a phone they had just re-provisioned.
   ========================================================================================= */
test('a released phone that is enrolled again comes back locked-able, with its own token', async () => {
  const d = fleet([{ imei: 'P1', state: 'enrolled', enrol_token: 'tok-p1',
    last_seen: new Date(NOW - 60000).toISOString() }]);

  // Achia.
  await _FNS.deviceSetState(d, ADMIN, { imeis: ['P1'], state: 'released' });
  let row = d._dump('devices')[0];
  assert.equal(row.state, 'released');
  assert.ok(row.released_at, 'and it is stamped with when, which is what the stale check reads');

  // Funga now is refused, and rightly: it dropped Device Owner and stopped calling home.
  await assert.rejects(
    () => _FNS.deviceSetState(d, ADMIN, { imeis: ['P1'], state: 'locked', reason: 'x' }),
    e => e.code === 'RELEASED_NOT_LISTENING');

  // Enrol it again -- the cable job the override exists for.
  const en = await _FNS.deviceEnrol(d, ADMIN, { imeis: 'P1' });
  assert.equal(en.enrolled, 0, 'not a new phone');
  assert.equal(en.alreadyOn, 1);
  assert.equal(en.revived, 1, 'and the screen is told the row came back from "imeachiwa"');
  assert.equal(en.provision[0].token, 'tok-p1',
    'the handset keeps the credential it is still carrying');
  assert.equal(en.provision[0].fresh, false, 'and is shown as known, not as a new phone');

  row = d._dump('devices')[0];
  assert.equal(row.state, 'enrolled', 'enrolling IS the statement that it is ours again');
  assert.equal(row.released_at, null, 'nothing left behind for the stale check to read');
  assert.equal(row.enrol_token, 'tok-p1', 'and its identity is untouched');

  // Which is the whole point: Funga now just works, with no override to argue with.
  const lock = await _FNS.deviceSetState(d, ADMIN, { imeis: ['P1'], state: 'locked', reason: 'arrears' });
  assert.equal(lock.changed, 1);
  assert.equal(d._dump('devices')[0].state, 'locked');

  // And it is in the history as a state change, not as a silent edit.
  const hist = await _FNS.deviceHistory(d, ADMIN, { imei: 'P1' });
  assert.ok(hist.events.some(e => e.from_state === 'released' && e.to_state === 'enrolled'),
    '"why is this enrolled when I released it in March" is answered by a row');
});

test('enrolling a LOCKED phone again does not unlock it', async () => {
  /* The limit that makes the above safe. If enrolment reset state generally, then plugging a
     defaulter's dark handset into the bench and running the same command anyone can copy off
     the screen would quietly free it -- a lock bypass with no decision behind it and nothing
     in the register to show one was made. `lost` is held for the same reason: writing a
     handset off is a judgement, and a cable is not an appeal. */
  const d = fleet([
    { imei: 'L1', state: 'locked', enrol_token: 'tl', state_reason: 'arrears' },
    { imei: 'X1', state: 'lost', enrol_token: 'tx', state_reason: 'stolen' },
  ]);
  const r = await _FNS.deviceEnrol(d, ADMIN, { imeis: 'L1 X1' });
  assert.equal(r.revived, 0, 'neither of these is a release coming back');

  const rows = d._dump('devices');
  assert.equal(rows.find(x => x.imei === 'L1').state, 'locked', 'a cable is not an unlock');
  assert.equal(rows.find(x => x.imei === 'L1').state_reason, 'arrears',
    'and the reason it was locked survives');
  assert.equal(rows.find(x => x.imei === 'X1').state, 'lost');
});

/* =========================================================================================
   THE TOKEN MEMORY, ACTUALLY EXERCISED.

     "Means we never lose record of an imei token even if futa"

   True, and it now has a round-trip test rather than a grep of the source. Two holes were
   found under it while checking that claim, and both are closed here.
   ========================================================================================= */

test('futa remembers the token, and re-enrolling that IMEI hands the same one back', async () => {
  const d = fleet([{ imei: 'F1', state: 'enrolled', enrol_token: 'keep-me' }]);
  d._dump('device_events').push({ id: 'e1', imei: 'F1', event: 'enrolled', at: '2026-08-01T00:00:00Z' });

  await _FNS.deviceDelete(d, ADMIN, { imei: 'F1' });
  assert.equal(d._dump('devices').length, 0, 'the row is gone');
  assert.equal(d._dump('device_events').length, 0, 'and its history with it');
  assert.equal(d._dump('device_tokens')[0].enrol_token, 'keep-me', 'but never the identity');

  const back = await _FNS.deviceEnrol(d, ADMIN, { imeis: 'F1' });
  assert.equal(back.provision[0].token, 'keep-me',
    'the handset is still carrying this string, so the register must hand back the same one');
  assert.equal(back.provision[0].fresh, false, 'and it is not a new phone');
});

test('a futa that cannot remember the token does not happen', async () => {
  /* The write was `await db.from(...).upsert(...)` with the result discarded, inside a
     try/catch. The Supabase client does not throw on a database error unless .throwOnError()
     is called -- which this codebase never does -- it RESOLVES with { error }. So the catch
     could only fire on a network throw, and every database error passed silently into the
     delete: row gone, memory never written, and a handset left carrying a credential the
     register can no longer name. It cannot beat, cannot be released, and refuses a factory
     reset because it is still Device Owner. That phone is scrap and nothing would have said so. */
  const d = fleet([{ imei: 'F2', state: 'enrolled', enrol_token: 'precious' }]);
  const real = d.from.bind(d);
  d.from = name => (name !== 'device_tokens' ? real(name) : {
    upsert: async () => ({ data: null, error: { message: 'timeout', code: '57014' } }),
  });

  await assert.rejects(() => _FNS.deviceDelete(d, ADMIN, { imei: 'F2' }),
    e => e.status === 503 && /token|remember/i.test(e.message));

  d.from = real;
  assert.equal(d._dump('devices').length, 1, 'nothing was deleted');
  assert.equal(d._dump('devices')[0].enrol_token, 'precious');
});

test('a deployment without the memory table can still delete', async () => {
  /* The deliberate tolerance, and the only one: "a delete that WORKS without remembering is
     far better than a delete that fails." Narrowing the catch must not take this with it. */
  const d = fleet([{ imei: 'F3', state: 'enrolled', enrol_token: 't3' }]);
  const real = d.from.bind(d);
  d.from = name => (name !== 'device_tokens' ? real(name) : {
    upsert: async () => ({ data: null, error: { message: 'relation "device_tokens" does not exist', code: '42P01' } }),
  });
  await _FNS.deviceDelete(d, ADMIN, { imei: 'F3' });
  d.from = real;
  assert.equal(d._dump('devices').length, 0, 'the register keeps working');
});

test('the Token button can still answer for a handset that was deleted', async () => {
  /* The case that needs it most: the phone is still Device Owner and still carrying its
     token, so it can be neither released nor factory reset without that string -- and
     docs/DEVICE-LOCKING.md sends the operator to this button to fetch it. deviceToken read
     the devices table only, so once the row was gone the memory was write-only and the
     recovery it exists for could not be done through any screen. */
  const d = fleet([{ imei: 'F4', state: 'enrolled', enrol_token: 'still-on-the-phone' }]);
  await _FNS.deviceDelete(d, ADMIN, { imei: 'F4' });

  const t = await _FNS.deviceToken(d, ADMIN, { imei: 'F4' });
  assert.equal(t.token, 'still-on-the-phone');
  assert.equal(t.retired, true, 'and the drawer is told this is a phone the register dropped');
  assert.ok(t.retiredBy, 'with who dropped it');

  // An IMEI nobody has ever heard of is still refused, exactly as before.
  await assert.rejects(() => _FNS.deviceToken(d, ADMIN, { imei: 'NEVER' }),
    e => /hakijasajiliwa|not on the registry/i.test(e.message));
});

/* =========================================================================================
   THE BOOT WINDOW.

     "then if a locked phone is restarted give grace period of 5 minutes so that one can
      connect data or wifi -- dont leave any loophole of unlocking a phone thats already
      locked and awake and got the grace period already"

   A locked handset draws a pinned screen the moment it boots, and that screen is why a phone
   can be stuck for good: a customer who has PAID cannot reach Settings to turn wifi on, so the
   handset cannot call home, so it never hears it was released.

   The server half is tested here. The three fences live in the APK and are asserted against
   its source below, the same way the enrol receiver's ordering already is.
   ========================================================================================= */

test('the beat carries the boot window, and its two numbers come from settings', async () => {
  const sold = [{ imei: 'B1', state: 'locked', enrol_token: 'tb', customer: 'Asha',
    state_reason: 'arrears', last_seen: new Date(NOW).toISOString() }];

  const dflt = await deviceApi(fleet(sold), 'dev_beat', [{ token: 'tb', locked: true }], NOW);
  assert.equal(dflt.bootGraceMinutes, 5, 'five minutes unless the office says otherwise');
  assert.equal(dflt.bootGraceEveryHours, 24);

  const tuned = await deviceApi(fleet(sold, [
    { key: 'DEVICE_BOOT_GRACE_MINUTES', value: '3' },
    { key: 'DEVICE_BOOT_GRACE_EVERY_HOURS', value: '12' },
  ]), 'dev_beat', [{ token: 'tb', locked: true }], NOW);
  assert.equal(tuned.bootGraceMinutes, 3, 'the number lives on the server, not in the APK');
  assert.equal(tuned.bootGraceEveryHours, 12);
});

test('zero minutes switches the window off, and a typo does not', async () => {
  /* Turning this off for a fleet is a decision the office must be able to make, so 0 cannot
     fall through to the default the way a blank or a misplaced letter does. */
  const sold = [{ imei: 'B2', state: 'locked', enrol_token: 'tb2', customer: 'Juma' }];
  const off = await deviceApi(fleet(sold, [{ key: 'DEVICE_BOOT_GRACE_MINUTES', value: '0' }]),
    'dev_beat', [{ token: 'tb2', locked: true }], NOW);
  assert.equal(off.bootGraceMinutes, 0, 'nought means nought');

  const typo = await deviceApi(fleet(sold, [{ key: 'DEVICE_BOOT_GRACE_MINUTES', value: 'tano' }]),
    'dev_beat', [{ token: 'tb2', locked: true }], NOW);
  assert.equal(typo.bootGraceMinutes, 5, 'a typo falls back rather than disarming the window');

  const neg = await deviceApi(fleet(sold, [{ key: 'DEVICE_BOOT_GRACE_MINUTES', value: '-5' }]),
    'dev_beat', [{ token: 'tb2', locked: true }], NOW);
  assert.equal(neg.bootGraceMinutes, 5, 'and so does a negative');
});

test('a retiring phone is offered no window, because it has no lock screen to open', async () => {
  const d = fleet([{ imei: 'B3', state: 'released', enrol_token: 'tb3', customer: 'Neema',
    released_at: new Date(NOW - 1000).toISOString() }]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 'tb3', locked: false }], NOW);
  assert.equal(r.retire, true);
  assert.equal(r.bootGraceMinutes, 0,
    'it is about to unharden and stop calling home; a window would only leave a stale number '
    + 'in a former customer\'s storage');
});

test('the boot window has all three of its fences, in the APK', () => {
  const src = f => fs.readFileSync(
    new URL('../android/lock/src/main/java/com/samaritantechs/hooploanlock/' + f, import.meta.url), 'utf8');
  const guard = src('Guard.java');

  /* FENCE 1 -- only ever opened at boot. If any other caller could open a window, a locked
     handset sitting awake in somebody's hand would have a path to one. */
  const openers = (guard.match(/openWindow\(/g) || []).length;
  assert.equal(openers, 2, 'exactly one call site and one declaration -- nothing else opens a window');
  const restore = guard.slice(guard.indexOf('static void restore('), guard.indexOf('mayOpenWindow(Context'));
  assert.match(restore, /realBoot && mayOpenWindow\(c\)/,
    'and it is gated on a real power cycle, not on MY_PACKAGE_REPLACED');
  assert.match(src('BootReceiver.java'), /ACTION_BOOT_COMPLETED\.equals\(action\)/,
    'which the receiver decides from the intent it actually got');

  /* FENCE 2 -- the rate limit, and the stamp that survives the reboot meant to reset it. */
  const may = guard.slice(guard.indexOf('private static boolean mayOpenWindow'),
                          guard.indexOf('private static void openWindow'));
  assert.match(may, /GRACE_LAST/, 'the limit is read from a stored stamp');
  assert.match(may, /since >= everyHours \* 3600000L/);
  assert.match(may, /if \(since < 0\) return false/,
    'and a clock wound backwards reads as "not yet", never as "long enough" -- on a locked '
    + 'phone the customer holds the clock');
  const open = guard.slice(guard.indexOf('private static void openWindow'), guard.indexOf('static void enforce('));
  const stampAt = open.indexOf('GRACE_LAST');
  const untilAt = open.indexOf('GRACE_UNTIL');
  assert.ok(stampAt > 0 && untilAt > stampAt,
    'the window is stamped as spent BEFORE it is opened, so a process killed mid-window '
    + 'cannot claim another on the reboot that follows');

  /* FENCE 3 -- reaching the server IS the purpose served, so the window ends there. */
  const beat = src('Beat.java');
  const served = beat.indexOf('Guard.windowServed(c)');
  assert.ok(served > 0, 'the beat closes the window');
  assert.ok(served < beat.indexOf('if ("lock".equals(command))'),
    'before it acts on the answer, so what follows is an ordinary lock with nothing under it');
  assert.match(guard, /static void windowServed\(Context c\)\s*\{\s*Prefs\.put\(c, Prefs\.GRACE_UNTIL, 0L\);/);

  // And a lock order always closes an open window -- otherwise the window outlives its purpose.
  const lock = guard.slice(guard.indexOf('static void lock(Context c)'), guard.indexOf('ACTION_RELEASE'));
  assert.match(lock, /Prefs\.put\(c, Prefs\.GRACE_UNTIL, 0L\)/);
  assert.match(lock, /if \(!was\) Prefs\.put\(c, Prefs\.GRACE_LAST, 0L\)/,
    'and only a NEW lock begins an episode that deserves its own window');
});

test('the offline self-lock stands down while a boot window is open', () => {
  /* Without this the window is dead on arrival for the phones that need it most. It opens at
     boot, the first beat fails because having no network is the whole reason it opened, and
     that failure reaches enforceGrace -- which would self-lock the handset that has been
     silent longest, which is exactly the paid-up customer who cannot be told they were
     released. Deferred by five minutes, never skipped: Guard.enforce still locks. */
  const beat = fs.readFileSync(new URL(
    '../android/lock/src/main/java/com/samaritantechs/hooploanlock/Beat.java', import.meta.url), 'utf8');
  const fn = beat.slice(beat.indexOf('static void enforceGrace(Context c)'), beat.indexOf('private static int battery'));
  assert.match(fn, /if \(Guard\.inWindow\(c\)\) return;/);
  assert.ok(fn.indexOf('Guard.inWindow') < fn.indexOf('Guard.lock(c)'),
    'and it stands down before it can reach the self-lock');
});

test('the boot-window build actually reaches handsets in the field', () => {
  /* SelfUpdate skips any build whose versionCode is not HIGHER than the installed one, so a
     change shipped without raising it reaches nobody. CI has caught this before. */
  const v = JSON.parse(fs.readFileSync(new URL('../lock-version.json', import.meta.url), 'utf8'));
  assert.ok(v.versionCode >= 13, 'raised for the boot window');
  assert.match(String(v.versionName), /^\d+\.\d+/);
});

test('a failed batch claim says WHICH of the three things went wrong', () => {
  /* It returned a bare String and null stood for every failure there is, so three completely
     different bench problems arrived as one sentence: the phone cannot read its own IMEI (a
     permission or vendor problem on THAT handset), the office said no (wrong IMEIs pasted, or a
     batch gone stale), or the office could not be reached at all (no wifi on the phone -- USB
     does not give it one). The next move differs for each and the message named none of them.

     Two handsets on a hub read "NOT IN THIS BATCH" when the batch was not the problem. */
  const src = fs.readFileSync(new URL(
    '../android/lock/src/main/java/com/samaritantechs/hooploanlock/EnrolReceiver.java',
    import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('private static Claim claim(Context c, String batch)'),
                       src.indexOf('private static boolean contains('));
  assert.ok(fn.length > 500, 'the claim helper is where the three are told apart');
  assert.match(fn, /CANNOT READ THIS PHONE'S IMEI/, 'the handset cannot name itself');
  assert.match(fn, /THE OFFICE REFUSED THIS PHONE \(HTTP/, 'the office answered and said no');
  assert.match(fn, /CANNOT REACH THE OFFICE/, 'the office was never reached');
  assert.match(fn, /a USB cable does not give it a network/,
    'and it names the cause an operator at a bench will actually hit');

  // The caller must report the reason it was handed, not a sentence of its own.
  const use = src.slice(src.indexOf('Claim c2 = claim(c, theBatch);'), src.indexOf('ALREADY ENROLLED'));
  assert.match(use, /msg = c2\.why/);
  assert.ok(!/NOT IN THIS BATCH/.test(use), 'the one-size-fits-all sentence is gone');
});

test('the enrol-message build reaches handsets in the field', () => {
  const v = JSON.parse(fs.readFileSync(new URL('../lock-version.json', import.meta.url), 'utf8'));
  assert.ok(v.versionCode >= 14, 'raised, or SelfUpdate skips it and no handset ever sees it');
});

/* =========================================================================================
   PHONES ALREADY IN THE FIELD, ON AN OLDER APK.

     "remember some phones locked with previous apk have gone to field already
      so whenever we update keep in mind they should be able to be unlocked and everything"

   A handset in a customer's pocket cannot be updated on demand. It updates when it feels like
   it, and a phone that is LOCKED and offline may not update for weeks -- so every version of
   this server has to keep talking to every version of the app that has ever shipped, and above
   all has to keep being able to UNLOCK one.

   The beat is the whole contract, and it is a contract in one direction only: the app reads
   the fields it knows by NAME and ignores everything else. So new fields are always safe, and
   renaming or dropping an old one is never safe -- it would not fail loudly, it would just
   stop unlocking phones, and nobody would find out until a paid-up customer complained.

   These names are read by builds that are out there right now. Changing one is not a
   refactor, it is a decision to strand every handset older than the change.
   ========================================================================================= */

const FIELD_APK_READS = ['ok', 'command', 'nextBeatSeconds', 'graceHours', 'message',
  'helpPhone', 'reason', 'brand', 'imei', 'retire'];

test('an old APK in the field can still be unlocked', async () => {
  /* The oldest beat there is: token and a state, none of the fields later versions send --
     no fcmToken, no reported imei, no location. It must still be told to unlock. */
  const d = fleet([{ imei: 'FIELD1', state: 'locked', enrol_token: 'oldtok',
    customer: 'Asha', reported: 'locked', last_seen: new Date(NOW - 60000).toISOString() }]);

  let r = await deviceApi(d, 'dev_beat', [{ token: 'oldtok', locked: true }], NOW);
  assert.equal(r.command, 'lock', 'still locked, so it is told to stay locked');

  // The office frees it. The very next beat from that same old handset must say unlock.
  await _FNS.deviceSetState(d, ADMIN, { imeis: ['FIELD1'], state: 'enrolled' });
  r = await deviceApi(d, 'dev_beat', [{ token: 'oldtok', locked: true }], NOW + 1000);
  assert.equal(r.command, 'unlock', 'a phone in the field must always be reachable to unlock');

  // And releasing it for good still retires it, which is the other one-way door.
  await _FNS.deviceSetState(d, ADMIN, { imeis: ['FIELD1'], state: 'released' });
  r = await deviceApi(d, 'dev_beat', [{ token: 'oldtok', locked: false }], NOW + 2000);
  assert.equal(r.command, 'unlock');
  assert.equal(r.retire, true, 'and it can still be handed back');
});

test('every field name an APK in the field reads is still sent', async () => {
  /* Pinned by NAME, because that is the whole contract. A rename would not fail loudly -- it
     would quietly stop unlocking every handset older than the change. */
  const d = fleet([{ imei: 'FIELD2', state: 'locked', enrol_token: 't2', customer: 'Juma',
    state_reason: 'arrears' }], [{ key: 'DEVICE_HELP_PHONE', value: '0700000000' }]);
  const r = await deviceApi(d, 'dev_beat', [{ token: 't2', locked: true }], NOW);
  for (const k of FIELD_APK_READS) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k),
      'the beat must still carry "' + k + '" -- an APK in the field reads it by that name');
  }
  // The two the boot window added are extra, and old builds simply never look for them.
  assert.equal(typeof r.bootGraceMinutes, 'number', 'new fields are additive');
});

test('a settings hiccup cannot take the fleet dark for the sake of the boot window', async () => {
  /* The boot window is a convenience. Reading its two numbers must never be able to fail a
     BEAT -- that would leave every locked phone in the field unreachable, including the ones
     whose customers have paid, for the sake of a feature about turning wifi on. */
  const d = fleet([{ imei: 'FIELD3', state: 'locked', enrol_token: 't3', customer: 'Neema' }]);
  const real = d.from.bind(d);
  d.from = name => {
    if (name !== 'settings') return real(name);
    throw new Error('settings unavailable');
  };
  const r = await deviceApi(d, 'dev_beat', [{ token: 't3', locked: true }], NOW);
  assert.equal(r.command, 'lock', 'the beat still answers, which is what keeps the fleet reachable');
  assert.equal(r.bootGraceMinutes, 0, 'and the window simply does not open');
});

test('the phones you just added come first, and the fleet keeps its own order below', async () => {
  /* "all recent added imeis should be on top so that i dont hustle finding them"

     The ordering below the band is deliberate and stays: written off, then a lock nobody has
     confirmed, then silence -- problems before routine, so the register opens on what needs
     somebody. Right for a fleet at rest, useless at the bench, where the phones that matter
     are the ones plugged in five minutes ago. */
  /* deviceList reads the wall clock (`Date.now()`), not the fixed NOW these tests usually
     pin, so the fixtures are relative to the real one -- otherwise every row would be a month
     stale and nothing would be in the band at all. */
  const t = Date.now();
  const old = new Date(t - 30 * 24 * 3600000).toISOString();
  const d = fleet([
    // Settled fleet, deliberately in the wrong order to prove the rank still decides below.
    { imei: 'OLD-OK', state: 'enrolled', enrol_token: 'a', enrolled_at: old,
      last_seen: new Date(t).toISOString(), reported: 'unlocked' },
    { imei: 'OLD-LOST', state: 'lost', enrol_token: 'b', enrolled_at: old,
      last_seen: new Date(t).toISOString() },
    // Two enrolled at the bench, an hour apart.
    { imei: 'BENCH-1', state: 'enrolled', enrol_token: 'c',
      enrolled_at: new Date(t - 2 * 3600000).toISOString() },
    { imei: 'BENCH-2', state: 'enrolled', enrol_token: 'd',
      enrolled_at: new Date(t - 60000).toISOString() },
  ]);
  const r = await _FNS.deviceList(d, ADMIN, {});
  const order = r.rows.map(x => x.imei);
  assert.deepEqual(order.slice(0, 2), ['BENCH-2', 'BENCH-1'],
    'both of today\'s phones on top, newest first');
  assert.deepEqual(order.slice(2), ['OLD-LOST', 'OLD-OK'],
    'and below them the fleet keeps problems-first, untouched');
  assert.equal(typeof r.rows[0].enrolledAt, 'number', 'sent as epoch ms, like every other time');
});

test('the just-enrolled band empties itself by the next morning', async () => {
  /* A band rather than a new sort, and it expires on its own -- nothing to switch off and
     nothing to remember. A day, because that is a bench session and the life of a batch. */
  const t = Date.now();
  const d = fleet([
    { imei: 'YESTERDAY', state: 'enrolled', enrol_token: 'a',
      enrolled_at: new Date(t - 25 * 3600000).toISOString(),
      last_seen: new Date(t).toISOString(), reported: 'unlocked' },
    { imei: 'PROBLEM', state: 'lost', enrol_token: 'b',
      enrolled_at: new Date(t - 40 * 24 * 3600000).toISOString(),
      last_seen: new Date(t).toISOString() },
  ]);
  const r = await _FNS.deviceList(d, ADMIN, {});
  assert.deepEqual(r.rows.map(x => x.imei), ['PROBLEM', 'YESTERDAY'],
    'past a day it is just a phone again, and the fleet\'s priorities take over');
});

test('a brand-new phone enrols on the FIRST run of the hub command', () => {
  /* THE BENCH BUG THAT LOOKED LIKE A WRONG BATCH.

     The hub command is one line: install, set-device-owner, broadcast. The last two are
     milliseconds apart, and the claim used to read the handset's IMEI before anything had
     granted READ_PHONE_STATE -- harden() ran only inside adopt(), which is AFTER a successful
     claim. So a phone being provisioned for the first time could not name itself, the claim
     failed, and the operator was told "NOT IN THIS BATCH" about a batch that was fine.

     Running the same command again worked, because by then the handset was already Device
     Owner and onEnabled had hardened it. Twice in one morning that read as a bad paste:

       Success: Device owner set ...          -> result=5 NOT IN THIS BATCH
       ... device owner is already set        -> result=1 ENROLLED

     Same phones, same batch, same APK, minutes apart. A documented one-liner that fails on
     every new phone and succeeds on the retry is not a flow anybody can trust. */
  const src = fs.readFileSync(new URL(
    '../android/lock/src/main/java/com/samaritantechs/hooploanlock/EnrolReceiver.java',
    import.meta.url), 'utf8');

  const thread = src.slice(src.indexOf('final PendingResult pending = goAsync();'),
                           src.indexOf('ALREADY ENROLLED'));
  const harden = thread.indexOf('LockAdmin.harden(c);');
  const claim = thread.indexOf('Claim c2 = claim(c, theBatch);');
  assert.ok(harden > 0, 'the claim path grants the permission itself');
  assert.ok(harden < claim, 'and does it BEFORE asking the phone which handset it is');

  /* The grant is applied by the system, not by us, so the first read can still be refused on a
     phone that has been Device Owner for a few hundred milliseconds. */
  const reads = src.slice(src.indexOf('private static JSONArray readImeis(Context c)'),
                          src.indexOf('private static boolean contains('));
  assert.match(reads, /tries < 2/, 'the read is retried while the grant lands');
  assert.match(reads, /Thread\.sleep\(/, 'which is free -- this already runs off the main thread');
  // And it still refuses rather than guessing when the phone genuinely cannot say.
  const fn = src.slice(src.indexOf('private static Claim claim(Context c, String batch)'),
                       src.indexOf('/** One attempt.'));
  assert.match(fn, /CANNOT READ THIS PHONE'S IMEI/);
});

test('the first-run enrol fix actually reaches handsets', () => {
  const v = JSON.parse(fs.readFileSync(new URL('../lock-version.json', import.meta.url), 'utf8'));
  assert.ok(v.versionCode >= 15, 'raised, or SelfUpdate skips it and no bench ever sees it');
});

test('a bench command is not run twice just because the wifi was not up yet', () => {
  /* THE SECOND RUN WAS NEVER FIXING ANYTHING -- IT WAS JUST HAPPENING A MINUTE LATER.
     =====================================================================================
       "the cmd always fail on 1st attempt (return=5) and work on second only"

       Success: Device owner set ...
       result=5  "CANNOT REACH THE OFFICE ...
                  [java.net.UnknownHostException: Unable to resolve host ...]"
       (the identical command again)
       result=1  "ENROLLED"

     UnknownHostException is DNS, and DNS is not ready the instant `adb install` finishes on a
     handset whose wifi was joined moments earlier: it is still associating and being
     validated. The broadcast fires inside that window and we quit on the very first miss, so
     every bulk bench was run twice. The retry was never fixing state -- it was buying seconds.
     So the app buys them itself. */
  const src = fs.readFileSync(new URL(
    '../android/lock/src/main/java/com/samaritantechs/hooploanlock/EnrolReceiver.java',
    import.meta.url), 'utf8');

  const fn = src.slice(src.indexOf('private static Claim claim(Context c, String batch)'),
                       src.indexOf('/** One attempt.'));
  assert.match(fn, /return post\(c, batch, imeis\);/, 'one pass of the loop is one attempt');
  assert.match(fn, /SystemClock\.elapsedRealtime\(\) - start >= NET_WAIT_MS\) break;/,
    'bounded by the wall clock, not by a count of attempts');
  assert.match(fn, /Thread\.sleep\(NET_RETRY_MS\)/, 'with a pause between them');

  /* AND ONLY FOR A FAILURE THAT MEANS THE OFFICE NEVER SPOKE. A refusal is an answer: asking
     again cannot turn a stale batch or a wrong IMEI into a right one, and hammering it would
     turn a clear message into a 30-second hang before the same message. */
  const post = src.slice(src.indexOf('private static Claim post('),
                         src.indexOf('private static JSONArray readImeis('));
  assert.ok(!/NET_WAIT_MS|NET_RETRY_MS|Thread\.sleep/.test(post),
    'post makes exactly one attempt and leaves the waiting to its caller');
  assert.match(post, /if \(http != 200\) \{[\s\S]{0,700}?return new Claim\(null,/,
    'the office refusing is returned at once, never retried');
  assert.match(post, /if \(t\.isEmpty\(\)\) \{[\s\S]{0,400}?return new Claim\(null,/,
    'so is a reply that carried no token');

  /* THE BUDGET, and it is not a style point. A background broadcast is killed at 60 seconds,
     and a killed receiver prints "result=0" with no data -- which reads exactly like success
     and is strictly worse than the failure this fixes. Worst case is the last attempt starting
     just under the deadline and then spending its full connect + read timeouts. */
  const wait = Number(/NET_WAIT_MS = (\d+)/.exec(src)[1]);
  const connect = Number(/setConnectTimeout\((\d+)\)/.exec(src)[1]);
  const readMs = Number(/setReadTimeout\((\d+)\)/.exec(src)[1]);
  assert.ok(wait >= 20000, 'long enough for a fresh handset to associate and validate');
  assert.ok(wait + connect + readMs < 60000,
    'and short enough that the broadcast is never killed mid-claim');

  // The operator is told it waited, so "this one has no wifi" is a finding and not a guess.
  assert.match(fn, /after waiting "\s*\+ waited \+ "s/,
    'the message reports how long it actually waited');

  // And the fix only counts if a bench can install it.
  const v = JSON.parse(fs.readFileSync(new URL('../lock-version.json', import.meta.url), 'utf8'));
  assert.ok(v.versionCode >= 17, 'raised, or SelfUpdate skips the build that carries this');
});

test('the ownership refusal names why set-device-owner fails', () => {
  /* "run this first, then broadcast again: adb shell dpm set-device-owner ..." is useless
     advice to the operator who just ran exactly that and watched it throw:

       Not allowed to set the device owner because there are already some accounts on the device.

     Android refuses Device Owner while ANY account is signed in, and on the handsets this fleet
     is built from there are usually two -- a Google account and the vendor's own -- so removing
     the obvious one still fails.

     This matters more than wording: a phone that never takes ownership CANNOT BE LOCKED, and if
     it ships in that state there is no way back without the handset in your hands. One already
     has. The message is the last chance to catch it at the bench. */
  const src = fs.readFileSync(new URL(
    '../android/lock/src/main/java/com/samaritantechs/hooploanlock/EnrolReceiver.java',
    import.meta.url), 'utf8');
  const at = src.indexOf('NOT DEVICE OWNER');
  assert.ok(at > 0);
  const msg = src.slice(at, at + 900);
  assert.match(msg, /account is signed in/, 'it names the reason Android refuses');
  assert.match(msg, /factory reset and SKIP the sign-in/, 'and the way through');
  assert.match(msg, /cannot be locked until it is/, 'and what is actually at stake');
  assert.match(msg, /do not ship this handset/,
    'and the one instruction that would have saved a phone already in the field');
  assert.match(msg, /dpm set-device-owner/, 'the command is still there');
});

test('a phone ordered locked that has NEVER spoken is counted as an alarm, not as pending', async () => {
  /* THE STATE THAT COST A HANDSET.

     A pending lock means "told, waiting for it to confirm" -- a phone that will report in
     within the quarter hour. This is not that. This handset has never contacted us at all, in
     its whole life on the register, and the lock ordered against it was never heard by
     anything. It happens when provisioning half-succeeded: the register minted a token and the
     broadcast that would have written it INTO the phone bailed out, usually because
     set-device-owner was refused for an account signed in on the handset.

     The office is then looking at a row that says `locked` about a phone running YouTube. One
     in that state was shipped to a customer before anybody noticed. */
  const d = fleet([
    // Ordered locked, never once spoke. The alarm.
    { imei: 'GHOST', state: 'locked', enrol_token: 'tok-g', state_reason: 'NEW', last_seen: null },
    // Ordered locked moments ago and simply has not confirmed yet. Ordinary, not an alarm.
    { imei: 'PENDING', state: 'locked', enrol_token: 'tok-p', reported: 'unlocked',
      last_seen: new Date(Date.now() - 60000).toISOString() },
    // Locked and confirmed.
    { imei: 'REALLY', state: 'locked', enrol_token: 'tok-r', reported: 'locked',
      last_seen: new Date(Date.now() - 60000).toISOString() },
  ]);
  const r = await _FNS.deviceList(d, ADMIN, {});
  assert.equal(r.counts.lockedNeverSpoke, 1, 'only the one that has never spoken');

  const by = Object.fromEntries(r.rows.map(x => [x.imei, x]));
  assert.equal(by.GHOST.lockedNeverSpoke, true);
  assert.equal(by.PENDING.lockedNeverSpoke, false,
    'a lock waiting on its next beat is NOT this -- conflating them is what hid it');
  assert.equal(by.REALLY.lockedNeverSpoke, false);

  /* And the trap that made it invisible: the server holding a token proves the REGISTER has an
     identity for this IMEI, never that the phone received it. */
  assert.ok(d._dump('devices').find(x => x.imei === 'GHOST').enrol_token,
    'it has a token server-side and is still not under control');
});

test('the alarm is not shown when every locked phone has spoken', async () => {
  const d = fleet([{ imei: 'OK1', state: 'locked', enrol_token: 't', reported: 'locked',
    last_seen: new Date(Date.now() - 60000).toISOString() }]);
  const r = await _FNS.deviceList(d, ADMIN, {});
  assert.equal(r.counts.lockedNeverSpoke, 0);
});
