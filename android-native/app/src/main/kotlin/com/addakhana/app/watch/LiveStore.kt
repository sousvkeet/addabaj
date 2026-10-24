package com.addakhana.app.watch

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import com.addakhana.app.Graph
import com.addakhana.app.call.CallService
import com.addakhana.app.data.Toasts
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.obj
import com.addakhana.app.net.str
import com.addakhana.app.rtc.CandidateQueue
import com.addakhana.app.rtc.Rtc
import com.addakhana.app.rtc.Rtc.answer
import com.addakhana.app.rtc.Rtc.offer
import com.addakhana.app.rtc.Rtc.setLocal
import com.addakhana.app.rtc.Rtc.setRemote
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.ScreenCapturerAndroid
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.VideoSource
import livekit.org.webrtc.VideoTrack
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.math.abs

/** My live stream: a video file playing on this phone, or my screen. */
data class LiveHost(
    val roomId: String,
    /** Empty until the server has announced it. */
    val sessionId: String = "",
    /** file or screen */
    val mode: String,
    val title: String,
    val audio: Boolean,
    /** Each viewer's connection (by socket): new, connecting, connected… */
    val viewers: Map<String, String> = emptyMap(),
    val playing: Boolean = true,
    val time: Double = 0.0,
    val duration: Double = 0.0,
    val volume: Float = 1f,
    /** My own mute (only for me), not the room's. */
    val muted: Boolean = false,
    /** Why there's no sound, when there isn't. */
    val soundNote: String? = null,
)

/** Someone else's live stream, as I watch it. */
data class LiveViewer(
    val roomId: String,
    val sessionId: String,
    /** connecting, live, retrying or failed */
    val status: String = "connecting",
    val error: String? = null,
    val video: VideoTrack? = null,
    val sound: Boolean = false,
)

data class LiveUi(
    val host: LiveHost? = null,
    /** What viewers get from me, for my preview. */
    val preview: VideoTrack? = null,
    val viewer: LiveViewer? = null,
    /** My own sound of a stream I watch. */
    val muted: Boolean = false,
)

/**
 * Live streams, as the web app's (store/liveStream.ts): a room admin
 * streams a video file playing on their phone, or their screen, to each
 * viewer over its own WebRTC connection. The host always offers; viewers
 * only answer. Signalling goes by socket id, not user id.
 */
@OptIn(UnstableApi::class)
class LiveStore(private val realtime: Realtime, private val scope: CoroutineScope) {
    companion object {
        private const val TAG = "Live"
        /** Each viewer gets its own copy, so keep it sensible for a phone's upload. */
        private const val VIDEO_BITRATE = 2_500_000
        private const val AUDIO_BITRATE = 128_000
        /** Where WebRTC starts before it has measured the connection. */
        private const val START_KBPS = 1200
        /** The picture's longer side, at most (720p). */
        private const val MAX_SIDE = 1280
        private const val SHORT_SIDE = 720

        /** Opus in stereo at music quality, and video that starts sharp rather than blurry. */
        fun tune(sdp: String): String {
            fun addParams(text: String, pt: String, params: Map<String, Any>): String {
                val fmtp = Regex("a=fmtp:$pt ([^\\r\\n]*)")
                val found = fmtp.find(text)
                return if (found != null) {
                    val kept = found.groupValues[1].split(';').filter { it.substringBefore('=').trim() !in params.keys }
                    text.replaceRange(found.range, "a=fmtp:$pt " + (kept + params.map { "${it.key}=${it.value}" }).joinToString(";"))
                } else {
                    // Codecs without parameters (VP8) get a line of their own.
                    val m = Regex("(a=rtpmap:$pt [^\\r\\n]*)(\\r?\\n)").find(text) ?: return text
                    text.replaceRange(m.range, m.groupValues[1] + m.groupValues[2] + "a=fmtp:$pt " + params.map { "${it.key}=${it.value}" }.joinToString(";") + m.groupValues[2])
                }
            }
            var out = sdp
            Regex("a=rtpmap:(\\d+) opus/48000", RegexOption.IGNORE_CASE).find(out)?.groupValues?.get(1)?.let {
                out = addParams(out, it, mapOf("stereo" to 1, "sprop-stereo" to 1, "maxaveragebitrate" to AUDIO_BITRATE))
            }
            for (pt in Regex("a=rtpmap:(\\d+) (?:VP8|VP9|H264|AV1)/90000", RegexOption.IGNORE_CASE).findAll(out).map { it.groupValues[1] }.toList()) {
                out = addParams(out, pt, mapOf("x-google-start-bitrate" to START_KBPS))
            }
            return out
        }
    }

