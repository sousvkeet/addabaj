package com.addakhana.app.net

import android.content.Context
import android.os.Build
import com.addakhana.app.BuildConfig
import com.addakhana.app.data.DataUse
import com.addakhana.app.data.Usage
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.EventListener
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The server's JSON, read leniently: fields this app doesn't know are skipped. */
val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
    coerceInputValues = true
    isLenient = true
}

/** The site this app talks to ("https://adda-api.clix.dpdns.org"). */
val appUrl: String = BuildConfig.APP_URL

/**
 * "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AddaKhanaApp/2.0.0":
 * the server shows this phone in Settings › Devices as the app, with its model.
 */
val userAgent: String =
    "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}; ${Build.MODEL} Build/${Build.ID}) AddaKhanaApp/${BuildConfig.VERSION_NAME}"

/**
 * The login cookie (adda_token), kept on this phone between launches. The
 * server sets it again now and then (a new password, other devices logged
 * out), so every response's cookies are kept, not just the login's.
 */
class CookieStore(context: Context) : CookieJar {
    private val prefs = context.getSharedPreferences("cookies", Context.MODE_PRIVATE)
    private val cookies = mutableMapOf<String, Cookie>()
    private val site = appUrl.toHttpUrl()

    init {
        for (line in prefs.getStringSet("all", emptySet()).orEmpty()) {
            Cookie.parse(site, line)?.let { cookies[key(it)] = it }
        }
    }

    private fun key(c: Cookie) = "${c.name}|${c.domain}|${c.path}"

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val now = System.currentTimeMillis()
        for (c in cookies) {
            if (c.expiresAt < now) this.cookies.remove(key(c)) else this.cookies[key(c)] = c
        }
        persist()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        cookies.values.removeAll { it.expiresAt < now }
        return cookies.values.filter { it.matches(url) }
    }

    /** "adda_token=…" for requests made outside OkHttp, or null when signed out. */
    @Synchronized
    fun header(): String? = loadForRequest(site).takeIf { it.isNotEmpty() }?.joinToString("; ") { "${it.name}=${it.value}" }

    @Synchronized
    fun signedIn(): Boolean = loadForRequest(site).any { it.name == "adda_token" }

    /**
     * Updating from the web-view app (1.x), the login is in the web view's
     * cookie store, in this same app: taken over once, so the update doesn't
     * log anyone out. It lasts as long as it would have there (its token says).
     */
    @Synchronized
    fun adoptWebViewLogin(context: Context) {
        if (prefs.getBoolean("adopted", false)) return
        prefs.edit().putBoolean("adopted", true).apply()
        // A fresh install has no web view data (and loading the web view just to look would be slow).
        if (signedIn() || !java.io.File(context.applicationInfo.dataDir, "app_webview").exists()) return
        val raw = runCatching { android.webkit.CookieManager.getInstance().getCookie(appUrl) }.getOrNull() ?: return
        val token = raw.split(';').map { it.trim() }.firstOrNull { it.startsWith("adda_token=") }?.substringAfter('=') ?: return
        val expires = runCatching {
            val payload = String(android.util.Base64.decode(token.split('.')[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP))
            org.json.JSONObject(payload).getLong("exp") * 1000
        }.getOrNull() ?: return
        if (expires <= System.currentTimeMillis()) return
        val cookie = Cookie.Builder().name("adda_token").value(token).hostOnlyDomain(site.host).path("/").expiresAt(expires).httpOnly()
            .apply { if (site.isHttps) secure() }
            .build()
        cookies[key(cookie)] = cookie
        persist()
    }

    @Synchronized
    fun clear() {
        cookies.clear()
        persist()
    }

    private fun persist() {
        // Session cookies (no expiry) only live as long as the app's process, like a browser's.
        prefs.edit().putStringSet("all", cookies.values.filter { it.persistent }.map { it.toString() }.toSet()).apply()
    }
}

class ApiError(val status: Int, message: String) : IOException(message)

private val siteHost by lazy { appUrl.toHttpUrl().host }

/** What a request is, for Network usage: photos, videos and files (media), or the rest. */
private fun usageOf(url: HttpUrl): Usage {
    val path = url.encodedPath
    val media = url.host != siteHost || path.startsWith("/api/files/") || path.startsWith("/api/uploads") ||
        path.startsWith("/api/stream/") || path.startsWith("/api/app/download") || path.contains("/photo")
    return if (media) Usage.Media else Usage.Messages
}

/** Counts what each request sends and receives (Settings › Storage and data › Network usage). */
private class UsageCounter : EventListener() {
    private var kind = Usage.Messages

    override fun callStart(call: Call) {
        kind = usageOf(call.request().url)
    }

    override fun requestHeadersEnd(call: Call, request: Request) = DataUse.count(kind, request.headers.byteCount(), 0)
    override fun requestBodyEnd(call: Call, byteCount: Long) = DataUse.count(kind, byteCount, 0)
    override fun responseHeadersEnd(call: Call, response: Response) = DataUse.count(kind, 0, response.headers.byteCount())
    override fun responseBodyEnd(call: Call, byteCount: Long) = DataUse.count(kind, 0, byteCount)
}

fun httpClient(cookies: CookieStore): OkHttpClient =
    OkHttpClient.Builder()
        .cookieJar(cookies)
        .eventListenerFactory { UsageCounter() }
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor(Interceptor { chain ->
            chain.proceed(chain.request().newBuilder().header("User-Agent", userAgent).build())
        })
        .build()

/** Runs the call without blocking, cancelling it with the coroutine. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (cont.isActive) cont.resume(response) else response.close()
        }
    })
}

/** The server's own words for a failed request ({"error": "…"}), or a general one. */
fun errorOf(status: Int, body: String?): ApiError {
    val text = runCatching { (json.parseToJsonElement(body.orEmpty()) as JsonObject)["error"]?.jsonPrimitive?.content }.getOrNull()
    return ApiError(
        status,
        text ?: when (status) {
            401 -> "Please log in again."
            413 -> "That's too big to send."
            429 -> "Too many tries. Wait a moment, then try again."
            in 500..599 -> "Something went wrong on the server. Try again in a moment."
            else -> "Something went wrong ($status)."
        },
    )
}
