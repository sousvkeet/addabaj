package com.addakhana.app.call

import android.util.Log
import com.addakhana.app.Graph
import com.addakhana.app.data.AppLifecycle
import com.addakhana.app.data.DataUse
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.VoiceParticipant
import com.addakhana.app.net.Connection
import com.addakhana.app.net.Incoming
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.bool
import com.addakhana.app.net.json
import com.addakhana.app.net.obj
import com.addakhana.app.net.str
import com.addakhana.app.rtc.CandidateQueue
import com.addakhana.app.rtc.Rtc
import com.addakhana.app.rtc.Rtc.addVideoSlot
import com.addakhana.app.rtc.Rtc.answer
import com.addakhana.app.rtc.Rtc.incomingAudioLevel
import com.addakhana.app.rtc.Rtc.localAudioLevel
import com.addakhana.app.rtc.Rtc.offer
import com.addakhana.app.rtc.Rtc.setLocal
import com.addakhana.app.rtc.Rtc.setRemote
import com.addakhana.app.rtc.Rtc.stats
import com.addakhana.app.rtc.Rtc.videoSlot
import com.addakhana.app.rtc.Tones
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.VideoTrack

/** How big someone's camera is shown: not at all, or a small, medium or large tile. */
enum class View(val wire: String) {
    Hidden("hidden"), Small("small"), Medium("medium"), Large("large");

    companion object {
        fun of(s: String?) = entries.firstOrNull { it.wire == s }
    }
}

data class Moderation(val voiceMuted: Boolean = false, val cameraBlocked: Boolean = false)

data class VoiceState(
    val roomId: String? = null,
    /** idle, joining or live */
    val status: String = "idle",
    val muted: Boolean = false,
    /** Each person's camera (there from the start; pictures while their camera is on). */
    val videos: Map<String, VideoTrack> = emptyMap(),
    val speaking: Map<String, Boolean> = emptyMap(),
    val connection: Map<String, PeerConnection.PeerConnectionState> = emptyMap(),
    val cameraOn: Boolean = false,
    val cameraBusy: Boolean = false,
    /** My camera, for the self view. */
    val localVideo: VideoTrack? = null,
    val frontCamera: Boolean = true,
    /** The call window is shrunk to the bar. */
    val minimized: Boolean = false,
    /** My connection to the server dropped: the call carries on once it's back. */
    val reconnecting: Boolean = false,
    val moderation: Moderation = Moderation(),
    val startedAt: Long = 0,
    /** How the call goes: "livekit", or "mesh" (phone to phone). */
    val via: String? = null,
) {
    val live get() = status == "live"
    val active get() = status != "idle"
}

/**
 * Room voice (and video), natively, as the web app's (client/src/store/voice.ts),
 * so everyone in the room talks whatever app they use. Through LiveKit when the
 * server has it (ClientConfig.livekit; see LiveKitCall): voice:join hands out a
 * ticket into the room's call, and the sizes I show people (setViews) become
 * the quality LiveKit sends me. The server still keeps the seats.
 *
 * Without LiveKit, a full mesh. The newcomer offers to everyone already there. Video rides on the
 * same connections, in a slot made from the start (a camera going on or off
 * is a track swap), each viewer telling each sender how big it shows them.
 *
 * A network change doesn't end it: the connection to the server comes back,
 * the seat is taken back (the server keeps it 2 minutes), and every call
 * connection that broke is made again: by the person with the larger id
 * (the other asks them to), so both never offer at once.
 */
class VoiceStore(private val realtime: Realtime, private val scope: CoroutineScope) {
    companion object {
        private const val TAG = "Voice"

        private data class Quality(val side: Int, val bitrate: Int, val fps: Int)

        private val QUALITY = mapOf(
            View.Small to Quality(240, 300_000, 15),
            View.Medium to Quality(480, 900_000, 24),
            View.Large to Quality(720, 2_000_000, 30),
        )
        /** Using less data (Settings › Storage and data): a smaller ladder. */
        private val LESS = mapOf(
            View.Small to Quality(180, 150_000, 12),
            View.Medium to Quality(360, 350_000, 15),
            View.Large to Quality(480, 600_000, 20),
        )
        /** All the copies of my camera together stay within this. */
        private const val UPLOAD_BUDGET = 4_000_000
        private const val LESS_BUDGET = 1_000_000
        /** How long the call waits for the connection to come back (just after the server lets the seat go). */
        private const val RECONNECT_MS = 125_000L
        /** A call connection "disconnected" this long is made again. */
        private const val STALL_MS = 2_500L
        /** At most one fresh connection to the same person this often. */
        private const val REPAIR_EVERY_MS = 4_000L
        /** Both offering within this of each other is a real collision. */
        private const val COLLISION_MS = 2_500L
    }

