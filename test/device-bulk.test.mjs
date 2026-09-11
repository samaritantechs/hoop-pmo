import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';

/* =========================================================================================
   ACHIA BELONGS TO THE UNLOCKING DESK, AND IT TAKES A LIST.

     "now the unlocking needs the achia button - it shouldnt be at locking"

     "on top at 3 buttons [Zilizochaguliwa: 0 / Fungua / Unlock / Achia / Release] add the 4th
      on the right 'Release/Achia Bulk' so that the general duty can paste a list of imeis as
      we paste at enrolling bulk, but now general duty paste them to release many at once since
      sales are many they cant just tick one by one imei so they paste a list of verified sales
      imeis and release at once"

   TWO HALVES OF ONE COMPLAINT. The split shipped on the bulk bar and stopped there: the
   per-row drawer, which only ever opens on the LOCKING bench, went on offering all four
   orders. The server refused them -- that part was never in doubt -- but a button whose only
   possible answer is a 403 is a screen teaching the operator that the system is broken.

   And the way the POS desk actually works at the end of a day is a LIST: verified sales come
   out of somewhere else entirely, and turning that list into ticks means hunting each IMEI
   through a register of hundreds with a customer's handset riding on every click.

   TICKING AND PASTING ARE DIFFERENT INPUTS, so the fourth button is deliberately apart from
   the other three rather than beside them.
   ========================================================================================= */
const STORE = { code: 'ST', name: 'SIPHO', role: 'STORE', teams: null, tabs: ['devlock'], readOnly: false };
const DUTY = { code: 'GD', name: 'ASHA', role: 'GENERAL DUTY', teams: null, tabs: ['devunlock'], readOnly: false };

const dev = (o = {}) => ({
  imei: o.imei, item: 'A07', holder: 'SIPHO STORE',
  state: o.state || 'enrolled', state_reason: null, state_by: null, state_at: null,
  reported: null, last_seen: o.seen || null, released_at: o.released || null,
  enrol_token: 'tok-' + o.imei, enrolled_at: '2026-08-01T08:00:00Z', updated_at: '2026-08-01T08:00:00Z',
});
const devDb = rows => fakeDb({ devices: rows, device_events: [], settings: [] });
const stateOf = async (db, imei) => (await db.from('devices').select('*')).data.find(r => r.imei === imei).state;

const HTML = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
/** The source of one top-level page function, so a claim about the screen is made against the
    screen rather than against a memory of it. */
function src(name) {
  const at = HTML.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is not defined in portal.html any more');
  return HTML.slice(at, HTML.indexOf('\n}', at) + 2);
}
/* Lift a page function and RUN it, with just enough of the page around it to answer. A test
   that only greps for a button string cannot tell a button that is drawn from one that is
   merely written down. */
const DEPS = mode => `
  var DEVMODE=${JSON.stringify(mode)};
  var OUT={html:'', acted:[]};
  function drawer(h){ OUT.html=h; }
  function closeDrawer(){ OUT.closed=true; }
  function esc(s){ return String(s==null?'':s); }
  function money(n){ return String(n); }
  function agoMins(n){ return n==null?'':n+'m'; }
  function clock(t){ return t?String(t):''; }
  function toast(m,bad){ OUT.toast=[m,!!bad]; }
  function $(){ return null; }
  function $all(){ return []; }
  function devAct_(m,imeis,state){ OUT.acted.push([imeis,state]); return true; }
`;
function run(name, mode) {
  const body = src(name);
  return new Function(DEPS(mode) + body + '\nreturn { fn: ' + name + ', out: OUT };')();
}

/* ---------------------------------------------------------------------------------------- */
test('a pasted list releases many at once, and the strangers come back by name', async () => {
  const db = devDb([
    dev({ imei: 'D1', state: 'locked' }), dev({ imei: 'D2', state: 'locked' }),
    dev({ imei: 'D3', state: 'released', released: '2026-09-01T08:00:00Z' }),
  ]);
  /* The list is not the table: nothing here was ticked, and two of these IMEIs came off a
     sales sheet with a typo in one and a handset that was never enrolled in the other. */
  const r = await _FNS.deviceSetState(db, DUTY, {
    imeis: ['D1', 'D2', 'D3', 'GHOST', 'TYPO'], state: 'released',
  });
  assert.equal(r.changed, 2, 'the two that were locked are let go');
  assert.equal(r.alreadyThere, 1, 'the one already released is not counted as work done');
  assert.equal(r.notEnrolled, 2);
  /* THE NAMES, NOT THE COUNT. "2 hazijasajiliwa" against a paste of eighty is the operator's
     problem restated: they would have to re-paste in batches to find which two. */
  assert.deepEqual(r.notEnrolledList.sort(), ['GHOST', 'TYPO']);
  assert.equal(await stateOf(db, 'D1'), 'released');
  assert.equal(await stateOf(db, 'D2'), 'released');
});

