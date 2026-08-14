// GET /api/health -- proves the serverless layer is alive before any real routes exist.
// Deliberately dependency-free: it must work on the very first deploy, with or without
// the Supabase environment variables in place. `env` only reports WHETHER the two vars
// are set (never their values), so a half-finished Vercel setup is visible at a glance.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    service: 'hoop-pmo',
    time: new Date().toISOString(),
    env: {
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
  });
}
