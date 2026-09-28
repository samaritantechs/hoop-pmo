/* THE HANDOVER TO HOPE, ON SALE -- api/_lib/handover.js and everything that calls it.
 *
 *   "transfereed stock from Hoop to Hope should switch lock logo to Hope and appear in Hope
 *    Unlocking too" / "am not seeing that device at unlocking in both hoop and hope"
 *
 * A phone HOOP sells to HOPE MICROCREDIT is HOPE's from that day; until now nobody's finger ever
 * reached Hamisha for it, so it stayed HOOP's: locked from here, invisible there, showing HOOP's
 * number to a customer HOOP cannot help. These tests pin the two halves of the fix -- the sale
 * QUEUES the move (one keyed write, no HTTP, from the upload) and the natural reads COMPLETE it
 * (a batch from HOPE, throttled, renewed when it expires) -- and what every screen says about a
 * phone on its way, including the cases where it could not go. */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { fakeDb } = await import('./fake-db.mjs');
const H = await import('../api/_lib/handover.js');
const { _FNS } = await import('../api/portal.js');
const { deviceApi } = await import('../api/_lib/device-core.js');
const { supabase } = await import('../api/_lib/supabase.js');
const upload = (await import('../api/upload.js')).default;
const { clearRolesCache } = await import('../api/_lib/auth.js');
const { clearSystemOpenCache } = await import('../api/_lib/system-gate.js');
const { _resetSeen } = await import('../api/_lib/signin.js');
const { clearStockIndex } = await import('../api/_lib/stock-index.js');

const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
const STORE = { code: 'S1', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['devlock', 'devunlock', 'newstock'], readOnly: false };
const DESK = { code: 'D1', name: 'GD DESK', role: 'GENERAL_DUTY', teams: null, tabs: ['devunlock'], readOnly: false };
const NOW = Date.parse('2026-09-28T09:00:00Z');
const HOPE = 'https://hope-pmo-v2-ten.vercel.app';
const HEX = 'c'.repeat(32);
const iso = ms => new Date(ms).toISOString();
const hoursAgo = h => iso(NOW - h * 3600000);

/** A HOPE that answers the batch call the way api/shift-batch.js there does. Returns the calls
    it saw. Restored by `done()` -- a stub left behind would leak into every later file. */
function stubHope(answer) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    if (typeof answer === 'function') return answer(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, batch: HEX }) };
  };
  return { calls, done: () => { globalThis.fetch = real; } };
}
function withSecret(fn) {
  const saved = process.env.DEVICE_SHIFT_SECRET;
  process.env.DEVICE_SHIFT_SECRET = 'shared-secret-xyz';
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env.DEVICE_SHIFT_SECRET; else process.env.DEVICE_SHIFT_SECRET = saved;
  });
}
function withoutSecret(fn) {
  const saved = process.env.DEVICE_SHIFT_SECRET;
  delete process.env.DEVICE_SHIFT_SECRET;
  return Promise.resolve().then(fn).finally(() => {
    if (saved !== undefined) process.env.DEVICE_SHIFT_SECRET = saved;
  });
}

const dev = (o = {}) => ({ imei: o.imei, item: o.item === undefined ? 'A07' : o.item, holder: 'SIPHO STORE',
  state: o.state || 'locked', state_by: o.by === undefined ? 'SIPHO' : o.by, state_at: hoursAgo(30),
  reported: o.reported === undefined ? 'locked' : o.reported, last_seen: o.seen === undefined ? hoursAgo(1) : o.seen,
  enrol_token: 'tok-' + o.imei, app_version: o.app === undefined ? '1.12.0' : o.app,
  shift_server: o.shift_server || null, shift_batch: o.shift_batch || null, shift_at: o.shift_at || null });
const sale = (o = {}) => ({ sale_key: 'S' + o.imei, imei: o.imei, sale_date: o.day || '2026-08-29', branch: 'HOOP LIMITED',
  agent: 'ELIA CHITUZI', client_name: o.customer === undefined ? 'HOPE MICROCREDIT' : o.customer,
  client_phone: '0677111920', model: 'SAMSUNG A07-64GB', commission_agent: 'ELIA CHITUZI',
  commission_phone: '0673170988', price: 503000, receipt_number: 'R' + o.imei });

