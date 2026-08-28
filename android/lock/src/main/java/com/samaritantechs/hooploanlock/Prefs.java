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
    static final String LOCKED = "locked";          // what we were TOLD to do, and intend to do
    /* WHETHER THE LOCK SCREEN IS ACTUALLY ON THE GLASS, maintained by LockActivity itself
       rather than inferred from the intention above. They come apart -- an activity the
       system killed, a startActivity that did nothing, a release the screen never heard --
       and when they do, this is the one the customer is looking at. See Beat: it is this
       that gets reported, because a register confidently saying "unlocked" about a phone
       showing a lock screen is worse than one that says nothing. */
    static final String SCREEN_UP = "screenUp";
    static final String MESSAGE = "message";        // the lock screen's words, refreshed each beat
    static final String HELP_PHONE = "helpPhone";
    static final String REASON = "reason";
    static final String BRAND = "brand";            // company name atop the lock screen; from settings
    /* The IMEI as the REGISTER holds it, which is a different fact from the one Imei.java
       reads off the modem: this is the number on Sipho's report, the one a caller reads out
       down the phone, and on a phone where provisioning half-failed it is the only one this
       app can put on the screen at all. Stored, because a locked handset in a dead spot has
       to show it without asking anybody. */
    static final String IMEI = "imei";
    static final String LAST_OK = "lastOkBeat";     // ms; the anchor the offline grace counts from
    static final String GRACE_HOURS = "graceHours"; // -1 = never self-lock (still stock)
    /* How many seconds the SERVER wants until the next beat. Short only while an order is
       outstanding; a quarter of an hour otherwise. Kept here so the pace survives a reboot
       and so the office can change it for a whole fleet without shipping an APK. */
    static final String NEXT_BEAT = "nextBeatSeconds";
    static final String RETIRED = "retired";        // released for good; stop beating
    /* When the register first said "I do not know this token". Cleared by any successful
       beat; after long enough the handset releases itself rather than staying a brick with
       no office able to reach it. See noteNotEnrolled in Beat.java. */
    static final String GONE_SINCE = "goneSince";

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
