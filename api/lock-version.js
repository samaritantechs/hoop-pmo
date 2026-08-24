import fs from 'node:fs';
import { withApi } from './_lib/auth.js';

// GET /api/lock-version
// What an installed HOOPLOAN Lock handset polls to decide whether to update itself -- the
// same arrangement as /api/app-version, and for the same reason: lock-version.json is the
// file android/lock/build.gradle stamps into the APK, so the version the phone is running
// and the version advertised here cannot drift apart.
//
// Read through `new URL(..., import.meta.url)` so Vercel's file tracer bundles the JSON with
// the function; a cwd-based path traces to nothing and the read throws in production, which
// would silently stop every locked phone from ever updating.
//
// No credential required. A phone must be able to ask what the current build is even when
// its own token has been revoked -- and there is nothing here worth protecting: it is a
// version number and a public APK URL.
let cached = null;
export default withApi(async (req, res) => {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(new URL('../lock-version.json', import.meta.url), 'utf8'));
  }
  return { ...cached };
});