    private val _state = MutableStateFlow(VoiceState())
    val state: StateFlow<VoiceState> = _state.asStateFlow()
    private val s get() = _state.value

    private class Peer(val pc: PeerConnection, val queue: CandidateQueue) {
        var video: RtpTransceiver? = null
        var remoteAudio: AudioTrack? = null
        var offeredAt = 0L
        /** Changes to what goes into the video slot, one at a time. */
        val sending = Mutex()
    }

    private val peers = mutableMapOf<String, Peer>()
    /** How big each person shows my camera (as they asked). */
    private val wanted = mutableMapOf<String, View>()
    /** How big I show each person (the call window, or its small floating view). */
    private var shown: Map<String, View> = emptyMap()
    private val shownBy = mutableMapOf<String, Map<String, View>>()
    private val told = mutableMapOf<String, View>()
    private val repaired = mutableMapOf<String, Long>()
    /** Through LiveKit: the room's call (null phone to phone). */
    private var lk: LiveKitCall? = null
    private var micSource: AudioSource? = null
    private var mic: AudioTrack? = null
    private var streamId = Rtc.newStreamId()
    private var camera: Rtc.Camera? = null
    private var lostJob: Job? = null
    private var meterJob: Job? = null
    /** My camera was on when the app went out of sight (it stops there, and comes back with me). */
    private var cameraPaused = false

    private val myId get() = Graph.auth.user?.id.orEmpty()

    init {
        scope.launch { realtime.events.collect { handle(it) } }
        scope.launch {
            var was: Connection = Connection.Offline
            realtime.state.collect { now ->
                if (was is Connection.Online && now !is Connection.Online) onConnectionLost()
                was = now
            }
        }
        scope.launch { realtime.connects.collect { onReconnected() } }
        // Onto mobile data, or the setting changed: what I ask for, and send, follows.
        scope.launch {
            combine(DataUse.net, DataUse.calls) { _, _ -> DataUse.lessForCalls() }.distinctUntilChanged().drop(1).collect {
                tellAll()
                sendVideoToAll()
            }
        }
        scope.launch {
            AppLifecycle.foreground.collect { shown ->
                // Out of sight: nobody needs to send me video, and my camera stops (the others see my photo).
                tellAll()
                val roomId = s.roomId
                if (roomId != null && s.live) {
                    if (!shown && camera != null) {
                        cameraPaused = true
                        stopCamera(announce = true)
                    } else if (shown && cameraPaused) {
                        cameraPaused = false
                        if (!s.moderation.cameraBlocked) toggleCamera()
                    }
                }
            }
        }
    }

    private fun set(fn: (VoiceState) -> VoiceState) = _state.update(fn)

    // ── Peers ──────────────────────────────────────────────────────────

    private fun closePeer(userId: String) {
        val peer = peers.remove(userId) ?: return
        Rtc.release(peer.pc)
        told.remove(userId)
        set { it.copy(videos = it.videos - userId, speaking = it.speaking - userId, connection = it.connection - userId) }
    }

    private fun cleanup() {
        lostJob?.cancel()
        meterJob?.cancel()
        lk?.close()
        lk = null
        repaired.clear()
        for (id in peers.keys.toList()) closePeer(id)
        mic?.dispose()
        mic = null
        micSource?.dispose()
        micSource = null
        camera?.stop()
        camera = null
        cameraPaused = false
        wanted.clear()
        told.clear()
        shown = emptyMap()
        shownBy.clear()
        _state.value = VoiceState()
    }

    private fun signal(roomId: String, to: String, data: JsonElement) =
        realtime.emit("voice:signal", buildJsonObject { put("roomId", roomId); put("to", to); put("data", data) })

