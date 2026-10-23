package com.addakhana.app.ui.call

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Cameraswitch
import androidx.compose.material.icons.rounded.CloseFullscreen
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Hearing
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.addakhana.app.Graph
import com.addakhana.app.call.View
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.Room
import com.addakhana.app.rtc.Rtc
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.duration
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import kotlin.math.ceil
import kotlin.math.sqrt

/** A camera's picture (libwebrtc's renderer). `overlay`: drawn above other video (the self view). */
@Composable
fun VideoView(track: VideoTrack?, modifier: Modifier = Modifier, mirror: Boolean = false, fit: Boolean = false, overlay: Boolean = false) {
    AndroidView(
        factory = { ctx ->
            SurfaceViewRenderer(ctx).apply {
                init(Rtc.egl.eglBaseContext, null)
                setEnableHardwareScaler(true)
                if (overlay) setZOrderMediaOverlay(true)
            }
        },
        update = { r ->
            r.setMirror(mirror)
            r.setScalingType(if (fit) RendererCommon.ScalingType.SCALE_ASPECT_FIT else RendererCommon.ScalingType.SCALE_ASPECT_FILL)
            val was = r.tag as? VideoTrack
            if (was !== track) {
                runCatching { was?.removeSink(r) }
                runCatching { track?.addSink(r) }
                r.tag = track
                if (track == null) r.clearImage()
            }
        },
        onRelease = { r ->
            runCatching { (r.tag as? VideoTrack)?.removeSink(r) }
            r.release()
        },
        modifier = modifier,
    )
}

/** Asks for the microphone (and the camera, for video) when needed, then goes on. */
@Composable
fun rememberMediaPermission(onResult: (granted: Boolean, video: Boolean) -> Unit): (video: Boolean) -> Unit {
    val context = LocalContext.current
    var wantVideo by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val mic = result[Manifest.permission.RECORD_AUDIO] ?: (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        if (!mic) Toasts.error("Allow the microphone for calls and room voice (Settings › Apps › Adda Khana › Permissions).")
        val cam = !wantVideo || (result[Manifest.permission.CAMERA] ?: false)
        onResult(mic, wantVideo && cam)
    }
    return { video ->
        wantVideo = video
        val need = listOfNotNull(Manifest.permission.RECORD_AUDIO, if (video) Manifest.permission.CAMERA else null)
            .filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (need.isEmpty()) onResult(true, video) else launcher.launch(need.toTypedArray())
    }
}

@Composable
private fun RoundButton(icon: ImageVector, label: String, onClick: () -> Unit, size: Dp = 56.dp, background: Brush = SolidColor(Color.White.copy(alpha = 0.14f)), tint: Color = Color.White, caption: String? = null) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(size).clip(CircleShape).background(background).clickable(onClickLabel = label, onClick = onClick), contentAlignment = Alignment.Center) {
            Icon(icon, label, tint = tint, modifier = Modifier.size(size * 0.45f))
        }
        if (caption != null) Text(caption, color = Color.White.copy(alpha = 0.85f), fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
    }
}

/** Two live rings growing out of the avatar, as the web app's ring-pulse. */
@Composable
private fun PulsingAvatar(name: String, hue: Int, photo: String?, size: Dp) {
    val p = palette
    val t = rememberInfiniteTransition(label = "ring")
    val a by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1_800, easing = LinearEasing)), label = "a")
    Box(contentAlignment = Alignment.Center) {
        for (offset in listOf(0f, 0.5f)) {
            val v = (a + offset) % 1f
            Box(Modifier.size(size).scale(1f + 0.45f * v).border(3.dp, p.live.copy(alpha = 1f - v), CircleShape))
        }
        Avatar(name, hue, photo, size)
    }
}

// ── One-to-one calls ──────────────────────────────────────────────────

