import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';

/* =========================================================================================
   STOCK REQUESTS, THE AGING GATE, AND THE HANDOVER NOTE.

     Store SOP B.1  "Receive the stock request from the RSM in the system"
     Store SOP B.2  "Confirm the RSM/agent has no outstanding aging stock"
     Store SOP B.5  "Prepare a pre-numbered delivery/handover note listing IMEIs, quantities,
                     and condition"
     Store SOP B.6  "Conduct a joint physical count with the RSM/agent before handover"
     Store SOP B.7  "Photograph the sealed boxes and IMEI list at the point of handover"
     Store SOP B.8  "Obtain the RSM/agent's signature"
     Store SOP B.9  courier dispatch: documents verified complete before dispatch
     Store SOP E    "No new stock is released to any RSM/agent with outstanding aging stock"
     Store SOP G    low stock alert below 1,500 pieces

   THE GATE IS THE POINT. Everything else is the request shape this system already has three
   of; what is new is an approval that arithmetic can refuse. And the permission is the NAV --
   "I implement tasks/roles by nav tabs not role based" -- so nothing below names a store
   keeper or a GM.
   ========================================================================================= */
const ASKER = { code: 'R1', name: 'ANOLD SAWE', role: 'OFFICER', teams: null, tabs: ['stockreq'], readOnly: false };
const STORE = { code: 'S1', name: 'SIPHO K', role: 'OFFICER', teams: null, tabs: ['stockappr'], readOnly: false };
const READER = { code: 'G1', name: 'BOSS', role: 'MANAGER', teams: null, tabs: ['stockrep'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['stockreq', 'stockappr', 'stockrep'], readOnly: true };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const TODAY = '2026-09-09';
/* The shop's own aged-stock upload: age_days per serial per agent, stamped as_of the day. */
const aged = (agent, age, o = {}) => ({ serial: o.serial || ('S' + agent + age + (o.n || 0)), agent,
  item: o.item || 'A07', received: '2026-09-01', age_days: age, as_of: o.asOf || TODAY });
const aRequest = o => ({
  id: o.id, requested_at: o.at || '2026-09-09T06:00:00Z',
  staff_code: o.code || 'R1', staff_name: o.name || 'ANOLD SAWE', staff_role: 'OFFICER',
  holder: o.holder || 'ANOLD SAWE', destination: o.dest || 'Morogoro', item: o.item || 'A07',
  qty: o.qty == null ? 10 : o.qty, reason: o.reason || 'Soko la wiki',
  aging_count: o.agingCount == null ? 0 : o.agingCount, aging_oldest_days: o.agingOldest || null, aging_as_of: TODAY,
  status: o.status || 'pending', approved_qty: o.approvedQty == null ? null : o.approvedQty,
  comment: o.comment || null, decided_by: o.by || null, decided_at: o.decidedAt || null,
  aging_override: !!o.override, aging_override_reason: o.overrideReason || null,
  issued_at: o.issuedAt || null, issued_by: o.issuedBy || null,
  updated_by: 'ANOLD SAWE', updated_at: o.updatedAt || o.at || '2026-09-09T06:00:00Z',
});
const stDb = (o = {}) => fakeDb({
  stock_requests: o.requests || [], stock_handovers: o.handovers || [],
  stock_handover_items: o.items || [], stock_handover_photos: o.photos || [],
  hoop_aged_stock: o.aged || [], devices: o.devices || [], settings: o.settings || [],
});
// A tiny valid JPEG-shaped data URL of a given decoded size -- what the phone sends after shrinking.
const photoOf = bytes => 'data:image/jpeg;base64,' + Buffer.alloc(bytes, 7).toString('base64');

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
const GOOD_HANDOVER = { countedJointly: true, receivedBy: 'Anold Sawe' };

/* ---------------------------------------------------------------------------------------- */
test('stock: three panes are three grants, view-only looks but never releases, ADMIN holds all', async () => {
  const d = stDb({ requests: [aRequest({ id: uid('r1') })] });
  const denied = async (fn, user, args) => {
    await assert.rejects(() => _FNS[fn](d, user, args || {}), e => e.status === 403,
      fn + ' must refuse a user who was never granted its pane');
  };
  await denied('stockQueue', ASKER); await denied('stockReqReport', ASKER);
  await denied('stockDecide', ASKER, { id: uid('r1'), approve: true });
  await denied('stockIssue', ASKER, { id: uid('r1') });
  await denied('stockMine', STORE); await denied('stockReqReport', STORE);
  await denied('stockMine', READER); await denied('stockQueue', READER);
  await denied('stockRequest', READER, { item: 'A07', qty: 1 });
  await denied('stockDecide', READER, { id: uid('r1'), approve: true });
  // View-only reads every pane and writes nothing.
  assert.ok(Array.isArray((await _FNS.stockMine(d, VIEWER)).rows));
  assert.ok(Array.isArray((await _FNS.stockQueue(d, VIEWER, {})).rows));
  assert.ok((await _FNS.stockReqReport(d, VIEWER, {})).totals);
  for (const [fn, args] of [['stockRequest', { item: 'A07', qty: 1 }], ['stockDecide', { id: uid('r1'), approve: true }],
    ['stockIssue', { id: uid('r1'), ...GOOD_HANDOVER }]]) {
    await assert.rejects(() => _FNS[fn](d, VIEWER, args), e => e.status >= 400 && e.status < 500, fn);
  }
  assert.equal(d._dump('stock_requests').length, 1);
  assert.equal(d._dump('stock_handovers').length, 0);
  // "ADMIN IS FULL ACCESS EVERYWHERE WE DEVELOP"
  assert.equal((await _FNS.stockQueue(d, OWNER, {})).rows.length, 1);
  assert.ok((await _FNS.stockReqReport(d, OWNER, {})).totals);
});

test('stock: the navs are tickable, the writes are audited, and the migration matches the server', () => {
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const m = /const NAV_TABS = \[([^\]]+)\]/.exec(src);
  for (const k of ['stockreq', 'stockappr', 'stockrep']) {
    assert.ok(m[1].includes(`'${k}'`), k + ' must be a nav the owner can tick');
  }
  for (const fn of ['stockRequest', 'stockDecide', 'stockIssue']) {
    assert.match(src, new RegExp("AUDITED\\.add\\('" + fn + "'\\)"), fn + ' is a write and lands in the audit log');
  }
  const ed = /const EDITABLE_SETTINGS = \[([\s\S]*?)\]/.exec(src);
  for (const k of ['STOCK_EMAIL', 'STOCK_AGING_DAYS', 'STOCK_LOW_ALERT']) {
    assert.ok(ed[1].includes(`'${k}'`), k + ' is settable without a deploy');
  }
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-09-stock-requests.sql', import.meta.url), 'utf8');
  for (const t of ['stock_requests', 'stock_handovers', 'stock_handover_items', 'stock_handover_photos']) {
    assert.match(sql, new RegExp('create table if not exists ' + t + ' \\('), t + ' is created idempotently');
  }
  assert.match(sql, /request_id\s+uuid not null unique/, 'one handover per request, enforced by the database too');
  assert.match(sql, /on conflict \(key\) do nothing/, 'the seed never overwrites a number the office already set');
  // Every status the server admits is a status the CHECK admits.
  const states = /const STOCK_STATES = \[([^\]]+)\]/.exec(src);
  for (const s of ['pending', 'approved', 'rejected', 'issued', 'cancelled']) {
    assert.ok(states[1].includes(`'${s}'`)); assert.ok(sql.includes(`'${s}'`));
  }
});

