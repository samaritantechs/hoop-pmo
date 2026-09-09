import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';

/* =========================================================================================
   LOSS AND DAMAGE -- the price list, the case, and the acknowledgement of liability.

     Finance SOP H     valuation, liability and recovery, handled centrally by Finance
     Finance SOP H.1   the root cause; "A police report is REQUIRED for suspected theft"
     Finance SOP H.2   "The Finance Officer values the missing/damaged device using the
                        CURRENT PRICE LIST"
     Finance SOP H.3   the custodian is liable and must reimburse at the assessed value
     Finance SOP H.4   the recovery method, approved by the GM and Finance
     Finance SOP H.5   "The custodian SIGNS an acknowledgment of liability and repayment plan"
     Store SOP C.7     the store's verification opens the case
     RSM SOP F, CSM SOP G   the custodian named, at the device's prevailing value

   Four SOPs point at one process and none of them could open a case, because there was
   nowhere to open one.

   THE PERMISSION IS THE NAV, as everywhere here.
   ========================================================================================= */
const KEEPER = { code: 'S1', name: 'SIPHO K', role: 'OFFICER', teams: null, tabs: ['lossreq'], readOnly: false };
const FIN = { code: 'F1', name: 'JANETH', role: 'OFFICER', teams: null, tabs: ['loss'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['loss', 'lossreq'], readOnly: true };
const OTHER = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const aCase = o => ({ id: o.id, opened_at: o.at || '2026-09-05T06:00:00Z',
  staff_code: o.code || 'S1', staff_name: o.name || 'SIPHO K', staff_role: 'OFFICER',
  custodian: o.custodian || 'ANOLD SAWE', imei: o.imei || '351388334583295', item: o.item || 'A07',
  cause: o.cause || 'negligence', police_ref: o.policeRef || null, details: null,
  value_amount: o.value == null ? null : o.value, value_source: o.value == null ? null : 'price list A07',
  recovery_method: o.method || null, recovery_note: null,
  approved_by: null, approved_at: null,
  acknowledged_by: o.ackBy || null, acknowledged_at: o.ackAt || null,
  status: o.status || (o.value == null ? 'open' : 'valued'), recovered: o.recovered || 0,
  settled_at: null, updated_by: 'SIPHO K', updated_at: o.updatedAt || o.at || '2026-09-05T06:00:00Z' });
const lossDb = (o = {}) => fakeDb({
  loss_cases: o.cases || [], loss_case_notes: o.notes || [], device_prices: o.prices || [],
  watu_loans: o.loans || [], settings: o.settings || [],
});
function captureMail() {
  const sent = [];
  const prev = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  _setFetch(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ id: 'msg_' + sent.length }) };
  });
  return { sent, restore() { _setFetch(null); if (prev == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; } };
}
const GOOD = { custodian: 'ANOLD SAWE', item: 'A07', imei: '351388334583295', cause: 'negligence' };

/* ---------------------------------------------------------------------------------------- */
test('loss: reporting and working a case are two grants, and the price list is the desk\'s', async () => {
  const d = lossDb({ cases: [aCase({ id: uid('c1') })] });
  const denied = async (fn, user, args) => {
    await assert.rejects(() => _FNS[fn](d, user, args || {}), e => e.status === 403,
      fn + ' must refuse a user who was never granted its pane');
  };
  await denied('lossList', OTHER); await denied('priceList', OTHER);
  await denied('lossRaise', OTHER, GOOD);
  // The store keeper reports and reads their own; the price list is Finance's to set.
  await denied('priceSave', KEEPER, { item: 'A07', amount: 1 });
  await denied('priceDelete', KEEPER, { item: 'A07' });
  assert.ok((await _FNS.priceList(d, KEEPER)).prices, 'but they can read it');
  // View-only reads both panes and writes nothing.
  assert.ok(Array.isArray((await _FNS.lossList(d, VIEWER, {})).rows));
  for (const [fn, args] of [['lossRaise', GOOD], ['lossUpdate', { id: uid('c1'), note: 'x' }],
    ['priceSave', { item: 'A07', amount: 1 }]]) {
    await assert.rejects(() => _FNS[fn](d, VIEWER, args), e => e.status >= 400 && e.status < 500, fn);
  }
  assert.equal(d._dump('loss_cases').length, 1);
  assert.ok((await _FNS.lossList(d, OWNER, {})).rows, 'ADMIN IS FULL ACCESS EVERYWHERE');
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const m = /const NAV_TABS = \[([^\]]+)\]/.exec(src);
  for (const k of ['lossreq', 'loss']) assert.ok(m[1].includes(`'${k}'`), k + ' is a nav the owner can tick');
  for (const fn of ['lossRaise', 'lossUpdate', 'priceSave', 'priceDelete']) {
    assert.match(src, new RegExp("AUDITED\\.add\\('" + fn + "'\\)"), fn + ' is audited');
  }
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-09-loss-damage.sql', import.meta.url), 'utf8');
  for (const t of ['device_prices', 'loss_cases', 'loss_case_notes']) {
    assert.match(sql, new RegExp('create table if not exists ' + t + ' \\('), t + ' is created idempotently');
  }
  for (const c of ['negligence', 'unresolved_sale', 'incident', 'theft']) assert.ok(sql.includes(`'${c}'`));
});