test('a pasted list locks a whole consignment, no reason needed', async () => {
  /* "as achia has bulk and enroll has bulk lock need bulk too at locking" -- the bench already
     pastes to enrol a batch, and locking that same batch was the one step still asking for
     four hundred clicks. */
  const db = devDb([
    dev({ imei: 'D1' }), dev({ imei: 'D2' }), dev({ imei: 'D3', state: 'locked' }),
  ]);
  const r = await _FNS.deviceSetState(db, STORE, {
    imeis: ['D1', 'D2', 'D3', 'GHOST'], state: 'locked',
  });
  assert.equal(r.changed, 2);
  assert.equal(r.alreadyThere, 1, 'one was already shut');
  assert.deepEqual(r.notEnrolledList, ['GHOST']);
  assert.equal(await stateOf(db, 'D1'), 'locked');
});

test('the paste is still each desk’s own order, however long the list is', async () => {
  const db = devDb([dev({ imei: 'D1', state: 'locked' })]);
  /* The gate is on the TRANSITION, so pasting instead of ticking changes nothing about who may
     give the order -- curl does not read HTML, and neither does a textarea. A store bench that
     could paste its way to a release would be the whole nav split undone by one form. */
  await assert.rejects(() => _FNS.deviceSetState(db, STORE, { imeis: ['D1'], state: 'released' }),
    /no access to the devunlock pane/);
  await assert.rejects(() => _FNS.deviceSetState(db, DUTY, { imeis: ['D1'], state: 'locked' }),
    /no access to the devlock pane/);
  assert.equal(await stateOf(db, 'D1'), 'locked');
});

test('the ceiling is the one enrolment already has, and a full table still fits under it', async () => {
  const db = devDb([dev({ imei: 'D1', state: 'locked' })]);
  const many = n => Array.from({ length: n }, (_, i) => 'IM' + i);
  /* Every IMEI rides in an `in(...)` filter, which travels as a query string. Past a few
     hundred the URL is refused somewhere between here and the database and what comes back is
     a transport error, not an answer about phones -- so the limit is stated as a sentence
     about phones instead. A paste is no longer bounded by what fits on a screen. */
  await assert.rejects(() => _FNS.deviceSetState(db, DUTY, { imeis: many(501), state: 'released' }),
    /kikomo 500|500 max/);
  // And 500 exactly is fine: deviceList shows 500 rows, so tick-all on a full table must pass.
  const ok = await _FNS.deviceSetState(db, DUTY, { imeis: many(500), state: 'released' });
  assert.equal(ok.notEnrolled, 500, 'none of those exist, but the ceiling did not stop the ask');
});

test('the paste is split the way a person pastes, and nothing is repaired', () => {
  const parse = run('devParseImeis_', 'unlock').fn;
  /* Newlines, tabs, commas and semicolons all separate; Excel's quotes are noise around a
     token, never part of one. */
  const a = parse('351388334583295\r\n\t351388334583296, 351388334583297;351388334583298');
  assert.deepEqual(a.list, ['351388334583295', '351388334583296', '351388334583297', '351388334583298']);
  assert.deepEqual(parse('"351388334583295"\n\'351388334583296\'').list,
    ['351388334583295', '351388334583296'], 'a quoted text cell is the IMEI inside it');

  // Two lists pasted over each other is worth SEEING before the one-way door, not silently tidied.
  const dup = parse('D1\nD2\nD1\nD1');
  assert.deepEqual(dup.list, ['D1', 'D2']);
  assert.equal(dup.dupes, 2);

  /* AND NOTHING IS REPAIRED. Stripping the stray character out of `35138-8334583295` would
     produce a shorter number that looks exactly as valid as a real IMEI -- and this list ends
     in an order that cannot be taken back. It goes to the register as typed, and the register
     answers by name. */
  assert.deepEqual(parse('35138-8334583295').list, ['35138-8334583295']);
  assert.deepEqual(parse('  \n\t ').list, [], 'whitespace is not an IMEI');
  assert.deepEqual(parse('').list, []);
  // An IMEI that happens to spell a property of Object.prototype is an IMEI like any other.
  assert.deepEqual(parse('constructor\ntoString\nconstructor').list, ['constructor', 'toString']);
});

