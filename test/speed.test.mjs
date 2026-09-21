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
 * THESE ARE THE POST-FIX CEILINGS OF THE POSTGRES WAR (measured 2026-09-21), NOT A TARGET.
 * =========================================================================================
 * Two numbers per screen: COLD (a fresh instance, the first person of the morning) and WARM
 * (the same database client asked again straight after -- what everybody else pays). Every
 * ceiling is what the screen MEASURED on this fixture, times one and one fifth, rounded up.
 * The warm column is where the war was won: the door, the deck, the roster, the stock index
 * and the dashboard are shared per instance now, and a memo that quietly stops being shared
 * shows up here as a warm number climbing back towards the cold one. A ceiling that is raised
 * is raised in the SAME commit as the change that needs it, with the reason in the diff -- and
 * the first question is always "can the database do this instead of me?".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
const { _FNS } = await import('../api/portal.js');
const { callApi, _clearSummaryCache } = await import('../api/_lib/call-core.js');
import { NOW, TODAY, day, stamp, imei, uuid, BRANCHES, bigBook, counting, ALL_NAVS, ADMIN, RSM_ONE, CREDIT, AGENT, BOOK, IMEI0, uid } from './speed-fixture.mjs';


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
  ['Tips',                    'hints',          {}, ADMIN,     3, 24, 3, 24],   // cold 2 / 20, warm 2 / 20
  ['Tips (RSM)',              'hints',          {}, RSM_ONE,   3, 24, 3, 24],   // cold 2 / 20, warm 2 / 20
  ['The bell',                'notifications',  {}, ADMIN,     3, 48, 3, 48],   // cold 2 / 40, warm 2 / 40
  ['The bell (RSM)',          'notifications',  {}, RSM_ONE,  9, 7334, 4, 48],   // cold 7 / 6111, warm 3 / 40 -- the fence reads the register
  ['Dashboard (boot)',        'boot',           {}, ADMIN,    12, 23795, 2, 50],   // cold 10 / 19829, warm 1 / 41 -- the whole week of snapshots
  ['Dashboard (boot, RSM)',   'boot',           {}, RSM_ONE,  17, 31080, 2, 50],   // cold 14 / 25900, warm 1 / 41 -- MORE than the admin: the week of snapshots, then the fence's register on top
  ['Locked trend',            'lockedTrend',    {}, ADMIN,     3, 11079, 2, 2],   // cold 2 / 9232, warm 1 / 1
  ['Locked trend (RSM)',      'lockedTrend',    {}, RSM_ONE,  9, 7503, 3, 2],   // cold 7 / 6252, warm 2 / 1
  ['Locked trend (a week)',   'lockedTrend',    { week: '2026-09-07' }, ADMIN,   2, 5236, 0, 0],   // cold 1 / 4363, warm 0 / 0
  ['Locked trend (a week, RSM)', 'lockedTrend', { week: '2026-09-07' }, RSM_ONE, 8, 7401, 2, 0],   // cold 6 / 6167, warm 1 / 0
  ['Recovery week',           'recoveryWeek',   {}, ADMIN,     6, 17214, 2, 2],   // cold 5 / 14345, warm 1 / 1
  ['Recovery week (RSM)',     'recoveryWeek',   {}, RSM_ONE,  11, 7772, 3, 2],   // cold 9 / 6476, warm 2 / 1
  ['Recovery day list',       'recoveryDayList', { date: TODAY }, ADMIN,  11, 10770, 4, 3432],   // cold 9 / 8975, warm 3 / 2860
  ['Recovery day list (RSM)', 'recoveryDayList', { date: TODAY }, RSM_ONE, 11, 7425, 4, 87],   // cold 9 / 6187, warm 3 / 72
  ['Recovery',                'recovery',       {}, ADMIN,    12, 14152, 8, 6867],   // cold 10 / 11793, warm 6 / 5722
  ['Recovery (RSM)',          'recovery',       {}, RSM_ONE,  14, 7461, 9, 176],   // cold 11 / 6217, warm 7 / 146
  ['Calls report',            'report',         {}, ADMIN,    12, 12104, 8, 4818],   // cold 10 / 10086, warm 6 / 4015
  ['Calls report (RSM)',      'report',         {}, RSM_ONE,  12, 9210, 8, 1925],   // cold 10 / 7675, warm 6 / 1604
  ['Calls report (a week)',   'report',         { from: '2026-09-11', to: TODAY }, ADMIN,   12, 12720, 8, 5435],   // cold 10 / 10600, warm 6 / 4529
  ['Calls report (a week, RSM)', 'report',      { from: '2026-09-11', to: TODAY }, RSM_ONE, 12, 9210, 8, 1925],   // cold 10 / 7675, warm 6 / 1604
  ['Follow-up outcomes',      'fuOutcomes',     {}, ADMIN,     5, 3602, 5, 3602],   // cold 4 / 3001, warm 4 / 3001
  ['Follow-up outcomes (RSM)', 'fuOutcomes',    {}, RSM_ONE,  11, 7377, 6, 92],   // cold 9 / 6147, warm 5 / 76
  ['Sales week',              'salesWeek',      {}, ADMIN,     4, 122, 2, 2],   // cold 3 / 101, warm 1 / 1
  ['Sales week (RSM)',        'salesWeek',      {}, RSM_ONE,  10, 7317, 3, 2],   // cold 8 / 6097, warm 2 / 1
  ['Sales week (a week)',     'salesWeek',      { week: '2026-09-07' }, ADMIN,    3, 420, 0, 0],   // cold 2 / 350, warm 0 / 0
  ['Sales week (a week, RSM)', 'salesWeek',     { week: '2026-09-07' }, RSM_ONE, 9, 7286, 2, 0],   // cold 7 / 6071, warm 1 / 0
  ['Customers (Wateja)',      'customers',      {}, ADMIN,    16, 17973, 9, 10635],   // cold 13 / 14977, warm 7 / 8862
  ['Customers (Wateja, RSM)', 'customers',      {}, RSM_ONE,  16, 7607, 9, 269],   // cold 13 / 6339, warm 7 / 224
  ['One customer\'s comments', 'customerComments', { imei: IMEI0 }, ADMIN,   2, 9, 2, 9],   // cold 1 / 7, warm 1 / 7
  ['One customer\'s comments (RSM)', 'customerComments', { imei: IMEI0 }, RSM_ONE, 2, 9, 2, 9],   // cold 1 / 7, warm 1 / 7
  ['Customer search',         'customerSearch', { q: 'CUSTOMER 7' }, ADMIN,   2, 36, 2, 36],   // cold 1 / 30, warm 1 / 30
  ['Customer search (RSM)',   'customerSearch', { q: 'CUSTOMER 7' }, RSM_ONE, 2, 3, 2, 3],   // cold 1 / 2, warm 1 / 2
  ['Global search',           'globalSearch',   { q: 'CUSTOMER 7' }, ADMIN,   5, 36, 5, 36],   // cold 4 / 30, warm 4 / 30
  ['Global search (RSM)',     'globalSearch',   { q: 'CUSTOMER 7' }, RSM_ONE, 5, 3, 5, 3],   // cold 4 / 2, warm 4 / 2
  // ---- sales: the fraud audit and the scorecards ----
  ['Fraud audit',             'salesAudit',     {}, ADMIN,     4, 6018, 4, 6018],   // cold 3 / 5015, warm 3 / 5015
  ['Fraud audit (RSM)',       'salesAudit',     {}, RSM_ONE,  10, 13304, 5, 6018],   // cold 8 / 11086, warm 4 / 5015
  ['Fraud audit (a month)',   'salesAudit',     { from: '2026-08-20', to: TODAY }, ADMIN,    4, 6098, 4, 6098],   // cold 3 / 5081, warm 3 / 5081
  ['Fraud audit (a month, RSM)', 'salesAudit',  { from: '2026-08-20', to: TODAY }, RSM_ONE, 10, 13383, 5, 6098],   // cold 8 / 11152, warm 4 / 5081
  ['Agent scorecards',        'agentScore',     {}, ADMIN,     5, 7286, 5, 7286],   // cold 4 / 6071, warm 4 / 6071
  ['Agent scorecards (RSM)',  'agentScore',     {}, RSM_ONE,  11, 11061, 6, 3776],   // cold 9 / 9217, warm 5 / 3146
  ['Targets',                 'targetsView',    {}, ADMIN,     4, 2319, 4, 2319],   // cold 3 / 1932, warm 3 / 1932
  ['Targets (RSM)',           'targetsView',    {}, RSM_ONE,   4, 1449, 4, 1449],   // cold 3 / 1207, warm 3 / 1207
  // ---- stock: the register, the old list, the audit, movements and transfers ----
  ['Stock view',              'stockView',      {}, ADMIN,     3, 1646, 3, 1646],   // cold 2 / 1371, warm 2 / 1371
  ['Stock view (RSM)',        'stockView',      {}, RSM_ONE,   3, 1646, 3, 1646],   // cold 2 / 1371, warm 2 / 1371 -- same as admin
  ['Stock account',           'stockAccount',   {}, ADMIN,     5, 1647, 3, 2],   // cold 4 / 1372, warm 2 / 1
  ['Stock account (RSM)',     'stockAccount',   {}, RSM_ONE,   5, 1647, 3, 2],   // cold 4 / 1372, warm 2 / 1 -- same as admin
  ['Device list (lock bench)', 'deviceList',    {}, ADMIN,     3, 2400, 3, 2400],   // cold 2 / 2000, warm 2 / 2000
  ['Device list (RSM)',       'deviceList',     {}, RSM_ONE,   3, 2400, 3, 2400],   // cold 2 / 2000, warm 2 / 2000 -- same as admin
  ['Device history',          'deviceHistory',  { imei: IMEI0 }, ADMIN,   3, 3, 3, 3],   // cold 2 / 2, warm 2 / 2
  ['Device token',            'deviceToken',    { imei: IMEI0 }, ADMIN,   2, 2, 2, 2],   // cold 1 / 1, warm 1 / 1
  ['Aging sync',              'syncAging',      {}, ADMIN,     5, 2760, 5, 2760],   // cold 4 / 2300, warm 4 / 2300
  ['Aging sync (RSM)',        'syncAging',      {}, RSM_ONE,   5, 2760, 5, 2760],   // cold 4 / 2300, warm 4 / 2300 -- same as admin
  ['OLD STOCK',               'oldStock',       {}, ADMIN,    66, 13822, 4, 4373],   // cold 55 / 11518, warm 3 / 3644 -- FIFTY-SIX trips for one click
  ['OLD STOCK (RSM)',         'oldStock',       {}, RSM_ONE,  66, 13822, 4, 4373],   // cold 55 / 11518, warm 3 / 3644
  ['Old stock by holder',     'oldStockHolder', {}, ADMIN,    10, 12086, 2, 1800],   // cold 8 / 10071, warm 1 / 1500
  ['Old stock by holder (RSM)', 'oldStockHolder', {}, RSM_ONE, 11, 13371, 3, 3086],   // cold 9 / 11142, warm 2 / 2571
  ['Old stock round',         'oldStockRound',  {}, ADMIN,    10, 12086, 2, 1800],   // cold 8 / 10071, warm 1 / 1500
  ['Old stock round (RSM)',   'oldStockRound',  {}, RSM_ONE,  11, 13371, 3, 3086],   // cold 9 / 11142, warm 2 / 2571
  ['NEW STOCK',               'newStock',       {}, ADMIN,    29, 14182, 6, 6088],   // cold 24 / 11818, warm 5 / 5073
  ['NEW STOCK (RSM)',         'newStock',       {}, RSM_ONE,  29, 14182, 6, 6088],   // cold 24 / 11818, warm 5 / 5073
  ['Price list',              'priceList',      {}, ADMIN,     3, 3605, 3, 3605],   // cold 2 / 3004, warm 2 / 3004 -- reads 3,000 loans for 4 prices
  ['Price list (RSM)',        'priceList',      {}, RSM_ONE,   3, 3605, 3, 3605],   // cold 2 / 3004, warm 2 / 3004
  ['Stock requests (mine)',   'stockMine',      {}, ADMIN,    14, 12446, 3, 1800],   // cold 11 / 10371, warm 2 / 1500 -- "mine" reads the whole register
  ['Stock requests (mine, RSM)', 'stockMine',   {}, RSM_ONE,  14, 12446, 3, 1800],   // cold 11 / 10371, warm 2 / 1500 -- same as admin
  ['Stock requests (queue)',  'stockQueue',     {}, ADMIN,    14, 12806, 3, 2160],   // cold 11 / 10671, warm 2 / 1800
  ['Stock requests (queue, RSM)', 'stockQueue', {}, RSM_ONE,  14, 12806, 3, 2160],   // cold 11 / 10671, warm 2 / 1800 -- same as admin
  ['Stock requests report',   'stockReqReport', {}, ADMIN,    14, 12806, 3, 2160],   // cold 11 / 10671, warm 2 / 1800
  ['Stock requests report (RSM)', 'stockReqReport', {}, RSM_ONE, 14, 12806, 3, 2160],   // cold 11 / 10671, warm 2 / 1800 -- same as admin
  ['Stock handover',          'stockHandover',  { id: uid(580003) }, ADMIN,   4, 8, 4, 8],   // cold 3 / 6, warm 3 / 6
  ['Stock photos',            'stockPhotos',    { id: uid(580003) }, ADMIN,   3, 2, 3, 2],   // cold 2 / 1, warm 2 / 1
  ['Stock movement',          'stockMovement',  {}, ADMIN,    9, 7228, 9, 7228],   // cold 7 / 6023, warm 7 / 6023
  ['Stock movement (RSM)',    'stockMovement',  {}, RSM_ONE,  9, 7228, 9, 7228],   // cold 7 / 6023, warm 7 / 6023 -- same as admin
  ['Transfer parties',        'transferUsers',  {}, ADMIN,     6, 5248, 6, 5248],   // cold 5 / 4373, warm 5 / 4373
  ['Transfer parties (RSM)',  'transferUsers',  {}, RSM_ONE,   6, 5248, 6, 5248],   // cold 5 / 4373, warm 5 / 4373 -- same as admin
  ['Transfer stock window',   'transferStock',  {}, ADMIN,    12, 14486, 4, 4200],   // cold 10 / 12071, warm 3 / 3500
  ['Transfer stock window (RSM)', 'transferStock', {}, RSM_ONE, 12, 14486, 4, 4200],   // cold 10 / 12071, warm 3 / 3500 -- "what YOU hold" reads everything
  ['Transfer inbox',          'transferInbox',  {}, ADMIN,     2, 240, 2, 240],   // cold 1 / 200, warm 1 / 200
  ['Transfer list',           'transferList',   {}, ADMIN,     2, 240, 2, 240],   // cold 1 / 200, warm 1 / 200
  ['Transfer document',       'transferGet',    { id: uid(650000) }, ADMIN,   3, 3, 3, 3],   // cold 2 / 2, warm 2 / 2
  // ---- the office: advances, imprest, leave, issues, top-ups, losses, commission ----
  ['Advance (mine)',          'advMine',        {}, ADMIN,     4, 3, 4, 3],   // cold 3 / 2, warm 3 / 2
  ['Advance queue',           'advQueue',       {}, ADMIN,     2, 360, 2, 360],   // cold 1 / 300, warm 1 / 300
  ['Advance report',          'advReport',      {}, ADMIN,     2, 360, 2, 360],   // cold 1 / 300, warm 1 / 300
  ['Salary list',             'salaryList',     {}, ADMIN,     3, 123, 3, 123],   // cold 2 / 102, warm 2 / 102
  ['Imprest rates',           'impRoles',       {}, ADMIN,     5, 460, 5, 460],   // cold 4 / 383, warm 4 / 383
  ['Imprest (mine)',          'impMine',        {}, ADMIN,     6, 460, 6, 460],   // cold 5 / 383, warm 5 / 383
  ['Imprest queue',           'impQueue',       {}, ADMIN,     2, 360, 2, 360],   // cold 1 / 300, warm 1 / 300
  ['Imprest report',          'impReport',      {}, ADMIN,     3, 480, 3, 480],   // cold 2 / 400, warm 2 / 400
  ['Imprest photos',          'impPhotos',      { id: uid(500001) }, ADMIN,   2, 0, 2, 0],   // cold 1 / 0, warm 1 / 0
  ['Leave (mine)',            'leaveMine',      {}, ADMIN,     2, 0, 2, 0],   // cold 1 / 0, warm 1 / 0
  ['Leave queue',             'leaveQueue',     {}, ADMIN,     2, 360, 2, 360],   // cold 1 / 300, warm 1 / 300
  ['Leave report',            'leaveReport',    {}, ADMIN,     3, 370, 3, 370],   // cold 2 / 308, warm 2 / 308
  ['Issue targets',           'issueTargets',   {}, ADMIN,     3, 448, 2, 0],   // cold 2 / 373, warm 1 / 0
  ['Issues (mine)',           'issueMine',      {}, ADMIN,     2, 0, 2, 0],   // cold 1 / 0, warm 1 / 0
  ['Issue queue',             'issueQueue',     {}, ADMIN,     2, 360, 2, 360],   // cold 1 / 300, warm 1 / 300
  ['Issue report',            'issueReport',    {}, ADMIN,     2, 360, 2, 360],   // cold 1 / 300, warm 1 / 300
  ['Issue notes',             'issueNotes',     { id: uid(530000) }, ADMIN,   2, 2, 2, 2],   // cold 1 / 1, warm 1 / 1
  ['Top-ups (mine)',          'topupMine',      {}, ADMIN,     2, 0, 2, 0],   // cold 1 / 0, warm 1 / 0
  ['Top-up queue',            'topupQueue',     {}, ADMIN,     3, 270, 3, 270],   // cold 2 / 225, warm 2 / 225
  ['Loss cases',              'lossList',       {}, ADMIN,     2, 240, 2, 240],   // cold 1 / 200, warm 1 / 200
  ['Loss case notes',         'lossNotes',      { id: uid(560000) }, ADMIN,   2, 2, 2, 2],   // cold 1 / 1, warm 1 / 1
  ['Commission rates',        'commRates',      {}, ADMIN,     5, 4888, 3, 3],   // cold 4 / 4073, warm 2 / 2 -- the rate table reads every agent
  ['Commission rates (RSM)',  'commRates',      {}, RSM_ONE,   5, 4888, 3, 3],   // cold 4 / 4073, warm 2 / 2 -- same as admin
  ['Commission cycles',       'commRuns',       {}, ADMIN,     2, 15, 2, 15],   // cold 1 / 12, warm 1 / 12
  ['Commission sheet',        'commSheet',      { id: uid(630000) }, ADMIN,   3, 32, 3, 32],   // cold 2 / 26, warm 2 / 26
  // ---- people, codes, settings, security ----
  ['Staff directory',         'staffDirectory', {}, ADMIN,     4, 4886, 3, 1286],   // cold 3 / 4071, warm 2 / 1071
  ['Staff directory (RSM)',   'staffDirectory', {}, RSM_ONE,   4, 4886, 3, 1286],   // cold 3 / 4071, warm 2 / 1071 -- same as admin
  ['Staff channel (one person)', 'staffChannel', { phone: '0720100000' }, ADMIN, 2, 1286, 2, 1286],   // cold 1 / 1071, warm 1 / 1071 -- one person, the whole register
  ['Enrolment queue',         'enrolQueue',     {}, ADMIN,     3, 1338, 3, 1338],   // cold 2 / 1115, warm 2 / 1115
  ['Enrolment queue (RSM)',   'enrolQueue',     {}, RSM_ONE,   3, 1338, 3, 1338],   // cold 2 / 1115, warm 2 / 1115 -- same as admin
  ['Officers',                'officers',       {}, ADMIN,     2, 53, 2, 53],   // cold 1 / 44, warm 1 / 44
  ['Access codes',            'accessCodes',    {}, ADMIN,     4, 455, 4, 455],   // cold 3 / 379, warm 3 / 379
  ['Settings',                'settings',       {}, ADMIN,     2, 6, 2, 6],   // cold 1 / 5, warm 1 / 5
  ['IT weekly report',        'itWeekly',       {}, ADMIN,    41, 4438, 41, 4438],   // cold 34 / 3698, warm 34 / 3698 -- THIRTY-FOUR trips
  ['IT weekly report (RSM)',  'itWeekly',       {}, RSM_ONE,  41, 4438, 41, 4438],   // cold 34 / 3698, warm 34 / 3698 -- same as admin
  ['Sign-in watch',           'signinWatch',    {}, ADMIN,     3, 173, 3, 173],   // cold 2 / 144, warm 2 / 144
  ['Audit log',               'audit',          {}, ADMIN,     5, 266, 5, 266],   // cold 4 / 221, warm 4 / 221
  // ---- the dashboard, fetched as one ----
  ['Dashboard week (one trip)', 'dashboardWeek', {}, ADMIN, 6, 5, 6, 5],   // cold 5 / 4, warm 5 / 4 -- lockedTrend + recoveryWeek + salesWeek + stockAccount, one door instead of four
  ['Dashboard week (one trip, RSM)', 'dashboardWeek', {}, RSM_ONE, 12, 7290, 8, 5],   // cold 10 / 6075, warm 6 / 4 -- lockedTrend + recoveryWeek + salesWeek + stockAccount, one door instead of four
];

