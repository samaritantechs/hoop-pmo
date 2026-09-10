import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';

/* =========================================================================================
   NEW STOCK -- the sale behind every handset we have locked.

     "An audit of our existing imeis since we started locking on our own -- Imei, Rsm, rsm no,
      agent, agent no, customer, customer no, price, guarantor, guaranto no, status (locked,
      unlocked, achia), by (who promted that status), last read (last sync date & time), so
      that we could always sort locked and sort by sync to know our lost or stock that needs
      verification."

     "It should always read and stamp the sales first imei sales info from watu deck upload,
      since watu always omit data so when we stamp once we are done for the missing column
      info, the rest until obtained -- if watu removes sales data, we already stamped ours."

   TWO KINDS OF FACT, HANDLED IN OPPOSITE WAYS, and nearly every test here is about the line
   between them.

   THE SALE DISAPPEARS, SO IT IS STAMPED. Who bought this handset and for how much is a fact
   about a day in the past. Watu re-uploads its deck over itself with columns blank and rows
   gone; the fact does not stop being true because a spreadsheet stopped mentioning it.

   THE STATE CHANGES, SO IT IS NEVER STAMPED. Locked or not, who ordered it, when it last
   spoke -- read live, every time. A stamped status is a lie within the hour.

   Everywhere else in this system, writing down what you could derive is the mistake. The
   difference is which way the input moves: a derived TOTAL goes stale when its inputs change,
   a captured SALE goes missing when its input is deleted.
   ========================================================================================= */
