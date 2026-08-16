import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { callApi, pnorm, lifeDayOf, _clearSummaryCache } from '../api/_lib/call-core.js';

/* The whole officer day, end to end, against the fake PostgREST client: sign in with the
   team code, see the deck, sync calls, log a follow-up. Pinned clock: 2026-08-14 EAT. */
const NOW = Date.parse('2026-08-14T09:00:00+03:00');

function db() {
  return fakeDb({
    settings: [
      { key: 'SYSTEM_OPEN', value: 'YES' },
      { key: 'DATA_VERSION', value: 'v1' },
    ],
    teams: [
      { team: 'KINONDONI', team_code: 'AB2C3D', rsm: 'Anold Sawe' },
      { team: 'TEMEKE', team_code: 'XY7Z8W', rsm: 'Other Rsm' },
    ],
    access_codes: [
      { code: 'BOSS-1', name: 'Peter Kisoli', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'] },
    ],
    followup_status: [
      { imei: '351929937378664', client_name: 'Alafati Kalikawe Selemani', contact: '255716548153',
        team: 'KINONDONI', model: 'A07', price: 450000, disbursed_date: '2026-07-13',
        days_offline: 21, locked4: true, locked7: true, has_ever_paid: false, deck_date: '2026-08-14' },
      { imei: '351738748292885', client_name: 'Yuda M Japhet', contact: '255773460588',
        team: 'KINONDONI', model: 'A07', price: 450000, disbursed_date: '2026-06-30',
        days_offline: 12, locked4: true, locked7: false, has_ever_paid: true, deck_date: '2026-08-14' },
      // Another team's customer -- must never reach this officer's handset.
      { imei: '351929937369465', client_name: 'Rinus Njunwa Paschar', contact: '255650793471',
        team: 'TEMEKE', model: 'A07', price: 450000, disbursed_date: '2026-06-29',
        days_offline: 10, locked4: true, locked7: true, has_ever_paid: true, deck_date: '2026-08-14' },
      // Yesterday's deck row -- today's upload IS today's list, so this one stays off it.
      { imei: '351000000000001', client_name: 'Old Deck Row', contact: '255700000001',
        team: 'KINONDONI', model: 'A06', price: 400000, disbursed_date: '2026-07-01',
        days_offline: 5, locked4: true, locked7: false, has_ever_paid: true, deck_date: '2026-08-13' },
    ],
    followup_comments: [],
    call_users: [],
    call_logs: [],
  });
}

async function registerOfficer(d) {
  return callApi(d, 'api_callRegister', ['dev-1', 'Ainea', '', '', '0712345678', 'AB2C3D'], NOW);
}

test('an officer registers with the TEAM CODE and lands on their team', async () => {
  const d = db();
  const r = await registerOfficer(d);
  assert.equal(r.ok, true);
  assert.equal(r.team, 'KINONDONI');
  assert.equal(r.leader, false);
  const boot = await callApi(d, 'api_callBoot', ['dev-1'], NOW);
  assert.equal(boot.ok, true);
  assert.equal(boot.name, 'Ainea');
  assert.equal(boot.team, 'KINONDONI');
});

test('a wrong team code is refused; a view-only code cannot register a handset', async () => {
  const d = db();
  await assert.rejects(() => callApi(d, 'api_callRegister', ['dev-1', 'X', '', '', '0712000000', 'WRONG1'], NOW), /si sahihi/);
  const d2 = fakeDb({ access_codes: [{ code: 'LOOK', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: [] }], teams: [], call_users: [], settings: [] });
  await assert.rejects(() => callApi(d2, 'api_callRegister', ['dev-1', '', '', 'LOOK', '0712000000', ''], NOW), /view-only/);
});

test('the list is the NEWEST deck, dealt company-wide -- teams are locations, not fences', async () => {
  const d = db();
  await registerOfficer(d);
  const r = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.asOf, '2026-08-14');
  assert.equal(r.stale, false);
  // ONE credit user -> the whole company deck, BOTH branches; yesterday's row absent.
  assert.equal(r.rows.length, 3);
  assert.ok(r.rows.some(x => x.team === 'TEMEKE'), 'the deck is one company pool -- Temeke belongs in it');
  assert.ok(!r.rows.some(x => x.ref === '351000000000001'), 'yesterday\'s deck row leaked');
  // Most offline first.
  assert.equal(r.rows[0].ref, '351929937378664');
  assert.equal(r.rows[0].daysOff, 21);
  assert.equal(r.rows[0].locked7, true);
  // The 45-day window: 13-Jul disbursement seen on 14-Aug is day 33, inside the window.
  assert.equal(r.rows[0].lifeDay, 33);
  assert.equal(r.rows[0].inWindow, true);
  assert.equal(r.rows[0].ds, '33/45');
  // 30-Jun customer is day 46 -- aged out, and the row says so.
  assert.equal(r.rows[1].lifeDay, 46);
  assert.equal(r.rows[1].inWindow, false);
});

