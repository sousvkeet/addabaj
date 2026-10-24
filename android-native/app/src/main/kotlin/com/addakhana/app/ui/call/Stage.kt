package com.addakhana.app.ui.call

import android.content.Context
import android.graphics.SurfaceTexture
import android.view.TextureView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PictureInPictureAlt
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import com.addakhana.app.rtc.Rtc
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.theme.palette
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.EglRenderer
import livekit.org.webrtc.GlRectDrawer
import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoSink
import livekit.org.webrtc.VideoTrack
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * A camera's picture in a TextureView. WebRTC's SurfaceViewRenderer is a
 * window of its own, always under or over everything else; this one draws
 * like any view, so it stacks, clips to rounded corners and moves smoothly:
 * a floating window can sit on a full-screen video and be dragged around.
 */
class TextureVideoView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener, VideoSink {
    private val renderer = EglRenderer("stage")
    private var track: VideoTrack? = null

    init {
        renderer.init(Rtc.egl.eglBaseContext, EglBase.CONFIG_RGBA, GlRectDrawer())
        surfaceTextureListener = this
        // See-through until the first picture (the tile shows behind it).
        isOpaque = false
    }

    fun show(next: VideoTrack?) {
        if (next === track) return
        runCatching { track?.removeSink(this) }
        track = next
        if (next == null) renderer.clearImage(0f, 0f, 0f, 0f) else runCatching { next.addSink(this) }
    }

    fun mirror(on: Boolean) = renderer.setMirror(on)

    override fun onFrame(frame: VideoFrame) = renderer.onFrame(frame)

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        fill(width, height)
        renderer.createEglSurface(surface)
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = fill(width, height)

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        val done = CountDownLatch(1)
        renderer.releaseEglSurface { done.countDown() }
        done.await(1, TimeUnit.SECONDS)
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}

    /** Fills its box, cutting off the picture's edges as needed (SurfaceViewRenderer's SCALE_ASPECT_FILL). */
    private fun fill(width: Int, height: Int) {
        if (width > 0 && height > 0) renderer.setLayoutAspectRatio(width / height.toFloat())
    }

    fun release() {
        show(null)
        renderer.release()
    }
}

@Composable
private fun StageVideo(track: VideoTrack, mirror: Boolean, modifier: Modifier) {
    AndroidView(
        factory = { TextureVideoView(it) },
        update = { v ->
            v.mirror(mirror)
            v.show(track)
        },
        onRelease = { it.release() },
        modifier = modifier,
    )
}

/** Someone on a call's stage. */
data class Feed(
    val id: String,
    val name: String,
    val hue: Int,
    val photo: String?,
    /** Their camera's picture; null shows their photo. */
    val video: VideoTrack?,
    val mirror: Boolean = false,
    val mine: Boolean = false,
    val speaking: Boolean = false,
    val muted: Boolean = false,
    /** Muted by a room admin. */
    val silenced: Boolean = false,
    /** After the name: ", reconnecting…" and the like. */
    val note: String = "",
    /** Under the photo of someone without a picture, full screen: "Calling…", "camera is off". */
    val caption: String? = null,
)

/** Where someone is: in the grid, full screen, or floating in a small window. */
enum class Mode { Grid, Full, Floating }

/**
 * Where everyone is on a call's stage: in the grid; full screen (one at a
 * time, with the others in a row along the bottom); or floating in a small
 * window, dragged anywhere. Lasts while the call is shrunk to its bar.
 */
class StageLayout {
    private val modes = mutableStateMapOf<String, Mode>()
    /** Floating windows' places, as fractions of where they can go (0,0 top left; 1,1 bottom right). */
    internal val spots = mutableStateMapOf<String, Offset>()
    /** Floating windows, the last one touched on top. */
    internal val order = mutableStateListOf<String>()
    /** The call's buttons are showing (a tap on the full-screen video hides and shows them). */
    var chrome by mutableStateOf(true)

    fun mode(id: String): Mode = modes[id] ?: Mode.Grid
    val full: String? get() = modes.entries.firstOrNull { it.value == Mode.Full }?.key
    /** Someone is out of the grid. */
    val arranged: Boolean get() = modes.isNotEmpty()

