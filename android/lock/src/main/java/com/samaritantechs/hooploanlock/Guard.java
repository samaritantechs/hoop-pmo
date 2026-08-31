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
        boolean was = Prefs.of(c).getBoolean(Prefs.LOCKED, false);
        Prefs.put(c, Prefs.LOCKED, true);
        /* A LOCK ORDER ALWAYS CLOSES AN OPEN WINDOW. The boot window exists so a handset can
           be REACHED, and the office reaching it to say "lock" is that purpose served, not
           interrupted. Leaving it open here would be the loophole itself: take a window, wait
           for the beat to land, and keep the phone for the rest of the five minutes anyway. */
        Prefs.put(c, Prefs.GRACE_UNTIL, 0L);
        /* AND A NEW LOCK BEGINS A NEW EPISODE. The rate limit exists to stop a power cycle
           minting a fresh window, not to punish a customer whose phone is locked again next
           month -- so the stamp is cleared when the state actually CHANGES to locked, and only
           then. Re-locking a phone that is already locked (a changed reason, a repeated order,
           a beat restating the obvious) is not a new episode and must not hand back a window
           that has already been spent. */
        if (!was) Prefs.put(c, Prefs.GRACE_LAST, 0L);
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

    /** Called on boot and after our own package is replaced: restore whatever we were doing.
        `realBoot` separates the two -- see restore()'s note on why an app update gets no
        window. */
    static void restore(Context c, boolean realBoot) {
        if (Prefs.of(c).getBoolean(Prefs.RETIRED, false)) return;
        if (!Prefs.of(c).getBoolean(Prefs.LOCKED, false)) return;
        /* THE WINDOW IS ONLY EVER OPENED HERE, on a real power cycle of a locked phone. That
           is fence 1: there is no other caller, so a locked handset sitting awake in somebody's
           hand has no path to one.

           AN APP UPDATE IS NOT A BOOT. BootReceiver also fires on MY_PACKAGE_REPLACED, and
           SelfUpdate installs on our schedule rather than the customer's -- so counting that
           as a power cycle would spend a customer's one daily window on an event they neither
           asked for nor noticed, and would leave them locked out when they genuinely rebooted
           an hour later. */
        if (realBoot && mayOpenWindow(c)) { openWindow(c); return; }
        show(c);
    }

    /* Fence 2, and the one the ask is really about: "dont leave any loophole of unlocking a
       phone thats already locked and awake and got the grace period already."

       Switching a phone off and on again is the first thing anybody tries. GRACE_LAST is
       stamped the moment a window OPENS and lives in SharedPreferences, so it is still there
       on the next boot -- and the second power cycle inside the period finds it and locks
       immediately. Rebooting in a loop buys nothing at all.

       It is a rate limit rather than a one-shot on purpose. A customer who has PAID, whose
       phone is locked, and who is somewhere with no wifi in reach spends their window and
       gets nowhere; if that were the only one they ever got, the handset would be bricked by
       the very mechanism meant to save it. One window per period is enough to be a way out
       and far too little to be a way of using the phone. */
    private static boolean mayOpenWindow(Context c) {
        int minutes = Prefs.of(c).getInt(Prefs.BOOT_GRACE_MINUTES, 0);
        if (minutes <= 0) return false;                  // switched off for this fleet
        int everyHours = Prefs.of(c).getInt(Prefs.BOOT_GRACE_EVERY_HOURS, 24);
        long last = Prefs.of(c).getLong(Prefs.GRACE_LAST, 0);
        if (last <= 0) return true;                      // none spent since this lock began
        long since = System.currentTimeMillis() - last;
        /* A CLOCK THAT WENT BACKWARDS IS NOT AN INVITATION. The phone's own clock is settable
           by whoever holds it, and on a locked handset that is the customer. Winding it back
           makes `since` negative, which must read as "not yet", never as "long enough" --
           otherwise the rate limit is defeated by changing the date, which is easier than
           rebooting. */
        if (since < 0) return false;
        return since >= everyHours * 3600000L;
    }

    private static void openWindow(Context c) {
        int minutes = Prefs.of(c).getInt(Prefs.BOOT_GRACE_MINUTES, 0);
        long now = System.currentTimeMillis();
        /* STAMPED BEFORE IT IS USED. If the process dies during the window -- which on a
           phone booting up is entirely ordinary -- the window is already counted as spent,
           so the reboot that follows cannot claim another. Optimistic accounting in the
           customer's favour would be the loophole. */
        Prefs.put(c, Prefs.GRACE_LAST, now);
        Prefs.put(c, Prefs.GRACE_UNTIL, now + minutes * 60000L);
        /* Say what is happening, in the one moment somebody is certainly looking at the
           screen. A phone that silently works and then locks itself five minutes later reads
           as a fault; a phone that says "you have five minutes to turn wifi on" reads as an
           instruction, and it is the instruction that gets the handset back online. A toast
           needs no permission and no notification channel, so there is nothing here that can
           fail on one Android version and not another. */
        try {
            android.widget.Toast.makeText(c,
                "Dakika " + minutes + ": washa WiFi au data ili simu isikie ujumbe wa ofisi."
                + "\n" + minutes + " minutes: turn on WiFi or data so this phone can hear the office.",
                android.widget.Toast.LENGTH_LONG).show();
        } catch (Exception ignored) { }
        /* The in-process timer for the ordinary case, plus enforce() being called from every
           beat and every job run for the case where this process does not survive. Belt and
           braces on purpose: a window that fails to CLOSE is a phone that is not locked. */
        final Context app = c.getApplicationContext();
        new Handler(Looper.getMainLooper()).postDelayed(() -> enforce(app), minutes * 60000L);
    }

    /* THE WINDOW HAS TO CLOSE EVEN IF NOTHING REMEMBERS TO CLOSE IT. Called from the boot
       receiver, from every beat and from every job run, so a killed process, a missed timer
       or a phone that simply sat there all resolve the same way: the moment anything in this
       app runs again and the window has run out, the screen comes back.

       Deliberately does NOT re-open a window or touch GRACE_LAST. This only ever locks. */
    static void enforce(Context c) {
        if (Prefs.of(c).getBoolean(Prefs.RETIRED, false)) return;
        if (!Prefs.of(c).getBoolean(Prefs.LOCKED, false)) return;
        long until = Prefs.of(c).getLong(Prefs.GRACE_UNTIL, 0);
        long now = System.currentTimeMillis();
        // Still inside it -- and a clock wound forward closes the window early, which is the
        // safe direction and the only one worth allowing.
        if (until > 0 && now < until) return;
        if (until > 0) Prefs.put(c, Prefs.GRACE_UNTIL, 0L);
        show(c);
    }

    /** True while a boot window is open. The beat asks, so it can come back quickly enough to
        be useful during the one window where reaching the server is the entire point. */
    static boolean inWindow(Context c) {
        long until = Prefs.of(c).getLong(Prefs.GRACE_UNTIL, 0);
        return until > 0 && System.currentTimeMillis() < until;
    }

    /* Fence 3: the window ends the moment the handset reaches us, because at that moment it
       has served its whole purpose -- the office can see this phone and this phone can hear
       the office. Called from Beat on ANY successful answer, before the answer is acted on,
       so what follows is an ordinary lock or an ordinary unlock with no window left under it.
       There is therefore nothing to be gained by staying offline through the window. */
    static void windowServed(Context c) {
        Prefs.put(c, Prefs.GRACE_UNTIL, 0L);
    }
}