const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
const STORE = { code: 'S1', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['newstock'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['newstock'], readOnly: true };
const OUT = { code: 'Z1', name: 'Mtu', role: 'OFFICER', teams: null, tabs: ['stock'], readOnly: false };

const IM = '351929937378664';
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();

const dev = (o = {}) => ({
  imei: o.imei || IM, item: o.item || 'A07', holder: 'SIPHO STORE',
  state: o.state || 'locked', state_by: o.by === undefined ? 'SIPHO' : o.by,
  state_at: o.at || hoursAgo(30), last_seen: o.seen === undefined ? hoursAgo(2) : o.seen,
  customer: o.customer || null,
});
/* The deck row as credits upload it, with the offline-queue columns merged onto it -- which is
   how this database has held them since the queue landed. */
const loan = (o = {}) => ({
  imei: o.imei || IM, client_name: o.customer === undefined ? 'Alafati K Selemani' : o.customer,
  client_mobile: o.phone === undefined ? '255716548153' : o.phone,
  agent: o.agent === undefined ? 'Denis John' : o.agent,
  team: 'KINONDONI', shop: 'Hoop Limited, Kinondoni',
  model: 'A07', model_details: o.model === undefined ? 'A07 (SM-A075F/DS)' : o.model,
  disbursed_date: o.day || '2026-07-13', price: o.price === undefined ? 450000 : o.price,
  guarantor_name: o.guarantor === undefined ? 'Issack daniely samawa' : o.guarantor,
  guarantor_phone: o.gphone === undefined ? '0788533370' : o.gphone,
  branch: 'Dar es salaam',
});
const receipt = (o = {}) => ({
  imei: o.imei || IM, sale_date: o.day || '2026-08-14', branch: 'HOOP LIMITED',
  agent: 'CYPRIAN RENATUS', client_name: o.customer || 'Fredy J Damasi',
  client_phone: o.phone || '0797053513', model: 'SAMSUNG A07-64GB',
  commission_agent: o.agent === undefined ? 'Cyprian Dotto Renatus' : o.agent,
  commission_phone: o.aphone === undefined ? '0780866571' : o.aphone,
  price: o.price === undefined ? 503000 : o.price,
});
const staff = (name, role, branch, phone) => ({ phone, name, role, branch, manager: null, active: true });

const nsDb = (o = {}) => fakeDb({
  stock_audit: o.audit || [], devices: o.devices || [dev({})],
  watu_loans: o.loans || [], hoop_sales: o.sales || [],
  hoop_agents: o.agents || [], hoop_aged_stock: o.aged || [],
}, o.opts || {});
const only = d => d.rows[0];

/* ---------------------------------------------------------------------------------------- */
test('the deck answers first, and every column the owner named lands on one row', async () => {
  const db = nsDb({
    loans: [loan({})],
    agents: [staff('SIMON MWANGASA', 'Regional_Manager', 'Dar es salaam', '0683875152'),
      staff('ATHUMANI DIANGA', 'Team_Leader', 'Dar es salaam', '0670306780'),
      staff('Denis John', 'Field_Officer', 'Dar es salaam', '0712657140')],
  });
  const r = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(r.imei, IM);
  assert.equal(r.agent, 'Denis John');
  assert.equal(r.customer, 'Alafati K Selemani');
  assert.equal(r.customerPhone, '0716548153', 'a 255-prefixed number is stored the register’s way');
  assert.equal(r.price, 450000);
  assert.equal(r.guarantor, 'Issack daniely samawa', 'the offline queue is the only feed that has one');
  assert.equal(r.guarantorPhone, '0788533370');
  /* THE RSM IS ON NO SALE FEED. Watu does not know our hierarchy, so it is walked up the staff
     register: agent -> team leader -> regional manager. */
  assert.equal(r.rsm, 'SIMON MWANGASA');
  assert.equal(r.rsmPhone, '0683875152');
  assert.equal(r.agentPhone, '0712657140', 'the staff register answers the agent’s number');

  // The state half, live off the register rather than stamped.
  assert.equal(r.status, 'locked');
  assert.equal(r.by, 'SIPHO');
  assert.ok(r.seenAt > 0 && r.silentDays === 0);
  assert.equal(r.gaps, 0, 'nothing left unanswered on this handset');
});

test('once stamped, a deck that goes blank cannot un-say it', async () => {
  /* THE WHOLE REASON THIS IS A TABLE AND NOT A JOIN. "Watu always omit data so when we stamp
     once we are done ... if watu removes sales data, we already stamped ours." */
  const db = nsDb({ loans: [loan({})] });
  await _FNS.newStock(db, STORE, {});
  const stamped = db._dump('stock_audit');
  assert.equal(stamped.length, 1);
  assert.equal(stamped[0].customer, 'Alafati K Selemani');
  assert.equal(stamped[0].src.customer, 'watu_loans', 'and it says which feed answered');

  // Watu re-uploads with the customer, the price and the guarantor gone. Or drops the row.
  db._dump('watu_loans').length = 0;
  db._dump('watu_loans').push(loan({ customer: null, phone: null, price: null,
    guarantor: null, gphone: null, agent: null }));
  const after = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(after.customer, 'Alafati K Selemani', 'the stamp holds');
  assert.equal(after.price, 450000);
  assert.equal(after.guarantor, 'Issack daniely samawa');

  db._dump('watu_loans').length = 0;                 // the row is gone from the deck entirely
  const gone = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(gone.customer, 'Alafati K Selemani', 'a deleted sale is still our sale');
  assert.equal(gone.status, 'locked', 'and the handset is still ours to watch');
});

test('a later feed fills only what the earlier one left blank', async () => {
  /* THE PRIORITY IS THE OWNER'S OWN: the deck financed the handset, the offline queue is the
     only place a guarantor was written down, then the shop book, then the staff register, then
     the stock report. Each is asked in turn and none of them may overwrite the one before. */
  const db = nsDb({
    // A deck row that knows the agent and the price and nothing about the buyer.
    loans: [loan({ customer: null, phone: null })],
    sales: [receipt({})],
  });
  const r = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(r.agent, 'Denis John', 'the deck’s agent stands: the shop book does not outrank it');
  assert.equal(r.price, 450000, 'nor its price');
  assert.equal(r.customer, 'Fredy J Damasi', 'but the blank the deck left is filled by the shop');
  assert.equal(r.customerPhone, '0797053513');
  assert.equal(r.src.agent, 'watu_loans');
  assert.equal(r.src.customer, 'hoop_sales');
  /* The shop book's payout number is the agent's, and it is the only feed carrying one when
     the staff register has never heard of them. */
  assert.equal(r.agentPhone, '0780866571');
  assert.equal(r.src.agent_phone, 'hoop_sales');
});

test('the earliest receipt is the sale, not whichever row came back first', async () => {
  /* A second receipt against the same IMEI is a top-up or a correction. "First catch" has to
     mean the first SALE, or the audit quietly re-attributes a handset to whoever touched it
     most recently. */
  const db = nsDb({ sales: [
    receipt({ day: '2026-08-20', customer: 'Wa pili', agent: 'Mtu mwingine' }),
    receipt({ day: '2026-08-14', customer: 'Wa kwanza', agent: 'Cyprian Dotto Renatus' }),
  ] });
  const r = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(r.customer, 'Wa kwanza');
  assert.equal(r.agent, 'Cyprian Dotto Renatus');
});

test('an unanswered column stays open for the upload that can finally answer it', async () => {
  /* A BLANK IS NOT A VALUE. Stamping '' or 0 would close the column for good against the feed
     that finally carries the number -- which is the opposite of what the stamp is for. */
  const db = nsDb({ loans: [loan({ customer: '  ', price: 0, guarantor: '', gphone: '' })] });
  const first = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(first.customer, '', 'whitespace is not a customer');
  assert.equal(first.price, null, 'a price of zero is a missing price, not a free handset');
  assert.ok(first.gaps > 0);
  const stamped = db._dump('stock_audit')[0];
  assert.equal(stamped.customer, null);
  assert.equal(stamped.price, null);
  assert.ok(!('customer' in stamped.src), 'and nothing claims to have answered it');

  // The next upload carries them, and now they stamp.
  db._dump('watu_loans').length = 0;
  db._dump('watu_loans').push(loan({}));
  const then = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(then.customer, 'Alafati K Selemani');
  assert.equal(then.price, 450000);
  assert.ok(then.gaps < first.gaps,
    'and the gap count falls -- which is how one number shows a feed finally arriving');
});

test('status, who ordered it and the last beat are read live and never stamped', async () => {
  const db = nsDb({ loans: [loan({})] });
  await _FNS.newStock(db, STORE, {});
  const stamped = db._dump('stock_audit')[0];
  /* THE LINE THIS PANE IS BUILT ON. Anything that CHANGES must not be captured: a stamped
     status is a lie within the hour, and this is the pane read to decide whether a handset
     needs chasing. */
  for (const k of ['status', 'state', 'by', 'state_by', 'last_seen', 'seen_at']) {
    assert.ok(!(k in stamped), k + ' must never be stamped -- it changes');
  }

  const reg = db._dump('devices');
  reg[0].state = 'released'; reg[0].state_by = 'ASHA'; reg[0].last_seen = null;
  const after = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(after.status, 'achia', 'the owner’s own word for a released handset');
  assert.equal(after.by, 'ASHA', 'and who prompted it');
  assert.equal(after.neverSeen, true);
  assert.equal(after.customer, 'Alafati K Selemani', 'while the sale is exactly where it was');

  reg[0].state = 'enrolled';
  assert.equal(only(await _FNS.newStock(db, STORE, {})).status, 'unlocked');
  /* `lost` is not one of the three words the owner used, because it is rare -- but calling it
     "locked" because that is what the handset does would hide a written-off phone inside the
     one number this audit is read for. */
  reg[0].state = 'lost';
  assert.equal(only(await _FNS.newStock(db, STORE, {})).status, 'lost');
});

test('the population is the register: a phone nobody locked is somebody else’s audit', async () => {
  const db = nsDb({
    devices: [dev({ imei: 'OURS' })],
    loans: [loan({ imei: 'OURS' }), loan({ imei: 'NEVER-LOCKED' })],
    sales: [receipt({ imei: 'SOLD-ELSEWHERE' })],
  });
  const d = await _FNS.newStock(db, STORE, {});
  assert.deepEqual(d.rows.map(r => r.imei), ['OURS'],
    '"our existing imeis since we started locking on our own"');
  assert.equal(d.counts.total, 1);
  assert.equal(db._dump('stock_audit').length, 1, 'and nothing else is stamped either');
});

test('the tiles are the three words, and the desk can narrow to one', async () => {
  const db = nsDb({ devices: [
    dev({ imei: 'A', state: 'locked', seen: hoursAgo(200) }),
    dev({ imei: 'B', state: 'enrolled' }),
    dev({ imei: 'C', state: 'released' }),
    dev({ imei: 'D', state: 'locked', seen: null }),
  ] });
  const d = await _FNS.newStock(db, ADMIN, {});
  assert.equal(d.counts.locked, 2);
  assert.equal(d.counts.unlocked, 1);
  assert.equal(d.counts.achia, 1);
  assert.equal(d.counts.never, 1);
  assert.equal(d.counts.quiet7, 1, 'A has been silent over a week');
  /* WORST FIRST: never spoken, then the longest silence. Every column still sorts on its own
     click -- that is the pane's whole purpose -- but the order it OPENS in is the order
     somebody chasing stock wants. */
  assert.deepEqual(d.rows.map(r => r.imei), ['D', 'A', 'B', 'C']);

  assert.deepEqual((await _FNS.newStock(db, ADMIN, { status: 'locked' })).rows.map(r => r.imei),
    ['D', 'A']);
  assert.equal((await _FNS.newStock(db, ADMIN, { status: 'achia' })).counts.total, 4,
    'the tiles always count the whole fleet, never the filtered slice');
});

test('the search reaches the stamped detail, not just the IMEI', async () => {
  const db = nsDb({
    devices: [dev({ imei: 'A' }), dev({ imei: 'B' })],
    loans: [loan({ imei: 'A' }), loan({ imei: 'B', customer: 'Mtu Mwingine', guarantor: 'Mdhamini B' })],
  });
  assert.deepEqual((await _FNS.newStock(db, STORE, { q: 'alafati' })).rows.map(r => r.imei), ['A'],
    'by customer, case-insensitively');
  assert.deepEqual((await _FNS.newStock(db, STORE, { q: 'Mdhamini B' })).rows.map(r => r.imei), ['B'],
    'and by guarantor -- the column a verification actually starts from');
});

test('before the migration it still computes, and says nothing is being kept', async () => {
  const db = nsDb({ loans: [loan({})], opts: { missingColumns: { stock_audit: ['imei'] } } });
  const d = await _FNS.newStock(db, STORE, {});
  assert.equal(d.notReady, true);
  assert.match(d.notReadyNote, /RUN-ME-2026-09-11-new-stock\.sql/);
  /* NOT AN EMPTY AUDIT -- an audit that cannot be SAVED. The joins underneath work perfectly
     well, so the rows are there; what is missing is the remembering, and that is the one thing
     worth saying out loud rather than showing a table that looks complete. */
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].customer, 'Alafati K Selemani');
  assert.equal(d.stamped, 0);
});

