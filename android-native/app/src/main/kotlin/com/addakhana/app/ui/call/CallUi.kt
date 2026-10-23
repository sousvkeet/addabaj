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
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.material.icons.rounded.GridView
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

/**
 * The call full screen. A video call: both of you on the stage (VideoStage),
 * them full screen and you floating in a corner to begin with; a voice
 * call: their picture. The buttons, and the name and time at the top.
 */
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
    val first = peer.name.split(' ').first()
    val me = Graph.auth.user
    val myId = me?.id ?: "me"
    val layout = if (call.videoCall) {
        Stages.of("call:${peer.id}") {
            set(peer.id, Mode.Full)
            set(myId, Mode.Floating)
        }
    } else {
        null
    }
    val header: @Composable () -> Unit = {
        Row(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent))).statusBarsPadding().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(peer.name, color = Color.White, fontSize = 21.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(status, color = Color.White.copy(alpha = 0.8f), fontSize = 14.sp)
            }
            if (layout?.arranged == true) {
                RoundButton(Icons.Rounded.GridView, "Show you both side by side", { layout.everyoneToGrid() }, 44.dp)
                Spacer(Modifier.width(8.dp))
            }
            RoundButton(Icons.Rounded.Tune, "Audio and video settings", { settings = true }, 44.dp)
            Spacer(Modifier.width(8.dp))
            RoundButton(Icons.Rounded.CloseFullscreen, "Shrink", { Graph.calls.setMinimized(true) }, 44.dp)
        }
    }
    val controls: @Composable () -> Unit = {
        Row(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.5f)))).navigationBarsPadding().padding(top = 16.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            RoundButton(if (call.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (call.muted) "Unmute microphone" else "Mute microphone", { Graph.calls.toggleMute() }, background = if (call.muted) SolidColor(Color.White) else SolidColor(Color.White.copy(alpha = 0.14f)), tint = if (call.muted) p.deep else Color.White)
            RoundButton(if (call.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, if (call.cameraOn) "Turn camera off" else "Turn camera on", { if (call.cameraOn) Graph.calls.toggleCamera() else ask(true) })
            if (call.cameraOn) RoundButton(Icons.Rounded.Cameraswitch, "Switch camera", { Graph.calls.switchCamera() })
            RoundButton(if (call.speaker) Icons.Rounded.VolumeUp else Icons.Rounded.Hearing, if (call.speaker) "Use the earpiece" else "Use the loudspeaker", { Graph.calls.setSpeaker(!call.speaker) }, background = if (call.speaker) SolidColor(Color.White) else SolidColor(Color.White.copy(alpha = 0.14f)), tint = if (call.speaker) p.deep else Color.White)
            RoundButton(Icons.Rounded.CallEnd, if (call.phase == "outgoing") "Cancel call" else "End call", { Graph.calls.endCall() }, background = SolidColor(p.danger))
        }
    }
    if (layout != null) {
        val feeds = listOfNotNull(
            Feed(
                peer.id, peer.name, peer.hue, peer.photo,
                video = call.remoteVideo.takeIf { call.peerCameraOn },
                speaking = call.remoteSpeaking,
                muted = call.peerMuted,
                caption = if (call.phase == "outgoing") "Calling $first…" else "$first's camera is off",
            ),
            // Me while my camera's on (where I was put stays for when it's back).
            call.localVideo?.takeIf { call.cameraOn }?.let { video ->
                Feed(myId, me?.name ?: "You", me?.hue ?: 260, me?.photo, video = video, mirror = call.frontCamera, mine = true, speaking = call.localSpeaking)
            },
        )
        VideoStage(feeds, layout, header, controls, labels = false, everyone = setOf(peer.id, myId))
    } else {
        Box(Modifier.fillMaxSize().background(p.deep)) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(peer.name, peer.hue, peer.photo, 112.dp, ring = call.remoteSpeaking)
                Spacer(Modifier.height(16.dp))
                Text(peer.name, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                Text(if (call.phase == "outgoing") "Calling $first…" else status, color = Color.White.copy(alpha = 0.75f), fontSize = 15.sp)
            }
            Box(Modifier.align(Alignment.TopCenter)) { header() }
            Box(Modifier.align(Alignment.BottomCenter)) { controls() }
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
 * The room's video call: everyone on the stage (VideoStage), with their
 * camera or their photo, in a grid to begin with. Anyone can be made full
 * screen or floated in a small window. Each picture's size is told to its
 * sender, so they send just that.
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
    val layout = Stages.of("room:$roomId")
    var settings by remember { mutableStateOf(false) }
    if (settings) com.addakhana.app.ui.home.DeviceSettings { settings = false }
    // Back: someone full screen goes back to the grid first.
    BackHandler {
        val full = layout.full
        if (full != null) layout.set(full, Mode.Grid) else Graph.voice.setMinimized(true)
    }
    val camAsk = rememberMediaPermission { ok, video -> if (ok && video) Graph.voice.toggleCamera() }
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { Graph.voice.setViews(emptyMap()) } }
    val feeds = people.map { v ->
        val mine = v.userId == me
        val m = members[v.userId]
        val track = if (mine) voice.localVideo else voice.videos[v.userId]
        Feed(
            id = v.userId,
            name = m?.name ?: chat.users[v.userId]?.name ?: "?",
            hue = m?.hue ?: 260,
            photo = m?.photo,
            video = track?.takeIf { (v.camera || mine && voice.cameraOn) && !v.cameraBlocked },
            mirror = mine && voice.frontCamera,
            mine = mine,
            speaking = voice.speaking[v.userId] == true,
            muted = v.muted,
            silenced = v.silenced,
            note = when {
                v.away -> ", reconnecting…"
                !mine && voice.connection[v.userId]?.let { it != org.webrtc.PeerConnection.PeerConnectionState.CONNECTED } == true -> ", connecting…"
                else -> ""
            },
        )
    }
    VideoStage(
        feeds = feeds,
        layout = layout,
        header = {
            Row(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent))).statusBarsPadding().padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(room?.name ?: "Room call", color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${people.size} in the call, ${people.count { it.camera }} on camera", color = Color.White.copy(alpha = 0.75f), fontSize = 13.sp)
                }
                if (layout.arranged) {
                    RoundButton(Icons.Rounded.GridView, "Everyone back to the grid", { layout.everyoneToGrid() }, 44.dp)
                    Spacer(Modifier.width(8.dp))
                }
                RoundButton(Icons.Rounded.Tune, "Audio and video settings", { settings = true }, 44.dp)
                Spacer(Modifier.width(8.dp))
                RoundButton(Icons.Rounded.CloseFullscreen, "Shrink", { Graph.voice.setMinimized(true) }, 44.dp)
            }
        },
        controls = {
            Row(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.55f)))).navigationBarsPadding().padding(vertical = 16.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                RoundButton(if (voice.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (voice.muted) "Unmute" else "Mute", { Graph.voice.toggleMute() }, 48.dp, background = if (voice.muted) SolidColor(Color.White) else SolidColor(Color.White.copy(alpha = 0.14f)), tint = if (voice.muted) p.deep else Color.White)
                RoundButton(if (voice.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, "Camera", { if (voice.cameraOn) Graph.voice.toggleCamera() else camAsk(true) }, 48.dp)
                if (voice.cameraOn) RoundButton(Icons.Rounded.Cameraswitch, "Switch camera", { Graph.voice.switchCamera() }, 48.dp)
                RoundButton(Icons.Rounded.CallEnd, "Leave the call", { Graph.voice.leave() }, 48.dp, background = SolidColor(p.danger))
            }
        },
        // Each person's picture size, told to them (in device pixels), so they send just that.
        onShown = { sizes ->
            Graph.voice.setViews(
                people.filter { it.userId != me && it.camera }.associate { v ->
                    val px = sizes[v.userId] ?: 0
                    v.userId to when {
                        px < 340 -> View.Small
                        px < 680 -> View.Medium
                        else -> View.Large
                    }
                },
            )
        },
    )
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
            // Whoever was made full screen (on camera), else whoever's speaking on camera, else anyone on camera, else whoever's speaking.
            val chosen = voice.roomId?.let { Stages.current("room:$it")?.full }
            val main = people.firstOrNull { it.userId == chosen && it.camera && it.userId != me }
                ?: people.firstOrNull { it.userId != me && it.camera && voice.speaking[it.userId] == true }
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
