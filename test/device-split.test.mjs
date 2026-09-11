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

/* ============================================================================================
   THE LOCK NEVER TOUCHES THE CUSTOMER'S ACCOUNTS.
   ============================================================================================
     "RSMs in abroad regions are complaining phones at Point of sale cant login GMAIL account"
     "they say they cant create account, they have to create in their own phones and then login
      in our customer phone"
     "signing in is okay but creating is not"

   THE FIELD REPORT IS THE PROOF, and it clears this app: every account control a Device Owner
   has blocks ADDING an account, an existing one exactly as much as a new one. If the lock held
   either, signing in would fail too. It does not. What remains is Google's own rule on managed
   phones -- create is dropped, sign-in is kept -- which is why it returns at achia, when the
   step-down ends the management.

   SO THIS TEST GUARDS THE ABSENCE. Adding one of these lines later would be a one-word change
   that reads like hardening and, on 2,000 handsets in the field, silently takes Gmail away
   from paying customers -- with the reason five thousand kilometres from whoever notices.
   ============================================================================================ */
test('the lock app holds no account restriction, so signing in keeps working', () => {
  const admin = fs.readFileSync(
    new URL('../android/lock/src/main/java/com/samaritantechs/hooploanlock/LockAdmin.java',
      import.meta.url), 'utf8');
  /* Comments are the record of WHY, and naming a restriction is how the record explains it --
     so the check is on code, with block comments stripped first. */
  const code = admin.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/DISALLOW_MODIFY_ACCOUNTS/.test(code),
    'that would block signing in as well, which the field says still works');
  assert.ok(!/setAccountManagementDisabled/.test(code),
    'the same, by the other route');
  // And the restrictions it DOES hold, unchanged -- none of them is about accounts.
  for (const r of ['DISALLOW_FACTORY_RESET', 'DISALLOW_SAFE_BOOT', 'DISALLOW_ADD_USER']) {
    assert.match(code, new RegExp('addUserRestriction\\(me, UserManager\\.' + r + '\\)'), r);
  }
  /* DISALLOW_ADD_USER is a second USER, not a second ACCOUNT -- the one pair a reader chasing
     this complaint would most easily confuse, and confusing them ends with the wrong line
     deleted from a lock that 2,000 handsets depend on. */
  assert.ok(/DISALLOW_ADD_USER/.test(code) && !/DISALLOW_MODIFY_ACCOUNTS/.test(code));
});

test('the POS desk carries the Gmail steps, and the store bench does not', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const draw = html.slice(html.indexOf('function drawDevices('));
  // On the unlocking pane only: that is the desk with the customer standing at it.
  assert.match(draw.slice(0, 30000), /\+\(canLock \? '' :\s*\n?\s*'<div class="note"/,
    'the card is gated to the POS desk');
  /* READ THE CARD THE WAY THE OPERATOR DOES. This pane is built by concatenating string
     literals, so a sentence on screen is spread over several of them in the source -- and a
     regex written the way somebody at the counter reads it then fails on a card that is
     perfectly correct. Every assertion below has been bitten by that once already. Joining
     adjacent literals first is the fix, and it is the right one: what is being asserted here
     is the WORDS THE DESK SEES, not how the file happens to wrap them. */
  const card = draw.replace(/'\s*\+\s*'/g, '');
  assert.match(card, /accounts\.google\.com\/signup/);
  assert.match(card, /Mipangilio → Akaunti → Ongeza akaunti → Google/);
  /* GOOGLE'S EXACT SENTENCE IS ON THE CARD.
       "it says sign in with your work account in all the 3 never allowing creation"
     An operator reading "sign in with your work account" has no reason to connect it to a
     loan and every reason to ring the office. Printing the words they are looking at, next to
     what to do about them, is what ends that call -- so it is asserted, not paraphrased. */
  assert.equal(card.split('Sign in with your work account').length - 1, 2,
    'once in the Swahili half and once in the English');
  /* AND THE ONLY ROUTE THAT WORKS LEADS. The browser step was tried on a handset and refused
     in all three apps, so it is gone -- the card must never send anybody back to it. */
  assert.ok(!/Fungua <b>Chrome<\/b> kwenye simu ya mteja/.test(card),
    'the browser route was confirmed refused and must not be printed as a step');
  /* "Any device not under finance", never "the customer's other phone": the customer at the
     counter frequently has no other phone, which is how this became a complaint at all. */
  assert.match(card, /kisicho chini ya mkopo/);
  assert.match(card, /any device that is not under finance/i);
  // The account is the customer's, and the desk that made it knows the password.
  assert.match(card, /change the password/i);
  // And it says whose rule this is, so nobody goes looking for a switch in our own code.
  assert.match(card, /Si hitilafu ya kufuli letu wala si simu ya kazi/);
  assert.match(card, /This is not a fault in the lock and it is not a work phone/);
});

