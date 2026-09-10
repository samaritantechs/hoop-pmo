import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';

/* =========================================================================================
   ONE ADVANCE A MONTH, AND THE READ-BACK OF WHAT WAS FILLED IN.

     "One shouldn't be able to request advance more than once in a single month from now on.
      One had been there and second real one already, so I rejected the 1st one with comment
      trial -- that's why we don't need to treat the old one but treat the future, from now on."

     "At advance request -- they need the below report of my request to have data columns of
      what they filled so as to know the reference."

   A DECLINED REQUEST DOES NOT COUNT. That is the shape of the whole rule rather than a detail
   of it: the owner's own fix for the duplicate was to DECLINE the trial so the real one could
   stand. If a decline still occupied the month, that fix would not have worked and somebody
   would be locked out of a month by a mistake. A decline is the eraser.

   MEASURED ON THE MONTH THE ADVANCE IS *FOR*, never on the day the button was pressed. One
   advance against one payroll month is the point of the rule -- SOP G.5's ceiling is a
   percentage of that month's salary -- and requested_at would let two requests for September
   be filed either side of the 1st of October and both stand.

   AND IT REFUSES, WHERE THE DEADLINE ONLY FLAGS. The two rules are deliberately opposite in
   kind: lateness is a judgement the approver is entitled to make, a second advance against one
   month's salary is something the office has decided does not happen.
   ========================================================================================= */