const book = (o = {}) => fakeDb({
  devices: o.devices || [], device_events: [], settings: o.settings || [], hoop_sales: o.sales || [],
  stock_audit: [], watu_loans: [], hoop_agents: [], hoop_aged_stock: [], old_stock: [],
  access_codes: [], audit_log: [],
}, o.opts || {});

/* ------------------------------------------------------------------------------------------
   THE RULES, ON THEIR OWN.
   ------------------------------------------------------------------------------------------ */
test('who counts as the partner: the configured buyer, contained, case-blind, off by `none`', () => {
  assert.deepEqual(H.parseBuyers(''), ['HOPE MICROCREDIT'], 'blank means the one partner there is');
  assert.deepEqual(H.parseBuyers('none'), [], '`none` switches the handover off');
  assert.deepEqual(H.parseBuyers('Hope Microcredit\nHOPE MFI, hope ltd'), ['HOPE MICROCREDIT', 'HOPE MFI', 'HOPE LTD']);
  const buyers = H.parseBuyers('');
  assert.equal(H.soldToPartner('HOPE MICROCREDIT', buyers), 'HOPE MICROCREDIT');
  assert.equal(H.soldToPartner('  hope   microcredit LTD ', buyers), 'HOPE MICROCREDIT', 'a suffix never stops a handover');
  assert.equal(H.soldToPartner('Fredy J Damasi', buyers), null);
  assert.equal(H.soldToPartner('HOPE MICROCREDIT', []), null, 'off is off');
  const sold = H.partnerSalesIn([sale({ imei: 'A' }), sale({ imei: 'B', customer: 'Juma' }), sale({ imei: 'A' })], buyers);
  assert.deepEqual([...sold.keys()], ['A'], 'one entry per IMEI, only the partner\'s');
});

test('the partner address: https only, no trailing slash, the default when unset or unusable', () => {
  assert.equal(H.normalizeServer('https://hope.example/'), 'https://hope.example');
  assert.equal(H.normalizeServer('http://hope.example'), '', 'plain http would put the identity on the wire');
  assert.equal(H.normalizeServer(''), '');
});

test('an app that predates shift is named as such; an app that never said is not', () => {
  assert.equal(H.shiftAppTooOld('1.11.8'), true);
  assert.equal(H.shiftAppTooOld('1.11.9'), false);
  assert.equal(H.shiftAppTooOld('1.12.0'), false);
  assert.equal(H.shiftAppTooOld('1.2'), true);
  assert.equal(H.shiftAppTooOld(''), false, 'unknown is not "too old" -- it has told us nothing');
  assert.equal(H.shiftAppTooOld(null), false);
});

test('what still needs a ticket: queued rows, and ordered rows whose batch is expiring -- never a released one', () => {
  assert.equal(H.needsTicket({ shift_server: HOPE, shift_batch: null, state: 'locked' }, NOW), true);
  assert.equal(H.needsTicket({ shift_server: HOPE, shift_batch: HEX, shift_at: hoursAgo(1), state: 'locked' }, NOW), false);
  assert.equal(H.needsTicket({ shift_server: HOPE, shift_batch: HEX, shift_at: hoursAgo(21), state: 'locked' }, NOW), true,
    'a day-old batch is refused by the other office; renew it before the phone finds out');
  assert.equal(H.needsTicket({ shift_server: HOPE, shift_batch: null, state: 'released' }, NOW), false);
  assert.equal(H.needsTicket({ shift_server: null, state: 'locked' }, NOW), false);
});

test('the settings memo fails CLOSED on the buyer and soft on the address', async () => {
  const d = book({ settings: [{ key: 'DEVICE_HANDOVER_BUYER', value: 'none' }, { key: 'DEVICE_SHIFT_PARTNER', value: 'https://other.example/' }] });
  const cfg = await H.handoverConfig(d, NOW);
  assert.deepEqual(cfg.buyers, []);
  assert.equal(cfg.server, 'https://other.example');
  // A settings table that cannot be asked queues nothing this minute rather than guessing.
  const broken = { from: () => { throw new Error('boom'); } };
  const c2 = await H.handoverConfig(broken, NOW);
  assert.deepEqual(c2.buyers, []);
  assert.equal(c2.server, H.DEFAULT_PARTNER);
  assert.equal(c2.asked, false);
  // Memoised: a write busts it, otherwise the same answer comes back without a read.
  d._dump('settings').find(s => s.key === 'DEVICE_HANDOVER_BUYER').value = '';
  assert.deepEqual((await H.handoverConfig(d, NOW + 1000)).buyers, [], 'still the memo');
  H.noteHandoverSettingsWritten(d);
  assert.deepEqual((await H.handoverConfig(d, NOW + 1000)).buyers, ['HOPE MICROCREDIT'], 'busted, re-read');
});

