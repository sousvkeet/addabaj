package com.addakhana.app.data

import android.content.Context
import com.addakhana.app.Graph
import com.addakhana.app.model.Attachment
import com.addakhana.app.model.ClearAfter
import com.addakhana.app.model.Conversation
import com.addakhana.app.model.ForwardResult
import com.addakhana.app.model.Invite
import com.addakhana.app.model.LinkPreview
import com.addakhana.app.model.LocalFile
import com.addakhana.app.model.Mention
import com.addakhana.app.model.Message
import com.addakhana.app.model.Reaction
import com.addakhana.app.model.ReplyRef
import com.addakhana.app.model.Room
import com.addakhana.app.model.Scope
import com.addakhana.app.model.Sender
import com.addakhana.app.model.User
import com.addakhana.app.model.VoiceParticipant
import com.addakhana.app.net.Api
import com.addakhana.app.net.ApiError
import com.addakhana.app.net.Connection
import com.addakhana.app.net.Incoming
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.arr
import com.addakhana.app.net.bool
import com.addakhana.app.net.json
import com.addakhana.app.net.long
import com.addakhana.app.net.obj
import com.addakhana.app.net.str
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/**
 * A chat's messages as far as they're loaded, oldest first (messages still
 * sending last). `stale`: a copy kept from last time, or from before this
 * device was away, replaced by the server's when the chat is next opened;
 * `recheck`: the open chat after being away, whose newest page is checked
 * against the server's (see [land]).
 */
@Serializable
data class Paged(
    val items: List<Message> = emptyList(),
    val loaded: Boolean = false,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val stale: Boolean = false,
    val recheck: Boolean = false,
)

data class ChatState(
    /** Everything has come from the server (or from last time's copy) at least once. */
    val bootstrapped: Boolean = false,
    val conversations: Map<String, Conversation> = emptyMap(),
    val rooms: Map<String, Room> = emptyMap(),
    /** Rooms as Room info shows them: members, invites, voice, watching. */
    val roomDetails: Map<String, Room> = emptyMap(),
    val invites: List<Invite> = emptyList(),
    /** Chats' messages, by the other person's id. */
    val dms: Map<String, Paged> = emptyMap(),
    val roomMessages: Map<String, Paged> = emptyMap(),
    /** People the app knows: chat partners, room members. */
    val users: Map<String, User> = emptyMap(),
    val online: Set<String> = emptySet(),
    val lastSeen: Map<String, String> = emptyMap(),
    /** People whose online status and last seen aren't shared with me. */
    val hiddenPresence: Set<String> = emptySet(),
    val dmTyping: Set<String> = emptySet(),
    /** Who's typing in each room: user id to name. */
    val roomTyping: Map<String, Map<String, String>> = emptyMap(),
    /** Who's in each room's voice. */
    val voice: Map<String, List<VoiceParticipant>> = emptyMap(),
    val activeDm: String? = null,
    val activeRoom: String? = null,
)

/** What's kept on the phone between launches (see [save]). */
@Serializable
private data class Kept(
    val version: Int = 1,
    val conversations: List<Conversation> = emptyList(),
    val rooms: List<Room> = emptyList(),
    val invites: List<Invite> = emptyList(),
    val users: List<User> = emptyList(),
    val dms: Map<String, Paged> = emptyMap(),
    val roomMessages: Map<String, Paged> = emptyMap(),
    val roomDetails: List<Room> = emptyList(),
)

/** Muted (my notifications for it are off) right now. */
fun mutedNow(mutedUntil: String?): Boolean = mutedUntil != null && runCatching { Instant.parse(mutedUntil).isAfter(Instant.now()) }.getOrDefault(false)

/** Muted until I turn it back on (the server says year 9999). */
fun mutedForGood(mutedUntil: String?): Boolean = mutedUntil != null && mutedUntil.startsWith("9999")

/** A room message that mentions me, or replies to one of mine: it gets through even when the room is muted. */
fun isForMe(m: Message, me: String?) = me != null && (m.mentions?.any { it.id == me } == true || m.replyTo?.senderId == me)

/** What a room adds to the app's unread counts: its unread messages, or (muted) just the ones for me. */
fun countedUnread(room: Room) = if (mutedNow(room.mutedUntil)) room.unreadMentions else room.unread

fun countedDmUnread(c: Conversation) = if (mutedNow(c.mutedUntil)) 0 else c.unread

/** Pinned first (the last pinned on top), then by newest message. */
fun <T> ordered(items: Collection<T>, pinnedAt: (T) -> String?, newest: (T) -> String): List<T> =
    items.sortedWith { a, b ->
        val pa = pinnedAt(a)
        val pb = pinnedAt(b)
        when {
            (pa != null) != (pb != null) -> if (pa != null) -1 else 1
            pa != null && pb != null -> pb.compareTo(pa)
            else -> newest(b).compareTo(newest(a))
        }
    }

const val MAX_PINNED = 5

/** A message written offline waits this long for the connection to come back. */
private const val OUTBOX_WAIT_MS = 2 * 60_000L

/**
 * Chats and rooms: their lists, messages, who's online and typing, and who's
 * in each room's voice. Kept up to date by the server's live events, and on
 * the phone between launches.
 */
