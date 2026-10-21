package com.addakhana.app;

import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The server's API from outside the page (notification actions while the app
 * is closed), signed in with the WebView's own login cookie. Call off the main thread.
 */
final class Api {
    private Api() {}

    /** POSTs JSON to /api{path}; returns the HTTP status (0 when the server can't be reached). */
    static int post(String path, JSONObject body) {
        HttpURLConnection http = null;
        try {
            URL url = new URL(BuildConfig.APP_URL + "/api" + path);
            http = (HttpURLConnection) url.openConnection();
            http.setRequestMethod("POST");
            http.setConnectTimeout(5_000);
            http.setReadTimeout(4_000);
            http.setDoOutput(true);
            http.setRequestProperty("Content-Type", "application/json");
            String cookie = CookieManager.getInstance().getCookie(BuildConfig.APP_URL);
            if (cookie != null) http.setRequestProperty("Cookie", cookie);
            try (OutputStream out = http.getOutputStream()) {
                out.write((body == null ? "{}" : body.toString()).getBytes(StandardCharsets.UTF_8));
            }
            return http.getResponseCode();
        } catch (Exception e) {
            return 0;
        } finally {
            if (http != null) http.disconnect();
        }
    }
}