/* ------------------------------------------------------------------------------------------
   THE FIRST HALF: QUEUE. One update returning rows, one event insert, nothing else.
   ------------------------------------------------------------------------------------------ */
test('queueHandover marks only phones on the register that are not already ordered or released', async () => {
  const d = book({ devices: [
    dev({ imei: 'Q1' }),                                            // sold, ours, locked  -> queued
    dev({ imei: 'Q2', state: 'released', by: 'SIPHO' }),           // achia'd: nothing is listening
    dev({ imei: 'Q3', shift_server: HOPE, shift_batch: HEX, shift_at: hoursAgo(1) }),   // already ordered
  ] });
  const cfg = { server: HOPE, buyers: ['HOPE MICROCREDIT'] };
  const sold = new Map([['Q1', 'HOPE MICROCREDIT'], ['Q2', 'HOPE MICROCREDIT'], ['Q3', 'HOPE MICROCREDIT'], ['GHOST', 'HOPE MICROCREDIT']]);
  const r = await H.queueHandover(d, sold, 'SIPHO', cfg, NOW);
  assert.equal(r.queued, 1);
  assert.deepEqual(r.imeis, ['Q1']);
  const rows = d._dump('devices');
  assert.equal(rows.find(x => x.imei === 'Q1').shift_server, HOPE);
  assert.equal(rows.find(x => x.imei === 'Q1').shift_batch, null, 'queued, not yet ordered: the phone hears nothing until a batch is fetched');
  assert.equal(rows.find(x => x.imei === 'Q2').shift_server, null);
  assert.equal(rows.find(x => x.imei === 'Q3').shift_batch, HEX, 'an order already placed is left alone');
  const ev = d._dump('device_events');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event, 'handover-queued');
  assert.match(ev[0].reason, /HOPE MICROCREDIT/);
  assert.equal(ev[0].actor, 'SIPHO');
  // The phone's next beat carries NO shift: a queued row has no batch yet.
  const beat = await deviceApi(d, 'dev_beat', [{ token: 'tok-Q1', locked: true }], NOW);
  assert.equal(beat.shift, undefined);
});

test('before the shift migration, queueing says so and nothing throws', async () => {
  const d = book({ devices: [dev({ imei: 'M1' })],
    opts: { missingColumns: { devices: ['shift_server', 'shift_batch', 'shift_at'] } } });
  const r = await H.queueHandover(d, ['M1'], 'SIPHO', { server: HOPE, buyers: ['HOPE MICROCREDIT'] }, NOW);
  assert.equal(r.queued, 0);
  assert.match(r.note, /RUN-ME-2026-09-15-device-shift\.sql/);
  assert.equal(d._dump('device_events').length, 0);
});

/* ------------------------------------------------------------------------------------------
   THE SECOND HALF: COMPLETE. Asks HOPE once, writes the batch, and says what it could not do.
   ------------------------------------------------------------------------------------------ */
