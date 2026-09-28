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

   THREE RULES THE FIRST CUT GOT WRONG, each one a phone sent the wrong way:

     THE LATEST SALE DECIDES. hoop_sales keeps one row per receipt, so a phone HOPE handed
     back and the shop re-sold in September still carries its August HOPE sale. "Any partner
     sale ever" shipped that phone to HOPE on the day it was enrolled for its new HOOP customer;
     partnerSalesIn now looks at the LAST sale per IMEI only.

     A PHONE THAT ARRIVED FROM THE PARTNER IS NOT SENT BACK ON THE STRENGTH OF THE SALE THAT
     TOOK IT THERE. HOPE's Hamisha reaches this register through api/shift-batch.js, which enrols
     as SHIFT:HOPE; the row is stamped enrolled_by/enrolled_at at that moment (deviceEnrol). A
     partner sale dated on or before that arrival is the one that already happened. The upload,
     which has no rows in hand, simply never queues an arrived-from-partner row at all (the
     `enrolled_by` filter in queueHandover); the panes, which do have the rows, compare dates.
     And deviceEnrol runs none of this for the partner's own synthetic user -- a nested
     cross-office call inside a cross-office call ordered the phone straight back, and the
     locked handset ended up RELEASED on both registers.

     RENEWAL IS FOR A PHONE THAT IS HERE. A batch expires after a day (claim() refuses it,
     silently), so an order is re-minted -- but only when the handset has BEATEN THIS OFFICE
     SINCE THE ORDER and within the last few hours, and its app can read an order at all. A
     phone that moved and whose dev_shifted was lost never beats here again, so it is never
     renewed (each renewal was rejoining -- and REVIVING -- HOPE's row); a boxed phone is
     renewed on the first open after it wakes up, not every twenty hours in the dark.

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
/* ...and only for a phone that has beaten here this recently: the beat is every minute, so a
   handset that is switched on and still ours speaks well inside this. One that does not is
   boxed, dead, or gone to the other office -- and a new batch for it is a call to HOPE and a
   row revived there for nothing. */
export const RENEW_ALIVE_MS = 3 * 60 * 60 * 1000;
/* A phone that has beaten this office this long AFTER its order and is still here did not
   act on it -- an app too old to read it, or a claim the other office refused. Said on the
   row (shiftStalled) so it is not mistaken for a phone that is merely slow. */
export const STALL_AFTER_MS = 10 * 60 * 1000;
const BATCH_RX = /^[0-9a-f]{32}$/i;
const SHIFT_COLS_RX = /shift_server|shift_batch|shift_at/;
/* The first lock app that reads a shift order off a beat. Older builds ignore the field, so an
   order on such a row sits for ever -- worth saying on the row rather than letting it look like
   a phone that is merely slow. versionCode 22 = 1.11.9 (docs/DEVICE-LOCKING.md). */
export const SHIFT_MIN_APP = '1.11.9';
/* WHERE THE SHARED SECRET MAY BE SENT. DEVICE_SHIFT_PARTNER is an editable setting, and the
   next pane open POSTs DEVICE_SHIFT_SECRET to whatever it names and orders every queued phone
   to beat there -- so a typo (or a bad day) must not be able to point the fleet at a stranger.
   The hosts this family of deployments actually runs on, or the list in DEVICE_SHIFT_PARTNER_HOSTS
   (comma-separated hostnames) when an office moves. An address off the list is refused BY NAME
   on the screen, and nothing is queued to it. */
export const DEFAULT_PARTNER_HOSTS = ['hope-pmo-v2-ten.vercel.app', 'hope-pmo-v2.vercel.app', 'hoop-pmo.vercel.app'];
export function partnerHosts() {
  const env = S(process.env.DEVICE_SHIFT_PARTNER_HOSTS).split(/[,\s]+/).map(h => h.toLowerCase()).filter(Boolean);
  return env.length ? env : DEFAULT_PARTNER_HOSTS;
}
export function partnerAllowed(server) {
  const s = normalizeServer(server);
  if (!s) return false;
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch (e) { return false; }
  return partnerHosts().includes(host);
}
export const PARTNER_NOT_ALLOWED = 'DEVICE_SHIFT_PARTNER si ofisi inayotambulika, kwa hiyo hakuna simu '
  + 'iliyopangwa kuhama. / DEVICE_SHIFT_PARTNER is not a known office (see DEVICE_SHIFT_PARTNER_HOSTS), '
  + 'so no handover was queued.';

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
  if (hit && hit.value && hit.at <= nowMs && (nowMs - hit.at) < CONFIG_TTL_MS) return hit.value;
  if (hit && hit.pending && hit.at <= nowMs && (nowMs - hit.at) < CONFIG_TTL_MS) return hit.pending;
  const pending = (async () => {
    let rows = null;
    try {
      rows = await fetchAll(() => db.from('settings').select('key, value').in('key', HANDOVER_SETTINGS));
    } catch (e) { rows = null; }
    const get = k => { const r = (rows || []).find(x => S(x.key) === k); return r ? S(r.value) : ''; };
    const wanted = normalizeServer(get('DEVICE_SHIFT_PARTNER')) || DEFAULT_PARTNER;
    const allowed = partnerAllowed(wanted);
    return {
      // An address off the allowlist is NO address: nothing is queued to it, and the note says why.
      server: allowed ? wanted : '',
      buyers: rows === null ? [] : parseBuyers(get('DEVICE_HANDOVER_BUYER')),
      asked: rows !== null,
      note: allowed ? undefined : PARTNER_NOT_ALLOWED,
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

/** The LAST sale per IMEI (sale_date, then the order the records came in -- a cumulative export
    lists a later receipt later). Records carry imei + client_name + sale_date: a sales upload's
    own parsed rows, or the hoop_sales feed. */
export function latestSaleBy(records) {
  const out = new Map();
  for (const r of records || []) {
    const imei = S(r && r.imei);
    if (!imei) continue;
    const had = out.get(imei);
    if (!had || S(r.sale_date) >= S(had.sale_date)) out.set(imei, r);
  }
  return out;
}

/** True when a partner sale is the one that already carried this phone to the partner: the row
    arrived here FROM a partner (enrolled_by SHIFT:…) on or after the sale's date. */
export function saleBeforeArrival(sale, row) {
  if (!row || !/^SHIFT:/i.test(S(row.enrolled_by))) return false;
  const arrived = row.enrolled_at ? Date.parse(row.enrolled_at) : NaN;
  if (!Number.isFinite(arrived)) return true;   // arrived from the partner, when unknown: never resend
  const day = S(sale && sale.sale_date).slice(0, 10);
  if (!day) return true;
  // The sale's day, taken to its end: a sale dated the day the phone came back is the old one.
  const sold = Date.parse(day + 'T23:59:59.999Z');
  return !Number.isFinite(sold) || sold <= arrived;
}

/** imei -> buyer, for every IMEI whose LATEST sale went to a partner. `rows` (optional, keyed by
    imei) lets a caller holding the register skip phones that came back from that partner after
    the sale in question -- see saleBeforeArrival. */
export function partnerSalesIn(records, buyers, rows) {
  const out = new Map();
  if (!buyers || !buyers.length) return out;
  for (const [imei, last] of latestSaleBy(records)) {
    const buyer = soldToPartner(last.client_name, buyers);
    if (!buyer) continue;
    const row = rows instanceof Map ? rows.get(imei) : null;
    if (row && saleBeforeArrival(last, row)) continue;
    out.set(imei, buyer);
  }
  return out;
}

/* THE FIRST HALF: mark the rows. One update per 500 IMEIs that RETURNS the rows it touched, so
   the event trail names exactly those and nothing is read beforehand. Rows already ordered,
   already released, or not on the register at all simply do not match the filter -- and neither
   does a row that ARRIVED from a partner office, unless the caller says it has compared the
   sale's date with the arrival itself (`opts.arrivalsChecked`; the panes do, the upload cannot). */
export async function queueHandover(db, sold, actor, cfg, nowMs = Date.now(), opts = {}) {
  const map = sold instanceof Map ? sold
    : new Map([...(sold || [])].map(i => [S(i), (cfg && cfg.buyers && cfg.buyers[0]) || DEFAULT_BUYER]));
  const imeis = [...map.keys()].filter(Boolean);
  const server = cfg && cfg.server;
  if (!imeis.length || !server) return { queued: 0, imeis: [], server: server || '', note: cfg && cfg.note };
  const at = new Date(nowMs).toISOString();
  const rows = [];
  for (let i = 0; i < imeis.length; i += 500) {
    let qy = db.from('devices')
      .update({ shift_server: server, shift_at: at, updated_at: at })
      .in('imei', imeis.slice(i, i + 500)).is('shift_server', null).neq('state', 'released');
    if (!opts.arrivalsChecked) qy = qy.or('enrolled_by.is.null,enrolled_by.not.ilike.SHIFT:*');
    const { data, error } = await qy.select('imei, state');
    if (error) {
      if (columnMissing(error)) return { queued: rows.length, imeis: rows.map(r => String(r.imei)), server, note: MIGRATION_NOTE };
      throw new Error(error.message);
    }
    rows.push(...(data || []));
  }
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
  /* The secret leaves this server here and nowhere else, so this is where the allowlist holds:
     an address that is not a known office gets no secret, and the drawer is told to paste a
     batch instead (the code-once path needs no trust between the two backends). */
  if (!partnerAllowed(server)) {
    const e = new Error('need-batch: ' + S(server) + ' si ofisi inayotambulika (DEVICE_SHIFT_PARTNER_HOSTS), '
      + 'kwa hiyo Hamisha inahitaji batch kutoka \'Sajili simu\' yao. / need-batch: ' + S(server)
      + ' is not a known office (DEVICE_SHIFT_PARTNER_HOSTS), so Shift needs a batch pasted from their '
      + 'own \'Sajili simu\' / Enrol drawer.');
    e.status = 400; e.code = 'need-batch'; throw e;
  }
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
  if (!Number.isFinite(at) || (nowMs - at) <= RENEW_AFTER_MS) return false;
  /* RENEWED ONLY FOR A PHONE THAT IS STILL HERE TO COLLECT IT: it has beaten this office since
     the order was written, it did so within the last few hours, and its app can read an order.
     Anything else is a call to the other office that cannot help -- and a row revived there. */
  const seen = r.last_seen ? Date.parse(r.last_seen) : NaN;
  if (!Number.isFinite(seen) || seen <= at || (nowMs - seen) > RENEW_ALIVE_MS) return false;
  return !shiftAppTooOld(r.app_version);
}

/** Ordered, still here, and it has beaten this office well after the order: the phone did not
    move. That is a fault to look at (app too old; a claim the other office refused), never a
    phone that is merely slow. */
export function shiftStalled(r, nowMs = Date.now()) {
  if (!S(r && r.shift_server) || !S(r.shift_batch) || S(r.state) === 'released') return false;
  const at = r.shift_at ? Date.parse(r.shift_at) : NaN;
  const seen = r.last_seen ? Date.parse(r.last_seen) : NaN;
  return Number.isFinite(at) && Number.isFinite(seen) && (seen - at) > STALL_AFTER_MS;
}

/* `opts.openedBy` marks a piggyback: the order is written by the system on the strength of
   the sales book, and the person who happened to open the pane is named in the reason, not
   as the actor -- the Unlocking desk did not order a shift by searching for a phone. */
export async function completeHandovers(db, actor, opts = {}, nowMs = Date.now()) {
  let rows = opts.rows;
  if (!rows) {
    try {
      rows = await fetchAll(() => db.from('devices')
        .select('imei, state, item, shift_server, shift_batch, shift_at, last_seen, app_version')
        .not('shift_server', 'is', null));
    } catch (e) {
      if (columnMissing(e)) return { pending: 0, ordered: 0, renewed: 0, note: MIGRATION_NOTE };
      throw e;
    }
  }
  const due = (rows || []).filter(r => needsTicket(r, nowMs));
  if (!due.length) return { pending: 0, ordered: 0, renewed: 0 };
  const last = lastTry.get(db) || 0;
  if (!opts.force && last <= nowMs && (nowMs - last) < RETRY_EVERY_MS) {
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
  const who = opts.openedBy ? ' — imefunguliwa na ' + S(opts.openedBy) + ' / opened by ' + S(opts.openedBy) : '';
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
    /* THE FIRST WRITER WINS. Two running instances can both be asked for the same due rows
       inside the same minute (the throttle is per instance), and each comes back holding a
       batch the other office minted. Writing unconditionally let the LATER response overwrite
       the earlier one, so this register could hold batch A while the other held B -- and the
       phone's claim was refused, silently, until the next renewal. So a queued row is written
       only while it still has no batch, and a renewal only over the batch it was read with;
       what did not match was already ordered by somebody else and is not counted twice. */
    const groups = new Map();   // old batch ('' = queued) -> imeis
    for (const r of list) {
      const k = S(r.shift_batch);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(S(r.imei));
    }
    const written = [];
    let failed = false;
    for (const [old, group] of groups) {
      let qy = db.from('devices')
        .update({ shift_batch: batch, shift_at: at, updated_at: at })
        .in('imei', group.filter(i => imeis.includes(i))).not('shift_server', 'is', null);
      qy = old ? qy.eq('shift_batch', old) : qy.is('shift_batch', null);
      const { data, error } = await qy.select('imei');
      if (error) { notes.push(error.message); failed = true; break; }
      for (const r of data || []) written.push({ imei: S(r.imei), fresh: !old });
    }
    if (failed || !written.length) continue;
    const { error: eErr } = await db.from('device_events').insert(written.map(w => ({
      imei: w.imei, event: 'shift-ordered',
      reason: (w.fresh
        ? 'kuhamishwa kwenda ' + server + ' (mauzo) / shift ordered to ' + server + ' (sold to the partner)'
        : 'batch mpya — simu haijafika bado / order renewed: the phone had not collected the last batch before it expired')
        + who,
      actor: opts.openedBy ? 'auto' : (actor || 'auto'), at })));
    if (eErr) { notes.push(eErr.message); continue; }
    for (const w of written) { if (w.fresh) ordered++; else renewed++; done.push(w.imei); }
  }
  return { pending: due.length - ordered - renewed, ordered, renewed, imeis: done,
    note: notes.join(' · ') || undefined };
}
