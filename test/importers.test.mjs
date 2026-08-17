import test from 'node:test';
import assert from 'node:assert/strict';
import { watuDate, watuBool, watuImei, teamFromShop, lifetimeDay, importWatu } from '../api/_lib/importers.js';

/* The starter's own sample rows -- the fixtures the demo is seeded with. */
const HEADERS = ['Shop', 'Agent', 'Agent ID', 'Client Name', 'Client Mobile', 'Model', 'Model Details',
  'Disbursed Date', 'IMEI', 'Price', 'Has Ever Paid', 'Days Offline', 'Onboarding Time (Min)',
  'App Signed Up', 'Locked 4+ Days', 'Locked 7+ Days'];
const ROW1 = ['Hoop Limited, Kinondoni', 'Denis John', '120405', 'Alafati Kalikawe Selemani', '255716548153',
  'A07', 'A07 (SM-A075F/DS) 64GB/4GB', '13-Jul-26', '351929937378664', '450000', 'FALSE', '21', '375', 'TRUE', 'TRUE', 'TRUE'];
const ROW2 = ['Hoop Limited, Kinondoni', 'Adolph Steven', '96231', 'Yuda M Japhet', '255773460588',
  'A07', 'A07 (SM-A075F/DS) 64GB/4GB', '30-Jun-26', '351738748292885', '450000', 'TRUE', '12', '25', 'TRUE', 'TRUE', 'TRUE'];

test('watuDate parses the 13-Jul-26 shape for all twelve months', () => {
  const cases = [
    ['13-Jan-26', '2026-01-13'], ['1-Feb-26', '2026-02-01'], ['28-Mar-26', '2026-03-28'],
    ['30-Apr-26', '2026-04-30'], ['5-May-26', '2026-05-05'], ['30-Jun-26', '2026-06-30'],
    ['13-Jul-26', '2026-07-13'], ['9-Aug-26', '2026-08-09'], ['21-Sep-26', '2026-09-21'],
    ['31-Oct-26', '2026-10-31'], ['2-Nov-26', '2026-11-02'], ['25-Dec-26', '2026-12-25'],
  ];
  for (const [input, want] of cases) assert.equal(watuDate(input), want, input);
});

test('watuDate handles 4-digit years, spaces, Date objects, ISO, and junk', () => {
  assert.equal(watuDate('13-Jul-2026'), '2026-07-13');
  assert.equal(watuDate('13 Jul 26'), '2026-07-13');
  assert.equal(watuDate(new Date(2026, 6, 13)), '2026-07-13');   // XLSX cellDates:true
  assert.equal(watuDate('2026-07-13'), '2026-07-13');
  assert.equal(watuDate('32-Jul-26'), null);
  assert.equal(watuDate('13-Xyz-26'), null);
  assert.equal(watuDate(''), null);
  assert.equal(watuDate(null), null);
});

test('watuBool: TRUE/FALSE text, and blank stays null -- missing is not "no"', () => {
  assert.equal(watuBool('TRUE'), true);
  assert.equal(watuBool('FALSE'), false);
  assert.equal(watuBool('true'), true);
  assert.equal(watuBool(false), false);
  assert.equal(watuBool(''), null);
  assert.equal(watuBool(null), null);
  assert.equal(watuBool('maybe'), null);
});

test('watuImei keeps the IMEI as text, 15 digits intact', () => {
  assert.equal(watuImei('351929937378664'), '351929937378664');
  assert.equal(watuImei(351929937378664), '351929937378664');       // number from XLSX raw
  assert.equal(watuImei(' 351929937378664 '), '351929937378664');
  assert.equal(watuImei('3.51929937378664E+14'), '351929937378664'); // Excel's crime scene
  assert.equal(watuImei('12345'), null);                             // too short to be one
  assert.equal(watuImei(''), null);
});

test('teamFromShop takes the part after the dealer name', () => {
  assert.equal(teamFromShop('Hoop Limited, Kinondoni'), 'KINONDONI');
  assert.equal(teamFromShop('Hoop Ltd, Dar es Salaam, Temeke'), 'TEMEKE');
  assert.equal(teamFromShop('Mwanza'), 'MWANZA');
  assert.equal(teamFromShop(''), null);
});