/* ============================================================================================
   NOTHING MINTS A SECOND TOKEN FOR A HANDSET THAT ALREADY HAS ONE.
   ============================================================================================
     "so the tokens should be autoupdated"
     "i fear to disturb tokens for unlocking and achia"
     "we have stock at ground you know"

   THE SECOND INSTINCT IS THE RIGHT ONE. A token lives in TWO places -- the devices row and the
   handset's own storage -- and the phone's copy changes only with the phone in your hands. Give
   the register a new one on its own and the pair stop matching, which on a handset out with a
   customer is a fortnight, not an inconvenience: every beat 403s so the office can no longer
   unlock OR release it; an unlocked one self-locks after its grace week with nobody able to open
   it; and it comes back only after fourteen continuous days of refusal.

   SO THE PROTECTION IS AN ABSENCE, and an absence is exactly what a future edit removes without
   noticing. "Auto-update the tokens" is a reasonable-sounding sentence that would put field stock
   on the floor, so the shape of the code that prevents it is pinned here.
   ============================================================================================ */
test('a known IMEI keeps its token: no server path mints a second one', async () => {
  const db = fakeDb({ devices: [], device_events: [], hoop_aged_stock: [], settings: [] });
  const IMEI = '351111111111111';
  const first = await _FNS.deviceEnrol(db, STORE, { imeis: [IMEI] });
  const token = first.provision[0].token;
  assert.match(token, /^[0-9a-f]{32}$/, 'minted once, at enrolment');

  /* Enrolling the same IMEI again hands back the SAME string -- "achia and relock/re-enroll
     should repick same token used before if the imei exists". A second mint here is how a
     register and a handset stop agreeing. */
  const again = await _FNS.deviceEnrol(db, STORE, { imeis: [IMEI] });
  assert.equal(again.provision[0].token, token, 're-enrolling never re-mints');

  // Releasing does not touch it either: achia is a decision about a loan, not about identity.
  await _FNS.deviceSetState(db, DUTY, { imeis: [IMEI], state: 'released' });
  const after = await _FNS.deviceToken(db, STORE, { imei: IMEI });
  assert.equal(after.token, token, 'achia leaves the credential alone on both sides');

  /* And the reader is a reader. deviceToken discloses; it must never rotate -- there is no
     screen anywhere that can change a field handset's token, and that is the whole point. */
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const fn = api.slice(api.indexOf('  async deviceToken(db, user, args) {'));
  const body = fn.slice(0, fn.indexOf('\n  },')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/randomUUID/.test(body), 'deviceToken reads the token; it does not mint one');
  assert.ok(!/\.update\(|\.upsert\(|\.insert\(/.test(body), 'and it writes nothing');
});

test('the Token drawer says why there is no new-token button', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const drawerSrc = html.slice(html.indexOf('function devToken(imei){'));
  const card = drawerSrc.slice(0, 6000).replace(/'\s*\+\s*'/g, '');
  // Said where somebody would look for the button, not only in a doc nobody opens at a bench.
  assert.match(card, /never changed for a handset that is in the field/i);
  assert.match(card, /self-locks after its grace week/i);
  assert.match(card, /Token haibadilishwi kwa simu iliyoko shambani/);
  /* AND THE APK IS FETCHED FRESH. A field handset has self-updated, so an older file on the
     laptop is refused as a downgrade -- and the station's one-liner joins with &&, so the
     enrol broadcast then never runs. That reads at the bench as "re-enrolling is broken". */
  assert.match(card, /Download it fresh every time/i);
  assert.match(card, /refused as a downgrade/i);
});

/* ============================================================================================
   ONE FUNGUA PRESS DECIDES UNLOCK-ONLY OR UNLOCK-AND-ACHIA.
   ============================================================================================
     "sales coordinators fungua and achia at once at pos ... whenever pressed unlock prompt a
      quin wether to achia too or just [unlock] ... reduce the double work ... decide the two
      now ... extend to achia for current or selected device"

   A managed phone refuses Gmail account creation, so the POS desk was releasing every handset
   right after unlocking it -- two presses. This makes it one decision. It is a UI change: the
   server already gates both 'enrolled' and 'released' behind the unlock nav, and this test pins
   that the single funnel every Fungua passes through now opens the chooser, and that lock and
   the standalone achia are untouched.
   ============================================================================================ */
test('Fungua opens a choice, and it reaches both unlock and release through the one funnel', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const act = html.slice(html.indexOf('function devAct_('), html.indexOf('function devSend_('));
  /* EVERY Fungua enters devAct_ with state 'enrolled' -- the bulk bar and row button via
     devSetState, the row panel directly -- so intercepting here catches all three, for the
     current phone or a selection, with nothing duplicated per entry point. */
  assert.match(act, /if\(state==='enrolled'\)\{ devUnlockChoose_\(m, imeis\); return false; \}/);
  // And it must sit BEFORE the release confirmation, or an unlock would trip Achia's dialog.
  assert.ok(act.indexOf("state==='enrolled'") < act.indexOf("state==='released' && !confirm("),
    'the enrolled intercept precedes the release confirmation');

  const choose = html.slice(html.indexOf('function devUnlockChoose_('),
    html.indexOf('function devUnlockChoose_(') + 1600);
  // Two roads, both through devSend_/devAct_ -- the same proven write path, not a new one.
  assert.match(choose, /Fungua tu \/ Unlock only/);
  assert.match(choose, /Fungua na Achia \/ Unlock \+ release/);
  assert.match(choose, /devSend_\(m, imeis, 'enrolled', '', false\)/);
  assert.match(choose, /devSend_\(m, imeis, 'released', '', false\)/);
  /* THE ONE-WAY WARNING RIDES ON THE RELEASE BUTTON, so the decision is made once and informed
     rather than behind a second dialog -- which is the whole "reduce the double work". */
  assert.match(choose, /Drops Device Owner and stops reporting/);
  assert.match(choose, /lets Gmail sign-in work/i);
  /* A BULK RELEASE STILL CONFIRMS THE COUNT; a single POS phone does not. */
  assert.match(choose, /if\(n>1\) devAct_\(m, imeis, 'released'\);/);
});

test('lock and the standalone achia are left exactly as they were', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const act = html.slice(html.indexOf('function devAct_('), html.indexOf('function devSend_('));
  // Lock/write-off ask for no reason -- the intercept did not add one, and none is left over.
  assert.ok(!/prompt\(/.test(act), 'no reason prompt anywhere in the order path');
  assert.ok(!/Sababu inahitajika/.test(act));
  // The standalone Achia still carries its own one-way confirmation on the release path.
  assert.match(act, /state==='released' && !confirm\(/);
  // The desk still offers both buttons on their own, unchanged.
  assert.match(html, /data-dvs="enrolled">Fungua \/ Unlock/);
  assert.match(html, /data-dvs="released">Achia \/ Release/);
});
