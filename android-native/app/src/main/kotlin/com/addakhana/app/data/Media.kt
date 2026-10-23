package com.addakhana.app.data

import android.app.DownloadManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.addakhana.app.Graph
import com.addakhana.app.model.Attachment
import com.addakhana.app.model.LocalFile
import com.addakhana.app.net.appUrl
import com.addakhana.app.net.await
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.UUID

/** Files: fetched signed in and kept for a while, saved to Downloads, picked to send, recorded. */
object Media {
    private fun hash(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    /** A small copy the server makes of a sent photo, or a video's picture (server/src/services/thumbs.js). */
    fun thumb(path: String, size: Int) = "$path?thumb=$size"

    /** A server file already on this phone, or null. */
    fun cachedFile(context: Context, path: String): File? = File(File(context.cacheDir, "media"), hash(path)).takeIf { it.isFile && it.length() > 0 }

    /**
     * A file just sent, kept as the server's copy: it shows, opens and plays
     * from the phone without downloading it back, and Settings › Storage and
     * data › Clear removes it like anything downloaded.
     */
    fun keep(context: Context, sent: File, path: String) {
        if (!sent.isFile) return
        val dir = File(context.cacheDir, "media").apply { mkdirs() }
        val file = File(dir, hash(path))
        if (!sent.renameTo(file)) {
            runCatching { sent.copyTo(file, overwrite = true) }
            sent.delete()
        }
    }

    private val fetching = java.util.Collections.synchronizedSet(HashSet<String>())
    /** Two downloads at a time, so a chat full of voice messages doesn't crowd out what's on screen. */
    private val fetchSlots = kotlinx.coroutines.sync.Semaphore(2)

    /** Downloads it ahead (a voice message or a video, where Settings › Storage and data allows), so it plays at once. */
    fun prefetch(context: Context, path: String) {
        if (cachedFile(context, path) != null || !fetching.add(path)) return
        Graph.scope.launch(Dispatchers.IO) {
            try {
                fetchSlots.acquire()
                try {
                    runCatching { cached(context, path) }
                } finally {
                    fetchSlots.release()
                }
            } finally {
                fetching.remove(path)
            }
        }
    }

    /** A server file on this phone (fetched with the login cookie, kept in the cache). */
    suspend fun cached(context: Context, path: String): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "media").apply { mkdirs() }
        val file = File(dir, hash(path))
        if (file.isFile && file.length() > 0) return@withContext file
        val full = if (path.startsWith("http")) path else appUrl + path
        Graph.http.newCall(Request.Builder().url(full).build()).await().use { res ->
            if (!res.isSuccessful) throw java.io.IOException("Couldn't load it (${res.code}).")
            val tmp = File(dir, file.name + ".part")
            res.body.byteStream().use { input -> FileOutputStream(tmp).use { input.copyTo(it) } }
            tmp.renameTo(file)
        }
        file
    }

    /** Saves a file to the phone's Downloads (signed in), as the WebView app did. */
    fun download(context: Context, a: Attachment) {
        val dm = context.getSystemService(DownloadManager::class.java) ?: return
        val name = a.name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "file" }
        val request = DownloadManager.Request(Uri.parse("$appUrl${a.url}?download=1"))
            .setTitle(name)
            .setMimeType(a.mime.ifBlank { null })
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        Graph.cookies.header()?.let { request.addRequestHeader("Cookie", it) }
        request.addRequestHeader("User-Agent", com.addakhana.app.net.userAgent)
        runCatching { dm.enqueue(request) }
            .onSuccess { Toasts.show("Downloading $name") }
            .onFailure { Toasts.error("This file can't be downloaded.") }
    }

    // ── Sending at standard quality ────────────────────────────────────

    /** A video sent at standard quality: 720p (its short side) at about 2 Mbit/s, as WhatsApp sends them. */
    private const val VIDEO_SHORT_SIDE = 720
    private const val VIDEO_BITRATE = 2_000_000

    /**
     * A video re-encoded smaller (H.264 and AAC in MP4), `shrink` to 720p too.
     * False when the phone can't: then the original goes as it is.
     */
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private suspend fun compress(context: Context, input: File, output: File, shrink: Boolean, onProgress: (Int) -> Unit): Boolean = withContext(Dispatchers.Main) {
        val done = kotlinx.coroutines.CompletableDeferred<Boolean>()
        val transformer = androidx.media3.transformer.Transformer.Builder(context)
            .setVideoMimeType(androidx.media3.common.MimeTypes.VIDEO_H264)
            .setAudioMimeType(androidx.media3.common.MimeTypes.AUDIO_AAC)
            .setEncoderFactory(
                androidx.media3.transformer.DefaultEncoderFactory.Builder(context)
                    .setRequestedVideoEncoderSettings(androidx.media3.transformer.VideoEncoderSettings.Builder().setBitrate(VIDEO_BITRATE).build())
                    .setEnableFallback(true)
                    .build(),
            )
            .addListener(object : androidx.media3.transformer.Transformer.Listener {
                override fun onCompleted(composition: androidx.media3.transformer.Composition, exportResult: androidx.media3.transformer.ExportResult) {
                    done.complete(true)
                }

                override fun onError(composition: androidx.media3.transformer.Composition, exportResult: androidx.media3.transformer.ExportResult, exportException: androidx.media3.transformer.ExportException) {
                    done.complete(false)
                }
            })
            .build()
        val effects = if (shrink) listOf<androidx.media3.common.Effect>(androidx.media3.effect.Presentation.createForShortSide(VIDEO_SHORT_SIDE)) else emptyList()
        val item = androidx.media3.transformer.EditedMediaItem.Builder(androidx.media3.common.MediaItem.fromUri(Uri.fromFile(input)))
            .setEffects(androidx.media3.transformer.Effects(emptyList(), effects))
            .build()
        val progress = launch {
            val holder = androidx.media3.transformer.ProgressHolder()
            while (isActive) {
                if (transformer.getProgress(holder) == androidx.media3.transformer.Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress)
                delay(400)
            }
        }
        try {
            transformer.start(item, output.path)
            done.await()
        } catch (e: kotlinx.coroutines.CancellationException) {
            transformer.cancel()
            throw e
        } catch (_: Exception) {
            false
        } finally {
            progress.cancel()
        }
    }

    // ── Picking files to send ──────────────────────────────────────────

    /**
     * A picked file, copied into the app's own space (so it can be sent, or
     * sent again after a restart), with what the server wants to know. Photos
     * and videos go at the quality chosen in Settings › Storage and data:
     * standard (photos at most 1600 px, videos 720p), or HD (photos up to
     * 4096 px, videos as they are, unless too big to send). `onProgress`: a
     * video being made smaller, in percent.
     */
    suspend fun prepare(context: Context, uri: Uri, onProgress: (Int) -> Unit = {}): LocalFile = withContext(Dispatchers.IO) {
        val cr = context.contentResolver
        val mime = cr.getType(uri) ?: "application/octet-stream"
        var name = cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
            ?: ("file." + (MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "bin"))
        val dir = File(context.filesDir, "outbox").apply { mkdirs() }
        val out = File(dir, UUID.randomUUID().toString())
        cr.openInputStream(uri)?.use { input -> FileOutputStream(out).use { input.copyTo(it) } } ?: throw java.io.IOException("Couldn't read that file.")
        val limit = Graph.site.config.value.limits.uploadMaxBytes
        when {
            mime.startsWith("image/") && mime != "image/gif" -> {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(out.path, bounds)
                var w = bounds.outWidth
                var h = bounds.outHeight
                val rotation = runCatching { androidx.exifinterface.media.ExifInterface(out.path).rotationDegrees }.getOrDefault(0)
                var finalMime = mime
                val hd = DataUse.photos.value == UploadQuality.HD
                val side = if (hd) 4096 else 1600
                if (maxOf(w, h) > side || out.length() > (if (hd) 12_000_000 else 500_000) || rotation != 0) {
                    var sample = 1
                    while (maxOf(w, h) / (sample * 2) >= side) sample *= 2
                    var bmp = BitmapFactory.decodeFile(out.path, BitmapFactory.Options().apply { inSampleSize = sample })
                    if (bmp != null) {
                        if (rotation != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
                        val scale = minOf(1f, side.toFloat() / maxOf(bmp.width, bmp.height))
                        if (scale < 1f) bmp = Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
                        val jpeg = mime == "image/jpeg" || mime == "image/jpg"
                        finalMime = if (jpeg) "image/jpeg" else "image/webp"
                        @Suppress("DEPRECATION")
                        val format = if (jpeg) Bitmap.CompressFormat.JPEG else if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
                        FileOutputStream(out).use { bmp.compress(format, if (hd) 92 else 80, it) }
                        w = bmp.width
                        h = bmp.height
                        if (!jpeg) name = name.substringBeforeLast('.') + ".webp"
                    }
                }
                LocalFile(out.path, "image", name, finalMime, w, h)
            }
            mime == "image/gif" -> {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(out.path, bounds)
                LocalFile(out.path, "image", name, mime, bounds.outWidth, bounds.outHeight)
            }
            mime.startsWith("video/") -> {
                fun info(f: File): Triple<Int?, Int?, Double?>? {
                    val r = MediaMetadataRetriever()
                    return try {
                        r.setDataSource(f.path)
                        val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
                        val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
                        val rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                        val ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
                        if (rot == 90 || rot == 270) Triple(h, w, ms?.div(1000.0)) else Triple(w, h, ms?.div(1000.0))
                    } catch (_: Exception) {
                        null
                    } finally {
                        runCatching { r.release() }
                    }
                }
                val first = info(out)
                if (first == null) LocalFile(out.path, "file", name, mime)
                else {
                    val (w, h, seconds) = first
                    // Standard quality: bigger than 720p, or more than about 2.5 Mbit/s, is made smaller;
                    // HD: only what's too big to send.
                    val shortSide = minOf(w ?: 0, h ?: 0)
                    val rate = if ((seconds ?: 0.0) > 0) out.length() * 8 / seconds!! else 0.0
                    val standard = DataUse.videos.value == UploadQuality.Standard
                    var sent = LocalFile(out.path, "video", name, mime, w, h, seconds)
                    if ((standard && (shortSide > VIDEO_SHORT_SIDE || rate > VIDEO_BITRATE * 1.25)) || out.length() > limit) {
                        val smaller = File(dir, UUID.randomUUID().toString())
                        if (compress(context, out, smaller, shrink = shortSide > VIDEO_SHORT_SIDE, onProgress) && smaller.length() in 1 until out.length()) {
                            out.delete()
                            val (sw, sh, ss) = info(smaller) ?: first
                            sent = LocalFile(smaller.path, "video", name.substringBeforeLast('.') + ".mp4", "video/mp4", sw, sh, ss)
                        } else smaller.delete()
                    }
                    sent
                }
            }
            else -> LocalFile(out.path, "file", name, mime)
        }.also {
            if (File(it.path).length() > limit) {
                val mb = File(it.path).length() / (1024 * 1024)
                File(it.path).delete()
                throw java.io.IOException("“${it.name}” is $mb MB. Files can be up to ${limit / (1024 * 1024)} MB.")
            }
        }
    }
}

