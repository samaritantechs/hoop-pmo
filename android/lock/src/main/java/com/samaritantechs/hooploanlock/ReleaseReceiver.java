package com.samaritantechs.hooploanlock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * THE WAY BACK OUT, over the same cable a phone was provisioned on.
 *
 * A release normally travels through the server: the office presses Achia, the register says
 * "retire", and the next beat unlocks the phone and steps the app down as Device Owner. That
 * needs a phone that can still reach us and still hear the answer. When it cannot -- a handset
 * whose beat was cancelled, whose token no longer matches, whose owner-step-down was refused
 * once and left it silent -- there was no way back at all except a factory reset the phone also
 * refused. That is the state the first A07 reached, and it is why this exists.
 *
 *   adb install -r public/HOOPLOAN-Lock.apk        (update is allowed; uninstall is blocked)
 *   adb shell am broadcast --include-stopped-packages \
 *       -a com.samaritantechs.hooploanlock.RELEASE \
 *       -n com.samaritantechs.hooploanlock/.ReleaseReceiver \
 *       -e token <the token on this handset's register row>
 *
 * --include-stopped-packages IS NOT OPTIONAL. `adb install -r` leaves the app in Android's
 * STOPPED state, and a stopped app receives no broadcast without the flag -- `am` then prints
 * "Broadcast completed: result=0" and nothing here runs, the same success-shaped failure the
 * enrol has hit three times. result=1 RELEASED / result=2 mismatch / result=3 PARTIAL are the
 * answers that mean the receiver actually ran.
 *
 * THE GUARD, and why it is the token. This receiver is exported, so adb can reach it -- which
 * means any app on the handset can reach it too, and an unlocked customer phone that could be
 * freed by a sideloaded app is no lock at all. So it demands this handset's own token, the one
 * on its register row that only the office holds; a random app does not know it and cannot read
 * it out of our private storage. adb at the bench does. (A phone that has been cleared has no
 * stored token to protect and is let through -- there is nothing left on it to steal.)
 *
 * This does NOT weaken the lock in the field. Turning USB debugging on to reach adb needs
 * Developer options, which needs Settings, which a pinned lock screen never lets go of -- so a
 * genuinely locked phone cannot be reached this way at all. It is a bench tool for a handset in
 * our own hands, and it reports the truth clear: whether the system really let go of ownership,
 * or whether something else (Samsung Knox Guard, on organisation-owned Watu stock) still holds
 * it and must be cleared first.
 */
public class ReleaseReceiver extends BroadcastReceiver {

    /* setResultCode / setResultData are what `am broadcast` prints back, so the answer lands in
       the same terminal the command was typed into -- no logcat, no guessing. Wrapped because
       setResult* throws if the broadcast was not sent as ordered, and a thrown recovery tool is
       worse than a quiet one. */
    private void say(int code, String why) {
        try { setResultCode(code); setResultData(why); } catch (Exception ignored) { }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        if (intent == null) return;

        String stored = Prefs.str(c, Prefs.TOKEN, "");
        String given = intent.getStringExtra("token");
        given = given == null ? "" : given.trim();
        if (stored != null && !stored.isEmpty() && !stored.equals(given)) {
            // Never guess, and never half-act on a wrong token: nothing is changed at all.
            say(2, "TOKEN MISMATCH - this handset holds a different token. Pass its own: "
                 + "-e token <the token on its register row>. Nothing was changed.");
            return;
        }

        // Take the screen down first, so a locked handset leaves lock task even if the
        // owner-step-down below is refused.
        Guard.unlock(c);
        boolean freed = LockAdmin.unharden(c);

        // Drop this handset's identity so it can be enrolled again from scratch afterwards --
        // whether or not the system let us give up Device Owner. If ownership was refused, the
        // phone stays owner with no token, which is exactly the state EnrolReceiver will take a
        // fresh token in: relock is possible without a factory reset.
        Prefs.of(c).edit()
                .remove(Prefs.TOKEN)
                .remove(Prefs.RETIRED)
                .remove(Prefs.LOCKED)
                .remove(Prefs.GONE_SINCE)
                .apply();
        BeatJob.cancel(c);

        if (freed) {
            say(1, "RELEASED - no longer Device Owner. Uninstall it now if you like "
                 + "(adb uninstall " + c.getPackageName() + "), or factory reset the phone.");
        } else {
            say(3, "PARTIAL - screen unlocked, restrictions dropped, token cleared, but the "
                 + "system refused to give up Device Owner. Another admin (Samsung Knox Guard, "
                 + "on Watu-sourced stock) may hold this device. You can re-enrol and re-lock "
                 + "the handset as it is; a full hand-back needs that other admin removed first.");
        }
    }
}
