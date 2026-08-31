package com.samaritantechs.hooploanlock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * A locked phone that is switched off and on again must come back locked. Rebooting is the
 * first thing anybody tries, so this is not a nicety -- without it the lock lasts one
 * power cycle.
 *
 * Also fires on MY_PACKAGE_REPLACED, i.e. after this app updates itself: an update must not
 * be a window during which the phone is free.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        LockAdmin.harden(c);          // restrictions are per-user state; re-assert them
        /* A REAL POWER CYCLE IS NOT THE SAME EVENT AS OUR OWN UPDATE, and only one of them
           earns the boot window. SelfUpdate installs on OUR schedule, not the customer's, so
           counting a package replace as a boot would spend their one window on something they
           neither asked for nor noticed -- and leave them locked out when they genuinely
           restarted an hour later. Both still restore the lock; only a boot may open a
           window. */
        String action = intent != null ? intent.getAction() : null;
        boolean realBoot = Intent.ACTION_BOOT_COMPLETED.equals(action)
            || "android.intent.action.QUICKBOOT_POWERON".equals(action);
        Guard.restore(c, realBoot);
        BeatJob.schedule(c);
        Beat.now(c, false);
    }
}
