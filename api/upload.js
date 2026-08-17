import { randomUUID } from 'node:crypto';
import { supabase } from './_lib/supabase.js';
import { withApi, gatedUser, can } from './_lib/auth.js';
import { todayKey } from './_lib/time.js';
import { importWatu, importSales, isSalesFile, importAgents, isAgentsFile,
  importAgedStock, isAgedStockFile, importOfflineQueue, isOfflineQueueFile,
  lifetimeDay } from './_lib/importers.js';

/* =====================================================================================
   POST /api/upload -- the daily Watu list, AND the hoopltd.shop sales export. The header
   row decides which one arrived (isSalesFile); the page needs no second button.

   Body: { code, rows: [[headers],[...]], meta: { uploadDate? }, part: { id, index, total } }
   The page slices big files; every slice re-sends the header row and carries the same
   part.id (the batch uuid), so the server stays stateless across slices.

   THE POSTGRES BUDGET (the permanent rule -- stated per change, forever):
   Per slice, warm: 1 auth read + 1 gate read (cached 30s) + 4 writes -- teams upsert
   (ignoreDuplicates), watu_snapshots insert, watu_loans upsert, followup_status upsert --
   each chunked at 1000 rows/statement. Last slice adds 1 settings upsert (DATA_VERSION).
   Row bounds: every write is bounded by the file's own row count; nothing here reads the
   register back. No read is repeated across slices; nothing is fetched to be merged --
   the header-presence upsert IS the merge.

   REPLACE-BY-DAY, WITHOUT DELETING ANYTHING: snapshots append under a fresh batch uuid;
   the register upserts in place; followup_status rows get deck_date = this upload's date,
   and the phones' list is "rows carrying the NEWEST deck_date" -- so today's upload IS
   today's list, yesterday's rows simply stop being on it, and no officer's comment history
   is ever deleted by an upload.

   THE OFFICERS' WORK IS PRESERVED BY CONSTRUCTION: the followup payload carries deck
   columns only -- fu_status, promise_date, promise_amt, last_comment, comment_by,
   comment_at are never mentioned, and a PostgREST upsert updates exactly the columns in
   the payload (Hope rule 7).
   ===================================================================================== */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 1000;

async function writeChunks(db, table, records, onConflict) {
  let written = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    for (let attempt = 0; ; attempt++) {
      const q = onConflict
        ? db.from(table).upsert(slice, { onConflict })
        : db.from(table).insert(slice);
      const { error } = await q;
      if (!error) break;
      if (attempt >= 1) {
        throw new Error(table + ': ' + error.message + ' (after ' + written + ' rows were written)');
      }
      await new Promise(r => setTimeout(r, 400));
    }
    written += slice.length;
  }
  return written;
}

/** MERGE WITHOUT LOSS. Rows whose key sets differ cannot share one PostgREST request,
    and a PostgREST upsert updates exactly the keys in the payload -- so grouping rows
    by shape is what makes "a blank cell leaves what the register holds" literally true:
    the blank's key is absent from that row's group, so the column is never touched.
    A handful of shapes at most; writes stay bounded by rows/CHUNK + shapes. */
async function writeChunksGrouped(db, table, records, onConflict) {
  const groups = new Map();
  for (const r of records) {
    const sig = Object.keys(r).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(r);
  }
  let written = 0;
  for (const g of groups.values()) written += await writeChunks(db, table, g, onConflict);
  return written;
}

/** WHO UPLOADED WHAT lands in the same audit_log the portal writes to, so the Settings
    audit list shows every kind of data anybody sent. Fire-and-forget (audit.js rule 3):
    a log line can never break an upload. Last slice only -- one line per file. */
async function logUpload(user, action, subject) {
  try {
    await supabase.from('audit_log').insert({
      actor_code: user.code, actor_name: user.name, actor_role: user.role,
      action, subject, ok: true });
  } catch (e) { /* swallowed -- an upload must not depend on its log line */ }
}

