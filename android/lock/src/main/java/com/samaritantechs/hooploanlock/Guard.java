package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.content.Intent;

/**
 * Lock and unlock, in one place, so every caller -- a beat, a boot, the grace rule -- goes
 * through the same door and the remembered state can never disagree with what is on screen.
 *
 * `Prefs.LOCKED` is what this phone is DOING, which is not the same as what it was told. The
 * server keeps the office's intent; this keeps the handset's reality, and the next beat
 * reports it. Those two being separate facts is the whole reason the register can tell an
 * ordered lock from a confirmed one.
 */
class Guard {

    static void lock(Context c) {
        Prefs.put(c, Prefs.LOCKED, true);
        show(c);
    }

    /** Sent to the lock screen while it is running. See unlock(). */
    static final String ACTION_RELEASE = "com.samaritantechs.hooploanlock.RELEASE_SCREEN";

    /* TAKING THE SCREEN DOWN HAS TO BE RETRIED, AND CANNOT DEPEND ON STARTING AN ACTIVITY.
       =========================================================================================
         "351388334583295 — — tayari  unlocked  0h"
         "but the phone is locked and banner on"

       The register said the phone was fine. The customer was looking at a lock screen.

       The old code set LOCKED=false and then, only if the OLD value was true, tried to bring
       the screen down. So one failed attempt stranded it for good: every later beat saw `was`
       already false and did nothing at all. A single missed intent, and that handset shows a
       lock screen until somebody drives to it -- while the office reads "unlocked" and has no
       reason to look.

       Two things are wrong with that and both are fixed here.

       IT MUST RETRY. The condition is now "is the screen up", answered by the activity itself,
       so every beat keeps trying until the glass agrees. Self-healing beats correct-once.

       AND IT MUST NOT NEED startActivity. Bringing a screen UP needs one; taking it down does
       not, and on Android 10+ an app in the background can have an activity start refused with
       no error worth the name. A broadcast reaches a RUNNING activity's own receiver with no
       such restriction, so that is the primary route. The activity start stays as a fallback
       for the case where the activity is gone but the flag was left standing. */
    static void unlock(Context c) {
        boolean was = Prefs.of(c).getBoolean(Prefs.LOCKED, false);
        boolean up = Prefs.of(c).getBoolean(Prefs.SCREEN_UP, false);
        Prefs.put(c, Prefs.LOCKED, false);
        if (!was && !up) return;                 // nothing to stand down

        // The route that works on a live screen: its own receiver, no activity start involved.
        try { c.sendBroadcast(new Intent(ACTION_RELEASE).setPackage(c.getPackageName())); }
        catch (Exception ignored) { }

        /* And the fallback, for a screen that is believed up but whose activity is gone. Only
           when the flag still says so after the broadcast -- launching an activity purely to
           finish it flashes a blue screen at somebody for no reason. */
        if (Prefs.of(c).getBoolean(Prefs.SCREEN_UP, false)) {
            Intent i = new Intent(c, LockActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            i.putExtra(LockActivity.EXTRA_RELEASE, true);
            try { c.startActivity(i); } catch (Exception ignored) { }
        }
    }

    /** Bring the lock screen up. Safe to call when it is already showing. */
    static void show(Context c) {
        Intent i = new Intent(c, LockActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try { c.startActivity(i); } catch (Exception ignored) { }
    }

    /** Called on boot and after our own package is replaced: restore whatever we were doing. */
    static void restore(Context c) {
        if (Prefs.of(c).getBoolean(Prefs.RETIRED, false)) return;
        if (Prefs.of(c).getBoolean(Prefs.LOCKED, false)) show(c);
    }
}
