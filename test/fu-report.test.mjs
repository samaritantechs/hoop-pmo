import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { _FNS } from '../api/portal.js';
import { _setFetch } from '../api/_lib/mail.js';
import { callApi, fuBucketOf, FU_BUCKETS, FU_STATUSES, FU_NEED_COMMENT } from '../api/_lib/call-core.js';

/* =========================================================================================
   THE CREDIT DEPARTMENT'S DAY -- the report the SOP has always asked for and nothing here
   could produce.

     A.4 "Log the outcome of every call."
     A.5 "Generate a report covering: stolen devices, maintenance, not available, paid,
          unpaid, and unresponded calls."
     A.6 "Send the report to the General Manager."
     B.5 "... escalating to the RSM as a last resort."
     D   "The credit department's default rate on the WATU system must not exceed 5%."

   THE PERMISSION IS THE NAV -- "I implement tasks/roles by nav tabs not role based". Nothing
   here names a credit officer or a GM; the fixtures hold panes.
   ========================================================================================= */
const CREDIT = { code: 'C1', name: 'NEEMA M', role: 'OFFICER', teams: null, tabs: ['furep'], readOnly: false };
const CALLER = { code: 'K1', name: 'JUMA G', role: 'OFFICER', teams: null, tabs: ['reports'], readOnly: false };
const VIEWER = { code: 'V1', name: 'Auditor', role: 'AUDITOR', teams: null, tabs: ['furep'], readOnly: true };
const OWNER = { code: 'X', name: 'Peter', role: 'ADMIN', teams: null, tabs: ['settings'], readOnly: false };
const KIN = { code: 'T1', name: 'Timu', role: 'OFFICER', teams: ['KINONDONI'], tabs: ['furep'], readOnly: false };

const TODAY = '2026-09-09';
const NOW = Date.parse(TODAY + 'T12:00:00+03:00');
/* An EAT timestamp as the database would store it: 09:00 in Dar es Salaam is 06:00Z. */
const eat = (day, hhmm) => new Date(Date.parse(day + 'T' + hhmm + ':00Z') - 3 * 3600000).toISOString();
const note = o => ({
  imei: o.imei, team: o.team || 'KINONDONI', client_name: o.name || ('Mteja ' + o.imei),
  fu_status: o.fu === undefined ? 'ANALIPA LEO' : o.fu, comment: o.comment || '',
  created_at: o.at || eat(TODAY, '09:00'), created_by: o.by || 'NEEMA M',
});
const log = o => ({
  ref: o.ref === undefined ? null : o.ref, outcome: o.outcome || 'CONNECTED', portfolio: o.portfolio !== false,
  call_date: o.day || TODAY, officer: o.by || 'NEEMA M', team: o.team || 'KINONDONI',
});
const deckRow = o => ({ imei: o.imei, client_name: o.name || ('Mteja ' + o.imei), team: o.team || 'KINONDONI',
  contact: o.contact || '0712000000', days_offline: o.off == null ? 3 : o.off, deck_date: o.deck || TODAY });

const fuDb = (o = {}) => fakeDb({
  followup_comments: o.notes || [], call_logs: o.logs || [],
  followup_status: o.deck || [], settings: o.settings || [],
});

function captureMail() {
  const sent = [];
  const prev = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  _setFetch(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ id: 'msg_' + sent.length }) };
  });
  return { sent, restore() { _setFetch(null); if (prev == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; } };
}

