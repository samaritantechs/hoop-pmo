/* THE SPEED GUARD -- HOOPLOAN's copy of the postgres war.
 *
 *   "we go into postgres war"
 *
 * Every screen must answer what it costs the database, in ROUND TRIPS and in ROWS, and that
 * answer has to be something that FAILS rather than something somebody promised. This file is
 * the promise written down: each portal function and each phone handler has a ceiling, and a
 * change that pushes past it turns `npm test` red before it can be deployed.
 *
 * ROUND TRIPS ARE THE UNIT. Each awaited PostgREST request is one journey from the web server
 * to the database and back; each page a fetchAll issues is one. Rows crossing the wire are the
 * second number, because a filtered read is ONE trip and can still drag a whole table.
 *
 * =========================================================================================
 * THESE ARE THE PRE-FIX BASELINE OF THE POSTGRES-WAR AUDIT (2026-09-20), NOT A TARGET.
 * =========================================================================================
 * Every ceiling below is what the screen MEASURED on this fixture, times one and a half,
 * rounded up. They exist so the numbers cannot get worse while they are being brought down;
 * they will be tightened, screen by screen, as each read is moved into the query. A ceiling
 * that is raised is raised in the SAME commit as the change that needs it, with the reason
 * in the diff -- and the first question is always "can the database do this instead of me?".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
const { _FNS } = await import('../api/portal.js');
const { callApi, _clearSummaryCache } = await import('../api/_lib/call-core.js');

/* Friday 2026-09-18, noon in Dar es Salaam. Pinned so the fixture's "today", "this week" and
   "the newest deck" never drift with the calendar. */
export const NOW = Date.parse('2026-09-18T09:00:00Z');
export const TODAY = '2026-09-18';
const day = i => new Date(Date.parse(TODAY) - i * 86400000).toISOString().slice(0, 10);
const stamp = (i, h = 8) => day(i) + 'T' + String(h).padStart(2, '0') + ':00:00Z';

