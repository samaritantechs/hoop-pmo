package com.samaritantechs.hooploanlock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The second way a phone can be handed its identity: over adb, at a station with a laptop.
 *
 *   adb shell dpm set-device-owner com.samaritantechs.hooploanlock/.LockAdmin
 *   adb shell am broadcast -a com.samaritantechs.hooploanlock.ENROL \
 *       -n com.samaritantechs.hooploanlock/.EnrolReceiver \
 *       -e server https://hoop-pmo.vercel.app -e token <the token from the register>
 *
 * QR provisioning is the tidier route for hundreds of phones at a time. This one exists
 * because HOOP is already opening every box by hand -- a cable is one more thing on a bench
 * that is already covered in phones, and unlike a QR it gives an error message you can read
 * when something goes wrong.
 *
 * THE GUARD, and why it is the shape it is. An exported receiver that sets the server URL
 * would otherwise let any app on the phone re-point this one at a server of its choosing --
 * which is a complete bypass, since that server could simply answer "unlock". So it accepts
 * a token exactly once: only while none is stored, and only on a phone that is already
 * Device Owner, which is a state only somebody holding the handset can bring about.
 * Re-enrolling a phone therefore means a factory reset, which is the correct amount of
 * friction for changing which office a handset answers to.
 */
public class EnrolReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        if (intent == null) return;

        String existing = Prefs.str(c, Prefs.TOKEN, "");
        if (existing != null && !existing.isEmpty()) return;      // already spoken for
        if (!LockAdmin.isOwner(c)) return;                        // not provisioned; not ours

        String token = intent.getStringExtra("token");
        String server = intent.getStringExtra("server");
        if (token == null || token.trim().isEmpty()) return;

        if (server != null && !server.trim().isEmpty()) Prefs.put(c, Prefs.SERVER, server.trim());
        Prefs.put(c, Prefs.TOKEN, token.trim());

        LockAdmin.harden(c);
        Beat.now(c, true);          // appear on the register while the bench is still open
        BeatJob.schedule(c);
    }
}
