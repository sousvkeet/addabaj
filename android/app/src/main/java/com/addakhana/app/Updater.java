package com.addakhana.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.CookieManager;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Updates the app from its own server (Admin › App updates): downloads the new
 * version with progress shown in the page, checks it, and opens Android's
 * installer. The first time, Android asks to allow installing apps from Adda
 * Khana; once allowed, the install carries on by itself.
 */
final class Updater {
    private Updater() {}

    private static volatile boolean busy;
    /** Downloaded and checked, waiting for "install unknown apps" to be allowed. */
    private static File pending;
    /** Android's installer is open; coming back to the app means it wasn't installed. */
    private static boolean installerOpen;

    /** {code, name} of this build, for the page's update check. */
    static String version() {
        return Push.event("version").put("code", BuildConfig.VERSION_CODE).put("name", BuildConfig.VERSION_NAME).toString();
    }

    /** Only files from this app's own server, at its app-download address. */
    private static URL allowed(String url) {
        try {
            Uri base = Uri.parse(BuildConfig.APP_URL);
            Uri u = Uri.parse(url.startsWith("/") ? BuildConfig.APP_URL + url : url);
            boolean sameServer = base.getScheme().equals(u.getScheme()) && base.getAuthority().equals(u.getAuthority());
            if (!sameServer || u.getPath() == null || !u.getPath().matches("/api/app/download/\\d+")) return null;
            return new URL(u.toString());
        } catch (Exception e) {
            return null;
        }
    }

    private static void tell(String state, Push.Json extra) {
        Push.Json e = extra != null ? extra : Push.event("update");
        MainActivity.send(e.put("type", "update").put("state", state));
    }

    static void start(Activity activity, String url, String sha256) {
        URL source = allowed(url);
        if (source == null) {
            tell("failed", Push.event("update").put("message", "That isn't this app's download address."));
            return;
        }
        // Only a file matching the release's fingerprint is ever installed.
        String expected = sha256 == null ? "" : sha256.toLowerCase(Locale.ROOT);
        if (!expected.matches("[0-9a-f]{64}")) {
            tell("failed", Push.event("update").put("message", "That update can't be checked, so it wasn't downloaded."));
            return;
        }
        if (busy) return;
        busy = true;
        Context app = activity.getApplicationContext();
        new Thread(() -> {
            try {
                // Already downloaded (the installer was cancelled, or the setting wasn't allowed yet)?
                File ready = new File(new File(app.getCacheDir(), "updates"), "AddaKhana-update.apk");
                File file = ready.isFile() && expected.equals(sha256(ready)) ? ready : download(app, source, expected);
                MainActivity.runOnPage(() -> install(app, file));
            } catch (Exception e) {
                tell("failed", Push.event("update").put("message", e.getMessage() == null ? "The download didn't finish." : e.getMessage()));
            } finally {
                busy = false;
            }
        }, "app-update").start();
    }

    private static File download(Context c, URL source, String sha256) throws Exception {
        File dir = new File(c.getCacheDir(), "updates");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("There's no room to save the update.");
        for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) old.delete();
        File part = new File(dir, "update.apk.part");
        HttpURLConnection http = (HttpURLConnection) source.openConnection();
        http.setConnectTimeout(15_000);
        http.setReadTimeout(30_000);
        String cookie = CookieManager.getInstance().getCookie(BuildConfig.APP_URL);
        if (cookie != null) http.setRequestProperty("Cookie", cookie);
        int status = http.getResponseCode();
        if (status != 200) throw new Exception("The server answered " + status + ". Try again later.");
        long total = http.getContentLengthLong();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long received = 0;
        long lastTold = 0;
        try (InputStream in = http.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                digest.update(buf, 0, n);
                received += n;
                long now = System.currentTimeMillis();
                if (now - lastTold > 250) {
                    lastTold = now;
                    tell("downloading", Push.event("update").put("received", received).put("total", total)
                            .put("percent", total > 0 ? (int) (received * 100 / total) : -1));
                }
            }
        } finally {
            http.disconnect();
        }
        if (total > 0 && received != total) throw new Exception("The download was cut short. Try again.");
        if (!sha256.equals(hex(digest))) {
            part.delete();
            throw new Exception("The download didn't match the release, so it wasn't installed. Try again.");
        }
        tell("downloaded", null);
        File apk = new File(dir, "AddaKhana-update.apk");
        if (!part.renameTo(apk)) throw new Exception("Couldn't save the update.");
        return apk;
    }

    private static String hex(MessageDigest digest) {
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    private static String sha256(File file) {
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) digest.update(buf, 0, n);
            return hex(digest);
        } catch (Exception e) {
            return "";
        }
    }

    /** Opens Android's installer for the downloaded update (asking to allow it first, if needed). */
    private static void install(Context c, File apk) {
        MainActivity a = MainActivity.foreground();
        if (Build.VERSION.SDK_INT >= 26 && !c.getPackageManager().canRequestPackageInstalls()) {
            pending = apk;
            tell("permission", null);
            if (a == null) return;
            try {
                a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName())));
            } catch (ActivityNotFoundException ignored) {
                // No such settings screen; the page explains what to allow.
            }
            return;
        }
        pending = null;
        Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".updates", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            (a != null ? a : c).startActivity(intent);
            installerOpen = true;
            tell("installing", null);
        } catch (ActivityNotFoundException e) {
            tell("failed", Push.event("update").put("message", "This phone has no app installer."));
        }
    }

    /**
     * Back in the app. From the installer: it was cancelled (an installed update
     * restarts the app instead). From the "install unknown apps" setting: carry
     * on if it's allowed now.
     */
    static void resume(Context c) {
        if (installerOpen) {
            installerOpen = false;
            tell("cancelled", null);
            return;
        }
        File apk = pending;
        if (apk == null) return;
        if (Build.VERSION.SDK_INT < 26 || c.getPackageManager().canRequestPackageInstalls()) install(c, apk);
        else tell("permission-needed", null);
    }

    /** An update that was installed (or given up) leaves nothing behind. */
    static void clean(Context c) {
        if (busy || pending != null) return;
        File dir = new File(c.getCacheDir(), "updates");
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
    }
}