export const BRANCHES = Array.from({ length: 40 }, (_, i) => 'BRANCH' + String(i + 1).padStart(2, '0'));
const NRSM = 30, NTL = 40, NAGENT = 1000;
const rsmName = i => 'RSM ' + String(i + 1).padStart(2, '0');
const tlName = i => 'LEADER ' + String(i + 1).padStart(2, '0');
const agentName = i => 'AGENT ' + String(i + 1).padStart(4, '0');
const agentPhone = i => '0720' + String(100000 + i).slice(-6);
const rsmPhone = i => '0730' + String(100000 + i).slice(-6);
const tlPhone = i => '0740' + String(100000 + i).slice(-6);
// A customer contact, 12 digits as Watu writes them; pnorm() keeps the last nine.
const contact = i => '25571' + String(1000000 + i).slice(-7);
const imei = i => '35100' + String(1000000000 + i).slice(-10);
const uuid = n => { const h = n.toString(16).padStart(12, '0'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4000-8000-' + h.padStart(12, '0').slice(-12); };
const MODELS = ['SAMSUNG A07-64GB', 'SAMSUNG A06-64GB', 'RIMO-64GB', 'ITEL A100'];
const FU = ['AMETOA AHADI', 'HAPATIKANI', 'ANALIPA LEO', 'SIMU IPO KWA MTU MWINGINE', ''];

/* A deterministic "random": the fixture has to be the same book on every run, or a budget
   that passes on Monday and fails on Tuesday teaches nobody anything. */
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/** A book big enough that reading it carelessly shows up. Deliberately modest per table --
    this is about the SHAPE of the reads, and a shape that is wrong is wrong at any size. */
export function bigBook() {
  const rnd = lcg(7);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const t = {};

  // ---- reference / config ----
  t.teams = BRANCHES.map((b, i) => ({ team: b, team_code: 'TC' + String(i + 1).padStart(2, '0') + 'XY',
    rsm: rsmName(i % NRSM), rsm_no: rsmPhone(i % NRSM), updated_at: stamp(30) }));
  // The shared AGENT sign-in: a team named AGENT whose code every agent uses with their phone.
  t.teams.push({ team: 'AGENT', team_code: 'AGNT77', rsm: null, rsm_no: null, updated_at: stamp(30) });
  t.settings = [
    { key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v100' },
    { key: 'CALL_BRAND', value: 'HOOPLOAN' }, { key: 'CALL_SYNC_SECONDS', value: '300' },
    { key: 'ADVANCE_DEADLINE_DAY', value: '15' }, { key: 'ADVANCE_MAX_PCT', value: '40' },
  ];
  t.roles = [
    { role: 'ADMIN', tabs: ['upload', 'settings'] },
    { role: 'RSM', tabs: ['dashboard', 'customers', 'recovery', 'stock', 'oldstock', 'newstock', 'transfers'] },
    { role: 'CREDIT', tabs: ['dashboard', 'customers', 'reports', 'furep', 'recovery'] },
    { role: 'AGENT', tabs: ['customers', 'stock', 'transfers'] },
    { role: 'STORE', tabs: ['stock', 'newstock', 'oldstock', 'transfers', 'stockappr'] },
    { role: 'HR', tabs: ['leaveappr', 'staff'] },
  ];
  t.hints = Array.from({ length: 20 }, (_, i) => ({ id: uuid(9000 + i), tab: ['dashboard', 'customers', 'calls', 'all'][i % 4],
    message: 'tip ' + i, sw_message: 'kidokezo ' + i }));
  t.announcement = [{ id: true, image_url: null, text: '', is_on: false, updated_at: stamp(10) }];

  // ---- the people: 30 RSMs, 40 team leaders under them, 1,000 agents under those ----
  t.hoop_agents = [];
  for (let i = 0; i < NRSM; i++) t.hoop_agents.push({ phone: rsmPhone(i), name: rsmName(i), role: 'Regional_Manager',
    branch: BRANCHES[i % 40], manager: null, active: true, joined_date: day(400) });
  for (let i = 0; i < NTL; i++) t.hoop_agents.push({ phone: tlPhone(i), name: tlName(i), role: 'Team_Leader',
    branch: BRANCHES[i % 40], manager: rsmName(i % NRSM), active: true, joined_date: day(300) });
  for (let i = 0; i < NAGENT; i++) t.hoop_agents.push({ phone: agentPhone(i), name: agentName(i), role: 'Field_Officer',
    branch: BRANCHES[i % 40], manager: tlName(i % NTL), active: i % 20 !== 0, joined_date: day(200 - (i % 150)),
    national_id: 'NID' + i, kin_name: 'KIN ' + i, kin_phone: '0760' + String(100000 + i).slice(-6), email: null });
  t.hoop_agents.push({ phone: '0700000009', name: 'SIPHO STORE', role: 'Store_Keeper', branch: null, manager: null, active: true });
  // Which agent sold customer i: agents are spread over branches the same way (i % 40), so the
  // seller is always in the customer's own branch.
  const sellerOf = i => agentName((i % 40) + 40 * (Math.floor(i / 40) % 25));

  // ---- the Watu register: 3,000 phones on the book ----
  const NCUST = 3000;
  t.watu_loans = [];
  for (let i = 0; i < NCUST; i++) t.watu_loans.push({ imei: imei(i), client_name: 'CUSTOMER ' + i,
    client_mobile: contact(i), shop: 'Hoop Limited, ' + BRANCHES[i % 40], agent: sellerOf(i), agent_id: 'W' + (i % 1000),
    team: BRANCHES[i % 40], branch: BRANCHES[i % 40], model: pick(MODELS), model_details: 'x',
    disbursed_date: day(3 + (i % 60)), price: 450000, has_ever_paid: i % 3 !== 0, days_offline: i % 30,
    onboarding_min: 5, app_signed_up: true, locked4: i % 30 >= 4, locked7: i % 30 >= 7,
    guarantor_name: 'GUARANTOR ' + i, guarantor_phone: '0750' + String(100000 + i).slice(-6),
    snapshot_date: TODAY, upload_batch: uuid(1), updated_at: stamp(0) });

  // ---- 7 days of Watu lists, ~2,860 phones each = 20,020 snapshot rows ----
  t.watu_snapshots = [];
  let sn = 0;
  for (let d = 6; d >= 0; d--) {
    for (let i = 0; i < 2860; i++) {
      const off = Math.max(0, (i % 30) - (6 - d) + (i % 7 === 0 ? 3 : 0));
      t.watu_snapshots.push({ id: uuid(100000 + sn++), imei: imei(i), client_name: 'CUSTOMER ' + i,
        client_mobile: contact(i), shop: 'Hoop Limited, ' + BRANCHES[i % 40], agent: sellerOf(i), agent_id: 'W' + (i % 1000),
        team: BRANCHES[i % 40], model: MODELS[i % 4], model_details: 'x', disbursed_date: day(3 + (i % 60)), price: 450000,
        has_ever_paid: (i + d) % 3 !== 0, days_offline: off, onboarding_min: 5, app_signed_up: true,
        locked4: off >= 4, locked7: off >= 7, snapshot_date: day(d), upload_batch: uuid(10 + d), created_at: stamp(d, 6) });
    }
  }

  // ---- the deck the phones read: 3,000 rows on the newest deck_date ----
  t.followup_status = [];
  for (let i = 0; i < NCUST; i++) {
    const off = i % 30;
    t.followup_status.push({ imei: imei(i), team: BRANCHES[i % 40], client_name: 'CUSTOMER ' + i, contact: contact(i),
      model: MODELS[i % 4], price: 450000, disbursed_date: day(3 + (i % 60)), lifetime_day: 3 + (i % 60),
      days_offline: off, locked4: off >= 4, locked7: off >= 7, has_ever_paid: i % 3 !== 0,
      fu_status: FU[i % 5] || null, promise_date: i % 5 === 0 ? day(i % 9) : null, promise_amt: i % 5 === 0 ? 20000 : null,
      last_comment: i % 5 === 4 ? null : 'note', comment_by: 'CREDIT ' + String(1 + (i % 40)).padStart(2, '0'),
      comment_at: stamp(i % 7), deck_date: TODAY, updated_at: stamp(0, 6) });
  }

  // ---- two months of follow-up history: 20,000 comments ----
  t.followup_comments = [];
  for (let i = 0; i < 20000; i++) {
    const c = i % NCUST;
    t.followup_comments.push({ id: uuid(200000 + i), imei: imei(c), team: BRANCHES[c % 40], client_name: 'CUSTOMER ' + c,
      comment: 'follow-up note ' + i, fu_status: FU[i % 4], promise_date: i % 4 === 0 ? day(i % 9) : null,
      promise_amt: i % 4 === 0 ? 20000 : null, new_number: i % 50 === 0 ? '0771' + String(100000 + i).slice(-6) : null,
      created_by: 'CREDIT ' + String(1 + (i % 40)).padStart(2, '0'), created_at: stamp(i % 60, 7 + (i % 10)),
      upload_date: null, upload_batch: null });
  }

  // ---- the credit desk on the phones: 40 officers, one handset each, plus the fenced two ----
  t.call_users = [];
  for (let i = 1; i <= 40; i++) t.call_users.push({ user_id: 'U' + i, name: 'CREDIT ' + String(i).padStart(2, '0'),
    team: BRANCHES[(i - 1) % 40], role: 'OFFICER', is_leader: false, leader_teams: null, device_id: 'DEV' + i,
    phone: '0712' + String(100000 + i).slice(-6), active: true, registered_at: stamp(30), last_sync: stamp(0, 5), last_ts: NOW - 3600000 });
  // The one-branch RSM, signed in on their access code: a leader handset scoped to their branch.
  t.call_users.push({ user_id: 'UR1', name: rsmName(0), team: BRANCHES[0], role: 'RSM', is_leader: true, leader_teams: [BRANCHES[0]],
    device_id: 'DEVR1', phone: rsmPhone(0), active: true, registered_at: stamp(30) });
  t.call_users.push({ user_id: 'UR2', name: rsmName(1), team: BRANCHES[1], role: 'RSM', is_leader: true, leader_teams: [BRANCHES[1]],
    device_id: 'DEVR2', phone: rsmPhone(1), active: true, registered_at: stamp(30) });
  // Two agents on the shared AGENT code: the phone is the identity.
  t.call_users.push({ user_id: 'UA1', name: agentName(0), team: BRANCHES[0], role: 'AGENT', is_leader: false, leader_teams: null,
    device_id: 'DEVA1', phone: agentPhone(0), active: true, registered_at: stamp(30) });
  t.call_users.push({ user_id: 'UA2', name: agentName(1), team: BRANCHES[1], role: 'AGENT', is_leader: false, leader_teams: null,
    device_id: 'DEVA2', phone: agentPhone(1), active: true, registered_at: stamp(30) });

  // ---- a week of calls: 3,000 rows, today-heavy ----
  t.call_logs = [];
  for (let i = 0; i < 3000; i++) {
    const d = i % 10 < 4 ? 0 : (i % 7);
    const u = 1 + (i % 40);
    t.call_logs.push({ id: 'C' + i, user_id: 'U' + u, officer: 'CREDIT ' + String(u).padStart(2, '0'), team: BRANCHES[(u - 1) % 40],
      phone: String(contact(i % NCUST)).slice(3), direction: 'OUT', call_date: day(d), call_time: '09:' + String(i % 60).padStart(2, '0'),
      duration: 20 + (i % 90), portfolio: i % 4 !== 3, match_type: i % 4 !== 3 ? 'CUSTOMER' : null,
      ref: i % 4 !== 3 ? imei(i % NCUST) : null, customer: i % 4 !== 3 ? 'CUSTOMER ' + (i % NCUST) : null,
      synced_at: stamp(d, 10), outcome: ['CONNECTED', 'CONNECTED', 'MISSED', 'REJECTED'][i % 4], category: null });
  }

  // ---- the portal's people: an ADMIN, the one-branch RSM, a credit officer, an agent, and a few hundred staff codes ----
  t.access_codes = [
    { code: 'A1', name: 'PETER ADMIN', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'], suspend_from: null, suspend_to: null },
    { code: 'R1', name: rsmName(0), role: 'RSM', teams: [BRANCHES[0]], tabs: [], suspend_from: null, suspend_to: null },
    { code: 'C1', name: 'CREDIT 01', role: 'CREDIT', teams: [BRANCHES[0]], tabs: [], suspend_from: null, suspend_to: null },
    { code: 'G1', name: agentName(0), role: 'AGENT', teams: null, tabs: [], suspend_from: null, suspend_to: null },
    { code: 'S1', name: 'SIPHO STORE', role: 'STORE', teams: null, tabs: [], suspend_from: null, suspend_to: null },
    { code: 'H1', name: 'HR DESK', role: 'HR', teams: null, tabs: [], suspend_from: null, suspend_to: null },
  ];
  for (let i = 1; i < NRSM; i++) t.access_codes.push({ code: 'R' + (i + 1), name: rsmName(i), role: 'RSM', teams: [BRANCHES[i % 40]], tabs: [], suspend_from: null, suspend_to: null });
  for (let i = 1; i < 300; i++) t.access_codes.push({ code: 'G' + (i + 1), name: agentName(i), role: 'AGENT', teams: null, tabs: [], suspend_from: null, suspend_to: null });
  for (let i = 1; i < 40; i++) t.access_codes.push({ code: 'C' + (i + 1), name: 'CREDIT ' + String(i + 1).padStart(2, '0'), role: 'CREDIT', teams: [BRANCHES[i]], tabs: [], suspend_from: null, suspend_to: null });

  // ---- Hoop's own sales: 2,000 receipts over two months, 1,500 of them on the register ----
  t.hoop_sales = [];
  for (let i = 0; i < 2000; i++) t.hoop_sales.push({ sale_key: 'S' + i, sale_date: day(i % 60), branch: BRANCHES[i % 40],
    agent: sellerOf(i).toUpperCase(), client_name: 'CUSTOMER ' + i, client_id: 'ID' + i, client_phone: contact(i),
    model: MODELS[i % 4], receipt_number: String(9000 + i), imei: i < 1500 ? imei(i) : imei(100000 + i),
    commission_agent: sellerOf(i), commission_phone: agentPhone((i % 40) + 40 * (Math.floor(i / 40) % 25)),
    price: 503000, upload_batch: uuid(5), recorded_by: 'SIPHO STORE', uploaded_by: 'SIPHO STORE', updated_at: stamp(i % 60) });

  // ---- the lock register: 2,000 enrolled handsets ----
  t.devices = [];
  for (let i = 0; i < 2000; i++) {
    const holder = i % 10 === 0 ? 'SIPHO STORE' : (i % 10 === 1 ? rsmName(i % NRSM) : agentName(i % NAGENT));
    const sold = i % 5 === 0;
    t.devices.push({ imei: imei(i), enrolled_at: stamp(20 + (i % 30)), enrolled_by: 'SIPHO STORE', enrol_batch: uuid(3),
      item: MODELS[i % 4], holder, state: sold ? 'released' : (i % 3 === 0 ? 'enrolled' : 'locked'),
      state_reason: 'stock', state_by: 'SIPHO STORE', state_at: stamp(i % 20), reported: i % 3 === 0 ? 'unlocked' : 'locked',
      last_seen: stamp(i % 4, 7), app_version: '1.0.2', battery: 50 + (i % 50), android: '13',
      sold_ref: sold ? 'S' + i : null, customer: sold ? 'CUSTOMER ' + i : null, released_at: sold ? stamp(i % 20) : null,
      enrol_token: 'tok' + i, reported_imei: imei(i), fcm_token: null, last_lat: null, last_lng: null, last_loc_acc: null,
      last_loc_at: null, enrol_batch_at: stamp(20), shift_server: null, shift_batch: null, shift_at: null, frp: null, updated_at: stamp(i % 4) });
  }
  t.device_events = Array.from({ length: 500 }, (_, i) => ({ id: uuid(300000 + i), imei: imei(i), event: i % 2 ? 'locked' : 'enrolled',
    from_state: 'enrolled', to_state: 'locked', reason: 'stock', actor: 'SIPHO STORE', at: stamp(i % 30) }));
  t.device_tokens = Array.from({ length: 50 }, (_, i) => ({ imei: imei(i), enrol_token: 'old' + i, retired_at: stamp(40), retired_by: 'SIPHO STORE' }));

  // ---- the old list: 1,500 handsets never enrolled ----
  t.old_stock = [];
  for (let i = 0; i < 1500; i++) t.old_stock.push({ imei: imei(50000 + i), item: MODELS[i % 4], agent: agentName(i % NAGENT),
    agent_phone: agentPhone(i % NAGENT), rsm: rsmName(i % NRSM), rsm_phone: rsmPhone(i % NRSM), age_days: 30 + (i % 200),
    as_of: day(8), source: 'SIPHO-SEPT', location: null, location_from: null, added_at: stamp(8), updated_at: stamp(8) });
  t.hoop_aged_stock = Array.from({ length: 300 }, (_, i) => ({ serial: imei(50000 + i), agent: agentName(i % NAGENT), item: MODELS[i % 4],
    received: day(60), age_days: 60, as_of: day(8), updated_at: stamp(8) }));
  t.stock_audit = Array.from({ length: 500 }, (_, i) => ({ imei: imei(i), rsm: rsmName(i % NRSM), rsm_phone: rsmPhone(i % NRSM),
    agent: sellerOf(i), agent_phone: agentPhone(i % NAGENT), customer: 'CUSTOMER ' + i, customer_phone: contact(i), price: 450000,
    guarantor: 'GUARANTOR ' + i, guarantor_phone: '0750' + String(100000 + i).slice(-6), branch: BRANCHES[i % 40], model: MODELS[i % 4],
    sale_date: day(3 + (i % 60)), src: {}, first_at: stamp(3), stamped_at: stamp(3) }));

  // ---- the office: a few hundred rows in every smaller table ----
  const status3 = ['pending', 'approved', 'rejected'];
  const staffOf = i => ({ staff_code: 'G' + (1 + (i % 300)), staff_name: agentName(i % 300), staff_role: 'AGENT' });
  t.staff_advances = Array.from({ length: 300 }, (_, i) => ({ id: uuid(400000 + i), requested_at: stamp(i % 90), ...staffOf(i),
    apply_date: day(i % 90), amount: 100000, status: ['pending', 'approved', 'declined'][i % 3], approved_amount: i % 3 === 1 ? 100000 : null,
    comment: null, decided_by: i % 3 ? 'PETER ADMIN' : null, decided_at: i % 3 ? stamp(i % 90) : null, bank_name: 'CRDB', account_no: '0123',
    late: false, salary_at_request: 500000, cap_amount: 200000, paid_at: null, paid_by: null, payment_ref: null, deducted_at: null,
    deducted_by: null, deduct_period: null, updated_at: stamp(i % 90) }));
  t.staff_salaries = Array.from({ length: 100 }, (_, i) => ({ staff_code: 'G' + (i + 1), staff_name: agentName(i), monthly_salary: 500000,
    updated_by: 'HR DESK', updated_at: stamp(100) }));
  t.imprest_roles = [{ role: 'CREDIT', accommodation_per_day: 40000 }, { role: 'RSM', accommodation_per_day: 70000 },
    { role: 'AGENT', accommodation_per_day: 30000 }, { role: 'STORE', accommodation_per_day: 40000 }];
  t.imprest_requests = Array.from({ length: 300 }, (_, i) => ({ id: uuid(500000 + i), requested_at: stamp(i % 90), ...staffOf(i),
    full_name: agentName(i % 300), mobile: agentPhone(i % 300), email: null, imprest_role: 'AGENT', pay_mode: 'MPESA', account_no: '0712',
    travel_date: day((i % 90) - 3), destination: 'Morogoro', fare_trips: 2, fare_per_trip: 15000, fare_amount: 30000, accom_days: 3,
    accom_rate: 30000, accom_amount: 90000, other1_desc: null, other1_amount: 0, other2_amount: 0, other3_amount: 0, total_amount: 120000,
    purpose: 'Wateja', status: status3[i % 3], approved_amount: i % 3 === 1 ? 120000 : null, comment: null,
    decided_by: i % 3 ? 'PETER ADMIN' : null, decided_at: i % 3 ? stamp(i % 90) : null, retired_at: null, retire_total: null,
    retire_balance: null, updated_at: stamp(i % 90) }));
  t.imprest_retirements = Array.from({ length: 100 }, (_, i) => ({ id: uuid(510000 + i), request_id: uuid(500000 + 3 * i + 1),
    filed_at: stamp(i % 60), filed_by_code: 'G' + (1 + (i % 300)), filed_by_name: agentName(i % 300), fare_actual: 30000,
    accom_actual: 90000, other1_actual: 0, other2_actual: 0, other3_actual: 0, total_actual: 120000, notes: null, photo_count: 0 }));
  t.imprest_photos = [];
  t.leave_requests = Array.from({ length: 300 }, (_, i) => ({ id: uuid(520000 + i), requested_at: stamp(i % 90), ...staffOf(i),
    employee_id: 'E' + i, department: 'SALES', supervisor: rsmName(i % NRSM), leave_type: 'annual', other_type: null,
    from_date: day((i % 90) - 10), to_date: day((i % 90) - 15), working_days: 5, resume_date: day((i % 90) - 16), reason: 'rest',
    contact: agentPhone(i % 300), handed_to: null, declared: true, short_notice: false, status: status3[i % 3], comment: null,
    decided_by: i % 3 ? 'HR DESK' : null, decided_at: i % 3 ? stamp(i % 90) : null, updated_at: stamp(i % 90) }));
  t.issues = Array.from({ length: 300 }, (_, i) => ({ id: uuid(530000 + i), raised_at: stamp(i % 90), ...staffOf(i),
    department: ['STORE', 'FINANCE', 'IT', 'HR', 'CREDIT', 'SALES'][i % 6], kind: ['issue', 'complaint', 'document'][i % 3],
    subject_type: i % 2 ? 'imei' : 'agent', subject: i % 2 ? imei(i) : agentName(i % 300), title: 'issue ' + i, details: 'x',
    contact: null, verified: false, referred_to: null, external_ref: null, status: ['open', 'waiting', 'resolved'][i % 3],
    assigned_to: null, resolution: null, escalated_by: null, escalated_at: null, resolved_by: null, resolved_at: null,
    to_role: null, to_name: null, updated_by: null, updated_at: stamp(i % 90) }));
  t.issue_notes = Array.from({ length: 300 }, (_, i) => ({ id: uuid(540000 + i), issue_id: uuid(530000 + (i % 300)), at: stamp(i % 90),
    by_code: 'A1', by_name: 'PETER ADMIN', note: 'note ' + i, change: null }));
  t.topups = Array.from({ length: 300 }, (_, i) => ({ id: uuid(550000 + i), requested_at: stamp(i % 90), ...staffOf(i),
    imei: imei(i), customer: 'CUSTOMER ' + i, customer_phone: contact(i), payer_name: 'PAYER', paid_amount: 50000, proof_ref: 'M' + i,
    price: 450000, balance: 400000, status: ['requested', 'verified', 'paid', 'unlocked'][i % 4], comment: null, verified_by: null,
    verified_at: null, paid_by: null, paid_at: null, payment_ref: null, unlocked_by: null, unlocked_at: null, chk_request: false,
    chk_paid_to: false, chk_watu: false, chk_auditor: false, updated_by: null, updated_at: stamp(i % 90) }));
  t.loss_cases = Array.from({ length: 200 }, (_, i) => ({ id: uuid(560000 + i), opened_at: stamp(i % 90), ...staffOf(i),
    custodian: agentName(i % 300), imei: imei(i), item: MODELS[i % 4], cause: ['negligence', 'incident', 'theft'][i % 3],
    police_ref: null, details: 'x', value_amount: 450000, value_source: 'price list', recovery_method: null, recovery_note: null,
    approved_by: null, approved_at: null, acknowledged_by: null, acknowledged_at: null,
    status: ['open', 'valued', 'recovering', 'settled'][i % 4], recovered: 0, settled_at: null, updated_by: null, updated_at: stamp(i % 90) }));
  t.loss_case_notes = Array.from({ length: 200 }, (_, i) => ({ id: uuid(570000 + i), case_id: uuid(560000 + (i % 200)), at: stamp(i % 90),
    by_code: 'A1', by_name: 'PETER ADMIN', note: 'n', change: null }));
  t.device_prices = MODELS.map(m => ({ item: m, amount: 450000, note: null, updated_by: 'PETER ADMIN', updated_at: stamp(100) }));
  t.stock_requests = Array.from({ length: 300 }, (_, i) => ({ id: uuid(580000 + i), requested_at: stamp(i % 90), ...staffOf(i),
    holder: agentName(i % 300), destination: BRANCHES[i % 40], item: MODELS[i % 4], qty: 5, reason: 'sales', aging_count: 2,
    aging_oldest_days: 40, aging_as_of: day(8), status: ['pending', 'approved', 'rejected', 'issued'][i % 4], approved_qty: i % 4 ? 5 : null,
    comment: null, decided_by: i % 4 ? 'SIPHO STORE' : null, decided_at: i % 4 ? stamp(i % 90) : null, aging_override: false,
    aging_override_reason: null, issued_at: i % 4 === 3 ? stamp(i % 90) : null, issued_by: i % 4 === 3 ? 'SIPHO STORE' : null,
    updated_by: null, updated_at: stamp(i % 90) }));
  t.stock_handovers = Array.from({ length: 75 }, (_, i) => ({ id: uuid(590000 + i), request_id: uuid(580000 + 4 * i + 3), at: stamp(i % 60),
    by_code: 'S1', by_name: 'SIPHO STORE', note_no: 'N' + i, counted_jointly: true, received_by: agentName(i), condition_note: null,
    courier: null, docs_complete: true, qty: 5 }));
  t.stock_handover_items = Array.from({ length: 375 }, (_, i) => ({ id: uuid(600000 + i), handover_id: uuid(590000 + (i % 75)),
    imei: imei(50000 + i), condition: 'new' }));
  t.stock_handover_photos = [];
  t.sales_targets = [];
  for (const period of ['2026-08', '2026-09']) {
    t.sales_targets.push({ id: uuid(610000 + t.sales_targets.length), period, scope: 'company', name: 'HOOP', target_qty: 2000, target_amount: null, note: null, set_by: 'PETER ADMIN', set_at: stamp(30), updated_at: stamp(30) });
    for (let i = 0; i < NRSM; i++) t.sales_targets.push({ id: uuid(610000 + t.sales_targets.length), period, scope: 'rsm', name: rsmName(i), target_qty: 60, target_amount: null, note: null, set_by: 'PETER ADMIN', set_at: stamp(30), updated_at: stamp(30) });
    for (let i = 0; i < 80; i++) t.sales_targets.push({ id: uuid(610000 + t.sales_targets.length), period, scope: 'agent', name: agentName(i), target_qty: 10, target_amount: null, note: null, set_by: 'PETER ADMIN', set_at: stamp(30), updated_at: stamp(30) });
  }
  t.commission_rates = [{ id: uuid(620000), role: 'AGENT', item: 'SAMSUNG A07-64GB', amount: 75000, updated_by: 'PETER ADMIN', updated_at: stamp(100) },
    { id: uuid(620001), role: 'RSM', item: 'SAMSUNG A07-64GB', amount: 30000, updated_by: 'PETER ADMIN', updated_at: stamp(100) }];
  t.commission_runs = Array.from({ length: 12 }, (_, i) => ({ id: uuid(630000 + i), period: '2026-' + String(1 + (i % 9)).padStart(2, '0'),
    kind: i < 9 ? 'monthly' : 'daily', status: ['paid', 'approved', 'draft'][i % 3], created_at: stamp(30 * (9 - (i % 9))), created_by: 'PETER ADMIN',
    built_at: stamp(30), approved_by: null, approved_at: null, comment: null, paid_by: null, paid_at: null, payment_ref: null, cleared_at: null,
    chk_unpaid_list: false, chk_watu_verified: false, chk_advance_topups: false, chk_voucher: false, chk_bank_statement: false,
    total_qty: 300, total_amount: 22500000, disqualified: 0, updated_at: stamp(30) }));
  t.commission_lines = Array.from({ length: 300 }, (_, i) => ({ id: uuid(640000 + i), run_id: uuid(630000 + (i % 12)), agent: agentName(i),
    agent_phone: agentPhone(i), rsm: rsmName(i % NRSM), role: 'AGENT', qty: 3, amount: 225000, disqualified: 0, note: null }));
  t.transfers = Array.from({ length: 200 }, (_, i) => ({ id: uuid(650000 + i), ref: 'TR-' + (1000 + i), created_at: stamp(i % 60), created_by: 'S1',
    from_name: i % 2 ? 'SIPHO STORE' : rsmName(i % NRSM), from_phone: null, to_name: i % 2 ? rsmName(i % NRSM) : agentName(i % 300), to_phone: null,
    note: null, item_count: 1, total_qty: 2, total_amount: 900000, sender_signature: 'sig', sender_signed_by: 'SIPHO STORE', sender_signed_at: stamp(i % 60),
    receiver_signature: i % 3 ? 'sig' : null, receiver_signed_by: i % 3 ? rsmName(i % NRSM) : null, receiver_signed_at: i % 3 ? stamp(i % 60) : null,
    status: ['accepted', 'sent', 'declined'][i % 3], from_role: 'STORE', to_role: 'RSM', accepted_at: null, accepted_by: null, declined_at: null,
    declined_by: null, decline_reason: null, moved: i % 3 === 0 ? 2 : null, three_way: false, desk_signature: null, desk_signed_by: null,
    desk_signed_at: null, updated_at: stamp(i % 60) }));
  t.transfer_items = Array.from({ length: 400 }, (_, i) => ({ id: uuid(660000 + i), transfer_id: uuid(650000 + (i % 200)), imei: imei(i),
    item: MODELS[i % 4], qty: 1, price: 450000, source: 'devices', prev_holder: 'SIPHO STORE' }));
  t.signin_attempts = Array.from({ length: 500 }, (_, i) => ({ id: uuid(670000 + i), at: stamp(i % 14, 6 + (i % 12)), day: day(i % 14),
    door: ['portal', 'app', 'upload'][i % 3], ok: i % 5 !== 0, outcome: i % 5 ? 'ok' : 'invalid', code_key: 'k' + (i % 50), code_masked: 'A**',
    phone_masked: null, device: 'DEV' + (i % 40), who_name: 'CREDIT ' + String(1 + (i % 40)).padStart(2, '0'), who_role: 'OFFICER', detail: null,
    ip: '10.0.0.' + (i % 250), ua: 'test', reviewed_by: null, reviewed_at: null, review_note: null }));
  t.audit_log = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, at: stamp(i % 30, 6 + (i % 12)), actor_code: 'A1', actor_name: 'PETER ADMIN',
    actor_role: 'ADMIN', action: ['settingSet', 'deviceSetState', 'saveAccessCode'][i % 3], ref: null, team: null, subject: 'x', ok: true,
    error: null, ms: 40, ip: null, ua: null, before: null, after: null }));
  t.it_reports = Array.from({ length: 10 }, (_, i) => ({ id: uuid(680000 + i), week_from: day(7 * (i + 1) + 4), week_to: day(7 * i + 5),
    sent_at: stamp(7 * i + 4), sent_by: 'PETER ADMIN', sent_to: 'it@hoop', summary: 'ok' }));
  return t;
}

/** Counts every request the code sends, exactly as fetchAll issues them: one trip per awaited
    builder, rows counted where they are answered. An RPC goes through the same wrapper. */
export function counting(tables, opts) {
  const db0 = fakeDb(tables, opts);
  let trips = 0, rows = 0;
  const wrap = q => new Proxy(q, { get(o, p) {
    if (p === 'then') return (res, rej) => o.then(r => {
      trips++; if (Array.isArray(r.data)) rows += r.data.length; return res(r);
    }, rej);
    const v = o[p];
    return typeof v === 'function' ? (...a) => { const out = v.apply(o, a); return out === o ? wrap(o) : out; } : v;
  } });
  return { db: { from: n => wrap(db0.from(n)),
                 rpc: (n, a) => wrap(db0.rpc(n, a)),
                 _dump: n => db0._dump(n) },
           stat: () => ({ trips, rows }) };
}

/* Every pane, so requireNav never decides a measurement -- the fences and the team scope do. */
const ALL_NAVS = ['dashboard', 'customers', 'reports', 'furep', 'recovery', 'fraud', 'scorecards', 'stock', 'movement', 'transfers',
  'stockreq', 'stockappr', 'stockrep', 'newstock', 'oldstock', 'targets', 'commission', 'commappr', 'lossreq', 'loss', 'topupreq',
  'topups', 'devlock', 'devunlock', 'advreq', 'advappr', 'advrep', 'impreq', 'impappr', 'imprep', 'leavereq', 'leaveappr', 'leaverep',
  'issuereq', 'issues', 'issuerep', 'enrol', 'security', 'itrep', 'audit', 'staff', 'codes', 'settings'];
export const ADMIN = { code: 'A1', name: 'PETER ADMIN', role: 'ADMIN', teams: null, tabs: ['upload', 'settings'], readOnly: false };
/* One branch of forty, and the credit fence on top of it: their own name and everyone under
   them on the staff register. */
export const RSM_ONE = { code: 'R1', name: 'RSM 01', role: 'RSM', teams: [BRANCHES[0]], tabs: ALL_NAVS.slice(), readOnly: false };
export const CREDIT = { code: 'C1', name: 'CREDIT 01', role: 'CREDIT', teams: [BRANCHES[0]], tabs: ALL_NAVS.slice(), readOnly: false };
export const AGENT = { code: 'G1', name: 'AGENT 0001', role: 'AGENT', teams: null, tabs: ALL_NAVS.slice(), readOnly: false };

/* Built ONCE. fakeDb copies every row it is handed, so each counting() below is a fresh
   database over the same book, and building the book (the slow part) is paid once per run. */
const BOOK = bigBook();
const IMEI0 = '351001000000000';
const uid = n => { const h = n.toString(16).padStart(12, '0'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4000-8000-' + h.padStart(12, '0').slice(-12); };

test('speed: the fixture is the book it claims to be', () => {
  assert.equal(BOOK.teams.length, 41);
  assert.ok(BOOK.hoop_agents.length > 1000);
  assert.ok(BOOK.watu_snapshots.length >= 20000);
  assert.equal(BOOK.followup_status.length, 3000);
  assert.equal(BOOK.followup_comments.length, 20000);
  assert.equal(BOOK.devices.length, 2000);
  assert.equal(BOOK.old_stock.length, 1500);
  assert.equal(BOOK.hoop_sales.length, 2000);
});

test('speed: counting() sees every trip and every row', async () => {
  const c = counting(BOOK);
  await _FNS.hints(c.db, ADMIN, {});
  const { trips, rows } = c.stat();
  assert.equal(trips, 2, 'hints is two reads: the tips and two settings');
  assert.equal(rows, 20, 'twenty tips, no matching settings');
});

/* =====================================================================================
   EVERY PORTAL SCREEN, BOTH WAYS: as the ADMIN who holds every branch and as an RSM who
   holds ONE branch of forty (and whose credit fence narrows further, to their own agents).
   =====================================================================================
   screen, portal function, args, who, TRIPS, ROWS -- measured on 2026-09-20 with the
   postgres-war sweep (scratch: pgwar-sweep.mjs), then x1.5 rounded up. The measured figure
   is beside each row so the slack is visible. Every one of these is a CEILING to bring down.

   WHAT THE NUMBERS ALREADY SAY, so nobody has to re-derive it:

     THE FENCE IS A DOWNLOAD. Wherever the RSM reads MORE than the admin (the bell: 40 rows
     for the admin, 6,111 for the RSM; salesWeek 101 vs 6,097), the extra is agentIndex --
     the whole watu_loans register, the staff register and the sales report (3,000 + 1,071 +
     2,000 rows) read so that the rows can be fenced in JavaScript by seller name. It is
     cached per database client for fifteen minutes, so in the field it is paid once per
     instance per quarter hour, not once per screen -- but it is still a company-sized read
     to answer a one-person question.

     THE STOCK PANES DO NOT SCOPE AT ALL. stockMine / stockQueue / stockReqReport / transferStock
     / stockMovement / staffDirectory / transferUsers read the identical 4,000-12,000 rows for
     the RSM as for the admin: the whole devices register and the whole old-stock list, then
     a filter here. See the tell at the bottom of this file.

     oldStock IS FIFTY-SIX TRIPS and newStock TWENTY-FIVE, for one click each. */
const BUDGETS = [
  // ---- the dashboard, the bell, and the credit panes ----
  ['Tips',                    'hints',          {}, ADMIN,     3,     30],   // measured 2 / 20
  ['Tips (RSM)',              'hints',          {}, RSM_ONE,   3,     30],   // measured 2 / 20
  ['The bell',                'notifications',  {}, ADMIN,     3,     60],   // measured 2 / 40
  ['The bell (RSM)',          'notifications',  {}, RSM_ONE,  11,   9167],   // measured 7 / 6111 -- the fence reads the register
  ['Dashboard (boot)',        'boot',           {}, ADMIN,    17,  39095],   // measured 11 / 26063 -- the whole week of snapshots
  ['Dashboard (boot, RSM)',   'boot',           {}, RSM_ONE,  24,  43814],   // measured 16 / 29209 -- MORE than the admin: the week of snapshots, then the fence's register on top
  ['Locked trend',            'lockedTrend',    {}, ADMIN,     3,  13848],   // measured 2 / 9232
  ['Locked trend (RSM)',      'lockedTrend',    {}, RSM_ONE,  11,   9378],   // measured 7 / 6252
  ['Locked trend (a week)',   'lockedTrend',    { week: '2026-09-07' }, ADMIN,   2,  6545],   // measured 1 / 4363
  ['Locked trend (a week, RSM)', 'lockedTrend', { week: '2026-09-07' }, RSM_ONE, 9,  9251],   // measured 6 / 6167
  ['Recovery week',           'recoveryWeek',   {}, ADMIN,     8,  21518],   // measured 5 / 14345
  ['Recovery week (RSM)',     'recoveryWeek',   {}, RSM_ONE,  14,   9714],   // measured 9 / 6476
  ['Recovery day list',       'recoveryDayList', { date: TODAY }, ADMIN,  14, 13463],   // measured 9 / 8975
  ['Recovery day list (RSM)', 'recoveryDayList', { date: TODAY }, RSM_ONE, 21, 18387],   // measured 14 / 12258
  ['Recovery',                'recovery',       {}, ADMIN,    15,  17690],   // measured 10 / 11793
  ['Recovery (RSM)',          'recovery',       {}, RSM_ONE,  17,   9326],   // measured 11 / 6217
  ['Calls report',            'report',         {}, ADMIN,    15,  15515],   // measured 10 / 10343
  ['Calls report (RSM)',      'report',         {}, RSM_ONE,  15,  11513],   // measured 10 / 7675
  ['Calls report (a week)',   'report',         { from: '2026-09-11', to: TODAY }, ADMIN,   15, 15900],   // measured 10 / 10600
  ['Calls report (a week, RSM)', 'report',      { from: '2026-09-11', to: TODAY }, RSM_ONE, 15, 11513],   // measured 10 / 7675
  ['Follow-up outcomes',      'fuOutcomes',     {}, ADMIN,     6,   4502],   // measured 4 / 3001
  ['Follow-up outcomes (RSM)', 'fuOutcomes',    {}, RSM_ONE,  14,   9221],   // measured 9 / 6147
  ['Sales week',              'salesWeek',      {}, ADMIN,     5,    152],   // measured 3 / 101
  ['Sales week (RSM)',        'salesWeek',      {}, RSM_ONE,  12,   9146],   // measured 8 / 6097
  ['Sales week (a week)',     'salesWeek',      { week: '2026-09-07' }, ADMIN,    3,   525],   // measured 2 / 350
  ['Sales week (a week, RSM)', 'salesWeek',     { week: '2026-09-07' }, RSM_ONE, 11,  9107],   // measured 7 / 6071
  ['Customers (Wateja)',      'customers',      {}, ADMIN,    20,  22466],   // measured 13 / 14977
  ['Customers (Wateja, RSM)', 'customers',      {}, RSM_ONE,  27,  18615],   // measured 18 / 12410
  ['One customer\'s comments', 'customerComments', { imei: IMEI0 }, ADMIN,   2, 11],   // measured 1 / 7
  ['One customer\'s comments (RSM)', 'customerComments', { imei: IMEI0 }, RSM_ONE, 2, 11],   // measured 1 / 7
  ['Customer search',         'customerSearch', { q: 'CUSTOMER 7' }, ADMIN,   2, 45],   // measured 1 / 30
  ['Customer search (RSM)',   'customerSearch', { q: 'CUSTOMER 7' }, RSM_ONE, 2,  3],   // measured 1 / 2
  ['Global search',           'globalSearch',   { q: 'CUSTOMER 7' }, ADMIN,   6, 45],   // measured 4 / 30
  ['Global search (RSM)',     'globalSearch',   { q: 'CUSTOMER 7' }, RSM_ONE, 6,  3],   // measured 4 / 2
  // ---- sales: the fraud audit and the scorecards ----
  ['Fraud audit',             'salesAudit',     {}, ADMIN,     5,   7572],   // measured 3 / 5048
  ['Fraud audit (RSM)',       'salesAudit',     {}, RSM_ONE,  12,  16679],   // measured 8 / 11119
  ['Fraud audit (a month)',   'salesAudit',     { from: '2026-08-20', to: TODAY }, ADMIN,    5,  7622],   // measured 3 / 5081
  ['Fraud audit (a month, RSM)', 'salesAudit',  { from: '2026-08-20', to: TODAY }, RSM_ONE, 12, 16728],   // measured 8 / 11152
  ['Agent scorecards',        'agentScore',     {}, ADMIN,     6,   9107],   // measured 4 / 6071
  ['Agent scorecards (RSM)',  'agentScore',     {}, RSM_ONE,  14,  13826],   // measured 9 / 9217
  ['Targets',                 'targetsView',    {}, ADMIN,     5,   2898],   // measured 3 / 1932
  ['Targets (RSM)',           'targetsView',    {}, RSM_ONE,   5,   1811],   // measured 3 / 1207
  // ---- stock: the register, the old list, the audit, movements and transfers ----
  ['Stock view',              'stockView',      {}, ADMIN,     3,   2057],   // measured 2 / 1371
  ['Stock view (RSM)',        'stockView',      {}, RSM_ONE,   3,   2057],   // measured 2 / 1371 -- same as admin
  ['Stock account',           'stockAccount',   {}, ADMIN,     6,   2058],   // measured 4 / 1372
  ['Stock account (RSM)',     'stockAccount',   {}, RSM_ONE,   6,   2058],   // measured 4 / 1372 -- same as admin
  ['Device list (lock bench)', 'deviceList',    {}, ADMIN,     3,   3000],   // measured 2 / 2000
  ['Device list (RSM)',       'deviceList',     {}, RSM_ONE,   3,   3000],   // measured 2 / 2000 -- same as admin
  ['Device history',          'deviceHistory',  { imei: IMEI0 }, ADMIN,   3, 3],   // measured 2 / 2
  ['Device token',            'deviceToken',    { imei: IMEI0 }, ADMIN,   2, 2],   // measured 1 / 1
  ['Aging sync',              'syncAging',      {}, ADMIN,     6,   3450],   // measured 4 / 2300
  ['Aging sync (RSM)',        'syncAging',      {}, RSM_ONE,   6,   3450],   // measured 4 / 2300 -- same as admin
  ['OLD STOCK',               'oldStock',       {}, ADMIN,    84,  18884],   // measured 56 / 12589 -- FIFTY-SIX trips for one click
  ['OLD STOCK (RSM)',         'oldStock',       {}, RSM_ONE,  86,  20490],   // measured 57 / 13660
  ['Old stock by holder',     'oldStockHolder', {}, ADMIN,    12,  15107],   // measured 8 / 10071
  ['Old stock by holder (RSM)', 'oldStockHolder', {}, RSM_ONE, 14, 16713],   // measured 9 / 11142
  ['Old stock round',         'oldStockRound',  {}, ADMIN,    12,  15107],   // measured 8 / 10071
  ['Old stock round (RSM)',   'oldStockRound',  {}, RSM_ONE,  14,  16713],   // measured 9 / 11142
  ['NEW STOCK',               'newStock',       {}, ADMIN,    38,  19334],   // measured 25 / 12889
  ['NEW STOCK (RSM)',         'newStock',       {}, RSM_ONE,  39,  20940],   // measured 26 / 13960
  ['Price list',              'priceList',      {}, ADMIN,     3,   4506],   // measured 2 / 3004 -- reads 3,000 loans for 4 prices
  ['Price list (RSM)',        'priceList',      {}, RSM_ONE,   3,   4506],   // measured 2 / 3004
  ['Stock requests (mine)',   'stockMine',      {}, ADMIN,    17,  15557],   // measured 11 / 10371 -- "mine" reads the whole register
  ['Stock requests (mine, RSM)', 'stockMine',   {}, RSM_ONE,  17,  15557],   // measured 11 / 10371 -- same as admin
  ['Stock requests (queue)',  'stockQueue',     {}, ADMIN,    17,  16007],   // measured 11 / 10671
  ['Stock requests (queue, RSM)', 'stockQueue', {}, RSM_ONE,  17,  16007],   // measured 11 / 10671 -- same as admin
  ['Stock requests report',   'stockReqReport', {}, ADMIN,    17,  16007],   // measured 11 / 10671
  ['Stock requests report (RSM)', 'stockReqReport', {}, RSM_ONE, 17, 16007],   // measured 11 / 10671 -- same as admin
  ['Stock handover',          'stockHandover',  { id: uid(580003) }, ADMIN,   5,  9],   // measured 3 / 6
  ['Stock photos',            'stockPhotos',    { id: uid(580003) }, ADMIN,   3,  2],   // measured 2 / 1
  ['Stock movement',          'stockMovement',  {}, ADMIN,    11,   9035],   // measured 7 / 6023
  ['Stock movement (RSM)',    'stockMovement',  {}, RSM_ONE,  11,   9035],   // measured 7 / 6023 -- same as admin
  ['Transfer parties',        'transferUsers',  {}, ADMIN,     8,   6560],   // measured 5 / 4373
  ['Transfer parties (RSM)',  'transferUsers',  {}, RSM_ONE,   8,   6560],   // measured 5 / 4373 -- same as admin
  ['Transfer stock window',   'transferStock',  {}, ADMIN,    15,  18107],   // measured 10 / 12071
  ['Transfer stock window (RSM)', 'transferStock', {}, RSM_ONE, 15, 18107],   // measured 10 / 12071 -- "what YOU hold" reads everything
  ['Transfer inbox',          'transferInbox',  {}, ADMIN,     2,    300],   // measured 1 / 200
  ['Transfer list',           'transferList',   {}, ADMIN,     2,    300],   // measured 1 / 200
  ['Transfer document',       'transferGet',    { id: uid(650000) }, ADMIN,   3,  3],   // measured 2 / 2
  // ---- the office: advances, imprest, leave, issues, top-ups, losses, commission ----
  ['Advance (mine)',          'advMine',        {}, ADMIN,     5,      3],   // measured 3 / 2
  ['Advance queue',           'advQueue',       {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Advance report',          'advReport',      {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Salary list',             'salaryList',     {}, ADMIN,     3,    153],   // measured 2 / 102
  ['Imprest rates',           'impRoles',       {}, ADMIN,     6,    575],   // measured 4 / 383
  ['Imprest (mine)',          'impMine',        {}, ADMIN,     8,    575],   // measured 5 / 383
  ['Imprest queue',           'impQueue',       {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Imprest report',          'impReport',      {}, ADMIN,     3,    600],   // measured 2 / 400
  ['Imprest photos',          'impPhotos',      { id: uid(500001) }, ADMIN,   2,  0],   // measured 1 / 0
  ['Leave (mine)',            'leaveMine',      {}, ADMIN,     2,      0],   // measured 1 / 0
  ['Leave queue',             'leaveQueue',     {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Leave report',            'leaveReport',    {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Issue targets',           'issueTargets',   {}, ADMIN,     2,    560],   // measured 1 / 373
  ['Issues (mine)',           'issueMine',      {}, ADMIN,     2,      0],   // measured 1 / 0
  ['Issue queue',             'issueQueue',     {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Issue report',            'issueReport',    {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Issue notes',             'issueNotes',     { id: uid(530000) }, ADMIN,   2,  2],   // measured 1 / 1
  ['Top-ups (mine)',          'topupMine',      {}, ADMIN,     2,      0],   // measured 1 / 0
  ['Top-up queue',            'topupQueue',     {}, ADMIN,     2,    450],   // measured 1 / 300
  ['Loss cases',              'lossList',       {}, ADMIN,     2,    300],   // measured 1 / 200
  ['Loss case notes',         'lossNotes',      { id: uid(560000) }, ADMIN,   2,  2],   // measured 1 / 1
  ['Commission rates',        'commRates',      {}, ADMIN,     5,   6110],   // measured 3 / 4073 -- the rate table reads every agent
  ['Commission rates (RSM)',  'commRates',      {}, RSM_ONE,   5,   6110],   // measured 3 / 4073 -- same as admin
  ['Commission cycles',       'commRuns',       {}, ADMIN,     2,     18],   // measured 1 / 12
  ['Commission sheet',        'commSheet',      { id: uid(630000) }, ADMIN,   3, 39],   // measured 2 / 26
  // ---- people, codes, settings, security ----
  ['Staff directory',         'staffDirectory', {}, ADMIN,     3,   6107],   // measured 2 / 4071
  ['Staff directory (RSM)',   'staffDirectory', {}, RSM_ONE,   3,   6107],   // measured 2 / 4071 -- same as admin
  ['Staff channel (one person)', 'staffChannel', { phone: '0720100000' }, ADMIN, 2, 1607],   // measured 1 / 1071 -- one person, the whole register
  ['Enrolment queue',         'enrolQueue',     {}, ADMIN,     3,   1673],   // measured 2 / 1115
  ['Enrolment queue (RSM)',   'enrolQueue',     {}, RSM_ONE,   3,   1673],   // measured 2 / 1115 -- same as admin
  ['Officers',                'officers',       {}, ADMIN,     2,     66],   // measured 1 / 44
  ['Access codes',            'accessCodes',    {}, ADMIN,     5,    569],   // measured 3 / 379
  ['Settings',                'settings',       {}, ADMIN,     2,      8],   // measured 1 / 5
  ['IT weekly report',        'itWeekly',       {}, ADMIN,    51,   5847],   // measured 34 / 3898 -- THIRTY-FOUR trips
  ['IT weekly report (RSM)',  'itWeekly',       {}, RSM_ONE,  51,   5847],   // measured 34 / 3898 -- same as admin
  ['Sign-in watch',           'signinWatch',    {}, ADMIN,     3,    270],   // measured 2 / 180
  ['Audit log',               'audit',          {}, ADMIN,     6,    344],   // measured 4 / 229
];

for (const [label, fn, args, user, tripBudget, rowBudget] of BUDGETS) {
  test(`speed: ${label} stays within ${tripBudget} trips and ${rowBudget.toLocaleString()} rows`, async () => {
    _clearSummaryCache();
    const c = counting(BOOK);
    await _FNS[fn](c.db, user, args);
    const { trips, rows } = c.stat();
    const advice = `\n  Before raising these numbers: can the database do the work instead?\n` +
      `  Ordering, limiting, filtering and counting all belong there. If the answer is genuinely\n` +
      `  no, raise them in the SAME commit so the cost is visible in the diff.`;
    assert.ok(trips <= tripBudget,
      `${label} took ${trips} round trips (budget ${tripBudget}).` + advice);
    assert.ok(rows <= rowBudget,
      `${label} read ${rows.toLocaleString()} rows (budget ${rowBudget.toLocaleString()}) in ${trips} trips.` +
      `\n  A filtered read is ONE trip and can still drag a whole table.` + advice);
  });
}

/* =====================================================================================
   THE PHONE IS THE WORST CONNECTION IN THE COMPANY, AND THERE ARE THREE HUNDRED OF THEM.
   =====================================================================================
   Two numbers per handler: the FIRST handset on a cold instance, and a SECOND registered
   handset straight after it on the same instance -- the warm cost, which is what the other
   two hundred and ninety-nine pay. call-core.js's own header (lines 20-31) states a budget
   per handler "warm, on the second handset"; what it CLAIMS is written beside what was
   MEASURED, because the two do not agree and the gap is the work.

     handler        header claims (warm)                          measured 2nd handset
     boot           4 reads + gate (cached 30s)                   3 trips / 79 rows      ok
     list           3 reads + called-set (cached 30s)             6 trips / 3,046 rows   the deck is re-read PER HANDSET
     sync           2 reads + index (cached) + 2 writes           4 trips / 2 rows       ok -- the index is shared
     summary        cached 2 min per team-set; miss = 2 + 1       7 trips / 3,121 rows   per OFFICER, not per team-set
     comments       2 keyed reads                                 3 trips / 9 rows       +1 (the issues read)
     bell           (not claimed)                                 4 trips / 61 rows
     report         date-bounded, team-scoped                     6 trips / 202 rows     ok warm; 6,273 rows cold

   And the fenced handsets (AGENT, RSM) read the SAME 3,046-row deck as a credit officer to
   show their own handful -- the fence is applied after the whole deck has crossed the wire.

   [label, handler, first args, second args, FIRST trips, FIRST rows, SECOND trips, SECOND rows]
   measured 2026-09-20 (scratch: pgwar-phone.mjs), x1.5 rounded up. */
const oneCall = i => [{ ts: NOW - 3600000 - i, dur: 60, dir: 'out', num: '071' + String(1000000 + i).slice(-7), outcome: 'CONNECTED' }];
const PHONE = [
  ['Calls: boot',                   'api_callBoot',          ['DEV1'], ['DEV2'],                    6,   119,  5,   119],   // 4/79, 3/79
  ['Calls: the list',               'api_callList',          ['DEV1', 'today'], ['DEV2', 'today'], 18, 15863,  9,  4569],   // 12/10575, 6/3046
  ['Calls: the list (AGENT)',       'api_callList',          ['DEVA1', 'today'], ['DEVA2', 'today'], 18, 15863, 9, 4569],   // 12/10575, 6/3046
  ['Calls: the list (RSM leader)',  'api_callList',          ['DEVR1', 'today'], ['DEVR2', 'today'], 18, 15863, 9, 4569],   // 12/10575, 6/3046
  ['Calls: sync one call',          'api_callSync',          ['DEV1', oneCall(1)], ['DEV2', oneCall(2)], 15, 14210, 6, 3],   // 10/9473, 4/2
  ['Calls: one customer\'s comments', 'api_callComments',    ['DEV1', IMEI0], ['DEV2', '351001000000001'], 5, 12, 5, 14],   // 3/8, 3/9
  ['Calls: daily summary',          'api_callDailySummary',  ['DEV1'], ['DEV2'],                   18, 32736, 11,  4682],   // 12/21824, 7/3121
  ['Calls: daily summary (AGENT)',  'api_callDailySummary',  ['DEVA1'], ['DEVA2'],                 23, 41664,  9,  4503],   // 15/27776, 6/3002
  ['Calls: daily summary (RSM leader)', 'api_callDailySummary', ['DEVR1'], ['DEVR2'],              23, 41664,  9,  4503],   // 15/27776, 6/3002
  ['Calls: the bell',               'api_callNotifications', ['DEV1'], ['DEV2'],                    6,   182,  6,    92],   // 4/121, 4/61
  ['Calls: leader report',          'api_callReport',        ['DEVR1', null, null, null], ['DEVR2', null, null, null], 15, 9410, 9, 303],   // 10/6273, 6/202
];

for (const [label, fn, a1, a2, t1, r1, t2, r2] of PHONE) {
  test(`speed: ${label} -- first handset within ${t1} trips / ${r1.toLocaleString()} rows, second within ${t2} / ${r2.toLocaleString()}`, async () => {
    _clearSummaryCache();
    const c = counting(BOOK);
    await callApi(c.db, fn, a1, NOW);
    const first = c.stat();
    await callApi(c.db, fn, a2, NOW);
    const second = { trips: c.stat().trips - first.trips, rows: c.stat().rows - first.rows };
    const advice = `\n  This one runs on a PHONE, on mobile data, three hundred times a morning. Ask the\n` +
      `  database to do more before asking the handset to wait longer.`;
    assert.ok(first.trips <= t1, `${label}: the first handset took ${first.trips} trips (budget ${t1}).` + advice);
    assert.ok(first.rows <= r1, `${label}: the first handset read ${first.rows.toLocaleString()} rows (budget ${r1.toLocaleString()}).` + advice);
    assert.ok(second.trips <= t2, `${label}: the SECOND handset took ${second.trips} trips (budget ${t2}) -- something is not being shared.` + advice);
    assert.ok(second.rows <= r2, `${label}: the SECOND handset read ${second.rows.toLocaleString()} rows (budget ${r2.toLocaleString()}) -- something is not being shared.` + advice);
  });
}

/* THE ONE THAT TURNED HOPE'S DATABASE RED, checked here before it can happen to Hoop: the
   phone index (who is this number) must be built once per DATA_VERSION and shared by every
   handset, never rebuilt per sync. And it must not outlive an upload. */
test('speed: the phone index is built once and shared, not rebuilt per handset', async () => {
  const c = counting(BOOK);
  const sync = i => callApi(c.db, 'api_callSync', ['DEV' + i, oneCall(i)], NOW);
  await sync(1);
  const first = c.stat().rows;
  assert.ok(first > 1000, 'the first handset does build the index -- ' + first + ' rows');
  let before = c.stat().rows;
  for (let i = 2; i <= 8; i++) {
    await sync(i);
    const after = c.stat().rows;
    assert.ok(after - before < 100,
      `handset ${i} re-read ${after - before} rows to sync one call -- the index is not being shared.`);
    before = after;
  }
  c.db._dump('settings').find(r => r.key === 'DATA_VERSION').value = 'v101';
  before = c.stat().rows;
  await sync(1);
  assert.ok(c.stat().rows - before > 1000, 'an upload must force the index to rebuild on the next sync');
});

/* THE DECK IS READ ONCE PER HANDSET TODAY. Three hundred officers opening the list at eight
   in the morning is three hundred reads of the same three thousand rows within a minute, and
   the deck does not change between uploads. TODO(postgres-war): share the newest deck per
   instance against DATA_VERSION, the way the phone index already is. Offender: api_callList
   (the deck read, ~3,000 rows per handset warm). */
test.todo('speed: the deck is read once per minute, not once per handset', async () => {
  const c = counting(BOOK);
  await callApi(c.db, 'api_callList', ['DEV1', 'today'], NOW);
  let before = c.stat().rows;
  for (let i = 2; i <= 6; i++) {
    await callApi(c.db, 'api_callList', ['DEV' + i, 'today'], NOW);
    const after = c.stat().rows;
    assert.ok(after - before < 500, `handset ${i} re-read ${after - before} rows for the same deck`);
    before = after;
  }
});

/* =====================================================================================
   THE WHOLE-SYSTEM GUARD: HOW MUCH DOES ONE ORDINARY RSM READ?
   =====================================================================================
   An RSM holds ONE branch of forty. Every screen they open should read roughly a fortieth of
   the book; where it reads the whole book instead, the cause is always the same mistake --
   fetch everything, filter in JavaScript -- and it is invisible when the fixture has one
   branch. This sweeps EVERY read-only portal function, so a new screen is covered the day it
   is added. The two tells:

     1. the RSM reads more than OFFICER_ROW_CEILING rows for one screen;
     2. the RSM reads EXACTLY as many rows as the all-branches admin (the filter is not in
        the query) -- checked only where there is a real book to narrow (admin >= 500 rows).

   TODAY BOTH TELLS FIRE, and this file must be green, so each carries the list of screens it
   already knows about: an offender may not GROW past its ceiling above, and no NEW offender
   may appear. The lists are the work queue of the postgres war, and the day one is empty the
   allowance below it comes out. */
const OFFICER_ROW_CEILING = 4000;

/* Functions that CHANGE something. A speed sweep must not fire them, and their cost is not a
   read cost anyway. oldStock and newStock stamp as they read (they mint staff codes off the
   stock lists) and are swept regardless: they are the two heaviest panes an RSM opens. */
const WRITERS = new Set(['notifSeen', 'fuOutcomesSend', 'portalAddComment', 'deviceEnrol', 'deviceShift', 'deviceSetState',
  'deviceDelete', 'advRequest', 'advDecide', 'advPay', 'advDeduct', 'salarySave', 'salaryDelete', 'impRoleSave', 'impRoleDelete',
  'impRequest', 'impDecide', 'impRetire', 'leaveRequest', 'leaveDecide', 'issueRaise', 'issueUpdate', 'topupRequest', 'topupUpdate',
  'priceSave', 'priceDelete', 'lossRaise', 'lossUpdate', 'commRateSave', 'commRateDelete', 'commBuild', 'commDecide', 'commPay',
  'targetSave', 'targetDelete', 'staffChannelSave', 'staffActive', 'staffManager', 'stockRequest', 'stockDecide', 'stockIssue',
  'saveTeam', 'newTeamCode', 'staffBranchSave', 'officerActive', 'deleteRole', 'saveRole', 'saveAccessCode', 'renameAccessCode',
  'changeMyCode', 'accessCodeSuspend', 'deleteAccessCode', 'settingSet', 'enrolSave', 'enrolUpdate', 'itWeeklySend', 'signinReview',
  'signinSend', 'transferCreate', 'transferAccept', 'transferDecline', 'transferSign', 'transferCreateBulk']);

/* TODO(postgres-war): the screens where a one-branch RSM reads the SAME rows as the admin on
   a table with more than 500 rows -- the team/holder filter is applied after the whole table
   has crossed the wire. Measured 2026-09-20. Remove each name here as its query is scoped. */
const KNOWN_UNSCOPED = new Set(['stockView', 'stockAccount', 'deviceList', 'syncAging', 'priceList', 'commRates', 'stockMine',
  'stockQueue', 'stockReqReport', 'stockMovement', 'staffDirectory', 'enrolQueue', 'itWeekly', 'transferUsers', 'transferStock']);

/* The screens where the RSM already reads past OFFICER_ROW_CEILING, each held to the ceiling
   it was measured at above (x1.5) rather than to the real one. Derived from BUDGETS so there
   is one list of numbers, not two. */
const KNOWN_OVER = new Map(BUDGETS.filter(b => b[3] === RSM_ONE && Object.keys(b[2]).length === 0 && b[5] > OFFICER_ROW_CEILING)
  .map(b => [b[1], b[5]]));

/* Swept once, shared by the two tells below. */
let sweepP = null;
function sweep() {
  sweepP = sweepP || (async () => {
    const out = [];
    for (const fn of Object.keys(_FNS)) {
      if (WRITERS.has(fn)) continue;
      const run = async user => {
        _clearSummaryCache();
        const c = counting(BOOK);
        try { await _FNS[fn](c.db, user, {}); } catch (e) { return null; }   // needs arguments, or refused -- not a read
        return c.stat().rows;
      };
      out.push({ fn, rsm: await run(RSM_ONE), admin: await run(ADMIN) });
    }
    return out;
  })();
  return sweepP;
}

test('speed: NO new screen lets one RSM read the whole company book (known offenders held to their ceilings)', async () => {
  const worst = (await sweep()).filter(w => w.rsm != null);
  const over = worst.filter(w => KNOWN_OVER.has(w.fn) ? w.rsm > KNOWN_OVER.get(w.fn) : w.rsm > OFFICER_ROW_CEILING)
    .sort((a, b) => b.rsm - a.rsm);
  assert.deepEqual(over.map(w => w.fn), [],
    'These screens read more than ' + OFFICER_ROW_CEILING.toLocaleString() + ' rows for an RSM who holds ONE branch of forty '
    + '(or a known offender grew past its ceiling):\n  '
    + over.map(w => w.fn + ' -- ' + w.rsm.toLocaleString() + ' rows').join('\n  ')
    + '\n\n  Almost certainly a read that fetches every branch and filters in JavaScript.'
    + '\n  The fix is scopeQ / the holder filter in the QUERY, not a bigger number here.');
});

test('speed: an RSM and an admin must NOT read the same amount (no new unscoped screen)', async () => {
  const same = (await sweep()).filter(w => w.rsm != null && w.admin != null && w.admin >= 500 && w.rsm === w.admin).map(w => w.fn);
  const fresh = same.filter(fn => !KNOWN_UNSCOPED.has(fn));
  assert.deepEqual(fresh, [],
    'These screens read exactly as much for a ONE-BRANCH RSM as for an ALL-BRANCHES admin, '
    + 'which means the team filter is not in the query:\n  ' + fresh.join('\n  '));
});

test.todo('speed: NO screen lets one RSM read the whole company book', async () => {
  const over = (await sweep()).filter(w => w.rsm != null && w.rsm > OFFICER_ROW_CEILING).sort((a, b) => b.rsm - a.rsm);
  assert.deepEqual(over.map(w => w.fn + ' -- ' + w.rsm.toLocaleString() + ' rows'), []);
});

test.todo('speed: an RSM and an admin must NOT read the same amount', async () => {
  const same = (await sweep()).filter(w => w.rsm != null && w.admin != null && w.admin >= 500 && w.rsm === w.admin).map(w => w.fn);
  assert.deepEqual(same, []);
});
