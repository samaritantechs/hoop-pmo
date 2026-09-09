import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';

/* =========================================================================================
   TOP-UPS (CREDIT SALES) -- request, verify, pay, unlock.

     Finance SOP B.1  the request WITH proof of the client's upfront payment
     Finance SOP B.2  "VERIFY THE IMEI NUMBER before processing the payment"
     Finance SOP B.3  verify the payer's name against bank/mobile-money records
     Finance SOP B.4  calculate the balance to complete the full phone price
     Finance SOP B.5  "Send the top-up payment IMMEDIATELY so the system can unlock the device
                       for the client -- THIS STEP MUST NEVER BE DELAYED"
     Finance SOP B.6  confirm with the agent/client that the device has been unlocked
     Finance SOP B    the Top-Up Audit Checklist, filed against every transaction

   B.5 is the only step in any of these SOPs with the words "must never be delayed", and it is
   why this is a table rather than a WhatsApp thread: the only way to stop a customer's phone
   staying locked quietly is to make the waiting visible and count the minutes.

   THE PERMISSION IS THE NAV, as everywhere here.
   ========================================================================================= */
const AGENT = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['topupreq'], readOnly: false };
const FIN = { code: 'F1', name: 'JANETH', role: 'OFFICER', teams: null, tabs: ['topups'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['topupreq', 'topups'], readOnly: true };
const OTHER = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const IMEI = '351388334583295';
const minsAgo = n => new Date(Date.now() - n * 60000).toISOString();
const aTop = o => ({ id: o.id, requested_at: o.at || minsAgo(10),
  staff_code: o.code || 'A1', staff_name: o.name || 'JUMA G', staff_role: 'OFFICER',
  imei: o.imei || IMEI, customer: o.customer || 'Alafati', customer_phone: '0712000000',
  payer_name: o.payer || null, paid_amount: o.paid == null ? 100000 : o.paid, proof_ref: 'MPESA-1',
  price: o.price === undefined ? 450000 : o.price,
  balance: o.balance === undefined ? 350000 : o.balance,
  status: o.status || 'requested', comment: null,
  verified_by: o.verifiedBy || null, verified_at: o.verifiedAt || null,
  paid_by: null, paid_at: o.paidAt || null, payment_ref: o.ref || null,
  unlocked_by: null, unlocked_at: null,
  chk_request: false, chk_paid_to: false, chk_watu: false, chk_auditor: false,
  updated_by: 'JUMA G', updated_at: o.at || minsAgo(10) });
const tuDb = (o = {}) => fakeDb({
  topups: o.rows || [], watu_loans: o.loans || [], settings: o.settings || [],
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
const GOOD = { imei: IMEI, customer: 'Alafati', paidAmount: 100000, payerName: 'Alafati K', proofRef: 'MPESA-77' };
const VERIFY = { step: 'verify', imeiOk: true, payerOk: true };

/* ---------------------------------------------------------------------------------------- */
test('top-ups: asking and working them are two grants, and view-only moves nothing', async () => {
  const d = tuDb({ rows: [aTop({ id: uid('t1') })] });
  const denied = async (fn, user, args) => {
    await assert.rejects(() => _FNS[fn](d, user, args || {}), e => e.status === 403, fn);
  };
  await denied('topupQueue', AGENT);
  await denied('topupUpdate', AGENT, { id: uid('t1'), ...VERIFY });
  await denied('topupMine', FIN);
  await denied('topupRequest', OTHER, GOOD);
  await denied('topupQueue', OTHER);
  assert.ok(Array.isArray((await _FNS.topupQueue(d, VIEWER, {})).rows));
  for (const [fn, args] of [['topupRequest', GOOD], ['topupUpdate', { id: uid('t1'), ...VERIFY }]]) {
    await assert.rejects(() => _FNS[fn](d, VIEWER, args), e => e.status >= 400 && e.status < 500, fn);
  }
  assert.equal(d._dump('topups')[0].status, 'requested');
  assert.ok((await _FNS.topupQueue(d, OWNER, {})).rows, 'ADMIN IS FULL ACCESS EVERYWHERE');
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const m = /const NAV_TABS = \[([^\]]+)\]/.exec(src);
  for (const k of ['topupreq', 'topups']) assert.ok(m[1].includes(`'${k}'`), k + ' is a nav the owner can tick');
  for (const fn of ['topupRequest', 'topupUpdate']) {
    assert.match(src, new RegExp("AUDITED\\.add\\('" + fn + "'\\)"), fn + ' is audited');
  }
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-09-topups.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists topups \(/);
  for (const c of ['verified_at', 'paid_at', 'unlocked_at', 'chk_request', 'chk_paid_to', 'chk_watu', 'chk_auditor']) {
    assert.ok(sql.includes(c), c + ' is a column');
  }
});

/* ---------------------------------------------------------------------------------------- */
test('B.1/B.4: the request needs an IMEI and a payment, and the balance comes off the loan book', async () => {
  const cap = captureMail();
  try {
    const d = tuDb({ loans: [{ imei: IMEI, price: 450000, client_name: 'Alafati Kalikawe' }],
      settings: [{ key: 'TOPUP_EMAIL', value: 'fedha@hoop.co.tz' }] });
    const r = await _FNS.topupRequest(d, AGENT, { imei: ' 351388334583295 ', paidAmount: '100000',
      payerName: 'Alafati K', proofRef: 'MPESA-77' });
    assert.equal(r.price, 450000, 'looked up rather than typed');
    assert.equal(r.balance, 350000, 'SOP B.4');
    const [row] = d._dump('topups');
    assert.equal(row.imei, IMEI); assert.equal(row.staff_code, 'A1'); assert.equal(row.status, 'requested');
    assert.equal(row.customer, 'Alafati Kalikawe', 'the customer name comes off the book too');
    // Finance is told, and the notice carries the reason it is urgent.
    assert.equal(r.emailed, true);
    const b = JSON.stringify(cap.sent[0].body);
    assert.ok(b.includes('fedha@hoop.co.tz'));
    assert.ok(b.includes('B.5'), 'the notice says why it must not wait');
    assert.match(cap.sent[0].body.subject, new RegExp(IMEI));
    // What it refuses.
    await assert.rejects(() => _FNS.topupRequest(d, AGENT, { paidAmount: 1000 }),
      e => e.status === 400 && /IMEI/.test(e.message));
    await assert.rejects(() => _FNS.topupRequest(d, AGENT, { imei: '123', paidAmount: 1000 }), e => e.status === 400);
    await assert.rejects(() => _FNS.topupRequest(d, AGENT, { imei: IMEI }),
      e => e.status === 400 && /alicholipa|paid up front/i.test(e.message));
    await assert.rejects(() => _FNS.topupRequest(d, AGENT, { imei: IMEI, paidAmount: 0 }), e => e.status === 400);
    // A phone the book does not know opens with no price and no balance, rather than a wrong one.
    const un = await _FNS.topupRequest(d, AGENT, { imei: '359999999999999', paidAmount: 50000 });
    assert.equal(un.price, null); assert.equal(un.balance, null);
  } finally { cap.restore(); }
});

test('B.2/B.3: verifying takes BOTH the IMEI and the payer, and nothing is paid before it', async () => {
  const d = tuDb({ rows: [aTop({ id: uid('v1') })] });
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('v1'), step: 'verify', payerOk: true }),
    e => e.status === 400 && /B\.2/.test(e.message));
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('v1'), step: 'verify', imeiOk: true }),
    e => e.status === 400 && /B\.3/.test(e.message));
  // Paying before verifying is the thing B.2 exists to prevent.
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('v1'), step: 'pay', paymentRef: 'TX1' }),
    e => e.status === 400 && /Thibitisha kwanza|Verify it before paying/i.test(e.message));
  assert.equal(d._dump('topups')[0].status, 'requested');
  const r = await _FNS.topupUpdate(d, FIN, { id: uid('v1'), ...VERIFY, payerName: 'Alafati K', price: '500000' });
  assert.equal(r.status, 'verified');
  const [row] = d._dump('topups');
  assert.equal(row.verified_by, 'JANETH'); assert.ok(row.verified_at);
  assert.equal(row.payer_name, 'Alafati K');
  assert.equal(row.price, 500000); assert.equal(row.balance, 400000, 'and the balance is recomputed');
});

