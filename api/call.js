import { supabase } from './_lib/supabase.js';
import { withApi } from './_lib/auth.js';
import { callApi } from './_lib/call-core.js';

// POST /api/call   { fn: 'api_callBoot' | 'api_callRegister' | ..., args: [...] }
// One route for the whole HOOPLOAN Calls app (public/call.html), same transport as Hope's.
// Auth model: possession of a registered device id (plus a portal access code at
// registration time for leaders). All logic lives in _lib/call-core.js so the entire
// pipeline runs under npm test against the fake PostgREST client.
export default withApi(async (req) => {
  if (req.method !== 'POST') { const e = new Error('Method not allowed'); e.status = 405; throw e; }
  const { fn, args } = req.body || {};
  return callApi(supabase, fn, args);
});
