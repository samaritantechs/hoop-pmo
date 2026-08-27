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

    /* SAY WHY, INSTEAD OF FAILING IN SILENCE.
     *
     * Every guard below used to be a bare `return`, and `am broadcast` prints
     * "Broadcast completed: result=0" either way -- which reads exactly like success. On the
     * first real handset that cost an evening: the operator ran this BEFORE
     * set-device-owner, saw result=0, and had no way to learn the receiver had dropped it on
     * the floor. result=0 only ever meant "delivered", never "accepted".
     *
     * setResultCode and setResultData are what adb prints back, so the answer lands in the
     * same terminal the command was typed into -- no logcat, no guessing.
     */
    private void say(int code, String why) {
        try { setResultCode(code); setResultData(why); } catch (Exception ignored) { }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        if (intent == null) return;

        String existing = Prefs.str(c, Prefs.TOKEN, "");
        if (existing != null && !existing.isEmpty()) {            // already spoken for
            say(2, "ALREADY ENROLLED - this handset already holds a token. "
                 + "Re-enrolling it needs a factory reset.");
            return;
        }
        if (!LockAdmin.isOwner(c)) {                              // not provisioned; not ours
            say(3, "NOT DEVICE OWNER - run this first, then broadcast again: "
                 + "adb shell dpm set-device-owner com.samaritantechs.hooploanlock/.LockAdmin");
            return;
        }

        String token = intent.getStringExtra("token");
        String server = intent.getStringExtra("server");
        if (token == null || token.trim().isEmpty()) {
            say(4, "NO TOKEN - pass -e token <the token from the register>.");
            return;
        }

        if (server != null && !server.trim().isEmpty()) Prefs.put(c, Prefs.SERVER, server.trim());
        Prefs.put(c, Prefs.TOKEN, token.trim());

        LockAdmin.harden(c);
        Beat.now(c, true);          // appear on the register while the bench is still open
        BeatJob.schedule(c);
        say(1, "ENROLLED - reporting in now; look for this phone on the register.");
    }
}