/** Trials need an eraser. Deletes ONE day's data: that day's snapshots, the register
    rows last confirmed that day, and the deck rows it stamped (their comments cascade).
    Budget: 3 bounded deletes + 1 settings write; every delete is scoped to the date. */
async function deleteDay(user, day) {
  const gone = { snapshots: 0, register: 0, deck: 0 };
  const del = async (table, col) => {
    const { data, error } = await supabase.from(table).delete().eq(col, day).select(col === 'deck_date' ? 'imei' : 'imei');
    if (error) throw new Error(table + ': ' + error.message);
    return (data || []).length;
  };
  gone.snapshots = await del('watu_snapshots', 'snapshot_date');
  gone.register = await del('watu_loans', 'snapshot_date');
  gone.deck = await del('followup_status', 'deck_date');
  const { error } = await supabase.from('settings')
    .upsert({ key: 'DATA_VERSION', value: randomUUID() }, { onConflict: 'key' });
  if (error) throw new Error('settings: ' + error.message);
  await logUpload(user, 'upload:delete-day', day + ' · deck ' + gone.deck + ' · reg ' + gone.register + ' · hist ' + gone.snapshots);
  return { ok: true, deleted: gone, date: day };
}

export default withApi(async (req) => {
  if (req.method !== 'POST') { const e = new Error('Method not allowed'); e.status = 405; throw e; }
  const { code, rows, meta, part, action } = req.body || {};
  const user = await gatedUser(code);
  if (!(await can(user, 'upload'))) {
    const e = new Error('Upload permission is required for your access code.'); e.status = 403; throw e;
  }

  if (String(action || '') === 'delete') {
    const day = String((meta && meta.uploadDate) || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const e = new Error('A date (yyyy-mm-dd) is required to delete a day.'); e.status = 400; throw e;
    }
    return deleteDay(user, day);
  }

  const p = part && typeof part === 'object' ? part : {};
  const total = Math.max(1, parseInt(p.total, 10) || 1);
  const index = Math.max(0, parseInt(p.index, 10) || 0);
  const isLast = index >= total - 1;
  const batch = UUID_RE.test(String(p.id || '')) ? String(p.id) : randomUUID();

  const wantDate = String((meta && meta.uploadDate) || '').trim();
  const snapshotDate = /^\d{4}-\d{2}-\d{2}$/.test(wantDate) ? wantDate : todayKey();

  // ONE upload slot, FOUR file kinds: the header row says which arrived. Sales, agents
  // and aged stock touch NOTHING the phones read -- no deck release, no DATA_VERSION.
  // Budget per non-watu slice: 1 auth + 1 gate (cached) + 1 chunked upsert.
  const header = Array.isArray(rows) && rows.length ? rows[0] : null;

  // The page lets the uploader CHOOSE the report type; the choice travels as meta.kind
  // and is enforced here too -- a sales file can never land "as" a deck because the
  // wrong chip was picked, whatever client sent it.
  const wantKind = String((meta && meta.kind) || '').trim();
  const enforceKind = actual => {
    if (wantKind && wantKind !== actual) {
      const e = new Error('The chosen report type is "' + wantKind + '" but this file is "'
        + actual + '".');
      e.status = 400; throw e;
    }
  };

  // Sipho's Agents Register (browser-parsed from his saved HTML) -> hoop_agents.
  // Upsert on phone: rows he already sent update, new people insert -- "update data
  // that doesn't exist" is the on-conflict clause doing its job.
  if (header && isAgentsFile(header)) {
    enforceKind('agents');
    const ag = importAgents(rows);
    if (!ag.records.length && !ag.dropped.length) {
      const e = new Error('No agent rows could be read.'); e.status = 400; throw e;
    }
    await writeChunks(supabase, 'hoop_agents',
      ag.records.map(r => ({ ...r, updated_at: new Date().toISOString() })), 'phone');
    if (isLast) await logUpload(user, 'upload:agents', 'rows ' + ag.records.length);
    return { kind: 'agents', inserted: ag.records.length, batch,
      dropped: ag.dropped.length, droppedRows: ag.dropped.slice(0, 50),
      part: { index, total, last: isLast } };
  }

  // Sipho's Aged Stock -> hoop_aged_stock, stamped with the chosen date (as_of):
  // age is only true on the day the report was read.
  if (header && isAgedStockFile(header)) {
    enforceKind('agedstock');
    const st = importAgedStock(rows);
    if (!st.records.length && !st.dropped.length) {
      const e = new Error('No stock rows could be read.'); e.status = 400; throw e;
    }
    // One row per phone PER REPORT DATE -- movement is the diff between two dates.
    await writeChunks(supabase, 'hoop_aged_stock',
      st.records.map(r => ({ ...r, as_of: snapshotDate, updated_at: new Date().toISOString() })), 'serial,as_of');
    if (isLast) await logUpload(user, 'upload:agedstock', snapshotDate + ' · rows ' + st.records.length);
    return { kind: 'agedstock', inserted: st.records.length, date: snapshotDate, batch,
      dropped: st.dropped.length, droppedRows: st.dropped.slice(0, 50),
      part: { index, total, last: isLast } };
  }

  // The credit team's OFFLINE QUEUE sheet -> merged into the watu_loans register by
  // IMEI. This is the file that carries GUARANTORS (name | phone in one cell), plus
  // customer, phone, agent and sale date; its Watu working-state columns are ignored.
  // "Always append and update existing": new IMEIs insert, known IMEIs update ONLY the
  // keys each row actually carries (writeChunksGrouped) -- nothing already known is
  // ever nulled out. Moves DATA_VERSION: the phones' cards must pick the guarantors up.
  // Budget per slice: 1 auth + 1 gate (cached) + <=shapes chunked upserts, bounded by
  // the file's rows; last slice adds 1 settings write + the audit line.
  if (header && isOfflineQueueFile(header)) {
    enforceKind('offline');
    const oq = importOfflineQueue(rows);
    if (!oq.records.length && !oq.dropped.length) {
      const e = new Error('No offline-queue rows could be read.'); e.status = 400; throw e;
    }
    const nowOq = new Date().toISOString();
    try {
      await writeChunksGrouped(supabase, 'watu_loans',
        oq.records.map(r => ({ ...r, updated_at: nowOq })), 'imei');
    } catch (err) {
      if (/guarantor_/i.test(String(err.message))) {
        const e = new Error('The register has no guarantor columns yet — run '
          + 'db/migrations/RUN-ME-2026-08-17-offline-queue.sql in the Supabase SQL editor, then upload again.');
        e.status = 400; throw e;
      }
      throw err;
    }
    if (isLast) {
      const { error } = await supabase.from('settings')
        .upsert({ key: 'DATA_VERSION', value: batch }, { onConflict: 'key' });
      if (error) throw new Error('settings: ' + error.message);
      await logUpload(user, 'upload:offline-queue', 'rows ' + oq.records.length);
    }
    return { kind: 'offline', inserted: oq.records.length, batch,
      dropped: oq.dropped.length, droppedRows: oq.dropped.slice(0, 50),
      part: { index, total, last: isLast } };
  }

  if (header && isSalesFile(header)) {
    enforceKind('sales');
    const sales = importSales(rows);
    if (!sales.records.length && !sales.dropped.length) {
      const e = new Error('No sales rows could be read from the file.'); e.status = 400; throw e;
    }
    const now = new Date().toISOString();
    await writeChunks(supabase, 'hoop_sales',
      sales.records.map(r => ({ ...r, sale_date: r.sale_date || snapshotDate,
        upload_batch: batch, updated_at: now })),
      'sale_key');
    if (isLast) await logUpload(user, 'upload:sales', snapshotDate + ' · rows ' + sales.records.length);
    return {
      kind: 'sales',
      inserted: sales.records.length,
      date: snapshotDate,
      batch,
      dropped: sales.dropped.length,
      droppedRows: sales.dropped.slice(0, 50),
      part: { index, total, last: isLast },
    };
  }

  enforceKind('watu');
  const { records, teams, dropped } = importWatu(rows || []);
  if (!records.length && !dropped.length) {
    const e = new Error('No data rows could be read from the file.'); e.status = 400; throw e;
  }

  // REPLACE-BY-DAY, honestly: this upload IS this date's list. Rows the previous upload
  // of the same date stamped -- and this file no longer carries -- must leave the list,
  // not linger with the old deck_date. Releasing the stamp (never deleting the row)
  // keeps every officer comment; the row simply stops being on any day's deck until a
  // file carries that customer again. First slice only, or slice two would release
  // what slice one just stamped. One bounded write.
  if (index === 0) {
    const { error: relErr } = await supabase.from('followup_status')
      .update({ deck_date: null }).eq('deck_date', snapshotDate);
    if (relErr) throw new Error('followup_status: ' + relErr.message);
  }

  // 1. Teams first (the register references them). ignoreDuplicates: an existing team's
  //    RSM and code are somebody's work; a daily list must never touch them.
  if (teams.length) {
    const { error } = await supabase.from('teams')
      .upsert(teams.map(t => ({ team: t })), { onConflict: 'team', ignoreDuplicates: true });
    if (error) throw new Error('teams: ' + error.message);
  }

  const now = new Date().toISOString();

  // 2. History: append-only, one row per phone per upload, stamped with this batch.
  await writeChunks(supabase, 'watu_snapshots',
    records.map(r => ({ ...r, snapshot_date: snapshotDate, upload_batch: batch })));

  // 3. The register: latest state per IMEI. Only the file's own columns are in the payload.
  await writeChunks(supabase, 'watu_loans',
    records.map(r => ({ ...r, snapshot_date: snapshotDate, upload_batch: batch, updated_at: now })),
    'imei');

  // 4. The working list the phones read. Deck columns ONLY -- see the header note.
  await writeChunks(supabase, 'followup_status',
    records.map(r => {
      const out = { imei: r.imei, deck_date: snapshotDate, updated_at: now };
      if (r.team !== undefined) out.team = r.team;
      if (r.client_name !== undefined) out.client_name = r.client_name;
      if (r.client_mobile !== undefined) out.contact = r.client_mobile;
      if (r.model !== undefined) out.model = r.model;
      if (r.price !== undefined) out.price = r.price;
      if (r.disbursed_date !== undefined) {
        out.disbursed_date = r.disbursed_date;
        out.lifetime_day = lifetimeDay(r.disbursed_date, snapshotDate);
      }
      if (r.days_offline !== undefined) out.days_offline = r.days_offline;
      if (r.locked4 !== undefined) out.locked4 = r.locked4;
      if (r.locked7 !== undefined) out.locked7 = r.locked7;
      if (r.has_ever_paid !== undefined) out.has_ever_paid = r.has_ever_paid;
      return out;
    }),
    'imei');

  // 5. Last slice: move DATA_VERSION so every handset drops its hour-long cache at once
  //    (Hope's mechanism, one settings row by primary key).
  if (isLast) {
    const { error } = await supabase.from('settings')
      .upsert({ key: 'DATA_VERSION', value: batch }, { onConflict: 'key' });
    if (error) throw new Error('settings: ' + error.message);
    await logUpload(user, 'upload:watu-deck', snapshotDate + ' · rows ' + records.length);
  }

  return {
    kind: 'watu',
    inserted: records.length,
    date: snapshotDate,
    batch,
    teams,
    // Dropped rows are NAMED, never silent -- the upload that taught Hope this rule
    // spent a week being "mysteriously short".
    dropped: dropped.length,
    droppedRows: dropped.slice(0, 50),
    part: { index, total, last: isLast },
  };
});
