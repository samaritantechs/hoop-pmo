/* =======================================================================================
   A KEYED MEMO, GOOD FOR AS LONG AS THE DATA HASN'T MOVED.

   The postgres-war audit found several panes re-scanning a whole table on every open to
   answer a question that only changes when new data lands: the roles and models behind the
   commission dropdowns, the branch list off the loan book, the role -> names index behind
   the issues desk. None of those change from one click to the next, so re-reading the table
   they are built from on every click is a company-sized read for a one-person question.

   DATA_VERSION IS THE SIGNAL an upload already gives for free (api/upload.js bumps it, in
   the settings table, on the last slice of every upload). A cache keyed on it goes stale
   the moment new data lands and never before -- exactly like call-core.js's own agentIndex,
   which this copies the shape of.

   ITS OWN SETTING READ, DELIBERATELY NOT call-core's. This module is reached from
   api/portal.js; call-core.js's settingGet is private to call-core.js and owned by a
   different batch of this same audit, so importing it here would be one file reaching into
   another's internals for a three-line query -- exactly the kind of coupling that turns an
   unrelated change into a merge conflict. The read itself is one line; duplicating it costs
   nothing and keeps the two files free to change independently. */
export async function settingRead(db, key) {
  const { data } = await db.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}

/** A per-database memo, refreshed when DATA_VERSION moves OR when `ttlMs` has passed,
    whichever comes first -- the TTL alone covers a change that never touches DATA_VERSION
    (an access code added by hand, say), and the version check alone would otherwise let a
    cache ride for the life of the process.

    Returns a function `memo(db, build)` that runs `build()` at most once per (db, version)
    per window; every other caller inside it gets the same answer without paying for it
    again. Keyed on `db` with a WeakMap, so nothing here outlives the client it was built
    for -- a fake db in a test, or a serverless instance's db handle once it is recycled,
    is simply forgotten rather than pinned.

    Budget: 1 round trip (the keyed DATA_VERSION read) on every call, warm or cold; `build`'s
    own cost is paid only on a miss -- and on a cold cache, once per db however many callers
    arrive together: the build in flight is shared, the same way agentIndex's is, so two panes
    opening at the same moment do not each scan the table. */
export function memoByDataVersion(ttlMs) {
  const cache = new WeakMap();
  const inFlight = new WeakMap();
  return async function memo(db, build, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const version = (await settingRead(db, 'DATA_VERSION')) || '';
    const hit = cache.get(db);
    if (hit && hit.version === version && (now - hit.at) < ttlMs) return hit.value;
    let p = inFlight.get(db);
    if (!p) {
      p = Promise.resolve().then(build).then(value => { cache.set(db, { version, at: now, value }); return value; })
        .finally(() => { if (inFlight.get(db) === p) inFlight.delete(db); });
      inFlight.set(db, p);
    }
    return p;
  };
}
