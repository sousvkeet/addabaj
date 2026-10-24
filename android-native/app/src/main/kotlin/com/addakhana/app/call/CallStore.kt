package com.addakhana.app.call

import android.util.Log
import com.addakhana.app.Graph
import com.addakhana.app.data.AppLifecycle
import com.addakhana.app.data.DataUse
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.Sender
import com.addakhana.app.net.Connection
import com.addakhana.app.net.Incoming
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.bool
import com.addakhana.app.net.int
import com.addakhana.app.net.obj
import com.addakhana.app.net.str
import com.addakhana.app.push.IncomingCall
import com.addakhana.app.rtc.CandidateQueue
import com.addakhana.app.rtc.Rtc
import com.addakhana.app.rtc.Rtc.addVideoSlot
import com.addakhana.app.rtc.Rtc.answer
import com.addakhana.app.rtc.Rtc.incomingAudioBytes
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
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.combine
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
import livekit.org.webrtc.RtpSender
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.VideoTrack

data class CallState(
    /** idle, outgoing, incoming, connecting or active */
    val phase: String = "idle",
    val callId: String? = null,
    val peer: Sender? = null,
    /** Started as (or became) a video call. */
    val videoCall: Boolean = false,
    val muted: Boolean = false,
    val peerMuted: Boolean = false,
    val cameraOn: Boolean = false,
    val cameraBusy: Boolean = false,
    val peerCameraOn: Boolean = false,
    val localVideo: VideoTrack? = null,
    val remoteVideo: VideoTrack? = null,
    val frontCamera: Boolean = true,
    /** The video window is shrunk to the call bar. */
    val minimized: Boolean = false,
    val startedAt: Long? = null,
    val reconnecting: Boolean = false,
    val localSpeaking: Boolean = false,
    val remoteSpeaking: Boolean = false,
    /** Connected, but no sound has arrived for a few seconds. */
    val noIncomingAudio: Boolean = false,
    val accepting: Boolean = false,
    /** The sound comes from the loudspeaker (not the earpiece). */
    val speaker: Boolean = false,
) {
    val idle get() = phase == "idle"
    val inCall get() = phase != "idle" && phase != "incoming"
}

/**
 * One-to-one calls, natively, as the web app's (client/src/store/call.ts):
 * every call negotiates one audio and one video slot up front (the video
 * slot empty for voice calls, so a camera going on later is a track swap),
 * and the caller makes every offer, ICE restarts included. A network change
 * doesn't end a call: it resumes on the new connection to the server
 * (call:resume), and the sound and video get a new path.
 */
class CallStore(private val realtime: Realtime, private val scope: CoroutineScope) {
    companion object {
        private const val TAG = "Call"
        /** How long a call waits for its connection to come back (the server waits about as long). */
        private const val RECONNECT_MS = 50_000L
        private const val STALL_MS = 2_500L
        private const val REPAIR_EVERY_MS = 4_000L
        /** My camera's most, in a one-to-one call: a sharp 720p. */
        private const val MAX_BITRATE = 3_000_000
        private const val MAX_FPS = 30
        /** Less data (Settings › Storage and data): about 480p, 20 frames a second, 450 kbit/s. */
        private const val LESS_BITRATE = 450_000
        private const val LESS_FPS = 20
        private const val LESS_SCALE = 1.5
        /** An answer from the call screen counts for a call that arrives this long after. */
        private const val ANSWER_VALID_MS = 60_000L
    }

    private val _state = MutableStateFlow(CallState())
    val state: StateFlow<CallState> = _state.asStateFlow()
    private val s get() = _state.value

    private var pc: PeerConnection? = null
    private var queue: CandidateQueue? = null
    private var micSource: AudioSource? = null
    private var mic: AudioTrack? = null
    private var camera: Rtc.Camera? = null
    private var videoTx: RtpTransceiver? = null
    private var audioSender: RtpSender? = null
    private var streamId = Rtc.newStreamId()
    /** Who started the call: the caller makes every offer. */
    private var role: String? = null
    private var lostJob: Job? = null
    private var healthJob: Job? = null
    private var lastRepair = 0L
    /** Answered on the phone's call screen, before the app heard of the call: (callId, video, when). */
    private var pendingAnswer: Triple<String, Boolean, Long>? = null

