package com.addakhana.app.rtc

import android.media.AudioFormat
import com.addakhana.app.BuildConfig
import com.addakhana.app.Graph
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Debug builds only: a sound file plays in place of the microphone, looped, so
 * calls can be tested where there's no real one (an emulator). Put a 48 kHz
 * mono 16-bit WAV at files/test-mic.wav (`adb shell run-as`); it's read when a
 * call first records after the app starts.
 */
internal object TestMic {
    private var samples: ShortArray? = null
    private var checked = false
    private var at = 0

    /** There's a test sound to play (always false in release builds). */
    fun present(): Boolean {
        if (!BuildConfig.DEBUG) return false
        if (!checked) {
            checked = true
            samples = runCatching {
                val bytes = File(Graph.context.filesDir, "test-mic.wav").readBytes()
                val data = ByteBuffer.wrap(bytes, 44, bytes.size - 44).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                ShortArray(data.remaining()).also { data.get(it) }
            }.getOrNull()?.takeIf { it.isNotEmpty() }
        }
        return samples != null
    }

    /** Writes the next stretch of the test sound over what the microphone recorded. */
    fun fill(buffer: ByteBuffer, format: Int, channels: Int, bytes: Int) {
        if (!present() || format != AudioFormat.ENCODING_PCM_16BIT) return
        val s = samples ?: return
        val out = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        val frames = bytes / 2 / maxOf(1, channels)
        for (i in 0 until frames) {
            val v = s[at]
            at = (at + 1) % s.size
            for (c in 0 until channels) out.putShort((i * channels + c) * 2, v)
        }
    }
}