    private val _state = MutableStateFlow(LiveUi())
    val state: StateFlow<LiveUi> = _state.asStateFlow()
    private val s get() = _state.value

    // ── Host ──
    private var exo: ExoPlayer? = null
    private var sound: FileSound? = null
    private var helper: SurfaceTextureHelper? = null
    private var surface: Surface? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var screen: ScreenCapturerAndroid? = null
    private val streamId = "live-" + UUID.randomUUID()
    private val hostPeers = mutableMapOf<String, Pair<PeerConnection, CandidateQueue>>()
    private var hostJobs = mutableListOf<Job>()
    private var reportJob: Job? = null
    /** playing, position, when (elapsed ms). */
    private var lastReport = Triple(false, 0.0, 0L)
    private var roomMuted = false

    // ── Viewer ──
    private var viewerPc: PeerConnection? = null
    private var viewerQueue: CandidateQueue? = null
    private var hostSocket = ""
    private var watchdog: Job? = null
    private var remoteSound: AudioTrack? = null

    init {
        scope.launch { realtime.events.collect { e ->
            val o = e.obj
            when (e.name) {
                "live:viewer" -> onViewer(o.str("roomId"), o.str("viewer"))
                "live:viewer-left" -> if (s.host?.roomId == o.str("roomId")) o.str("viewer")?.let { closeHostPeer(it) }
                "live:signal" -> onSignal(o.str("roomId"), o.str("from"), o.obj("data"))
                "live:ended" -> onEnded(o.str("sessionId"), o.str("reason"))
            }
        } }
        scope.launch { realtime.connects.collect { onReconnected() } }
        // Watching a live stream while its room's video is mine to see (its page, or the small player).
        scope.launch {
            combine(Graph.watch.state.map { it.roomId }.distinctUntilChanged(), Graph.chat.state) { id, chat ->
                val device = id?.let { chat.roomDetails[it]?.watch?.source?.takeIf { s -> s.kind == "device" }?.device }
                if (id != null && device != null && device.hostId != Graph.auth.user?.id) id to device.sessionId else null
            }.distinctUntilChanged().collect { target -> if (target == null) unwatch() else watch(target.first, target.second) }
        }
        // A call or room voice shares WebRTC's one recording: while it runs, the film's
        // sound would replace my voice there, so the stream goes quiet until it ends.
        scope.launch {
            combine(Graph.calls.state, Graph.voice.state) { call, voice -> !call.idle || voice.active }
                .distinctUntilChanged()
                .collect { talking -> if (audioTrack != null) feed(!talking) }
        }
        // An admin muted the room's video for everyone: the host doesn't hear the file either.
        scope.launch {
            combine(_state.map { it.host?.roomId }.distinctUntilChanged(), Graph.chat.state) { id, chat ->
                id != null && chat.roomDetails[id]?.watch?.muted != null
            }.distinctUntilChanged().collect { muted ->
                roomMuted = muted
                applyHostVolume()
            }
        }
        // My sound of a stream I watch: my mute, or the room's.
        scope.launch {
            combine(_state.map { it.muted to it.viewer?.roomId }.distinctUntilChanged(), Graph.chat.state) { (muted, id), chat ->
                muted || (id != null && chat.roomDetails[id]?.watch?.muted != null)
            }.distinctUntilChanged().collect { applyViewerSound() }
        }
    }

    private fun config() = Graph.site.config.value

    // ── Hosting ──────────────────────────────────────────────────────

