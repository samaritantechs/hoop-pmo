/* SERVER-SIDE TESTS FOR THE POSTGRES-ROUND-TRIP-AUDIT UI FIXES.
 *
 * Kept separate from test/portal.test.mjs (which nobody else edits either, but this file
 * belongs entirely to the "uploading and the call app never go down" round-trip audit and
 * is easier to find on its own). Each test below proves ONE of the fixes: that a new combined
 * fn returns exactly what the individual fns it calls would have, or that a write's response
 * now carries a field the client used to fetch again to get.
 *
 * test/speed.test.mjs is not touched here, and not imported either -- it registers its own
 * top-level tests, and importing it from another test file would run them a second time. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { todayKey } from '../api/_lib/time.js';

const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'], readOnly: false };

function dayShift(base, days) {
  const d = new Date(Date.parse(base + 'T00:00:00Z') + days * 86400000);
  return d.toISOString().slice(0, 10);
}

/* =========================================================================================
   FIX 2 -- dashboardWeek: one trip instead of four (five, counting recoveryWeek's own
   double-fetch), running the SAME lockedTrend/recoveryWeek/salesWeek/stockAccount this file
   already tests on their own, so there is still exactly one definition of each figure.
   ========================================================================================= */
function dashboardBook() {
  const today = todayKey();
  const dow = new Date(Date.parse(today + 'T00:00:00Z')).getUTCDay();
  const mon = dayShift(today, -((dow + 6) % 7));
  const tue = dayShift(mon, 1);
  const recent = dayShift(mon, -10);
  const prevStock = dayShift(today, -1);

  const snap = (imei, date, off, disb, l7) => ({ imei, client_name: 'C' + imei, team: 'KINONDONI',
    days_offline: off, locked7: l7, has_ever_paid: true, price: 450000, disbursed_date: disb,
    snapshot_date: date, created_at: date + 'T08:00:00Z' });
  const loan = (k, date, agent, branch, price) => ({ imei: 'IM' + k, disbursed_date: date,
    price, agent, agent_id: 'A' + k, branch, team: 'PIVOTTEST' });
  const st = (serial, agent, as_of, age) => ({ serial, agent, item: 'A07', age_days: age, as_of,
    received: dayShift(as_of, -(age || 0)) });

  return fakeDb({
    watu_snapshots: [
      snap('A', mon, 9, recent, true), snap('B', mon, 8, recent, true),
      snap('A', tue, 4, recent, false), snap('B', tue, 8, recent, true),
    ],
    call_users: [
      { user_id: 'u1', name: 'CREDIT ONE', role: 'CREDIT', active: true },
      { user_id: 'u2', name: 'CREDIT TWO', role: 'CREDIT', active: true },
    ],
    watu_loans: [
      loan('P', mon, 'AGENT X', 'BRANCH ONE', 500000),
      loan('Q', tue, 'AGENT X', 'BRANCH ONE', 900000),
    ],
    hoop_aged_stock: [
      st('S1', 'SIPHO STORE', prevStock, 3), st('S2', 'SIPHO STORE', prevStock, 60),
      st('S1', 'SIPHO STORE', today, 4),
    ],
    hoop_agents: [{ name: 'AGENT X', role: 'Field_Officer', branch: 'BRANCH ONE' }],
    settings: [{ key: 'SALES_DAILY_TARGET', value: '1000000' }],
  });
}

test('dashboardWeek returns all four parts for ADMIN, matching what each fn returns on its own', async () => {
  const d = dashboardBook();
  const dw = await _FNS.dashboardWeek(d, ADMIN, {});
  assert.ok(dw.trend, 'trend is missing');
  assert.ok(dw.recovery, 'recovery is missing');
  assert.ok(dw.sales, 'sales is missing -- ADMIN holds every nav');
  assert.ok(dw.stock, 'stock is missing -- ADMIN holds every nav');

  // Same fixture, same args, called directly: dashboardWeek must not have reimplemented any
  // of these, only called them -- so their answers, not just their presence, must agree.
  const trend = await _FNS.lockedTrend(d, ADMIN, {});
  const recovery = await _FNS.recoveryWeek(d, ADMIN, {});
  const sales = await _FNS.salesWeek(d, ADMIN, {});
  const stock = await _FNS.stockAccount(d, ADMIN, {});
  assert.deepEqual(dw.trend.points, trend.points);
  assert.equal(dw.trend.from, trend.from);
  assert.deepEqual(dw.recovery.points, recovery.points);
  assert.deepEqual(dw.recovery.credits, recovery.credits);
  assert.deepEqual(dw.sales.company, sales.company);
  assert.deepEqual(dw.stock.company.totals, stock.company.totals);
});

test('dashboardWeek gives a code without scorecards or stock a null sales and a null stock, not an error', async () => {
  /* dashboard + recovery + fraud: fraud is not one of the old-vocabulary words auth.js's
     USER_TABS/EXTRA_TABS carry, so navsFor treats this as a DELIBERATE, exact choice rather
     than falling back to the legacy "whole department" default -- see navsFor's own comment.
     Neither scorecards nor stock is ticked. */
  const CODE = { code: 'Y', name: 'Dash Only', role: 'MANAGER', teams: null,
    tabs: ['dashboard', 'recovery', 'fraud'], readOnly: false };
  const d = dashboardBook();
  const dw = await _FNS.dashboardWeek(d, CODE, {});
  assert.ok(dw.trend, 'trend is still drawn -- it needs only dashboard or recovery');
  assert.ok(dw.recovery, 'recovery is still drawn for the same reason');
  assert.equal(dw.sales, null, 'sales must be null, not a 403, for a code that never held scorecards');
  assert.equal(dw.stock, null, 'stock must be null, not a 403, for a code that never held stock');
});

