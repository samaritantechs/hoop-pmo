import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';

/* =========================================================================================
   AGING BY SYNCHRONISATION -- the locked phones our server is not pinging.

     "Issuing of stock at stock request, by using the devices synchronization we should get a
      report of never synced by days, so sortable columns of aging stock by synchronisation for
      locked phones -- here we easily trace the phones that our system is not pinging (could
      have been frauded / software booted to remove lock), so now way forward stock
      verification will require stock holders to always connect to the internet the stock they
      hold so that we analyze which phones are not syncing"

   The aging tracker asks how long a phone has sat on a shelf. This asks how long since it
   SPOKE TO US -- and a locked handset that has stopped speaking is either off, or out of
   coverage, or no longer locked at all.

   THE TWO CLOCKS ARE THE POINT. A phone locked five minutes ago has not had time to confirm
   anything; counting it as silent would bury the real cases under every lock ordered today.
   So silence is only SUSPECT once it has outlasted the order that caused it.
   ========================================================================================= */
const STORE = { code: 'ST', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['stockrep'], readOnly: false };
const ISSUER = { code: 'IS', name: 'Desk', role: 'STORE', teams: null, tabs: ['stockappr'], readOnly: false };
const BENCH = { code: 'BN', name: 'Bench', role: 'STORE', teams: null, tabs: ['devlock'], readOnly: false };
const OTHER = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['customers'], readOnly: false };
const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };

const DAY = 86400000;
const ago = d => new Date(Date.now() - d * DAY).toISOString();
const dev = o => ({
  imei: o.imei, item: o.item || 'A07', holder: o.holder || 'SIPHO STORE',
  state: o.state || 'locked', reported: o.reported || 'locked',
  last_seen: o.seenDaysAgo == null ? null : ago(o.seenDaysAgo),
  state_at: o.orderedDaysAgo == null ? null : ago(o.orderedDaysAgo),
  released_at: null,
});
const syncDb = (o = {}) => fakeDb({
  devices: o.devices || [], hoop_aged_stock: o.aged || [], settings: o.settings || [],
});

/* ---------------------------------------------------------------------------------------- */
test('silence is counted in days, and a phone that never spoke is the worst row there is', async () => {
  const db = syncDb({ devices: [
    dev({ imei: 'D1', seenDaysAgo: 0, orderedDaysAgo: 40 }),        // beating
    dev({ imei: 'D2', seenDaysAgo: 9, orderedDaysAgo: 40 }),        // quiet nine days
    dev({ imei: 'D3', seenDaysAgo: 45, orderedDaysAgo: 60 }),       // quiet six weeks
    dev({ imei: 'D4', seenDaysAgo: null, orderedDaysAgo: 30 }),     // never once spoke
  ] });
  const d = await _FNS.syncAging(db, STORE, {});
  assert.equal(d.alertDays, 7, 'seven days is the standing judgement when nobody has set one');
  assert.equal(d.counts.total, 4);
  assert.equal(d.counts.never, 1);
  assert.equal(d.counts.suspect, 3, 'D2, D3 and D4 -- D1 spoke today');
  assert.equal(d.counts.over30, 1);
  assert.equal(d.counts.fresh, 1);

  /* WORST FIRST, and never-spoken beats every silence that has an end: it is the one whose
     lock may never have been applied at all. */
  assert.equal(d.rows[0].imei, 'D4');
  assert.equal(d.rows[0].neverSeen, true);
  assert.equal(d.rows[0].days, null);
  assert.equal(d.rows[1].imei, 'D3', 'then the longest silence');
  assert.equal(d.rows[1].days, 45);
  assert.equal(d.rows[3].imei, 'D1');
  assert.equal(d.rows[3].suspect, false);

  // The sharpest line: ordered locked, never spoke, and long enough ago to matter.
  assert.equal(d.counts.neverAndRipe, 1);
});

test('a phone locked this morning is not evidence of anything', async () => {
  const db = syncDb({ devices: [
    dev({ imei: 'FRESH', seenDaysAgo: null, orderedDaysAgo: 0 }),   // ordered today, silent
    dev({ imei: 'OLD', seenDaysAgo: null, orderedDaysAgo: 30 }),    // ordered a month ago, silent
  ] });
  const d = await _FNS.syncAging(db, STORE, {});
  const by = Object.fromEntries(d.rows.map(r => [r.imei, r]));
  /* BOTH have never spoken. Only one of them has had time to. Counting the other would bury
     every real case under the phones somebody locked this morning. */
  assert.equal(by.FRESH.neverSeen, true);
  assert.equal(by.FRESH.suspect, false, 'not yet -- the order is younger than the silence we look for');
  assert.equal(by.OLD.suspect, true);
  assert.equal(d.counts.never, 2, 'both are still counted as never having spoken');
  assert.equal(d.counts.suspect, 1, 'but only one is a case to chase');
  assert.equal(d.counts.neverAndRipe, 1);
});

