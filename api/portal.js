import { supabase, fetchAll } from './_lib/supabase.js';
import { withApi, gatedUser, isReadOnly } from './_lib/auth.js';
import { audited, AUDITED, auditList } from './_lib/audit.js';
import { todayKey } from './_lib/time.js';
import { summaryFor, reportCore, lifeDayOf, fuStatusConfig, pnorm } from './_lib/call-core.js';

/* =====================================================================================
   POST /api/portal   { code, fn, args }

   The HOOP portal backend: tiles, Teams & codes, Ripoti, Recovery, staff, settings.
   Every write passes through audited() -- who did what lands in audit_log, never the
   payload. A read-only code (AUDITOR) sees everything and changes nothing.

   THE POSTGRES BUDGET, warm, per fn:
     boot       auth+gate (cached) + summary (2-min cache; miss = 3 scoped reads)
                + 1 teams read
     report     3 reads, date-bounded + team-scoped at the database (call-core's own)
     recovery   2 tiny indexed date lookups + 2 day-bounded scoped reads of watu_snapshots
     customers  2 tiny indexed date lookups + 1 deck read + 1 prev-day snapshot read
                + 1 register read (imei,agent,team only) + 1 keyed settings read; all scoped
     portalAddComment  1 stub upsert + 1 comment insert + 1 keyed status update (3 writes)
     customerComments  1 read, keyed by IMEI, newest 100
     teams      1 read;   saveTeam / newTeamCode: 1 read + 1 write
     officers   1 read;   officerActive: 1 write
     codes      3 parallel reads (codes, roles, 1 keyed setting);
                saveAccessCode / deleteAccessCode: 1 write
                deleteRole: 1 bounded codes read + 1 keyed delete + 1 keyed read + 1 write
     settings   1 `in` read; settingSet: 1 write
     salesAudit / agentScore   3 parallel bounded reads each (sales by date range,
                register imei+agent columns / scoped register, agents ~1k) -- see the
                fns' own headers; both are reads, nothing audited
   Row bounds: recovery reads two DAYS of snapshots, team-scoped; nothing reads the whole
   history; the audit list is capped at 200 newest.
   ===================================================================================== */

AUDITED.add('newTeamCode');
AUDITED.add('officerActive');
AUDITED.add('renameAccessCode');
AUDITED.add('portalAddComment');
AUDITED.add('deleteRole');

const K = s => String(s == null ? '' : s).trim().toUpperCase();
const num = v => (typeof v === 'number' ? v : Number(v) || 0);

function requireWrite(user) {
  if (isReadOnly(user)) {
    const e = new Error('Msimbo huu ni wa kuangalia tu. / This is a view-only code.'); e.status = 403; throw e;
  }
}
function requireSettings(user) {
  if (!(user.tabs || []).includes('settings')) {
    const e = new Error('Settings permission is required.'); e.status = 403; throw e;
  }
}
const scopeQ = (user, q) => (user.teams && user.teams.length) ? q.in('team', user.teams.map(K)) : q;

/** The sales audit names people and their kin -- anyone trusted with uploads or
    settings sees it; a plain viewer role does not. */
function requireOps(user) {
  const t = user.tabs || [];
  if (!(t.includes('upload') || t.includes('settings'))) {
    const e = new Error('Ukaguzi wa mauzo unahitaji ruhusa ya upload au settings. / The sales audit needs upload or settings permission.');
    e.status = 403; throw e;
  }
}
const dayShift = (key, days) =>
  new Date(Date.parse(key + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

/* Hope's phone-safe alphabet: no 0/O, no 1/I/L -- these get read out loud. */
const CODE_ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function mintCode(existing) {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)];
    if (!existing.has(c)) return c;
  }
  throw new Error('Could not mint a unique team code.');
}