/** "Incoming voice call": Decline, Voice only (for video calls) and Accept. Back can't dismiss it. */
@Composable
fun IncomingCallScreen() {
    val p = palette
    val call by Graph.calls.state.collectAsState()
    val peer = call.peer ?: return
    BackHandler { }
    val ask = rememberMediaPermission { ok, video -> if (ok) Graph.calls.acceptCall(video) else Graph.calls.declineCall() }
    Box(Modifier.fillMaxSize().background(Color(0x9E060816))) {
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp))
                .background(p.deep)
                .navigationBarsPadding()
                .padding(top = 36.dp, bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            PulsingAvatar(peer.name, peer.hue, peer.photo, 104.dp)
            Spacer(Modifier.height(24.dp))
            Text(if (call.videoCall) "Incoming video call" else "Incoming voice call", color = p.inkSoft, fontSize = 15.sp)
            Text(peer.name, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 24.dp))
            Spacer(Modifier.height(32.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                RoundButton(Icons.Rounded.CallEnd, "Decline", { Graph.calls.declineCall() }, 64.dp, SolidColor(p.danger), caption = "Decline")
                if (call.videoCall) RoundButton(Icons.Rounded.Call, "Voice only", { ask(false) }, 64.dp, caption = "Voice only")
                RoundButton(
                    if (call.videoCall) Icons.Rounded.Videocam else Icons.Rounded.Call,
                    if (call.videoCall) "Accept with video" else "Accept",
                    { ask(call.videoCall) },
                    64.dp,
                    SolidColor(p.live),
                    tint = p.onLive,
                    caption = if (call.accepting) "Connecting…" else if (call.videoCall) "With video" else "Accept",
                )
            }
        }
    }
}

/** How a call is going, in words: "Calling…", "Reconnecting…", "No sound arriving", or its time. */
@Composable
fun callStatus(): String {
    val call by Graph.calls.state.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(call.startedAt) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val base = when {
        call.phase == "outgoing" -> "Calling…"
        call.phase == "connecting" -> "Connecting…"
        call.reconnecting -> "Reconnecting…"
        call.noIncomingAudio -> "No sound arriving"
        call.startedAt != null -> duration((now - call.startedAt!!) / 1000.0)
        else -> ""
    }
    return base + if (call.muted) ", muted" else ""
}

