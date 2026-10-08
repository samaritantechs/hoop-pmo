import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { callApi, pnorm, lifeDayOf, dealMap, _clearSummaryCache } from '../api/_lib/call-core.js';

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

test('the customer row carries the actual disbursed date, not just the day-of-45 count', async () => {
  const d = db();
  await registerOfficer(d);
  const r = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const alafati = r.rows.find(x => x.ref === '351929937378664');
  assert.equal(alafati.disbursedDate, '2026-07-13', 'the raw date, so the credit team can read it, not just count it');
  assert.ok(alafati.ds && alafati.ds.indexOf('/45') > 0, 'the day-of-45 count still rides alongside it');
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
  // 30-Jun customer is day 46 -- INSIDE the window now: the owner's 2-day calendar
  // grace (months vary; Watu keeps a customer ~2 days longer than plain arithmetic).
  assert.equal(r.rows[1].lifeDay, 46);
  assert.equal(r.rows[1].inWindow, true, 'day 46 rides the 2-day grace -- Watu still counts them');
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
  assert.equal(s.locked7.num, 2, 'Alafati AND Rinus: day 47 rides the 2-day grace, so Rinus is our burden again');
  assert.equal(s.inWindow.num, 3, 'days 33, 46 and 47 are all inside 45+2');
  assert.equal(s.calls.num, 1, 'their OWN calls today');
  assert.equal(s.reached.pct, null, 'no yesterday upload in this fixture -- the bar says so, never today');
  assert.equal(s.weekAvg.pct, null);
});

test('pnorm and lifeDayOf ports behave', () => {
  assert.equal(pnorm('255716548153'), '716548153');
  assert.equal(pnorm('0716548153'), '716548153');
  assert.equal(lifeDayOf('2026-07-13', '2026-08-14'), 33);
});

test('locked 7+ is the COLUMN and the window, never one without the other', async () => {
  /* BOTH HALVES -- and this test has now been wrong in both directions, which is why the
     numbers are written into it.

     It first asserted `days_offline >= 7 && inWindow`: our own arithmetic standing in for a
     figure Watu already publishes. The owner overturned that half --

       "The locked 7+ days list of credits is always a few number away from the actual one so
        please dont use dates to give the customer list but the count and acture true/false
        values in the columns -- this is the VERY CORRECT METHOD"

     -- and it was rewritten to the column ALONE, dropping the window along with the
     arithmetic. That shipped, and the owner caught it the same day:

       "Locked 7+ should be in a window of 45 days, it has lost that and credits are now
        having 283 for today yet they told me it was 41"

     Both readings, measured against his own 2,650-row deck on 27 Aug 2026, beside the figure
     Watu quoted that same morning:

       column alone, no window ......... 283
       column AND the window ........... 41    <-- what Watu says
       days_offline >= 7 AND window .... 44-46

     So Watu decides WHO IS LOCKED, we decide WHO IS STILL ON THE BOOK, and a customer has to
     pass both to reach an officer's list. */
  _clearSummaryCache();
  const d = db();
  // Locked a week, but disbursed 100 days before the pinned clock -- long off the book.
  d._dump('followup_status').push({
    imei: '351999999999999', client_name: 'Nje Ya Dirisha', contact: '255788000111',
    team: 'KINONDONI', model: 'A07', price: 450000, disbursed_date: '2026-05-06',
    days_offline: 40, locked4: true, locked7: true, has_ever_paid: false, deck_date: '2026-08-14' });
  await registerOfficer(d);
  const s = await callApi(d, 'api_callDailySummary', ['dev-1'], NOW);
  assert.equal(s.list.num, 4, 'company pool: every row stays on the deck');
  assert.equal(s.locked7.num, 2,
    'the day-100 customer is locked AND gone; being locked does not put them back on the book');
  assert.equal(s.inWindow.num, 3, 'and the window tile counts the window, as it always did');
  _clearSummaryCache();
});

test('the deal is equal PER TAB: every officer gets the same cut of every stratum', async () => {
  // Four locked-7 customers and four unlocked in-window ones, two credit users:
  // each must hold exactly 2 + 2 -- never "3 got 12 and one got 9" on a tab again.
  const mk = (imei, l7) => ({ imei, client_name: 'C' + imei, contact: '25571600000' + imei,
    disbursed_date: '2026-08-01', locked4: l7, locked7: l7, deck_date: '2026-08-14' });
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [],
    followup_status: [mk('1', true), mk('2', false), mk('3', true), mk('4', false),
                      mk('5', true), mk('6', false), mk('7', true), mk('8', false)],
    call_users: [
      { user_id: 'U1', device_id: 'dev-1', name: 'Ainea', role: 'CREDIT', active: true },
      { user_id: 'U2', device_id: 'dev-2', name: 'Baraka', role: 'CREDIT', active: true },
    ],
    call_logs: [],
  });
  const a = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const b = await callApi(d, 'api_callList', ['dev-2', 'today'], NOW);
  assert.equal(a.rows.length, 4); assert.equal(b.rows.length, 4);
  assert.equal(a.rows.filter(r => r.locked7).length, 2, 'the Lock 7+ tab is equal too');
  assert.equal(b.rows.filter(r => r.locked7).length, 2);
  const refsA = new Set(a.rows.map(r => r.ref));
  assert.ok(!b.rows.some(r => refsA.has(r.ref)), 'no customer dealt twice');
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

/* ONE PERSON, ONE SEAT -- however many handsets.
     "No matter how many logins a hoop officer attends it shouldn't affect data duplication
      like a Portfolio and compliance officer logged in in two phones and caused two customer
      distributions for both instead of per accesscode since it's the same"
   A call_users row is keyed on the phone number typed at sign-in, so one officer on two
   handsets with two numbers is two rows. The deal used to count rows and dealt that person
   two shares. It now counts people (seatRoster): both handsets see the SAME share, the seat
   is one slot in the round-robin, and the other officer's share is the rest of the book. */