const FNS = {
  async boot(db, user) {
    const [summary, teams] = await Promise.all([
      summaryFor(db, { name: user.name, role: user.role, teams: user.teams }, Date.now()),
      fetchAll(() => db.from('teams').select('team, team_code, rsm, rsm_no')),
    ]);
    const showCodes = (user.tabs || []).includes('settings') && !isReadOnly(user);
    return {
      name: user.name, role: user.role, tabs: user.tabs, readOnly: !!user.readOnly,
      teams: teams.filter(t => !user.teams || user.teams.some(x => K(x) === K(t.team)))
        .map(t => ({ team: t.team, code: showCodes ? (t.team_code || '') : (t.team_code ? '••••••' : ''),
          rsm: t.rsm || '', rsmNo: t.rsm_no || '' }))
        .sort((a, b) => a.team < b.team ? -1 : 1),
      summary,
      today: todayKey(),
    };
  },

  async report(db, user, args) {
    const a = args || {};
    let scope = user.teams;
    const want = String(a.team || '').trim();
    if (want && (!scope || scope.some(t => K(t) === K(want)))) scope = [want];
    const out = await reportCore(db, scope, a.from, a.to, null, Date.now());
    out.scope = scope || 'ALL';
    return out;
  },

  /* RECOVERY -- who came back after our calls. The newest two uploads, diffed per IMEI:
     paid for the first time, reconnected (days_offline fell), or sank deeper. */
  async recovery(db, user) {
    const one = await db.from('watu_snapshots').select('snapshot_date')
      .order('snapshot_date', { ascending: false }).limit(1);
    if (one.error) throw new Error(one.error.message);
    const latest = one.data && one.data[0] && String(one.data[0].snapshot_date).slice(0, 10);
    if (!latest) return { ok: true, latest: null, prev: null, rows: [], counts: null };
    const two = await db.from('watu_snapshots').select('snapshot_date')
      .lt('snapshot_date', latest).order('snapshot_date', { ascending: false }).limit(1);
    const prev = two.data && two.data[0] && String(two.data[0].snapshot_date).slice(0, 10);
    if (!prev) return { ok: true, latest, prev: null, rows: [], counts: null,
      note: 'Upload mbili zinahitajika kupima recovery — hii ni ya kwanza. / Recovery needs two uploads; this is the first.' };
    const COLS = 'imei, client_name, contact, team, days_offline, has_ever_paid, price, created_at';
    const [cur, old] = await Promise.all([
      fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS).eq('snapshot_date', latest))),
      fetchAll(() => scopeQ(user, db.from('watu_snapshots').select(COLS).eq('snapshot_date', prev))),
    ]);
    // A same-date re-upload appends; the newest row per IMEI within the day wins.
    const byImei = rows => {
      const m = new Map();
      for (const r of rows) {
        const k = String(r.imei);
        const had = m.get(k);
        if (!had || String(r.created_at) > String(had.created_at)) m.set(k, r);
      }
      return m;
    };
    const curM = byImei(cur), oldM = byImei(old);
    const rows = [];
    let paidNew = 0, reconnected = 0, deeper = 0, off = 0;
    for (const [imei, c] of curM) {
      const o = oldM.get(imei);
      if (!o) continue;
      const paid = o.has_ever_paid === false && c.has_ever_paid === true;
      const dOld = num(o.days_offline), dNew = num(c.days_offline);
      const better = dNew < dOld, worse = dNew > dOld;
      if (paid) paidNew++;
      if (better) reconnected++;
      if (worse) deeper++;
      if (paid || better) rows.push({ imei, name: c.client_name, team: c.team,
        was: dOld, now: dNew, paid, price: num(c.price) });
    }
    for (const [imei] of oldM) if (!curM.has(imei)) off++;
    rows.sort((a, b) => (b.paid - a.paid) || (b.was - b.now) - (a.was - a.now));
    return { ok: true, latest, prev,
      counts: { compared: [...curM.keys()].filter(k => oldM.has(k)).length,
        paidNew, reconnected, deeper, leftList: off },
      rows: rows.slice(0, 500) };
  },

  /** THE CUSTOMERS BOOK, split the way Hoop reads it: today's deck inside the 45-day
      window, today's deck beyond it (Hoop's burden has lapsed), and yesterday's (jana).
      The AGENT rides on every row -- who sold the phone is who to lean on, the same
      slot the guarantor held in Hope.
      Budget: 2 tiny indexed date lookups + 1 deck read + 1 prev-day snapshot read +
      1 register read (imei+agent only), all team-scoped; FU vocabulary is 1 keyed read. */
  async customers(db, user) {
    const today = todayKey();
    const d1 = await db.from('followup_status').select('deck_date').not('deck_date', 'is', null)
      .order('deck_date', { ascending: false }).limit(1);
    if (d1.error) throw new Error(d1.error.message);
    const deckDate = d1.data && d1.data[0] ? String(d1.data[0].deck_date).slice(0, 10) : null;
    let prevDate = null;
    if (deckDate) {
      const d2 = await db.from('watu_snapshots').select('snapshot_date').lt('snapshot_date', deckDate)
        .order('snapshot_date', { ascending: false }).limit(1);
      prevDate = d2.data && d2.data[0] ? String(d2.data[0].snapshot_date).slice(0, 10) : null;
    }
    const [deck, prev, agents, fu] = await Promise.all([
      deckDate ? fetchAll(() => scopeQ(user, db.from('followup_status')
        .select('imei, client_name, contact, team, model, price, disbursed_date, days_offline, locked4, locked7, has_ever_paid, fu_status, comment_by')
        .eq('deck_date', deckDate))) : [],
      prevDate ? fetchAll(() => scopeQ(user, db.from('watu_snapshots')
        .select('imei, client_name, client_mobile, team, model, price, disbursed_date, days_offline, locked4, locked7, has_ever_paid, agent, created_at')
        .eq('snapshot_date', prevDate))) : [],
      fetchAll(() => scopeQ(user, db.from('watu_loans').select('imei, agent, team'))),
      fuStatusConfig(db),
    ]);
    const agentOf = {};
    agents.forEach(r => { agentOf[r.imei] = r.agent || ''; });
    const mk = (r, contactKey, refDay) => ({
      imei: r.imei, name: r.client_name || '', phone: r[contactKey] || '',
      team: r.team || '', model: r.model || '', price: num(r.price),
      agent: r.agent !== undefined ? (r.agent || '') : (agentOf[r.imei] || ''),
      daysOff: r.days_offline == null ? null : num(r.days_offline),
      locked7: r.locked7 === true, locked4: r.locked4 === true, paid: r.has_ever_paid === true,
      fu: r.fu_status || '', lifeDay: lifeDayOf(r.disbursed_date, refDay),
    });
    // jana: a same-date re-upload appends, so the newest row per IMEI within the day wins.
    const seen = new Map();
    prev.forEach(r => {
      const had = seen.get(r.imei);
      if (!had || String(r.created_at) > String(had.created_at)) seen.set(r.imei, r);
    });
    const jana = [...seen.values()].map(r => mk(r, 'client_mobile', prevDate));
    const leo = deck.map(r => mk(r, 'contact', today));
    const inWindow = leo.filter(r => r.lifeDay != null && r.lifeDay <= 45);
    const beyond = leo.filter(r => !(r.lifeDay != null && r.lifeDay <= 45));
    const bySunk = (a, b) => num(b.daysOff) - num(a.daysOff);
    inWindow.sort(bySunk); beyond.sort(bySunk); jana.sort(bySunk);
    return { ok: true, deckDate, prevDate, leo45: inWindow, leo45plus: beyond, jana, ...fu };
  },

  /** EVERYONE COMMENTS. Any signed-in portal user except a view-only code can log a
      follow-up on any customer inside their team scope -- same three writes as the
      phone's addComment, actor = the access code's name. */
  async portalAddComment(db, user, args) {
    requireWrite(user);
    const a = args || {};
    const ref = String(a.imei || '').trim();
    if (!ref) throw new Error('IMEI is required.');
    if (user.teams && a.team && !user.teams.some(t => K(t) === K(a.team))) {
      throw new Error('Mteja huyu yuko nje ya timu zako. / That customer is outside your teams.');
    }
    if (!a.fu && !String(a.comment || '').trim()) throw new Error('Chagua hali au andika maoni. / Pick a status or write a comment.');
    const now = new Date().toISOString();
    const { error: sErr } = await db.from('followup_status')
      .upsert({ imei: ref, team: a.team ? K(a.team) : null, client_name: a.name || null },
        { onConflict: 'imei', ignoreDuplicates: true });
    if (sErr) throw new Error(sErr.message);
    const { error: cErr } = await db.from('followup_comments').insert({
      imei: ref, team: a.team ? K(a.team) : null, client_name: a.name || null,
      comment: a.comment || null, fu_status: a.fu || null,
      promise_date: a.promiseDate || null, promise_amt: a.promiseAmt || null,
      created_by: user.name, created_at: now });
    if (cErr) throw new Error(cErr.message);
    const { error: uErr } = await db.from('followup_status').update({
      fu_status: a.fu || null, promise_date: a.promiseDate || null, promise_amt: a.promiseAmt || null,
      last_comment: a.comment || null, comment_by: user.name, comment_at: now, updated_at: now,
    }).eq('imei', ref);
    if (uErr) throw new Error(uErr.message);
    return { ok: true, imei: ref, savedAt: now };
  },

  async customerComments(db, user, args) {
    const ref = String((args && args.imei) || '').trim();
    if (!ref) throw new Error('IMEI is required.');
    const { data, error } = await db.from('followup_comments')
      .select('comment, fu_status, promise_date, created_by, created_at')
      .eq('imei', ref).order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return { ok: true, items: data || [] };
  },

  /* ============ MAUZO: the fraud audit and the agent scorecards (phase 2) ============
     The owner's loop: general duty's sales book diffed against Watu's records finds
     the sale nobody financed; Sipho's register names who answers for it; the daily
     follow-up files say how each agent's customers BEHAVE. */

  /** Every general-duty sale in the window, judged: OK (IMEI in the Watu register),
      DRIFT (in Watu but under a different agent than the commission claims), PENDING
      (not in Watu yet, but too fresh to accuse -- a loan can land a day late), BULK
      (not in Watu, and the buyer phone bought 3+ -- a cash/bulk sale to label, not
      accuse), HAKUNA WATU (not in Watu, old enough to answer for). Every flagged row
      resolves its seller against hoop_agents by payout phone.
      Budget: 3 parallel bounded reads -- sales by date range, the register
      (imei+agent+agent_id only, the whole portfolio, paged), agents (~1k rows). */
  async salesAudit(db, user, args) {
    requireOps(user);
    const a = args || {};
    const today = todayKey();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(a.to || '')) ? a.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(a.from || '')) ? a.from : dayShift(today, -30);
    const [sales, reg, agents] = await Promise.all([
      fetchAll(() => db.from('hoop_sales')
        .select('sale_key, sale_date, receipt_number, client_name, client_phone, imei, model, price, agent, commission_agent, commission_phone')
        .gte('sale_date', from).lte('sale_date', to)),
      fetchAll(() => db.from('watu_loans').select('imei, agent, agent_id')),
      fetchAll(() => db.from('hoop_agents').select('phone, name, national_id, kin_name, kin_phone, role, branch')),
    ]);
    const regBy = new Map(reg.map(r => [String(r.imei), r]));
    const agBy = new Map(agents.map(r => [pnorm(r.phone), r]));
    const freshLine = dayShift(today, -2);          // sale younger than this: too fresh to accuse
    const words = s => new Set(String(s || '').toUpperCase().split(/\s+/).filter(Boolean));
    const overlap = (x, y) => { for (const w of words(x)) if (words(y).has(w)) return true; return false; };
    const notInWatu = sales.filter(s => !regBy.has(String(s.imei)));
    const buyerCount = {};
    notInWatu.forEach(s => { const k = pnorm(s.client_phone); if (k) buyerCount[k] = (buyerCount[k] || 0) + 1; });
    const rows = sales.map(s => {
      const w = regBy.get(String(s.imei)) || null;
      let status;
      if (w) status = (s.commission_agent && w.agent && !overlap(s.commission_agent, w.agent)) ? 'DRIFT' : 'OK';
      else if ((buyerCount[pnorm(s.client_phone)] || 0) >= 3) status = 'BULK';
      else if (String(s.sale_date) >= freshLine) status = 'PENDING';
      else status = 'HAKUNA_WATU';
      const reg2 = agBy.get(pnorm(s.commission_phone)) || null;
      return { saleKey: s.sale_key, date: s.sale_date, receipt: s.receipt_number || '',
        client: s.client_name || '', phone: s.client_phone || '', imei: s.imei,
        model: s.model || '', price: num(s.price), seller: s.commission_agent || s.agent || '',
        sellerPhone: s.commission_phone || '', watuAgent: w ? (w.agent || '') : null,
        watuAgentId: w ? (w.agent_id || '') : null, status,
        reg: reg2 ? { name: reg2.name, nid: reg2.national_id || '', kin: reg2.kin_name || '',
          kinPhone: reg2.kin_phone || '', role: reg2.role || '', branch: reg2.branch || '' } : null };
    });
    const RANK = { HAKUNA_WATU: 0, DRIFT: 1, BULK: 2, PENDING: 3, OK: 4 };
    rows.sort((x, y) => (RANK[x.status] - RANK[y.status]) || (x.date < y.date ? 1 : -1));
    const count = k => rows.filter(r => r.status === k).length;
    return { ok: true, from, to,
      counts: { total: rows.length, ok: count('OK'), drift: count('DRIFT'),
        pending: count('PENDING'), bulk: count('BULK'), candidates: count('HAKUNA_WATU') },
      rows: rows.slice(0, 500) };
  },

  /** Two scoreboards, deliberately NOT merged -- the identities live in different
      systems and a fuzzy merge would lie. WATU side (keyed on Watu's own Agent ID):
      how each agent's customers behave -- % ever paid, % locked, days offline, past-45
      count. SALES side (keyed on normalized payout phone): sales counted per
      commission earner, with the hoop_agents identity attached.
      Budget: 3 parallel bounded reads -- register (scoped), sales by range, agents. */
  async agentScore(db, user, args) {
    requireOps(user);
    const a = args || {};
    const today = todayKey();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(a.to || '')) ? a.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(a.from || '')) ? a.from : dayShift(today, -90);
    const [reg, sales, agents] = await Promise.all([
      fetchAll(() => scopeQ(user, db.from('watu_loans')
        .select('imei, agent, agent_id, team, has_ever_paid, locked4, locked7, days_offline, disbursed_date'))),
      fetchAll(() => db.from('hoop_sales')
        .select('commission_agent, commission_phone, sale_date, price')
        .gte('sale_date', from).lte('sale_date', to)),
      fetchAll(() => db.from('hoop_agents').select('phone, name, role, branch, kin_name, kin_phone')),
    ]);
    const byAgent = new Map();
    for (const r of reg) {
      const key = String(r.agent_id || K(r.agent) || '?');
      let g = byAgent.get(key);
      if (!g) { g = { agent: r.agent || '', agentId: r.agent_id || '', teams: new Set(),
        customers: 0, paid: 0, locked4: 0, locked7: 0, offSum: 0, offN: 0, over45: 0 }; byAgent.set(key, g); }
      g.customers++;
      if (r.team) g.teams.add(r.team);
      if (r.has_ever_paid === true) g.paid++;
      if (r.locked4 === true) g.locked4++;
      if (r.locked7 === true) g.locked7++;
      if (r.days_offline != null) { g.offSum += num(r.days_offline); g.offN++; }
      const l = lifeDayOf(r.disbursed_date, today);
      if (l != null && l > 45) g.over45++;
    }
    const watuAgents = [...byAgent.values()].map(g => ({
      agent: g.agent, agentId: g.agentId, teams: [...g.teams].sort(),
      customers: g.customers,
      paidPct: g.customers ? g.paid / g.customers : null,
      locked4: g.locked4, locked7: g.locked7,
      locked7Pct: g.customers ? g.locked7 / g.customers : null,
      avgOff: g.offN ? Math.round(g.offSum / g.offN) : null,
      over45: g.over45,
    })).sort((x, y) => (y.locked7Pct || 0) - (x.locked7Pct || 0) || y.customers - x.customers);
    const bySeller = new Map();
    for (const s of sales) {
      const key = pnorm(s.commission_phone) || K(s.commission_agent) || '?';
      let g = bySeller.get(key);
      if (!g) { g = { names: {}, phone: s.commission_phone || '', sales: 0, amount: 0 }; bySeller.set(key, g); }
      g.sales++; g.amount += num(s.price);
      const n = String(s.commission_agent || '').trim();
      if (n) g.names[n] = (g.names[n] || 0) + 1;
    }
    const agBy = new Map(agents.map(r => [pnorm(r.phone), r]));
    const sellers = [...bySeller.entries()].map(([key, g]) => {
      const reg2 = agBy.get(key) || null;
      const name = Object.entries(g.names).sort((x, y) => y[1] - x[1]).map(e => e[0])[0] || '';
      return { name, phone: g.phone, sales: g.sales, amount: g.amount,
        reg: reg2 ? { name: reg2.name, role: reg2.role || '', branch: reg2.branch || '',
          kin: reg2.kin_name || '', kinPhone: reg2.kin_phone || '' } : null };
    }).sort((x, y) => y.sales - x.sales);
    return { ok: true, from, to, watuAgents: watuAgents.slice(0, 300), sellers: sellers.slice(0, 300) };
  },

  async saveTeam(db, user, args) {
    requireWrite(user); requireSettings(user);
    const a = args || {};
    const team = K(a.team);
    if (!team) throw new Error('Team name is required.');
    const row = { team, updated_at: new Date().toISOString() };
    if (a.rsm !== undefined) row.rsm = String(a.rsm || '').trim() || null;
    if (a.rsmNo !== undefined) row.rsm_no = String(a.rsmNo || '').trim() || null;
    const { error } = await db.from('teams').upsert(row, { onConflict: 'team' });
    if (error) throw new Error(error.message);
    return { ok: true, team };
  },

  /** Rotating a code releases every handset on the team -- that is what it is FOR. */
  async newTeamCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const team = K(args && args.team);
    if (!team) throw new Error('Team name is required.');
    const teams = await fetchAll(() => db.from('teams').select('team, team_code'));
    if (!teams.some(t => K(t.team) === team)) throw new Error('Unknown team: ' + team);
    const existing = new Set(teams.map(t => K(t.team_code || '').replace(/[^0-9A-Z]/g, '')).filter(Boolean));
    const code = mintCode(existing);
    const { error } = await db.from('teams').update({ team_code: code, updated_at: new Date().toISOString() }).eq('team', team);
    if (error) throw new Error(error.message);
    return { ok: true, team, code };
  },

  /** One box, four keys: name, phone, IMEI, agent. Team-scoped at the database.
      Budget: ONE read, or()-filtered and capped at 30 rows. */
  async customerSearch(db, user, args) {
    const q = String((args && args.q) || '').trim().replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.length < 3) return { ok: true, customers: [] };
    const pat = '*' + q + '*';
    let query = db.from('watu_loans')
      .select('imei, client_name, client_mobile, team, agent, model, days_offline, locked7, snapshot_date')
      .or(['client_name.ilike.' + pat, 'client_mobile.ilike.' + pat,
           'imei.ilike.' + pat, 'agent.ilike.' + pat].join(','))
      .limit(30);
    if (user.teams && user.teams.length) query = query.in('team', user.teams.map(K));
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { ok: true, customers: (data || []).map(r => ({
      imei: r.imei, name: r.client_name || '', phone: r.client_mobile || '',
      team: r.team || '', agent: r.agent || '', model: r.model || '',
      daysOff: r.days_offline, locked7: r.locked7 === true,
      asOf: r.snapshot_date ? String(r.snapshot_date).slice(0, 10) : null })) };
  },

  async officers(db, user) {
    const rows = await fetchAll(() => db.from('call_users')
      .select('user_id, name, team, role, phone, is_leader, active, last_sync'));
    return { ok: true, officers: rows
      .filter(r => !user.teams || !r.team || user.teams.some(t => K(t) === K(r.team)))
      .map(r => ({ userId: r.user_id, name: r.name || '', team: r.team || '', role: r.role || '',
        phone: r.phone || '', leader: !!r.is_leader, active: r.active !== false,
        lastSync: r.last_sync || null }))
      .sort((a, b) => a.name < b.name ? -1 : 1) };
  },

  /** The one-person cut: switch an account off without rotating anybody's code. */
  async officerActive(db, user, args) {
    requireWrite(user); requireSettings(user);
    const uid = String((args && args.userId) || '').trim();
    if (!uid) throw new Error('userId is required.');
    const active = !!(args && args.active);
    const { error } = await db.from('call_users').update({ active }).eq('user_id', uid);
    if (error) throw new Error(error.message);
    return { ok: true, userId: uid, active };
  },

  async accessCodes(db, user) {
    requireSettings(user);
    const [rows, roleRows, hiddenRow] = await Promise.all([
      fetchAll(() => db.from('access_codes').select('code, name, role, teams, tabs')),
      fetchAll(() => db.from('roles').select('role, tabs')),
      db.from('settings').select('value').eq('key', 'ROLES_HIDDEN').maybeSingle(),
    ]);
    const mask = isReadOnly(user);
    let hidden = [];
    try { hidden = JSON.parse((hiddenRow.data && hiddenRow.data.value) || '[]') || []; } catch (e) { hidden = []; }
    const hiddenSet = new Set(hidden.map(K));
    // Every role that exists anywhere is offered everywhere: the roles table first (it
    // carries the tabs), then roles only seen on codes, then the suggested set -- MINUS
    // suggested names the owner has deleted, or the delete would quietly undo itself.
    const seen = new Map();
    roleRows.forEach(r => { const k = K(r.role); if (k) seen.set(k, { role: k, tabs: r.tabs || [] }); });
    rows.forEach(r => { const k = K(r.role); if (k && !seen.has(k)) seen.set(k, { role: k, tabs: [] }); });
    ['ADMIN', 'MANAGER', 'FINANCE', 'RSM', 'CREDIT LEAD', 'GENERAL DUTY', 'STORE', 'IT', 'AUDITOR']
      .forEach(k => { if (!seen.has(k) && !hiddenSet.has(k)) seen.set(k, { role: k, tabs: [] }); });
    // How many codes hold each role decides whether the page may offer to delete it.
    const useCount = {};
    rows.forEach(r => { const k = K(r.role); if (k) useCount[k] = (useCount[k] || 0) + 1; });
    return { ok: true,
      roles: [...seen.values()].map(r => ({ ...r, inUse: useCount[r.role] || 0 }))
        .sort((a, b) => a.role < b.role ? -1 : 1),
      codes: rows.map(r => ({
        code: mask ? '••••••' : r.code, name: r.name, role: r.role,
        teams: r.teams || null, tabs: r.tabs || [] })) };
  },

  /** A role leaves only when NOBODY holds it -- reassign the codes first. A deleted
      suggested-set name also lands on ROLES_HIDDEN (a settings row this fn alone writes;
      it sits outside settingSet's whitelist) or the next read would resurrect it.
      Budget: 1 bounded codes read + 1 keyed delete + 1 keyed read + 1 keyed write. */
  async deleteRole(db, user, args) {
    requireWrite(user); requireSettings(user);
    const role = K(args && args.role);
    if (!role) throw new Error('Role name is required.');
    const codes = await fetchAll(() => db.from('access_codes').select('code, name, role'));
    const holders = codes.filter(c => K(c.role) === role);
    if (holders.length) {
      throw new Error('Role hii bado ina watu ' + holders.length + ' ('
        + holders.slice(0, 5).map(c => c.name || c.code).join(', ')
        + '). Wahamishie role nyingine kwanza. / Still in use -- reassign those codes first.');
    }
    const { error } = await db.from('roles').delete().eq('role', role);
    if (error) throw new Error(error.message);
    const { data } = await db.from('settings').select('value').eq('key', 'ROLES_HIDDEN').maybeSingle();
    let hidden = [];
    try { hidden = JSON.parse((data && data.value) || '[]') || []; } catch (e) { hidden = []; }
    if (!hidden.some(h => K(h) === role)) hidden.push(role);
    const { error: hErr } = await db.from('settings')
      .upsert({ key: 'ROLES_HIDDEN', value: JSON.stringify(hidden) }, { onConflict: 'key' });
    if (hErr) throw new Error(hErr.message);
    return { ok: true, role };
  },

  /** A role is a name plus the doors it opens. Tabs come from a fixed vocabulary; every
      code carrying the role inherits them at sign-in (auth.js resolveTabs). */
  async saveRole(db, user, args) {
    requireWrite(user); requireSettings(user);
    const role = K(args && args.role);
    if (!role) throw new Error('Role name is required.');
    const ALLOWED = new Set(['upload', 'settings', 'dashboard']);
    const tabs = (Array.isArray(args && args.tabs) ? args.tabs : [])
      .map(t => String(t).toLowerCase()).filter(t => ALLOWED.has(t));
    const { error } = await db.from('roles').upsert({ role, tabs }, { onConflict: 'role' });
    if (error) throw new Error(error.message);
    return { ok: true, role, tabs };
  },

  async saveAccessCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const a = args || {};
    const code = String(a.code || '').trim();
    if (!code || !String(a.name || '').trim() || !String(a.role || '').trim()) {
      throw new Error('code, name and role are all required.');
    }
    // Empty is NOT quietly "all teams" -- the caller states ALL, or names the teams.
    const wantsAll = a.allTeams === true;
    const list = Array.isArray(a.teams) ? a.teams.map(K).filter(Boolean) : [];
    if (!wantsAll && !list.length) {
      throw new Error('Chagua ALL au orodhesha timu. / State ALL, or name the teams.');
    }
    const row = { code, name: String(a.name).trim(), role: K(a.role),
      teams: wantsAll ? null : list,
      tabs: Array.isArray(a.tabs) ? a.tabs : [] };
    const { error } = await db.from('access_codes').upsert(row, { onConflict: 'code' });
    if (error) throw new Error(error.message);
    return { ok: true, code };
  },

  /** Change a code's VALUE -- your own included: the row keeps its name, role, teams
      and tabs, only the secret moves. The caller renaming themselves gets self:true so
      the page can re-sign them in with the new code instead of locking them out. */
  async renameAccessCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const from = String((args && args.from) || '').trim();
    const to = String((args && args.to) || '').trim();
    if (!from || !to) throw new Error('Both the old and the new code are required.');
    if (to.length < 4) throw new Error('The new code needs at least 4 characters.');
    if (from === to) return { ok: true, from, to, self: from === user.code };
    const { data: clash } = await db.from('access_codes').select('code').eq('code', to).maybeSingle();
    if (clash) throw new Error('That code is already taken.');
    const { data, error } = await db.from('access_codes').update({ code: to }).eq('code', from).select('code');
    if (error) throw new Error(error.message);
    if (!data || !data.length) throw new Error('Unknown code: ' + from);
    return { ok: true, from, to, self: from === user.code };
  },

  async deleteAccessCode(db, user, args) {
    requireWrite(user); requireSettings(user);
    const code = String((args && args.code) || '').trim();
    if (!code) throw new Error('code is required.');
    if (code === user.code) throw new Error('You cannot delete the code you are signed in with.');
    const { error } = await db.from('access_codes').delete().eq('code', code);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async settings(db, user) {
    requireSettings(user);
    const KEYS = ['SYSTEM_OPEN', 'CALL_BRAND', 'CALL_LOGO_URL', 'FU_STATUSES',
      'CALL_SYNC_SECONDS', 'CALL_MIN_SECS', 'OFFLINE_PACK'];
    const rows = await fetchAll(() => db.from('settings').select('key, value').in('key', KEYS));
    const by = {}; rows.forEach(r => { by[r.key] = r.value; });
    return { ok: true, settings: KEYS.map(k => ({ key: k, value: by[k] == null ? '' : by[k] })) };
  },

  async settingSet(db, user, args) {
    requireWrite(user); requireSettings(user);
    const key = K(args && args.key);
    const ALLOWED = new Set(['SYSTEM_OPEN', 'CALL_BRAND', 'CALL_LOGO_URL', 'FU_STATUSES',
      'CALL_SYNC_SECONDS', 'CALL_MIN_SECS', 'OFFLINE_PACK']);
    if (!ALLOWED.has(key)) throw new Error('That setting is not editable here: ' + key);
    const { error } = await db.from('settings')
      .upsert({ key, value: String((args && args.value) || '') }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    return { ok: true, key };
  },

  async audit(db, user, args) {
    requireSettings(user);
    return { ok: true, ...(await auditList(db, { limit: 200 })) };
  },
};

export const _FNS = FNS;   // tests only -- the fns run against the fake db

export default withApi(async (req) => {
  if (req.method !== 'POST') { const e = new Error('Method not allowed'); e.status = 405; throw e; }
  const { code, fn, args } = req.body || {};
  const user = await gatedUser(code);
  const h = FNS[fn];
  if (!h) { const e = new Error('Unknown portal fn: ' + fn); e.status = 400; throw e; }
  return audited(supabase, user, fn, args, () => h(supabase, user, args));
});
