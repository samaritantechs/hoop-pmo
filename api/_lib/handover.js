/* =============================================================================================
   THE HANDOVER TO HOPE, ON SALE.
   =============================================================================================
     "transfereed stock from Hoop to Hope should switch lock logo to Hope and appear in Hope
      Unlocking too"
     "am not seeing that device at unlocking in both hoop and hope"

   A handset HOOP sells to HOPE MICROCREDIT is HOPE's from that day: HOPE finances it onward,
   HOPE's desk unlocks it when the customer pays, and the lock screen should carry HOPE's mark and
   HOPE's phone number -- not a HOOP wordmark above the words HOPE MICROCREDIT. Until now that
   move was a person remembering to tick the phone under Kufunga simu and press Hamisha. Nobody
   remembered, so the phone stayed HOOP's: locked from HOOP's bench, invisible to HOPE, and
   showing HOOP's number to a customer HOOP cannot help.

   THIS MODULE MAKES THE SALE ITSELF THE ORDER. It reuses the Shift that already exists -- the
   phone reads a server and a batch off its own row on its next beat, claims a token from the
   other office and moves itself without ever letting go of Device Owner (see deviceShift in
   portal.js and Shift.java in android/lock). What is new is WHO writes the order and WHEN.

   TWO HALVES, ON PURPOSE, because of where each one has to run:

     queueHandover      ONE keyed write, no reads of the register, no HTTP. Stamps
                        shift_server (and shift_at) on the sold phones' rows and leaves
                        shift_batch EMPTY. The beat hands a phone its order only when BOTH
                        columns are set (device-core.js), so a row in this state is a phone
                        that is going to HOPE and has not yet been given its ticket. This is
                        the only half the SALES UPLOAD may run: api/upload.js sits in the
                        request the store types into, may not import portal.js (stock-index.js
                        says why), and has no business waiting on another company's server.

     completeHandovers  Asks HOPE for the batch -- server to server, the same /api/shift-batch
                        call the Hamisha drawer already makes, under DEVICE_SHIFT_SECRET -- and
                        writes it onto the queued rows. It rides the reads that happen anyway
                        (the Devices panes, NEW STOCK, an enrolment) and is throttled to one
                        attempt a minute per running instance, so a HOPE that is down or a
                        secret that is not set costs one bounded call and a sentence on the
                        screen, never a pane that hangs. There is no scheduler in this project
                        (audit.js says so); this is the same piggyback every other timed job
                        here uses.

   WHAT DECIDES A PHONE IS HOPE'S: the sales book. hoop_sales.client_name is the buyer of record
   and it is what NEW STOCK already prints in the Mteja column; DEVICE_HANDOVER_BUYER names the
   buyer(s) that mean "hand it over" and defaults to HOPE MICROCREDIT. Matched as "contains", so
   HOPE MICROCREDIT LTD still counts. `none` switches the whole thing off. The address it goes
   to is DEVICE_SHIFT_PARTNER, which until now was a constant in public/portal.html and is now
   the one place both the drawer and this module read it from.

   WHAT IT NEVER DOES: shift a released phone (nothing is listening), re-order a phone that
   already carries an order, touch the beat, or fail an upload. Every half reports what it did
   and what it could not -- the migration that is not run, the secret that is not set, the
   office that did not answer -- because a handover that silently did not happen looks exactly
   like one that did, and that is the state this exists to end.

   Budget, stated where each caller runs: queueHandover is 1 settings read (memoised 60s per
   instance) + 1 update-returning-rows + 1 event insert, only on a slice that carries a partner
   sale. completeHandovers is 0 reads when handed the rows a pane already fetched, 1 bounded read
   otherwise, then per partner office 1 outbound HTTPS call + 1 update + 1 insert -- and only
   while something is queued.
   ============================================================================================= */
import { fetchAll } from './supabase.js';

const S = v => String(v == null ? '' : v).trim();
const K = s => S(s).toUpperCase().replace(/\s+/g, ' ');

export const HANDOVER_SETTINGS = ['DEVICE_SHIFT_PARTNER', 'DEVICE_HANDOVER_BUYER'];
export const DEFAULT_PARTNER = 'https://hope-pmo-v2-ten.vercel.app';
export const DEFAULT_BUYER = 'HOPE MICROCREDIT';
export const SHIFT_MIGRATION = 'db/migrations/RUN-ME-2026-09-15-device-shift.sql';
export const MIGRATION_NOTE = 'Kuhamisha kwenda ofisi nyingine hakuwezi kuandikwa bado — endesha '
  + SHIFT_MIGRATION + '. / A handover cannot be queued until ' + SHIFT_MIGRATION + ' has been run.';