/** One voice message playing at a time: its position, length and speed (1×, 1.5×, 2×). */
object VoicePlayer {
    data class State(val id: String? = null, val playing: Boolean = false, val position: Long = 0, val duration: Long = 0, val speed: Float = 1f, val loading: Boolean = false)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private var player: MediaPlayer? = null
    private var ticker: Job? = null

    fun toggle(context: Context, a: Attachment) {
        val s = _state.value
        if (s.id == a.id && player != null) {
            val p = player!!
            if (p.isPlaying) {
                p.pause()
                _state.value = s.copy(playing = false)
            } else {
                p.start()
                _state.value = s.copy(playing = true)
                tick()
            }
            return
        }
        stop()
        _state.value = State(id = a.id, loading = true, duration = ((a.duration ?: 0.0) * 1000).toLong(), speed = s.speed)
        Graph.scope.launch {
            try {
                val file = Media.cached(context, a.url)
                if (_state.value.id != a.id) return@launch
                val p = MediaPlayer()
                p.setDataSource(file.path)
                p.prepare()
                setSpeed(p, _state.value.speed)
                p.setOnCompletionListener { stop() }
                p.start()
                player = p
                val trusted = ((a.duration ?: 0.0) * 1000).toLong()
                _state.value = _state.value.copy(loading = false, playing = true, duration = if (trusted > 0) trusted else p.duration.toLong())
                tick()
            } catch (e: Exception) {
                stop()
                Toasts.error(e.message ?: "Couldn't play it.")
            }
        }
    }

