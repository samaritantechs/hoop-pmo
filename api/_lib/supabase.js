import { createClient } from '@supabase/supabase-js';

// Server-side client for API routes -- uses the service role key so it can enforce your
// OWN access-code permission logic (below) rather than relying on Postgres RLS policies.
// This matches how Code.gs works today (auth_() checks a code against the Access sheet,
// then the rest of the function trusts that check) -- same model, new engine.
// A PASTED VALUE IS A HUMAN VALUE. createClient validates the URL at import time, so a
// SUPABASE_URL carrying stray quotes, whitespace, or a missing scheme did not fail one
// request -- it killed EVERY function at invocation (FUNCTION_INVOCATION_FAILED), which
// reached the phones as "server is not answering". Normalise first; keep the placeholder
// fallback so `npm test` stays importable with no env at all (tests inject the fake db).
/** A Supabase API key is a JWT whose payload names the PROJECT REF -- so even when a key
    is pasted where the URL belongs (which is exactly what happened on the first setup
    night), the right URL is recoverable from the paste itself. */
function refUrlFromJwt(raw) {
  const m = String(raw == null ? '' : raw).trim().match(/^eyJ[\w-]+\.([\w-]+)\.[\w-]+$/);
  if (!m) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    const ref = payload && payload.ref ? String(payload.ref) : '';
    return /^[a-z0-9]{16,24}$/.test(ref) ? 'https://' + ref + '.supabase.co' : null;
  } catch (e) { return null; }
}
function normUrl(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/^['"]+|['"]+$/g, '').replace(/\/+$/, '');
  if (!s) return null;
  if (/^eyJ/.test(s)) return null;               // that is a KEY, not a URL -- see refUrlFromJwt
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).origin; } catch (e) { return null; }
}
export const SUPABASE_URL_NORM =
  normUrl(process.env.SUPABASE_URL)
  || refUrlFromJwt(process.env.SUPABASE_URL)                  // a key in the URL slot
  || refUrlFromJwt(process.env.SUPABASE_SERVICE_ROLE_KEY);    // last resort: the key itself names the project