const CONFIG_TTL_MS = 60 * 1000;
const RETRY_EVERY_MS = 60 * 1000;
const PARTNER_TIMEOUT_MS = 8000;
/* A BATCH IS A BEARER SECRET FOR A DAY: claim() on either office refuses one older than 24h
   (BATCH_MAX_AGE_MS in device-core.js), and refuses it SILENTLY -- an expired batch writes no
   event on either register. A phone sold to HOPE and boxed for a week would therefore carry an
   order it can never honour. So an order that has sat unclaimed this long is renewed on the next
   natural read: a fresh batch from the same office, same row, same phone. */
export const RENEW_AFTER_MS = 20 * 60 * 60 * 1000;
const BATCH_RX = /^[0-9a-f]{32}$/i;
const SHIFT_COLS_RX = /shift_server|shift_batch|shift_at/;
/* The first lock app that reads a shift order off a beat. Older builds ignore the field, so an
   order on such a row sits for ever -- worth saying on the row rather than letting it look like
   a phone that is merely slow. versionCode 22 = 1.11.9 (docs/DEVICE-LOCKING.md). */
export const SHIFT_MIN_APP = '1.11.9';

const configCache = new WeakMap();   // db -> { at, value } | { at, pending }
const lastTry = new WeakMap();       // db -> when this instance last asked a partner office

export function noteHandoverSettingsWritten(db) { configCache.delete(db); lastTry.delete(db); }
/** Tests only: forget every memo so "cold" means the same thing in any order. */
export function _resetHandover(db) { noteHandoverSettingsWritten(db); }

export const columnMissing = e => SHIFT_COLS_RX.test(String((e && e.message) || ''));

function bad(msg) { const e = new Error(msg); e.status = 400; throw e; }

/** One name per line or comma. Blank means the default buyer; `none` means nobody. */
export function parseBuyers(raw) {
  const text = S(raw);
  if (!text) return [DEFAULT_BUYER];
  if (/^(none|hakuna|-)$/i.test(text)) return [];
  return [...new Set(text.split(/[\n,;]+/).map(K).filter(Boolean))];
}

/** True when a handset's reported app_version predates shift support. Unknown (never reported,
    or not a dotted number) is NOT "too old": a phone that has never spoken has told us nothing. */
export function shiftAppTooOld(appVersion) {
  const parts = v => String(v || '').trim().split('.').map(n => parseInt(n, 10));
  const have = parts(appVersion);
  if (have.length < 2 || have.some(n => !Number.isFinite(n))) return false;
  const need = parts(SHIFT_MIN_APP);
  for (let i = 0; i < need.length; i++) {
    const a = have[i] == null ? 0 : have[i];
    if (a < need[i]) return true;
    if (a > need[i]) return false;
  }
  return false;
}

/** https only and no trailing slash -- the same rule deviceShift holds the drawer to. */
export function normalizeServer(raw) {
  const s = S(raw).replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+/i.test(s) ? s : '';
}

/* THE TWO SETTINGS, READ ONCE A MINUTE PER INSTANCE. Fail-soft on the address (the default is
   the only other office there is) and FAIL-CLOSED on the buyer: a settings table that could not
   be asked hands back no buyer at all, so a wobble never queues a handover the office may have
   switched off with `none`. The in-flight promise is shared, and its answer is written back only
   if nothing busted the memo while it was out -- the same stale-write guard readBeatSettings and
   isSystemOpen learned the hard way. */
export async function handoverConfig(db, nowMs = Date.now()) {
  const hit = configCache.get(db);
  if (hit && hit.value && (nowMs - hit.at) < CONFIG_TTL_MS) return hit.value;
  if (hit && hit.pending && (nowMs - hit.at) < CONFIG_TTL_MS) return hit.pending;
  const pending = (async () => {
    let rows = null;
    try {
      rows = await fetchAll(() => db.from('settings').select('key, value').in('key', HANDOVER_SETTINGS));
    } catch (e) { rows = null; }
    const get = k => { const r = (rows || []).find(x => S(x.key) === k); return r ? S(r.value) : ''; };
    return {
      server: normalizeServer(get('DEVICE_SHIFT_PARTNER')) || DEFAULT_PARTNER,
      buyers: rows === null ? [] : parseBuyers(get('DEVICE_HANDOVER_BUYER')),
      asked: rows !== null,
    };
  })().then(value => {
    const cur = configCache.get(db);
    if (cur && cur.pending === pending) configCache.set(db, { at: nowMs, value });
    return value;
  });
  configCache.set(db, { at: nowMs, pending });
  return pending;
}

