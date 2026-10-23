package com.addakhana.app.data

import com.addakhana.app.Graph
import com.addakhana.app.model.Message
import com.addakhana.app.model.User
import com.addakhana.app.ui.messagePreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Messages that arrive while a video call covers the app, as banners over it
 * (at most 3, 6 seconds each; more from the same chat counted in one). Muted
 * chats stay quiet, except a room's mentions of me.
 */
class CallNotices {
    data class Notice(val key: String, val path: String, val title: String, val text: String, val count: Int, val name: String, val hue: Int, val photo: String?, val room: Boolean, val at: Long)

    private val _items = MutableStateFlow<List<Notice>>(emptyList())
    val items: StateFlow<List<Notice>> = _items.asStateFlow()

    /** A video call's window covers the app right now. */
    private fun covered(): Boolean {
        val call = Graph.calls.state.value
        val voice = Graph.voice.state.value
        val callStage = call.inCall && !call.minimized && (call.videoCall || call.peerCameraOn || call.cameraOn)
        val roomStage = voice.live && !voice.minimized && (Graph.chat.now.voice[voice.roomId].orEmpty().any { it.camera } || voice.cameraOn)
        return (callStage || roomStage) && AppLifecycle.foreground.value
    }

    fun dm(m: Message, partner: User) {
        if (m.senderId == Graph.auth.user?.id || m.kind != "text" || !covered()) return
        if (mutedNow(Graph.chat.now.conversations[partner.id]?.mutedUntil)) return
        // The call's own person: they can just say it.
        if (Graph.calls.state.value.peer?.id == partner.id) return
        add(Notice("dm:${partner.id}", "/chats/${partner.id}", partner.name, messagePreview(m, false), 1, partner.name, partner.hue, partner.photo, false, System.currentTimeMillis()))
    }

    fun room(m: Message) {
        val roomId = m.roomId ?: return
        val me = Graph.auth.user?.id
        if (m.sender?.id == me || m.kind != "text" || !covered()) return
        val room = Graph.chat.now.rooms[roomId] ?: return
        if (mutedNow(room.mutedUntil) && !isForMe(m, me)) return
        add(Notice("room:$roomId", "/rooms/$roomId", room.name, "${m.sender?.name?.split(' ')?.first()}: ${messagePreview(m, false)}", 1, room.name, com.addakhana.app.ui.components.hueFromId(roomId), room.photo, true, System.currentTimeMillis()))
    }

    private fun add(n: Notice) {
        _items.update { list ->
            val same = list.firstOrNull { it.key == n.key }
            val next = if (same != null) n.copy(count = same.count + 1) else n
            (list.filterNot { it.key == n.key } + next).takeLast(3)
        }
        Graph.scope.launch {
            delay(6_000)
            _items.update { list -> list.filterNot { it.key == n.key && it.at <= n.at } }
        }
    }

    fun dismiss(key: String) = _items.update { list -> list.filterNot { it.key == key } }
}
