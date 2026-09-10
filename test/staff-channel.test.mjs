import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { todayKey } from '../api/_lib/time.js';

/* =========================================================================================
   THE STAFF PANE: each rank, and each leader's own channel.

     "I needed the staff panel to be like of hope pmo -- don't put report to. But each person
      gets there by role, and clicking their panel needs filling who their channel data, like
      we start with 3: rsm, agent and team leader."

     "Country_Sales_Manager -- this is company admin, no need to be in the list.
      Regional_Manager -- these are the rsm, and on the staff pane we can activate or
      deactivate them; if deactivated even their login attempts can't work."

   THE EDIT RUNS THE OTHER WAY ROUND, and that is the whole of "don't put report to". The
   column underneath is the same `manager` the target cascade already walks. What changed is
   which end of the question the screen asks: nobody sits down to decide who ONE AGENT reports
   to, they sit down with an RSM and decide who is in that RSM's channel.

   WHAT THE BRANCH DERIVES IS NOT AN ASSIGNMENT. Where `manager` is blank the cascade falls
   back to the branch, and that is right for almost everybody. Those people are shown on the
   leader's panel and are deliberately not tickable: a tick that stores nothing and an untick
   that cannot be honoured are both worse than a line of text saying how they got there.

   AND DEACTIVATION REACHES THE DOOR. Two registers -- hoop_agents says who works here,
   access_codes is what opens the door -- joined by name and nothing else. That join is worth
   saying out loud rather than hiding, so "no code matched" is an answer this returns.
   ========================================================================================= */
const HR = { code: 'H1', name: 'SIPHO K', role: 'HR', teams: null, tabs: ['staff'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['staff'], readOnly: true };
const OUT = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };

const person = (name, role, branch, phone, o = {}) => ({
  name, role, branch, phone,
  manager: o.manager === undefined ? null : o.manager,
  active: o.active === undefined ? true : o.active,
  joined_date: '2026-02-21', kin_name: null, kin_phone: null,
  updated_at: '2026-02-21T00:00:00Z',
});
/* One branch, one rung of each rank, plus a second RSM elsewhere to prove a channel does not
   quietly reach across the company. */
const REG = () => [
  person('SALES MASTER', 'Country_Sales_Manager', 'Head Office', '0657282396'),
  person('SIMON MWANGASA', 'Regional_Manager', 'SOUTHERN HIGHLAND', '0683875152'),
  person('ANORD SAWE', 'Regional_Manager', 'Dar es salaam', '0658918324'),
  person('INNOCENT MWANGASA', 'Team_Leader', 'SOUTHERN HIGHLAND', '0784275550'),
  person('YELEMIA MNGANGA', 'Team_Leader', 'SOUTHERN HIGHLAND', '0788775616'),
  person('ATHUMANI DIANGA', 'Team_Leader', 'Dar es salaam', '0670306780'),
  person('ALLY NDEMANDEMA', 'Field_Officer', 'SOUTHERN HIGHLAND', '0687905620'),
  person('BASHIR MBINJI', 'Field_Officer', 'SOUTHERN HIGHLAND', '0686907985'),
];
const stDb = (o = {}) => fakeDb({
  hoop_agents: o.agents || REG(),
  access_codes: o.codes || [],
  settings: [], audit_log: [],
});
const nameOf = xs => xs.map(x => x.name).sort();
const phoneRow = (db, phone) => db._dump('hoop_agents').find(r => r.phone === phone);

/* ---------------------------------------------------------------------------------------- */
test('a leader’s panel lists the rank directly below, and only that rank', async () => {
  const db = stDb();
  const rsm = await _FNS.staffChannel(db, HR, { phone: '0683875152' });   // SIMON, an RSM
  assert.equal(rsm.leader.name, 'SIMON MWANGASA');
  assert.equal(rsm.leaf, false);
  /* AN RSM FILLS IN TEAM LEADERS, not agents. Reaching further down would let one tick put an
     agent under an RSM with a team leader standing between them -- a shape the roll-up cannot
     then explain. */
  assert.deepEqual(nameOf(rsm.members),
    ['ATHUMANI DIANGA', 'INNOCENT MWANGASA', 'YELEMIA MNGANGA']);

  const tl = await _FNS.staffChannel(db, HR, { phone: '0784275550' });    // a team leader
  assert.deepEqual(nameOf(tl.members), ['ALLY NDEMANDEMA', 'BASHIR MBINJI']);

  // An agent has no rank below them, and the pane says so rather than showing an empty box.
  const fo = await _FNS.staffChannel(db, HR, { phone: '0687905620' });
  assert.equal(fo.leaf, true);
  assert.deepEqual(fo.members, []);
});

