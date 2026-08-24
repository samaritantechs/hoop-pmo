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

    static void unlock(Context c) {
        boolean was = Prefs.of(c).getBoolean(Prefs.LOCKED, false);
        Prefs.put(c, Prefs.LOCKED, false);
        if (was) {
            // Tell the screen to stand down. LockActivity does the stopLockTask() itself --
            // only the activity that entered lock task may leave it.
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
