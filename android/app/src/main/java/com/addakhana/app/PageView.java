package com.addakhana.app;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * The app's WebView. While a call, room voice or a live stream from this
 * phone runs, the page must keep going with the app out of sight, which a
 * WebView doesn't do for a page it thinks is hidden: current WebViews freeze
 * a hidden page once it has been silent for a minute, so the server stops
 * hearing from it and drops the call or the seat; and a hidden page's video
 * is paused for good, which would stop a stream. So, only
 * then, the WebView isn't told the app went out of sight; the page is told
 * instead (a "sight" event) and acts as it would when hidden. With the app
 * closed meanwhile, the page waits in a window of its own (see Backstage).
 */
final class PageView extends WebView {
    /** A call, room voice, or a live stream from this phone (see MainActivity.keepsAwake). */
    private boolean awake;
    /** Out of sight, but the WebView wasn't told. */
    private boolean masked;
    /** In the backstage window: out of sight, whatever that window says. */
    private boolean backstage;
    private int windowVisibility = View.VISIBLE;

    PageView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        if (backstage) visibility = View.GONE;
        windowVisibility = visibility;
        if (awake && visibility != View.VISIBLE) {
            if (!masked) {
                masked = true;
                MainActivity.send(Push.event("sight").put("visible", false));
            }
            return;
        }
        if (masked) {
            masked = false;
            MainActivity.send(Push.event("sight").put("visible", true));
        }
        super.onWindowVisibilityChanged(visibility);
    }

    /** Something that must keep going out of sight started (or stopped). */
    void keepAwake(boolean on) {
        if (awake == on) return;
        awake = on;
        if (!on && masked) {
            // Out of sight all along: now the WebView may know (and the page goes by it again).
            masked = false;
            MainActivity.send(Push.event("sight").put("visible", JSONObject.NULL));
            super.onWindowVisibilityChanged(windowVisibility);
        }
    }

    boolean awake() {
        return awake;
    }

    void backstage(boolean on) {
        backstage = on;
    }
}
