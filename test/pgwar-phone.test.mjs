/* THE POSTGRES-WAR PHONE BATCH -- verified fixes to the shared caches behind the calls app.
 * =========================================================================================
 * A NEW FILE, DELIBERATELY -- test/speed.test.mjs is not touched here (other batches are
 * editing it in parallel; the merge has to stay clean), but its COUNTING PATTERN is copied
 * below so these tests measure trips and rows the same honest way: one round trip per
 * awaited PostgREST request, rows counted where they are answered.
 *
 * Each block below pins down ONE claim from the postgres-war audit (2026-09-20/21):
 *   1. rosterFull is memoised per db and shared across handsets.
 *   2. the deck (followup_status's newest deck_date) is memoised per db, and a comment
 *      write-throughs into it instead of forcing a rebuild.
 *   3. agentIndex de-dupes concurrent cold builds, and portal writes bust it explicitly.
 *   4. (no new test -- see the note above summaryForOfficer/summaryForRole in call-core.js;
 *      the per-officer cache key is correct and stays, only the header's claim was wrong.)
 *   5. device-core.js's beat() shares ONE settings read across its four helpers, that ONE
 *      read is itself memoised across handsets on the same warm process (bust on
 *      settingSet), and shifted() clears the shift order in one write instead of two.
 *   6. call.html's sync timer no longer forces a summary recompute on every tick.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
const { _FNS } = await import('../api/portal.js');
const { callApi, agentIndex, nameKey, rosterFull, _clearSummaryCache } = await import('../api/_lib/call-core.js');
const { deviceApi } = await import('../api/_lib/device-core.js');

/** Counts every request the code sends, exactly as fetchAll issues them -- copied from
    test/speed.test.mjs's counting() so the two files can change independently. */
function counting(tables, opts) {
  const db0 = fakeDb(tables, opts);
  let trips = 0, rows = 0;
  const wrap = q => new Proxy(q, { get(o, p) {
    if (p === 'then') return (res, rej) => o.then(r => {
      trips++; if (Array.isArray(r.data)) rows += r.data.length; return res(r);
    }, rej);
    const v = o[p];
    return typeof v === 'function' ? (...a) => { const out = v.apply(o, a); return out === o ? wrap(o) : out; } : v;
  } });
  return { db: { from: n => wrap(db0.from(n)), rpc: (n, a) => wrap(db0.rpc(n, a)), _dump: n => db0._dump(n) },
           stat: () => ({ trips, rows }) };
}

const NOW = Date.parse('2026-09-18T09:00:00Z');
const TODAY = '2026-09-18';
const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'], readOnly: false };

/* A small, hand-built book -- these tests are about the SHAPE of the caching, not about
   scale (test/speed.test.mjs's bigBook already proves this holds at 3,000 rows). */
function callBook() {
  return {
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D' }, { team: 'TEMEKE', team_code: 'XY7Z8W' }],
    access_codes: [],
    followup_status: [
      { imei: 'I1', client_name: 'One', contact: '255716000001', team: 'KINONDONI', model: 'A07', price: 450000,
        disbursed_date: '2026-08-01', days_offline: 5, locked4: false, locked7: false, has_ever_paid: false, deck_date: TODAY },
      { imei: 'I2', client_name: 'Two', contact: '255716000002', team: 'TEMEKE', model: 'A07', price: 450000,
        disbursed_date: '2026-08-01', days_offline: 5, locked4: false, locked7: false, has_ever_paid: false, deck_date: TODAY },
      { imei: 'I3', client_name: 'Three', contact: '255716000003', team: 'KINONDONI', model: 'A07', price: 450000,
        disbursed_date: '2026-08-01', days_offline: 5, locked4: false, locked7: false, has_ever_paid: false, deck_date: TODAY },
    ],
    followup_comments: [],
    call_users: [], call_logs: [],
  };
}
async function register(db, dev, name, passcode) {
  return callApi(db, 'api_callRegister', [dev, name, '', '', '07' + dev.replace(/\D/g, ''), passcode], NOW);
}

/* =========================================================================================
   1. rosterFull -- memoised per db, busted synchronously (see register() in call-core.js).
   ========================================================================================= */

