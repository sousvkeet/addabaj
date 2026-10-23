package com.addakhana.app.ui.watch

import android.app.Activity
import android.content.Context
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Podcasts
import androidx.compose.material.icons.rounded.ScreenShare
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.DeviceStream
import com.addakhana.app.model.Room
import com.addakhana.app.model.WatchState
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.call.Bar
import com.addakhana.app.ui.call.BarButton
import com.addakhana.app.ui.call.VideoView
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.duration
import com.addakhana.app.ui.theme.palette
import com.addakhana.app.watch.LiveHost
import com.addakhana.app.watch.LiveViewer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Where the host's file is now, from the room's last shared state. */
private fun positionOf(w: WatchState) = if (w.playing) w.position + maxOf(0L, Graph.site.serverNow() - w.at) / 1000.0 else w.position

/** A live stream is mine to host (this phone is sending it). */
@Composable
internal fun hosting(roomId: String, device: DeviceStream): LiveHost? {
    val live by Graph.live.state.collectAsState()
    val host = live.host ?: return null
    val mine = host.roomId == roomId && device.hostId == Graph.auth.user?.id && (host.sessionId == device.sessionId || host.sessionId.isEmpty())
    return host.takeIf { mine }
}

/** A live stream from an admin's phone or computer: the host sees what they send, everyone else the stream. */
@Composable
fun LiveView(room: Room, w: WatchState, small: Boolean) {
    val device = w.source.device ?: return
    val live by Graph.live.state.collectAsState()
    val host = hosting(room.id, device)
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (host != null) HostView(host, live.preview, w, small)
        else ViewerView(room, w, device, live.viewer?.takeIf { it.sessionId == device.sessionId }, live.muted, small)
        if (!small) {
            val watching = host?.viewers?.values?.count { it == "connected" } ?: 0
            Row(Modifier.align(Alignment.TopStart).padding(8.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                RecDot()
                Text(" LIVE", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                Text(" · " + if (host != null) "$watching watching" else device.hostName, color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            }
        }
    }
}

@Composable
private fun RecDot() {
    val p = palette
    val t = rememberInfiniteTransition(label = "rec")
    val a by t.animateFloat(1f, 0.35f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse), label = "a")
    Box(Modifier.size(8.dp).alpha(a).clip(CircleShape).background(p.danger))
}

@Composable
private fun SoundOnly(label: String) {
    val p = palette
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Rounded.GraphicEq, null, tint = p.live, modifier = Modifier.size(34.dp))
        Spacer(Modifier.height(8.dp))
        Text(label, color = Color.White.copy(alpha = 0.8f), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

private val shade = Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.8f)))

// ── The host ─────────────────────────────────────────────────────────