    /** How big I want someone's camera: as I show it (out of sight: not at all), a step smaller using less data. */
    private fun viewOf(userId: String): View {
        val shownAs = if (!AppLifecycle.foreground.value) View.Hidden else shown[userId] ?: View.Hidden
        // Using less data, a step smaller than it shows (sharp enough, a fraction of the data).
        return if (!DataUse.lessForCalls()) shownAs else when (shownAs) {
            View.Large -> View.Medium
            View.Medium -> View.Small
            else -> shownAs
        }
    }

    private fun tellAll() {
        for (id in peers.keys) tell(id)
        lk?.let { call -> for (id in call.others()) call.show(id, viewOf(id)) }
    }

    /** Tells someone how big I show their camera, when that changed (out of sight: not at all). */
    private fun tell(userId: String, again: Boolean = false) {
        val roomId = s.roomId ?: return
        val view = viewOf(userId)
        if (!again && told[userId] == view) return
        told[userId] = view
        signal(roomId, userId, buildJsonObject { put("view", view.wire) })
    }

    /** Puts my camera in someone's video slot the way they asked for it (or takes it out). */
    private fun sendVideo(userId: String) {
        val peer = peers[userId] ?: return
        scope.launch {
            peer.sending.withLock {
                if (peers[userId] !== peer) return@withLock
                val sender = peer.video?.sender ?: return@withLock
                val view = wanted[userId] ?: View.Hidden
                val track = if (view == View.Hidden) null else camera?.track
                runCatching {
                    if (sender.track()?.id() != track?.id()) sender.setTrack(track, false)
                    if (track != null) tune(sender, view)
                }
            }
        }
    }

    private fun sendVideoToAll() = peers.keys.toList().forEach { sendVideo(it) }

    /** One copy of my camera, at the size, sharpness and smoothness its viewer asked for, within my upload. */
    private fun tune(sender: livekit.org.webrtc.RtpSender, view: View) {
        val less = DataUse.lessForCalls()
        val ladder = if (less) LESS else QUALITY
        val q = ladder[view] ?: return
        val params = sender.parameters
        val encoding = params.encodings.firstOrNull() ?: return
        var asked = 0
        for (id in peers.keys) ladder[wanted[id]]?.let { asked += it.bitrate }
        val share = minOf(1.0, (if (less) LESS_BUDGET else UPLOAD_BUDGET).toDouble() / maxOf(asked, 1))
        encoding.scaleResolutionDownBy = maxOf(1.0, 720.0 / q.side)
        encoding.maxBitrateBps = maxOf(100_000, (q.bitrate * share).toInt())
        encoding.maxFramerate = q.fps
        sender.setParameters(params)
    }

    private fun connect(userId: String, roomId: String, offering: Boolean): Peer {
        closePeer(userId)
        lateinit var peer: Peer
        val pc = Rtc.peer(Graph.site.config.value, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                scope.launch { if (peers[userId] === peer) signal(roomId, userId, buildJsonObject { put("candidate", Rtc.candidateJson(candidate)) }) }
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                scope.launch {
                    if (peers[userId] !== peer) return@launch
                    when (val track = transceiver.receiver.track()) {
                        is VideoTrack -> set { it.copy(videos = it.videos + (userId to track)) }
                        is AudioTrack -> {
                            peer.remoteAudio = track
                            applySilence()
                        }
                    }
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                scope.launch {
                    if (peers[userId] !== peer) return@launch
                    set { it.copy(connection = it.connection + (userId to newState)) }
                    when (newState) {
                        // Connected (again): both ends settle what goes into the video slot.
                        PeerConnection.PeerConnectionState.CONNECTED -> {
                            tell(userId, again = true)
                            sendVideo(userId)
                        }
                        PeerConnection.PeerConnectionState.FAILED -> repair(userId)
                        PeerConnection.PeerConnectionState.DISCONNECTED -> scope.launch {
                            delay(STALL_MS)
                            val st = peer.pc.connectionState()
                            if (peers[userId] === peer && (st == PeerConnection.PeerConnectionState.DISCONNECTED || st == PeerConnection.PeerConnectionState.FAILED)) repair(userId)
                        }
                        else -> {}
                    }
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: DataChannel) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
        })
        peer = Peer(pc, CandidateQueue(pc))
        peers[userId] = peer
        mic?.let { pc.addTrack(it, listOf(streamId)) }
        // The one who offers makes the video slot; the other adopts it from the offer.
        if (offering) peer.video = pc.addVideoSlot(streamId)
        tell(userId, again = true)
        return peer
    }

