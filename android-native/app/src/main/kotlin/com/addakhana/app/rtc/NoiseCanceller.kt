package com.addakhana.app.rtc

import android.os.Debug
import android.util.Log
import io.livekit.android.audio.AudioProcessorInterface
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import livekit.org.webrtc.ExternalAudioProcessingFactory
import java.nio.ByteBuffer

/**
 * Noise cancellation for calls and room voice, as in Meet or Zoom: RNNoise
 * (xiph.org's neural network noise suppressor, cpp/rnnoise) takes background
 * noise out of the microphone (traffic, typing, fans, a television) and leaves
 * voices.
 *
 * WebRTC hands it each 10 ms of the microphone on its recording thread, after
 * its own processing (the echo canceller), to clean in place. WebRTC has one
 * slot for this, shared by the app's calls (Rtc) and rooms through LiveKit
 * (LiveKitCall), and both put this one in it. Settings › Audio and video turns
 * it off. A phone too slow for it turns it off by itself, rather than let the
 * call's sound break up. A film's sound streaming in watch together (Rtc.soundFeed)
 * is left alone.
 */
object NoiseCanceller : ExternalAudioProcessingFactory.AudioProcessing, AudioProcessorInterface {
    private const val TAG = "NoiseCanceller"
    /** Cleaning 10 ms taking this much processor time on average (half the time there is): too slow. */
    private const val TOO_SLOW_NS = 5_000_000.0

    @Volatile private var on = true
    /** A new start (a new call, a new rate, or turned back on): RNNoise forgets what it heard. */
    @Volatile private var fresh = true
    // The rest belongs to WebRTC's recording thread.
    private var handle = 0L
    private var average = 0.0
    private var frames = 0L

    private val _tooSlow = MutableStateFlow(false)
    /** This phone couldn't keep up, so it's off until the app starts again. */
    val tooSlow: StateFlow<Boolean> = _tooSlow.asStateFlow()

    /** It can run on this phone (its native code is in the app for this processor). */
    val available: Boolean get() = Rnnoise.loaded

    /** On or off (from the setting): from the next 10 ms. */
    fun setOn(value: Boolean) {
        if (value && !on) fresh = true
        on = value
    }

    /** Cleaning now: on, and the microphone it's hearing (not a film's sound streaming in its place, which it would spoil). */
    private val active get() = on && Rnnoise.loaded && !_tooSlow.value && Rtc.soundFeed == null

    // WebRTC's side.

    override fun initialize(sampleRateHz: Int, numChannels: Int) {
        Log.i(TAG, "Microphone at $sampleRateHz Hz, $numChannels channel(s)")
        fresh = true
    }

    override fun reset(newRate: Int) {
        Log.i(TAG, "Microphone now at $newRate Hz")
        fresh = true
    }

    override fun process(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (!active) return
        if (fresh || handle == 0L) {
            if (handle != 0L) Rnnoise.destroy(handle)
            handle = Rnnoise.create()
            fresh = false
            if (handle == 0L) return
        }
        // The processor time it takes (not the time on the clock: the thread waiting its turn isn't RNNoise being slow).
        val start = Debug.threadCpuTimeNanos()
        Rnnoise.process(handle, buffer, numFrames)
        val took = (Debug.threadCpuTimeNanos() - start).toDouble()
        if (start < 0) return
        frames++
        average = if (frames == 1L) took else average * 0.99 + took * 0.01
        if (frames % 3000 == 0L) Log.d(TAG, "${frames / 100} s cleaned, %.2f ms per 10 ms".format(average / 1e6))
        if (frames > 500 && average > TOO_SLOW_NS) {
            Log.w(TAG, "Off: this phone takes %.1f ms to clean 10 ms of sound".format(average / 1e6))
            _tooSlow.value = true
        }
    }

    // LiveKit's side (rooms): the same.

    override fun isEnabled() = active

    override fun getName() = "RNNoise"

    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) = initialize(sampleRateHz, numChannels)

    override fun resetAudioProcessing(newRate: Int) = reset(newRate)

    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) = process(numBands, numFrames, buffer)
}
