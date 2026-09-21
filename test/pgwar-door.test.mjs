import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';

/* =========================================================================================
   THE POSTGRES-WAR AUDIT, BATCH "DOOR" -- verified fixes to the sign-in path, the roles read,
   the system-open switch, and the audited() diff.

     "we go into postgres war" (test/speed.test.mjs)

   Four things measured on the fake, and one silent correctness bug found alongside them:

     1. THE DOOR, part 1 (auth.js authCode): an exact-match sign-in paid for TWO access_codes
        trips -- the exact match, then an UNCONDITIONAL case-insensitive retry that could only
        ever confirm what the exact match had already answered.
     2. THE DOOR, part 2 (authCodeResolved / gatedUser / can): the roles row was read fresh on
        EVERY signed-in request, for a table that changes when somebody visits Teams & Staff
        and not one moment sooner.
     3. system-gate.js's clearSystemOpenCache existed and was never called, despite settingSet's
        own header claiming it was -- so closing the system left it open, elsewhere, for up to
        thirty seconds.
     4. audit.js's audited() paid for the row it diffs THREE TIMES over on every write it
        watches -- the handler's own keyed read, then its own before-read, then its own
        after-read -- for nine handlers that had already done that exact read for their own
        business logic. Bundled in: issueUpdate's AUDIT_DIFF spec named a column ("to_code")
        `issues` has never had, so on any migrated database its diff was refused outright and
        silently dropped; officerActive's spec named the wrong table entirely.
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

/* =========================================================================================
   3. SYSTEM-GATE -- settingSet(SYSTEM_OPEN) now actually clears the cache it always claimed
      to. clearSystemOpenCache was exported and never called; the switch stayed open, on every
      OTHER request, for up to thirty seconds after an admin closed it on their own screen.
   ========================================================================================= */
const { requireSystemOpen } = await import('../api/_lib/system-gate.js');

test('gate: settingSet(SYSTEM_OPEN=NO) closes the door immediately, not after 30s', async () => {
  const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
  const OFFICER = { code: 'C1', name: 'Juma', role: 'OFFICER', teams: null, tabs: ['dashboard'], readOnly: false };
  const db = fakeDb({ settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }] });

  // Populate the 30s cache with "open", exactly as the first portal request of the morning would.
  assert.equal(await requireSystemOpen(db, OFFICER), true);

  await _FNS.settingSet(db, OWNER, { key: 'SYSTEM_OPEN', value: 'NO' });

  // Without the fix this reads the still-cached "open" for up to another 30 seconds.
  await assert.rejects(() => requireSystemOpen(db, OFFICER), /closed|imefungwa/i,
    'the admin who just closed it must see it closed, on the very next request, everywhere');
  // ADMIN is never gated, whatever the switch says -- untouched by this fix.
  await requireSystemOpen(db, OWNER);
});

test('gate: a setting other than SYSTEM_OPEN does not touch the cache', async () => {
  const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
  const OFFICER = { code: 'C1', name: 'Juma', role: 'OFFICER', teams: null, tabs: ['dashboard'], readOnly: false };
  const db = fakeDb({ settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'GM_EMAIL', value: 'old@hoop.co.tz' }] });
  await requireSystemOpen(db, OFFICER);       // caches "open"
  await _FNS.settingSet(db, OWNER, { key: 'GM_EMAIL', value: 'new@hoop.co.tz' });
  // Still open -- an unrelated setting must not force a fresh read either way, but it certainly
  // must not have accidentally closed anything.
  await requireSystemOpen(db, OFFICER);
});

/* =========================================================================================
   4. audited() -- the free before-read, and issueUpdate's retired to_code spec.

   Measured: every AUDIT_DIFF write cost 5 trips (issueUpdate 6) -- the handler's own keyed
   read, audited()'s own before-read of the same row, the update, audited()'s own after-read of
   the same row again, and the audit_log insert. Nine handlers (topupUpdate, advDecide, advPay,
   impDecide, impRetire, leaveDecide, commDecide, commPay, issueUpdate) already do that keyed
   read for their own business logic; each now leaves what it read in args.__auditCtx.before
   and the patch it is about to write in args.__auditCtx.afterPatch, and audited() builds the
   diff from those instead of asking Postgres for the same row twice more.
   ========================================================================================= */
const { audited } = await import('../api/_lib/audit.js');

