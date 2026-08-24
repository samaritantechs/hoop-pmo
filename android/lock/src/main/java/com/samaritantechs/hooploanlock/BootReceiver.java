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
        Guard.restore(c);
        BeatJob.schedule(c);
        Beat.now(c, false);
    }
}
