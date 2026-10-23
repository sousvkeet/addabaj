package com.addakhana.app.data

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.os.Process
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLongArray

/** The network the phone uses now, for what downloads by itself. */
enum class Net(val label: String) {
    Mobile("When using mobile data"),
    Wifi("When connected on Wi-Fi"),
    Roaming("When roaming"),
}

/** What downloads by itself on a network (as WhatsApp's media auto-download). */
data class AutoDownload(val photos: Boolean, val audio: Boolean, val videos: Boolean) {
    val summary: String
        get() = listOfNotNull("Photos".takeIf { photos }, "Audio".takeIf { audio }, "Videos".takeIf { videos }).let {
            when (it.size) {
                0 -> "No media"
                3 -> "All media"
                else -> it.joinToString(", ")
            }
        }
}

/** "Use less data for calls". */
enum class CallSaving(val label: String) {
    Never("Off"),
    Mobile("On mobile data"),
    Always("Always"),
}

/** How photos and videos are sent. */
enum class UploadQuality(val label: String, val hint: String) {
    Standard("Standard quality", "Faster to send, and uses less data"),
    HD("HD quality", "Sharper, and up to several times bigger"),
}

/** One kind of traffic, for Network usage. */
enum class Usage(val label: String) {
    Calls("Calls, room voice and live streams"),
    Media("Photos, videos, files and voice messages"),
    Messages("Messages and everything else"),
}

/**
 * Settings › Storage and data: how much data the app uses, as WhatsApp's.
 * Calls can use less data (on mobile data, by default); photos, voice
 * messages and videos download by themselves only where chosen (photos'
 * small copies on mobile data, everything on Wi-Fi, nothing when roaming);
 * photos and videos are sent at standard quality unless HD is chosen. It
 * also counts what the app sends and receives, on mobile data and Wi-Fi.
 */
object DataUse {
    private lateinit var prefs: SharedPreferences

    private val _calls = MutableStateFlow(CallSaving.Mobile)
    val calls: StateFlow<CallSaving> = _calls.asStateFlow()

    private val defaults = mapOf(
        Net.Mobile to AutoDownload(photos = true, audio = false, videos = false),
        Net.Wifi to AutoDownload(photos = true, audio = true, videos = true),
        Net.Roaming to AutoDownload(photos = false, audio = false, videos = false),
    )
    private val _auto = MutableStateFlow(defaults)
    val auto: StateFlow<Map<Net, AutoDownload>> = _auto.asStateFlow()

    private val _photos = MutableStateFlow(UploadQuality.Standard)
    val photos: StateFlow<UploadQuality> = _photos.asStateFlow()
    private val _videos = MutableStateFlow(UploadQuality.Standard)
    val videos: StateFlow<UploadQuality> = _videos.asStateFlow()

    private val _net = MutableStateFlow(Net.Wifi)
    /** The network now (kept up to date as it changes). */
    val net: StateFlow<Net> = _net.asStateFlow()

    fun init(c: Context, scope: CoroutineScope) {
        prefs = c.getSharedPreferences("data_use", Context.MODE_PRIVATE)
        _calls.value = runCatching { CallSaving.valueOf(prefs.getString("calls", null) ?: "") }.getOrDefault(CallSaving.Mobile)
        _auto.value = Net.entries.associateWith { n ->
            val d = defaults.getValue(n)
            AutoDownload(
                prefs.getBoolean("${n.name}_photos", d.photos),
                prefs.getBoolean("${n.name}_audio", d.audio),
                prefs.getBoolean("${n.name}_videos", d.videos),
            )
        }
        _photos.value = runCatching { UploadQuality.valueOf(prefs.getString("photos", null) ?: "") }.getOrDefault(UploadQuality.Standard)
        _videos.value = runCatching { UploadQuality.valueOf(prefs.getString("videos", null) ?: "") }.getOrDefault(UploadQuality.Standard)
        watchNetwork(c)
        loadUsage()
        countRest(scope)
    }

    fun setCalls(v: CallSaving) {
        _calls.value = v
        prefs.edit().putString("calls", v.name).apply()
    }

    fun setAuto(n: Net, v: AutoDownload) {
        _auto.value = _auto.value + (n to v)
        prefs.edit().putBoolean("${n.name}_photos", v.photos).putBoolean("${n.name}_audio", v.audio).putBoolean("${n.name}_videos", v.videos).apply()
    }

    fun setPhotos(q: UploadQuality) {
        _photos.value = q
        prefs.edit().putString("photos", q.name).apply()
    }

    fun setVideos(q: UploadQuality) {
        _videos.value = q
        prefs.edit().putString("videos", q.name).apply()
    }

    /** What downloads by itself now. */
    fun autoNow(): AutoDownload = _auto.value.getValue(_net.value)