    /** People an admin silenced: every app keeps them quiet. */
    private fun applySilence() {
        val roomId = s.roomId ?: return
        val silenced = Graph.chat.now.voice[roomId].orEmpty().filter { it.silenced }.map { it.userId }.toSet()
        for ((id, peer) in peers) runCatching { peer.remoteAudio?.setEnabled(id !in silenced) }
    }

    /**
     * A call connection broke (a network change on either side): the one of
     * us with the larger id makes a fresh one; the other asks them to. Not
     * while the server is out of reach (onReconnected makes them all again).
     */
    private fun repair(userId: String) {
        val roomId = s.roomId ?: return
        if (!s.live || realtime.state.value !is Connection.Online || !peers.containsKey(userId)) return
        // Their connection dropped: they make it again when they're back.
        if (Graph.chat.now.voice[roomId].orEmpty().any { it.userId == userId && it.away }) return
        if (System.currentTimeMillis() - (repaired[userId] ?: 0) < REPAIR_EVERY_MS) return
        repaired[userId] = System.currentTimeMillis()
        if (myId > userId) scope.launch { runCatching { offerTo(userId, roomId) }.onFailure { Log.w(TAG, "offer failed", it) } }
        else signal(roomId, userId, buildJsonObject { put("restart", true) })
    }

    private suspend fun offerTo(userId: String, roomId: String) {
        val peer = connect(userId, roomId, offering = true)
        val offer = peer.pc.offer()
        peer.pc.setLocal(offer)
        peer.offeredAt = System.currentTimeMillis()
        signal(roomId, userId, buildJsonObject { put("sdp", Rtc.sdpJson(Rtc.lean(peer.pc.localDescription ?: offer))) })
    }

    // ── What the person does ───────────────────────────────────────────

    /** Joins a room's voice (with the camera on, for "Join with video"). */
    fun join(roomId: String, video: Boolean = false) = scope.launch {
        if (Graph.calls.state.value.phase != "idle") {
            Toasts.show("End your call before joining voice.")
            return@launch
        }
        val current = s
        if (current.roomId == roomId && current.active) {
            // Already here: "with video" turns the camera on.
            if (video && current.live && !current.cameraOn) toggleCamera()
            return@launch
        }
        if (current.roomId != null) leave()
        streamId = Rtc.newStreamId()
        _state.value = VoiceState(roomId = roomId, status = "joining", startedAt = System.currentTimeMillis())
        try {
            Graph.site.freshConfig()
            Rtc.ready(Graph.context)
            if (Graph.site.config.value.livekit) return@launch joinThroughLiveKit(roomId, video)
            val (source, track) = Rtc.openMicrophone()
            micSource = source
            mic = track
            if (video && s.roomId == roomId) {
                if (!startCamera()) Toasts.error("Couldn't start your camera. Joining with voice only.")
            }
            if (s.roomId != roomId) return@launch cleanup()
            val res = realtime.request("voice:join", buildJsonObject {
                put("roomId", roomId)
                put("muted", false)
                put("camera", camera != null)
            }, 10_000)
            // Left while joining: the leave reached the server first, so say it again.
            if (s.roomId != roomId) {
                realtime.emit("voice:leave", buildJsonObject { put("roomId", roomId) })
                return@launch
            }
            set { it.copy(status = "live", via = "mesh") }
            res.obj("moderation")?.let { moderate(Moderation(it.bool("voiceMuted") == true, it.bool("cameraBlocked") == true), joining = true) }
            Tones.blip(join = true)
            startMeters()
            val others = runCatching { json.decodeFromJsonElement(ListSerializer(VoiceParticipant.serializer()), res["peers"]!!) }.getOrDefault(emptyList())
            for (p in others) scope.launch { runCatching { offerTo(p.userId, roomId) }.onFailure { Log.w(TAG, "offer failed", it) } }
        } catch (e: Exception) {
            cleanup()
            Toasts.error(e.message ?: "Couldn't join voice.")
        }
    }

    // ── Through LiveKit ────────────────────────────────────────────────

