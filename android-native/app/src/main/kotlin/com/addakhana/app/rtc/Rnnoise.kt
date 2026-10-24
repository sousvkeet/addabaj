package com.addakhana.app.rtc

import java.nio.ByteBuffer

/** RNNoise, through the app's native library (cpp/noise_jni.c): one canceller per stream of sound. */
internal object Rnnoise {
    /** The library is here (false: none for this phone's processor, and noise cancellation stays off). */
    val loaded: Boolean = runCatching { System.loadLibrary("addanoise") }.isSuccess

    @JvmStatic external fun create(): Long

    @JvmStatic external fun destroy(handle: Long)

    /**
     * Cleans 10 ms in place: [frames] floats on the 16-bit scale, in a direct
     * buffer. Returns how sure it is that someone's speaking (0 to 1), or -1 for
     * a buffer it can't take (left as it was).
     */
    @JvmStatic external fun process(handle: Long, buffer: ByteBuffer, frames: Int): Float
}