class ChatStore(
    private val context: Context,
    private val api: Api,
    private val realtime: Realtime,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()
    val now: ChatState get() = _state.value

    private var me: User? = null
    private val myId: String? get() = me?.id
    private var eventsJob: Job? = null
    private var saveJob: Job? = null
    private val typingJobs = mutableMapOf<String, Job>()
    private val temps = AtomicLong()
    /** Each chat's sends go out one at a time, in the order they were written (see [takeTurn]). */
    private val lines = mutableMapOf<String, CompletableDeferred<Unit>>()

    private val visible: Boolean get() = AppLifecycle.foreground.value

    private inline fun set(fn: (ChatState) -> ChatState) {
        _state.update(fn)
        scheduleSave()
    }

    // ── Starting and stopping ──────────────────────────────────────────

    /** Signed in: last time's chats at once, then the server's; messages written offline go again. */
    fun start(user: User) {
        if (me?.id == user.id && eventsJob != null) return
        me = user
        _state.value = ChatState()
        val kept = restore(user.id)
        eventsJob?.cancel()
        eventsJob = scope.launch { realtime.events.collect { handle(it) } }
        scope.launch { realtime.connects.collect { sync() } }
        scope.launch {
            AppLifecycle.foreground.collect { shown ->
                if (!shown) {
                    saveNow()
                    return@collect
                }
                // Back on screen: whatever is open is read now.
                now.activeDm?.let { markDmRead(it) }
                now.activeRoom?.let { markRoomRead(it) }
            }
        }
        // Messages written offline before the app was closed are on their way again.
        kept?.let { k ->
            for ((partner, page) in k.dms) page.items.filter { it.pending != null && it.localFile == null && it.attachment == null }.forEach { resend(Scope.Dm, partner, it) }
            for ((roomId, page) in k.roomMessages) page.items.filter { it.pending != null && it.localFile == null && it.attachment == null }.forEach { resend(Scope.Room, roomId, it) }
        }
    }

    fun updateMe(user: User) {
        me = user
    }

    fun clear() {
        eventsJob?.cancel()
        eventsJob = null
        saveJob?.cancel()
        me?.let { file(it.id).delete() }
        me = null
        _state.value = ChatState()
    }

    /** Everything from the server: the lists, then the open chat's newest messages. */
    suspend fun sync() {
        try {
            val conversations = scope.async { api.conversations() }
            val rooms = scope.async { api.rooms() }
            val invites = scope.async { api.invites() }
            val c = conversations.await()
            val r = rooms.await()
            val i = invites.await()
            set { s ->
                // Whatever happened while this device was away shows when each chat is next opened.
                fun outdated(pages: Map<String, Paged>, open: String?) =
                    pages.mapValues { (id, p) -> if (!p.loaded) p else if (id == open) p.copy(recheck = true) else p.copy(stale = true) }
                s.copy(
                    bootstrapped = true,
                    conversations = c.associateBy { it.partner.id },
                    rooms = r.associateBy { it.id },
                    invites = i,
                    users = s.users + c.associate { it.partner.id to it.partner },
                    dms = outdated(s.dms, s.activeDm),
                    roomMessages = outdated(s.roomMessages, s.activeRoom),
                )
            }
            now.activeDm?.let { id ->
                loadDm(id)
                if (visible) markDmRead(id)
            }
            now.activeRoom?.let { id ->
                if (now.rooms.containsKey(id)) {
                    loadRoom(id)
                    loadRoomMessages(id)
                    if (visible) markRoomRead(id)
                }
            }
        } catch (e: Exception) {
            if (realtime.state.value is Connection.Online) Toasts.error(e.message ?: "Couldn't load your chats.")
        }
    }

    fun rememberUser(user: User) = set { s -> s.copy(users = s.users + (user.id to (s.users[user.id]?.let { merged(it, user) } ?: user))) }

    private fun merged(old: User, new: User) = new.copy(email = new.email ?: old.email)

    // ── Chats (direct messages) ────────────────────────────────────────

    fun openDm(partnerId: String?) {
        set { it.copy(activeDm = partnerId) }
        if (partnerId == null) return
        if (!now.users.containsKey(partnerId)) scope.launch { runCatching { api.user(partnerId) }.onSuccess { rememberUser(it) } }
        val page = now.dms[partnerId]
        if (page == null || !page.loaded || page.stale) scope.launch {
            loadDm(partnerId)
            if (visible) markDmRead(partnerId)
        } else if (visible) markDmRead(partnerId)
    }

    suspend fun loadDm(partnerId: String, older: Boolean = false) {
        val page = now.dms[partnerId] ?: Paged()
        if (older && (!page.hasMore || page.loadingMore)) return
        val firstId = page.items.firstOrNull { it.pending == null }?.id
        if (older) set { s -> s.copy(dms = s.dms + (partnerId to page.copy(loadingMore = true))) }
        try {
            val asked = page.items.map { it.id }.toSet()
            val result = api.dmMessages(partnerId, if (older) firstId else null)
            set { s -> s.copy(dms = s.dms + (partnerId to land(s.dms[partnerId] ?: Paged(), result.messages, result.hasMore, older, asked))) }
        } catch (e: Exception) {
            set { s -> s.copy(dms = s.dms + (partnerId to (s.dms[partnerId] ?: Paged()).copy(loadingMore = false))) }
            if (realtime.state.value is Connection.Online || page.items.isEmpty()) Toasts.error(e.message ?: "Couldn't load the messages.")
        }
    }

    /** Sends a message (text, a file, or both; replying to one) in a chat or room. */
    fun send(scope: Scope, chatId: String, body: String, replyTo: ReplyRef? = null, mentions: List<Mention>? = null, file: LocalFile? = null) {
        val user = me ?: return
        val temp = Message(
            id = 0,
            tempId = "tmp-${System.currentTimeMillis()}-${temps.incrementAndGet()}",
            clientId = UUID.randomUUID().toString(),
            kind = "text",
            body = body,
            createdAt = Instant.now().toString(),
            senderId = if (scope == Scope.Dm) user.id else null,
            recipientId = if (scope == Scope.Dm) chatId else null,
            roomId = if (scope == Scope.Room) chatId else null,
            sender = if (scope == Scope.Room) Sender(user.id, user.name, user.hue, user.photo) else null,
            mentions = mentions,
            replyTo = replyTo,
            replyToId = replyTo?.id,
            pending = "sending",
            localFile = file,
            upload = if (file != null) 0 else null,
        )
        put(scope, chatId) { page -> page.copy(loaded = true, items = page.items + temp) }
        deliver(scope, chatId, temp)
    }

    /** A failed message, sent again (the same clientId, so the server saves it once). */
    fun retry(scope: Scope, chatId: String, message: Message) {
        val again = message.copy(pending = "sending")
        put(scope, chatId) { page -> page.copy(items = page.items.map { if (it.tempId == message.tempId) again else it }) }
        deliver(scope, chatId, again)
    }

    /** Gives up on a message that didn't send. */
    fun discard(scope: Scope, chatId: String, message: Message) {
        put(scope, chatId) { page -> page.copy(items = page.items.filterNot { it.tempId == message.tempId }) }
        message.localFile?.let { File(it.path).delete() }
    }

    private fun resend(scope: Scope, chatId: String, message: Message) {
        put(scope, chatId) { page -> page.copy(items = page.items.map { if (it.tempId == message.tempId) it.copy(pending = "sending") else it }) }
        deliver(scope, chatId, message.copy(pending = "sending"))
    }

    private fun deliver(chatScope: Scope, chatId: String, temp: Message) {
        val tid = temp.tempId ?: return
        val turn = takeTurn("${chatScope.wire}:$chatId")
        scope.launch {
            try {
                var attachment: Attachment? = temp.attachment
                val file = temp.localFile
                if (file != null && attachment == null) {
                    attachment = upload(file) { percent -> patchTemp(chatScope, chatId, tid) { it.copy(upload = percent) } }
                    // Uploaded: a retry won't upload again.
                    patchTemp(chatScope, chatId, tid) { it.copy(attachment = attachment, upload = null) }
                }
                turn.ready.await()
                val payload = buildJsonObject {
                    if (chatScope == Scope.Dm) put("to", chatId) else put("roomId", chatId)
                    put("body", temp.body)
                    attachment?.let { put("attachmentId", it.id) }
                    temp.replyTo?.let { put("replyTo", it.id) }
                    temp.mentions?.takeIf { it.isNotEmpty() }?.let { list ->
                        put("mentions", json.encodeToJsonElement(ListSerializer(Mention.serializer()), list))
                    }
                    put("clientId", temp.clientId ?: UUID.randomUUID().toString())
                }
                val answer = try {
                    realtime.request(if (chatScope == Scope.Dm) "dm:send" else "room:send", payload, 10_000, OUTBOX_WAIT_MS)
                } finally {
                    turn.done()
                }
                val message = json.decodeFromJsonElement(Message.serializer(), answer["message"]!!)
                if (file != null) message.attachment?.let { Media.keep(context, File(file.path), it.url) }
                set { s ->
                    if (chatScope == Scope.Dm) {
                        val page = s.dms[chatId] ?: Paged()
                        val partner = s.users[chatId] ?: s.conversations[chatId]?.partner
                        val conv = s.conversations[chatId]
                        s.copy(
                            dms = s.dms + (chatId to page.copy(items = merge(page.items, listOf(message), tid))),
                            conversations = if (partner != null) {
                                s.conversations + (chatId to (conv ?: Conversation(partner)).copy(partner = partner, lastMessage = later(conv?.lastMessage, message)))
                            } else {
                                s.conversations
                            },
                        )
                    } else {
                        val page = s.roomMessages[chatId] ?: Paged()
                        val room = s.rooms[chatId]
                        s.copy(
                            roomMessages = s.roomMessages + (chatId to page.copy(items = merge(page.items, listOf(message), tid))),
                            rooms = if (room != null) s.rooms + (chatId to room.copy(lastMessage = later(room.lastMessage, message), unread = 0, unreadMentions = 0)) else s.rooms,
                        )
                    }
                }
            } catch (e: Exception) {
                turn.done()
                // A file the server no longer has waiting is uploaded again on retry.
                val expired = e.message?.contains("already sent or has expired") == true
                patchTemp(chatScope, chatId, tid) { it.copy(pending = "failed", upload = null, attachment = if (expired) null else it.attachment) }
                Toasts.error(if (e is java.io.IOException && e !is ApiError) "Not sent: there's still no connection." else e.message ?: "Not sent.")
            }
        }
    }

    private suspend fun upload(file: LocalFile, progress: (Int) -> Unit): Attachment {
        // Offline: the file waits for the connection, like a message does.
        if (realtime.state.value !is Connection.Online) {
            kotlinx.coroutines.withTimeoutOrNull(OUTBOX_WAIT_MS) { realtime.state.first { it is Connection.Online } }
                ?: throw java.io.IOException("There's still no connection.")
        }
        val meta = buildJsonObject {
            put("kind", file.kind)
            put("name", file.name)
            put("mime", file.mime)
            file.width?.let { put("width", it) }
            file.height?.let { put("height", it) }
            file.duration?.let { put("duration", it) }
            file.waveform?.let { w -> put("waveform", buildJsonArray { w.forEach { add(JsonPrimitive(it)) } }) }
        }
        var last = -10
        return withContext(Dispatchers.IO) {
            api.upload(File(file.path), meta) { p ->
                if (p - last >= 3 || p == 100) {
                    last = p
                    scope.launch { progress(p) }
                }
            }
        }
    }

    private class Turn(val ready: CompletableDeferred<Unit>, val done: () -> Unit)

    /** Waits for the chat's earlier sends (taken in the order they were written), then goes. */
    private fun takeTurn(chat: String): Turn {
        val before = lines[chat]
        val mine = CompletableDeferred<Unit>()
        lines[chat] = mine
        val ready = CompletableDeferred<Unit>()
        scope.launch {
            before?.await()
            ready.complete(Unit)
        }
        return Turn(ready) {
            mine.complete(Unit)
            if (lines[chat] === mine) lines.remove(chat)
        }
    }

    private fun patchTemp(chatScope: Scope, chatId: String, tid: String, fn: (Message) -> Message) =
        put(chatScope, chatId) { page -> page.copy(items = page.items.map { if (it.tempId == tid) fn(it) else it }) }

    private fun put(chatScope: Scope, chatId: String, fn: (Paged) -> Paged) = set { s ->
        if (chatScope == Scope.Dm) s.copy(dms = s.dms + (chatId to fn(s.dms[chatId] ?: Paged(loaded = true))))
        else s.copy(roomMessages = s.roomMessages + (chatId to fn(s.roomMessages[chatId] ?: Paged(loaded = true))))
    }

    private fun receiveDm(message: Message, partner: User) {
        val mine = myId
        val incoming = message.senderId != mine
        set { s ->
            val page = s.dms[partner.id]
            val isOpen = s.activeDm == partner.id && visible
            val prev = s.conversations[partner.id]
            s.copy(
                users = s.users + (partner.id to (s.users[partner.id]?.let { merged(it, partner) } ?: partner)),
                dms = s.dms + (partner.id to (page ?: Paged()).copy(items = merge(page?.items.orEmpty(), listOf(message)))),
                dmTyping = if (incoming) s.dmTyping - partner.id else s.dmTyping,
                conversations = s.conversations + (
                    partner.id to (prev ?: Conversation(partner)).copy(
                        partner = partner,
                        lastMessage = later(prev?.lastMessage, message),
                        unread = (prev?.unread ?: 0) + if (incoming && !isOpen && message.kind == "text") 1 else 0,
                    )
                    ),
            )
        }
        if (incoming && now.activeDm == partner.id && visible) markDmRead(partner.id)
    }

    fun markDmRead(partnerId: String) {
        Graph.notifications.clearChat("dm", partnerId)
        val s = now
        val mine = myId
        val hasUnread = (s.conversations[partnerId]?.unread ?: 0) > 0 ||
            s.dms[partnerId]?.items?.any { it.senderId == partnerId && it.recipientId == mine && it.readAt == null } == true
        if (!hasUnread) return
        set { st -> st.conversations[partnerId]?.let { st.copy(conversations = st.conversations + (partnerId to it.copy(unread = 0))) } ?: st }
        realtime.emit("dm:read", buildJsonObject { put("partnerId", partnerId) })
    }

    // ── Rooms ──────────────────────────────────────────────────────────

    fun openRoom(roomId: String?) {
        set { it.copy(activeRoom = roomId) }
        if (roomId == null) return
        scope.launch { loadRoom(roomId) }
        val page = now.roomMessages[roomId]
        if (page == null || !page.loaded || page.stale) scope.launch {
            loadRoomMessages(roomId)
            if (visible) markRoomRead(roomId)
        } else if (visible) markRoomRead(roomId)
    }

    suspend fun loadRoom(roomId: String) {
        try {
            upsertRoom(api.room(roomId))
        } catch (e: ApiError) {
            if (e.status == 404 || e.status == 403) dropRoom(roomId)
            else if (realtime.state.value is Connection.Online || !now.roomDetails.containsKey(roomId)) Toasts.error(e.message ?: "Couldn't load the room.")
        } catch (_: Exception) {
        }
    }

    suspend fun loadRoomMessages(roomId: String, older: Boolean = false) {
        val page = now.roomMessages[roomId] ?: Paged()
        if (older && (!page.hasMore || page.loadingMore)) return
        val firstId = page.items.firstOrNull { it.pending == null }?.id
        if (older) set { s -> s.copy(roomMessages = s.roomMessages + (roomId to page.copy(loadingMore = true))) }
        try {
            val asked = page.items.map { it.id }.toSet()
            val result = api.roomMessages(roomId, if (older) firstId else null)
            set { s -> s.copy(roomMessages = s.roomMessages + (roomId to land(s.roomMessages[roomId] ?: Paged(), result.messages, result.hasMore, older, asked))) }
        } catch (e: Exception) {
            set { s -> s.copy(roomMessages = s.roomMessages + (roomId to (s.roomMessages[roomId] ?: Paged()).copy(loadingMore = false))) }
            if ((e as? ApiError)?.status != 404 && (realtime.state.value is Connection.Online || page.items.isEmpty())) Toasts.error(e.message ?: "Couldn't load the messages.")
        }
    }

    private fun receiveRoomMessage(message: Message) {
        val roomId = message.roomId ?: return
        val mine = myId
        set { s ->
            val room = s.rooms[roomId]
            val page = s.roomMessages[roomId]
            val isOpen = s.activeRoom == roomId && visible
            val fromOther = message.kind == "text" && message.sender?.id != mine
            val counts = if (fromOther && !isOpen) 1 else 0
            val typing = s.roomTyping[roomId].orEmpty() - (message.sender?.id ?: "")
            s.copy(
                roomMessages = s.roomMessages + (roomId to (page ?: Paged()).copy(items = merge(page?.items.orEmpty(), listOf(message)))),
                roomTyping = s.roomTyping + (roomId to typing),
                rooms = if (room != null) {
                    s.rooms + (
                        roomId to room.copy(
                            lastMessage = later(room.lastMessage, message),
                            unread = room.unread + counts,
                            unreadMentions = room.unreadMentions + if (counts > 0 && isForMe(message, mine)) 1 else 0,
                        )
                        )
                } else {
                    s.rooms
                },
            )
        }
        if (now.activeRoom == roomId && visible) markRoomRead(roomId)
    }

    fun markRoomRead(roomId: String) {
        Graph.notifications.clearChat("room", roomId)
        val last = now.roomMessages[roomId]?.items?.lastOrNull { it.pending == null }
        set { s ->
            val room = s.rooms[roomId]
            if (room != null && (room.unread > 0 || room.unreadMentions > 0)) s.copy(rooms = s.rooms + (roomId to room.copy(unread = 0, unreadMentions = 0))) else s
        }
        if (last != null) realtime.emit("room:read", buildJsonObject { put("roomId", roomId); put("messageId", last.id) })
    }

    fun upsertRoom(room: Room) = set { s ->
        val prev = s.rooms[room.id]
        val upTo = clearedUpTo(room)
        val last = room.lastMessage?.takeUnless { upTo > 0 && millis(it.createdAt) <= upTo }
        val summary = room.copy(members = null, invites = null, voice = null, watch = null, queue = null, lastMessage = last).let {
            if (s.activeRoom == room.id) it.copy(unread = 0, unreadMentions = 0) else it
        }
        var next = s.copy(rooms = s.rooms + (room.id to summary.copy(lastMessage = summary.lastMessage ?: prev?.lastMessage?.takeUnless { upTo > 0 && millis(it.createdAt) <= upTo })))
        if (upTo > 0) next.roomMessages[room.id]?.let { page ->
            next = next.copy(roomMessages = next.roomMessages + (room.id to page.copy(items = page.items.filter { it.pending != null || millis(it.createdAt) > upTo })))
        }
        if (room.members != null) {
            next = next.copy(
                roomDetails = next.roomDetails + (room.id to room),
                users = next.users + room.members.associate { m -> m.id to (next.users[m.id]?.let { u -> u.copy(name = m.name, photo = m.photo, hue = m.hue, handle = m.handle ?: u.handle) } ?: m.asUser()) },
                voice = next.voice + (room.id to room.voice.orEmpty()),
            )
        }
        next
    }

    fun dropRoom(roomId: String) = set { s ->
        s.copy(rooms = s.rooms - roomId, roomDetails = s.roomDetails - roomId, roomMessages = s.roomMessages - roomId)
    }

    suspend fun createRoom(name: String, description: String, maxMembers: Int, password: String?): Room =
        api.createRoom(name, description, maxMembers, password).also { upsertRoom(it) }

    suspend fun joinRoom(code: String, password: String?): Room = api.joinRoom(code, password).also { upsertRoom(it) }
    suspend fun setRoomPassword(roomId: String, password: String?) = upsertRoom(api.setRoomPassword(roomId, password))
    suspend fun renewRoomCode(roomId: String) = upsertRoom(api.newRoomCode(roomId))
    suspend fun updateRoom(roomId: String, name: String?, description: String?, maxMembers: Int?) = upsertRoom(api.updateRoom(roomId, name, description, maxMembers))
    suspend fun deleteRoom(roomId: String) {
        api.deleteRoom(roomId)
        dropRoom(roomId)
    }

    suspend fun addMember(roomId: String, userId: String) = upsertRoom(api.addMember(roomId, userId))
    suspend fun inviteMember(roomId: String, userId: String) = upsertRoom(api.invite(roomId, userId))
    suspend fun cancelInvite(roomId: String, inviteId: String) {
        api.cancelInvite(roomId, inviteId)
        loadRoom(roomId)
    }

    suspend fun removeMember(roomId: String, userId: String) {
        api.removeMember(roomId, userId)
        loadRoom(roomId)
    }

    suspend fun setRole(roomId: String, userId: String, role: String) = upsertRoom(api.setRole(roomId, userId, role))
    suspend fun setRoomHistory(roomId: String, clearAfter: ClearAfter?) = upsertRoom(api.setRoomHistory(roomId, clearAfter))
    suspend fun clearRoomHistory(roomId: String) = upsertRoom(api.clearRoomHistory(roomId))
    suspend fun moderateVoice(roomId: String, userId: String, voiceMuted: Boolean? = null, cameraBlocked: Boolean? = null) =
        upsertRoom(api.moderateVoice(roomId, userId, voiceMuted, cameraBlocked))

    suspend fun setRoomPhoto(roomId: String, jpeg: ByteArray) = upsertRoom(api.setRoomPhoto(roomId, jpeg))
    suspend fun removeRoomPhoto(roomId: String) = upsertRoom(api.removeRoomPhoto(roomId))

    suspend fun leaveRoom(roomId: String) {
        api.removeMember(roomId, myId ?: return)
        dropRoom(roomId)
    }

    suspend fun acceptInvite(inviteId: String): Room {
        val room = api.acceptInvite(inviteId)
        set { s -> s.copy(invites = s.invites.filterNot { it.id == inviteId }) }
        upsertRoom(room)
        return room
    }

    suspend fun declineInvite(inviteId: String) {
        api.declineInvite(inviteId)
        set { s -> s.copy(invites = s.invites.filterNot { it.id == inviteId }) }
    }

    // ── Messages: reactions, edits, deletes, forwards ──────────────────

    fun react(scope: Scope, messageId: Long, emoji: String) {
        this.scope.launch {
            try {
                realtime.request("msg:react", buildJsonObject { put("scope", scope.wire); put("messageId", messageId); put("emoji", emoji) })
            } catch (e: Exception) {
                Toasts.error(e.message ?: "Couldn't react.")
            }
        }
    }

    suspend fun editMessage(scope: Scope, messageId: Long, body: String, mentions: List<Mention>? = null): Boolean = try {
        val change = realtime.request("msg:edit", buildJsonObject {
            put("scope", scope.wire)
            put("messageId", messageId)
            put("body", body)
            mentions?.let { put("mentions", json.encodeToJsonElement(ListSerializer(Mention.serializer()), it)) }
        })
        applyEdited(change)
        true
    } catch (e: Exception) {
        Toasts.error(e.message ?: "Couldn't edit it.")
        false
    }

    suspend fun deleteMessage(scope: Scope, chatId: String, messageId: Long, forEveryone: Boolean): Boolean = try {
        val res = realtime.request("msg:delete", buildJsonObject { put("scope", scope.wire); put("messageId", messageId); put("forEveryone", forEveryone) })
        if (res.bool("hidden") == true) {
            applyHidden(scope, messageId, chatId)
        } else {
            res.str("deletedAt")?.let { at -> applyDeleted(scope, messageId, at, if (scope == Scope.Dm) chatId else null, if (scope == Scope.Room) chatId else null, res.bool("byAdmin") == true) }
        }
        true
    } catch (e: Exception) {
        Toasts.error(e.message ?: "Couldn't delete it.")
        false
    }

    suspend fun forwardMessage(scope: Scope, messageId: Long, to: List<Pair<Scope, String>>): List<ForwardResult>? = try {
        val res = realtime.request("msg:forward", buildJsonObject {
            put("scope", scope.wire)
            put("messageId", messageId)
            put("to", buildJsonArray { to.forEach { (s, id) -> add(buildJsonObject { put("scope", s.wire); put("id", id) }) } })
        }, 20_000)
        json.decodeFromJsonElement(ListSerializer(ForwardResult.serializer()), res["results"] ?: JsonArray(emptyList()))
    } catch (e: Exception) {
        Toasts.error(e.message ?: "Couldn't forward it.")
        null
    }

    /** My settings for a chat or room: muted ("8h", "1w", "always", "off"), pinned, archived. */
    suspend fun setChatSettings(chatScope: Scope, id: String, mute: String? = null, pinned: Boolean? = null, archived: Boolean? = null) {
        if (chatScope == Scope.Room) {
            if (mute != null) {
                val res = api.muteRoom(id, mute)
                setRoomMuted(id, res.str("mutedUntil"))
            }
            if (pinned == null && archived == null) return
            val res = api.roomSettings(id, pinned, archived)
            applyChatSettings(Scope.Room, id, res)
        } else {
            val res = api.dmSettings(id, mute, pinned, archived)
            applyChatSettings(Scope.Dm, id, res)
        }
    }

    private fun applyChatSettings(chatScope: Scope, id: String, e: JsonObject) = set { s ->
        val mutedUntil = e.str("mutedUntil")
        val pinnedAt = e.str("pinnedAt")
        val archivedAt = e.str("archivedAt")
        if (chatScope == Scope.Dm) {
            s.conversations[id]?.let { s.copy(conversations = s.conversations + (id to it.copy(mutedUntil = mutedUntil, pinnedAt = pinnedAt, archivedAt = archivedAt))) } ?: s
        } else {
            s.copy(
                rooms = s.rooms[id]?.let { s.rooms + (id to it.copy(mutedUntil = mutedUntil, pinnedAt = pinnedAt, archivedAt = archivedAt)) } ?: s.rooms,
                roomDetails = s.roomDetails[id]?.let { s.roomDetails + (id to it.copy(mutedUntil = mutedUntil, pinnedAt = pinnedAt, archivedAt = archivedAt)) } ?: s.roomDetails,
            )
        }
    }

    private fun setRoomMuted(roomId: String, mutedUntil: String?) = set { s ->
        s.copy(
            rooms = s.rooms[roomId]?.let { s.rooms + (roomId to it.copy(mutedUntil = mutedUntil)) } ?: s.rooms,
            roomDetails = s.roomDetails[roomId]?.let { s.roomDetails + (roomId to it.copy(mutedUntil = mutedUntil)) } ?: s.roomDetails,
        )
    }

    suspend fun block(userId: String) {
        api.block(userId)
        markBlocked(userId, true)
    }

    suspend fun unblock(userId: String) {
        api.unblock(userId)
        markBlocked(userId, false)
    }

    fun markBlocked(userId: String, blocked: Boolean) = set { s ->
        s.copy(
            users = s.users[userId]?.let { s.users + (userId to it.copy(blocked = blocked)) } ?: s.users,
            conversations = s.conversations[userId]?.let { s.conversations + (userId to it.copy(partner = it.partner.copy(blocked = blocked))) } ?: s.conversations,
        )
    }

    // ── Typing ─────────────────────────────────────────────────────────

    private var typingSentAt = 0L
    private var typingStop: Job? = null

    /** I'm typing in a chat or room: says so (at most every 2 s), and stops saying so 2.5 s after the last key. */
    fun typing(chatScope: Scope, chatId: String) {
        val nowMs = System.currentTimeMillis()
        if (nowMs - typingSentAt > 2_000) {
            typingSentAt = nowMs
            emitTyping(chatScope, chatId, true)
        }
        typingStop?.cancel()
        typingStop = scope.launch {
            delay(2_500)
            typingSentAt = 0
            emitTyping(chatScope, chatId, false)
        }
    }

    fun stopTyping(chatScope: Scope, chatId: String) {
        if (typingStop?.isActive == true) {
            typingStop?.cancel()
            typingSentAt = 0
            emitTyping(chatScope, chatId, false)
        }
    }

    private fun emitTyping(chatScope: Scope, chatId: String, typing: Boolean) {
        if (chatScope == Scope.Dm) realtime.emit("dm:typing", buildJsonObject { put("to", chatId); put("typing", typing) })
        else realtime.emit("room:typing", buildJsonObject { put("roomId", chatId); put("typing", typing) })
    }

    private fun setDmTyping(from: String, typing: Boolean) {
        val key = "dm:$from"
        typingJobs.remove(key)?.cancel()
        _state.update { s -> s.copy(dmTyping = if (typing) s.dmTyping + from else s.dmTyping - from) }
        if (typing) typingJobs[key] = scope.launch {
            delay(5_000)
            setDmTyping(from, false)
        }
    }

    private fun setRoomTyping(roomId: String, userId: String, name: String, typing: Boolean) {
        val key = "room:$roomId:$userId"
        typingJobs.remove(key)?.cancel()
        _state.update { s ->
            val cur = s.roomTyping[roomId].orEmpty()
            s.copy(roomTyping = s.roomTyping + (roomId to if (typing) cur + (userId to name) else cur - userId))
        }
        if (typing) typingJobs[key] = scope.launch {
            delay(5_000)
            setRoomTyping(roomId, userId, name, false)
        }
    }

    // ── The server's live events ───────────────────────────────────────

    private fun handle(e: Incoming) {
        val o = e.obj
        when (e.name) {
            "dm:new" -> {
                val message = o["message"]?.let { json.decodeFromJsonElement(Message.serializer(), it) }
                val partner = o["partner"]?.let { json.decodeFromJsonElement(User.serializer(), it) }
                if (message != null && partner != null) {
                    receiveDm(message, partner)
                    Graph.callNotices.dm(message, partner)
                }
                // Answering tells the server this device has it, so the sender sees "delivered".
                e.ack(JsonPrimitive(true))
            }
            "room:message" -> {
                runCatching { json.decodeFromJsonElement(Message.serializer(), e.data) }.getOrNull()?.let {
                    receiveRoomMessage(it)
                    Graph.callNotices.room(it)
                }
                e.ack(JsonPrimitive(true))
            }
            "dm:delivered" -> {
                val partnerId = o.str("partnerId") ?: return
                val ids = o.arr("ids")?.mapNotNull { (it as? JsonPrimitive)?.longOrNull }?.toSet().orEmpty()
                val at = o.str("deliveredAt")
                fun stamp(m: Message) = if (m.id in ids && m.deliveredAt == null) m.copy(deliveredAt = at) else m
                set { s ->
                    s.copy(
                        dms = s.dms[partnerId]?.let { p -> s.dms + (partnerId to p.copy(items = p.items.map(::stamp))) } ?: s.dms,
                        conversations = s.conversations[partnerId]?.let { c -> s.conversations + (partnerId to c.copy(lastMessage = c.lastMessage?.let(::stamp))) } ?: s.conversations,
                    )
                }
            }
            "dm:read" -> {
                val readerId = o.str("readerId") ?: return
                val partnerId = o.str("partnerId") ?: return
                val readAt = o.str("readAt")
                val mine = myId
                if (readerId == mine) {
                    // Read on another of my devices.
                    set { s -> s.conversations[partnerId]?.let { s.copy(conversations = s.conversations + (partnerId to it.copy(unread = 0))) } ?: s }
                    Graph.notifications.clearChat("dm", partnerId)
                } else {
                    fun stamp(m: Message) = if (m.senderId == mine && m.readAt == null && m.pending == null) m.copy(readAt = readAt, deliveredAt = m.deliveredAt ?: readAt) else m
                    set { s ->
                        s.copy(
                            dms = s.dms[readerId]?.let { p -> s.dms + (readerId to p.copy(items = p.items.map(::stamp))) } ?: s.dms,
                            conversations = s.conversations[readerId]?.let { c -> s.conversations + (readerId to c.copy(lastMessage = c.lastMessage?.let(::stamp))) } ?: s.conversations,
                        )
                    }
                }
            }
            "room:receipts" -> {
                val roomId = o.str("roomId") ?: return
                val by = o.arr("members")?.mapNotNull { it as? JsonObject }?.associateBy { it.str("userId") }.orEmpty()
                set { s ->
                    val detail = s.roomDetails[roomId] ?: return@set s
                    s.copy(roomDetails = s.roomDetails + (roomId to detail.copy(members = detail.members?.map { m ->
                        val r = by[m.id] ?: return@map m
                        m.copy(lastReadId = maxOf(m.lastReadId, r.long("lastReadId") ?: 0), lastDeliveredId = maxOf(m.lastDeliveredId, r.long("lastDeliveredId") ?: 0))
                    })))
                }
            }
            "dm:typing" -> setDmTyping(o.str("from") ?: return, o.bool("typing") == true)
            "room:typing" -> setRoomTyping(o.str("roomId") ?: return, o.str("userId") ?: return, o.str("name").orEmpty(), o.bool("typing") == true)
            "room:read" -> {
                val roomId = o.str("roomId") ?: return
                set { s -> s.rooms[roomId]?.let { s.copy(rooms = s.rooms + (roomId to it.copy(unread = 0, unreadMentions = 0))) } ?: s }
                Graph.notifications.clearChat("room", roomId)
            }
            "msg:reactions" -> {
                val reactions = json.decodeFromJsonElement(ListSerializer(Reaction.serializer()), o["reactions"] ?: JsonArray(emptyList()))
                changeMessage(o) { it.copy(reactions = reactions) }
            }
            "msg:deleted" -> {
                val scope = if (o.str("scope") == "dm") Scope.Dm else Scope.Room
                val messageId = o.long("messageId") ?: return
                val partner = if (scope == Scope.Dm) partnerOf(o) else null
                applyDeleted(scope, messageId, o.str("deletedAt") ?: Instant.now().toString(), partner, o.str("roomId"), o.bool("byAdmin") == true)
            }
            "msg:hidden" -> {
                val scope = if (o.str("scope") == "dm") Scope.Dm else Scope.Room
                applyHidden(scope, o.long("messageId") ?: return, o.str("chatId") ?: o.str("roomId") ?: return)
            }
            "msg:edited" -> applyEdited(o)
            "msg:preview" -> {
                val preview = o["preview"]?.takeIf { it != JsonNull }?.let { json.decodeFromJsonElement(LinkPreview.serializer(), it) }
                changeMessage(o) { it.copy(preview = preview) }
            }
            "chat:settings" -> applyChatSettings(if (o.str("scope") == "dm") Scope.Dm else Scope.Room, o.str("id") ?: return, o)
            "room:muted" -> setRoomMuted(o.str("roomId") ?: return, o.str("mutedUntil"))
            "blocks:changed" -> scope.launch {
                runCatching { api.blocked() }.onSuccess { list ->
                    val blocked = list.map { it.id }.toSet()
                    for (id in now.users.keys + now.conversations.keys) markBlocked(id, id in blocked)
                }
            }
            "room:changed" -> o.str("roomId")?.let { id -> if (now.rooms.containsKey(id)) scope.launch { loadRoom(id) } }
            "room:cleared" -> {
                val roomId = o.str("roomId") ?: return
                val before = o.str("before") ?: return
                val upTo = millis(before)
                val room = now.rooms[roomId]
                set { s ->
                    val page = s.roomMessages[roomId]
                    val r = s.rooms[roomId]
                    s.copy(
                        roomMessages = page?.let { s.roomMessages + (roomId to it.copy(items = it.items.filter { m -> m.pending != null || millis(m.createdAt) > upTo })) } ?: s.roomMessages,
                        rooms = if (r?.lastMessage != null && millis(r.lastMessage.createdAt) <= upTo) s.rooms + (roomId to r.copy(lastMessage = null)) else s.rooms,
                    )
                }
                if ((room?.unread ?: 0) > 0 && o.bool("all") != true) scope.launch { loadRoom(roomId) }
            }
            "room:added" -> {
                val room = runCatching { json.decodeFromJsonElement(Room.serializer(), e.data) }.getOrNull() ?: return
                val isNew = !now.rooms.containsKey(room.id)
                upsertRoom(room)
                if (isNew && room.ownerId != myId) Toasts.show("You were added to ${room.name}.", Toasts.Tone.Live)
            }
            "room:removed" -> {
                val roomId = o.str("roomId") ?: return
                val room = now.rooms[roomId]
                dropRoom(roomId)
                if (room != null) when (o.str("reason")) {
                    "removed" -> Toasts.show("You were removed from ${room.name}.")
                    "deleted" -> if (room.ownerId != myId) Toasts.show("${room.name} was deleted.")
                }
            }
            "invite:new" -> {
                val invite = runCatching { json.decodeFromJsonElement(Invite.serializer(), e.data) }.getOrNull() ?: return
                set { s -> s.copy(invites = listOf(invite) + s.invites.filterNot { it.id == invite.id }) }
                Toasts.show("${invite.inviter.name} invited you to ${invite.room.name}.", Toasts.Tone.Live)
            }
            "invite:updated" -> {
                val invite = runCatching { json.decodeFromJsonElement(Invite.serializer(), e.data) }.getOrNull() ?: return
                set { s -> s.copy(invites = s.invites.map { if (it.id == invite.id) invite else it }) }
            }
            "invite:removed" -> o.str("inviteId")?.let { id -> set { s -> s.copy(invites = s.invites.filterNot { it.id == id }) } }
            "presence:snapshot" -> {
                val online = o.arr("online")?.mapNotNull { (it as? JsonPrimitive)?.content }?.toSet().orEmpty()
                _state.update { it.copy(online = online) }
            }
            "presence:update" -> {
                val userId = o.str("userId") ?: return
                val online = o.bool("online") == true
                _state.update { s ->
                    s.copy(
                        online = if (online) s.online + userId else s.online - userId,
                        lastSeen = o.str("lastSeenAt")?.let { s.lastSeen + (userId to it) } ?: s.lastSeen,
                        hiddenPresence = if (o.bool("hidden") == true) s.hiddenPresence + userId else s.hiddenPresence - userId,
                    )
                }
            }
            "presence:refresh" -> scope.launch {
                runCatching { api.presence() }.onSuccess { online ->
                    _state.update { it.copy(online = online.toSet(), lastSeen = emptyMap(), hiddenPresence = emptySet()) }
                    sync()
                }
            }
            "user:updated" -> o.obj("user")?.let { applyUser(it) }
            "voice:snapshot" -> {
                val snap = o.mapNotNull { (roomId, list) ->
                    runCatching { roomId to json.decodeFromJsonElement(ListSerializer(VoiceParticipant.serializer()), list) }.getOrNull()
                }.toMap()
                _state.update { it.copy(voice = it.voice + snap) }
            }
            "voice:state" -> {
                val roomId = o.str("roomId") ?: return
                val list = runCatching { json.decodeFromJsonElement(ListSerializer(VoiceParticipant.serializer()), o["participants"]!!) }.getOrNull() ?: return
                setVoice(roomId, list)
            }
            "watch:state" -> {
                val roomId = o.str("roomId") ?: return
                val watch = o["watch"]?.takeIf { it != JsonNull }?.let { runCatching { json.decodeFromJsonElement(com.addakhana.app.model.WatchState.serializer(), it) }.getOrNull() }
                set { s ->
                    s.copy(
                        roomDetails = s.roomDetails[roomId]?.let { s.roomDetails + (roomId to it.copy(watch = watch)) } ?: s.roomDetails,
                        rooms = s.rooms[roomId]?.let { s.rooms + (roomId to it.copy(watching = watch?.source?.title)) } ?: s.rooms,
                    )
                }
            }
            "watch:queue" -> {
                val roomId = o.str("roomId") ?: return
                val queue = runCatching { json.decodeFromJsonElement(ListSerializer(com.addakhana.app.model.QueueItem.serializer()), o["queue"]!!) }.getOrNull() ?: return
                set { s -> s.roomDetails[roomId]?.let { s.copy(roomDetails = s.roomDetails + (roomId to it.copy(queue = queue))) } ?: s }
            }
        }
    }

    fun setVoice(roomId: String, participants: List<VoiceParticipant>) = _state.update { it.copy(voice = it.voice + (roomId to participants)) }

    private fun partnerOf(o: JsonObject): String {
        val mine = myId
        return o.arr("between")?.mapNotNull { (it as? JsonPrimitive)?.content }?.firstOrNull { it != mine } ?: mine.orEmpty()
    }

    /** A change to one message (in a chat: { between }, or a room: { roomId }). */
    private fun changeMessage(o: JsonObject, fn: (Message) -> Message) {
        val messageId = o.long("messageId") ?: return
        fun update(items: List<Message>) = items.map { if (it.id == messageId) fn(it) else it }
        if (o.str("scope") == "dm") {
            val partner = partnerOf(o)
            set { s -> s.dms[partner]?.let { p -> s.copy(dms = s.dms + (partner to p.copy(items = update(p.items)))) } ?: s }
        } else {
            val roomId = o.str("roomId") ?: return
            set { s -> s.roomMessages[roomId]?.let { p -> s.copy(roomMessages = s.roomMessages + (roomId to p.copy(items = update(p.items)))) } ?: s }
        }
    }

    private fun applyEdited(o: JsonObject) {
        val messageId = o.long("messageId") ?: return
        val body = o.str("body") ?: return
        val editedAt = o.str("editedAt")
        val preview = o["preview"]?.takeIf { it != JsonNull }?.let { json.decodeFromJsonElement(LinkPreview.serializer(), it) }
        val mentions = o["mentions"]?.let { if (it == JsonNull) emptyList() else runCatching { json.decodeFromJsonElement(ListSerializer(Mention.serializer()), it) }.getOrNull() }
        fun edit(m: Message) = when {
            m.id == messageId -> m.copy(body = body, editedAt = editedAt, preview = preview, mentions = mentions ?: m.mentions)
            m.replyTo?.id == messageId -> m.copy(replyTo = m.replyTo.copy(body = body))
            else -> m
        }
        if (o.str("scope") == "dm") {
            val partner = partnerOf(o)
            set { s ->
                s.copy(
                    dms = s.dms[partner]?.let { p -> s.dms + (partner to p.copy(items = p.items.map(::edit))) } ?: s.dms,
                    conversations = s.conversations[partner]?.takeIf { it.lastMessage?.id == messageId }?.let { c -> s.conversations + (partner to c.copy(lastMessage = c.lastMessage?.let(::edit))) } ?: s.conversations,
                )
            }
        } else {
            val roomId = o.str("roomId") ?: return
            set { s ->
                s.copy(
                    roomMessages = s.roomMessages[roomId]?.let { p -> s.roomMessages + (roomId to p.copy(items = p.items.map(::edit))) } ?: s.roomMessages,
                    rooms = s.rooms[roomId]?.takeIf { it.lastMessage?.id == messageId }?.let { r -> s.rooms + (roomId to r.copy(lastMessage = r.lastMessage?.let(::edit))) } ?: s.rooms,
                )
            }
        }
    }

    private fun applyDeleted(chatScope: Scope, messageId: Long, deletedAt: String, partnerId: String?, roomId: String?, byAdmin: Boolean) {
        // A message deleted for everyone keeps its place as a marker; replies to it show it as deleted.
        fun erase(items: List<Message>) = items.map { m ->
            when {
                m.id == messageId -> m.copy(body = "", attachment = null, reactions = emptyList(), replyTo = null, replyToId = null, deletedAt = deletedAt, deletedByAdmin = byAdmin, meta = null)
                m.replyTo?.id == messageId -> m.copy(replyTo = m.replyTo.copy(body = "", attachment = null, deleted = true))
                else -> m
            }
        }
        if (chatScope == Scope.Dm && partnerId != null) {
            // An unread message taken back: the server recounts what's unread.
            if ((now.conversations[partnerId]?.unread ?: 0) > 0) scope.launch {
                runCatching { api.conversations() }.onSuccess { list ->
                    list.firstOrNull { it.partner.id == partnerId }?.let { fresh ->
                        set { s -> s.conversations[partnerId]?.let { s.copy(conversations = s.conversations + (partnerId to it.copy(unread = fresh.unread))) } ?: s }
                    }
                }
            }
            set { s ->
                s.copy(
                    dms = s.dms[partnerId]?.let { p -> s.dms + (partnerId to p.copy(items = erase(p.items))) } ?: s.dms,
                    conversations = s.conversations[partnerId]?.takeIf { it.lastMessage?.id == messageId }?.let { c -> s.conversations + (partnerId to c.copy(lastMessage = c.lastMessage?.let { erase(listOf(it)).first() })) } ?: s.conversations,
                )
            }
            Graph.notifications.removeMessage("dm", partnerId, messageId)
        } else if (roomId != null) {
            if ((now.rooms[roomId]?.unread ?: 0) > 0) scope.launch { loadRoom(roomId) }
            set { s ->
                s.copy(
                    roomMessages = s.roomMessages[roomId]?.let { p -> s.roomMessages + (roomId to p.copy(items = erase(p.items))) } ?: s.roomMessages,
                    rooms = s.rooms[roomId]?.takeIf { it.lastMessage?.id == messageId }?.let { r -> s.rooms + (roomId to r.copy(lastMessage = r.lastMessage?.let { erase(listOf(it)).first() })) } ?: s.rooms,
                )
            }
            Graph.notifications.removeMessage("room", roomId, messageId)
        }
    }

    private fun applyHidden(chatScope: Scope, messageId: Long, chatId: String) {
        if (chatScope == Scope.Dm) {
            val wasLast = now.conversations[chatId]?.lastMessage?.id == messageId
            set { s -> s.dms[chatId]?.let { p -> s.copy(dms = s.dms + (chatId to p.copy(items = p.items.filterNot { it.id == messageId }))) } ?: s }
            // The chat list now shows the message before it (or no chat at all).
            if (wasLast) scope.launch { runCatching { api.conversations() }.onSuccess { list -> set { s -> s.copy(conversations = list.associateBy { it.partner.id }) } } }
        } else {
            val wasLast = now.rooms[chatId]?.lastMessage?.id == messageId
            set { s -> s.roomMessages[chatId]?.let { p -> s.copy(roomMessages = s.roomMessages + (chatId to p.copy(items = p.items.filterNot { it.id == messageId }))) } ?: s }
            if (wasLast) scope.launch { loadRoom(chatId) }
        }
    }

    /** Someone changed their name or photo: show it everywhere they appear. */
    private fun applyUser(o: JsonObject) {
        val id = o.str("id") ?: return
        val name = o.str("name")
        val hasPhoto = o.containsKey("photo")
        val photo = o.str("photo")
        fun User.changed() = copy(name = name ?: this.name, photo = if (hasPhoto) photo else this.photo)
        fun Sender.changed() = copy(name = name ?: this.name, photo = if (hasPhoto) photo else this.photo)
        set { s ->
            s.copy(
                users = s.users[id]?.let { s.users + (id to it.changed()) } ?: s.users,
                conversations = s.conversations[id]?.let { s.conversations + (id to it.copy(partner = it.partner.changed())) } ?: s.conversations,
                roomDetails = s.roomDetails.mapValues { (_, d) ->
                    if (d.members?.any { it.id == id } == true) d.copy(members = d.members.map { if (it.id == id) it.copy(name = name ?: it.name, photo = if (hasPhoto) photo else it.photo) else it }) else d
                },
                roomMessages = s.roomMessages.mapValues { (_, p) ->
                    if (p.items.any { it.sender?.id == id }) p.copy(items = p.items.map { if (it.sender?.id == id) it.copy(sender = it.sender.changed()) else it }) else p
                },
                rooms = s.rooms.mapValues { (_, r) -> if (r.lastMessage?.sender?.id == id) r.copy(lastMessage = r.lastMessage.copy(sender = r.lastMessage.sender?.changed())) else r },
                invites = s.invites.map { if (it.inviter.id == id) it.copy(inviter = it.inviter.changed()) else it },
            )
        }
        if (id == myId) Graph.auth.user?.let { Graph.auth.setUser(it.changed()) }
    }

    // ── Kept on the phone ──────────────────────────────────────────────

    private fun file(userId: String) = File(context.filesDir, "chats-$userId.json")

    private fun restore(userId: String): Kept? {
        val kept = runCatching { json.decodeFromString(Kept.serializer(), file(userId).readText()) }.getOrNull() ?: return null
        _state.update {
            it.copy(
                bootstrapped = true,
                conversations = kept.conversations.associateBy { c -> c.partner.id },
                rooms = kept.rooms.associateBy { r -> r.id },
                invites = kept.invites,
                users = kept.users.associateBy { u -> u.id },
                // Shown until each chat opens and loads the server's copy.
                dms = kept.dms.mapValues { (_, p) -> p.copy(stale = true, loadingMore = false) },
                roomMessages = kept.roomMessages.mapValues { (_, p) -> p.copy(stale = true, loadingMore = false) },
                roomDetails = kept.roomDetails.associateBy { r -> r.id },
            )
        }
        return kept
    }

    private fun scheduleSave() {
        if (saveJob?.isActive == true || me == null) return
        saveJob = scope.launch {
            delay(1_500)
            saveNow()
        }
    }

    /** The lists, and the 25 most recent chats and rooms with their last 40 messages each (and anything still sending). */
    fun saveNow() {
        saveJob?.cancel()
        val user = me ?: return
        val s = _state.value
        if (!s.bootstrapped) return
        fun trim(p: Paged) = p.copy(items = p.items.filter { it.pending == null }.takeLast(40) + p.items.filter { it.pending != null }.map { it.copy(pending = "failed", upload = null) }, loadingMore = false, recheck = false)
        val dmIds = s.conversations.values.sortedByDescending { it.lastMessage?.createdAt.orEmpty() }.take(25).map { it.partner.id }.toSet() +
            s.dms.filterValues { p -> p.items.any { it.pending != null } }.keys
        val roomIds = s.rooms.values.sortedByDescending { it.lastMessage?.createdAt ?: it.createdAt.orEmpty() }.take(25).map { it.id }.toSet() +
            s.roomMessages.filterValues { p -> p.items.any { it.pending != null } }.keys
        val kept = Kept(
            conversations = s.conversations.values.toList(),
            rooms = s.rooms.values.toList(),
            invites = s.invites,
            users = s.users.values.filter { u -> s.conversations.containsKey(u.id) },
            dms = s.dms.filterKeys { it in dmIds }.mapValues { trim(it.value) },
            roomMessages = s.roomMessages.filterKeys { it in roomIds }.mapValues { trim(it.value) },
            roomDetails = s.roomDetails.values.filter { it.id in roomIds },
        )
        scope.launch(Dispatchers.IO) {
            runCatching {
                val target = file(user.id)
                val tmp = File(target.parentFile, target.name + ".tmp")
                tmp.writeText(json.encodeToString(Kept.serializer(), kept))
                tmp.renameTo(target)
            }
        }
    }

    companion object {
        /** Messages merged into a list: the server's copies replace optimistic ones, in id order, still-sending ones last. */
        fun merge(items: List<Message>, incoming: List<Message>, replaceTemp: String? = null): List<Message> {
            val saved = incoming.mapNotNull { it.clientId }.toSet()
            val byKey = LinkedHashMap<Any, Message>()
            for (m in items) {
                if (m.tempId != null && (m.tempId == replaceTemp || (m.clientId != null && m.clientId in saved))) continue
                byKey[m.tempId ?: m.id] = m
            }
            for (m in incoming) byKey[m.id] = m
            val all = byKey.values
            return all.filter { it.pending == null }.sortedBy { it.id } + all.filter { it.pending != null }
        }

        /**
         * A page from the server landed on what's held. The newest page
         * replaces what's held when that's a copy from last time (stale), or
         * when more than a page arrived while away (it would leave a gap);
         * messages still sending, and ones that arrived live meanwhile, stay.
         */
        fun land(cur: Paged, messages: List<Message>, hasMore: Boolean, older: Boolean, asked: Set<Long>): Paged {
            if (older) return cur.copy(items = merge(cur.items, messages), hasMore = hasMore, loaded = true, loadingMore = false)
            val low = messages.minOfOrNull { it.id } ?: Long.MAX_VALUE
            val high = messages.maxOfOrNull { it.id } ?: Long.MAX_VALUE
            val held = cur.items.filter { it.pending == null }
            val gap = hasMore && held.any { it.id < low } && held.none { it.id in low..high }
            if (!cur.stale && !cur.recheck && !gap) {
                return Paged(items = merge(cur.items, messages), loaded = true, hasMore = if (cur.loaded) cur.hasMore || hasMore else hasMore)
            }
            val keepOlder = !cur.stale && !gap && hasMore
            fun arrived(m: Message) = m.id > high && m.id !in asked
            return Paged(
                items = merge(cur.items.filter { it.pending != null || arrived(it) || (keepOlder && it.id < low) }, messages),
                loaded = true,
                hasMore = if (keepOlder) cur.hasMore || hasMore else hasMore,
            )
        }

        /** The later of a chat's last message and a new one (sends and arrivals can cross). */
        fun later(last: Message?, message: Message) = if (last != null && last.id > message.id) last else message

        fun millis(iso: String): Long = runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0)

        /** Nothing in the room from this time or earlier shows any more (cleared at once by an admin). */
        fun clearedUpTo(room: Room): Long = room.clearedAt?.let { millis(it) } ?: 0
    }
}

