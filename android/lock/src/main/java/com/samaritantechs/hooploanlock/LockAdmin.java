package com.samaritantechs.hooploanlock;

import android.app.admin.DeviceAdminReceiver;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PersistableBundle;
import android.os.UserManager;

/**
 * The Device Owner receiver -- the reason this app can do anything at all.
 *
 * A normal Android app cannot stop somebody leaving it. It can draw a screen, and the home
 * button dismisses that screen; it can restart itself, and Settings uninstalls it. Every
 * "lock by IMEI" service sold to dealers works this way underneath, whatever the sales page
 * implies: the phone has to be made a Device Owner while it is in your hands, and everything
 * else follows from that one act. It is why HOOP's phones have to be opened at the station.
 *
 * Device Owner can only be established on a phone with no accounts set up -- straight out of
 * the box, or straight after a factory reset. That is not a limitation we can engineer away.
 */
public class LockAdmin extends DeviceAdminReceiver {

    static ComponentName who(Context c) {
        return new ComponentName(c.getApplicationContext(), LockAdmin.class);
    }

    static DevicePolicyManager dpm(Context c) {
        return (DevicePolicyManager) c.getSystemService(Context.DEVICE_POLICY_SERVICE);
    }

    static boolean isOwner(Context c) {
        try {
            return dpm(c).isDeviceOwnerApp(c.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * QR provisioning finished. This is the one moment the phone is handed its identity: the
     * server it answers to and the token that speaks for exactly one registry row.
     */
    @Override
    public void onProfileProvisioningComplete(Context context, Intent intent) {
        PersistableBundle extras = intent.getParcelableExtra(
                DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE);
        if (extras != null) {
            String server = extras.getString("server", "");
            String token = extras.getString("token", "");
            if (server != null && !server.isEmpty()) Prefs.put(context, Prefs.SERVER, server);
            if (token != null && !token.isEmpty()) Prefs.put(context, Prefs.TOKEN, token);
        }
        harden(context);
        // Say hello immediately, so the station sees the phone appear on the register while
        // the box is still open and can tell straight away that provisioning actually took.
        Beat.now(context, true);
        BeatJob.schedule(context);
    }

    @Override
    public void onEnabled(Context context, Intent intent) {
        harden(context);
        BeatJob.schedule(context);
    }

    /**
     * The restrictions that make a lock mean something.
     *
     * Without these, "locked" lasts exactly as long as it takes to hold the power button and
     * pick Factory Reset. Each one closes a specific way out, and none of them touches the
     * customer's own data:
     *
     *   FACTORY_RESET   the obvious one -- reset would clear us off the phone entirely
     *   SAFE_BOOT       safe mode starts without third-party apps, i.e. without this one
     *   ADD_USER        a second user is a whole session our lock screen does not cover
     *   uninstall block Settings can otherwise remove a device admin that is not pinned
     *
     * Deliberately NOT set: DISALLOW_DEBUGGING_FEATURES. It would close the adb door too --
     * including the door we need when something here goes wrong on a phone in Dar and there
     * is no other way in. Locking ourselves out along with the thief is not a win.
     */
    static void harden(Context c) {
        if (!isOwner(c)) return;
        DevicePolicyManager d = dpm(c);
        ComponentName me = who(c);
        try { d.addUserRestriction(me, UserManager.DISALLOW_FACTORY_RESET); } catch (Exception ignored) { }
        try { d.addUserRestriction(me, UserManager.DISALLOW_SAFE_BOOT); } catch (Exception ignored) { }
        try { d.addUserRestriction(me, UserManager.DISALLOW_ADD_USER); } catch (Exception ignored) { }
        try { d.setUninstallBlocked(me, c.getPackageName(), true); } catch (Exception ignored) { }
        /* AND THE RADIO STAYS ON -- a lock that can be switched off is not a lock.
           -------------------------------------------------------------------------------
             "wifi is off, let me connect it"

           A handset that cannot hear us can be neither locked, unlocked nor released.
           Airplane mode is one tap from any screen and defeats the whole product; from
           Android 13 turning Wi-Fi off does the same thing more quietly.

           This is not mainly about evasion. The customer who has PAID is who it hurts most:
           their phone is pinned in lock task, so they cannot reach Settings to rejoin a
           network, and the release the office has already granted can never arrive. They
           would be holding a handset nobody alive can open without a cable.

           Held exactly as long as we are Device Owner, next to the factory-reset block and
           dropped by unharden along with it -- a phone handed back is an ordinary phone.
           Deliberately NOT set: anything touching mobile data, which is the customer's own
           money to spend or not. */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try { d.addUserRestriction(me, UserManager.DISALLOW_AIRPLANE_MODE); } catch (Exception ignored) { }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            try { d.addUserRestriction(me, UserManager.DISALLOW_CHANGE_WIFI_STATE); } catch (Exception ignored) { }
        }
        // Only this package may hold the screen. Set once, here, so LockActivity's
        // startLockTask() is allowed to pin without a prompt when the moment comes.
        try { d.setLockTaskPackages(me, new String[]{ c.getPackageName() }); } catch (Exception ignored) { }
        /* LOCATION, GRANTED BY US TO US.
           -------------------------------------------------------------------------------
             "am asked if the app could trap last sync with location coordinates"

           Location is a runtime permission and there is nobody at a locked handset to tap
           Allow -- a phone in a box in a warehouse would never be asked and never answer.
           A Device Owner may grant it to itself, which is one of the few things being Device
           Owner buys that a manifest entry cannot.

           Best effort, like everything else here: where a vendor build refuses, Loc.last
           returns null for ever and the register simply has no position for that handset.
           A missing column on a report is an acceptable outcome; a lock that fails to
           install because of it would not be. */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            for (String perm : new String[]{
                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION,
                    /* READ_PHONE_STATE is here for the same reason and by the same mechanism:
                       getImei() needs device-owner AND this grant, not device-owner alone. It
                       was optional while the IMEI was only ever extra information on the
                       register; it is required now that a handset must name itself to claim
                       its own token out of a hub batch. */
                    android.Manifest.permission.READ_PHONE_STATE }) {
                try {
                    d.setPermissionGrantState(me, c.getPackageName(), perm,
                            DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
                } catch (Exception ignored) { }
            }
            /* Background location is a separate permission from Android 10, and it is the one
               that matters here: this app is never in the foreground on a phone that is not
               locked. Attempted separately so a platform that refuses it does not also cost
               us the foreground grant above. */
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    d.setPermissionGrantState(me, c.getPackageName(),
                            android.Manifest.permission.ACCESS_BACKGROUND_LOCATION,
                            DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
                } catch (Exception ignored) { }
            }
        }
        /* PLAY PROTECT IS NOT SWITCHED OFF HERE, AND THE REASON IS WORTH KEEPING.
           -------------------------------------------------------------------------------
             "it asked b/se app is dangerous continue anyway"

           That dialog is Play Protect, not the install confirmation -- two gates, and only
           the second is the one SelfUpdate's setRequireUserAction silences. The obvious
           answer is for a Device Owner to turn package verification off, and this code did
           that for one commit before the compiler pointed out that
           Settings.Global.PACKAGE_VERIFIER_ENABLE is @hide: not public API, no public
           constant, does not build.

           Reaching past that with the raw string would have compiled and then done nothing.
           From Android 9 setGlobalSetting is restricted to a short allowlist and package
           verification is not on it, so the call would be accepted and ignored -- a line that
           reads like a fix, ships like a fix, and leaves the prompt exactly where it was.
           This feature has produced enough of those.

           WHAT ACTUALLY HAPPENS, which is less alarming than it looked: Play Protect warns
           when an unknown app is FIRST installed. That is at the bench, with an operator
           holding the phone, who taps through it once. Updates afterwards are the same
           package with the same signature and do not re-warn -- and those are the ones that
           reach a boxed handset with nobody nearby, which is the case that mattered.

           If it ever does need suppressing across a fleet, the supported route is Android
           Enterprise enrolment through an EMM, not a bare Device Owner. */
    }

    /**
     * Undone when a phone is released for good. A customer who has finished paying should be
     * left with an ordinary phone -- not one that still refuses to factory reset because of a
     * loan they cleared. Releasing has to give back everything locking took.
     *
     * RETURNS whether the phone is ACTUALLY no longer Device Owner -- read back, not assumed.
     * This is the fix for the handset that came out owned, silent and unreachable: the last
     * step here, clearDeviceOwnerApp, is deprecated and can be refused without throwing
     * (Samsung's Knox layer does exactly that on an organisation-owned device). The old code
     * called it, ignored it, then set RETIRED and cancelled the beat -- so a phone the system
     * had NOT released stopped speaking anyway, and there was no way back to it. Every caller
     * now checks this return before going quiet: a phone still owned keeps beating.
     */
    static boolean unharden(Context c) {
        if (!isOwner(c)) return true;                     // already handed back; nothing to do
        DevicePolicyManager d = dpm(c);
        ComponentName me = who(c);
        try { d.clearUserRestriction(me, UserManager.DISALLOW_FACTORY_RESET); } catch (Exception ignored) { }
        try { d.clearUserRestriction(me, UserManager.DISALLOW_SAFE_BOOT); } catch (Exception ignored) { }
        try { d.clearUserRestriction(me, UserManager.DISALLOW_ADD_USER); } catch (Exception ignored) { }
        // Their phone, their radio. Cleared unconditionally rather than behind the same
        // version checks as harden(): clearing one that was never set costs nothing, and a
        // handset that changed Android version between lock and release must not keep a
        // restriction we can no longer name.
        try { d.clearUserRestriction(me, UserManager.DISALLOW_AIRPLANE_MODE); } catch (Exception ignored) { }
        try { d.clearUserRestriction(me, UserManager.DISALLOW_CHANGE_WIFI_STATE); } catch (Exception ignored) { }
        /* AND HAND BACK THE LOCATION PERMISSION WE GRANTED OURSELVES. A phone under finance
           reports where it last synced so unaccounted stock can be found; a phone that has
           been paid off is nobody's to follow. Returned to DEFAULT rather than DENIED, which
           is the honest undo: it puts the decision back where it belongs, with whoever is
           holding the phone, exactly as if we had never been Device Owner. */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            for (String perm : new String[]{
                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION,
                    android.Manifest.permission.ACCESS_BACKGROUND_LOCATION }) {
                try {
                    d.setPermissionGrantState(me, c.getPackageName(), perm,
                            DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT);
                } catch (Exception ignored) { }
            }
        }
        try { d.setUninstallBlocked(me, c.getPackageName(), false); } catch (Exception ignored) { }
        // And step down as Device Owner entirely, which is what actually hands the phone back.
        // Deprecated since API 26 but still the only way for an app to give up ownership, and
        // present on every version this stock spans -- so it is called unguarded.
        try { d.clearDeviceOwnerApp(c.getPackageName()); } catch (Exception ignored) { }
        // The truth, read off the system rather than presumed from a call that can lie.
        return !isOwner(c);
    }
}