test('the row panel offers what THIS desk holds, on both benches', () => {
  const row = { imei: 'D1', state: 'locked', item: 'A07', holder: 'SIPHO', silentMins: 30 };
  const d = { rows: [row] };

  const lock = run('devLockOne', 'lock');
  lock.fn({}, d, 'D1');
  assert.match(lock.out.html, /data-dvs1="locked"/, 'the store bench locks');
  assert.match(lock.out.html, /data-dvs1="lost"/, 'and writes off');
  /* THE REGRESSION THE OWNER FOUND. These two were drawn here for the store keeper and the
     only thing behind them was the server's refusal. */
  assert.ok(!/data-dvs1="released"/.test(lock.out.html), 'Achia is not the locking bench’s order');
  assert.ok(!/data-dvs1="enrolled"/.test(lock.out.html), 'nor is Fungua');

  const open = run('devLockOne', 'unlock');
  open.fn({}, d, 'D1');
  assert.match(open.out.html, /data-dvs1="enrolled"/, 'the POS desk opens');
  assert.match(open.out.html, /data-dvs1="released"/, 'and releases');
  assert.ok(!/data-dvs1="locked"/.test(open.out.html), 'and is not offered the locking order');
  assert.ok(!/data-dvs1="lost"/.test(open.out.html), 'nor stock accountability’s');

  /* Both panels still open on the same handset's facts -- the split decides which ORDERS are
     offered, never what either desk is allowed to know about a phone. */
  for (const o of [lock.out.html, open.out.html]) assert.match(o, /D1/);
});

test('the bulk bar is partitioned by the same one word', () => {
  /* devPaint_ carries tiles, chips, a table and five hundred rows, so this half is read rather
     than run -- but it is read as a PARTITION: the locking pair and the unlocking pair have to
     sit on opposite sides of the same colon. `[^:]` is the anchor; a stray Achia added to the
     locking branch lands on the wrong side of it and the match fails. */
  assert.match(src('devPaint_'),
    /canLock\s*\?[^:]*data-dvs="locked"[^:]*data-dvs="lost"[^:]*:[^:]*data-dvs="enrolled"[^:]*data-dvs="released"/,
    'Funga and Imepotea on one side, Fungua and Achia on the other');
});

test('the last button takes the list, and never the ticks', () => {
  const bar = src('devPaint_');
  assert.match(bar, /BOOT\.readOnly \? ''/, 'a view-only code is offered nothing');
  /* BOTH DESKS WORK FROM LISTS, so both get one -- and each gets only its own order. A store
     bench that could paste its way to a release would be the nav split undone by a textarea. */
  assert.match(bar, /data-dvbulk="'\+\(canLock\?'locked':'released'\)\+'"/);
  assert.match(bar, /canLock\?'Funga kwa wingi[^']*':'Achia kwa wingi/);
  /* Pushed away from the others, because it does not act on the selection they act on -- and
     the search now sits between the spacer and it, which is where the ask put it:
     "add a search at unlocking BEFORE the Achia kwa wingi button". */
  const at = t => { const i = bar.indexOf(t); assert.ok(i > 0, 'missing: ' + t); return i; };
  assert.ok(at('<span style="flex:1"></span>') < at('id="dvQ"'));
  assert.ok(at('id="dvQ"') < at('id="dvBulk"'), 'the search comes before the bulk button');
  /* AND THE MAGNIFIER IS GONE WITH IT: the box narrows the list as the digits go in, so a
     button beside it would be a control with nothing left to do -- and one somebody presses
     anyway, wondering what they missed. */
  assert.ok(!/dvFind/.test(bar), 'no search button: the typing is the search');
  assert.match(bar, /rb\.onclick[^;]*devBulkForm\(m, rb\.getAttribute\('data-dvbulk'\)\)/,
    'and the order comes off the button rather than out of DEVMODE a second time');

  const form = src('devBulkForm');
  /* THE INPUT IS THE TEXTAREA. Reading devPicked() here as well would make one button answer
     to two inputs -- tick three rows, paste eighty, press, and nobody can say what happened. */
  assert.ok(!/devPicked|dvck|dvCount/.test(form), 'the paste form does not read the tick boxes');
  assert.match(form, /devParseImeis_/);
  assert.match(form, /devAct_\(m, p\.list, state\)/,
    'the order goes through the same door as every other, so the one-way-door confirmation '
    + 'and the not-listening refusal are the ones already proven');
  /* THE COUNT UNDER THE BOX is the whole safety of the screen, and it must be live: a paste
     that arrived as one unbroken token reads 1, and a header row that came along reads "IMEI"
     as the first one -- both before the order rather than after the phones have gone dark. */
  assert.match(form, /ta\.oninput\s*=\s*recount/);
  assert.match(form, /ya kwanza/, 'it shows the first IMEI back, so a mis-parse is visible as itself');
});