test('completeHandovers gives every queued row its batch from the other office and the phone moves on its next beat', async () => {
  await withSecret(async () => {
    const d = book({ devices: [
      dev({ imei: 'C1', shift_server: HOPE, item: 'SAMSUNG A07-64GB' }),
      dev({ imei: 'C2', shift_server: HOPE, item: null }),
      dev({ imei: 'C3' }),                                             // not sold: untouched
    ] });
    H._resetHandover(d);
    const hope = stubHope();
    try {
      const r = await H.completeHandovers(d, 'SIPHO', {}, NOW);
      assert.equal(r.ordered, 2);
      assert.equal(r.pending, 0);
      assert.equal(hope.calls.length, 1, 'one call for the whole queue, not one per phone');
      assert.equal(hope.calls[0].url, HOPE + '/api/shift-batch');
      assert.equal(hope.calls[0].body.from, 'HOOP');
      assert.deepEqual(hope.calls[0].body.imeis, ['C1', 'C2']);
      assert.deepEqual(hope.calls[0].body.details, [{ imei: 'C1', item: 'SAMSUNG A07-64GB' }, { imei: 'C2', item: null }],
        'the model travels so HOPE\'s register does not show a blank');
      const rows = d._dump('devices');
      assert.equal(rows.find(x => x.imei === 'C1').shift_batch, HEX);
      assert.equal(rows.find(x => x.imei === 'C3').shift_server, null);
      assert.equal(d._dump('device_events').filter(e => e.event === 'shift-ordered').length, 2);
    } finally { hope.done(); }
    const beat = await deviceApi(d, 'dev_beat', [{ token: 'tok-C1', locked: true }], NOW);
    assert.deepEqual(beat.shift, { server: HOPE, batch: HEX }, 'exactly what Hamisha would have written');
  });
});

test('no secret: the queue stays queued, the reason is named, and it is retried -- but not more than once a minute', async () => {
  await withoutSecret(async () => {
    const d = book({ devices: [dev({ imei: 'N1', shift_server: HOPE })] });
    H._resetHandover(d);
    const r = await H.completeHandovers(d, 'SIPHO', {}, NOW);
    assert.equal(r.ordered, 0);
    assert.equal(r.pending, 1);
    assert.match(r.note, /DEVICE_SHIFT_SECRET/);
    assert.equal(d._dump('devices')[0].shift_batch, null);
    const again = await H.completeHandovers(d, 'SIPHO', {}, NOW + 10000);
    assert.equal(again.throttled, true, 'a partner that just said no is not asked again ten seconds later');
    assert.equal(again.pending, 1);
    const forced = await H.completeHandovers(d, 'SIPHO', { force: true }, NOW + 10000);
    assert.equal(forced.throttled, undefined, 'the button does not wait');
    assert.match(forced.note, /DEVICE_SHIFT_SECRET/);
  });
});

test('a partner that refuses or cannot be reached is a sentence, never a thrown pane, and the rows stay queued', async () => {
  await withSecret(async () => {
    const d = book({ devices: [dev({ imei: 'R1', shift_server: HOPE })] });
    H._resetHandover(d);
    const hope = stubHope(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'Shift secret refused.' }) }));
    try {
      const r = await H.completeHandovers(d, 'SIPHO', {}, NOW);
      assert.equal(r.ordered, 0); assert.equal(r.pending, 1);
      assert.match(r.note, /refused/i);
    } finally { hope.done(); }
    const down = stubHope(async () => { throw new Error('ECONNRESET'); });
    try {
      const r = await H.completeHandovers(d, 'SIPHO', { force: true }, NOW);
      assert.equal(r.ordered, 0);
      assert.match(r.note, /could not be reached/i);
    } finally { down.done(); }
    assert.equal(d._dump('devices')[0].shift_batch, null, 'still queued for the next open');
  });
});

test('an order the phone never collected is renewed before its batch expires', async () => {
  await withSecret(async () => {
    const d = book({ devices: [
      dev({ imei: 'E1', shift_server: HOPE, shift_batch: 'a'.repeat(32), shift_at: hoursAgo(21) }),  // expiring
      dev({ imei: 'E2', shift_server: HOPE, shift_batch: 'b'.repeat(32), shift_at: hoursAgo(2) }),   // fresh
    ] });
    H._resetHandover(d);
    const hope = stubHope();
    try {
      const r = await H.completeHandovers(d, 'SIPHO', {}, NOW);
      assert.equal(r.renewed, 1); assert.equal(r.ordered, 0);
      assert.deepEqual(hope.calls[0].body.imeis, ['E1']);
    } finally { hope.done(); }
    const rows = d._dump('devices');
    assert.equal(rows.find(x => x.imei === 'E1').shift_batch, HEX, 'a fresh batch, same office, same phone');
    assert.equal(rows.find(x => x.imei === 'E1').shift_at, iso(NOW));
    assert.equal(rows.find(x => x.imei === 'E2').shift_batch, 'b'.repeat(32), 'a live order is not touched');
    const ev = d._dump('device_events').find(e => e.imei === 'E1');
    assert.match(ev.reason, /batch mpya|renewed/);
  });
});

