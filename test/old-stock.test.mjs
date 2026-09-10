import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { todayKey, addDaysKey } from '../api/_lib/time.js';

/* =========================================================================================
   OLD STOCK -- what we hold, have never locked, and are going out to find.

     "For an OLD STOCK new nav pane for all those stock that imei no does not exist in our new
      enrolled phones. So we have NEW STOCK and OLD STOCK (never enrolled)."

     "They start reading with those aging days off, so everyday that goes they've not yet been
      enrolled they continue to count aging."

     "We'll conduct ground visits to all our previous agents and lock all stock we find, and
      once a stock in OLD STOCK is enrolled into our lock then it moves to list of NEW STOCK."

     "If a phone imei once reads in sales [in watu deck] and it was in old stock not in new
      stock, move its column data needed into NEW STOCK, so that we can always get the update
      of current activities no matter the stock age."

   THE AGE IS ARITHMETIC, NEVER A STORED NUMBER. `age_days` was true on `as_of`; today's age is
   that plus the days since. Re-saving an age every night would need a job somebody has to keep
   alive, and the morning it did not run the whole list would quietly understate itself.

   NOTHING MARKS A ROW AS MOVED. A handset is in OLD STOCK exactly while it is absent from the
   register and absent from the deck -- both asked at read time. A `moved` column would be a
   second opinion about a question the data already answers, and the day the two disagreed a
   phone would be on both lists or on neither.
   ========================================================================================= */
const STORE = { code: 'S1', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['oldstock', 'newstock'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['oldstock'], readOnly: true };
const OUT = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };

const TODAY = todayKey();
const D = n => addDaysKey(TODAY, n);
const old = (o = {}) => ({
  imei: o.imei, item: o.item || 'SAMSUNG A07-64GB',
  agent: o.agent === undefined ? 'ABEL MGANGA' : o.agent,
  agent_phone: o.agentPhone === undefined ? '0789473000' : o.agentPhone,
  rsm: o.rsm === undefined ? 'ANORD SAWE' : o.rsm,
  rsm_phone: '0658918324',
  age_days: o.age === undefined ? 100 : o.age,
  as_of: o.asOf || TODAY,
  source: 'SIPHO-SEPT', added_at: TODAY, updated_at: TODAY,
});
const osDb = (o = {}) => fakeDb({
  old_stock: o.stock || [], devices: o.devices || [], watu_loans: o.loans || [],
  hoop_aged_stock: o.aged || [], settings: o.settings || [],
  stock_audit: [], hoop_sales: [], hoop_agents: o.agents || [],
});

/* ---------------------------------------------------------------------------------------- */
test('the age keeps climbing for every day the handset stays un-enrolled', async () => {
  /* THE WHOLE AGEING RULE. The sheet said 100 days on the day it was made; thirty days later
     it is 130, with nothing re-uploaded and no job having run. */
  const db = osDb({ stock: [
    old({ imei: 'A1', age: 100, asOf: TODAY }),
    old({ imei: 'A2', age: 100, asOf: D(-30) }),
    old({ imei: 'A3', age: null }),
  ] });
  const d = await _FNS.oldStock(db, STORE, {});
  const by = Object.fromEntries(d.rows.map(r => [r.imei, r]));
  assert.equal(by.A1.age, 100, 'a list made today reads as it was written');
  assert.equal(by.A2.age, 130, 'and one from a month ago has aged a month');
  assert.equal(by.A2.ageStart, 100, 'the row still says what it started at, and when');
  assert.equal(by.A2.asOf, D(-30));
  /* A HANDSET WITH NO AGE IS NOT A HANDSET OF AGE ZERO. The sheet leaves some blank, and
     calling those brand new would put the oldest stock at the bottom of a worklist. */
  assert.equal(by.A3.age, null);
  assert.equal(d.counts.noAge, 1);
});

test('a locked or sold handset leaves the list by itself, with nothing to tick off', async () => {
  /* "Once a stock in OLD STOCK is enrolled into our lock then it moves to list of NEW STOCK."
     Both are asked at read time, so the two panes cannot disagree about where a phone is. */
  const db = osDb({
    stock: [old({ imei: 'STILL' }), old({ imei: 'FOUND' }), old({ imei: 'SOLD' })],
    devices: [{ imei: 'FOUND', state: 'locked' }],
    loans: [{ imei: 'SOLD', agent: 'X', disbursed_date: D(-3), price: 450000 }],
  });
  const d = await _FNS.oldStock(db, STORE, {});
  assert.deepEqual(d.rows.map(r => r.imei), ['STILL'], 'only the one still outstanding');
  /* AND THE OTHER TWO ARE COUNTED, separately. A list that only shrinks says nothing about
     WHY -- one of these we now control, the other got away and sold first. */
  assert.equal(d.counts.open, 1);
  assert.equal(d.counts.locked, 1);
  assert.equal(d.counts.sold, 1);
  assert.equal(d.counts.listed, 3, 'and the list never forgets how many it started with');

  // Nothing was written to say so: the rows are exactly as they were loaded.
  assert.equal(db._dump('old_stock').length, 3);
  assert.ok(db._dump('old_stock').every(r => !('moved' in r)));
});

