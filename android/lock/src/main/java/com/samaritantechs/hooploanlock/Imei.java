package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.os.Build;
import android.telephony.TelephonyManager;

/**
 * The handset's own idea of its IMEI -- reported for information, never used as identity.
 *
 * This is worth being blunt about, because "we lock by IMEI" is how these systems are sold
 * and it gives the wrong picture. An IMEI is a serial number: it identifies a phone, it does
 * not give anybody power over one. Reading it here is a convenience for whoever is looking
 * at the register, not the mechanism -- the mechanism is Device Owner, and the identity is
 * the token that was written into this phone at provisioning.
 *
 * Three reasons it cannot be the identity, all of them ordinary rather than exotic:
 *   - from Android 10 a normal app is refused outright; only a device/profile owner may ask,
 *     so on a phone where provisioning half-failed this returns nothing precisely when we
 *     would most want it
 *   - a dual-SIM phone has TWO, and which one Sipho's report wrote down is a coin toss
 *   - the getter changed shape across the versions this stock spans
 *
 * So it is sent when it can be read, omitted when it cannot, and the server files it beside
 * its own key without ever acting on a difference. See device-core.js.
 */
class Imei {

    static String read(Context c) {
        try {
            TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return null;
            String v;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v = tm.getImei();                 // device owner is permitted; others are refused
            } else {
                v = tm.getDeviceId();
            }
            return (v == null || v.trim().isEmpty()) ? null : v.trim();
        } catch (Throwable ignored) {
            // SecurityException on 10+ without Device Owner, and anything else a vendor build
            // decides to throw. Not being able to read it is normal, not a failure.
            return null;
        }
    }
}