test('a feed that has never been uploaded costs its columns and nothing else', async () => {
  /* An audit that refuses to open because one upload has not happened yet is an audit nobody
     uses -- and this one is opened precisely when things are incomplete. */
  const bare = fakeDb({ stock_audit: [], devices: [dev({ customer: 'Mteja wa dukani' })] });
  const d = await _FNS.newStock(bare, STORE, {});
  assert.equal(d.ok, true);
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].agent, '');
  assert.equal(d.rows[0].customer, 'Mteja wa dukani',
    'the till’s own note stands in where no sales feed has ever mentioned this handset');
  assert.ok(d.counts.gappy > 0, 'and the pane says how much it still does not know');
});

test('a view-only code reads the audit and stamps nothing', async () => {
  const db = nsDb({ loans: [loan({})] });
  const d = await _FNS.newStock(db, VIEWER, {});
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].customer, 'Alafati K Selemani', 'it still computes the whole row');
  assert.equal(d.stamped, 0);
  assert.equal(db._dump('stock_audit').length, 0, 'but a view-only code writes nothing, as everywhere');

  // ADMIN IS FULL ACCESS EVERYWHERE WE DEVELOP -- the standing rule.
  assert.equal((await _FNS.newStock(db, ADMIN, {})).ok, true);
  await assert.rejects(() => _FNS.newStock(db, OUT, {}), /no access to the newstock pane/);
});