    init {
        scope.launch { realtime.events.collect { handle(it) } }
        scope.launch {
            var was: Connection = Connection.Offline
            realtime.state.collect { now ->
                if (was is Connection.Online && now !is Connection.Online && !s.idle) waitForLine()
                was = now
            }
        }
        scope.launch { realtime.connects.collect { onReconnected() } }
        // Onto mobile data, or the setting changed: my camera follows (what I receive changes at the next negotiation).
        scope.launch {
            combine(DataUse.net, DataUse.calls) { _, _ -> DataUse.lessForCalls() }.distinctUntilChanged().collect { if (camera != null) tuneVideo() }
        }
        scope.launch {
            AppLifecycle.foreground.collect { shown ->
                // Ringing in the app, which just went out of sight: the phone's own call screen takes over.
                if (!shown && s.phase == "incoming") {
                    Tones.stopRing()
                    ringNatively()
                }
            }
        }
    }

    private fun set(fn: (CallState) -> CallState) = _state.update(fn)

    private fun cleanup() {
        lostJob?.cancel()
        healthJob?.cancel()
        role = null
        lastRepair = 0
        Tones.stopRing()
        s.callId?.let { IncomingCall.stopRinging(Graph.context, it) }
        pc?.let { Rtc.release(it) }
        pc = null
        queue = null
        videoTx = null
        audioSender = null
        camera?.stop()
        camera = null
        mic?.dispose()
        mic = null
        micSource?.dispose()
        micSource = null
        _state.value = CallState()
    }

    private fun signal(data: JsonObject) {
        val callId = s.callId ?: return
        realtime.emit("call:signal", buildJsonObject { put("callId", callId); put("data", data) })
    }

    private fun emitCamera(on: Boolean) {
        val callId = s.callId ?: return
        if (pc != null) realtime.emit("call:camera", buildJsonObject { put("callId", callId); put("on", on) })
    }

    private suspend fun startMic() {
        Rtc.ready(Graph.context)
        val (source, track) = Rtc.openMicrophone()
        micSource = source
        mic = track
    }

    private fun startCamera(): Boolean {
        if (s.idle) return false
        Rtc.init(Graph.context)
        val cam = Rtc.Camera.open(front = com.addakhana.app.data.Devices.frontCamera.value, onEnded = { scope.launch { if (camera != null) stopCamera() } }) ?: return false
        camera?.stop()
        camera = cam
        videoTx?.sender?.let { runCatching { it.setTrack(cam.track, false) } }
        tuneVideo()
        set { it.copy(cameraOn = true, localVideo = cam.track, frontCamera = cam.front, minimized = false) }
        return true
    }

    private fun tuneVideo() {
        val sender = videoTx?.sender ?: return
        val params = sender.parameters
        val encoding = params.encodings.firstOrNull() ?: return
        val less = DataUse.lessForCalls()
        val bitrate = if (less) LESS_BITRATE else MAX_BITRATE
        val fps = if (less) LESS_FPS else MAX_FPS
        val scale = if (less) LESS_SCALE else 1.0
        if (encoding.maxBitrateBps == bitrate && encoding.maxFramerate == fps && encoding.scaleResolutionDownBy == scale) return
        encoding.maxBitrateBps = bitrate
        encoding.maxFramerate = fps
        encoding.scaleResolutionDownBy = scale
        runCatching { sender.setParameters(params) }
    }

    private fun stopCamera() {
        runCatching { videoTx?.sender?.setTrack(null, false) }
        camera?.stop()
        camera = null
        set { it.copy(cameraOn = false, localVideo = null) }
        emitCamera(false)
    }

    /** The call's connection is down: "Reconnecting…", ending if it doesn't come back in time. */
    private fun waitForLine() {
        set { it.copy(reconnecting = true) }
        lostJob?.cancel()
        lostJob = scope.launch {
            delay(RECONNECT_MS)
            if (s.idle || (pc?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED && realtime.state.value is Connection.Online)) return@launch
            endCall()
            Toasts.error("The call ended: the connection didn't come back.")
        }
    }

