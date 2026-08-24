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
    [{ imei: 'D1', token: 'tok1', locked: true, battery: 84, android: '13', appVersion: '1.0.2' }], NOW);

  assert.equal(r.command, 'lock');
  assert.equal(r.reason, 'Stock unaccounted', 'the phone is told WHY, so the lock screen can say it');
  assert.equal(r.helpPhone, '0700000000');
  assert.match(r.message, /HOOPLOAN/);

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
    { imei: 'D2', state: 'locked', state_reason: 'unpaid', enrol_token: 'tok2' },
  ]);

  // Wrong token, unknown IMEI, and a missing token all give the SAME answer -- otherwise
  // this endpoint becomes an oracle for guessing which IMEIs are real.
  const refused = /Not enrolled/;
  await assert.rejects(() => deviceApi(d, 'dev_beat', [{ imei: 'D1', token: 'tok2' }], NOW), refused,
    'another phone\'s token does not open this one');
  await assert.rejects(() => deviceApi(d, 'dev_beat', [{ imei: 'GHOST', token: 'tok1' }], NOW), refused);
  await assert.rejects(() => deviceApi(d, 'dev_beat', [{ imei: 'D1', token: '' }], NOW), /required/);

  // A phone claiming to be unlocked is still told to lock: state is the office's, not its.
  const r = await deviceApi(d, 'dev_beat', [{ imei: 'D1', token: 'tok1', locked: false }], NOW);
  assert.equal(r.command, 'lock');
  assert.equal(d._dump('devices').find(x => x.imei === 'D1').state, 'locked');

  // ...and the registry surfaces the disagreement rather than believing either side.
  const list = await _FNS.deviceList(d, ADMIN, {});
  assert.equal(list.rows.find(x => x.imei === 'D1').lockState, 'pending',
    'ordered locked, reporting unlocked -- that is pending, and someone must look at it');
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
  const beat = await deviceApi(d, 'dev_beat', [{ imei: 'D1', token: tok, locked: false }], NOW);
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
