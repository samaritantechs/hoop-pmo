import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { todayKey } from '../api/_lib/time.js';

/* =========================================================================================
   ONE TARGET, EVERYBODY'S NUMBER.

     "Sales target is set per rsm like hope sets for team, so it increases to the higher
      leadership tiers, but decrease when going down to team leaders and agents -- like it's
      2 halves if only 2 team leaders are under the rsm. With that hierarchy down at agents
      contributive auto target from that of rsm. And target will be set by role not a single
      staff."

   TWO SENTENCES, ONE ARITHMETIC. "Increases going up" and "decreases going down" are the same
   rule read from either end: a number set at one level is DIVIDED among the people under it,
   and the sum of the shares is the number you started with.

   NOTHING DERIVED IS EVER STORED. A share written into a row is a lie the moment somebody
   moves team or gains an agent -- and a lie nobody could see, because it would look exactly
   like a number a person typed. So the tree is walked on every read, and every row says WHERE
   its number came from.
   ========================================================================================= */
const CSM = { code: 'C1', name: 'Boss', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
const TGT = { code: 'T1', name: 'Setter', role: 'MANAGER', teams: null, tabs: ['targets'], readOnly: false };
const PERIOD = todayKey().slice(0, 7);
const DAY = PERIOD + '-05';

/* One region: a country manager, one RSM, two team leaders, four field officers. */
const REGISTER = [
  { name: 'PETER CSM', role: 'Country_Sales_Manager', branch: 'ILALA', manager: null, active: true },
  { name: 'RSM ONE', role: 'Regional_Manager', branch: 'ILALA', manager: null, active: true },
  { name: 'TL A', role: 'Team_Leader', branch: 'ILALA', manager: null, active: true },
  { name: 'TL B', role: 'Team_Leader', branch: 'ILALA', manager: null, active: true },
  { name: 'AG 1', role: 'Field_Officer', branch: 'ILALA', manager: 'TL A', active: true },
  { name: 'AG 2', role: 'Field_Officer', branch: 'ILALA', manager: 'TL A', active: true },
  { name: 'AG 3', role: 'Field_Officer', branch: 'ILALA', manager: 'TL B', active: true },
  { name: 'AG 4', role: 'Field_Officer', branch: 'ILALA', manager: 'TL B', active: true },
];
const target = o => ({ period: o.period || PERIOD, scope: o.scope, name: o.name,
  target_qty: o.qty == null ? null : o.qty, target_amount: o.amount == null ? null : o.amount,
  note: null, set_by: 'Boss', set_at: '2026-09-01T08:00:00Z' });
const loan = o => ({ imei: o.imei, agent: o.agent, team: 'ILALA', branch: 'ILALA',
  price: o.price == null ? 500000 : o.price, disbursed_date: o.day || DAY });
const tgDb = (o = {}) => fakeDb({
  watu_loans: o.loans || [], hoop_agents: o.agents || REGISTER, sales_targets: o.targets || [],
});
const row = (d, scope, name) => d.rows[scope].find(r => r.name === name);

/* ---------------------------------------------------------------------------------------- */
test('a target on the RSM halves to two team leaders and quarters to four agents', async () => {
  const db = tgDb({ targets: [target({ scope: 'rsm', name: 'RSM ONE', qty: 40 })] });
  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });

  const rsm = row(d, 'rsm', 'RSM ONE');
  assert.equal(rsm.targetQty, 40);
  assert.equal(rsm.targetSource, 'own', 'somebody typed this one');

  /* "2 halves if only 2 team leaders are under the rsm" -- exactly the owner's example. */
  for (const tl of ['TL A', 'TL B']) {
    const r = row(d, 'agent', tl);
    assert.equal(r.targetQty, 20, tl + ' carries half of forty');
    assert.equal(r.targetSource, 'share');
    assert.equal(r.targetFrom, 'RSM ONE', 'and the row says whose half it is');
    assert.equal(r.shareOf, 2);
  }
  // ...and each team leader's twenty splits again between their two agents.
  for (const ag of ['AG 1', 'AG 2', 'AG 3', 'AG 4']) {
    const r = row(d, 'agent', ag);
    assert.equal(r.targetQty, 10, ag + ' carries a quarter of forty');
    assert.equal(r.targetSource, 'share');
  }
  /* THE OTHER HALF OF THE SENTENCE: add the leaves back up and you have what was set. */
  assert.equal(rsm.rolledQty, 40, 'it increases to the higher leadership tiers');
  assert.equal(rsm.under, 6, 'two team leaders and four agents beneath them');
});

