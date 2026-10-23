package com.addakhana.app.watch

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.addakhana.app.BuildConfig
import com.addakhana.app.Graph
import com.addakhana.app.data.DataUse
import com.addakhana.app.model.WatchSource
import com.addakhana.app.net.appUrl
import kotlin.math.abs
import kotlin.math.roundToInt

/** What the sync needs from a player: a file or stream (ExoPlayer), or YouTube's own player. */
interface WatchPlayer {
    fun play()
    fun pause()
    fun seek(seconds: Double)
    /** Where it is, in seconds. */
    fun time(): Double
    /** Playing, or about to (buffering): not paused, not ended. */
    fun playing(): Boolean
    /** A live stream: no shared timeline, everyone plays the live edge. */
    fun live(): Boolean
    fun setMuted(muted: Boolean)
    fun setVolume(volume: Float)
    /** Fine speed control, for easing out small drifts (files and streams; not YouTube). */
    val setRate: ((Float) -> Unit)?
    /** Its sound goes on with the app out of sight (files and streams; YouTube stops). */
    val background: Boolean
    /** How long it is (seconds), once known. */
    fun duration(): Double?
    /** Shows the picture in this frame (moving it from wherever it was), with the player's own controls or without. */
    fun show(frame: FrameLayout, controls: Boolean)
    fun hide(frame: FrameLayout)
    /** The app went out of sight, or came back. */
    fun sight(visible: Boolean)
    fun release()
}

/** What a player tells the sync. */
interface PlayerEvents {
    fun ready()
    /** A play, pause or seek at the player (only an admin's counts), or its end. */
    fun userAction(playing: Boolean, position: Double, ended: Boolean)
    fun error(message: String)
}

private fun absolute(url: String) = if (url.startsWith("/")) appUrl + url else url

/**
 * A video file or HLS stream. Links the phone can't play directly move to
 * the server's relay; one that errors or stalls is tried twice more, with a
 * pause, before an error shows.
 */
