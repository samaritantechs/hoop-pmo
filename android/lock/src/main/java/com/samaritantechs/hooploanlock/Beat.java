package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.os.BatteryManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * One call to /api/device: what this handset is, and what the office says it should be.
 *
 * The command is always recomputed by the server from the registry, never queued, so a phone
 * that has been off for a fortnight gets the CURRENT answer the moment it comes back rather
 * than a backlog replayed at it. That is also why this is safe to run often and safe to miss.
 */
class Beat {

    /** Runs on a background thread; safe to call from anywhere. */
    static void now(final Context c, final boolean hello) {
        new Thread(() -> run(c.getApplicationContext(), hello)).start();
    }

    static void run(Context c, boolean hello) {
        if (Prefs.of(c).getBoolean(Prefs.RETIRED, false)) return;   // released; nothing left to say
        String token = Prefs.str(c, Prefs.TOKEN, "");
        if (token == null || token.isEmpty()) return;               // never provisioned

        try {
            JSONObject payload = new JSONObject();
            payload.put("token", token);
            if (!hello) {
                payload.put("locked", Prefs.of(c).getBoolean(Prefs.LOCKED, false));
                payload.put("battery", battery(c));
                payload.put("android", Build.VERSION.RELEASE);
                payload.put("appVersion", BuildConfig.VERSION_NAME);
                String imei = Imei.read(c);
                if (imei != null) payload.put("imei", imei);
            }
            JSONObject body = new JSONObject();
            body.put("fn", hello ? "dev_hello" : "dev_beat");
            body.put("args", new org.json.JSONArray().put(payload));

            JSONObject r = post(Prefs.server(c) + "/api/device", body.toString());
            if (r == null || !r.optBoolean("ok", false)) {
                if (lastStatus == 403) noteNotEnrolled(c);
                return;
            }
            // Any answer at all means the register still knows us; forget the 403 clock.
            Prefs.of(c).edit().remove(Prefs.GONE_SINCE).apply();

            apply(c, r);
        } catch (Exception ignored) {
            /* A failed beat is not an event. The phone keeps doing whatever it was already
               doing, and the offline grace below is what eventually decides otherwise. */
        }
    }

    /**
     * What to do with the answer. The order matters: retire before lock, because a released
     * phone must never be caught by the grace rule on its way out.
     */
    private static void apply(Context c, JSONObject r) {
        String command = r.optString("command", "");
        Prefs.put(c, Prefs.LAST_OK, System.currentTimeMillis());
        Prefs.put(c, Prefs.GRACE_HOURS, String.valueOf(r.optInt("graceHours", -1)));
        String msg = r.optString("message", "");
        if (msg != null && !msg.isEmpty()) Prefs.put(c, Prefs.MESSAGE, msg);
        String help = r.optString("helpPhone", "");
        Prefs.put(c, Prefs.HELP_PHONE, help == null ? "" : help);
        String reason = r.optString("reason", "");
        Prefs.put(c, Prefs.REASON, reason == null ? "" : reason);
        /* Brand and IMEI are kept only when the server actually sends them, and never
           overwritten with blank. An older deployment that does not know these fields yet
           must not wipe the company name and the IMEI off a lock screen that already had
           them -- an empty header is exactly the screen nobody can act on. */
        String brand = r.optString("brand", "");
        if (brand != null && !brand.isEmpty()) Prefs.put(c, Prefs.BRAND, brand);
        String imei = r.optString("imei", "");
        if (imei != null && !imei.isEmpty()) Prefs.put(c, Prefs.IMEI, imei);

        if (r.optBoolean("retire", false)) {
            /* A RELEASED PHONE NEVER SELF-LOCKS AGAIN, and this line is load-bearing now that
               a refused step-down leaves the handset beating instead of retiring. The server
               goes on sending a real graceHours for any phone that was ever sold -- it
               describes the row, not this moment -- and enforceGrace would take that at its
               word. A former customer's phone that spent a week out of coverage would then
               lock itself for a loan the office had already closed. Written before the retire
               attempt, so it holds whether or not the step-down takes. */
            Prefs.put(c, Prefs.GRACE_HOURS, "-1");
            /* The loan cleared. Give the phone back -- but only go SILENT once it is actually
               back. Unlock the screen and try to step down; retire and stop beating only if
               that truly took. A phone the system refused to release must keep calling home,
               or it becomes what the first A07 became: owned, silent, unreachable. While it
               keeps beating the office still sees it, the next beat retries the release, and
               an office that changes its mind can still reach it. */
            Guard.unlock(c);
            if (LockAdmin.unharden(c)) {
                Prefs.put(c, Prefs.RETIRED, true);
                BeatJob.cancel(c);
            }
            return;
        }
        if ("lock".equals(command)) Guard.lock(c);
        else Guard.unlock(c);
    }