    fun seek(fraction: Float) {
        val p = player ?: return
        val to = (fraction.coerceIn(0f, 1f) * (_state.value.duration.takeIf { it > 0 } ?: p.duration.toLong())).toInt()
        p.seekTo(to)
        _state.value = _state.value.copy(position = to.toLong())
    }

    /** 1× → 1.5× → 2× → 1×. */
    fun cycleSpeed() {
        val next = when (_state.value.speed) {
            1f -> 1.5f
            1.5f -> 2f
            else -> 1f
        }
        _state.value = _state.value.copy(speed = next)
        player?.let { setSpeed(it, next) }
    }

    private fun setSpeed(p: MediaPlayer, speed: Float) {
        runCatching {
            val wasPlaying = p.isPlaying
            p.playbackParams = p.playbackParams.setSpeed(speed)
            if (!wasPlaying) p.pause()
        }
    }

    private fun tick() {
        ticker?.cancel()
        ticker = Graph.scope.launch {
            while (isActive) {
                val p = player ?: break
                runCatching { _state.value = _state.value.copy(position = p.currentPosition.toLong()) }
                delay(100)
            }
        }
    }

    fun stop() {
        ticker?.cancel()
        runCatching { player?.release() }
        player = null
        _state.value = State(speed = _state.value.speed)
    }
}

