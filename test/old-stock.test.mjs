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

test('our own shop’s deck moves a handset too, not just Watu’s', async () => {
  /* "So all stock that read in watu deck although in old stock moves and permanently stamps
      its appropriate column data into new stock, the other deck's columns inclusive?"

     TWO UPLOADS, ONE EVENT. watu_loans is the finance company's export and hoop_sales is our
     own shop's; a handset written in one and not the other is sold either way. Asking only the
     first left a phone sitting in OLD STOCK with a receipt against it -- listed as never
     enrolled and gathering dust, while the till had already rung it up. */
  const db = fakeDb({
    stock_audit: [], devices: [], watu_loans: [], hoop_aged_stock: [], hoop_agents: [],
    old_stock: [old({ imei: 'TILL' }), old({ imei: 'QUIET' })],
    hoop_sales: [{ imei: 'TILL', sale_date: D(-2), branch: 'Dar', agent: 'Denis John',
      client_name: 'Neema Joseph', client_phone: '0716548153', model: 'A07',
      commission_agent: 'Denis John', commission_phone: '0754000111', price: 470000 }],
  });
  const ns = await _FNS.newStock(db, STORE, {});
  const row = ns.rows.find(r => r.imei === 'TILL');
  assert.ok(row, 'the shop’s own receipt moves it');
  assert.equal(row.customer, 'Neema Joseph');
  assert.equal(row.price, 470000);
  assert.equal(row.neverLocked, true, 'still nothing we control -- only the sale moved it');

  // And OLD STOCK asks the identical question, so it is on one list, not both and not neither.
  const os = await _FNS.oldStock(db, STORE, {});
  assert.deepEqual(os.rows.map(r => r.imei), ['QUIET']);
  assert.equal(os.counts.sold, 1);
});

test('once stamped, the move is permanent -- the deck can drop the row and it stays moved', async () => {
  /* THE WORD IS "PERMANENTLY", AND THIS IS THE HALF THAT EARNS IT. The decks are re-uploaded
     over themselves with rows deleted -- that is the whole reason the sale is stamped rather
     than joined. Without this the hand-off would be a live join wearing a stamp's clothes: a
     handset that moved in September would walk back into the un-enrolled list in October
     because Watu trimmed its export, and the ground team would be sent to fetch a phone that
     was sold two months ago. */
  const first = fakeDb({
    stock_audit: [], devices: [], hoop_sales: [], hoop_aged_stock: [], hoop_agents: [],
    old_stock: [old({ imei: 'GONE' })],
    watu_loans: [{ imei: 'GONE', client_name: 'Alafati K Selemani', client_mobile: '255716548153',
      agent: 'Denis John', team: 'KINONDONI', model_details: 'A07',
      disbursed_date: D(-40), price: 450000 }],
  });
  await _FNS.newStock(first, STORE, {});
  const stamped = first._dump('stock_audit').map(r => Object.assign({}, r));
  assert.equal(stamped.length, 1, 'the sale was stamped on the way through');

  /* The next month's deck no longer mentions it. Everything else is as it was. */
  const later = fakeDb({
    stock_audit: stamped, devices: [], watu_loans: [], hoop_sales: [],
    hoop_aged_stock: [], hoop_agents: [], old_stock: [old({ imei: 'GONE' })],
  });
  const ns = await _FNS.newStock(later, STORE, {});
  const row = ns.rows.find(r => r.imei === 'GONE');
  assert.ok(row, 'still on NEW STOCK, on the strength of the stamp alone');
  assert.equal(row.customer, 'Alafati K Selemani', 'with the columns the deck has since lost');
  assert.equal(row.price, 450000);
  assert.equal(row.neverLocked, true);

  // And it does not reappear on the worklist as something still to go and find.
  const os = await _FNS.oldStock(later, STORE, {});
  assert.equal(os.rows.length, 0);
  assert.equal(os.counts.sold, 1);
});

