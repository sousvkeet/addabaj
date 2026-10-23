package com.addakhana.app.net

import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import com.addakhana.app.data.DataUse
import com.addakhana.app.data.Usage
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

/** An event from the server, with its acknowledgement when it asks for one (dm:new, room:message). */
class Incoming(val name: String, val data: JsonElement, private val ackFn: ((JsonElement) -> Unit)?) {
    val wantsAck: Boolean get() = ackFn != null
    fun ack(payload: JsonElement = JsonObject(emptyMap())) = ackFn?.invoke(payload)
    val obj: JsonObject get() = data as? JsonObject ?: JsonObject(emptyMap())
}

sealed interface Connection {
    data object Offline : Connection
    data object Connecting : Connection
    /** Connected, as this socket id (the server's name for this connection). */
    data class Online(val sid: String) : Connection
    /** The login is no longer good (logged out elsewhere, password changed). */
    data object Unauthorized : Connection
}

/**
 * The live connection: Socket.IO v4 (Engine.IO 4) over a WebSocket, written
 * here rather than with the Java client, so it shares OkHttp and its cookies
 * and stays small. Reconnects by itself (sooner when the network comes back:
 * see [nudge]); the server checks it's alive every 8 seconds.
 */
@OptIn(ExperimentalCoroutinesApi::class)
/** A WebSocket frame's own bytes, roughly (for Network usage). */
private const val FRAME = 6L

/** Sends a frame, counting it (Settings › Storage and data › Network usage). */
private fun WebSocket.out(text: String): Boolean {
    DataUse.count(Usage.Messages, text.length + FRAME, 0)
    return send(text)
}

class Realtime(private val http: OkHttpClient, private val scope: CoroutineScope) {
    private val tag = "Realtime"
    private val _state = MutableStateFlow<Connection>(Connection.Offline)
    val state: StateFlow<Connection> = _state.asStateFlow()

    private val _events = MutableSharedFlow<Incoming>(extraBufferCapacity = 512)
    val events: SharedFlow<Incoming> = _events.asSharedFlow()

    /** Every connection made, with its socket id (the stores re-sync on each). */
    private val _connects = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val connects: SharedFlow<String> = _connects.asSharedFlow()

    /** The socket id of the connection before this one, for resuming calls and voice (call:resume, voice:join). */
    @Volatile var previousSid: String? = null
        private set

    private val worker = Dispatchers.IO.limitedParallelism(1)
    private val inbox = Channel<Pair<WebSocket, String?>>(Channel.UNLIMITED)
    private var socket: WebSocket? = null
    private var wanted = false
    private var attempt = 0
    private var retryJob: Job? = null
    private var watchdog: Job? = null
    private var pingInterval = 8_000L
    private var pingTimeout = 8_000L
    @Volatile private var lastHeard = 0L
    private val nextAck = AtomicInteger(0)
    private val acks = mutableMapOf<Int, CompletableDeferred<JsonElement>>()

    init {
        scope.launch(worker) {
            for ((ws, text) in inbox) {
                if (ws !== socket) continue
                if (text == null) closed(ws) else handle(ws, text)
            }
        }
    }

    /** Starts connecting (after login, or at launch while logged in). */
    fun start() = scope.launch(worker) {
        wanted = true
        if (socket == null) open()
    }

    /** Disconnects for good (logging out). */
    fun stop() = scope.launch(worker) {
        wanted = false
        retryJob?.cancel()
        socket?.close(1000, null)
        dropSocket()
        _state.value = Connection.Offline
    }

    /** The network came back or the app came to the front: reconnect now rather than at the next try. */
    fun nudge() = scope.launch(worker) {
        if (!wanted) return@launch
        if (_state.value is Connection.Unauthorized) return@launch
        if (socket == null) {
            retryJob?.cancel()
            open()
        } else if (_state.value is Connection.Online && System.currentTimeMillis() - lastHeard > 3_000) {
            // Quiet for a while: check the line, and drop it if nothing answers.
            val alive = withTimeoutOrNull(3_000) { runCatching { request("time:now", JsonObject(emptyMap())) }.isSuccess } == true
            if (!alive) socket?.let { reconnectSoon(it) }
        }
    }