    /** A new path for the sound and video (the network changed): an ICE restart, offered by the caller. */
    private suspend fun restartIce() {
        val conn = pc ?: return
        if (s.callId == null || role != "caller" || realtime.state.value !is Connection.Online) return
        try {
            conn.restartIce()
            val offer = conn.offer()
            if (pc !== conn) return
            conn.setLocal(offer)
            signal(buildJsonObject { put("sdp", Rtc.sdpJson(Rtc.lean(conn.localDescription ?: offer))) })
        } catch (e: Exception) {
            Log.w(TAG, "ICE restart failed", e)
        }
    }

    /** The call's connection broke: the caller finds it a new path; the callee asks it to. */
    private fun repair() {
        if (pc == null || s.callId == null || realtime.state.value !is Connection.Online || System.currentTimeMillis() - lastRepair < REPAIR_EVERY_MS) return
        lastRepair = System.currentTimeMillis()
        if (role == "caller") scope.launch { restartIce() } else signal(buildJsonObject { put("restart", true) })
    }

    private fun setupPeer(asCaller: Boolean): PeerConnection {
        role = if (asCaller) "caller" else "callee"
        streamId = Rtc.newStreamId()
        lateinit var conn: PeerConnection
        var synced = false
        conn = Rtc.peer(Graph.site.config.value, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                scope.launch { if (pc === conn) signal(buildJsonObject { put("candidate", Rtc.candidateJson(candidate)) }) }
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                scope.launch {
                    if (pc !== conn) return@launch
                    val track = transceiver.receiver.track()
                    if (track is VideoTrack) set { it.copy(remoteVideo = track) }
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                scope.launch {
                    if (pc !== conn) return@launch
                    when (newState) {
                        PeerConnection.PeerConnectionState.CONNECTED -> {
                            lostJob?.cancel()
                            set { it.copy(phase = "active", reconnecting = false, startedAt = it.startedAt ?: System.currentTimeMillis()) }
                            watchIncomingAudio(conn)
                            // Tell the other side where my camera ended up (it may have changed while ringing).
                            if (!synced) {
                                synced = true
                                emitCamera(s.cameraOn)
                            }
                        }
                        PeerConnection.PeerConnectionState.DISCONNECTED -> {
                            // Often a network change: if it doesn't come back by itself, give it a new path.
                            waitForLine()
                            scope.launch {
                                delay(STALL_MS)
                                val st = conn.connectionState()
                                if (pc === conn && (st == PeerConnection.PeerConnectionState.DISCONNECTED || st == PeerConnection.PeerConnectionState.FAILED)) repair()
                            }
                        }
                        PeerConnection.PeerConnectionState.FAILED -> {
                            if (s.startedAt != null) {
                                // It was working: find it a new path, rather than end the call.
                                waitForLine()
                                repair()
                            } else {
                                Toasts.error("The call couldn't connect. If you're on different networks, a TURN server may be needed.")
                                endCall()
                            }
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
        pc = conn
        queue = CandidateQueue(conn)
        mic?.let { audioSender = conn.addTrack(it, listOf(streamId)) }
        // The caller makes the video slot; the callee adopts it from the offer.
        if (asCaller) {
            videoTx = conn.addVideoSlot(streamId)
            camera?.track?.let { t -> runCatching { videoTx?.sender?.setTrack(t, false) } }
        }
        return conn
    }

    /** Sound arriving (even a silent speaker sends a few packets a second), and who's speaking. */
    private fun watchIncomingAudio(conn: PeerConnection) {
        healthJob?.cancel()
        healthJob = scope.launch {
            var last: Long? = null
            var stalledSince = 0L
            var tick = 0
            var localQuiet = 0L
            var remoteQuiet = 0L
            while (isActive && pc === conn) {
                delay(300)
                val report = runCatching { conn.stats() }.getOrNull() ?: continue
                val now = System.currentTimeMillis()
                // Speaking rings.
                val remote = report.incomingAudioLevel() ?: 0.0
                if (remote > 0.03) {
                    remoteQuiet = 0
                    if (!s.remoteSpeaking) set { it.copy(remoteSpeaking = true) }
                } else if (s.remoteSpeaking) {
                    if (remoteQuiet == 0L) remoteQuiet = now else if (now - remoteQuiet > 400) set { it.copy(remoteSpeaking = false) }
                }
                val local = if (s.muted) 0.0 else report.localAudioLevel() ?: 0.0
                if (local > 0.03) {
                    localQuiet = 0
                    if (!s.localSpeaking) set { it.copy(localSpeaking = true) }
                } else if (s.localSpeaking) {
                    if (localQuiet == 0L) localQuiet = now else if (now - localQuiet > 400) set { it.copy(localSpeaking = false) }
                }
                // Every 2 s: is any sound arriving at all?
                if (++tick % 7 != 0) continue
                val bytes = report.incomingAudioBytes() ?: continue
                if (last != null && bytes == last) {
                    if (stalledSince == 0L) stalledSince = now
                    if (now - stalledSince > 6_000 && !s.noIncomingAudio) set { it.copy(noIncomingAudio = true) }
                } else {
                    stalledSince = 0
                    if (s.noIncomingAudio) set { it.copy(noIncomingAudio = false) }
                }
                last = bytes
            }
        }
    }

    // ── What the person does ───────────────────────────────────────────

    fun startCall(peer: Sender, video: Boolean) = scope.launch {
        if (!s.idle) {
            Toasts.show("You're already on a call.")
            return@launch
        }
        _state.value = CallState(phase = "outgoing", peer = peer, videoCall = video, speaker = video)
        try {
            if (Graph.voice.state.value.roomId != null) Graph.voice.leave()
            Graph.site.freshConfig()
            startMic()
            if (video && !startCamera()) Toasts.error("Couldn't start your camera. Continuing with voice only.")
            if (s.phase != "outgoing") return@launch cleanup()
            val withVideo = camera != null
            set { it.copy(videoCall = withVideo) }
            val res = realtime.request("call:start", buildJsonObject { put("to", peer.id); put("video", withVideo) })
            val callId = res.str("callId") ?: throw IllegalStateException("The call didn't start.")
            // Hung up while it was being placed: cancel it, or they'd ring on.
            if (s.phase != "outgoing" || s.peer?.id != peer.id || s.callId != null) {
                realtime.emit("call:end", buildJsonObject { put("callId", callId) })
                return@launch
            }
            set { it.copy(callId = callId) }
            Tones.ring(incoming = false)
        } catch (e: Exception) {
            cleanup()
            Toasts.error(e.message ?: "Couldn't start the call.")
        }
    }

    fun acceptCall(video: Boolean) = scope.launch {
        val callId = s.callId ?: return@launch
        // Answered twice (the call screen and the notification, say): the first answer goes on.
        if (s.phase != "incoming" || s.accepting) return@launch
        Tones.stopRing()
        IncomingCall.stopRinging(Graph.context, callId)
        set { it.copy(accepting = true, speaker = video) }
        try {
            if (Graph.voice.state.value.roomId != null) Graph.voice.leave()
            Graph.site.freshConfig()
            startMic()
            if (video && !startCamera()) Toasts.error("Couldn't start your camera. Continuing with voice only.")
            // Ended while the microphone started: let it go (it's on, and nothing else would).
            if (s.callId != callId) {
                if (s.idle) cleanup()
                return@launch
            }
            setupPeer(asCaller = false)
            realtime.request("call:accept", buildJsonObject { put("callId", callId); put("video", camera != null) })
            if (s.callId == callId) set { it.copy(phase = "connecting", accepting = false) }
        } catch (e: Exception) {
            realtime.emit("call:decline", buildJsonObject { put("callId", callId) })
            cleanup()
            Toasts.error(e.message ?: "Couldn't answer the call.")
        }
    }

    fun declineCall() {
        s.callId?.let { realtime.emit("call:decline", buildJsonObject { put("callId", it) }) }
        cleanup()
    }

    fun endCall() {
        s.callId?.let { realtime.emit("call:end", buildJsonObject { put("callId", it) }) }
        cleanup()
    }

    fun toggleMute() {
        val muted = !s.muted
        mic?.setEnabled(!muted)
        set { it.copy(muted = muted, localSpeaking = false) }
        s.callId?.let { realtime.emit("call:mute", buildJsonObject { put("callId", it); put("muted", muted) }) }
    }

    fun toggleCamera() {
        if (s.cameraBusy || s.idle || s.phase == "incoming") return
        if (s.cameraOn) return stopCamera()
        set { it.copy(cameraBusy = true) }
        val ok = startCamera()
        set { it.copy(cameraBusy = false) }
        if (ok) {
            emitCamera(true)
            // A camera usually means looking at the screen: the loudspeaker (from the earpiece; a headset stays).
            if (CallService.route.value == com.addakhana.app.data.Output.Earpiece) setSpeaker(true)
        } else {
            Toasts.error("Couldn't start your camera.")
        }
    }

    fun switchCamera() = camera?.switch { front -> set { it.copy(frontCamera = front) } }

    fun setMinimized(minimized: Boolean) = set { it.copy(minimized = minimized) }

    fun setSpeaker(on: Boolean) {
        set { it.copy(speaker = on) }
        CallService.setSpeaker(on)
    }

    /** What the phone actually did (a tablet has no earpiece, say). */
    fun speakerChanged(on: Boolean) = set { it.copy(speaker = on) }

    /** Answered on the phone's call screen: answer once the call reaches the app (it may already have). */
    fun answerFromNotification(callId: String, video: Boolean) {
        if (s.callId == callId && s.phase == "incoming") {
            acceptCall(video)
        } else {
            pendingAnswer = Triple(callId, video, System.currentTimeMillis())
            Graph.realtime.nudge()
        }
    }

    /** Declined on the notification (the server is told separately). */
    fun declinedElsewhere(callId: String) {
        if (pendingAnswer?.first == callId) pendingAnswer = null
        scope.launch { if (s.callId == callId && s.phase == "incoming") cleanup() }
    }

    /** Rings with the phone's own call screen (the app is out of sight). */
    private fun ringNatively() {
        val callId = s.callId ?: return
        val peer = s.peer ?: return
        IncomingCall.ring(
            Graph.context,
            mapOf(
                "callId" to callId,
                "callerId" to peer.id,
                "callerName" to peer.name,
                "callerHue" to peer.hue.toString(),
                "callerPhoto" to peer.photo.orEmpty(),
                "video" to if (s.videoCall) "1" else "0",
                "sentAt" to System.currentTimeMillis().toString(),
            ),
        )
    }

    // ── The server's events ────────────────────────────────────────────

    private fun handle(e: Incoming) {
        val o = e.obj
        when (e.name) {
            "call:incoming" -> onIncoming(o)
            "call:accepted" -> if (o.str("callId") == s.callId) scope.launch { onAccepted(o.bool("video") == true) }
            "call:signal" -> if (o.str("callId") == s.callId) scope.launch { onSignal(o.obj("data") ?: return@launch) }
            "call:peer-mute" -> if (o.str("callId") == s.callId) set { it.copy(peerMuted = o.bool("muted") == true) }
            "call:peer-camera" -> if (o.str("callId") == s.callId) {
                val on = o.bool("on") == true
                set { if (on) it.copy(peerCameraOn = true, videoCall = true) else it.copy(peerCameraOn = false) }
            }
            "call:ended" -> onEnded(o.str("callId"), o.str("reason"))
            "call:dismissed" -> if (o.str("callId") == s.callId && s.phase == "incoming" && !s.accepting) {
                cleanup()
                Toasts.show("You answered on another device.")
            }
            "call:peer-away" -> if (o.str("callId") == s.callId && s.phase != "incoming") waitForLine()
            "call:peer-back" -> if (o.str("callId") == s.callId) {
                // Still working (it can ride out a short drop): nothing to wait for.
                if (pc?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) {
                    lostJob?.cancel()
                    set { it.copy(reconnecting = false) }
                }
                // Their network changed: the caller gives the sound and video a new path.
                lastRepair = System.currentTimeMillis()
                if (role == "caller") scope.launch { restartIce() }
            }
        }
    }

    private fun onIncoming(o: JsonObject) {
        if (!s.idle) return
        val callId = o.str("callId") ?: return
        val from = o.obj("from") ?: return
        val video = o.bool("video") == true
        val peer = Sender(from.str("id") ?: return, from.str("name") ?: "Someone", from.int("hue") ?: 260, from.str("photo"))
        _state.value = CallState(phase = "incoming", callId = callId, peer = peer, videoCall = video, peerCameraOn = video)
        val answered = pendingAnswer?.takeIf { it.first == callId && System.currentTimeMillis() - it.third < ANSWER_VALID_MS }
        pendingAnswer = null
        when {
            answered != null -> acceptCall(answered.second)
            // On screen: ring here (unless the phone's call screen already is).
            AppLifecycle.foreground.value -> if (!IncomingCall.isRinging(Graph.context, callId)) Tones.ring(incoming = true)
            else -> ringNatively()
        }
    }

    private suspend fun onAccepted(video: Boolean) {
        if (s.phase != "outgoing") return
        Tones.stopRing()
        set { it.copy(phase = "connecting", peerCameraOn = video) }
        try {
            val conn = setupPeer(asCaller = true)
            val offer = conn.offer()
            conn.setLocal(offer)
            signal(buildJsonObject { put("sdp", Rtc.sdpJson(Rtc.lean(conn.localDescription ?: offer))) })
        } catch (e: Exception) {
            Toasts.error("Couldn't start the call. Try again.")
            endCall()
        }
    }

    private suspend fun onSignal(data: JsonObject) {
        val conn = pc ?: return
        // The callee's side broke: it asks me (the caller) for a new path.
        if (data.bool("restart") == true) {
            if (role == "caller") {
                lastRepair = System.currentTimeMillis()
                restartIce()
            }
            return
        }
        try {
            val sdp = data.obj("sdp")?.let { Rtc.sdpOf(it) }
            if (sdp != null) {
                conn.setRemote(Rtc.lean(Rtc.startSharp(sdp)))
                queue?.flush()
                if (sdp.type == SessionDescription.Type.OFFER) {
                    // Adopt the caller's video slot and open it for sending, so my camera can join with a track swap.
                    videoTx = conn.videoSlot()?.also { tx ->
                        tx.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                        runCatching { tx.sender.setStreams(listOf(streamId)) }
                        camera?.track?.let { runCatching { tx.sender.setTrack(it, false) } }
                    }
                    val answer = conn.answer()
                    conn.setLocal(answer)
                    signal(buildJsonObject { put("sdp", Rtc.sdpJson(Rtc.lean(conn.localDescription ?: answer))) })
                }
                tuneVideo()
            } else {
                data.obj("candidate")?.let { queue?.add(it) }
            }
        } catch (e: Exception) {
            Log.w(TAG, "signalling failed", e)
        }
    }

    private fun onEnded(callId: String?, reason: String?) {
        if (callId != null) IncomingCall.stopRinging(Graph.context, callId)
        if (callId == null || callId != s.callId) return
        val name = s.peer?.name ?: "They"
        val phase = s.phase
        cleanup()
        when {
            reason == "declined" && phase == "outgoing" -> Toasts.show("$name declined the call.")
            reason == "missed" && phase == "outgoing" -> Toasts.show("$name didn't answer.")
            (reason == "missed" || reason == "cancelled") && phase == "incoming" -> Toasts.show("Missed call from $name.")
            reason == "dropped" -> Toasts.error("Call dropped. $name lost connection.")
            reason == "ended" -> Toasts.show("Call ended.")
        }
    }

    /** Connected again: the call carries on here, and finds its sound and video a new path. */
    private suspend fun onReconnected() {
        val callId = s.callId ?: return
        if (s.idle) return
        try {
            val res = realtime.request("call:resume", buildJsonObject {
                put("callId", callId)
                realtime.previousSid?.let { put("from", it) }
            })
            if (s.callId != callId) return
            if (res.bool("ringing") == true || s.phase == "incoming") {
                lostJob?.cancel()
                set { it.copy(reconnecting = false) }
                return
            }
            // Answered while my connection was down: start connecting now.
            if (s.phase == "outgoing") {
                lostJob?.cancel()
                set { it.copy(reconnecting = false) }
                if (res.bool("answered") == true) onAccepted(res.bool("video") == true)
                return
            }
            if (pc?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) {
                lostJob?.cancel()
                set { it.copy(reconnecting = false) }
            }
            // The network changed, so the sound and video need a new path too.
            lastRepair = System.currentTimeMillis()
            if (role == "caller") restartIce() else signal(buildJsonObject { put("restart", true) })
        } catch (e: Exception) {
            if (s.callId != callId) return
            cleanup()
            Toasts.error(e.message ?: "The call ended.")
        }
    }

    fun signedOut() {
        if (!s.idle) endCall()
    }
}