test('the partner call is bounded: a HOPE that never answers is abandoned, not waited out', async () => {
  await withSecret(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    try {
      await assert.rejects(() => H.shiftBatchFromPartner(HOPE, ['T1'], { timeoutMs: 30 }),
        e => e.status === 400 && /could not be reached/i.test(e.message));
    } finally { globalThis.fetch = real; }
  });
});

/* ------------------------------------------------------------------------------------------
   THE UPLOAD QUEUES, AND ONLY QUEUES. The real handler, against a fake database, the way
   test/upload-speed.test.mjs drives it.
   ------------------------------------------------------------------------------------------ */
const SALES_HEADERS = ['SALE_DATE', 'BRANCH', 'AGENT', 'CLIENT_NAME', 'CLIENT_PHONE', 'MODEL', 'RECEIPT_NUMBER', 'IMEI',
  'COMMISSION_AGENT', 'COMMISSION_PHONE', 'PRICE'];
const salesRow = (imei, customer) => ['29-Aug-26', 'HOOP LIMITED', 'ELIA CHITUZI', customer, '0677111920', 'SAMSUNG A07-64GB',
  'R' + imei, imei, 'ELIA CHITUZI', '0673170988', '503000'];
const CODE_ROW = { code: 'U1', name: 'UPLOADER', role: 'ADMIN', teams: null, tabs: [] };
function counting(tables) {
  const db0 = fakeDb(tables);
  let trips = 0; const calls = [];
  const wrap = q => new Proxy(q, { get(o, p) {
    if (p === 'then') return (res, rej) => o.then(r => { trips++; calls.push(o.tableName + ':' + o.mode); return res(r); }, rej);
    const v = o[p];
    return typeof v === 'function' ? (...a) => { const out = v.apply(o, a); return out === o ? wrap(o) : out; } : v;
  } });
  return { db: { from: n => wrap(db0.from(n)), rpc: (n, a) => wrap(db0.rpc(n, a)), _dump: n => db0._dump(n) },
    trips: () => trips, calls };
}
async function withFakeSupabase(fake, fn) {
  const hadOwn = Object.prototype.hasOwnProperty.call(supabase, 'from');
  const saved = supabase.from;
  supabase.from = fake.from;
  try { return await fn(); } finally { if (hadOwn) supabase.from = saved; else delete supabase.from; }
}
async function post(body) {
  const res = { statusCode: null, body: null, setHeader() {}, status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; }, end() {} };
  await upload({ method: 'POST', body }, res);
  if (res.body && res.body.ok === false) throw new Error('upload refused: ' + res.body.error);
  return res.body;
}
function resetCaches() { clearRolesCache(supabase); clearSystemOpenCache(supabase); _resetSeen(); H._resetHandover(supabase); clearStockIndex(supabase); }
const uploadBook = devices => ({ access_codes: [{ ...CODE_ROW }], roles: [], settings: [], signin_attempts: [], teams: [],
  hoop_sales: [], devices, device_events: [], audit_log: [] });