    private suspend fun joinThroughLiveKit(roomId: String, video: Boolean) {
        val res = realtime.request("voice:join", buildJsonObject {
            put("roomId", roomId)
            put("muted", false)
            put("camera", video)
            put("livekit", true)
        }, 10_000)
        // Left while joining: the leave reached the server first, so say it again.
        if (s.roomId != roomId) {
            realtime.emit("voice:leave", buildJsonObject { put("roomId", roomId) })
            return
        }
        val ticket = res.obj("livekit") ?: throw IllegalStateException("Couldn't join voice.")
        set { it.copy(status = "live", via = "livekit") }
        res.obj("moderation")?.let { moderate(Moderation(it.bool("voiceMuted") == true, it.bool("cameraBlocked") == true), joining = true) }
        Tones.blip(join = true)
        try {
            startCall(roomId, ticket, camera = video && !s.moderation.cameraBlocked)
        } catch (e: Exception) {
            // The network went as I joined (the server's gone too): back in when it's back (onReconnected), as after any drop.
            if (realtime.state.value !is Connection.Online && s.roomId == roomId) {
                set { it.copy(reconnecting = true) }
                return
            }
            // In the seat, but not the call: out of both.
            realtime.emit("voice:leave", buildJsonObject { put("roomId", roomId) })
            throw e
        }
    }

    /** Into the room's call (again, after LiveKit's connection was lost for good), sending what I may. */
    private suspend fun startCall(roomId: String, ticket: JsonObject, camera: Boolean) {
        lk?.close()
        lateinit var call: LiveKitCall
        call = LiveKitCall(Graph.context, scope, object : LiveKitCall.Events {
            private val mine get() = lk === call

            override fun video(userId: String, track: VideoTrack?) {
                if (!mine) return
                set { it.copy(videos = if (track == null) it.videos - userId else it.videos + (userId to track)) }
                if (track != null) call.show(userId, viewOf(userId))
            }

            override fun here(userId: String, here: Boolean) {
                if (!mine) return
                set {
                    if (here) it.copy(connection = it.connection + (userId to PeerConnection.PeerConnectionState.CONNECTED))
                    else it.copy(connection = it.connection - userId, videos = it.videos - userId, speaking = it.speaking - userId)
                }
                if (here) call.show(userId, viewOf(userId))
            }

            override fun speaking(ids: Set<String>) {
                if (!mine) return
                set { st -> st.copy(speaking = (st.speaking.keys + ids).associateWith { id -> id in ids && (id != myId || !st.muted) }) }
            }

            override fun reconnecting(now: Boolean) {
                if (mine) set { it.copy(reconnecting = now || realtime.state.value !is Connection.Online) }
            }

            override fun gone(reason: io.livekit.android.events.DisconnectReason?) {
                scope.launch {
                    if (!mine || !s.live) return@launch
                    val online = realtime.state.value is Connection.Online
                    val removed = reason == io.livekit.android.events.DisconnectReason.DUPLICATE_IDENTITY ||
                        reason == io.livekit.android.events.DisconnectReason.PARTICIPANT_REMOVED ||
                        reason == io.livekit.android.events.DisconnectReason.ROOM_DELETED
                    // Joined from another device, or taken out: the server says so (voice:kicked).
                    if (online && removed) {
                        delay(2_000)
                        if (lk === call) {
                            cleanup()
                            Toasts.error("You left voice.")
                        }
                        return@launch
                    }
                    // It gave up on the connection: in again with a fresh ticket (without the server either:
                    // when it's back, onReconnected; or I'm told it didn't come back).
                    set { it.copy(reconnecting = true) }
                    if (online) rejoinCall(roomId)
                }
            }

            override fun refused(what: String) {
                Log.w(TAG, "LiveKit didn't take my $what")
            }
        })
        lk = call
        call.connect(ticket.str("url") ?: throw IllegalStateException("No call address."), ticket.str("token") ?: throw IllegalStateException("No call ticket."))
        if (lk !== call) return call.close()
        if (!s.moderation.voiceMuted && !s.muted) call.mic(true)
        if (camera) startCameraLk()
        set { it.copy(reconnecting = realtime.state.value !is Connection.Online) }
    }

    /** LiveKit's connection is gone for good: a fresh ticket (the seat is still mine), and in again. */
    private suspend fun rejoinCall(roomId: String) {
        try {
            val res = realtime.request("voice:join", buildJsonObject {
                put("roomId", roomId)
                put("resume", true)
                (realtime.state.value as? Connection.Online)?.sid?.let { put("from", it) }
                put("muted", s.muted)
                put("camera", s.cameraOn)
                put("livekit", true)
            })
            if (s.roomId != roomId) return
            startCall(roomId, res.obj("livekit") ?: return, camera = s.cameraOn)
        } catch (e: Exception) {
            if (s.roomId != roomId) return
            realtime.emit("voice:leave", buildJsonObject { put("roomId", roomId) })
            cleanup()
            Toasts.error(e.message ?: "You left voice.")
        }
    }

