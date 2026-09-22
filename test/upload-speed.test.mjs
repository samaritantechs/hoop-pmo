/* THE UPLOAD SPEED GUARD -- the postgres war reaches /api/upload itself.
 *
 * CLAUDE.md rule 1: "UPLOADING and CALL APP should NEVER GO DOWN neither SLOW DOWN." Everything
 * in test/speed.test.mjs enforces that for the portal (_FNS) and the call app (callApi) -- and
 * for nothing else. api/upload.js's own write handler (the default-exported POST function) had
 * ZERO speed-guard coverage: the only test that imported anything from this file drove the
 * `deckStats` helper alone, against a bare fakeDb, never through the real handler. A change that
 * quietly turned deckStats -- or the settings/audit writes beside it -- from "once per upload"
 * into "once per slice" would have passed every existing test. This file closes that gap.
 *
 * THE HANDLER IS NOT INJECTABLE THE WAY portalApi/callApi ARE. `export default withApi(async
 * (req) => {...})` reaches for the module-level `supabase` singleton directly (imported from
 * api/_lib/supabase.js), and so does everything it calls beneath it that is NOT given an
 * explicit `db` -- gatedUser(code) and can(user, 'upload') in upload.js's own body default their
 * `db` param to that same singleton. So the only way to drive the real handler against a fake
 * database is to monkey-patch the singleton's `.from` for the duration of one run, exactly the
 * situation a sister repo's upload.js was found to be in. Patched carefully: saved and restored
 * in try/finally so a failing assertion mid-test can never leave a later test, or a later file
 * sharing this process, talking to this test's fake rows.
 *
 * gatedUser/can also warm two caches that are keyed on the DATABASE CLIENT OBJECT (auth.js's
 * rolesCache, system-gate.js's isSystemOpen cache) -- and because every call here goes through
 * the same real `supabase` object (only its `.from` is swapped), those caches persist ACROSS
 * this file's own test() blocks, not just across slices of one upload. Each measurement below
 * resets them first (clearRolesCache, clearSystemOpenCache, signin.js's _resetSeen) so "cold"
 * means the same thing every time this file is run, in any order, in any process. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { supabase } = await import('../api/_lib/supabase.js');
const upload = (await import('../api/upload.js')).default;
const { fakeDb } = await import('./fake-db.mjs');
const { clearRolesCache } = await import('../api/_lib/auth.js');
const { clearSystemOpenCache } = await import('../api/_lib/system-gate.js');
const { _resetSeen } = await import('../api/_lib/signin.js');

/* =====================================================================================
   THE FIXTURE: a small, realistic Watu deck row -- the same shape test/importers.test.mjs's
   own fixture uses (Watu's starter export), so a header this file's own suite already proves
   `importWatu` reads correctly. imei()/watuRow() vary only what has to vary per row (the IMEI
   and the phone number) so the register's unique keys never collide across rows.
   ===================================================================================== */
const HEADERS = ['Shop', 'Agent', 'Agent ID', 'Client Name', 'Client Mobile', 'Model', 'Model Details',
  'Disbursed Date', 'IMEI', 'Price', 'Has Ever Paid', 'Days Offline', 'Onboarding Time (Min)',
  'App Signed Up', 'Locked 4+ Days', 'Locked 7+ Days'];
const imei = n => '35192993' + String(7300000 + n).padStart(7, '0');
const watuRow = n => ['Hoop Limited, Kinondoni', 'Denis John', '120405', 'Customer ' + n,
  '25571' + String(1000000 + n).slice(-7), 'A07', 'A07 (SM-A075F/DS) 64GB/4GB', '13-Jul-26',
  imei(n), '450000', 'FALSE', String(10 + (n % 20)), '375', 'TRUE', 'TRUE', n % 3 === 0 ? 'TRUE' : 'FALSE'];

/* One ADMIN code -- the cheapest path through gatedUser/can (see auth.js: ADMIN short-circuits
   both the roles read's RESULT and requireSystemOpen entirely), so what this file measures is
   the upload handler's own cost, not the fence on top of it -- that fence already has its own
   coverage in test/speed.test.mjs. */
const CODE_ROW = { code: 'U1', name: 'UPLOADER', role: 'ADMIN', teams: null, tabs: [] };
const emptyBook = () => ({ access_codes: [{ ...CODE_ROW }], roles: [], settings: [],
  signin_attempts: [], teams: [], watu_snapshots: [], watu_loans: [], followup_status: [],
  audit_log: [] });

