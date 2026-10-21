package com.addakhana.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Debug builds only: delivers a push as if it came from Firebase, for testing
 * without a Firebase project:
 *   adb shell am broadcast -n com.addakhana.app/.DebugPushReceiver --es data '{"type":"message",…}'
 */
public class DebugPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String raw = intent.getStringExtra("data");
        if (raw == null) return;
        try {
            JSONObject o = new JSONObject(raw);
            Map<String, String> data = new HashMap<>();
            for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                data.put(k, String.valueOf(o.get(k)));
            }
            // Off the main thread, like Firebase's own deliveries (which may download a sender's photo).
            PendingResult done = goAsync();
            Context app = context.getApplicationContext();
            new Thread(() -> {
                try {
                    Push.handle(app, data);
                } finally {
                    done.finish();
                }
            }, "test-push").start();
        } catch (Exception e) {
            android.util.Log.w("AddaPush", "Bad test push", e);
        }
    }
}