export const supabase = createClient(
  SUPABASE_URL_NORM || 'https://unset.supabase.co',
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || 'unset').trim().replace(/^['"]+|['"]+$/g, ''),
  { auth: { persistSession: false } }
);

export const PAGE_SIZE = 1000;   // kept for the callers that still name it

/** A hosted database is not always there. When Supabase is overloaded, restarting, or its
    edge cannot reach it, the answer is not data and not a normal error -- it is a gateway
    timeout, often a whole HTML error page. Every screen then failed at once and the system
    looked broken when it was only briefly unreachable.

    One immediate retry, then one more after a short pause, rides out exactly that. It is
    deliberately small: a hammering retry on a database that is already struggling makes it
    worse, which is the same mistake as fetching pages six at a time. */
/* `canceling statement` is Postgres itself giving up on ONE statement that outran its timeout.
   It is named explicitly rather than left to match on the word "timeout", because it is the
   failure a slow database produces most often and it is worth being able to see it in this
   list. Retrying it is safe: a cancelled statement is rolled back whole, so it wrote nothing. */
const TRANSIENT = /timeout|timed out|canceling statement|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|502|503|504|522|<!DOCTYPE/i;

export function isTransient(err) {
  if (!err) return false;
  const m = String(err.message || err);
  return TRANSIENT.test(m);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Runs a query, retrying only failures that look like the database being briefly unreachable.
    A real error -- bad column, permission, constraint -- is returned immediately, because
    retrying it would only delay the truth. */
export async function runQuery(build, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    let res;
    try { res = await build(); }
    catch (e) { res = { data: null, error: e }; }        // fetch itself threw
    if (!res.error) return res;
    last = res.error;
    if (!isTransient(last) || i === tries - 1) return res;
    await sleep(i === 0 ? 250 : 1200);
  }
  return { data: null, error: last };
}

/** The message a PERSON should see when the database is unreachable. Supabase's edge answers
    with an HTML error page, and printing that verbatim is how a 522 ended up on screen as a
    wall of markup. */
export function friendlyDbError(err) {
  const raw = String((err && err.message) || err || '');
  if (isTransient(err) || raw.length > 200 || raw.indexOf('<') === 0) {
    return 'Mfumo wa kumbukumbu haupatikani kwa dakika hii. Subiri sekunde chache ujaribu tena. '
         + '/ The database is briefly unreachable — wait a few seconds and try again.';
  }
  return raw;
}


/* =====================================================================================
   A DATABASE FUNCTION IS CAPPED EXACTLY LIKE A TABLE READ, AND NOTHING WAS PAGING IT.

     "i wonder why use sampling in a list that needs them all .. i fear many defaulters havent
      been reached in app followup by now"

   That fear was right, and this is where it came from. fetchAll has always paged past
   PostgREST's silent 1000-row cap for ordinary reads -- it is the first thing this file
   explains. Every `db.rpc(...)` call in the system was a bare single request, and PostgREST
   applies THE SAME CAP to a function that returns a set. No error, no warning: row 1001 onward
   simply is not there.

   The team-day totals function is the one that hurts. A week of defaulter decks is seven days
   times forty teams times seven weekdays times two types -- getting on for four thousand
   summary rows, of which a thousand came back. The weekly report and the dashboard have been
   adding up a truncated set, and the per-team date map built on it silently lost every team
   whose row fell past the cap, which is precisely "a team is in the file but nowhere on the
   screen".

   So RPC gets what table reads have always had. Same page size, same stop condition -- a short
   page means the end -- and the same one-at-a-time discipline, because a wave of concurrent
   pages is what exhausted the connection pool the last time somebody tried it.

   A CLIENT THAT CANNOT PAGE IS STILL ANSWERED. `.range()` exists on the real PostgREST builder;
   anything else gets one plain call rather than an exception.

   THAT CHECK COSTS NOTHING, and it took a failing test to make it so. The first version built a
   throwaway `db.rpc(...)` purely to look for `.range` on it. On the real client that is free --
   nothing is sent until the builder is awaited -- but it is still one more call than the work
   needs, and the speed guards count calls, not awaits. They were right to. So the capability is
   read off the SAME builder the page is about to be sent on: if it cannot range, that builder is
   returned as it stands and its one answer is the whole answer. */
export async function rpcAll(db, fn, args) {
  if (!db || typeof db.rpc !== 'function') return { data: null, error: new Error('no rpc') };

  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let paged = true;
    const { data, error } = await runQuery(() => {
      const q = db.rpc(fn, args);
      if (q && typeof q.range === 'function') return q.range(from, from + PAGE_SIZE - 1);
      paged = false;                       // a client that cannot page: this one call is it
      return q;
    });
    if (!paged) return { data, error };
    if (error) return { data: null, error };
    const page = Array.isArray(data) ? data : [];
    out.push(...page);
    // A short page is the end. An exactly-full one is not, so it asks again.
    if (page.length < PAGE_SIZE) break;
    /* The same guard fetchAll has. A function that never returns a short page would otherwise
       spin forever; stopping loudly beats a request that never ends. */
    if (out.length > 500000) throw new Error(`${fn} returned more than 500,000 rows -- refusing to keep paging`);
  }
  return { data: out, error: null };
}

/** Supabase/PostgREST caps any single query at 1000 rows by default -- silently, no error, just
    a truncated result. This is exactly what made two different tables both report precisely
    1000 on the dashboard regardless of their real row counts. Fetches ALL matching rows by
    paginating with .range() until a page comes back short of a full page (the sign nothing's
    left). Takes a function that BUILDS the query, not a query object -- .range() needs to apply
    to a fresh copy each page, not a query that's already been sent. */
