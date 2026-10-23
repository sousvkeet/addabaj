package com.addakhana.app.data

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.addakhana.app.BuildConfig
import com.addakhana.app.Graph
import com.addakhana.app.model.Release
import com.addakhana.app.net.appUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Locale

/**
 * Updates the app from its own server (Admin › App updates): downloads the
 * new version (only from this server, and only a file matching the release's
 * SHA-256), then opens Android's installer. The first time, Android asks to
 * allow installing apps from Adda Khana; once allowed, it carries on.
 */
object Updater {
    sealed interface State {
        data object Idle : State
        data class Downloading(val percent: Int) : State
        data object Checking : State
        /** Waiting for "Install unknown apps" to be allowed. */
        data object Permission : State
        data object Installing : State
        data object Cancelled : State
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()
    private var pending: File? = null
    private var installerOpen = false

    /** A release newer than this build. */
    fun isNewer(versionCode: Int) = versionCode > BuildConfig.VERSION_CODE

    private fun allowed(url: String): String? {
        val full = if (url.startsWith("/")) appUrl + url else url
        val base = Uri.parse(appUrl)
        val u = Uri.parse(full)
        val same = base.scheme == u.scheme && base.authority == u.authority
        return if (same && u.path?.matches(Regex("/api/app/download/\\d+")) == true) full else null
    }

    fun start(activity: Activity, release: Release) {
        if (_state.value is State.Downloading || _state.value is State.Checking) return
        val source = allowed(release.url) ?: return run { _state.value = State.Failed("That isn't this app's download address.") }
        val expected = release.sha256.lowercase(Locale.ROOT)
        if (!expected.matches(Regex("[0-9a-f]{64}"))) return run { _state.value = State.Failed("That update can't be checked, so it wasn't downloaded.") }
        val app = activity.applicationContext
        _state.value = State.Downloading(0)
        Graph.scope.launch {
            try {
                val dir = File(app.cacheDir, "updates").apply { mkdirs() }
                val ready = File(dir, "AddaKhana-update.apk")
                val file = if (ready.isFile && withContext(Dispatchers.IO) { sha256(ready) } == expected) ready else download(dir, source, expected)
                install(activity, file)
            } catch (e: Exception) {
                _state.value = State.Failed(e.message ?: "The download didn't finish.")
            }
        }
    }

    private suspend fun download(dir: File, source: String, expected: String): File = withContext(Dispatchers.IO) {
        dir.listFiles()?.forEach { it.delete() }
        val part = File(dir, "update.apk.part")
        val digest = MessageDigest.getInstance("SHA-256")
        Graph.http.newCall(Request.Builder().url(source).build()).execute().use { res ->
            if (res.code != 200) throw java.io.IOException("The server answered ${res.code}. Try again later.")
            val total = res.body.contentLength()
            var received = 0L
            var told = -1
            res.body.byteStream().use { input ->
                FileOutputStream(part).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        received += n
                        val pct = if (total > 0) (received * 100 / total).toInt() else -1
                        if (pct != told) {
                            told = pct
                            _state.value = State.Downloading(pct)
                        }
                    }
                }
            }
            if (total > 0 && received != total) throw java.io.IOException("The download was cut short. Try again.")
        }
        _state.value = State.Checking
        if (digest.digest().joinToString("") { "%02x".format(it) } != expected) {
            part.delete()
            throw java.io.IOException("The download didn't match the release, so it wasn't installed. Try again.")
        }
        val apk = File(dir, "AddaKhana-update.apk")
        if (!part.renameTo(apk)) throw java.io.IOException("Couldn't save the update.")
        apk
    }

    private fun sha256(file: File): String = runCatching {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    }.getOrDefault("")

    /** Android's installer for the downloaded update (allowing it first, if needed). */
    private fun install(activity: Activity, apk: File) {
        val c: Context = activity
        if (Build.VERSION.SDK_INT >= 26 && !c.packageManager.canRequestPackageInstalls()) {
            pending = apk
            _state.value = State.Permission
            runCatching { activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${c.packageName}"))) }
            return
        }
        pending = null
        val uri = FileProvider.getUriForFile(c, "${c.packageName}.updates", apk)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            activity.startActivity(intent)
            installerOpen = true
            _state.value = State.Installing
        } catch (_: ActivityNotFoundException) {
            _state.value = State.Failed("This phone has no app installer.")
        }
    }

    /** Back in the app: from the installer (it was cancelled; an installed update restarts the app), or the setting. */
    fun resume(activity: Activity) {
        if (installerOpen) {
            installerOpen = false
            _state.value = State.Cancelled
            return
        }
        val apk = pending ?: return
        if (Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()) install(activity, apk)
    }

    /** An update installed (or given up) leaves nothing behind. */
    fun clean(c: Context) {
        if (pending != null || _state.value !is State.Idle) return
        File(c.cacheDir, "updates").listFiles()?.forEach { it.delete() }
    }
}
