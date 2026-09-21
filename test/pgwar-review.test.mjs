/* WHAT THE REVIEW OF THE POSTGRES WAR FOUND, PINNED.

   1. The refused attempt is the one the audit log is FOR. The first cut of audited()'s
      side-channel set ctx.before AFTER the "already decided / already paid" guards had thrown,
      so a double-click on Pay, or two approvers acting on the same request, was logged with
      before: null -- the one fact worth reading dropped. The row is handed over the moment it
      is read now, and the refusal path reads it itself when a handler refused before it ever
      got that far.
   2. memoByDataVersion builds once under concurrent callers, like every other memo this
      change added. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.mjs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
const { _FNS } = await import('../api/portal.js');
const { audited } = await import('../api/_lib/audit.js');
const { memoByDataVersion } = await import('../api/_lib/memo.js');

const FIN = { code: 'F1', name: 'JANETH', role: 'OFFICER', teams: null, tabs: ['topups'], readOnly: false };
const ID = '0a1b2c3d-1111-4222-8333-0a1b2c3d0a1b';
const aTopup = status => ({ id: ID, requested_at: '2026-09-01T06:00:00Z',
  staff_code: 'A1', staff_name: 'JUMA G', staff_role: 'OFFICER',
  imei: '351388334583295', customer: 'Alafati', customer_phone: '0712000000',
  payer_name: 'JUMA', paid_amount: 100000, proof_ref: 'MPESA-1',
  price: 450000, balance: 350000, status, comment: null,
  verified_by: 'JANETH', verified_at: '2026-09-01T07:00:00Z', paid_by: 'JANETH', paid_at: '2026-09-01T08:00:00Z',
  payment_ref: 'X', unlocked_by: 'JANETH', unlocked_at: '2026-09-01T09:00:00Z',
  chk_request: true, chk_paid_to: true, chk_watu: true, chk_auditor: true,
  updated_by: 'JANETH', updated_at: '2026-09-01T09:00:00Z' });

test('a refused "already complete" top-up step still logs what the row looked like', async () => {
  const db = fakeDb({ topups: [aTopup('unlocked')], watu_loans: [], audit_log: [] });
  const args = { id: ID, step: 'verify', imeiOk: true, payerOk: true };
  await assert.rejects(() => audited(db, FIN, 'topupUpdate', args, () => _FNS.topupUpdate(db, FIN, args), {}),
    /imekamilika|already complete/);
  const [row] = db._dump('audit_log');
  assert.equal(row.ok, false);
  assert.deepEqual(row.before, { status: 'unlocked' },
    'the guard threw AFTER the row was handed over, so the refusal carries the state it refused against');
  assert.equal(row.after, null);
});

test('a handler that refuses before it ever reads the row leaves audited() to read it on the refusal path', async () => {
  /* The migration-not-run branch: the handler bails on its own read failing, never reaching
     the hand-over. Nothing was written, so the refusal path's own read is still "before". */
  const db = fakeDb({ topups: [aTopup('requested')], watu_loans: [], audit_log: [] },
    { missingColumns: { topups: ['chk_auditor'] } });
  const args = { id: ID, step: 'verify', imeiOk: true, payerOk: true };
  await assert.rejects(() => audited(db, FIN, 'topupUpdate', args, () => _FNS.topupUpdate(db, FIN, args), {}));
  const [row] = db._dump('audit_log');
  assert.equal(row.ok, false);
  assert.deepEqual(row.before, { status: 'requested' }, 'read on the way out, since the handler never handed it over');
});

test('memoByDataVersion builds once for two callers arriving together on a cold cache', async () => {
  const db = fakeDb({ settings: [{ key: 'DATA_VERSION', value: 'v1' }] });
  const memo = memoByDataVersion(60000);
  let builds = 0;
  const build = async () => { builds++; await new Promise(r => setTimeout(r, 5)); return { n: builds }; };
  const [a, b] = await Promise.all([memo(db, build, 1000), memo(db, build, 1000)]);
  assert.equal(builds, 1, 'the in-flight build is shared');
  assert.deepEqual(a, b);
  const c = await memo(db, build, 2000);
  assert.equal(builds, 1, 'and the settled value is memoised after it');
  assert.deepEqual(c, a);
  db._dump('settings')[0].value = 'v2';
  await memo(db, build, 3000);
  assert.equal(builds, 2, 'a moved DATA_VERSION rebuilds');
});
