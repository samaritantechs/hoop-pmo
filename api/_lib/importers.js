import { buildHeaderMap, normalizeHeader, num, textOrNull, normTeam, dateOrNull } from './parse.js';

/* =====================================================================================
   THE WATU IMPORTER -- the daily locked-customer list, the one upload this system lives on.

   Exact columns of the export (starter section 5):

     Shop | Agent | Agent ID | Client Name | Client Mobile | Model | Model Details |
     Disbursed Date | IMEI | Price | Has Ever Paid | Days Offline | Onboarding Time (Min) |
     App Signed Up | Locked 4+ Days | Locked 7+ Days

   Three rules learned the hard way in Hope, kept:
   - IMEI STAYS TEXT end to end. A 15-digit number is exactly representable in a JS double,
     so String() is lossless -- but the moment it touches Excel as a number it is destroyed,
     so nothing downstream may ever treat it as one.
   - HEADER PRESENCE: only columns present in the file are written. A file without the
     LOCKED columns must not null out what yesterday's file said.
   - A row whose IMEI cannot be read is DROPPED AND NAMED in the response, never silently.
   ===================================================================================== */

/* Watu writes dates as 13-Jul-26 -- day-MonthName-2-digit-year, a shape Hope's numeric
   parser has never seen. Month names are tested for all twelve. */
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

export function watuDate(v) {
  if (v == null || v === '') return null;
  // XLSX with cellDates:true hands real Date objects through.
  if (v instanceof Date && !isNaN(v.getTime())) {
    const p = n => (n < 10 ? '0' : '') + n;
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  const s = String(v).trim();
  // 13-Jul-26 / 13-Jul-2026 / 13 Jul 26 / 1-Dec-25
  const m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2}|\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toUpperCase()];
    if (!mon) return null;
    const d = parseInt(m[1], 10);
    if (d < 1 || d > 31) return null;
    let y = parseInt(m[3], 10);
    if (m[3].length === 2) y = y < 50 ? 2000 + y : 1900 + y;
    const p = n => (n < 10 ? '0' : '') + n;
    return y + '-' + p(mon) + '-' + p(d);
  }
  // Anything else (ISO, d/m/yyyy) falls through to Hope's parser, day-first like the region.
  return dateOrNull(s, true);
}

/** TRUE / FALSE arrive as text. Blank is null -- missing must not become "no". */
export function watuBool(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toUpperCase();
  if (s === 'TRUE' || s === 'YES' || s === '1' || s === 'T' || s === 'Y') return true;
  if (s === 'FALSE' || s === 'NO' || s === '0' || s === 'F' || s === 'N') return false;
  return null;
}

/** The IMEI as text: digits only, and only if it plausibly IS one (>= 10 digits keeps a
    truncated test row visible rather than silently invented). Scientific-notation text
    ("3.51929937378664E+14" -- Excel's crime scene) is recovered when it is exact. */
export function watuImei(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!isFinite(v) || v !== Math.floor(v)) return null;
    return String(v);
  }
  let s = String(v).trim();
  if (/e\+?\d+$/i.test(s)) {
    const n = Number(s);
    if (isFinite(n) && n === Math.floor(n)) s = n.toFixed(0);
  }
  const d = s.replace(/\D/g, '');
  return d.length >= 10 ? d : null;
}

/** "Hoop Limited, Kinondoni" -> KINONDONI. The team is the part after the dealer's own name;
    a shop with no comma is its own team. Team names are join keys, so normTeam like Hope. */
export function teamFromShop(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const i = s.lastIndexOf(',');
  const part = i >= 0 ? s.slice(i + 1) : s;
  return normTeam(part) || null;
}

/** Day N of the 45-day window. Day of disbursement = day 1 until Hoop states the exact
    formula (starter section 7 item 10). */
export function lifetimeDay(disbursedKey, todayKey) {
  if (!disbursedKey || !todayKey) return null;
  const ms = Date.parse(todayKey + 'T00:00:00Z') - Date.parse(disbursedKey + 'T00:00:00Z');
  if (isNaN(ms)) return null;
  return Math.floor(ms / 86400000) + 1;
}

/* Column -> header spellings. Several candidates per field because a header that matches
   nothing is indistinguishable from a column of empty cells. */
