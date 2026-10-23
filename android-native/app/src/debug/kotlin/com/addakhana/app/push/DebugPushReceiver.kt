package com.addakhana.app.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.addakhana.app.Graph
import org.json.JSONObject

/**
 * Debug builds only: a pretend push, for testing notifications and ringing
 * without Firebase:
 *   adb shell am broadcast -n com.addakhana.app.dev/com.addakhana.app.push.DebugPushReceiver --es data '{"type":"message",…}'
 */
class DebugPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val raw = intent.getStringExtra("data") ?: return
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val data = json.keys().asSequence().associateWith { json.optString(it) }
        Graph.init(context.applicationContext)
        val done = goAsync()
        Thread {
            try {
                Graph.push.handle(data)
            } finally {
                done.finish()
            }
        }.start()
    }
}