    fun set(id: String, mode: Mode, spot: Offset? = null) {
        val was = mode(id)
        when (mode) {
            Mode.Full -> {
                full?.takeIf { it != id }?.let { current ->
                    if (was == Mode.Floating) {
                        // A floating window to full screen: the two swap places.
                        modes[current] = Mode.Floating
                        spots[current] = spots[id] ?: CORNERS.first()
                        raise(current)
                    } else {
                        modes.remove(current)
                    }
                }
                modes[id] = Mode.Full
            }
            Mode.Floating -> {
                spots[id] = spot ?: spots[id]?.takeIf { was == Mode.Floating } ?: freeCorner(id)
                modes[id] = Mode.Floating
                raise(id)
            }
            Mode.Grid -> modes.remove(id)
        }
        chrome = true
    }

    fun move(id: String, spot: Offset) {
        spots[id] = Offset(spot.x.coerceIn(0f, 1f), spot.y.coerceIn(0f, 1f))
    }

    fun raise(id: String) {
        order.remove(id)
        order.add(id)
    }

    fun everyoneToGrid() {
        modes.clear()
        chrome = true
    }

    /** Forgets whoever left. */
    internal fun keep(ids: Set<String>) {
        modes.keys.filter { it !in ids }.forEach { modes.remove(it) }
    }

    private fun freeCorner(id: String): Offset {
        val taken = modes.filter { it.value == Mode.Floating && it.key != id }.mapNotNull { spots[it.key] }
        return CORNERS.firstOrNull { c -> taken.none { (it - c).getDistance() < 0.3f } } ?: CORNERS.first()
    }

    private companion object {
        /** Bottom right first (WhatsApp's self view), then bottom left, top right, top left. */
        val CORNERS = listOf(Offset(1f, 1f), Offset(0f, 1f), Offset(1f, 0f), Offset(0f, 0f))
    }
}

/** The stage's layout for the call going on (one at a time), kept while it's shrunk to its bar. */
object Stages {
    private var key: String? = null
    private var layout: StageLayout? = null

    fun of(key: String, setup: StageLayout.() -> Unit = {}): StageLayout =
        layout?.takeIf { this.key == key } ?: StageLayout().apply(setup).also {
            this.key = key
            layout = it
        }

    fun current(key: String): StageLayout? = layout?.takeIf { this.key == key }

    fun clear() {
        key = null
        layout = null
    }
}

private enum class Kind { Full, Grid, Strip, Hidden, Floating }

private data class Placed(val rect: Rect, val kind: Kind)

private enum class Press { Tap, Move, Long, Cancel }

/**
 * A video call's stage, for one-to-one calls and rooms alike. Everyone is in
 * the grid, full screen or floating (see StageLayout):
 * - Tap someone in the grid (or the row) to make them full screen. Tap a
 *   floating window to swap it with whoever's full screen. Tap the
 *   full-screen video to hide or show the buttons.
 * - Drag a floating window anywhere. Press and hold anyone else and drag:
 *   they come out of the grid into a floating window under your finger.
 * - Press and hold anyone (or their ⋮) for Full screen, Small floating
 *   window or Back to the grid.
 * Each person's picture is one view the whole time, so it keeps playing
 * while it moves between these (nothing reconnects or goes black).
 * `onShown` gets the size each person shows at (the longer side, in pixels).
 * `labels`: names on the tiles (a one-to-one call has the name at the top).
 */
