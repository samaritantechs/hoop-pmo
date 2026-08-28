package com.samaritantechs.hooploanlock;

import android.content.Context;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * THE DOORBELL. Google taps this handset on the shoulder, and it beats immediately.
 *
 * A phone that polls cannot be faster than its poll. Sixty seconds is the floor we can reach
 * by asking, and Doze pushes an idle handset past even that. This is the only way an order
 * given in the office reaches a phone in Dar in about a second: Google already holds an open
 * connection to every Android device for its own notifications, and lets us send down it.
 *
 * WHAT ARRIVES HERE IS NOT A COMMAND, and that is the whole security design.
 *
 * The message says "beat", and carries nothing else -- no lock, no unlock, no release. This
 * class does exactly one thing with it: run the ordinary heartbeat. The handset then asks
 * /api/device the same question it always asks, with its own enrolment token, and gets the
 * same answer it always gets.
 *
 * So somebody who forged or replayed a push could cause one extra heartbeat. That is the
 * entire attack: they cannot lock a phone, unlock one, or free one, because none of those
 * decisions travels in this message. It is the same rule the rest of the system runs on --
 * the command is DERIVED from the register on every beat, never queued and never carried.
 *
 * AND IT IS ONLY EVER A SHORTCUT. Push failing, Firebase being unreachable, Google dropping
 * the message -- none of that strands anything, because the timed beat underneath is
 * unchanged and still arrives. This class makes the system faster. Nothing depends on it.
 *
 * Compiled only when lock/google-services.json is present; see lock/build.gradle.
 */
public class Push extends FirebaseMessagingService {

    /**
     * A new registration token for this handset. Fires on first run after install, and
     * whenever Firebase decides to rotate one.
     *
     * Stored and then reported by the ordinary beat rather than sent from here: the beat is
     * the one authenticated channel this app has, and an address the server accepted without
     * a token would be an address anybody could write. It also means a phone with no network
     * right now simply reports it whenever it next gets one, with no retry logic to get wrong.
     */
    @Override
    public void onNewToken(String token) {
        Context c = getApplicationContext();
        if (token == null || token.trim().isEmpty()) return;
        String had = Prefs.str(c, Prefs.FCM_TOKEN, "");
        if (token.equals(had)) return;
        Prefs.put(c, Prefs.FCM_TOKEN, token);
        /* Tell the office straight away. Until this beat lands the server has no way to reach
           this handset quickly -- it would fall back to the timer, which works but is the
           thing we are here to improve. */
        Beat.now(c, false);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        // Deliberately not reading the payload. See the header: this is a doorbell, and
        // acting on anything it carried would be the bug, not a feature.
        Beat.now(getApplicationContext(), false);
    }
}