test('lifetimeDay: disbursement day is day 1; the 45-day window reads off it', () => {
  assert.equal(lifetimeDay('2026-07-13', '2026-07-13'), 1);
  assert.equal(lifetimeDay('2026-07-13', '2026-08-14'), 33);
  assert.equal(lifetimeDay('2026-06-30', '2026-08-14'), 46);        // aged out of the window
  assert.equal(lifetimeDay(null, '2026-08-14'), null);
});

test('importWatu reads the sample rows whole', () => {
  const { records, teams, dropped } = importWatu([HEADERS, ROW1, ROW2]);
  assert.equal(records.length, 2);
  assert.equal(dropped.length, 0);
  assert.deepEqual(teams, ['KINONDONI']);
  const r = records[0];
  assert.equal(r.imei, '351929937378664');
  assert.equal(r.client_name, 'Alafati Kalikawe Selemani');
  assert.equal(r.client_mobile, '255716548153');
  assert.equal(r.disbursed_date, '2026-07-13');
  assert.equal(r.price, 450000);
  assert.equal(r.has_ever_paid, false);
  assert.equal(r.days_offline, 21);
  assert.equal(r.onboarding_min, 375);
  assert.equal(r.app_signed_up, true);
  assert.equal(r.locked4, true);
  assert.equal(r.locked7, true);
  assert.equal(r.team, 'KINONDONI');
});

test('header-presence rule: a column the file does not have is absent, not null', () => {
  const slim = ['Client Name', 'IMEI', 'Days Offline'];
  const { records } = importWatu([slim, ['Yuda M Japhet', '351738748292885', '12']]);
  const r = records[0];
  assert.equal(r.imei, '351738748292885');
  assert.equal(r.days_offline, 12);
  assert.ok(!('locked7' in r), 'locked7 must not be manufactured for an absent column');
  assert.ok(!('price' in r), 'price must not be manufactured for an absent column');
});

test('a row with an unreadable IMEI is dropped AND named', () => {
  const bad = ROW1.slice(); bad[8] = 'no-imei-here';
  const { records, dropped } = importWatu([HEADERS, bad, ROW2]);
  assert.equal(records.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, 'Alafati Kalikawe Selemani');
});

test('the same IMEI twice in one file is one phone -- last occurrence wins', () => {
  const newer = ROW1.slice(); newer[11] = '25';
  const { records } = importWatu([HEADERS, ROW1, newer]);
  assert.equal(records.length, 1);
  assert.equal(records[0].days_offline, 25);
});

test('a file with no IMEI column is refused with the headers named', () => {
  assert.throws(() => importWatu([['Name', 'Phone'], ['x', 'y']]), /no IMEI column/);
});

/* ---------- phase 2: the three new file kinds through one upload slot ---------- */
import { importSales, isSalesFile, importAgents, isAgentsFile,
  importAgedStock, isAgedStockFile } from '../api/_lib/importers.js';

const SALES_HEADERS = ['Date', 'Branch', 'Agent', 'Client_Name', 'Client_Id', 'Client_Phone',
  'Phone_Model', 'Receipt_Number', 'Imei', 'Commission_Agent', 'Commission_Phone', 'Price'];
const SALE1 = ['14/08/2026', 'HOOP LIMITED', 'CYPRIAN RENATUS', 'Fredy J Damasi', 'N/A', '0797053513',
  'SAMSUNG A07-64GB', '9969', '350748531117000', 'Cyprian Dotto Renatus', '0780866571', '503000.00'];
const SALE2 = ['14/08/2026', 'HOOP LIMITED', 'Anord Sawe', 'Sayuni John Ngogo', 'N/A', '0789631776',
  'SAMSUNG A07-64GB', '9941', '353451828021079', 'ALOBOGASTI', '0764907295', '503000.00'];
const TOTAL_ROW = ['Total', '', '', '', '', '', '', '', '', '', '', 12038400];

test('the header row alone says which file kind arrived', () => {
  assert.equal(isSalesFile(SALES_HEADERS), true);
  assert.equal(isSalesFile(HEADERS), false, 'the Watu list is not a sales file');
  assert.equal(isAgentsFile(['JOINED', 'NAME', 'PHONE', 'KIN_NAME', 'ROLE']), true);
  assert.equal(isAgentsFile(SALES_HEADERS), false);
  assert.equal(isAgedStockFile(['AGENT', 'ITEM', 'SERIAL', 'RECEIVED', 'AGE']), true);
  assert.equal(isAgedStockFile(HEADERS), false);
});

