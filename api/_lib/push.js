/* =============================================================================================
   THE TAP ON THE SHOULDER.
   =============================================================================================
     "funga and fungua and release should not take even a minute they should all be
      immediate effect whenever online and phone pings"

   A phone that polls cannot be quicker than its poll. The adaptive beat got everything AFTER
   the first contact down to seconds, but the first contact still waits for the handset to
   wake up on its own -- up to a quarter of an hour with the office staring at the screen.

   Firebase Cloud Messaging is the only way past that on Android: Google already holds an open
   connection to every phone for its own notifications, and lets us send a message down it.
   Costs nothing, uses no meaningful battery or data, and arrives in about a second.

   WHAT WE SEND IS NOT A COMMAND. This is the part worth being deliberate about.

   The message says "wake up and beat", and nothing else. The handset then asks /api/device
   the same question it always asks, with its own token, and gets the same answer it always
   gets. So a forged or replayed push can do exactly one thing: cause an extra heartbeat.
   It cannot lock a phone, unlock one, or release one -- because it does not carry that
   decision, and the beat that does is authenticated by a token the push never sees.

   That is the same rule the whole system already runs on: the command is DERIVED from the
   register on every beat, never queued and never carried. Push is a doorbell, not a key.

   IT IS ALSO ENTIRELY OPTIONAL. With no Firebase credentials configured, every function here
   returns quietly and the fleet behaves exactly as it does today -- the fifteen-minute beat,
   the twenty-five second follow-up while an order is outstanding. Nothing calls this in a way
   that can fail an operator's action; see nudge().
   ============================================================================================= */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** The three values from the Firebase service-account JSON. Absent = push is simply off. */
function creds() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  /* Vercel's dashboard stores newlines as the two characters \n, so a key pasted there
     arrives unusable unless they are turned back. Accepting both shapes costs one replace
     and saves an afternoon of "invalid_grant" with nothing to read. */
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

export function pushConfigured() {
  return creds() !== null;
}

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* Google hands out an access token per service account, good for an hour. Minting one costs
   a round trip and a signature, so it is held for the life of the serverless instance and
   retired a minute early -- a token that expires mid-flight fails the send it was fetched
   for, which is exactly the request somebody is waiting on. */
let cached = { token: '', expires: 0 };

async function accessToken(c, nowMs) {
  if (cached.token && cached.expires > nowMs + 60_000) return cached.token;
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: c.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const jwt = header + '.' + claims + '.' + b64url(signer.sign(c.privateKey));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error('FCM auth failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  if (!j.access_token) throw new Error('FCM auth returned no token');
  cached = { token: j.access_token, expires: nowMs + (Number(j.expires_in || 3600) * 1000) };
  return cached.token;
}

/**
 * Wake these handsets. Returns { sent, failed, stale } -- `stale` are registration tokens
 * Firebase says are dead (app uninstalled, or the token rotated), which the caller may clear.
 *
 * DATA-ONLY, and high priority. A `notification` payload would draw something on the
 * customer's screen, which is wrong twice over: there is nothing for them to read, and on a
 * LOCKED phone the notification shade is not reachable anyway. Data-only messages are handed
 * straight to the app instead. `priority: high` is what gets a dozing handset woken rather
 * than batched until Android feels like it -- which for this message is the entire point.
 */
export async function wake(fcmTokens, nowMs = Date.now(), fetchImpl = fetch) {
  const c = creds();
  const list = [...new Set((fcmTokens || []).map(t => String(t || '').trim()).filter(Boolean))];
  if (!c || !list.length) return { sent: 0, failed: 0, stale: [] };

  const bearer = await accessToken(c, nowMs);
  const url = 'https://fcm.googleapis.com/v1/projects/' + c.projectId + '/messages:send';
  let sent = 0, failed = 0;
  const stale = [];

  /* One request per handset -- FCM v1 has no true batch endpoint, and a topic would send to
     every phone we own, which is precisely what must never happen for a lock order. Run them
     together rather than in sequence: two hundred phones one after another would outlast a
     serverless function's patience. */
  await Promise.all(list.map(async token => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            // The whole payload. A doorbell, not a key -- see the header.
            data: { beat: '1' },
            android: { priority: 'HIGH', ttl: '600s' },
          },
        }),
      });
      if (res.ok) { sent++; return; }
      failed++;
      /* 404 UNREGISTERED / 400 INVALID_ARGUMENT on the token itself mean this registration
         is dead -- the app was reinstalled, or Firebase rotated it. Worth telling the caller
         so the row can be cleared rather than retried for ever. */
      if (res.status === 404) stale.push(token);
      else if (res.status === 400 && /INVALID_ARGUMENT|registration/i.test(await res.text())) stale.push(token);
    } catch (e) {
      failed++;
    }
  }));
  return { sent, failed, stale };
}

/**
 * Wake them, and never let it matter if that fails.
 *
 * THIS IS CALLED FROM THE MIDDLE OF AN OPERATOR'S ACTION -- pressing Funga -- and a lock is
 * not less ordered because Google was slow to accept a doorbell. The register is the record;
 * push only decides whether the phone finds out in a second or at its next beat. So every
 * failure here is swallowed on purpose, which is the opposite of the rule everywhere else in
 * this system, and the reason is that the fallback is the thing that already worked.
 */
export async function nudge(db, imeis, nowMs = Date.now()) {
  try {
    if (!pushConfigured() || !imeis || !imeis.length) return { sent: 0, failed: 0, stale: [] };
    const { data, error } = await db.from('devices').select('imei, fcm_token').in('imei', imeis);
    if (error) return { sent: 0, failed: 0, stale: [] };
    const tokens = (data || []).map(r => r.fcm_token).filter(Boolean);
    const r = await wake(tokens, nowMs);
    // A dead registration is worth forgetting, or every future order retries it.
    if (r.stale.length) {
      const dead = (data || []).filter(x => r.stale.includes(x.fcm_token)).map(x => x.imei);
      if (dead.length) await db.from('devices').update({ fcm_token: null }).in('imei', dead);
    }
    return r;
  } catch (e) {
    return { sent: 0, failed: 0, stale: [] };
  }
}