    /** My camera into the call (in place of the one before). */
    private suspend fun startCameraLk(): Boolean {
        val call = lk ?: return false
        val front = com.addakhana.app.data.Devices.frontCamera.value
        val track = call.cameraOn(front, DataUse.lessForCalls()) ?: return false
        if (lk !== call) return false
        set { it.copy(cameraOn = true, localVideo = track, frontCamera = front, minimized = false) }
        return true
    }

    fun leave() {
        val roomId = s.roomId
        if (roomId != null) realtime.emit("voice:leave", buildJsonObject { put("roomId", roomId) })
        if (s.live) Tones.blip(join = false)
        cleanup()
    }

    fun toggleMute() {
        val roomId = s.roomId
        if (s.muted && s.moderation.voiceMuted) {
            Toasts.show("An admin muted you here. You can talk again when an admin lets you.")
            return
        }
        val next = !s.muted
        mic?.setEnabled(!next)
        lk?.let { call -> scope.launch { call.mic(!next) } }
        set { it.copy(muted = next, speaking = it.speaking + (myId to false)) }
        if (roomId != null) realtime.emit("voice:mute", buildJsonObject { put("roomId", roomId); put("muted", next) })
    }

    fun toggleCamera() {
        if (!s.live || s.cameraBusy) return
        if (s.cameraOn) return stopCamera(announce = true)
        if (s.moderation.cameraBlocked) {
            Toasts.show("An admin stopped your camera here. You can turn it on again when an admin lets you.")
            return
        }
        if (lk != null) {
            scope.launch {
                set { it.copy(cameraBusy = true) }
                val ok = startCameraLk()
                set { it.copy(cameraBusy = false) }
                if (ok) s.roomId?.let { realtime.emit("voice:camera", buildJsonObject { put("roomId", it); put("on", true) }) }
                else Toasts.error("Couldn't start your camera.")
            }
            return
        }
        set { it.copy(cameraBusy = true) }
        val ok = startCamera()
        set { it.copy(cameraBusy = false) }
        if (ok) s.roomId?.let { realtime.emit("voice:camera", buildJsonObject { put("roomId", it); put("on", true) }) }
        else Toasts.error("Couldn't start your camera.")
    }

    fun switchCamera() {
        lk?.let { call ->
            if (!s.cameraOn) return
            val front = !s.frontCamera
            call.switchCamera(front)
            set { it.copy(frontCamera = front) }
            return
        }
        camera?.switch { front -> set { it.copy(frontCamera = front) } }
    }

    fun setMinimized(minimized: Boolean) = set { it.copy(minimized = minimized) }

    /** How big the call window (or its small floating view, "pip") shows each person now; anyone missing isn't shown. */
    fun setViews(views: Map<String, View>, from: String = "window") {
        if (views.isNotEmpty()) shownBy[from] = views else shownBy.remove(from)
        shown = shownBy["pip"] ?: shownBy["window"] ?: emptyMap()
        tellAll()
    }

    private fun startCamera(): Boolean {
        if (!s.active) return false
        Rtc.init(Graph.context)
        val cam = Rtc.Camera.open(front = com.addakhana.app.data.Devices.frontCamera.value, onEnded = { scope.launch { if (camera != null) stopCamera(announce = true) } }) ?: return false
        camera?.stop()
        camera = cam
        set { it.copy(cameraOn = true, localVideo = cam.track, frontCamera = cam.front, minimized = false) }
        sendVideoToAll()
        return true
    }

    private fun stopCamera(announce: Boolean) {
        val cam = camera
        camera = null
        lk?.cameraOff()
        set { it.copy(cameraOn = false, localVideo = null) }
        // Out of every slot before the camera goes.
        for (peer in peers.values) runCatching { peer.video?.sender?.setTrack(null, false) }
        cam?.stop()
        val roomId = s.roomId
        if (announce && roomId != null && s.live) realtime.emit("voice:camera", buildJsonObject { put("roomId", roomId); put("on", false) })
    }