@Composable
fun VideoStage(
    feeds: List<Feed>,
    layout: StageLayout,
    header: @Composable () -> Unit,
    controls: @Composable () -> Unit,
    labels: Boolean = true,
    everyone: Set<String>? = null,
    onShown: (Map<String, Int>) -> Unit = {},
) {
    val p = palette
    val density = LocalDensity.current
    var headerH by remember { mutableIntStateOf(0) }
    var controlsH by remember { mutableIntStateOf(0) }
    val stage = remember { arrayOfNulls<LayoutCoordinates>(1) }
    var dragging by remember { mutableStateOf<String?>(null) }
    var grab by remember { mutableStateOf(Offset.Zero) }
    var menu by remember { mutableStateOf<String?>(null) }
    val ids = feeds.map { it.id }
    // Whoever left is forgotten (`everyone`: who to remember even while off the stage).
    LaunchedEffect(ids, everyone) { layout.keep(everyone ?: ids.toSet()) }

    BoxWithConstraints(Modifier.fillMaxSize().background(p.deep).onGloballyPositioned { stage[0] = it }) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        fun px(d: Dp) = with(density) { d.toPx() }
        val portrait = h >= w
        val full = layout.full?.takeIf { it in ids }
        val chrome = full == null || layout.chrome
        val top = if (chrome) maxOf(headerH, WindowInsets.statusBars.getTop(density)).toFloat() else WindowInsets.statusBars.getTop(density).toFloat()
        val bottom = if (chrome) maxOf(controlsH, WindowInsets.navigationBars.getBottom(density)).toFloat() else WindowInsets.navigationBars.getBottom(density).toFloat()
        val pad = px(8.dp)
        val placed = HashMap<String, Placed>()

        // Full screen: the whole stage, under the buttons.
        full?.let { placed[it] = Placed(Rect(0f, 0f, w, h), Kind.Full) }
        val rest = feeds.filter { layout.mode(it.id) == Mode.Grid }
        // Someone full screen: the rest in a row along the bottom (sliding away with the buttons).
        var stripH = 0f
        if (full != null && rest.isNotEmpty()) {
            val tw0 = px(if (portrait) 84.dp else 112.dp)
            val th0 = px(if (portrait) 112.dp else 84.dp)
            val gap = px(8.dp)
            val tw = minOf(tw0, (w - 2 * pad - gap * (rest.size - 1)) / rest.size)
            val th = tw * th0 / tw0
            val x0 = (w - (rest.size * tw + (rest.size - 1) * gap)) / 2
            val y = if (chrome) h - bottom - th - pad else h + pad
            if (chrome) stripH = th + pad
            rest.forEachIndexed { i, f -> placed[f.id] = Placed(Rect(Offset(x0 + i * (tw + gap), y), Size(tw, th)), if (chrome) Kind.Strip else Kind.Hidden) }
        }
        // Nobody full screen: the grid, between the header and the buttons, its last row centred.
        if (full == null && rest.isNotEmpty()) {
            val area = Rect(pad, top, w - pad, h - bottom)
            val n = rest.size
            val aspect = if (portrait) 3f / 4f else 4f / 3f
            // Columns that give the biggest tiles (3:4 standing, 4:3 lying).
            val cols = (1..n).maxBy { c ->
                val cw = area.width / c
                val ch = area.height / ceil(n / c.toFloat())
                minOf(cw, ch * aspect) * minOf(cw / aspect, ch)
            }
            val rows = ceil(n / cols.toFloat()).toInt()
            val cw = area.width / cols
            val ch = area.height / rows
            rest.forEachIndexed { i, f ->
                val r = i / cols
                val inRow = if (r == rows - 1) n - r * cols else cols
                val x = area.left + (cols - inRow) * cw / 2 + (i % cols) * cw
                placed[f.id] = Placed(Rect(Offset(x, area.top + r * ch), Size(cw, ch)), Kind.Grid)
            }
        }
        // Floating windows: anywhere clear of the header, the buttons and the row.
        val fw = (w * 0.3f).coerceIn(px(96.dp), px(168.dp))
        val fh = fw * if (portrait) 4f / 3f else 3f / 4f
        val room = Rect(pad, top + pad, maxOf(pad, w - pad - fw), maxOf(top + pad, h - bottom - stripH - pad - fh))
        fun spotAt(topLeft: Offset) = Offset(
            if (room.width > 0) (topLeft.x - room.left) / room.width else 0f,
            if (room.height > 0) (topLeft.y - room.top) / room.height else 0f,
        )
        feeds.filter { layout.mode(it.id) == Mode.Floating }.forEach { f ->
            val s = layout.spots[f.id] ?: Offset(1f, 1f)
            placed[f.id] = Placed(Rect(Offset(room.left + room.width * s.x, room.top + room.height * s.y), Size(fw, fh)), Kind.Floating)
        }

        val shown = placed.mapValues { (_, v) -> maxOf(v.rect.width, v.rect.height).roundToInt() }
        LaunchedEffect(shown, feeds.map { it.id to (it.video != null) }) { onShown(shown) }

        feeds.forEach { f ->
            val at = placed[f.id] ?: return@forEach
            key(f.id) {
                val z = when (at.kind) {
                    Kind.Full -> 0f
                    Kind.Grid -> 1f
                    Kind.Strip, Kind.Hidden -> 2f
                    Kind.Floating -> if (dragging == f.id) 100f else 10f + layout.order.indexOf(f.id).coerceAtLeast(0)
                }
                FeedTile(
                    f = f,
                    at = at,
                    mode = layout.mode(f.id),
                    snap = dragging == f.id,
                    z = z,
                    top = if (chrome) top else WindowInsets.statusBars.getTop(density).toFloat(),
                    labels = labels,
                    chrome = chrome,
                    menuOpen = menu == f.id,
                    stage = { stage[0] },
                    onTap = {
                        when (layout.mode(f.id)) {
                            Mode.Full -> layout.chrome = !layout.chrome
                            else -> layout.set(f.id, Mode.Full)
                        }
                    },
                    onMenu = { open -> menu = if (open) f.id else null },
                    onMode = { mode -> layout.set(f.id, mode) },
                    onLift = { finger, fraction ->
                        grab = Offset(fw * fraction.x, fh * fraction.y)
                        dragging = f.id
                        layout.set(f.id, Mode.Floating, spotAt(finger - grab))
                    },
                    onGrab = { finger ->
                        grab = finger - (placed[f.id]?.rect?.topLeft ?: finger)
                        dragging = f.id
                        layout.raise(f.id)
                    },
                    onDrag = { finger -> layout.move(f.id, spotAt(finger - grab)) },
                    onDrop = { dragging = null },
                )
            }
        }

        AnimatedVisibility(chrome, Modifier.align(Alignment.TopCenter).zIndex(5f), enter = fadeIn(), exit = fadeOut()) {
            Box(Modifier.fillMaxWidth().onSizeChanged { headerH = it.height }) { header() }
        }
        AnimatedVisibility(chrome, Modifier.align(Alignment.BottomCenter).zIndex(5f), enter = fadeIn(), exit = fadeOut()) {
            Box(Modifier.fillMaxWidth().onSizeChanged { controlsH = it.height }) { controls() }
        }
    }
}