/** The call full screen: the other person's video (or their picture), my camera in the corner, the buttons. */
@Composable
fun CallStage() {
    val p = palette
    val call by Graph.calls.state.collectAsState()
    val peer = call.peer ?: return
    BackHandler { Graph.calls.setMinimized(true) }
    val ask = rememberMediaPermission { ok, video -> if (ok && video) Graph.calls.toggleCamera() }
    val status = callStatus()
    var settings by remember { mutableStateOf(false) }
    if (settings) com.addakhana.app.ui.home.DeviceSettings { settings = false }
    Box(Modifier.fillMaxSize().background(p.deep)) {
        if (call.peerCameraOn && call.remoteVideo != null) {
            VideoView(call.remoteVideo, Modifier.fillMaxSize())
        } else {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(peer.name, peer.hue, peer.photo, 112.dp, ring = call.remoteSpeaking)
                Spacer(Modifier.height(16.dp))
                Text(peer.name, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                Text(
                    if (call.phase == "outgoing") "Calling ${peer.name.split(' ').first()}…" else if (call.videoCall) "${peer.name.split(' ').first()}'s camera is off" else status,
                    color = Color.White.copy(alpha = 0.75f),
                    fontSize = 15.sp,
                )
            }
        }
        // Top: name and status, and Shrink.
        Row(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent))).statusBarsPadding().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(peer.name, color = Color.White, fontSize = 21.sp, fontWeight = FontWeight.SemiBold)
                Text(status, color = Color.White.copy(alpha = 0.8f), fontSize = 14.sp)
            }
            RoundButton(Icons.Rounded.Tune, "Audio and video settings", { settings = true }, 44.dp)
            Spacer(Modifier.width(8.dp))
            RoundButton(Icons.Rounded.CloseFullscreen, "Shrink", { Graph.calls.setMinimized(true) }, 44.dp)
        }
        if (call.localVideo != null) {
            BoxWithConstraints(Modifier.align(Alignment.BottomEnd).padding(end = 14.dp, bottom = 130.dp)) {
                VideoView(
                    call.localVideo,
                    Modifier.width((maxWidth * 0.3f).coerceIn(96.dp, 190.dp)).aspectRatio(3f / 4f).clip(RoundedCornerShape(16.dp)),
                    mirror = call.frontCamera,
                    overlay = true,
                )
            }
        }
        Row(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(bottom = 24.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            RoundButton(if (call.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (call.muted) "Unmute microphone" else "Mute microphone", { Graph.calls.toggleMute() }, background = if (call.muted) SolidColor(Color.White) else SolidColor(Color.White.copy(alpha = 0.14f)), tint = if (call.muted) p.deep else Color.White)
            RoundButton(if (call.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, if (call.cameraOn) "Turn camera off" else "Turn camera on", { if (call.cameraOn) Graph.calls.toggleCamera() else ask(true) })
            if (call.cameraOn) RoundButton(Icons.Rounded.Cameraswitch, "Switch camera", { Graph.calls.switchCamera() })
            RoundButton(if (call.speaker) Icons.Rounded.VolumeUp else Icons.Rounded.Hearing, if (call.speaker) "Use the earpiece" else "Use the loudspeaker", { Graph.calls.setSpeaker(!call.speaker) }, background = if (call.speaker) SolidColor(Color.White) else SolidColor(Color.White.copy(alpha = 0.14f)), tint = if (call.speaker) p.deep else Color.White)
            RoundButton(Icons.Rounded.CallEnd, if (call.phase == "outgoing") "Cancel call" else "End call", { Graph.calls.endCall() }, background = SolidColor(p.danger))
        }
    }
}

/** The call shrunk to a bar at the top: tap to open it again. */
@Composable
fun CallBar() {
    val p = palette
    val call by Graph.calls.state.collectAsState()
    val peer = call.peer ?: return
    val status = callStatus()
    Bar(onClick = { Graph.calls.setMinimized(false) }) {
        Avatar(peer.name, peer.hue, peer.photo, 40.dp, ring = call.remoteSpeaking)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(peer.name, color = Color.White, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(status, color = Color.White.copy(alpha = 0.75f), fontSize = 13.sp)
        }
        BarButton(if (call.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (call.muted) "Unmute microphone" else "Mute microphone", { Graph.calls.toggleMute() }, on = call.muted)
        BarButton(Icons.Rounded.CallEnd, "End call", { Graph.calls.endCall() }, danger = true)
    }
}

@Composable
internal fun Bar(onClick: () -> Unit, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val p = palette
    Row(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 8.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(p.deep.copy(alpha = 0.94f))
            .border(1.dp, Color.White.copy(alpha = 0.08f), RoundedCornerShape(22.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
internal fun BarButton(icon: ImageVector, label: String, onClick: () -> Unit, on: Boolean = false, danger: Boolean = false) {
    val p = palette
    Box(
        Modifier.padding(start = 6.dp).size(38.dp).clip(CircleShape)
            .background(if (danger) p.danger else if (on) Color.White else Color.White.copy(alpha = 0.12f))
            .clickable(onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = if (on && !danger) p.deep else Color.White, modifier = Modifier.size(19.dp)) }
}

// ── Room voice ────────────────────────────────────────────────────────

/** In a room's voice: the bar at the top (tap to open the room). */
@Composable
fun VoiceBar() {
    val p = palette
    val voice by Graph.voice.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    val roomId = voice.roomId ?: return
    val room = chat.rooms[roomId]
    val others = chat.voice[roomId].orEmpty().count { it.userId != Graph.auth.user?.id }
    val cams = chat.voice[roomId].orEmpty().count { it.camera }
    Bar(onClick = {
        if (cams > 0) Graph.voice.setMinimized(false) else Nav.push(Screen.Room(roomId))
    }) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(p.live), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.GraphicEq, null, tint = p.onLive)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(room?.name ?: "Room voice", color = Color.White, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                when {
                    voice.status == "joining" -> "Joining voice…"
                    voice.reconnecting -> "Reconnecting…"
                    cams > 0 -> "$cams on camera, tap to see"
                    others == 0 -> "Only you so far"
                    else -> "Talking with $others other${if (others == 1) "" else "s"}"
                },
                color = Color.White.copy(alpha = 0.75f),
                fontSize = 13.sp,
            )
        }
        BarButton(if (voice.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, "Camera", { Graph.voice.toggleCamera() }, on = voice.cameraOn)
        BarButton(if (voice.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (voice.muted) "Unmute" else "Mute", { Graph.voice.toggleMute() }, on = voice.muted)
        BarButton(Icons.Rounded.CallEnd, "Leave voice", { Graph.voice.leave() }, danger = true)
    }
}

/**
 * "The adda table", in Room info: who's in voice around a table, lighting
 * up while they talk; Join (or with video), Mute, Camera, Leave.
 */
@Composable
fun VoiceTable(room: Room) {
    val p = palette
    val voice by Graph.voice.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    val call by Graph.calls.state.collectAsState()
    val people = chat.voice[room.id].orEmpty()
    val here = voice.roomId == room.id && voice.active
    val seats = Graph.site.config.value.limits.voiceSeats
    val members = chat.roomDetails[room.id]?.members.orEmpty().associateBy { it.id }
    val ask = rememberMediaPermission { ok, video -> if (ok) Graph.voice.join(room.id, video) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).clip(RoundedCornerShape(20.dp)).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), RoundedCornerShape(20.dp)).padding(16.dp)) {
        Text("Voice", color = p.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Box(Modifier.fillMaxWidth().height(278.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(196.dp).border(1.dp, p.line, CircleShape))
            Column(Modifier.size(100.dp).clip(CircleShape).background(p.subtle).border(2.dp, p.brand.copy(alpha = 0.5f), CircleShape), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(Icons.Rounded.GraphicEq, null, tint = p.brand)
                Text(if (people.isEmpty()) "No one is talking yet" else "${people.size} at the table", color = p.inkSoft, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp), maxLines = 2)
            }
            val size = when {
                people.size <= 6 -> 52.dp
                people.size <= 9 -> 44.dp
                else -> 38.dp
            }
            val radius = with(LocalDensity.current) { 98.dp.toPx() }
            people.forEachIndexed { i, v ->
                val angle = -Math.PI / 2 + 2 * Math.PI * i / people.size
                val m = members[v.userId]
                val name = m?.name ?: chat.users[v.userId]?.name ?: "?"
                Box(Modifier.align(Alignment.Center).offset { androidx.compose.ui.unit.IntOffset((radius * kotlin.math.cos(angle)).toInt(), (radius * kotlin.math.sin(angle)).toInt()) }) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box {
                            Avatar(name, m?.hue ?: 260, m?.photo, size, ring = voice.speaking[v.userId] == true)
                            if (v.muted || v.silenced) Box(Modifier.align(Alignment.BottomEnd).size(18.dp).clip(CircleShape).background(p.danger), contentAlignment = Alignment.Center) {
                                Icon(Icons.Rounded.MicOff, "Muted", tint = Color.White, modifier = Modifier.size(11.dp))
                            }
                            if (v.camera) Box(Modifier.align(Alignment.TopEnd).size(20.dp).clip(CircleShape).background(p.brand), contentAlignment = Alignment.Center) {
                                Icon(Icons.Rounded.Videocam, "Camera on", tint = Color.White, modifier = Modifier.size(12.dp))
                            }
                        }
                        if (people.size <= 8) Text(name.split(' ').first() + if (v.away) "…" else "", color = p.inkSoft, fontSize = 11.sp, maxLines = 1)
                    }
                }
            }
        }
        val full = people.size >= seats && !here
        if (!here) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AddaButton(if (full) "Voice is full" else "Join voice", { ask(false) }, Modifier.weight(1f), variant = Variant.Live, enabled = !full && call.idle)
                AddaButton("Join with video", { ask(true) }, Modifier.weight(1f), variant = Variant.Soft, enabled = !full && call.idle)
            }
            if (!call.idle) Text("End your call to join voice.", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
            Text("Up to $seats people can talk at once, cameras on or off.", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 8.dp))
        } else if (voice.status == "joining") {
            AddaButton("Joining…", {}, Modifier.fillMaxWidth(), variant = Variant.Live, loading = true)
        } else {
            val camAsk = rememberMediaPermission { ok, video -> if (ok && video) Graph.voice.toggleCamera() }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AddaButton(if (voice.moderation.voiceMuted) "Muted" else if (voice.muted) "Unmute" else "Mute", { Graph.voice.toggleMute() }, Modifier.weight(1f), variant = if (voice.muted) Variant.Primary else Variant.Soft, icon = if (voice.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic)
                AddaButton("Camera", { if (voice.cameraOn) Graph.voice.toggleCamera() else camAsk(true) }, Modifier.weight(1f), variant = if (voice.cameraOn) Variant.Primary else Variant.Soft, icon = if (voice.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff)
                AddaButton("Leave", { Graph.voice.leave() }, Modifier.weight(1f), variant = Variant.DangerSoft)
            }
            val cams = people.count { it.camera }
            if (cams > 0) AddaButton("Show video ($cams on camera)", { Graph.voice.setMinimized(false) }, Modifier.fillMaxWidth().padding(top = 8.dp), variant = Variant.Soft, icon = Icons.Rounded.Videocam)
            AwayCard()
        }
    }
}