test('one form, two orders, and the warning is not written once for both', () => {
  /* Everything that makes a bulk order safe is the same work for either desk, so there is one
     form. What is NOT the same is what the order costs, and a warning copied across would be
     false on one of the two screens. */
  /* DEPT comes along, read out of the page rather than copied here: the warning names the
     desk that can undo a lock, and that desk was renamed by the CEO. A test carrying its own
     copy of the name would keep passing through the next rename while the screen said
     something else. */
  const dept = HTML.slice(HTML.indexOf('var DEPT={'), HTML.indexOf(';', HTML.indexOf('var DEPT={')) + 1);
  assert.ok(dept.length > 10 && dept.length < 900, 'DEPT is one block at the top of the script');
  const t = new Function(dept + '\n' + HTML.slice(HTML.indexOf('var DEVBULK={'),
    HTML.indexOf('\n};', HTML.indexOf('var DEVBULK={')) + 3) + '\nreturn DEVBULK;')();
  assert.deepEqual(Object.keys(t).sort(), ['locked', 'released']);

  // Achia cannot be undone from the office: the way back is a cable, per phone.
  assert.match(t.released.warn, /mlango wa njia moja[\s\S]*one-way/);
  assert.match(t.released.warn, /kebo|cable/);

  /* Funga CAN be undone -- by the sales coordinator, in a second -- so calling it irreversible
     would be a lie that makes the real warning next door mean less. What is true is that every
     phone on the list goes dark to whoever is holding it, which on a pasted list is a number
     nobody counted. */
  assert.ok(!/njia moja|one-way|irreversible/i.test(t.locked.warn),
    'locking is not a one-way door and must not borrow the sentence of the one that is');
  assert.match(t.locked.warn, /gizani|dark/, 'it says what a lock actually costs the holder');
  assert.match(t.locked.warn, /Sales Co\./, 'and who can undo it, since this desk cannot');
  assert.ok(!/general duty/i.test(t.locked.warn), 'under the name that desk now has');
  // No reason is demanded any more -- the warning must not promise one it will not ask for.
  assert.ok(!/sababu|reason/i.test(t.locked.warn));
});

test('the IMEIs the register never heard of are named on screen, not counted', () => {
  const send = src('devSend_');
  assert.match(send, /notEnrolledList[\s\S]{0,200}devUnknownDrawer_/,
    'the server has always sent the names; the screen has to show them');

  const un = run('devUnknownDrawer_', 'unlock');
  un.fn({ notEnrolled: 2, notEnrolledList: ['GHOST', 'TYPO'] });
  assert.match(un.out.html, /GHOST/);
  assert.match(un.out.html, /TYPO/);
  assert.ok(!/na nyingine/.test(un.out.html), 'nothing is hidden, so nothing is claimed to be');

  /* The server sends the first twenty and the true total separately. A screen printing twenty
     and saying nothing more would read as the whole answer -- which is the exact failure this
     drawer exists to end, one layer further in. */
  const many = run('devUnknownDrawer_', 'unlock');
  many.fn({ notEnrolled: 33, notEnrolledList: Array.from({ length: 20 }, (_, i) => 'X' + i) });
  assert.match(many.out.html, /na nyingine 13|13 more/);
});