const WATU_COLS = [
  ['shop',           v => textOrNull(v), 'SHOP'],
  ['agent',          v => textOrNull(v), 'AGENT', 'AGENT NAME'],
  ['agent_id',       v => textOrNull(v), 'AGENT ID', 'AGENTID'],
  ['client_name',    v => textOrNull(v), 'CLIENT NAME', 'CUSTOMER NAME', 'NAME'],
  ['client_mobile',  v => textOrNull(v), 'CLIENT MOBILE', 'CLIENT PHONE', 'MOBILE', 'PHONE'],
  ['model',          v => textOrNull(v), 'MODEL'],
  ['model_details',  v => textOrNull(v), 'MODEL DETAILS', 'MODEL DETAIL'],
  ['disbursed_date', v => watuDate(v),   'DISBURSED DATE', 'DISBURSEMENT DATE', 'DISB DATE'],
  ['price',          v => num(v),        'PRICE', 'WATU PRICE', 'LOAN VALUE'],
  ['has_ever_paid',  v => watuBool(v),   'HAS EVER PAID', 'EVER PAID'],
  ['days_offline',   v => num(v),        'DAYS OFFLINE', 'OFFLINE DAYS'],
  ['onboarding_min', v => num(v),        'ONBOARDING TIME (MIN)', 'ONBOARDING TIME MIN', 'ONBOARDING TIME', 'ONBOARDING MIN'],
  ['app_signed_up',  v => watuBool(v),   'APP SIGNED UP', 'APP SIGNED-UP', 'APP SIGNUP'],
  ['locked4',        v => watuBool(v),   'LOCKED 4+ DAYS', 'LOCKED 4 DAYS', 'LOCKED 4+'],
  ['locked7',        v => watuBool(v),   'LOCKED 7+ DAYS', 'LOCKED 7 DAYS', 'LOCKED 7+'],
];
const IMEI_HEADERS = ['IMEI', 'IMEI NUMBER', 'IMEI NO'];

function cellOf(row, h, candidates) {
  for (const c of candidates) {
    const i = h[normalizeHeader(c)];
    if (i !== undefined) return { has: true, value: row[i] };
  }
  return { has: false };
}

/* =====================================================================================
   THE SALES IMPORTER -- general duty's hoopltd.shop export (sales_details.xlsx shape):

     Date | Branch | Agent | Client_Name | Client_Id | Client_Phone | Phone_Model |
     Receipt_Number | Imei | Commission_Agent | Commission_Phone | Price

   Underscored headers are literal -- normalizeHeader keeps them, so both spellings are
   candidates. The export ends with a "Total" footer row (Date cell says "Total", no
   IMEI): that row is the file's own arithmetic, skipped SILENTLY -- naming it among the
   dropped would cry wolf on every upload. Rows with a real name but no readable IMEI
   are still dropped AND NAMED, the Hope rule.
   ===================================================================================== */
const SALES_COLS = [
  ['sale_date',        v => watuDate(v),   'DATE', 'SALE DATE', 'SALE_DATE'],
  ['branch',           v => textOrNull(v), 'BRANCH'],
  ['agent',            v => textOrNull(v), 'AGENT', 'AGENT NAME'],
  ['client_name',      v => textOrNull(v), 'CLIENT_NAME', 'CLIENT NAME', 'CUSTOMER NAME'],
  ['client_id',        v => textOrNull(v), 'CLIENT_ID', 'CLIENT ID', 'ID_NO', 'ID NO'],
  ['client_phone',     v => textOrNull(v), 'CLIENT_PHONE', 'CLIENT PHONE', 'CLIENT MOBILE', 'PHONE_NO', 'PHONE NO'],
  ['model',            v => textOrNull(v), 'PHONE_MODEL', 'PHONE MODEL', 'MODEL', 'ITEM'],
  ['receipt_number',   v => textOrNull(v), 'RECEIPT_NUMBER', 'RECEIPT NUMBER', 'RECEIPT NO', 'RCPT_NO', 'RCPT NO'],
  ['commission_agent', v => textOrNull(v), 'COMMISSION_AGENT', 'COMMISSION AGENT'],
  ['commission_phone', v => textOrNull(v), 'COMMISSION_PHONE', 'COMMISSION PHONE'],
  ['price',            v => num(v),        'PRICE', 'TOTAL', 'GROSS_TOTAL'],
];
const SALES_IMEI_HEADERS = ['IMEI', 'IMEI NUMBER', 'IMEI NO', 'SERIAL'];

/** A file is a SALES file when it carries the columns only the hoopltd.shop export has.
    Decided from the header row alone, so /upload takes both file kinds in one slot. */
