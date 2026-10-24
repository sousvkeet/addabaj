package com.addakhana.app.call

import android.content.Context
import android.media.AudioManager
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.VideoQuality
import com.addakhana.app.rtc.Rtc
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.VideoTrack

/**
 * A room's call through LiveKit (when the server has it: ClientConfig.livekit):
 * my microphone and camera go up once, to LiveKit, which passes them on to
 * everyone, each at the size they show it (show). The server's ticket says
 * what I may send (an admin may have muted me, or stopped my camera).
 *
 * The phone's sound stays the app's to route (CallService: earpiece,
 * loudspeaker, Bluetooth), as in one-to-one calls; and pictures draw in the
 * app's own views (ui/call/Stage.kt), so LiveKit's video shares the app's EGL
 * context (through a context of its own, which it may release).
 */
class LiveKitCall(
    context: Context,
    private val scope: CoroutineScope,
    private val events: Events,
) {
    /** What happens in the call, for VoiceStore. */
    interface Events {
        fun video(userId: String, track: VideoTrack?)
        fun here(userId: String, here: Boolean)
        fun speaking(ids: Set<String>)
        fun reconnecting(now: Boolean)
        /** LiveKit's connection is gone: `reason` says why (another device took the seat, the server took me out…). */
        fun gone(reason: DisconnectReason?)
        /** A publish that wasn't allowed (an admin's decision arriving as I joined). */
        fun refused(what: String)
    }

    private val egl: EglBase = EglBase.create(Rtc.egl.eglBaseContext)

    val room: Room = LiveKit.create(
        context.applicationContext,
        options = RoomOptions(
            adaptiveStream = false,
            dynacast = true,
            audioTrackCaptureDefaults = LocalAudioTrackOptions(noiseSuppression = true, echoCancellation = true, autoGainControl = true, highPassFilter = true, typingNoiseDetection = true),
            // Speech quality (24 kbps; LiveKit's default is for music), with redundancy against lost packets.
            audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = 24_000, dtx = true, red = true),
        ),
        overrides = LiveKitOverrides(
            audioOptions = AudioOptions(
                audioHandler = NoAudioHandler(),
                javaAudioDeviceModuleCustomizer = { builder ->
                    // As the app's own calls (rtc/Rtc.kt): the phone's own rate, its echo canceller and noise suppressor.
                    val rate = (context.getSystemService(AudioManager::class.java)
                        ?.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull() ?: 0).takeIf { it >= 16_000 } ?: 48_000
                    builder.setSampleRate(rate).setUseHardwareAcousticEchoCanceler(true).setUseHardwareNoiseSuppressor(true)
                    // LiveKit hands every 10 ms of my microphone to its audio sinks, copied each time; the app has
                    // none, so the copying (a hundred a second, all call long, and the clean-up after) goes.
                    builder.setSamplesReadyCallback(null)
                },
            ),
            eglBase = egl,
        ),
    )

    init {
        // LiveKit's call metrics: it reads the connection's statistics and sends them to the server all call
        // long. Off: that's CPU (and data) the call itself never needed, most of the work out of sight.
        room.enableMetrics = false
    }

    private var listening: Job? = null
    private var camera: LocalVideoTrack? = null
    private var closed = false

    /** The person behind a participant (their user id), from LiveKit's identity. */
    private fun idOf(p: io.livekit.android.room.participant.Participant) = p.identity?.value

    private fun publication(userId: String): RemoteTrackPublication? =
        room.remoteParticipants.values.firstOrNull { idOf(it) == userId }?.getTrackPublication(Track.Source.CAMERA) as? RemoteTrackPublication

    /** Into the call. Throws if LiveKit can't be reached. */
    suspend fun connect(url: String, token: String) {
        listening = scope.launch {
            room.events.events.collect { e ->
                if (closed) return@collect
                when (e) {
                    is RoomEvent.ParticipantConnected -> idOf(e.participant)?.let { events.here(it, true) }
                    is RoomEvent.ParticipantDisconnected -> idOf(e.participant)?.let {
                        events.video(it, null)
                        events.here(it, false)
                    }
                    is RoomEvent.TrackSubscribed -> {
                        val id = idOf(e.participant) ?: return@collect
                        val track = e.track as? io.livekit.android.room.track.VideoTrack ?: return@collect
                        events.video(id, track.rtcTrack)
                    }
                    is RoomEvent.TrackUnsubscribed -> {
                        val id = idOf(e.participant) ?: return@collect
                        if (e.track is io.livekit.android.room.track.VideoTrack) events.video(id, null)
                    }
                    is RoomEvent.ActiveSpeakersChanged -> events.speaking(e.speakers.mapNotNull { idOf(it) }.toSet())
                    is RoomEvent.Reconnecting -> events.reconnecting(true)
                    is RoomEvent.Reconnected -> events.reconnecting(false)
                    is RoomEvent.Disconnected -> events.gone(e.reason)
                    else -> {}
                }
            }
        }
        room.connect(url, token)
        for (p in room.remoteParticipants.values) idOf(p)?.let { events.here(it, true) }
    }

    /** My microphone on (sending) or off (muted). */
    suspend fun mic(on: Boolean) {
        runCatching { room.localParticipant.setMicrophoneEnabled(on) }.onFailure { if (on) events.refused("microphone") }
    }

    /**
     * My camera on: opened and sent (in three sizes, each viewer getting the
     * one they show; less of all of them using less data). Returns its picture
     * for the self view, or null.
     */
    suspend fun cameraOn(front: Boolean, less: Boolean): VideoTrack? {
        cameraOff()
        val lp = room.localParticipant
        val track = lp.createVideoTrack(
            name = "camera",
            options = LocalVideoTrackOptions(
                position = if (front) CameraPosition.FRONT else CameraPosition.BACK,
                captureParams = if (less) VideoCaptureParameter(854, 480, 20) else VideoCaptureParameter(1280, 720, 30),
            ),
        )
        track.startCapture()
        val sent = runCatching {
            lp.publishVideoTrack(
                track,
                VideoTrackPublishOptions(
                    name = "camera",
                    videoEncoding = if (less) VideoEncoding(600_000, 20) else VideoEncoding(1_700_000, 30),
                    simulcast = true,
                    source = Track.Source.CAMERA,
                ),
            )
        }.getOrDefault(false)
        if (!sent) {
            track.stopCapture()
            track.dispose()
            events.refused("camera")
            return null
        }
        camera = track
        return track.rtcTrack
    }

    fun cameraOff() {
        val track = camera ?: return
        camera = null
        runCatching { room.localParticipant.unpublishTrack(track) }
        runCatching { track.stopCapture() }
        runCatching { track.dispose() }
    }

    fun switchCamera(front: Boolean) {
        camera?.switchCamera(position = if (front) CameraPosition.FRONT else CameraPosition.BACK)
    }

    /** Someone's camera at the size I show it (not at all: not sent to me). */
    fun show(userId: String, view: View) {
        val pub = publication(userId) ?: return
        pub.setEnabled(view != View.Hidden)
        if (view != View.Hidden) {
            pub.setVideoQuality(
                when (view) {
                    View.Large -> VideoQuality.HIGH
                    View.Medium -> VideoQuality.MEDIUM
                    else -> VideoQuality.LOW
                },
            )
        }
    }

    /** Everyone in the call with me now. */
    fun others(): List<String> = room.remoteParticipants.values.mapNotNull { idOf(it) }

    val connected get() = room.state == Room.State.CONNECTED
    val disconnected get() = room.state == Room.State.DISCONNECTED

    /** Out of the call, for good (this object is done). */
    fun close() {
        if (closed) return
        closed = true
        listening?.cancel()
        cameraOff()
        runCatching { room.disconnect() }
        runCatching { room.release() }
        runCatching { egl.release() }
    }
}
