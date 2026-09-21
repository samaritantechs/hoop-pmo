import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';

/* =========================================================================================
   THE POSTGRES-WAR AUDIT, BATCH "DOOR" -- verified fixes to the sign-in path and the roles
   read behind every signed-in request.

     "we go into postgres war" (test/speed.test.mjs)

     1. THE DOOR, part 1 (auth.js authCode): an exact-match sign-in paid for TWO access_codes
        trips -- the exact match, then an UNCONDITIONAL case-insensitive retry that could only
        ever confirm what the exact match had already answered.
     2. THE DOOR, part 2 (authCodeResolved / gatedUser / can): the roles row was read fresh on
        EVERY signed-in request, for a table that changes when somebody visits Teams & Staff
        and not one moment sooner.

   More sections (system-gate, audited()) join this file as the rest of the sweep lands.
   ========================================================================================= */

/** Counts every request the code sends, exactly as fetchAll issues them -- copied from
    test/speed.test.mjs's counting(), with one addition: a per-table tally, needed here to
    tell "1 access_codes trip" apart from "1 roles trip" inside the same call. */
function counting(tables, opts) {
  const db0 = fakeDb(tables, opts);
  let trips = 0, rows = 0;
  const byTable = {};
  const wrap = (q, table) => new Proxy(q, { get(o, p) {
    if (p === 'then') return (res, rej) => o.then(r => {
      trips++; byTable[table] = (byTable[table] || 0) + 1;
      if (Array.isArray(r.data)) rows += r.data.length;
      return res(r);
    }, rej);
    const v = o[p];
    return typeof v === 'function' ? (...a) => { const out = v.apply(o, a); return out === o ? wrap(o, table) : out; } : v;
  } });
  return { db: { from: n => wrap(db0.from(n), n), rpc: (n, a) => wrap(db0.rpc(n, a), n),
                 _dump: n => db0._dump(n) },
           stat: () => ({ trips, rows }),
           tableTrips: t => byTable[t] || 0 };
}

/* =========================================================================================
   1. THE DOOR, PART 1 -- authCode skips the case-insensitive retry once the exact match wins.
   ========================================================================================= */
const { authCode, authCodeResolved, USER_TABS } = await import('../api/_lib/auth.js');
const { _FNS } = await import('../api/portal.js');

test('door: an exact-match sign-in costs exactly ONE access_codes trip', async () => {
  const c = counting({ access_codes: [
    { code: 'ABC123', name: 'Juma', role: 'OFFICER', teams: null, tabs: [] },
  ] });
  const u = await authCode('ABC123', c.db);
  assert.equal(u.name, 'Juma');
  assert.equal(c.stat().trips, 1, 'the ilike() fallback must not run once the exact match answered');
});

test('door: a code typed in a different case than stored still signs in (two trips, not one)', async () => {
  const c = counting({ access_codes: [
    { code: 'ABC123', name: 'Juma', role: 'OFFICER', teams: null, tabs: [] },
  ] });
  const u = await authCode('abc123', c.db);
  assert.equal(u.name, 'Juma', 'the case-insensitive retry still runs when the exact match misses');
  assert.equal(c.stat().trips, 2, 'one trip to learn the exact match missed, one for the retry');
});

test('door: a suspended code still refuses, and ADMIN is still never suspended (unaffected by the fix)', async () => {
  /* Regression only -- the real coverage for this rule is test/portal.test.mjs's "a suspended
     code cannot sign in" and test/signin-watch.test.mjs; this just proves skipping the
     unconditional ilike() retry changed nothing about who gets refused. */
  const day = new Date().toISOString().slice(0, 10);
  const d = fakeDb({ access_codes: [
    { code: 'AWAY', name: 'Ally', role: 'CREDIT', teams: null, tabs: [], suspend_from: day, suspend_to: day },
    { code: 'BOSS', name: 'Peter', role: 'ADMIN', teams: null, tabs: [], suspend_from: day, suspend_to: day },
  ] });
  await assert.rejects(() => authCode('AWAY', d), /simamishwa|suspended/i);
  assert.equal((await authCode('BOSS', d)).name, 'Peter');
});

