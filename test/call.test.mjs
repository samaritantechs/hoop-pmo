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
  assert.equal(s.list.num, 4, 'company pool: both branches AND the beyond-window row stay on the deck');
  assert.equal(s.locked7.num, 2, 'the day-100 row stays OUT even with the 2-day grace; days 33 and 47 count');
  assert.equal(s.inWindow.num, 3);
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
