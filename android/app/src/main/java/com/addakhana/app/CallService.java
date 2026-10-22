package com.addakhana.app;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

/**
 * Keeps a call, room voice or live stream going while the app is in the
 * background or the screen is off (a foreground service, with the ongoing
 * call notification and its hang-up button). During one-to-one voice calls
 * the sound plays from the earpiece and the screen turns off at your ear,
 * like a phone call; video calls and rooms use the loudspeaker.
 */
public class CallService extends Service {
    static final String ACTION_UPDATE = "com.addakhana.app.CALL_UPDATE";
    static final String ACTION_HANGUP = "com.addakhana.app.CALL_HANGUP";
    /** Mute or unmute (the picture-in-picture window's button). */
    static final String ACTION_MUTE = "com.addakhana.app.CALL_MUTE";
    static final String ACTION_STOP = "com.addakhana.app.CALL_STOP";
    static final int ID = 5;

    static volatile boolean running;
    /** What's running: "call", "voice", "live" or "watch" (a room's video playing on in the background). */
    static volatile String kind = "none";
    private static volatile CallService instance;
    /** null: the default for the session (earpiece for voice calls); otherwise what the person chose. */
    private static volatile Boolean speakerChoice;

    private final Handler main = new Handler(Looper.getMainLooper());
    private JSONObject session = new JSONObject();
    private PowerManager.WakeLock proximity;
    private boolean routed;

    // ── Called from the page bridge ─────────────────────────────────────

    /** What's running now (JSON from client/src/lib/native.ts); kind "none" stops the service. */
    static void update(Context c, String json) {
        JSONObject s;
        try {
            s = new JSONObject(json);
        } catch (Exception e) {
            return;
        }
        String kind = s.optString("kind", "none");
        // Ringing isn't a call yet (the phone's own call screen handles that), and a
        // screen share has its own service and notification (ScreenCaptureService).
        boolean idle = "none".equals(kind)
                || ("call".equals(kind) && "incoming".equals(s.optString("phase")))
                || ("live".equals(kind) && "screen".equals(s.optString("mode")));
        if (idle) {
            if (running) c.startService(new Intent(c, CallService.class).setAction(ACTION_STOP));
            return;
        }
        // Their photo for the call's notification: fetched now, shown from the next update (the call connecting).
        if ("call".equals(kind)) Avatars.prefetch(c, s.optString("photo"));
        Intent i = new Intent(c, CallService.class).setAction(ACTION_UPDATE).putExtra("session", json);
        try {
            if (running) c.startService(i);
            else ContextCompat.startForegroundService(c, i);
        } catch (Exception ignored) {
            // Not allowed from the background; the page keeps going as long as Android lets it.
        }
    }

    static void setSpeaker(boolean on) {
        speakerChoice = on;
        CallService s = instance;
        if (s != null) s.main.post(s::applyAudio);
    }

