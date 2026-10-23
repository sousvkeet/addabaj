package com.addakhana.app.watch

import android.widget.FrameLayout
import com.addakhana.app.Graph
import com.addakhana.app.data.AppLifecycle
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.FindResult
import com.addakhana.app.model.WatchState
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.int
import com.addakhana.app.net.json
import com.addakhana.app.net.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.max

/** The room whose video plays for me, and how its player is doing. */
data class WatchUi(
    /** The room I'm watching: its page is open, or the small player shows it. */
    val roomId: String? = null,
    /** Its page is open (the video shows there; elsewhere, the small player). */
    val onPage: Boolean = false,
    /** youtube, file, hls or device (a live stream): what's playing; null while nothing is. */
    val kind: String? = null,
    val ready: Boolean = false,
    val playing: Boolean = false,
    val error: String? = null,
    /** My own sound, under the room's. */
    val muted: Boolean = false,
    val volume: Float = 1f,
    /** The server getting a room's video ready: (download or join, percent). */
    val preparing: Map<String, Pair<String, Int>> = emptyMap(),
    /** The video fills the screen. */
    val fullscreen: Boolean = false,
) {
    /** Its sound goes on with the app out of sight (a live stream's too). */
    val background get() = kind == "file" || kind == "hls" || kind == "device"
}

/**
 * Watch together, as the web app's (store/watching.ts and WatchStage's sync):
 * everyone's player follows the room's shared state (at server time `at` the
 * video was at `position`). The admin who last pressed play, pause or seek is
 * the host: their player is the reference, and re-anchors the room's timeline
 * when it drifts (buffering, say). Everyone else seeks back when far off, and
 * eases small drifts out with the playback speed. The player is made once per
 * video and moves between the room's page and the small player.
 */
class WatchStore(private val realtime: Realtime, private val scope: CoroutineScope) {
    companion object {
        /** Members seek back when this far from the shared timeline. */
        private const val DRIFT = 1.25
        /** Players with speed control only seek past this; smaller drifts are eased out. */
        private const val SEEK = 2.5
        /** Paused, everyone shows the same moment. */
        private const val PAUSED = 0.25
        /** The host re-anchors the room's timeline to its own position past this. */
        private const val HOST_DRIFT = 1.0

        /** Up to 15% faster when behind, slower when ahead. */
        fun catchUpRate(drift: Double): Float = if (abs(drift) < 0.2) 1f else (1 - (drift * 0.25).coerceIn(-0.15, 0.15)).toFloat()
    }

    private val _state = MutableStateFlow(WatchUi())
    val state: StateFlow<WatchUi> = _state.asStateFlow()
    private val s get() = _state.value

    private var player: WatchPlayer? = null
    private var playerKey: String? = null
    private var frame: FrameLayout? = null
    private var frameControls = false
    /** Changes made by the sync look like clicks for a moment; they aren't anyone's control. */
    private var suppressUntil = 0L
    /** An admin's pause on its way to the room: nothing plays the video meanwhile. */
    private var pausing = false
    /** When (server time) this player last sent a change. */
    private var sentAt = 0L
    private var toldLength: String? = null
    /** A video was seen playing in the room I'm watching (so its end means stopping). */
    private var seen = false
    private var seenFor: String? = null

    private val room get() = s.roomId?.let { Graph.chat.now.roomDetails[it] }
    private val watch: WatchState? get() = room?.watch
    private val isAdmin get() = room?.myRole == "admin"
    private val me get() = Graph.auth.user?.id
    private val hidden get() = !AppLifecycle.foreground.value
    private fun now() = Graph.site.serverNow()

    /** Where the video should be right now. */
    fun expected(w: WatchState) = if (w.playing) w.position + max(0L, now() - w.at) / 1000.0 else w.position

    init {
        // The room's shared state, as it changes.
        scope.launch {
            combine(_state.map { it.roomId }.distinctUntilChanged(), Graph.chat.state) { id, chat ->
                val detail = id?.let { chat.roomDetails[it] }
                Follow(id, detail != null, detail?.watch, detail?.myRole == "admin", id != null && chat.bootstrapped && chat.rooms[id] == null)
            }.distinctUntilChanged().collect { follow(it) }
        }
        // Every 2 s: the host reports where it really is; everyone else corrects any drift.
        scope.launch {
            while (true) {
                delay(2_000)
                tick()
            }
        }
        // Out of sight and back: YouTube stops (and catches up); files play on.
        scope.launch {
            AppLifecycle.foreground.drop(1).collect { visible ->
                val a = player ?: return@collect
                a.sight(visible)
                if (visible) {
                    apply(force = true)
                    suppressUntil = System.currentTimeMillis() + 2_500
                }
            }
        }
        scope.launch {
            realtime.events.collect { e ->
                if (e.name != "watch:preparing") return@collect
                val roomId = e.obj.str("roomId") ?: return@collect
                val progress = (e.obj.str("phase") ?: "download") to (e.obj.int("percent") ?: 0)
                _state.update { it.copy(preparing = it.preparing + (roomId to progress)) }
            }
        }
    }