/* ---------------------------------------------------------------------------------------- */
test('stock: a request is stamped from the session and carries what the tracker said that morning', async () => {
  const cap = captureMail();
  try {
    const d = stDb({
      aged: [aged('ANOLD SAWE', 9), aged('ANOLD SAWE', 2, { n: 1 }), aged('Other Rsm', 30, { n: 2 })],
      settings: [{ key: 'STOCK_EMAIL', value: 'stoo@hoop.co.tz' }],
    });
    const r = await _FNS.stockRequest(d, ASKER, {
      holder: '  anold sawe ', destination: 'Morogoro', item: ' A07 ', qty: '12', reason: 'Soko la wiki',
      // Nothing the client says about identity or state is believed.
      staffName: 'SOMEBODY ELSE', staffCode: 'ZZ', status: 'approved', approvedQty: 99, agingOverride: true,
    });
    assert.ok(r.id);
    const [row] = d._dump('stock_requests');
    assert.equal(row.staff_code, 'R1'); assert.equal(row.staff_name, 'ANOLD SAWE'); assert.equal(row.staff_role, 'OFFICER');
    assert.equal(row.status, 'pending', 'nobody files their own request as approved');
    assert.equal(row.approved_qty, undefined);
    assert.ok(!row.aging_override, 'the override is the desk\'s to set, never the form\'s');
    assert.equal(row.holder, 'anold sawe', 'trimmed, kept as typed');
    assert.equal(row.item, 'A07'); assert.equal(row.qty, 12);
    // SOP E, stamped: one piece over the 5-day threshold, the oldest is 9 days.
    assert.equal(row.aging_count, 1); assert.equal(row.aging_oldest_days, 9); assert.equal(row.aging_as_of, TODAY);
    assert.equal(r.aging.blocked, true);
    // The store desk is told, and the mail carries the gate so it is read before the pane is opened.
    assert.equal(r.emailed, true);
    const b = JSON.stringify(cap.sent[0].body);
    assert.ok(b.includes('stoo@hoop.co.tz'));
    assert.match(cap.sent[0].body.subject, /A07/); assert.match(cap.sent[0].body.subject, /12/);
    assert.ok(b.includes('SOP E'), 'the aging position travels with the request');
    // Nobody set: the request still lands.
    const quiet = stDb();
    const r2 = await _FNS.stockRequest(quiet, ASKER, { item: 'A06', qty: 1 });
    assert.equal(r2.emailed, false); assert.equal(quiet._dump('stock_requests').length, 1);
    assert.equal(quiet._dump('stock_requests')[0].holder, 'ANOLD SAWE', 'defaults to the person asking');
    assert.equal(r2.aging.blocked, false, 'no aged-stock upload is not a blocked holder');
  } finally { cap.restore(); }
});

