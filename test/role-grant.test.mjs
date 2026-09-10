import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { resolveTabs, USER_TABS } from '../api/_lib/auth.js';

/* =========================================================================================
   THE ROLE'S TICKS ARE THE GRANT.

     "Roles enrollment should be like of hopemo -- I just assign someone as RSM CREDIT STORE
      etc and they get the roles I assigned; their navs by ticking and not the whole dept"

   Two separate fallbacks used to fire when a role had nothing ticked, and between them they
   handed out panes nobody chose:

     resolveTabs   an empty merged list fell back to USER_TABS -- the OLD vocabulary
     navsFor       a `chosen` list of only dashboard/settings fell back to LEGACY_NAVS

   Three words of that old vocabulary are still live nav keys, and one of them is COMMISSION.
   So creating a role called STORE, ticking nothing on it yet, and handing somebody that code
   gave them the pane that builds sheets, sets rates and pays agents. Nobody ticked it and
   nothing on any screen said so.

   Both fallbacks stay -- a code saved before panes were choosable must not go dark on a
   deploy day -- but each now fires only for the case it was written for.
   ========================================================================================= */
const U = (role, tabs) => ({ code: 'C1', name: 'Mtu', role, teams: null, tabs, readOnly: false });
const ADMIN = U('ADMIN', ['settings']);
const VIEWER = { ...U('AUDITOR', []), readOnly: true };
const emptyDb = () => fakeDb({
  watu_snapshots: [], followup_status: [], watu_loans: [], settings: [],
  roles: [], access_codes: [], hoop_agents: [], hoop_aged_stock: [], commission_rates: [],
});

/* ---------------------------------------------------------------------------------------- */
test('the old vocabulary really does overlap the live navs -- this is why the fallback bit', () => {
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const navTabs = /const NAV_TABS = \[([^\]]+)\]/.exec(api)[1]
    .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  const overlap = USER_TABS.filter(t => navTabs.includes(t));
  /* If this ever comes back empty the bug below is gone on its own and these tests are
     documenting history rather than guarding anything -- which is worth knowing. */
  assert.ok(overlap.includes('commission'),
    'COMMISSION is in the old vocabulary AND is a live nav: that is the whole hazard');
  assert.ok(overlap.includes('dashboard') && overlap.includes('reports'));
});

test('a role that exists and ticks nothing grants nothing -- it no longer hands out Commission', async () => {
  /* THE ROW IS THE EVIDENCE OF A DECISION. Somebody made this role and has not ticked it
     yet; that is an answer, and the answer is nothing. */
  const configuredButEmpty = resolveTabs(U('STORE', []), [], true);
  assert.deepEqual(configuredButEmpty, [], 'a configured role with no ticks resolves to nothing');

  const nobody = U('STORE', []);
  const db = emptyDb();
  for (const [fn, args] of [['commRates', {}], ['customers', {}], ['recovery', {}], ['staffDirectory', {}]]) {
    await assert.rejects(() => _FNS[fn](db, nobody, args), /no access to the \w+ pane/,
      fn + ' must not open for a role nobody has ticked');
  }
});

test('the ticks are the grant, exactly -- one pane means one pane', async () => {
  const db = emptyDb();
  const store = U('STORE', ['stockreq']);
  assert.equal((await _FNS.stockMine(db, store)).ok, true, 'the ticked pane opens');
  for (const [fn, args] of [['customers', {}], ['recovery', {}], ['staffDirectory', {}], ['commRates', {}]]) {
    await assert.rejects(() => _FNS[fn](db, store, args), /no access to the \w+ pane/,
      fn + ' was not ticked, so it does not open');
  }

  /* TICKING ONLY DASHBOARD USED TO GRANT FIVE PANES. `chosen` came back as just ['dashboard'],
     which the old guard read as "nothing deliberate here" and answered with the legacy
     defaults -- Customers, Call reports, Recovery and Staff. That is the "whole dept". */
  const dashOnly = U('CLERK', ['dashboard']);
  for (const [fn, args] of [['customers', {}], ['recovery', {}], ['staffDirectory', {}]]) {
    await assert.rejects(() => _FNS[fn](db, dashOnly, args), /no access to the \w+ pane/,
      'ticking Dashboard grants Dashboard and nothing beside it');
  }
});

test('a code from before panes were choosable keeps every door it had', async () => {
  const db = emptyDb();
  /* THE CASE BOTH FALLBACKS EXIST FOR. USER_TABS is what a never-configured code resolves to,
     and it is full of words this system can no longer offer to tick -- followup, par,
     present, weekly. A row carrying one of those was saved back then. */
  assert.deepEqual(resolveTabs(U('MANAGER', []), null, false), USER_TABS,
    'no roles row at all means nobody has ever configured this role');

  const legacy = U('MANAGER', USER_TABS.slice());
  assert.equal((await _FNS.customers(db, legacy, {})).ok, true, 'yesterday’s code still works today');
  assert.equal((await _FNS.recovery(db, legacy, {})).ok, true);

  // The old ACTION words count too: upload and audit were never navs and cannot be ticked.
  const oldAdminish = U('MANAGER', ['upload', 'settings']);
  assert.equal((await _FNS.customers(db, oldAdminish, {})).ok, true);
  assert.equal((await _FNS.salesAudit(db, oldAdminish, {})).ok, true, 'upload still opened the fraud pane');
});

