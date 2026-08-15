// Shared CSV -> typed-value helpers for the migration.
//
// A few of these exist specifically BECAUSE of bugs that cost real time in the Sheets
// version -- documented inline so nobody "fixes" them back to the naive version later.

/** Row objects from csv-parse keep whatever header text was in row 1. Sheets exports
    sometimes have trailing spaces or slightly different casing across tabs that are
    "the same" column -- this matches by normalized name so a migration doesn't silently
    drop a column just because one tab's header has a trailing space and another doesn't. */
export function normalizeHeader(h) {
  return String(h || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function col(row, headerMap, ...candidates) {
  for (const c of candidates) {
    const key = headerMap[normalizeHeader(c)];
    if (key !== undefined && row[key] !== undefined && row[key] !== '') return row[key];
  }
  return null;
}

export function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => { map[normalizeHeader(h)] = i; });
  return map;
}

/** Tolerant number parser: strips commas/currency text, returns null (not 0) for blank
    so a genuinely-missing value doesn't get silently recorded as zero in a numeric column. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Slash dates arrive in BOTH orders and neither source announces which: a Sheets CSV export
    follows the sheet's locale (d/m/yyyy here), while a browser-side XLSX parse used to render
    Dates as m/d/yyyy. Reading one as the other is silent corruption, not a visible failure --
    7/23/2026 was refused outright (month 23) and 7/5/2026 quietly became 7 May instead of
    5 July. So: whichever component CANNOT be a month decides the order, and only when both
    are <= 12 do we fall back to d/m/yyyy, the convention of the sheets this system reads.
    (The browser path now sends yyyy-mm-dd, which is unambiguous and skips all of this.) */
/** `dayFirst` is optional and comes from inferDayFirst over the whole column: it only decides
    the cases the value itself cannot, like 06/07/2026. Everything else is read from the value.
    Omitted, this behaves exactly as it always has. */
export function dateOrNull(v, dayFirst) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || /^no\s+due\s+date$/i.test(s)) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                      // ISO first -- never ambiguous
  if (m) {
    const month = Number(m[2]), day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), year = yearOf(m[3]);
    let day, month;
    if (a > 12 && b <= 12) { day = a; month = b; }                      // 23/7 -> only d/m is possible
    else if (b > 12 && a <= 12) { month = a; day = b; }                 // 7/23 -> only m/d is possible
    else if (dayFirst === false) { month = a; day = b; }                 // the file said month-first
    else { day = a; month = b; }                                        // both <= 12 -> the sheets' own d/m
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

/** 'HH:MM' from a clock value. A time-only cell comes back from the XLSX parse as a Date on
    Excel's epoch day, so the DATE part is meaningless and only the clock survives. */