    private data class Follow(val roomId: String?, val loaded: Boolean, val watch: WatchState?, val admin: Boolean, val gone: Boolean)

    private fun follow(f: Follow) {
        if (f.roomId == null) return release()
        // Nothing to play any more (stopped, or the room is gone for me).
        if (f.roomId != seenFor) {
            seenFor = f.roomId
            seen = false
        }
        // Nothing to play any more: the room is gone for me, or its video stopped (one I saw play;
        // a page just opening may show its video a moment before the room's state catches up).
        if (f.gone || (f.loaded && f.watch == null && (seen || !s.onPage))) return stop()
        val w = f.watch ?: return
        seen = true
        val src = w.source
        if (!src.preparing) _state.update { it.copy(preparing = it.preparing - f.roomId) }
        if (src.kind == "device" || src.preparing || src.finding || src.error != null) {
            release()
            // A live stream plays through its own connection (see LiveStore).
            if (src.kind == "device") _state.update { it.copy(kind = "device") }
            return
        }
        // A new video (or a new role: admins get the player's controls) means a fresh player.
        val key = "${src.kind}:${src.url}:${src.videoId}:${f.admin}"
        if (key != playerKey) start(key, w, f.admin)
        else {
            applySound()
            apply()
        }
    }

    private fun start(key: String, w: WatchState, admin: Boolean) {
        release()
        playerKey = key
        toldLength = null
        _state.update { it.copy(kind = w.source.kind, ready = false, error = null, playing = false) }
        // Events from an older player (the video changed meanwhile) are ignored.
        lateinit var mine: WatchPlayer
        val events = object : PlayerEvents {
            override fun ready() {
                if (player !== mine) return
                _state.update { it.copy(ready = true) }
                applySound()
                apply(force = true)
            }

            override fun userAction(playing: Boolean, position: Double, ended: Boolean) {
                if (player !== mine) return
                _state.update { it.copy(playing = playing) }
                onUserAction(playing, position, ended)
            }

            override fun error(message: String) {
                if (player === mine) _state.update { it.copy(error = message) }
            }
        }
        mine = if (w.source.kind == "youtube") YouTubePlayer(Graph.context, w.source, expected(w), admin, events)
        else FilePlayer(Graph.context, w.source, expected(w), admin, events)
        player = mine
        frame?.let { mine.show(it, frameControls) }
        if (hidden) mine.sight(false)
    }

    private fun release() {
        player?.release()
        player = null
        playerKey = null
        pausing = false
        if (s.kind != null || s.ready || s.error != null) _state.update { it.copy(kind = null, ready = false, playing = false, error = null, fullscreen = false) }
    }

    /** The sound: off while an admin has it muted for everyone, else as I set it. */
    private fun applySound() {
        val a = player ?: return
        val silent = watch?.muted != null || s.muted
        // Turning the sound on isn't anyone's control either.
        if (!silent) suppressUntil = max(suppressUntil, System.currentTimeMillis() + 1_500)
        a.setMuted(silent)
        a.setVolume(s.volume)
    }

    private fun quiet() {
        suppressUntil = max(suppressUntil, System.currentTimeMillis() + 1_500)
    }

    /** Brings this player in line with the room. */
    private fun apply(force: Boolean = false) {
        val a = player?.takeIf { s.ready } ?: return
        val w = watch ?: return
        if (pausing && !force) return
        // A change I just made already matches my player; and a room state older
        // than my last change (an update crossing it on the way) mustn't undo it.
        if (!force && w.by == me && (now() - w.at < 1_500 || w.at < sentAt)) return
        if (!a.live()) {
            val drift = a.time() - expected(w)
            val limit = if (!w.playing) PAUSED else if (a.setRate != null) SEEK else DRIFT
            if (abs(drift) > limit) {
                quiet()
                a.seek(expected(w))
                a.setRate?.invoke(1f)
            } else {
                a.setRate?.invoke(if (w.playing) catchUpRate(drift) else 1f)
            }
        }
        if (w.playing && !a.playing()) {
            quiet()
            a.play()
        } else if (!w.playing && a.playing()) {
            quiet()
            a.pause()
        }
        _state.update { it.copy(playing = w.playing) }
    }

    private fun tick() {
        val a = player?.takeIf { s.ready } ?: return
        val w = watch ?: return
        tellLength(a, w)
        // Out of sight a player only follows the room (as far as it plays there at all),
        // so a phone in someone's pocket never pulls everyone back.
        if (hidden) {
            if (a.background) apply()
            return
        }
        if (isAdmin && w.by == me) {
            // The host is the reference, and always plays at normal speed.
            a.setRate?.invoke(1f)
            if (System.currentTimeMillis() < suppressUntil) return
            if (w.playing && !a.playing()) {
                if (!pausing) a.play()
                return
            }
            val t = a.time()
            if (!a.live() && abs(t - expected(w)) > HOST_DRIFT) control(w.playing, t)
        } else apply()
    }