test('importSales reads the real export shape and skips the Total footer silently', () => {
  const { records, dropped } = importSales([SALES_HEADERS, SALE1, SALE2, TOTAL_ROW]);
  assert.equal(records.length, 2);
  assert.equal(dropped.length, 0, 'the footer is arithmetic, not a broken row');
  const r = records[0];
  assert.equal(r.sale_date, '2026-08-14', 'dd/mm/yyyy read day-first');
  assert.equal(r.imei, '350748531117000');
  assert.equal(r.client_phone, '0797053513', 'phones stay text, leading zero kept');
  assert.equal(r.price, 503000, 'price text with decimals becomes a number');
  assert.equal(r.commission_agent, 'Cyprian Dotto Renatus');
  assert.match(r.sale_key, /^S[0-9a-z]+$/);
  const again = importSales([SALES_HEADERS, SALE1]);
  assert.equal(again.records[0].sale_key, r.sale_key, 'sale_key is deterministic -- re-uploads update');
});

test('importAgents keys on phone, reads status, and names the phoneless row', () => {
  const H = ['JOINED', 'NAME', 'NATIONAL_ID', 'PHONE', 'EMAIL', 'KIN_NAME', 'KIN_PHONE',
    'KIN_RELATIONSHIP', 'ROLE', 'BRANCH', 'STATUS'];
  const { records, dropped } = importAgents([H,
    ['21/02/2026', 'Anord Sawe', '19950923141260000121', '0658918324', 'sawearnold@gmail.com',
      'Violet Wilambile', '0682046804', 'Sister', 'Regional_Manager', 'Dar es salaam', 'Active'],
    ['21/02/2026', 'Ghost Agent', '', '', '', '', '', '', 'Field_Officer', 'ILALA', 'Inactive'],
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].phone, '0658918324');
  assert.equal(records[0].joined_date, '2026-02-21');
  assert.equal(records[0].kin_name, 'Violet Wilambile');
  assert.equal(records[0].active, true);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, 'Ghost Agent');
});

test('importAgedStock keys on the serial and keeps the report date honest', () => {
  const H = ['AGENT', 'ITEM', 'SERIAL', 'RECEIVED', 'AGE'];
  const { records, dropped } = importAgedStock([H,
    ['Anord Sawe', 'SAMSUNG A06-64GB', '350115227805852', '03/07/2026', '43'],
    ['Anord Sawe', 'SAMSUNG A06-64GB', '(no serial)', '', ''],
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].serial, '350115227805852');
  assert.equal(records[0].received, '2026-07-03');
  assert.equal(records[0].age_days, 43);
  assert.equal(dropped.length, 1);
});

/* ---------- the offline queue: guarantors land at last ---------- */
import { importOfflineQueue, isOfflineQueueFile, splitGuarantor, looksLikeHeader } from '../api/_lib/importers.js';

const OQ_HEADERS = ['Sale Date', 'IMEI', 'Offline Bucket', 'Customer', 'Customer Phone',
  'Guarantor', 'Agent', 'Branch', 'Offline Owner', 'Status', 'Next Action Date',
  'Last Action Type', 'Last Action At', 'Last Action By', 'Last Action Note'];

test('the offline queue is recognized -- and NEVER mistaken for a deck', () => {
  assert.equal(isOfflineQueueFile(OQ_HEADERS), true);
  assert.equal(isSalesFile(OQ_HEADERS), false, 'no receipt/commission columns');
  assert.equal(isAgentsFile(OQ_HEADERS), false, 'no next-of-kin column');
  assert.equal(isOfflineQueueFile(['Shop', 'Agent', 'IMEI', 'Client Name']), false,
    'the daily deck is not an offline queue');
});

test('splitGuarantor takes "name | phone" apart and invents neither half', () => {
  assert.deepEqual(splitGuarantor('Issack daniely samawa | 0788533370'),
    { name: 'Issack daniely samawa', phone: '0788533370' });
  assert.deepEqual(splitGuarantor('-'), { name: null, phone: null });
  assert.deepEqual(splitGuarantor('Grace Simbeye'), { name: 'Grace Simbeye', phone: null });
  assert.deepEqual(splitGuarantor('0788533370'), { name: null, phone: '0788533370' });
});