export function isSalesFile(headerRow) {
  const h = buildHeaderMap(headerRow || []);
  return ['RECEIPT_NUMBER', 'RECEIPT NUMBER', 'COMMISSION_AGENT', 'COMMISSION AGENT']
    .some(n => h[normalizeHeader(n)] !== undefined);
}

/** rows = array-of-arrays, first row headers. Returns { records, dropped, headers }.
    sale_key is deterministic (receipt + imei) so a re-upload UPDATES its own rows --
    a receipt can hold several phones, so the receipt number alone is not the key. */
export function importSales(rows) {
  const all = (rows || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (all.length < 2) return { records: [], dropped: [], headers: [] };
  const h = buildHeaderMap(all[0]);
  const present = SALES_COLS.filter(([, , ...names]) =>
    names.some(n => h[normalizeHeader(n)] !== undefined));
  const imeiIdx = SALES_IMEI_HEADERS.map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  if (imeiIdx === undefined) {
    const e = new Error('The sales file has no IMEI column. Headers seen: ' + all[0].join(' | '));
    e.status = 400;
    throw e;
  }
  const records = [];
  const dropped = [];
  const seen = new Set();
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    const first = String(row[0] == null ? '' : row[0]).trim().toUpperCase();
    const imei = watuImei(row[imeiIdx]);
    if (!imei) {
      if (first === 'TOTAL' || first === 'GRAND TOTAL') continue;   // the footer, silently
      const name = cellOf(row, h, ['CLIENT_NAME', 'CLIENT NAME', 'CUSTOMER NAME']);
      dropped.push({ line: i + 1, name: textOrNull(name.value) || '(no name)', imei: textOrNull(row[imeiIdx]) || '(blank)' });
      continue;
    }
    const out = { imei };
    for (const [key, fn, ...names] of present) {
      const got = cellOf(row, h, names);
      if (got.has) out[key] = fn(got.value);
    }
    out.sale_key = 'S' + salesH36(String(out.receipt_number || '') + '|' + imei);
    if (seen.has(out.sale_key)) {
      const j = records.findIndex(r => r.sale_key === out.sale_key);
      if (j >= 0) records[j] = out;
    } else { seen.add(out.sale_key); records.push(out); }
  }
  return { records, dropped, headers: present.map(p => p[0]) };
}
/* Same djb2-xor as call-core's h36; duplicated here because importers must not import
   the call stack. Two copies of five lines beat a shared module for two callers. */
function salesH36(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0;
  return x.toString(36);
}

/* =====================================================================================
   THE OFFLINE QUEUE -- the credit team's Watu portfolio sheet, and THE file that finally
   carries GUARANTORS (the PENDING #1 trigger, landed 2026-08-17). Real shape:

     Sale Date | IMEI | Offline Bucket | Customer | Customer Phone | Guarantor |
     Agent | Branch | Offline Owner | Status | Next Action Date | Last Action ...

   Guarantor arrives as ONE cell: "Issack daniely samawa | 0788533370" -- name, pipe,
   phone. Only the columns the register NEEDS are taken (the owner: "the file has extra
   data, dont use it if we dont have to"); the Watu working-state columns (bucket, owner,
   status, actions) stay in the file. MERGE, NEVER LOSE: a key rides a record only when
   its cell holds a value, so a blank cell leaves whatever the register already knows --
   the upload endpoint groups records by shape so PostgREST updates exactly those keys.
   ===================================================================================== */
const OFFLINE_COLS = [
  ['disbursed_date', v => watuDate(v),   'SALE DATE', 'SALE_DATE', 'DISBURSED DATE', 'DATE'],
  ['client_name',    v => textOrNull(v), 'CUSTOMER', 'CUSTOMER NAME', 'CLIENT NAME', 'CLIENT_NAME'],
  ['client_mobile',  v => textOrNull(v), 'CUSTOMER PHONE', 'CUSTOMER_PHONE', 'CLIENT MOBILE', 'CLIENT PHONE'],
  ['agent',          v => textOrNull(v), 'AGENT', 'AGENT NAME'],
  ['branch',         v => textOrNull(v), 'BRANCH'],
];
export function isOfflineQueueFile(headerRow) {
  const h = buildHeaderMap(headerRow || []);
  const has = n => h[normalizeHeader(n)] !== undefined;
  return has('GUARANTOR') || has('OFFLINE BUCKET') || has('OFFLINE_BUCKET');
}

