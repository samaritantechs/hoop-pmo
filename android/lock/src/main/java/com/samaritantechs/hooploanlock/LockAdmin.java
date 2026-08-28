package com.samaritantechs.hooploanlock;

import android.app.admin.DeviceAdminReceiver;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
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
        // Only this package may hold the screen. Set once, here, so LockActivity's
        // startLockTask() is allowed to pin without a prompt when the moment comes.
        try { d.setLockTaskPackages(me, new String[]{ c.getPackageName() }); } catch (Exception ignored) { }
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
        try { d.setUninstallBlocked(me, c.getPackageName(), false); } catch (Exception ignored) { }
        // And step down as Device Owner entirely, which is what actually hands the phone back.
        // Deprecated since API 26 but still the only way for an app to give up ownership, and
        // present on every version this stock spans -- so it is called unguarded.
        try { d.clearDeviceOwnerApp(c.getPackageName()); } catch (Exception ignored) { }
        // The truth, read off the system rather than presumed from a call that can lie.
        return !isOwner(c);
    }
}