test('a second read with nothing new to learn writes nothing at all', async () => {
  /* The stamp is idempotent by construction -- it fills blanks -- so a pane opened twice in a
     morning must not rewrite four hundred rows to say the same thing. */
  const db = nsDb({ loans: [loan({})] });
  assert.equal((await _FNS.newStock(db, STORE, {})).stamped, 1);
  assert.equal((await _FNS.newStock(db, STORE, {})).stamped, 0);
  assert.equal((await _FNS.newStock(db, STORE, {})).stamped, 0);
  const row = db._dump('stock_audit')[0];
  assert.ok(row.first_at, 'and the row remembers when it first appeared');
  assert.equal(row.first_at, row.stamped_at, 'nothing having changed since');
});

test('a manager who sold a phone is their own RSM, and a loop costs a row not the request', async () => {
  const db = nsDb({
    loans: [loan({ agent: 'SIMON MWANGASA' })],
    agents: [staff('SIMON MWANGASA', 'Regional_Manager', 'SOUTHERN HIGHLAND', '0683875152')],
  });
  assert.equal(only(await _FNS.newStock(db, STORE, {})).rsm, 'SIMON MWANGASA',
    'the honest answer, rather than climbing past them to somebody else');

  /* Two people naming each other is a typo the register can contain, and the walk must not
     take the server with it. salesTree already refuses a "manager" who is not ABOVE you, so
     this is belt and braces on the walk itself. */
  const loopy = nsDb({
    loans: [loan({ agent: 'A MOJA' })],
    agents: [{ ...staff('A MOJA', 'Field_Officer', 'X', '0700000001'), manager: 'B MBILI' },
      { ...staff('B MBILI', 'Field_Officer', 'X', '0700000002'), manager: 'A MOJA' }],
  });
  const r = only(await _FNS.newStock(loopy, STORE, {}));
  assert.equal(r.rsm, '', 'no regional manager exists above them, so the column stays open');
});

/* ---------------------------------------------------------------------------------------- */
import fs from 'node:fs';
const HTML = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
const fnSrc = name => {
  const at = HTML.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is not defined in portal.html');
  return HTML.slice(at, HTML.indexOf('\n}', at) + 2);
};

test('the pane is the owner’s column list, in the owner’s order', () => {
  const src = fnSrc('drawNewStock');
  /* THE COLUMNS WERE DICTATED, so they are asserted as dictated -- in order, because the order
     is how somebody reads a row aloud to the person they are chasing. */
  /* THE NUMBERS MOVED UNDER THE NAMES, so four pairs of columns became four columns:
       "We could put agent and customer numbers under their names in the single double rowed row
        in name columns to reduce lengths."
     Every field the owner named is still on the row -- the table is narrower, not smaller. */
  const want = ['IMEI', 'Tarehe / disb date', 'RSM', 'Ajenti / agent', 'Mteja / customer',
    'Bei / price', 'Mdhamini / guarantor', 'Hali / status', 'Nani / by',
    'Iliongea lini / last read'];
  let at = 0;
  for (const h of want) {
    // Matched on the header's opening rather than the whole cell: Hali carries a second line
    // naming the location that rides under it, and that is a caption, not a fourteenth column.
    const i = src.indexOf('<th>' + h, at);
    assert.ok(i > 0, 'the "' + h + '" column is missing from the table');
    at = i;
  }
  /* EVERY TABLE ON THIS PAGE SORTS ITSELF on a header click, which is the entire ask -- "so
     that we could always sort locked and sort by sync". That is a delegated handler on <th>,
     so the only thing this pane owes it is a real <thead>. */
  assert.match(src, /<thead><tr>/);
});