/* =========================================================================================
   FINDING ONE HANDSET, FAST.

     "Add a search at unlocking before the Achia kwa wingi button. General duty need to unlock
      phones by application and finding a single phone in fast speed is hard, so if they search
      imei there it remains itself on the below list."

   IT IS THE SERVER'S SEARCH, NOT THE BROWSER'S, and that is the whole of it. The pane holds
   the newest 500 rows; the register is bigger than that and growing. A filter over what is
   already on screen would answer "no such phone" about a handset sitting in the operator's
   hand -- the one answer this box must never give.
   ========================================================================================= */
test('the search reaches the whole register, not just the rows on screen', async () => {
  const many = Array.from({ length: 520 }, (_, i) =>
    dev({ imei: '35100000000' + String(i).padStart(4, '0'), state: 'locked' }));
  // The one the customer brought in, deliberately last so it is off the end of the 500.
  many.push(dev({ imei: '351929937378664', state: 'locked' }));
  const db = devDb(many);

  const all = await _FNS.deviceList(db, DUTY, {});
  assert.equal(all.rows.length, 500, 'the pane only ever holds 500');
  assert.equal(all.total, 521);

  const one = await _FNS.deviceList(db, DUTY, { q: '351929937378664' });
  assert.equal(one.rows.length, 1, 'and the search finds it anyway');
  assert.equal(one.rows[0].imei, '351929937378664');
  assert.equal(one.searching, true);
  assert.equal(one.q, '351929937378664', 'the digits it actually used come back');
});

test('the digits are what count, so a paste off a sticker still finds the phone', async () => {
  const db = devDb([dev({ imei: '351929937378664', state: 'locked' })]);
  for (const typed of ['351929937378664', 'IMEI: 3519 2993 7378 664', '  351929937378664  ',
    'imei/351929937378664']) {
    const d = await _FNS.deviceList(db, DUTY, { q: typed });
    assert.equal(d.rows.length, 1, 'did not find it from: ' + typed);
  }
  // A partial is a search: the last six digits are what somebody reads off a screen.
  assert.equal((await _FNS.deviceList(db, DUTY, { q: '378664' })).rows.length, 1);
  /* AND THE LIKE WILDCARDS CANNOT REACH THE PATTERN, because they are not digits. A bare `%`
     would otherwise match the whole fleet and read as a search that found everything. */
  assert.equal((await _FNS.deviceList(db, DUTY, { q: '%' })).searching, false,
    'no digits is no search, not a search for everything');
  assert.equal((await _FNS.deviceList(db, DUTY, { q: '%' })).rows.length, 1, 'so the fleet is shown');
});

test('a search outranks the state chip, because the desk is holding that phone', async () => {
  /* If the pane happened to be filtered to "tayari" and the handset is locked, an obedient
     search would report nothing found about a phone the operator can see. */
  const db = devDb([
    dev({ imei: 'AAA111', state: 'locked' }),
    dev({ imei: 'BBB222', state: 'enrolled' }),
  ]);
  assert.deepEqual((await _FNS.deviceList(db, DUTY, { state: 'enrolled' })).rows.map(r => r.imei),
    ['BBB222'], 'the chip alone narrows to its state');
  const d = await _FNS.deviceList(db, DUTY, { state: 'enrolled', q: '111' });
  assert.deepEqual(d.rows.map(r => r.imei), ['AAA111'],
    'but the search wins: that is the phone that was asked for');
});

test('both desks can search, and it changes nothing about who may act', async () => {
  const db = devDb([dev({ imei: 'AAA111', state: 'locked' })]);
  const BOSS = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
  const AUDIT = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['devlock'], readOnly: true };
  for (const who of [STORE, DUTY, BOSS, AUDIT]) {
    assert.equal((await _FNS.deviceList(db, who, { q: '111' })).rows.length, 1,
      (who.name || who.code) + ' can find a handset');
  }
  /* A SEARCH IS A READ. Finding a phone on the wrong desk still does not let you order
     anything about it -- the gate is on the transition, as it has been throughout. */
  await assert.rejects(() => _FNS.deviceSetState(db, STORE, { imeis: ['AAA111'], state: 'enrolled' }),
    /no access to the devunlock pane/);
});

