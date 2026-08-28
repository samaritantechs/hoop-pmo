package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;

/**
 * WHERE THE PHONE WAS WHEN IT LAST SPOKE.
 *
 *   "the management gets headache on aged stock [stolen, lost, sold-by-cash etc] am asked if
 *    the app could trap last sync with location coordinates"
 *
 * The accountability report can already name the handsets nobody can account for. What it
 * cannot do is say where any of them is, so every unaccounted IMEI ends in a phone call and
 * somebody's word. A coordinate turns that into a place to go -- and often into evidence that
 * a phone booked as "sold by cash" has not moved from one shop in three weeks.
 *
 * LAST KNOWN, NOT LIVE, AND THAT IS DELIBERATE.
 * -------------------------------------------------------------------------------------------
 * getLastKnownLocation returns whatever fix the system already has, from any app that asked
 * recently. It costs nothing: no GPS wake, no radio, no battery, no delay to the beat. Asking
 * for a fresh fix every minute would drain a customer's phone all day to answer a question
 * that gets asked about one handset in a hundred, once.
 *
 * The price is that the fix can be OLD -- a phone that beat a minute ago may be carrying a
 * position from Tuesday. So the fix's own timestamp travels with it and the register shows
 * that age. A coordinate without its age is not information, it is a wrong address waiting to
 * be driven to.
 *
 * THE PERMISSION IS GRANTED BY US, TO US. Location is a runtime permission and there is
 * nobody at a locked handset to tap Allow. A Device Owner can grant it to itself with
 * setPermissionGrantState, which is done in LockAdmin.harden -- one of the few things being
 * Device Owner buys that a manifest entry cannot. Where that is refused, this returns null
 * for ever and the rest of the app carries on exactly as before: no location is a missing
 * column on a report, never a broken lock.
 */
class Loc {

    /** How stale a fix may be and still be worth sending: a fortnight. */
    private static final long MAX_AGE_MS = 14L * 24 * 3600 * 1000;

    /** A position, or null. Never throws, never blocks, never wakes a radio. */
    static Location last(Context c) {
        try {
            if (!granted(c)) return null;
            LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return null;
            Location best = null;
            /* Every provider the phone has, newest fix wins. GPS is the most accurate when it
               is there; NETWORK is usually the one that actually exists on a handset sitting
               indoors in a shop, which is precisely the stock this feature is for; PASSIVE
               catches a fix some other app obtained without us asking for anything. */
            for (String p : new String[]{
                    LocationManager.GPS_PROVIDER,
                    LocationManager.NETWORK_PROVIDER,
                    LocationManager.PASSIVE_PROVIDER }) {
                Location l = null;
                try { l = lm.getLastKnownLocation(p); } catch (Exception ignored) { }
                if (l == null) continue;
                if (best == null || l.getTime() > best.getTime()) best = l;
            }
            if (best == null) return null;
            // A fix older than a fortnight says more about when the phone was last outdoors
            // than about where it is, and putting it on a map invites somebody to drive there.
            if (System.currentTimeMillis() - best.getTime() > MAX_AGE_MS) return null;
            return best;
        } catch (Exception e) {
            return null;      // a position is a nice-to-have; a beat is not
        }
    }

    private static boolean granted(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            return c.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED
                || c.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }
}