test('a target set BY ROLE is every holder’s, without one row per person', async () => {
  const db = tgDb({ targets: [target({ scope: 'role', name: 'Field_Officer', qty: 12 })] });
  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });
  for (const ag of ['AG 1', 'AG 2', 'AG 3', 'AG 4']) {
    const r = row(d, 'agent', ag);
    assert.equal(r.targetQty, 12, 'every field officer is expected to sell twelve');
    assert.equal(r.targetSource, 'role');
    assert.equal(r.targetFrom, 'FIELD_OFFICER');
  }
  // The role row itself is a SOURCE, not a place on the board: nothing is measured against it.
  const rr = d.rows.role.find(r => r.name === 'FIELD_OFFICER');
  assert.equal(rr.targetQty, 12);
  assert.equal(rr.holders, 4, 'and it says how many people draw from it');
  assert.equal(d.totals.roles, 1);
  assert.ok(d.names.role.includes('REGIONAL_MANAGER'), 'the form offers the roles the register uses');
});

test('own beats role, and role beats a share -- and the row always says which', async () => {
  const db = tgDb({ targets: [
    target({ scope: 'rsm', name: 'RSM ONE', qty: 40 }),          // would give everybody a share
    target({ scope: 'role', name: 'Field_Officer', qty: 12 }),    // beats the share
    target({ scope: 'agent', name: 'AG 1', qty: 30 }),            // beats both
  ] });
  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });
  assert.equal(row(d, 'agent', 'AG 1').targetQty, 30);
  assert.equal(row(d, 'agent', 'AG 1').targetSource, 'own');
  assert.equal(row(d, 'agent', 'AG 2').targetQty, 12);
  assert.equal(row(d, 'agent', 'AG 2').targetSource, 'role');
  assert.equal(row(d, 'agent', 'TL A').targetQty, 20, 'a team leader has no role target here');
  assert.equal(row(d, 'agent', 'TL A').targetSource, 'share');

  /* THE ROLL-UP IS HONEST ABOUT AN OVERRIDE. Somebody was given thirty where the cascade would
     have given twelve, so the leaves no longer add to forty -- and seeing that is the point. */
  assert.notEqual(row(d, 'rsm', 'RSM ONE').rolledQty, 40);
});

test('a number set at the very top reaches an agent through every rung', async () => {
  const db = tgDb({ targets: [target({ scope: 'agent', name: 'PETER CSM', qty: 80 })] });
  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });
  // Peter -> one RSM (80) -> two TLs (40 each) -> two agents each (20 each).
  assert.equal(row(d, 'rsm', 'RSM ONE').targetQty, 80, 'the only RSM carries the whole company number');
  assert.equal(row(d, 'agent', 'TL A').targetQty, 40);
  assert.equal(row(d, 'agent', 'AG 1').targetQty, 20);
  assert.equal(row(d, 'agent', 'AG 1').targetSource, 'share');
});

test('a share is rounded UP, because three people aiming low finish the month short', async () => {
  const db = tgDb({
    agents: [
      { name: 'RSM ONE', role: 'Regional_Manager', branch: 'ILALA', active: true },
      { name: 'AG 1', role: 'Field_Officer', branch: 'ILALA', manager: 'RSM ONE', active: true },
      { name: 'AG 2', role: 'Field_Officer', branch: 'ILALA', manager: 'RSM ONE', active: true },
      { name: 'AG 3', role: 'Field_Officer', branch: 'ILALA', manager: 'RSM ONE', active: true },
    ],
    targets: [target({ scope: 'rsm', name: 'RSM ONE', qty: 10 })],
  });
  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });
  for (const ag of ['AG 1', 'AG 2', 'AG 3']) {
    assert.equal(row(d, 'agent', ag).targetQty, 4, 'ten between three is four each, not three');
  }
  assert.equal(row(d, 'rsm', 'RSM ONE').rolledQty, 12, 'so the shares add to a little over, never under');
});