test('one officer on two handsets is dealt ONE share, and both handsets see the same one', async () => {
  const d = db();
  d._dump('access_codes').push({ code: 'PCO-7', name: 'Neema Mushi', role: 'PCO', teams: null, tabs: [] });
  await registerOfficer(d);                                                       // Ainea, dev-1, team code
  // Neema signs in with her ACCESS CODE on two phones, two different numbers.
  const p1 = await callApi(d, 'api_callRegister', ['dev-n1', '', '', 'PCO-7', '0711000001', ''], NOW);
  const p2 = await callApi(d, 'api_callRegister', ['dev-n2', '', '', 'PCO-7', '0711000002', ''], NOW);
  assert.equal(p1.ok, true); assert.equal(p2.ok, true);
  assert.notEqual(p1.userId, p2.userId, 'two numbers, two rows -- the identity the app keys on');
  assert.equal(d._dump('call_users').filter(u => u.name === 'Neema Mushi').length, 2);

  const a = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const n1 = await callApi(d, 'api_callList', ['dev-n1', 'today'], NOW);
  const n2 = await callApi(d, 'api_callList', ['dev-n2', 'today'], NOW);
  const refs = r => r.rows.map(x => x.ref).sort();
  assert.deepEqual(refs(n1), refs(n2), 'both of Neema\'s phones hold the SAME cards');
  assert.equal(a.rows.length + n1.rows.length, 3, 'two PEOPLE split the book: nothing lost, nothing dealt twice');
  assert.ok(a.rows.length >= 1 && n1.rows.length >= 1, 'both people hold work -- a 2-seat deal of 3 cards is 2+1');
  assert.ok(!n1.rows.some(r => new Set(refs(a)).has(r.ref)), 'no customer is on two people\'s lists');
  // Every card names its holder by the seat, whichever phone asks.
  for (const r of n1.rows) assert.equal(r.heldBy, 'Neema Mushi');
  for (const r of a.rows) assert.equal(r.heldBy, 'Ainea');

  // Switching ONE of her phones off keeps her seat (the other phone is still in); switching
  // both off removes it and Ainea holds the whole book again.
  const { _FNS } = await import('../api/portal.js');
  const ADMIN = { code: 'BOSS-1', name: 'Peter Kisoli', role: 'ADMIN', teams: null, tabs: ['codes'], readOnly: false };
  await _FNS.officerActive(d, ADMIN, { userId: p1.userId, active: false });
  const n2b = await callApi(d, 'api_callList', ['dev-n2', 'today'], NOW);
  const ab = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(ab.rows.length + n2b.rows.length, 3, 'still two people');
  assert.ok(n2b.rows.length >= 1, 'her remaining phone still holds her share');
  await _FNS.officerActive(d, ADMIN, { userId: p2.userId, active: false });
  const ac = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(ac.rows.length, 3, 'with both of her phones off, Ainea holds the whole book');

  // The App users pane says so on each of her rows, and not on Ainea's.
  await _FNS.officerActive(d, ADMIN, { userId: p1.userId, active: true });
  await _FNS.officerActive(d, ADMIN, { userId: p2.userId, active: true });
  const off = (await _FNS.officers(d, ADMIN)).officers;
  assert.deepEqual(off.filter(o => o.name === 'Neema Mushi').map(o => o.seatHandsets), [2, 2]);
  assert.equal(off.find(o => o.name === 'Ainea').seatHandsets, 1);
});

test('the officer tile counts the seat: calls from either handset, one share', async () => {
  _clearSummaryCache();
  const { seatRoster, rosterFull } = await import('../api/_lib/call-core.js');
  // Two rows, one name: the seat is the smaller id, and both ids belong to it.
  const seats = seatRoster([
    { user_id: 'U1', name: 'Neema Mushi', role: 'PCO', active: true },
    { user_id: 'U2', name: 'Ainea', role: 'PCO', active: true },
    { user_id: 'U3', name: 'MUSHI NEEMA', role: 'PCO', active: true },   // same person, other spelling order
    { user_id: 'U4', name: '', role: 'PCO', active: true },              // a blank name is never merged
  ]);
  assert.deepEqual(seats.ids, ['U1', 'U2', 'U4'], 'three seats, in the order one-handset rosters always had');
  assert.deepEqual(seats.members.U1, ['U1', 'U3']);
  assert.equal(seats.seatOf.U3, 'U1');
  assert.equal(seats.names.U1, 'Neema Mushi');

  const roster = ['U1', 'U2'];
  const yHolder = dealMap([{ imei: 'X1', snapshot_date: '2026-08-13' }, { imei: 'X2', snapshot_date: '2026-08-13' }], roster, '2026-08-13').X1;
  const neemaHoldsX1 = yHolder === 'U1';
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D' }],
    followup_status: [
      { imei: 'A', client_name: 'Leo Mmoja', contact: '255716000001', team: 'KINONDONI',
        disbursed_date: '2026-08-01', days_offline: 9, locked4: true, locked7: false, deck_date: '2026-08-14' },
      { imei: 'B', client_name: 'Leo Mbili', contact: '255716000002', team: 'KINONDONI',
        disbursed_date: '2026-08-01', days_offline: 9, locked4: true, locked7: false, deck_date: '2026-08-14' },
    ],
    call_users: [
      { user_id: 'U1', device_id: 'dev-1', name: 'Neema Mushi', team: 'KINONDONI', role: 'PCO', is_leader: true, active: true },
      { user_id: 'U2', device_id: 'dev-2', name: 'Ainea', team: 'KINONDONI', role: 'CREDIT', is_leader: false, active: true },
      { user_id: 'U3', device_id: 'dev-3', name: 'Neema Mushi', team: 'KINONDONI', role: 'PCO', is_leader: true, active: true },
    ],
    watu_snapshots: [
      { imei: 'X1', client_mobile: '255716111111', snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      { imei: 'X2', client_mobile: '255716222222', snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
    ],
    call_logs: [
      // Neema reached her yesterday customer from her OTHER phone (U3), and made one call today from each.
      { id: 'L1', user_id: 'U3', phone: neemaHoldsX1 ? '255716111111' : '255716222222', duration: 95, call_date: '2026-08-13' },
      { id: 'L2', user_id: 'U1', phone: '255716000001', duration: 40, call_date: '2026-08-14' },
      { id: 'L3', user_id: 'U3', phone: '255716000002', duration: 40, call_date: '2026-08-14' },
    ],
  });
  assert.deepEqual((await rosterFull(d, '2026-08-14')).ids, ['U1', 'U2'], 'the roster has two seats, not three rows');
  const s1 = await callApi(d, 'api_callDailySummary', ['dev-1'], NOW);
  _clearSummaryCache();
  const s3 = await callApi(d, 'api_callDailySummary', ['dev-3'], NOW);
  assert.equal(s1.list.num, 1, 'a 2-seat deal of 2 cards: one each');
  assert.deepEqual([s3.list.num, s3.locked7.num, s3.inWindow.num], [s1.list.num, s1.locked7.num, s1.inWindow.num],
    'her second phone shows the same share');
  assert.equal(s1.calls.num, 2, 'today\'s calls: one from each phone, both hers');
  assert.equal(s3.calls.num, 2);
  assert.equal(s1.reached.pct, 1, 'reached from the other phone still counts as reached');
  assert.equal(s3.reached.pct, 1);
  _clearSummaryCache();
  const s2 = await callApi(d, 'api_callDailySummary', ['dev-2'], NOW);
  assert.equal(s2.reached.pct, 0, 'Ainea called nobody -- Neema\'s calls are not hers');
  _clearSummaryCache();
});

/* FUTA, BESIDE ZIMA -- as HOPE has it. "just not Zima but can also delete login device
   history to reduce unwanted list histories". Deleting a login row takes its call logs
   with it (call_logs.user_id references call_users, so they must go first), drops the
   handset out of its seat, and the next list() on that handset is "not registered". */
