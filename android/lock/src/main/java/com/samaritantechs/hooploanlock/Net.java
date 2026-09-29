package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.os.Build;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

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
        wifiOn(c);
    }

    /**
     * Turn the Wi-Fi radio on, and say whether it is (or is coming) on. The one thing the
     * locked screen's Wi-Fi button can do by itself: a Device Owner may switch the radio on
     * where an ordinary app has been refused since Android 10, and a radio that is on rejoins
     * any network the phone already knows without anybody typing a password. Picking a NEW
     * network is the system panel's job -- see LockActivity.radios().
     *
     * Best effort, always: a vendor build that refuses answers false and nothing else changes.
     */
    static boolean wifiOn(Context c) {
        if (!LockAdmin.isOwner(c)) return false;
        try {
            WifiManager w = (WifiManager)
                    c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (w == null) return false;
            if (!w.isWifiEnabled()) w.setWifiEnabled(true);
            int st = w.getWifiState();
            return st == WifiManager.WIFI_STATE_ENABLED || st == WifiManager.WIFI_STATE_ENABLING;
        } catch (Exception ignored) {
            // A phone that keeps what it has is fine; a crash is not.
            return false;
        }
    }

    /* THE NETWORK LIST, AND JOINING ONE, DONE HERE RATHER THAN IN SETTINGS.
       -----------------------------------------------------------------------------------
       The first cut sent the customer to the system's own Wi-Fi panel. On the phones this
       fleet is made of, that panel answers "Unlock to view networks" -- Samsung hides the list
       while the device counts as locked, and with a second lock (Knox Guard) on the handset it
       always counts as locked. No allowlist or restriction of ours changes that.

       A Device Owner does not need the panel. addNetwork / enableNetwork were closed to ordinary
       apps in Android 10 and left open to device and profile owners, exactly for kiosks: the
       locked screen can draw the list itself and join a network by name and password. The list
       (getScanResults) needs the location permission harden() grants and location switched on;
       when either is missing the list is simply empty and the name is typed instead -- the
       customer knows the name of their own Wi-Fi. */

    /** What is in range: one row per name, strongest first, at most `max`. Empty when the
        system will not say. */
    static List<ScanResult> scan(Context c, int max) {
        List<ScanResult> out = new ArrayList<>();
        try {
            WifiManager w = (WifiManager)
                    c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (w == null) return out;
            try { w.startScan(); } catch (Exception ignored) { }     // a fresh look, if the system allows one now
            List<ScanResult> rs = w.getScanResults();
            if (rs == null) return out;
            Map<String, ScanResult> best = new HashMap<>();
            for (ScanResult r : rs) {
                if (r == null || r.SSID == null || r.SSID.trim().isEmpty()) continue;
                ScanResult had = best.get(r.SSID);
                if (had == null || r.level > had.level) best.put(r.SSID, r);
            }
            out.addAll(best.values());
            java.util.Collections.sort(out, (a, b) -> b.level - a.level);
            if (out.size() > max) out = new ArrayList<>(out.subList(0, max));
        } catch (Exception ignored) {
            // No permission, location off, a build that refuses: no list, and the typed name still works.
        }
        return out;
    }

    /** Needs a password. */
    static boolean secured(ScanResult r) {
        String cap = (r == null || r.capabilities == null) ? "" : r.capabilities;
        return cap.contains("WPA") || cap.contains("WEP") || cap.contains("SAE")
            || cap.contains("PSK") || cap.contains("EAP");
    }

    /** WPA3 only -- no WPA2 fallback advertised -- so the join must say SAE. */
    static boolean saeOnly(ScanResult r) {
        String cap = (r == null || r.capabilities == null) ? "" : r.capabilities;
        return cap.contains("SAE") && !cap.contains("PSK");
    }

    /**
     * Join a network by name and password. True when the system accepted the network and was
     * told to connect to it -- the connection itself lands a moment later and the screen's
     * network callback reports it. A saved network of the same name is replaced first, so a
     * corrected password takes rather than the old one being retried for ever.
     */
    static boolean join(Context c, String ssid, String pass, boolean sae) {
        if (!LockAdmin.isOwner(c)) return false;
        if (ssid == null || ssid.trim().isEmpty()) return false;
        try {
            WifiManager w = (WifiManager)
                    c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (w == null) return false;
            if (!w.isWifiEnabled()) w.setWifiEnabled(true);
            String quoted = "\"" + ssid.trim() + "\"";
            WifiConfiguration cfg = new WifiConfiguration();
            cfg.SSID = quoted;
            if (pass == null || pass.isEmpty()) {
                cfg.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            } else if (sae && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                cfg.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.SAE);
                cfg.preSharedKey = "\"" + pass + "\"";
            } else {
                cfg.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);
                cfg.preSharedKey = "\"" + pass + "\"";
            }
            try {
                List<WifiConfiguration> saved = w.getConfiguredNetworks();
                if (saved != null) for (WifiConfiguration old : saved) {
                    if (old != null && quoted.equals(old.SSID)) w.removeNetwork(old.networkId);
                }
            } catch (Exception ignored) { }
            int id = w.addNetwork(cfg);
            if (id < 0) return false;
            try { w.disconnect(); } catch (Exception ignored) { }
            boolean ok = w.enableNetwork(id, true);
            try { w.reconnect(); } catch (Exception ignored) { }
            return ok;
        } catch (Exception ignored) {
            return false;
        }
    }
}
