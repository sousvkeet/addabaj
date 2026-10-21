package com.addakhana.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Surface;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.nio.ByteBuffer;

/**
 * Screen sharing for live streams. WebView can't capture the screen, so the
 * app does: Android's screen recording (MediaProjection, after the system's
 * own permission prompt) is encoded to H.264 and handed to the page, which
 * turns it into an ordinary video track (client/src/lib/native.ts).
 */
public class ScreenCaptureService extends Service {
    static final String ACTION_START = "com.addakhana.app.SCREEN_START";
    static final String ACTION_STOP = "com.addakhana.app.SCREEN_STOP";
    static final int ID = 6;
    /** The longest side sent; plenty for a phone screen, light on the uplink. */
    private static final int MAX_SIDE = 1280;

    static volatile boolean running;
    private static volatile ScreenCaptureService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaCodec encoder;
    private Surface input;
    private Thread drain;
    private volatile boolean stopping;
    private byte[] config;

    /** The page asked for a fresh full picture (its decoder lost track). */
    static void requestKeyFrame() {
        ScreenCaptureService s = instance;
        MediaCodec e = s == null ? null : s.encoder;
        if (e == null) return;
        Bundle b = new Bundle();
        b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try {
            e.setParameters(b);
        } catch (Exception ignored) {
            // Encoder already stopped.
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !ACTION_START.equals(intent.getAction()) || running) {
            // Stopped from the page or the notification.
            finish(intent != null && intent.getBooleanExtra("fromPage", false) ? End.QUIET : End.TELL_PAGE);
            return START_NOT_STICKY;
        }
        // Android 10+ wants the service in the foreground before the capture starts.
        Notification n = notification();
        try {
            if (Build.VERSION.SDK_INT >= 29) ServiceCompat.startForeground(this, ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            else startForeground(ID, n);
        } catch (Exception e) {
            fail();
            return START_NOT_STICKY;
        }
        running = true;
        try {
            Intent data = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra("data", Intent.class)
                    : legacyData(intent);
            MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
            projection = mpm.getMediaProjection(intent.getIntExtra("code", 0), data);
            if (projection == null) throw new IllegalStateException("no projection");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    // Stopped from Android's own "stop sharing" (status bar chip, cast tile).
                    finish(End.TELL_PAGE);
                }
            }, main);
            start();
        } catch (Exception e) {
            fail();
        }
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private static Intent legacyData(Intent intent) {
        return intent.getParcelableExtra("data");
    }

    private void start() throws Exception {
        int[] size = captureSize();
        int width = size[0];
        int height = size[1];
        encoder = encoder(width, height);
        input = encoder.createInputSurface();
        encoder.start();
        DisplayMetrics dm = getResources().getDisplayMetrics();
        display = projection.createVirtualDisplay("AddaKhanaScreen", width, height, dm.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, main);
        MainActivity.screenStarted(width, height);
        drain = new Thread(this::drainLoop, "screen-encoder");
        drain.start();
    }

    /** The screen scaled so its longest side is at most MAX_SIDE, in multiples of 16 (what encoders like). */
    private int[] captureSize() {
        int w;
        int h;
        WindowManager wm = getSystemService(WindowManager.class);
        if (Build.VERSION.SDK_INT >= 30) {
            Rect r = wm.getMaximumWindowMetrics().getBounds();
            w = r.width();
            h = r.height();
        } else {
            DisplayMetrics m = new DisplayMetrics();
            legacyRealMetrics(wm, m);
            w = m.widthPixels;
            h = m.heightPixels;
        }
        float scale = Math.min(1f, (float) MAX_SIDE / Math.max(w, h));
        return new int[] { Math.max(16, Math.round(w * scale / 16) * 16), Math.max(16, Math.round(h * scale / 16) * 16) };
    }

    @SuppressWarnings("deprecation")
    private static void legacyRealMetrics(WindowManager wm, DisplayMetrics m) {
        wm.getDefaultDisplay().getRealMetrics(m);
    }

    private static MediaCodec encoder(int width, int height) throws Exception {
        MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        try {
            codec.configure(format(width, height, true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        } catch (Exception e) {
            // Some encoders refuse the profile hint; let them pick.
            codec.configure(format(width, height, false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        }
        return codec;
    }

    private static MediaFormat format(int width, int height, boolean baseline) {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, Math.min(4_000_000, Math.max(1_000_000, width * height * 3)));
        f.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        // A still screen produces no new frames; repeat the last one so late viewers still get a picture.
        f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
        if (baseline) f.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
        return f;
    }

    private void drainLoop() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        MediaCodec codec = encoder;
        while (!stopping) {
            int index;
            try {
                index = codec.dequeueOutputBuffer(info, 100_000);
            } catch (Exception e) {
                break;
            }
            if (index < 0) continue;
            try {
                ByteBuffer buf = codec.getOutputBuffer(index);
                if (buf != null && info.size > 0) {
                    byte[] bytes = new byte[info.size];
                    buf.position(info.offset);
                    buf.get(bytes, 0, info.size);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        config = bytes;
                    } else {
                        boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                        // Every key frame carries the stream setup (SPS/PPS), so the page can start from any of
                        // them. Done here rather than with KEY_PREPEND_HEADER_TO_SYNC_FRAMES, which many encoders refuse.
                        if (key && config != null && !startsWithSps(bytes)) bytes = concat(config, bytes);
                        MainActivity.screenFrame(key, info.presentationTimeUs, Base64.encodeToString(bytes, Base64.NO_WRAP));
                    }
                }
                codec.releaseOutputBuffer(index, false);
            } catch (Exception e) {
                break;
            }
        }
        try {
            codec.stop();
        } catch (Exception ignored) {
            // Already stopped.
        }
        codec.release();
    }

    private static boolean startsWithSps(byte[] b) {
        int at = b.length > 4 && b[0] == 0 && b[1] == 0 && b[2] == 1 ? 3 : b.length > 4 && b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 1 ? 4 : -1;
        return at > 0 && (b[at] & 0x1f) == 7;
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private Notification notification() {
        PendingIntent stop = PendingIntent.getService(this, 81, new Intent(this, ScreenCaptureService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, AddaApp.CH_ONGOING)
                .setSmallIcon(R.drawable.ic_screen)
                .setColor(Notifications.BRAND)
                .setContentTitle(getString(R.string.screen_sharing))
                .setContentText(getString(R.string.screen_sharing_text))
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(Notifications.open(this, null, 80))
                .addAction(R.drawable.ic_stop, getString(R.string.stop_sharing), stop)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    private enum End { TELL_PAGE, QUIET, FAILED }

    private void fail() {
        finish(End.FAILED);
    }

    private void finish(End how) {
        boolean wasRunning = running;
        running = false;
        stopping = true;
        main.removeCallbacksAndMessages(null);
        if (display != null) display.release();
        display = null;
        if (projection != null) {
            MediaProjection p = projection;
            projection = null;
            try {
                p.stop();
            } catch (Exception ignored) {
                // Already stopped.
            }
        }
        if (drain == null && encoder != null) encoder.release();
        encoder = null;
        drain = null;
        if (input != null) input.release();
        input = null;
        if (wasRunning || how == End.FAILED) MainActivity.screenEnded(how == End.FAILED ? "failed" : how == End.TELL_PAGE ? "ended" : null);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (running) finish(End.TELL_PAGE);
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
