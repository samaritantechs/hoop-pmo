import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { todayKey, addDaysKey } from '../api/_lib/time.js';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
const { _FNS } = await import('../api/portal.js');
const { clearStockIndex } = await import('../api/_lib/stock-index.js');

/* =========================================================================================
   THE POSTGRES-WAR SWEEP ON THE STOCK CLUSTER -- verified fixes 1-5 (2026-09-20 audit).

   This is a NEW file, not an edit to test/speed.test.mjs: the counting() proxy below is
   copied from there verbatim (same shape, extended with a per-table trip count, which the
   fixes here need to prove and the original never had to). Every BUDGETS row in that file
   stays a ceiling; nothing here lowers one -- these tests prove the FIX, not re-litigate the
   baseline.
   ========================================================================================= */

/** Counts every request the code sends, exactly as fetchAll issues it: one trip per awaited
    builder, rows counted where they are answered, and (new here) which TABLE each trip named
    -- the stock-index memo tests need to know not just "how many trips" but "did this one
    touch hoop_agents again". */
export function counting(tables, opts) {
  const db0 = fakeDb(tables, opts);
  let trips = 0, rows = 0;
  const byTable = {};
  const wrap = (q, table) => new Proxy(q, { get(o, p) {
    if (p === 'then') return (res, rej) => o.then(r => {
      trips++; if (Array.isArray(r.data)) rows += r.data.length;
      if (table) byTable[table] = (byTable[table] || 0) + 1;
      return res(r);
    }, rej);
    const v = o[p];
    return typeof v === 'function' ? (...a) => { const out = v.apply(o, a); return out === o ? wrap(o, table) : out; } : v;
  } });
  return {
    db: { from: n => wrap(db0.from(n), n), rpc: (n, a) => wrap(db0.rpc(n, a)), _dump: n => db0._dump(n) },
    stat: () => ({ trips, rows }),
    tableTrips: n => byTable[n] || 0,
  };
}

const TODAY = todayKey();
const D = n => addDaysKey(TODAY, n);
const ADMIN = { code: 'A1', name: 'PETER ADMIN', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'], readOnly: false };
const RSM = { code: 'R1', name: 'RSM ONE', role: 'RSM', teams: ['BRANCH01'],
  tabs: ['oldstock', 'newstock', 'stockreq', 'stockappr', 'stockrep', 'transfers'], readOnly: false };
const STORE = { code: 'S1', name: 'SIPHO', role: 'STORE', teams: null,
  tabs: ['oldstock', 'newstock', 'stockreq', 'stockappr', 'stockrep', 'transfers', 'devlock'], readOnly: false };

const old = (o = {}) => ({
  imei: o.imei, item: o.item || 'SAMSUNG A07-64GB',
  agent: o.agent === undefined ? 'AGENT ONE' : o.agent, agent_phone: '0700000011',
  rsm: o.rsm === undefined ? 'RSM ONE' : o.rsm, rsm_phone: '0700000001',
  age_days: o.age === undefined ? 10 : o.age, as_of: o.asOf || TODAY,
});
const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};
const aRequest = o => ({
  id: o.id, requested_at: o.at || TODAY + 'T06:00:00Z',
  staff_code: o.code || 'R1', staff_name: o.name || 'RSM ONE', staff_role: 'RSM',
  holder: o.holder || 'RSM ONE', destination: 'Depot', item: 'A07',
  qty: o.qty == null ? 10 : o.qty, reason: 'x',
  aging_count: 0, aging_oldest_days: null, aging_as_of: TODAY,
  status: o.status || 'pending', approved_qty: o.approvedQty == null ? null : o.approvedQty,
  comment: null, decided_by: null, decided_at: null,
  aging_override: false, aging_override_reason: null, issued_at: null, issued_by: null,
  updated_by: 'RSM ONE', updated_at: o.at || TODAY + 'T06:00:00Z',
});

/** The whole stock-cluster fixture, shared by most tests below: an RSM with a couple of
    agents, some old stock, a couple of enrolled devices, and the two decks the aging gate and
    the sale audit each read. Small on purpose -- these tests are about the SHAPE of the reads
    (does a second call cost less, does a bust make the third call fresh), not their size. */
function book(extra) {
  return Object.assign({
    old_stock: [old({ imei: '861000000000001' }), old({ imei: '861000000000002' })],
    devices: [],
    hoop_agents: [
      { phone: '0700000001', name: 'RSM ONE', role: 'Regional_Manager', branch: 'BRANCH01', manager: null },
      { phone: '0700000011', name: 'AGENT ONE', role: 'Field_Officer', branch: 'BRANCH01', manager: 'RSM ONE' },
    ],
    watu_loans: [], hoop_sales: [], stock_audit: [], hoop_aged_stock: [],
    settings: [], stock_requests: [], access_codes: [
      { code: 'R1', name: 'RSM ONE', role: 'RSM' }, { code: 'S1', name: 'SIPHO', role: 'STORE' },
      { code: 'A1', name: 'PETER ADMIN', role: 'ADMIN' },
    ],
    transfers: [], transfer_items: [],
  }, extra);
}

