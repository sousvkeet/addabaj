package com.addakhana.app.ui.watch

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Cameraswitch
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.OpenInFull
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.addakhana.app.Graph
import com.addakhana.app.call.View
import com.addakhana.app.call.VoiceState
import com.addakhana.app.data.ChatState
import com.addakhana.app.ui.call.RoundButton
import com.addakhana.app.ui.call.StageVideo
import com.addakhana.app.ui.call.rememberMediaPermission
import com.addakhana.app.ui.theme.palette
import com.addakhana.app.watch.WatchUi
import kotlin.math.roundToInt

// A room's video call over its video: while the room's video plays on its
// page, the call's cameras float over the player instead of the call's screen
// covering it. Up to three windows, mine among them; with more cameras on, the
// others shown are the ones who spoke last. Each window moves (drag it) and
// resizes (drag a corner) on its own, always inside the player. The player
// itself is never touched, so the video plays on through all of it.

private const val MAX_WINDOWS = 3
/** Someone talking takes a window from whoever's been quiet at least this long. */
private const val QUIET_MS = 4_000L

/** The room of my call is showing its video on its page now. */
fun callRoomPlayerShown(voice: VoiceState, chat: ChatState, watch: WatchUi): Boolean {
    val id = voice.roomId ?: return false
    return voice.live && watch.roomId == id && watch.onPage && chat.roomDetails[id]?.watch != null
}

/** The call's cameras float over the room's video (rather than the call's own screen), and the video plays on. */
fun callsOnPlayer(voice: VoiceState, chat: ChatState, watch: WatchUi): Boolean {
    val id = voice.roomId ?: return false
    val cameras = chat.voice[id].orEmpty().any { it.camera } || voice.cameraOn
    return voice.onPlayer && cameras && callRoomPlayerShown(voice, chat, watch)
}

/** Where each window was left (fractions of the player), while the app runs: the player is rebuilt now and then. */
private object Placed {
    val spots = mutableStateMapOf<String, Rect>()
    val order = mutableStateListOf<String>()
    val lastSpoke = mutableMapOf<String, Long>()
    var picked: List<String> = emptyList()
}

private class Shown(val id: String, val key: String, val name: String, val track: livekit.org.webrtc.VideoTrack?, val mine: Boolean, val muted: Boolean, val silenced: Boolean, val speaking: Boolean)

/** My room call's cameras over the room's video (nothing when they aren't). */
@Composable
fun PlayerCalls(roomId: String, modifier: Modifier = Modifier) {
    val voice by Graph.voice.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    val watch by Graph.watch.state.collectAsState()
    if (voice.roomId != roomId || !callsOnPlayer(voice, chat, watch)) return
    Overlay(roomId, voice, chat, modifier)
}

