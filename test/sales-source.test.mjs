import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { todayKey, addDaysKey } from '../api/_lib/time.js';

/* =========================================================================================
   WHO SOLD IT IS THE DECK'S ANSWER.

     "I said we trace sales in the watu deck uploaded by credits"

   There are two books about the same phones:

     watu_loans   the WATU DECK, uploaded by credits. Who financed the handset, keyed on the
                  agent Watu itself credits, dated by disbursed_date.
     hoop_sales   the SHOP's own book from hoopltd.shop, keyed on the payout phone written
                  against each receipt -- who the shop intended to PAY.

   Everywhere that matters already drove off the deck: targetsView measures achievement
   against watu_loans, and commBuild builds the sheet from watu_loans and treats a shop
   disagreement as a DISPUTE that is not paid this cycle. The agent scorecard was the odd one
   out -- its SALES column counted receipts -- so an agent could look busy on phones the loan
   book had never heard of.

   THE SHOP BOOK IS NOT DROPPED. A blind spot traded for another blind spot is not a fix: the
   gap between the two books is the most interesting number on the row, so it is a column.
   salesAudit keeps reading both by design -- comparing them IS that pane's whole job.
   ========================================================================================= */
const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
const TODAY = todayKey();
const D = n => addDaysKey(TODAY, n);

const loan = o => ({
  imei: o.imei, agent: o.agent, agent_id: o.id || null, team: 'KINONDONI', branch: 'ILALA',
  price: o.price == null ? 500000 : o.price,
  has_ever_paid: true, locked4: false, locked7: false, days_offline: 1,
  disbursed_date: o.day || D(-5),
});
const receipt = o => ({
  sale_key: o.key, sale_date: o.day || D(-5), receipt_number: o.key, client_name: 'Mteja',
  client_phone: '0712000000', imei: o.imei, model: 'A07', price: o.price == null ? 500000 : o.price,
  agent: o.agent, commission_agent: o.agent, commission_phone: o.phone || '',
});
const scoreDb = (o = {}) => fakeDb({
  watu_loans: o.loans || [], hoop_sales: o.sales || [], hoop_agents: o.agents || [],
});

/* ---------------------------------------------------------------------------------------- */
test('the scorecard counts the deck, and says which book it counted', async () => {
  const db = scoreDb({
    loans: [loan({ imei: 'I1', agent: 'JUMA G', id: '11', price: 500000 }),
      loan({ imei: 'I2', agent: 'JUMA G', id: '11', price: 400000 })],
    sales: [receipt({ key: 'R1', imei: 'I1', agent: 'JUMA G', phone: '0712000001' })],
    agents: [{ phone: '0712000001', name: 'JUMA G', role: 'Field_Officer', branch: 'ILALA' }],
  });
  const d = await _FNS.agentScore(db, ADMIN, { from: D(-30), to: TODAY });
  assert.equal(d.salesSource, 'watu_loans', 'a column headed "sales" must say which book it is');
  const juma = d.sellers.find(s => s.name === 'JUMA G');
  assert.equal(juma.sales, 2, 'the deck credits him with two');
  assert.equal(juma.amount, 900000, 'and the amount is the deck’s own price');
  assert.equal(juma.shopSales, 1, 'the shop wrote one receipt');
  assert.equal(juma.drift, 1);
});

test('a seller the shop pays and the deck has never heard of is a row, not a silence', async () => {
  const db = scoreDb({
    loans: [loan({ imei: 'I1', agent: 'JUMA G' })],
    sales: [receipt({ key: 'R1', imei: 'GHOST1', agent: 'ELIA C', phone: '0757578866' }),
      receipt({ key: 'R2', imei: 'GHOST2', agent: 'ELIA C', phone: '0757578866' })],
  });
  const d = await _FNS.agentScore(db, ADMIN, { from: D(-30), to: TODAY });
  const elia = d.sellers.find(s => s.name === 'ELIA C');
  assert.ok(elia, 'dropping them would hide exactly what tracing the deck is for');
  assert.equal(elia.sales, 0);
  assert.equal(elia.shopSales, 2);
  assert.equal(elia.shopOnly, true);
  assert.equal(elia.reg, null, 'not in the register either -- shown as such, never invented');
  assert.equal(d.totals.shopOnly, 1);
});