    /** Streams a video file from this phone: it plays here, and goes live to each viewer with its sound. */
    suspend fun startFile(roomId: String, uri: Uri, title: String) {
        if (s.host != null) stop()
        Graph.site.freshConfig()
        Rtc.ready(Graph.context)
        val app = Graph.context
        // The picture: the player draws into a texture WebRTC sends.
        val helper = SurfaceTextureHelper.create("live-file", Rtc.egl.eglBaseContext)
        val source = Rtc.factory.createVideoSource(false)
        source.adaptOutputFormat(MAX_SIDE, SHORT_SIDE, 30)
        helper.setTextureSize(1280, 720)
        source.capturerObserver.onCapturerStarted(true)
        helper.startListening { frame -> source.capturerObserver.onFrameCaptured(frame) }
        val surface = Surface(helper.surfaceTexture)
        // The sound: copied as it plays, sent in place of the microphone's.
        val sound = FileSound()
        val renderers = object : DefaultRenderersFactory(app) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf(TeeAudioProcessor(sound))).build()
        }
        val player = ExoPlayer.Builder(app, renderers)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), false)
            .build()
        this.helper = helper
        this.videoSource = source
        this.surface = surface
        this.sound = sound
        this.exo = player
        try {
            player.addListener(object : Player.Listener {
                override fun onVideoSizeChanged(videoSize: VideoSize) {
                    if (videoSize.width > 0 && videoSize.height > 0) helper.setTextureSize(videoSize.width, videoSize.height)
                }

                override fun onEvents(player: Player, events: Player.Events) {
                    if (events.containsAny(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_POSITION_DISCONTINUITY, Player.EVENT_PLAYBACK_STATE_CHANGED)) {
                        updateHost()
                        report()
                    }
                }
            })
            player.setVideoSurface(surface)
            player.setMediaItem(MediaItem.fromUri(uri))
            player.prepare()
            val ready = withTimeoutOrNull(15_000) {
                suspendCancellableCoroutine { cont ->
                    val l = object : Player.Listener {
                        override fun onPlaybackStateChanged(state: Int) {
                            if (state == Player.STATE_READY) {
                                player.removeListener(this)
                                if (cont.isActive) cont.resume(true)
                            }
                        }

                        override fun onPlayerError(error: PlaybackException) {
                            player.removeListener(this)
                            if (cont.isActive) cont.resume(false)
                        }
                    }
                    player.addListener(l)
                    cont.invokeOnCancellation { player.removeListener(l) }
                }
            } == true
            if (!ready) throw IllegalStateException("This video can't be played on this phone. MP4 (H.264) files work best.")
            val hasVideo = player.currentTracks.groups.any { it.type == C.TRACK_TYPE_VIDEO && it.isSelected }
            val hasSound = player.currentTracks.groups.any { it.type == C.TRACK_TYPE_AUDIO && it.isSelected }
            if (hasVideo) videoTrack = Rtc.factory.createVideoTrack("live-video-" + UUID.randomUUID(), source)
            // WebRTC sends sound through its recording: it needs the microphone (whose sound is replaced),
            // and can't while room voice or a call uses it.
            val micOk = androidx.core.content.ContextCompat.checkSelfPermission(app, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
            val talking = !Graph.calls.state.value.idle || Graph.voice.state.value.active
            val note = when {
                !hasSound -> "This video has no sound"
                !micOk -> "No sound: allow the microphone for Adda Khana (the video's sound goes out the same way)"
                talking -> "No sound while you're in a call or room voice"
                else -> null
            }
            if (hasSound && note == null) {
                // Plain sound: no echo cancelling, noise suppression or gain on a film.
                val quiet = MediaConstraints().apply {
                    for (k in listOf("googEchoCancellation", "googAutoGainControl", "googNoiseSuppression", "googHighpassFilter")) mandatory.add(MediaConstraints.KeyValuePair(k, "false"))
                }
                audioSource = Rtc.factory.createAudioSource(quiet)
                audioTrack = Rtc.factory.createAudioTrack("live-sound-" + UUID.randomUUID(), audioSource)
                feed(true)
            }
            if (videoTrack == null && audioTrack == null) throw IllegalStateException("This file has nothing to stream.")
            player.play()
            // The file's name; Android's photo picker gives only a number, so then the video's own title.
            val me = Graph.auth.user?.name?.split(' ')?.first() ?: "My"
            val name = title.substringBeforeLast('.').takeIf { n -> n.any { it.isLetter() } }
                ?: player.mediaMetadata.title?.toString()?.takeIf { it.isNotBlank() }
                ?: "$me's video"
            begin(roomId, "file", name, player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 }, note)
        } catch (e: Exception) {
            cleanupHost()
            throw e
        }
    }

    /**
     * Streams my screen (the picture; apps' sound isn't shared). Android asks
     * first; `permission` is its answer. Android also wants a running
     * notification for it, which the call service shows.
     */
    suspend fun startScreen(roomId: String, permission: Intent) {
        if (s.host != null) stop()
        Graph.site.freshConfig()
        Rtc.ready(Graph.context)
        val me = Graph.auth.user?.name?.split(' ')?.first() ?: "My"
        _state.update { it.copy(host = LiveHost(roomId = roomId, mode = "screen", title = "$me's screen", audio = false)) }
        try {
            // The service, with screen capture in its notification, before the capture starts (Android 14).
            withTimeoutOrNull(5_000) { CallService.projecting.first { it } } ?: throw IllegalStateException("Android didn't let the screen be shared.")
            val app = Graph.context
            val helper = SurfaceTextureHelper.create("live-screen", Rtc.egl.eglBaseContext)
            val source = Rtc.factory.createVideoSource(true)
            val capturer = ScreenCapturerAndroid(permission, object : MediaProjection.Callback() {
                // Stopped from Android's own controls.
                override fun onStop() {
                    scope.launch { if (s.host?.mode == "screen") stop() }
                }
            })
            this.helper = helper
            this.videoSource = source
            this.screen = capturer
            capturer.initialize(helper, app, source.capturerObserver)
            val metrics = app.resources.displayMetrics
            val scale = minOf(1.0, MAX_SIDE.toDouble() / maxOf(metrics.widthPixels, metrics.heightPixels))
            capturer.startCapture((metrics.widthPixels * scale).toInt() / 2 * 2, (metrics.heightPixels * scale).toInt() / 2 * 2, 30)
            videoTrack = Rtc.factory.createVideoTrack("live-screen-" + UUID.randomUUID(), source)
            begin(roomId, "screen", "$me's screen", null, null)
        } catch (e: Exception) {
            cleanupHost()
            throw e
        }
    }

    /** Shared setup once there's something to send. */
    private suspend fun begin(roomId: String, mode: String, title: String, duration: Double?, note: String?) {
        val player = exo
        _state.update {
            it.copy(
                host = LiveHost(
                    roomId = roomId,
                    mode = mode,
                    title = title,
                    audio = audioTrack != null,
                    playing = player?.playWhenReady ?: true,
                    time = (player?.currentPosition ?: 0) / 1000.0,
                    duration = duration ?: 0.0,
                    soundNote = note,
                ),
                preview = videoTrack,
            )
        }
        val res = realtime.request("live:start", buildJsonObject {
            put("roomId", roomId)
            put("mode", mode)
            put("title", title)
            if (duration != null) put("duration", duration)
            put("audio", audioTrack != null)
        })
        // Stopped before the server said it started: stop it there too.
        if (s.host?.roomId != roomId) {
            realtime.emit("live:stop", buildJsonObject { put("roomId", roomId) })
            return
        }
        val sessionId = res.str("sessionId").orEmpty()
        _state.update { st -> st.copy(host = st.host?.copy(sessionId = sessionId)) }
        if (player != null) {
            lastReport = Triple(player.playWhenReady, player.currentPosition / 1000.0, SystemClock.elapsedRealtime())
            report()
            hostJobs += scope.launch {
                while (true) {
                    delay(500)
                    updateHost()
                    // Re-anchor viewers' progress bars if playback drifts (buffering, a stall).
                    val (playing, position, at) = lastReport
                    if (playing && abs(player.currentPosition / 1000.0 - (position + (SystemClock.elapsedRealtime() - at) / 1000.0)) > 1.5) report()
                }
            }
        }
        applyHostVolume()
    }

    /** The film's sound into the stream (in place of the microphone's), or the stream quiet. */
    private fun feed(on: Boolean) {
        val sound = sound ?: return
        Rtc.soundFeed = if (on) { buffer, bytes, rate, channels ->
            sound.fill(buffer, bytes, rate, channels)
            true
        } else null
        runCatching { audioTrack?.setEnabled(on) }
        _state.update { st -> st.copy(host = st.host?.copy(soundNote = if (on) null else "No sound while you're in a call or room voice")) }
    }

    private fun updateHost() {
        val player = exo ?: return
        _state.update { st ->
            st.copy(host = st.host?.copy(
                playing = player.playWhenReady && player.playbackState != Player.STATE_ENDED,
                time = player.currentPosition / 1000.0,
                duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 } ?: st.host.duration,
            ))
        }
    }

    /** Tells the room where the file is, so viewers' progress bars follow (bursts coalesced). */
    private fun report() {
        reportJob?.cancel()
        reportJob = scope.launch {
            delay(250)
            val host = s.host ?: return@launch
            val player = exo ?: return@launch
            if (host.sessionId.isEmpty()) return@launch
            val playing = player.playWhenReady && player.playbackState != Player.STATE_ENDED
            lastReport = Triple(playing, player.currentPosition / 1000.0, SystemClock.elapsedRealtime())
            runCatching {
                realtime.request("live:progress", buildJsonObject {
                    put("roomId", host.roomId)
                    put("playing", playing)
                    put("position", lastReport.second)
                })
            }
        }
    }

    private fun applyHostVolume() {
        val player = exo ?: return
        val host = s.host ?: return
        player.volume = if (roomMuted || host.muted) 0f else host.volume
    }

    fun play() = exo?.play()
    fun pause() = exo?.pause()

    fun seek(seconds: Double) {
        val player = exo ?: return
        val end = player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: Long.MAX_VALUE
        player.seekTo((seconds * 1000).toLong().coerceIn(0, end))
    }

    /** Only for me: viewers' sound is theirs. */
    fun setHostMuted(muted: Boolean) {
        _state.update { st -> st.copy(host = st.host?.copy(muted = muted)) }
        applyHostVolume()
    }

    fun setHostVolume(volume: Float) {
        _state.update { st -> st.copy(host = st.host?.copy(volume = volume, muted = volume == 0f)) }
        applyHostVolume()
    }

    suspend fun stop() {
        val host = s.host
        cleanupHost()
        if (host != null) runCatching { realtime.request("live:stop", buildJsonObject { put("roomId", host.roomId) }) }
    }

    private fun closeHostPeer(viewer: String) {
        val (pc, _) = hostPeers.remove(viewer) ?: return
        Rtc.release(pc)
        _state.update { st -> st.copy(host = st.host?.copy(viewers = st.host.viewers - viewer)) }
    }

    private fun cleanupHost() {
        for (id in hostPeers.keys.toList()) closeHostPeer(id)
        hostJobs.forEach { it.cancel() }
        hostJobs.clear()
        reportJob?.cancel()
        Rtc.soundFeed = null
        exo?.release()
        exo = null
        sound = null
        screen?.let { runCatching { it.stopCapture() }; it.dispose() }
        screen = null
        helper?.let { it.stopListening(); it.dispose() }
        helper = null
        surface?.release()
        surface = null
        videoTrack?.dispose()
        videoTrack = null
        videoSource?.dispose()
        videoSource = null
        audioTrack?.dispose()
        audioTrack = null
        audioSource?.dispose()
        audioSource = null
        _state.update { it.copy(host = null, preview = null) }
    }

    /** A viewer asked to watch: a connection of its own, which I offer. */
    private fun onViewer(roomId: String?, viewer: String?) {
        val host = s.host ?: return
        if (roomId != host.roomId || viewer == null) return
        if (videoTrack == null && audioTrack == null) return
        closeHostPeer(viewer)
        lateinit var pc: PeerConnection
        val queue: CandidateQueue
        pc = Rtc.peer(config(), object : Observer() {
            override fun onIceCandidate(candidate: IceCandidate) {
                realtime.emit("live:signal", buildJsonObject {
                    put("roomId", roomId)
                    put("to", viewer)
                    put("data", buildJsonObject { put("candidate", Rtc.candidateJson(candidate)) })
                })
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                scope.launch {
                    if (hostPeers[viewer]?.first !== pc) return@launch
                    _state.update { st -> st.copy(host = st.host?.copy(viewers = st.host.viewers + (viewer to newState.name.lowercase()))) }
                    // A dead link is dropped; the viewer asks again if they're still there.
                    if (newState == PeerConnection.PeerConnectionState.FAILED) closeHostPeer(viewer)
                }
            }
        })
        queue = CandidateQueue(pc)
        hostPeers[viewer] = pc to queue
        videoTrack?.let { track ->
            val t = pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf(streamId)))
            limit(t, VIDEO_BITRATE, 30)
        }
        audioTrack?.let { track ->
            val t = pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf(streamId)))
            limit(t, AUDIO_BITRATE, null)
        }
        _state.update { st -> st.copy(host = st.host?.copy(viewers = st.host.viewers + (viewer to "new"))) }
        scope.launch {
            try {
                val offer = pc.offer()
                val tuned = SessionDescription(offer.type, tune(offer.description))
                pc.setLocal(tuned)
                realtime.emit("live:signal", buildJsonObject {
                    put("roomId", roomId)
                    put("to", viewer)
                    put("data", buildJsonObject { put("sdp", Rtc.sdpJson(pc.localDescription ?: tuned)) })
                })
            } catch (e: Exception) {
                Log.w(TAG, "offer failed", e)
                closeHostPeer(viewer)
            }
        }
    }

    private fun limit(t: RtpTransceiver, bitrate: Int, fps: Int?) {
        runCatching {
            val p = t.sender.parameters
            p.encodings.forEach {
                it.maxBitrateBps = bitrate
                if (fps != null) it.maxFramerate = fps
            }
            t.sender.parameters = p
        }
    }

    // ── Watching ─────────────────────────────────────────────────────

    private fun watch(roomId: String, sessionId: String) {
        val v = s.viewer
        if (v?.sessionId == sessionId && v.status != "failed") return
        closeViewerPeer()
        _state.update { it.copy(viewer = LiveViewer(roomId, sessionId)) }
        request()
    }

    private fun unwatch() {
        val v = s.viewer ?: return
        closeViewerPeer()
        realtime.emit("live:leave", buildJsonObject { put("roomId", v.roomId) })
        _state.update { it.copy(viewer = null) }
    }

    /** Asks the host (through the server) for a fresh connection. */
    private fun request() {
        val v = s.viewer ?: return
        watchdog?.cancel()
        watchdog = scope.launch {
            try {
                Graph.site.freshConfig()
                realtime.request("live:watch", buildJsonObject { put("roomId", v.roomId); put("sessionId", v.sessionId) }, waitForConnection = 10_000)
            } catch (e: Exception) {
                val current = s.viewer
                if (current?.sessionId != v.sessionId) return@launch
                val msg = e.message ?: "Couldn't connect to the stream."
                _state.update { it.copy(viewer = current.copy(status = "failed", error = msg)) }
                // "Full" may clear up: keep trying quietly.
                if (Regex("full", RegexOption.IGNORE_CASE).containsMatchIn(msg)) {
                    delay(15_000)
                    request()
                }
                return@launch
            }
            // No picture within 15 s: ask again.
            delay(15_000)
            val current = s.viewer
            if (current?.sessionId != v.sessionId || current.status == "live") return@launch
            _state.update { it.copy(viewer = current.copy(status = "retrying")) }
            request()
        }
    }

    private fun closeViewerPeer() {
        watchdog?.cancel()
        viewerPc?.let { Rtc.release(it) }
        viewerPc = null
        viewerQueue = null
        hostSocket = ""
        remoteSound = null
        _state.update { st -> st.copy(viewer = st.viewer?.copy(video = null, sound = false)) }
    }

    /** My own sound of the stream (off while the room's video is muted for everyone). */
    private fun applyViewerSound() {
        val track = remoteSound ?: return
        val roomId = s.viewer?.roomId
        val roomMuted = roomId != null && Graph.chat.now.roomDetails[roomId]?.watch?.muted != null
        runCatching { track.setVolume(if (s.muted || roomMuted) 0.0 else 1.0) }
    }

    fun setViewerMuted(muted: Boolean) {
        _state.update { it.copy(muted = muted) }
        applyViewerSound()
    }

    private fun onSignal(roomId: String?, from: String?, data: JsonObject?) {
        if (roomId == null || from == null || data == null) return
        scope.launch {
            try {
                // Answers and candidates from my viewers.
                val peer = if (s.host?.roomId == roomId) hostPeers[from] else null
                if (peer != null) {
                    val sdp = data.obj("sdp")?.let { Rtc.sdpOf(it) }
                    if (sdp?.type == SessionDescription.Type.ANSWER) {
                        peer.first.setRemote(sdp)
                        peer.second.flush()
                    } else data.obj("candidate")?.let { peer.second.add(it) }
                    return@launch
                }
                // An offer or candidates from the host I'm watching.
                val v = s.viewer ?: return@launch
                if (v.roomId != roomId) return@launch
                val sdp = data.obj("sdp")?.let { Rtc.sdpOf(it) }
                if (sdp?.type == SessionDescription.Type.OFFER) receive(roomId, from, sdp)
                else if (from == hostSocket) data.obj("candidate")?.let { viewerQueue?.add(it) }
            } catch (e: Exception) {
                Log.w(TAG, "signalling failed", e)
            }
        }
    }

    private suspend fun receive(roomId: String, from: String, offer: SessionDescription) {
        closeViewerPeer()
        Rtc.ready(Graph.context)
        lateinit var pc: PeerConnection
        pc = Rtc.peer(config(), object : Observer() {
            override fun onIceCandidate(candidate: IceCandidate) {
                realtime.emit("live:signal", buildJsonObject {
                    put("roomId", roomId)
                    put("to", from)
                    put("data", buildJsonObject { put("candidate", Rtc.candidateJson(candidate)) })
                })
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                val track = transceiver.receiver.track() ?: return
                scope.launch {
                    if (viewerPc !== pc) return@launch
                    when (track) {
                        is VideoTrack -> _state.update { st -> st.copy(viewer = st.viewer?.copy(video = track)) }
                        is AudioTrack -> {
                            remoteSound = track
                            applyViewerSound()
                            _state.update { st -> st.copy(viewer = st.viewer?.copy(sound = true)) }
                        }
                    }
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                scope.launch {
                    if (viewerPc !== pc) return@launch
                    val current = s.viewer ?: return@launch
                    when (newState) {
                        PeerConnection.PeerConnectionState.CONNECTED -> {
                            watchdog?.cancel()
                            _state.update { it.copy(viewer = current.copy(status = "live", error = null)) }
                        }
                        PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.DISCONNECTED -> {
                            _state.update { it.copy(viewer = current.copy(status = "retrying")) }
                            // "Disconnected" often heals by itself: give it a moment first.
                            watchdog?.cancel()
                            watchdog = scope.launch {
                                delay(if (newState == PeerConnection.PeerConnectionState.FAILED) 500 else 4_000)
                                if (viewerPc === pc && pc.connectionState() != PeerConnection.PeerConnectionState.CONNECTED) request()
                            }
                        }
                        else -> {}
                    }
                }
            }
        })
        viewerPc = pc
        val queue = CandidateQueue(pc)
        viewerQueue = queue
        hostSocket = from
        // Stuck connecting: ask for a fresh connection.
        watchdog?.cancel()
        watchdog = scope.launch {
            delay(15_000)
            val current = s.viewer ?: return@launch
            if (viewerPc !== pc || pc.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) return@launch
            _state.update { it.copy(viewer = current.copy(status = "retrying")) }
            request()
        }
        pc.setRemote(offer)
        queue.flush()
        val answer = pc.answer()
        val tuned = SessionDescription(answer.type, tune(answer.description))
        pc.setLocal(tuned)
        realtime.emit("live:signal", buildJsonObject {
            put("roomId", roomId)
            put("to", from)
            // Using less data (Settings › Storage and data): the host sends me less picture (the sound stays).
            put("data", buildJsonObject { put("sdp", Rtc.sdpJson(Rtc.lean(pc.localDescription ?: tuned, voice = false, videoKbps = 900))) })
        })
    }

    private fun onEnded(sessionId: String?, reason: String?) {
        val host = s.host
        if (host != null && host.sessionId == sessionId) {
            cleanupHost()
            when (reason) {
                "replaced" -> Toasts.show("Your live stream ended because the video was changed.")
                "stopped" -> Toasts.show("An admin ended your live stream.")
                "lost" -> Toasts.error("Your live stream ended because your connection dropped.")
            }
        }
        if (s.viewer?.sessionId == sessionId) {
            closeViewerPeer()
            _state.update { it.copy(viewer = null) }
        }
    }

    private fun onReconnected() {
        val host = s.host
        if (host != null && host.sessionId.isNotEmpty()) {
            scope.launch {
                runCatching { realtime.request("live:resume", buildJsonObject { put("roomId", host.roomId); put("sessionId", host.sessionId) }) }
                    .onFailure {
                        cleanupHost()
                        Toasts.error(it.message ?: "Your live stream ended.")
                    }
            }
        }
        // The server knows viewers by connection: ask again on the new one.
        val v = s.viewer
        if (v != null) {
            closeViewerPeer()
            _state.update { it.copy(viewer = v.copy(status = "retrying")) }
            request()
        }
    }

    fun signedOut() {
        if (s.host != null) scope.launch { stop() }
        unwatch()
    }

    /** The connection callbacks a live stream doesn't need. */
    private open class Observer : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidate(candidate: IceCandidate) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
    }
}