    /* A PHONE WHOSE ROW IS GONE MUST NOT BE A BRICK FOREVER.
     * =========================================================================
     *   "if it doesn't find it's tocken it's should release fromm organization
     *    ownership"
     *
     * He is right, and the old rule was wrong. A 403 means the register does not
     * know this token: nobody can lock it, unlock it or release it, because every
     * one of those travels through a row that no longer exists. Refusing to act on
     * that left the handset hardened for good, needing a factory reset it also
     * refuses to perform. That is not a security posture, it is a brick.
     *
     * BUT NOT ON THE FIRST ONE, and that is the whole design. A bad deploy, a
     * migration mid-flight, a bug in one endpoint -- any of those could 403 the
     * entire fleet for an hour, and an instant rule would hand every phone HOOP
     * owns back to whoever is holding it. So the release needs the 403 to be the
     * settled state of the world rather than a moment in it: fourteen days of
     * continuous refusal, cleared by any successful beat.
     *
     * WHY A HOSTILE NETWORK CANNOT FORGE THIS. A 403 only counts when it arrives
     * over a valid TLS connection to the configured host -- anything else fails
     * the handshake and lands in the offline path below, which never releases
     * anything. Somebody who can genuinely serve our origin already owns the
     * server, and can simply mark the phone released.
     *
     * The first 403's timestamp is stored rather than a counter: a phone that is
     * off for a fortnight has not served fourteen days of anything, and should
     * not come back free.
     */
    private static final long RETIRE_AFTER_GONE_MS = 14L * 24 * 60 * 60 * 1000;

    private static void noteNotEnrolled(Context c) {
        long first = Prefs.of(c).getLong(Prefs.GONE_SINCE, 0);
        if (first == 0) {
            Prefs.put(c, Prefs.GONE_SINCE, System.currentTimeMillis());
            return;
        }
        if (System.currentTimeMillis() - first < RETIRE_AFTER_GONE_MS) return;
        // Fourteen days of the office not knowing us. Hand the phone back, exactly as a
        // release does -- unlock, drop the restrictions, step down as Device Owner. Only go
        // silent if the step-down actually took; a phone still owned keeps beating rather than
        // becoming a brick nobody can reach. The retry is harmless -- it runs at most once a
        // beat and self-heals the moment the system stops refusing.
        // And never self-lock again, for the same reason as the retire path above: a handset
        // still beating because the step-down was refused must not be caught by the grace it
        // was carrying before the office lost it.
        Prefs.put(c, Prefs.GRACE_HOURS, "-1");
        Guard.unlock(c);
        if (LockAdmin.unharden(c)) {
            Prefs.put(c, Prefs.RETIRED, true);
            BeatJob.cancel(c);
        }
    }

    /**
     * THE OFFLINE QUESTION, which is the hardest honest call in this whole app.
     *
     * A phone that cannot reach us cannot be told to lock. If we do nothing, "stay in
     * airplane mode" defeats the entire system -- which is precisely what somebody who has
     * decided not to pay will do. If we lock on every missed beat, we strand a paying
     * customer in Kigoma with one bar for an afternoon.
     *
     * So: the server sets the grace, per phone, and it is generous. `graceHours` of -1 means
     * never self-lock, which is what stock sitting in a box at the station gets -- boxed
     * phones are offline for weeks by design and must not lock themselves. A phone that has
     * gone out to a customer gets a real number (a week by default), counted from the last
     * beat that actually succeeded.
     *
     * A self-lock is not a decision this phone made about the customer. It is the phone
     * saying "I have not heard from the office in far too long" -- and the moment it reaches
     * us again, the office's actual answer wins, including unlocking it straight back.
     */
    static void enforceGrace(Context c) {
        if (Prefs.of(c).getBoolean(Prefs.RETIRED, false)) return;
        int graceHours;
        try { graceHours = Integer.parseInt(Prefs.str(c, Prefs.GRACE_HOURS, "-1")); }
        catch (Exception e) { graceHours = -1; }
        if (graceHours <= 0) return;                       // still stock, or told never to
        long last = Prefs.of(c).getLong(Prefs.LAST_OK, 0);
        if (last == 0) return;                             // never once heard from us: not our call
        long silent = System.currentTimeMillis() - last;
        if (silent > graceHours * 3600000L) Guard.lock(c);
    }

    private static int battery(Context c) {
        try {
            BatteryManager bm = (BatteryManager) c.getSystemService(Context.BATTERY_SERVICE);
            if (bm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            }
        } catch (Exception ignored) { }
        return -1;
    }

    /* The last HTTP status post() saw, so run() can tell "the office says you are not on the
       register" apart from "the office did not answer". Every other failure is silence. */
    private static int lastStatus = 0;

    private static JSONObject post(String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "application/json");
        c.setConnectTimeout(12000);
        c.setReadTimeout(12000);
        c.setDoOutput(true);
        lastStatus = 0;
        try {
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes("UTF-8"));
            os.close();
            lastStatus = c.getResponseCode();
            // 403 = this token is not on the register. Never an instant release -- see
            // noteNotEnrolled(), which is where that decision now lives.
            if (lastStatus != 200) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            return new JSONObject(sb.toString());
        } finally {
            c.disconnect();
        }
    }
}