/** Pages until a short page arrives -- ONE PAGE AT A TIME, deliberately.

    A wave of six concurrent page requests was tried and reverted the same day. It made each
    individual read finish sooner, but every screen fires several of these at once, and with
    200+ users on a live system the multiplied concurrency exhausted the database's connection
    pool: logins started failing with "failed to fetch", Settings would not open, and the
    data-heavy tabs errored. Latency per read is a smaller problem than the whole system
    falling over, so this stays sequential.

    The real fix for a slow read is to ask for FEWER ROWS AND FEWER COLUMNS, which is what the
    narrowed selects do -- not to ask for the same excess faster. */
/* FEWER, BIGGER PAGES -- not more of them at once.

   Asking for a thousand rows at a time meant thirty separate journeys to the database for one
   snapshot of thirty thousand customers, each one a full HTTPS round trip from Vercel. The
   dashboard needed 567 of them. At 150ms apiece that is eighty-five seconds of waiting before
   a single figure is worked out, and the platform gives up at sixty.

   The fix is NOT to fire them in parallel -- that was tried and it took the whole system down
   (see above). It is to make each journey carry more. Ten thousand rows in one request costs
   barely more than one thousand: the same round trip, a bigger body.

   PostgREST may be configured with a lower ceiling than we ask for, and it enforces it
   SILENTLY -- a truncated page with no error, which is what once made two different tables
   both report exactly 1000. So the ceiling is LEARNED rather than assumed: if the first page
   comes back at a round number below what was asked for, that number becomes the page size for
   the rest of this read, and paging continues correctly from there. Asking for more than the
   server allows is therefore safe, and asking for less than it allows is just slow. */
export const MAX_PAGE = 10000;
/* The numbers a person actually types into a server's row limit. Matching any multiple of 500
   was too eager -- a table holding exactly 4,500 rows is a normal table, not a truncated one,
   and paying an extra round trip for it on every read is a tax on being ordinary. */
const LIKELY_CAPS = new Set([1000, 2000, 5000, 10000, 20000, 25000, 50000, 100000]);

/* =====================================================================================
   A PAGED READ NEEDS A TOTAL ORDER, OR THE PAGES DO NOT FIT TOGETHER.
   =====================================================================================
   Reported from the field, and it is the most corrosive kind of bug there is:

     "The dashboard reads different stats after every visit or refresh without even any
      update being uploaded."

   Nothing was being uploaded and nothing was random in our arithmetic. The randomness was in
   the DATABASE, and it is documented behaviour rather than a fault.

   `offset`/`limit` slice a result set by POSITION. Postgres only promises a position when the
   query says ORDER BY -- without one it is free to hand rows back in whatever order the plan
   happens to produce, and that order is not stable between two separate statements. It is
   least stable on exactly the tables this matters for: `synchronize_seqscans` is on by default,
   so a sequential scan over a big table starts wherever another scan already in flight has got
   to, and finishes by wrapping round. Two users refreshing at once therefore get two DIFFERENT
   orderings of the same unchanged rows.

   Page 1 is then rows 0-9,999 of one ordering and page 2 is rows 10,000-19,999 of a different
   one. Some customers arrive twice and others not at all -- so the total moves every refresh,
   by a plausible-looking amount, with no error anywhere and nothing in the data to blame. It
   also explains the shape of the complaint that came with it: figures that look "abnormal"
   rather than obviously broken.

   The fix is to give every paged read a tiebreaker on a column that is UNIQUE, which pins the
   ordering down completely. It is added AFTER whatever the caller already ordered by, so the
   caller's own sort still decides and this only settles the ties -- which is the only place
   the ambiguity ever was.

   COST. Sorting is not free, but it is small next to what these reads already do: a sort of ten
   thousand rows costs a few milliseconds, against the tens of milliseconds it takes merely to
   serialise them and put them on the wire. Where the tiebreaker is the primary key, Postgres can
   often walk the index and not sort at all.

   IF THE SERVER WILL NOT ACCEPT THE ORDER -- an un-migrated table that has no `id` yet, a view,
   a column renamed -- the read falls back to exactly what it did before: unordered, one page at
   a time. A tiebreaker that cannot be applied must never turn a working screen into an error. */