test('rosterFull: two calls with no write between cost the roster once', async () => {
  const c = counting({
    call_users: [
      { user_id: 'U1', name: 'Ainea', role: 'CREDIT', active: true },
      { user_id: 'U2', name: 'Baraka', role: 'CREDIT', active: true },
    ],
    access_codes: [],
  });
  const a = await rosterFull(c.db, TODAY);
  const afterFirst = c.stat();
  assert.ok(afterFirst.trips >= 2, 'the first call really does read call_users and access_codes');
  const b = await rosterFull(c.db, TODAY);
  const afterSecond = c.stat();
  assert.equal(afterSecond.trips, afterFirst.trips, 'the second call costs NOTHING -- warm from cache');
  assert.equal(afterSecond.rows, afterFirst.rows);
  assert.deepEqual(a, b);
});

test('list(): two handsets, no write between, cost the roster and the deck once', async () => {
  // Registration happens OUTSIDE the counted instance -- these two are already at work, like
  // the other two hundred and ninety-eight; the measurement is of a THIRD opening the app.
  const c = counting(callBook());
  await register(c.db, 'dev-1', 'Ainea', 'AB2C3D');
  await register(c.db, 'dev-2', 'Baraka', 'XY7Z8W');
  const afterReg = c.stat();
  await callApi(c.db, 'api_callList', ['dev-1', 'today'], NOW);
  const afterFirst = c.stat();
  await callApi(c.db, 'api_callList', ['dev-2', 'today'], NOW);
  const afterSecond = c.stat();
  const first = { trips: afterFirst.trips - afterReg.trips, rows: afterFirst.rows - afterReg.rows };
  const second = { trips: afterSecond.trips - afterFirst.trips, rows: afterSecond.rows - afterFirst.rows };
  // The SECOND handset's list() must be dramatically cheaper than the first's: no re-read of
  // the roster (call_users+access_codes) or the deck (followup_status), only its own device
  // lookup plus each shared cache's own cheap freshness check.
  assert.ok(second.trips < first.trips, `second handset (${second.trips} trips) should beat the first (${first.trips})`);
  assert.ok(second.rows <= 6, `second handset read ${second.rows} rows -- the roster/deck must be shared, not re-fetched`);
});

