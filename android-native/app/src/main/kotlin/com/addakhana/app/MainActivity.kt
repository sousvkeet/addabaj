package com.addakhana.app

import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.res.Configuration
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import com.addakhana.app.call.CallService
import com.addakhana.app.data.AppLifecycle
import com.addakhana.app.data.Permissions
import com.addakhana.app.data.Updater
import com.addakhana.app.ui.AddaRoot
import com.addakhana.app.ui.Nav
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** The app's one screen: everything is drawn in Compose (see ui/App.kt). */
class MainActivity : ComponentActivity() {
    companion object {
        const val ACTION_OPEN = "com.addakhana.app.OPEN"
        const val ACTION_ANSWER = "com.addakhana.app.ANSWER"
        const val EXTRA_PATH = "path"

        private val _pip = MutableStateFlow(false)
        /** A video call floats in Android's picture-in-picture window. */
        val pip: StateFlow<Boolean> = _pip.asStateFlow()
        val inPip: Boolean get() = _pip.value

        private val JOIN = Regex("^/join/([A-Za-z0-9-]{1,16})$")
        private val SAFE_PATH = Regex("^/(chats|rooms|invites)(/[0-9a-fA-F-]{36})?$")
    }

    /** A video call is on screen: leaving the app floats it (Android 8+). */
    private var pipWanted = false
    private var pipMuted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { AddaRoot(leave = { leave() }) }
        if (savedInstanceState == null) Updater.clean(this)
        handle(intent)
        watchPip()
    }

    override fun onStart() {
        super.onStart()
        AppLifecycle.shown(true)
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) AppLifecycle.shown(false)
    }

    override fun onResume() {
        super.onResume()
        // Back from a prompt or the phone's settings, perhaps with a permission changed.
        Permissions.refresh(this)
        // Back from the installer, or from allowing "Install unknown apps".
        Updater.resume(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** A notification tap (a chat, a room), an answer from the call screen, or an invite link. */
    private fun handle(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            ACTION_OPEN -> intent.getStringExtra(EXTRA_PATH)?.takeIf { SAFE_PATH.matches(it) }?.let { Nav.openPath(it) }
            ACTION_ANSWER -> {
                val callId = intent.getStringExtra("callId") ?: return
                Graph.calls.answerFromNotification(callId, intent.getBooleanExtra("video", false))
            }
            Intent.ACTION_VIEW -> intent.data?.path?.let { path -> JOIN.find(path)?.groupValues?.get(1)?.let { Nav.join(it) } }
        }
        // Handled: not again when the activity is recreated.
        intent.action = Intent.ACTION_MAIN
    }

    /** Back from the chats: the app goes to the background (a video call floats instead); calls and voice go on. */
    private fun leave() {
        if (pipWanted && enterPip()) return
        moveTaskToBack(true)
    }

    // ── Picture in picture ─────────────────────────────────────────────

    private fun watchPip() {
        if (Build.VERSION.SDK_INT < 26) return
        lifecycleScope.launch {
            combine(Graph.calls.state, Graph.voice.state, Graph.chat.state) { call, voice, chat ->
                val callVideo = call.inCall && (call.cameraOn || call.peerCameraOn)
                val roomVideo = voice.live && (voice.cameraOn || chat.voice[voice.roomId].orEmpty().any { it.camera })
                (callVideo || roomVideo) to (if (call.inCall) call.muted else voice.muted)
            }.distinctUntilChanged().collect { (wanted, muted) ->
                pipWanted = wanted
                pipMuted = muted
                runCatching { setPictureInPictureParams(pipParams()) }
            }
        }
    }

    private fun pipParams(): PictureInPictureParams {
        val muteLabel = getString(if (pipMuted) R.string.pip_unmute else R.string.pip_mute)
        val mute = RemoteAction(Icon.createWithResource(this, if (pipMuted) R.drawable.ic_mic_off else R.drawable.ic_mic), muteLabel, muteLabel, CallService.action(this, CallService.ACTION_MUTE))
        val hangupLabel = getString(R.string.pip_hang_up)
        val hangup = RemoteAction(Icon.createWithResource(this, R.drawable.ic_call_end), hangupLabel, hangupLabel, CallService.action(this, CallService.ACTION_HANGUP))
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16)).setActions(listOf(mute, hangup))
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(pipWanted)
            b.setSeamlessResizeEnabled(false)
        }
        return b.build()
    }

    private fun enterPip(): Boolean = Build.VERSION.SDK_INT >= 26 && runCatching { enterPictureInPictureMode(pipParams()) }.getOrDefault(false)

    /** Android 8 to 11: Home floats a video call (12+ does it by itself, with Home's own animation). */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT in 26..30 && pipWanted) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        _pip.value = isInPictureInPictureMode
    }
}