test('the silence leads its cell, so the column sorts by it', () => {
  /* "Sort by sync to know our lost or stock that needs verification." A cell that leads with a
     timestamp sorts alphabetically by clock face, which is not an answer to anything. The days
     go first and the timestamp underneath, so the sort means what the reader thinks it means --
     and a handset that has never spoken sorts above every silence that has an end. */
  const src = fnSrc('drawNewStock');
  const cell = src.slice(src.indexOf('var last=r.neverSeen'), src.indexOf('return \'<tr>'));
  assert.match(cell, /hajawahi/, 'never-spoken is named rather than shown as a blank');
  assert.ok(cell.indexOf('r.silentDays') < cell.indexOf('clock(r.seenAt)'),
    'the days come before the clock, or the column sorts by the time of day');
});

test('the stamp is invisible, so the pane says it happened', () => {
  /* Opening this pane captures whatever the feeds can answer, for good. Nobody would guess
     that from a table, and on the morning after a Watu upload the number of columns just
     captured IS the point of opening it. */
  const src = fnSrc('drawNewStock');
  assert.match(src, /d\.stamped\?/, 'the count of what was just stamped is on screen');
  assert.match(src, /c\.gappy/, 'and how much is still unanswered, which should fall each upload');
  // The two halves are explained where somebody will read them, not only in the docs.
  assert.match(src, /hupigwa muhuri[\s\S]*stamped the first time/);
  assert.match(src, /husomwa moja kwa moja[\s\S]*read live/);
});

test('the number sits under the name, and the feed moves to the tooltip', () => {
  /* "Replace the brand/Co.-reader under the names there, e.g. watu_loans into 0756749261."
     The space under a name was being spent on which feed filled it. The phone answers "who do
     I ring", which is what this pane is open for; the feed answers "where did this come from",
     which is asked of one cell occasionally -- so it moves to the title, not off the page. */
  const cell = fnSrc('nsCell');
  assert.match(cell, /phone\?'<div class="mut"[^']*<a href="tel:/,
    'the number is drawn under the name, and it is a call');
  assert.match(cell, /from\?' title="'\+esc\(from\)/, 'the feed is still recoverable, in the tooltip');
  assert.ok(!/<div class="mut" style="font-size:9\.5px">'\+esc\(from\)/.test(cell),
    'but it no longer occupies the line the number needs');
  assert.match(cell, /—/, 'an unanswered column reads as unanswered, never as an empty cell');

  // And the row passes name and phone together, so one cell carries both.
  const src = fnSrc('drawNewStock');
  for (const pair of ['r.rsm,r.rsmPhone', 'r.agent,r.agentPhone', 'r.customer,r.customerPhone',
    'r.guarantor,r.guarantorPhone']) {
    assert.ok(src.includes('nsCell(' + pair), 'missing paired cell: ' + pair);
  }
});

/* ---------------------------------------------------------------------------------------- */
test('the last ping’s coordinates ride under the status, and survive Achia', async () => {
  /* "Add the second in one [location coordinate link] so that we can click to view where the
     phone is... so even if achia we'll always find the latest ping coordinate location."

     THE STAMPING WAS ALREADY HAPPENING -- every beat writes the handset's last known position.
     What matters here is that RELEASING one does not erase it: a phone let go is a phone
     nobody is tracking any more, and its final fix is all that is left of it. */
  const withLoc = { ...dev({ imei: 'D1', state: 'locked' }),
    last_lat: -6.7924, last_lng: 39.2083, last_loc_acc: 25, last_loc_at: hoursAgo(5) };
  const db = fakeDb({ stock_audit: [], devices: [withLoc], watu_loans: [], hoop_sales: [],
    hoop_agents: [], hoop_aged_stock: [] });
  const r = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(r.lat, -6.7924);
  assert.equal(r.lng, 39.2083);
  assert.equal(r.locAcc, 25);
  assert.ok(r.locAt > 0);

  // Now let it go. deviceSetState writes state, reason, who and when -- and nothing else.
  await _FNS.deviceSetState(db, { code: 'G', name: 'ASHA', role: 'GENERAL DUTY', teams: null,
    tabs: ['devunlock'], readOnly: false }, { imeis: ['D1'], state: 'released' });
  const after = only(await _FNS.newStock(db, STORE, {}));
  assert.equal(after.status, 'achia');
  assert.equal(after.lat, -6.7924, 'the last place it was seen outlives the release');
  assert.equal(after.lng, 39.2083);
  assert.equal(after.locAcc, 25);
});

test('the fix has its own age, and a handset that never sent one says so', async () => {
  /* The phone reports its LAST KNOWN position rather than waking the GPS on every beat, so the
     two timestamps must never be collapsed: one that beat a minute ago can be carrying a fix
     from Tuesday. */
  const db = fakeDb({ stock_audit: [],
    devices: [{ ...dev({ imei: 'OLDFIX', seen: hoursAgo(1) }),
      last_lat: -6.79, last_lng: 39.2, last_loc_acc: 1800, last_loc_at: hoursAgo(72) },
    dev({ imei: 'NOFIX' })],
    watu_loans: [], hoop_sales: [], hoop_agents: [], hoop_aged_stock: [] });
  const d = await _FNS.newStock(db, STORE, {});
  const by = Object.fromEntries(d.rows.map(r => [r.imei, r]));
  assert.ok(by.OLDFIX.locAt < by.OLDFIX.seenAt,
    'the fix is older than the beat that carried it, and the row keeps both');
  assert.equal(by.NOFIX.lat, null);
  assert.equal(by.NOFIX.locAt, null);
  assert.equal(d.hasLoc, true);
});