    /** What a room's admins decided about me: muted (my microphone goes off and stays off), my camera stopped. */
    private fun moderate(next: Moderation, joining: Boolean) {
        val before = s.moderation
        set { it.copy(moderation = next) }
        if (next.voiceMuted && !s.muted) {
            mic?.setEnabled(false)
            lk?.let { call -> scope.launch { call.mic(false) } }
            set { it.copy(muted = true, speaking = it.speaking + (myId to false)) }
        }
        if (next.cameraBlocked && (camera != null || (lk != null && s.cameraOn))) stopCamera(announce = true)
        if (joining) {
            if (next.voiceMuted || next.cameraBlocked) {
                val what = if (next.voiceMuted && next.cameraBlocked) "muted you and stopped your camera" else if (next.voiceMuted) "muted you" else "stopped your camera"
                Toasts.show("An admin $what here, until they let you.")
            }
            return
        }
        if (next.voiceMuted != before.voiceMuted) {
            if (next.voiceMuted) Toasts.error("An admin muted you.") else Toasts.show("An admin let you talk again. Unmute when you're ready.", Toasts.Tone.Live)
        }
        if (next.cameraBlocked != before.cameraBlocked) {
            if (next.cameraBlocked) Toasts.error("An admin stopped your camera.") else Toasts.show("An admin let you turn your camera on again.", Toasts.Tone.Live)
        }
    }

    /** Who's speaking (rings on their seats), from each connection's audio level, three times a second. */
    private fun startMeters() {
        meterJob?.cancel()
        meterJob = scope.launch {
            val quietSince = mutableMapOf<String, Long>()
            while (isActive) {
                delay(300)
                if (!AppLifecycle.foreground.value) continue
                var local: Double? = null
                for ((id, peer) in peers.toMap()) {
                    val report = runCatching { peer.pc.stats() }.getOrNull() ?: continue
                    if (local == null) local = report.localAudioLevel()
                    val level = report.incomingAudioLevel() ?: continue
                    update(id, level, quietSince)
                }
                if (!s.muted) local?.let { update(myId, it, quietSince) }
            }
        }
    }

    private fun update(id: String, level: Double, quietSince: MutableMap<String, Long>) {
        val now = System.currentTimeMillis()
        val speaking = s.speaking[id] == true
        if (level > 0.03) {
            quietSince.remove(id)
            if (!speaking) set { it.copy(speaking = it.speaking + (id to true)) }
        } else if (speaking) {
            val since = quietSince.getOrPut(id) { now }
            if (now - since > 400) set { it.copy(speaking = it.speaking + (id to false)) }
        }
    }

    // ── The server's events ────────────────────────────────────────────

    private fun handle(e: Incoming) {
        val o = e.obj
        when (e.name) {
            "voice:peer-joined" -> if (o.str("roomId") == s.roomId && s.live) Tones.blip(join = true)
            "voice:peer-left" -> {
                if (o.str("roomId") != s.roomId) return
                val userId = o.str("userId") ?: return
                wanted.remove(userId)
                closePeer(userId)
                sendVideoToAll()
                Tones.blip(join = false)
            }
            "voice:signal" -> {
                if (o.str("roomId") != s.roomId) return
                val from = o.str("from") ?: return
                val data = o.obj("data") ?: return
                scope.launch { onSignal(s.roomId!!, from, data) }
            }
            "voice:kicked" -> {
                if (o.str("roomId") != s.roomId) return
                cleanup()
                when (o.str("reason")) {
                    "elsewhere" -> Toasts.show("You joined voice on another device, so this one left.")
                    "removed" -> Toasts.show("You were removed from the room, so you left voice.")
                    "deleted" -> Toasts.show("The room was deleted, so voice ended.")
                }
            }
            "voice:moderated" -> {
                if (o.str("roomId") != s.roomId || !s.active) return
                moderate(Moderation(o.bool("voiceMuted") == true, o.bool("cameraBlocked") == true), joining = false)
            }
            "voice:state" -> if (o.str("roomId") == s.roomId) scope.launch { applySilence() }
        }
    }

