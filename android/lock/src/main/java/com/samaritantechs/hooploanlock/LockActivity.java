package com.samaritantechs.hooploanlock;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
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
 * THE THREE LINES, specified by the person who has to answer the calls:
 *
 *     HOOP LIMITED
 *     SIMU HII IMEFUNGWA NA HOOP LIMITED. WASILIANA NASI KWA NAMBA 0700000000
 *     IMEI: 351388334583295
 *
 * Not one of those words is compiled into this APK. The company name, the number and the
 * message all arrive on the heartbeat and are stored, because a handset in somebody's pocket
 * for eighteen months cannot wait for an app release when the office changes its phone
 * number. This class owns the LAYOUT; device-core.js owns the WORDS.
 *
 * THERE USED TO BE A FOURTH LINE, "REASON: ...", and it is gone on purpose:
 * "DROP THE REASON FILLING AND ITS DATA SINCE THE MESSAGE IS ENOUGH". It could name an
 * accused employee, or simply restate what the message above already said -- either way it
 * was internal information painted onto a screen any stranger holding the phone can read.
 * The reason a phone is locked still exists: it is typed at Funga where the operator wants
 * to, still on the row's own history in the portal. It is simply not this screen's business
 * any more.
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
    /* Kept so a repaint can swap the MARK as well as the words. Null when the office said
       "no mark" at build time -- see build() and refreshLogo(). */
    private ImageView logoView;

    /* THE RADIO, FROM THIS SCREEN -- see radios(). netView is the one line under the two
       buttons that says whether the phone can hear the office right now, and what a button
       press did. Everything below it exists so a customer who turns the network on is not
       left waiting a quarter of an hour for the beat that would free or move their phone. */
    private TextView netView;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /* When one of OUR two buttons last opened a system panel, and 0 otherwise. The emergency
       button never sets it: a screen that pulled itself back over a live emergency call would
       take the hang-up button away from somebody who needs it. */
    private long panelOpenedAt = 0;
    private boolean inFront = false;
    private long lastNetBeat = 0;
    private ConnectivityManager.NetworkCallback netWatch;
    /* HOW LONG A PANEL MAY STAY IN FRONT. Settings has to be reachable for the panel to open
       at all (LockAdmin.harden allowlists it for lock task), and a panel has a way into the
       rest of Settings -- so the locked screen puts itself back on top after this long, and
       the moment a network comes up. Long enough to type a Wi-Fi password twice. */
    private static final long PANEL_MS = 90_000L;
    private final Runnable comeback = () -> {
        if (inFront || isFinishing()) return;
        if (!Prefs.of(this).getBoolean(Prefs.LOCKED, false)) return;
        Guard.show(getApplicationContext());
    };

    /* THE SCREEN'S OWN DOORBELL. Registered while this activity is alive, so an unlock can
       reach it without anybody having to start an activity from the background -- which is
       the thing Android 10+ may refuse in silence, and which stranded a customer's phone
       showing a lock screen while the register read "unlocked". See Guard.unlock. */
    private final BroadcastReceiver release = new BroadcastReceiver() {
        @Override public void onReceive(Context ctx, Intent i) {
            if (Guard.ACTION_REPAINT.equals(i == null ? null : i.getAction())) {
                /* Re-locked, under a new reason, while this screen was already up. The words
                   come from the beat and are read at build time, so without this the customer
                   goes on reading the previous reason -- and the register and the glass give
                   two different answers to the only question this screen exists to settle. */
                refresh();
                return;
            }
            standDown();
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setShowWhenLocked();
        setContentView(build());
        try {
            IntentFilter f = new IntentFilter(Guard.ACTION_RELEASE);
            f.addAction(Guard.ACTION_REPAINT);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(release, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(release, f);
        } catch (Exception ignored) { }
        watchNetwork();
        handle(getIntent());
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(release); } catch (Exception ignored) { }
        unwatchNetwork();
        ui.removeCallbacksAndMessages(null);
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

    /* Whatever else happened while this screen was away -- a beat with new words, a repaint
       that arrived while the process was being rebuilt -- the glass is repainted from the
       stored words every time it comes back to the front. Cheap, and it closes the gap
       between "the broadcast reached us" and "the broadcast reached us in time". */
    @Override
    protected void onResume() {
        super.onResume();
        refresh();
        inFront = true;
        ui.removeCallbacks(comeback);
        panelOpenedAt = 0;
    }

    /* Paused by a panel one of our buttons opened: arm the return. Paused by anything else --
       the emergency dialer, the system -- nothing is armed, exactly as before. */
    @Override
    protected void onPause() {
        super.onPause();
        inFront = false;
        if (panelOpenedAt > 0) ui.postDelayed(comeback, PANEL_MS);
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
        refreshLogo();
        refreshNet();
        /* NO REASON LINE. There used to be one here -- "REASON: STOCK, UNSOLD", or worse,
           naming an accused employee by name on a screen anybody who picks the phone up can
           read. "DROP THE REASON FILLING AND ITS DATA SINCE THE MESSAGE IS ENOUGH": whoever
           is holding a locked phone needs to know who it belongs to and how to reach them --
           `msg` already says both -- not the internal story behind the lock. That story
           still exists, on the row's own history; it simply no longer gets painted onto
           glass a stranger can read. */
    }

    /* THE MARK CHANGES WITH THE WORDS, ON A SCREEN THAT IS ALREADY UP.
       -----------------------------------------------------------------------------------
         "transfereed stock from Hoop to Hope should switch lock logo to Hope"

       A handset shifted to the other office while LOCKED kept drawing the old office's mark
       above the new office's name until it was unlocked and re-locked, or rebooted: the words
       repaint on every beat (refresh(), above), but the logo was chosen once, in build(), and
       this activity is singleInstance -- a later show() reaches onNewIntent, never onCreate.
       Two companies on one screen, for as long as a customer stayed locked. LockLogo.apply
       has already fetched the new office's mark by the time Guard.lock broadcasts the repaint
       (Beat.apply calls it first), so re-reading the file here is all it takes.

       The three answers stay apart exactly as build() keeps them: a mark the office sent, the
       mark compiled in when no office ever said, and nothing at all when the office said none
       -- falling back is how HOOP's mark lands on a HOPE phone, so "none" hides the view rather
       than showing the drawable. A view that was never built (told "none" at creation) stays
       absent; the next re-lock builds it. Every failure is swallowed: a logo may never cost a
       lock screen its words. */
    private void refreshLogo() {
        try {
            if (logoView == null) return;
            if (LockLogo.suppressed(this)) { logoView.setVisibility(View.GONE); return; }
            android.graphics.Bitmap sent = LockLogo.bitmap(this);
            if (sent != null) logoView.setImageBitmap(sent);
            else logoView.setImageResource(R.drawable.hoop_logo_white);
            logoView.setVisibility(View.VISIBLE);
        } catch (Throwable ignored) { }
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

        /* THE MARK, ABOVE THE NAME IT NAMES.
           -------------------------------------------------------------------------------
           "put HOOP logo above the title on locked info that displays: the white png since
            the bg is already full blue"

           res/drawable-nodpi/hoop_logo_white.png is generated by scripts/make-white-logo.py
           from brand/hoop-logo.png -- the SAME wordmark shapes as the launcher icon and
           every other HOOP mark in this repo, every inked pixel turned white rather than
           hand-redrawn, so this can never quietly drift from the brand file. The source art
           is navy-on-white, built for a white ground; this screen's ground is navy
           (0xFF0B2A6B, set below), so the navy ink is what has to change, not the background
           behind it -- a white PNG on this background needs no box of its own, it is just
           ink with nothing around it.

           adjustViewBounds, not a fixed width and height: the PNG is trimmed tight to its
           ink by the generator, at a resolution well above anything this shows at, so
           Android only ever scales it DOWN to whatever the requested height allows --
           downscaling is always sharp; only upscaling would blur, and nothing here upscales.
           Missing the resource (a build that skipped the generator) must not blank the
           screen the office phone number lives on, so a failed load is caught and the logo
           is simply absent rather than crashing what a locked customer is staring at. */
        /* WHOSE MARK IT IS, IS THE SERVER'S TO SAY, because one APK serves two companies. The
           drawable above is now the FALLBACK rather than the answer: a handset told which mark
           to draw draws that one, a handset told to draw NONE draws none, and a handset nobody
           has ever told anything goes on showing exactly what it always showed.

           The three cases are kept apart deliberately. Collapsing "told none" into "not told"
           is precisely how HOOP's wordmark ends up sitting above the words "HOPE MICROCREDIT"
           on a HOPE officer's locked phone -- two companies on one screen, in front of
           somebody deciding whether this is their employer or a scam. See LockLogo. */
        try {
            if (!LockLogo.suppressed(this)) {
                ImageView logo = new ImageView(this);
                android.graphics.Bitmap sent = LockLogo.bitmap(this);
                if (sent != null) logo.setImageBitmap(sent);
                else logo.setImageResource(R.drawable.hoop_logo_white);
                logo.setAdjustViewBounds(true);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, dp(48));
                root.addView(logo, lp);
                logoView = logo;
            }
        } catch (Exception ignored) { }

        brandView = row(root, 26, Color.WHITE, true, 0);
        reasonView = row(root, 16, 0xFFDCE6FA, false, 20);
        helpView = row(root, 22, Color.WHITE, true, 24);
        /* THE IMEI is the last, reference line -- smaller than the message above it (that is
           still what somebody reads first), but white and bold rather than dim: it is what
           gets read OUT, digit by digit, down a phone line, and a dim grey-blue line was hard
           to read off the screen in that moment. Monospace so fifteen digits can be tracked
           with a finger without losing the place; setTypeface(MONOSPACE, BOLD) keeps both,
           since a plain setTypeface(MONOSPACE) would otherwise drop the bold row() just set.
           No REASON line under it any more -- see refresh(). */
        imeiView = row(root, 14, Color.WHITE, true, 22);
        imeiView.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);

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

        radios(root);
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

    /* THE RADIO, FROM THE LOCKED SCREEN.
       =====================================================================================
         "we don't have the grace period to go switch on wifi or data since theirs beats the
          phone in seconds after power on. so we need to give both the wifi and data buttons
          on top of our lock, leaving the grace period behind"

       A locked phone that cannot reach the office cannot be unlocked, released or moved --
       and the person holding it could not help, because this screen is pinned and Settings
       is behind it. The boot window (Guard.openWindow) was the answer: a few minutes of
       ordinary use after a power cycle, long enough to pull the shade down. It stopped being
       one the day a second lock arrived on the same stock: Knox Guard takes the screen within
       seconds of boot, so the window opens onto a screen the customer cannot use either.

       So the two toggles live HERE, on the only screen that is reliably in front:

         WIFI   switches the radio on ourselves -- a Device Owner may (Net.wifiOn), and a radio
                that is on rejoins any network this phone already knows -- then opens the
                system's own Wi-Fi panel for a new network.
         DATA   opens the system's internet panel, which carries the mobile-data switch. There
                is no API for an app, Device Owner or not, to flip mobile data itself; the
                panel is the sanctioned way and the same one the other lock's button uses.

       WHY THE PANEL OPENS AT ALL: this activity is singleInstance, so anything it starts lands
       in a NEW task, and lock task refuses a new task from a package that is not allowlisted --
       silently: the start returns a code rather than throwing. LockAdmin.harden therefore
       allowlists Settings alongside this package. That is a door into Settings, so it is a
       short one: the screen pulls itself back on top after PANEL_MS, and the moment a network
       comes up (see networkBack). What Settings can do to us in that time is bounded by the
       platform, not by hope: a Device Owner is a protected package -- its data cannot be
       cleared, it cannot be disabled, force-stopped or uninstalled -- and the restrictions
       LockAdmin holds stay held.

       AND THE PHONE SPEAKS THE MOMENT IT CAN. A network callback (watchNetwork) beats at once
       when connectivity returns, so the unlock, release or shift the office already ordered
       lands in seconds rather than at the next quarter-hour -- which is what the boot window
       was really for. A silent refusal to open the panel is caught and SAID (openPanel): the
       screen is still in front a moment later, so the customer is told, not left tapping. */
    private void radios(LinearLayout root) {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        Button wifi = new Button(this);
        wifi.setText("Washa WiFi / Wi-Fi on");
        wifi.setOnClickListener(v -> wifiPressed());
        Button data = new Button(this);
        data.setText("Data za simu / Mobile data");
        data.setOnClickListener(v -> dataPressed());
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        bp.leftMargin = dp(6);
        bp.rightMargin = dp(6);
        bar.addView(wifi, bp);
        bar.addView(data, bp);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        root.addView(bar, lp);
        /* Mixed case, unlike the lines above: this is a sentence to act on, not a name to read
           out, and a two-language sentence in capitals is the one thing on this screen that
           is genuinely hard to read. */
        netView = row(root, 12, 0xFFFFD27A, false, 8);
        netView.setAllCaps(false);
    }

    private void wifiPressed() {
        boolean on = Net.wifiOn(this);
        say(on ? "WiFi imewashwa — chagua mtandao / Wi-Fi is on — pick a network"
               : "WiFi haikuwashika hapa — washa kwenye kidirisha / Wi-Fi could not be switched on here — use the panel");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            openPanel(android.provider.Settings.Panel.ACTION_WIFI, android.provider.Settings.ACTION_WIFI_SETTINGS);
        } else {
            openPanel(android.provider.Settings.ACTION_WIFI_SETTINGS);
        }
    }

    private void dataPressed() {
        say("Washa data za simu kwenye kidirisha / Turn mobile data on in the panel");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            openPanel(android.provider.Settings.Panel.ACTION_INTERNET_CONNECTIVITY,
                    android.provider.Settings.ACTION_DATA_ROAMING_SETTINGS,
                    android.provider.Settings.ACTION_WIRELESS_SETTINGS);
        } else {
            openPanel(android.provider.Settings.ACTION_DATA_ROAMING_SETTINGS,
                    android.provider.Settings.ACTION_WIRELESS_SETTINGS);
        }
    }

    /** The first of these that resolves. A lock-task refusal does NOT throw -- the start is
        simply dropped -- so if this screen is still in front a moment later, that is what
        happened, and it is said on the screen rather than left as a button that does nothing. */
    private void openPanel(String... actions) {
        panelOpenedAt = System.currentTimeMillis();
        for (String a : actions) {
            try {
                startActivity(new Intent(a));
                ui.postDelayed(() -> {
                    if (!inFront || panelOpenedAt == 0) return;
                    panelOpenedAt = 0;
                    say(Net.online(this) ? "Mtandao upo / Online"
                        : "Kidirisha hakikufunguka. WiFi ikiwashwa huunganisha mtandao unaojulikana yenyewe. "
                          + "/ The panel could not open. Wi-Fi, once on, joins a known network by itself.");
                }, 1500);
                return;
            } catch (Exception ignored) { }
        }
        panelOpenedAt = 0;
        say("Simu hii haina kidirisha cha mtandao / This phone offers no network panel");
    }

    private void say(String text) {
        try { set(netView, text); } catch (Exception ignored) { }
    }

    /** The standing line under the buttons: can this phone hear the office right now. */
    private void refreshNet() {
        try {
            if (netView == null) return;
            boolean on = Net.online(this);
            set(netView, on ? "Mtandao upo / Online"
                : "Hakuna mtandao — washa WiFi au data ili simu isikie ofisi. / No network — turn on Wi-Fi or data so this phone can hear the office.");
            netView.setTextColor(on ? 0xFF9BE7B0 : 0xFFFFD27A);
        } catch (Exception ignored) { }
    }

    /* The network coming back is the event this whole screen waits for. Two beats, because the
       first can land before the connection has finished validating; the second is long enough
       after for a captive portal or a slow DNS to have settled, and both are cheap. Then the
       screen comes back over whichever panel the customer is still in: the network is up, which
       is all the panel was for, and the office's answer is seconds away. */
    private void networkBack() {
        refreshNet();
        long now = System.currentTimeMillis();
        if (now - lastNetBeat < 20_000L) return;
        lastNetBeat = now;
        final Context app = getApplicationContext();
        ui.postDelayed(() -> Beat.now(app, false), 1500);
        ui.postDelayed(() -> Beat.now(app, false), 12_000);
        if (!inFront && panelOpenedAt > 0) ui.postDelayed(comeback, 4000);
    }

    private void watchNetwork() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            netWatch = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) { ui.post(() -> networkBack()); }
                @Override public void onLost(Network n) { ui.post(() -> refreshNet()); }
            };
            cm.registerDefaultNetworkCallback(netWatch);
        } catch (Exception ignored) { netWatch = null; }
    }

    private void unwatchNetwork() {
        try {
            if (netWatch == null) return;
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(netWatch);
        } catch (Exception ignored) { }
        netWatch = null;
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