/** The configured buyer this sale went to, or null. "Contains", so a suffix like LTD never
    stops a handover -- the sales export spells the same customer three ways in one month. */
export function soldToPartner(clientName, buyers) {
  const name = K(clientName);
  if (!name) return null;
  return (buyers || []).find(b => b && name.includes(b)) || null;
}

/** imei -> buyer, for every record whose buyer is a partner. Records carry imei + client_name
    (a sales upload's own parsed rows, or the hoop_sales feed). */
export function partnerSalesIn(records, buyers) {
  const out = new Map();
  if (!buyers || !buyers.length) return out;
  for (const r of records || []) {
    const buyer = soldToPartner(r && r.client_name, buyers);
    const imei = S(r && r.imei);
    if (buyer && imei && !out.has(imei)) out.set(imei, buyer);
  }
  return out;
}

/* THE FIRST HALF: mark the rows. One update that RETURNS the rows it touched, so the event
   trail names exactly those and nothing is read beforehand. Rows already ordered, already
   released, or not on the register at all simply do not match the filter. */
export async function queueHandover(db, sold, actor, cfg, nowMs = Date.now()) {
  const map = sold instanceof Map ? sold
    : new Map([...(sold || [])].map(i => [S(i), (cfg && cfg.buyers && cfg.buyers[0]) || DEFAULT_BUYER]));
  const imeis = [...map.keys()].filter(Boolean).slice(0, 500);
  const server = cfg && cfg.server;
  if (!imeis.length || !server) return { queued: 0, imeis: [], server: server || '' };
  const at = new Date(nowMs).toISOString();
  const { data, error } = await db.from('devices')
    .update({ shift_server: server, shift_at: at, updated_at: at })
    .in('imei', imeis).is('shift_server', null).neq('state', 'released')
    .select('imei, state');
  if (error) {
    if (columnMissing(error)) return { queued: 0, imeis: [], server, note: MIGRATION_NOTE };
    throw new Error(error.message);
  }
  const rows = data || [];
  if (rows.length) {
    const { error: eErr } = await db.from('device_events').insert(rows.map(r => ({
      imei: String(r.imei), event: 'handover-queued', from_state: r.state, to_state: r.state,
      reason: 'imeuzwa kwa ' + map.get(String(r.imei)) + ' — inasubiri kuhamishwa kwenda ' + server
        + ' / sold to ' + map.get(String(r.imei)) + ', handover to ' + server + ' queued',
      actor: actor || 'auto', at })));
    if (eErr) throw new Error(eErr.message);
  }
  return { queued: rows.length, imeis: rows.map(r => String(r.imei)), server };
}

/* THE OTHER OFFICE, ASKED SERVER-TO-SERVER. One POST to their /api/shift-batch with the shared
   secret; what comes back is exactly what a person would have copied out of their Sajili simu.
   Every failure names itself: not configured here (the drawer's cue to fall back to the
   code-once path), refused there (secrets differ), or unreachable. Never silent.

   BOUNDED. A partner office that is down must cost a pane one short wait, not the whole request:
   the call is abandoned after PARTNER_TIMEOUT_MS and reported as unreachable. `details` rides
   along so the receiving register can stamp the model on the rows it mints -- HOPE's desk then
   sees "A07-64GB", not a blank. */
export async function shiftBatchFromPartner(server, imeis, opts = {}) {
  const secret = String(process.env.DEVICE_SHIFT_SECRET || '').trim();
  if (!secret) {
    const e = new Error('need-batch: DEVICE_SHIFT_SECRET haijawekwa kwenye seva hii, kwa hiyo Hamisha '
      + 'inahitaji msimbo wako wa ofisi nyingine au batch. / need-batch: DEVICE_SHIFT_SECRET is not '
      + 'set on this deployment, so Shift needs your code for the other office, or a pasted batch.');
    e.status = 400; e.code = 'need-batch'; throw e;
  }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  // Cleared in the finally below, so it never outlives the call it bounds -- and never
  // unref()'d, so the deadline is real even when nothing else is keeping the loop alive.
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs || PARTNER_TIMEOUT_MS) : null;
  let res, body;
  try {
    res = await fetch(server + '/api/shift-batch', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, imeis, from: 'HOOP', details: opts.details || undefined }),
      signal: ctl ? ctl.signal : undefined });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    bad('Ofisi nyingine haipatikani: ' + server + ' / The other office could not be reached: '
      + String((e && e.message) || e));
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok || body.ok === false || !body.batch) {
    bad('Ofisi nyingine imekataa kutoa batch / The other office refused to hand back a batch: '
      + String(body.error || ('HTTP ' + res.status)));
  }
  const batch = String(body.batch).trim();
  if (!BATCH_RX.test(batch)) {
    bad('Batch si sahihi — nakili moja kwa moja kutoka \'Sajili simu\' ya ofisi nyingine. '
      + '/ That batch does not look right — copy it straight from the other office\'s own '
      + '\'Sajili simu\' / Enrol drawer.');
  }
  return batch;
}

