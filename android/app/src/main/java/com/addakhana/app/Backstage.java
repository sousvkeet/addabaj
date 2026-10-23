package com.addakhana.app;

import android.app.Presentation;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

/**
 * Where the page waits while a call, room voice or live stream goes on with
 * the app closed (swiped away in recents, say). A WebView taken out of its
 * window counts as hidden, and current WebViews freeze a hidden page once it
 * has been silent for a minute, which drops the call. So the page goes into a
 * window of its own, on a private virtual display that shows nothing
 * anywhere, until the app opens again or nothing runs any more. It still
 * hears it's out of sight (see PageView), and draws nothing meanwhile.
 */
final class Backstage {
    private static VirtualDisplay display;
    private static Presentation window;
    private static FrameLayout frame;

    private Backstage() {}

    /** Takes the page, just out of the activity that showed it (this size, so its layout stays as it was). */
    static void hold(Context app, PageView page, int width, int height, int densityDpi) {
        release(page);
        try {
            DisplayManager displays = app.getSystemService(DisplayManager.class);
            display = displays.createVirtualDisplay("Adda Khana backstage", Math.max(width, 1), Math.max(height, 1), densityDpi, null, 0);
            window = new Presentation(app, display.getDisplay());
            window.getWindow().addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
            frame = new FrameLayout(window.getContext());
            page.backstage(true);
            page.setVisibility(View.INVISIBLE);
            frame.addView(page, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            window.setContentView(frame);
            window.show();
        } catch (RuntimeException e) {
            // Not allowed on this phone: the page stays without a window, as before.
            release(page);
        }
    }

    /** Lets the page go: back to the app's window, or closing. Nothing when it isn't here. */
    static void release(PageView page) {
        if (display == null && window == null && frame == null) return;
        if (page != null) {
            if (frame != null && page.getParent() == frame) frame.removeView(page);
            page.backstage(false);
            page.setVisibility(View.VISIBLE);
        }
        if (window != null) {
            try {
                window.dismiss();
            } catch (RuntimeException ignored) {
                // Its display is already gone.
            }
            window = null;
        }
        frame = null;
        if (display != null) {
            display.release();
            display = null;
        }
    }
}
