package com.addakhana.app.rtc

import android.content.Context
import com.addakhana.app.BuildConfig
import com.addakhana.app.Graph
import com.addakhana.app.model.ClientConfig
import com.addakhana.app.net.int
import com.addakhana.app.net.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.Camera2Enumerator
import livekit.org.webrtc.CameraVideoCapturer
import livekit.org.webrtc.DefaultVideoDecoderFactory
import livekit.org.webrtc.DefaultVideoEncoderFactory
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.ExternalAudioProcessingFactory
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStreamTrack
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RTCStatsReport
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.VideoSource
import livekit.org.webrtc.VideoTrack
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * WebRTC for calls and room voice, natively (Google's libwebrtc): the same
 * calls as the web app's, so phones, the WebView app and browsers all talk.
 * Sound plays and records through the phone's call audio (echo cancelling
 * and noise suppression in hardware where the phone has them).
 */
object Rtc {
    lateinit var egl: EglBase
        private set
    lateinit var factory: PeerConnectionFactory
        private set
    private lateinit var adm: JavaAudioDeviceModule
    private lateinit var app: Context

    /**
     * Sound to send in place of the microphone's (a video file streaming
     * live): fills the buffer just recorded (16-bit PCM at the given rate
     * and channels) and says whether it did. Called on WebRTC's recording thread.
     */
    @Volatile
    var soundFeed: ((buffer: java.nio.ByteBuffer, bytes: Int, rate: Int, channels: Int) -> Boolean)? = null

    /**
     * Starts WebRTC away from the main thread: the first time it loads its
     * code and starts its threads, which takes a moment (seconds on a slow
     * phone, which would freeze the screen and show "isn't responding").
     */
    suspend fun ready(context: Context) {
        if (!::factory.isInitialized) withContext(Dispatchers.Default) { init(context) }
    }

    /** The microphone, made away from the main thread (it waits for WebRTC's own threads). */
    suspend fun openMicrophone(): Pair<AudioSource, AudioTrack> = withContext(Dispatchers.Default) { microphone() }

