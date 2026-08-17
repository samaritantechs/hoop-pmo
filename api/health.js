// GET /api/health -- the whole truth in one unauthenticated read.
// Deliberately keeps its OWN env analysis dependency-free (it must answer even when the
// supabase module cannot load), then attempts one tiny real read so "configured" and
// "actually connected" stop being guesses. Never prints a key; the URL host is not a
// secret (the service key is, and stays server-side).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const rawUrl = String(process.env.SUPABASE_URL || '');
  const looksLikeKey = /^eyJ/.test(rawUrl.trim());
  let urlValid = false, host = null;
  let db = null;
  try {
    const { supabase, SUPABASE_URL_NORM } = await import('./_lib/supabase.js');
    if (SUPABASE_URL_NORM) { urlValid = true; host = new URL(SUPABASE_URL_NORM).host; }
    const t0 = Date.now();
    const { error } = await supabase.from('settings').select('key').limit(1);
    db = { reachable: !error, ms: Date.now() - t0,
      error: error ? String(error.message || error).slice(0, 200) : null };
  } catch (e) {
    db = { reachable: false, error: 'module: ' + String(e && e.message).slice(0, 200) };
  }
  /* THE CARD'S SUPPLY LINES, counted -- never named. When the phone shows a dash where
     an agent or guarantor belongs, this section says which link is dry: the register
     read (columns there? rows there?), the agents register, the credit roster behind
     the "who is chasing" chip. Counts only -- an unauthenticated page carries no PII.
     Budget: 4 bounded reads, and only when the base check above already reached the db. */
  let card = null;
  if (db && db.reachable) {
    try {
      const { supabase, fetchAll } = await import('./_lib/supabase.js');
      const probeSel = await supabase.from('watu_loans')
        .select('imei, agent, agent_id, branch, guarantor_name, guarantor_phone').limit(1);
      const reg = await fetchAll(() => supabase.from('watu_loans')
        .select(probeSel.error ? 'imei, agent' : 'imei, agent, branch, guarantor_name'));
      const ags = await fetchAll(() => supabase.from('hoop_agents').select('name, phone'));
      const cus = await fetchAll(() => supabase.from('call_users').select('user_id, role, active'));
      const CR = new Set(['CREDIT', 'OFFICER', 'CREDIT OFFICER', 'CREDIT TEAM']);
      const K = s => String(s == null ? '' : s).trim().toUpperCase();
      const dv = await supabase.from('settings').select('value').eq('key', 'DATA_VERSION').maybeSingle();
      // Stock rides along: row count + how many report dates -- so "did Sipho's upload
      // land" is answerable from here without guessing from a screen.
      const stCount = await supabase.from('hoop_aged_stock').select('serial', { count: 'exact', head: true });
      const stDates = await fetchAll(() => supabase.from('hoop_aged_stock').select('as_of'));
      card = {
        agedStockRows: stCount.error ? null : (stCount.count || 0),
        agedStockDates: [...new Set(stDates.map(r => String(r.as_of).slice(0, 10)))].sort().slice(-4),
        guarantorColumns: !probeSel.error,
        columnError: probeSel.error ? String(probeSel.error.message || '').slice(0, 160) : null,
        register: reg.length,
        withAgent: reg.filter(r => r.agent).length,
        withGuarantor: probeSel.error ? null : reg.filter(r => r.guarantor_name).length,
        withBranch: probeSel.error ? null : reg.filter(r => r.branch).length,
        agentsRegister: ags.length,
        agentsWithPhone: ags.filter(a => a.phone).length,
        creditRoster: cus.filter(u => u.active !== false && CR.has(K(u.role))).length,
        dataVersion: dv.data ? String(dv.data.value).slice(0, 8) : null,
      };
    } catch (e) { card = { error: String(e && e.message).slice(0, 200) }; }
  }
  /* HOPE'S POSTGRES RULE, ADAPTED: when a phone and the database disagree, do not guess
     from the screen -- run the phone's OWN pipeline server-side and count what it
     produces. This samples one active app account and calls the real api_callList, then
     reports field PRESENCE only (counts, a role, dates -- never a name or a number).
     If these counts are full and a handset still shows dashes, the fault is on the
     handset; if they are zero, the fault is in the data or the code, named right here. */
  let deep = null;
  if (db && db.reachable) {
    try {
      const { supabase, fetchAll } = await import('./_lib/supabase.js');
      const core = await import('./_lib/call-core.js');
      const users = await fetchAll(() => supabase.from('call_users').select('device_id, role, active'));
      const pick = users.find(u => u.active !== false && u.device_id);
      if (!pick) deep = { error: 'no active app account to sample' };
      else {
        const r = await core.callApi(supabase, 'api_callList', [pick.device_id], Date.now());
        deep = (r && r.ok) ? {
          sampledRole: pick.role || '(blank)',
          rows: r.rows.length, asOf: r.asOf, stale: !!r.stale, note: r.note || null,
          withHeldBy: r.rows.filter(x => x.heldBy).length,
          withAgentName: r.rows.filter(x => x.agentName).length,
          withAgentPhone: r.rows.filter(x => x.agentPhone).length,
          withGuarantor: r.rows.filter(x => x.gName).length,
          withBranch: r.rows.filter(x => x.team).length,
        } : { error: (r && r.error) || 'list did not answer' };
      }
    } catch (e) { deep = { error: String(e && e.message).slice(0, 200) }; }
  }
  res.status(200).json({
    ok: true,
    service: 'hoop-pmo',
    time: new Date().toISOString(),
    env: {
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    urlValid, host, keyPastedAsUrl: looksLikeKey, db, card, deep,
  });
}