@Composable
private fun FeedTile(
    f: Feed,
    at: Placed,
    mode: Mode,
    snap: Boolean,
    z: Float,
    top: Float,
    labels: Boolean,
    chrome: Boolean,
    menuOpen: Boolean,
    stage: () -> LayoutCoordinates?,
    onTap: () -> Unit,
    onMenu: (Boolean) -> Unit,
    onMode: (Mode) -> Unit,
    onLift: (finger: Offset, fraction: Offset) -> Unit,
    onGrab: (finger: Offset) -> Unit,
    onDrag: (finger: Offset) -> Unit,
    onDrop: () -> Unit,
) {
    val p = palette
    val density = LocalDensity.current
    val haptic = LocalHapticFeedback.current
    // Glides to its place; follows the finger exactly while dragged.
    val box = remember { Animatable(at.rect, Rect.VectorConverter) }
    LaunchedEffect(at.rect, snap) { if (snap) box.snapTo(at.rect) else box.animateTo(at.rect, tween(260)) }
    val modeNow by rememberUpdatedState(mode)
    val tap by rememberUpdatedState(onTap)
    val openMenu by rememberUpdatedState { onMenu(true) }
    val lift by rememberUpdatedState(onLift)
    val grabIt by rememberUpdatedState(onGrab)
    val drag by rememberUpdatedState(onDrag)
    val drop by rememberUpdatedState(onDrop)
    val tile = remember { arrayOfNulls<LayoutCoordinates>(1) }
    fun toStage(local: Offset): Offset {
        val s = stage()
        val t = tile[0]
        return if (s != null && t != null && t.isAttached) s.localPositionOf(t, local) else local
    }

    val kind = at.kind
    val corner = when (kind) {
        Kind.Full -> 0.dp
        Kind.Grid -> 16.dp
        else -> 14.dp
    }
    val shape = RoundedCornerShape(corner)
    val who = if (f.mine) "Your video" else "${f.name}'s video"
    Box(
        Modifier
            .zIndex(z)
            .layout { measurable, _ ->
                val r = box.value
                val width = r.width.roundToInt().coerceAtLeast(0)
                val height = r.height.roundToInt().coerceAtLeast(0)
                val placeable = measurable.measure(Constraints.fixed(width, height))
                layout(width, height) { placeable.place(r.left.roundToInt(), r.top.roundToInt()) }
            }
            .padding(if (kind == Kind.Grid) 4.dp else 0.dp)
            .then(if (kind == Kind.Floating) Modifier.shadow(10.dp, shape) else Modifier)
            .clip(shape)
            .background(Color(0xFF141A33))
            .then(
                when {
                    f.speaking && kind != Kind.Full -> Modifier.border(2.dp, p.live, shape)
                    kind == Kind.Floating -> Modifier.border(1.dp, Color.White.copy(alpha = 0.25f), shape)
                    else -> Modifier
                },
            ),
    ) {
        if (f.video != null) {
            StageVideo(f.video, f.mirror, Modifier.fillMaxSize())
        } else {
            NoPicture(f, big = kind == Kind.Full, top = with(density) { top.toDp() })
        }
        // Who it is (full screen: under the header, as the row and buttons cover the bottom).
        if (labels && kind != Kind.Hidden) {
            val small = kind == Kind.Strip || kind == Kind.Floating
            Row(
                Modifier
                    .align(if (kind == Kind.Full) Alignment.TopStart else Alignment.BottomStart)
                    .padding(start = if (small) 4.dp else 8.dp, bottom = if (small) 4.dp else 8.dp, top = if (kind == Kind.Full) with(density) { top.toDp() } + 8.dp else 0.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color.Black.copy(alpha = 0.55f))
                    .padding(horizontal = if (small) 6.dp else 8.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (f.muted || f.silenced) Icon(Icons.Rounded.MicOff, "Muted", tint = if (f.silenced) p.danger else p.live, modifier = Modifier.size(13.dp).padding(end = 2.dp))
                Text(
                    (if (f.mine) "You" else if (small) f.name.split(' ').first() else f.name) + if (small) "" else f.note,
                    color = Color.White,
                    fontSize = if (small) 11.sp else 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // Taps, holds and drags (see VideoStage).
        Box(
            Modifier
                .fillMaxSize()
                .onGloballyPositioned { tile[0] = it }
                .semantics {
                    contentDescription = who
                    onClick(label = if (mode == Mode.Full) "Show or hide the buttons" else "Full screen") { tap(); true }
                    onLongClick(label = "Video options") { openMenu(); true }
                    customActions = listOfNotNull(
                        CustomAccessibilityAction("Full screen") { onMode(Mode.Full); true }.takeIf { mode != Mode.Full },
                        CustomAccessibilityAction("Small floating window") { onMode(Mode.Floating); true }.takeIf { mode != Mode.Floating },
                        CustomAccessibilityAction("Back to the grid") { onMode(Mode.Grid); true }.takeIf { mode != Mode.Grid },
                    )
                }
                .pointerInput(f.id) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        val floating = modeNow == Mode.Floating
                        val slop = viewConfiguration.touchSlop
                        var last = down.position
                        // Until it's let go (a tap), moved, or held (a long press).
                        val press = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            var result = Press.Cancel
                            while (true) {
                                val e = awaitPointerEvent()
                                val c = e.changes.firstOrNull { it.id == down.id }
                                if (c == null || e.changes.any { it.id != down.id && it.pressed }) break
                                last = c.position
                                if (!c.pressed) {
                                    result = Press.Tap
                                    break
                                }
                                if ((c.position - down.position).getDistance() > slop) {
                                    result = Press.Move
                                    break
                                }
                            }
                            result
                        } ?: Press.Long
                        when (press) {
                            Press.Cancel -> return@awaitEachGesture
                            Press.Tap -> {
                                tap()
                                return@awaitEachGesture
                            }
                            // A floating window moves at once; anyone else needs holding first (so a swipe does nothing).
                            Press.Move -> if (floating) {
                                // Held where the finger first touched it, which it catches up with.
                                grabIt(toStage(down.position))
                                drag(toStage(last))
                            } else {
                                return@awaitEachGesture
                            }
                            Press.Long -> {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                // Let go where it is: the options. Moved: out it comes, under the finger.
                                while (true) {
                                    val e = awaitPointerEvent()
                                    val c = e.changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
                                    if (!c.pressed) {
                                        openMenu()
                                        return@awaitEachGesture
                                    }
                                    if ((c.position - down.position).getDistance() > slop) {
                                        if (floating) {
                                            grabIt(toStage(down.position))
                                            drag(toStage(c.position))
                                        } else {
                                            val fraction = Offset(
                                                (down.position.x / size.width.coerceAtLeast(1)).coerceIn(0f, 1f),
                                                (down.position.y / size.height.coerceAtLeast(1)).coerceIn(0f, 1f),
                                            )
                                            lift(toStage(c.position), fraction)
                                        }
                                        c.consume()
                                        break
                                    }
                                }
                            }
                        }
                        // Dragging, until it's let go (or the gesture is cut short).
                        try {
                            while (true) {
                                val e = awaitPointerEvent()
                                val c = e.changes.firstOrNull { it.id == down.id } ?: break
                                // It lands where the finger lifts.
                                drag(toStage(c.position))
                                c.consume()
                                if (!c.pressed) break
                            }
                        } finally {
                            drop()
                        }
                    }
                },
        )
        // Its options: a ⋮ on grid tiles and the full-screen video; press and hold for the rest.
        Box(Modifier.align(Alignment.TopEnd).padding(top = if (kind == Kind.Full) with(density) { top.toDp() } + 6.dp else 6.dp, end = 6.dp)) {
            if (chrome && (kind == Kind.Grid || kind == Kind.Full)) {
                Box(
                    Modifier.size(32.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)).clickable(onClickLabel = "Video options") { onMenu(true) },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Rounded.MoreVert, "Video options for ${if (f.mine) "you" else f.name}", tint = Color.White, modifier = Modifier.size(18.dp)) }
            }
            DropdownMenu(menuOpen, { onMenu(false) }, containerColor = p.surface) {
                Text(if (f.mine) "Your video" else f.name, color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                if (mode != Mode.Full) {
                    DropdownMenuItem(text = { Text("Full screen", color = p.ink) }, leadingIcon = { Icon(Icons.Rounded.Fullscreen, null, tint = p.ink) }, onClick = {
                        onMenu(false)
                        onMode(Mode.Full)
                    })
                }
                if (mode != Mode.Floating) {
                    DropdownMenuItem(text = { Text("Small floating window", color = p.ink) }, leadingIcon = { Icon(Icons.Rounded.PictureInPictureAlt, null, tint = p.ink) }, onClick = {
                        onMenu(false)
                        onMode(Mode.Floating)
                    })
                }
                if (mode != Mode.Grid) {
                    DropdownMenuItem(text = { Text("Back to the grid", color = p.ink) }, leadingIcon = { Icon(Icons.Rounded.GridView, null, tint = p.ink) }, onClick = {
                        onMenu(false)
                        onMode(Mode.Grid)
                    })
                }
            }
        }
    }
}

/** Someone without a picture: their photo, and full screen their name and why. */
@Composable
private fun NoPicture(f: Feed, big: Boolean, top: Dp) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (big) {
            Column(Modifier.padding(top = top), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Avatar(f.name, f.hue, f.photo, 112.dp, ring = f.speaking)
                Spacer(Modifier.height(16.dp))
                Text(if (f.mine) "You" else f.name, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 24.dp))
                f.caption?.let { Text(it, color = Color.White.copy(alpha = 0.75f), fontSize = 15.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp)) }
            }
        } else {
            Avatar(f.name, f.hue, f.photo, (minOf(maxWidth, maxHeight) * 0.42f).coerceIn(32.dp, 96.dp), ring = f.speaking)
        }
    }
}