test('dashboardWeek itself requires the dashboard nav', async () => {
  const NONE = { code: 'Z', name: 'Nobody', role: 'MANAGER', teams: null, tabs: ['fraud'], readOnly: false };
  await assert.rejects(() => _FNS.dashboardWeek(dashboardBook(), NONE, {}), /dashboard/);
});

/* =========================================================================================
   FIX 3 -- portalAddComment hands back the row it just wrote, exactly as customerComments
   would have, so the customer drawer can prepend it instead of re-fetching the whole history
   for the one line it already knows it just saved.
   ========================================================================================= */
test('portalAddComment returns the new comment\'s own fields, not just ok/imei', async () => {
  const d = fakeDb({ followup_status: [], followup_comments: [] });
  const r = await _FNS.portalAddComment(d, ADMIN, { imei: '123', team: null, name: 'A Customer',
    fu: 'Ameahidi', promiseDate: '2026-09-25', comment: 'Atalipa Ijumaa' });
  assert.equal(r.ok, true);
  assert.equal(r.comment, 'Atalipa Ijumaa');
  assert.equal(r.fu_status, 'Ameahidi');
  assert.equal(r.promise_date, '2026-09-25');
  assert.equal(r.created_by, 'Peter', 'the actor is the access code\'s own name');
  assert.ok(r.created_at, 'a timestamp the row markup can print, same as customerComments rows carry');

  // And it is exactly what customerComments itself would say the row now looks like.
  const list = await _FNS.customerComments(d, ADMIN, { imei: '123' });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].comment, r.comment);
  assert.equal(list.items[0].fu_status, r.fu_status);
  assert.equal(list.items[0].created_by, r.created_by);
});

/* =========================================================================================
   FIX 8 -- transferDecline hands back declinedAt/declinedBy/reason, so the transfer drawer
   can merge them onto the document it is already showing instead of calling transferGet
   again to learn the outcome of the decline it just made.
   ========================================================================================= */
function oneTransfer(over) {
  const now = new Date().toISOString();
  return Object.assign({
    id: 'T1', ref: 'TR-1', created_at: now, created_by: 'AGENT ONE',
    from_name: 'AGENT ONE', from_phone: null, from_role: 'AGENT',
    to_name: 'RSM DAR', to_phone: null, to_role: 'RSM',
    note: null, item_count: 1, total_qty: 1, total_amount: 100000,
    sender_signature: 'sig', sender_signed_by: 'AGENT ONE', sender_signed_at: now,
    receiver_signature: null, receiver_signed_by: null, receiver_signed_at: null,
    status: 'sent', accepted_at: null, accepted_by: null,
    declined_at: null, declined_by: null, decline_reason: null,
    moved: null, three_way: false, desk_signature: null, desk_signed_by: null, desk_signed_at: null,
    updated_at: now,
  }, over || {});
}
const RSM_DAR_ = { code: 'R1', name: 'RSM DAR', role: 'RSM', teams: null, tabs: ['transfers'], readOnly: false };

test('transferDecline returns declinedAt/declinedBy/reason, not just ok/id', async () => {
  const d = fakeDb({ transfers: [oneTransfer()] });
  const r = await _FNS.transferDecline(d, RSM_DAR_, { id: 'T1', reason: 'Wrong model' });
  assert.equal(r.ok, true);
  assert.equal(r.declinedBy, 'RSM DAR');
  assert.equal(r.reason, 'Wrong model');
  assert.ok(r.declinedAt, 'a timestamp the drawer can print with clock(), same as transferGet carries');

  // And it matches the row transferGet would show afterwards -- the client's own merge
  // (trMergeDecline_) has nothing to disagree with.
  const row = d._dump('transfers').find(t => t.id === 'T1');
  assert.equal(row.status, 'declined');
  assert.equal(row.declined_by, r.declinedBy);
  assert.equal(row.decline_reason, r.reason);
  assert.equal(Date.parse(row.declined_at), Date.parse(r.declinedAt));
});

/* =========================================================================================
   FIX 12 (team code) -- mint/rotate used to chain a trailing srv('boot') just to learn the
   one code newTeamCode had already handed back. newTeamCode already echoes `team` alongside
   `code` (this test pins that it still does); the page patches BOOT.teams[...].code from the
   two and redraws directly, with no second trip. Nothing here changed server-side.
   ========================================================================================= */
test('newTeamCode echoes team alongside the new code, for the page to patch BOOT.teams with', async () => {
  const d = fakeDb({ teams: [{ team: 'KINONDONI', team_code: 'AB2C3D' }] });
  const r = await _FNS.newTeamCode(d, ADMIN, { team: 'KINONDONI' });
  assert.equal(r.ok, true);
  assert.equal(r.team, 'KINONDONI', 'the page keys BOOT.teams by this field');
  assert.match(r.code, /^[2-9A-HJKMNP-Z]{6}$/);
});