/** Same shape as speed-fixture.mjs's counting() (every awaited builder is one trip, rows counted
    where they are answered), extended with a per-(table,mode) call log -- this file needs to
    prove not just HOW MANY trips an upload costs, but that the once-per-batch ones (deckStats,
    the DATA_VERSION move, the audit line) truly run once, whatever the slice count is. */
function counting(tables) {
  const db0 = fakeDb(tables);
  let trips = 0, rows = 0;
  const calls = [];
  const wrap = q => new Proxy(q, { get(o, p) {
    if (p === 'then') return (res, rej) => o.then(r => {
      trips++; if (Array.isArray(r.data)) rows += r.data.length;
      calls.push(o.tableName + ':' + o.mode + (o.headOnly ? ':head' : ''));
      return res(r);
    }, rej);
    const v = o[p];
    return typeof v === 'function' ? (...a) => { const out = v.apply(o, a); return out === o ? wrap(o) : out; } : v;
  } });
  return {
    db: { from: n => wrap(db0.from(n)), rpc: (n, a) => wrap(db0.rpc(n, a)), _dump: n => db0._dump(n) },
    stat: () => ({ trips, rows }),
    calls,
    count: key => calls.filter(c => c === key).length,
  };
}

/** Monkey-patches the module-level `supabase` singleton's `.from` for the duration of `fn`,
    then restores it -- whatever `fn` does, including throw. This is the ONLY way to route the
    real handler's writes at a fake database: see the file header. */
async function withFakeSupabase(fake, fn) {
  const hadOwn = Object.prototype.hasOwnProperty.call(supabase, 'from');
  const saved = supabase.from;
  supabase.from = fake.from;
  try {
    return await fn();
  } finally {
    if (hadOwn) supabase.from = saved; else delete supabase.from;
  }
}

/* A bare Vercel-shaped req/res pair -- nothing here drives an HTTP server, just the same
   (req, res) contract withApi expects (see auth.js: setHeader, status().json(), end()). */