test('the holder comes from the newest stock file, and the enrolment stamp is the fallback', async () => {
  const db = syncDb({
    devices: [dev({ imei: 'D1', holder: 'SIPHO STORE', seenDaysAgo: 20, orderedDaysAgo: 30 }),
      dev({ imei: 'D2', holder: 'SIPHO STORE', seenDaysAgo: 20, orderedDaysAgo: 30 })],
    aged: [
      // Yesterday's file said RSM ONE; today's says AGENT X. Today's wins.
      { serial: 'D1', agent: 'RSM ONE', item: 'A07', age_days: 12, as_of: '2026-09-08' },
      { serial: 'D1', agent: 'AGENT X', item: 'A07', age_days: 13, as_of: '2026-09-09' },
    ],
  });
  const d = await _FNS.syncAging(db, STORE, {});
  const by = Object.fromEntries(d.rows.map(r => [r.imei, r]));
  assert.equal(by.D1.holder, 'AGENT X', 'the register is re-uploaded daily; the newest as_of is the answer');
  assert.equal(by.D1.agedDays, 13, 'and one row answers both questions -- shelf age and silence');
  assert.equal(by.D2.holder, 'SIPHO STORE', 'a phone not in the stock file keeps its enrolment stamp');
  assert.equal(by.D2.agedDays, null);

  /* PER HOLDER, because that is who stock verification actually sits down with. */
  const x = d.byHolder.find(h => h.holder === 'AGENT X');
  assert.equal(x.held, 1);
  assert.equal(x.quiet, 1);
  assert.equal(x.worstDays, 20);
  assert.deepEqual(d.holders.sort(), ['AGENT X', 'SIPHO STORE']);
});

test('the report is about LOCKED phones, and the filters are the questions a desk asks', async () => {
  const db = syncDb({ devices: [
    dev({ imei: 'L1', state: 'locked', holder: 'AGENT X', seenDaysAgo: 20, orderedDaysAgo: 30 }),
    dev({ imei: 'E1', state: 'enrolled', holder: 'AGENT X', seenDaysAgo: 20, orderedDaysAgo: 30 }),
    dev({ imei: 'L2', state: 'locked', holder: 'SIPHO STORE', seenDaysAgo: 20, orderedDaysAgo: 30 }),
  ] });
  assert.deepEqual((await _FNS.syncAging(db, STORE, {})).rows.map(r => r.imei).sort(), ['L1', 'L2'],
    'locked by default -- that is the population the amendment is about');
  assert.deepEqual((await _FNS.syncAging(db, STORE, { state: 'enrolled' })).rows.map(r => r.imei), ['E1']);
  assert.equal((await _FNS.syncAging(db, STORE, { state: 'all' })).rows.length, 3);
  const one = await _FNS.syncAging(db, STORE, { holder: 'AGENT X' });
  assert.deepEqual(one.rows.map(r => r.imei), ['L1'], 'narrowed to one holder');
  assert.equal(one.counts.total, 2, 'the counts still describe the whole population, not the slice');
});

test('the line between patience and a case is a setting, not a constant', async () => {
  const devices = [dev({ imei: 'D1', seenDaysAgo: 5, orderedDaysAgo: 30 })];
  assert.equal((await _FNS.syncAging(syncDb({ devices }), STORE, {})).counts.suspect, 0,
    'five days is under the standing seven');
  const strict = syncDb({ devices, settings: [{ key: 'SYNC_ALERT_DAYS', value: '3' }] });
  const d = await _FNS.syncAging(strict, STORE, {});
  assert.equal(d.alertDays, 3);
  assert.equal(d.counts.suspect, 1, 'an office that wants a shorter leash sets one');
  const junk = syncDb({ devices, settings: [{ key: 'SYNC_ALERT_DAYS', value: 'ndiyo' }] });
  assert.equal((await _FNS.syncAging(junk, STORE, {})).alertDays, 7, 'nonsense falls back to the judgement');
});

test('three desks read it, everybody else does not, and an un-migrated register says so', async () => {
  const db = syncDb({ devices: [dev({ imei: 'D1', seenDaysAgo: 20, orderedDaysAgo: 30 })] });
  for (const who of [STORE, ISSUER, BENCH, ADMIN]) {
    assert.equal((await _FNS.syncAging(db, who, {})).ok, true,
      (who.tabs[0]) + ' needs this: the chaser, the issuer and the tracker');
  }
  await assert.rejects(() => _FNS.syncAging(db, OTHER, {}), /no access to the stockrep pane/);

  const bare = fakeDb({ devices: [], hoop_aged_stock: [], settings: [] },
    { missingColumns: { devices: ['last_seen'] } });
  const d = await _FNS.syncAging(bare, STORE, {});
  assert.equal(d.notReady, true);
  assert.deepEqual(d.rows, []);
  assert.equal(d.counts.total, 0);
});