const ASKER = { code: 'A1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['advreq'], readOnly: false };
const MATE = { code: 'A2', name: 'ASHA M', role: 'OFFICER', teams: null, tabs: ['advreq'], readOnly: false };
const APPROVER = { code: 'D1', name: 'NEEMA M', role: 'OFFICER', teams: null, tabs: ['advappr'], readOnly: false };
const HR = { code: 'H1', name: 'SIPHO K', role: 'HR', teams: null, tabs: ['advrep'], readOnly: false };

const GOOD = { amount: 100000, applyDate: '2026-09-10', bank: 'CRDB', account: '0150123456' };
const advDb = (o = {}) => fakeDb({
  staff_advances: o.rows || [], staff_salaries: [], settings: o.settings || [],
});
const anAdv = o => ({
  id: o.id || 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa', requested_at: o.at || '2026-09-05T06:00:00Z',
  staff_code: o.code || 'A1', staff_name: o.name || 'JUMA G', staff_role: 'OFFICER',
  apply_date: o.applyDate || '2026-09-05', amount: 200000,
  status: o.status || 'pending', approved_amount: null, comment: o.comment || null,
  decided_by: null, decided_at: null, bank_name: 'CRDB', account_no: '0150',
  late: null, salary_at_request: null, cap_amount: null,
  paid_at: null, paid_by: null, payment_ref: null,
  deducted_at: null, deducted_by: null, deduct_period: null,
  updated_at: o.at || '2026-09-05T06:00:00Z',
});

/* ---------------------------------------------------------------------------------------- */
test('a second request in the same month is refused, and the refusal names the first', async () => {
  const d = advDb();
  await _FNS.advRequest(d, ASKER, GOOD);
  await assert.rejects(() => _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-09-20' }),
    e => {
      assert.equal(e.status, 400);
      assert.match(e.message, /Tayari una ombi|already have an advance request/);
      // Which one is in the way, so nobody has to go looking for it.
      assert.match(e.message, /2026-09-10/);
      assert.match(e.message, /inasubiri|pending/);
      // And the way out, which is not "wait until next month".
      assert.match(e.message, /Likikataliwa|declined/);
      return true;
    });
  assert.equal(d._dump('staff_advances').length, 1, 'and nothing was filed');
});

test('a DECLINED request frees the month -- which is the fix the owner already used', async () => {
  /* "I rejected the 1st one with comment trial." If a decline still held the month, that fix
     would not have worked. It is the eraser, and this is the test that keeps it one. */
  const d = advDb({ rows: [anAdv({ id: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaa1', applyDate: '2026-09-02', status: 'declined', comment: 'trial' })] });
  const r = await _FNS.advRequest(d, ASKER, GOOD);
  assert.equal(r.ok, true, 'the real one goes through');
  assert.equal(d._dump('staff_advances').length, 2);

  // But an APPROVED one holds it, and so does one still waiting.
  const approved = advDb({ rows: [anAdv({ applyDate: '2026-09-02', status: 'approved' })] });
  await assert.rejects(() => _FNS.advRequest(approved, ASKER, GOOD), /Tayari una ombi|already have/);
  const pending = advDb({ rows: [anAdv({ applyDate: '2026-09-02', status: 'pending' })] });
  await assert.rejects(() => _FNS.advRequest(pending, ASKER, GOOD), /Tayari una ombi|already have/);
});

test('the month is the one the advance is FOR, not the day the button was pressed', async () => {
  /* A request filed on the 30th of September FOR October is an October advance. Keying the
     rule on requested_at would let two September advances be filed either side of a month end
     and both stand -- which is the loophole, not the rule. */
  const d = advDb({ rows: [anAdv({ at: '2026-09-30T22:00:00Z', applyDate: '2026-10-01' })] });
  const sept = await _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-09-28' });
  assert.equal(sept.ok, true, 'September is still free: that row is October’s');
  await assert.rejects(() => _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-10-20' }),
    /Tayari una ombi|already have/, 'and October is taken');
});

test('it is one advance per PERSON, and a different month is always free', async () => {
  const d = advDb();
  await _FNS.advRequest(d, ASKER, GOOD);
  // A colleague's September is their own.
  assert.equal((await _FNS.advRequest(d, MATE, GOOD)).ok, true);
  // And next month is open for both.
  assert.equal((await _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-10-03' })).ok, true);
  assert.equal(d._dump('staff_advances').length, 3);
});

test('nothing already filed is touched, flagged or deleted by the rule arriving', async () => {
  /* "We don't need to treat the old one but treat the future -- from now on." The rule governs
     new requests. A month that already holds two live rows keeps both, and the only thing it
     cannot do is take a third. */
  const d = advDb({ rows: [
    anAdv({ id: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaa1', applyDate: '2026-09-02', status: 'pending' }),
    anAdv({ id: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaa2', applyDate: '2026-09-06', status: 'approved' }),
  ] });
  const before = JSON.stringify(d._dump('staff_advances'));
  await assert.rejects(() => _FNS.advRequest(d, ASKER, GOOD), /Tayari una ombi|already have/);
  assert.equal(JSON.stringify(d._dump('staff_advances')), before,
    'both survive exactly as they were; the rule is not retroactive');
  // And both still read, decide and pay as they always did.
  assert.equal((await _FNS.advMine(d, ASKER)).rows.length, 2);
  assert.equal((await _FNS.advQueue(d, APPROVER, {})).rows.length, 2);
  assert.equal((await _FNS.advReport(d, HR, {})).rows.length, 2);
});

test('the ceiling is a setting, so the office can relax it without a deploy', async () => {
  const d = advDb({ settings: [{ key: 'ADVANCE_MAX_PER_MONTH', value: '2' }] });
  await _FNS.advRequest(d, ASKER, GOOD);
  assert.equal((await _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-09-20' })).ok, true);
  await assert.rejects(() => _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-09-25' }),
    /Tayari una ombi|already have/, 'the third is still refused');
  // Nonsense in the setting falls back to the rule as asked for, never to no rule at all.
  const junk = advDb({ settings: [{ key: 'ADVANCE_MAX_PER_MONTH', value: 'many' }] });
  await _FNS.advRequest(junk, ASKER, GOOD);
  await assert.rejects(() => _FNS.advRequest(junk, ASKER, { ...GOOD, applyDate: '2026-09-20' }),
    /Tayari una ombi|already have/);
});

test('the form is told which months are spoken for, before the button', async () => {
  /* This rule REFUSES, unlike the deadline which only flags -- so a form that reveals it after
     the request has been typed and sent is a form that wastes the trip. */
  const d = advDb({ rows: [
    anAdv({ id: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaa1', applyDate: '2026-09-02', status: 'pending' }),
    anAdv({ id: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaa2', applyDate: '2026-08-02', status: 'declined' }),
    anAdv({ id: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaa3', applyDate: '2026-07-02', status: 'approved' }),
  ] });
  const mine = await _FNS.advMine(d, ASKER);
  assert.equal(mine.maxPerMonth, 1);
  assert.deepEqual(mine.usedMonths.sort(), ['2026-07', '2026-09'],
    'August is free again because that request was declined');
});

test('before the migration the rule still holds, on the server’s own number', async () => {
  /* The setting arrives by hand like every other. Until it is pasted, advPolicy falls back to
     1 -- so the rule asked for is in force from the deploy, not from the paste. */
  const d = advDb();
  assert.equal((await _FNS.advMine(d, ASKER)).maxPerMonth, 1);
  await _FNS.advRequest(d, ASKER, GOOD);
  await assert.rejects(() => _FNS.advRequest(d, ASKER, { ...GOOD, applyDate: '2026-09-20' }),
    /Tayari una ombi|already have/);
});

/* ---------------------------------------------------------------------------------------- */
const HTML = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
const fnSrc = name => {
  const at = HTML.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is not defined in portal.html');
  return HTML.slice(at, HTML.indexOf('\n}', at) + 2);
};

test('what the requester filled is on the list they read back', () => {
  /* HR's report has carried the bank and the account since the beginning, because HR pays from
     them. The two panes where the request is actually LOOKED AT showed everything except the
     one thing somebody wants to check afterwards: which account they typed. */
  const t = fnSrc('advTable');
  assert.match(t, /<th>Benki \/ Bank or carrier<\/th>/);
  assert.match(t, /<th>Namba ya akaunti \/ Account<\/th>/);
  assert.match(t, /r\.bank\?esc\(r\.bank\)/);
  assert.match(t, /r\.account\?esc\(r\.account\)/);
  /* An account number is read digit by digit against a bank app, so it is monospaced -- and an
     empty one reads as empty rather than as a blank cell nobody can tell from a space. */
  assert.match(t, /font-family:ui-monospace/);
  assert.match(t, /—/);
  // advTable is the asker's list AND the approver's queue, so both get it from one change.
  assert.match(fnSrc('drawAdvReq'), /advTable\(rows,false\)/);
});

test('the form says the month rule before the button, and disables it', () => {
  const src = fnSrc('drawAdvReq');
  assert.match(src, /usedMonths/);
  assert.match(src, /monthTaken/);
  assert.match(src, /b\.disabled=monthTaken\(\)/,
    'a button whose only answer is a refusal is not a button');
  // The way out is on screen: a decline frees the month.
  assert.match(src, /Likikataliwa[\s\S]*declined/);
  /* And a refusal from the server must not hand the button back enabled -- ruleLine owns that
     state, so the catch asks it again rather than guessing. */
  assert.match(src, /b\.disabled=false;\s*\n\s*\/\/[\s\S]*?ruleLine\(\);/);
});

test('top-up through commission sign-off sit under Sales, and advances keep their own group', () => {
  /* "Request topup to commission sigoff should be moved to sales segment in the nav pane, not
     advances." The range the owner named, by its endpoints, as it stood on their screen. */
  const cat = HTML.slice(HTML.indexOf('var NAV='), HTML.indexOf('var GROUPS='));
  const groupOf = nav => {
    const m = new RegExp("\\{ g:'([a-z]+)',\\s+t:'[a-z]+',\\s+nav:'" + nav + "'").exec(cat);
    assert.ok(m, nav + ' is not in the nav catalog');
    return m[1];
  };
  for (const nav of ['topupreq', 'topups', 'lossreq', 'loss', 'commission', 'commappr']) {
    assert.equal(groupOf(nav), 'mauzo', nav + ' belongs to Sales now');
  }
  for (const nav of ['advreq', 'advappr', 'advrep']) {
    assert.equal(groupOf(nav), 'adv', nav + ' is what the Salary advance group is for');
  }
  /* THE GROUPING IS A LABEL, NOT A GRANT. Moving a pane between headings must not change who
     can open it -- the nav key is the permission, and it is untouched. */
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const navs = /const NAV_TABS = \[([^\]]+)\]/.exec(api)[1];
  for (const nav of ['topupreq', 'topups', 'lossreq', 'loss', 'commission', 'commappr']) {
    assert.match(navs, new RegExp("'" + nav + "'"), nav + ' is still its own nav key');
  }
});

test('the migration changes no row, and cannot fail the paste', () => {
  const sql = fs.readFileSync(new URL('../db/migrations/RUN-ME-2026-09-11-advance-once-a-month.sql', import.meta.url), 'utf8');
  /* "From now on" -- nothing already filed is rewritten. A migration for a new rule that
     UPDATEs the rows the rule was not in force for is how history stops being history. */
  assert.ok(!/\bupdate\s+staff_advances\b|\bdelete\s+from\s+staff_advances\b/i.test(sql),
    'it must not touch a single existing request');
  assert.match(sql, /ADVANCE_MAX_PER_MONTH', '1'/);
  assert.match(sql, /on conflict \(key\) do nothing/);
  /* The table is live and may already hold duplicates from before the rule existed, so the
     index goes in a block that cannot abort the paste -- and says how to find them. */
  assert.match(sql, /exception when others then/);
  assert.match(sql, /where status <> 'declined'/, 'a decline frees the month here too');
  assert.match(sql, /raise notice/);
});
