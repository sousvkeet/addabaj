package com.addakhana.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * What the app needs from Android, for the page's first-run screen and its
 * Settings › App permissions (client/src/components/Permissions.tsx):
 * notifications, the microphone and the camera, ringing over the lock screen
 * (Android 14+) and running in the background. Each is "granted", "ask"
 * (Android's own prompt can still show) or "settings" (only the phone's
 * settings can change it now). One this Android version doesn't have isn't listed.
 */
final class Permissions {
    static final int REQUEST = 6;
    private static final String SEEN = "permissions_seen";

    /** The page shows its own screen for these, so the app doesn't ask by itself as well (1.10.0 on). */
    static volatile boolean pageAsks;

    private Permissions() {}

    static JSONObject state(Context c) {
        Push.Json s = new Push.Json()
                .put("notifications", notifications(c))
                .put("microphone", runtime(c, Manifest.permission.RECORD_AUDIO))
                .put("camera", runtime(c, Manifest.permission.CAMERA))
                .put("battery", inBackground(c) ? "granted" : "ask")
                .put("seen", AddaApp.prefs(c).getBoolean(SEEN, false));
        if (Build.VERSION.SDK_INT >= 34) s.put("fullScreen", IncomingCall.canRingFullScreen(c) ? "granted" : "settings");
        return s.o;
    }

    /** The first-run screen was seen (continued from, or put off): it doesn't come back by itself. */
    static void seen(Context c) {
        AddaApp.prefs(c).edit().putBoolean(SEEN, true).apply();
    }

    static boolean wasSeen(Context c) {
        return AddaApp.prefs(c).getBoolean(SEEN, false);
    }

    private static String runtime(Context c, String permission) {
        if (c.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return "granted";
        // Android stops showing its prompt once it's been refused twice (or for good).
        boolean asked = AddaApp.prefs(c).getBoolean("asked:" + permission, false);
        boolean prompts = !asked || (c instanceof Activity && ((Activity) c).shouldShowRequestPermissionRationale(permission));
        return prompts ? "ask" : "settings";
    }

    private static String notifications(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        boolean on = nm != null && nm.areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= 33) {
            String r = runtime(c, Manifest.permission.POST_NOTIFICATIONS);
            // Allowed once, but switched off in the phone's settings since.
            return "granted".equals(r) && !on ? "settings" : r;
        }
        return on ? "granted" : "settings";
    }

    /** Left out of battery optimisation, so calls ring and messages arrive on phones that stop apps in the background. */
    private static boolean inBackground(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    /**
     * Android's prompt for one of them, or its page in the phone's settings
     * when the prompt can't show any more. "all": every prompt that can still
     * show, one after another. The page hears how it went (MainActivity.sendPermissions).
     */
    static void ask(Activity a, String which) {
        JSONObject s = state(a);
        Uri app = Uri.parse("package:" + a.getPackageName());
        switch (which) {
            case "all": {
                List<String> prompt = new ArrayList<>();
                if (Build.VERSION.SDK_INT >= 33 && "ask".equals(s.optString("notifications"))) prompt.add(Manifest.permission.POST_NOTIFICATIONS);
                if ("ask".equals(s.optString("microphone"))) prompt.add(Manifest.permission.RECORD_AUDIO);
                if ("ask".equals(s.optString("camera"))) prompt.add(Manifest.permission.CAMERA);
                request(a, prompt);
                break;
            }
            case "notifications":
                if (Build.VERSION.SDK_INT >= 33 && "ask".equals(s.optString(which))) {
                    request(a, Collections.singletonList(Manifest.permission.POST_NOTIFICATIONS));
                } else {
                    open(a, new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.getPackageName()),
                            new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app));
                }
                break;
            case "microphone":
            case "camera":
                if ("ask".equals(s.optString(which))) {
                    request(a, Collections.singletonList("camera".equals(which) ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO));
                } else {
                    open(a, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app));
                }
                break;
            case "fullScreen":
                if (Build.VERSION.SDK_INT >= 34) {
                    open(a, new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, app), new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app));
                }
                break;
            case "battery":
                // Android's "Let the app always run in the background?"; or, where that's missing, the list of apps.
                open(a, new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, app), new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                break;
            default:
                break;
        }
    }

    private static void request(Activity a, List<String> permissions) {
        if (permissions.isEmpty()) {
            // Nothing left to prompt for: the page hears where things stand.
            MainActivity.sendPermissions(a);
            return;
        }
        SharedPreferences.Editor e = AddaApp.prefs(a).edit();
        for (String p : permissions) e.putBoolean("asked:" + p, true);
        e.apply();
        String[] wanted = permissions.toArray(new String[0]);
        if (a instanceof MainActivity) ((MainActivity) a).askFor(wanted, REQUEST);
        else a.requestPermissions(wanted, REQUEST);
    }

    /** The first of these the phone has; the page hears how it went when the app is back (onResume). */
    private static void open(Activity a, Intent... intents) {
        for (Intent i : intents) {
            try {
                a.startActivity(i);
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
                // Not on this phone: try the next.
            }
        }
        MainActivity.sendPermissions(a);
    }
}
