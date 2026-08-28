import test from 'node:test';
import assert from 'node:assert/strict';
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