/* ---------------------------------------------------------------------------------------- */
test('follow-up vocabulary: the two words the SOP needed, and the buckets read the WORDS not the list', () => {
  // A phone in the shop is not a customer refusing to pay; an RSM's file is not "OTHERS".
  assert.ok(FU_STATUSES.includes('MATENGENEZO'), 'maintenance is a status of its own (SOP A.5)');
  assert.ok(FU_STATUSES.includes('IMEPELEKWA KWA RSM'), 'escalation to the RSM is a status of its own (SOP B.5)');
  for (const s of ['MATENGENEZO', 'IMEPELEKWA KWA RSM']) {
    assert.ok(FU_NEED_COMMENT.includes(s), s + ' is useless without a sentence saying what and why');
  }
  // Nothing was taken away: handsets already in the field keep every word they know.
  for (const s of ['AMETOA AHADI', 'ANALIPA LEO', 'HAPATIKANI', 'HANA USHIRIKIANO',
    'SIMU IPO KWA MTU MWINGINE', 'SIMU IMEIBIWA / IMEPOTEA', 'ANA NAMBA NYINGINE', 'OTHERS']) {
    assert.ok(FU_STATUSES.includes(s), s + ' must not disappear from under a phone in the field');
  }
  // The bucket is decided by the words, so a status the office invents still counts.
  assert.equal(fuBucketOf('SIMU IMEIBIWA / IMEPOTEA'), 'stolen');
  assert.equal(fuBucketOf('simu imepotea kabisa'), 'stolen', 'case and extra words do not matter');
  assert.equal(fuBucketOf('MATENGENEZO'), 'maintenance');
  assert.equal(fuBucketOf('Iko service kwa fundi'), 'maintenance');
  assert.equal(fuBucketOf('HAPATIKANI'), 'notAvailable');
  assert.equal(fuBucketOf('ANALIPA LEO'), 'paid');
  assert.equal(fuBucketOf('AMELIPA JANA'), 'paid');
  // A PROMISE IS NOT MONEY.
  assert.equal(fuBucketOf('AMETOA AHADI'), 'unpaid');
  assert.equal(fuBucketOf('HANA USHIRIKIANO'), 'unpaid');
  assert.equal(fuBucketOf('IMEPELEKWA KWA RSM'), 'unpaid');
  assert.equal(fuBucketOf('ANA NAMBA NYINGINE'), 'unpaid');
  assert.equal(fuBucketOf('OTHERS'), 'unpaid');
  assert.equal(fuBucketOf('KITU KIPYA KABISA'), 'unpaid', 'a word nobody planned for still lands somewhere');
  assert.equal(fuBucketOf(''), null, 'nothing logged decides nothing');
  assert.equal(fuBucketOf(null), null);
  assert.deepEqual(FU_BUCKETS, ['paid', 'unpaid', 'notAvailable', 'stolen', 'maintenance']);
});

test('the follow-up report is its own nav, and the send is a write the audit log keeps', async () => {
  const d = fuDb({ notes: [note({ imei: '1' })] });
  await assert.rejects(() => _FNS.fuOutcomes(d, CALLER, {}), e => e.status === 403,
    'holding Ripoti za simu is not holding this report');
  await assert.rejects(() => _FNS.fuOutcomesSend(d, CALLER, {}), e => e.status === 403);
  // View-only reads the report and cannot send it out of the building.
  assert.ok((await _FNS.fuOutcomes(d, VIEWER, {})).totals);
  await assert.rejects(() => _FNS.fuOutcomesSend(d, VIEWER, {}), e => e.status >= 400 && e.status < 500);
  // ADMIN IS FULL ACCESS EVERYWHERE.
  assert.ok((await _FNS.fuOutcomes(d, OWNER, {})).totals);
  const src = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  assert.match(src, /const NAV_TABS = \[[^\]]*'furep'/, 'furep is a nav the owner can tick');
  assert.match(src, /AUDITED\.add\('fuOutcomesSend'\)/, 'sending the department\'s day to the GM is logged');
  const ed = /const EDITABLE_SETTINGS = \[([\s\S]*?)\]/.exec(src);
  for (const k of ['CALL_SCRIPT', 'KPI_DEFAULT_RATE']) {
    assert.ok(ed[1].includes(`'${k}'`), k + ' is settable from the Settings pane, no deploy needed');
  }
});

