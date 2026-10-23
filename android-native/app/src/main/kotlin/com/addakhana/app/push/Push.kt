package com.addakhana.app.push

import android.content.Context
import com.addakhana.app.Graph
import com.addakhana.app.net.Api
import com.addakhana.app.net.Realtime
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Push notifications from the server (Firebase Cloud Messaging). The token
 * says where this phone's notifications go; it's given to the server on
 * every connection while someone is signed in. Without Firebase's settings
 * in the build this all does nothing.
 */
class Push(private val c: Context, private val api: Api, private val realtime: Realtime, private val scope: CoroutineScope) {
    private val prefs = c.getSharedPreferences("push", Context.MODE_PRIVATE)
    val configured: Boolean get() = runCatching { FirebaseApp.getApps(c).isNotEmpty() }.getOrDefault(false)
    val token: String get() = prefs.getString("token", "").orEmpty()

    init {
        scope.launch { realtime.connects.collect { register() } }
    }

    /** Asks Firebase for this phone's token. */
    fun refreshToken() {
        if (!configured) return
        runCatching { FirebaseMessaging.getInstance().token.addOnSuccessListener { save(it) } }
    }

    fun save(token: String?) {
        if (token.isNullOrEmpty() || token == this.token) return
        prefs.edit().putString("token", token).apply()
        scope.launch { register() }
    }

    /** Tells the server where this phone's notifications go (each connection: the server ties it to this login). */
    private suspend fun register() {
        val t = token
        if (t.isEmpty() || Graph.auth.user == null) return
        runCatching { api.registerPush(t) }
    }

    /** Before logging out: the server stops sending here, and a fresh token waits for the next login. */
    suspend fun unregister() {
        val t = token
        if (t.isNotEmpty()) runCatching { api.unregisterPush(t) }
        prefs.edit().remove("token").apply()
        if (configured) runCatching { FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener { refreshToken() } }
    }

    /** One push from the server (see server/src/services/push.js for what each carries). */
    fun handle(data: Map<String, String>) {
        // Nobody is signed in on this phone any more.
        if (Graph.auth.user == null) return
        when (data["type"]) {
            "message" -> Graph.notifications.showMessage(data)
            "read" -> Graph.notifications.clearChat(data["scope"], data["chatId"])
            "deleted" -> data["messageId"]?.toLongOrNull()?.let { Graph.notifications.removeMessage(data["scope"], data["chatId"], it) }
            "call" -> {
                IncomingCall.ring(c, data)
                // Connect now, so the call is already here when it's answered.
                Graph.holdConnection(IncomingCall.RING_MS)
            }
            "call_end" -> IncomingCall.ended(c, data)
        }
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Graph.init(applicationContext)
        Graph.push.save(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Graph.init(applicationContext)
        Graph.push.handle(message.data)
    }
}