test('the branch’s own answer is shown, and is not a tick', async () => {
  const db = stDb();
  const rsm = await _FNS.staffChannel(db, HR, { phone: '0683875152' });   // SOUTHERN HIGHLAND
  const byName = Object.fromEntries(rsm.members.map(x => [x.name, x]));
  /* Nobody has typed anything, so these two land here because they share a branch. They are
     `branch`, never `mine`: the difference between what a person decided and what the system
     worked out is the whole honesty of this screen. */
  assert.equal(byName['INNOCENT MWANGASA'].branch, true);
  assert.equal(byName['INNOCENT MWANGASA'].mine, false);
  assert.equal(byName['YELEMIA MNGANGA'].branch, true);
  // The Dar team leader belongs to the other RSM's branch and is neither.
  assert.equal(byName['ATHUMANI DIANGA'].branch, false);
  assert.equal(byName['ATHUMANI DIANGA'].mine, false);
  assert.equal(rsm.counts.branch, 2);
  assert.equal(rsm.counts.mine, 0);
});

test('ticking writes the channel, and unticking only ever clears what pointed here', async () => {
  const db = stDb();
  const RSM = '0683875152';                                   // SIMON
  // Take the Dar team leader into this channel: an explicit assignment across a branch line,
  // which is exactly the case `manager` exists for.
  const r = await _FNS.staffChannelSave(db, HR, { phone: RSM, members: ['0670306780'] });
  assert.equal(r.added, 1);
  assert.equal(r.removed, 0);
  assert.equal(phoneRow(db, '0670306780').manager, 'SIMON MWANGASA');

  const after = await _FNS.staffChannel(db, HR, { phone: RSM });
  const byName = Object.fromEntries(after.members.map(x => [x.name, x]));
  assert.equal(byName['ATHUMANI DIANGA'].mine, true);
  /* THE BRANCH TWO ARE STILL NOT TICKED and were not touched by the save: they have nothing
     stored, so there was nothing to write. A save that "tidied" them into explicit rows would
     freeze today's branch layout into the register for ever. */
  assert.equal(phoneRow(db, '0784275550').manager, null);
  assert.equal(byName['INNOCENT MWANGASA'].branch, true);

  // Unticking clears it, and the person falls back to whatever the branch says.
  const back = await _FNS.staffChannelSave(db, HR, { phone: RSM, members: [] });
  assert.equal(back.removed, 1);
  assert.equal(phoneRow(db, '0670306780').manager, null);
});

test('one leader’s save never un-assigns another leader’s people', async () => {
  /* The dangerous shape of a "set the whole list" save: sending an empty list from one panel
     must not mean "and nobody reports to anybody else either". */
  const db = stDb({ agents: REG().map(p =>
    p.phone === '0670306780' ? { ...p, manager: 'ANORD SAWE' } : p) });
  await _FNS.staffChannelSave(db, HR, { phone: '0683875152', members: [] });   // SIMON saves empty
  assert.equal(phoneRow(db, '0670306780').manager, 'ANORD SAWE',
    'Anord’s team leader is not Simon’s to release');
  // And the other panel still shows them.
  const anord = await _FNS.staffChannel(db, HR, { phone: '0658918324' });
  assert.equal(anord.members.find(x => x.name === 'ATHUMANI DIANGA').mine, true);
  // While Simon's panel says where they currently are, so nobody wonders.
  const simon = await _FNS.staffChannel(db, HR, { phone: '0683875152' });
  assert.equal(simon.members.find(x => x.name === 'ATHUMANI DIANGA').elsewhere, 'ANORD SAWE');
});

test('a phone that is not on the rank below is refused, not quietly dropped', async () => {
  const db = stDb();
  /* The pane cannot send one, but the pane is not the only thing that can call this -- and
     silently ignoring it would report a save that did not happen. */
  await assert.rejects(
    () => _FNS.staffChannelSave(db, HR, { phone: '0683875152', members: ['0687905620'] }),
    /si wa ngazi inayofuata|not on the rank below/, 'an agent is two rungs below an RSM');
  await assert.rejects(
    () => _FNS.staffChannelSave(db, HR, { phone: '0683875152', members: ['0799999999'] }),
    /si wa ngazi inayofuata|not on the rank below/, 'and a stranger is nobody');
});