@OptIn(UnstableApi::class)
class FilePlayer(c: Context, private val source: WatchSource, startAt: Double, private val controls: Boolean, private val events: PlayerEvents) : WatchPlayer {
    private val main = Handler(Looper.getMainLooper())
    private val exo: ExoPlayer = ExoPlayer.Builder(c)
        // Signed in, for the server's relay.
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(Graph.http)))
        // Not paused by room voice or a call starting: people talk while they watch.
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), false)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .build()
        .apply {
            // Using less data (Settings › Storage and data): a stream with several qualities plays at most 480p.
            if (DataUse.lessForCalls()) trackSelectionParameters = trackSelectionParameters.buildUpon().setMaxVideoSize(854, 480).build()
        }
    private var ready = false
    private var released = false
    private var onRelay = false
    private var retries = 0
    private var current = source.url
    private var volume = 1f
    private var muted = false
    private var startMs = (startAt * 1000).toLong().coerceAtLeast(0)
    private val views = mutableMapOf<FrameLayout, PlayerView>()
    private val stalled = Runnable { if (!ready) failed() }

    init {
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY && !ready) announce()
                if (state == Player.STATE_ENDED && ready) action()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (ready) action()
            }

            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                if (ready && reason == Player.DISCONTINUITY_REASON_SEEK) action()
            }

            override fun onPlayerError(error: PlaybackException) = failed()
        })
        load(source.url)
    }

    private fun load(url: String) {
        current = url
        // Nothing at all after 15 s counts as a stall (some sites just hang).
        main.removeCallbacks(stalled)
        main.postDelayed(stalled, 15_000)
        val item = MediaItem.Builder().setUri(absolute(url)).apply { if (source.kind == "hls") setMimeType(MimeTypes.APPLICATION_M3U8) }.build()
        exo.setMediaItem(item, startMs)
        exo.prepare()
    }

    private fun failed() {
        if (released) return
        main.removeCallbacks(stalled)
        if (ready) startMs = exo.currentPosition
        ready = false
        val relay = source.fallbackUrl
        if (!onRelay && relay != null) {
            onRelay = true
            retries = 0
            load(relay)
            return
        }
        if (retries < 2) {
            retries++
            main.postDelayed({ if (!released) load(current) }, retries * 2000L)
            return
        }
        events.error(
            if (source.kind == "hls") "The stream couldn't be loaded. It may be offline, or its server doesn't allow playback on other apps."
            else "This link couldn't be played. Use a YouTube link, or a direct link to a video file (.mp4, .webm) or stream (.m3u8).",
        )
    }

    private fun announce() {
        ready = true
        main.removeCallbacks(stalled)
        events.ready()
    }

    private fun action() = events.userAction(playing(), time(), exo.playbackState == Player.STATE_ENDED)

    override fun play() = exo.play()
    override fun pause() = exo.pause()
    override fun seek(seconds: Double) = exo.seekTo((seconds * 1000).toLong().coerceAtLeast(0))
    override fun time() = exo.currentPosition / 1000.0
    override fun playing() = exo.playWhenReady && exo.playbackState != Player.STATE_ENDED
    override fun live() = exo.isCurrentMediaItemLive || (ready && exo.duration == C.TIME_UNSET)

    override fun setMuted(muted: Boolean) {
        this.muted = muted
        exo.volume = if (muted) 0f else volume
    }

    override fun setVolume(volume: Float) {
        this.volume = volume
        if (!muted) exo.volume = volume
    }

    override val setRate: ((Float) -> Unit) = { r -> if (abs(exo.playbackParameters.speed - r) > 0.001f) exo.setPlaybackSpeed(r) }
    override val background = true
    override fun duration() = exo.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 }

    override fun show(frame: FrameLayout, controls: Boolean) {
        views[frame]?.let {
            if (it.player === exo) {
                it.useController = controls && this.controls
                return
            }
        }
        frame.removeAllViews()
        val view = PlayerView(frame.context).apply {
            // Admins get the player's own controls (not in the small player); members only follow.
            useController = controls && this@FilePlayer.controls
            setShowNextButton(false)
            setShowPreviousButton(false)
            setShowSubtitleButton(false)
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShutterBackgroundColor(Color.BLACK)
            player = exo
        }
        views[frame] = view
        frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    override fun hide(frame: FrameLayout) {
        views.remove(frame)?.let {
            it.player = null
            frame.removeView(it)
        }
    }

    override fun sight(visible: Boolean) {}

    override fun release() {
        released = true
        main.removeCallbacksAndMessages(null)
        for ((frame, view) in views) {
            view.player = null
            frame.removeView(view)
        }
        views.clear()
        exo.release()
    }
}

/**
 * YouTube's own player (its embed, in a web view: YouTube has no other
 * player apps may use). It reports where it is a few times a second, so the
 * sync can ask at any moment. It stops with the app out of sight, as
 * YouTube requires, and lines up again when the app is back.
 */
@SuppressLint("SetJavaScriptEnabled")
class YouTubePlayer(c: Context, private val source: WatchSource, startAt: Double, private val controls: Boolean, private val events: PlayerEvents) : WatchPlayer {
    companion object {
        private val ERRORS = mapOf(
            2 to "YouTube rejected this video link.",
            5 to "This video can't be played here.",
            100 to "This YouTube video was removed or is private.",
            101 to "This video's owner doesn't allow it to be played in other apps.",
            150 to "This video's owner doesn't allow it to be played in other apps.",
            152 to "YouTube didn't let this player start. Try again in a moment.",
            153 to "YouTube didn't let this player start. Try again in a moment.",
        )
    }

    private val main = Handler(Looper.getMainLooper())
    private val context = MutableContextWrapper(c.applicationContext)
    private val web = WebView(context)
    private var ready = false
    private var released = false
    private var at = 0.0
    private var atClock = 0L
    private var state = -1
    private var length = 0.0
    private var isLive = false

