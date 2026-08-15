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
