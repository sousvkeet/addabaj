package com.addakhana.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.RemoteInput;

import org.json.JSONObject;

import java.util.regex.Pattern;

/** Buttons on notifications that work without opening the app: Reply, Mark as read, Decline. */
public class ActionReceiver extends BroadcastReceiver {
    static final String ACTION_REPLY = "com.addakhana.app.REPLY";
    static final String ACTION_READ = "com.addakhana.app.READ";
    static final String ACTION_DISMISS = "com.addakhana.app.DISMISS";
    static final String ACTION_DECLINE = "com.addakhana.app.DECLINE";

    private static final Pattern ID = Pattern.compile("[0-9a-fA-F-]{36}");

    static boolean isId(String s) {
        return s != null && ID.matcher(s).matches();
    }

    static PendingIntent pending(Context c, String action, String scope, String chatId, boolean mutable) {
        Intent i = new Intent(c, ActionReceiver.class).setAction(action).putExtra("scope", scope).putExtra("chatId", chatId);
        // Reply needs a mutable intent: Android fills in the typed text.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (mutable ? (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0) : PendingIntent.FLAG_IMMUTABLE);
        return PendingIntent.getBroadcast(c, (action + scope + chatId).hashCode(), i, flags);
    }

    static PendingIntent decline(Context c, String callId) {
        Intent i = new Intent(c, ActionReceiver.class).setAction(ACTION_DECLINE).putExtra("callId", callId);
        return PendingIntent.getBroadcast(c, (ACTION_DECLINE + callId).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        Context c = context.getApplicationContext();
        String scope = intent.getStringExtra("scope");
        String chatId = intent.getStringExtra("chatId");
        String callId = intent.getStringExtra("callId");
        CharSequence typed = null;
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        if (results != null) typed = results.getCharSequence(Notifications.KEY_REPLY);
        String reply = typed == null ? "" : typed.toString().trim();

        PendingResult done = goAsync();
        new Thread(() -> {
            try {
                switch (action) {
                    case ACTION_REPLY:
                        if (isChat(scope, chatId) && !reply.isEmpty()) reply(c, scope, chatId, reply);
                        break;
                    case ACTION_READ:
                        if (isChat(scope, chatId)) {
                            Notifications.clearChat(c, scope, chatId);
                            Api.post(readPath(scope, chatId), null);
                        }
                        break;
                    case ACTION_DISMISS:
                        // Swiped away: start afresh with the next message.
                        if (isChat(scope, chatId)) Notifications.forget(c, scope, chatId);
                        break;
                    case ACTION_DECLINE:
                        if (isId(callId)) {
                            IncomingCall.declined(c, callId);
                            MainActivity.send(Push.event("decline").put("callId", callId));
                            Api.post("/calls/" + callId + "/decline", null);
                        }
                        break;
                }
            } finally {
                done.finish();
            }
        }).start();
    }

    private static void reply(Context c, String scope, String chatId, String text) {
        JSONObject body = new JSONObject();
        try {
            body.put("body", text);
        } catch (Exception ignored) {
            return;
        }
        String base = "room".equals(scope) ? "/rooms/" : "/dms/";
        int status = Api.post(base + chatId + "/messages", body);
        if (status >= 200 && status < 300) {
            // Replying means you've read it, like any messenger. Your reply shows
            // for a moment (so you see it went), then the notification goes.
            Notifications.showReply(c, scope, chatId, text, true);
            Api.post(readPath(scope, chatId), null);
            try {
                Thread.sleep(1500);
            } catch (InterruptedException ignored) {
                // Clear it now then.
            }
            Notifications.clearChat(c, scope, chatId);
        } else {
            Notifications.showReply(c, scope, chatId, text, false);
        }
    }

    private static boolean isChat(String scope, String chatId) {
        return ("dm".equals(scope) || "room".equals(scope)) && isId(chatId);
    }

    private static String readPath(String scope, String chatId) {
        return ("room".equals(scope) ? "/rooms/" : "/dms/") + chatId + "/read";
    }
}
