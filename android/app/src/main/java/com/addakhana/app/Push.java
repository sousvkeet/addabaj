package com.addakhana.app;

import android.content.Context;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.Map;

/**
 * Push notifications from the server (Firebase Cloud Messaging). The token
 * says where this phone's notifications go; the page sends it to the server
 * while someone is signed in. Without a Firebase setup this all does nothing.
 */
final class Push {
    private Push() {}

    static boolean configured(Context c) {
        return !FirebaseApp.getApps(c).isEmpty();
    }

    static String token(Context c) {
        return AddaApp.prefs(c).getString("push_token", "");
    }

    /** Asks Firebase for this phone's token and hands it to the page. */
    static void refreshToken(Context c) {
        if (!configured(c)) return;
        Context app = c.getApplicationContext();
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t -> saveToken(app, t));
    }

    static void saveToken(Context c, String token) {
        if (token == null || token.isEmpty()) return;
        AddaApp.prefs(c).edit().putString("push_token", token).apply();
        MainActivity.send(event("token").put("token", token));
    }

    /** Signed out: this phone's old token stops working, and a fresh one waits for the next sign-in. */
    static void resetToken(Context c) {
        AddaApp.prefs(c).edit().remove("push_token").apply();
        if (!configured(c)) return;
        Context app = c.getApplicationContext();
        FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(t -> refreshToken(app));
    }

    /** One push from the server (see server/src/services/push.js for what each carries). */
    static void handle(Context c, Map<String, String> data) {
        String type = data.get("type");
        if (type == null) return;
        // Nobody is signed in on this phone any more.
        if (AddaApp.userId(c).isEmpty()) return;
        switch (type) {
            case "message":
                Notifications.showMessage(c, data);
                break;
            case "read":
                Notifications.clearChat(c, data.get("scope"), data.get("chatId"));
                break;
            case "deleted":
                Notifications.removeMessage(c, data.get("scope"), data.get("chatId"), data.get("messageId"));
                break;
            case "call":
                IncomingCall.ring(c, data);
                break;
            case "call_end":
                IncomingCall.ended(c, data);
                break;
        }
    }

    /** A JSON event for the page ({type: …}); see client/src/lib/native.ts. */
    static Json event(String type) {
        return new Json().put("type", type);
    }

    /** JSONObject without the checked exceptions. */
    static final class Json {
        final JSONObject o = new JSONObject();

        Json put(String key, Object value) {
            try {
                o.put(key, value);
            } catch (Exception ignored) {
                // Only fails for non-finite numbers.
            }
            return this;
        }

        @Override
        public String toString() {
            return o.toString();
        }
    }
}
