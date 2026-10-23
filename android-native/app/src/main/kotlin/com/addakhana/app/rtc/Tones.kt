package com.addakhana.app.rtc

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.sin

/**
 * The app's own sounds, made here rather than shipped as files, as the web
 * app makes them: room join and leave blips, the ringback a caller hears, and
 * the chirp of a call coming in while the app is open.
 */
object Tones {
    private const val RATE = 24_000
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ringing: Job? = null

    /** Tones (several frequencies at once) from start to start + length seconds, with soft edges. */
    private fun pcm(parts: List<Triple<List<Double>, Double, Double>>, gain: Double): ShortArray {
        val total = parts.maxOf { it.second + it.third }
        val out = ShortArray((total * RATE).toInt() + 1)
        for ((freqs, start, length) in parts) {
            val from = (start * RATE).toInt()
            val n = (length * RATE).toInt()
            for (i in 0 until n) {
                val t = i.toDouble() / RATE
                val edge = minOf(1.0, t / 0.02, (length - t) / 0.05).coerceAtLeast(0.0)
                var v = 0.0
                for (f in freqs) v += sin(2 * PI * f * t)
                val sample = (v / freqs.size) * gain * edge * Short.MAX_VALUE
                val idx = from + i
                if (idx < out.size) out[idx] = (out[idx] + sample).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            }
        }
        return out
    }

    private fun play(samples: ShortArray, signalling: Boolean) {
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(if (signalling) AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING else AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(samples.size * 2)
            .build()
        track.write(samples, 0, samples.size)
        track.play()
        scope.launch {
            delay(samples.size * 1000L / RATE + 200)
            runCatching { track.release() }
        }
    }

    /** Someone came into the room's voice (660 then 880 Hz), or left (520 then 390 Hz). */
    fun blip(join: Boolean) = scope.launch {
        runCatching {
            val (a, b) = if (join) 660.0 to 880.0 else 520.0 to 390.0
            play(pcm(listOf(Triple(listOf(a), 0.0, 0.09), Triple(listOf(b), 0.09, 0.12)), 0.18), signalling = true)
        }
    }

    /** "incoming": a bright double chirp every 1.8 s; "ringback": the tone a caller hears, every 3.5 s. */
    fun ring(incoming: Boolean) {
        stopRing()
        ringing = scope.launch {
            val sound = if (incoming) {
                pcm(listOf(Triple(listOf(880.0, 1320.0), 0.0, 0.18), Triple(listOf(880.0, 1320.0), 0.28, 0.18)), 0.3)
            } else {
                pcm(listOf(Triple(listOf(440.0, 480.0), 0.0, 1.6)), 0.22)
            }
            while (isActive) {
                runCatching { play(sound, signalling = !incoming) }
                delay(if (incoming) 1_800 else 3_500)
            }
        }
    }

    fun stopRing() {
        ringing?.cancel()
        ringing = null
    }
}