function fakeReq(body) { return { method: 'POST', body }; }
function fakeRes() {
  const r = { statusCode: null, body: null };
  r.setHeader = () => {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => {};
  return r;
}
async function post(body) {
  const res = fakeRes();
  await upload(fakeReq(body), res);
  if (res.body && res.body.ok === false) throw new Error('upload refused: ' + res.body.error);
  return res.body;
}

/* Slices a Watu deck exactly the way public/upload.html does it (SLICE = 2000 there): the
   header row is re-sent on every slice, every slice carries the same batch uuid, and the last
   slice is whichever one runs out of rows -- server-side isLast is index >= total - 1. */
function sliceRequests(rowCount, sliceSize, code, uploadDate, batchId) {
  const data = Array.from({ length: rowCount }, (_, i) => watuRow(i));
  const total = Math.max(1, Math.ceil(data.length / sliceSize));
  const bodies = [];
  for (let i = 0; i < total; i++) {
    const rows = [HEADERS].concat(data.slice(i * sliceSize, (i + 1) * sliceSize));
    bodies.push({ code, rows, meta: { uploadDate, kind: 'watu' }, part: { id: batchId, index: i, total } });
  }
  return bodies;
}

function resetCaches() {
  clearRolesCache(supabase);
  clearSystemOpenCache(supabase);
  _resetSeen();
}

/* =====================================================================================
   1. A FIRST-EVER CEILING WHERE NONE EXISTED.

   Measured cold (2026-09-22, this fixture): 14 round trips, 0 rows, for a 25-row Watu deck sent
   as one request -- access_codes(1) + roles(1) + the sign-in log's read+insert(2) +
   followup_status's release(1) + teams/watu_snapshots/watu_loans/followup_status writes(4) +
   the DATA_VERSION move(1) + deckStats' three HEAD counts(3) + the audit line(1). Budget below
   is that, x1.2, rounded up -- the same convention test/speed.test.mjs uses.
   ===================================================================================== */
test('speed: a small single-request Watu upload -- cold within 17 trips / 5 rows', async () => {
  resetCaches();
  const c = counting(emptyBook());
  const result = await withFakeSupabase(c.db, () =>
    post({ code: 'U1', rows: [HEADERS, ...Array.from({ length: 25 }, (_, i) => watuRow(i))],
      meta: { uploadDate: '2026-09-22', kind: 'watu' },
      part: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', index: 0, total: 1 } }));
  const { trips, rows } = c.stat();
  // Proves this drove the REAL handler, not a stub: the deck report (deckStats) came back,
  // read from the fake table this request itself just wrote.
  assert.equal(result.inserted, 25);
  assert.equal(result.deck && result.deck.rows, 25, 'deckStats must read back what this request wrote');
  const advice = '\n  Before raising this: can the database do the work instead? If genuinely not, ' +
    'raise it in the SAME commit as the change that needs it, with the reason in the diff ' +
    '(CLAUDE.md rule 1).';
  assert.ok(trips <= 17, `a single-request Watu upload took ${trips} round trips (budget 17).` + advice);
  assert.ok(rows <= 5, `a single-request Watu upload read ${rows} rows (budget 5) -- ` +
    'this endpoint should never read rows back, only counts.' + advice);
});

/* =====================================================================================
   2. THE SAME ROWS, SLICED MORE WAYS, MUST COST LINEARLY -- NOT PER-SLICE WASTE.

   This is the regression guard for the exact bug class a sister repo's upload.js had: a
   diagnostic or a settings/audit write that should run ONCE PER BATCH (gated on isLast) instead
   running once PER SLICE. Today's api/upload.js gates all three correctly (see deckStats' own
   comment and the `if (isLast)` blocks around it) -- this test is what would turn red the day
   that stops being true.

   Measured cold, this fixture, 30 rows of the same deck: each ADDITIONAL slice costs exactly 5
   round trips (access_codes + teams + watu_snapshots + watu_loans + followup_status -- the
   per-slice writes, bounded by the slice's own row count) on top of a fixed 9-trip once-per-
   batch cost (roles, the sign-in log, the day's release, DATA_VERSION, deckStats' three HEAD
   counts, and the audit line). Budgets below are those measurements x1.2, rounded up. */
test('speed: the same rows in more slices cost linearly, not per-slice', async () => {
  resetCaches();
  const one = counting(emptyBook());
  await withFakeSupabase(one.db, async () => {
    for (const body of sliceRequests(30, 2000, 'U1', '2026-09-22', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')) {
      await post(body);
    }
  });
  const oneSlice = one.stat();

  resetCaches();
  const six = counting(emptyBook());
  await withFakeSupabase(six.db, async () => {
    for (const body of sliceRequests(30, 5, 'U1', '2026-09-22', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')) {
      await post(body);
    }
  });
  const sixSlices = six.stat();

  const PER_SLICE_CEILING = 6;   // measured marginal cost per extra slice: 5, x1.2 rounded up
  const ONCE_CEILING = 11;       // measured once-per-batch cost: 9, x1.2 rounded up
  const advice = '\n  A future change that pushes past this is very likely re-doing something ' +
    'per slice that belongs on the isLast branch only (CLAUDE.md rule 1).';

  assert.ok(oneSlice.trips <= PER_SLICE_CEILING + ONCE_CEILING,
    `30 rows in one slice took ${oneSlice.trips} trips (budget ${PER_SLICE_CEILING + ONCE_CEILING}).` + advice);
  assert.ok(sixSlices.trips <= 6 * PER_SLICE_CEILING + ONCE_CEILING,
    `30 rows in six slices took ${sixSlices.trips} trips ` +
    `(budget ${6 * PER_SLICE_CEILING + ONCE_CEILING} = 6 slices x ${PER_SLICE_CEILING} + ${ONCE_CEILING}).` + advice);
  assert.ok(sixSlices.trips - oneSlice.trips <= 5 * PER_SLICE_CEILING,
    `going from one slice to six added ${sixSlices.trips - oneSlice.trips} trips ` +
    `(budget ${5 * PER_SLICE_CEILING} for the five extra slices) -- cost per slice must stay flat.` + advice);

  // THE SHARP GUARD: whatever the slice count, the once-per-batch operations must run
  // EXACTLY ONCE across the whole upload, not once per slice.
  assert.equal(six.count('settings:upsert'), 1,
    'DATA_VERSION must move once per upload, not once per slice');
  assert.equal(six.count('followup_status:select:head'), 3,
    'deckStats is three HEAD counts, run once per upload (isLast) -- not once per slice');
  assert.equal(six.count('audit_log:insert'), 1,
    'the upload audit line must be written once per upload, not once per slice');
});