test('stock: what a request must carry', async () => {
  const d = stDb();
  const bad = async (args, why) => {
    await assert.rejects(() => _FNS.stockRequest(d, ASKER, args), e => e.status === 400 && why.test(e.message), JSON.stringify(args));
  };
  await bad({ qty: 5 }, /modeli|model/i);
  await bad({ item: 'A07' }, /idadi|quantity/i);
  await bad({ item: 'A07', qty: 0 }, /idadi|quantity/i);
  await bad({ item: 'A07', qty: -3 }, /idadi|quantity/i);
  await bad({ item: 'A07', qty: 99999 }, /kubwa mno|too large/i);
  // A blank holder is not an error: it means "for me", which is the usual case.
  await _FNS.stockRequest(d, ASKER, { item: 'A07', qty: 5, holder: '   ' });
  assert.equal(d._dump('stock_requests')[0].holder, 'ANOLD SAWE');
  // Only a code with no name of its own has nobody to fall back to.
  await assert.rejects(() => _FNS.stockRequest(d, { ...ASKER, name: '' }, { item: 'A07', qty: 5 }),
    e => e.status === 400 && /anayepokea|stock is for/i.test(e.message));
  assert.equal(d._dump('stock_requests').length, 1, 'and nothing else was filed');
});

/* ---------------------------------------------------------------------------------------- */
test('stock: THE GATE — an approval is refused while aging stock is outstanding, and released only with a reason', async () => {
  const mk = () => stDb({
    requests: [aRequest({ id: uid('g1'), holder: 'ANOLD SAWE', qty: 10 })],
    aged: [aged('Anold  Sawe', 9), aged('ANOLD SAWE', 12, { n: 1 }), aged('ANOLD SAWE', 3, { n: 2 })],
  });
  // Refused, and the refusal says what is holding it up and how to proceed.
  const d = mk();
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('g1'), approve: true }),
    e => e.status === 400 && /SOP E/.test(e.message) && /siku 5/.test(e.message) && /siku 12/.test(e.message));
  assert.equal(d._dump('stock_requests')[0].status, 'pending', 'nothing moved');
  // Ticking the override without a reason is not an override.
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('g1'), approve: true, overrideAging: true }),
    e => e.status === 400 && /SOP E/.test(e.message));
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('g1'), approve: true, overrideReason: 'kwa sababu' }),
    e => e.status === 400, 'a reason without the tick is not an override either');
  assert.equal(d._dump('stock_requests')[0].status, 'pending');
  // With both, it goes through and the reason is kept.
  const r = await _FNS.stockDecide(d, STORE, { id: uid('g1'), approve: true, overrideAging: true,
    overrideReason: 'Mteja amelipa, GM amekubali kwa simu' });
  assert.equal(r.status, 'approved'); assert.equal(r.agingOverride, true);
  const row = d._dump('stock_requests')[0];
  assert.equal(row.aging_override, true);
  assert.equal(row.aging_override_reason, 'Mteja amelipa, GM amekubali kwa simu');
  assert.equal(row.decided_by, 'SIPHO K');
  // REJECTING is never gated: the gate exists to stop stock leaving, not to stop a no.
  const d2 = mk();
  const no = await _FNS.stockDecide(d2, STORE, { id: uid('g1'), approve: false, comment: 'Maliza stoo ya zamani' });
  assert.equal(no.status, 'rejected'); assert.equal(d2._dump('stock_requests')[0].aging_override, false);
});