test('both books land on one row for one human, resolved through the register', async () => {
  /* The deck spells a name its own way and the shop writes a payout phone. A register hit is
     the only spelling both books can be pulled onto, so it wins -- the same resolution
     commBuild uses when it decides whether a phone is disputed. */
  const db = scoreDb({
    loans: [loan({ imei: 'I1', agent: 'Cyprian Dotto Renatus' })],
    sales: [receipt({ key: 'R1', imei: 'I1', agent: 'CYPRIAN RENATUS', phone: '0780866571' })],
    agents: [{ phone: '0780866571', name: 'Cyprian Dotto Renatus', role: 'Field_Officer', branch: 'ILALA' }],
  });
  const d = await _FNS.agentScore(db, ADMIN, { from: D(-30), to: TODAY });
  assert.equal(d.sellers.length, 1, 'one human, one row');
  assert.equal(d.sellers[0].sales, 1);
  assert.equal(d.sellers[0].shopSales, 1);
  assert.equal(d.sellers[0].drift, 0);
  assert.equal(d.sellers[0].reg.name, 'Cyprian Dotto Renatus');
});

test('the deck half honours the window, the same one the shop half is read for', async () => {
  const db = scoreDb({
    loans: [loan({ imei: 'IN', agent: 'JUMA G', day: D(-5) }),
      loan({ imei: 'OUT', agent: 'JUMA G', day: D(-200) })],
  });
  const d = await _FNS.agentScore(db, ADMIN, { from: D(-30), to: TODAY });
  assert.equal(d.sellers.find(s => s.name === 'JUMA G').sales, 1,
    'a loan from six months ago is not this period’s sale');
  /* The portfolio half is deliberately NOT windowed -- how somebody's customers behave is a
     fact about their whole book -- so both loans still count there. */
  assert.equal(d.watuAgents.find(a => a.agent === 'JUMA G').customers, 2);
});

test('a deck row with no agent named is still counted, and says so', async () => {
  const db = scoreDb({ loans: [loan({ imei: 'I1', agent: '' })] });
  const d = await _FNS.agentScore(db, ADMIN, { from: D(-30), to: TODAY });
  /* A total that does not match the board is a total nobody trusts, so an unattributed phone
     is named rather than dropped. */
  const nobody = d.sellers.find(s => /hakuna ajenti|no agent/i.test(s.name));
  assert.ok(nobody, 'an unattributed sale is visible, not silently missing');
  assert.equal(nobody.sales, 1);
  assert.equal(d.totals.deckSales, 1);
});

test('the panes that compare the two books still read both -- that is their job', () => {
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const fnSrc = name => {
    const at = api.indexOf('  async ' + name + '(');
    return api.slice(at, api.indexOf('\n  },', at));
  };
  /* salesAudit exists to hold the shop's book against the deck and name the drift; commBuild
     pays from the deck and refuses to pay a phone the shop credits to somebody else. Neither
     may quietly become single-source -- that would delete the check, not tidy it. */
  for (const fn of ['salesAudit', 'commBuild']) {
    const src = fnSrc(fn);
    assert.match(src, /from\('hoop_sales'\)/, fn + ' still reads the shop book');
    assert.match(src, /from\('watu_loans'\)/, fn + ' still reads the deck');
  }
  // And the ones that measure performance drive off the deck.
  for (const fn of ['targetsView', 'agentScore']) {
    assert.match(fnSrc(fn), /from\('watu_loans'\)/, fn + ' measures against the deck');
  }
  assert.match(fnSrc('agentScore'), /salesSource: 'watu_loans'/);
});