/** Does this row LOOK like a header any importer knows? Some exports carry a merged
    company banner ABOVE the real header ("HOOP LTD" across one wide cell) -- the
    upload scans the first rows with this instead of refusing the file over a
    decoration. A banner matches nothing; the real header matches its kind. */
export function looksLikeHeader(row) {
  const h = buildHeaderMap(row || []);
  const has = n => h[normalizeHeader(n)] !== undefined;
  return isAgentsFile(row) || isAgedStockFile(row) || isSalesFile(row)
    || isOfflineQueueFile(row) || ['IMEI', 'IMEI NUMBER', 'IMEI NO'].some(has);
}
/** "name | phone" in one cell; a lone dash is Watu's own blank. No pipe: digits are a
    phone, anything else is a name -- never invent the half the cell does not hold. */
export function splitGuarantor(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s === '-') return { name: null, phone: null };
  const i = s.lastIndexOf('|');
  if (i < 0) {
    const d = s.replace(/\D/g, '');
    return d.length >= 9 ? { name: null, phone: s } : { name: s, phone: null };
  }
  return { name: s.slice(0, i).trim() || null, phone: s.slice(i + 1).trim() || null };
}
export function importOfflineQueue(rows) {
  const all = (rows || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (all.length < 2) return { records: [], dropped: [], headers: [] };
  const h = buildHeaderMap(all[0]);
  const present = OFFLINE_COLS.filter(([, , ...names]) => names.some(n => h[normalizeHeader(n)] !== undefined));
  const imeiIdx = IMEI_HEADERS.map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  const gIdx = ['GUARANTOR', 'GUARANTOR NAME'].map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  const gPhoneIdx = ['GUARANTOR PHONE', 'GUARANTOR_PHONE'].map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  if (imeiIdx === undefined) {
    const e = new Error('The offline-queue file has no IMEI column. Headers seen: ' + all[0].join(' | '));
    e.status = 400; throw e;
  }
  const records = [];
  const dropped = [];
  const comments = [];
  const seen = new Set();
  // The sheet's own follow-up trail (Status / Last Action ...) imports ONE TIME into the
  // app's comment history -- the owner: "we moved to commenting into the current
  // HoopCalls app". Deterministic ids at the upload layer make every re-send a no-op.
  const cCol = n => { const i = h[normalizeHeader(n)]; return i === undefined ? -1 : i; };
  const stIdx = cCol('STATUS'), noteIdx = cCol('LAST ACTION NOTE'),
    byIdx = cCol('LAST ACTION BY'), atIdx = cCol('LAST ACTION AT');
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    const imei = watuImei(row[imeiIdx]);
    if (!imei) {
      const name = cellOf(row, h, ['CUSTOMER', 'CUSTOMER NAME', 'CLIENT NAME']);
      dropped.push({ line: i + 1, name: textOrNull(name.value) || '(no name)', imei: textOrNull(row[imeiIdx]) || '(blank)' });
      continue;
    }
    // MERGE RULE: only keys whose cell holds a value ride the record.
    const out = { imei };
    for (const [key, fn, ...names] of present) {
      const got = cellOf(row, h, names);
      if (!got.has) continue;
      const v = fn(got.value);
      if (v != null && v !== '') out[key] = v;
    }
    if (gIdx !== undefined) {
      const g = splitGuarantor(row[gIdx]);
      if (g.name) out.guarantor_name = g.name;
      if (g.phone) out.guarantor_phone = g.phone;
    }
    if (gPhoneIdx !== undefined) {
      const p = textOrNull(row[gPhoneIdx]);
      if (p) out.guarantor_phone = p;
    }
    const note = noteIdx >= 0 ? String(row[noteIdx] == null ? '' : row[noteIdx]).trim() : '';
    const status = stIdx >= 0 ? String(row[stIdx] == null ? '' : row[stIdx]).trim() : '';
    if (note || (status && status !== '-')) {
      const by = byIdx >= 0 ? String(row[byIdx] == null ? '' : row[byIdx]).trim() : '';
      const at = atIdx >= 0 ? String(row[atIdx] == null ? '' : row[atIdx]).trim() : '';
      const ts = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(at)
        ? at.slice(0, 16).replace(' ', 'T') + ':00+03:00' : null;
      comments.push({ imei, comment: note || ('[' + status + ']'),
        created_by: by ? by + ' (Watu)' : 'Watu offline queue', created_at: ts });
    }
    if (seen.has(imei)) {
      const j = records.findIndex(r => r.imei === imei);
      if (j >= 0) records[j] = out;
    } else { seen.add(imei); records.push(out); }
  }
  return { records, comments, dropped, headers: present.map(p => p[0]) };
}

