package com.addakhana.app;

import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

/** App start: notification channels, and a little shared state. */
public class AddaApp extends Application {
    static final String CH_MESSAGES = "messages";
    static final String CH_ROOMS = "rooms";
    static final String CH_CALLS = "calls";
    static final String CH_MISSED = "missed_calls";
    static final String CH_ONGOING = "ongoing";

    static final long[] RING_VIBRATION = { 0, 900, 700, 900, 700 };

    /** The app is on screen (some activity of ours is started). */
    static volatile boolean visible;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
        Push.refreshToken(this);
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("adda", MODE_PRIVATE);
    }

    /** Who is signed in ("" when nobody), so notifications can say "You". */
    static String userId(Context c) {
        return prefs(c).getString("user_id", "");
    }

    static void createChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);

        NotificationChannel messages = new NotificationChannel(CH_MESSAGES, c.getString(R.string.ch_messages), NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription(c.getString(R.string.ch_messages_desc));
        messages.enableVibration(true);
        messages.setShowBadge(true);

        NotificationChannel rooms = new NotificationChannel(CH_ROOMS, c.getString(R.string.ch_rooms), NotificationManager.IMPORTANCE_HIGH);
        rooms.setDescription(c.getString(R.string.ch_rooms_desc));
        rooms.enableVibration(true);
        rooms.setShowBadge(true);

        // Rings with the phone's ringtone, over and over until answered (FLAG_INSISTENT).
        NotificationChannel calls = new NotificationChannel(CH_CALLS, c.getString(R.string.ch_calls), NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription(c.getString(R.string.ch_calls_desc));
        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        calls.setSound(ringtone, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        calls.enableVibration(true);
        calls.setVibrationPattern(RING_VIBRATION);
        calls.setShowBadge(false);
        calls.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        NotificationChannel missed = new NotificationChannel(CH_MISSED, c.getString(R.string.ch_missed), NotificationManager.IMPORTANCE_HIGH);
        missed.setDescription(c.getString(R.string.ch_missed_desc));

        NotificationChannel ongoing = new NotificationChannel(CH_ONGOING, c.getString(R.string.ch_ongoing), NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription(c.getString(R.string.ch_ongoing_desc));
        ongoing.setSound(null, null);
        ongoing.enableVibration(false);
        ongoing.setShowBadge(false);

        nm.createNotificationChannels(java.util.Arrays.asList(messages, rooms, calls, missed, ongoing));
    }
}
