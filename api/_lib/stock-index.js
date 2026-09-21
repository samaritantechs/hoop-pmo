import { fetchAll } from './supabase.js';

/* =========================================================================================
   THE STOCK INDEX MEMO -- the aux reads behind OLD STOCK and the aging gate, shared instead
   of rebuilt from scratch at every one of the nine places that ask for them.
   =========================================================================================
     "oldStockIndex / stockAgingIndex: an 8-trip, six-table read rebuilt from scratch at nine
      call sites (oldStock, oldStockHolder, oldStockRound, transferStock, stockRequest,
      stockMine, stockQueue, stockDecide, stockReqReport); one 'submit a stock request' click
      builds it twice."

   devices (who is locked), watu_loans, hoop_agents, hoop_sales and stock_audit (oldStockIndex's
   six-table "is it still outstanding" question), plus hoop_aged_stock and the aging-days/
   low-alert policy (stockAgingIndex's own two reads) do not change in the few seconds it
   takes somebody to open OLD STOCK, drill into a holder, and submit a request against it --
   they change when somebody enrols a phone, deletes one, or an upload lands. So each is read
   at most once per database client per TTL window and handed to every caller that asks,
   rather than rebuilt per call.

   NEITHER INDEX SCOPES BY TEAM, so there is no fence to fold into a cache key: one entry per
   db is the whole of it.

   old_stock ITSELF IS NEVER IN HERE. oldStock()'s location-stamp logic reads old_stock.location
   back off the rows this memo's caller already read and decides, per row, whether to write a
   place down for the first time -- caching that read would mean stamping against a copy of
   the one table this whole mechanism exists to keep truthful, a few seconds stale. old_stock
   stays a fresh, one-trip read inside oldStockIndex() itself, exactly as before.

   A WeakMap keyed on the db CLIENT, so a client that is garbage-collected (every test's own
   fakeDb, a serverless instance that recycles) takes its memo with it: nothing here needs to
   outlive the thing that built it. */
const TTL_MS = 25000;   // 20-30s: long enough to share one open + drill-down + submit,
                         // short enough that a real change is visible well inside a minute.
const stores = new WeakMap();   // db -> Map<key, { at, value }>

function slotFor(db) {
  let m = stores.get(db);
  if (!m) { m = new Map(); stores.set(db, m); }
  return m;
}

/** Runs `loader` at most once per TTL per db per key. `fresh` skips the cached answer (and
    re-primes the slot with whatever it finds, so the very next ordinary caller is warmed by
    it rather than paying for the same read again a moment later). Returns `{ value, hit }`
    so a caller that only pays for its OWN work on a miss (newStock's stamp write and staff
    sync, see there) can tell which one happened. */
async function memoised(db, key, ttlMs, fresh, loader) {
  const slot = slotFor(db);
  if (!fresh) {
    const hit = slot.get(key);
    if (hit && (Date.now() - hit.at) < ttlMs) return { value: hit.value, hit: true };
  }
  const value = await loader();
  slot.set(key, { at: Date.now(), value });
  return { value, hit: false };
}

/** A generic per-db memo for anything else in the stock cluster that wants the exact same
    shape (newStock's joined-rows cache; a future syncAging one) without inventing a second
    WeakMap -- and so that busting one busts them all together, see clearStockIndex(). */
export async function memoStock(db, key, ttlMs, opts, loader) {
  return memoised(db, key, ttlMs, !!(opts && opts.fresh), loader);
}

/** Every busy write that can change one of the memoised tables calls this. Deleting the
    WHOLE per-db slot rather than one key is deliberate: it costs nothing (the next read for
    any of them simply misses once) and it means a table added to this memo later is covered
    by every existing caller of clearStockIndex without anybody having to remember to list it
    twice.
    Busters: deviceEnrol (inserts devices), deviceDelete (removes devices), and
    api/upload.js after its hoop_agents / hoop_aged_stock / hoop_sales / watu_loans imports
    (upload.js imports this module directly -- never portal.js, which would pull the whole
    portal handler table into the upload request). Deliberately NOT busted by deviceSetState,
    deviceShift, stockIssue, stockHandover, syncAging, oldStockHolder or oldStockRound: none
    of them insert or delete a row in a memoised table, only change a column on one that was
    already there (holder, state) or read without writing at all. */
export function clearStockIndex(db) {
  stores.delete(db);
}

const feed = async (db, table, cols) => {
  try { return await fetchAll(() => db.from(table).select(cols)); } catch (ignored) { return []; }
};

/** oldStockIndex's own six-table aux read (everything except old_stock itself): who is
    locked, who the decks say has sold, and where each name is stationed. `opts.fresh`
    bypasses the cache (stockDecide's live aging-gate recompute, via stockAgingIndex).
    `opts.agents`, on a MISS, is used in place of this function's own hoop_agents fetch --
    the caller (oldStock/newStock) already read it this request with the wider column set
    every stock fn needs (FIX 2), and a warm memo must not throw that read away and take a
    second one just because it happens to also be the one building the aux bundle. */
export async function getOldStockAux(db, opts) {
  const { value } = await memoised(db, 'oldStockAux', TTL_MS, !!(opts && opts.fresh), async () => {
    const locked = new Set();
    try {
      for (const d of await fetchAll(() => db.from('devices').select('imei'))) locked.add(String(d.imei));
    } catch (ignored) { /* nothing enrolled yet */ }
    /* Widened to carry the agent and the branch, and narrowed again on a database that
       predates the offline-queue migration -- see oldStockIndex's own header. */
    let loans = await feed(db, 'watu_loans', 'imei, agent, branch');
    if (!loans.length) loans = await feed(db, 'watu_loans', 'imei');
    const agents = (opts && opts.agents) || await feed(db, 'hoop_agents', 'name, branch');
    const sales = await feed(db, 'hoop_sales', 'imei');
    const audit = await feed(db, 'stock_audit', 'imei, sale_date, customer, price');
    return { locked, loans, agents, sales, audit };
  });
  return value;
}

/** stockAgingIndex's own two reads on top of oldStockIndex's: the uploaded aged-stock file
    and the aging-days/low-alert policy. `policyOf` is passed in rather than imported, so this
    module never has to import stockPolicy back out of portal.js (which defines it) and the
    two files stay a one-way dependency: upload.js and portal.js both import FROM here, this
    file imports from neither. */
export async function getAgingAux(db, opts, policyOf) {
  const { value } = await memoised(db, 'agingAux', TTL_MS, !!(opts && opts.fresh), async () => {
    const aged = await feed(db, 'hoop_aged_stock', 'serial, agent, item, age_days, as_of');
    const policy = await policyOf(db);
    return { aged, policy };
  });
  return value;
}