test('stock: the gate is recomputed LIVE, not read off the stamp', async () => {
  // Filed on a clean morning; by the time somebody decides, the holder is sitting on old stock.
  const d = stDb({
    requests: [aRequest({ id: uid('l1'), holder: 'ANOLD SAWE', agingCount: 0 })],
    aged: [aged('ANOLD SAWE', 40)],
  });
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('l1'), approve: true }),
    e => e.status === 400 && /SOP E/.test(e.message), 'a request filed clean can still be refused two days later');
  // And the other way round: stamped blocked, cleared since, approves with no override.
  const d2 = stDb({ requests: [aRequest({ id: uid('l2'), holder: 'ANOLD SAWE', agingCount: 7, agingOldest: 30 })], aged: [] });
  const r = await _FNS.stockDecide(d2, STORE, { id: uid('l2'), approve: true });
  assert.equal(r.status, 'approved');
  assert.equal(d2._dump('stock_requests')[0].aging_override, false, 'a gate that no longer applies is not an override');
});

test('stock: the threshold and the low-stock level are settings, with the SOP\'s own numbers as the fallback', async () => {
  const base = { requests: [aRequest({ id: uid('t1'), holder: 'ANOLD SAWE' })], aged: [aged('ANOLD SAWE', 7)] };
  // Default 5: seven days is aging, so this is blocked.
  await assert.rejects(() => _FNS.stockDecide(stDb(base), STORE, { id: uid('t1'), approve: true }), e => e.status === 400);
  // Raised to 10: the same seven days is not.
  const d = stDb({ ...base, settings: [{ key: 'STOCK_AGING_DAYS', value: '10' }] });
  assert.equal((await _FNS.stockDecide(d, STORE, { id: uid('t1'), approve: true })).status, 'approved');
  // Nonsense in the box leaves the SOP's number standing.
  const junk = stDb({ ...base, settings: [{ key: 'STOCK_AGING_DAYS', value: 'soon' }] });
  await assert.rejects(() => _FNS.stockDecide(junk, STORE, { id: uid('t1'), approve: true }), e => e.status === 400);
  // SOP G: the low-stock alert, with 1500 as the fallback.
  const rep = await _FNS.stockReqReport(stDb({ aged: [aged('A', 1), aged('B', 1, { n: 1 })] }), READER, {});
  assert.equal(rep.aging.lowAlert, 1500);
  assert.equal(rep.aging.pieces, 2);
  assert.equal(rep.aging.low, true, 'two pieces is below the alert level');
  const rep2 = await _FNS.stockReqReport(stDb({ aged: [aged('A', 1)], settings: [{ key: 'STOCK_LOW_ALERT', value: '1' }] }), READER, {});
  assert.equal(rep2.aging.low, false, 'one piece against a level of one is not below it');
  // No upload at all is not a low-stock alarm -- it is no information.
  assert.equal((await _FNS.stockReqReport(stDb(), READER, {})).aging.low, false);
});