test('a login row can be deleted outright: its calls go with it, its seat shrinks, its handset is out', async () => {
  const d = db();
  d._dump('access_codes').push({ code: 'PCO-7', name: 'Neema Mushi', role: 'PCO', teams: null, tabs: [] });
  await registerOfficer(d);
  const p1 = await callApi(d, 'api_callRegister', ['dev-n1', '', '', 'PCO-7', '0711000001', ''], NOW);
  const p2 = await callApi(d, 'api_callRegister', ['dev-n2', '', '', 'PCO-7', '0711000002', ''], NOW);
  d._dump('call_logs').push({ id: 'LX', user_id: p2.userId, phone: '255716548153', duration: 30, call_date: '2026-08-14' });
  const { _FNS } = await import('../api/portal.js');
  const ADMIN = { code: 'BOSS-1', name: 'Peter Kisoli', role: 'ADMIN', teams: null, tabs: ['codes'], readOnly: false };
  const r = await _FNS.officerDelete(d, ADMIN, { userId: p2.userId });
  assert.equal(r.deleted, true); assert.equal(r.name, 'Neema Mushi');
  assert.equal(d._dump('call_users').some(u => u.user_id === p2.userId), false, 'the row is gone');
  assert.equal(d._dump('call_logs').some(l => l.user_id === p2.userId), false, 'and its calls with it');
  assert.equal(d._dump('call_users').some(u => u.user_id === p1.userId), true, 'her other phone is untouched');
  const gone = await callApi(d, 'api_callList', ['dev-n2', 'today'], NOW);
  assert.equal(gone.ok, false); assert.equal(gone.error, 'DEVICE_NOT_REGISTERED');
  const off = (await _FNS.officers(d, ADMIN)).officers;
  assert.deepEqual(off.filter(o => o.name === 'Neema Mushi').map(o => o.seatHandsets), [1], 'one phone, one seat, no sharing chip');
  await assert.rejects(() => _FNS.officerDelete(d, ADMIN, { userId: p2.userId }), /haipo tena|no longer exists/);
  // The deal still sums: two people, three cards.
  const a = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const n1 = await callApi(d, 'api_callList', ['dev-n1', 'today'], NOW);
  assert.equal(a.rows.length + n1.rows.length, 3);
});

/* THE WINDOW ENDS ITSELF. "suspension should auto return the person when set end date
   reaches not wait manual activation" -- end to end, through the pane's own call: the day
   after `to`, the roster counts them again and the deal hands them cards, with nobody
   pressing Washa. The roster cache is keyed by day, so the morning after cannot serve the
   day before's roster. This always held (suspendedOn); it is pinned here as the regression
   guard for the promise, and for the pane's contract -- `today` and `suspendTo` travel
   together so the screen can print a lapsed window as "alirudi" rather than as a window. */
test('a suspension window lapses on its own: the day after the end date the person is dealt again', async () => {
  const d = db();
  d._dump('access_codes').push({ code: 'PCO-7', name: 'Neema Mushi', role: 'PCO', teams: null, tabs: [], suspend_from: null, suspend_to: null });
  await registerOfficer(d);                                                                  // Ainea
  await callApi(d, 'api_callRegister', ['dev-n1', '', '', 'PCO-7', '0711000001', ''], NOW);  // Neema
  const { _FNS } = await import('../api/portal.js');
  const { rosterFull } = await import('../api/_lib/call-core.js');
  const ADMIN = { code: 'BOSS-1', name: 'Peter Kisoli', role: 'ADMIN', teams: null, tabs: ['codes'], readOnly: false };
  await _FNS.accessCodeSuspend(d, ADMIN, { code: 'PCO-7', from: '2026-08-13', to: '2026-08-14' });
  assert.deepEqual(Object.values((await rosterFull(d, '2026-08-13')).names), ['Ainea'], 'away: off the roster');
  assert.deepEqual(Object.values((await rosterFull(d, '2026-08-14')).names), ['Ainea'], 'the last day counts');
  assert.deepEqual(Object.values((await rosterFull(d, '2026-08-15')).names).sort(), ['Ainea', 'Neema Mushi'],
    'the day after the end date she is back -- nobody pressed anything');
  // The pane agrees: the window has lapsed, she is not suspended, and the dates are still on record.
  const pane = await _FNS.accessCodes(d, ADMIN);
  const mine = pane.codes.find(c => c.name === 'Neema Mushi');
  assert.equal(mine.suspended, false);
  assert.equal(mine.suspendTo, '2026-08-14');
  assert.match(String(pane.today), /^\d{4}-\d{2}-\d{2}$/, 'the pane compares suspendTo with today to say "alirudi"');
  assert.ok(mine.suspendTo < pane.today, 'and this window is behind us');
  // And the handset, on the 15th, is dealt its share of the book.
  const later = Date.parse('2026-08-15T09:00:00+03:00');
  const n1 = await callApi(d, 'api_callList', ['dev-n1', 'today'], later);
  assert.ok(n1.rows.length >= 1, 'dealt again, automatically');
});

/* A RENAME FOLLOWS THE SEAT. The app copies a code's name onto a phone at sign-in and
   never again, and the seat is that name -- so renaming the code used to split the person
   the moment one phone re-signed and the other did not: two shares again, the chip gone, a
   suspension catching one phone of two. The save now carries the new name onto every app
   row spelled the same, in the same write. */
test('renaming an access code renames every phone signed in under it, so the seat stays one', async () => {
  const d = db();
  d._dump('access_codes').push({ code: 'PCO-7', name: 'Neema Mushi', role: 'PCO', teams: null, tabs: [] });
  await registerOfficer(d);
  await callApi(d, 'api_callRegister', ['dev-n1', '', '', 'PCO-7', '0711000001', ''], NOW);
  await callApi(d, 'api_callRegister', ['dev-n2', '', '', 'PCO-7', '0711000002', ''], NOW);
  const { _FNS } = await import('../api/portal.js');
  const ADMIN = { code: 'BOSS-1', name: 'Peter Kisoli', role: 'ADMIN', teams: null, tabs: ['codes'], readOnly: false };
  const r = await _FNS.saveAccessCode(d, ADMIN, { code: 'PCO-7', name: 'Neema J Mushi', role: 'PCO', allTeams: true, tabs: [] });
  assert.equal(r.renamed, 2, 'both of her phones carry the new name now');
  assert.deepEqual(d._dump('call_users').filter(u => u.device_id !== 'dev-1').map(u => u.name), ['Neema J Mushi', 'Neema J Mushi']);
  // One phone re-signs (and so copies the code's name again), the other does not: still one seat.
  await callApi(d, 'api_callRegister', ['dev-n1', '', '', 'PCO-7', '0711000001', ''], NOW);
  const a = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const n1 = await callApi(d, 'api_callList', ['dev-n1', 'today'], NOW);
  const n2 = await callApi(d, 'api_callList', ['dev-n2', 'today'], NOW);
  assert.equal(a.rows.length + n1.rows.length, 3, 'two people, three cards');
  assert.deepEqual(n1.rows.map(x => x.ref).sort(), n2.rows.map(x => x.ref).sort(), 'both phones, one share');
  for (const x of n1.rows) assert.equal(x.heldBy, 'Neema J Mushi');
  const off = (await _FNS.officers(d, ADMIN)).officers;
  assert.deepEqual(off.filter(o => o.name === 'Neema J Mushi').map(o => o.seatHandsets), [2, 2]);
  // Saving the same name again touches nothing.
  const again = await _FNS.saveAccessCode(d, ADMIN, { code: 'PCO-7', name: 'Neema J Mushi', role: 'PCO', allTeams: true, tabs: [] });
  assert.equal(again.renamed, 0);
});