@Composable
private fun HostView(host: LiveHost, preview: org.webrtc.VideoTrack?, w: WatchState, small: Boolean) {
    val p = palette
    val roomMuted = w.muted != null
    Box(Modifier.fillMaxSize()) {
        if (preview != null) VideoView(preview, Modifier.fillMaxSize(), fit = true) else SoundOnly("Streaming sound only")
        if (host.sessionId.isEmpty()) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) { Spinner(color = p.live) }
        if (small) return@Box
        host.soundNote?.let { note ->
            Row(Modifier.align(Alignment.TopEnd).padding(8.dp).fillMaxWidth(0.6f), horizontalArrangement = Arrangement.End) {
                Row(Modifier.clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.GraphicEq, null, tint = Color.White, modifier = Modifier.size(13.dp))
                    Text(" $note", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(shade).padding(start = 6.dp, end = 6.dp, top = 22.dp, bottom = 4.dp)) {
            if (host.mode == "file") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBtn(
                        if (host.playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow,
                        if (host.playing) "Pause for everyone" else "Play for everyone",
                        { if (host.playing) Graph.live.pause() else Graph.live.play() },
                        size = 38.dp,
                        tint = Color.White,
                    )
                    Text("${duration(host.time)} / ${duration(host.duration)}", color = Color.White, fontSize = 12.5.sp)
                    Slider(
                        value = host.time.coerceAtMost(host.duration).toFloat(),
                        onValueChange = { Graph.live.seek(it.toDouble()) },
                        valueRange = 0f..maxOf(1f, host.duration.toFloat()),
                        colors = SliderDefaults.colors(thumbColor = p.live, activeTrackColor = p.live, inactiveTrackColor = Color.White.copy(alpha = 0.25f)),
                        modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                    )
                    IconBtn(
                        if (roomMuted || host.muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp,
                        if (roomMuted) "Muted for everyone" else if (host.muted) "Unmute (only for you)" else "Mute (only for you)",
                        { if (roomMuted) Toasts.show("${w.muted?.byName ?: "An admin"} muted the video for everyone. Turn its sound back on with “Unmute for everyone”.") else Graph.live.setHostMuted(!host.muted) },
                        size = 34.dp,
                        tint = Color.White,
                    )
                    IconBtn(Icons.Rounded.Fullscreen, "Full screen", { Graph.watch.setFullscreen(true) }, size = 34.dp, tint = Color.White)
                }
            } else {
                Text(
                    "Everyone watching sees your screen, even while you use other apps. The picture is shared, not the sound.",
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 12.5.sp,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
                )
            }
        }
    }
}

// ── Everyone else ────────────────────────────────────────────────────

@Composable
private fun ViewerView(room: Room, w: WatchState, device: DeviceStream, viewer: LiveViewer?, muted: Boolean, small: Boolean) {
    val p = palette
    val roomMuted = w.muted != null
    val status = viewer?.status ?: "connecting"
    val video = viewer?.video
    // The progress bar moves along while the host's file plays.
    var position by remember { mutableDoubleStateOf(0.0) }
    LaunchedEffect(w, device.duration) {
        while (true) {
            position = minOf(positionOf(w), device.duration ?: Double.MAX_VALUE)
            if (device.mode != "file" || !w.playing) break
            delay(1_000)
        }
    }
    val ended = device.duration != null && position >= device.duration - 0.5
    val connected = video != null || viewer?.sound == true
    Box(Modifier.fillMaxSize()) {
        if (video != null) VideoView(video, Modifier.fillMaxSize(), fit = true)
        else if (viewer?.sound == true) SoundOnly("Listening to ${device.hostName}")
        if (!connected && status != "failed") {
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Spinner(size = if (small) 18.dp else 26.dp, color = p.live)
                if (!small) {
                    Spacer(Modifier.height(10.dp))
                    Text(if (status == "retrying") "Reconnecting…" else "Connecting to ${device.hostName}'s stream…", color = Color.White, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        if (connected && status == "retrying" && !small) {
            Row(Modifier.align(Alignment.TopEnd).padding(8.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner(size = 12.dp, color = Color.White)
                Text(" Reconnecting…", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        if (status == "failed") {
            Box(Modifier.fillMaxSize().background(p.deep.copy(alpha = 0.95f)).padding(if (small) 8.dp else 24.dp), contentAlignment = Alignment.Center) {
                Text(viewer?.error ?: "Couldn't connect to the stream.", color = p.onBrand, fontSize = if (small) 11.sp else 14.5.sp)
            }
        }
        if (connected && device.mode == "file" && !w.playing && !small) {
            Row(Modifier.align(Alignment.Center).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Pause, null, tint = Color.White, modifier = Modifier.size(16.dp))
                Text(if (ended) "  The video has ended" else "  Paused by ${device.hostName}", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        if (connected && !small) {
            Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(shade).padding(start = 10.dp, end = 4.dp, top = 18.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                val total = device.duration
                if (device.mode == "file" && total != null && total > 0) {
                    Text("${duration(position)} / ${duration(total)}", color = Color.White, fontSize = 12.5.sp)
                    LinearProgressIndicator(
                        progress = { (position / total).toFloat().coerceIn(0f, 1f) },
                        modifier = Modifier.weight(1f).padding(horizontal = 10.dp).height(4.dp).clip(RoundedCornerShape(50)),
                        color = p.live,
                        trackColor = Color.White.copy(alpha = 0.25f),
                    )
                } else Spacer(Modifier.weight(1f))
                IconBtn(
                    if (roomMuted || muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp,
                    if (roomMuted) "Muted for everyone" else if (muted) "Unmute" else "Mute",
                    {
                        if (roomMuted) Toasts.show("${w.muted?.byName ?: "An admin"} muted the video for everyone. " + if (room.myRole == "admin") "Turn its sound back on with “Unmute for everyone”." else "Only an admin can turn its sound back on.")
                        else Graph.live.setViewerMuted(!muted)
                    },
                    size = 34.dp,
                    tint = Color.White,
                )
                IconBtn(Icons.Rounded.Fullscreen, "Full screen", { Graph.watch.setFullscreen(true) }, size = 34.dp, tint = Color.White)
            }
        }
    }
}

// ── Starting one ─────────────────────────────────────────────────────

private fun nameOf(c: Context, uri: Uri): String =
    runCatching {
        c.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull() ?: "Video"

/** Stream a video file playing on this phone, or share the screen, live to the room. */
@Composable
fun DeviceSource(roomId: String, onDone: () -> Unit) {
    val p = palette
    val context = LocalContext.current
    val co = rememberCoroutineScope()
    var busy by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val maxViewers = Graph.site.config.collectAsState().value.limits.liveViewers

    fun start(kind: String, run: suspend () -> Unit) {
        busy = kind
        error = null
        co.launch {
            try {
                run()
                onDone()
            } catch (e: Exception) {
                error = e.message ?: "Couldn't start the stream."
            } finally {
                busy = ""
            }
        }
    }

    val file = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) start("file") { Graph.live.startFile(roomId, uri, nameOf(context, uri)) }
    }
    val screen = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) start("screen") { Graph.live.startScreen(roomId, data) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SourceOption(
            Icons.Rounded.Movie,
            "Stream a video file",
            "Plays here and streams live to the room, with your play, pause and seek.",
            null,
            busy == "file",
            busy.isEmpty(),
        ) { file.launch("video/*") }
        SourceOption(
            Icons.Rounded.ScreenShare,
            "Share your screen",
            "Everyone watching sees your screen, even while you use other apps. The picture is shared, not the sound.",
            null,
            busy == "screen",
            busy.isEmpty(),
        ) {
            val manager = context.getSystemService(MediaProjectionManager::class.java)
            if (manager == null) error = "This phone can't share its screen." else screen.launch(manager.createScreenCaptureIntent())
        }
        Text(
            "The video goes from this phone to each person watching, so your upload speed matters, and up to $maxViewers people can watch. Adda Khana keeps streaming in the background until you stop.",
            color = p.inkSoft,
            fontSize = 13.sp,
        )
        error?.let {
            Text(it, color = p.danger, fontSize = 14.sp, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.danger.copy(alpha = 0.1f)).padding(horizontal = 12.dp, vertical = 9.dp))
        }
    }
}

// ── Away from the room ───────────────────────────────────────────────

/** My live stream, while I'm elsewhere in the app: where it goes, how many watch, pause and stop. */
@Composable
fun StreamBar() {
    val p = palette
    val live by Graph.live.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    val host = live.host ?: return
    val co = rememberCoroutineScope()
    val watching = host.viewers.values.count { it == "connected" }
    Bar(onClick = { Nav.push(Screen.Room(host.roomId)) }) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(p.danger), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Podcasts, null, tint = Color.White, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("Live in ${chat.rooms[host.roomId]?.name ?: "the room"}", color = Color.White, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${host.title}, $watching watching", color = Color.White.copy(alpha = 0.75f), fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (host.mode == "file") {
            BarButton(if (host.playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (host.playing) "Pause for everyone" else "Play for everyone", { if (host.playing) Graph.live.pause() else Graph.live.play() })
        }
        BarButton(Icons.Rounded.Stop, "Stop streaming", { co.launch { Graph.live.stop() } }, danger = true)
    }
}