/* =========================================================================================
   2. THE DOOR, PART 2 -- the roles read, memoised 30s and shared by authCodeResolved/can.
   ========================================================================================= */
test('door: authCodeResolved(code, db) called twice for one role costs exactly ONE roles trip', async () => {
  const c = counting({
    access_codes: [{ code: 'C1', name: 'Neema', role: 'RSM', teams: null, tabs: [] }],
    roles: [{ role: 'RSM', tabs: ['dashboard', 'customers'] }],
  });
  const u1 = await authCodeResolved('C1', c.db);
  const u2 = await authCodeResolved('C1', c.db);
  assert.deepEqual(u1.tabs, ['dashboard', 'customers']);
  assert.deepEqual(u2.tabs, u1.tabs, 'the second call reads the memo, not the table');
  assert.equal(c.tableTrips('roles'), 1, 'one roles trip for two resolutions inside the 30s window');
  assert.equal(c.tableTrips('access_codes'), 2, 'the door itself is unaffected -- one exact match per call');
});

test('door: saveRole clears the memo, so the very next authCodeResolved sees the NEW tabs', async () => {
  const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
  const db = fakeDb({
    access_codes: [{ code: 'C1', name: 'Neema', role: 'RSM', teams: null, tabs: [] }],
    roles: [{ role: 'RSM', tabs: ['dashboard'] }],
  });
  const before = await authCodeResolved('C1', db);
  assert.deepEqual(before.tabs, ['dashboard']);

  await _FNS.saveRole(db, OWNER, { role: 'RSM', tabs: ['dashboard', 'customers'] });
  const after = await authCodeResolved('C1', db);
  assert.deepEqual(after.tabs, ['dashboard', 'customers'],
    'without clearRolesCache this would still read the stale memo for up to 30s');
});

test('door: deleteRole clears the memo too', async () => {
  const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
  const db = fakeDb({
    access_codes: [{ code: 'C1', name: 'Neema', role: 'STORE', teams: null, tabs: [] }],
    roles: [{ role: 'STORE', tabs: ['stockreq'] }],
    settings: [],
  });
  const before = await authCodeResolved('C1', db);
  assert.deepEqual(before.tabs, ['stockreq']);

  /* deleteRole refuses while a code still holds the role (reassign first) -- moving C1 off it
     is what makes the delete legal; the STALE cache entry for STORE is what this test is
     really about, and it was populated a line ago, before C1 moved. */
  await db.from('access_codes').update({ role: 'OTHER' }).eq('code', 'C1');
  await _FNS.deleteRole(db, OWNER, { role: 'STORE' });

  // A fresh code taking the same role name, now that the row is gone.
  await db.from('access_codes').insert([{ code: 'C2', name: 'Asha', role: 'STORE', teams: null, tabs: [] }]);
  const after = await authCodeResolved('C2', db);
  assert.deepEqual(after.tabs, USER_TABS,
    'no role row at all reads as "never configured" -- the stale memo would still say stockreq');
});

test('door: a MISSING role row is memoised too, and still yields resolveTabs\' defaults', async () => {
  const c = counting({
    // tabs: [] on the code, so resolveTabs' merge is empty and the roleKnown branch decides.
    access_codes: [{ code: 'C2', name: 'Old Timer', role: 'LEGACY', teams: null, tabs: [] }],
    roles: [],
  });
  const u1 = await authCodeResolved('C2', c.db);
  const u2 = await authCodeResolved('C2', c.db);
  assert.deepEqual(u1.tabs, USER_TABS, 'no row at all -- nobody has ever configured this role');
  assert.deepEqual(u2.tabs, u1.tabs);
  assert.equal(c.tableTrips('roles'), 1, 'the ABSENCE of a row is memoised just like its presence');
});

test('door: renameAccessCode does NOT clear the roles memo -- it never touches roles', async () => {
  const src = await (await import('node:fs')).promises.readFile(
    new URL('../api/portal.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async renameAccessCode('), src.indexOf('\n  async changeMyCode('));
  assert.ok(!/clearRolesCache/.test(fn), 'renameAccessCode changes a CODE, never a ROLE');
});