/** In voice, if something on the phone could still stop it once you leave the app: the setting that would. */
@Composable
private fun AwayCard() {
    val p = palette
    val items by com.addakhana.app.data.Permissions.items.collectAsState()
    val ask = com.addakhana.app.ui.home.rememberAsk()
    val texts = mapOf(
        "battery" to ("Let Adda Khana run in the background, so voice goes on when you leave the app or lock the phone." to "Allow"),
        "background" to ("Android holds Adda Khana back in the background: voice can stop when you leave the app." to "Settings"),
        "samsung" to ("On Samsung phones, add Adda Khana to Never sleeping apps, so voice goes on when you leave the app." to "Open"),
    )
    val away = items.firstOrNull { it.key in texts && it.status != com.addakhana.app.data.Permissions.Status.Granted && it.status != com.addakhana.app.data.Permissions.Status.Opened } ?: return
    val (text, action) = texts.getValue(away.key)
    Row(Modifier.fillMaxWidth().padding(top = 10.dp).clip(RoundedCornerShape(16.dp)).background(p.subtle).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, color = p.ink, fontSize = 13.5.sp, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(8.dp))
        AddaButton(action, { ask(away.key) }, height = 36.dp)
    }
}

/**
 * The room's video call: everyone as a tile (their camera, or their photo),
 * the one tapped large with the others in a row; my camera too. Each tile's
 * size is told to its sender, so they send just that.
 */