test('before the location migration the audit still opens', async () => {
  /* PostgREST refuses a whole select over one unknown column. Naming last_lat on a deployment
     that has not run that migration would take the entire audit dark over a column nobody had
     asked for last week. */
  const db = fakeDb({ stock_audit: [], devices: [dev({})], watu_loans: [], hoop_sales: [],
    hoop_agents: [], hoop_aged_stock: [] },
  { missingColumns: { devices: ['last_lat', 'last_lng', 'last_loc_acc', 'last_loc_at'] } });
  const d = await _FNS.newStock(db, STORE, {});
  assert.equal(d.ok, true);
  assert.equal(d.hasLoc, false, 'and it says the map is not available rather than showing blanks');
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].lat, null);
});

test('the coordinate is a link, with its accuracy and never a bare pin', () => {
  const fn = fnSrc('nsWhere');
  assert.match(fn, /google\.com\/maps\?q=/);
  assert.match(fn, /encodeURIComponent/, 'a coordinate is put in a URL, so it is encoded for one');
  assert.match(fn, /target="_blank" rel="noopener"/);
  /* A 2,000m fix is a suburb, not an address. Drawing it as a pin with no radius is how
     somebody drives to the wrong building, so a vague one is marked as vague. */
  assert.match(fn, /r\.locAcc>500/);
  assert.match(fn, /±/);
  // The age shown is the FIX's, not the beat's -- collapsing them is the lie this avoids.
  assert.match(fn, /r\.locAt/);
  assert.ok(!/r\.seenAt/.test(fn), 'the beat’s time must not stand in for the fix’s');
  assert.match(fn, /hakuna eneo \/ no location/, 'no fix reads as no fix, never as an empty cell');
});

test('a missing location column never reads as a missing register', async () => {
  /* THE BUG THIS PINS. tableMissing() matches a missing COLUMN as well as a missing table --
     deliberately, because for most callers both mean "run the migration". Asked before the
     location check, it answered an absent `last_lat` with "the devices register does not
     exist", offering the wrong migration on the pane somebody opens when stock has gone
     missing. Both panes that read the position now ask the narrower question first. */
  const opts = { missingColumns: { devices: ['last_lat', 'last_lng', 'last_loc_acc', 'last_loc_at'] } };
  const db = fakeDb({ stock_audit: [], devices: [dev({})], watu_loans: [], hoop_sales: [],
    hoop_agents: [], hoop_aged_stock: [], device_events: [], settings: [] }, opts);
  const ns = await _FNS.newStock(db, STORE, {});
  assert.equal(ns.noDevices, false, 'the register is plainly there: it just has no map columns');
  assert.equal(ns.hasLoc, false);
  assert.equal(ns.rows.length, 1);

  // The devices pane itself had the same ordering, and the same false alarm.
  const LOCKER = { code: 'S9', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['devlock'], readOnly: false };
  const dl = await _FNS.deviceList(db, LOCKER, {});
  assert.ok(!dl.notReady, 'the whole Devices pane must not go dark over one absent column');
  assert.equal(dl.rows.length, 1);
});

/* =========================================================================================
   NEW SALES -- the week, the month, and who is carrying them.

     "Add NEW SALES widgets at top of weekly and monthly progress showing 3: 1-no of agents,
      2-no of customers, 3-price. And another card showing top and bottom agent at once as
      weekly progress 3x2: 1-agent name, 2-no of sales, 3-price."

   COUNTED FROM THIS PANE'S OWN STAMPED ROWS, so the widget and the table under it can never
   disagree. A card reading the deck directly would count phones this audit has never heard of.
   ========================================================================================= */
import { todayKey, addDaysKey, weekMondayKey } from '../api/_lib/time.js';
const TODAY = todayKey();
const WEEK = weekMondayKey();
const MONTH1 = TODAY.slice(0, 7) + '-01';
/** A locked handset whose sale is already stamped, so the widget has something to count. */
const sold = (imei, agent, day, price, cust) => ({
  imei, rsm: null, rsm_phone: null, agent, agent_phone: null,
  customer: cust || ('Mteja ' + imei), customer_phone: cust ? null : '07120000' + String(imei).slice(-2),
  price, guarantor: null, guarantor_phone: null, branch: null, model: 'A07',
  sale_date: day, src: {}, first_at: '2026-09-01T00:00:00Z', stamped_at: '2026-09-01T00:00:00Z',
});
const salesDb = audit => fakeDb({
  stock_audit: audit,
  devices: audit.map(a => dev({ imei: a.imei })),
  watu_loans: [], hoop_sales: [], hoop_agents: [], hoop_aged_stock: [],
});