test('a stamp with no sale on it is not a sale, and does not move anything', async () => {
  /* stock_audit holds a row for every handset the audit has ever merged -- including ones
     filled from the stock report alone, which says who was HOLDING a phone and nothing
     whatever about it being sold. Counting membership as evidence would empty OLD STOCK of
     exactly the handsets it exists to chase. A date, a buyer or a price is the test. */
  const db = fakeDb({
    devices: [], watu_loans: [], hoop_sales: [], hoop_aged_stock: [], hoop_agents: [],
    old_stock: [old({ imei: 'HELD' })],
    stock_audit: [{ imei: 'HELD', agent: 'ABEL MGANGA', rsm: 'ANORD SAWE', model: 'A07',
      customer: null, sale_date: null, price: null, src: { agent: 'hoop_aged_stock' } }],
  });
  const os = await _FNS.oldStock(db, STORE, {});
  assert.deepEqual(os.rows.map(r => r.imei), ['HELD'], 'still outstanding, still to be found');
  assert.equal(os.counts.sold, 0);
  assert.ok(!(await _FNS.newStock(db, STORE, {})).rows.some(r => r.imei === 'HELD'));

  /* A PRICE OF ZERO IS NOT A SALE EITHER -- it is the missing price this system already
     refuses to stamp anywhere else. */
  const zero = fakeDb({
    devices: [], watu_loans: [], hoop_sales: [], hoop_aged_stock: [], hoop_agents: [],
    old_stock: [old({ imei: 'HELD' })],
    stock_audit: [{ imei: 'HELD', agent: 'ABEL MGANGA', customer: '', sale_date: '', price: 0 }],
  });
  assert.deepEqual((await _FNS.oldStock(zero, STORE, {})).rows.map(r => r.imei), ['HELD']);
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

/* =========================================================================================
   THE THREE NUMBERS ON THE ROUND OPEN WHAT THEY COUNT.

     "pieces, oldest and 90+ numbers in Ziara / The round at old stock -- the nos should be
      clickable to open a list of that qty displayed in the specified cell in a row/column"

   ONE FUNCTION, ONE FLOOR, THREE CELLS. They are the same question with a different minimum
   age under it, and `oldest` needs no special case: it is the MAXIMUM age in the group, so
   asking for "at least that" returns exactly the piece the cell is naming.
   ========================================================================================= */
test('a number on the round opens the handsets behind it', async () => {
  const db = osDb({ stock: [
    old({ imei: 'P1', agent: 'ABEL MGANGA', age: 200 }),
    old({ imei: 'P2', agent: 'ABEL MGANGA', age: 95 }),
    old({ imei: 'P3', agent: 'ABEL MGANGA', age: 12 }),
    old({ imei: 'Q1', agent: 'ANOLD RUBBEN', age: 300 }),
  ] });
  const board = (await _FNS.oldStock(db, STORE, {})).byAgent;
  const abel = board.find(g => g.agent === 'ABEL MGANGA');
  assert.equal(abel.pieces, 3); assert.equal(abel.oldest, 200); assert.equal(abel.over90, 2);

  // PIECES: no floor, so all of them -- and nobody else's.
  const all = await _FNS.oldStockHolder(db, STORE, { key: abel.key, min: null });
  assert.deepEqual(all.rows.map(r => r.imei), ['P1', 'P2', 'P3'], 'oldest first, like the pane');
  assert.equal(all.shown, 3, 'the list is exactly the number that opened it');
  assert.equal(all.agent, 'ABEL MGANGA');

  // OLDEST: the floor is the figure shown, and the maximum is the only thing that clears it.
  const top = await _FNS.oldStockHolder(db, STORE, { key: abel.key, min: abel.oldest });
  assert.deepEqual(top.rows.map(r => r.imei), ['P1']);

  // 90+: the floor is ninety.
  const over = await _FNS.oldStockHolder(db, STORE, { key: abel.key, min: 90 });
  assert.deepEqual(over.rows.map(r => r.imei), ['P1', 'P2']);
  assert.equal(over.shown, abel.over90, 'the drawer and the cell cannot disagree');
});

test('the drawer ignores the pane’s filter, because the board does too', async () => {
  /* THE BOARD IS NOT FILTERED, so this must not be either. A count of three that opened a
     list of one because the pane happened to be narrowed to another RSM would be worse than
     no link at all. */
  const db = osDb({ stock: [
    old({ imei: 'R1', agent: 'ABEL MGANGA', rsm: 'ANORD SAWE', age: 200 }),
    old({ imei: 'R2', agent: 'ABEL MGANGA', rsm: 'ANORD SAWE', age: 150 }),
  ] });
  const board = (await _FNS.oldStock(db, STORE, { rsm: 'AYUBU BWANGA' })).byAgent;
  assert.equal(board[0].pieces, 2, 'the board still counts the whole round');
  const d = await _FNS.oldStockHolder(db, STORE, { key: board[0].key });
  assert.equal(d.shown, 2, 'and so does the list it opens');
});

test('a holder with no name still opens, and a sold piece is not in the list', async () => {
  /* "(hakuna jina)" is a LABEL, not a holder -- looking it up by the name on screen would
     find nobody while the count beside it says two. The group's key is what travels. */
  const db = osDb({
    stock: [
      old({ imei: 'N1', agent: null, agentPhone: null, age: 40 }),
      old({ imei: 'N2', agent: null, agentPhone: null, age: 20 }),
      old({ imei: 'N3', agent: null, agentPhone: null, age: 10 }),
    ],
    loans: [{ imei: 'N3', agent: 'X', disbursed_date: D(-2), price: 400000 }],
  });
  const board = (await _FNS.oldStock(db, STORE, {})).byAgent;
  assert.equal(board[0].key, '?', 'the unnamed group is keyed, not named');
  assert.equal(board[0].pieces, 2, 'the sold one already left the round');
  const d = await _FNS.oldStockHolder(db, STORE, { key: '?' });
  assert.deepEqual(d.rows.map(r => r.imei), ['N1', 'N2'],
    'and it is not in the list either: one index answers both');
});

test('the round exports the handsets behind it, not the summary on screen', async () => {
  /* "pieces, oldest and 90+ card should have excel button on top"

     The generic export above every table copies WHAT IS ON SCREEN, which here is five summary
     columns per holder -- and a team driving out to collect handsets needs the IMEIs. */
  const db = osDb({ stock: [
    old({ imei: 'E1', agent: 'ABEL MGANGA', age: 200 }),
    old({ imei: 'E2', agent: 'ABEL MGANGA', age: 40 }),
    old({ imei: 'F1', agent: 'ANOLD RUBBEN', age: 300 }),
    old({ imei: 'G1', agent: 'ZUHURA S', age: 10 }),
  ] });
  const d = await _FNS.oldStockRound(db, STORE, {});
  assert.equal(d.pieces, 4, 'one line per handset');
  assert.equal(d.holders, 3);
  /* WORST TRIP FIRST, the same order the board sorts by -- an older pile is a worse problem
     than a bigger one, and the file has to agree with the card that produced it. */
  assert.deepEqual(d.rows.map(r => r.imei), ['F1', 'E1', 'E2', 'G1']);
  // Every line carries its HOLDER'S totals, so the file pivots back into the board.
  const e1 = d.rows.find(r => r.imei === 'E1');
  assert.equal(e1.pieces, 2); assert.equal(e1.oldest, 200); assert.equal(e1.over90, 1);
  assert.equal(e1.agentPhone, '0789473000', 'and the number to ring before setting off');
});

test('the round export ignores the pane’s filter, because the card does', async () => {
  const db = osDb({ stock: [
    old({ imei: 'H1', agent: 'ABEL MGANGA', rsm: 'ANORD SAWE', age: 200 }),
    old({ imei: 'H2', agent: 'ABEL MGANGA', rsm: 'ANORD SAWE', age: 20 }),
  ] });
  /* A file that quietly obeyed a filter the card ignores would disagree with the number that
     produced it -- and somebody would drive out with two thirds of a list. */
  const d = await _FNS.oldStockRound(db, { ...STORE }, { rsm: 'AYUBU BWANGA', q: '999' });
  assert.equal(d.pieces, 2);
  // And a handset that has since been locked or sold is not on the round at all.
  const gone = osDb({ stock: [old({ imei: 'H1' }), old({ imei: 'H3' })],
    devices: [{ imei: 'H3', state: 'locked' }] });
  assert.deepEqual((await _FNS.oldStockRound(gone, STORE, {})).rows.map(r => r.imei), ['H1']);
});

test('the cells lead with the figure, and a zero opens nothing', () => {
  const html = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const num = html.slice(html.indexOf('function osNum_('), html.indexOf('function osHolderDrawer('));
  /* EVERY TABLE HERE SORTS ON THE CELL'S TEXT, so a number wrapped in a control has to stay a
     number FIRST. An icon or a word in front of it and the Kongwe column starts sorting
     alphabetically -- on the one board read to decide which visit goes first. */
  assert.match(num, /">'\+money\(n\)\+'<\/button>'/,
    'the button closes its tag and the figure is the whole of what is inside it');
  assert.match(num, /if\(!n\) return money\(n\|\|0\);/,
    'a zero is not a link: there is nothing behind it to open');
  assert.match(num, /text-decoration:underline/, 'and it looks like it does something');

  const draw = html.slice(html.indexOf('function drawOldStock('), html.indexOf('function osNum_('));
  for (const cell of ["osNum_(g.pieces,g.key,''", 'osNum_(g.oldest,g.key,g.oldest', 'osNum_(g.over90,g.key,90']) {
    assert.ok(draw.includes(cell), 'the round is missing: ' + cell);
  }
  assert.match(draw, /data-osh/, 'and the board wires them');

  const dr = html.slice(html.indexOf('function osHolderDrawer('), html.indexOf('function drawNewStock('));
  assert.match(dr, /srv\('oldStockHolder'/);
  assert.ok(!/drawOldStock/.test(dr), 'opening a number never redraws the pane under it');
  assert.match(dr, /Showing '\+money\(rows\.length\)\+' of '\+money\(d\.shown\)/,
    'a capped list says so rather than sitting under a heading that names the full count');
});

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