test('an empty search leaves no trap: the box that caused it is still on screen', () => {
  const bar = src('devPaint_');
  /* The action bar used to render only when there were rows. Type one wrong digit, get no
     rows, and the box you would clear the search in went with them. */
  assert.match(bar, /var actions=\(!rows\.length && !qLive\) \? '' :/);
  // While a search is live the tiles are replaced: they count the fleet, and what is on screen
  // is one phone. Keyed on what was TYPED, not on the server's last answer -- between a
  // keystroke and the reply those two disagree, and the tiles must not flash back in the gap.
  assert.match(bar, /var tiles=qLive/);
  assert.match(bar, /id="dvClear"/, 'and the banner carries the way out');
  assert.match(bar, /No handset carries those digits/);
});

test('the search banner is not built before the rows it counts', () => {
  /* THE CRASH THIS PANE SHIPPED WITH.
       "pressing search icon: Imeshindikana / Could not load.
        Cannot read properties of undefined (reading 'length')"

     `rows` was declared with `var` BELOW the banner that reads `rows.length`. The declaration
     hoists and the assignment does not, so it was `undefined` at that line -- and because the
     banner is the one piece of this pane that renders only while searching, nothing else ever
     touched it. The pane died the first time somebody searched. */
  const bar = src('devPaint_');
  const rowsAt = bar.indexOf('var rows=');
  const tilesAt = bar.indexOf('var tiles=');
  assert.ok(rowsAt > 0 && tilesAt > 0);
  assert.ok(rowsAt < tilesAt, 'rows is worked out before anything draws a count of it');
  assert.ok(bar.indexOf('var qLive=') < rowsAt, 'and the typed digits before rows uses them');
});

test('typing narrows the list, with no button and no reload', () => {
  /* "typing should auto reduce the list to the typed imei without even the button being there
      or re-loading the whole page at unlocking page" */
  const wire = src('devPaint_');
  assert.match(wire, /qBox\.oninput=function/, 'every keystroke acts');
  /* THE INSTANT HALF: repaint from rows already in hand. devPaint_ rather than drawDevices,
     because drawDevices blanks the pane to a skeleton -- which is the "re-loading the whole
     page" the ask is about. */
  assert.match(wire, /oninput=function[\s\S]{0,400}devPaint_\(m, d, at\)/);
  assert.ok(!/oninput=function[\s\S]{0,400}drawDevices/.test(wire),
    'a keystroke never blanks the pane');
  // THE WHOLE-REGISTER HALF, once the typing pauses: the loaded page is not the register.
  assert.match(wire, /setTimeout\(function\(\)\{ DEVQ_TIMER=null; devSearchFetch_\(m\); \}, 250\)/);
  assert.match(wire, /if\(v===String\(DEV\.q\|\|''\)\)\{ qBox\.value=v; return; \}/,
    'and an unchanged box redraws nothing');
  // Enter does not search -- the typing did -- it just stops waiting for the pause.
  assert.match(wire, /qBox\.onkeydown[\s\S]{0,400}devSearchFetch_\(m\)/);

  /* THE REPAINT COSTS THE CARET, so it is put back -- otherwise the second digit lands
     nowhere. Counted in digits, so it survives the box stripping anything that is not one. */
  assert.match(wire, /DEVQ_FOCUS=true; DEVQ_CARET=raw\.slice\(0,pos\)\.replace\(\/\\D\/g,''\)\.length/);
  assert.match(wire, /if\(DEVQ_FOCUS\)\{[\s\S]{0,300}setSelectionRange/);
  assert.ok(/DEVQ_FOCUS=false; DEVQ_CARET=null;/.test(wire),
    'and it is one-shot: a tile repainting must not steal focus into the search box');

  /* THE LAST QUESTION ASKED IS THE ONLY ONE WHOSE ANSWER COUNTS. Requests return in whatever
     order the network feels like, and "35138" answering after "351388" would put the wider
     list back under a narrower box. */
  const fetch = src('devSearchFetch_');
  assert.match(fetch, /var mine=\+\+DEVQ_SEQ;/);
  assert.match(fetch, /if\(mine!==DEVQ_SEQ\) return;/);
  assert.match(fetch, /catch\(function\(e\)\{ if\(mine===DEVQ_SEQ\) toast\(safeErr\(e\), true\); \}\)/,
    'a failed keystroke toasts rather than replacing the fleet with an error page');
});