/* =====================================================================================
   SIPHO'S HTML SAVES -- he cannot export Excel, so the upload page parses his saved
   SyscoPos pages IN THE BROWSER (DOMParser), turns the rendered table into plain rows,
   and sends them here like any other file. The HTML itself is never stored -- the rows
   are extracted, upserted, and the file is dumped. Two page kinds:

     Agents Register -> hoop_agents  (JOINED|NAME|NATIONAL_ID|PHONE|EMAIL|KIN_NAME|
                                      KIN_PHONE|KIN_RELATIONSHIP|ROLE|BRANCH|STATUS)
     Aged Stock      -> hoop_aged_stock (AGENT|ITEM|SERIAL|RECEIVED|AGE)
   ===================================================================================== */
const AGENTS_COLS = [
  ['joined_date',      v => watuDate(v),   'JOINED', 'DATE', 'DATE_JOINED', 'DATE JOINED'],
  ['name',             v => textOrNull(v), 'NAME', 'AGENT NAME'],
  ['national_id',      v => textOrNull(v), 'NATIONAL_ID', 'NATIONAL ID'],
  ['email',            v => textOrNull(v), 'EMAIL'],
  ['kin_name',         v => textOrNull(v), 'KIN_NAME', 'KIN NAME', 'NEXT_OF_KIN', 'NEXT OF KIN'],
  ['kin_phone',        v => textOrNull(v), 'KIN_PHONE', 'KIN PHONE'],
  ['kin_relationship', v => textOrNull(v), 'KIN_RELATIONSHIP', 'KIN RELATIONSHIP', 'RELATIONSHIP'],
  ['role',             v => textOrNull(v), 'ROLE', 'AGENT_TYPE', 'AGENT TYPE'],
  ['branch',           v => textOrNull(v), 'BRANCH'],
];
export function isAgentsFile(headerRow) {
  const h = buildHeaderMap(headerRow || []);
  return ['KIN_NAME', 'KIN NAME', 'NEXT_OF_KIN', 'NEXT OF KIN']
    .some(n => h[normalizeHeader(n)] !== undefined);
}
/** Keyed on phone like the hoop_agents table itself; a row with no phone is dropped
    and named -- phone IS the identity that joins commissions to people. */
export function importAgents(rows) {
  const all = (rows || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (all.length < 2) return { records: [], dropped: [], headers: [] };
  const h = buildHeaderMap(all[0]);
  const present = AGENTS_COLS.filter(([, , ...names]) => names.some(n => h[normalizeHeader(n)] !== undefined));
  const phoneIdx = ['PHONE', 'PHONE_NUMBER', 'PHONE NUMBER'].map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  const statusIdx = ['STATUS', 'ACCOUNT_STATUS', 'ACCOUNT STATUS'].map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  if (phoneIdx === undefined) {
    const e = new Error('The agents file has no PHONE column -- hoop_agents is keyed on it. Headers seen: ' + all[0].join(' | '));
    e.status = 400; throw e;
  }
  const records = [];
  const dropped = [];
  const seen = new Set();
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    const phone = String(row[phoneIdx] == null ? '' : row[phoneIdx]).replace(/\s+/g, '').trim();
    if (!phone || phone.replace(/\D/g, '').length < 9) {
      const name = cellOf(row, h, ['NAME', 'AGENT NAME']);
      dropped.push({ line: i + 1, name: textOrNull(name.value) || '(no name)', imei: phone || '(no phone)' });
      continue;
    }
    const out = { phone };
    for (const [key, fn, ...names] of present) {
      const got = cellOf(row, h, names);
      if (got.has) out[key] = fn(got.value);
    }
    if (statusIdx !== undefined) {
      const s = String(row[statusIdx] == null ? '' : row[statusIdx]).trim().toUpperCase();
      if (s) out.active = s === 'ACTIVE' || s === 'TRUE' || s === '1';
    }
    if (seen.has(phone)) {
      const j = records.findIndex(r => r.phone === phone);
      if (j >= 0) records[j] = out;
    } else { seen.add(phone); records.push(out); }
  }
  return { records, dropped, headers: present.map(p => p[0]) };
}