const FIN = { code: 'F1', name: 'JANETH', role: 'OFFICER', teams: null, tabs: ['topups'], readOnly: false };
const aTopup = o => ({ id: o.id, requested_at: '2026-09-01T06:00:00Z',
  staff_code: 'A1', staff_name: 'JUMA G', staff_role: 'OFFICER',
  imei: '351388334583295', customer: 'Alafati', customer_phone: '0712000000',
  payer_name: null, paid_amount: 100000, proof_ref: 'MPESA-1',
  price: 450000, balance: 350000, status: o.status || 'requested', comment: null,
  verified_by: null, verified_at: null, paid_by: null, paid_at: null, payment_ref: null,
  unlocked_by: null, unlocked_at: null,
  chk_request: false, chk_paid_to: false, chk_watu: false, chk_auditor: false,
  updated_by: 'JUMA G', updated_at: '2026-09-01T06:00:00Z' });
const uid = tag => {
  const h = [...tag].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h}-1111-4222-8333-${h}${h.slice(0, 4)}`;
};

test('audited: topupUpdate(verify) now costs 3 trips, not 5', async () => {
  const id = uid('t1');
  const c = counting({ topups: [aTopup({ id })], watu_loans: [], audit_log: [] });
  const args = { id, step: 'verify', imeiOk: true, payerOk: true };
  await audited(c.db, FIN, 'topupUpdate', args, () => _FNS.topupUpdate(c.db, FIN, args), {});
  const { trips } = c.stat();
  assert.equal(trips, 3, '1 keyed read (shared via __auditCtx) + 1 update + 1 audit_log insert');
});

test('audited: the ctx-merged diff is byte-identical to reading the row before and after', async () => {
  /* THE OLD SHAPE, replicated by hand on an independent copy of the SAME fixture: read the row,
     apply the identical write through the ordinary handler, read the row again. If the new
     fast path ever drifted from this, the values -- not just the trip count -- would disagree. */
  const id = uid('t2');
  const dbNew = fakeDb({ topups: [aTopup({ id })], audit_log: [] });
  const dbOld = fakeDb({ topups: [aTopup({ id })], audit_log: [] });

  const args = { id, step: 'verify', imeiOk: true, payerOk: true };
  await audited(dbNew, FIN, 'topupUpdate', args, () => _FNS.topupUpdate(dbNew, FIN, args), {});
  const got = dbNew._dump('audit_log')[0];

  const before = (await dbOld.from('topups').select('status').eq('id', id).maybeSingle()).data;
  await _FNS.topupUpdate(dbOld, FIN, { id, step: 'verify', imeiOk: true, payerOk: true });
  const after = (await dbOld.from('topups').select('status').eq('id', id).maybeSingle()).data;

  assert.deepEqual(got.before, { status: before.status });
  assert.deepEqual(got.after, { status: after.status });
  assert.equal(got.before.status, 'requested');
  assert.equal(got.after.status, 'verified');
});

test('audited: staffManager still logs a diff -- it has no own read, so audited() still does both of its', async () => {
  const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['staff', 'settings'], readOnly: false };
  const db = fakeDb({ hoop_agents: [
    { phone: '0712000000', name: 'AGENT A', role: 'AGENT', manager: 'RSM OLD', branch: 'B1', active: true },
  ], audit_log: [] });
  const args = { phone: '0712000000', manager: 'RSM NEW' };
  await audited(db, ADMIN, 'staffManager', args, () => _FNS.staffManager(db, ADMIN, args), {});
  const [row] = db._dump('audit_log');
  assert.equal(row.ok, true);
  assert.deepEqual(row.before, { manager: 'RSM OLD' });
  assert.deepEqual(row.after, { manager: 'RSM NEW' });
});

const anIssue = o => ({ id: o.id, raised_at: '2026-09-01T06:00:00Z', staff_code: 'A1', staff_name: 'JUMA G',
  staff_role: 'OFFICER', department: 'IT', kind: 'issue', subject_type: null, subject: null,
  title: 'Simu haiwaki', details: null, contact: null, verified: false,
  referred_to: null, external_ref: null, status: o.status || 'open', assigned_to: null,
  resolution: null, escalated_by: null, escalated_at: null, resolved_by: null, resolved_at: null,
  updated_by: 'JUMA G', updated_at: '2026-09-01T06:00:00Z' });

test('audited: issueUpdate records a status change on the REAL columns; the retired to_code spec would have been refused', async () => {
  const id = uid('i1');
  /* to_code never existed on ANY deployment -- issues has to_role and to_name (see ISSUE_COLS).
     missingColumns models that permanently-absent column, on an otherwise ordinary, fully
     migrated database. */
  const db = fakeDb({ issues: [anIssue({ id })], issue_notes: [] },
    { missingColumns: { issues: ['to_code'] } });

  // Proof the bug was real: the spec this replaces would have failed outright, on every database.
  const rejected = await db.from('issues').select('status, to_role, to_code').eq('id', id);
  assert.match(String(rejected.error && rejected.error.message), /to_code/,
    'the retired AUDIT_DIFF spec named a column issues has never had');

  const DESK = { code: 'D1', name: 'NEEMA M', role: 'OFFICER', teams: null, tabs: ['issues'], readOnly: false };
  const args = { id, status: 'waiting' };
  await audited(db, DESK, 'issueUpdate', args, () => _FNS.issueUpdate(db, DESK, args), {});
  const [row] = db._dump('audit_log');
  assert.equal(row.ok, true);
  assert.deepEqual(row.before, { status: 'open' });
  assert.deepEqual(row.after, { status: 'waiting' });
});

test('audited: a refused issueUpdate still records what it tried to overwrite, using the ctx before-read', async () => {
  const id = uid('i2');
  const db = fakeDb({ issues: [anIssue({ id, status: 'resolved' })], issue_notes: [] });
  // A raiser (not the desk) may not change status at all -- requireAnyNav lets them in, but
  // navsFor(user).includes('issues') is false, so `desk` is false and nothing in the patch moves.
  const RAISER = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['issuereq'], readOnly: false };
  const args = { id, status: 'open' };
  await assert.rejects(() => audited(db, RAISER, 'issueUpdate', args,
    () => _FNS.issueUpdate(db, RAISER, args), {}));
  const [row] = db._dump('audit_log');
  assert.equal(row.ok, false);
  // pick_ names every field the spec tracks, not only the ones that moved -- same as every
  // other refused-attempt row (see audit-log.test.mjs's settingSet case).
  assert.deepEqual(row.before, { status: 'resolved', to_role: null, to_name: null },
    'ctx.before still rides along on a refusal');
  assert.equal(row.after, null);
});

/* =========================================================================================
   THE OTHER BUNDLED FIX -- officerActive's AUDIT_DIFF spec named the wrong table entirely.
   ========================================================================================= */
test('audited: officerActive\'s spec now names the table and key it actually updates', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/_lib/audit.js', import.meta.url), 'utf8');
  const spec = src.slice(src.indexOf('const AUDIT_DIFF = {'), src.indexOf('const K_ ='));
  assert.match(spec, /officerActive:\s*\{\s*table:\s*'call_users'/,
    'officerActive flips call_users.active, never an access_codes row');
  assert.match(spec, /officerActive:[\s\S]{0,80}user_id:\s*a\.userId/);

  const db = fakeDb({ call_users: [{ user_id: 'U1', name: 'Ainea', team: 'B1', role: 'PCO', active: true }],
    audit_log: [] });
  const ADMIN = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['codes', 'settings'], readOnly: false };
  const args = { userId: 'U1', active: false };
  await audited(db, ADMIN, 'officerActive', args, () => _FNS.officerActive(db, ADMIN, args), {});
  const [row] = db._dump('audit_log');
  assert.deepEqual(row.before, { active: 'true' });
  assert.deepEqual(row.after, { active: 'false' }, 'the old spec logged nothing here, ever, on any database');
});

/* =========================================================================================
   THE AUDITED.add BLOCK -- every name in portal.js's own top block resolves to a real fn.
   ========================================================================================= */
test('every AUDITED.add(...) name in portal.js\'s top block is a real, dispatchable fn', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("AUDITED.add('newTeamCode')"),
    src.indexOf("AUDITED.add('transferCreateBulk')") + "AUDITED.add('transferCreateBulk');".length);
  const names = [...block.matchAll(/AUDITED\.add\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]);
  assert.ok(names.length > 40, 'the block should have been found');
  for (const name of names) {
    assert.ok(Object.prototype.hasOwnProperty.call(_FNS, name),
      name + ' is added to AUDITED but is not a dispatchable portal fn');
  }
});