/* TWO NUMBERS PER SCREEN: COLD, then WARM. Cold is a fresh instance -- the first person of the
   morning. Warm is the SAME database client asked the same question straight after, which is what
   everybody else pays, and it is where the postgres war was won: a memo that quietly stops being
   shared shows up here as a warm number climbing back towards the cold one. Both are ceilings at
   measured x1.2, rounded up. */
for (const [label, fn, args, user, tripBudget, rowBudget, warmTrips, warmRows] of BUDGETS) {
  test(`speed: ${label} -- cold within ${tripBudget} trips / ${rowBudget.toLocaleString()} rows, warm within ${warmTrips} / ${warmRows.toLocaleString()}`, async () => {
    _clearSummaryCache();
    const c = counting(BOOK);
    await _FNS[fn](c.db, user, args);
    const cold = c.stat();
    await _FNS[fn](c.db, user, args);
    const warm = { trips: c.stat().trips - cold.trips, rows: c.stat().rows - cold.rows };
    const advice = `\n  Before raising these numbers: can the database do the work instead?\n` +
      `  Ordering, limiting, filtering and counting all belong there. If the answer is genuinely\n` +
      `  no, raise them in the SAME commit so the cost is visible in the diff.`;
    assert.ok(cold.trips <= tripBudget, `${label} took ${cold.trips} round trips cold (budget ${tripBudget}).` + advice);
    assert.ok(cold.rows <= rowBudget,
      `${label} read ${cold.rows.toLocaleString()} rows cold (budget ${rowBudget.toLocaleString()}) in ${cold.trips} trips.` +
      `\n  A filtered read is ONE trip and can still drag a whole table.` + advice);
    assert.ok(warm.trips <= warmTrips, `${label} took ${warm.trips} round trips WARM (budget ${warmTrips}) -- a memo has stopped being shared.` + advice);
    assert.ok(warm.rows <= warmRows, `${label} read ${warm.rows.toLocaleString()} rows WARM (budget ${warmRows.toLocaleString()}) -- a memo has stopped being shared.` + advice);
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
  ['Calls: boot',                   'api_callBoot',          ['DEV1'], ['DEV2'],                    5, 95, 4, 95],   // 4/79, 3/79
  ['Calls: the list',               'api_callList',          ['DEV1', 'today'], ['DEV2', 'today'], 15, 12690, 4, 3],   // 12/10575, 3/2 -- the deck is SHARED now
  ['Calls: the list (AGENT)',       'api_callList',          ['DEVA1', 'today'], ['DEVA2', 'today'], 15, 12690, 4, 3],   // 12/10575, 3/2 -- the fence runs on the shared deck in memory
  ['Calls: the list (RSM leader)',  'api_callList',          ['DEVR1', 'today'], ['DEVR2', 'today'], 15, 12690, 4, 3],   // 12/10575, 3/2
  ['Calls: sync one call',          'api_callSync',          ['DEV1', oneCall(1)], ['DEV2', oneCall(2)], 12, 11368, 5, 3],   // 10/9473, 4/2
  ['Calls: one customer\'s comments', 'api_callComments',    ['DEV1', IMEI0], ['DEV2', '351001000000001'], 4, 10, 4, 11],   // 3/8, 3/9
  ['Calls: daily summary',          'api_callDailySummary',  ['DEV1'], ['DEV2'],                   15, 26189, 5, 93],   // 12/21824, 4/77
  ['Calls: daily summary (AGENT)',  'api_callDailySummary',  ['DEVA1'], ['DEVA2'],                 17, 33332, 5, 3],   // 14/27776, 4/2
  ['Calls: daily summary (RSM leader)', 'api_callDailySummary', ['DEVR1'], ['DEVR2'],              17, 33332, 5, 3],   // 14/27776, 4/2
  ['Calls: the bell',               'api_callNotifications', ['DEV1'], ['DEV2'],                    5, 146, 5, 74],   // 4/121, 4/61
  ['Calls: leader report',          'api_callReport',        ['DEVR1', null, null, null], ['DEVR2', null, null, null], 12, 7528, 8, 243],   // 10/6273, 6/202
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

/* THE DECK WAS READ ONCE PER HANDSET. Three hundred officers opening the list at eight in the
   morning were three hundred reads of the same three thousand rows within a minute, for a deck
   that only changes on an upload. It is shared per instance now, keyed on the deck date and
   DATA_VERSION (sharedDeck in call-core.js), and a comment write-throughs into the one row it
   changed -- so this is the test that was a todo, made real. */
test('speed: the deck is read once per instance, not once per handset', async () => {
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
  'stockQueue', 'stockReqReport', 'stockMovement', 'staffDirectory', 'enrolQueue', 'itWeekly', 'transferUsers', 'transferStock',
  /* oldStock and newStock read the same rows for the RSM as for the admin BY CONSTRUCTION now: the
     six-table index behind them is one shared per-instance memo (api/_lib/stock-index.js), read
     whole and once, and the RSM's own rows are fenced from it in memory -- see stockAllow. The
     tell is the wrong instrument for a shared read; the warm ceilings above are the right one. */
  'oldStock', 'newStock']);

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