    init {
        web.setBackgroundColor(Color.BLACK)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // The room's play and pause drive it, not a tap.
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(Bridge(), "Adda")
        // A real https page of the site, so YouTube sees where it's playing.
        web.loadDataWithBaseURL(BuildConfig.SITE_URL + "/", page(startAt), "text/html", "utf-8", null)
    }

    private fun page(startAt: Double): String {
        val id = source.videoId.orEmpty().filter { it.isLetterOrDigit() || it == '-' || it == '_' }
        val c = if (controls) 1 else 0
        return """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{width:100%;height:100%}</style></head>
<body><div id="p"></div><script>
var p;
function tick(){if(!p||!p.getCurrentTime)return;var d=p.getVideoData?p.getVideoData():null;Adda.tick(p.getCurrentTime()||0,p.getPlayerState(),p.getDuration()||0,!!(d&&d.isLive));}
function onYouTubeIframeAPIReady(){p=new YT.Player('p',{videoId:'$id',width:'100%',height:'100%',
playerVars:{autoplay:0,controls:$c,disablekb:${1 - c},fs:0,rel:0,playsinline:1,modestbranding:1,iv_load_policy:3,start:${startAt.toInt().coerceAtLeast(0)}},
events:{onReady:function(){tick();Adda.ready();setInterval(tick,250);},onStateChange:function(e){tick();Adda.state(e.data);},onError:function(e){Adda.error(e.data);}}});}
</script><script src="https://www.youtube.com/iframe_api" onerror="Adda.error(-1)"></script></body></html>"""
    }

    private inner class Bridge {
        @JavascriptInterface
        fun tick(time: Double, st: Int, d: Double, live: Boolean) {
            main.post {
                at = time
                atClock = SystemClock.elapsedRealtime()
                state = st
                length = d
                isLive = live
            }
        }

        @JavascriptInterface
        fun ready() {
            main.post {
                if (released) return@post
                ready = true
                events.ready()
            }
        }

        @JavascriptInterface
        fun state(st: Int) {
            main.post {
                if (released) return@post
                state = st
                when (st) {
                    1 -> events.userAction(true, at, false)
                    2 -> events.userAction(false, at, false)
                    0 -> events.userAction(false, length, true)
                }
            }
        }

        @JavascriptInterface
        fun error(code: Int) {
            main.post {
                if (!released) events.error(if (code == -1) "Couldn't load the YouTube player. Check your connection." else ERRORS[code] ?: "YouTube couldn't play this video.")
            }
        }
    }

    private fun js(code: String) {
        if (ready && !released) web.evaluateJavascript("try{$code}catch(e){}", null)
    }

    override fun play() {
        js("p.playVideo()")
    }

    override fun pause() {
        js("p.pauseVideo()")
    }

    override fun seek(seconds: Double) {
        js("p.seekTo($seconds,true)")
        at = seconds
        atClock = SystemClock.elapsedRealtime()
    }

    override fun time() = if (state == 1) at + (SystemClock.elapsedRealtime() - atClock) / 1000.0 else at
    override fun playing() = state == 1 || state == 3
    override fun live() = isLive

    override fun setMuted(muted: Boolean) = js(if (muted) "p.mute()" else "p.unMute()")
    override fun setVolume(volume: Float) = js("p.setVolume(${(volume * 100).roundToInt()})")
    override val setRate: ((Float) -> Unit)? = null
    override val background = false
    override fun duration() = length.takeIf { it > 0 }

    override fun show(frame: FrameLayout, controls: Boolean) {
        if (web.parent === frame) return
        (web.parent as? ViewGroup)?.removeView(web)
        context.baseContext = frame.context
        frame.removeAllViews()
        frame.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    override fun hide(frame: FrameLayout) {
        if (web.parent === frame) frame.removeView(web)
    }

    override fun sight(visible: Boolean) {
        if (visible) web.onResume() else {
            pause()
            web.onPause()
        }
    }

    override fun release() {
        released = true
        main.removeCallbacksAndMessages(null)
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
    }
}
