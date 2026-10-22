package com.addakhana.app;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * The app's WebView. While this phone streams a video file live to a room,
 * the page must keep playing that file with the app out of sight, which a
 * WebView doesn't do for a page it thinks is hidden: it pauses the video and
 * won't let it play again, so the stream would stop for everyone. So, only
 * then, the WebView isn't told the app went out of sight; the page is told
 * instead (a "sight" event) and acts as it would when hidden.
 */
final class PageView extends WebView {
    /** Streaming a file live from this phone (see MainActivity.Bridge.callState). */
    private boolean awake;
    /** Out of sight, but the WebView wasn't told. */
    private boolean masked;
    private int windowVisibility = View.VISIBLE;

    PageView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
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

    /** A live file stream from this phone started (or stopped). */
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
}
