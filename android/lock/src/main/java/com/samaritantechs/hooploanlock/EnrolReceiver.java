package com.samaritantechs.hooploanlock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The second way a phone can be handed its identity: over adb, at a station with a laptop.
 *
 *   adb shell dpm set-device-owner com.samaritantechs.hooploanlock/.LockAdmin
 *   adb shell am broadcast --include-stopped-packages \
 *       -a com.samaritantechs.hooploanlock.ENROL \
 *       -n com.samaritantechs.hooploanlock/.EnrolReceiver \
 *       -e server https://hoop-pmo.vercel.app -e token <the token from the register>
 *
 * --include-stopped-packages IS NOT OPTIONAL, and leaving it off is the third time this
 * feature has produced a failure that prints like a success. A freshly installed app, and
 * any app that has had `pm clear` run on it, sits in Android's STOPPED state and receives no
 * broadcast at all unless the sender asks for one. Without the flag `am` reports:
 *
 *     Broadcast completed: result=0
 *
 * -- no result code, no message, nothing in logcat, and none of the guards below ever run,
 * because this class is never constructed. result=0 with NO data= is the signature: it means
 * the receiver did not run, as distinct from result=1..4 with a message, which means it did.
 *
 * QR provisioning is the tidier route for hundreds of phones at a time. This one exists
 * because HOOP is already opening every box by hand -- a cable is one more thing on a bench
 * that is already covered in phones, and unlike a QR it gives an error message you can read
 * when something goes wrong.
 *
 * THE GUARD, and why it is the shape it is. An exported receiver that sets the server URL
 * would otherwise let any app on the phone re-point this one at a server of its choosing --
 * which is a complete bypass, since that server could simply answer "unlock". So the SERVER
 * is settable exactly once, at first enrolment, and only on a phone that is already Device
 * Owner: a state only somebody holding the handset can bring about. Nothing said over this
 * receiver afterwards can ever move a handset to a different server.
 *
 * RE-ENROLLING NO LONGER MEANS A FACTORY RESET.
 * ---------------------------------------------------------------------------------------
 *   "factory reset is wasting time we need to test as long as we own"
 *
 * It used to. A second token was refused outright, and the message said so -- send an
 * operator to wipe a working handset to change a string. Worse, the bench scripts offered
 * -ReEnrol / REENROL=1 as the way round it, which ran `pm clear`; the comment three lines
 * above that call, in the same file, records that `pm clear` is REFUSED on a Device Owner
 * app. The flag never worked. So the documented escape hatch was a dead end and the reset
 * was the only real route, which is what made this expensive.
 *
 * A phone will now take a new token when the broadcast proves it holds the CURRENT one:
 *
 *   ... -e token <the new token> -e current <the token it holds now>
 *
 * That keeps the guard exactly as strong as it was. An app on the handset cannot read this
 * one's private preferences, so it cannot supply `current`; and it still has to be Device
 * Owner. The only party that can re-enrol is the office, which is the party that minted both
 * tokens and is already trusted with the lock.
 *
 * THE SERVER IS DELIBERATELY NOT RE-SETTABLE ALONGSIDE IT. Handing a new token is a change
 * of identity within one office; changing the server is a change of WHO OWNS THE PHONE, and
 * is the one thing that could turn a stolen token into an unlock. Re-enrolment therefore
 * replaces the token and leaves the server exactly where first provisioning put it.
 */
public class EnrolReceiver extends BroadcastReceiver {

