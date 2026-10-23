package com.addakhana.app.data

import android.content.Context
import com.addakhana.app.model.AppVersions
import com.addakhana.app.model.ClientConfig
import com.addakhana.app.model.SiteInfo
import com.addakhana.app.net.Api
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.json
import com.addakhana.app.net.long
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * How the site works: its limits and call servers (/config), the host's
 * settings for messages and its announcement (/site), the newest app
 * version, and the server's clock (for watching together in step).
 */
class SiteStore(context: Context, private val api: Api, private val realtime: Realtime, private val scope: CoroutineScope) {
    private val prefs = context.getSharedPreferences("site", Context.MODE_PRIVATE)

    private val _config = MutableStateFlow(load("config", ClientConfig.serializer()) ?: ClientConfig())
    val config: StateFlow<ClientConfig> = _config.asStateFlow()
    private val _site = MutableStateFlow(load("site", SiteInfo.serializer()) ?: SiteInfo())
    val site: StateFlow<SiteInfo> = _site.asStateFlow()
    private val _dismissed = MutableStateFlow(prefs.getString("dismissed_announcement", null))
    /** The announcement I closed (a new one shows again). */
    val dismissed: StateFlow<String?> = _dismissed.asStateFlow()

    fun dismissAnnouncement(id: String) {
        _dismissed.value = id
        prefs.edit().putString("dismissed_announcement", id).apply()
    }
    private val _versions = MutableStateFlow(load("versions", AppVersions.serializer()) ?: AppVersions())
    val versions: StateFlow<AppVersions> = _versions.asStateFlow()
    private var configAt = 0L

    /** Server time minus this phone's, in ms. */
    @Volatile var clockOffset = 0L
        private set

    init {
        scope.launch {
            realtime.connects.collect {
                load()
                syncClock()
            }
        }
        scope.launch {
            realtime.events.collect { e ->
                when (e.name) {
                    "site:settings" -> runCatching { json.decodeFromJsonElement(SiteInfo.serializer(), e.data) }.onSuccess { set(it.copy(build = _site.value.build)) }
                    "app:versions" -> runCatching { json.decodeFromJsonElement(AppVersions.serializer(), e.data) }.onSuccess { setVersions(it) }
                }
            }
        }
        // Call servers' passwords last a day: fetched again every hour.
        scope.launch {
            while (true) {
                delay(3_600_000)
                runCatching { setConfig(api.config()) }
            }
        }
    }

    suspend fun load() {
        runCatching { setConfig(api.config()) }
        runCatching { set(api.site()) }
        runCatching { setVersions(api.appVersions()) }
    }

    /** Fresh call servers (TURN passwords expire): fetched again if an hour old. */
    suspend fun freshConfig(): ClientConfig {
        if (System.currentTimeMillis() - configAt > 3_600_000) runCatching { setConfig(api.config()) }
        return _config.value
    }

    private fun setConfig(c: ClientConfig) {
        configAt = System.currentTimeMillis()
        _config.value = c
        prefs.edit().putString("config", json.encodeToString(ClientConfig.serializer(), c)).apply()
    }

    private fun set(s: SiteInfo) {
        _site.value = s
        prefs.edit().putString("site", json.encodeToString(SiteInfo.serializer(), s)).apply()
    }

    private fun setVersions(v: AppVersions) {
        _versions.value = v
        prefs.edit().putString("versions", json.encodeToString(AppVersions.serializer(), v)).apply()
    }

    /** Four round trips to the server; the quickest says how far its clock is from this phone's. */
    private suspend fun syncClock() {
        var best = Long.MAX_VALUE
        repeat(4) {
            runCatching {
                val t0 = System.currentTimeMillis()
                val res: JsonObject = realtime.request("time:now", JsonObject(emptyMap()), 5_000)
                val t1 = System.currentTimeMillis()
                val server = res.long("now") ?: return@runCatching
                if (t1 - t0 < best) {
                    best = t1 - t0
                    clockOffset = server - (t0 + t1) / 2
                }
            }
        }
    }

    fun serverNow() = System.currentTimeMillis() + clockOffset

    private fun <T> load(key: String, serializer: kotlinx.serialization.KSerializer<T>): T? =
        prefs.getString(key, null)?.let { runCatching { json.decodeFromString(serializer, it) }.getOrNull() }
}
