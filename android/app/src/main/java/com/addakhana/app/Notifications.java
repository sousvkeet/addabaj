package com.addakhana.app;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Message notifications, one per chat or room, like a messenger: the latest
 * messages stacked with each sender's picture, Reply and Mark as read buttons,
 * and a bundle when several chats are waiting. What each shows is kept here
 * (Android only shows what we post), and dropped once the chat is read.
 */
final class Notifications {
    private Notifications() {}

    static final int ID_CHAT = 1;
    static final int ID_SUMMARY = 2;
    static final int ID_MISSED = 3;
    static final String GROUP = "com.addakhana.app.MESSAGES";
    static final String KEY_REPLY = "reply";
    static final int BRAND = 0xFF7C5CFF;
    private static final int KEEP = 12;

    private static SharedPreferences store(Context c) {
        return c.getSharedPreferences("notifications", Context.MODE_PRIVATE);
    }

    static String key(String scope, String chatId) {
        return scope + ":" + chatId;
    }

    static String path(String scope, String chatId) {
        return ("room".equals(scope) ? "/rooms/" : "/chats/") + chatId;
    }

    private static JSONObject load(Context c, String key) {
        try {
            String raw = store(c).getString(key, null);
            return raw == null ? null : new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    // ── New messages ───────────────────────────────────────────────────

    static synchronized void showMessage(Context c, Map<String, String> d) {
        // The open app shows new messages itself.
        if (AddaApp.visible) return;
        String scope = d.get("scope");
        String chatId = d.get("chatId");
        if (chatId == null || !("dm".equals(scope) || "room".equals(scope))) return;
        String key = key(scope, chatId);
        try {
            JSONObject chat = load(c, key);
            if (chat == null) chat = new JSONObject().put("scope", scope).put("chatId", chatId).put("messages", new JSONArray());
            chat.put("name", value(d, "chatName", "Adda Khana")).put("hue", value(d, "chatHue", "260"));
            JSONArray old = chat.getJSONArray("messages");
            long id = Long.parseLong(value(d, "messageId", "0"));
            for (int i = 0; i < old.length(); i++) if (old.getJSONObject(i).optLong("id") == id) return; // already shown
            JSONArray list = new JSONArray();
            for (int i = Math.max(0, old.length() - (KEEP - 1)); i < old.length(); i++) list.put(old.get(i));
            list.put(new JSONObject()
                    .put("id", id)
                    .put("sender", value(d, "senderName", "Someone"))
                    .put("senderId", value(d, "senderId", ""))
                    .put("hue", value(d, "senderHue", "260"))
                    .put("text", value(d, "text", ""))
                    .put("at", Long.parseLong(value(d, "sentAt", String.valueOf(System.currentTimeMillis())))));
            chat.put("messages", list);
            chat.put("unread", chat.optInt("unread") + 1);
            store(c).edit().putString(key, chat.toString()).apply();
            post(c, key, chat, true);
            postSummary(c);
        } catch (Exception ignored) {
            // A malformed push; nothing to show.
        }
    }

    /** After replying from the notification: shows the reply (or that it failed) without alerting again. */
    static synchronized void showReply(Context c, String scope, String chatId, String text, boolean sent) {
        String key = key(scope, chatId);
        JSONObject chat = load(c, key);
        if (chat == null) return;
        try {
            chat.getJSONArray("messages").put(new JSONObject()
                    .put("id", -System.currentTimeMillis())
                    .put("self", true)
                    .put("text", sent ? text : c.getString(R.string.reply_failed, text))
                    .put("at", System.currentTimeMillis()));
            store(c).edit().putString(key, chat.toString()).apply();
            post(c, key, chat, false);
        } catch (Exception ignored) {
            // Leave it as it was.
        }
    }

    private static void post(Context c, String key, JSONObject chat, boolean alert) throws Exception {
        String scope = chat.getString("scope");
        String chatId = chat.getString("chatId");
        String name = chat.optString("name", "Adda Khana");
        boolean room = "room".equals(scope);
        JSONArray messages = chat.getJSONArray("messages");

        Person me = new Person.Builder().setName(c.getString(R.string.you)).setKey("me").build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        if (room) {
            style.setConversationTitle(name);
            style.setGroupConversation(true);
        }
        Map<String, Person> people = new HashMap<>();
        long last = System.currentTimeMillis();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.getJSONObject(i);
            last = m.optLong("at", last);
            if (m.optBoolean("self")) {
                style.addMessage(m.optString("text"), last, (Person) null);
                continue;
            }
            String sender = m.optString("sender", "Someone");
            String senderKey = m.optString("senderId", sender);
            Person p = people.get(senderKey);
            if (p == null) {
                p = new Person.Builder().setName(sender).setKey(senderKey).setIcon(Avatars.icon(sender, Avatars.hue(m.optString("hue")))).build();
                people.put(senderKey, p);
            }
            style.addMessage(m.optString("text"), last, p);
        }

        int unread = chat.optInt("unread", 1);
        String count = c.getResources().getQuantityString(R.plurals.new_messages, unread, unread);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, room ? AddaApp.CH_ROOMS : AddaApp.CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat_adda)
                .setColor(BRAND)
                .setStyle(style)
                .setContentTitle(name)
                .setContentText(count)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setOnlyAlertOnce(!alert)
                .setGroup(GROUP)
                .setWhen(last)
                .setShowWhen(true)
                .setNumber(unread)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                // On the lock screen: who, not what.
                .setPublicVersion(new NotificationCompat.Builder(c, room ? AddaApp.CH_ROOMS : AddaApp.CH_MESSAGES)
                        .setSmallIcon(R.drawable.ic_stat_adda)
                        .setColor(BRAND)
                        .setContentTitle(c.getString(R.string.app_name))
                        .setContentText(count)
                        .build())
                .setContentIntent(openChat(c, scope, chatId))
                .setDeleteIntent(ActionReceiver.pending(c, ActionReceiver.ACTION_DISMISS, scope, chatId, false))
                .addAction(replyAction(c, scope, chatId))
                .addAction(new NotificationCompat.Action.Builder(R.drawable.ic_done, c.getString(R.string.mark_read),
                        ActionReceiver.pending(c, ActionReceiver.ACTION_READ, scope, chatId, false))
                        .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                        .setShowsUserInterface(false)
                        .build());
        // Older Android shows no sender pictures in the message list.
        if (!room && Build.VERSION.SDK_INT < 28) b.setLargeIcon(Avatars.bitmap(name, Avatars.hue(chat.optString("hue")), 192));
        notify(c, key, ID_CHAT, b);
    }

