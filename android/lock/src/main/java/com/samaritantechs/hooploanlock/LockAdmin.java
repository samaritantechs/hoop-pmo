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

    /** The system Settings app -- the same package name on AOSP and on Samsung's One UI -- and
        the telephony app, which hosts the mobile-network screen on Android 9 and older. */
    static final String SETTINGS_PACKAGE = "com.android.settings";
    static final String PHONE_PACKAGE = "com.android.phone";

    /* THE ONE DOOR IN THE LOCK, AND WHO HOLDS IT OPEN.
       -----------------------------------------------------------------------------------
       The locked screen's Wi-Fi and data buttons open the system's own network panels. Those
       are Settings activities, and LockActivity is singleInstance, so they start in a NEW task
       -- which lock task refuses, silently, from any package not on the allowlist. So Settings
       is allowlisted for exactly as long as a panel our screen opened is in front: opened by
       openPanel, closed by the screen coming back (its own comeback, a network returning, the
       customer backing out) and by an unlock.

       NOT held permanently in harden(), for two reasons the first cut got wrong. A permanent
       entry changes every phone in the field the moment it self-updates -- any Settings
       activity the SYSTEM launches on a locked phone (a dual-SIM prompt, a storage-full flow)
       would join lock task on top of our screen instead of being refused. And the system does
       the one thing we cannot when the entry is REMOVED: LockTaskController finishes every
       locked task whose package just lost allowlist status, so closing the door is also what
       clears the Settings task from under our screen -- left alive, it would be the task the
       phone stayed pinned to after an unlock. Closed from every road back to the screen
       (LockActivity), from an unlock (Guard.unlock) and from a release (unharden), and shut
       unconditionally when a locked screen is created, so a process killed behind a panel
       cannot leave it open past the next boot. Best effort; false when this app is not Device
       Owner, where there is no lock task to open a door in. */
    static boolean allowSettings(Context c, boolean open) {
        if (!isOwner(c)) return false;
        DevicePolicyManager d = dpm(c);
        ComponentName me = who(c);
        /* AND WHAT THE DOOR MAY NOT BE USED FOR, held for exactly as long as it is open -- never
           on an unlocked phone, never at the bench. A panel has a way into the rest of Settings,
           and each of these closes a road a pinned phone never had: a hotspot run off a locked
           handset, a network reset that forgets every Wi-Fi and leaves the phone unable to call
           home, a clock wound to mint boot windows and stall the network-back beat, a force-stop
           or clear-data attempt on any app from the Apps screen, a sideload.

           Deliberately NOT DISALLOW_DEBUGGING_FEATURES, though it is the obvious one: applying it
           writes ADB_ENABLED=0 as a side effect and nothing turns it back on, and the cable RELEASE
           on a locked handset (ReleaseReceiver) -- the office's own recovery when the air cannot
           reach a phone -- IS adb. A door that shut that would cost more than it closes. What adb
           can do to a Device Owner is bounded anyway: uninstall, disable and clear-data are refused
           by the system for a protected package, and a full lock task cannot be stopped from the
           shell. */
        for (String r : DOOR_RESTRICTIONS) {
            try { if (open) d.addUserRestriction(me, r); else d.clearUserRestriction(me, r); } catch (Exception ignored) { }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                if (open) d.addUserRestriction(me, UserManager.DISALLOW_CONFIG_DATE_TIME);
                else d.clearUserRestriction(me, UserManager.DISALLOW_CONFIG_DATE_TIME);
            } catch (Exception ignored) { }
        }
        /* AND THE WI-FI TOGGLE IS THEIRS WHILE THE DOOR IS OPEN. harden() holds
           DISALLOW_CHANGE_WIFI_STATE from Android 13 so a locked phone's radio cannot be switched
           OFF from under us -- and the same restriction greys the switch in the very panel the
           Wi-Fi button opens: "blocked by your organisation", no networks to see, on the one
           phone where Net.wifiOn did not take. The customer is in that panel to turn Wi-Fi ON.
           So the restriction is lifted for the press and put back the moment the door shuts
           (unharden shuts the door BEFORE its own clears, so a released phone keeps none of it). */
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (open) d.clearUserRestriction(me, UserManager.DISALLOW_CHANGE_WIFI_STATE);
                else d.addUserRestriction(me, UserManager.DISALLOW_CHANGE_WIFI_STATE);
            } catch (Exception ignored) { }
        }
        try {
            d.setLockTaskPackages(me, open
                ? new String[]{ c.getPackageName(), SETTINGS_PACKAGE, PHONE_PACKAGE }
                : new String[]{ c.getPackageName() });
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static final String[] DOOR_RESTRICTIONS = {
        UserManager.DISALLOW_CONFIG_TETHERING, UserManager.DISALLOW_NETWORK_RESET,
        UserManager.DISALLOW_APPS_CONTROL, UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
    };

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
        // (Settings joins this list only while a panel our screen opened is in front -- see
        // allowSettings below -- never here, so a phone that merely self-updates changes nothing.)
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
        /* The door first, if a panel was open at the moment of release: shutting it puts the
           Wi-Fi restriction back, and the clears below then take everything off for good. */
        allowSettings(c, false);
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
        /* AND THE RESET-PROTECTION FENCE COMES OFF. A paid-off phone is nobody's to fence: from
           here the customer's own account protects it the ordinary way. Cleared HERE as well as
           by the retiring beat (Frp.apply on an empty list), because the cable RELEASE and the
           fourteen-day self-release reach this without any beat having said so -- and a former
           customer whose phone still demanded HOOP's account after a wipe would be the exact
           thing achia promises not to leave behind. */
        try { Frp.clear(c); } catch (Exception ignored) { }
        // And step down as Device Owner entirely, which is what actually hands the phone back.
        // Deprecated since API 26 but still the only way for an app to give up ownership, and
        // present on every version this stock spans -- so it is called unguarded.
        try { d.clearDeviceOwnerApp(c.getPackageName()); } catch (Exception ignored) { }
        // The truth, read off the system rather than presumed from a call that can lie.
        return !isOwner(c);
    }
}