test('achievement is still measured against the deck, and a derived target is measured too', async () => {
  const db = tgDb({
    targets: [target({ scope: 'rsm', name: 'RSM ONE', qty: 40 })],
    loans: [loan({ imei: 'I1', agent: 'AG 1' }), loan({ imei: 'I2', agent: 'AG 1' }),
      loan({ imei: 'I3', agent: 'AG 2' })],
  });
  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });
  const ag1 = row(d, 'agent', 'AG 1');
  assert.equal(ag1.qty, 2, 'two phones on the Watu deck this month');
  assert.equal(ag1.targetQty, 10);
  assert.equal(ag1.pctQty, 20, 'and a share is a real target: it is measured like any other');
  assert.equal(ag1.missed, true);
  /* An agent who has sold nothing and was never typed into the table still has a number to
     answer for -- a board showing only the people who happened to sell hides the worst rows. */
  const ag4 = row(d, 'agent', 'AG 4');
  assert.equal(ag4.qty, 0);
  assert.equal(ag4.targetQty, 10);
  assert.equal(ag4.hasTarget, true);
  assert.ok(d.totals.derived >= 6, 'most of the board is answering for a number nobody typed');
});

test('a manager naming a peer, or a loop, cannot make the walk hang', async () => {
  const db = tgDb({
    agents: [
      { name: 'A', role: 'Field_Officer', branch: 'ILALA', manager: 'B', active: true },
      { name: 'B', role: 'Field_Officer', branch: 'ILALA', manager: 'A', active: true },
      { name: 'RSM ONE', role: 'Regional_Manager', branch: 'ILALA', active: true },
    ],
    targets: [target({ scope: 'rsm', name: 'RSM ONE', qty: 10 })],
  });
  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });
  /* A manager who is not ABOVE you is not your manager, so the loop is refused before it can
     form and both fall to the RSM standing in their branch. */
  assert.equal(row(d, 'agent', 'A').targetQty, 5);
  assert.equal(row(d, 'agent', 'B').targetQty, 5);
  assert.equal(row(d, 'agent', 'A').targetFrom, 'RSM ONE');
});

test('a role target is one target however it is spelled, and the nav still gates all of it', async () => {
  const db = tgDb();
  await _FNS.targetSave(db, TGT, { period: PERIOD, scope: 'role', name: 'regional manager', qty: 25 });
  await _FNS.targetSave(db, TGT, { period: PERIOD, scope: 'role', name: 'Regional_Manager', qty: 30 });
  const stored = db._dump('sales_targets').filter(r => r.scope === 'role');
  assert.equal(stored.length, 1, 'three spellings of one role are one target, not three');
  assert.equal(stored[0].name, 'REGIONAL_MANAGER');
  assert.equal(stored[0].target_qty, 30, 're-setting corrects it');

  const d = await _FNS.targetsView(db, TGT, { period: PERIOD });
  assert.equal(row(d, 'rsm', 'RSM ONE').targetQty, 30);
  assert.equal(row(d, 'rsm', 'RSM ONE').targetSource, 'role');

  await _FNS.targetDelete(db, TGT, { period: PERIOD, scope: 'role', name: 'regional manager' });
  assert.equal(db._dump('sales_targets').filter(r => r.scope === 'role').length, 0,
    'and deleting keys it the same way saving did, or it would delete nothing');

  await assert.rejects(() => _FNS.targetSave(db, TGT, { period: PERIOD, scope: 'role', name: '', qty: 5 }),
    /Chagua wadhifa|Choose a role/);
  const outsider = { code: 'Z', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['customers'], readOnly: false };
  await assert.rejects(() => _FNS.targetsView(db, outsider, {}), /no access to the targets pane/);
  assert.equal((await _FNS.targetsView(db, CSM, {})).ok, true, 'ADMIN is full access everywhere');
});
