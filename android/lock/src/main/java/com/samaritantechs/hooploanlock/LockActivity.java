package com.samaritantechs.hooploanlock;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The screen a locked phone shows, and the thing that actually holds it there.
 *
 * startLockTask() is the mechanism. As Device Owner it pins this activity with no way out:
 * no home, no recents, no notification shade, no exit gesture. A normal app calling this
 * gets a "Screen pinned" toast and an escape hatch; a Device Owner's lock task has neither.
 * That difference is the entire reason the phone has to be opened at the station.
 *
 * WHAT THIS SCREEN IS FOR, beyond stopping use: somebody is holding this phone, they cannot
 * use it, and they need to know why and what to do about it. A lock screen that just says
 * LOCKED turns a payment problem into an angry walk to a shop.
 *
 * THE FOUR LINES, specified by the person who has to answer the calls:
 *
 *     HOOP LIMITED
 *     SIMU HII IMEFUNGWA NA HOOP LIMITED. WASILIANA NASI KWA NAMBA 0700000000
 *     IMEI: 351388334583295
 *     REASON: STOCK, UNSOLD
 *
 * Not one of those words is compiled into this APK. The company name, the number, the
 * message and the reason all arrive on the heartbeat and are stored, because a handset in
 * somebody's pocket for eighteen months cannot wait for an app release when the office
 * changes its phone number. This class owns the LAYOUT; device-core.js owns the WORDS.
 *
 * IN CAPITALS, deliberately. This is read at arm's length, often outdoors, often by somebody
 * who is upset, and the IMEI has to be copied out loud down a phone line digit by digit.
 * setAllCaps is applied at render so whatever the office types into settings comes out in
 * the same voice.
 */
public class LockActivity extends Activity {

    static final String EXTRA_RELEASE = "release";

    private TextView brandView;
    private TextView reasonView;
    private TextView helpView;
    private TextView imeiView;
    private TextView whyView;

    /* THE SCREEN'S OWN DOORBELL. Registered while this activity is alive, so an unlock can
       reach it without anybody having to start an activity from the background -- which is
       the thing Android 10+ may refuse in silence, and which stranded a customer's phone
       showing a lock screen while the register read "unlocked". See Guard.unlock. */
    private final android.content.BroadcastReceiver release = new android.content.BroadcastReceiver() {
        @Override public void onReceive(Context ctx, Intent i) { standDown(); }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setShowWhenLocked();
        setContentView(build());
        try {
            android.content.IntentFilter f = new android.content.IntentFilter(Guard.ACTION_RELEASE);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(release, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(release, f);
        } catch (Exception ignored) { }
        handle(getIntent());
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(release); } catch (Exception ignored) { }
        /* THE GLASS IS THE TRUTH. However this activity ended -- released, finished, or killed
           by the system to reclaim memory -- the lock screen is no longer in front of anybody,
           and the next beat must say so. If the office still wants this phone locked, that beat
           gets "lock" back and Guard.show() puts it up again, which is the loop working rather
           than a gap in it. */
        Prefs.put(this, Prefs.SCREEN_UP, false);
        super.onDestroy();
    }