/* ...BUT NOT WHEN THE NAME IS SOMEBODY ELSE'S TOO. Two codes, one spelling, two people: the
   chip shows them as one seat, and renaming one code is how the office splits them. A phone
   carries no code, so "every phone with the old name" would drag the other person along --
   the save leaves every phone alone instead and says so; each takes its code's name at its
   next sign-in. */
test('renaming one of two same-named codes touches no phone, and says so', async () => {
  const d = db();
  d._dump('access_codes').push({ code: 'PCO-1', name: 'Juma Ally', role: 'PCO', teams: null, tabs: [] });
  d._dump('access_codes').push({ code: 'PCO-2', name: 'Juma Ally', role: 'PCO', teams: null, tabs: [] });
  const j1 = await callApi(d, 'api_callRegister', ['dev-j1', '', '', 'PCO-1', '0711000001', ''], NOW);
  const j2 = await callApi(d, 'api_callRegister', ['dev-j2', '', '', 'PCO-2', '0711000002', ''], NOW);
  const { _FNS } = await import('../api/portal.js');
  const ADMIN = { code: 'BOSS-1', name: 'Peter Kisoli', role: 'ADMIN', teams: null, tabs: ['codes'], readOnly: false };
  const r = await _FNS.saveAccessCode(d, ADMIN, { code: 'PCO-1', name: 'Juma A Ally', role: 'PCO', allTeams: true, tabs: [] });
  assert.equal(r.renamed, 0); assert.equal(r.shared, true);
  const names = Object.fromEntries(d._dump('call_users').map(u => [u.user_id, u.name]));
  assert.equal(names[j1.userId], 'Juma Ally', 'untouched -- it takes the new name at the next sign-in');
  assert.equal(names[j2.userId], 'Juma Ally', 'the other person is never renamed');
  // The first phone re-signs and takes its code's new name: now two seats, as intended.
  await callApi(d, 'api_callRegister', ['dev-j1', '', '', 'PCO-1', '0711000001', ''], NOW);
  const off = (await _FNS.officers(d, ADMIN)).officers;
  assert.deepEqual(off.map(o => [o.name, o.seatHandsets]).sort(), [['Juma A Ally', 1], ['Juma Ally', 1]]);
});

/* AN ERASER IS AUDITED. Deleting a login and every call it logged is the most destructive
   write on the App users table; Zima on the same row is logged, so this must be too, and
   the entry must still be able to say WHOSE login it was once the row is gone. */
test('deleting a login is audited, with the name it had', async () => {
  const { AUDITED, audited } = await import('../api/_lib/audit.js');
  const { _FNS } = await import('../api/portal.js');
  assert.ok(AUDITED.has('officerDelete'), 'in the audited list, beside officerActive');
  assert.ok(AUDITED.has('officerActive'));
  const d = db();
  d._dump('audit_log');   // the table exists in this fixture once asked for
  d._dump('access_codes').push({ code: 'PCO-7', name: 'Neema Mushi', role: 'PCO', teams: null, tabs: [] });
  const p = await callApi(d, 'api_callRegister', ['dev-n1', '', '', 'PCO-7', '0711000001', ''], NOW);
  const ADMIN = { code: 'BOSS-1', name: 'Peter Kisoli', role: 'ADMIN', teams: null, tabs: ['codes'], readOnly: false };
  await audited(d, ADMIN, 'officerDelete', { userId: p.userId },
    () => _FNS.officerDelete(d, ADMIN, { userId: p.userId }), { ip: '41.222.180.4', ua: 'test' });
  const row = d._dump('audit_log').find(r => r.action === 'officerDelete');
  assert.ok(row, 'an audit row');
  assert.equal(row.ok, true);
  assert.equal(row.before.name, 'Neema Mushi', 'whose login it was, read before the row went');
  assert.equal(row.after.name, null, 'and nothing after -- it is gone');
  assert.equal(d._dump('call_users').some(u => u.user_id === p.userId), false);
});

test('the bar: own yesterday % and last-week average for a credit user; company for a leader', async () => {
  _clearSummaryCache();
  const NOWF = Date.parse('2026-08-14T09:00:00+03:00');          // Friday; last week = Mon 03 .. Sun 09
  // Who the per-deck shuffle deals X1 and W1 to, computed with the very function every
  // screen shares -- the fixture then attributes the calls to whoever actually held them.
  const roster = ['U1', 'U2'];
  const yHolder = dealMap([{ imei: 'X1', snapshot_date: '2026-08-13' }, { imei: 'X2', snapshot_date: '2026-08-13' }], roster, '2026-08-13').X1;
  const wHolder = dealMap([{ imei: 'W1', snapshot_date: '2026-08-05' }], roster, '2026-08-05').W1;
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D' }],
    followup_status: [
      { imei: 'A', client_name: 'Leo Mmoja', contact: '255716000001', team: 'KINONDONI',
        disbursed_date: '2026-08-01', days_offline: 9, locked4: true, locked7: false, deck_date: '2026-08-14' },
    ],
    call_users: [
      { user_id: 'U1', device_id: 'dev-1', name: 'Ainea', team: 'KINONDONI', role: 'CREDIT', is_leader: false, active: true },
      { user_id: 'U2', device_id: 'dev-2', name: 'Baraka', team: 'KINONDONI', role: 'CREDIT', is_leader: true, active: true },
      { user_id: 'U9', device_id: 'dev-9', name: 'Bosi', team: 'KINONDONI', role: 'MANAGER', is_leader: true, active: true },
    ],
    /* Yesterday's book: two customers. The deal RESHUFFLES per deck now, so who holds
       X1 is derived from dealMap below rather than assumed from IMEI order -- the test
       pins the SEMANTICS (each bar measures the share its officer actually held), not
       one arrangement's accident. */
    watu_snapshots: [
      { imei: 'X1', client_mobile: '255716111111', snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      { imei: 'X2', client_mobile: '255716222222', snapshot_date: '2026-08-13', created_at: '2026-08-13T08:00:00Z' },
      // One day of last week, one customer.
      { imei: 'W1', client_mobile: '255716333333', snapshot_date: '2026-08-05', created_at: '2026-08-05T08:00:00Z' },
    ],
    call_logs: [
      // The holder of X1 reached them; the holder of X2 called NOBODY.
      { id: 'L1', user_id: yHolder, phone: '255716111111', duration: 95, call_date: '2026-08-13' },
      // Whoever was dealt the last-week customer reached them too.
      { id: 'L2', user_id: wHolder, phone: '255716333333', duration: 60, call_date: '2026-08-05' },
    ],
  });
  const devOf = { U1: 'dev-1', U2: 'dev-2' };
  const sA = await callApi(d, 'api_callDailySummary', [devOf[yHolder]], NOWF);
  assert.equal(sA.reached.pct, 1, 'the holder of X1 reached 1 of their 1 dealt yesterday customer');
  assert.equal(sA.asOfReached, '2026-08-13');
  const other = yHolder === 'U1' ? 'U2' : 'U1';
  const sB = await callApi(d, 'api_callDailySummary', [devOf[other]], NOWF);
  assert.equal(sB.reached.pct, 0, 'the holder of X2 reached 0 of their 1 -- the bar does not hide it');
  // The one last-week customer was dealt to exactly one of them: their worked day
  // averages 100%, the other has no dealt last-week day at all.
  const sW = wHolder === yHolder ? sA : sB;
  const sN = wHolder === yHolder ? sB : sA;
  assert.equal(sW.weekAvg.pct, 1, 'the holder of W1\'s one worked last-week day averaged 100%');
  assert.equal(sN.weekAvg.pct, null, 'no last-week customer was dealt to the other officer');
  _clearSummaryCache();
  const s9 = await callApi(d, 'api_callDailySummary', ['dev-9'], NOWF);
  assert.equal(s9.reached.den, 2, 'the leader sees the COMPANY: everyone\'s yesterday book');
  assert.equal(s9.reached.num, 1);
  assert.equal(s9.reached.pct, 0.5);
  _clearSummaryCache();
});