test('the round is grouped by the person a visit is actually made to', async () => {
  const db = osDb({ stock: [
    old({ imei: 'A1', agent: 'ABEL MGANGA', age: 200 }),
    old({ imei: 'A2', agent: 'ABEL MGANGA', age: 40 }),
    old({ imei: 'B1', agent: 'ANOLD RUBBEN', agentPhone: '0713366666', age: 95 }),
  ] });
  const d = await _FNS.oldStock(db, STORE, {});
  /* SORTED BY THE OLDEST PIECE, not by how many: a bigger pile is a bigger van, an older pile
     is a worse problem, and the worst trip should be obvious before anybody sets off. */
  assert.deepEqual(d.byAgent.map(g => g.agent), ['ABEL MGANGA', 'ANOLD RUBBEN']);
  assert.equal(d.byAgent[0].pieces, 2);
  assert.equal(d.byAgent[0].oldest, 200);
  assert.equal(d.byAgent[0].over90, 1);
  assert.equal(d.byAgent[1].phone, '0713366666', 'with the number to ring before setting off');
  assert.equal(d.counts.holders, 2);
  // The handsets themselves open oldest first, for the same reason.
  assert.deepEqual(d.rows.map(r => r.imei), ['A1', 'B1', 'A2']);
});

test('it filters by holder, by RSM and by IMEI', async () => {
  const db = osDb({ stock: [
    old({ imei: '351929937378664', agent: 'ABEL MGANGA', rsm: 'ANORD SAWE' }),
    old({ imei: '351929937381494', agent: 'ANOLD RUBBEN', rsm: 'AYUBU BWANGA' }),
  ] });
  assert.equal((await _FNS.oldStock(db, STORE, { agent: 'abel mganga' })).rows.length, 1,
    'case-insensitively, because nobody types a register’s capitals');
  assert.equal((await _FNS.oldStock(db, STORE, { rsm: 'AYUBU BWANGA' })).rows[0].imei, '351929937381494');
  // Digits only, the same as the device search: an IMEI is digits.
  assert.equal((await _FNS.oldStock(db, STORE, { q: '378664' })).rows.length, 1);
  assert.equal((await _FNS.oldStock(db, STORE, { q: 'IMEI: 3519 2993 7381 494' })).rows.length, 1);
  // The tiles keep describing the whole outstanding list, never the filtered slice.
  assert.equal((await _FNS.oldStock(db, STORE, { agent: 'abel mganga' })).counts.open, 2);
});

test('a sale on a never-locked handset shows up in NEW STOCK', async () => {
  /* "If a phone imei once reads in sales and it was in old stock not in new stock, move its
     column data needed into NEW STOCK, so that we can always get the update of current
     activities no matter the stock age."

     A live sale filed under "never enrolled, gathering dust" is the opposite of current. */
  const db = fakeDb({
    stock_audit: [], devices: [], hoop_sales: [], hoop_aged_stock: [], hoop_agents: [],
    old_stock: [old({ imei: 'SOLD1', agent: 'ABEL MGANGA' }), old({ imei: 'QUIET' })],
    watu_loans: [{ imei: 'SOLD1', client_name: 'Alafati K Selemani', client_mobile: '255716548153',
      agent: 'Denis John', team: 'KINONDONI', shop: 'Hoop', model: 'A07', model_details: 'A07',
      disbursed_date: D(-4), price: 450000, guarantor_name: null, guarantor_phone: null, branch: 'Dar' }],
  });
  const ns = await _FNS.newStock(db, STORE, {});
  const row = ns.rows.find(r => r.imei === 'SOLD1');
  assert.ok(row, 'the sold one is on NEW STOCK even with no device row behind it');
  assert.equal(row.customer, 'Alafati K Selemani', 'with the sale stamped exactly as any other');
  assert.equal(row.price, 450000);
  /* AND IT IS NOT DRESSED AS A STATE THE REGISTER NEVER HELD. We do not control this phone and
     the pane must not imply we do. */
  assert.equal(row.neverLocked, true);
  assert.equal(row.by, '');
  assert.equal(row.seenAt, null);
  assert.equal(ns.counts.soldUnlocked, 1);
  assert.ok(!ns.rows.some(r => r.imei === 'QUIET'), 'the un-sold one stays where it is');

  // And OLD STOCK agrees, from its own side: it counts the sale rather than listing it.
  const os = await _FNS.oldStock(db, STORE, {});
  assert.deepEqual(os.rows.map(r => r.imei), ['QUIET']);
  assert.equal(os.counts.sold, 1);
});

