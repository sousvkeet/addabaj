package com.addakhana.app;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.Typeface;

import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.drawable.IconCompat;

import java.util.Locale;

/** The web app's avatars: initials on a two-tone gradient from the person's hue. */
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

    static int hue(String value) {
        try {
            return Integer.parseInt(value);
        } catch (Exception e) {
            return 260;
        }
    }
}