/**
 * Voice messages: recorded as AAC (an .m4a file, which the server takes as
 * a voice message), at 32 kbit/s, up to 5 minutes, with 48 bars of its
 * loudness for the waveform.
 */
class Recorder(private val context: Context) {
    companion object {
        const val MAX_MS = 5 * 60_000L
        const val MIN_MS = 700L
    }

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L
    private val levels = mutableListOf<Int>()
    private var sampler: Job? = null
    private val _live = MutableStateFlow<List<Int>>(emptyList())
    /** The last 40 levels, for the recording bars. */
    val live: StateFlow<List<Int>> = _live.asStateFlow()
    private val _elapsed = MutableStateFlow(0L)
    val elapsed: StateFlow<Long> = _elapsed.asStateFlow()

    fun start(onLimit: () -> Unit) {
        val dir = File(context.filesDir, "outbox").apply { mkdirs() }
        val out = File(dir, UUID.randomUUID().toString() + ".m4a")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioEncodingBitRate(32_000)
        r.setAudioSamplingRate(24_000)
        r.setAudioChannels(1)
        r.setOutputFile(out.path)
        r.prepare()
        r.start()
        recorder = r
        file = out
        startedAt = System.currentTimeMillis()
        levels.clear()
        sampler = Graph.scope.launch {
            while (isActive) {
                delay(80)
                val amp = runCatching { r.maxAmplitude }.getOrDefault(0)
                val level = (Math.sqrt(amp / 32767.0) * 100).toInt().coerceIn(0, 100)
                levels += level
                _live.value = levels.takeLast(40)
                _elapsed.value = System.currentTimeMillis() - startedAt
                if (_elapsed.value >= MAX_MS) {
                    onLimit()
                    break
                }
            }
        }
    }

    /** The recording, ready to send; null when it was too short (or failed). */
    fun finish(): LocalFile? {
        val ms = System.currentTimeMillis() - startedAt
        val out = file
        stopRecorder()
        if (out == null) return null
        if (ms < MIN_MS) {
            out.delete()
            Toasts.show("Hold on a little longer to record a voice message.")
            return null
        }
        val stamp = LocalTime.now().format(DateTimeFormatter.ofPattern("HH.mm"))
        return LocalFile(out.path, "voice", "Voice message $stamp.m4a", "audio/mp4", duration = ms / 1000.0, waveform = squeeze(levels, 48))
    }

    fun cancel() {
        val out = file
        stopRecorder()
        out?.delete()
    }

    private fun stopRecorder() {
        sampler?.cancel()
        runCatching { recorder?.stop() }
        runCatching { recorder?.release() }
        recorder = null
        file = null
        _live.value = emptyList()
        _elapsed.value = 0
    }

    /** Levels squeezed into n bars (8–100), as the web app's recorder makes them. */
    private fun squeeze(values: List<Int>, n: Int): List<Int> {
        if (values.isEmpty()) return List(n) { 8 }
        return List(n) { i ->
            val from = i * values.size / n
            val to = maxOf(from + 1, (i + 1) * values.size / n)
            val slice = values.subList(from.coerceAtMost(values.size - 1), to.coerceAtMost(values.size))
            (slice.maxOrNull() ?: 0).coerceIn(8, 100)
        }
    }
}