    /** An admin's player tells the room how long the video is, when nothing else did: Up next moves on at its end. */
    private fun tellLength(a: WatchPlayer, w: WatchState) {
        val length = a.duration() ?: return
        val id = w.id ?: return
        if (!isAdmin || w.duration != null || toldLength == id) return
        toldLength = id
        val roomId = s.roomId ?: return
        realtime.emit("watch:duration", buildJsonObject { put("roomId", roomId); put("watchId", id); put("duration", length) })
    }

    private fun onUserAction(playing: Boolean, position: Double, ended: Boolean) {
        // Only what an admin does at their player drives the room, never what the phone does on its own.
        if (!isAdmin || System.currentTimeMillis() < suppressUntil || hidden) return
        val send = {
            val w = watch
            // Our own sync moves look like clicks; only real changes go out.
            if (w != null && !(w.playing == playing && abs(position - expected(w)) < DRIFT)) control(playing, position, ended)
        }
        if (playing) return send()
        // A pause that holds (not one made as the app goes out of sight) goes out.
        pausing = true
        scope.launch {
            delay(600)
            pausing = false
            val a = player
            if (!hidden && System.currentTimeMillis() >= suppressUntil && a != null && !a.playing()) send()
        }
    }

    private fun control(playing: Boolean, position: Double, ended: Boolean = false) {
        val roomId = s.roomId ?: return
        sentAt = now() - 1_000
        scope.launch {
            runCatching {
                realtime.request("watch:control", buildJsonObject {
                    put("roomId", roomId)
                    put("playing", playing)
                    put("position", position)
                    put("ended", ended)
                })
            }.onFailure { Toasts.error(it.message ?: "That didn't work.") }
        }
    }

    // ── For the screens ───────────────────────────────────────────────

    /** The room's page shows its video: it plays for me (from now on). */
    fun attach(roomId: String) = _state.update { if (it.roomId == roomId && it.onPage) it else it.copy(roomId = roomId, onPage = true) }

    /** The room's page closed: its video carries on in the small player. */
    fun detach(roomId: String) {
        _state.update { if (it.roomId == roomId) it.copy(onPage = false, fullscreen = false) else it }
        // Leaving a room whose video has stopped: nothing to carry on.
        if (s.roomId == roomId && Graph.chat.now.roomDetails[roomId]?.watch == null) stop()
    }

    /** Stops it for me (not for the room). */
    fun stop() {
        _state.update { it.copy(roomId = null, onPage = false, fullscreen = false) }
        release()
    }

    /** A frame on screen (the room's stage, the small player or full screen) takes the picture; `controls`: the player's own (admins). */
    fun show(frame: FrameLayout, controls: Boolean) {
        this.frame = frame
        frameControls = controls
        player?.show(frame, controls)
    }

    fun hide(frame: FrameLayout) {
        player?.hide(frame)
        if (this.frame === frame) this.frame = null
    }

    fun setMuted(muted: Boolean) {
        _state.update { it.copy(muted = muted) }
        applySound()
    }

    fun setVolume(volume: Float) {
        _state.update { it.copy(volume = volume, muted = volume == 0f) }
        applySound()
    }

    fun setFullscreen(on: Boolean) = _state.update { it.copy(fullscreen = on) }

    // ── The room's controls (admins) ──────────────────────────────────

    private suspend fun ask(event: String, roomId: String, timeoutMs: Long = 15_000, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}): JsonObject =
        realtime.request(event, buildJsonObject {
            put("roomId", roomId)
            extra()
        }, timeoutMs)

    /** Runs a room control, saying so if it fails. */
    fun act(event: String, roomId: String, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}) {
        scope.launch { runCatching { ask(event, roomId, 60_000, extra) }.onFailure { Toasts.error(it.message ?: "That didn't work.") } }
    }

    /** Finds the videos at a link (it can take a while on some sites). */
    suspend fun scan(roomId: String, url: String, requestId: String): FindResult =
        json.decodeFromJsonElement(FindResult.serializer(), ask("watch:scan", roomId, 120_000) { put("url", url); put("requestId", requestId) })

    suspend fun play(roomId: String, scanId: String, optionId: String) {
        ask("watch:set", roomId, 30_000) { put("scanId", scanId); put("optionId", optionId) }
    }

    /** Into Up next: one video, or every video of the playlist. How many went in. */
    suspend fun queue(roomId: String, scanId: String, optionId: String?): Int =
        ask("watch:queue-add", roomId, 60_000) {
            put("scanId", scanId)
            if (optionId != null) put("optionId", optionId) else put("playlist", true)
        }.int("added") ?: 0
}