test('importOfflineQueue takes ONLY what the register needs and merges by presence', () => {
  const { records, dropped } = importOfflineQueue([OQ_HEADERS,
    ['2026-08-01', '351416739926494', 'Offline 7+', 'Jefas D Samawa', '0662047809',
      'Issack daniely samawa | 0788533370', 'Anord Sawe', 'Dar es salaam', '-',
      'He/She Will Pay', '2026-08-17', 'comment', '2026-08-17 09:41', 'AYNEA', 'atalipia'],
    // A row with NO guarantor and NO agent: those keys must be ABSENT, not null --
    // that absence is what stops an upload erasing what the register already holds.
    ['2026-08-02', '358179230370041', 'Offline 4+', 'Kapama I Mbao', '255760042887',
      '-', '', 'Lake zone', '-', '', '', '', '', '', ''],
    ['', '(no imei)', '', 'Ghost Row', '', '', '', '', '', '', '', '', '', '', ''],
  ]);
  assert.equal(records.length, 2);
  const a = records[0];
  assert.equal(a.imei, '351416739926494');
  assert.equal(a.client_name, 'Jefas D Samawa');
  assert.equal(a.client_mobile, '0662047809');
  assert.equal(a.guarantor_name, 'Issack daniely samawa');
  assert.equal(a.guarantor_phone, '0788533370');
  assert.equal(a.agent, 'Anord Sawe');
  assert.equal(a.branch, 'Dar es salaam');
  assert.equal(a.disbursed_date, '2026-08-01');
  assert.equal(a.status, undefined, 'Watu working-state columns are extra data -- not taken');
  const b = records[1];
  assert.ok(!('guarantor_name' in b) && !('guarantor_phone' in b), 'a dash guarantor stays absent');
  assert.ok(!('agent' in b), 'a blank agent cell stays absent -- never null over existing data');
  assert.equal(b.branch, 'Lake zone');
  assert.equal(dropped.length, 1, 'the IMEI-less row is dropped AND named');
  assert.equal(dropped[0].name, 'Ghost Row');
});

test('importOfflineQueue carries the sheet\'s Last Action trail as one-time comments', () => {
  const { comments } = importOfflineQueue([OQ_HEADERS,
    ['2026-08-01', '351416739926494', 'Offline 7+', 'Jefas D Samawa', '0662047809',
      'Issack | 0788', 'Anord', 'Dar', '-', 'He/She Will Pay', '2026-08-17',
      'comment', '2026-08-17 09:41', 'AYNEA POLYASI', 'atalipia ya wiki leo'],
    // Status but no note -> the status itself becomes the comment, bracketed.
    ['2026-08-02', '358179230370041', 'Offline 4+', 'Kapama I Mbao', '255760042887',
      '-', '', 'Lake zone', '-', "Doesn't Answer", '', '', '', '', ''],
    // Nothing at all -> no comment row.
    ['2026-08-03', '358179230370215', 'Offline 4+', 'Quiet Row', '255698151755',
      '-', '', '', '-', '', '', '', '', '', ''],
  ]);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].comment, 'atalipia ya wiki leo');
  assert.equal(comments[0].created_by, 'AYNEA POLYASI (Watu)');
  assert.equal(comments[0].created_at, '2026-08-17T09:41:00+03:00');
  assert.equal(comments[1].comment, "[Doesn't Answer]");
  assert.equal(comments[1].created_by, 'Watu offline queue');
  assert.equal(comments[1].created_at, null, 'no timestamp on the sheet -> the upload stamps it');
});

test('a merged company banner above the real header is recognized, never a refusal', () => {
  assert.equal(looksLikeHeader(['HOOP LTD', '', '', '', '']), false, 'a banner matches no kind');
  assert.equal(looksLikeHeader(['Aged stock report — all branches']), false);
  assert.equal(looksLikeHeader(OQ_HEADERS), true, 'the offline queue header is known');
  assert.equal(looksLikeHeader(['AGENT', 'ITEM', 'SERIAL', 'RECEIVED', 'AGE']), true, 'aged stock is known');
  assert.equal(looksLikeHeader(['Shop', 'Agent', 'IMEI', 'Client Name']), true, 'a deck header is known by its IMEI');
});