test('only CREDIT roles are dealt shares -- everyone else opens the whole book', async () => {
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [{ team: 'HOOP', team_code: 'AB2C3D' }],
    followup_status: [
      { imei: 'A', client_name: 'One', contact: '255716000001', team: 'DAR', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
      { imei: 'B', client_name: 'Two', contact: '255716000002', team: 'DAR', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
    ],
    call_users: [
      { user_id: 'U1', device_id: 'dev-1', name: 'Ainea', role: 'OFFICER', is_leader: false, active: true },
      { user_id: 'U2', device_id: 'dev-2', name: 'Baraka', role: 'CREDIT', is_leader: false, active: true },
      { user_id: 'U5', device_id: 'dev-5', name: 'Mwinyi', role: 'GENERAL DUTY', is_leader: false, active: true },
    ],
    call_logs: [],
  });
  const a = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const b = await callApi(d, 'api_callList', ['dev-2', 'today'], NOW);
  assert.equal(a.rows.length + b.rows.length, 2, 'the two CREDIT users split the book equally');
  assert.equal(Math.abs(a.rows.length - b.rows.length), 0);
  const g = await callApi(d, 'api_callList', ['dev-5', 'today'], NOW);
  assert.equal(g.rows.length, 2, 'a non-credit role is NOT dealt -- they open the whole book');
});

/* ---------- the card knows the seller + the AGENT stage ---------- */

test('the card carries WHO SOLD the phone: agent name, id and own number on the row', async () => {
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [],
    followup_status: [
      { imei: 'A', client_name: 'One', contact: '255716000001', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
      { imei: 'B', client_name: 'Two', contact: '255716000002', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
    ],
    watu_loans: [{ imei: 'A', agent: 'Anord Sawe', agent_id: '77123',
      guarantor_name: 'Issack daniely samawa', guarantor_phone: '0788533370' }],
    hoop_agents: [{ name: 'Anord Sawe', phone: '0658918324' }],
    call_users: [{ user_id: 'U1', device_id: 'dev-1', name: 'Ainea', role: 'CREDIT', active: true }],
    call_logs: [],
  });
  const r = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const a = r.rows.find(x => x.ref === 'A'), b = r.rows.find(x => x.ref === 'B');
  assert.equal(a.agentName, 'Anord Sawe');
  assert.equal(a.agentId, '77123');
  assert.equal(a.agentPhone, '0658918324', 'the agent\'s own number comes from Sipho\'s register by name');
  assert.equal(a.gName, 'Issack daniely samawa', 'the offline queue put a REAL guarantor on the card');
  assert.equal(a.gContact, '0788533370');
  assert.equal(b.agentName, '', 'an IMEI missing from the register shows a dash, never a guess');
  assert.equal(b.gName, '', 'no guarantor on file stays an honest blank');
  assert.equal(a.heldBy, 'Ainea', 'the third chip: the credit person chasing this customer');
  assert.equal(b.heldBy, 'Ainea', 'one credit user holds the whole book, so every row says so');
});

test('the card survives a database that has not run the guarantor migration yet', async () => {
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [],
    followup_status: [
      { imei: 'A', client_name: 'One', contact: '255716000001', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
    ],
    watu_loans: [{ imei: 'A', agent: 'Anord Sawe', agent_id: '77123' }],
    hoop_agents: [{ name: 'Anord Sawe', phone: '0658918324' }],
    call_users: [{ user_id: 'U1', device_id: 'dev-1', name: 'Ainea', role: 'CREDIT', active: true }],
    call_logs: [],
  }, { missingColumns: { watu_loans: ['guarantor_name', 'guarantor_phone', 'branch'] } });
  const r = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(r.rows[0].agentName, 'Anord Sawe', 'the un-migrated select falls back -- the agent still shows');
  assert.equal(r.rows[0].gName, '', 'guarantor is simply blank until the migration runs');
});

test('an agent signs in with PHONE + the shared code alone; the register is the identity', async () => {
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }],
    teams: [{ team: 'HOOP', team_code: 'AB2C3D' }, { team: 'AGENT', team_code: 'QQ7R8S' }],
    hoop_agents: [{ name: 'Anord Sawe', phone: '0658918324', branch: 'KINONDONI' }],
    call_users: [],
  });
  // No name typed at all -- the register supplies the name AND the branch by phone.
  const r = await callApi(d, 'api_callRegister',
    ['dev-9', '', '', '', '0658918324', 'QQ7R8S'], NOW);
  assert.equal(r.ok, true);
  const cu = d._dump('call_users')[0];
  assert.equal(cu.role, 'AGENT');
  assert.equal(cu.name, 'Anord Sawe', 'the register\'s spelling, not a typed one');
  assert.equal(cu.team, 'KINONDONI', 'the BRANCH column of Sipho\'s report IS the agent\'s location');
  assert.equal(cu.is_leader, false);
  // A phone the register does NOT know cannot become an agent account at all --
  // the fence fails closed at the front door.
  await assert.rejects(() => callApi(d, 'api_callRegister',
    ['dev-7', 'Someone New', '', '', '0755000111', 'QQ7R8S'], NOW), /agents register/i);
  // The staff code is untouched: name still typed, role OFFICER, the deal covers them.
  const r3 = await callApi(d, 'api_callRegister',
    ['dev-8', 'Ainea', '', '', '0712345678', 'AB2C3D'], NOW);
  assert.equal(r3.ok, true);
  assert.equal(d._dump('call_users').find(u => u.name === 'Ainea').role, 'OFFICER');
});

