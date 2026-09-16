package com.samaritantechs.hooploanlock;

import android.app.admin.DevicePolicyManager;
import android.app.admin.FactoryResetProtectionPolicy;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * WHO MAY SET THIS HANDSET UP AGAIN AFTER A WIPE -- Factory Reset Protection, named by the office.
 *
 *   "does our lock persist through OS rebootings of (Flashing ROMs / Fastboot flashing, Odin
 *    (Samsung), SP Flash Tool, Fastboot/ADB commands)"
 *
 * It does not, and no app can: this app lives in the data partition, and a recovery wipe, an
 * Odin flash with CSC or a fastboot -w replaces it. What DOES outlive those is the FRP record in
 * the persistent partition, which they leave alone. A Device Owner may write that record without
 * any Google account signed in on the phone (Android 11+, Google services present): after ANY
 * wipe the setup wizard then demands one of the accounts named here before the phone is usable.
 *
 * WHAT IT DOES NOT BEAT, said plainly: a MediaTek "Format all" erases that partition too, and
 * this is not enforced at all on a phone without Google services or below Android 11. So every
 * outcome is REPORTED on the beat -- set, cleared, unsupported, error -- and the register counts
 * the phones that are actually fenced rather than assuming all of them are.
 *
 * THE ACCOUNTS COME DOWN ON EVERY BEAT, like the lock screen's words, so a handset that was out
 * before the office named them is fenced on its next beat -- no re-enrol, no cable. Applied only
 * when the list CHANGES, because writing the persistent partition every minute would be both
 * pointless and unkind to it. A retiring phone is sent an empty list and clears the policy: a
 * paid-off phone is nobody's to fence, and the customer's own account protects it the ordinary
 * way from then on. The customer can add and use their own Gmail at any time either way -- this
 * decides who can pass SETUP AFTER A WIPE, and nothing else.
 */
class Frp {

    /** Reads the server's `frpAccounts` off a beat or hello answer and applies it if it changed. */
    static void apply(Context c, JSONObject r) {
        if (!r.has("frpAccounts") || r.isNull("frpAccounts")) return;   // older server: keep what we have
        List<String> ids = new ArrayList<>();
        JSONArray a = r.optJSONArray("frpAccounts");
        if (a != null) {
            for (int i = 0; i < a.length(); i++) {
                String id = a.optString(i, "").replaceAll("\\D", "");
                if (!id.isEmpty() && !ids.contains(id)) ids.add(id);
            }
        }
        String want = join(ids);
        String had = Prefs.str(c, Prefs.FRP_IDS, null);
        if (want.equals(had)) return;                                    // unchanged: nothing to write
        String state = set(c, ids);
        // Remember the list only when the write took, so a refused write is retried next beat.
        if (state.startsWith("set") || state.startsWith("cleared")) Prefs.put(c, Prefs.FRP_IDS, want);
        Prefs.put(c, Prefs.FRP_STATE, state);
    }

    /** Clears the policy on release -- part of handing an ordinary phone back. */
    static void clear(Context c) {
        String state = set(c, new ArrayList<String>());
        Prefs.of(c).edit().remove(Prefs.FRP_IDS).putString(Prefs.FRP_STATE, state).apply();
    }

    /** What the last apply made of it, for the beat to report. Empty until anything was asked. */
    static String state(Context c) {
        String s = Prefs.str(c, Prefs.FRP_STATE, "");
        return s == null ? "" : s;
    }

    private static String set(Context c, List<String> ids) {
        if (!LockAdmin.isOwner(c)) return "unsupported:not-owner";
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "unsupported:android<11";
        if (!hasGms(c)) return "unsupported:no-gms";
        try {
            DevicePolicyManager d = LockAdmin.dpm(c);
            FactoryResetProtectionPolicy policy = ids.isEmpty() ? null
                : new FactoryResetProtectionPolicy.Builder()
                    .setFactoryResetProtectionAccounts(ids)
                    .setFactoryResetProtectionEnabled(true)
                    .build();
            d.setFactoryResetProtectionPolicy(LockAdmin.who(c), policy);
            return ids.isEmpty() ? "cleared" : "set:" + ids.size();
        } catch (Exception e) {
            String why = String.valueOf(e.getMessage());
            return "error:" + (why.length() > 60 ? why.substring(0, 60) : why);
        }
    }

    /** The policy is enforced by Google's setup wizard; with no Google services there is nobody
        to enforce it, and reporting "set" would be a fence that is not there. */
    private static boolean hasGms(Context c) {
        try {
            c.getPackageManager().getPackageInfo("com.google.android.gms", 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        } catch (Exception e) {
            return true;   // could not ask: do not refuse on a guess
        }
    }

    private static String join(List<String> ids) {
        StringBuilder sb = new StringBuilder();
        for (String id : ids) { if (sb.length() > 0) sb.append(','); sb.append(id); }
        return sb.toString();
    }
}