/* Tables whose primary key is not called `id`. Everything else that is big enough to page has
   one that is, so `id` is the default rather than a guess. */
const PAGE_KEY = {
  teams: 'team',
  access_codes: 'code',
  roles: 'role',
  settings: 'key',
  followup_status: 'ref',
  call_users: 'user_id',
  call_agents: 'user_id',
  /* devices is keyed by IMEI and has no `id` column at all, so the default below asked
     PostgREST to order by a column that does not exist. The fallback above caught it and
     re-read the table unordered, exactly as designed -- so nothing broke and nobody saw it.
     What it cost was two round trips for every read of the register, one of them certain to
     fail, on the busiest pane in the system and on every heartbeat that looks a handset up.
     Naming the real key here makes the first attempt the only attempt, and gives the paged
     read the stable tiebreaker this whole mechanism exists to provide. */
  devices: 'imei',
};

/** The table a built query points at, read off the URL PostgREST is about to be asked for.
    Taken from the query rather than passed in by a hundred call sites: a parameter that has to
    be remembered at every read is a parameter that will be forgotten at one of them, and a
    forgotten one here is silent. */
function tableOf(q) {
  try {
    const path = q && q.url && q.url.pathname;
    if (!path) return null;
    const name = String(path).split('/').filter(Boolean).pop();
    return name || null;
  } catch { return null; }
}

/** The unique column that settles the order for this query, or null if we cannot tell which
    table it reads -- in which case nothing is added and the read behaves as it always did. */
export function pageKeyFor(q) {
  const t = tableOf(q);
  if (!t) return null;
  return Object.prototype.hasOwnProperty.call(PAGE_KEY, t) ? PAGE_KEY[t] : 'id';
}

/** `state.key` is decided from the FIRST query this builds and remembered for the rest of the
    read -- deliberately not by building a throwaway query to look at, because a caller counting
    how many times it is asked for a table would then see one extra per read, and one of them
    does exactly that to prove the widget is riding on the cache rather than the book.
    Pass state.key = null to force the plain, unordered read this always used to do. */
async function readPages(buildQuery, state) {
  const all = [];
  let from = 0;
  // Deliberately NOT remembered between reads. A filtered query that legitimately returns
  // exactly a round number would otherwise pin every later read to that size for the life of
  // the process -- a wrong guess that quietly slows everything and is invisible. One optimistic
  // request per read is a cheap price for not carrying a mistake around.
  let size = MAX_PAGE;
  while (true) {
    const { data, error } = await runQuery(() => {
      const q = buildQuery();
      if (state.key === undefined) state.key = pageKeyFor(q);
      return (state.key ? q.order(state.key, { ascending: true }) : q).range(from, from + size - 1);
    });
    if (error) throw error;
    const got = data ? data.length : 0;
    for (const r of (data || [])) all.push(r);

    if (got < size) {
      /* A short page normally means the end. But a page that stops on a round number, when we
         asked for more, is more likely a server ceiling -- and treating a ceiling as the end
         drops every row past it while the totals still look plausible, which is the worst way
         for this to fail. So: shrink to what arrived and keep going. If it really was the end,
         the next request comes back empty and costs one round trip. */
      if (!LIKELY_CAPS.has(got)) break;
      size = got;
    }
    from += size;
  }
  return all;
}

export async function fetchAll(buildQuery) {
  const state = { key: undefined };
  try {
    return await readPages(buildQuery, state);
  } catch (e) {
    /* A database that is unreachable is not a bad column name, and pretending otherwise would
       hide an outage behind a second doomed attempt. Nor is there anything to retry if no
       tiebreaker was applied in the first place -- that read already failed on its own terms.
       Only a refusal of the ORDER is worth a second, plainer attempt. */
    if (isTransient(e) || !state.key) throw e;
    return readPages(buildQuery, { key: null });
  }
}