@Composable
fun RoomCallStage() {
    val p = palette
    val voice by Graph.voice.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    val roomId = voice.roomId ?: return
    val me = Graph.auth.user?.id
    val room = chat.rooms[roomId]
    val members = chat.roomDetails[roomId]?.members.orEmpty().associateBy { it.id }
    val people = chat.voice[roomId].orEmpty()
    var focused by remember { mutableStateOf<String?>(null) }
    var settings by remember { mutableStateOf(false) }
    if (settings) com.addakhana.app.ui.home.DeviceSettings { settings = false }
    BackHandler { Graph.voice.setMinimized(true) }
    val camAsk = rememberMediaPermission { ok, video -> if (ok && video) Graph.voice.toggleCamera() }
    Column(Modifier.fillMaxSize().background(p.deep)) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(room?.name ?: "Room call", color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                Text("${people.size} in the call, ${people.count { it.camera }} on camera", color = Color.White.copy(alpha = 0.75f), fontSize = 13.sp)
            }
            RoundButton(Icons.Rounded.Tune, "Audio and video settings", { settings = true }, 44.dp)
            Spacer(Modifier.width(8.dp))
            RoundButton(Icons.Rounded.CloseFullscreen, "Shrink", { Graph.voice.setMinimized(true) }, 44.dp)
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().padding(8.dp)) {
            val density = LocalDensity.current
            val n = people.size.coerceAtLeast(1)
            val portrait = maxHeight > maxWidth
            // Columns that give the biggest tiles (3:4 standing, 4:3 lying).
            val cols = (1..n).maxByOrNull { c ->
                val rows = ceil(n / c.toDouble()).toFloat()
                val w = maxWidth.value / c
                val h = maxHeight.value / rows
                val aspect = if (portrait) 3f / 4f else 4f / 3f
                minOf(w, h * aspect) * minOf(w / aspect, h)
            } ?: 1
            val rows = ceil(n / cols.toDouble()).toInt()
            val tileW = maxWidth / cols
            val tileH = maxHeight / rows
            // Each person's tile size, told to them (in device pixels).
            LaunchedEffect(people.map { it.userId to it.camera }, cols, focused) {
                val views = people.filter { it.userId != me && it.camera }.associate { v ->
                    val px = with(density) { maxOf(if (focused == v.userId) maxWidth.toPx() else tileW.toPx(), tileH.toPx()) } * 1.0f
                    v.userId to when {
                        px < 340 -> View.Small
                        px < 680 -> View.Medium
                        else -> View.Large
                    }
                }
                Graph.voice.setViews(views)
            }
            androidx.compose.runtime.DisposableEffect(Unit) { onDispose { Graph.voice.setViews(emptyMap()) } }
            Column {
                for (r in 0 until rows) {
                    Row(Modifier.height(tileH)) {
                        for (c in 0 until cols) {
                            val i = r * cols + c
                            val v = people.getOrNull(i) ?: continue
                            val mine = v.userId == me
                            val m = members[v.userId]
                            val name = m?.name ?: chat.users[v.userId]?.name ?: "?"
                            val track = if (mine) voice.localVideo else voice.videos[v.userId]
                            Box(
                                Modifier.width(tileW).height(tileH).padding(4.dp).clip(RoundedCornerShape(16.dp)).background(Color(0xFF141A33))
                                    .then(if (voice.speaking[v.userId] == true) Modifier.border(2.dp, p.live, RoundedCornerShape(16.dp)) else Modifier)
                                    .clickable { focused = if (focused == v.userId) null else v.userId },
                                contentAlignment = Alignment.Center,
                            ) {
                                if ((v.camera || mine && voice.cameraOn) && track != null && !v.cameraBlocked) {
                                    VideoView(track, Modifier.fillMaxSize(), mirror = mine && voice.frontCamera)
                                } else {
                                    Avatar(name, m?.hue ?: 260, m?.photo, 72.dp)
                                }
                                Row(Modifier.align(Alignment.BottomStart).padding(6.dp).clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                    if (v.muted || v.silenced) Icon(Icons.Rounded.MicOff, "Muted", tint = if (v.silenced) p.danger else p.live, modifier = Modifier.size(13.dp).padding(end = 2.dp))
                                    Text(
                                        (if (mine) "You" else name) + when {
                                            v.away -> ", reconnecting…"
                                            !mine && voice.connection[v.userId]?.let { it != org.webrtc.PeerConnection.PeerConnectionState.CONNECTED } == true -> ", connecting…"
                                            else -> ""
                                        },
                                        color = Color.White,
                                        fontSize = 12.sp,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(vertical = 16.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            RoundButton(if (voice.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (voice.muted) "Unmute" else "Mute", { Graph.voice.toggleMute() }, 48.dp, background = if (voice.muted) SolidColor(Color.White) else SolidColor(Color.White.copy(alpha = 0.14f)), tint = if (voice.muted) p.deep else Color.White)
            RoundButton(if (voice.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, "Camera", { if (voice.cameraOn) Graph.voice.toggleCamera() else camAsk(true) }, 48.dp)
            if (voice.cameraOn) RoundButton(Icons.Rounded.Cameraswitch, "Switch camera", { Graph.voice.switchCamera() }, 48.dp)
            RoundButton(Icons.Rounded.CallEnd, "Leave the call", { Graph.voice.leave() }, 48.dp, background = SolidColor(p.danger))
        }
    }
}

/** The call floating in Android's picture-in-picture window: the other person (or whoever's speaking on camera in a room). */
@Composable
fun PipView() {
    val p = palette
    val call by Graph.calls.state.collectAsState()
    val voice by Graph.voice.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    Box(Modifier.fillMaxSize().background(p.deep), contentAlignment = Alignment.Center) {
        if (call.inCall) {
            val peer = call.peer
            if (call.peerCameraOn && call.remoteVideo != null) VideoView(call.remoteVideo, Modifier.fillMaxSize())
            else if (peer != null) Avatar(peer.name, peer.hue, peer.photo, 72.dp, ring = call.remoteSpeaking)
        } else if (voice.live) {
            val me = Graph.auth.user?.id
            val people = chat.voice[voice.roomId].orEmpty()
            // Whoever's speaking on camera, else anyone on camera, else whoever's speaking.
            val main = people.firstOrNull { it.userId != me && it.camera && voice.speaking[it.userId] == true }
                ?: people.firstOrNull { it.userId != me && it.camera }
                ?: people.firstOrNull { it.userId != me && voice.speaking[it.userId] == true }
                ?: people.firstOrNull { it.userId != me }
            val track = main?.let { voice.videos[it.userId] }
            if (main?.camera == true && track != null) VideoView(track, Modifier.fillMaxSize())
            else main?.let { m ->
                val member = chat.roomDetails[voice.roomId]?.members?.firstOrNull { it.id == m.userId }
                Avatar(member?.name ?: "?", member?.hue ?: 260, member?.photo, 72.dp, ring = voice.speaking[m.userId] == true)
            }
        }
    }
}
