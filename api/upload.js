import { randomUUID } from 'node:crypto';
import { supabase } from './_lib/supabase.js';
import { withApi, gatedUser, can } from './_lib/auth.js';
import { todayKey } from './_lib/time.js';
import { importWatu, lifetimeDay } from './_lib/importers.js';

/* =====================================================================================
   POST /api/upload -- the daily Watu list, and nothing else (v1 has one file type).

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

export default withApi(async (req) => {
  if (req.method !== 'POST') { const e = new Error('Method not allowed'); e.status = 405; throw e; }
  const { code, rows, meta, part } = req.body || {};
  const user = await gatedUser(code);
  if (!(await can(user, 'upload'))) {
    const e = new Error('Upload permission is required for your access code.'); e.status = 403; throw e;
  }

  const p = part && typeof part === 'object' ? part : {};
  const total = Math.max(1, parseInt(p.total, 10) || 1);
  const index = Math.max(0, parseInt(p.index, 10) || 0);
  const isLast = index >= total - 1;
  const batch = UUID_RE.test(String(p.id || '')) ? String(p.id) : randomUUID();

  const wantDate = String((meta && meta.uploadDate) || '').trim();
  const snapshotDate = /^\d{4}-\d{2}-\d{2}$/.test(wantDate) ? wantDate : todayKey();

  const { records, teams, dropped } = importWatu(rows || []);
  if (!records.length && !dropped.length) {
    const e = new Error('No data rows could be read from the file.'); e.status = 400; throw e;
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
  }

  return {
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
