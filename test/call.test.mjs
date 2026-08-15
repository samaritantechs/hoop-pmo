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

test('the list is the NEWEST deck, scoped to the officer team, most-offline first', async () => {
  const d = db();
  await registerOfficer(d);
  const r = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.asOf, '2026-08-14');
  assert.equal(r.stale, false);
  // Two Kinondoni rows on today's deck: Temeke's customer and yesterday's row are absent.
  assert.equal(r.rows.length, 2);
  assert.ok(!r.rows.some(x => x.team === 'TEMEKE'), 'another team leaked onto the handset');
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

test('the daily summary counts the deck, the window, and who was reached', async () => {
  _clearSummaryCache();
  const d = db();
  await registerOfficer(d);
  await callApi(d, 'api_callSync', ['dev-1', [
    { ts: NOW - 3600000, dur: 95, dir: 'out', num: '0716548153', outcome: 'CONNECTED' },
  ]], NOW);
  _clearSummaryCache();          // the sync moved the book; the strip must not serve the pre-sync copy
  const s = await callApi(d, 'api_callDailySummary', ['dev-1'], NOW);
  assert.equal(s.ok, true);
  assert.equal(s.list.num, 2);
  assert.equal(s.locked7.num, 1);
  assert.equal(s.inWindow.num, 1);
  assert.equal(s.calls.num, 1);
  assert.equal(s.reached.num, 1);
  assert.equal(s.reached.den, 2);
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
  assert.equal(s.list.num, 3, 'they stay ON the deck (visible in the 45+ tab)');
  assert.equal(s.locked7.num, 1, 'but the Locked 7+ burden counts only the in-window one');
  assert.equal(s.inWindow.num, 1);
  _clearSummaryCache();
});