/* ---------------------------------------------------------------------------------------- */
test('one customer, one bucket: the six numbers add up to the book', async () => {
  const d = fuDb({
    notes: [
      note({ imei: 'A', fu: 'ANALIPA LEO' }),
      note({ imei: 'B', fu: 'AMETOA AHADI' }),
      note({ imei: 'C', fu: 'HAPATIKANI' }),
      note({ imei: 'D', fu: 'SIMU IMEIBIWA / IMEPOTEA' }),
      note({ imei: 'E', fu: 'MATENGENEZO' }),
      note({ imei: 'F', fu: 'IMEPELEKWA KWA RSM' }),
    ],
    // G was dialled and nothing came back; H is on the book and nobody rang.
    logs: [log({ ref: 'G', outcome: 'MISSED' }), log({ ref: 'A' }), log({ ref: 'A' })],
    deck: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(i => deckRow({ imei: i })),
  });
  const r = await _FNS.fuOutcomes(d, CREDIT, { from: TODAY, to: TODAY });
  const t = r.totals;
  assert.equal(t.paid, 1); assert.equal(t.unpaid, 2, 'a promise and an RSM escalation are both still unpaid');
  assert.equal(t.notAvailable, 1); assert.equal(t.stolen, 1); assert.equal(t.maintenance, 1);
  assert.equal(t.unresponded, 1, 'dialled, nothing logged');
  assert.equal(t.notCalled, 1, 'on the book, never rung');
  assert.equal(t.customers, 8);
  const summed = r.kinds.reduce((s, k) => s + t[k], 0);
  assert.equal(summed, t.customers, 'the buckets PARTITION -- nobody counted twice, nobody missed');
  assert.equal(t.logged, 6); assert.equal(t.calls, 3); assert.equal(t.dialled, 2);
  assert.equal(r.deckDate, TODAY);
  assert.equal(r.from, TODAY); assert.equal(r.to, TODAY);
  // Every row carries the bucket it was counted in, so a tile can filter the table under it.
  const by = {}; for (const row of r.rows) by[row.imei] = row.kind;
  assert.deepEqual(by, { A: 'paid', B: 'unpaid', C: 'notAvailable', D: 'stolen', E: 'maintenance',
    F: 'unpaid', G: 'unresponded', H: 'notCalled' });
  assert.equal(r.rows.find(x => x.imei === 'A').callsMade, 2);
  assert.equal(r.rows.find(x => x.imei === 'A').by, 'NEEMA M');
  assert.equal(r.rows.find(x => x.imei === 'H').status, '', 'nothing was logged, so nothing is claimed');
  // Worst first: what somebody must act on before what is settled.
  assert.equal(r.rows[0].kind, 'stolen');
  assert.equal(r.rows[r.rows.length - 1].kind, 'paid');
});

test('the LAST word of the day wins, and a note with no status is contact with nothing to show', async () => {
  const d = fuDb({
    notes: [
      note({ imei: 'A', fu: 'HAPATIKANI', at: eat(TODAY, '09:00') }),
      note({ imei: 'A', fu: 'ANALIPA LEO', at: eat(TODAY, '16:00') }),
      note({ imei: 'B', fu: '', comment: 'Nimeongea na mkewe' }),
    ],
    logs: [log({ ref: 'A' })],
  });
  const r = await _FNS.fuOutcomes(d, CREDIT, { from: TODAY, to: TODAY });
  assert.equal(r.totals.paid, 1, '"hapatikani" at nine and "analipa leo" at four is a customer who paid');
  assert.equal(r.totals.notAvailable, 0);
  assert.equal(r.totals.unpaid, 1, 'a comment with no status is contact that produced nothing -- never paid');
  assert.equal(r.rows.find(x => x.imei === 'B').comment, 'Nimeongea na mkewe');
});