/* ---------------------------------------------------------------------------------------- */
test('H.1: theft needs a police report, and the four causes are the SOP\'s four', async () => {
  const d = lossDb();
  await assert.rejects(() => _FNS.lossRaise(d, KEEPER, { ...GOOD, cause: 'theft' }),
    e => e.status === 400 && /H\.1/.test(e.message) && /polisi|police/i.test(e.message));
  assert.equal(d._dump('loss_cases').length, 0, 'and nothing was opened');
  const ok = await _FNS.lossRaise(d, KEEPER, { ...GOOD, cause: 'theft', policeRef: 'DAR/RB/1234' });
  assert.ok(ok.id);
  assert.equal(d._dump('loss_cases')[0].police_ref, 'DAR/RB/1234');
  // The other three causes need no report.
  for (const cause of ['negligence', 'unresolved_sale', 'incident']) {
    await _FNS.lossRaise(d, KEEPER, { ...GOOD, cause });
  }
  assert.equal(d._dump('loss_cases').length, 4);
  await assert.rejects(() => _FNS.lossRaise(d, KEEPER, { ...GOOD, cause: 'gremlins' }),
    e => e.status === 400 && /chanzo|root cause/i.test(e.message));
  await assert.rejects(() => _FNS.lossRaise(d, KEEPER, { custodian: 'X' }), e => e.status === 400);
  await assert.rejects(() => _FNS.lossRaise(d, KEEPER, { cause: 'negligence' }),
    e => e.status === 400 && /aliyekuwa|custodian/i.test(e.message));
  await assert.rejects(() => _FNS.lossRaise(d, KEEPER, { ...GOOD, imei: '123' }),
    e => e.status === 400 && /IMEI/.test(e.message));
});

test('H.2: a case is valued from the CURRENT price list, and the figure is copied onto it', async () => {
  const cap = captureMail();
  try {
    const d = lossDb({ prices: [{ item: 'A07', amount: 450000 }, { item: 'A06', amount: 380000 }],
      settings: [{ key: 'LOSS_EMAIL', value: 'gm@hoop.co.tz' }] });
    const r = await _FNS.lossRaise(d, KEEPER, GOOD);
    assert.equal(r.value, 450000); assert.equal(r.status, 'valued');
    const [row] = d._dump('loss_cases');
    assert.equal(row.value_amount, 450000);
    assert.match(row.value_source, /price list A07/, 'and it says where the figure came from');
    assert.equal(row.staff_code, 'S1', 'stamped from the access code');
    assert.equal(row.recovered, 0);
    // The GM hears the same day (Store SOP C.7, RSM SOP A.7).
    assert.equal(r.emailed, true);
    const b = JSON.stringify(cap.sent[0].body);
    assert.ok(b.includes('gm@hoop.co.tz'));
    assert.match(cap.sent[0].body.subject, /ANOLD SAWE/);
    assert.ok(b.includes('450,000'), 'the value travels with the notice');
    /* CHANGING THE PRICE MUST NOT RE-PRICE A CASE ALREADY OPENED. */
    await _FNS.priceSave(d, FIN, { item: 'A07', amount: 500000 });
    assert.equal(d._dump('loss_cases')[0].value_amount, 450000, 'the opened case keeps its figure');
    const later = await _FNS.lossRaise(d, KEEPER, GOOD);
    assert.equal(later.value, 500000, 'but a new case gets the new price');
    // A model nobody has priced opens UNVALUED rather than at zero.
    const un = await _FNS.lossRaise(d, KEEPER, { ...GOOD, item: 'S24' });
    assert.equal(un.value, null); assert.equal(un.status, 'open');
    const unrow = d._dump('loss_cases').find(x => x.item === 'S24');
    assert.equal(unrow.value_amount, null);
  } finally { cap.restore(); }
});