test('register() busts the roster cache synchronously; the pool re-deals on the very next list()', async () => {
  // Pinned in test/call.test.mjs too ('registering another credit user re-deals the pool
  // automatically') -- kept here as well because it is the test a TTL-only cache fails: two
  // registrations and two list() calls all share the SAME pinned `nowMs`, so nothing here
  // would ever tell a TTL apart from the instant before it expired.
  const raw = fakeDb(callBook());
  await register(raw, 'dev-1', 'Ainea', 'AB2C3D');
  const before = await callApi(raw, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(before.rows.length, 3, 'alone, Ainea holds the whole book');
  await register(raw, 'dev-2', 'Baraka', 'XY7Z8W');
  const a = await callApi(raw, 'api_callList', ['dev-1', 'today'], NOW);
  const b = await callApi(raw, 'api_callList', ['dev-2', 'today'], NOW);
  assert.equal(a.rows.length + b.rows.length, 3, 'the pool is split, nothing lost or duplicated');
  assert.ok(a.rows.length >= 1 && b.rows.length >= 1, 'both hold work now that both are on the roster');
});

/* =========================================================================================
   2. THE DECK -- memoised per (db, deckDate, DATA_VERSION); a comment write-throughs.
   ========================================================================================= */

test('sharedDeck: list() twice with the same deckDate/DATA_VERSION costs the deck once', async () => {
  const c = counting(callBook());
  await register(c.db, 'dev-1', 'Ainea', 'AB2C3D');
  const afterReg = c.stat();
  await callApi(c.db, 'api_callList', ['dev-1', 'today'], NOW);
  const first = c.stat();
  await callApi(c.db, 'api_callList', ['dev-1', 'today'], NOW);
  const second = c.stat();
  const firstCost = { trips: first.trips - afterReg.trips, rows: first.rows - afterReg.rows };
  const delta = { trips: second.trips - first.trips, rows: second.rows - first.rows };
  assert.ok(delta.trips < firstCost.trips, `the second list() (${delta.trips} trips) should beat the first (${firstCost.trips})`);
  assert.ok(delta.rows <= 6, `the second list() read ${delta.rows} rows -- the deck must be warm, not re-fetched`);
});

test('addComment() write-through: the officer sees their own follow-up on the very next list(), with no DATA_VERSION bump', async () => {
  const raw = fakeDb(callBook());
  await register(raw, 'dev-1', 'Ainea', 'AB2C3D');
  await callApi(raw, 'api_callList', ['dev-1', 'today'], NOW);   // warm the shared deck cache
  const before = raw._dump('settings').find(r => r.key === 'DATA_VERSION').value;
  await callApi(raw, 'api_callAddComment', ['dev-1', {
    ref: 'I1', team: 'KINONDONI', name: 'One', fu: 'HAPATIKANI', comment: 'hakupatikani leo',
  }], NOW);
  const after = raw._dump('settings').find(r => r.key === 'DATA_VERSION').value;
  assert.equal(after, before, 'a comment must never bump DATA_VERSION -- see the note above sharedDeck');
  // The cache lives on the db object itself, so re-reading through the SAME `raw` is what
  // proves this is the write-through patch and not a coincidental rebuild.
  const r = await callApi(raw, 'api_callList', ['dev-1', 'today'], NOW);
  const row = r.rows.find(x => x.ref === 'I1');
  assert.ok(row, 'the commented customer is still on the list');
  assert.equal(row.fuStatus, 'HAPATIKANI', 'the write-through patch reached the cached row');
  const summary = await callApi(raw, 'api_callDailySummary', ['dev-1'], NOW);
  assert.equal(summary.ok, true, 'dailySummary keeps working off the same patched, shared deck');
});

test('a DATA_VERSION bump forces the deck to rebuild', async () => {
  const raw = fakeDb(callBook());
  await register(raw, 'dev-1', 'Ainea', 'AB2C3D');
  await callApi(raw, 'api_callList', ['dev-1', 'today'], NOW);   // warms the cache
  const c = counting({
    settings: raw._dump('settings'), teams: raw._dump('teams'), access_codes: raw._dump('access_codes'),
    followup_status: raw._dump('followup_status'), followup_comments: raw._dump('followup_comments'),
    call_users: raw._dump('call_users'), call_logs: raw._dump('call_logs'),
  });
  await callApi(c.db, 'api_callList', ['dev-1', 'today'], NOW);
  const warm = c.stat();
  c.db._dump('settings').find(r => r.key === 'DATA_VERSION').value = 'v2';
  await callApi(c.db, 'api_callList', ['dev-1', 'today'], NOW);
  const afterBump = c.stat();
  const bumpDelta = afterBump.rows - warm.rows;
  assert.ok(bumpDelta >= 3, `a version bump only re-read ${bumpDelta} rows -- the deck should have rebuilt (3 followup_status rows)`);
});

/* =========================================================================================
   3. agentIndex -- an in-flight promise, so concurrent cold callers build the register once.
   ========================================================================================= */

test('agentIndex: Promise.all of two calls on a cold cache builds the register ONCE', async () => {
  const c = counting({
    settings: [{ key: 'DATA_VERSION', value: 'v1' }],
    watu_loans: [{ imei: 'A', agent: 'X', agent_id: '1', branch: 'B' }],
    hoop_agents: [{ name: 'X', phone: '0700000001', branch: 'B', manager: null, role: 'Field_Officer' }],
    hoop_sales: [],
  });
  const [a, b] = await Promise.all([agentIndex(c.db, NOW), agentIndex(c.db, NOW)]);
  assert.equal(a, b, 'both callers get the SAME resolved object -- one build, not two');
  const stat = c.stat();
  // 2 x DATA_VERSION checks (one per caller -- these are never de-duped, only the BUILD is)
  // + ONE build's three table reads (watu_loans, hoop_agents, hoop_sales) = 5 trips.
  assert.ok(stat.trips <= 6, `expected around 5 trips (2 version checks + 3 table reads), got ${stat.trips}`);
});

test('staffManager busts agentIndex synchronously -- the very next read sees the new manager', async () => {
  const d = fakeDb({
    settings: [{ key: 'DATA_VERSION', value: 'v1' }],
    hoop_agents: [
      { name: 'RSM North', phone: '0700000001', branch: 'NORTH', manager: null, role: 'Regional_Manager', active: true },
      { name: 'RSM South', phone: '0700000002', branch: 'SOUTH', manager: null, role: 'Regional_Manager', active: true },
      { name: 'Field One', phone: '0700000003', branch: 'SOUTH', manager: null, role: 'Field_Officer', active: true },
    ],
  });
  const before = await agentIndex(d, NOW);
  assert.equal(before.tree.parentOf(nameKey('Field One')), nameKey('RSM South'),
    'the branch fallback finds the south RSM with no manager column set');
  await _FNS.staffManager(d, ADMIN, { phone: '0700000003', manager: 'RSM North' });
  const after = await agentIndex(d, NOW);   // SAME nowMs -- a TTL-only cache would still be warm
  assert.equal(after.tree.parentOf(nameKey('Field One')), nameKey('RSM North'),
    'staffManager\'s write is visible on this instance\'s very next agentIndex-backed read');
});

/* =========================================================================================
   5. device-core.js's beat() -- one shared settings read for its four helpers.
   ========================================================================================= */

test('beat(): a sold, non-retiring, settled device costs exactly 2 reads + 1 write', async () => {
  const c = counting({
    devices: [{ imei: 'D1', state: 'locked', enrol_token: 'tok1', reported: 'locked', customer: 'Asha', sold_ref: 'S1' }],
    device_events: [],
    settings: [
      { key: 'DEVICE_HELP_PHONE', value: '0700000000' },
      { key: 'DEVICE_OFFLINE_GRACE_HOURS', value: '48' },
      { key: 'DEVICE_BOOT_GRACE_MINUTES', value: '5' },
      { key: 'DEVICE_FRP_ACCOUNT_IDS', value: '123456789012' },
    ],
  });
  const r = await deviceApi(c.db, 'dev_beat', [{ token: 'tok1', locked: true }], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.command, 'lock', 'still locked, matches the register -- settled');
  const stat = c.stat();
  assert.equal(stat.trips, 3,
    'byToken (1 read) + the ONE shared settings read for lockWords/graceFor/bootGraceFor/frpFor (1 read) '
    + '+ the devices update (1 write) = 3 -- no transition, so no device_events insert either');
});

test('beat(): retire, stock and FRP branches still produce the right commands off the shared settings read', async () => {
  const retiring = await deviceApi(fakeDb({
    devices: [{ imei: 'D2', state: 'released', enrol_token: 'tok2' }], device_events: [],
    settings: [{ key: 'DEVICE_FRP_ACCOUNT_IDS', value: '123456789' }],
  }), 'dev_beat', [{ token: 'tok2', locked: false }], NOW);
  assert.equal(retiring.command, 'unlock');
  assert.equal(retiring.retire, true);
  assert.deepEqual(retiring.frpAccounts, [], 'a paid-off phone is nobody\'s to fence');
  assert.equal(retiring.message, null, 'a retiring phone gets no lock words at all');

  const stock = await deviceApi(fakeDb({
    devices: [{ imei: 'D3', state: 'enrolled', enrol_token: 'tok3' }], device_events: [], settings: [],
  }), 'dev_beat', [{ token: 'tok3', locked: false }], NOW);
  assert.equal(stock.command, 'unlock');
  assert.equal(stock.graceHours, -1, 'still stock (no customer/sold_ref) -- never self-locks');

  const frp = await deviceApi(fakeDb({
    devices: [{ imei: 'D4', state: 'locked', enrol_token: 'tok4' }], device_events: [],
    settings: [{ key: 'DEVICE_FRP_ACCOUNT_IDS', value: '999999999, 888888888' }],
  }), 'dev_beat', [{ token: 'tok4', locked: true }], NOW);
  assert.deepEqual(frp.frpAccounts, ['999999999', '888888888']);
});

/* =========================================================================================
   5b. THE NEXT STEP: the one shared settings read itself is memoised across handsets on the
   same warm process (postgres war, 2026-09-22) -- see readBeatSettings in device-core.js.
   Measured empirically before this fix: three successive beats from three different handsets
   on the same warm `db` cost 3, 6, 9 CUMULATIVE trips -- perfectly linear, no warm discount,
   because the settings read above was shared across the four helpers WITHIN one beat but
   never remembered from one beat to the next. ========================================== */

test('beat(): a second handset on the same warm db pays nothing at all for settings', async () => {
  const c = counting({
    devices: [
      { imei: 'W1', state: 'locked', enrol_token: 'wtok1', reported: 'locked', customer: 'Asha', sold_ref: 'S1' },
      { imei: 'W2', state: 'locked', enrol_token: 'wtok2', reported: 'locked', customer: 'Baraka', sold_ref: 'S2' },
    ],
    device_events: [],
    settings: [
      { key: 'DEVICE_LOCK_BRAND', value: 'HOOP LIMITED' },
      { key: 'DEVICE_HELP_PHONE', value: '0700000000' },
      { key: 'DEVICE_OFFLINE_GRACE_HOURS', value: '48' },
    ],
  });

  const r1 = await deviceApi(c.db, 'dev_beat', [{ token: 'wtok1', locked: true }], NOW);
  const first = c.stat().trips;
  const r2 = await deviceApi(c.db, 'dev_beat', [{ token: 'wtok2', locked: true }], NOW);
  const second = c.stat().trips - first;

  // Correctness first: the memo must not have changed a single answer on the wire.
  assert.equal(r1.brand, 'HOOP LIMITED');
  assert.equal(r2.brand, 'HOOP LIMITED');
  assert.equal(r1.helpPhone, r2.helpPhone);
  assert.equal(r1.graceHours, r2.graceHours);

  assert.equal(first, 3, 'the FIRST beat still costs byToken (1) + the settings read (1) + the write (1)');
  assert.ok(second < first,
    `the SECOND handset's incremental cost (${second} trips) must be lower than the first's (${first}) -- the settings table is being re-read`);
  assert.equal(second, 2,
    'byToken (1) + the write (1); settings served from the warm memo -- no settings trip at all');
});

test('beat(): two beats landing at once on a cold cache share ONE settings read, not two', async () => {
  const c = counting({
    devices: [
      { imei: 'C1', state: 'enrolled', enrol_token: 'ctok1', reported: 'unlocked' },
      { imei: 'C2', state: 'enrolled', enrol_token: 'ctok2', reported: 'unlocked' },
    ],
    device_events: [],
    settings: [{ key: 'DEVICE_LOCK_BRAND', value: 'HOOP LIMITED' }],
  });
  const [r1, r2] = await Promise.all([
    deviceApi(c.db, 'dev_beat', [{ token: 'ctok1', locked: false }], NOW),
    deviceApi(c.db, 'dev_beat', [{ token: 'ctok2', locked: false }], NOW),
  ]);
  assert.equal(r1.brand, 'HOOP LIMITED');
  assert.equal(r2.brand, 'HOOP LIMITED');
  const { trips } = c.stat();
  // byToken x2 (2) + ONE shared settings read, the build in flight rather than started twice
  // (1) + the write x2 (2) = 5, not 6.
  assert.equal(trips, 5,
    `${trips} trips for two concurrent cold beats -- the settings read is being started twice instead of shared`);
});

test('settingSet(DEVICE_LOCK_BRAND) is visible on the very next beat, not after the stale TTL', async () => {
  const d = fakeDb({
    devices: [{ imei: 'E1', state: 'enrolled', enrol_token: 'etok1', reported: 'unlocked' }],
    device_events: [],
    settings: [{ key: 'DEVICE_LOCK_BRAND', value: 'HOOP LIMITED' }],
  });
  const before = await deviceApi(d, 'dev_beat', [{ token: 'etok1', locked: false }], NOW);
  assert.equal(before.brand, 'HOOP LIMITED');

  await _FNS.settingSet(d, ADMIN, { key: 'DEVICE_LOCK_BRAND', value: 'HOOP FINANCE' });

  const after = await deviceApi(d, 'dev_beat', [{ token: 'etok1', locked: false }], NOW);   // SAME nowMs
  assert.equal(after.brand, 'HOOP FINANCE',
    'the beat-settings memo must be dropped on write, not merely wait out its 15s TTL');
});

/* =========================================================================================
   5c. shifted() wrote the devices row TWICE -- state fields, then a separate write to clear
   shift_server/shift_batch. One combined UPDATE, falling back to two only on a genuine
   pre-migration column-not-found error, mirrors beat()'s own fallback-retry shape. */

test('shifted(): the shift order is cleared in the same write, not a second one', async () => {
  const c = counting({
    devices: [{ imei: 'F1', state: 'enrolled', enrol_token: 'ftok1',
      shift_server: 'https://other.example', shift_batch: 'e'.repeat(32) }],
    device_events: [],
    settings: [],
  });
  const out = await deviceApi(c.db, 'dev_shifted', [{ token: 'ftok1' }], NOW);
  assert.equal(out.ok, true);
  const row = c.db._dump('devices').find(x => x.imei === 'F1');
  assert.equal(row.state, 'released');
  assert.equal(row.shift_server, null, 'the order is still cleared');
  assert.equal(row.shift_batch, null, 'the order is still cleared');
  const ev = c.db._dump('device_events').find(x => x.event === 'shifted');
  assert.ok(ev, 'the transition is still filed');

  const { trips } = c.stat();
  // byToken (1) + ONE combined update (1) + the device_events insert (1) = 3, not 4.
  assert.equal(trips, 3, `${trips} trips for shifted() -- the shift order is being cleared in a second write`);
});

test('shifted(): still works pre-migration, when shift_server/shift_batch do not exist yet', async () => {
  const db = fakeDb({
    devices: [{ imei: 'F2', state: 'enrolled', enrol_token: 'ftok2' }],
    device_events: [],
    settings: [],
  }, { missingColumns: { devices: ['shift_server', 'shift_batch'] } });

  const out = await deviceApi(db, 'dev_shifted', [{ token: 'ftok2' }], NOW);
  assert.equal(out.ok, true, 'the state transition must not fail just because the migration has not run');
  const row = db._dump('devices').find(x => x.imei === 'F2');
  assert.equal(row.state, 'released');
  const ev = db._dump('device_events').find(x => x.event === 'shifted');
  assert.ok(ev, 'the transition is filed even without the shift columns');
});

/* =========================================================================================
   6. public/call.html -- the sync timer must not force a recompute every tick.
   =========================================================================================
   No DOM harness exists for this page (see test/portal-html.test.mjs's own note on why that
   check stays narrow), so this reads the source and asks the same kind of small, exact
   question: within the sync timer's own body, is the call to loadDaySummary passed false? */
test('call.html: the sync timer calls loadDaySummary(false), not (true)', () => {
  const src = fs.readFileSync(new URL('../public/call.html', import.meta.url), 'utf8');
  const start = src.indexOf('S.syncTimer = setInterval(function(){');
  assert.ok(start >= 0, 'the sync timer\'s setInterval must still be named S.syncTimer');
  // Bounded to the timer's own callback -- up to the interval's closing `}, Math.max(60,`,
  // which is this specific setInterval's own signature, not just any `}`.
  const end = src.indexOf('}, Math.max(60, S.syncEverySec', start);
  assert.ok(end > start, 'could not find the end of the sync timer\'s callback');
  const body = src.slice(start, end);
  assert.match(body, /doSync\(\)/, 'the timer must still call doSync() -- that is what forces a reload on a real version move');
  assert.match(body, /loadDaySummary\(false\)/,
    'the timer must call loadDaySummary(false): summaryVersionCheck_ (inside doSync) already '
    + 'forces a reload when DATA_VERSION actually moves, and (true) here defeats both the '
    + '2-minute server cache and the 15-minute client cooldown on every single tick');
  assert.doesNotMatch(body, /loadDaySummary\(true\)/,
    'the timer must not force a recompute on every tick regardless of whether anything changed');
});
