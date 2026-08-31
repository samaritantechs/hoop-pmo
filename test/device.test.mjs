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