    private static NotificationCompat.Action replyAction(Context c, String scope, String chatId) {
        RemoteInput input = new RemoteInput.Builder(KEY_REPLY).setLabel(c.getString(R.string.reply_hint)).build();
        return new NotificationCompat.Action.Builder(R.drawable.ic_reply, c.getString(R.string.reply),
                ActionReceiver.pending(c, ActionReceiver.ACTION_REPLY, scope, chatId, true))
                .addRemoteInput(input)
                .setAllowGeneratedReplies(true)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setShowsUserInterface(false)
                .build();
    }

    /** The bundle header when several chats are waiting (older Android shows its lines). */
    private static void postSummary(Context c) {
        Map<String, ?> all = store(c).getAll();
        int chats = 0;
        int total = 0;
        NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
        for (Object raw : all.values()) {
            try {
                JSONObject chat = new JSONObject(String.valueOf(raw));
                JSONArray m = chat.getJSONArray("messages");
                if (m.length() == 0) continue;
                chats++;
                total += chat.optInt("unread", 1);
                JSONObject lastMessage = m.getJSONObject(m.length() - 1);
                inbox.addLine(chat.optString("name") + ": " + lastMessage.optString("text"));
            } catch (Exception ignored) {
                // Skip it.
            }
        }
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        if (chats < 2) {
            nm.cancel("summary", ID_SUMMARY);
            return;
        }
        String line = c.getResources().getQuantityString(R.plurals.messages_from_chats, total, total, chats);
        inbox.setSummaryText(line);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, AddaApp.CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat_adda)
                .setColor(BRAND)
                .setContentTitle(c.getString(R.string.app_name))
                .setContentText(line)
                .setStyle(inbox)
                .setGroup(GROUP)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(open(c, "/chats", 0));
        notify(c, "summary", ID_SUMMARY, b);
    }

    // ── Clearing ───────────────────────────────────────────────────────

    /** Read here or on another device: the chat's notification goes. */
    static synchronized void clearChat(Context c, String scope, String chatId) {
        if (scope == null || chatId == null) return;
        String key = key(scope, chatId);
        store(c).edit().remove(key).apply();
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        release(c, key, ID_CHAT);
        nm.cancel(key, ID_CHAT);
        if ("dm".equals(scope)) {
            nm.cancel("missed:" + chatId, ID_MISSED);
            c.getSharedPreferences("missed", Context.MODE_PRIVATE).edit().remove(chatId).apply();
        }
        postSummary(c);
    }

    /** A message was deleted for everyone: take it out of its chat's notification (gone when it was the only one). */
    static synchronized void removeMessage(Context c, String scope, String chatId, String messageId) {
        if (scope == null || chatId == null || messageId == null) return;
        String key = key(scope, chatId);
        JSONObject chat = load(c, key);
        if (chat == null) return;
        try {
            long id = Long.parseLong(messageId);
            JSONArray old = chat.getJSONArray("messages");
            JSONArray kept = new JSONArray();
            int removed = 0;
            for (int i = 0; i < old.length(); i++) {
                JSONObject m = old.getJSONObject(i);
                if (m.optLong("id") == id && !m.optBoolean("self")) removed++;
                else kept.put(m);
            }
            if (removed == 0) return;
            boolean othersLeft = false;
            for (int i = 0; i < kept.length(); i++) if (!kept.getJSONObject(i).optBoolean("self")) othersLeft = true;
            if (!othersLeft) {
                clearChat(c, scope, chatId);
                return;
            }
            chat.put("messages", kept);
            chat.put("unread", Math.max(1, chat.optInt("unread", 1) - removed));
            store(c).edit().putString(key, chat.toString()).apply();
            post(c, key, chat, false);
            postSummary(c);
        } catch (Exception ignored) {
            // A malformed push; leave the notification as it is.
        }
    }

    /** The notification was swiped away: forget its messages, keep everything else. */
    static synchronized void forget(Context c, String scope, String chatId) {
        store(c).edit().remove(key(scope, chatId)).apply();
        postSummary(c);
    }

    /** Signed out: nothing of theirs stays on screen. */
    static synchronized void clearAll(Context c) {
        store(c).edit().clear().apply();
        c.getSharedPreferences("missed", Context.MODE_PRIVATE).edit().clear().apply();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) for (StatusBarNotification n : nm.getActiveNotifications()) release(c, n.getTag(), n.getId());
        NotificationManagerCompat.from(c).cancelAll();
    }

    /**
     * Android 15+ keeps a notification you replied to on screen and ignores the
     * app removing it; posting it again (silently) lets it go.
     */
    private static void release(Context c, String tag, int id) {
        if (Build.VERSION.SDK_INT < 35 || tag == null) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        for (StatusBarNotification n : nm.getActiveNotifications()) {
            if (n.getId() != id || !tag.equals(n.getTag())) continue;
            NotificationCompat.Builder quiet = new NotificationCompat.Builder(c, n.getNotification().getChannelId())
                    .setSmallIcon(R.drawable.ic_stat_adda)
                    .setSilent(true)
                    .setOnlyAlertOnce(true)
                    .setGroup(GROUP);
            notify(c, tag, id, quiet);
            return;
        }
    }

    // ── Missed calls ───────────────────────────────────────────────────

    static synchronized void showMissedCall(Context c, String callerId, String name, int hue, boolean video) {
        if (callerId == null) return;
        SharedPreferences missed = c.getSharedPreferences("missed", Context.MODE_PRIVATE);
        int count = missed.getInt(callerId, 0) + 1;
        missed.edit().putInt(callerId, count).apply();
        String text = count > 1
                ? c.getResources().getQuantityString(R.plurals.missed_calls, count, count)
                : c.getString(video ? R.string.missed_video_call : R.string.missed_voice_call);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, AddaApp.CH_MISSED)
                .setSmallIcon(R.drawable.ic_missed)
                .setColor(0xFFFF5C7A)
                .setLargeIcon(Avatars.bitmap(name, hue, 192))
                .setContentTitle(name)
                .setContentText(text)
                .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .setContentIntent(openChat(c, "dm", callerId));
        notify(c, "missed:" + callerId, ID_MISSED, b);
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private static PendingIntent openChat(Context c, String scope, String chatId) {
        return open(c, path(scope, chatId), key(scope, chatId).hashCode());
    }

    /** Opens the app at `path`. */
    static PendingIntent open(Context c, String path, int requestCode) {
        Intent i = new Intent(c, MainActivity.class)
                .setAction(MainActivity.ACTION_OPEN)
                .putExtra(MainActivity.EXTRA_PATH, path)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @SuppressWarnings("MissingPermission")
    static void notify(Context c, String tag, int id, NotificationCompat.Builder b) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        if (!nm.areNotificationsEnabled()) return;
        try {
            nm.notify(tag, id, b.build());
        } catch (SecurityException ignored) {
            // Notifications permission was taken away meanwhile.
        }
    }

    private static String value(Map<String, String> d, String key, String fallback) {
        String v = d.get(key);
        return v == null || v.isEmpty() ? fallback : v;
    }
}