    // ── Sending ─────────────────────────────────────────────────────────

    /** Sends an event if connected (dropped otherwise: typing, signals and the like go stale anyway). */
    fun emit(event: String, data: JsonElement = JsonObject(emptyMap())) {
        val ws = socket ?: return
        if (_state.value !is Connection.Online) return
        ws.out("42" + json.encodeToString(JsonArray.serializer(), JsonArray(listOf(JsonPrimitive(event), data))))
    }

    /**
     * Sends an event and waits for the server's answer ({ok:true, …} or
     * {ok:false, error}), waiting up to [waitForConnection] ms for a
     * connection first. Throws ApiError when the server says no.
     */
    suspend fun request(event: String, data: JsonElement, timeoutMs: Long = 10_000, waitForConnection: Long = 0): JsonObject {
        if (_state.value !is Connection.Online) {
            if (waitForConnection <= 0) throw IOException("Not connected.")
            withTimeoutOrNull(waitForConnection) { state.first { it is Connection.Online } } ?: throw IOException("There's still no connection.")
        }
        val ws = socket ?: throw IOException("Not connected.")
        val id = nextAck.incrementAndGet()
        val done = CompletableDeferred<JsonElement>()
        synchronized(acks) { acks[id] = done }
        try {
            ws.out("42$id" + json.encodeToString(JsonArray.serializer(), JsonArray(listOf(JsonPrimitive(event), data))))
            val answer = withTimeout(timeoutMs) { done.await() }
            val obj = answer as? JsonObject ?: JsonObject(emptyMap())
            if (obj["ok"]?.jsonPrimitive?.booleanOrNull == false) {
                throw ApiError(0, obj["error"]?.jsonPrimitive?.contentOrNull ?: "That didn't work.")
            }
            return obj
        } finally {
            synchronized(acks) { acks.remove(id) }
        }
    }

    // ── The connection ──────────────────────────────────────────────────

