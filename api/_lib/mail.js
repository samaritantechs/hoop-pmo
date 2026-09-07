/* =========================================================================================
   EMAIL, AS A COURTESY ON TOP OF THE PANES -- never as the thing they depend on.
   =========================================================================================
     "so the gm and administrator email get set in settings"

   The imprest and leave panes are the system of record: a request exists the moment its row
   does, and an approver sees it the moment they open their pane. Email is the nudge that says
   "there is something in your pane" and the copy the CEO keeps in their inbox. So it MUST NOT
   be able to break the thing it is announcing: a request that failed because a mail provider
   was down, or because nobody had set an address yet, would be a request lost to a courtesy.

   Every function here therefore RESOLVES, always, with { sent, reason }. The caller records
   the answer (the panes show "email haikutumwa" beside a request nobody was told about) and
   carries on. Nothing here throws.

   Same provider and the same two knobs as HOPE's weekly report, deliberately, so one deploy
   variable serves both systems:
     RESEND_API_KEY   environment variable on the deployment -- a secret, so never a settings row
     EMAIL_FROM       Settings; blank falls back to Resend's own onboarding sender, which Resend
                      delivers ONLY to the address of the Resend account itself -- enough to see
                      the first test arrive, useless for the office. Set a sender on a domain
                      verified in Resend before anybody relies on it
   The recipient is a Settings KEY passed by the caller (IMPREST_ADMIN_EMAIL, IMPREST_CEO_EMAIL,
   HR_EMAIL) so the office can change who is told without a deploy. Several addresses may be
   separated by commas or semicolons. */

/* BOUNDED, because the row is already written by the time a send runs. A provider that accepts
   the connection and then hangs would hold the serverless function open past its limit, and
   the response that says "filed" would never reach the phone -- the person would see a dropped
   request and press again. Eight seconds is longer than any real send and shorter than the
   function's own budget. */
const SEND_TIMEOUT_MS = 8000;
let fetchImpl = (...a) => globalThis.fetch(...a);
/** Tests only: swap the transport so a send can be observed without a network. */
export function _setFetch(f) { fetchImpl = f || ((...a) => globalThis.fetch(...a)); }

const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function setting(db, key) {
  try {
    const { data } = await db.from('settings').select('value').eq('key', key).maybeSingle();
    return String((data && data.value) || '').trim();
  } catch (e) {
    return '';
  }
}

/**
 * Send one email. `toKey` names the Settings row holding the recipient(s); `to` may be given
 * directly instead (the requester's own address off a form). Resolves with
 *   { sent: true, to, id }            on success
 *   { sent: false, reason: '...' }    on every kind of failure, including "not configured"
 */
export async function sendMail(db, { toKey, to, subject, html }) {
  try {
    const key = String(process.env.RESEND_API_KEY || '').trim();
    if (!key) return { sent: false, reason: 'RESEND_API_KEY haijawekwa / not set on the deployment' };
    let addr = String(to || '').trim();
    if (!addr && toKey) addr = await setting(db, toKey);
    /* "Name <addr>" is how the Settings hint shows the sender, so somebody will type a
       recipient that way too; the address inside the brackets is what is meant. And "set to
       something that is not an address" is told apart from "blank", because the fix is different. */
    const parts = addr.split(/[;,]/).map(x => x.trim()).filter(Boolean)
      .map(x => { const m = /<([^>]+)>/.exec(x); return (m ? m[1] : x).trim(); });
    const list = parts.filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (!list.length) {
      return { sent: false, reason: (toKey ? toKey + ' ' : '') + (parts.length
        ? 'si anwani sahihi / is not a valid address: ' + parts.join(', ').slice(0, 120)
        : 'haijawekwa kwenye Settings / no recipient set') };
    }
    const from = (await setting(db, 'EMAIL_FROM')) || 'HOOPLOAN <onboarding@resend.dev>';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS) : null;
    let res, body;
    try {
      res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        // A subject is one line. A name typed with a line break in it must not become a header.
        body: JSON.stringify({ from, to: list,
          subject: String(subject || 'HOOPLOAN').replace(/[\r\n]+/g, ' ').slice(0, 200),
          html: String(html || '') }),
        signal: ctl ? ctl.signal : undefined,
      });
      // The body read is under the same clock: a provider that sends headers and then stalls
      // would otherwise hold the function open exactly as a hung connection would.
      body = await res.json().catch(() => ({}));
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) return { sent: false, reason: 'provider: ' + (body.message || res.status) };
    return { sent: true, to: list.join(', '), id: body.id || null };
  } catch (e) {
    return { sent: false, reason: String((e && e.message) || e) };
  }
}

/* ONE LOOK FOR EVERY NOTICE. A navy header, a table of the facts, and a line saying which pane
   to open -- because the email is not the record, the pane is, and the reader should be sent
   there rather than asked to reply to a message. */
export function noticeHtml(title, rows, footer) {
  const money = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  const cell = (k, v) => `<tr><td style="padding:5px 8px;color:#6b7280;white-space:nowrap">${esc(k)}</td>`
    + `<td style="padding:5px 8px;font-weight:600">${typeof v === 'number' ? money(v) + ' TZS' : esc(v)}</td></tr>`;
  return `<div style="font:14px system-ui;color:#111;max-width:640px">
    <h2 style="margin:0 0 10px;color:#0B2A6B">${esc(title)}</h2>
    <table style="border-collapse:collapse;font:13px system-ui">${rows.map(([k, v]) => cell(k, v)).join('')}</table>
    <p style="color:#6b7280;font-size:12px;margin-top:14px">${esc(footer || 'Fungua HOOPLOAN portal kuona zaidi. / Open the HOOPLOAN portal for the full record.')}</p>
  </div>`;
}