/* =====================================================================================
   FIX 1 -- oldStockIndex / stockAgingIndex: one aux memo, not nine rebuilds.
   ===================================================================================== */

test('fix1: two back-to-back stockMine calls cost the aux reads once', async () => {
  const c = counting(book({ stock_requests: [aRequest({ id: uid('m1') })] }));
  await _FNS.stockMine(c.db, RSM);
  const first = c.stat();
  await _FNS.stockMine(c.db, RSM);
  const second = { trips: c.stat().trips - first.trips, rows: c.stat().rows - first.rows };
  // old_stock is never memoised (fresh every time, by design) and stock_requests is its own
  // read -- so the SECOND call still pays those two, and nothing else: the six-table aux
  // (devices/watu_loans/hoop_agents/hoop_sales/stock_audit/hoop_aged_stock) plus the policy
  // read are all served warm.
  assert.ok(second.trips <= 3, `second stockMine call cost ${second.trips} trips (want <= 3 -- old_stock + stock_requests + policy at most)`);
  assert.ok(second.trips < first.trips, `the memo bought nothing: first ${first.trips}, second ${second.trips}`);
});

test('fix1: deviceEnrol busts the memo, and oldStock sees the new device on its next open', async () => {
  const c = counting(book());
  const before = await _FNS.oldStock(c.db, STORE, {});
  assert.deepEqual(before.rows.map(r => r.imei).sort(), ['861000000000001', '861000000000002']);
  await _FNS.deviceEnrol(c.db, STORE, { imeis: ['861000000000001'] });
  const after = await _FNS.oldStock(c.db, STORE, {});
  assert.deepEqual(after.rows.map(r => r.imei), ['861000000000002'],
    'the freshly-enrolled handset must not still read as un-enrolled off a warm memo');
});

test('fix1: deviceDelete busts the memo too', async () => {
  const c = counting(book());
  await _FNS.deviceEnrol(c.db, STORE, { imeis: ['861000000000001'] });
  const locked = await _FNS.oldStock(c.db, STORE, {});
  assert.equal(locked.counts.locked, 1);
  await _FNS.deviceDelete(c.db, STORE, { imei: '861000000000001' });
  const after = await _FNS.oldStock(c.db, STORE, {});
  assert.deepEqual(after.rows.map(r => r.imei).sort(), ['861000000000001', '861000000000002'],
    'a deleted device must not still read as locked off a warm memo');
});

test('fix1: stockDecide bypasses the memo (fresh: true) -- the naive fix fails this', async () => {
  // AGENT ONE is aging from the start (blocked), and old_stock itself is NEVER memoised (see
  // stock-index.js's header) -- so the only way to demonstrate the AUX memo going stale is to
  // change one of the tables it DOES cache (devices) without going through a buster, which is
  // exactly the gap `fresh: true` exists to be safe against even if a buster call were ever
  // missing or wrong.
  const c = counting(book({
    old_stock: [old({ imei: '861000000009999', agent: 'AGENT ONE', age: 90 })],
    stock_requests: [aRequest({ id: uid('d1'), holder: 'AGENT ONE' })],
  }));
  const before = await _FNS.stockQueue(c.db, STORE, {});
  assert.equal(before.rows[0].agingNow.blocked, true, 'sanity: blocked from the start');

  // The handset gets locked -- WITHOUT going through deviceEnrol (whatever the reason: this
  // stands in for a buster that never fires), so the memo's `locked` Set never hears about it.
  c.db._dump('devices').push({ imei: '861000000009999', item: 'A07', holder: 'AGENT ONE', state: 'locked' });

  // A plain (non-fresh) read is ALLOWED to answer off the now-stale warm memo -- that is the
  // whole point of it existing -- so this is the control, not the assertion under test.
  const stale = await _FNS.stockQueue(c.db, STORE, {});
  assert.equal(stale.rows[0].agingNow.blocked, true, 'the ordinary queue view may still be warm');

  // But the SOP-E release decision must never trust that memo: stockDecide is required to
  // read fresh and see the handset is locked now, so AGENT ONE is clear to receive stock.
  const decided = await _FNS.stockDecide(c.db, STORE, { id: uid('d1'), approve: true });
  assert.equal(decided.status, 'approved', 'stockDecide answered off a stale memo instead of reading fresh');
});

