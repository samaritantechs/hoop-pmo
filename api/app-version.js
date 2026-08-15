import fs from 'node:fs';
import { withApi } from './_lib/auth.js';

// GET /api/app-version
// What the installed Android app polls on every launch to decide whether to update itself.
// The numbers come from app-version.json at the repo root -- the SAME file android/app/
// build.gradle reads at build time, so the app's own versionCode and the one advertised here
// can never drift apart (a mismatch would mean phones either update in a loop or never).
//
// Read through `new URL(..., import.meta.url)` rather than process.cwd(): that form is what
// Vercel's file tracer follows, so the JSON is actually bundled with the function. A cwd-based
// path traces to nothing, the read throws in production, and auto-update would silently never
// fire -- the one failure mode nobody would notice until phones had drifted weeks behind.
//
// No access code required: an out-of-date app must be able to ask before anyone signs in.
let cached = null;
export default withApi(async (req, res) => {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(new URL('../app-version.json', import.meta.url), 'utf8'));
  }
  return { ...cached };
});