test('stock: a decision happens once, releases no more than was asked, and rejecting needs a reason', async () => {
  const d = stDb({ requests: [aRequest({ id: uid('d1'), qty: 10 })] });
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('d1'), approve: false }),
    e => e.status === 400 && /sababu|reason/i.test(e.message));
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('d1'), approve: true, qty: 11 }),
    e => e.status === 400 && /zaidi ya kilichoombwa|more than was asked/i.test(e.message));
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('d1'), approve: true, qty: 0 }), e => e.status === 400);
  // Fewer than asked is the normal case and is recorded as such.
  const r = await _FNS.stockDecide(d, STORE, { id: uid('d1'), approve: true, qty: 6, comment: 'Stoo iliyopo' });
  assert.equal(r.approvedQty, 6);
  assert.equal(d._dump('stock_requests')[0].approved_qty, 6);
  // Twice is never.
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('d1'), approve: true }),
    e => e.status === 400 && /imeshaamuliwa|already been decided/i.test(e.message));
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: uid('zz'), approve: true }), e => e.status === 400);
  await assert.rejects(() => _FNS.stockDecide(d, STORE, { id: 'not-a-uuid', approve: true }), e => e.status === 400);
});

/* ---------------------------------------------------------------------------------------- */
test('stock: the handover needs the joint count and a signature, and only on an approved request', async () => {
  const d = stDb({ requests: [
    aRequest({ id: uid('h1'), status: 'approved', approvedQty: 3 }),
    aRequest({ id: uid('h2'), status: 'pending' }),
    aRequest({ id: uid('h3'), status: 'issued', issuedAt: '2026-09-09T08:00:00Z' }),
  ] });
  // SOP B.6 and B.8 are not paperwork: without them nobody can be held to the shortage.
  await assert.rejects(() => _FNS.stockIssue(d, STORE, { id: uid('h1'), receivedBy: 'Anold' }),
    e => e.status === 400 && /B\.6|pamoja|joint/i.test(e.message));
  await assert.rejects(() => _FNS.stockIssue(d, STORE, { id: uid('h1'), countedJointly: true }),
    e => e.status === 400 && /B\.8|saini|signed/i.test(e.message));
  // Not approved yet, or already gone.
  await assert.rejects(() => _FNS.stockIssue(d, STORE, { id: uid('h2'), ...GOOD_HANDOVER }),
    e => e.status === 400 && /Idhinisha kwanza|Approve the request/i.test(e.message));
  await assert.rejects(() => _FNS.stockIssue(d, STORE, { id: uid('h3'), ...GOOD_HANDOVER }),
    e => e.status === 400 && /tayari imetolewa|already been handed/i.test(e.message));
  assert.equal(d._dump('stock_handovers').length, 0);
  // SOP B.9: a courier dispatch without its documents checked does not leave.
  await assert.rejects(() => _FNS.stockIssue(d, STORE, { id: uid('h1'), ...GOOD_HANDOVER, courier: 'ABC Couriers' }),
    e => e.status === 400 && /B\.9|nyaraka|documents/i.test(e.message));
  assert.equal(d._dump('stock_handovers').length, 0);
});

