package com.samaritantechs.hooploanlock;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update, the same shape as HOOP Calls' -- one version file at the repo root, served
 * back to the installed app so the two can never drift -- with one deliberate difference:
 * this one does not ask.
 *
 * The calls app prompts an officer, because an officer is holding it and a surprise install
 * mid-call would be worse than a tap. Nobody is holding a locked handset in a customer's
 * drawer, and a prompt nobody will ever answer means that phone stays on an old build for
 * the rest of its loan. As Device Owner, Android performs the install without asking anyone,
 * which is exactly the right behaviour here and the wrong behaviour there.
 *
 * BEST EFFORT, AND SAID SO. If the silent install is refused -- a vendor build that does it
 * differently, a phone where provisioning half-took -- the phone simply keeps running what it
 * has. It is not stranded and it is not broken: it goes on beating, and it keeps reporting
 * its app_version, so the register shows exactly which handsets are behind rather than
 * leaving anybody to guess.
 */
class SelfUpdate {

    private static final String SESSION_DONE = "com.samaritantechs.hooploanlock.INSTALL_DONE";

    static void check(Context c) {
        if (Prefs.of(c).getBoolean(Prefs.RETIRED, false)) return;
        try {
            JSONObject j = fetch(Prefs.server(c) + "/api/lock-version");
            if (j == null) return;
            int remote = j.optInt("versionCode", 0);
            if (remote <= BuildConfig.VERSION_CODE) return;          // already current
            String url = j.optString("apkUrl", "");
            if (url.isEmpty()) return;
            install(c, url);
        } catch (Exception ignored) {
            // An update check must never be able to break a working lock.
        }
    }

    private static void install(Context c, String url) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            params.setInstallReason(android.content.pm.PackageManager.INSTALL_REASON_POLICY);
        }
        int sessionId = pi.createSession(params);
        PackageInstaller.Session session = pi.openSession(sessionId);

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(60000);
        try {
            if (conn.getResponseCode() != 200) { session.abandon(); return; }
            InputStream in = conn.getInputStream();
            OutputStream out = session.openWrite("apk", 0, -1);
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            session.fsync(out);
            out.close();
            in.close();
        } finally {
            conn.disconnect();
        }

        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent done = PendingIntent.getBroadcast(c, sessionId,
                new Intent(SESSION_DONE).setPackage(c.getPackageName()), flags);
        // As Device Owner this completes with no dialog. If the platform refuses, the session
        // fails and we are still running the build we already had -- see the note above.
        session.commit(done.getIntentSender());
        session.close();
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
}