test('the two stored aliases still expand, and are not mistaken for old vocabulary', async () => {
  const db = emptyDb();
  const sales = U('RSM', ['sales']);
  assert.equal((await _FNS.salesAudit(db, sales, {})).ok, true);
  assert.equal((await _FNS.stockView(db, sales, {})).ok, true);
  /* An alias is a grant this system still hands out, so it must NOT drag the legacy defaults
     along with it -- that would be the whole-department problem wearing a different hat. */
  await assert.rejects(() => _FNS.customers(db, sales, {}), /no access to the customers pane/);
  await assert.rejects(() => _FNS.staffDirectory(db, sales, {}), /no access to the staff pane/);

  const devices = U('STORE', ['devices']);
  assert.equal((await _FNS.deviceList(db, devices, {})).ok, true, 'the legacy device grant still opens both');
  await assert.rejects(() => _FNS.customers(db, devices, {}), /no access to the customers pane/);
});

test('ADMIN and AUDITOR are untouched by any of it', async () => {
  const db = emptyDb();
  assert.deepEqual(resolveTabs(U('ADMIN', []), [], true).includes('settings'), true);
  assert.equal((await _FNS.customers(db, ADMIN, {})).ok, true, 'ADMIN IS FULL ACCESS EVERYWHERE');
  assert.equal((await _FNS.commRates(db, ADMIN)).ok, true);
  assert.equal((await _FNS.customers(db, VIEWER, {})).ok, true, 'supervision sees every pane');
  await assert.rejects(() => _FNS.saveRole(db, VIEWER, { role: 'X', tabs: [] }), /kuangalia tu|view-only/i,
    'and changes none of it');
});

test('the editor is told which panes exist, and a role saves exactly what was ticked', async () => {
  const db = emptyDb();
  const out = await _FNS.accessCodes(db, ADMIN, {});
  assert.ok(out.navTabs.includes('stockreq') && out.navTabs.includes('devlock'));
  assert.ok(!out.navTabs.includes('devices'), 'the old single device grant is no longer offered');

  await _FNS.saveRole(db, ADMIN, { role: 'STORE', tabs: ['stockappr', 'devlock', 'nonsense'] });
  const row = db._dump('roles').find(x => x.role === 'STORE');
  assert.deepEqual(row.tabs, ['stockappr', 'devlock'], 'a word that is not grantable is dropped');

  /* An alias somebody's role still carries survives a re-save: dropping it would quietly take
     a pane away from everybody holding that role. */
  await _FNS.saveRole(db, ADMIN, { role: 'OLD', tabs: ['sales', 'devices'] });
  assert.deepEqual(db._dump('roles').find(x => x.role === 'OLD').tabs, ['sales', 'devices']);

  // A role saved with nothing is a role that opens nothing -- and the pane says so.
  await _FNS.saveRole(db, ADMIN, { role: 'NEW', tabs: [] });
  const after = await _FNS.accessCodes(db, ADMIN, {});
  assert.deepEqual(after.roles.find(r => r.role === 'NEW').tabs, []);
});

test('a never-configured code keeps its doors and does NOT collect Commission on the way', async () => {
  const db = emptyDb();
  /* THE HOLE THE DERIVED LIST CLOSED. resolveTabs answers USER_TABS for a role with no row at
     all; `reports` is in that list and is also a live nav, so the old guard read the whole
     thing as a deliberate choice and returned dashboard + reports + COMMISSION. Nobody had
     ticked anything for this person. */
  const neverConfigured = U('SOMEONE NEW', USER_TABS.slice());
  await assert.rejects(() => _FNS.commRates(db, neverConfigured), /no access to the commission pane/,
    'money is never a default');
  // And what the fallback exists to protect is still protected.
  assert.equal((await _FNS.customers(db, neverConfigured, {})).ok, true);
  assert.equal((await _FNS.recovery(db, neverConfigured, {})).ok, true);
  assert.equal((await _FNS.staffDirectory(db, neverConfigured)).ok, true);
});

test('a deliberate tick of an ambiguous nav is still honoured', async () => {
  const db = emptyDb();
  /* The other side of the same coin: `commission` being an old word must not make a MODERN
     tick of it unreadable. A Finance role ticked exactly Commission gets exactly Commission. */
  const finance = U('FINANCE', ['commission']);
  assert.equal((await _FNS.commRates(db, finance)).ok, true, 'ticked on purpose, granted');
  await assert.rejects(() => _FNS.customers(db, finance, {}), /no access to the customers pane/,
    'and nothing else came with it');
});