test('deactivating shuts the door, and says which codes it shut', async () => {
  const db = stDb({ codes: [
    { code: 'AB12', name: 'INNOCENT MWANGASA', role: 'TEAM LEADER', suspend_from: null, suspend_to: null },
    { code: 'ZZ99', name: 'Somebody Else', role: 'OFFICER', suspend_from: null, suspend_to: null },
  ] });
  const r = await _FNS.staffActive(db, HR, { phone: '0784275550', active: false });
  assert.equal(r.active, false);
  assert.equal(r.codes, 1, 'one portal code carried that name');
  assert.equal(r.doorKnown, true);
  assert.equal(phoneRow(db, '0784275550').active, false);

  const code = db._dump('access_codes').find(c => c.code === 'AB12');
  /* OPEN-ENDED: suspendedOn reads a `from` with no `to` as "from that day until somebody lifts
     it", which is what deactivated means. A window with an end date would quietly let them
     back in. */
  assert.equal(code.suspend_from, todayKey());
  assert.equal(code.suspend_to, null);
  assert.equal(db._dump('access_codes').find(c => c.code === 'ZZ99').suspend_from, null,
    'and nobody else’s door moved');

  // Switching them back on lifts it.
  const on = await _FNS.staffActive(db, HR, { phone: '0784275550', active: true });
  assert.equal(on.codes, 1);
  assert.equal(db._dump('access_codes').find(c => c.code === 'AB12').suspend_from, null);
  assert.equal(phoneRow(db, '0784275550').active, true);
});

test('no code in that name is an answer, not a silent half-success', async () => {
  /* The two registers are joined BY NAME and nothing else -- it is the only thing they share.
     So a miss is ordinary and has to be reported, or somebody believes they have shut a door
     that is still open. */
  const db = stDb({ codes: [{ code: 'ZZ99', name: 'Somebody Else', role: 'OFFICER' }] });
  const r = await _FNS.staffActive(db, HR, { phone: '0784275550', active: false });
  assert.equal(r.active, false, 'the register still records them as inactive');
  assert.equal(r.codes, 0, 'and the screen is told no door was involved');
  assert.equal(phoneRow(db, '0784275550').active, false);
});

test('an ADMIN code is never shut out by this pane', async () => {
  /* The standing rule, and here it is also the lockout guard: an admin code suspended from the
     staff pane would leave nobody able to lift it. */
  const db = stDb({ codes: [
    { code: 'AD01', name: 'INNOCENT MWANGASA', role: 'ADMIN', suspend_from: null, suspend_to: null },
  ] });
  const r = await _FNS.staffActive(db, HR, { phone: '0784275550', active: false });
  assert.equal(r.adminSkipped, 1);
  assert.equal(r.codes, 0);
  assert.equal(db._dump('access_codes').find(c => c.code === 'AD01').suspend_from, null);
  assert.equal(phoneRow(db, '0784275550').active, false, 'the register still records the change');
});

test('before the suspend migration the register still changes, and says the door did not', async () => {
  const db = fakeDb({
    hoop_agents: REG(), access_codes: [{ code: 'AB12', name: 'INNOCENT MWANGASA', role: 'TEAM LEADER' }],
    settings: [], audit_log: [],
  }, { missingColumns: { access_codes: ['suspend_from', 'suspend_to'] } });
  const r = await _FNS.staffActive(db, HR, { phone: '0784275550', active: false });
  assert.equal(r.active, false);
  assert.equal(r.doorKnown, false,
    'three states, not two: the un-migrated door cannot say yes, so it does not pretend to');
  assert.equal(phoneRow(db, '0784275550').active, false);
});

test('a view-only code reads every channel and changes none of them', async () => {
  const db = stDb();
  assert.equal((await _FNS.staffChannel(db, VIEWER, { phone: '0683875152' })).ok, true);
  for (const [fn, args] of [
    ['staffChannelSave', { phone: '0683875152', members: [] }],
    ['staffActive', { phone: '0784275550', active: false }],
  ]) {
    await assert.rejects(() => _FNS[fn](db, VIEWER, args), /kuangalia tu|view-only/i);
  }
  // And the nav is the permission, as everywhere here.
  for (const fn of ['staffChannel', 'staffChannelSave', 'staffActive']) {
    await assert.rejects(() => _FNS[fn](db, OUT, { phone: '0683875152', active: false }),
      /no access to the staff pane/);
  }
});