test('H.5: nobody signs for a number nobody has worked out', async () => {
  const d = lossDb({ cases: [aCase({ id: uid('u1'), value: null, status: 'open' })] });
  await assert.rejects(() => _FNS.lossUpdate(d, FIN, { id: uid('u1'), acknowledgedBy: 'Anold Sawe' }),
    e => e.status === 400 && /H\.2/.test(e.message) && /H\.5/.test(e.message));
  assert.equal(d._dump('loss_cases')[0].acknowledged_by, null);
  // Value it, and the signature is accepted.
  const r = await _FNS.lossUpdate(d, FIN, { id: uid('u1'), value: 450000, acknowledgedBy: 'Anold Sawe',
    recoveryMethod: 'salary_deduction', recoveryNote: 'TZS 90,000 kwa miezi 5', note: 'Amekubali' });
  assert.equal(r.status, 'acknowledged');
  const [row] = d._dump('loss_cases');
  assert.equal(row.value_amount, 450000);
  assert.match(row.value_source, /assessed by JANETH/, 'a hand valuation says who made it');
  assert.equal(row.acknowledged_by, 'Anold Sawe'); assert.ok(row.acknowledged_at);
  assert.equal(row.recovery_method, 'salary_deduction');
  assert.equal(row.approved_by, 'JANETH', 'SOP H.4: who approved the recovery method');
  // Every move leaves a note behind it.
  const notes = d._dump('loss_case_notes');
  assert.equal(notes.length, 1); assert.equal(notes[0].note, 'Amekubali');
  assert.match(String(notes[0].change), /acknowledged/);
  await assert.rejects(() => _FNS.lossUpdate(d, FIN, { id: uid('u1'), recoveryMethod: 'barter' }), e => e.status === 400);
});

test('H.3: money in, and a case settles itself when the debt is met', async () => {
  const d = lossDb({ cases: [aCase({ id: uid('m1'), value: 450000, status: 'acknowledged' })] });
  // Part payment: recovering, and the outstanding figure is what is left.
  await _FNS.lossUpdate(d, FIN, { id: uid('m1'), recovered: 200000, note: 'Awamu ya kwanza' });
  let list = await _FNS.lossList(d, FIN, {});
  assert.equal(list.rows[0].status, 'recovering');
  assert.equal(list.rows[0].outstanding, 250000);
  assert.equal(list.totals.outstanding, 250000);
  assert.equal(list.totals.recovered, 200000);
  // Never more than the phone was worth.
  await assert.rejects(() => _FNS.lossUpdate(d, FIN, { id: uid('m1'), recovered: 500000 }),
    e => e.status === 400 && /zaidi ya thamani|more than the device was valued/i.test(e.message));
  // Meeting the value settles it, without anybody choosing "settled".
  const done = await _FNS.lossUpdate(d, FIN, { id: uid('m1'), recovered: 450000 });
  assert.equal(done.status, 'settled');
  const [row] = d._dump('loss_cases');
  assert.ok(row.settled_at);
  // A settled case leaves the live totals.
  list = await _FNS.lossList(d, FIN, {});
  assert.equal(list.totals.outstanding, 0);
  assert.deepEqual(list.rows, [], 'and drops off the live list');
  assert.equal((await _FNS.lossList(d, FIN, { state: 'all' })).rows.length, 1);
  // Writing a debt off takes a reason.
  const d2 = lossDb({ cases: [aCase({ id: uid('w1'), value: 450000 })] });
  await assert.rejects(() => _FNS.lossUpdate(d2, FIN, { id: uid('w1'), status: 'written_off' }),
    e => e.status === 400 && /sababu|why/i.test(e.message));
  await _FNS.lossUpdate(d2, FIN, { id: uid('w1'), status: 'written_off', note: 'Simu imepatikana' });
  assert.equal(d2._dump('loss_cases')[0].status, 'written_off');
});

