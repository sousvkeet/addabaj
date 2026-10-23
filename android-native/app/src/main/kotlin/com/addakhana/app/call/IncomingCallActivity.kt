package com.addakhana.app.call

import android.Manifest
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.addakhana.app.Graph
import com.addakhana.app.MainActivity
import com.addakhana.app.data.AppLifecycle
import com.addakhana.app.push.IncomingCall
import com.addakhana.app.ui.call.CallStage
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.theme.AddaTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.lang.ref.WeakReference

/**
 * The phone's own call screen for an incoming call, over the lock screen,
 * with Answer and Decline, like a phone call (rung from a push or the live
 * connection while the app is out of sight). Answered on a locked phone, it
 * becomes the call screen there, as a phone call does: talking needs no
 * unlocking, only the rest of the app does.
 */
class IncomingCallActivity : ComponentActivity() {
    companion object {
        private var current = WeakReference<IncomingCallActivity>(null)

        /** The call ended or was answered elsewhere: this screen goes (unless it's the call's own screen now). */
        fun finishFor(callId: String) {
            current.get()?.let { if (it.callId == callId && !it.answered) it.runOnUiThread { it.finish() } }
        }

        /** How long an answered call may take to reach the app (it connects first, after a cold start). */
        private const val REACH_MS = 20_000L
    }

    private var callId by mutableStateOf("")
    private var name by mutableStateOf("")
    private var hue by mutableStateOf(260)
    private var photo by mutableStateOf<String?>(null)
    private var video by mutableStateOf(false)
    private var answered by mutableStateOf(false)
    private var unlocked: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Graph.init(applicationContext)
        current = WeakReference(this)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        take(intent)
        setContent {
            AddaTheme {
                LaunchedEffect(callId, answered) {
                    // Nobody answers a ringing phone forever.
                    if (answered) return@LaunchedEffect
                    delay(60_000)
                    finish()
                }
                if (answered) {
                    CallStage()
                    return@AddaTheme
                }
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFF1A1440), Color(0xFF090C1A))))) {
                    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Spacer(Modifier.height(48.dp))
                        Text(if (video) "Incoming video call" else "Incoming voice call", color = Color(0xFFA7ACD0), fontSize = 16.sp)
                        Spacer(Modifier.height(28.dp))
                        Avatar(name, hue, photo, 132.dp)
                        Spacer(Modifier.height(20.dp))
                        Text(name, color = Color(0xFFEEF0FF), fontSize = 30.sp, fontWeight = FontWeight.Bold)
                        Text("Adda Khana", color = Color(0xFF8E93B8), fontSize = 14.sp)
                        Spacer(Modifier.weight(1f))
                        Row(Modifier.fillMaxWidth().padding(bottom = 32.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                            Button(Icons.Rounded.CallEnd, "Decline", Color(0xFFEF4444)) { decline() }
                            Button(if (video) Icons.Rounded.Videocam else Icons.Rounded.Call, "Answer", Color(0xFF22C55E)) { answer() }
                        }
                    }
                }
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun Button(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, color: Color, onClick: () -> Unit) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(72.dp).clip(CircleShape).background(color).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
                Icon(icon, label, tint = Color.White, modifier = Modifier.size(32.dp))
            }
            Text(label, color = Color.White, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }

    override fun onStart() {
        super.onStart()
        AppLifecycle.callScreenShown(true)
    }

    override fun onStop() {
        super.onStop()
        AppLifecycle.callScreenShown(false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    private fun take(i: Intent) {
        callId = i.getStringExtra("callId").orEmpty()
        name = i.getStringExtra("name") ?: "Someone"
        hue = i.getIntExtra("hue", 260)
        photo = i.getStringExtra("photo")?.takeIf { it.isNotEmpty() }
        video = i.getBooleanExtra("video", false)
    }

    private fun decline() {
        val id = callId
        IncomingCall.stopRinging(this, id)
        Graph.calls.declinedElsewhere(id)
        Graph.scope.launch { runCatching { Graph.api.declineCall(id) } }
        finish()
    }

    private fun answer() {
        val id = callId
        val km = getSystemService(KeyguardManager::class.java)
        if (km?.isKeyguardLocked == true && granted(Manifest.permission.RECORD_AUDIO)) {
            answerHere(id, video && granted(Manifest.permission.CAMERA))
            return
        }
        // Unlocked (or the microphone needs allowing first): the app answers.
        val open = IncomingCall.answer(this, id, video)
        if (Build.VERSION.SDK_INT >= 26 && km != null && km.isKeyguardLocked) {
            km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() {
                    runCatching { open.send() }
                    finish()
                }
            })
        } else {
            runCatching { open.send() }
            finish()
        }
    }

    private fun granted(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    /** Answered on the lock screen: the call goes on right here until it ends, or until the phone is unlocked. */
    private fun answerHere(id: String, withVideo: Boolean) {
        answered = true
        // A voice call lets the screen go dark (held to the ear, or put down); video keeps it on.
        if (!withVideo) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        Graph.calls.setMinimized(false)
        Graph.calls.answerFromNotification(id, withVideo)
        lifecycleScope.launch {
            // The call reaches the app (it may already have), then this screen stays until it's over.
            withTimeoutOrNull(REACH_MS) { Graph.calls.state.first { it.callId == id } } ?: return@launch finish()
            Graph.calls.state.first { it.callId != id }
            finish()
        }
        // Shrink (or Back) means the rest of the app: that needs unlocking.
        lifecycleScope.launch {
            Graph.calls.state.map { it.minimized }.distinctUntilChanged().filter { it }.collect { openApp() }
        }
        unlocked = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) = openApp()
        }.also { ContextCompat.registerReceiver(this, it, IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_NOT_EXPORTED) }
    }

    /** The app takes the call over (unlocking first, if the phone is locked). */
    private fun openApp() {
        val go = {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
        }
        val km = getSystemService(KeyguardManager::class.java)
        if (km?.isKeyguardLocked != true) return go()
        if (Build.VERSION.SDK_INT < 26) return Graph.calls.setMinimized(false)
        km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = go()
            // Still locked: the call screen stays.
            override fun onDismissCancelled() = Graph.calls.setMinimized(false)
            override fun onDismissError() = Graph.calls.setMinimized(false)
        })
    }

    override fun onDestroy() {
        unlocked?.let { runCatching { unregisterReceiver(it) } }
        if (current.get() === this) current.clear()
        super.onDestroy()
    }
}