    /** Leave lock task and go. Only the activity that entered it may leave it. */
    private void standDown() {
        try { stopLockTask(); } catch (Exception ignored) { }
        Prefs.put(this, Prefs.SCREEN_UP, false);
        finish();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent != null && intent.getBooleanExtra(EXTRA_RELEASE, false)) {
            // Told to stand down. Only the activity that entered lock task may leave it,
            // which is why unlocking is routed back through here rather than done in Guard.
            standDown();
            return;
        }
        refresh();
        // Recorded BEFORE the pin attempt, because the screen is in front of the customer
        // either way -- startLockTask decides whether they can leave it, not whether it shows.
        Prefs.put(this, Prefs.SCREEN_UP, true);
        try { startLockTask(); } catch (Exception ignored) {
            /* Not Device Owner -- a hand-installed test build, or provisioning that did not
               take. The screen still shows, and it can still be left. Failing softly here is
               deliberate: a crash loop on a customer's phone would be far worse than a lock
               that is weaker than intended and visibly so on the register. */
        }
    }

    /** Words from the last beat, so a phone that has heard from us shows the current message. */
    private void refresh() {
        String brand = str(Prefs.BRAND);
        if (brand.isEmpty()) brand = getString(R.string.lock_brand);
        String msg = str(Prefs.MESSAGE);
        if (msg.isEmpty()) msg = getString(R.string.lock_default);
        String help = str(Prefs.HELP_PHONE);
        String reason = str(Prefs.REASON);

        /* THE IMEI, from the register first and the modem only as a fallback. Those are two
           different facts and the register's is the useful one: it is what Sipho's stock
           report says, what the office will search on, and what an Android 10+ handset
           cannot read about itself at all unless Device Owner took properly -- which is
           precisely the phone we would most want to identify. */
        String imei = str(Prefs.IMEI);
        if (imei.isEmpty()) {
            String own = Imei.read(this);
            if (own != null) imei = own;
        }

        set(brandView, brand);
        set(reasonView, msg);
        /* The number gets its own big line ONLY when the message has not already said it.
           With the default wording it has -- "WASILIANA NASI KWA NAMBA 0700000000" -- and
           repeating it underneath looks like two different numbers at a glance. With a
           custom message that forgot to mention one, this is what stops a locked phone from
           telling somebody to get in touch without saying how. */
        set(helpView, help.isEmpty() || msg.contains(help) ? "" : help);
        set(imeiView, imei.isEmpty() ? "" : "IMEI: " + imei);
        set(whyView, reason.isEmpty() ? "" : "REASON: " + reason);
    }

    private String str(String key) {
        String v = Prefs.str(this, key, "");
        return v == null ? "" : v.trim();
    }

    /** Empty is not a blank line on a screen this short -- it is a row that is not there. */
    private void set(TextView v, String text) {
        if (v == null) return;
        v.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
        v.setText(text);
    }

    private View build() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xFF0B2A6B);
        int pad = dp(28);
        root.setPadding(pad, pad, pad, pad);

        brandView = row(root, 26, Color.WHITE, true, 0);
        reasonView = row(root, 16, 0xFFDCE6FA, false, 20);
        helpView = row(root, 22, Color.WHITE, true, 24);
        /* IMEI and REASON are the reference lines -- smaller, dimmer, and last, because they
           are what somebody reads OUT once they are already on the call. The message above
           is what they read first. Monospace on the IMEI so fifteen digits can be tracked
           with a finger without losing the place. */
        imeiView = row(root, 14, 0xFFA9BEE6, false, 22);
        imeiView.setTypeface(Typeface.MONOSPACE);
        whyView = row(root, 14, 0xFFA9BEE6, false, 6);

        /* THE ONE THING A LOCKED PHONE MUST STILL DO. Emergency calls are not ours to take
           away -- not for a debt, not for anything. The dialer opens outside lock task for
           emergency numbers, and this button is here so somebody in trouble does not have to
           know that. It is also, plainly, the law in most places. */
        Button emergency = new Button(this);
        emergency.setText("Simu ya dharura / Emergency call");
        emergency.setOnClickListener(v -> {
            try {
                startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:")));
            } catch (Exception ignored) { }
        });
        LinearLayout.LayoutParams ep = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        ep.topMargin = dp(36);
        ep.gravity = Gravity.CENTER;
        root.addView(emergency, ep);

        return root;
    }

    /**
     * One centred, ALL-CAPS line, stacked under the last. Built in code rather than XML for
     * the same reason the rest of this app is: a lock screen that fails to inflate is a
     * phone nobody can use and nobody can explain, so there is no layout file to go missing
     * and no theme attribute to be overridden by a vendor build.
     */
    private TextView row(LinearLayout root, int sp, int colour, boolean bold, int topDp) {
        TextView t = new TextView(this);
        t.setTextColor(colour);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.CENTER);
        t.setAllCaps(true);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topDp);
        root.addView(t, lp);
        return t;
    }

    /** Back does nothing. There is nowhere behind this screen to go. */
    @Override
    public void onBackPressed() { }

    private void setShowWhenLocked() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }
}
