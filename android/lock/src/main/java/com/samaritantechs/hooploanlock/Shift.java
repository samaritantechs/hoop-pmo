package com.samaritantechs.hooploanlock;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * MOVING A HANDSET FROM ONE OFFICE TO THE OTHER WITHOUT A FACTORY RESET.
 *
 *   "another button for shift so that hoop can shift a device to hope and viceversa saving
 *    re-enlorrment energy"
 *
 * One signed APK serves both companies, so a phone leaving Hoop for HOPE is the same app on
 * the same handset answering to a different register. Until now that move cost a wipe, and
 * the arithmetic is worth stating because it is the whole reason this class exists:
 *
 *   achia  -> LockAdmin.unharden -> clearDeviceOwnerApp   the phone stops being Device Owner
 *   re-enrol needs set-device-owner
 *   set-device-owner is REFUSED while any account is signed in
 *   a handset that has been in an officer's hand for months has a Google account on it
 *   => factory reset, on every phone, to change which office it answers to
 *
 * A shift never lets go of Device Owner. That is the point: the expensive part of enrolment
 * is not the token, it is ownership, and ownership is exactly what a release throws away.
 *
 * WHY THIS DOES NOT BREAK THE WRITE-ONCE-SERVER RULE, which is load-bearing and is stated in
 * EnrolReceiver: the server is settable only at first enrolment because changing it is a
 * change of WHO OWNS THE PHONE, and a phone that could be re-pointed by anything holding its
 * token could be pointed at a server that simply answers "unlock".
 *
 * The rule relaxes to exactly one case and no further: THE OFFICE THIS HANDSET CURRENTLY
 * ANSWERS TO may hand it to a named successor. That instruction arrives the same way every
 * lock and unlock already does -- in the body of a beat response, over HTTPS, from the
 * address already written into this phone's own storage. Nobody else can produce one.
 * Somebody holding a leaked token can impersonate the PHONE to the office; they cannot
 * impersonate the OFFICE to the phone, which is the asymmetry the whole design rests on.
 *
 * AND THE HANDSET PROVES ITSELF TO THE NEW OFFICE RATHER THAN BEING TOLD WHO IT IS. The order
 * carries a BATCH, not a token -- the same batch enrolment already uses -- so the phone reads
 * its own IMEI and collects the token minted for it. One batch covers a whole shift, which is
 * what makes a bulk shift possible at all, and no office ever has to hold the other's
 * per-handset secrets.
 *
 * NOTHING IS WRITTEN UNTIL THE NEW OFFICE HAS ANSWERED. A shift that fails leaves the phone
 * exactly where it was, still answering the old register, and simply tries again on the next
 * beat. The one state this must never produce is a handset holding one office's credential
 * while beating at the other's address -- owned, hardened, and reachable from neither desk.
 */
final class Shift {

    private static final int TIMEOUT_MS = 12000;

    private Shift() { }

