package com.addakhana.app.watch

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A video file's sound on its way into a live stream: copied as the phone's
 * player plays it (16-bit PCM), turned into what WebRTC records (its rate
 * and channels), and handed over 10 ms at a time in place of the
 * microphone's. What waits in between is about the player's own buffer, so
 * the sound stays with the picture; a pause runs it dry (silence), a seek
 * empties it.
 */
@OptIn(UnstableApi::class)
class FileSound : TeeAudioProcessor.AudioBufferSink {
    private val lock = Any()
    private var inRate = 0
    private var inChannels = 0
    private var inEncoding = C.ENCODING_INVALID
    private var outRate = 48_000
    private var outChannels = 1
    /** Up to 2 s of stereo sound at 48 kHz. */
    private val ring = ShortArray(48_000 * 2 * 2)
    private var head = 0
    private var size = 0
    /** Where the next output sample falls between the last input frame and the next (resampling). */
    private var phase = 0.0
    private var prevL = 0f
    private var prevR = 0f
    private var havePrev = false

    override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
        synchronized(lock) {
            inRate = sampleRateHz
            inChannels = channelCount
            inEncoding = encoding
            reset()
        }
    }

    private fun reset() {
        head = 0
        size = 0
        phase = 0.0
        havePrev = false
    }

    override fun handleBuffer(buffer: ByteBuffer) {
        synchronized(lock) {
            if (inEncoding != C.ENCODING_PCM_16BIT || inRate <= 0 || inChannels <= 0) return
            val b = buffer.order(ByteOrder.LITTLE_ENDIAN)
            val start = b.position()
            val frames = b.remaining() / (2 * inChannels)
            val step = inRate.toDouble() / outRate
            for (i in 0 until frames) {
                val at = start + i * 2 * inChannels
                val l = b.getShort(at).toFloat()
                val r = if (inChannels > 1) b.getShort(at + 2).toFloat() else l
                if (havePrev) {
                    while (phase <= 1.0) {
                        push(prevL + (l - prevL) * phase.toFloat(), prevR + (r - prevR) * phase.toFloat())
                        phase += step
                    }
                    phase -= 1.0
                }
                prevL = l
                prevR = r
                havePrev = true
            }
        }
    }

    private fun push(l: Float, r: Float) {
        if (outChannels == 1) put(((l + r) / 2).toInt()) else {
            put(l.toInt())
            put(r.toInt())
        }
    }

    private fun put(v: Int) {
        val sample = v.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        if (size == ring.size) {
            // Nobody is taking it (not sending yet): the oldest goes.
            head = (head + 1) % ring.size
            size--
        }
        ring[(head + size) % ring.size] = sample
        size++
    }

    /** WebRTC's recording, replaced: `bytes` of sound at its rate and channels, from the ring or silence. */
    fun fill(buffer: ByteBuffer, bytes: Int, rate: Int, channels: Int) {
        synchronized(lock) {
            if (rate != outRate || channels != outChannels) {
                outRate = rate
                outChannels = channels
                reset()
            }
            val out = buffer.duplicate().order(ByteOrder.nativeOrder())
            for (i in 0 until bytes / 2) {
                val v: Short = if (size > 0) ring[head].also {
                    head = (head + 1) % ring.size
                    size--
                } else 0
                out.putShort(i * 2, v)
            }
        }
    }
}