test('loss: the desk sees every case, the reporter only their own, and two desks cannot clash', async () => {
  const d = lossDb({ cases: [
    aCase({ id: uid('a'), code: 'S1', value: 450000 }),
    aCase({ id: uid('b'), code: 'S2', name: 'MWINGINE', custodian: 'OTHER RSM', value: 380000 }),
  ] });
  assert.equal((await _FNS.lossList(d, FIN, {})).rows.length, 2);
  assert.equal((await _FNS.lossList(d, FIN, {})).desk, true);
  const mine = await _FNS.lossList(d, KEEPER, {});
  assert.equal(mine.rows.length, 1); assert.equal(mine.rows[0].id, uid('a'));
  assert.equal(mine.desk, false);
  assert.ok(mine.rows[0].mine);
  // A reporter may add a note to their own and change nothing else.
  const r = await _FNS.lossUpdate(d, KEEPER, { id: uid('a'), note: 'Nimeongea na RSM',
    value: 1, status: 'settled', acknowledgedBy: 'me' });
  assert.equal(r.change, null);
  const own = d._dump('loss_cases').find(x => x.id === uid('a'));
  assert.equal(own.value_amount, 450000); assert.equal(own.status, 'valued');
  assert.equal(own.acknowledged_by, null);
  assert.equal(d._dump('loss_case_notes').length, 1);
  // Somebody else's case reads as not there.
  await assert.rejects(() => _FNS.lossUpdate(d, KEEPER, { id: uid('b'), note: 'x' }),
    e => e.status === 400 && /haipo|no longer exists/i.test(e.message));
  await assert.rejects(() => _FNS.lossNotes(d, KEEPER, { id: uid('b') }), e => e.status === 400);
  assert.equal((await _FNS.lossNotes(d, FIN, { id: uid('a') })).notes.length, 1);
  // Two desks, one row: the second is told to reopen it rather than overwriting.
  const race = lossDb({ cases: [aCase({ id: uid('r1'), value: 450000, updatedAt: '2026-09-05T06:00:00Z' })] });
  const raw = race.from.bind(race);
  race.from = name => {
    const q = raw(name);
    if (name === 'loss_cases') {
      const u = q.update.bind(q);
      q.update = p => { race._dump('loss_cases')[0].updated_at = '2026-09-05T07:00:00Z'; return u(p); };
    }
    return q;
  };
  await assert.rejects(() => _FNS.lossUpdate(race, FIN, { id: uid('r1'), recovered: 1000, note: 'x' }),
    e => e.status === 400 && /mtu mwingine|Somebody else/i.test(e.message));
  assert.equal(race._dump('loss_case_notes').length, 0, 'and no note claims a move that did not happen');
});

test('loss: the price list is edited from the desk', async () => {
  const d = lossDb({ loans: [{ imei: 'I1', model: 'A07' }, { imei: 'I2', model: 'A06' }] });
  await _FNS.priceSave(d, FIN, { item: ' a07 ', amount: '450000', note: 'Watu list Sep' });
  const [p] = d._dump('device_prices');
  assert.equal(p.item, 'A07'); assert.equal(p.amount, 450000); assert.equal(p.updated_by, 'JANETH');
  await _FNS.priceSave(d, FIN, { item: 'A07', amount: 460000 });
  assert.equal(d._dump('device_prices').length, 1, 'saving again corrects rather than duplicating');
  assert.equal(d._dump('device_prices')[0].amount, 460000);
  const list = await _FNS.priceList(d, FIN);
  assert.equal(list.prices.length, 1);
  assert.deepEqual(list.items, ['A06', 'A07'], 'the models the book knows are offered');
  await assert.rejects(() => _FNS.priceSave(d, FIN, { item: 'A07' }), e => e.status === 400);
  await assert.rejects(() => _FNS.priceSave(d, FIN, { amount: 1 }), e => e.status === 400);
  await assert.rejects(() => _FNS.priceSave(d, FIN, { item: 'A07', amount: -1 }), e => e.status === 400);
  await _FNS.priceDelete(d, FIN, { item: 'A07' });
  assert.equal(d._dump('device_prices').length, 0);
});

test('loss: before the migration every pane says which file to run', async () => {
  const bare = fakeDb({ loss_cases: [], device_prices: [], loss_case_notes: [], watu_loans: [] },
    { missingColumns: { loss_cases: ['id'], device_prices: ['item'] } });
  assert.equal((await _FNS.lossList(bare, FIN, {})).notReady, true);
  assert.equal((await _FNS.priceList(bare, FIN)).notReady, true);
  assert.equal((await _FNS.lossNotes(bare, KEEPER, { id: uid('x') })).notReady, true);
  for (const [fn, user, args] of [
    ['lossRaise', KEEPER, GOOD],
    ['lossUpdate', FIN, { id: uid('x'), note: 'x' }],
    ['priceSave', FIN, { item: 'A07', amount: 1 }],
  ]) {
    await assert.rejects(() => _FNS[fn](bare, user, args),
      e => e.status === 400 && /RUN-ME-2026-09-09-loss-damage\.sql/.test(e.message), fn + ' names the migration');
  }
});
