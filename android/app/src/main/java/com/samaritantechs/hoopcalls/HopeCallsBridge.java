package com.samaritantechs.hoopcalls;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.CallLog;
import android.content.ContentValues;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;

/**
 * The exact contract public/call.html programs against (see its "native bridge" comment):
 *   getDeviceId()                    stable per install
 *   getCalls(sinceMs, max)           JSON [{ts,dur,dir:"in"|"out",num,outcome}] from the call log
 *   getWatermark()/setWatermark(ms)  last-synced timestamp (server dedups by id regardless)
 *   hasCallLogPermission()           '1' / '0'
 *   getManufacturer()                for the OEM battery-settings guidance
 *   isIgnoringBatteryOptimizations() / requestIgnoreBatteryOptimizations()
 * Everything returns strings/primitives -- the WebView bridge marshals nothing fancier.
 */
public class HopeCallsBridge {
    private final MainActivity activity;
    private final SharedPreferences prefs;

    HopeCallsBridge(MainActivity activity, SharedPreferences prefs) {
        this.activity = activity;
        this.prefs = prefs;
    }

    @JavascriptInterface
    public String getDeviceId() {
        String id = prefs.getString("deviceId", null);
        if (id == null) {
            id = "a" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            prefs.edit().putString("deviceId", id).apply();
        }
        return id;
    }

    @JavascriptInterface
    public String getCalls(double sinceMs, int max) {
        JSONArray out = new JSONArray();
        if (!has(android.Manifest.permission.READ_CALL_LOG)) return out.toString();
        try (Cursor c = activity.getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                new String[]{CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE, CallLog.Calls.NUMBER},
                CallLog.Calls.DATE + " >= ?",
                new String[]{String.valueOf((long) sinceMs)},
                CallLog.Calls.DATE + " DESC")) {
            if (c != null) {
                int n = 0;
                while (c.moveToNext() && n < Math.max(1, max)) {
                    JSONObject o = new JSONObject();
                    int type = c.getInt(2);
                    o.put("ts", c.getLong(0));
                    o.put("dur", c.getLong(1));
                    o.put("dir", type == CallLog.Calls.OUTGOING_TYPE ? "out" : "in");
                    o.put("num", c.getString(3) == null ? "" : c.getString(3));
                    o.put("outcome", outcomeOf(type));
                    out.put(o);
                    n++;
                }
            }
        } catch (Exception ignored) { /* a broken provider yields an empty sync, never a crash */ }
        return out.toString();
    }

    private static String outcomeOf(int type) {
        if (type == CallLog.Calls.MISSED_TYPE) return "MISSED";
        if (type == CallLog.Calls.REJECTED_TYPE) return "REJECTED";
        if (type == CallLog.Calls.BLOCKED_TYPE) return "BLOCKED";
        return "CONNECTED";
    }

    @JavascriptInterface
    public String getWatermark() { return String.valueOf(prefs.getLong("watermark", 0L)); }

    @JavascriptInterface
    public void setWatermark(String ms) {
        try { prefs.edit().putLong("watermark", Long.parseLong(ms)).apply(); } catch (Exception ignored) {}
    }

    @JavascriptInterface
    public String hasCallLogPermission() {
        return has(android.Manifest.permission.READ_CALL_LOG) ? "1" : "0";
    }

    @JavascriptInterface
    public String getManufacturer() { return Build.MANUFACTURER == null ? "" : Build.MANUFACTURER; }

    @JavascriptInterface
    public String isIgnoringBatteryOptimizations() {
        PowerManager pm = (PowerManager) activity.getSystemService(android.content.Context.POWER_SERVICE);
        return (pm != null && pm.isIgnoringBatteryOptimizations(activity.getPackageName())) ? "1" : "0";
    }

    @JavascriptInterface
    public void requestIgnoreBatteryOptimizations() {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(i);
        } catch (Exception ignored) {}
    }

    /**
     * SAVE A FILE THE PAGE BUILT ITSELF.
     *
     * Reports, JPGs and spreadsheets are built in the browser, so the page holds the bytes and
     * has nowhere to put them. Its ordinary way out -- an anchor with a download attribute --
     * produces a blob: URL, which goes to Android's DownloadManager, which does not understand
     * blob: and throws. The fallback then tries to open that URL with an ordinary app, nothing
     * on the handset can, and the process goes down: the app closes with no file and no message.
     *
     * So the bytes come here instead, base64 in a string, and are written to the phone's own
     * Downloads folder -- MediaStore on Android 10 and later, which needs no storage permission,
     * and the plain public directory before that.
     *
     * Returns "OK <name>" or "ERR <reason>". The page shows whichever it gets; a save that fails
     * silently is the thing this method exists to stop.
     */
    @JavascriptInterface
    public String saveBase64(String name, String mime, String base64) {
        try {
            if (name == null || name.trim().isEmpty()) name = "hope-download";
            // Anything that could climb out of Downloads is stripped rather than trusted.
            name = name.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (mime == null || mime.isEmpty()) mime = "application/octet-stream";

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = activity.getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "ERR could not create the file";
                OutputStream out = activity.getContentResolver().openOutputStream(uri);
                if (out == null) return "ERR could not open the file";
                out.write(bytes);
                out.close();
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists() && !dir.mkdirs()) return "ERR no Downloads folder";
                FileOutputStream out = new FileOutputStream(new File(dir, name));
                out.write(bytes);
                out.close();
            }
            final String shown = name;
            activity.runOnUiThread(() ->
                    Toast.makeText(activity, "Imehifadhiwa Downloads: " + shown, Toast.LENGTH_LONG).show());
            return "OK " + name;
        } catch (Exception e) {
            return "ERR " + e.getMessage();
        }
    }

    /* ---- used by the built-in offline/URL screen, not by call.html ---- */
    @JavascriptInterface
    public void retry() { activity.retryFromBridge(); }

    @JavascriptInterface
    public void setStartUrl(String url) { activity.setStartUrlFromBridge(url); }

    private boolean has(String perm) {
        return activity.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }
}