test('stock: the note carries the IMEIs, the photos, and moves the phone registry\'s holder', async () => {
  const d = stDb({
    requests: [aRequest({ id: uid('n1'), status: 'approved', approvedQty: 3, holder: 'ANOLD SAWE' })],
    devices: [{ imei: '351388334583295', holder: 'STORE', state: 'enrolled' },
      { imei: '351388334583296', holder: 'STORE', state: 'enrolled' }],
  });
  const r = await _FNS.stockIssue(d, STORE, {
    id: uid('n1'), noteNo: 'HN-0042', receivedBy: 'Anold Sawe', countedJointly: true,
    // Typed off a pad: spaces, commas, a duplicate, and a blank line.
    imeis: ' 351388334583295, 351388334583296 \n 351388334583295 \n\n 359999999999999 ',
    conditionNote: 'Maboksi yamefungwa', courier: 'ABC Couriers', docsComplete: true,
    photos: [photoOf(20000), photoOf(30000)],
  });
  assert.equal(r.imeis, 3, 'de-duplicated'); assert.equal(r.photos, 2);
  assert.equal(r.holdersMoved, 2, 'the two the registry knows; the third is not enrolled and that is normal');
  const [req] = d._dump('stock_requests');
  assert.equal(req.status, 'issued'); assert.equal(req.issued_by, 'SIPHO K'); assert.ok(req.issued_at);
  const [hv] = d._dump('stock_handovers');
  assert.equal(hv.note_no, 'HN-0042'); assert.equal(hv.received_by, 'Anold Sawe');
  assert.equal(hv.counted_jointly, true); assert.equal(hv.courier, 'ABC Couriers'); assert.equal(hv.docs_complete, true);
  assert.equal(hv.qty, 3);
  assert.deepEqual(d._dump('stock_handover_items').map(i => i.imei).sort(),
    ['351388334583295', '351388334583296', '359999999999999']);
  assert.deepEqual(d._dump('stock_handover_photos').map(p => p.seq), [1, 2]);
  assert.ok(d._dump('stock_handover_photos')[0].bytes > 19000);
  // WHO HAS IT is now one answer, not two.
  for (const dev of d._dump('devices')) assert.equal(dev.holder, 'ANOLD SAWE');
  // And it reads back whole.
  const h = await _FNS.stockHandover(d, READER, { id: uid('n1') });
  assert.equal(h.handover.noteNo, 'HN-0042'); assert.equal(h.handover.photos, 2);
  assert.equal(h.items.length, 3);
  const p = await _FNS.stockPhotos(d, READER, { id: uid('n1') });
  assert.equal(p.photos.length, 2); assert.equal(p.photos[0].seq, 1);
});