test('the week and the month each answer the three numbers asked for', async () => {
  const db = salesDb([
    sold('A1', 'JUMA G', TODAY, 450000),
    sold('A2', 'JUMA G', WEEK, 500000),
    sold('A3', 'ASHA M', TODAY, 300000),
    // Earlier in the month but before this week: counts in the month, not in the week.
    sold('A4', 'ELIA C', MONTH1, 200000),
    // Last year: neither.
    sold('A5', 'ELIA C', '2025-01-05', 999000),
  ]);
  const ns = (await _FNS.newStock(db, STORE, {})).newSales;
  assert.equal(ns.week.agents, 2, 'JUMA and ASHA sold this week');
  assert.equal(ns.week.customers, 3);
  assert.equal(ns.week.amount, 1250000);
  assert.equal(ns.week.sales, 3);
  assert.equal(ns.week.from, WEEK);
  assert.equal(ns.week.to, TODAY, 'and the period is on the card, so the figure can be checked');

  assert.ok(ns.month.agents >= ns.week.agents);
  assert.equal(ns.month.from, MONTH1);
  // Last year's sale is in neither window.
  assert.ok(ns.month.amount < 999000 + 1250000);
});

test('a customer is a phone number where there is one', async () => {
  /* Two receipts spelling a name differently are one buyer; two buyers can share a name. The
     number is the identity wherever a feed gave one. */
  const one = { ...sold('B1', 'JUMA G', TODAY, 100000), customer: 'Alafati Selemani', customer_phone: '0716548153' };
  const same = { ...sold('B2', 'JUMA G', TODAY, 100000), customer: 'ALAFATI K SELEMANI', customer_phone: '0716548153' };
  const db = salesDb([one, same]);
  const ns = (await _FNS.newStock(db, STORE, {})).newSales;
  assert.equal(ns.week.customers, 1, 'one number, one buyer, however the name was typed');
  assert.equal(ns.week.sales, 2, 'but two handsets');
});

test('top and bottom are the highest and lowest who SOLD, and it says how many it ranked', async () => {
  const db = salesDb([
    sold('C1', 'JUMA G', TODAY, 500000), sold('C2', 'JUMA G', TODAY, 500000),
    sold('C3', 'JUMA G', TODAY, 500000),
    sold('C4', 'ASHA M', TODAY, 400000), sold('C5', 'ASHA M', TODAY, 400000),
    sold('C6', 'ELIA C', TODAY, 100000),
  ]);
  const ns = (await _FNS.newStock(db, STORE, {})).newSales;
  assert.equal(ns.top.name, 'JUMA G');
  assert.equal(ns.top.sales, 3);
  assert.equal(ns.top.amount, 1500000);
  assert.equal(ns.bottom.name, 'ELIA C');
  assert.equal(ns.bottom.sales, 1);
  assert.equal(ns.bottom.amount, 100000);
  /* THE BOTTOM IS THE LOWEST WHO SOLD, never the highest who did not -- somebody who sold
     nothing is not on these rows at all, so the card says the size of what it ranked. */
  assert.equal(ns.ranked, 3);
});

test('one seller is not two rows, and no sales is not a top of nobody', async () => {
  const one = salesDb([sold('D1', 'JUMA G', TODAY, 500000)]);
  const ns1 = (await _FNS.newStock(one, STORE, {})).newSales;
  assert.equal(ns1.top.name, 'JUMA G');
  assert.equal(ns1.bottom, null, 'printing the same person twice would read as two facts');
  assert.equal(ns1.ranked, 1);

  const none = salesDb([sold('D2', 'JUMA G', '2025-01-05', 500000)]);
  const ns0 = (await _FNS.newStock(none, STORE, {})).newSales;
  assert.equal(ns0.top, null);
  assert.equal(ns0.ranked, 0);
  assert.equal(ns0.week.amount, 0);
});

test('a sale nobody is named for counts in the totals but ranks nobody', async () => {
  /* A total that does not match the board is a total nobody trusts, so the handset still
     counts -- but it cannot make an empty name the week's top agent. */
  const db = salesDb([
    { ...sold('E1', 'JUMA G', TODAY, 500000) },
    { ...sold('E2', null, TODAY, 700000), agent: null },
  ]);
  const ns = (await _FNS.newStock(db, STORE, {})).newSales;
  assert.equal(ns.week.sales, 2);
  assert.equal(ns.week.amount, 1200000, 'both handsets are in the money');
  assert.equal(ns.week.agents, 1, 'but only one agent is named');
  assert.equal(ns.ranked, 1);
  assert.equal(ns.top.name, 'JUMA G');
});

