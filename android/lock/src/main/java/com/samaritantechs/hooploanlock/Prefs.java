package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * The handful of facts this app has to remember across reboots. Small on purpose: the
 * registry on the server is the record, and anything kept here is either a credential we
 * were handed at provisioning or the last thing the server told us.
 */
class Prefs {
    private static final String FILE = "hooploanlock";

    static final String SERVER = "server";          // where to beat; from the provisioning bundle
    static final String TOKEN = "token";            // this handset's credential -- see device-core.js
    static final String LOCKED = "locked";          // what we are currently DOING, not what we were told
    static final String MESSAGE = "message";        // the lock screen's words, refreshed each beat
    static final String HELP_PHONE = "helpPhone";
    static final String REASON = "reason";
    static final String LAST_OK = "lastOkBeat";     // ms; the anchor the offline grace counts from
    static final String GRACE_HOURS = "graceHours"; // -1 = never self-lock (still stock)
    static final String RETIRED = "retired";        // released for good; stop beating

    static SharedPreferences of(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String str(Context c, String k, String dflt) {
        return of(c).getString(k, dflt);
    }

    static void put(Context c, String k, String v) {
        of(c).edit().putString(k, v).apply();
    }

    static void put(Context c, String k, boolean v) {
        of(c).edit().putBoolean(k, v).apply();
    }

    static void put(Context c, String k, long v) {
        of(c).edit().putLong(k, v).apply();
    }

    /** The base URL to beat against, falling back to the build's default for a hand-installed
        test build that never went through QR provisioning. */
    static String server(Context c) {
        String s = str(c, SERVER, "");
        if (s == null || s.isEmpty()) s = BuildConfig.DEFAULT_SERVER;
        return s.replaceAll("/+$", "");
    }
}