test('the stock report’s ageing now comes from this list, newest day winning', async () => {
  /* "Use these two navs to update data of aging stock in stock reports -- not uploading aged
     stock for now." OLD STOCK ages itself to today, which is exactly why the upload can be
     switched off. A file somebody DOES paste is still read, and a newer day still wins: neither
     list is a superset of the other, and dropping the upload would throw away the one feed that
     can still correct this. */
  const db = osDb({
    stock: [old({ imei: 'A1', agent: 'ABEL MGANGA', age: 200, asOf: D(-10) }),
      old({ imei: 'A2', agent: 'ABEL MGANGA', age: 3, asOf: TODAY })],
    aged: [{ serial: 'A1', agent: 'ABEL MGANGA', item: 'A07', age_days: 5, as_of: D(-40) }],
    settings: [{ key: 'STOCK_AGING_DAYS', value: '30' }],
  });
  const rep = await _FNS.stockReqReport(db, { ...STORE, tabs: ['stockrep'] }, {});
  const g = (rep.aging.holders || []).find(h => /ABEL/i.test(h.holder));
  assert.ok(g, 'the holder is on the tracker without anybody uploading a file');
  assert.equal(g.pieces, 2);
  assert.equal(g.oldest, 210, 'aged to today: 200 as of ten days ago');
  assert.equal(g.aging, 1, 'and only the one past the threshold counts as aging');
});

test('before the migration the pane opens and names the file to run', async () => {
  const bare = fakeDb({ devices: [], watu_loans: [], hoop_aged_stock: [], settings: [],
    stock_audit: [], hoop_sales: [], hoop_agents: [] },
  { missingColumns: { old_stock: ['imei'] } });
  const d = await _FNS.oldStock(bare, STORE, {});
  assert.equal(d.notReady, true);
  assert.match(d.notReadyNote, /RUN-ME-2026-09-12-old-stock\.sql/);
  assert.equal(d.rows.length, 0);
  // And NEW STOCK does not care: no old list simply means the register alone, as before.
  assert.equal((await _FNS.newStock(bare, STORE, {})).ok, true);
});

test('a view-only code reads it, and somebody without the nav does not', async () => {
  const db = osDb({ stock: [old({ imei: 'A1' })] });
  assert.equal((await _FNS.oldStock(db, VIEWER, {})).rows.length, 1);
  await assert.rejects(() => _FNS.oldStock(db, OUT, {}), /no access to the oldstock pane/);
});

/* ---------------------------------------------------------------------------------------- */
const HTML = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
const UP = fs.readFileSync(new URL('../public/upload.html', import.meta.url), 'utf8');
const fnSrc = name => {
  const at = HTML.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is not defined in portal.html');
  return HTML.slice(at, HTML.indexOf('\n}', at) + 2);
};

test('the pane opens as a worklist: the round first, then the handsets', () => {
  const src = fnSrc('drawOldStock');
  assert.match(src, /Ziara \/ The round/, 'the per-holder board, because a visit is made to a person');
  assert.match(src, /Kongwe \/ oldest/);
  assert.match(src, /href="tel:/, 'with the number to ring before setting off');
  assert.match(src, /Simu \/ The handsets/);
  // It says the two panes hand off to each other, so nobody looks for a Done button.
  assert.match(src, /Ikifungwa au ikiuzwa, inatoka hapa yenyewe[\s\S]*takes it off this list by itself/);
  const age = fnSrc('osAge');
  assert.match(age, /tangu '\+esc\(r\.asOf/, 'and each age says what it started at, and when');
});

test('the aged-stock upload is off but not gone, and auto-detect will not route to it', () => {
  /* "Not uploading aged stock for now though; leave the uploading button and function just
     there but unclickable." */
  assert.match(UP, /data-k="agedstock" disabled/);
  assert.match(UP, /imezimwa \/ off/);
  /* A DISABLED CHIP THAT THE SNIFFER CAN STILL SELECT is a door that looks shut and is not:
     drop an aged-stock file on the page and it would upload anyway. */
  assert.ok(!/return 'agedstock';/.test(UP), 'auto-detect must not route there while it is off');
  // The parser and the endpoint are untouched behind it -- turning it back on is one attribute.
  assert.match(UP, /agedstock: \{ label: 'Aged Stock'/);
});