    /** Calls use less data now. */
    fun lessForCalls(): Boolean = when (_calls.value) {
        CallSaving.Always -> true
        CallSaving.Mobile -> _net.value != Net.Wifi
        CallSaving.Never -> false
    }

    private fun watchNetwork(c: Context) {
        val cm = c.getSystemService(ConnectivityManager::class.java) ?: return
        fun classify(caps: NetworkCapabilities?): Net = when {
            caps == null -> Net.Wifi
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING) -> Net.Roaming
            // Wi-Fi from another phone's hotspot is mobile data too (it's metered).
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) -> Net.Wifi
            else -> Net.Mobile
        }
        runCatching {
            _net.value = classify(cm.getNetworkCapabilities(cm.activeNetwork))
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    _net.value = classify(caps)
                }
            })
        }
    }

    // ── Network usage ────────────────────────────────────────────────

    /** Bytes, by network (Wi-Fi, then mobile data, roaming included), kind and direction: [net][kind][sent, received]. */
    data class Counts(val bytes: List<Long>, val since: Long) {
        fun get(wifi: Boolean, kind: Usage, sent: Boolean) = bytes[index(wifi, kind, sent)]
        fun total(wifi: Boolean, sent: Boolean) = Usage.entries.sumOf { get(wifi, it, sent) }
    }

    private fun index(wifi: Boolean, kind: Usage, sent: Boolean) = (if (wifi) 0 else 6) + kind.ordinal * 2 + (if (sent) 0 else 1)

    private val counts = AtomicLongArray(12)
    private val _usage = MutableStateFlow(Counts(List(12) { 0L }, System.currentTimeMillis()))
    val usage: StateFlow<Counts> = _usage.asStateFlow()
    /** What the app sent and received in all, the last time it looked (TrafficStats). */
    private var lastTx = -1L
    private var lastRx = -1L
    /** What was counted by kind since then (the rest is calls, or media such as YouTube's player). */
    private val tracked = AtomicLongArray(2)

    /** Some traffic of a kind (from the HTTP client and the live connection; calls are the rest). */
    fun count(kind: Usage, sent: Long, received: Long) {
        val wifi = _net.value == Net.Wifi
        if (sent > 0) counts.addAndGet(index(wifi, kind, true), sent)
        if (received > 0) counts.addAndGet(index(wifi, kind, false), received)
        tracked.addAndGet(0, sent.coerceAtLeast(0))
        tracked.addAndGet(1, received.coerceAtLeast(0))
    }

    /**
     * Every 10 s: whatever the app sent and received that the HTTP client and
     * the live connection didn't count is calls while one runs (WebRTC), or
     * media otherwise (YouTube's player). Then the counts are saved.
     */
    private fun countRest(scope: CoroutineScope) = scope.launch {
        val uid = Process.myUid()
        while (true) {
            val tx = TrafficStats.getUidTxBytes(uid)
            val rx = TrafficStats.getUidRxBytes(uid)
            val sentTracked = tracked.getAndSet(0, 0)
            val receivedTracked = tracked.getAndSet(1, 0)
            if (tx >= 0 && rx >= 0 && lastTx >= 0 && tx >= lastTx && rx >= lastRx) {
                val restSent = (tx - lastTx - sentTracked).coerceAtLeast(0)
                val restReceived = (rx - lastRx - receivedTracked).coerceAtLeast(0)
                val kind = if (com.addakhana.app.call.CallService.running && com.addakhana.app.call.CallService.kind != "watch") Usage.Calls else Usage.Media
                val wifi = _net.value == Net.Wifi
                counts.addAndGet(index(wifi, kind, true), restSent)
                counts.addAndGet(index(wifi, kind, false), restReceived)
            }
            lastTx = tx
            lastRx = rx
            publish()
            delay(10_000)
        }
    }

    private fun publish() {
        val now = List(12) { counts.get(it) }
        if (now != _usage.value.bytes) {
            _usage.value = _usage.value.copy(bytes = now)
            prefs.edit().putString("usage", now.joinToString(",")).apply()
        }
    }

    private fun loadUsage() {
        val saved = prefs.getString("usage", null)?.split(',')?.mapNotNull { it.toLongOrNull() }
        if (saved?.size == 12) saved.forEachIndexed { i, v -> counts.set(i, v) }
        val since = prefs.getLong("usage_since", 0L).takeIf { it > 0 } ?: System.currentTimeMillis().also { prefs.edit().putLong("usage_since", it).apply() }
        _usage.value = Counts(List(12) { counts.get(it) }, since)
    }

    fun resetUsage() {
        for (i in 0 until 12) counts.set(i, 0)
        val now = System.currentTimeMillis()
        prefs.edit().putString("usage", "").putLong("usage_since", now).apply()
        _usage.value = Counts(List(12) { 0L }, now)
    }
}
