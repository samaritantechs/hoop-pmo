import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { commandFor } from '../api/_lib/device-core.js';

/* =========================================================================================
   THE PHONE REGISTRY IS TWO PANES, BECAUSE IT IS TWO DEPARTMENTS.

     "we now want storekeeper to always lock and general duty will be unlocking at customer
      screening-pos ... all see the devices but no unlocking button in locking .. but the
      lockers will be able to relock the devices"

     "remember we working on amendments -- more than 200 phones are in regions kilometers
      away, don't distract the locking and unlocking mechanism"

   THE SECOND SENTENCE IS THE ONE MOST OF THIS FILE IS ABOUT. A handset learns what it should
   be doing from commandFor(state) over /api/device, with its own per-device token. It has
   never known what a nav is, and after this change it still does not. This is a permission
   change and the tests hold it to being only that.

   THE GATE IS ON THE TRANSITION, NOT ON THE PANE. deviceSetState is one door for all four
   state changes, so a pane that merely hides its unlock button is a suggestion -- curl does
   not read HTML.
   ========================================================================================= */
const STORE = { code: 'ST', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['devlock'], readOnly: false };
const DUTY = { code: 'GD', name: 'ASHA', role: 'GENERAL DUTY', teams: null, tabs: ['devunlock'], readOnly: false };
const BOTH = { code: 'B1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['devlock', 'devunlock'], readOnly: false };
const LEGACY = { code: 'L1', name: 'Wa zamani', role: 'STORE', teams: null, tabs: ['devices'], readOnly: false };
const OTHER = { code: 'Z1', name: 'Mwingine', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['devlock'], readOnly: true };
const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const dev = (o = {}) => ({
  imei: o.imei || '351388334583295', item: 'A07', holder: 'SIPHO STORE',
  state: o.state || 'enrolled', state_reason: null, state_by: null, state_at: null,
  reported: o.reported || null, last_seen: o.seen || null, released_at: o.released || null,
  enrol_token: 'tok-' + (o.imei || '1'), enrolled_at: '2026-08-01T08:00:00Z', updated_at: '2026-08-01T08:00:00Z',
});
const devDb = (o = {}) => fakeDb({ devices: o.devices || [dev({})], device_events: [], settings: [] });
const stateOf = async (db, imei) => (await db.from('devices').select('*')).data.find(r => r.imei === imei).state;

/* ---------------------------------------------------------------------------------------- */
test('the store keeper locks and re-locks, and cannot unlock anybody’s handset', async () => {
  const db = devDb({ devices: [dev({ imei: 'D1', state: 'enrolled' })] });

  const lock = await _FNS.deviceSetState(db, STORE, { imeis: ['D1'], state: 'locked', reason: 'hajalipa' });
  assert.equal(lock.changed, 1);
  assert.equal(await stateOf(db, 'D1'), 'locked');

  /* THE WHOLE POINT OF THE SPLIT. Hiding the button would be a suggestion; this is the rule,
     and it is enforced at the one door every state change passes through. */
  await assert.rejects(() => _FNS.deviceSetState(db, STORE, { imeis: ['D1'], state: 'enrolled' }),
    /no access to the devunlock pane/, 'the locking bench cannot open a phone');
  await assert.rejects(() => _FNS.deviceSetState(db, STORE, { imeis: ['D1'], state: 'released' }),
    /no access to the devunlock pane/, 'nor let one go for good');
  assert.equal(await stateOf(db, 'D1'), 'locked', 'and nothing moved while it was refused');

  /* "the lockers will be able to relock the devices" -- including one that was released and
     is still listening, which is the case the register was built to keep reachable. */
  await _FNS.deviceSetState(db, DUTY, { imeis: ['D1'], state: 'released' });
  assert.equal(await stateOf(db, 'D1'), 'released');
  const again = await _FNS.deviceSetState(db, STORE, { imeis: ['D1'], state: 'locked', reason: 'imerudi', force: true });
  assert.equal(again.changed, 1);
  assert.equal(await stateOf(db, 'D1'), 'locked', 'a locker re-locks');
});

test('general duty unlocks and releases at the POS, and cannot lock or write off', async () => {
  const db = devDb({ devices: [dev({ imei: 'D1', state: 'locked' })] });

  const open = await _FNS.deviceSetState(db, DUTY, { imeis: ['D1'], state: 'enrolled' });
  assert.equal(open.changed, 1);
  assert.equal(await stateOf(db, 'D1'), 'enrolled');

  await assert.rejects(() => _FNS.deviceSetState(db, DUTY, { imeis: ['D1'], state: 'locked', reason: 'x' }),
    /no access to the devlock pane/, 'the POS desk does not lock');
  await assert.rejects(() => _FNS.deviceSetState(db, DUTY, { imeis: ['D1'], state: 'lost', reason: 'x' }),
    /no access to the devlock pane/, 'nor write a handset off -- that is stock accountability');

  // Somebody the owner ticks for both does both. Two navs, two grants, one person.
  await _FNS.deviceSetState(db, BOTH, { imeis: ['D1'], state: 'locked', reason: 'x' });
  await _FNS.deviceSetState(db, BOTH, { imeis: ['D1'], state: 'enrolled' });
  assert.equal(await stateOf(db, 'D1'), 'enrolled');
});

test('both desks see every phone, because the one who ships it must know whether it is shut', async () => {
  const db = devDb({ devices: [dev({ imei: 'D1', state: 'locked' }), dev({ imei: 'D2', state: 'enrolled' })] });
  for (const who of [STORE, DUTY, ADMIN, VIEWER]) {
    const d = await _FNS.deviceList(db, who, {});
    assert.equal(d.ok, true);
    assert.equal((d.rows || []).length, 2, (who.name || who.code) + ' sees the whole fleet');
  }
  assert.equal((await _FNS.deviceHistory(db, DUTY, { imei: 'D1' })).ok, true, 'and can read one phone’s story');
  await assert.rejects(() => _FNS.deviceList(db, OTHER, {}), /no access to the devlock pane/,
    'somebody holding neither still holds neither');
});

test('the bench keeps provisioning: enrolling, the token and the eraser are the locker’s', async () => {
  const db = fakeDb({ devices: [dev({ imei: 'D1' })], device_events: [], hoop_aged_stock: [], settings: [] });
  for (const [fn, args] of [['deviceEnrol', { imeis: ['D9'] }], ['deviceToken', { imei: 'D1' }], ['deviceDelete', { imei: 'D1' }]]) {
    await assert.rejects(() => _FNS[fn](db, DUTY, args), /no access to the devlock pane/,
      fn + ' is bench work: the POS desk does not provision handsets');
  }
  // And a view-only code changes nothing on either desk, as everywhere here.
  await assert.rejects(() => _FNS.deviceSetState(db, VIEWER, { imeis: ['D1'], state: 'locked', reason: 'x' }),
    /kuangalia tu|view-only/i);
});

test('a code that still holds the old `devices` tick keeps both halves, and nobody goes dark', async () => {
  const db = devDb({ devices: [dev({ imei: 'D1', state: 'enrolled' })] });
  /* THE MORNING THIS SHIPPED. Every role and code in the field carries `devices`; splitting
     the nav without expanding the old grant would have taken the bench away from the store
     keeper and the POS desk from general duty, on a deploy nobody asked for. */
  assert.equal((await _FNS.deviceList(db, LEGACY, {})).ok, true);
  await _FNS.deviceSetState(db, LEGACY, { imeis: ['D1'], state: 'locked', reason: 'x' });
  await _FNS.deviceSetState(db, LEGACY, { imeis: ['D1'], state: 'enrolled' });
  assert.equal(await stateOf(db, 'D1'), 'enrolled', 'the legacy grant still does both');

  // ADMIN IS FULL ACCESS EVERYWHERE WE DEVELOP -- the standing rule.
  await _FNS.deviceSetState(db, ADMIN, { imeis: ['D1'], state: 'locked', reason: 'x' });
  assert.equal(await stateOf(db, 'D1'), 'locked');
});

test('nothing a handset in the field observes has changed', () => {
  /* OVER TWO HUNDRED LOCKED PHONES ARE KILOMETERS AWAY. What each of them does is decided by
     commandFor(state) -- the whole of the phone's half of the contract. If this mapping is
     what it always was, the split cannot have reached the field. */
  assert.equal(commandFor('locked'), 'lock');
  assert.equal(commandFor('lost'), 'lock', 'a written-off phone stays shut');
  assert.equal(commandFor('enrolled'), 'unlock');
  assert.equal(commandFor('released'), 'unlock');
  assert.equal(commandFor('anything else'), 'unlock');

  // The beat endpoint knows about IMEIs and tokens. It has never known about navs.
  const beat = fs.readFileSync(new URL('../api/_lib/device-core.js', import.meta.url), 'utf8');
  const door = fs.readFileSync(new URL('../api/device.js', import.meta.url), 'utf8');
  for (const src of [beat, door]) {
    assert.ok(!/requireNav|devlock|devunlock|NAV_TABS/.test(src),
      'the phone-facing half must not learn what a nav is');
  }

  // The four states themselves are untouched: same names, same set, same meanings.
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const map = /const DEVICE_STATE_NAV = \{([^}]+)\}/.exec(api)[1];
  for (const st of ['locked', 'lost', 'enrolled', 'released']) {
    assert.match(map, new RegExp('\\b' + st + ':'), st + ' is still a state this system orders');
  }
  assert.match(map, /locked: 'devlock'/);
  assert.match(map, /enrolled: 'devunlock'/);
});

test('an unknown state is refused before any nav is consulted', async () => {
  const db = devDb();
  /* A fifth state added later with no entry in DEVICE_STATE_NAV is refused outright, which is
     the safe direction: a missing case that fell through to "allowed" is how a nav split
     quietly stops splitting anything. */
  await assert.rejects(() => _FNS.deviceSetState(db, ADMIN, { imeis: ['D1'], state: 'bricked' }),
    /Unknown device state/);
  await assert.rejects(() => _FNS.deviceSetState(db, ADMIN, { imeis: ['D1'], state: 'constructor' }),
    /Unknown device state/, 'and an inherited property is not a state either');
});