test('B.5/B.6: pay then confirm the unlock, each once, and never out of order', async () => {
  const d = tuDb({ rows: [aTop({ id: uid('p1'), status: 'verified', verifiedBy: 'JANETH' })] });
  // Unlocking before paying is a lie about a customer's phone.
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('p1'), step: 'unlock', confirmed: true }),
    e => e.status === 400 && /kabla ya malipo|before it is paid/i.test(e.message));
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('p1'), step: 'pay' }),
    e => e.status === 400 && /kumbukumbu|reference/i.test(e.message));
  const paid = await _FNS.topupUpdate(d, FIN, { id: uid('p1'), step: 'pay', paymentRef: 'TX-902' });
  assert.equal(paid.status, 'paid');
  const [row] = d._dump('topups');
  assert.equal(row.paid_by, 'JANETH'); assert.ok(row.paid_at); assert.equal(row.payment_ref, 'TX-902');
  // B.6: recording an unlock nobody confirmed is refused.
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('p1'), step: 'unlock' }),
    e => e.status === 400 && /B\.6/.test(e.message));
  const done = await _FNS.topupUpdate(d, FIN, { id: uid('p1'), step: 'unlock', confirmed: true });
  assert.equal(done.status, 'unlocked');
  assert.equal(row.unlocked_by, 'JANETH'); assert.ok(row.unlocked_at);
  // A finished top-up is finished.
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('p1'), step: 'note', comment: 'x' }),
    e => e.status === 400 && /imekamilika|already complete/i.test(e.message));
});