    static boolean speakerOn(Context c) {
        AudioManager am = c.getSystemService(AudioManager.class);
        if (am == null) return false;
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo d = am.getCommunicationDevice();
            return d != null && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
        }
        return am.isSpeakerphoneOn();
    }

    // ── Service ────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    /** Hang up or mute, from a notification's button or the picture-in-picture window's. */
    static PendingIntent action(Context c, String action) {
        return PendingIntent.getService(c, ACTION_MUTE.equals(action) ? 72 : 71, new Intent(c, CallService.class).setAction(action),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_STOP : intent.getAction();
        if (ACTION_HANGUP.equals(action)) {
            // The page ends it and then reports "none", which stops this service.
            if (!MainActivity.send(Push.event("hangup"))) stop(startId);
            return START_NOT_STICKY;
        }
        if (ACTION_MUTE.equals(action)) {
            MainActivity.send(Push.event("mute"));
            return START_NOT_STICKY;
        }
        if (!ACTION_UPDATE.equals(action)) {
            stop(startId);
            return START_NOT_STICKY;
        }
        try {
            session = new JSONObject(intent.getStringExtra("session"));
        } catch (Exception e) {
            stop(startId);
            return START_NOT_STICKY;
        }
        if (!goForeground(build())) {
            stop(startId);
            return START_NOT_STICKY;
        }
        running = true;
        kind = session.optString("kind", "none");
        // Answered in the app: the phone's own ringing stops.
        String callId = session.optString("callId");
        if ("call".equals(session.optString("kind")) && ActionReceiver.isId(callId)) IncomingCall.stopRinging(this, callId);
        applyAudio();
        // Chromium sets up call audio as the call connects; route again once it has.
        main.postDelayed(this::applyAudio, 1500);
        return START_NOT_STICKY;
    }

    /**
     * Android 14+ only allows a microphone or camera service once that
     * permission is granted, so ask for what's allowed now; it's updated as
     * the call goes on. Returns false when Android refuses altogether.
     */
    private boolean goForeground(Notification n) {
        if (Build.VERSION.SDK_INT < 29) {
            startForeground(ID, n);
            return true;
        }
        String kind = session.optString("kind");
        boolean talking = "call".equals(kind) || "voice".equals(kind);
        int types = 0;
        if (Build.VERSION.SDK_INT >= 30) {
            if (talking && granted(Manifest.permission.RECORD_AUDIO)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (session.optBoolean("video") && granted(Manifest.permission.CAMERA)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        }
        int[] attempts = types == 0
                ? new int[] { ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK }
                : new int[] { types, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK };
        for (int t : attempts) {
            try {
                ServiceCompat.startForeground(this, ID, n, t);
                return true;
            } catch (Exception ignored) {
                // Try the next, smaller set.
            }
        }
        return running; // already in the foreground from before
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private Notification build() {
        String kind = session.optString("kind");
        String name = session.optString("name", getString(R.string.app_name));
        boolean video = session.optBoolean("video");
        long startedAt = session.optLong("startedAt", 0);
        PendingIntent open = Notifications.open(this, null, 70);
        PendingIntent hangup = action(this, ACTION_HANGUP);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, AddaApp.CH_ONGOING)
                .setColor(Notifications.BRAND)
                .setOngoing(true)
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(open)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (startedAt > 0) b.setUsesChronometer(true).setWhen(startedAt).setShowWhen(true);

        if ("call".equals(kind)) {
            String phase = session.optString("phase");
            int status = "outgoing".equals(phase) ? R.string.call_calling
                    : "connecting".equals(phase) ? R.string.call_connecting
                    : video ? R.string.call_ongoing_video : R.string.call_ongoing_voice;
            Person p = new Person.Builder().setName(name).setIcon(Avatars.icon(this, name, session.optInt("hue", 260), session.optString("photo"))).setImportant(true).build();
            b.setSmallIcon(video ? R.drawable.ic_video : R.drawable.ic_call)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentTitle(name)
                    .setContentText(getString(status))
                    .setStyle(NotificationCompat.CallStyle.forOngoingCall(p, hangup).setIsVideo(video))
                    .addPerson(p);
        } else if ("voice".equals(kind)) {
            // "video": my camera is on in the room's call.
            b.setSmallIcon(video ? R.drawable.ic_video : R.drawable.ic_mic)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentTitle(getString(video ? R.string.room_video : R.string.room_voice))
                    .setContentText(name)
                    .addAction(R.drawable.ic_call_end, getString(R.string.leave), hangup);
        } else if ("watch".equals(kind)) {
            // A room's video playing on (its sound) while the app is out of sight.
            b.setSmallIcon(R.drawable.ic_play)
                    .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                    .setContentTitle(session.optString("title", getString(R.string.app_name)))
                    .setContentText(getString(session.optBoolean("paused") ? R.string.watching_paused : R.string.watching_in, name))
                    .addAction(R.drawable.ic_stop, getString(R.string.stop), hangup);
        } else {
            boolean screen = "screen".equals(session.optString("mode"));
            b.setSmallIcon(R.drawable.ic_radio)
                    .setCategory(NotificationCompat.CATEGORY_SERVICE)
                    .setContentTitle(getString(screen ? R.string.live_screen : R.string.live_file))
                    .setContentText(getString(R.string.live_to, name))
                    .addAction(R.drawable.ic_stop, getString(R.string.stop), hangup);
        }
        return b.build();
    }

    // ── Sound: earpiece or loudspeaker, and the proximity sensor ─────────

    private void applyAudio() {
        if (!running) return;
        AudioManager am = getSystemService(AudioManager.class);
        if (am == null) return;
        String kind = session.optString("kind");
        boolean oneToOne = "call".equals(kind);
        boolean voiceCall = oneToOne && !session.optBoolean("video");
        // Headphones or a headset take the sound wherever they are; a video's sound plays as media.
        if (hasHeadset(am) || "live".equals(kind) || "watch".equals(kind)) {
            releaseProximity();
            return;
        }
        boolean speaker = speakerChoice != null ? speakerChoice : !voiceCall;
        route(am, speaker);
        // The screen turns off at your ear (only when the sound is at your ear).
        if (oneToOne && !speaker && "active".equals(session.optString("phase"))) holdProximity();
        else releaseProximity();
        // What actually happened (a tablet has no earpiece, say), not what was asked for.
        MainActivity.send(Push.event("speaker").put("on", speakerOn(this)));
    }

    private void route(AudioManager am, boolean speaker) {
        routed = true;
        if (Build.VERSION.SDK_INT >= 31) {
            int want = speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (d.getType() == want) {
                    am.setCommunicationDevice(d);
                    return;
                }
            }
        } else {
            am.setSpeakerphoneOn(speaker);
        }
    }

    private static boolean hasHeadset(AudioManager am) {
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            switch (d.getType()) {
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                    return true;
                default:
                    if (Build.VERSION.SDK_INT >= 31 && d.getType() == AudioDeviceInfo.TYPE_BLE_HEADSET) return true;
            }
        }
        return false;
    }

    private void holdProximity() {
        if (proximity != null && proximity.isHeld()) return;
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm == null || !pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
        proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "AddaKhana:call");
        proximity.setReferenceCounted(false);
        proximity.acquire(4 * 60 * 60 * 1000L);
    }

    private void releaseProximity() {
        if (proximity != null && proximity.isHeld()) proximity.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY);
        proximity = null;
    }

    /**
     * Stops, unless another request is already queued behind this one: moving
     * voice from one room to another sends "none" then the new room, and that
     * second one must keep the service (and the microphone) going.
     */
    private void stop(int startId) {
        if (stopSelfResult(startId)) tearDown();
    }

    private void tearDown() {
        running = false;
        kind = "none";
        speakerChoice = null;
        main.removeCallbacksAndMessages(null);
        releaseProximity();
        AudioManager am = getSystemService(AudioManager.class);
        if (routed && am != null) {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
            else am.setSpeakerphoneOn(false);
        }
        routed = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
    }

    @Override
    public void onDestroy() {
        if (running) tearDown();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