test('sync writes call logs deduped by construction and matches the deck by phone', async () => {
  const d = db();
  await registerOfficer(d);
  const calls = [
    { ts: NOW - 3600000, dur: 95, dir: 'out', num: '0716548153', outcome: 'CONNECTED' },
    { ts: NOW - 3600000, dur: 95, dir: 'out', num: '0716548153', outcome: 'CONNECTED' },   // same call twice
    { ts: NOW - 1800000, dur: 40, dir: 'out', num: '0650793471', outcome: 'CONNECTED' },   // Temeke's customer
  ];
  const r = await callApi(d, 'api_callSync', ['dev-1', calls], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.added, 2, 'the duplicate must not become a third row');
  assert.equal(r.portfolio, 1, 'own-team match only');
  assert.equal(r.nonPortfolio, 1, 'the other team\'s customer is named but not portfolio');
  const logs = d._dump('call_logs');
  assert.equal(logs.length, 2);
  const mine = logs.find(l => l.portfolio);
  assert.equal(mine.ref, '351929937378664', 'the log points at the IMEI');
  assert.equal(mine.category, null, 'hoop has one book -- no category, no CHECK violation');
});

test('a follow-up saves the comment, the promise, and the register in step', async () => {
  const d = db();
  await registerOfficer(d);
  const r = await callApi(d, 'api_callAddComment', ['dev-1', {
    ref: '351929937378664', team: 'KINONDONI', name: 'Alafati Kalikawe Selemani',
    fu: 'AMETOA AHADI', comment: 'Atalipa jioni', promiseDate: '2026-08-15',
  }], NOW);
  assert.equal(r.ok, true);
  const fu = d._dump('followup_status').find(x => x.imei === '351929937378664');
  assert.equal(fu.fu_status, 'AMETOA AHADI');
  assert.equal(fu.promise_date, '2026-08-15');
  assert.equal(fu.comment_by, 'Ainea');
  const cm = d._dump('followup_comments');
  assert.equal(cm.length, 1);
  assert.equal(cm[0].imei, '351929937378664');
  // And the promise without a date is refused, same rule as Hope.
  await assert.rejects(() => callApi(d, 'api_callAddComment', ['dev-1', {
    ref: '351738748292885', fu: 'AMETOA AHADI', comment: 'x',
  }], NOW), /promise date/);
});

test('the daily summary counts the officer\'s dealt share; the bar is yesterday, not today', async () => {
  _clearSummaryCache();
  const d = db();
  await registerOfficer(d);
  await callApi(d, 'api_callSync', ['dev-1', [
    { ts: NOW - 3600000, dur: 95, dir: 'out', num: '0716548153', outcome: 'CONNECTED' },
  ]], NOW);
  _clearSummaryCache();          // the sync moved the book; the strip must not serve the pre-sync copy
  const s = await callApi(d, 'api_callDailySummary', ['dev-1'], NOW);
  assert.equal(s.ok, true);
  assert.equal(s.list.num, 3, 'ONE credit user is dealt the WHOLE company deck -- both teams');
  assert.equal(s.locked7.num, 1, 'Alafati only: Rinus is locked 7+ but past day 45 -- not our burden');
  assert.equal(s.inWindow.num, 1);
  assert.equal(s.calls.num, 1, 'their OWN calls today');
  assert.equal(s.reached.pct, null, 'no yesterday upload in this fixture -- the bar says so, never today');
  assert.equal(s.weekAvg.pct, null);
});

test('pnorm and lifeDayOf ports behave', () => {
  assert.equal(pnorm('255716548153'), '716548153');
  assert.equal(pnorm('0716548153'), '716548153');
  assert.equal(lifeDayOf('2026-07-13', '2026-08-14'), 33);
});

