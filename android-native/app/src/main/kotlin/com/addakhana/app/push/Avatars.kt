package com.addakhana.app.push

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Looper
import android.util.LruCache
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.drawable.IconCompat
import com.addakhana.app.Graph
import com.addakhana.app.net.appUrl
import okhttp3.Request
import java.io.File
import java.util.Collections
import java.util.Locale

/** Avatars for notifications: someone's profile photo, or initials on a two-tone gradient from their hue. */
object Avatars {
    /** First letters of the first two words. */
    fun initials(name: String?): String {
        val out = StringBuilder()
        var words = 0
        for (w in name.orEmpty().trim().split(Regex("\\s+"))) {
            if (w.isEmpty()) continue
            out.appendCodePoint(w.codePointAt(0))
            if (++words == 2) break
        }
        return if (out.isEmpty()) "?" else out.toString().uppercase(Locale.getDefault())
    }

    fun bitmap(name: String?, hue: Int, size: Int): Bitmap {
        val b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        val from = ColorUtils.HSLToColor(floatArrayOf((hue % 360).toFloat(), 0.78f, 0.62f))
        val to = ColorUtils.HSLToColor(floatArrayOf(((hue + 48) % 360).toFloat(), 0.72f, 0.48f))
        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = LinearGradient(0f, 0f, size.toFloat(), size.toFloat(), from, to, Shader.TileMode.CLAMP) }
        c.drawCircle(size / 2f, size / 2f, size / 2f, bg)
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFFFFFFFF.toInt()
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textSize = size * 0.38f
            textAlign = Paint.Align.CENTER
            setShadowLayer(size * 0.02f, 0f, size * 0.01f, 0x40000000)
        }
        val label = initials(name)
        val bounds = Rect()
        text.getTextBounds(label, 0, label.length, bounds)
        c.drawText(label, size / 2f, size / 2f - bounds.exactCenterY(), text)
        return b
    }

    /** Their photo when there is one, else their initials. */
    fun bitmap(c: Context, name: String?, hue: Int, photo: String?, size: Int): Bitmap = photo(c, photo, size) ?: bitmap(name, hue, size)

    fun icon(c: Context, name: String?, hue: Int, photo: String?): IconCompat = IconCompat.createWithBitmap(bitmap(c, name, hue, photo, 192))

    /** Never waits for a download (a ringing phone mustn't): a kept photo, else initials. */
    fun iconNow(c: Context, name: String?, hue: Int, photo: String?): IconCompat =
        IconCompat.createWithBitmap(photo(c, photo, 192, download = false) ?: bitmap(name, hue, 192))

    private val PHOTO = Regex("/api/(?:users|rooms)/[0-9a-fA-F-]{36}/photo/[0-9a-f]{16}")
    private const val MAX_PHOTO_BYTES = 3 * 1024 * 1024
    private val kept = LruCache<String, Bitmap>(48)
    private val fetching = Collections.synchronizedSet(HashSet<String>())

    /**
     * A profile photo (an address on this app's server) as a circle, or null.
     * Off the main thread it's downloaded (signed in) and kept on the phone;
     * each version has its own address, so a kept one never goes stale.
     */
    fun photo(c: Context, path: String?, size: Int, download: Boolean = true): Bitmap? {
        if (path == null || !PHOTO.matches(path)) return null
        val key = "$path@$size"
        kept.get(key)?.let { return it }
        val file = File(File(c.cacheDir, "photos"), path.replace(Regex("[^0-9a-fA-F]"), "") + ".jpg")
        var bytes: ByteArray? = if (file.isFile) runCatching { file.readBytes() }.getOrNull() else null
        if (bytes == null) {
            if (!download || Looper.myLooper() == Looper.getMainLooper()) {
                prefetch(c, path)
                return null
            }
            bytes = runCatching {
                Graph.http.newCall(Request.Builder().url(appUrl + path).build()).execute().use { res ->
                    if (!res.isSuccessful) return@use null
                    val body = res.body
                    if (body.contentLength() > MAX_PHOTO_BYTES) return@use null
                    body.bytes().takeIf { it.size <= MAX_PHOTO_BYTES }
                }
            }.getOrNull() ?: return null
            file.parentFile?.let { dir -> if (dir.isDirectory || dir.mkdirs()) runCatching { file.writeBytes(bytes) } }
        }
        val b = circle(BitmapFactory.decodeByteArray(bytes, 0, bytes.size), size) ?: return null
        kept.put(key, b)
        return b
    }

    /** Fetches a photo in the background, so it's there next time. */
    fun prefetch(c: Context, path: String?) {
        if (path == null || !PHOTO.matches(path) || !fetching.add(path)) return
        val app = c.applicationContext
        Thread({
            try {
                photo(app, path, 192)
            } finally {
                fetching.remove(path)
            }
        }, "photo").start()
    }

    private fun circle(src: Bitmap?, size: Int): Bitmap? {
        if (src == null) return null
        val side = minOf(src.width, src.height)
        val square = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
        val scaled = Bitmap.createScaledBitmap(square, size, size, true)
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
        Canvas(out).drawCircle(size / 2f, size / 2f, size / 2f, paint)
        return out
    }

    fun hue(value: String?): Int = value?.toIntOrNull() ?: 260
}