test('the window is EAT days, so a follow-up logged before 03:00 is not filed under yesterday', async () => {
  const d = fuDb({
    notes: [
      note({ imei: 'EARLY', at: eat(TODAY, '01:30') }),        // 22:30Z yesterday
      note({ imei: 'LATE', at: eat(TODAY, '23:30') }),         // 20:30Z today
      note({ imei: 'YESTERDAY', at: eat('2026-09-08', '23:30') }),
      note({ imei: 'TOMORROW', at: eat('2026-09-10', '00:30') }),
    ],
  });
  const r = await _FNS.fuOutcomes(d, CREDIT, { from: TODAY, to: TODAY });
  assert.deepEqual(r.rows.map(x => x.imei).sort(), ['EARLY', 'LATE'],
    'the Dar es Salaam day, both ends of it, and nothing from the days either side');
  assert.equal(r.rows.find(x => x.imei === 'EARLY').day, TODAY);
  // A wider window picks up the neighbours.
  const wide = await _FNS.fuOutcomes(d, CREDIT, { from: '2026-09-08', to: '2026-09-10' });
  assert.equal(wide.totals.logged, 4);
});

test('today by default, a period on request, and a team narrowed only within the code\'s own scope', async () => {
  const d = fuDb({
    notes: [
      note({ imei: 'TODAY1', at: eat(TODAY, '10:00') }),
      note({ imei: 'OLD', at: eat('2026-09-01', '10:00') }),
      note({ imei: 'OTHER', team: 'TEMEKE', at: eat(TODAY, '10:00') }),
    ],
  });
  // No dates at all: this is a DAILY report, so it opens on today alone.
  const today = await _FNS.fuOutcomes(d, OWNER, {});
  assert.equal(today.from, todayReal(), 'defaults to the real today');
  const day = await _FNS.fuOutcomes(d, OWNER, { from: TODAY, to: TODAY });
  assert.deepEqual(day.rows.map(x => x.imei).sort(), ['OTHER', 'TODAY1']);
  const period = await _FNS.fuOutcomes(d, OWNER, { from: '2026-09-01', to: TODAY });
  assert.equal(period.totals.logged, 3);
  // A team filter inside the period.
  const one = await _FNS.fuOutcomes(d, OWNER, { from: TODAY, to: TODAY, team: 'temeke' });
  assert.deepEqual(one.rows.map(x => x.imei), ['OTHER']);
  assert.equal(one.team, 'TEMEKE');
  // A code scoped to its own team never sees another's, filter or no filter.
  const mine = await _FNS.fuOutcomes(d, KIN, { from: TODAY, to: TODAY });
  assert.deepEqual(mine.rows.map(x => x.imei), ['TODAY1']);
  const cheeky = await _FNS.fuOutcomes(d, KIN, { from: TODAY, to: TODAY, team: 'TEMEKE' });
  assert.deepEqual(cheeky.rows, [], 'asking for somebody else\'s team returns nothing, never theirs');
  // A date that is not a date falls back rather than throwing at somebody mid-report.
  assert.ok((await _FNS.fuOutcomes(d, OWNER, { from: 'last week', to: 'now' })).totals);
});
function todayReal() { return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10); }

test('the per-officer table says who logged what, and who only dialled', async () => {
  const d = fuDb({
    notes: [
      note({ imei: 'A', fu: 'ANALIPA LEO', by: 'NEEMA M' }),
      note({ imei: 'B', fu: 'SIMU IMEIBIWA / IMEPOTEA', by: 'NEEMA M' }),
      note({ imei: 'C', fu: 'AMETOA AHADI', by: 'ASHA K' }),
    ],
    logs: [log({ ref: 'A', by: 'NEEMA M' }), log({ ref: 'D', by: 'ASHA K' }), log({ ref: 'D', by: 'ASHA K' })],
  });
  const r = await _FNS.fuOutcomes(d, CREDIT, { from: TODAY, to: TODAY });
  const neema = r.byOfficer.find(o => o.officer === 'NEEMA M');
  const asha = r.byOfficer.find(o => o.officer === 'ASHA K');
  assert.equal(neema.logged, 2); assert.equal(neema.paid, 1); assert.equal(neema.stolen, 1);
  assert.equal(neema.dialled, 1);
  assert.equal(asha.logged, 1); assert.equal(asha.unpaid, 1);
  assert.equal(asha.dialled, 1, 'two calls to one customer is one customer dialled');
  assert.equal(r.byOfficer[0].officer, 'NEEMA M', 'busiest first');
  assert.equal(r.totals.unresponded, 1, 'D was dialled twice and never written up');
});