const AGED_COLS = [
  ['agent',    v => textOrNull(v), 'AGENT', 'AGENT NAME'],
  ['item',     v => textOrNull(v), 'ITEM', 'PRODUCT'],
  ['received', v => watuDate(v),   'RECEIVED', 'DATE_RECEIVED', 'DATE RECEIVED'],
  ['age_days', v => num(v),        'AGE', 'AGE_DAYS', 'AGE DAYS'],
];
export function isAgedStockFile(headerRow) {
  const h = buildHeaderMap(headerRow || []);
  const has = n => h[normalizeHeader(n)] !== undefined;
  return has('SERIAL') && (has('AGE') || has('RECEIVED') || has('DATE_RECEIVED'));
}
/** Keyed on serial (the IMEI in warehouse clothes). as_of stamps which day's report
    this was -- age is only true on the day it was read. */
export function importAgedStock(rows) {
  const all = (rows || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (all.length < 2) return { records: [], dropped: [], headers: [] };
  const h = buildHeaderMap(all[0]);
  const present = AGED_COLS.filter(([, , ...names]) => names.some(n => h[normalizeHeader(n)] !== undefined));
  const serialIdx = ['SERIAL', 'IMEI', 'SERIAL NO'].map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  if (serialIdx === undefined) {
    const e = new Error('The aged-stock file has no SERIAL column. Headers seen: ' + all[0].join(' | '));
    e.status = 400; throw e;
  }
  const records = [];
  const dropped = [];
  const seen = new Set();
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    const serial = watuImei(row[serialIdx]);
    if (!serial) {
      const name = cellOf(row, h, ['AGENT', 'AGENT NAME']);
      dropped.push({ line: i + 1, name: textOrNull(name.value) || '(no agent)', imei: textOrNull(row[serialIdx]) || '(blank)' });
      continue;
    }
    const out = { serial };
    for (const [key, fn, ...names] of present) {
      const got = cellOf(row, h, names);
      if (got.has) out[key] = fn(got.value);
    }
    if (seen.has(serial)) {
      const j = records.findIndex(r => r.serial === serial);
      if (j >= 0) records[j] = out;
    } else { seen.add(serial); records.push(out); }
  }
  return { records, dropped, headers: present.map(p => p[0]) };
}

/** rows = array-of-arrays, first row headers. Returns { records, teams, dropped, headers }.
    records carry ONLY the columns whose headers are present (the header-presence rule);
    `team` is derived and always present when shop is; `imei` is always present. */
export function importWatu(rows) {
  const all = (rows || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (all.length < 2) return { records: [], teams: [], dropped: [], headers: [] };
  const h = buildHeaderMap(all[0]);
  const present = WATU_COLS.filter(([, , ...names]) =>
    names.some(n => h[normalizeHeader(n)] !== undefined));
  const imeiIdx = IMEI_HEADERS.map(n => h[normalizeHeader(n)]).find(i => i !== undefined);
  if (imeiIdx === undefined) {
    const e = new Error('The file has no IMEI column -- the register is keyed on it. '
      + 'Headers seen: ' + all[0].join(' | '));
    e.status = 400;
    throw e;
  }
  const records = [];
  const dropped = [];
  const teams = new Set();
  const seen = new Set();
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    const imei = watuImei(row[imeiIdx]);
    if (!imei) {
      const name = cellOf(row, h, ['CLIENT NAME', 'CUSTOMER NAME', 'NAME']);
      dropped.push({ line: i + 1, name: textOrNull(name.value) || '(no name)', imei: textOrNull(row[imeiIdx]) || '(blank)' });
      continue;
    }
    // The same IMEI twice in one file is one phone: last occurrence wins, or Postgres
    // refuses the batch with "cannot affect row a second time".
    const out = { imei };
    for (const [key, fn, ...names] of present) {
      const got = cellOf(row, h, names);
      if (got.has) out[key] = fn(got.value);
    }
    if (out.shop !== undefined) {
      const t = teamFromShop(out.shop);
      if (t) { out.team = t; teams.add(t); }
    }
    if (seen.has(imei)) {
      const j = records.findIndex(r => r.imei === imei);
      if (j >= 0) records[j] = out;
    } else { seen.add(imei); records.push(out); }
  }
  return { records, teams: [...teams], dropped, headers: present.map(p => p[0]) };
}