test('locked 7+ beyond day 45 leaves the count -- not Hoop\'s responsibility', async () => {
  _clearSummaryCache();
  const d = db();
  // Locked a week AND past the 45-day window: disbursed 100 days before the pinned clock.
  d._dump('followup_status').push({
    imei: '351999999999999', client_name: 'Nje Ya Dirisha', contact: '255788000111',
    team: 'KINONDONI', model: 'A07', price: 450000, disbursed_date: '2026-05-06',
    days_offline: 40, locked4: true, locked7: true, has_ever_paid: false, deck_date: '2026-08-14' });
  await registerOfficer(d);
  const s = await callApi(d, 'api_callDailySummary', ['dev-1'], NOW);
  assert.equal(s.list.num, 4, 'company pool: both branches AND the beyond-45 row stay on the deck');
  assert.equal(s.locked7.num, 1, 'but the Locked 7+ burden counts only the in-window one');
  assert.equal(s.inWindow.num, 1);
  _clearSummaryCache();
});

/* ---------- the workload deal + the performance bar ---------- */

test('registering another credit user re-deals the pool automatically', async () => {
  const d = db();
  await registerOfficer(d);                                     // Ainea, dev-1
  const before = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(before.rows.length, 3, 'alone, Ainea holds the whole book');
  // A second credit user registers with the OTHER branch's code -- branch is irrelevant
  // to the deal, the roster length is everything.
  await callApi(d, 'api_callRegister', ['dev-2', 'Baraka', '', '', '0755000111', 'XY7Z8W'], NOW);
  const a = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const b = await callApi(d, 'api_callList', ['dev-2', 'today'], NOW);
  assert.equal(a.rows.length + b.rows.length, 3, 'the pool is split, nothing lost');
  assert.ok(a.rows.length >= 1 && b.rows.length >= 1, 'both hold work');
  const refsA = new Set(a.rows.map(r => r.ref));
  assert.ok(!b.rows.some(r => refsA.has(r.ref)), 'no customer is dealt twice');
});

test('the bar: own yesterday % and last-week average for a credit user; company for a leader', async () => {
  _clearSummaryCache();
  const NOWF = Date.parse('2026-08-14T09:00:00+03:00');          // Friday; last week = Mon 03 .. Sun 09
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D' }],
    followup_status: [
      { imei: 'A', client_name: 'Leo Mmoja', contact: '255716000001', team: 'KINONDONI',
        disbursed_date: '2026-08-01', days_offline: 9, locked4: true, locked7: false, deck_date: '2026-08-14' },
    ],
    call_users: [
      { user_id: 'U1', device_id: 'dev-1', name: 'Ainea', team: 'KINONDONI', is_leader: false, active: true },
      { user_id: 'U2', device_id: 'dev-2', name: 'Baraka', team: 'KINONDONI', is_leader: false, active: true },
      { user_id: 'U9', device_id: 'dev-9', name: 'Bosi', team: 'KINONDONI', is_leader: true, active: true },
    ],
    // Yesterday's book: two customers. Sorted by IMEI, X1 deals to U1, X2 to U2.
    watu_snapshots: [
      { imei: 'X1', contact: '255716111111', snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      { imei: 'X2', contact: '255716222222', snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      // One day of last week, one customer -- dealt to U1 (index 0).
      { imei: 'W1', contact: '255716333333', snapshot_date: '2026-08-05', created_at: '2026-08-05T08:00:00Z' },
    ],
    call_logs: [
      // U1 reached their yesterday customer; U2 called NOBODY.
      { id: 'L1', user_id: 'U1', phone: '255716111111', duration: 95, call_date: '2026-08-13' },
      // U1 also reached their last-week customer.
      { id: 'L2', user_id: 'U1', phone: '255716333333', duration: 60, call_date: '2026-08-05' },
    ],
  });
  const s1 = await callApi(d, 'api_callDailySummary', ['dev-1'], NOWF);
  assert.equal(s1.reached.pct, 1, 'U1 reached 1 of their 1 dealt yesterday customer');
  assert.equal(s1.asOfReached, '2026-08-13');
  assert.equal(s1.weekAvg.pct, 1, 'their one worked last-week day averaged 100%');
  const s2 = await callApi(d, 'api_callDailySummary', ['dev-2'], NOWF);
  assert.equal(s2.reached.pct, 0, 'U2 reached 0 of their 1 -- the bar does not hide it');
  assert.equal(s2.weekAvg.pct, null, 'no last-week customer was dealt to U2');
  _clearSummaryCache();
  const s9 = await callApi(d, 'api_callDailySummary', ['dev-9'], NOWF);
  assert.equal(s9.reached.den, 2, 'the leader sees the COMPANY: everyone\'s yesterday book');
  assert.equal(s9.reached.num, 1);
  assert.equal(s9.reached.pct, 0.5);
  _clearSummaryCache();
});