test('a call to somebody who is not on the book is not a customer, and an empty day is an empty report', async () => {
  const d = fuDb({ logs: [log({ ref: null }), log({ ref: '' })] });
  const r = await _FNS.fuOutcomes(d, CREDIT, { from: TODAY, to: TODAY });
  assert.equal(r.totals.customers, 0, 'a call with no IMEI behind it counts as a call, never as a customer');
  assert.equal(r.totals.calls, 2);
  assert.deepEqual(r.rows, []);
  const empty = await _FNS.fuOutcomes(fuDb(), CREDIT, { from: TODAY, to: TODAY });
  assert.equal(empty.totals.customers, 0);
  for (const k of empty.kinds) assert.equal(empty.totals[k], 0, k + ' is zero, not undefined');
  assert.equal(empty.deckDate, null);
});

/* ---------------------------------------------------------------------------------------- */
test('the GM is sent the same six numbers the pane shows (SOP A.6)', async () => {
  const cap = captureMail();
  try {
    const d = fuDb({
      notes: [note({ imei: 'A', fu: 'ANALIPA LEO' }), note({ imei: 'B', fu: 'MATENGENEZO' })],
      logs: [log({ ref: 'C' })],
      settings: [{ key: 'GM_EMAIL', value: 'gm@hoop.co.tz' }],
    });
    const r = await _FNS.fuOutcomesSend(d, CREDIT, { from: TODAY, to: TODAY });
    assert.equal(r.emailed, true);
    assert.equal(cap.sent.length, 1);
    const b = cap.sent[0].body, s = JSON.stringify(b);
    assert.ok(s.includes('gm@hoop.co.tz'));
    assert.match(b.subject, new RegExp(TODAY), 'the period is in the subject line');
    for (const word of ['Paid', 'Unpaid', 'Not available', 'Stolen', 'Maintenance', 'Unresponded']) {
      assert.ok(s.includes(word), 'the GM is sent the "' + word + '" number by name');
    }
    assert.ok(s.includes('NEEMA M'), 'and who sent it');
    // The mail is built from the SAME report the pane draws.
    const pane = await _FNS.fuOutcomes(d, CREDIT, { from: TODAY, to: TODAY });
    assert.deepEqual(r.totals, pane.totals, 'the screen and the GM\'s copy can never disagree');
    // Nobody set: the report still runs and says the mail did not go.
    const quiet = fuDb({ notes: [note({ imei: 'A' })] });
    const r2 = await _FNS.fuOutcomesSend(quiet, CREDIT, { from: TODAY, to: TODAY });
    assert.equal(r2.emailed, false); assert.ok(r2.emailNote); assert.equal(cap.sent.length, 1);
  } finally { cap.restore(); }
});

/* ---------------------------------------------------------------------------------------- */
test('the default-rate KPI is the locked-7 share of the in-window book, against its ceiling', async () => {
  const snap = (imei, o = {}) => ({ imei, client_name: 'C' + imei, client_mobile: '07', team: 'KINONDONI',
    days_offline: o.off == null ? 9 : o.off, has_ever_paid: o.paid !== false, price: 450000,
    created_at: '2026-09-09T06:00:00Z', locked7: !!o.locked, disbursed_date: o.disb || '2026-09-01',
    snapshot_date: o.date || TODAY });
  const d = fakeDb({
    watu_snapshots: [
      // Today: four inside the 45-day window, one of them 7+ offline; one long out of window
      // and locked, which must NOT be counted -- Hoop's burden on it has lapsed.
      snap('A', { locked: true }), snap('B'), snap('C'), snap('D'),
      snap('E', { locked: true, disb: '2026-01-01' }),
      // Yesterday, so recovery has two decks to compare.
      snap('A', { date: '2026-09-08', locked: true }), snap('B', { date: '2026-09-08' }),
    ],
    settings: [],
  });
  const r = await _FNS.recovery(d, { ...OWNER, tabs: ['recovery'], teams: null });
  assert.ok(r.kpi, 'the pane that does the recovery work carries the KPI');
  assert.equal(r.kpi.book, 4, 'the denominator is the in-window book, not the whole file');
  assert.equal(r.kpi.locked, 1);
  assert.equal(r.kpi.pct, 25);
  assert.equal(r.kpi.target, 5, 'SOP D\'s ceiling is the default');
  assert.equal(r.kpi.asOf, TODAY);
  // The ceiling is the owner's to move, and nonsense in the box leaves it where it was.
  const withKpi = async v => {
    const dd = fakeDb({ watu_snapshots: d._dump('watu_snapshots'), settings: [{ key: 'KPI_DEFAULT_RATE', value: v }] });
    return (await _FNS.recovery(dd, { ...OWNER, tabs: ['recovery'], teams: null })).kpi;
  };
  assert.equal((await withKpi('7')).target, 7);
  assert.equal((await withKpi('7.5%')).target, 7.5);
  assert.equal((await withKpi('nonsense')).target, 5);
  assert.equal((await withKpi('-3')).target, 5);
  assert.equal((await withKpi('900')).target, 5);
});