/* =====================================================================================
   FIX 2 -- hoop_agents read once per request, not 2-3 times.
   ===================================================================================== */

test('fix2: oldStock for an RSM reads hoop_agents exactly once', async () => {
  const c = counting(book({ old_stock: [old({ imei: '861000000000001', agent: 'AGENT ONE' })] }));
  await _FNS.oldStock(c.db, RSM, {});
  assert.equal(c.tableTrips('hoop_agents'), 1,
    `hoop_agents was read ${c.tableTrips('hoop_agents')} times (oldStockIndex's feed, stockAllow, syncStaffFromStock each used to fetch it separately)`);
});

test('fix2: newStock reads hoop_agents exactly once', async () => {
  const c = counting(book());
  await _FNS.newStock(c.db, RSM, {});
  assert.equal(c.tableTrips('hoop_agents'), 1, `hoop_agents was read ${c.tableTrips('hoop_agents')} times`);
});

/* =====================================================================================
   FIX 3 -- newStock's own join, memoised (minus the two live tables).
   ===================================================================================== */

test('fix3: a second newStock call within the TTL costs far fewer trips', async () => {
  const c = counting(book());
  await _FNS.newStock(c.db, RSM, {});
  const first = c.stat();
  await _FNS.newStock(c.db, RSM, {});
  const second = { trips: c.stat().trips - first.trips };
  // devices and stock_audit are read live every call by design (see newStockFeeds's header);
  // watu_loans / hoop_sales / hoop_agents / hoop_aged_stock / old_stock come off the memo.
  assert.ok(second.trips < first.trips,
    `second newStock call cost ${second.trips} trips against a first of ${first.trips} -- the feed memo bought nothing`);
});

test('fix3: a status-tile call returns the same rows as a fresh call', async () => {
  const c1 = counting(book());
  const fresh = await _FNS.newStock(c1.db, ADMIN, { status: 'unlocked' });
  const c2 = counting(book());
  await _FNS.newStock(c2.db, ADMIN, {});
  const tile = await _FNS.newStock(c2.db, ADMIN, { status: 'unlocked' });
  assert.deepEqual(tile.rows.map(r => r.imei).sort(), fresh.rows.map(r => r.imei).sort());
});

test('fix3: a deviceEnrol between two newStock calls is visible on the second', async () => {
  const c = counting(book());
  const before = await _FNS.newStock(c.db, STORE, {});
  assert.equal(before.rows.find(r => r.imei === '861000000000001'), undefined,
    'not enrolled yet, so not in the register-backed rows (it may still show via the old-stock join)');
  await _FNS.deviceEnrol(c.db, STORE, { imeis: ['861000000000001'] });
  const after = await _FNS.newStock(c.db, STORE, {});
  const row = after.rows.find(r => r.imei === '861000000000001');
  assert.ok(row, 'the freshly-enrolled handset must appear');
  assert.equal(row.status, 'unlocked');
});

/* =====================================================================================
   FIX 4 -- stockIssue moves a handover's holders in 200-IMEI chunks, not one trip per phone.
   ===================================================================================== */

test('fix4: a handover of more than 200 IMEIs moves them in ceil(N/200) trips', async () => {
  const N = 350;
  const imei = i => '3510010' + String(1000000 + i).slice(-9);
  const imeis = Array.from({ length: N }, (_, i) => imei(i));
  const devices = imeis.map(im => ({ imei: im, item: 'A07', holder: 'SIPHO', state: 'enrolled' }));
  const c = counting(book({
    devices,
    stock_requests: [aRequest({ id: uid('big'), status: 'approved', approvedQty: N, holder: 'AGENT ONE' })],
  }));
  const r = await _FNS.stockIssue(c.db, STORE, {
    id: uid('big'), receivedBy: 'Agent One', countedJointly: true, imeis,
  });
  assert.equal(r.imeis, N);
  assert.equal(r.holdersMoved, N, 'every one of them is on the registry');
  // stockIssue's only reads/writes against 'devices' are the holder-move updates themselves
  // (nothing else in this call touches that table), so every trip counted here is one of them.
  assert.equal(c.tableTrips('devices'), Math.ceil(N / 200),
    `moved ${N} IMEIs in ${c.tableTrips('devices')} trips to devices (want ${Math.ceil(N / 200)})`);
});

/* =====================================================================================
   test/old-stock.test.mjs, test/stock-requests.test.mjs, test/new-stock.test.mjs are the
   regression net for these three fixes and are run unmodified (bar the three explicit
   cache-bust calls new-stock.test.mjs now needs -- see its own header note there); nothing
   here duplicates them.
   ===================================================================================== */