export function timeOrNull(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** IS THIS FILE WRITTEN DAY-FIRST OR MONTH-FIRST?

    23/07/2026 can only be d/m. 07/23/2026 can only be m/d. 06/07/2026 is genuinely both, and
    guessing wrong moves a comment by up to eleven months while looking perfectly reasonable.

    A whole COLUMN usually settles it: one unambiguous value anywhere in the file decides every
    value in it, because a single export does not switch conventions halfway down. So this
    reads the column, not the cell.

    Returns true (day-first), false (month-first), or null when the file offers no evidence
    either way -- a caller that gets null should say so rather than pretend it knew. */
/** A two-digit year, turned into a four-digit one. "23-06-26" is how a person writes the
    twenty-third of June twenty twenty-six, and refusing it silently lost every promise date in
    a file that happened to be exported that way.

    Under fifty means this century. Fifty and over means the last one -- the usual convention,
    and safe here because these are loan dates: there is no 1998 promise date, and a birth year
    would never reach this function. */
export function yearOf(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (t.length === 4) return t;
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  return String(n < 50 ? 2000 + n : 1900 + n);
}

export function inferDayFirst(values) {
  let dayFirst = 0, monthFirst = 0;
  for (const v of (values || [])) {
    const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
  }
  /* A file carrying BOTH kinds of evidence is malformed -- somebody pasted two exports
     together. The larger pile of evidence wins, and an exact tie gives up rather than guessing
     from a coin flip. */
  /* A file carrying BOTH kinds of evidence is malformed -- somebody pasted two exports
     together. The larger pile of evidence wins, and an exact tie gives up rather than guessing
     from a coin flip. Null means UNDECIDED, and it stays undecided here: a caller that has a
     safe way to break the tie can use tightestSpanIsDayFirst below, and one that has not --
     a comment log legitimately spans a year -- must not have a guess made on its behalf. */
  if (dayFirst === monthFirst) return null;
  return dayFirst > monthFirst;
}

/** WHICH READING PUTS THE FILE IN THE TIGHTER SPAN, for the files where nothing else can tell.

    An approved-loans report for the first week of August is 8/3, 8/4 ... 8/10: every value has
    both components under thirteen, so inferDayFirst counts nothing and gives up -- and giving
    up means day-first, which read that week as THE EIGHTH OF SIX DIFFERENT MONTHS:

      "Replaced 7 days, 2026-03-08 to 2026-10-08"     "i uploaded approved and now getting 0 sales!"

    Eight months of history out of a one-week report, and August's sales then read zero because
    nothing landed in August.

    A REPORT covers a stretch of days. It does not cover the same day-of-month across most of a
    year. So where the components cannot decide, the shape of the result can -- seven days
    against seven months is not a close call.

    Deliberately NOT part of inferDayFirst. This reasoning is only sound for a file that covers
    one short period, which a day's or a week's report does and a year of imported comment
    history does not. Null when it genuinely cannot tell. */
export function tightestSpanIsDayFirst(values) {
  const span = first => {
    let lo = null, hi = null;
    for (const v of (values || [])) {
      const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (!m) continue;
      const d = first ? Number(m[1]) : Number(m[2]);
      const mo = first ? Number(m[2]) : Number(m[1]);
      let y = Number(m[3]); if (y < 100) y += 2000;
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;      // not a real date this way round
      const t = Date.UTC(y, mo - 1, d);
      if (lo === null || t < lo) lo = t;
      if (hi === null || t > hi) hi = t;
    }
    return lo === null ? null : (hi - lo);
  };
  const dSpan = span(true), mSpan = span(false);
  if (dSpan === null || mSpan === null || dSpan === mSpan) return null;
  return dSpan < mSpan;
}

/** A full moment -- date AND clock -- as an ISO timestamp, for a log whose ORDER matters.

    dateOrNull deliberately throws the time away: a due date has no clock. A comment log is the
    opposite. Its rows are what somebody said and when, several in the same afternoon, and the
    screen shows them newest first -- so collapsing every comment of a day onto midnight loses
    the order they were actually made in.

    `dayFirst` comes from inferDayFirst over the whole column. Null means undecided, and the
    caller decides what to do about that; here it falls back to day-first, which is what
    dateOrNull has always assumed.

    Returns null rather than a wrong answer, so an unreadable stamp is visible as missing
    instead of quietly becoming the moment of upload. */
export function stampOrNull(v, dayFirst) {
  if (v == null || v === '') return null;
  // The XLSX reader hands real date cells back as Date objects, which already carry the clock.
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  if (!s) return null;

  let y, mo, d;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                  // ISO -- never ambiguous
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (!m) return null;
    const a = +m[1], b = +m[2];
    y = +yearOf(m[3]);
    if (a > 12 && b <= 12) { d = a; mo = b; }                        // only d/m is possible
    else if (b > 12 && a <= 12) { mo = a; d = b; }                   // only m/d is possible
    else if (dayFirst === false) { mo = a; d = b; }                  // the file said month-first
    else { d = a; mo = b; }                                          // the sheets' own d/m
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  // The clock, if there is one. 12-hour times carry am/pm; a bare 24-hour time does not.
  let hh = 0, mi = 0, ss = 0;
  const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
  if (t) {
    hh = +t[1]; mi = +t[2]; ss = t[3] ? +t[3] : 0;
    const ap = t[4] ? t[4].toUpperCase() : '';
    if (ap === 'PM' && hh < 12) hh += 12;
    if (ap === 'AM' && hh === 12) hh = 0;
    if (hh > 23 || mi > 59 || ss > 59) { hh = 0; mi = 0; ss = 0; }
  }

  /* Read as EAT (UTC+3) and stored as the UTC instant it was. The clock in a v1 export is the
     wall clock in the office, and treating 11:29 as 11:29 UTC would file every comment three
     hours early -- enough to move an evening one onto the next day. */
  const p2 = n => String(n).padStart(2, '0');
  const iso = `${y}-${p2(mo)}-${p2(d)}T${p2(hh)}:${p2(mi)}:${p2(ss)}+03:00`;
  const when = new Date(iso);
  return isNaN(when.getTime()) ? null : when.toISOString();
}

/** D.S / D.C are "paid/target" TEXT, e.g. "3/6" -- this is the one field that broke
    repeatedly in the Sheets version because Excel/Sheets kept silently re-interpreting
    it as a date. Here it's read as a plain string into a TEXT column with no numeric or
    date coercion possible anywhere in the pipeline -- if the CSV cell already got
    Excel-mangled into something like "Jun-03" before it ever reached this script, that's
    upstream of us and worth a visual spot-check on the export, but nothing in THIS
    pipeline can introduce the corruption itself. */
export function dsText(v) {
  return v === null || v === undefined ? null : String(v).trim();
}

/** Phone normalization matching pnorm_() from Code.gs: strip everything but digits,
    drop a leading 255 country code, drop leading zeros, keep the last 9 digits. Same
    normalization means the same customer matches the same phone across old and new data. */
export function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('255')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  return d.slice(-9) || null;
}

export function textOrNull(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? null : s;
}

/** Team names are identifiers used for matching and foreign keys, not free text -- "Tunduru"
    and "TUNDURU" are the same team to a person but different strings to an exact-match database
    constraint. Normalizing every team value through this, everywhere a team gets read (Teams
    upload AND every table that references it), means that mismatch can't happen again -- not
    guarded against case by case, structurally not possible. */
export function normTeam(v) {
  const s = textOrNull(v);
  return s ? s.toUpperCase().replace(/\s+/g, ' ') : null;
}
