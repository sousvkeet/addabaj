package com.addakhana.app.push

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.RemoteInput
import com.addakhana.app.Graph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Buttons on notifications that work without opening the app: Reply, Mark as read, Decline. */
class ActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_REPLY = "com.addakhana.app.REPLY"
        const val ACTION_READ = "com.addakhana.app.READ"
        const val ACTION_DISMISS = "com.addakhana.app.DISMISS"
        const val ACTION_DECLINE = "com.addakhana.app.DECLINE"

        private val ID = Regex("[0-9a-fA-F-]{36}")
        private val work = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        fun isId(s: String?) = s != null && ID.matches(s)

        fun pending(c: Context, action: String, scope: String, chatId: String, mutable: Boolean): PendingIntent {
            val i = Intent(c, ActionReceiver::class.java).setAction(action).putExtra("scope", scope).putExtra("chatId", chatId)
            // Reply needs a mutable intent: Android fills in the typed text.
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (mutable) (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0) else PendingIntent.FLAG_IMMUTABLE
            return PendingIntent.getBroadcast(c, (action + scope + chatId).hashCode(), i, flags)
        }

        fun decline(c: Context, callId: String): PendingIntent {
            val i = Intent(c, ActionReceiver::class.java).setAction(ACTION_DECLINE).putExtra("callId", callId)
            return PendingIntent.getBroadcast(c, (ACTION_DECLINE + callId).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        private fun isChat(scope: String?, chatId: String?) = (scope == "dm" || scope == "room") && isId(chatId)
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        Graph.init(context.applicationContext)
        val scope = intent.getStringExtra("scope")
        val chatId = intent.getStringExtra("chatId")
        val callId = intent.getStringExtra("callId")
        val reply = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.KEY_REPLY)?.toString()?.trim().orEmpty()
        val done = goAsync()
        work.launch {
            try {
                when (action) {
                    ACTION_REPLY -> if (isChat(scope, chatId) && reply.isNotEmpty()) reply(scope!!, chatId!!, reply)
                    ACTION_READ -> if (isChat(scope, chatId)) {
                        Graph.notifications.clearChat(scope, chatId)
                        runCatching { if (scope == "room") Graph.api.roomRead(chatId!!) else Graph.api.dmRead(chatId!!) }
                    }
                    // Swiped away: start afresh with the next message.
                    ACTION_DISMISS -> if (isChat(scope, chatId)) Graph.notifications.forget(scope!!, chatId!!)
                    ACTION_DECLINE -> if (isId(callId)) {
                        IncomingCall.stopRinging(context.applicationContext, callId!!)
                        Graph.calls.declinedElsewhere(callId)
                        runCatching { Graph.api.declineCall(callId) }
                    }
                }
            } finally {
                done.finish()
            }
        }
    }

    private suspend fun reply(scope: String, chatId: String, text: String) {
        val sent = runCatching { if (scope == "room") Graph.api.replyRoom(chatId, text) else Graph.api.replyDm(chatId, text) }.isSuccess
        if (sent) {
            // Replying means you've read it. The reply shows for a moment (so you see it went), then the notification goes.
            Graph.notifications.showReply(scope, chatId, text, sent = true)
            runCatching { if (scope == "room") Graph.api.roomRead(chatId) else Graph.api.dmRead(chatId) }
            delay(1_500)
            Graph.notifications.clearChat(scope, chatId)
        } else {
            Graph.notifications.showReply(scope, chatId, text, sent = false)
        }
    }
}
