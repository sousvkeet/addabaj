package com.addakhana.app

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.addakhana.app.call.CallService
import com.addakhana.app.call.CallStore
import com.addakhana.app.call.Session
import com.addakhana.app.call.VoiceStore
import com.addakhana.app.data.AppLifecycle
import com.addakhana.app.data.AuthStore
import com.addakhana.app.data.CallNotices
import com.addakhana.app.data.ChatStore
import com.addakhana.app.data.SiteStore
import com.addakhana.app.data.VoicePlayer
import com.addakhana.app.model.User
import com.addakhana.app.net.Api
import com.addakhana.app.net.CookieStore
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.httpClient
import com.addakhana.app.push.Notifications
import com.addakhana.app.push.Push
import com.addakhana.app.ui.Nav
import com.addakhana.app.watch.LiveStore
import com.addakhana.app.watch.WatchStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient

/**
 * What lives as long as the app's process, not any one screen: the
 * connection, the stores, calls and room voice (so a call goes on whatever
 * the screens do, with the app in the background or the screen off).
 */
@SuppressLint("StaticFieldLeak")
object Graph {
    lateinit var context: Context
        private set
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var cookies: CookieStore
        private set
    lateinit var http: OkHttpClient
        private set
    lateinit var api: Api
        private set
    lateinit var realtime: Realtime
        private set
    lateinit var notifications: Notifications
        private set
    lateinit var push: Push
        private set
    lateinit var site: SiteStore
        private set
    lateinit var chat: ChatStore
        private set
    lateinit var calls: CallStore
        private set
    lateinit var voice: VoiceStore
        private set
    lateinit var watch: WatchStore
        private set
    lateinit var live: LiveStore
        private set
    val callNotices = CallNotices()
    lateinit var auth: AuthStore
        private set

    fun init(app: Context) {
        if (::context.isInitialized) return
        context = app.applicationContext
        cookies = CookieStore(context).also { it.adoptWebViewLogin(context) }
        http = httpClient(cookies)
        api = Api(http)
        realtime = Realtime(http, scope)
        notifications = Notifications(context).also { it.createChannels() }
        push = Push(context, api, realtime, scope)
        site = SiteStore(context, api, realtime, scope)
        chat = ChatStore(context, api, realtime, scope)
        calls = CallStore(realtime, scope)
        voice = VoiceStore(realtime, scope)
        watch = WatchStore(realtime, scope)
        live = LiveStore(realtime, scope)
        // Last: it may say someone is signed in straight away (see onSignedIn).
        auth = AuthStore(context, api, realtime, cookies, scope)
        keepConnected()
        reportPresence()
        runSessions()
        watchNetwork()
        push.refreshToken()
    }

    /** Someone signed in (or was, at launch): their chats, and the live connection. */
    fun onSignedIn(me: User) {
        chat.start(me)
        realtime.start()
    }

    /** Logged out: calls end, the connection closes, and nothing of theirs stays. */
    fun onSignedOut(was: User?) {
        calls.signedOut()
        voice.signedOut()
        watch.stop()
        live.signedOut()
        VoicePlayer.stop()
        realtime.stop()
        chat.clear()
        notifications.clearAll()
        Nav.reset()
        if (was != null) push.refreshToken()
    }

    /** A call is ringing (its push came): connected for a while, so answering is quick. */
    private val held = MutableStateFlow(false)
    private var holdJob: Job? = null

    fun holdConnection(ms: Long) {
        scope.launch {
            holdJob?.cancel()
            holdJob = scope.launch {
                held.value = true
                delay(ms)
                held.value = false
            }
        }
    }

    /**
     * Connected while the app or its call screen is on screen, while a call
     * rings, and while a call or room voice runs. Otherwise it lets go 5
     * seconds after the app leaves the screen (long enough for a file picker
     * or a permission prompt): Android soon freezes an idle app, and a frozen
     * connection would only make the server think it's still here. The
     * server then sends pushes instead.
     */
    private fun keepConnected() = scope.launch {
        val ringing = combine(AppLifecycle.callScreen, held) { screen, push -> screen || push }
        // Room voice, or a room's video playing on out of sight (it follows the room's play and pause).
        val media = combine(voice.state, watch.state, live.state) { v, w, l -> v.active || (w.roomId != null && w.background) || l.host != null }
        combine(AppLifecycle.foreground, ringing, calls.state, media, auth.state) { fg, ring, call, m, a ->
            Triple(a is com.addakhana.app.data.AuthState.SignedIn, fg || ring, !call.idle || m)
        }.distinctUntilChanged().collectLatest { (signedIn, wanted, busy) ->
            if (!signedIn) return@collectLatest
            if (wanted || busy) {
                realtime.start()
                // Back after a while away (perhaps frozen): check the line now.
                if (wanted) realtime.nudge()
            } else {
                delay(5_000)
                realtime.stop()
            }
        }
    }

    /**
     * The server sends pushes only while nobody is looking: it's told on
     * every connection, and whenever the app comes and goes.
     */
    private fun reportPresence() {
        fun say() = realtime.emit("client:state", buildJsonObject { put("active", AppLifecycle.foreground.value) })
        scope.launch { realtime.connects.collect { say() } }
        scope.launch { AppLifecycle.foreground.collect { say() } }
    }

    /** What's running (a call, room voice, my live stream, a room's video), for the foreground service and its notification. */
    private fun runSessions() = scope.launch {
        combine(calls.state, voice.state, chat.state, watch.state, live.state) { call, v, c, w, l ->
            val host = l.host
            when {
                call.inCall || call.phase == "outgoing" -> call.peer?.let { peer ->
                    Session(
                        kind = "call", name = peer.name, phase = call.phase, hue = peer.hue, photo = peer.photo,
                        video = call.cameraOn, startedAt = call.startedAt ?: 0, muted = call.muted,
                    )
                }
                v.active -> Session(
                    kind = "voice", name = c.rooms[v.roomId]?.name ?: "Room", video = v.cameraOn, startedAt = v.startedAt, muted = v.muted,
                )
                host != null -> Session(kind = "live", name = c.rooms[host.roomId]?.name ?: "Room", mode = host.mode, title = host.title, paused = !host.playing)
                // Started while the app is on screen (Android allows it only then), and kept while paused.
                w.roomId != null && w.background -> Session(
                    kind = "watch", name = c.rooms[w.roomId]?.name ?: "Room", title = c.roomDetails[w.roomId]?.watch?.source?.title, paused = !w.playing,
                )
                else -> null
            }?.copy(projection = host?.mode == "screen", recording = host?.audio == true)
        }.distinctUntilChanged().collect { CallService.update(context, it) }
    }

    /** The network came back or changed (Wi-Fi to mobile data): reconnect now rather than at the next try. */
    private fun watchNetwork() {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    scope.launch { realtime.nudge() }
                }
            })
        }
    }
}