    private fun open() {
        _state.value = Connection.Connecting
        val url = appUrl.replaceFirst("http", "ws") + "/socket.io/?EIO=4&transport=websocket"
        val request = Request.Builder().url(url).build()
        lateinit var ws: WebSocket
        ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                DataUse.count(Usage.Messages, 0, text.length + FRAME)
                inbox.trySend(webSocket to text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                inbox.trySend(webSocket to null)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.i(tag, "connection failed: ${t.message}")
                inbox.trySend(webSocket to null)
            }
        })
        socket = ws
        lastHeard = System.currentTimeMillis()
        startWatchdog(ws)
    }

    private fun handle(ws: WebSocket, text: String) {
        lastHeard = System.currentTimeMillis()
        if (text.isEmpty()) return
        when (text[0]) {
            '0' -> {
                // Engine.IO open: the heartbeat's timing, then join the default namespace.
                runCatching {
                    val open = json.parseToJsonElement(text.substring(1)) as JsonObject
                    pingInterval = open["pingInterval"]?.jsonPrimitive?.longOrNull ?: pingInterval
                    pingTimeout = open["pingTimeout"]?.jsonPrimitive?.longOrNull ?: pingTimeout
                }
                ws.out("40")
            }
            '2' -> ws.out("3")
            '1' -> reconnectSoon(ws)
            '4' -> socketIo(ws, text.substring(1))
        }
    }

    /** A Socket.IO packet: 0 connect, 2 event, 3 ack, 4 connect error (default namespace only). */
    private fun socketIo(ws: WebSocket, packet: String) {
        if (packet.isEmpty()) return
        val type = packet[0]
        var i = 1
        if (i < packet.length && packet[i] == '/') {
            // Another namespace: not used here.
            return
        }
        val idStart = i
        while (i < packet.length && packet[i].isDigit()) i++
        val ackId = packet.substring(idStart, i).toIntOrNull()
        val body = packet.substring(i)
        val payload = if (body.isEmpty()) JsonNull else runCatching { json.parseToJsonElement(body) }.getOrDefault(JsonNull)
        when (type) {
            '0' -> {
                val sid = (payload as? JsonObject)?.get("sid")?.jsonPrimitive?.contentOrNull ?: ""
                attempt = 0
                val was = (_state.value as? Connection.Online)?.sid
                _state.value = Connection.Online(sid)
                _connects.tryEmit(sid)
                if (was != null) previousSid = was
            }
            '1' -> reconnectSoon(ws)
            '2' -> {
                val list = payload as? JsonArray ?: return
                val name = (list.firstOrNull() as? JsonPrimitive)?.contentOrNull ?: return
                val data = list.getOrNull(1) ?: JsonNull
                val ack: ((JsonElement) -> Unit)? = ackId?.let { id ->
                    { answer: JsonElement ->
                        ws.out("43$id" + json.encodeToString(JsonArray.serializer(), JsonArray(listOf(answer))))
                    }
                }
                _events.tryEmit(Incoming(name, data, ack))
            }
            '3' -> {
                val id = ackId ?: return
                val answer = (payload as? JsonArray)?.firstOrNull() ?: JsonNull
                synchronized(acks) { acks[id] }?.complete(answer)
            }
            '4' -> {
                val message = (payload as? JsonObject)?.get("message")?.jsonPrimitive?.contentOrNull
                Log.i(tag, "refused: $message")
                if (message == "unauthorized") {
                    ws.close(1000, null)
                    dropSocket()
                    _state.value = Connection.Unauthorized
                } else {
                    reconnectSoon(ws)
                }
            }
        }
    }

    private fun closed(ws: WebSocket) {
        if (ws !== socket) return
        reconnectSoon(ws)
    }

    private fun reconnectSoon(ws: WebSocket) {
        if (ws !== socket) return
        (state.value as? Connection.Online)?.let { previousSid = it.sid }
        ws.cancel()
        dropSocket()
        if (!wanted) {
            _state.value = Connection.Offline
            return
        }
        _state.value = Connection.Connecting
        // 0.5 s, 1 s, 2 s, then every 4–5 s, as Socket.IO's own client does.
        val delayMs = (500L shl attempt.coerceAtMost(3)).coerceAtMost(4_000) + (0..800).random()
        attempt++
        retryJob?.cancel()
        retryJob = scope.launch(worker) {
            delay(delayMs)
            if (wanted && socket == null) open()
        }
    }

    private fun dropSocket() {
        socket = null
        watchdog?.cancel()
        synchronized(acks) {
            acks.values.forEach { it.completeExceptionally(IOException("Disconnected.")) }
            acks.clear()
        }
    }

    /** No ping from the server in its interval and timeout: the line is dead (phones lose it quietly). */
    private fun startWatchdog(ws: WebSocket) {
        watchdog?.cancel()
        watchdog = scope.launch(worker) {
            while (isActive && ws === socket) {
                delay(2_000)
                if (System.currentTimeMillis() - lastHeard > pingInterval + pingTimeout + 2_000) {
                    Log.i(tag, "no heartbeat: reconnecting")
                    reconnectSoon(ws)
                    return@launch
                }
            }
        }
    }
}

// Small helpers for the server's JSON.
fun JsonObject.str(name: String): String? = (this[name] as? JsonPrimitive)?.contentOrNull
fun JsonObject.bool(name: String): Boolean? = (this[name] as? JsonPrimitive)?.booleanOrNull
fun JsonObject.int(name: String): Int? = (this[name] as? JsonPrimitive)?.intOrNull
fun JsonObject.long(name: String): Long? = (this[name] as? JsonPrimitive)?.longOrNull
fun JsonObject.obj(name: String): JsonObject? = this[name] as? JsonObject
fun JsonObject.arr(name: String): JsonArray? = this[name] as? JsonArray
