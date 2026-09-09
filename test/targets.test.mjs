import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';

/* =========================================================================================
   SALES TARGETS -- set them, then measure the month against them.

     CSM SOP B.3  "Set regional targets for each RSM and monitor performance against them"
     CSM SOP A.2  "Hold RSMs accountable for the performance of their respective regions"
     RSM SOP B.1  "Set and monitor sales targets for each agent/team leader, in line with the
                   overall targets set by the company"
     RSM SOP B.3  "Review performance data weekly and monthly, and identify reasons for any
                   decline"
     RSM SOP B.5  "Document the actions taken and the results achieved"

   The Sales performance board answers "how much did we sell". It could never answer "against
   what": nothing here held a target for a PERSON, only SALES_DAILY_TARGET, one company-wide
   number per day.

   THE PERMISSION IS THE NAV. Nothing below names a CSM or an RSM; the fixtures hold panes.
   ========================================================================================= */
const SETTER = { code: 'M1', name: 'SALES MASTER', role: 'OFFICER', teams: null, tabs: ['targets'], readOnly: false };
const SELLER = { code: 'A1', name: 'AJENTI', role: 'OFFICER', teams: null, tabs: ['scorecards'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['targets', 'staff'], readOnly: true };
const HR = { code: 'H1', name: 'SIPHO K', role: 'OFFICER', teams: null, tabs: ['staff'], readOnly: false };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const MONTH = '2026-09';
const loan = (agent, o = {}) => ({ imei: o.imei || ('I' + agent + (o.n || 0)),
  disbursed_date: o.date || '2026-09-15', price: o.price == null ? 450000 : o.price,
  agent, team: o.team || 'KINONDONI', branch: o.branch || 'DAR' });
const agent = (name, role, branch, manager) => ({ name, role, branch, manager: manager || null, active: true });
const tgt = (scope, name, o = {}) => ({ period: o.period || MONTH, scope, name,
  target_qty: o.qty == null ? null : o.qty, target_amount: o.amount == null ? null : o.amount,
  note: o.note || null, set_by: o.by || 'SALES MASTER', set_at: '2026-09-01T06:00:00Z' });
const tgDb = (o = {}) => fakeDb({
  watu_loans: o.loans || [], hoop_agents: o.agents || [], sales_targets: o.targets || [],
});

/* ---------------------------------------------------------------------------------------- */
test('targets: one nav, view-only sets nothing, ADMIN holds it, and the writes are audited', async () => {
  const d = tgDb({ targets: [tgt('company', 'ALL', { qty: 100 })] });
  await assert.rejects(() => _FNS.targetsView(d, SELLER, {}), e => e.status === 403,
    'holding the sales board is not holding the targets');
  await assert.rejects(() => _FNS.targetSave(d, SELLER, { period: MONTH, scope: 'agent', name: 'X', qty: 1 }),
    e => e.status === 403);
  assert.ok((await _FNS.targetsView(d, VIEWER, {})).rows, 'view-only reads');
  for (const [fn, args] of [['targetSave', { period: MONTH, scope: 'agent', name: 'X', qty: 1 }],
    ['targetDelete', { period: MONTH, scope: 'company', name: 'ALL' }],
    ['staffManager', { phone: '07', manager: 'Y' }]]) {
    await assert.rejects(() => _FNS[fn](d, VIEWER, args), e => e.status >= 400 && e.status < 500, fn);
  }
  assert.equal(d._dump('sales_targets').length, 1, 'and changes nothing');
  assert.ok((await _FNS.targetsView(d, OWNER, {})).rows, 'ADMIN IS FULL ACCESS EVERYWHERE');
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  assert.match(src, /const NAV_TABS = \[[^\]]*'targets'/, 'targets is a nav the owner can tick');
  for (const fn of ['targetSave', 'targetDelete', 'staffManager']) {
    assert.match(src, new RegExp("AUDITED\\.add\\('" + fn + "'\\)"), fn + ' is audited');
  }
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-09-targets.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists sales_targets \(/);
  assert.match(sql, /alter table hoop_agents add column if not exists manager text;/,
    'the register gains one column, idempotently');
  assert.match(sql, /unique \(period, scope, name\)/, 'one target per name per month, enforced by the database');
  for (const s of ['agent', 'rsm', 'branch', 'company']) assert.ok(sql.includes(`'${s}'`));
});

/* ---------------------------------------------------------------------------------------- */
test('targets: four scopes off one read, and an agent rolls up to their RSM', async () => {
  const d = tgDb({
    loans: [
      loan('ASHA', { n: 1 }), loan('ASHA', { n: 2 }), loan('ASHA', { n: 3 }),
      loan('JUMA', { n: 4, price: 500000 }),
      loan('MOSES', { n: 5, branch: 'MBEYA' }),
    ],
    agents: [
      agent('SIMON MWANGASA', 'Regional_Manager', 'DAR'),
      agent('PETER MWERA', 'Regional_Manager', 'MBEYA'),
      agent('ASHA', 'Field_Officer', 'DAR'),
      agent('JUMA', 'Field_Officer', 'DAR'),
      agent('MOSES', 'Field_Officer', 'MBEYA'),
    ],
  });
  const r = await _FNS.targetsView(d, SETTER, { period: MONTH });
  assert.equal(r.period, MONTH); assert.equal(r.from, '2026-09-01'); assert.equal(r.to, '2026-09-30');
  // Agents.
  const asha = r.rows.agent.find(x => x.name === 'ASHA');
  assert.equal(asha.qty, 3); assert.equal(asha.amount, 1350000);
  assert.equal(asha.manager, 'SIMON MWANGASA', 'derived from the branch, with no data entry at all');
  assert.equal(r.rows.agent.find(x => x.name === 'MOSES').manager, 'PETER MWERA');
  // RSMs: an agent's numbers land on their manager's line.
  const simon = r.rows.rsm.find(x => x.name === 'SIMON MWANGASA');
  assert.equal(simon.qty, 4, 'ASHA\'s three and JUMA\'s one');
  assert.equal(simon.amount, 1350000 + 500000);
  assert.equal(r.rows.rsm.find(x => x.name === 'PETER MWERA').qty, 1);
  // Branches and the company.
  assert.equal(r.rows.branch.find(x => x.name === 'DAR').qty, 4);
  assert.equal(r.rows.branch.find(x => x.name === 'MBEYA').qty, 1);
  assert.equal(r.rows.company[0].name, 'ALL');
  assert.equal(r.rows.company[0].qty, 5);
  assert.equal(r.totals.sales, 5);
  assert.equal(r.totals.amount, 3 * 450000 + 500000 + 450000);
  // The form is offered the register's own spellings, so nobody targets a name nothing matches.
  assert.ok(r.names.agent.includes('ASHA'));
  assert.deepEqual(r.names.rsm, ['PETER MWERA', 'SIMON MWANGASA']);
  assert.deepEqual(r.names.branch, ['DAR', 'MBEYA']);
});

test('targets: the register\'s own manager column overrides the branch, and a sale with no agent is still a sale', async () => {
  const d = tgDb({
    loans: [loan('ASHA', { n: 1 }), { imei: 'I9', disbursed_date: '2026-09-10', price: 300000, agent: null, team: 'T', branch: 'DAR' }],
    agents: [
      agent('SIMON MWANGASA', 'Regional_Manager', 'DAR'),
      agent('PETER MWERA', 'Regional_Manager', 'MBEYA'),
      // ASHA stands in DAR but reports across the line to Mbeya's RSM.
      agent('ASHA', 'Field_Officer', 'DAR', 'PETER MWERA'),
    ],
  });
  const r = await _FNS.targetsView(d, SETTER, { period: MONTH });
  assert.equal(r.rows.agent.find(x => x.name === 'ASHA').manager, 'PETER MWERA', 'the override wins');
  assert.equal(r.rows.rsm.find(x => x.name === 'PETER MWERA').qty, 1);
  assert.equal(r.rows.rsm.find(x => x.name === 'SIMON MWANGASA'), undefined, 'and nothing lands on the branch RSM');
  // A sale nobody is named on is still counted, and says so.
  assert.ok(r.rows.agent.find(x => /no agent/.test(x.name)));
  assert.ok(r.rows.rsm.find(x => /no manager/.test(x.name)));
  assert.equal(r.rows.company[0].qty, 2, 'the company total never quietly drops a sale');
});

test('targets: only this month, and only the code\'s own teams', async () => {
  const d = tgDb({
    loans: [
      loan('ASHA', { n: 1, date: '2026-09-01' }), loan('ASHA', { n: 2, date: '2026-09-30' }),
      loan('ASHA', { n: 3, date: '2026-08-31' }), loan('ASHA', { n: 4, date: '2026-10-01' }),
      loan('OTHER', { n: 5, team: 'TEMEKE' }),
    ],
    agents: [],
  });
  const r = await _FNS.targetsView(d, SETTER, { period: MONTH });
  assert.equal(r.totals.sales, 3, 'both ends of September, neither neighbour');
  // February, to prove the month arithmetic is not a fixed 30.
  const feb = await _FNS.targetsView(tgDb({ loans: [loan('A', { date: '2026-02-28' })] }), SETTER, { period: '2026-02' });
  assert.equal(feb.to, '2026-02-28'); assert.equal(feb.totals.sales, 1);
  const jan = await _FNS.targetsView(tgDb({}), SETTER, { period: '2026-01' });
  assert.equal(jan.to, '2026-01-31');
  // A code scoped to one team never sees another's.
  const scoped = await _FNS.targetsView(d, { ...SETTER, teams: ['KINONDONI'] }, { period: MONTH });
  assert.equal(scoped.totals.sales, 2, 'September, KINONDONI only');
  // Nonsense in the period box falls back to this month rather than throwing mid-report.
  assert.match((await _FNS.targetsView(d, SETTER, { period: 'later' })).period, /^\d{4}-\d{2}$/);
});

/* ---------------------------------------------------------------------------------------- */
test('targets: attainment, and a target with NO sales is the row worth reading', async () => {
  const d = tgDb({
    loans: [loan('ASHA', { n: 1 }), loan('ASHA', { n: 2 })],
    agents: [agent('SIMON MWANGASA', 'Regional_Manager', 'DAR'), agent('ASHA', 'Field_Officer', 'DAR'),
      agent('LAZY', 'Field_Officer', 'DAR')],
    targets: [
      tgt('agent', 'ASHA', { qty: 4, amount: 2000000, note: 'Soko la Kariakoo' }),
      // Set a target, sold nothing: the whole reason this pane exists.
      tgt('agent', 'LAZY', { qty: 10 }),
      tgt('company', 'ALL', { qty: 10, amount: 5000000 }),
    ],
  });
  const r = await _FNS.targetsView(d, SETTER, { period: MONTH });
  const asha = r.rows.agent.find(x => x.name === 'ASHA');
  assert.equal(asha.targetQty, 4); assert.equal(asha.pctQty, 50);
  assert.equal(asha.targetAmount, 2000000); assert.equal(asha.pctAmount, 45, '900,000 of 2,000,000');
  assert.equal(asha.note, 'Soko la Kariakoo'); assert.equal(asha.setBy, 'SALES MASTER');
  assert.equal(asha.hasTarget, true); assert.equal(asha.missed, true);
  const lazy = r.rows.agent.find(x => x.name === 'LAZY');
  assert.ok(lazy, 'an agent with a target and no sales still appears');
  assert.equal(lazy.qty, 0); assert.equal(lazy.pctQty, 0); assert.equal(lazy.missed, true);
  // Somebody with sales and no target is not "missed" -- nobody asked them for anything.
  const simon = r.rows.rsm.find(x => x.name === 'SIMON MWANGASA');
  assert.equal(simon.hasTarget, false); assert.equal(simon.missed, false);
  assert.equal(simon.pctQty, null, 'and no percentage is invented for them');
  assert.equal(r.totals.withTarget, 3); assert.equal(r.totals.missed, 3);
  assert.equal(r.totals.pctQty, 20, 'the company: 2 of 10');
  // A target met is not missed.
  await _FNS.targetSave(d, SETTER, { period: MONTH, scope: 'agent', name: 'ASHA', qty: 2 });
  const after = await _FNS.targetsView(d, SETTER, { period: MONTH });
  const asha2 = after.rows.agent.find(x => x.name === 'ASHA');
  assert.equal(asha2.pctQty, 100); assert.equal(asha2.missed, false);
  assert.equal(asha2.targetAmount, null, 're-setting replaces the target rather than merging into it');
});

test('targets: setting one corrects it rather than filing a second', async () => {
  const d = tgDb({ agents: [agent('ASHA', 'Field_Officer', 'DAR')] });
  await _FNS.targetSave(d, SETTER, { period: MONTH, scope: 'agent', name: ' ASHA ', qty: '30', amount: '15000000', note: 'Q3 push' });
  assert.equal(d._dump('sales_targets').length, 1);
  let [row] = d._dump('sales_targets');
  assert.equal(row.name, 'ASHA'); assert.equal(row.target_qty, 30); assert.equal(row.target_amount, 15000000);
  assert.equal(row.set_by, 'SALES MASTER'); assert.equal(row.note, 'Q3 push');
  await _FNS.targetSave(d, SETTER, { period: MONTH, scope: 'agent', name: 'ASHA', qty: '25' });
  assert.equal(d._dump('sales_targets').length, 1, 'one target per name per month');
  [row] = d._dump('sales_targets');
  assert.equal(row.target_qty, 25);
  // A different month is a different target.
  await _FNS.targetSave(d, SETTER, { period: '2026-10', scope: 'agent', name: 'ASHA', qty: 40 });
  assert.equal(d._dump('sales_targets').length, 2);
  // Zero is a real target -- a month off -- and survives the round trip.
  await _FNS.targetSave(d, SETTER, { period: MONTH, scope: 'agent', name: 'ASHA', qty: 0 });
  assert.equal(d._dump('sales_targets').find(x => x.period === MONTH).target_qty, 0);
  const v = await _FNS.targetsView(d, SETTER, { period: MONTH });
  const a = v.rows.agent.find(x => x.name === 'ASHA');
  assert.equal(a.targetQty, 0); assert.equal(a.hasTarget, true);
  assert.equal(a.pctQty, null, 'nothing is divided by zero');
  assert.equal(a.missed, false, 'and selling nothing against a target of nothing is not a miss');
  // The company scope names itself, whatever the form sends.
  await _FNS.targetSave(d, SETTER, { period: MONTH, scope: 'company', name: 'whatever', qty: 500 });
  assert.ok(d._dump('sales_targets').some(x => x.scope === 'company' && x.name === 'ALL'));
});

test('targets: what a target must carry, and what removing one means', async () => {
  const d = tgDb({ targets: [tgt('agent', 'ASHA', { qty: 5 })] });
  const bad = async (args, why) => {
    await assert.rejects(() => _FNS.targetSave(d, SETTER, args), e => e.status === 400 && why.test(e.message), JSON.stringify(args));
  };
  await bad({ scope: 'agent', name: 'ASHA', qty: 5 }, /mwezi|month/i);
  await bad({ period: '2026-9', scope: 'agent', name: 'ASHA', qty: 5 }, /mwezi|month/i);
  await bad({ period: MONTH, scope: 'region', name: 'ASHA', qty: 5 }, /aina|scope/i);
  await bad({ period: MONTH, scope: 'agent', qty: 5 }, /jina|name/i);
  await bad({ period: MONTH, scope: 'agent', name: 'ASHA' }, /idadi au kiasi|quantity or an amount/i);
  await bad({ period: MONTH, scope: 'agent', name: 'ASHA', qty: -1 }, /idadi|quantity/i);
  await bad({ period: MONTH, scope: 'agent', name: 'ASHA', amount: -5 }, /kiasi|amount/i);
  assert.equal(d._dump('sales_targets').length, 1, 'and nothing was written');
  // Removing is not the same as setting zero: gone means nobody has said.
  await _FNS.targetDelete(d, SETTER, { period: MONTH, scope: 'agent', name: 'ASHA' });
  assert.equal(d._dump('sales_targets').length, 0);
  await assert.rejects(() => _FNS.targetDelete(d, SETTER, { period: MONTH, scope: 'agent' }), e => e.status === 400);
  await assert.rejects(() => _FNS.targetDelete(d, SETTER, { scope: 'agent', name: 'ASHA' }), e => e.status === 400);
});

/* ---------------------------------------------------------------------------------------- */
test('targets: who an agent reports to is one editable field on the staff register', async () => {
  const d = fakeDb({ hoop_agents: [
    { phone: '0712000001', name: 'ASHA', role: 'Field_Officer', branch: 'DAR', manager: null, active: true },
    { phone: '0712000002', name: 'SIMON', role: 'Regional_Manager', branch: 'DAR', manager: null, active: true },
  ] });
  const r = await _FNS.staffManager(d, HR, { phone: '0712000001', manager: ' PETER MWERA ' });
  assert.equal(r.manager, 'PETER MWERA');
  assert.equal(d._dump('hoop_agents').find(x => x.phone === '0712000001').manager, 'PETER MWERA');
  // Blank clears the override and hands the question back to the branch.
  await _FNS.staffManager(d, HR, { phone: '0712000001', manager: '' });
  assert.equal(d._dump('hoop_agents').find(x => x.phone === '0712000001').manager, null);
  await assert.rejects(() => _FNS.staffManager(d, HR, { phone: '0799999999', manager: 'X' }),
    e => e.status === 400 && /hayupo|not in the register/i.test(e.message));
  await assert.rejects(() => _FNS.staffManager(d, HR, { manager: 'X' }), e => e.status === 400);
  // It rides on the staff nav, not the targets one.
  await assert.rejects(() => _FNS.staffManager(d, SETTER, { phone: '0712000001', manager: 'X' }), e => e.status === 403);
  // And the directory hands it back so the pane can show it.
  const dir = await _FNS.staffDirectory(d, HR);
  assert.equal(dir.staff.find(x => x.name === 'ASHA').manager, '');
});

test('targets: before the migrations, every pane still opens', async () => {
  // The targets table is absent: the sales still count, and the pane says which file to run.
  const noTable = fakeDb({ watu_loans: [loan('ASHA')], hoop_agents: [agent('ASHA', 'Field_Officer', 'DAR')] },
    { missingColumns: { sales_targets: ['period'] } });
  const r = await _FNS.targetsView(noTable, SETTER, { period: MONTH });
  assert.equal(r.notReady, true);
  assert.equal(r.totals.sales, 1, 'the month is still counted -- only the targets are missing');
  await assert.rejects(() => _FNS.targetSave(noTable, SETTER, { period: MONTH, scope: 'agent', name: 'ASHA', qty: 1 }),
    e => e.status === 400 && /RUN-ME-2026-09-09-targets\.sql/.test(e.message));
  /* targetDelete goes down the same tableMissing branch in production, but a FILTERED delete
     is the one shape this fake cannot refuse -- it has no schema to check the filter against,
     so it matches nothing and reports success. Asserted here as far as the fake can go: the
     delete is harmless when there is nothing to delete. */
  assert.equal((await _FNS.targetDelete(noTable, SETTER, { period: MONTH, scope: 'agent', name: 'ASHA' })).ok, true);
  // The register has no `manager` column yet: the branch fallback carries the roll-up.
  const noCol = fakeDb({ watu_loans: [loan('ASHA')], sales_targets: [],
    hoop_agents: [{ name: 'ASHA', role: 'Field_Officer', branch: 'DAR', active: true },
      { name: 'SIMON', role: 'Regional_Manager', branch: 'DAR', active: true }] },
    { missingColumns: { hoop_agents: ['manager'] } });
  const r2 = await _FNS.targetsView(noCol, SETTER, { period: MONTH });
  assert.equal(r2.rows.agent.find(x => x.name === 'ASHA').manager, 'SIMON');
  const dir = await _FNS.staffDirectory(noCol, HR);
  assert.equal(dir.staff.length, 2, 'and the staff pane does not go dark over one missing column');
  assert.equal(dir.staff[0].manager, '');
  // watu_loans without `branch` -- the same shape salesWeek already survives.
  const noBranch = fakeDb({ sales_targets: [], hoop_agents: [],
    watu_loans: [{ imei: 'I1', disbursed_date: '2026-09-10', price: 400000, agent: 'ASHA', team: 'KINONDONI' }] },
    { missingColumns: { watu_loans: ['branch'] } });
  const r3 = await _FNS.targetsView(noBranch, SETTER, { period: MONTH });
  assert.equal(r3.totals.sales, 1);
  assert.equal(r3.rows.branch[0].name, 'KINONDONI', 'the team stands in for the branch');
});
