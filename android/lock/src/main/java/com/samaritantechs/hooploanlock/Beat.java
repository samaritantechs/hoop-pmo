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
            if (r == null || !r.optBoolean("ok", false)) return;

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

        if (r.optBoolean("retire", false)) {
            // The loan cleared. Give the phone back completely and stop calling home.
            Prefs.put(c, Prefs.RETIRED, true);
            Guard.unlock(c);
            LockAdmin.unharden(c);
            BeatJob.cancel(c);
            return;
        }
        if ("lock".equals(command)) Guard.lock(c);
        else Guard.unlock(c);
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

    private static JSONObject post(String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "application/json");
        c.setConnectTimeout(12000);
        c.setReadTimeout(12000);
        c.setDoOutput(true);
        try {
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes("UTF-8"));
            os.close();
            // 403 means this token is not on the register. Deliberately NOT treated as
            // permission to unlock: a phone that has been un-enrolled by somebody tampering
            // with the database is the last one that should let itself go.
            if (c.getResponseCode() != 200) return null;
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