    /* SAY WHY, INSTEAD OF FAILING IN SILENCE.
     *
     * Every guard below used to be a bare `return`, and `am broadcast` prints
     * "Broadcast completed: result=0" either way -- which reads exactly like success. On the
     * first real handset that cost an evening: the operator ran this BEFORE
     * set-device-owner, saw result=0, and had no way to learn the receiver had dropped it on
     * the floor. result=0 only ever meant "delivered", never "accepted".
     *
     * setResultCode and setResultData are what adb prints back, so the answer lands in the
     * same terminal the command was typed into -- no logcat, no guessing.
     */
    private void say(int code, String why) {
        try { setResultCode(code); setResultData(why); } catch (Exception ignored) { }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        if (intent == null) return;

        /* OWNERSHIP FIRST, because it is the precondition for everything below and because
           it is the more useful thing to be told. A released handset still holds its token,
           and answering "already enrolled" there sends the operator looking for the wrong
           problem: what that phone needs is set-device-owner, which this now says. */
        if (!LockAdmin.isOwner(c)) {                              // not provisioned; not ours
            say(3, "NOT DEVICE OWNER - run this first, then broadcast again: "
                 + "adb shell dpm set-device-owner com.samaritantechs.hooploanlock/.LockAdmin");
            return;
        }

        String token = intent.getStringExtra("token");
        if (token == null || token.trim().isEmpty()) {
            say(4, "NO TOKEN - pass -e token <the token from the register>.");
            return;
        }
        token = token.trim();

        String existing = Prefs.str(c, Prefs.TOKEN, "");
        boolean fresh = existing == null || existing.isEmpty();
        boolean same = !fresh && existing.equals(token);

        if (!fresh && !same) {
            // A DIFFERENT token: allowed, but only to somebody who can name the current one.
            String proof = intent.getStringExtra("current");
            if (proof == null || !existing.equals(proof.trim())) {
                say(2, "ALREADY ENROLLED, under a different token. To move this handset onto "
                     + "the new one, add: -e current <the token it holds now>");
                return;
            }
        }

        /* THE SERVER, ONCE. See the note above: a new token is a change of identity inside
           one office, but a new server is a change of which office owns the phone -- the one
           thing that could turn a leaked token into an unlock. So it is written at first
           enrolment and never again, and a re-enrol carrying -e server silently keeps the
           server it already has rather than failing over it. */
        if (fresh) {
            String server = intent.getStringExtra("server");
            if (server != null && !server.trim().isEmpty()) Prefs.put(c, Prefs.SERVER, server.trim());
        }
        Prefs.put(c, Prefs.TOKEN, token);

        /* AND THE PHONE IS BACK IN SERVICE, which is the whole point of saying so here.
           -------------------------------------------------------------------------------
             "so if a customer never reboots the phone?"

           RETIRED means "released for good; stop beating", and EVERY path checks it --
           Beat.run returns on its first line, BeatJob will not arm, Guard will not restore,
           SelfUpdate will not fetch. BootReceiver calls straight into those, so a phone
           carrying this flag does not come back from a reboot either. It is silent for good.

           That is correct after a genuine release and catastrophic when the flag is wrong,
           and it HAS been wrong: builds before 1.5.0 set it whether or not the system
           actually accepted the step-down, so a handset that stayed Device Owner stopped
           speaking anyway. `adb install -r` keeps app data, so a newer APK inherits the flag
           and behaves exactly as badly. On a phone in Dar that is a handset nobody can lock,
           unlock or reach again -- with no route home short of a factory reset, which needs
           the phone in your hands.

           Enrolling is the office saying "this handset is in service". There is no reading
           of that which leaves it retired, so the flag goes, and the one command the station
           already copies becomes the way back from a silent phone. GONE_SINCE goes with it:
           it counts how long a handset has been unreachable, and this is the moment that
           count stops being true. */
        Prefs.of(c).edit().remove(Prefs.RETIRED).remove(Prefs.GONE_SINCE).apply();

        LockAdmin.harden(c);
        Beat.now(c, true);          // appear on the register while the bench is still open
        BeatJob.schedule(c);
        say(1, same
            ? "ENROLLED - already held this token; re-armed and reporting in now."
            : fresh ? "ENROLLED - reporting in now; look for this phone on the register."
                    : "RE-ENROLLED - now holds the new token, same server; reporting in now.");
    }
}