test('the channel is the same column the targets cascade already walks', async () => {
  /* NOT A SECOND HIERARCHY. If this pane wrote somewhere of its own, the staff screen and the
     targets board would disagree about who is under whom -- and the numbers would be the last
     thing to notice. */
  const CSM = { ...HR, tabs: ['staff', 'targets'] };
  const db = fakeDb({
    hoop_agents: REG(), access_codes: [], settings: [], audit_log: [],
    // One sale, so the Dar team leader is on the board at all.
    watu_loans: [{ imei: 'I1', agent: 'ATHUMANI DIANGA', agent_id: '1', team: 'T',
      branch: 'Dar es salaam', price: 500000, has_ever_paid: true, locked4: false,
      locked7: false, days_offline: 1, disbursed_date: '2026-09-10' }],
    // Thirty phones expected of this RSM, and nothing typed against anybody below them.
    sales_targets: [{ id: 't1', period: '2026-09', scope: 'rsm', name: 'SIMON MWANGASA',
      target_qty: 30, target_amount: null, note: null, set_by: 'Peter', set_at: '2026-09-01T00:00:00Z' }],
  });
  /* Before the channel is filled in, the Dar team leader is in the other RSM's branch and gets
     nothing from Simon. */
  const before = await _FNS.targetsView(db, CSM, { period: '2026-09' });
  const beforeRow = (before.rows.agent || []).find(r => r.name === 'ATHUMANI DIANGA');
  assert.ok(!beforeRow || beforeRow.targetFrom !== 'SIMON MWANGASA');

  await _FNS.staffChannelSave(db, CSM, { phone: '0683875152', members: ['0670306780'] });
  const after = await _FNS.targetsView(db, CSM, { period: '2026-09' });
  const row = (after.rows.agent || []).find(r => r.name === 'ATHUMANI DIANGA');
  assert.ok(row, 'the same person is on the targets board');
  /* THE POINT: a tick on the staff pane moved a number on the targets board, because both
     screens read one column. If this pane had written a hierarchy of its own, the two would
     disagree and the numbers would be the last thing anybody noticed. */
  assert.equal(row.targetSource, 'share');
  assert.equal(row.targetFrom, 'SIMON MWANGASA');
  assert.equal(phoneRow(db, '0670306780').manager, 'SIMON MWANGASA');
});

test('before the manager migration the panel reads, and the save says which file to run', async () => {
  const db = fakeDb({ hoop_agents: REG().map(({ manager, ...r }) => r), access_codes: [],
    settings: [], audit_log: [] }, { missingColumns: { hoop_agents: ['manager'] } });
  const d = await _FNS.staffChannel(db, HR, { phone: '0683875152' });
  assert.equal(d.ok, true, 'the rank below still lists');
  assert.equal(d.members.length, 3);
  assert.ok(d.members.every(x => !x.mine), 'nothing can be assigned yet, and none pretends to be');
  await assert.rejects(
    () => _FNS.staffChannelSave(db, HR, { phone: '0683875152', members: ['0670306780'] }),
    /RUN-ME-2026-09-09-targets\.sql/);
});

/* =========================================================================================
   WHERE SOMEBODY WORKS, SET FROM THIS PANE.

   The branch was read-only here and empty for most of the register, which is exactly why 532
   handsets sat on OLD STOCK with no location: their holder has no branch on the register and
   no sales in the deck to borrow one from.

   ONE EDIT ANSWERS EVERY HANDSET THEY CARRY, because OLD STOCK derives the place from the
   HOLDER and stamps it on the next open. Setting it on the person is also where the rest of
   the system already looks.
   ========================================================================================= */
const brDb = (agents, loans = []) => fakeDb({
  hoop_agents: agents, watu_loans: loans, audit_log: [], settings: [],
  old_stock: [], devices: [], hoop_aged_stock: [], stock_audit: [], hoop_sales: [],
});
const AN_AGENT = { name: 'ABEL MGANGA', phone: '0789473000', role: 'Field_Officer',
  branch: null, manager: 'ANORD SAWE', active: true };