test('stock: what the note refuses — a bad IMEI, more phones than were approved, and a photo that is not one', async () => {
  const mk = () => stDb({ requests: [aRequest({ id: uid('b1'), status: 'approved', approvedQty: 2 })] });
  const bad = async (args, why) => {
    const d = mk();
    await assert.rejects(() => _FNS.stockIssue(d, STORE, { id: uid('b1'), ...GOOD_HANDOVER, ...args }),
      e => e.status === 400 && why.test(e.message), JSON.stringify(args).slice(0, 80));
    assert.equal(d._dump('stock_handovers').length, 0, 'and nothing was written');
    assert.equal(d._dump('stock_requests')[0].status, 'approved', 'nor was the request moved');
  };
  await bad({ imeis: '12345' }, /IMEI/);
  await bad({ imeis: '351388334583295 351388334583296 351388334583297' }, /zilizoidhinishwa|approved/i);
  await bad({ photos: ['hello'] }, /si picha|not an image/i);
  await bad({ photos: [photoOf(300 * 1024)] }, /kubwa mno|too large/i);
  await bad({ photos: [photoOf(100)] }, /ndogo mno|too small/i);
  await bad({ photos: [photoOf(5000), photoOf(5000), photoOf(5000), photoOf(5000)] }, /nyingi mno|Too many/i);
  // A note with no IMEIs at all is allowed -- boxed stock counted by the box still has a note.
  const d = mk();
  const r = await _FNS.stockIssue(d, STORE, { id: uid('b1'), ...GOOD_HANDOVER });
  assert.equal(r.imeis, 0);
  assert.equal(d._dump('stock_handovers')[0].qty, 2, 'the approved quantity stands in for a count by the box');
});

test('stock: two store keepers pressing at once write one handover, not two', async () => {
  const d = stDb({ requests: [aRequest({ id: uid('race'), status: 'approved', approvedQty: 2 })] });
  /* Somebody else's handover lands between this desk's read and its claim: the guarded update
     matches nothing, and the second press is told so before any photo is written. */
  const raw = d.from.bind(d);
  let armed = true;
  d.from = name => {
    const q = raw(name);
    if (name === 'stock_requests' && armed) {
      const u = q.update.bind(q);
      q.update = p => { armed = false; d._dump('stock_requests')[0].status = 'issued'; return u(p); };
    }
    return q;
  };
  await assert.rejects(() => _FNS.stockIssue(d, STORE, { id: uid('race'), ...GOOD_HANDOVER, photos: [photoOf(9000)] }),
    e => e.status === 400 && /imeshatolewa|already handed/i.test(e.message));
  assert.equal(d._dump('stock_handovers').length, 0);
  assert.equal(d._dump('stock_handover_photos').length, 0, 'and no orphan photo was left behind');
});

/* ---------------------------------------------------------------------------------------- */
test('stock: the asker sees only their own, and the queue is a worklist', async () => {
  const d = stDb({
    requests: [
      aRequest({ id: uid('m1'), code: 'R1', status: 'issued', at: '2026-09-09T05:00:00Z' }),
      aRequest({ id: uid('m2'), code: 'R1', status: 'pending', at: '2026-09-08T05:00:00Z' }),
      aRequest({ id: uid('m3'), code: 'R2', name: 'OTHER RSM', holder: 'OTHER RSM', status: 'pending' }),
      aRequest({ id: uid('m4'), code: 'R1', status: 'approved', at: '2026-09-07T05:00:00Z' }),
    ],
    aged: [aged('OTHER RSM', 40)],
  });
  const mine = await _FNS.stockMine(d, ASKER);
  assert.deepEqual(mine.rows.map(x => x.id), [uid('m2'), uid('m4'), uid('m1')],
    'own rows only: pending, then approved, then what is already history');
  assert.ok(mine.rows.every(x => x.mine));
  assert.equal(mine.aging.blocked, false, 'and the asker is told where they stand right now');
  // The desk: open work by default, every request on request, and the gate live per row.
  const q = await _FNS.stockQueue(d, STORE, {});
  assert.deepEqual(q.rows.map(x => x.id), [uid('m3'), uid('m2'), uid('m4')], 'issued is history, not work');
  assert.equal(q.counts.pending, 2); assert.equal(q.counts.approved, 1); assert.equal(q.counts.issued, 1);
  assert.equal(q.counts.blocked, 1, 'one pending request is from somebody sitting on aging stock');
  assert.equal(q.rows.find(x => x.id === uid('m3')).agingNow.blocked, true);
  assert.equal(q.rows.find(x => x.id === uid('m2')).agingNow.blocked, false);
  assert.equal((await _FNS.stockQueue(d, STORE, { state: 'all' })).rows.length, 4);
  assert.deepEqual((await _FNS.stockQueue(d, STORE, { state: 'blocked' })).rows.map(x => x.id), [uid('m3')]);
  assert.deepEqual((await _FNS.stockQueue(d, STORE, { state: 'issued' })).rows.map(x => x.id), [uid('m1')]);
});

