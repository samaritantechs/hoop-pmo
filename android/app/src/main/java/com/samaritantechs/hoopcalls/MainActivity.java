package com.samaritantechs.hoopcalls;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * HOOPLOAN in one app: a WebView around the portal launcher, so a leader signs in once and
 * chooses Calls or the system (dashboard, uploads) from the same place -- plus the two things
 * a plain browser tab cannot do here:
 *   1. read the device call log, so officers' calls sync automatically (HoopLoanBridge);
 *   2. hand a real file picker to the page's &lt;input type=file&gt;, which is DEAD in a WebView
 *      unless the host app implements onShowFileChooser -- that is what makes uploading the
 *      daily Expected/Defaulters workbook from the phone work at all.
 * The app carries no business logic, so the pages can change without shipping a new APK.
 */
public class MainActivity extends Activity {
    private static final int REQ_CALL_LOG = 71;
    private static final int REQ_FILE_PICK = 72;

    /* HOW LONG A BLANK SCREEN IS ALLOWED TO LAST.

         "app is blanking blue not opening"

       The WebView's background is painted navy so the status-bar strip matches the header,
       which means an empty WebView is a full navy screen -- and that is precisely what an
       officer reported. Nothing here caught it: onReceivedError fires on an ERROR, and a
       load that simply never finishes is not an error. No error, no fallback screen, no
       button: the app just sits there being blue, and the only move left is to force-stop it
       and try again, which changes nothing.

       The page itself is one self-contained file off a CDN, so twenty seconds is already
       far more than a slow 3G handset needs. Past that, something is wrong that waiting will
       not fix, and saying so beats silence. */
    private static final long LOAD_TIMEOUT_MS = 20000;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> pendingFileCallback;
    private Runnable loadWatchdog;
    private boolean pageArrived;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        /* THE PREFERENCES FILE KEEPS ITS OLD NAME, whatever the app is called now. It holds
           the device id every registered handset is known to the server by, and the saved
           access code. Renaming the file points the app at an empty one: every officer is
           signed out, and the phone comes back as a device nobody has ever seen. Nobody can
           see this string; the cost of "tidying" it is a morning of re-registrations. */
        prefs = getSharedPreferences("hopecalls", MODE_PRIVATE);

