package com.samaritantechs.hoopcalls;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;


import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update. Officers cannot be asked to sideload a new APK by hand every time the system
 * changes, so on each launch the app asks the portal what the current build is
 * (/api/app-version, served from the same app-version.json that stamped this APK's own
 * versionCode) and, when it is behind, downloads and offers to install it.
 *
 * Deliberately conservative: it never installs silently. Android would not allow that for a
 * sideloaded app anyway, and a surprise install mid-call would be worse than a tap.
 */
class Updater {
    private static final String PREF_SKIPPED = "skippedVersion";
    private static final String PREF_TRIED = "triedVersion";
    private static final String PREF_SKIPPED_AT = "skippedAt";
    /** How long "Later" holds. A day: long enough not to nag, short enough that a
        declined update is never a permanent dead end. */
    private static final long SKIP_FOR_MS = 24L * 60 * 60 * 1000;

    static void checkInBackground(final MainActivity activity, final String baseUrl) {
        new Thread(() -> {
            try {
                JSONObject j = fetch(baseUrl.replaceAll("/+$", "") + "/api/app-version");
                if (j == null) return;
                final int remote = j.optInt("versionCode", 0);
                if (remote <= BuildConfig.VERSION_CODE) return;              // already current
                final String url = j.optString("apkUrl", "");
                final String notes = j.optString("notes", "");
                final String name = j.optString("versionName", String.valueOf(remote));
                if (url.isEmpty()) return;
                // "Later" quietens the prompt for this version -- but only for a day, not
                // forever. It used to be permanent, and a single tap on Later (easy to give a
                // prompt that was, at the time, offering a build that could not install) meant
                // that handset would never be told about that version again. The officer is
                // then stranded on an old build with no way back to the offer.
                int skipped = activity.getSharedPreferences("hopecalls", Context.MODE_PRIVATE).getInt(PREF_SKIPPED, 0);
                long skippedAt = activity.getSharedPreferences("hopecalls", Context.MODE_PRIVATE).getLong(PREF_SKIPPED_AT, 0);
                if (skipped == remote && System.currentTimeMillis() - skippedAt < SKIP_FOR_MS) return;
                // Have we already been round this loop for THIS version and come back still
                // running the old build? Then the install did not take -- a download that
                // served a stale file, or "install unknown apps" never granted -- and asking
                // again in the same words just teaches people to dismiss the dialog. Say what
                // actually happened instead.
                int tried = activity.getSharedPreferences("hopecalls", Context.MODE_PRIVATE).getInt(PREF_TRIED, 0);
                final boolean failedBefore = tried == remote;
                activity.runOnUiThread(() -> prompt(activity, remote, name, notes, url, failedBefore));
            } catch (Exception ignored) {
                // An update check must never break the app: no network, bad JSON, anything -> skip.
            }
        }).start();
    }

    private static JSONObject fetch(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        try {
            if (c.getResponseCode() != 200) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            return new JSONObject(sb.toString());
        } finally {
            c.disconnect();
        }
    }

    private static void prompt(final MainActivity activity, final int versionCode,
                               String versionName, String notes, final String url,
                               boolean failedBefore) {
        String body = "HOOP PMO " + versionName + "\n\n" + notes;
        if (failedBefore) {
            body = "Usasishaji uliopita haukukamilika — bado unatumia toleo la zamani.\n"
                 + "Ruhusu \"Sakinisha programu zisizojulikana\" kwa HOOP PMO, kisha jaribu tena.\n\n"
                 + "The last update did not finish, so this is still the old build. Allow "
                 + "\"Install unknown apps\" for HOOP PMO, then try again.\n\n"
                 + "HOOP PMO " + versionName + "\n" + notes;
        }
        new AlertDialog.Builder(activity)
                .setTitle(failedBefore ? "Usasishaji haukukamilika / Update did not finish"
                                       : "Toleo jipya / Update available")
                .setMessage(body)
                .setCancelable(false)
                .setPositiveButton("Sasisha / Update", (d, w) -> {
                    // Remembered BEFORE the download, so a launch that comes back on the old
                    // build knows the attempt was made and can say so.
                    activity.getSharedPreferences("hopecalls", Context.MODE_PRIVATE)
                            .edit().putInt(PREF_TRIED, versionCode).apply();
                    download(activity, url);
                })
                .setNegativeButton("Baadaye / Later", (d, w) ->
                        activity.getSharedPreferences("hopecalls", Context.MODE_PRIVATE)
                                .edit().putInt(PREF_SKIPPED, versionCode)
                                .putLong(PREF_SKIPPED_AT, System.currentTimeMillis()).apply())
                .show();
    }

    /** The browser does the download and Android's own installer takes over -- one
        the system asks to install, exactly as any sideloaded APK does. */
    private static void download(final MainActivity activity, String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            Toast.makeText(activity,
                "Inapakua toleo jipya kwenye browser \u2014 likiisha, gusa faili kuisakinisha. "
                + "/ Downloading in the browser \u2014 tap the finished file to install.",
                Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(activity, "Fungua " + url + " kwenye browser.", Toast.LENGTH_LONG).show();
        }
    }
}