test('a sales upload queues the phones sold to the partner -- one keyed write, no call to HOPE, and it says so', async () => {
  await withoutSecret(async () => {
    resetCaches();
    const c = counting(uploadBook([dev({ imei: '356562653724749' }), dev({ imei: '356562653724750' })]));
    const hope = stubHope();
    let result;
    try {
      result = await withFakeSupabase(c.db, () => post({ code: 'U1',
        rows: [SALES_HEADERS, salesRow('356562653724749', 'HOPE MICROCREDIT'), salesRow('356562653724750', 'Fredy J Damasi'),
          salesRow('356562653724751', 'HOPE MICROCREDIT')],
        meta: { uploadDate: '2026-09-28', kind: 'sales' }, part: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', index: 0, total: 1 } }));
    } finally { hope.done(); }
    assert.equal(result.kind, 'sales');
    assert.equal(result.inserted, 3);
    assert.deepEqual(result.handover, { sold: 2, queued: 1, server: H.DEFAULT_PARTNER, note: null },
      'two sold to the partner in the file; one of them is on our register');
    assert.equal(hope.calls.length, 0, 'THE UPLOAD NEVER CALLS THE OTHER OFFICE');
    const rows = c.db._dump('devices');
    assert.equal(rows.find(r => r.imei === '356562653724749').shift_server, H.DEFAULT_PARTNER);
    assert.equal(rows.find(r => r.imei === '356562653724749').shift_batch, null);
    assert.equal(rows.find(r => r.imei === '356562653724750').shift_server, null, 'sold to a customer, not the partner');
    assert.equal(c.db._dump('device_events').filter(e => e.event === 'handover-queued').length, 1);
  });
});

test('speed: a sales slice with no partner sale costs what it always did plus one memoised settings read; with one, two bounded writes more', async () => {
  resetCaches();
  const plain = counting(uploadBook([dev({ imei: '356562653724749' })]));
  await withFakeSupabase(plain.db, () => post({ code: 'U1',
    rows: [SALES_HEADERS, salesRow('356562653724749', 'Fredy J Damasi')],
    meta: { uploadDate: '2026-09-28', kind: 'sales' }, part: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', index: 0, total: 1 } }));
  const base = plain.trips();
  resetCaches();
  const partner = counting(uploadBook([dev({ imei: '356562653724749' })]));
  await withFakeSupabase(partner.db, () => post({ code: 'U1',
    rows: [SALES_HEADERS, salesRow('356562653724749', 'HOPE MICROCREDIT')],
    meta: { uploadDate: '2026-09-28', kind: 'sales' }, part: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', index: 0, total: 1 } }));
  const withQueue = partner.trips();
  assert.equal(withQueue - base, 2, 'exactly the update-returning-rows and the event insert (' + base + ' -> ' + withQueue + ')');
  assert.equal(partner.calls.filter(k => k === 'settings:select').length, 1, 'the buyer/partner settings are read once, memoised');
  // The ceiling the whole sales slice must stay under, cold: measured ' + base + ' without a partner sale.
  assert.ok(base <= 8, 'a plain sales slice took ' + base + ' round trips (budget 8). Before raising this: can the database do the work instead?');
});

test('a sales upload before the shift migration still lands the sales and names the migration', async () => {
  resetCaches();
  const c = counting({ ...uploadBook([dev({ imei: '356562653724749' })]) });
  const db0 = fakeDb({ ...uploadBook([dev({ imei: '356562653724749' })]) }, { missingColumns: { devices: ['shift_server', 'shift_batch', 'shift_at'] } });
  const result = await withFakeSupabase(db0, () => post({ code: 'U1',
    rows: [SALES_HEADERS, salesRow('356562653724749', 'HOPE MICROCREDIT')],
    meta: { uploadDate: '2026-09-28', kind: 'sales' }, part: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', index: 0, total: 1 } }));
  assert.equal(result.inserted, 1, 'the sales are in regardless');
  assert.equal(result.handover.queued, 0);
  assert.match(result.handover.note, /RUN-ME-2026-09-15-device-shift\.sql/);
  void c;
});

/* ------------------------------------------------------------------------------------------
   THE PANES SAY IT, AND THE DEVICES PANE COMPLETES IT.
   ------------------------------------------------------------------------------------------ */
test('the Devices pane completes a queued handover off the rows it read, and every row says where it stands', async () => {
  await withSecret(async () => {
    const d = book({ devices: [
      dev({ imei: 'P1', shift_server: HOPE }),
      dev({ imei: 'P2', shift_server: HOPE, shift_batch: HEX, shift_at: hoursAgo(1), app: '1.11.8' }),
      dev({ imei: 'P3', state: 'released', by: 'shift' }),
      dev({ imei: 'P4' }),
    ], settings: [{ key: 'DEVICE_SHIFT_PARTNER', value: 'https://other.example/' }] });
    H._resetHandover(d);
    const hope = stubHope();
    let list;
    try { list = await _FNS.deviceList(d, STORE, { pane: 'lock' }); } finally { hope.done(); }
    assert.equal(list.handover.ordered, 1, 'P1 got its batch on this open');
    assert.equal(hope.calls.length, 1);
    assert.equal(list.shiftPartner, 'https://other.example', 'the drawer\'s address comes from the setting now');
    const by = Object.fromEntries(list.rows.map(r => [r.imei, r]));
    assert.equal(by.P3, undefined, 'a phone that has gone is off the pane');
    assert.equal(by.P2.shiftPending, true);
    assert.equal(by.P2.shiftAppTooOld, true, 'an app that cannot read the order is the one case worth flagging');
    assert.equal(by.P4.shiftPending, false); assert.equal(by.P4.shiftQueued, false);
    assert.equal(list.counts.shiftPending, 2, 'P1 is pending now that it has a batch');
    assert.equal(list.counts.shiftQueued, 0);
    // The unlocking desk pays no partner-address read and gets the same completion.
    const gone = await _FNS.deviceList(d, DESK, { q: 'P3' });
    assert.equal(gone.rows[0].shiftedAway, true, 'a search still finds it, and says where it went');
    assert.equal(gone.shiftPartner, null);
  });
});

test('the Unlocking desk sees a live, confirmed-locked phone first -- not below a shelf of silent boxed stock', async () => {
  const boxed = Array.from({ length: 6 }, (_, i) => dev({ imei: 'BOX' + i, reported: null, seen: null }));
  const d = book({ devices: [...boxed, dev({ imei: 'LIVE1', seen: hoursAgo(0.1) }), dev({ imei: 'LIVE2', seen: hoursAgo(0.5) })] });
  const bench = await _FNS.deviceList(d, STORE, { pane: 'lock' });
  assert.notEqual(bench.rows[0].imei, 'LIVE1', 'the bench keeps problems first');
  const desk = await _FNS.deviceList(d, DESK, { pane: 'unlock' });
  assert.deepEqual(desk.rows.slice(0, 2).map(r => r.imei), ['LIVE1', 'LIVE2'], 'newest beat first among the live locked');
});

test('a phone handed to the other office cannot be ordered about from here, and the answer says why', async () => {
  const d = book({ devices: [dev({ imei: 'G1', state: 'released', by: 'shift', seen: hoursAgo(1) }), dev({ imei: 'G2' })] });
  await assert.rejects(() => _FNS.deviceSetState(d, DESK, { imeis: ['G1'], state: 'enrolled' }),
    e => e.status === 400 && /other office|ofisi nyingine/.test(e.message));
  const mixed = await _FNS.deviceSetState(d, DESK, { imeis: ['G1', 'G2'], state: 'enrolled' });
  assert.equal(mixed.changed, 1);
  assert.equal(mixed.shiftedAway, 1);
  assert.equal(d._dump('devices').find(r => r.imei === 'G1').state, 'released', 'untouched');
});

test('NEW STOCK queues every phone the sales book says is the partner\'s -- including sales that landed long ago -- and calls a shifted phone shifted', async () => {
  await withSecret(async () => {
    const d = book({
      devices: [dev({ imei: '356562653724749' }), dev({ imei: 'S2', state: 'released', by: 'shift' }), dev({ imei: 'S3' })],
      sales: [sale({ imei: '356562653724749' }), sale({ imei: 'S3', customer: 'Fredy J Damasi' }), sale({ imei: 'S2' })],
    });
    clearStockIndex(d); H._resetHandover(d);
    const hope = stubHope();
    let r;
    try { r = await _FNS.newStock(d, STORE, {}); } finally { hope.done(); }
    assert.equal(r.handover.queued, 1, 'the owner\'s own example, sold 29 Aug, is queued on the first open');
    assert.equal(r.handover.ordered, 1, 'and given its batch in the same open');
    const by = Object.fromEntries(r.rows.map(x => [x.imei, x]));
    assert.equal(by['356562653724749'].shiftPending, true);
    assert.equal(by['356562653724749'].shiftTo, H.DEFAULT_PARTNER);
    assert.equal(by.S2.status, 'shifted', 'not "achia": nobody\'s loan ended');
    assert.equal(r.counts.shifted, 1);
    assert.equal(r.counts.achia, 0);
    assert.equal(by.S3.shiftQueued, false, 'sold to a customer: stays ours');
    const row = d._dump('devices').find(x => x.imei === '356562653724749');
    assert.equal(row.shift_batch, HEX);
    // A second open a moment later finds nothing to do and asks nobody.
    const again = stubHope();
    let r2;
    try { r2 = await _FNS.newStock(d, STORE, {}); } finally { again.done(); }
    assert.equal(again.calls.length, 0);
    assert.equal(r2.handover && r2.handover.queued, 0);
  });
});

test('a read-only open of NEW STOCK moves nothing', async () => {
  const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['newstock'], readOnly: true };
  const d = book({ devices: [dev({ imei: 'V1' })], sales: [sale({ imei: 'V1' })] });
  clearStockIndex(d);
  const r = await _FNS.newStock(d, VIEWER, {});
  assert.equal(r.handover, null);
  assert.equal(d._dump('devices')[0].shift_server, null);
});

test('enrolling a phone the book already sold to the partner queues it, orders it, and says so -- and the batch is 32 hex', async () => {
  await withSecret(async () => {
    const d = book({ sales: [sale({ imei: '356562653724749' })] });
    H._resetHandover(d);
    const hope = stubHope();
    let r;
    try { r = await _FNS.deviceEnrol(d, STORE, { imeis: ['356562653724749', '356562653724750'] }); } finally { hope.done(); }
    assert.equal(r.enrolled, 2);
    assert.match(r.batch, /^[0-9a-f]{32}$/, 'the shape every register in this family mints -- and the only one the other way round accepts');
    assert.deepEqual(r.handover, { sold: 1, queued: 1, ordered: 1, pending: 0, server: H.DEFAULT_PARTNER, note: null });
    const row = d._dump('devices').find(x => x.imei === '356562653724749');
    assert.equal(row.shift_server, H.DEFAULT_PARTNER);
    assert.equal(row.shift_batch, HEX, 'the phone\'s very first beat will carry it to HOPE');
    assert.ok(!d._dump('devices').find(x => x.imei === '356562653724750').shift_server, 'a phone sold to nobody stays ours');
    // The beat: a shift order rides it, exactly like a lock order.
    const beat = await deviceApi(d, 'dev_beat', [{ token: row.enrol_token }], NOW);
    assert.deepEqual(beat.shift, { server: H.DEFAULT_PARTNER, batch: HEX });
  });
});

test('deviceHandover: the button checks the sales book itself, then completes without waiting for the throttle', async () => {
  await withSecret(async () => {
    const d = book({ devices: [dev({ imei: 'B1' }), dev({ imei: 'B2' }), dev({ imei: 'B3', shift_server: HOPE })],
      sales: [sale({ imei: 'B1' }), sale({ imei: 'B2', customer: 'Juma' })] });
    H._resetHandover(d);
    const hope = stubHope();
    let r;
    try { r = await _FNS.deviceHandover(d, STORE, { imeis: ['B1', 'B2'] }); } finally { hope.done(); }
    assert.equal(r.queued, 1, 'B1 is the partner\'s');
    assert.equal(r.notSold, 1, 'B2 is not, whatever the tick said');
    assert.equal(r.ordered, 2, 'B1 and the already-queued B3 both get their batch');
    assert.equal(r.pending, 0);
    await assert.rejects(() => _FNS.deviceHandover(d, DESK, {}), e => e.status === 403, 'a shift is an order: the bench\'s door');
  });
});

test('the two settings are editable from the Settings pane and a write busts the memo', async () => {
  const d = book({ settings: [] });
  const s = await _FNS.settings(d, ADMIN);
  const keys = s.settings.map(x => x.key);
  assert.ok(keys.includes('DEVICE_SHIFT_PARTNER') && keys.includes('DEVICE_HANDOVER_BUYER'));
  await _FNS.settingSet(d, ADMIN, { key: 'DEVICE_HANDOVER_BUYER', value: 'none' });
  assert.deepEqual((await H.handoverConfig(d)).buyers, []);
  await _FNS.settingSet(d, ADMIN, { key: 'DEVICE_HANDOVER_BUYER', value: '' });
  assert.deepEqual((await H.handoverConfig(d)).buyers, ['HOPE MICROCREDIT'], 'the write busted the memo');
});
