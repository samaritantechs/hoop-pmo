package com.samaritantechs.hooploanlock;

import android.app.Activity;
import android.content.Context;
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
 * LOCKED turns a payment problem into an angry walk to a shop. So it carries the reason and
 * the number to call, both refreshed from the server on every beat -- which is also why the
 * number lives in settings rather than in this APK.
 */
public class LockActivity extends Activity {

    static final String EXTRA_RELEASE = "release";

    private TextView reasonView;
    private TextView helpView;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setShowWhenLocked();
        setContentView(build());
        handle(getIntent());
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
            try { stopLockTask(); } catch (Exception ignored) { }
            finish();
            return;
        }
        refresh();
        try { startLockTask(); } catch (Exception ignored) {
            /* Not Device Owner -- a hand-installed test build, or provisioning that did not
               take. The screen still shows, and it can still be left. Failing softly here is
               deliberate: a crash loop on a customer's phone would be far worse than a lock
               that is weaker than intended and visibly so on the register. */
        }
    }

    /** Words from the last beat, so a phone that has heard from us shows the current message. */
    private void refresh() {
        String msg = Prefs.str(this, Prefs.MESSAGE, "");
        if (msg == null || msg.isEmpty()) msg = getString(R.string.lock_default);
        String reason = Prefs.str(this, Prefs.REASON, "");
        String help = Prefs.str(this, Prefs.HELP_PHONE, "");
        if (reasonView != null) {
            reasonView.setText(reason == null || reason.isEmpty() ? msg : msg + "\n\n" + reason);
        }
        if (helpView != null) {
            helpView.setVisibility(help == null || help.isEmpty() ? View.GONE : View.VISIBLE);
            helpView.setText(help);
        }
    }

    private View build() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xFF0B2A6B);
        int pad = dp(28);
        root.setPadding(pad, pad, pad, pad);

        TextView brand = new TextView(this);
        brand.setText("HOOPLOAN");
        brand.setTextColor(Color.WHITE);
        brand.setTypeface(Typeface.DEFAULT_BOLD);
        brand.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        brand.setGravity(Gravity.CENTER);
        root.addView(brand);

        reasonView = new TextView(this);
        reasonView.setTextColor(0xFFDCE6FA);
        reasonView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        reasonView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(20);
        root.addView(reasonView, lp);

        helpView = new TextView(this);
        helpView.setTextColor(Color.WHITE);
        helpView.setTypeface(Typeface.DEFAULT_BOLD);
        helpView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        helpView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        hp.topMargin = dp(24);
        root.addView(helpView, hp);

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
