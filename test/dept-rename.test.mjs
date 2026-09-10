import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { CREDIT_ROLES, rosterFull } from '../api/_lib/call-core.js';

/* =========================================================================================
   THE TWO DEPARTMENTS THE CEO RENAMED.

     "We have had a meeting with the GM, currently addressed as CEO. Agreed to change hoop
      dept names GENERAL DUTY into SALES COORDINATOR since they analyze and push sales,
      CREDIT into PORTFOLIO AND COMPLIANCE OFFICER since they make followups. Change the two
      if there was something implemented with the roles names as those, am dealing with the
      access code ones manually."

   A RENAME HAS TWO HALVES AND THEY PULL IN OPPOSITE DIRECTIONS.

     the label    what a person reads. This changes, everywhere, and the old words must be
                  gone -- a half-done rename is how two names for one desk end up in the
                  building, which is worse than either name alone.

     the value    what a ROW holds and what a handset in the field sends. This does not
                  change. `issues.department` is full of GENERAL_DUTY, `call_users.role` is
                  full of CREDIT, and the ISSUES_EMAIL setting is keyed on both. Renaming a
                  stored value orphans every row already carrying it -- and here it would
                  have emptied the follow-up roster on the morning it deployed.

   So: labels move, keys stand, and the matcher LEARNS the new name without forgetting the
   old. That last one is the whole trick, and it is the same contract the locked handsets in
   the field already live under.
   ========================================================================================= */
const read = f => fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');

test('the new name is matched, and every old spelling still is', () => {
  /* THE ROSTER IS THE COST OF GETTING THIS WRONG. Drop 'CREDIT' from this set and every
     person already registered under it falls off the deal: their deck opens empty, nobody is
     dealt a share, and nothing on any screen says why. */
  for (const old of ['CREDIT', 'OFFICER', 'CREDIT OFFICER', 'CREDIT TEAM']) {
    assert.ok(CREDIT_ROLES.has(old), 'a live spelling was dropped: ' + old);
  }
  assert.ok(CREDIT_ROLES.has('PORTFOLIO AND COMPLIANCE OFFICER'), 'the CEO\'s name is matched');
  // The two shorter forms somebody will inevitably type into the register.
  assert.ok(CREDIT_ROLES.has('PORTFOLIO AND COMPLIANCE'));
  assert.ok(CREDIT_ROLES.has('PORTFOLIO & COMPLIANCE'));
});

test('a follow-up person under either name is dealt a share', async () => {
  const db = fakeDb({
    call_users: [
      { user_id: 'U1', name: 'Ainea', role: 'CREDIT', active: true },
      { user_id: 'U2', name: 'Baraka', role: 'PORTFOLIO AND COMPLIANCE OFFICER', active: true },
      // Not a follow-up desk at all, under either name, and must not join the roster.
      { user_id: 'U3', name: 'Sipho', role: 'STORE', active: true },
    ],
    call_suspend: [],
  });
  const r = await rosterFull(db);
  assert.deepEqual(r.ids.sort(), ['U1', 'U2'],
    'the rename does not split one desk into two rosters');
});

test('the stored keys did not move, because rows and settings are keyed on them', async () => {
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  /* issues.department, issues.to_role and the ISSUES_EMAIL setting all hold these. A rename
     here would orphan every issue already filed and silently stop routing mail for both
     desks -- and the owner maintains that setting by hand. */
  assert.match(api, /const ISSUE_DEPTS = \['STORE', 'FINANCE', 'IT', 'HR', 'CREDIT', 'SALES', 'GENERAL_DUTY', 'ADMIN'\]/,
    'the department keys are stored values, not labels');

  const d = fakeDb({ issues: [], issue_events: [], access_codes: [], settings: [], roles: [] });
  const raiser = { code: 'R1', name: 'Asha', role: 'SALES COORDINATOR', teams: null,
    tabs: ['issuereq'], readOnly: false };
  const made = await _FNS.issueRaise(d, raiser, { department: 'GENERAL_DUTY', kind: 'issue',
    title: 'Deck did not arrive', details: 'Nothing since Friday' });
  assert.ok(made.ok);
  assert.equal(d._dump('issues')[0].department, 'GENERAL_DUTY',
    'the row still carries the key every earlier row carries');
});

test('nothing on a screen still says the old names', () => {
  const portal = read('portal.html');
  const upload = read('upload.html');

  /* THE PAGE NAMES THEM ONCE. They were literals in a dozen sentences, which is exactly how
     the NEXT rename would get half done and stay that way. */
  assert.match(portal, /var DEPT=\{SC:'Sales Coordinator',PC:'Portfolio and Compliance Officer'\}/);

  /* WHAT A PERSON READS, WHICH IS NOT WHAT A DEVELOPER READS.
     Block comments are stripped before this check, deliberately and in both directions:

       they must NOT be rewritten -- most of the ones naming the old desk are VERBATIM
       QUOTES of the owner's own requests ("we now want storekeeper to always lock and
       general duty will be unlocking at customer screening-pos"). Editing a quotation to
       say something the person never said is a worse lie than a stale name, and it destroys
       the one record of why the code is shaped the way it is.

       and they must not be CHECKED -- a fence that failed on its own explanation of the
       rename would be a fence nobody could leave in place.

     The stored key GENERAL_DUTY survives the strip on purpose: it appears in the settings
     help text, which tells the owner what to type into ISSUES_EMAIL, and it is a key. */
  const screen = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/GENERAL_DUTY/g, ' ');
  for (const [file, html] of [['portal.html', portal], ['upload.html', upload]]) {
    const hits = (screen(html).match(/general[ -]duty/gi) || []);
    assert.deepEqual(hits, [], file + ' still says "general duty" on a screen: ' + hits.join(', '));
  }

  // The desks that name each other name the new one.
  assert.match(portal, /var pivots=\[\['general',DEPT\.SC\]/, 'the sales pivot');
  assert.match(portal, /GENERAL_DUTY:DEPT\.SC/, 'the issue department label');
  assert.match(portal, /CREDIT:'Mikopo \/ '\+DEPT\.PC/);
  assert.match(portal, /Kufungua kunafanywa na <b>'\+DEPT\.SC/, 'the locking bench');
  assert.match(portal, /the sales coordinator at the POS/, 'the nav catalogue');
});

test('the new names are what a new access code is offered', () => {
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  /* ONLY A SUGGESTION LIST. Every role already on a code or in the roles table is merged in
     above it, so a code still carrying GENERAL DUTY keeps working and keeps appearing --
     changing what is OFFERED is what makes the next code carry the new name, and it takes
     nothing away from the codes that exist. The owner is doing those by hand. */
  const list = api.slice(api.indexOf("['ADMIN', 'MANAGER', 'FINANCE', 'RSM'"),
    api.indexOf('.forEach(k => { if (!seen.has(k)', api.indexOf("['ADMIN', 'MANAGER', 'FINANCE', 'RSM'")));
  assert.match(list, /'PORTFOLIO AND COMPLIANCE OFFICER'/);
  assert.match(list, /'SALES COORDINATOR'/);
  assert.ok(!/'GENERAL DUTY'|'CREDIT LEAD'/.test(list), 'the old titles are no longer offered');
});