test('stock: the report is the tracker and the distribution book together', async () => {
  const d = stDb({
    requests: [
      aRequest({ id: uid('p1'), status: 'issued', approvedQty: 8, qty: 10, at: '2026-09-05T06:00:00Z' }),
      aRequest({ id: uid('p2'), status: 'rejected', qty: 5, at: '2026-09-06T06:00:00Z' }),
      aRequest({ id: uid('p3'), status: 'issued', qty: 4, override: true, overrideReason: 'GM amekubali', at: '2026-09-07T06:00:00Z' }),
      aRequest({ id: uid('p4'), status: 'pending', qty: 2, holder: 'OTHER RSM', at: '2026-08-01T06:00:00Z' }),
    ],
    aged: [aged('ANOLD SAWE', 9), aged('ANOLD SAWE', 2, { n: 1 }), aged('OTHER RSM', 40, { n: 2 })],
  });
  const r = await _FNS.stockReqReport(d, READER, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.totals.count, 3, 'August is outside the period');
  assert.equal(r.totals.issued, 2); assert.equal(r.totals.rejected, 1); assert.equal(r.totals.pending, 0);
  assert.equal(r.totals.qtyAsked, 19); assert.equal(r.totals.qtyIssued, 12, '8 released of 10, plus 4 in full');
  assert.equal(r.totals.overrides, 1, 'SOP E, after the fact: how often the gate was overridden');
  // The tracker, worst first.
  assert.equal(r.aging.agingDays, 5); assert.equal(r.aging.asOf, TODAY);
  assert.equal(r.aging.holders[0].holder, 'OTHER RSM');
  assert.equal(r.aging.holders[0].aging, 1); assert.equal(r.aging.holders[0].oldest, 40);
  const anold = r.aging.holders.find(h => h.holder === 'ANOLD SAWE');
  assert.equal(anold.pieces, 2); assert.equal(anold.aging, 1, 'only the piece past the threshold');
  assert.match(anold.items, /A07 ×2/);
  // Narrowed by status and by holder.
  assert.equal((await _FNS.stockReqReport(d, READER, { from: '2026-09-01', to: '2026-09-30', status: 'issued' })).rows.length, 2);
  assert.equal((await _FNS.stockReqReport(d, READER, { holder: 'other  rsm' })).rows.length, 1);
  assert.equal((await _FNS.stockReqReport(d, READER, {})).totals.count, 4, 'no dates is everything');
});

test('stock: before the migration every pane says which file to run instead of failing', async () => {
  const bare = fakeDb({ stock_requests: [], hoop_aged_stock: [] }, { missingColumns: { stock_requests: ['id'] } });
  assert.equal((await _FNS.stockMine(bare, ASKER)).notReady, true);
  assert.equal((await _FNS.stockQueue(bare, STORE, {})).notReady, true);
  assert.equal((await _FNS.stockReqReport(bare, READER, {})).notReady, true);
  for (const [fn, user, args] of [
    ['stockRequest', ASKER, { item: 'A07', qty: 1 }],
    ['stockDecide', STORE, { id: uid('x'), approve: true }],
    ['stockIssue', STORE, { id: uid('x'), ...GOOD_HANDOVER }],
  ]) {
    await assert.rejects(() => _FNS[fn](bare, user, args),
      e => e.status === 400 && /RUN-ME-2026-09-09-stock-requests\.sql/.test(e.message), fn + ' names the migration');
  }
  assert.equal((await _FNS.stockHandover(bare, ASKER, { id: uid('x') })).notReady, true);
});