    /**
     * Act on the `shift` a beat may carry. Returns true when the handset now belongs to the
     * new office, in which case the caller must stop acting on the rest of THIS answer -- it
     * came from the old one and is about a phone that is no longer theirs.
     */
    static boolean apply(Context c, JSONObject r) {
        try {
            JSONObject s = (r == null) ? null : r.optJSONObject("shift");
            if (s == null) return false;

            String server = clean(s.optString("server", ""));
            String batch = clean(s.optString("batch", ""));
            if (server.isEmpty() || batch.isEmpty()) return false;

            /* HTTPS ONLY. The lock screen's words, the unlock order and now the identity all
               ride this address; plain http would put every one of them on the wire for
               whatever wifi the handset happens to be joined to. */
            if (!server.regionMatches(true, 0, "https://", 0, 8)) return false;
            while (server.endsWith("/")) server = server.substring(0, server.length() - 1);
            // Already there: a repeated order is a no-op rather than a pointless re-claim.
            if (server.equalsIgnoreCase(Prefs.server(c))) return false;
            if (!looksMinted(batch)) return false;

            JSONArray imeis = EnrolReceiver.imeisForClaim(c);
            if (imeis == null || imeis.length() == 0) return false;   // cannot name itself; stay put

            /* A LOCKED PHONE IS SHIFTED LOCKED.
               ---------------------------------------------------------------------------
                 "when we shift it goes with current state"

               This used to refuse outright: a lock is a decision about a person, and moving
               the phone to a register that never made that decision looked like a quiet way
               to undo it. That was solving the wrong problem. The fix is not to refuse the
               shift -- it is to CARRY the decision along, so the new office inherits the
               same caution rather than a blank slate. `state` is already on every beat this
               phone gets (dev_beat -> state: dev.state), which is exactly the fact worth
               relaying: it is the OLD office's own database, honestly reported by the phone
               that just heard it. The new office decides for itself whether to trust it and
               applies it only to a row it has not yet formed its own opinion about -- see
               the claim() handler in device-core.js on both sides. */
            String state = r.optString("state", "");
            String reason = r.optString("reason", "");

            String token = claim(server, batch, imeis, state, reason);
            if (token == null || token.isEmpty()) return false;       // the new office said no

            /* TELL THE OLD OFFICE BEFORE FORGETTING HOW TO REACH IT. Its register still shows
               this handset as one of its own, and a phone that simply goes quiet is
               indistinguishable there from one that is off, lost or out of coverage. Sent
               with the OLD token, which is about to be overwritten, so it is captured first.
               Best effort: if it does not land the shift still stands -- the phone is the new
               office's now -- and the old register shows a shift ordered and unconfirmed,
               which is at least a true statement of what it knows. */
            told(c, Prefs.str(c, Prefs.TOKEN, ""));

            /* THE SWITCH ITSELF. Ownership is untouched -- no unharden, no step-down -- which
               is the entire saving. What changes is which office this phone answers to. */
            Prefs.put(c, Prefs.SERVER, server);
            Prefs.put(c, Prefs.TOKEN, token);
            /* EVERYTHING THE OLD OFFICE PUT ON THE SCREEN GOES WITH IT. The brand, the
               sentence, the help number and the mark all named a company that no longer holds
               this handset, and a lock screen carrying the wrong company's phone number is
               worse than one carrying none: somebody rings a desk that cannot help them. The
               new office refills every one of them on the beat fired below. */
            LockLogo.reset(c);
            Prefs.of(c).edit()
                    .remove(Prefs.BRAND).remove(Prefs.MESSAGE)
                    .remove(Prefs.HELP_PHONE).remove(Prefs.REASON)
                    .remove(Prefs.RETIRED).remove(Prefs.GONE_SINCE)
                    .apply();

            // Appear on the new register while the person who pressed Shift is still looking.
            Beat.now(c, true);
            BeatJob.schedule(c);
            return true;
        } catch (Throwable ignored) {
            return false;      // a shift may never cost a beat; the next one tries again
        }
    }

    /** Ask the NEW office which token belongs to this handset. Null for every kind of no.
        `state` and `reason` are the OLD office's own words, relayed rather than invented --
        see the note above this method's call site and in device-core.js's claim(). */
    private static String claim(String server, String batch, JSONArray imeis, String state,
                                 String reason) {
        HttpURLConnection conn = null;
        try {
            JSONObject payload = new JSONObject();
            payload.put("batch", batch);
            payload.put("imeis", imeis);
            if (state != null && !state.isEmpty()) payload.put("state", state);
            if (reason != null && !reason.isEmpty()) payload.put("reason", reason);
            JSONObject body = new JSONObject();
            body.put("fn", "dev_claim");
            body.put("args", new JSONArray().put(payload));

            conn = (HttpURLConnection) new URL(server + "/api/device").openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setDoOutput(true);
            OutputStream os = conn.getOutputStream();
            os.write(body.toString().getBytes("UTF-8"));
            os.close();
            if (conn.getResponseCode() != 200) return null;

            BufferedReader rd = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = rd.readLine()) != null) sb.append(line);
            rd.close();
            String t = new JSONObject(sb.toString()).optString("token", "");
            return t.isEmpty() ? null : t;
        } catch (Throwable ignored) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** One line to the office being left, so its register can close the row honestly. */
    private static void told(Context c, String oldToken) {
        if (oldToken == null || oldToken.isEmpty()) return;
        HttpURLConnection conn = null;
        try {
            JSONObject payload = new JSONObject();
            payload.put("token", oldToken);
            JSONObject body = new JSONObject();
            body.put("fn", "dev_shifted");
            body.put("args", new JSONArray().put(payload));

            conn = (HttpURLConnection) new URL(Prefs.server(c) + "/api/device").openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setDoOutput(true);
            OutputStream os = conn.getOutputStream();
            os.write(body.toString().getBytes("UTF-8"));
            os.close();
            conn.getResponseCode();      // the answer is not needed; the attempt is
        } catch (Throwable ignored) {
            // See the note at the call site: the shift stands either way.
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String clean(String s) {
        return s == null ? "" : s.trim();
    }

    /** 32 hex characters, the only shape any register in this family mints. */
    private static boolean looksMinted(String t) {
        if (t == null || t.length() != 32) return false;
        for (int i = 0; i < 32; i++) {
            char ch = t.charAt(i);
            boolean hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')
                       || (ch >= 'A' && ch <= 'F');
            if (!hex) return false;
        }
        return true;
    }
}