    @Synchronized
    fun init(context: Context) {
        if (::factory.isInitialized) return
        app = context.applicationContext
        // Noise cancellation's native code, loaded here rather than on the first call's sound thread.
        if (!Rnnoise.loaded) android.util.Log.w("Rtc", "No noise cancellation on this phone")
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
        egl = EglBase.create()
        // The phone's own rate (WebRTC can fall back to 8 kHz, which some phones refuse to record at).
        val rate = (app.getSystemService(android.media.AudioManager::class.java)
            ?.getProperty(android.media.AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull() ?: 0)
            .takeIf { it >= 16_000 } ?: 48_000
        adm = JavaAudioDeviceModule.builder(app)
            .setSampleRate(rate)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .setAudioBufferCallback { buffer, format, channels, rate, bytes, captureTimeNs ->
                if (BuildConfig.DEBUG) TestMic.fill(buffer, format, channels, bytes)
                if (format == android.media.AudioFormat.ENCODING_PCM_16BIT) soundFeed?.invoke(buffer, bytes, rate, channels)
                captureTimeNs
            }
            .createAudioDeviceModule()
        // Noise cancellation (NoiseCanceller), after WebRTC's own processing; it goes in once the factory exists.
        val processing = ExternalAudioProcessingFactory()
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setAudioProcessingFactory(processing)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        runCatching { processing.setCapturePostProcessing(NoiseCanceller) }
    }

    // ── Connections ────────────────────────────────────────────────────

    private val FALLBACK = listOf(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer())

    /** The server's call servers (STUN, and TURN with a password that lasts a day). */
    fun iceServers(config: ClientConfig): List<PeerConnection.IceServer> {
        val list = config.iceServers.mapNotNull { s ->
            val urls = when (val u = s.urls) {
                is JsonArray -> u.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                is JsonPrimitive -> listOfNotNull(u.contentOrNull)
                else -> emptyList()
            }
            if (urls.isEmpty()) return@mapNotNull null
            PeerConnection.IceServer.builder(urls).apply {
                s.username?.let { setUsername(it) }
                s.credential?.let { setPassword(it) }
            }.createIceServer()
        }
        return list.ifEmpty { FALLBACK }
    }

    fun peer(config: ClientConfig, observer: PeerConnection.Observer): PeerConnection {
        val rtc = PeerConnection.RTCConfiguration(iceServers(config)).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            iceTransportsType = if (config.iceTransportPolicy == "relay") PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
            // Keeps finding paths as networks change (Wi-Fi to mobile data), so a repair finds one fast.
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        return factory.createPeerConnection(rtc, observer) ?: throw IllegalStateException("Couldn't start a call connection.")
    }

    private open class Sdp(val onCreate: (SessionDescription) -> Unit = {}, val onSet: () -> Unit = {}, val onFail: (String) -> Unit) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) = onCreate(sdp)
        override fun onSetSuccess() = onSet()
        override fun onCreateFailure(error: String?) = onFail(error ?: "failed")
        override fun onSetFailure(error: String?) = onFail(error ?: "failed")
    }

    suspend fun PeerConnection.offer(): SessionDescription = suspendCancellableCoroutine { cont ->
        createOffer(Sdp(onCreate = { cont.resume(it) }, onFail = { cont.resumeWithException(IllegalStateException("Offer failed: $it")) }), MediaConstraints())
    }

    suspend fun PeerConnection.answer(): SessionDescription = suspendCancellableCoroutine { cont ->
        createAnswer(Sdp(onCreate = { cont.resume(it) }, onFail = { cont.resumeWithException(IllegalStateException("Answer failed: $it")) }), MediaConstraints())
    }

    suspend fun PeerConnection.setLocal(sdp: SessionDescription): Unit = suspendCancellableCoroutine { cont ->
        setLocalDescription(Sdp(onSet = { cont.resume(Unit) }, onFail = { cont.resumeWithException(IllegalStateException("Local description failed: $it")) }), sdp)
    }

    suspend fun PeerConnection.setRemote(sdp: SessionDescription): Unit = suspendCancellableCoroutine { cont ->
        setRemoteDescription(Sdp(onSet = { cont.resume(Unit) }, onFail = { cont.resumeWithException(IllegalStateException("Remote description failed: $it")) }), sdp)
    }

    suspend fun PeerConnection.stats(): RTCStatsReport = suspendCancellableCoroutine { cont -> getStats { cont.resume(it) } }

    /**
     * Ends a connection now, and frees it a minute later. Something may still
     * be negotiating on it (an offer being made, a description being set):
     * a closed connection just tells it so, but a freed one crashes the app.
     */
    fun release(pc: PeerConnection) {
        runCatching { pc.close() }
        Graph.scope.launch(Dispatchers.IO) {
            delay(60_000)
            runCatching { pc.dispose() }
        }
    }

    /** The video slot (the offerer makes it; the answerer adopts it from the offer). */
    fun PeerConnection.videoSlot(): RtpTransceiver? = transceivers.firstOrNull { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }

    fun PeerConnection.addVideoSlot(streamId: String): RtpTransceiver =
        addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, listOf(streamId)))

    // ── Descriptions and candidates, as the web app sends them ─────────

    fun sdpJson(sdp: SessionDescription) = buildJsonObject {
        put("type", sdp.type.canonicalForm())
        put("sdp", sdp.description)
    }

    fun sdpOf(o: JsonObject): SessionDescription? {
        val type = when (o.str("type")) {
            "offer" -> SessionDescription.Type.OFFER
            "answer" -> SessionDescription.Type.ANSWER
            "pranswer" -> SessionDescription.Type.PRANSWER
            else -> return null
        }
        return SessionDescription(type, o.str("sdp") ?: return null)
    }

    private val UFRAG = Regex("""\bufrag (\S+)""")

    fun candidateJson(c: IceCandidate) = buildJsonObject {
        put("candidate", c.sdp)
        put("sdpMid", c.sdpMid)
        put("sdpMLineIndex", c.sdpMLineIndex)
        UFRAG.find(c.sdp)?.groupValues?.get(1)?.let { put("usernameFragment", it) }
    }

    fun candidateOf(o: JsonObject): IceCandidate? {
        val sdp = o.str("candidate")?.takeIf { it.isNotEmpty() } ?: return null
        return IceCandidate(o.str("sdpMid") ?: "0", o.int("sdpMLineIndex") ?: 0, sdp)
    }

    fun ufragOf(o: JsonObject): String? = o.str("usernameFragment") ?: o.str("candidate")?.let { UFRAG.find(it)?.groupValues?.get(1) }

    /** Video starts from this (kbps), not WebRTC's cautious default: a sharp picture in the first seconds. */
    private const val START_KBPS = 1200

    /**
     * The other side's description, asking to start sending video at a
     * usable quality (x-google-start-bitrate on the video codecs; VP8 has no
     * parameters, so it gets a line of its own). As the web app does.
     */
    fun startSharp(desc: SessionDescription): SessionDescription {
        val sdp = desc.description
        if (!sdp.contains("m=video")) return desc
        val sections = sdp.split(Regex("\r\n(?=m=)")).map { section ->
            if (!section.startsWith("m=video")) return@map section
            val lines = section.split("\r\n")
            val video = lines.mapNotNull { Regex("""^a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)/""", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1) }.toSet()
            val tuned = mutableSetOf<String>()
            val out = lines.map { line ->
                val pt = Regex("""^a=fmtp:(\d+) """).find(line)?.groupValues?.get(1)
                if (pt != null && pt in video) {
                    tuned += pt
                    if (line.contains("x-google-start-bitrate")) line else "$line;x-google-start-bitrate=$START_KBPS"
                } else {
                    line
                }
            }
            out.flatMap { line ->
                val pt = Regex("""^a=rtpmap:(\d+) """).find(line)?.groupValues?.get(1)
                if (pt != null && pt in video && pt !in tuned) listOf(line, "a=fmtp:$pt x-google-start-bitrate=$START_KBPS") else listOf(line)
            }.joinToString("\r\n")
        }
        return SessionDescription(desc.type, sections.joinToString("\r\n"))
    }

    /**
     * Less data, as WhatsApp's calls: a voice sends next to nothing while
     * nobody speaks (Opus DTX), always. While calls use less data (Settings ›
     * Storage and data), the voice is capped at 20 kbit/s and video at
     * `videoKbps`. Set on the other side's description it shapes what this
     * phone sends; on this phone's own, before it's sent, what the other
     * side sends here (browsers follow both). `voice` false: a film's sound
     * (a live stream), which is left as it is.
     */
    fun lean(desc: SessionDescription, voice: Boolean = true, videoKbps: Int = 500, less: Boolean = com.addakhana.app.data.DataUse.lessForCalls()): SessionDescription {
        if (!voice && !less) return desc
        val sections = desc.description.split(Regex("\r\n(?=m=)")).map { section ->
            when {
                voice && section.startsWith("m=audio") -> {
                    val opus = Regex("""a=rtpmap:(\d+) opus/48000""", RegexOption.IGNORE_CASE).find(section)?.groupValues?.get(1) ?: return@map section
                    val params = mutableMapOf("usedtx" to "1")
                    if (less) params["maxaveragebitrate"] = "20000"
                    val fmtp = Regex("""a=fmtp:$opus ([^\r\n]*)""").find(section)
                    if (fmtp != null) {
                        val kept = fmtp.groupValues[1].split(';').filter { it.substringBefore('=').trim() !in params.keys }
                        section.replaceRange(fmtp.range, "a=fmtp:$opus " + (kept + params.map { "${it.key}=${it.value}" }).joinToString(";"))
                    } else {
                        val rtpmap = Regex("""a=rtpmap:$opus [^\r\n]*""").find(section) ?: return@map section
                        section.replaceRange(rtpmap.range, rtpmap.value + "\r\na=fmtp:$opus " + params.map { "${it.key}=${it.value}" }.joinToString(";"))
                    }
                }
                less && section.startsWith("m=video") -> {
                    // A bandwidth line goes after the connection line (one replaces any there).
                    val lines = section.split("\r\n").filterNot { it.startsWith("b=AS:") || it.startsWith("b=TIAS:") }.toMutableList()
                    val at = lines.indexOfFirst { it.startsWith("c=") }
                    lines.add(if (at >= 0) at + 1 else 1, "b=AS:$videoKbps")
                    lines.joinToString("\r\n")
                }
                else -> section
            }
        }
        return SessionDescription(desc.type, sections.joinToString("\r\n"))
    }

    // ── Microphone and camera ──────────────────────────────────────────

    /** The microphone, with the phone's call processing (echo cancelling, noise suppression, gain). */
    fun microphone(): Pair<AudioSource, AudioTrack> {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
        }
        val source = factory.createAudioSource(constraints)
        val track = factory.createAudioTrack("mic-" + UUID.randomUUID(), source)
        return source to track
    }

    fun newStreamId() = UUID.randomUUID().toString()

    /** A camera sending 720p at 30 frames a second, or null when the phone has none. */
    class Camera private constructor(
        private val capturer: CameraVideoCapturer,
        private val helper: SurfaceTextureHelper,
        private val source: VideoSource,
        val track: VideoTrack,
        var front: Boolean,
    ) {
        val canSwitch: Boolean get() = Camera2Enumerator(app).deviceNames.size > 1

        fun switch(done: (Boolean) -> Unit = {}) {
            capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
                override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                    front = isFrontCamera
                    done(isFrontCamera)
                }

                override fun onCameraSwitchError(errorDescription: String?) {}
            })
        }

        fun stop() {
            runCatching { capturer.stopCapture() }
            capturer.dispose()
            helper.dispose()
            track.dispose()
            source.dispose()
        }

        companion object {
            /** `front`: the front camera if there is one (else the back), or the other way round. */
            fun open(front: Boolean = true, onEnded: () -> Unit = {}): Camera? {
                val enumerator = Camera2Enumerator(app)
                val names = enumerator.deviceNames
                val name = names.firstOrNull { enumerator.isFrontFacing(it) == front } ?: names.firstOrNull() ?: return null
                val capturer = enumerator.createCapturer(name, object : CameraVideoCapturer.CameraEventsHandler {
                    override fun onCameraError(errorDescription: String?) = onEnded()
                    override fun onCameraDisconnected() = onEnded()
                    override fun onCameraFreezed(errorDescription: String?) {}
                    override fun onCameraOpening(cameraName: String?) {}
                    override fun onFirstFrameAvailable() {}
                    override fun onCameraClosed() {}
                }) ?: return null
                val helper = SurfaceTextureHelper.create("camera", egl.eglBaseContext)
                val source = factory.createVideoSource(false)
                capturer.initialize(helper, app, source.capturerObserver)
                capturer.startCapture(1280, 720, 30)
                val track = factory.createVideoTrack("cam-" + UUID.randomUUID(), source)
                return Camera(capturer, helper, source, track, enumerator.isFrontFacing(name))
            }
        }
    }

    /** Audio level (0–1) of the sound arriving from the other side, from the connection's stats. */
    fun RTCStatsReport.incomingAudioLevel(): Double? =
        statsMap.values.firstOrNull { it.type == "inbound-rtp" && it.members["kind"] == "audio" }?.members?.get("audioLevel")?.let { (it as? Number)?.toDouble() }

    fun RTCStatsReport.incomingAudioBytes(): Long? =
        statsMap.values.firstOrNull { it.type == "inbound-rtp" && it.members["kind"] == "audio" }?.members?.get("bytesReceived")?.let { (it as? Number)?.toLong() }

    /** My microphone's level (0–1), from a connection's stats. */
    fun RTCStatsReport.localAudioLevel(): Double? =
        statsMap.values.firstOrNull { it.type == "media-source" && it.members["kind"] == "audio" }?.members?.get("audioLevel")?.let { (it as? Number)?.toDouble() }
}

/**
 * Holds ICE candidates that arrive before their description is set: the
 * first one, or an ICE restart's (told apart by their ICE username).
 */
class CandidateQueue(private val pc: PeerConnection) {
    private val queue = ArrayDeque<JsonObject>()

    private fun remoteUfrag(): String? = pc.remoteDescription?.description?.let { Regex("""a=ice-ufrag:(\S+)""").find(it)?.groupValues?.get(1) }

    private fun early(c: JsonObject): Boolean {
        if (pc.remoteDescription == null) return true
        val theirs = Rtc.ufragOf(c)
        val now = remoteUfrag()
        return theirs != null && now != null && theirs != now
    }

    fun add(c: JsonObject) {
        if (early(c)) {
            queue.addLast(c)
            if (queue.size > 60) queue.removeFirst()
        } else {
            Rtc.candidateOf(c)?.let { pc.addIceCandidate(it) }
        }
    }

    /** After a new description from the other side: whatever was waiting for it. */
    fun flush() {
        val items = queue.toList()
        queue.clear()
        for (c in items) if (early(c)) queue.addLast(c) else Rtc.candidateOf(c)?.let { pc.addIceCandidate(it) }
    }
}
