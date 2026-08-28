package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.wifi.WifiManager;
import android.os.Build;

/**
 * KEEPING THE PHONE REACHABLE, which turned out to be the whole ballgame.
 *
 *   "wifi is off, let me connect it"
 *   "the reset took it off"
 *
 * A handset was locked, the office ordered Fungua, and nothing happened for thirty-five
 * minutes. Every layer looked healthy -- the job was scheduled, the app was armed, the enrol
 * answered "reporting in now" -- and none of it mattered, because the phone had no network.
 *
 * WHY THAT IS WORSE THAN IT SOUNDS, and why this class exists rather than a line in the docs:
 *
 *   A LOCKED PHONE IS PINNED. No home, no recents, no notification shade, no Settings. So the
 *   person holding it CANNOT rejoin a network even if they want to. A customer who has paid
 *   in full is then holding a handset that nobody can unlock: not them, not the office, not
 *   over the air. The only way back is a cable, and they are in Mwanza.
 *
 *   AND IT IS THE OBVIOUS WAY OUT. A customer who works out that turning Wi-Fi off means the
 *   lock never arrives has defeated the entire product with one toggle.
 *
 *   THE DEADLOCK MADE IT PERMANENT. BeatJob required a network to run, so a phone with no
 *   network never woke at all -- and an app that never wakes can never notice it is offline
 *   or do anything about it. Being offline was self-sustaining. That constraint is gone: the
 *   beat now wakes regardless and calls this first.
 *
 * WHAT A DEVICE OWNER MAY ACTUALLY DO. setWifiEnabled has been refused for ordinary apps
 * since Android 10, and Device Owner is explicitly exempt -- one of the few places where
 * being Device Owner buys something the manifest cannot. It is still best effort: a vendor
 * build may refuse, and turning the radio on does nothing at all if no known network is in
 * range, which is the honest limit of this. On a phone that has left the office for good, the
 * answer is a SIM with data, not this class.
 */
class Net {

    /** Is there a usable network right now? Conservative: unsure reads as yes, so we try. */
    static boolean online(Context c) {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                NetworkCapabilities n = cm.getNetworkCapabilities(cm.getActiveNetwork());
                return n != null && n.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            NetworkInfo i = cm.getActiveNetworkInfo();
            return i != null && i.isConnected();
        } catch (Exception e) {
            return true;   // never let a probe failure stop a beat being attempted
        }
    }

    /**
     * Give an offline handset its radio back. Called before every beat, so a phone that goes
     * dark heals itself at the next wake rather than waiting for somebody with a cable.
     *
     * Does nothing when already online, and nothing on a phone we do not own -- switching a
     * stranger's Wi-Fi on is not ours to do, and off a Device Owner the call is refused
     * anyway.
     */
    static void ensureOnline(Context c) {
        if (online(c)) return;
        if (!LockAdmin.isOwner(c)) return;
        try {
            WifiManager w = (WifiManager)
                    c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (w != null && !w.isWifiEnabled()) w.setWifiEnabled(true);
        } catch (Exception ignored) {
            // Best effort, always. A phone that keeps what it has is fine; a crash is not.
        }
    }
}
