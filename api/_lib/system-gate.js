/** IS THE SYSTEM OPEN TO EVERYBODY YET?

    HOPE Calls and the system portal are two different products sharing one deployment. Calls
    is what a field officer needs every day; the portal is the whole book -- dashboards, PAR,
    presentations, uploads. There are moments when the second one should not be reachable at
    all: while it is being repaired, while figures are being re-uploaded, or simply because the
    company is not ready for two hundred people to open it on the same morning.

    So it is a switch, and the ADMIN holds it. Closed, everyone gets Calls and nothing else --
    no portal, no HOPE Live, and no sign of either on their screen. Open, everything is as it
    was.

    THE DEFAULT IS CLOSED. A deployment that has never had the switch set is a deployment
    nobody has decided about, and the safe reading of "nobody has decided" is "not yet".

    An ADMIN IS NEVER GATED, and is checked BEFORE the setting is read. Otherwise the one
    person who can open the door would be locked out by the same failure that closed it --
    which is how a settings table having a bad minute turns into nobody being able to fix
    anything. */

const KEY = 'SYSTEM_OPEN';

/* Read once, then trusted for half a minute. This is checked on EVERY portal request, and
   paying a round trip on each one to re-read a single row that changes twice a year is the
   sort of tax that put the dashboard at 567 requests. Half a minute is the longest anybody
   waits after the switch is flipped -- and settingSet clears it outright, so the admin who
   flipped it sees the effect immediately rather than wondering whether it took. */
const TTL_MS = 30000;
/* Kept against the DATABASE CLIENT, not in one module-level variable. In production there is a
   single long-lived client, so this behaves exactly as one variable would. In a test there is a
   fresh fake per case -- and a shared variable would have handed one test's answer to the next,
   which is how a suite passes while the door is standing open. */
const cache = new WeakMap();                 // db -> { at, open }

export function clearSystemOpenCache(db) { if (db) cache.delete(db); }

/** True only for a value that plainly says yes. Anything else -- unset, blank, 'NO', junk
    somebody typed -- reads as closed, because a switch nobody set is a switch nobody meant
    to turn on. */
export function readsAsOpen(value) {
  const v = String(value == null ? '' : value).trim().toUpperCase();
  return v === 'YES' || v === 'ON' || v === 'TRUE' || v === '1' || v === 'OPEN';
}

export async function isSystemOpen(db, nowMs = Date.now()) {
  const hit = cache.get(db);
  if (hit && hit.at <= nowMs && (nowMs - hit.at) < TTL_MS) return hit.open;
  let open = false;
  try {
    const { data } = await db.from('settings').select('value').eq('key', KEY).maybeSingle();
    open = readsAsOpen(data && data.value);
  } catch (e) {
    /* A settings table that will not answer must not silently throw the doors open. Closed is
       the safe answer, and the admin path above never reaches this line. */
    open = false;
  }
  cache.set(db, { at: nowMs, open });
  return open;
}

/** The one rule for "is this person an administrator", read the same way requireAdmin reads
    it inside the portal -- the resolved tab list, which an ADMIN role always contains. */
export function isAdminUser(user) {
  return !!(user && user.tabs && user.tabs.includes('settings'));
}

export class SystemClosedError extends Error {
  constructor() {
    super('Mfumo umefungwa kwa sasa — tumia HOPE Calls. '
        + '/ The system is closed for now — please use HOPE Calls.');
    this.name = 'SystemClosedError';
    this.status = 403;
    this.systemClosed = true;               // so a front end can tell this from a bad code
  }
}

/** Throws unless the system is open to everybody, or this person is an admin. */
export async function requireSystemOpen(db, user, nowMs = Date.now()) {
  if (isAdminUser(user)) return true;
  if (await isSystemOpen(db, nowMs)) return true;
  throw new SystemClosedError();
}