test('the pane opens on the three cards, and the date column sorts as a date', () => {
  const src = fnSrc('drawNewStock');
  assert.match(src, /nsThree\('NEW SALES · wiki hii/);
  assert.match(src, /nsThree\('NEW SALES · mwezi huu/);
  assert.match(src, /nsTopBottom\(ns\)/);
  // They wrap to one column on a phone rather than forcing the page sideways.
  assert.match(src, /minmax\(240px,1fr\)/);

  /* SORTABLE BY DATE IS THE WHOLE ASK, so the cell prints the day AS STORED: an ISO day sorts
     as text exactly the way it sorts as a date, and prettifying it to "13 Jul" would put
     August above July on every click. */
  assert.match(src, /<th>Tarehe \/ disb date<\/th>/);
  assert.match(src, /r\.saleDate\?esc\(r\.saleDate\)/);

  const three = fnSrc('nsThree');
  for (const lab of ['Maajenti / agents', 'Wateja / customers', 'Thamani / price']) {
    assert.ok(three.includes(lab), 'the card is missing "' + lab + '"');
  }
  assert.match(three, /repeat\(3,1fr\)/, 'three across, as asked');

  const tb = fnSrc('nsTopBottom');
  assert.match(tb, /JUU/); assert.match(tb, /CHINI/);
  assert.match(tb, /1\.4fr 1fr 1fr/, 'name, count, value -- three columns, two rows');
  assert.match(tb, /Only one agent has sold this week/);
  assert.match(tb, /agents who sold this week/, 'it never claims to have ranked the whole company');
});

test('the daily board prints the amount, instead of hiding it in a tooltip', () => {
  /* "Daily sales performance progress is showing QTY without amounts."
     The value was always there -- in `title`, which needs a mouse. The pane is read on a
     handset, where a tooltip is nothing at all. */
  const src = fnSrc('salesRender');
  const cell = src.slice(src.indexOf('var cell=function(c)'), src.indexOf('body=\'<div class="scroll">'));
  assert.match(cell, /money\(c\.count\)/);
  assert.match(cell, /money\(c\.amount\)[\s\S]{0,40}<\/div><\/td>/,
    'the value is drawn in the cell, under the count');
  assert.match(cell, /title="'\+money\(c\.amount\)/, 'and the tooltip stays: it costs nothing');
  // The totals row answers the same question in the same two numbers.
  assert.match(src, /money\(colA\[dd\]\)\+'<\/div>'/);
  // The legend no longer tells somebody to hover for a number that is now printed.
  assert.ok(!/gusa\/weka kishale/.test(src));
  assert.match(src, /handsets on top, value in TZS underneath/);
});

test('the agents who sold nothing are counted, and never ranked', async () => {
  /* THE BOTTOM CARD WAS HIDING THE PEOPLE IT IS READ FOR. These rows are sales, so an agent
     with none of them is not in them -- and a card ranking only sellers can name somebody with
     one sale as the week's bottom while three others sold nothing at all.

     They are COUNTED and a few are NAMED, never ranked: they are all equally bottom, and
     picking one of several zeros as "the worst performer of the week" is an arbitrary
     accusation a screen should not make. */
  const db = fakeDb({
    stock_audit: [sold('F1', 'JUMA G', TODAY, 500000), sold('F2', 'ELIA C', TODAY, 100000)],
    devices: [dev({ imei: 'F1' }), dev({ imei: 'F2' })],
    watu_loans: [], hoop_sales: [], hoop_aged_stock: [],
    hoop_agents: [
      staff('JUMA G', 'Field_Officer', 'Dar es salaam', '0700000001'),
      staff('ELIA C', 'Field_Officer', 'Dar es salaam', '0700000002'),
      staff('ASHA M', 'Field_Officer', 'Dar es salaam', '0700000003'),
      staff('NEEMA K', 'Field_Officer', 'Dar es salaam', '0700000004'),
      // A team leader is not an agent, and a former agent is not this week's problem.
      staff('ATHUMANI D', 'Team_Leader', 'Dar es salaam', '0700000005'),
      { ...staff('MSTAAFU X', 'Field_Officer', 'Dar es salaam', '0700000006'), active: false },
    ],
  });
  const ns = (await _FNS.newStock(db, STORE, {})).newSales;
  assert.equal(ns.top.name, 'JUMA G');
  assert.equal(ns.bottom.name, 'ELIA C', 'the lowest who sold is still a definite answer');
  assert.equal(ns.idle, 2, 'ASHA and NEEMA sold nothing at all');
  assert.deepEqual(ns.idleNames.sort(), ['ASHA M', 'NEEMA K'],
    'named, so the number is a list somebody can act on');
  assert.ok(!ns.idleNames.includes('ATHUMANI D'), 'a team leader is not one of the agents');
  assert.ok(!ns.idleNames.includes('MSTAAFU X'), 'nor is somebody who has left');
});

test('the card says who sold nothing, and does not rank them', () => {
  const tb = fnSrc('nsTopBottom');
  assert.match(tb, /ns\.idle/);
  assert.match(tb, /hawajauza kabisa wiki hii/);
  assert.match(tb, /sold nothing at all this week/);
  assert.match(tb, /ns\.idleNames/, 'a few names, so the number can be acted on');
  // It is a note, not a third ranked row: they are all equally bottom.
  assert.ok(!/CHINI[\s\S]{0,80}idle/.test(tb));
});
