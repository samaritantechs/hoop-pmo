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