test('setting a branch on the register fills in every handset that holder carries', async () => {
  const db = brDb([AN_AGENT]);
  const r = await _FNS.staffBranchSave(db, HR, { phone: '0789473000', branch: '  MWANZA ' });
  assert.equal(r.ok, true);
  /* TRIMMED, because a trailing space makes a second town on every pivot that reads this --
     and each distinct spelling is its own bar. Not upper-cased: the register's own spelling
     is what the office recognises. */
  assert.equal(r.branch, 'MWANZA');
  assert.equal(db._dump('hoop_agents')[0].branch, 'MWANZA');
  assert.equal(r.was, '', 'and it says what was there before');
});

test('an empty box clears the place rather than leaving a wrong one', async () => {
  /* Somebody put in the wrong town has to be able to go back to unknown. Without this the
     only way out is a second guess, and a guess is what sends a van to the wrong place. */
  const db = brDb([{ ...AN_AGENT, branch: 'WRONG TOWN' }]);
  const r = await _FNS.staffBranchSave(db, HR, { phone: '0789473000', branch: '   ' });
  assert.equal(r.branch, '');
  assert.equal(r.was, 'WRONG TOWN');
  assert.equal(db._dump('hoop_agents')[0].branch, null);
});

test('it refuses a phone the register does not know, rather than inventing a row', async () => {
  const db = brDb([AN_AGENT]);
  await assert.rejects(() => _FNS.staffBranchSave(db, HR, { phone: '0700000000', branch: 'X' }),
    /not in the register/);
  await assert.rejects(() => _FNS.staffBranchSave(db, HR, { branch: 'X' }), /No staff member/);
  assert.equal(db._dump('hoop_agents').length, 1);
});

test('a view-only code cannot move anybody, and it is audited when somebody does', async () => {
  const db = brDb([AN_AGENT]);
  await assert.rejects(() => _FNS.staffBranchSave(db, VIEWER, { phone: '0789473000', branch: 'X' }));
  /* WHERE SOMEBODY WORKS DECIDES WHERE A VAN GOES, so changing it is a thing the log holds --
     with the value each side, like every other watched call. */
  const { AUDITED } = await import('../api/_lib/audit.js');
  assert.ok(AUDITED.has('staffBranchSave'));
  const audit = await import('../api/_lib/audit.js');
  const src = fs.readFileSync(new URL('../api/_lib/audit.js', import.meta.url), 'utf8');
  assert.match(src, /staffBranchSave: \{ table: 'hoop_agents'[\s\S]{0,80}fields: \['branch'\]/);
  assert.ok(audit);
});

test('the pane offers the places already in use, from both the register and the deck', async () => {
  /* A new spelling should be a DECISION, not a typo: every distinct one becomes its own bar
     on the OLD STOCK pivot. The deck's names count because that is what the office says. */
  const db = brDb(
    [{ ...AN_AGENT, branch: 'MWANZA' }, { ...AN_AGENT, phone: '02', name: 'B', branch: 'TABORA' }],
    [{ imei: 's1', agent: 'X', branch: 'ARUSHA' }, { imei: 's2', agent: 'Y', branch: 'MWANZA' }]);
  const d = await _FNS.staffDirectory(db, HR);
  assert.deepEqual(d.branches, ['ARUSHA', 'MWANZA', 'TABORA'], 'both sources, de-duplicated');
});

test('the branch cell is a control, and a blank one says it is unset', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  /* From drawStaff to whatever function follows it -- drawSalaries is defined ABOVE this one,
     so slicing to it gives nothing at all and every assertion below would pass on an empty
     string. A fence that reads the wrong half of the file is not a fence. */
  const at = html.indexOf('function drawStaff(');
  const draw = html.slice(at, html.indexOf('\nfunction ', at + 10));
  assert.ok(draw.length > 500, 'the slice must actually hold drawStaff');
  assert.match(draw, /data-brn="/, 'the branch opens an editor');
  assert.match(draw, /weka \/ set/, 'and an empty one invites being filled in');
  assert.match(draw, /BOOT\.readOnly\s*\n?\s*\?/, 'a view-only code reads it and cannot press it');

  const dr = html.slice(html.indexOf('function staffBranchDrawer('), at);
  assert.match(dr, /list="brList"/, 'a datalist, so a genuinely new branch is still typeable');
  assert.match(dr, /Leaving it empty clears the location/,
    'clearing a wrong town is a real thing somebody needs to do, and guessing at it leaves the wrong one');
  assert.match(dr, /srv\('staffBranchSave'/);
});