@Composable
private fun Overlay(roomId: String, voice: VoiceState, chat: ChatState, modifier: Modifier) {
    val me = Graph.auth.user?.id
    val members = chat.roomDetails[roomId]?.members.orEmpty().associateBy { it.id }
    val now = System.currentTimeMillis()
    // Others on camera (an admin's stop counts as off), and when each last spoke.
    // (Not waiting for their picture: it only comes once a window asks for it.)
    val onCamera = chat.voice[roomId].orEmpty().filter { it.userId != me && it.camera && !it.cameraBlocked }
    for (v in onCamera) if (voice.speaking[v.userId] == true && !v.silenced) Placed.lastSpoke[v.userId] = now
    val mine = voice.cameraOn && voice.localVideo != null
    val room = MAX_WINDOWS - (if (mine) 1 else 0)
    val ids = onCamera.map { it.userId }
    // Who gets the windows: those already in one keep it, free windows go to whoever spoke last,
    // and someone talking takes the window of whoever's been quiet longest (and a while).
    val picked = run {
        val spoke = { id: String -> Placed.lastSpoke[id] ?: 0L }
        var next = Placed.picked.filter { it in ids }.take(room)
        val rest = ids.filter { it !in next }.sortedByDescending(spoke).toMutableList()
        while (next.size < room && rest.isNotEmpty()) next = next + rest.removeAt(0)
        for (id in rest) {
            if (voice.speaking[id] != true) continue
            val quietest = next.minByOrNull(spoke) ?: continue
            if (now - spoke(quietest) > QUIET_MS) next = next.map { if (it == quietest) id else it }
        }
        next.also { Placed.picked = it }
    }
    val shown = buildList {
        val local = voice.localVideo
        if (mine && local != null) add(Shown(me ?: "me", "me", "You", local, true, voice.muted, false, voice.speaking[me] == true && !voice.muted))
        for (id in picked) {
            val v = onCamera.firstOrNull { it.userId == id } ?: continue
            val track = voice.videos[id]
            val name = (members[id]?.name ?: chat.users[id]?.name ?: "Someone").split(' ').first()
            add(Shown(id, id, name, track, false, v.muted || v.silenced, v.silenced, voice.speaking[id] == true && !v.silenced))
        }
    }
    val hidden = onCamera.size - shown.count { !it.mine }

    BoxWithConstraints(modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        val pad = with(density) { 6.dp.toPx() }
        val minW = with(density) { 88.dp.toPx() }.coerceAtMost(w - 2 * pad)
        val minH = with(density) { 66.dp.toPx() }.coerceAtMost(h - 2 * pad)
        val top = with(density) { 48.dp.toPx() }
        val bottom = with(density) { 50.dp.toPx() }

        /** Within the player, at least the smallest size. */
        fun clamp(r: Rect): Rect {
            val rw = r.width.coerceIn(minW, w - 2 * pad)
            val rh = r.height.coerceIn(minH, h - 2 * pad)
            val x = r.left.coerceIn(pad, w - pad - rw)
            val y = r.top.coerceIn(pad, h - pad - rh)
            return Rect(x, y, x + rw, y + rh)
        }
        /** Where the i-th window starts: down the right side, clear of the buttons at the top and bottom, then further left. */
        fun initial(i: Int): Rect {
            val free = (h - top - bottom).coerceAtLeast(minH)
            var ww = (w * 0.27f).coerceIn(minW, with(density) { 240.dp.toPx() })
            var hh = ww * 3f / 4f
            val fit = if (free >= 2 * minH + pad) (free - pad) / 2 else free
            if (fit < hh) {
                hh = fit.coerceAtLeast(minH)
                ww = hh * 4f / 3f
            }
            val perColumn = ((free + pad) / (hh + pad)).toInt().coerceAtLeast(1)
            val column = i / perColumn
            val row = i % perColumn
            return clamp(Rect(Offset(w - pad - ww - column * (ww + pad), top + row * (hh + pad)), androidx.compose.ui.geometry.Size(ww, hh)))
        }
        fun rectOf(key: String, i: Int): Rect =
            Placed.spots[key]?.let { f -> clamp(Rect(f.left * w, f.top * h, f.right * w, f.bottom * h)) } ?: initial(i)
        fun keep(key: String, r: Rect) {
            val c = clamp(r)
            Placed.spots[key] = Rect(c.left / w, c.top / h, c.right / w, c.bottom / h)
        }
        fun raise(key: String) {
            Placed.order.remove(key)
            Placed.order.add(key)
        }

        // Everyone else's camera comes at the size its window shows it; those without a window, not at all.
        val views = shown.withIndex().filter { !it.value.mine }.associate { (i, s) ->
            val r = rectOf(s.key, i)
            val px = maxOf(r.width, r.height)
            s.id to when { px < 340 -> View.Small; px < 680 -> View.Medium; else -> View.Large }
        }
        LaunchedEffect(views) { Graph.voice.setViews(views, "player") }
        DisposableEffect(Unit) {
            onDispose {
                Graph.voice.setViews(emptyMap(), "player")
                // Away from the room's video (another screen): the call shrinks to its bar, rather than its screen opening.
                val v = Graph.voice.state.value
                if (v.live && v.onPlayer) Graph.voice.setMinimized(true)
            }
        }

        shown.forEachIndexed { i, s ->
            val r = rectOf(s.key, i)
            CallWindow(
                person = s,
                rect = r,
                z = 10f + Placed.order.indexOf(s.key).coerceAtLeast(0),
                mirror = s.mine && voice.frontCamera,
                onRaise = { raise(s.key) },
                onMove = { d ->
                    raise(s.key)
                    val now2 = rectOf(s.key, i)
                    keep(s.key, now2.translate(d))
                },
                onResize = { corner, d ->
                    raise(s.key)
                    val c = rectOf(s.key, i)
                    // The opposite corner stays where it is.
                    val left = corner == Alignment.TopStart || corner == Alignment.BottomStart
                    val up = corner == Alignment.TopStart || corner == Alignment.TopEnd
                    var nw = (if (left) c.width - d.x else c.width + d.x).coerceAtLeast(minW)
                    var nh = (if (up) c.height - d.y else c.height + d.y).coerceAtLeast(minH)
                    nw = nw.coerceAtMost(if (left) c.right - pad else w - pad - c.left)
                    nh = nh.coerceAtMost(if (up) c.bottom - pad else h - pad - c.top)
                    val x = if (left) c.right - nw else c.left
                    val y = if (up) c.bottom - nh else c.top
                    keep(s.key, Rect(x, y, x + nw, y + nh))
                },
            )
        }

        // The call's buttons, at the top: microphone, camera, and the call's own screen.
        val camAsk = rememberMediaPermission { ok, video -> if (ok && video) Graph.voice.toggleCamera() }
        Row(
            Modifier.align(Alignment.TopEnd).padding(6.dp).zIndex(40f).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (hidden > 0) Text("+$hidden on camera", color = Color.White.copy(alpha = 0.85f), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 6.dp))
            RoundButton(if (voice.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (voice.muted) "Unmute microphone" else "Mute microphone", { Graph.voice.toggleMute() }, 34.dp)
            Spacer(Modifier.width(4.dp))
            RoundButton(if (voice.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, if (voice.cameraOn) "Turn camera off" else "Turn camera on", { if (voice.cameraOn) Graph.voice.toggleCamera() else camAsk(true) }, 34.dp)
            if (voice.cameraOn) {
                Spacer(Modifier.width(4.dp))
                RoundButton(Icons.Rounded.Cameraswitch, "Switch camera", { Graph.voice.switchCamera() }, 34.dp)
            }
            Spacer(Modifier.width(4.dp))
            RoundButton(Icons.Rounded.OpenInFull, "Open the call", {
                Graph.voice.setOnPlayer(false)
                Graph.voice.setMinimized(false)
            }, 34.dp)
        }
    }
}

/** One camera's window: drag it to move it, drag a corner to resize it. */
@Composable
private fun CallWindow(person: Shown, rect: Rect, z: Float, mirror: Boolean, onRaise: () -> Unit, onMove: (Offset) -> Unit, onResize: (Alignment, Offset) -> Unit) {
    val p = palette
    val density = LocalDensity.current
    val shape = RoundedCornerShape(12.dp)
    val where = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val cornerPx = with(density) { 28.dp.toPx() }
    Box(
        Modifier
            .offset { IntOffset(rect.left.roundToInt(), rect.top.roundToInt()) }
            .size(with(density) { rect.width.toDp() }, with(density) { rect.height.toDp() })
            .zIndex(z)
            .onGloballyPositioned { where[0] = it }
            .clip(shape)
            .background(p.deep)
            .border(if (person.speaking) 2.dp else 1.dp, if (person.speaking) p.live else Color.White.copy(alpha = 0.15f), shape)
            .semantics { contentDescription = if (person.mine) "Your camera. Drag to move it, or a corner to resize it." else "${person.name}'s camera. Drag to move it, or a corner to resize it." }
            .pointerInput(person.key) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    // A touch brings it to the front (one under another comes out).
                    onRaise()
                    // Near a corner: that corner resizes it; anywhere else: it moves.
                    val sz = size
                    val nearLeft = down.position.x < cornerPx
                    val nearRight = down.position.x > sz.width - cornerPx
                    val nearTop = down.position.y < cornerPx
                    val nearBottom = down.position.y > sz.height - cornerPx
                    val corner = when {
                        nearTop && nearLeft -> Alignment.TopStart
                        nearTop && nearRight -> Alignment.TopEnd
                        nearBottom && nearLeft -> Alignment.BottomStart
                        nearBottom && nearRight -> Alignment.BottomEnd
                        else -> null
                    }
                    // On the screen, not in the window (which moves and grows under the finger).
                    fun onScreen(local: Offset) = where[0]?.takeIf { it.isAttached }?.localToRoot(local) ?: local
                    val from = onScreen(down.position)
                    var last = from
                    var dragging = false
                    while (true) {
                        val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                        val now = onScreen(change.position)
                        if (!dragging && (now - from).getDistance() > viewConfiguration.touchSlop) dragging = true
                        // All of the finger's way, from where it went down to where it lifts: the window keeps up with it exactly.
                        if (dragging) {
                            change.consume()
                            val d = now - last
                            last = now
                            if (d != Offset.Zero) {
                                if (corner == null) onMove(d) else onResize(corner, d)
                            }
                        }
                        if (!change.pressed) break
                    }
                }
            },
    ) {
        if (person.track != null) StageVideo(person.track, mirror, Modifier.fillMaxSize())
        // Until their picture comes: their name (it's on its way).
        else Text(person.name, color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp, modifier = Modifier.align(Alignment.Center))
        Row(
            Modifier.align(Alignment.BottomStart).padding(4.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 6.dp, vertical = 1.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (person.muted) Icon(Icons.Rounded.MicOff, null, tint = if (person.silenced) p.danger else p.live, modifier = Modifier.size(11.dp))
            Text(person.name, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        // The bottom-right corner shows it can be resized (every corner can).
        Box(Modifier.align(Alignment.BottomEnd).padding(4.dp).size(8.dp).border(2.dp, Color.White.copy(alpha = 0.7f), RoundedCornerShape(bottomEnd = 3.dp)))
    }
}
