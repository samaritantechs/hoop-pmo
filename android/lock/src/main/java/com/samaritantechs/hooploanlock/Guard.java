package com.samaritantechs.hooploanlock;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

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
        /* AND REPAINT A SCREEN THAT IS ALREADY UP.
           -------------------------------------------------------------------------------
             "relocking with other reason works but the previous lock keeps poppin"

           The words on the lock screen -- the reason above all -- arrive on the beat and are
           read when the activity is built. A phone that is ALREADY locked and is re-locked
           under a new reason builds nothing: show() hands the system an intent for an
           activity that is already there, and whether that reaches onNewIntent is up to the
           platform. When it does not, the customer goes on reading the previous reason while
           the register shows the new one -- two different answers to "why is my phone off",
           which is the one question this screen exists to settle.

           The release path already proved the reliable route to a LIVE screen is its own
           receiver, so the repaint goes the same way. Harmless when no screen is up: nothing
           is registered to hear it. */
        try { c.sendBroadcast(new Intent(ACTION_REPAINT).setPackage(c.getPackageName())); }
        catch (Exception ignored) { }
    }

    /** Sent to the lock screen while it is running. See unlock(). */
    static final String ACTION_RELEASE = "com.samaritantechs.hooploanlock.RELEASE_SCREEN";
    /** Sent when the words may have changed under a screen that is already up. See lock(). */
    static final String ACTION_REPAINT = "com.samaritantechs.hooploanlock.REPAINT_SCREEN";

    /* HOW LONG TO GIVE THE LIVE SCREEN before falling back to an activity start. Long enough
       for a main-thread broadcast to be delivered and acted on; short enough that a phone
       whose activity really is gone still comes down promptly. */
    private static final long FALLBACK_MS = 1200;

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

        /* AND THE FALLBACK, WHICH HAS TO WAIT ITS TURN.
           -------------------------------------------------------------------------------
             "cmd runs and the bluescreen flushes off and back on in a second"

           This is for a screen that is BELIEVED up but whose activity is gone -- the flag
           left standing after the system reclaimed the process. It was guarded by re-reading
           SCREEN_UP on the very next line, which reads as "only if the broadcast did not
           work" and cannot be: sendBroadcast is ASYNCHRONOUS. It queues the intent and
           returns, and the receiver runs afterwards on the main thread, so the flag is
           always still true one line later. The guard never once said no.

           So every unlock did it twice. The broadcast took the screen down, and then this
           built a SECOND lock screen, drew it, read the extra and finished it -- exactly the
           blue flash reported here, and the same one behind "restarting the phone made the
           app flash and get off". Worse than ugly: for that moment a phone the office has
           just released is showing its customer a lock screen.

           Giving the live screen its moment first costs nothing. If it stood down, SCREEN_UP
           is false by now and no activity is started at all. If the process died in between,
           the screen went with it, which is the outcome we wanted anyway. */
        final Context app = c.getApplicationContext();
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (!Prefs.of(app).getBoolean(Prefs.SCREEN_UP, false)) return;  // the live screen took it
            // And never tear down a screen the office has put back up in the meantime -- with
            // an operator working quickly, lock and unlock can be seconds apart.
            if (Prefs.of(app).getBoolean(Prefs.LOCKED, false)) return;
            Intent i = new Intent(app, LockActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            i.putExtra(LockActivity.EXTRA_RELEASE, true);
            try { app.startActivity(i); } catch (Exception ignored) { }
        }, FALLBACK_MS);
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
