package com.addakhana.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Adda Khana for Android: the web app in a full-screen WebView, plus what a
 * browser would do for it (microphone and camera for calls, the file picker,
 * downloads, full-screen video, the back button, outside links, an offline
 * page, system bars in the page's colours) and what a messenger needs on top:
 * notifications, ringing for calls, calls in the background and screen
 * sharing (see the other classes, and client/src/lib/native.ts for the page's side).
 *
 * There is one page per app. It outlives this activity during a call or
 * screen share, so swiping the app away doesn't hang up; a new activity picks
 * the same page up again.
 */
public class MainActivity extends Activity {
    static final String ACTION_OPEN = "com.addakhana.app.OPEN";
    static final String ACTION_ANSWER = "com.addakhana.app.ANSWER";
    static final String EXTRA_PATH = "path";

    private static final int REQUEST_FILES = 1;
    private static final int REQUEST_MEDIA = 2;
    private static final int REQUEST_STORAGE = 3;
    private static final int REQUEST_SCREEN = 4;
    private static final int REQUEST_NOTIFY = 5;

    // ── The page (one per app) ─────────────────────────────────────────
    // Created on a MutableContextWrapper, pointed at whichever activity shows it.
    @SuppressLint("StaticFieldLeak")
    private static WebView page;
    @SuppressLint("StaticFieldLeak")
    private static MutableContextWrapper pageContext;
    /**
     * Events for the page, kept until the page confirms each one (AddaNative.ack),
     * so none is lost to a page that's loading or reloading; a page that says
     * it's ready (AddaNative.ready) gets every unconfirmed one again.
     */
    private static final List<PageEvent> pending = new ArrayList<>();
    private static long lastEventId;

    private static final class PageEvent {
        final long id = ++lastEventId;
        final long at = System.currentTimeMillis();
        final String json;

        PageEvent(String json) {
            this.json = json;
        }
    }
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final String APP_ORIGIN = origin(Uri.parse(BuildConfig.APP_URL));

    // Screen sharing: frames go to the page through a message port.
    private static WebMessagePort screenPort;
    private static final AtomicInteger screenBacklog = new AtomicInteger();
    private static volatile boolean screenWaitForKey;

    private FrameLayout root;
    private FrameLayout fullscreenHolder;
    /** Where the page was, kept when Android closes the app in the background. */
    private static final String STATE_URL = "page-url";

    private WebView web;
    private String failedUrl;

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingMediaRequest;
    private PendingDownload pendingDownload;
    private int barColor = 0xFF090C1A;
    private boolean darkBars = true;
    private Object backCallback; // OnBackInvokedCallback (Android 13+)
    private boolean backClaimed;
    private boolean askedNotifications;

    private static final class PendingDownload {
        final String url, userAgent, disposition, mime;
        PendingDownload(String url, String userAgent, String disposition, String mime) {
            this.url = url;
            this.userAgent = userAgent;
            this.disposition = disposition;
            this.mime = mime;
        }
    }

    private static String origin(Uri uri) {
        return uri.getScheme() + "://" + uri.getAuthority();
    }

    // ── Setup ──────────────────────────────────────────────────────────

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.AppTheme);
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(barColor);
        boolean fresh = page == null;
        if (fresh) {
            createPage(this);
            Updater.clean(this);
        } else {
            pageContext.setBaseContext(this);
        }
        web = page;
        if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(this::download);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        fullscreenHolder = new FrameLayout(this);
        fullscreenHolder.setBackgroundColor(Color.BLACK);
        fullscreenHolder.setVisibility(View.GONE);
        root.addView(fullscreenHolder, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setUpEdgeToEdge();

        if (fresh) {
            String path = pathFrom(getIntent());
            // Android closed the app in the background: open where it was. A fresh load,
            // not WebView's restoreState, which would show a stale copy of the page.
            String was = savedInstanceState != null ? savedInstanceState.getString(STATE_URL) : null;
            if (path == null && was != null && isAppUrl(Uri.parse(was))) web.loadUrl(was);
            else web.loadUrl(BuildConfig.APP_URL + (path != null ? path : ""));
        }
        handleIntent(getIntent(), fresh);
        updateBack();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private static void createPage(Activity activity) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        pageContext = new MutableContextWrapper(activity);
        page = new WebView(pageContext);
        // No white flash before the (dark-first) page paints.
        page.setBackgroundColor(0xFF090C1A);
        WebSettings s = page.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Calls ring and play, and watch-together starts, without an extra tap.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " AddaKhanaApp/" + BuildConfig.VERSION_NAME);
        // An app, not a web page: no pinch zoom, no glow when pulling past the
        // top or bottom (the page's own lists stretch instead).
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        page.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Calls and live streams keep running with the screen off or another app in front.
        if (Build.VERSION.SDK_INT >= 26) page.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(page, true);
        page.addJavascriptInterface(new Bridge(activity.getApplicationContext()), "AddaNative");
    }

    /** The page is gone for good (closed with nothing running, or its renderer died). */
    private static void destroyPage() {
        if (page == null) return;
        WebView p = page;
        page = null;
        pending.clear();
        if (p.getParent() instanceof ViewGroup) ((ViewGroup) p.getParent()).removeView(p);
        p.destroy();
    }

    // ── Opened from a notification or the call screen ──────────────────

    private static String pathFrom(Intent intent) {
        if (intent == null) return null;
        // A shared room invite link (https://<server>/join/CODE) opened in the app.
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null && isAppUrl(intent.getData())) {
            String path = intent.getData().getPath();
            return path != null && path.matches("/join/[A-Za-z0-9-]{1,16}") ? path : null;
        }
        if (!ACTION_OPEN.equals(intent.getAction())) return null;
        String path = intent.getStringExtra(EXTRA_PATH);
        return path != null && path.startsWith("/") && !path.startsWith("//") ? path : null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent, false);
    }

    /** `loaded`: the page was just opened at the intent's path already. */
    private void handleIntent(Intent intent, boolean loaded) {
        if (intent == null) return;
        if (ACTION_ANSWER.equals(intent.getAction())) {
            String callId = intent.getStringExtra("callId");
            if (!ActionReceiver.isId(callId)) return;
            IncomingCall.stopRinging(this, callId);
            send(Push.event("answer").put("callId", callId).put("video", intent.getBooleanExtra("video", false)));
            // Handled; a later restart of this activity mustn't answer again.
            intent.setAction(Intent.ACTION_MAIN);
        } else {
            String path = pathFrom(intent);
            if (path != null && !loaded) send(Push.event("open").put("path", path));
            if (path != null) {
                intent.setAction(Intent.ACTION_MAIN);
                intent.setData(null);
            }
        }
    }

    // ── System bars ────────────────────────────────────────────────────

    /**
     * Android 11+: draw behind the system bars and pad the page by their size
     * (and the keyboard's), the bars showing the page colour through. Older
     * versions keep the page between the bars and resize it for the keyboard.
     */
    private void setUpEdgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                if (customView != null) {
                    v.setPadding(0, 0, 0, 0);
                } else {
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                }
                return insets;
            });
        }
        applyBars();
    }

    /** System bars in the page's colour, with light or dark icons to match. */
    @SuppressWarnings("deprecation")
    private void applyBars() {
        root.setBackgroundColor(barColor);
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setStatusBarColor(Build.VERSION.SDK_INT >= 30 ? Color.TRANSPARENT : barColor);
            getWindow().setNavigationBarColor(Build.VERSION.SDK_INT >= 30 ? Color.TRANSPARENT : barColor);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(darkBars ? 0 : light, light);
            }
        } else {
            View decor = getWindow().getDecorView();
            int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
            int flags = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(darkBars ? flags & ~light : flags | light);
        }
    }

    private void themeChanged(String color, boolean dark) {
        try {
            barColor = Color.parseColor(color);
        } catch (IllegalArgumentException ignored) {
            barColor = dark ? 0xFF090C1A : 0xFFF4F8FB;
        }
        darkBars = dark;
        applyBars();
    }

    // ── Page ↔ app ─────────────────────────────────────────────────────

    /** Runs on the main thread (where the page and activities live). */
    static void runOnPage(Runnable r) {
        main.post(r);
    }

    /** The activity on screen, or null when the app is in the background. */
    static MainActivity foreground() {
        MainActivity a = current.get();
        return a != null && AddaApp.visible ? a : null;
    }

    /** Sends the page an event (an "addanative" window event), until the page confirms it. */
    static boolean send(Object event) {
        String json = event.toString();
        main.post(() -> {
            PageEvent e = new PageEvent(json);
            forgetOld();
            pending.add(e);
            deliver(e);
        });
        return page != null;
    }

    private static void deliver(PageEvent e) {
        if (page == null) return;
        // Also kept in window.__addaInbox, for a page whose listener isn't set up yet.
        page.evaluateJavascript("(function(){var d=" + e.json + ";d.__id=" + e.id
                + ";(window.__addaInbox=window.__addaInbox||[]).push(d);"
                + "window.dispatchEvent(new CustomEvent('addanative',{detail:d}));})()", null);
    }

    /** Events nobody took within a minute are stale (a call long over, an old tap). */
    private static void forgetOld() {
        long now = System.currentTimeMillis();
        pending.removeIf(e -> now - e.at > 60_000);
        while (pending.size() > 50) pending.remove(0);
    }

    /**
     * What the page (and the offline page) can ask of the app. Every frame of
     * the page can see this object; the site's content policy only allows
     * YouTube's player as a frame, and nothing here reveals messages.
     */
    static final class Bridge {
        private final Context app;

        Bridge(Context app) {
            this.app = app;
        }

        @JavascriptInterface
        public void setTheme(String color, boolean dark) {
            MainActivity a = current.get();
            if (a != null) a.runOnUiThread(() -> a.themeChanged(color, dark));
        }

        @JavascriptInterface
        public void retry() {
            main.post(() -> {
                MainActivity a = current.get();
                if (page != null) page.loadUrl(a != null && a.failedUrl != null ? a.failedUrl : BuildConfig.APP_URL);
            });
        }

        /** A page is listening: it gets every event not yet confirmed (it ignores repeats). */
        @JavascriptInterface
        public void ready() {
            main.post(() -> {
                forgetOld();
                for (PageEvent e : new ArrayList<>(pending)) deliver(e);
            });
        }

        @JavascriptInterface
        public void ack(String id) {
            main.post(() -> pending.removeIf(e -> String.valueOf(e.id).equals(id)));
        }

        /** A tap felt through the phone (press and hold, a swipe reaching its point), following its vibration settings. */
        @JavascriptInterface
        public void haptic(String kind) {
            main.post(() -> {
                if (page == null) return;
                int type = "tick".equals(kind) ? HapticFeedbackConstants.CLOCK_TICK
                        : "confirm".equals(kind) && Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM
                        : HapticFeedbackConstants.LONG_PRESS;
                page.performHapticFeedback(type);
            });
        }

        /** {code, name} of the installed app, for the update check. */
        @JavascriptInterface
        public String appVersion() {
            return Updater.version();
        }

        /** Downloads an update from this app's own server and opens the installer. */
        @JavascriptInterface
        public void installUpdate(String url, String sha256) {
            main.post(() -> {
                MainActivity a = current.get();
                if (a != null && url != null) Updater.start(a, url, sha256);
            });
        }

        @JavascriptInterface
        public String pushToken() {
            return Push.token(app);
        }

        @JavascriptInterface
        public void setUser(String json) {
            main.post(() -> userChanged(app, json));
        }

        @JavascriptInterface
        public void callState(String json) {
            main.post(() -> {
                CallService.update(app, json);
                // Nothing running and nobody looking: the page can go.
                if (json.contains("\"kind\":\"none\"") && current.get() == null && !ScreenCaptureService.running) destroyPage();
            });
        }

        /** The phone's share sheet (WhatsApp, Messenger, SMS…) with this text. */
        @JavascriptInterface
        public void share(String text) {
            main.post(() -> {
                MainActivity a = current.get();
                if (a == null || text == null) return;
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
                try {
                    a.startActivity(Intent.createChooser(send, null));
                } catch (ActivityNotFoundException ignored) {
                    // Nothing can share text; very unlikely on a phone.
                }
            });
        }

        @JavascriptInterface
        public void clearChat(String scope, String id) {
            if (ActionReceiver.isId(id)) Notifications.clearChat(app, scope, id);
        }

        @JavascriptInterface
        public boolean isRinging(String callId) {
            return IncomingCall.isRinging(app, callId);
        }

        @JavascriptInterface
        public void setSpeaker(boolean on) {
            CallService.setSpeaker(on);
        }

        @JavascriptInterface
        public boolean isSpeakerOn() {
            return CallService.speakerOn(app);
        }

        @JavascriptInterface
        public void screenCapture(String action) {
            main.post(() -> {
                if ("stop".equals(action)) {
                    stopScreen(app, true);
                    return;
                }
                MainActivity a = current.get();
                if (a != null) a.askScreen();
                else send(Push.event("screen").put("state", "failed"));
            });
        }
    }

    /** Signed in or out (json "" = out). */
    private static void userChanged(Context app, String json) {
        String before = AddaApp.userId(app);
        if (json == null || json.isEmpty()) {
            AddaApp.prefs(app).edit().remove("user_id").remove("user_name").apply();
            Notifications.clearAll(app);
            if (!before.isEmpty()) Push.resetToken(app);
            CallService.update(app, "{\"kind\":\"none\"}");
            stopScreen(app, true);
            return;
        }
        try {
            JSONObject u = new JSONObject(json);
            String id = u.optString("id");
            if (!id.equals(before)) Notifications.clearAll(app);
            AddaApp.prefs(app).edit().putString("user_id", id).putString("user_name", u.optString("name")).apply();
        } catch (Exception ignored) {
            return;
        }
        MainActivity a = current.get();
        if (a != null) a.askNotifications();
    }

    /** Signed in: ask to show notifications (Android 13+), then to ring full screen (Android 14+). */
    private void askNotifications() {
        if (askedNotifications) return;
        askedNotifications = true;
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQUEST_NOTIFY);
        } else {
            askFullScreenCalls();
        }
    }

    private void askFullScreenCalls() {
        if (Build.VERSION.SDK_INT < 34 || IncomingCall.canRingFullScreen(this)) return;
        if (AddaApp.prefs(this).getBoolean("asked_full_screen", false) || isFinishing()) return;
        AddaApp.prefs(this).edit().putBoolean("asked_full_screen", true).apply();
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle(R.string.fsi_title)
                .setMessage(R.string.fsi_text)
                .setPositiveButton(R.string.fsi_allow, (d, w) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
                    } catch (ActivityNotFoundException ignored) {
                        // No such settings page on this phone.
                    }
                })
                .setNegativeButton(R.string.not_now, null)
                .show();
    }

    /** Tells the app the page's theme now and whenever it changes. */
    private static final String THEME_SYNC =
            "(function(){if(window.__addaTheme)return;window.__addaTheme=1;"
            + "var send=function(){var m=document.querySelector('meta[name=\"theme-color\"]');"
            + "var dark=document.documentElement.dataset.theme!=='light';"
            + "if(window.AddaNative)AddaNative.setTheme(m?m.content:(dark?'#090C1A':'#F4F8FB'),dark);};"
            + "new MutationObserver(send).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});"
            + "var m=document.querySelector('meta[name=\"theme-color\"]');if(m)new MutationObserver(send).observe(m,{attributes:true});"
            + "send();})();";

    private static boolean isAppUrl(Uri uri) {
        return uri != null && uri.getScheme() != null && APP_ORIGIN.equalsIgnoreCase(origin(uri));
    }

    private final class Client extends WebViewClient {
        /** Our own pages open here; everything else (YouTube, websites, mail) opens outside. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isAppUrl(uri)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            updateBack();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (isAppUrl(Uri.parse(url))) view.evaluateJavascript(THEME_SYNC, null);
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            Uri url = request.getUrl();
            failedUrl = isAppUrl(url) ? url.toString() : null;
            showOffline();
        }

        /** The page's renderer crashed or Android reclaimed it: start over instead of crashing the app. */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view != page) return true;
            Context app = getApplicationContext();
            main.post(() -> {
                destroyPage();
                CallService.update(app, "{\"kind\":\"none\"}");
                stopScreen(app, true);
                if (current.get() == MainActivity.this && !isFinishing()) recreate();
            });
            return true;
        }
    }

    private void showOffline() {
        try (InputStream in = getAssets().open("offline.html")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            web.loadDataWithBaseURL(null, out.toString("UTF-8"), "text/html", "UTF-8", null);
        } catch (IOException ignored) {
            // Nothing better to show.
        }
    }

    private final class Chrome extends WebChromeClient {
        /** Microphone / camera for calls: ask Android once, then let the page use them. */
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                if (!isAppUrl(request.getOrigin())) {
                    request.deny();
                    return;
                }
                List<String> needed = new ArrayList<>();
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && !granted(Manifest.permission.RECORD_AUDIO)) needed.add(Manifest.permission.RECORD_AUDIO);
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && !granted(Manifest.permission.CAMERA)) needed.add(Manifest.permission.CAMERA);
                }
                if (needed.isEmpty()) {
                    grantAllowed(request);
                } else {
                    if (pendingMediaRequest != null) pendingMediaRequest.deny();
                    pendingMediaRequest = request;
                    requestPermissions(needed.toArray(new String[0]), REQUEST_MEDIA);
                }
            });
        }

        /** Attach photos and files (several at once when the page allows it). */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent pick = params.createIntent();
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(Intent.createChooser(pick, getString(R.string.choose_files)), REQUEST_FILES);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        /** Full-screen video (watch together, live streams, video calls). */
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            fullscreenHolder.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            fullscreenHolder.setVisibility(View.VISIBLE);
            setSystemBarsHidden(true);
            root.requestApplyInsets();
            updateBack();
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }

        /** No grey "play" placeholder over videos before they start. */
        @Override
        public Bitmap getDefaultVideoPoster() {
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        }
    }

    private void exitFullscreen() {
        if (customView == null) return;
        fullscreenHolder.removeView(customView);
        fullscreenHolder.setVisibility(View.GONE);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        setSystemBarsHidden(false);
        root.requestApplyInsets();
        updateBack();
    }

    @SuppressWarnings("deprecation")
    private void setSystemBarsHidden(boolean hidden) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (hidden) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(hidden
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    : 0);
            applyBars();
        }
    }

    // ── Screen sharing ─────────────────────────────────────────────────

    /** Android's own "start recording or casting?" prompt, then the capture service. */
    private void askScreen() {
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        try {
            startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST_SCREEN);
        } catch (ActivityNotFoundException e) {
            send(Push.event("screen").put("state", "failed"));
        }
    }

    static void stopScreen(Context c, boolean fromPage) {
        if (ScreenCaptureService.running) {
            c.startService(new Intent(c, ScreenCaptureService.class).setAction(ScreenCaptureService.ACTION_STOP).putExtra("fromPage", fromPage));
        }
    }

    /** Capture started: hand the page a message port, then the stream's size. */
    static void screenStarted(int width, int height) {
        main.post(() -> {
            if (page == null) return;
            closeScreenPort();
            WebMessagePort[] ports = page.createWebMessageChannel();
            screenPort = ports[0];
            screenBacklog.set(0);
            screenWaitForKey = false;
            screenPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
                @Override
                public void onMessage(WebMessagePort port, WebMessage message) {
                    if ("key".equals(message.getData())) ScreenCaptureService.requestKeyFrame();
                }
            });
            page.postWebMessage(new WebMessage("adda-screen", new WebMessagePort[] { ports[1] }), Uri.parse(APP_ORIGIN));
            screenPort.postMessage(new WebMessage("c|" + width + "|" + height));
        });
    }

    /** One encoded frame, from the encoder thread. */
    static void screenFrame(boolean key, long timestampUs, String base64) {
        // The page can't keep up: skip ahead to the next full picture.
        if (screenBacklog.get() > 45 && !screenWaitForKey) {
            screenWaitForKey = true;
            ScreenCaptureService.requestKeyFrame();
        }
        if (screenWaitForKey && !key) return;
        screenWaitForKey = false;
        String message = "f|" + (key ? 1 : 0) + "|" + timestampUs + "|" + base64;
        screenBacklog.incrementAndGet();
        main.post(() -> {
            screenBacklog.decrementAndGet();
            if (screenPort != null) screenPort.postMessage(new WebMessage(message));
        });
    }

    /** Capture over; `state` ("ended" / "failed") tells the page, null when the page stopped it. */
    static void screenEnded(String state) {
        main.post(() -> {
            if (screenPort != null) screenPort.postMessage(new WebMessage("e"));
            closeScreenPort();
            if (state != null) send(Push.event("screen").put("state", state));
            if (current.get() == null && !CallService.running) destroyPage();
        });
    }

    private static void closeScreenPort() {
        if (screenPort == null) return;
        try {
            screenPort.close();
        } catch (Exception ignored) {
            // Already closed.
        }
        screenPort = null;
    }

    // ── Permissions and results ────────────────────────────────────────

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void grantAllowed(PermissionRequest request) {
        List<String> ok = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && granted(Manifest.permission.RECORD_AUDIO)) ok.add(r);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && granted(Manifest.permission.CAMERA)) ok.add(r);
        }
        if (ok.isEmpty()) request.deny();
        else request.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQUEST_MEDIA && pendingMediaRequest != null) {
            grantAllowed(pendingMediaRequest);
            pendingMediaRequest = null;
        } else if (requestCode == REQUEST_STORAGE && pendingDownload != null) {
            PendingDownload d = pendingDownload;
            pendingDownload = null;
            startDownload(d.url, d.userAgent, d.disposition, d.mime, results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED);
        } else if (requestCode == REQUEST_NOTIFY && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            askFullScreenCalls();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCREEN) {
            if (resultCode != RESULT_OK || data == null) {
                send(Push.event("screen").put("state", "denied"));
                return;
            }
            Intent capture = new Intent(this, ScreenCaptureService.class)
                    .setAction(ScreenCaptureService.ACTION_START)
                    .putExtra("code", resultCode)
                    .putExtra("data", data);
            try {
                ContextCompat.startForegroundService(this, capture);
            } catch (Exception e) {
                send(Push.event("screen").put("state", "failed"));
            }
            return;
        }
        if (requestCode != REQUEST_FILES || fileCallback == null) return;
        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                picked = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[] { data.getData() };
            }
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    // ── Downloads ──────────────────────────────────────────────────────

    private void download(String url, String userAgent, String disposition, String mime, long length) {
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) && !isAppUrl(uri)) {
            Toast.makeText(this, R.string.cannot_download, Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT <= 28 && !granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
            pendingDownload = new PendingDownload(url, userAgent, disposition, mime);
            requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, REQUEST_STORAGE);
            return;
        }
        startDownload(url, userAgent, disposition, mime, true);
    }

    /** Saves to Downloads with this login's cookies, and shows Android's download notification. */
    private void startDownload(String url, String userAgent, String disposition, String mime, boolean publicFolder) {
        String name = fileName(url, disposition, mime);
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) r.addRequestHeader("Cookie", cookie);
        r.addRequestHeader("User-Agent", userAgent);
        r.setTitle(name);
        if (mime != null && !mime.isEmpty()) r.setMimeType(mime);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        if (publicFolder) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        else r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        try {
            dm.enqueue(r);
            Toast.makeText(this, getString(R.string.downloading, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            Toast.makeText(this, R.string.cannot_download, Toast.LENGTH_SHORT).show();
        }
    }

    private static final Pattern UTF8_NAME = Pattern.compile("filename\\*=UTF-8''([^;]+)", Pattern.CASE_INSENSITIVE);

    /** The file's real name: Adda Khana sends it as filename*=UTF-8''…, which Android's helper doesn't read. */
    private static String fileName(String url, String disposition, String mime) {
        String name = null;
        if (disposition != null) {
            Matcher m = UTF8_NAME.matcher(disposition);
            if (m.find()) {
                try {
                    name = URLDecoder.decode(m.group(1).trim(), StandardCharsets.UTF_8.name());
                } catch (Exception ignored) {
                    name = null;
                }
            }
        }
        if (name == null || name.isEmpty()) name = URLUtil.guessFileName(url, disposition, mime);
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return name.isEmpty() ? "download" : name;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /** Back leaves full screen, then steps back through the app's pages. */
    private void goBack() {
        if (customView != null) {
            exitFullscreen();
        } else if (web.canGoBack()) {
            web.goBack();
        } else {
            // Like other chat apps: go to the background, keeping calls and voice running.
            moveTaskToBack(true);
        }
    }

    /** Android 12 and older (13+ uses updateBack below). */
    @SuppressLint("GestureBackNavigation")
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        goBack();
    }

    /**
     * Android 13+: claim the back gesture only while there's somewhere to go
     * back to. Otherwise the system plays its back-to-home animation and moves
     * the app to the background (calls keep running).
     */
    private void updateBack() {
        if (Build.VERSION.SDK_INT < 33 || web == null) return;
        boolean wanted = customView != null || web.canGoBack();
        if (wanted == backClaimed) return;
        if (backCallback == null) backCallback = (OnBackInvokedCallback) this::goBack;
        OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
        if (wanted) dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, (OnBackInvokedCallback) backCallback);
        else dispatcher.unregisterOnBackInvokedCallback((OnBackInvokedCallback) backCallback);
        backClaimed = wanted;
    }

    @Override
    protected void onStart() {
        super.onStart();
        AddaApp.visible = true;
        current = new WeakReference<>(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // During an update: back from the installer, or from allowing "install unknown apps".
        Updater.resume(this);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (current.get() == this) AddaApp.visible = false;
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        String url = web != null ? web.getUrl() : null;
        if (url != null && isAppUrl(Uri.parse(url))) outState.putString(STATE_URL, url);
    }

    @Override
    protected void onDestroy() {
        if (current.get() == this) {
            current.clear();
            AddaApp.visible = false;
        }
        if (web != null && web == page) {
            root.removeView(web);
            // A call or screen share keeps going without the window; otherwise the page closes.
            if (CallService.running || ScreenCaptureService.running) pageContext.setBaseContext(getApplicationContext());
            else destroyPage();
        }
        web = null;
        super.onDestroy();
    }
}
