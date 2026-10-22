package com.addakhana.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;

import java.util.Map;

/**
 * Incoming calls while the app is closed or in the background: the phone
 * rings with its ringtone and shows the call screen (over the lock screen too),
 * with Answer and Decline, like a phone call.
 */
final class IncomingCall {
    private IncomingCall() {}

    static final int ID_CALL = 4;
    /** A little longer than the server lets a call ring a phone. */
    private static final long RING_MS = 46_000;
    private static final long CLOCK_SLACK_MS = 10 * 60_000;

    static String tag(String callId) {
        return "call:" + callId;
    }

    static void ring(Context c, Map<String, String> d) {
        String callId = d.get("callId");
        if (!ActionReceiver.isId(callId) || wasEnded(c, callId)) return;
        // A push that arrived too late to answer. Firebase drops call pushes after 40 s,
        // so this only guards against stragglers; the margin allows for a phone whose clock is off.
        long sentAt = parse(d.get("sentAt"), System.currentTimeMillis());
        if (System.currentTimeMillis() - sentAt > RING_MS + CLOCK_SLACK_MS) return;
        // The open app rings itself; and nobody takes a second call mid-call (watching a video isn't one).
        if (AddaApp.visible || (CallService.running && !"watch".equals(CallService.kind))) return;

        String name = d.get("callerName") == null ? "Someone" : d.get("callerName");
        int hue = Avatars.hue(d.get("callerHue"));
        boolean video = "1".equals(d.get("video"));
        Person caller = new Person.Builder()
                .setName(name)
                .setKey(d.get("callerId"))
                .setIcon(Avatars.iconNow(c, name, hue, d.get("callerPhoto")))
                .setImportant(true)
                .build();

        Intent screen = new Intent(c, IncomingCallActivity.class)
                .putExtra("callId", callId)
                .putExtra("callerId", d.get("callerId"))
                .putExtra("name", name)
                .putExtra("hue", hue)
                .putExtra("photo", d.get("callerPhoto"))
                .putExtra("video", video)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent full = PendingIntent.getActivity(c, tag(callId).hashCode(), screen,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, AddaApp.CH_CALLS)
                .setSmallIcon(video ? R.drawable.ic_video : R.drawable.ic_call)
                .setColor(Notifications.BRAND)
                .setContentTitle(name)
                .setContentText(c.getString(video ? R.string.incoming_video_call : R.string.incoming_voice_call))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(full, true)
                .setContentIntent(full)
                .setTimeoutAfter(RING_MS)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, ActionReceiver.decline(c, callId), answer(c, callId, video))
                        .setIsVideo(video))
                .addPerson(caller)
                // Android 7 (channels set these from 8 on).
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
                .setVibrate(AddaApp.RING_VIBRATION);
        Notification n = b.build();
        // Keep ringing until answered, declined or the caller gives up.
        n.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(c).notify(tag(callId), ID_CALL, n);
        } catch (SecurityException ignored) {
            // No permission to notify.
        }
    }

    /** Answering opens the app, which joins the call. */
    static PendingIntent answer(Context c, String callId, boolean video) {
        Intent i = new Intent(c, MainActivity.class)
                .setAction(MainActivity.ACTION_ANSWER)
                .putExtra("callId", callId)
                .putExtra("video", video)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, ("answer" + callId).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** The server says the call is over: stop ringing, and note a call nobody answered. */
    static void ended(Context c, Map<String, String> d) {
        String callId = d.get("callId");
        if (!ActionReceiver.isId(callId)) return;
        boolean wasRinging = isRinging(c, callId);
        boolean firstWord = !wasEnded(c, callId);
        stopRinging(c, callId);
        String reason = d.get("reason");
        boolean missed = "missed".equals(reason) || "cancelled".equals(reason);
        if (missed && firstWord && (wasRinging || !AddaApp.visible)) {
            Notifications.showMissedCall(c, d.get("callerId"), d.get("callerName") == null ? "Someone" : d.get("callerName"),
                    Avatars.hue(d.get("callerHue")), d.get("callerPhoto"), "1".equals(d.get("video")));
        }
    }

    /** Declined here: stop ringing (the server is told separately). */
    static void declined(Context c, String callId) {
        stopRinging(c, callId);
    }

    static void stopRinging(Context c, String callId) {
        rememberEnded(c, callId);
        NotificationManagerCompat.from(c).cancel(tag(callId), ID_CALL);
        IncomingCallActivity.finishFor(callId);
    }

    static boolean isRinging(Context c, String callId) {
        if (callId == null) return false;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return false;
        for (StatusBarNotification n : nm.getActiveNotifications()) {
            if (n.getId() == ID_CALL && tag(callId).equals(n.getTag())) return true;
        }
        return false;
    }

    // Calls that ended, so a push that arrives late doesn't ring for them.
    private static SharedPreferences ended(Context c) {
        return c.getSharedPreferences("ended_calls", Context.MODE_PRIVATE);
    }

    static boolean wasEnded(Context c, String callId) {
        return ended(c).contains(callId);
    }

    private static void rememberEnded(Context c, String callId) {
        SharedPreferences p = ended(c);
        SharedPreferences.Editor e = p.edit();
        long now = System.currentTimeMillis();
        for (Map.Entry<String, ?> old : p.getAll().entrySet()) {
            if (old.getValue() instanceof Long && now - (Long) old.getValue() > 10 * 60_000) e.remove(old.getKey());
        }
        e.putLong(callId, now).apply();
    }

    private static long parse(String s, long fallback) {
        try {
            return Long.parseLong(s);
        } catch (Exception e) {
            return fallback;
        }
    }

    static boolean canRingFullScreen(Context c) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }
}
