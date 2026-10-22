package com.addakhana.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Looper;
import android.util.LruCache;

import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.drawable.IconCompat;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The web app's avatars: someone's profile photo, or initials on a two-tone
 * gradient from their hue.
 */
final class Avatars {
    private Avatars() {}

    /** First letters of the first two words, like the web app. */
    static String initials(String name) {
        StringBuilder out = new StringBuilder();
        int words = 0;
        for (String w : (name == null ? "" : name.trim()).split("\\s+")) {
            if (w.isEmpty()) continue;
            out.appendCodePoint(w.codePointAt(0));
            if (++words == 2) break;
        }
        return out.length() == 0 ? "?" : out.toString().toUpperCase(Locale.getDefault());
    }

    static Bitmap bitmap(String name, int hue, int size) {
        Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        int from = ColorUtils.HSLToColor(new float[] { hue % 360, 0.78f, 0.62f });
        int to = ColorUtils.HSLToColor(new float[] { (hue + 48) % 360, 0.72f, 0.48f });
        Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        bg.setShader(new LinearGradient(0, 0, size, size, from, to, Shader.TileMode.CLAMP));
        c.drawCircle(size / 2f, size / 2f, size / 2f, bg);

        Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
        text.setColor(0xFFFFFFFF);
        text.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        text.setTextSize(size * 0.38f);
        text.setTextAlign(Paint.Align.CENTER);
        text.setShadowLayer(size * 0.02f, 0, size * 0.01f, 0x40000000);
        String label = initials(name);
        Rect bounds = new Rect();
        text.getTextBounds(label, 0, label.length(), bounds);
        c.drawText(label, size / 2f, size / 2f - bounds.exactCenterY(), text);
        return b;
    }

    static IconCompat icon(String name, int hue) {
        return IconCompat.createWithBitmap(bitmap(name, hue, 192));
    }

    /** Their photo when there is one (see photo()), else their initials. */
    static Bitmap bitmap(Context c, String name, int hue, String photo, int size) {
        Bitmap b = photo(c, photo, size);
        return b != null ? b : bitmap(name, hue, size);
    }

    static IconCompat icon(Context c, String name, int hue, String photo) {
        return IconCompat.createWithBitmap(bitmap(c, name, hue, photo, 192));
    }

    /** Like icon(), but never waits for a download (a ringing phone mustn't): a kept photo, else initials. */
    static IconCompat iconNow(Context c, String name, int hue, String photo) {
        Bitmap b = photo(c, photo, 192, false);
        return IconCompat.createWithBitmap(b != null ? b : bitmap(name, hue, 192));
    }

    // ── Profile photos ─────────────────────────────────────────────────

    private static final Pattern PHOTO = Pattern.compile("/api/(?:users|rooms)/[0-9a-fA-F-]{36}/photo/[0-9a-f]{16}");
    private static final int MAX_PHOTO_BYTES = 3 * 1024 * 1024;
    private static final LruCache<String, Bitmap> kept = new LruCache<>(48);
    private static final Set<String> fetching = Collections.synchronizedSet(new HashSet<>());

    /**
     * Someone's profile photo (an address on this app's server) as a circle, or
     * null: none, or not to be had right now. Off the main thread it's
     * downloaded, signed in as this phone's user, and kept on the phone (each
     * version has its own address, so a kept one never goes stale). On the main
     * thread only a kept one is used, and it's fetched for next time.
     */
    static Bitmap photo(Context c, String path, int size) {
        return photo(c, path, size, true);
    }

    private static Bitmap photo(Context c, String path, int size, boolean download) {
        if (path == null || !PHOTO.matcher(path).matches()) return null;
        String key = path + "@" + size;
        Bitmap b = kept.get(key);
        if (b != null) return b;
        File file = new File(new File(c.getCacheDir(), "photos"), path.replaceAll("[^0-9a-fA-F]", "") + ".jpg");
        byte[] bytes = null;
        if (file.isFile()) {
            try (InputStream in = new FileInputStream(file)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                bytes = out.toByteArray();
            } catch (Exception ignored) {
                // Downloaded again below.
            }
        }
        if (bytes == null) {
            if (!download || Looper.myLooper() == Looper.getMainLooper()) {
                prefetch(c, path);
                return null;
            }
            bytes = Api.get(path, MAX_PHOTO_BYTES);
            if (bytes == null) return null;
            File dir = file.getParentFile();
            if (dir != null && (dir.isDirectory() || dir.mkdirs())) {
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                } catch (Exception ignored) {
                    // Just not kept.
                }
            }
        }
        b = circle(BitmapFactory.decodeByteArray(bytes, 0, bytes.length), size);
        if (b != null) kept.put(key, b);
        return b;
    }

    /** Fetches a photo in the background, so it's there next time. */
    static void prefetch(Context c, String path) {
        if (path == null || !PHOTO.matcher(path).matches() || !fetching.add(path)) return;
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                photo(app, path, 192);
            } finally {
                fetching.remove(path);
            }
        }, "photo").start();
    }

    /** The middle square of a picture, cut into a circle. */
    private static Bitmap circle(Bitmap src, int size) {
        if (src == null) return null;
        int side = Math.min(src.getWidth(), src.getHeight());
        Bitmap square = Bitmap.createBitmap(src, (src.getWidth() - side) / 2, (src.getHeight() - side) / 2, side, side);
        Bitmap scaled = Bitmap.createScaledBitmap(square, size, size, true);
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        paint.setShader(new BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        new Canvas(out).drawCircle(size / 2f, size / 2f, size / 2f, paint);
        return out;
    }

    static int hue(String value) {
        try {
            return Integer.parseInt(value);
        } catch (Exception e) {
            return 260;
        }
    }
}
