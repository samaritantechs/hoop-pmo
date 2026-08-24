import { supabase } from './_lib/supabase.js';
import { withApi } from './_lib/auth.js';
import { deviceApi } from './_lib/device-core.js';

// POST /api/device   { fn: 'dev_hello' | 'dev_beat', args: [ { imei, token, ... } ] }
//
// The handsets' only door. Deliberately NOT behind gatedUser(): a phone carries a
// per-device token, never a staff access code -- see the note at the top of
// _lib/device-core.js for what that token can and cannot do.
//
// It is also NOT behind the system open/closed switch. Closing the system stops the office
// working; it must never strand a locked phone with no way to be told it is free, which is
// the one failure here that reaches a customer standing in a shop.
export default withApi(async (req) => {
  if (req.method !== 'POST') { const e = new Error('Method not allowed'); e.status = 405; throw e; }
  const { fn, args } = req.body || {};
  return deviceApi(supabase, fn, args);
});