test('B.5: the wait is counted in minutes, and the queue serves whoever has waited longest', async () => {
  const d = tuDb({ rows: [
    aTop({ id: uid('w1'), at: minsAgo(200) }),
    aTop({ id: uid('w2'), at: minsAgo(20) }),
    aTop({ id: uid('w3'), at: minsAgo(400), status: 'verified' }),
    aTop({ id: uid('w4'), at: minsAgo(600), status: 'unlocked', paidAt: minsAgo(590) }),
  ] });
  const q = await _FNS.topupQueue(d, FIN, {});
  // Waiting first; among those, longest-waiting first. The finished one is not in the queue.
  assert.deepEqual(q.rows.map(x => x.id), [uid('w1'), uid('w2'), uid('w3')]);
  assert.equal(q.counts.waiting, 3);
  assert.ok(q.counts.longestWaitMins >= 400, 'the number B.5 exists to keep at zero');
  const w1 = q.rows.find(x => x.id === uid('w1'));
  assert.ok(w1.waitedMins >= 199 && w1.waitedMins <= 202);
  // The clock STOPS at the payment, not at the paperwork.
  const all = await _FNS.topupQueue(d, FIN, { state: 'all' });
  const w4 = all.rows.find(x => x.id === uid('w4'));
  assert.ok(w4.waitedMins <= 15, 'a paid top-up is not still accruing a wait');
  assert.equal(all.rows.length, 4);
  assert.equal((await _FNS.topupQueue(d, FIN, { state: 'verified' })).rows.length, 1);
  // The checklist labels the pane draws come from the server.
  assert.equal(q.checks.length, 4);
  assert.ok(q.checks.every(c => c.key && c.label));
});

test('top-ups: the checklist ticks stick, rejecting needs a reason, and two desks cannot clash', async () => {
  const d = tuDb({ rows: [aTop({ id: uid('c1') })] });
  await _FNS.topupUpdate(d, FIN, { id: uid('c1'), step: 'note', comment: 'Nimeona risiti',
    checks: { chkRequest: true, chkPaidTo: true } });
  const [row] = d._dump('topups');
  assert.equal(row.chk_request, true); assert.equal(row.chk_paid_to, true);
  assert.equal(row.chk_watu, false);
  assert.equal(row.comment, 'Nimeona risiti');
  assert.equal(row.status, 'requested', 'a note moves nothing');
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('c1'), step: 'note' }),
    e => e.status === 400 && /Hakuna kilichobadilika|Nothing to save/i.test(e.message));
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('c1'), step: 'reject' }),
    e => e.status === 400 && /Sababu|reason/i.test(e.message));
  await assert.rejects(() => _FNS.topupUpdate(d, FIN, { id: uid('c1'), step: 'teleport' }), e => e.status === 400);
  await _FNS.topupUpdate(d, FIN, { id: uid('c1'), step: 'reject', comment: 'Malipo hayajaonekana benki' });
  assert.equal(row.status, 'rejected');
  // Two desks paying the same top-up: the guarded update matches nothing for the second.
  const race = tuDb({ rows: [aTop({ id: uid('r1'), status: 'verified' })] });
  const raw = race.from.bind(race);
  let armed = true;
  race.from = name => {
    const q = raw(name);
    if (name === 'topups' && armed) {
      const u = q.update.bind(q);
      q.update = p => { armed = false; race._dump('topups')[0].status = 'paid'; return u(p); };
    }
    return q;
  };
  await assert.rejects(() => _FNS.topupUpdate(race, FIN, { id: uid('r1'), step: 'pay', paymentRef: 'TX-2' }),
    e => e.status === 400 && /mtu mwingine|Somebody else/i.test(e.message));
});

test('top-ups: the asker sees only their own, and before the migration every pane says which file to run', async () => {
  const d = tuDb({ rows: [aTop({ id: uid('m1'), code: 'A1' }), aTop({ id: uid('m2'), code: 'A2', name: 'MWINGINE' })] });
  const mine = await _FNS.topupMine(d, AGENT);
  assert.equal(mine.rows.length, 1); assert.equal(mine.rows[0].id, uid('m1'));
  assert.ok(mine.rows[0].mine);
  const bare = fakeDb({ topups: [], watu_loans: [] }, { missingColumns: { topups: ['id'] } });
  assert.equal((await _FNS.topupMine(bare, AGENT)).notReady, true);
  assert.equal((await _FNS.topupQueue(bare, FIN, {})).notReady, true);
  for (const [fn, user, args] of [
    ['topupRequest', AGENT, GOOD],
    ['topupUpdate', FIN, { id: uid('x'), ...VERIFY }],
  ]) {
    await assert.rejects(() => _FNS[fn](bare, user, args),
      e => e.status === 400 && /RUN-ME-2026-09-09-topups\.sql/.test(e.message), fn + ' names the migration');
  }
});