        web = new WebView(this);
        // Leave the phone's own status bar (clock, battery, signal) visible and untouched:
        // without this the page draws underneath it, so the time and battery sit on top of
        // the app's header. fitsSystemWindows insets the WebView below the system bars.
        web.setFitsSystemWindows(true);
        setContentView(web);
        // Android 15 (targetSdk 35) forces edge-to-edge and IGNORES fitsSystemWindows, so
        // the clock, battery and signal sat on top of the app's header. Pad the WebView
        // below the system bars ourselves; the padded strip is painted the header's navy,
        // so the status bar reads as part of the app -- the same look older Android gives.
        if (Build.VERSION.SDK_INT >= 30) {
            web.setBackgroundColor(0xFF0B2A6B);
            web.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars =
                        insets.getInsets(android.view.WindowInsets.Type.systemBars());
                v.setPadding(0, bars.top, 0, bars.bottom);
                return insets;
            });
        }
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage holds the access code, device id, list cache
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);           // the page never needs file:// -- keep it shut
        /* TWO NAMES FOR ONE BRIDGE, while the rename crosses over. HoopLoan is what the
           page reaches for first; HopeCalls stays so that a page deployed before this APK
           reaches a phone -- or after it, on a handset that has not updated -- still finds
           something. Same object, so there is no second copy of any state. */
        HoopLoanBridge bridge = new HoopLoanBridge(this, prefs);
        web.addJavascriptInterface(bridge, "HoopLoan");
        web.addJavascriptInterface(bridge, "HopeCalls");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if ("tel".equals(scheme)) {
                    // ACTION_DIAL opens the dialer with the number filled in -- no CALL_PHONE
                    // permission needed, and the officer always presses the green button themselves.
                    startActivity(new Intent(Intent.ACTION_DIAL, u));
                    return true;
                }
                if ("mailto".equals(scheme) || "sms".equals(scheme) || "whatsapp".equals(scheme)) {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                return false;                   // the portal itself stays inside the app
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showUrlScreen(String.valueOf(err.getDescription()));
            }

            /* A 500 or a 404 on the main frame is NOT onReceivedError -- the request
               succeeded, the server just did not send a page. Without this the WebView
               renders whatever error body came back, or nothing at all, and the officer is
               back to looking at navy. */
            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest req,
                                            android.webkit.WebResourceResponse resp) {
                if (req.isForMainFrame()) {
                    showUrlScreen("HTTP " + (resp == null ? "?" : String.valueOf(resp.getStatusCode())));
                }
            }

            /* The page arrived. Whatever the watchdog was about to say is now wrong, so
               call it off -- including when the page that arrived is the fallback screen
               itself, which must not be replaced by a second copy of itself. */
            @Override
            public void onPageFinished(WebView v, String url) {
                pageArrived = true;
                if (loadWatchdog != null) web.removeCallbacks(loadWatchdog);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = callback;
                try {
                    // params.createIntent() honours the page's own accept="" list (.xlsx/.xls/.csv).
                    startActivityForResult(params.createIntent(), REQ_FILE_PICK);
                    return true;
                } catch (Exception e) {
                    pendingFileCallback = null;
                    Toast.makeText(MainActivity.this, "Hakuna programu ya kuchagua faili.", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        // Reports the page offers for download go to the phone's Downloads folder via the
        // system DownloadManager, so they can be re-opened (or re-uploaded) like any file.
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long size) {
                /* NEVER HAND DownloadManager A blob: OR data: URL. It does not understand
                   either, it throws, and the catch below then asks Android to open that same URL
                   with an ordinary app -- which nothing can, so the app closes with no file and
                   no message. That is the "downloading JPG just closes the app" report.
                   The page saves those itself through HoopLoan.saveBase64; if one reaches here
                   at all it is from an older page, and saying so beats dying. */
                if (url != null && (url.startsWith("blob:") || url.startsWith("data:"))) {
                    Toast.makeText(MainActivity.this,
                            "Fungua mfumo kwenye Chrome kupakua faili hii / open the system in Chrome to save this file",
                            Toast.LENGTH_LONG).show();
                    return;
                }
                try {
                    String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                    r.setMimeType(mimeType);
                    r.addRequestHeader("User-Agent", userAgent);
                    r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                    r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) dm.enqueue(r);
                    Toast.makeText(MainActivity.this, "Inapakua: " + name, Toast.LENGTH_LONG).show();
                } catch (Exception e) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));   // let the browser have it
                }
            }
        });

        if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.READ_CALL_LOG}, REQ_CALL_LOG);
        }
        loadWatched(startUrl());
        // Ask the portal whether a newer build exists. Off the UI thread, failures ignored --
        // an update check must never be the reason the app does not open.
        Updater.checkInBackground(this, startUrl());
    }

    /**
     * Load a URL and start counting. Every load of the real page goes through here rather than
     * web.loadUrl, so there is no route into the app that can end in a silent navy screen.
     * Cancelled by onPageFinished; fires the built-in fallback screen if nothing ever arrives.
     */
    private void loadWatched(String url) {
        pageArrived = false;
        if (loadWatchdog != null) web.removeCallbacks(loadWatchdog);
        loadWatchdog = new Runnable() {
            @Override
            public void run() {
                if (pageArrived) return;
                showUrlScreen("Mtandao ni wa polepole sana au mfumo haujibu. "
                        + "/ The connection is very slow, or the server is not answering.");
            }
        };
        web.postDelayed(loadWatchdog, LOAD_TIMEOUT_MS);
        web.loadUrl(url);
    }

    /**
     * The saved override MUST NOT outlive the build that it was saved against. An install that
     * once pointed itself at ".../call" (via the fallback screen, back when that was the app's
     * whole job) kept loading the calls page straight after updating -- the launcher was in the
     * APK but unreachable, so signing in appeared to "go directly to calls". An override is now
     * stamped with the versionCode that saved it and is dropped when the app moves on; a stale
     * ".../call" is additionally rewritten to the site root rather than simply discarded, so a
     * genuinely different domain typed in the field survives the upgrade.
     */
    private String startUrl() {
        String saved = prefs.getString("startUrl", null);
        if (saved == null) return BuildConfig.START_URL;
        if (prefs.getInt("startUrlVersion", 0) >= BuildConfig.VERSION_CODE) return saved;
        // A new build's default WINS over anything an older build saved. HOOP's v1 pointed
        // at a Vercel-protected address, and carrying a saved copy of it forward would keep
        // a phone on the login wall through every reinstall. Anyone who genuinely runs a
        // different domain types it once more into the fallback screen.
        prefs.edit().remove("startUrl")
                    .putInt("startUrlVersion", BuildConfig.VERSION_CODE).apply();
        return BuildConfig.START_URL;
    }

    /**
     * Offline / wrong-server fallback: a tiny built-in page (no network needed) that retries,
     * or saves a different server URL to preferences -- so a changed domain never bricks the
     * installed app and never requires an APK rebuild in the field.
     */
    private void showUrlScreen(String why) {
        String current = startUrl();
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='font-family:sans-serif;background:#0B2A6B;color:#fff;padding:28px'>"
                + "<h2 style='margin:0 0 6px'>HOOPLOAN</h2>"
                + "<p style='color:#93C5FD'>Imeshindikana kufungua mfumo. Angalia mtandao wako, kisha jaribu tena.<br>"
                + "<small>" + android.text.TextUtils.htmlEncode(why == null ? "" : why) + "</small></p>"
                // This page is built by THIS build, which registers the bridge under both
                // names, so it can use the new one straight away -- unlike public/call.html,
                // which is served to older installs too and must still accept either.
                + "<button onclick='HoopLoan.retry()' style='width:100%;padding:14px;border:0;border-radius:10px;font-weight:700'>Jaribu tena / Retry</button>"
                + "<p style='color:#93C5FD;margin-top:26px'>Kama mfumo umehamia anwani mpya, iweke hapa:</p>"
                + "<input id=u value='" + android.text.TextUtils.htmlEncode(current) + "' style='width:100%;padding:12px;border-radius:10px;border:0'>"
                + "<button onclick='HoopLoan.setStartUrl(document.getElementById(\"u\").value)' "
                + "style='width:100%;padding:14px;border:0;border-radius:10px;font-weight:700;margin-top:10px'>Hifadhi &amp; fungua / Save &amp; open</button>"
                + "</body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /* Watched, like the first load. Retry is pressed FROM the fallback screen, so if it went
       back to an unwatched load the officer would be dropped into the same silent navy screen
       with the button they just used now gone -- a dead end reached by trying to escape one. */
    void retryFromBridge() {
        runOnUiThread(() -> loadWatched(startUrl()));
    }

    void setStartUrlFromBridge(String url) {
        String u = url == null ? "" : url.trim();
        if (!u.startsWith("http")) u = "https://" + u;
        prefs.edit().putString("startUrl", u).putInt("startUrlVersion", BuildConfig.VERSION_CODE).apply();
        final String go = u;
        runOnUiThread(() -> loadWatched(go));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_PICK) {
            // The callback MUST be answered even on cancel, or the page's file input stays
            // permanently stuck and no further pick is possible until a reload.
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] grants) {
        super.onRequestPermissionsResult(code, perms, grants);
        // The page checks hasCallLogPermission() on every sync -- reload so its banner updates now.
        if (code == REQ_CALL_LOG) web.reload();
    }
}
