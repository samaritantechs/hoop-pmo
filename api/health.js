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
  res.status(200).json({
    ok: true,
    service: 'hoop-pmo',
    time: new Date().toISOString(),
    env: {
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    urlValid, host, keyPastedAsUrl: looksLikeKey, db,
  });
}