    private suspend fun onSignal(roomId: String, from: String, data: JsonObject) {
        // How big they show my camera (it can come before their offer or answer).
        data.str("view")?.let { v ->
            val view = View.of(v) ?: return
            wanted[from] = view
            sendVideoToAll()
            return
        }
        if (mic == null) return
        // They ask me (the larger id) for a fresh connection: theirs broke.
        if (data.bool("restart") == true) {
            if (myId > from) repair(from)
            return
        }
        try {
            val sdpObj = data.obj("sdp")
            val sdp = sdpObj?.let { Rtc.sdpOf(it) }
            when {
                sdp?.type == livekit.org.webrtc.SessionDescription.Type.OFFER -> {
                    // Both offered at once (both reconnecting): the larger id's offer wins.
                    val mine = peers[from]
                    if (mine != null && mine.pc.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER && myId > from &&
                        System.currentTimeMillis() - mine.offeredAt < COLLISION_MS
                    ) return
                    val peer = connect(from, roomId, offering = false)
                    peer.pc.setRemote(Rtc.lean(Rtc.startSharp(sdp)))
                    peer.queue.flush()
                    // Adopt their video slot and open it for sending, so my camera can join with a track swap.
                    peer.video = peer.pc.videoSlot()?.also {
                        it.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                        runCatching { it.sender.setStreams(listOf(streamId)) }
                    }
                    val answer = peer.pc.answer()
                    peer.pc.setLocal(answer)
                    signal(roomId, from, buildJsonObject { put("sdp", Rtc.sdpJson(Rtc.lean(peer.pc.localDescription ?: answer))) })
                    sendVideo(from)
                }
                sdp?.type == livekit.org.webrtc.SessionDescription.Type.ANSWER -> {
                    val peer = peers[from] ?: return
                    peer.pc.setRemote(Rtc.lean(Rtc.startSharp(sdp)))
                    peer.queue.flush()
                }
                data.obj("candidate") != null -> peers[from]?.queue?.add(data.obj("candidate")!!)
            }
        } catch (e: Exception) {
            Log.w(TAG, "signalling failed", e)
        }
    }

    private fun onConnectionLost() {
        if (!s.active) return
        // Not in yet: try again once the line is back.
        if (s.status == "joining") {
            cleanup()
            Toasts.error("You left voice because the connection dropped.")
            return
        }
        // The call carries on (sound may pause) while the connection comes back.
        set { it.copy(reconnecting = true) }
        lostJob?.cancel()
        lostJob = scope.launch {
            delay(RECONNECT_MS)
            if (!s.active || realtime.state.value is Connection.Online) return@launch
            cleanup()
            Toasts.error("You left voice: the connection didn't come back.")
        }
    }

    /** Connected again: take my seat back, and make again whatever broke. */
    private suspend fun onReconnected() {
        lostJob?.cancel()
        val roomId = s.roomId ?: return
        if (!s.live) return
        try {
            val res = realtime.request("voice:join", buildJsonObject {
                put("roomId", roomId)
                put("resume", true)
                realtime.previousSid?.let { put("from", it) }
                put("muted", s.muted)
                put("camera", s.cameraOn)
                if (s.via == "livekit") put("livekit", true)
            })
            if (s.roomId != roomId) return
            set { it.copy(reconnecting = false) }
            res.obj("moderation")?.let { moderate(Moderation(it.bool("voiceMuted") == true, it.bool("cameraBlocked") == true), joining = false) }
            // Through LiveKit: its call carried on, or is coming back by itself; only if it gave up, in again.
            res.obj("livekit")?.let { ticket ->
                val call = lk
                if (call == null || call.disconnected) startCall(roomId, ticket, camera = s.cameraOn)
                return
            }
            val others = runCatching { json.decodeFromJsonElement(ListSerializer(VoiceParticipant.serializer()), res["peers"]!!) }.getOrDefault(emptyList())
            val here = others.map { it.userId }.toSet()
            // Gone while I was away.
            for (id in peers.keys.toList()) if (id !in here) closePeer(id)
            // A fresh connection to whoever's isn't working (after a network change, nobody's is).
            val resumed = res.bool("resumed") == true
            for (p in others) {
                val peer = peers[p.userId]
                if (resumed && peer?.pc?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) continue
                repaired[p.userId] = System.currentTimeMillis()
                scope.launch { runCatching { offerTo(p.userId, roomId) }.onFailure { Log.w(TAG, "offer failed", it) } }
            }
        } catch (e: Exception) {
            if (s.roomId != roomId) return
            cleanup()
            Toasts.error(e.message ?: "You left voice.")
        }
    }

    fun signedOut() {
        if (s.roomId != null) leave()
    }
}