const agentStageDb = () => fakeDb({
  settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
  teams: [],
  followup_status: [
    { imei: 'A', client_name: 'Mine', contact: '255716000001', deck_date: '2026-08-14', disbursed_date: '2026-08-01', locked7: true },
    { imei: 'B', client_name: 'Not Mine', contact: '255716000002', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
    { imei: 'C', client_name: 'Unregistered Sale', contact: '255716000003', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
  ],
  watu_loans: [
    { imei: 'A', agent: 'Anord Sawe', agent_id: '1' },
    { imei: 'B', agent: 'Neema John', agent_id: '2' },
  ],
  hoop_agents: [
    { name: 'Anord Sawe', phone: '0658918324' },
    { name: 'Neema John', phone: '0712000999' },
  ],
  call_users: [
    { user_id: 'U1', device_id: 'dev-1', name: 'Ainea', role: 'CREDIT', active: true },
    { user_id: 'U2', device_id: 'dev-2', name: 'Anord Sawe', role: 'AGENT', phone: '658918324', team: 'Mbagala', active: true },
    { user_id: 'U3', device_id: 'dev-3', name: 'Stranger', role: 'AGENT', phone: '655000000', team: 'Kigamboni', active: true },
  ],
  call_logs: [],
});

test('an AGENT sees ONLY the customers they sold; the credit deal never counts them', async () => {
  const d = agentStageDb();
  const ag = await callApi(d, 'api_callList', ['dev-2', 'today'], NOW);
  assert.equal(ag.rows.length, 1, 'exactly the phones they sold');
  assert.equal(ag.rows[0].ref, 'A');
  const cr = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(cr.rows.length, 3, 'the only CREDIT user still holds the whole book -- agents are outside the deal');
  const str = await callApi(d, 'api_callList', ['dev-3', 'today'], NOW);
  assert.equal(str.rows.length, 0, 'an unknown agent phone fails CLOSED -- empty, never somebody else\'s book');
  assert.match(String(str.note), /agents register/);
});

test('the agent strip counts THEIR book, never the company', async () => {
  _clearSummaryCache();
  const d = agentStageDb();
  const s = await callApi(d, 'api_callDailySummary', ['dev-2'], NOW);
  assert.equal(s.ok, true);
  assert.equal(s.list.num, 1, 'one sold customer on today\'s deck');
  assert.equal(s.locked7.num, 1);
  assert.equal(s.onRegister, true);
  _clearSummaryCache();
  const s3 = await callApi(d, 'api_callDailySummary', ['dev-3'], NOW);
  assert.equal(s3.list.num, 0);
  assert.equal(s3.onRegister, false, 'the strip says the phone is not on the register');
  _clearSummaryCache();
});

/* TEAM LEADER AND RSM, THE SAME FENCE WIDER.
   =========================================================================================
     "for team leader, agent and RSM roles, they only should ever see their data (pivoted
      of imeis they are assigned too -- as hope pmo does to its users) from the calls app
      to all system nav tabs"

   Both sign in on their OWN access code (leader = true), never a shared team code, so their
   name is already the identity -- no phone lookup. Their fence is the SAME salesTree walk
   NEW STOCK's RSM column and the targets roll-up already use: their own name, plus everyone
   beneath them in the register at any depth. */
const hierarchyStageDb = () => fakeDb({
  settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
  teams: [],
  followup_status: [
    { imei: 'A', client_name: 'Sold By Agent', contact: '255716000001', deck_date: '2026-08-14', disbursed_date: '2026-08-01', locked7: true },
    { imei: 'B', client_name: 'Sold By Other RSM', contact: '255716000002', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
  ],
  watu_loans: [
    { imei: 'A', agent: 'Anord Sawe' },
    { imei: 'B', agent: 'Somebody Else' },
  ],
  hoop_agents: [
    { name: 'Anord Sawe', phone: '0658918324', role: 'Field_Officer', manager: 'Juma Leader' },
    { name: 'Juma Leader', phone: '0700000001', role: 'Team_Leader', manager: 'Rehema RSM' },
    { name: 'Rehema RSM', phone: '0700000002', role: 'Regional_Manager' },
    { name: 'Somebody Else', phone: '0700000003', role: 'Field_Officer', manager: 'Other RSM' },
    { name: 'Other RSM', phone: '0700000004', role: 'Regional_Manager' },
  ],
  call_users: [
    // Access-code sign-ins: is_leader true, identity is the name, not the phone.
    { user_id: 'U-TL', device_id: 'dev-tl', name: 'Juma Leader', role: 'TEAM LEADER', is_leader: true, active: true },
    { user_id: 'U-RSM', device_id: 'dev-rsm', name: 'Rehema RSM', role: 'RSM', is_leader: true, active: true },
    { user_id: 'U-NEW', device_id: 'dev-new', name: 'Nobody Yet', role: 'TEAM LEADER', is_leader: true, active: true },
  ],
  call_logs: [],
});

test('TEAM LEADER and RSM see their whole subtree, at any depth -- not just their own name', async () => {
  const d = hierarchyStageDb();
  const tl = await callApi(d, 'api_callList', ['dev-tl', 'today'], NOW);
  assert.equal(tl.rows.length, 1, 'the team leader\'s one agent, two rungs down');
  assert.equal(tl.rows[0].ref, 'A');
  const rsm = await callApi(d, 'api_callList', ['dev-rsm', 'today'], NOW);
  assert.equal(rsm.rows.length, 1, 'the RSM sees the SAME agent through the team leader between them');
  assert.equal(rsm.rows[0].ref, 'A');
  /* An access-code sign-in always knows its OWN name (there is no phone lookup to fail the
     way a shared AGENT code can) -- so a TEAM LEADER the register has never heard of still
     resolves to a one-person set (themselves) rather than "unidentified". With nobody
     reporting to them and nothing sold under their own name, that is still an empty,
     fenced-closed book -- just reported as "nothing today" rather than "who are you". */
  const nobody = await callApi(d, 'api_callList', ['dev-new', 'today'], NOW);
  assert.equal(nobody.rows.length, 0, 'nobody reports to a name the register has never heard of');
  assert.match(String(nobody.note), /Hakuna mteja/);
});

test('the team leader/RSM strip counts the whole subtree, never the company', async () => {
  _clearSummaryCache();
  const d = hierarchyStageDb();
  const tl = await callApi(d, 'api_callDailySummary', ['dev-tl'], NOW);
  assert.equal(tl.list.num, 1);
  assert.equal(tl.onRegister, true);
  _clearSummaryCache();
  const rsm = await callApi(d, 'api_callDailySummary', ['dev-rsm'], NOW);
  assert.equal(rsm.list.num, 1, 'the RSM\'s strip is the same subtree, not the company\'s two customers');
  _clearSummaryCache();
});

test('a blank-role trial account is NOT dealt -- it opens the whole book', async () => {
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [],
    followup_status: [
      { imei: 'A', client_name: 'One', contact: '255716000001', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
      { imei: 'B', client_name: 'Two', contact: '255716000002', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
    ],
    call_users: [
      { user_id: 'U0', device_id: 'dev-0', name: 'Old Trial', is_leader: false, active: true },
      { user_id: 'U1', device_id: 'dev-1', name: 'Neema', role: 'CREDIT', is_leader: true, active: true },
    ],
    call_logs: [],
  });
  const old = await callApi(d, 'api_callList', ['dev-0', 'today'], NOW);
  assert.equal(old.rows.length, 2, 'no role saved -> whole book, never a share');
  const cr = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  assert.equal(cr.rows.length, 2, 'the ONLY credit account holds the whole book -- n=1');
});

test('the agent number reaches the card from the SALES report too, whatever the name order', async () => {
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [],
    followup_status: [
      { imei: 'A', client_name: 'One', contact: '255716000001', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
      { imei: 'B', client_name: 'Two', contact: '255716000002', deck_date: '2026-08-14', disbursed_date: '2026-08-01' },
    ],
    watu_loans: [
      { imei: 'A', agent: 'Neema John' },
      { imei: 'B', agent: 'Anord Sawe' },
    ],
    // Sipho's register spells the name the other way round -- token order must not matter.
    hoop_agents: [{ name: 'SAWE Anord', phone: '0658918324' }],
    // Neema is not on the register yet; her payout number rides the sales report.
    hoop_sales: [{ commission_agent: 'Neema John', commission_phone: '0712000999' }],
    call_users: [{ user_id: 'U1', device_id: 'dev-1', name: 'Ainea', role: 'CREDIT', active: true }],
    call_logs: [],
  });
  const r = await callApi(d, 'api_callList', ['dev-1', 'today'], NOW);
  const a = r.rows.find(x => x.ref === 'A'), b = r.rows.find(x => x.ref === 'B');
  assert.equal(a.agentPhone, '0712000999', 'the sales report fills the register\'s gap');
  assert.equal(b.agentPhone, '0658918324', 'token-sorted names: SAWE Anord IS Anord Sawe');
});

test('guarantor and agent calls are PORTFOLIO calls', async () => {
  const d = fakeDb({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' }],
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D' }],
    followup_status: [
      { imei: '351929937378664', client_name: 'Alafati Kalikawe Selemani', contact: '255716548153',
        team: 'KINONDONI', deck_date: '2026-08-14', disbursed_date: '2026-07-13' },
    ],
    watu_loans: [{ imei: '351929937378664', client_name: 'Alafati Kalikawe Selemani',
      team: 'KINONDONI', guarantor_phone: '0788533370' }],
    hoop_agents: [{ name: 'Anord Sawe', phone: '0658918324' }],
    followup_comments: [], call_users: [], call_logs: [],
  });
  await callApi(d, 'api_callRegister', ['dev-1', 'Ainea', '', '', '0712345678', 'AB2C3D'], NOW);
  const r = await callApi(d, 'api_callSync', ['dev-1', [
    { ts: NOW - 3600000, dur: 60, dir: 'out', num: '0788533370', outcome: 'CONNECTED' },  // the guarantor
    { ts: NOW - 1800000, dur: 45, dir: 'out', num: '0658918324', outcome: 'CONNECTED' },  // the agent
  ]], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.portfolio, 2, 'ringing the guarantor or the agent IS portfolio work');
  const logs = d._dump('call_logs');
  const g = logs.find(l => l.match_type === 'GUARANTOR');
  assert.equal(g.ref, '351929937378664', 'the guarantor call points at THEIR customer');
  assert.match(g.customer, /mdhamini/);
  const ag = logs.find(l => l.match_type === 'AGENT');
  assert.equal(ag.portfolio, true);
  assert.match(ag.customer, /Agent: Anord Sawe/);
});

/* =====================================================================================
   THE DEAL RESHUFFLES WITH EVERY DECK -- "The credits should always get random customers
   so have random assignement model during distribution per each watu deck upload."
   ===================================================================================== */

/* =====================================================================================
   EVERY OFFICER'S WHOLE BOOK IS EQUAL, NOT JUST EVERY TAB.

     "customer distribution for credits is always skipping one per credit agent since no
      matter how many customers there is, the provided day list is always 4 less"

   The deal is cut in four strata, and each one used to start dealing at the SAME officer.
   A stratum whose size does not divide by the roster gives its remainder to whoever is at
   the front -- so with four strata that is the same person four times over. On a
   60-customer deck: one officer 18, the other three 14 each. Every one of them exactly
   four short, and short by the same four however big the book gets, because it is one card
   per stratum rather than a proportion.

   The old comment promised "plus-minus one" and that was only ever true WITHIN a stratum.
   This asserts it across the whole book, which is where the officers actually feel it.
   ===================================================================================== */
test('no officer is a whole stratum short -- the deal is equal within one across the book', () => {
  // Sizes chosen so EVERY stratum leaves a remainder over the roster: the worst case, and
  // the one the office hit. Under the old deal this produced a spread of four.
  const mk = (n, extra, from) => Array.from({ length: n }, (_, i) => Object.assign(
    { imei: 'IM' + from + i, deck_date: '2026-08-14' }, extra));
  const rows = [
    ...mk(9, { locked7: true, disbursed_date: '2026-08-10' }, 'a'),
    ...mk(13, { locked4: true, disbursed_date: '2026-08-10' }, 'b'),
    ...mk(17, { disbursed_date: '2026-08-10' }, 'c'),
    ...mk(21, { disbursed_date: '2026-01-01' }, 'd'),          // beyond the 45-day window
  ];
  const roster = ['U1', 'U2', 'U3', 'U4'];
  const deal = dealMap(rows, roster, '2026-08-14');

  const per = Object.fromEntries(roster.map(o => [o, 0]));
  for (const r of rows) {
    const held = deal[String(r.imei)];
    assert.ok(held, 'every customer must be dealt to somebody: ' + r.imei);
    per[held]++;
  }
  const counts = Object.values(per);
  assert.equal(counts.reduce((a, b) => a + b, 0), rows.length,
    'the shares must add up to the whole deck -- a lost row is a customer nobody calls');
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
    'one officer is carrying a whole stratum more than another: ' + JSON.stringify(per));

  /* AND EVERY TAB STAYS EQUAL TOO, which is what the stratified deal exists for. Fixing the
     total by dealing one flat round-robin over the whole book would satisfy the assertion
     above and quietly undo that -- so both are pinned, and neither can be traded away for
     the other by somebody simplifying this later. */
  for (const [name, want, pick] of [
    ['L7', 9, r => r.locked7],
    ['L4', 13, r => r.locked4],
    ['IN', 17, r => !r.locked7 && !r.locked4 && r.disbursed_date === '2026-08-10'],
    ['OUT', 21, r => r.disbursed_date === '2026-01-01'],
  ]) {
    const tab = rows.filter(pick);
    assert.equal(tab.length, want, name + ' fixture drifted; this test is no longer testing it');
    const t = Object.fromEntries(roster.map(o => [o, 0]));
    for (const r of tab) t[deal[String(r.imei)]]++;
    const tc = Object.values(t);
    assert.ok(Math.max(...tc) - Math.min(...tc) <= 1,
      name + ' is not dealt evenly: ' + JSON.stringify(t));
  }
});

test('the same deck date always cuts the same deal -- a re-upload cannot reshuffle mid-morning', () => {
  const rows = 'ABCDEFGH'.split('').map(x => ({ imei: 'IM' + x, deck_date: '2026-08-14' }));
  const a = dealMap(rows, ['U1', 'U2'], '2026-08-14');
  const b = dealMap(rows.slice().reverse(), ['U1', 'U2'], '2026-08-14');
  assert.deepEqual(a, b, 'row arrival order and repeat calls change nothing within one deck');
});

test('consecutive decks deal the same customers to DIFFERENT officers', () => {
  const mk = day => 'ABCDEFGHJK'.split('').map(x => ({ imei: 'IM' + x, deck_date: day }));
  const roster = ['U1', 'U2'];
  const days = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
  const deals = days.map(day => dealMap(mk(day), roster, day));
  let moved = 0;
  for (let i = 1; i < deals.length; i++) {
    for (const imei of Object.keys(deals[i])) if (deals[i][imei] !== deals[i - 1][imei]) moved++;
  }
  assert.ok(moved > 0, 'at least some customers change hands between decks -- the arrangement is not frozen');
  // And every deck is still fair: half the book each, plus-minus one.
  for (const deal of deals) {
    const n1 = Object.values(deal).filter(u => u === 'U1').length;
    assert.ok(Math.abs(n1 - (10 - n1)) <= 1, 'the shuffle never costs the equal cut: ' + n1 + ' vs ' + (10 - n1));
  }
});

test('the deal keys on the DECK\'S own date, not the viewing day -- a stale deck keeps its arrangement', () => {
  const rows = 'ABCDEF'.split('').map(x => ({ imei: 'IM' + x, deck_date: '2026-08-13' }));
  const monday = dealMap(rows, ['U1', 'U2'], '2026-08-13');
  const tuesdayStillStale = dealMap(rows, ['U1', 'U2'], '2026-08-14');
  assert.deepEqual(monday, tuesdayStillStale, 'the deal belongs to the upload, not the calendar');
});

test('followup rows (deck_date) and snapshot rows (snapshot_date) cut the SAME deal for one date', () => {
  const imeis = 'ABCDEFGH'.split('');
  const fu = imeis.map(x => ({ imei: 'IM' + x, deck_date: '2026-08-13' }));
  const snap = imeis.map(x => ({ imei: 'IM' + x, snapshot_date: '2026-08-13' }));
  assert.deepEqual(dealMap(fu, ['U1', 'U2'], '2026-08-14'), dealMap(snap, ['U1', 'U2'], '2026-08-13'),
    'the phone\'s deck and Recovery\'s reconstruction can never disagree about who held whom');
});

test('the round-robin\'s starting officer rotates too -- one customer does not live with one officer', () => {
  const roster = ['U1', 'U2', 'U3'];
  const holders = new Set();
  for (let i = 1; i <= 9; i++) {
    const day = '2026-08-0' + ((i % 9) + 1);
    holders.add(dealMap([{ imei: 'LONER', deck_date: day }], roster, day).LONER);
  }
  assert.ok(holders.size > 1, 'across nine decks a lone customer is chased by more than one officer');
});

/* =========================================================================================
   THE DASHBOARD'S LOCK TILE: every lock inside the window, and the week's direction.
     "the reached-yesterday widget at dashboard should be summary of total locked <=45 since the
      list of officers doesn't have that, put it there so that we see overall weekly progress"
   ========================================================================================= */
test('summaryFor counts every Watu lock inside the 45-day window, and the week\'s first upload beside it', async () => {
  const { summaryFor } = await import('../api/_lib/call-core.js');
  _clearSummaryCache();
  // Friday 2026-08-14; the week's Monday is 2026-08-10.
  const NOWF = Date.parse('2026-08-14T12:00:00Z');
  const d = fakeDb({
    settings: [{ key: 'DATA_VERSION', value: 'v1' }],
    followup_status: [
      { imei: 'A', contact: '255716000001', disbursed_date: '2026-08-01', days_offline: 9, locked4: true, locked7: true, deck_date: '2026-08-14' },
      { imei: 'B', contact: '255716000002', disbursed_date: '2026-08-01', days_offline: 5, locked4: true, locked7: false, deck_date: '2026-08-14' },
      { imei: 'C', contact: '255716000003', disbursed_date: '2026-08-01', days_offline: 0, locked4: false, locked7: false, deck_date: '2026-08-14' },
      // Locked, but out of the window: not counted, exactly as the 7+ tile does not count it.
      { imei: 'D', contact: '255716000004', disbursed_date: '2026-05-01', days_offline: 20, locked4: true, locked7: true, deck_date: '2026-08-14' },
    ],
    watu_snapshots: [
      // Monday's upload: three locked in the window, so the week reads 3 -> 2.
      { imei: 'A', client_mobile: '255716000001', snapshot_date: '2026-08-10', created_at: '2026-08-10T08:00:00Z', disbursed_date: '2026-08-01', locked4: true, locked7: true },
      { imei: 'B', client_mobile: '255716000002', snapshot_date: '2026-08-10', created_at: '2026-08-10T08:00:00Z', disbursed_date: '2026-08-01', locked4: true, locked7: false },
      { imei: 'C', client_mobile: '255716000003', snapshot_date: '2026-08-10', created_at: '2026-08-10T08:00:00Z', disbursed_date: '2026-08-01', locked4: true, locked7: false },
      { imei: 'D', client_mobile: '255716000004', snapshot_date: '2026-08-10', created_at: '2026-08-10T08:00:00Z', disbursed_date: '2026-05-01', locked4: true, locked7: true },
    ],
    call_logs: [], call_users: [], teams: [],
  });
  const s = await summaryFor(d, { teams: null }, NOWF);
  assert.equal(s.locked7.num, 1, 'the 7+ tile is unchanged');
  assert.equal(s.lockedAll.num, 2, '4+ and 7+ inside the window, D outside it');
  assert.deepEqual(s.lockedAll.weekStart, { date: '2026-08-10', num: 3 }, 'Monday\'s upload, counted as it stood on Monday');
  _clearSummaryCache();
});