/* THE SECOND HALF: give the queued rows their ticket. Handed `rows` when the caller already
   read the register (0 further reads); reads the queued rows itself otherwise. Throttled per
   instance unless `force`, which is what the button is for. Never throws for a partner that
   would not answer -- that is a sentence for the screen, and the phones stay queued for the
   next open. */
/** An order that was written but has not been carried out: queued (no batch yet), or ordered so
    long ago that its batch has expired or is about to (see RENEW_AFTER_MS). A released row is
    neither -- the phone is not beating here to collect anything. */
export function needsTicket(r, nowMs = Date.now()) {
  if (!S(r && r.shift_server) || S(r.state) === 'released') return false;
  if (!S(r.shift_batch)) return true;
  const at = r.shift_at ? Date.parse(r.shift_at) : NaN;
  return Number.isFinite(at) && (nowMs - at) > RENEW_AFTER_MS;
}

export async function completeHandovers(db, actor, opts = {}, nowMs = Date.now()) {
  let rows = opts.rows;
  if (!rows) {
    try {
      rows = await fetchAll(() => db.from('devices')
        .select('imei, state, item, shift_server, shift_batch, shift_at')
        .not('shift_server', 'is', null));
    } catch (e) {
      if (columnMissing(e)) return { pending: 0, ordered: 0, renewed: 0, note: MIGRATION_NOTE };
      throw e;
    }
  }
  const due = (rows || []).filter(r => needsTicket(r, nowMs));
  if (!due.length) return { pending: 0, ordered: 0, renewed: 0 };
  const last = lastTry.get(db) || 0;
  if (!opts.force && (nowMs - last) < RETRY_EVERY_MS) {
    return { pending: due.length, ordered: 0, renewed: 0, throttled: true };
  }
  lastTry.set(db, nowMs);

  const byServer = new Map();
  for (const r of due) {
    const s = S(r.shift_server);
    if (!byServer.has(s)) byServer.set(s, []);
    byServer.get(s).push(r);
  }
  let ordered = 0, renewed = 0;
  const notes = [];
  const done = [];      // every IMEI that now carries a live batch, for callers holding stale rows
  const at = new Date(nowMs).toISOString();
  for (const [server, list] of byServer) {
    const imeis = list.map(r => S(r.imei)).filter(Boolean).slice(0, 500);
    let batch;
    try {
      batch = await shiftBatchFromPartner(server, imeis,
        { details: list.map(r => ({ imei: S(r.imei), item: S(r.item) || null })) });
    } catch (e) {
      notes.push(String((e && e.message) || e));
      continue;
    }
    const { error } = await db.from('devices')
      .update({ shift_batch: batch, shift_at: at, updated_at: at })
      .in('imei', imeis).not('shift_server', 'is', null);
    if (error) { notes.push(error.message); continue; }
    const fresh = new Set(list.filter(r => !S(r.shift_batch)).map(r => S(r.imei)));
    const { error: eErr } = await db.from('device_events').insert(imeis.map(imei => ({
      imei, event: 'shift-ordered',
      reason: fresh.has(imei)
        ? 'kuhamishwa kwenda ' + server + ' (mauzo) / shift ordered to ' + server + ' (sold to the partner)'
        : 'batch mpya — simu haijafika bado / order renewed: the phone had not collected the last batch before it expired',
      actor: actor || 'auto', at })));
    if (eErr) { notes.push(eErr.message); continue; }
    for (const imei of imeis) { if (fresh.has(imei)) ordered++; else renewed++; done.push(imei); }
  }
  return { pending: due.length - ordered - renewed, ordered, renewed, imeis: done,
    note: notes.join(' · ') || undefined };
}