test('the KPI still answers on the very first upload, when there is nothing to compare against', async () => {
  const d = fakeDb({ watu_snapshots: [
    { imei: 'A', client_name: 'A', client_mobile: '07', team: 'KINONDONI', days_offline: 9, has_ever_paid: true,
      price: 450000, created_at: '2026-09-09T06:00:00Z', locked7: true, disbursed_date: '2026-09-01', snapshot_date: TODAY },
    { imei: 'B', client_name: 'B', client_mobile: '07', team: 'KINONDONI', days_offline: 1, has_ever_paid: true,
      price: 450000, created_at: '2026-09-09T06:00:00Z', locked7: false, disbursed_date: '2026-09-01', snapshot_date: TODAY },
  ] });
  const r = await _FNS.recovery(d, { ...OWNER, tabs: ['recovery'], teams: null });
  assert.equal(r.prev, null);
  assert.match(r.note, /Recovery needs two uploads/);
  assert.equal(r.kpi.book, 2); assert.equal(r.kpi.locked, 1); assert.equal(r.kpi.pct, 50);
  // And an empty database says nothing rather than dividing by nothing.
  const bare = await _FNS.recovery(fakeDb({ watu_snapshots: [] }), { ...OWNER, tabs: ['recovery'], teams: null });
  assert.equal(bare.kpi, null);
});

/* ---------------------------------------------------------------------------------------- */
test('the company script reaches the handset on the boot it already makes (SOP A.3, E.5)', async () => {
  const base = () => ({
    settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }, { key: 'DATA_VERSION', value: 'v1' },
      { key: 'CALL_SCRIPT', value: '  Habari, naitwa {jina} kutoka HOOPLOAN.\nNakupigia kuhusu malipo yako.  ' }],
    teams: [{ team: 'KINONDONI', team_code: 'AB2C3D', rsm: 'Anold Sawe' }],
    access_codes: [], followup_status: [], followup_comments: [], call_users: [], call_logs: [],
  });
  const d = fakeDb(base());
  await callApi(d, 'api_callRegister', ['dev-1', 'Ainea', '', '', '0712345678', 'AB2C3D'], NOW);
  const boot = await callApi(d, 'api_callBoot', ['dev-1'], NOW);
  assert.equal(boot.callScript, 'Habari, naitwa {jina} kutoka HOOPLOAN.\nNakupigia kuhusu malipo yako.',
    'trimmed, and the office\'s own line breaks kept');
  assert.ok(boot.fuStatuses.includes('MATENGENEZO'), 'and the handset is offered the new words');
  // Blank is blank: the card shows no script panel rather than an empty box.
  const none = fakeDb({ ...base(), settings: [{ key: 'SYSTEM_OPEN', value: 'YES' }] });
  await callApi(none, 'api_callRegister', ['dev-1', 'Ainea', '', '', '0712345678', 'AB2C3D'], NOW);
  assert.equal((await callApi(none, 'api_callBoot', ['dev-1'], NOW)).callScript, '');
});
