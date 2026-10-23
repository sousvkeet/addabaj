package com.addakhana.app.ui.watch

import android.app.Activity
import android.content.pm.ActivityInfo
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.OndemandVideo
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Podcasts
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material.icons.rounded.VerticalAlignTop
import androidx.compose.material.icons.rounded.VideoLibrary
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import coil3.compose.AsyncImage
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.FindResult
import com.addakhana.app.model.Room
import com.addakhana.app.model.WatchState
import com.addakhana.app.net.str
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.AppSheet
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.SheetItem
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.duration
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch
import kotlinx.serialization.json.put

/** Where the room's video shows: its picture moves into whichever of these is on screen. */
@Composable
private fun PlayerFrame(controls: Boolean, modifier: Modifier = Modifier) {
    AndroidView(
        factory = { FrameLayout(it).apply { setBackgroundColor(android.graphics.Color.BLACK) } },
        modifier = modifier,
        update = { Graph.watch.show(it, controls) },
        onRelease = { Graph.watch.hide(it) },
    )
}

/** Swallows touches: members follow the room, they don't pause or seek. */
private fun Modifier.blockTouches() = pointerInput(Unit) {
    awaitPointerEventScope { while (true) awaitPointerEvent().changes.forEach { it.consume() } }
}

/** The room's video, under its header: the picture, then what's playing and (for admins) the room's controls. */
@Composable
fun WatchStage(room: Room, onChange: () -> Unit) {
    val p = palette
    val w = room.watch ?: return
    val ui by Graph.watch.state.collectAsState()
    val me = Graph.auth.user?.id
    val isAdmin = room.myRole == "admin"
    DisposableEffect(room.id) {
        Graph.watch.attach(room.id)
        onDispose { Graph.watch.detach(room.id) }
    }
    Column(Modifier.fillMaxWidth().background(Color.Black)) {
        BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Box(Modifier.widthIn(max = maxWidth).fillMaxWidth().aspectRatio(16f / 9f).heightIn(max = 320.dp)) {
                val live = w.source.kind == "device"
                Picture(room, w, ui.error, ui.preparing[room.id], small = false)
                // A live stream's own buttons stay usable; a synced video only follows the room.
                if (!isAdmin && !live) Box(Modifier.matchParentSize().blockTouches())
                MutedForEveryone(w, small = false, Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = if (live) 40.dp else 8.dp))
                // Members have no player controls: their sound and full screen go on the video.
                if (ui.error == null && !live && !w.source.preparing && !isAdmin) {
                    Row(Modifier.align(Alignment.BottomEnd).padding(8.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)), verticalAlignment = Alignment.CenterVertically) {
                        val silent = w.muted != null || ui.muted
                        IconBtn(
                            if (silent) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp,
                            if (w.muted != null) "Muted for everyone" else if (ui.muted) "Unmute video" else "Mute video",
                            { if (w.muted != null) mutedForEveryone(w, false) else Graph.watch.setMuted(!ui.muted) },
                            size = 36.dp,
                            tint = Color.White,
                        )
                        IconBtn(Icons.Rounded.Fullscreen, "Full screen", { Graph.watch.setFullscreen(true) }, size = 36.dp, tint = Color.White)
                    }
                }
            }
        }
        Column(Modifier.fillMaxWidth().background(p.deep).padding(horizontal = 16.dp, vertical = 10.dp)) {
            val device = w.source.device?.takeIf { w.source.kind == "device" }
            val host = device?.let { hosting(room.id, it) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(if (device != null) Icons.Rounded.Podcasts else Icons.Rounded.OndemandVideo, null, tint = p.live, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        w.source.title + (w.source.detail?.let { "  ·  $it" } ?: ""),
                        color = p.onBrand,
                        fontSize = 14.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        when {
                            host != null -> {
                                val states = host.viewers.values
                                val watching = states.count { it == "connected" }
                                val joining = states.count { it == "new" || it == "connecting" }
                                "Live to $watching ${if (watching == 1) "person" else "people"}" + (if (joining > 0) ", $joining joining" else "") + ". It keeps going in the background until you stop."
                            }
                            device != null -> device.hostName.split(' ').first().let { if (device.mode == "screen") "Live: you see what $it shares" else "Live: $it controls play, pause and seeking" }
                            !isAdmin -> "Watching in sync with ${w.byName}"
                            w.by == me -> "You control playback for everyone"
                            else -> "${w.byName} is controlling playback. Play, pause or seek to take over."
                        },
                        color = p.onBrand.copy(alpha = 0.7f),
                        fontSize = 12.5.sp,
                        maxLines = 2,
                    )
                }
                if (isAdmin && device == null && !w.source.preparing) IconBtn(Icons.Rounded.Fullscreen, "Full screen", { Graph.watch.setFullscreen(true) }, size = 40.dp, tint = p.onBrand)
            }
            if (isAdmin || host != null) {
                Spacer(Modifier.height(8.dp))
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val muted = w.muted != null
                    AddaButton(
                        if (muted) "Unmute for everyone" else "Mute for everyone",
                        { Graph.watch.act("watch:mute", room.id) { put("muted", !muted) } },
                        height = 34.dp,
                        variant = if (muted) Variant.Live else Variant.OnDark,
                        icon = if (muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp,
                    )
                    if (host != null) {
                        AddaButton("Stop streaming", { Graph.scope.launch { Graph.live.stop() } }, height = 34.dp, variant = Variant.Danger)
                    } else {
                        AddaButton("Change video", onChange, height = 34.dp, variant = Variant.OnDark)
                        AddaButton("Stop for everyone", { Graph.watch.act("watch:stop", room.id) }, height = 34.dp, variant = Variant.Danger)
                    }
                }
            }
        }
    }
}

/** The picture itself, or what's happening instead (getting it ready, an error). */
@Composable
private fun Picture(room: Room, w: WatchState, error: String?, preparing: Pair<String, Int>?, small: Boolean) {
    val src = w.source
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        when {
            src.kind == "device" -> LiveView(room, w, small)
            src.finding -> Waiting("Up next: getting “${src.title}” ready…", null, small)
            src.error != null -> Message(src.error, small)
            src.preparing -> {
                val percent = preparing?.second ?: 0
                Waiting(
                    "Getting the video ready for everyone…",
                    if (preparing?.first == "join") "Joining picture and sound…" else "Downloading picture and sound, $percent%",
                    small,
                    percent,
                )
            }
            else -> {
                // The player's own controls: admins, not in the small player.
                PlayerFrame(controls = room.myRole == "admin" && !small, Modifier.fillMaxSize())
                if (error != null) Message(error, small)
            }
        }
    }
}

@Composable
private fun Waiting(title: String, detail: String?, small: Boolean, percent: Int? = null) {
    val p = palette
    Column(Modifier.fillMaxSize().background(p.deep).padding(horizontal = if (small) 10.dp else 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Spinner(size = if (small) 18.dp else 26.dp, color = p.live)
        if (small) return@Column
        Spacer(Modifier.height(12.dp))
        Text(title, color = p.onBrand, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        if (percent != null) {
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth().widthIn(max = 280.dp).height(8.dp).clip(RoundedCornerShape(50)), color = p.live, trackColor = Color.White.copy(alpha = 0.15f))
        }
        if (detail != null) {
            Spacer(Modifier.height(8.dp))
            Text(detail, color = p.onBrand.copy(alpha = 0.7f), fontSize = 13.sp)
        }
    }
}

@Composable
private fun Message(text: String, small: Boolean) {
    val p = palette
    Box(Modifier.fillMaxSize().background(p.deep.copy(alpha = 0.95f)).padding(if (small) 8.dp else 24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = p.onBrand, fontSize = if (small) 11.sp else 14.5.sp, maxLines = if (small) 3 else 6, overflow = TextOverflow.Ellipsis)
    }
}

/** On the video while its sound is off for everyone. */
@Composable
private fun MutedForEveryone(w: WatchState, small: Boolean, modifier: Modifier = Modifier) {
    val muted = w.muted ?: return
    Row(modifier.clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = if (small) 6.dp else 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.AutoMirrored.Rounded.VolumeOff, "Muted for everyone", tint = Color.White, modifier = Modifier.size(13.dp))
        if (!small) Text(" Muted for everyone by ${muted.byName}", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private fun mutedForEveryone(w: WatchState, isAdmin: Boolean) = Toasts.show(
    "${w.muted?.byName ?: "An admin"} muted the video for everyone. " +
        if (isAdmin) "Turn its sound back on with “Unmute for everyone”." else "Only an admin can turn its sound back on.",
)

// ── Up next ───────────────────────────────────────────────────────────

/** The videos queued after this one. Everyone sees the list; admins play, reorder, remove and skip. */
@Composable
fun UpNext(room: Room) {
    val p = palette
    val queue = room.queue.orEmpty()
    if (queue.isEmpty()) return
    val isAdmin = room.myRole == "admin"
    var open by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf<Int?>(null) }
    Column(Modifier.fillMaxWidth().background(p.surface.copy(alpha = 0.7f))) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 10.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clickable { open = !open }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.VideoLibrary, null, tint = p.liveInk, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(10.dp))
                val rest = queue.size - 1
                Text(
                    "Up next · " + if (open) "${queue.size} ${if (queue.size == 1) "video" else "videos"}" else queue[0].title + if (rest > 0) " and $rest more" else "",
                    color = p.ink,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Icon(if (open) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, if (open) "Hide Up next" else "Show Up next", tint = p.inkSoft, modifier = Modifier.size(18.dp))
            }
            if (isAdmin) {
                Spacer(Modifier.width(8.dp))
                AddaButton("Next", { Graph.watch.act("watch:next", room.id) }, height = 34.dp, variant = Variant.Soft, icon = Icons.Rounded.SkipNext)
            }
        }
        if (open) {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 280.dp).padding(horizontal = 8.dp)) {
                itemsIndexed(queue, key = { _, it -> it.id }) { i, item ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("${i + 1}", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.width(20.dp))
                        Thumbnail(item.thumbnail, Modifier.width(64.dp))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(item.title, color = p.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOfNotNull(item.duration?.let { duration(it) }, item.site, item.addedBy?.let { "added by ${it.name}" }).joinToString(" · "),
                                color = p.inkSoft,
                                fontSize = 12.5.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (isAdmin) IconBtn(Icons.Rounded.MoreVert, "Actions for ${item.title}", { menu = i }, size = 36.dp, tint = p.inkSoft)
                    }
                }
                if (isAdmin && queue.size > 1) item {
                    Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.End) {
                        AddaButton("Clear Up next", { Graph.watch.act("watch:queue-clear", room.id) }, height = 34.dp, variant = Variant.DangerGhost, icon = Icons.Rounded.DeleteOutline)
                    }
                }
            }
        }
    }
    val chosen = menu?.let { queue.getOrNull(it) }
    if (chosen != null) {
        AppSheet(onDismiss = { menu = null }, title = chosen.title) {
            SheetItem(Icons.Rounded.PlayArrow, "Play now", {
                menu = null
                Graph.watch.act("watch:queue-play", room.id) { put("itemId", chosen.id) }
            })
            if (menu != 0) SheetItem(Icons.Rounded.VerticalAlignTop, "Play next", {
                menu = null
                Graph.watch.act("watch:queue-move", room.id) { put("itemId", chosen.id); put("to", 0) }
            })
            SheetItem(Icons.Rounded.Close, "Remove", {
                menu = null
                Graph.watch.act("watch:queue-remove", room.id) { put("itemId", chosen.id) }
            }, danger = true)
        }
    }
}

@Composable
private fun Thumbnail(url: String?, modifier: Modifier) {
    val p = palette
    var broken by remember(url) { mutableStateOf(false) }
    Box(modifier.aspectRatio(16f / 9f).clip(RoundedCornerShape(6.dp)).background(p.subtle), contentAlignment = Alignment.Center) {
        if (url == null || broken) Icon(Icons.Rounded.PlayArrow, null, tint = p.inkSoft, modifier = Modifier.size(15.dp))
        else AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, onError = { broken = true }, modifier = Modifier.fillMaxSize())
    }
}

// ── Finding a video ──────────────────────────────────────────────────

/**
 * Admins paste any link: a video page on almost any site, YouTube, or a
 * direct file or stream. The server finds the videos on it, the admin picks
 * one and a quality, and it plays for the whole room (or goes into Up next).
 */
@Composable
fun WatchDialog(roomId: String, replacing: Boolean, onDismiss: () -> Unit) {
    val p = palette
    val co = rememberCoroutineScope()
    var tab by remember { mutableStateOf("link") }
    var url by remember { mutableStateOf("") }
    var step by remember { mutableStateOf("link") }
    var progress by remember { mutableStateOf("") }
    var result by remember { mutableStateOf<FindResult?>(null) }
    var selected by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf("") }
    var request by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        Graph.realtime.events.collect { e ->
            if (e.name == "watch:scan-progress" && e.obj.str("requestId") == request.toString()) e.obj.str("message")?.let { progress = it }
        }
    }

    fun find() {
        val id = ++request
        error = null
        progress = "Looking at the link…"
        step = "finding"
        co.launch {
            try {
                val found = Graph.watch.scan(roomId, url.trim(), id.toString())
                if (request != id) return@launch
                val options = found.videos.flatMap { it.options }
                result = found
                selected = (options.firstOrNull { it.recommended } ?: options.firstOrNull())?.id.orEmpty()
                step = "choose"
            } catch (e: Exception) {
                if (request != id) return@launch
                error = e.message ?: "Couldn't look at that link."
                step = "link"
            }
        }
    }

    fun play() {
        val r = result ?: return
        if (selected.isEmpty()) return
        busy = "play"
        error = null
        co.launch {
            try {
                Graph.watch.play(roomId, r.scanId, selected)
                onDismiss()
            } catch (e: Exception) {
                error = e.message ?: "That didn't work."
            } finally {
                busy = ""
            }
        }
    }

    fun queue(all: Boolean) {
        val r = result ?: return
        if (!all && selected.isEmpty()) return
        busy = if (all) "all" else "queue"
        error = null
        co.launch {
            try {
                val added = Graph.watch.queue(roomId, r.scanId, if (all) null else selected)
                onDismiss()
                Toasts.show(if (added == 1) "Added to Up next." else "Added $added videos to Up next.")
            } catch (e: Exception) {
                error = e.message ?: "That didn't work."
            } finally {
                busy = ""
            }
        }
    }

    AppDialog(
        onDismiss = onDismiss,
        title = if (step == "choose") "Pick what to play" else if (replacing) "Change the video" else "Watch together",
        text = when {
            step == "choose" -> "Everyone in the room watches it in sync."
            tab == "device" -> "Play a video from this phone, or share your screen. It streams live to everyone in the room."
            else -> "Paste a link to a video, or to any page with a video on it. Admins control play, pause and seeking."
        },
    ) {
        if (step == "link") {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(p.subtle).padding(4.dp)) {
                for ((id, label, icon) in listOf(Triple("link", "Paste a link", Icons.Rounded.Link), Triple("device", "From your phone", Icons.Rounded.Smartphone))) {
                    val on = tab == id
                    Row(
                        Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).then(if (on) Modifier.background(p.aurora) else Modifier).clickable { tab = id }.padding(vertical = 9.dp),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(icon, null, tint = if (on) Color.White else p.inkSoft, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(label, color = if (on) Color.White else p.inkSoft, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
        }
        when {
            step == "link" && tab == "device" -> DeviceSource(roomId, onDone = onDismiss)
            step == "link" -> {
                Field(url, { url = it }, label = "Link", placeholder = "https://…", keyboard = KeyboardType.Uri, imeAction = ImeAction.Search, onDone = { if (url.isNotBlank()) find() })
                Spacer(Modifier.height(6.dp))
                Text(
                    "Works with YouTube (videos and playlists), Facebook, Instagram, X, Dailymotion, news and video sites, and direct .mp4 or .m3u8 links.",
                    color = p.inkSoft,
                    fontSize = 12.5.sp,
                )
                error?.let { ErrorNote(it) }
                Spacer(Modifier.height(14.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    AddaButton("Cancel", onDismiss, variant = Variant.Ghost)
                    Spacer(Modifier.width(8.dp))
                    AddaButton("Find videos", { find() }, icon = Icons.Rounded.Search, enabled = url.isNotBlank())
                }
            }
            step == "finding" -> Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Spinner(size = 30.dp)
                Spacer(Modifier.height(14.dp))
                Text(progress, color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text("Some sites take up to half a minute.", color = p.inkSoft, fontSize = 13.5.sp, modifier = Modifier.padding(top = 4.dp))
                Spacer(Modifier.height(16.dp))
                AddaButton("Cancel", {
                    request++
                    step = "link"
                }, variant = Variant.Ghost)
            }
            else -> result?.let { r -> Choose(r, selected, { selected = it }, busy, error, { queue(true) }) }
        }
        if (step == "choose") {
            Spacer(Modifier.height(14.dp))
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AddaButton("Try another link", { step = "link" }, variant = Variant.Ghost)
                AddaButton("Add to Up next", { queue(false) }, variant = Variant.Soft, icon = Icons.AutoMirrored.Rounded.PlaylistAdd, loading = busy == "queue", enabled = selected.isNotEmpty() && busy.isEmpty())
                AddaButton("Play for everyone", { play() }, loading = busy == "play", enabled = selected.isNotEmpty() && busy.isEmpty())
            }
        }
    }
}

@Composable
private fun ErrorNote(text: String) {
    val p = palette
    Text(text, color = p.danger, fontSize = 14.sp, modifier = Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.danger.copy(alpha = 0.1f)).padding(horizontal = 12.dp, vertical = 9.dp))
}

/** The videos found, each with its ways to play (qualities), one chosen. */
@Composable
private fun Choose(r: FindResult, selected: String, onSelect: (String) -> Unit, busy: String, error: String?, addAll: () -> Unit) {
    val p = palette
    r.playlist?.let { pl ->
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).border(1.dp, p.line, RoundedCornerShape(16.dp)).background(p.subtle.copy(alpha = 0.6f)).padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.VideoLibrary, null, tint = p.liveInk, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(pl.title, color = p.ink, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "A playlist: " + (if (pl.total > pl.count) "its first ${pl.count} of ${pl.total} videos" else "${pl.count} ${if (pl.count == 1) "video" else "videos"}") + ", one after another",
                        color = p.inkSoft,
                        fontSize = 13.sp,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            AddaButton("Add all to Up next", addAll, height = 34.dp, icon = Icons.AutoMirrored.Rounded.PlaylistAdd, loading = busy == "all", enabled = busy.isEmpty())
        }
        Spacer(Modifier.height(12.dp))
    }
    for (v in r.videos) {
        Column(Modifier.fillMaxWidth().padding(bottom = 10.dp).clip(RoundedCornerShape(16.dp)).border(1.dp, p.line, RoundedCornerShape(16.dp)).padding(12.dp)) {
            Row {
                if (v.thumbnail != null) {
                    Thumbnail(v.thumbnail, Modifier.width(104.dp))
                    Spacer(Modifier.width(12.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text(v.title, color = p.ink, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.5.sp)
                    Text(listOfNotNull(v.site, if (v.live) "Live" else v.duration?.let { duration(it) }).joinToString(", "), color = p.inkSoft, fontSize = 13.sp)
                }
            }
            Spacer(Modifier.height(6.dp))
            for (o in v.options) {
                val on = selected == o.id
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).then(if (on) Modifier.background(p.subtle) else Modifier).clickable { onSelect(o.id) }.padding(horizontal = 4.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(on, { onSelect(o.id) }, colors = RadioButtonDefaults.colors(selectedColor = p.brand, unselectedColor = p.inkSoft))
                    Text(o.label, color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.width(64.dp))
                    Column(Modifier.weight(1f)) {
                        Text(o.detail, color = p.inkSoft, fontSize = 13.sp)
                        if (o.recommended) Text("Recommended", color = p.liveInk, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                    }
                    o.size?.let { Text(it, color = p.inkSoft, fontSize = 13.sp, modifier = Modifier.padding(start = 6.dp, end = 4.dp)) }
                }
            }
        }
    }
    val relayed = r.videos.any { v -> v.options.any { it.relay } }
    if (r.notes.isNotEmpty() || relayed) {
        for (n in r.notes) Text(n, color = p.inkSoft, fontSize = 13.sp)
        if (relayed) Text("Videos from web pages play through your server, which uses its upload for each viewer.", color = p.inkSoft, fontSize = 13.sp)
    }
    error?.let { ErrorNote(it) }
}

// ── Away from the room, and full screen ──────────────────────────────

/** The room's video, small, in a corner while I'm elsewhere in the app: tap opens the room, X stops it (for me). */
@Composable
fun WatchDock(bottom: androidx.compose.ui.unit.Dp) {
    val p = palette
    val ui by Graph.watch.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    val roomId = ui.roomId ?: return
    if (ui.onPage || ui.fullscreen) return
    val room = chat.roomDetails[roomId] ?: return
    val w = room.watch ?: return
    // My own live stream keeps going without a player (its bar shows elsewhere).
    if (w.source.kind == "device" && w.source.device?.hostId == Graph.auth.user?.id) return
    val name = chat.rooms[roomId]?.name ?: room.name
    Box(Modifier.fillMaxSize().navigationBarsPadding().padding(end = 8.dp, bottom = bottom), contentAlignment = Alignment.BottomEnd) {
        BoxWithConstraints {
            Column(
                Modifier.width(minOf(240.dp, maxWidth * 0.62f)).clip(RoundedCornerShape(18.dp)).border(1.dp, Color.White.copy(alpha = 0.1f), RoundedCornerShape(18.dp)).background(p.deep),
            ) {
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black)) {
                    Picture(room, w, ui.error, ui.preparing[roomId], small = true)
                    Box(Modifier.matchParentSize().clickable(onClickLabel = "Open $name") { Nav.push(Screen.Room(roomId)) })
                    MutedForEveryone(w, small = true, Modifier.align(Alignment.TopStart).padding(6.dp))
                }
                Row(Modifier.padding(start = 12.dp, end = 2.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(w.source.title, color = p.onBrand, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${if (w.source.kind == "device") "Live in" else "Watching in"} $name", color = p.onBrand.copy(alpha = 0.7f), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconBtn(Icons.Rounded.Close, "Stop watching", { Graph.watch.stop() }, size = 36.dp, tint = p.onBrand)
                }
            }
        }
    }
}

/** The video filling the screen, sideways. Back (or the button) returns. */
@Composable
fun WatchFullscreen() {
    val ui by Graph.watch.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    if (!ui.fullscreen) return
    val roomId = ui.roomId ?: return
    val room = chat.roomDetails[roomId] ?: return
    val w = room.watch ?: return
    val activity = LocalContext.current as? Activity
    val view = LocalView.current
    BackHandler { Graph.watch.setFullscreen(false) }
    DisposableEffect(Unit) {
        val window = activity?.window
        val was = activity?.requestedOrientation ?: ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        val bars = window?.let { WindowCompat.getInsetsController(it, view) }
        bars?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars?.hide(WindowInsetsCompat.Type.systemBars())
        onDispose {
            bars?.show(WindowInsetsCompat.Type.systemBars())
            activity?.requestedOrientation = was
        }
    }
    val isAdmin = room.myRole == "admin"
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        val live = w.source.kind == "device"
        Picture(room, w, ui.error, ui.preparing[roomId], small = false)
        if (!isAdmin && !live) Box(Modifier.matchParentSize().blockTouches())
        MutedForEveryone(w, small = false, Modifier.align(Alignment.TopStart).statusBarsPadding().padding(start = 12.dp, top = if (live) 44.dp else 12.dp))
        IconBtn(
            Icons.Rounded.FullscreenExit,
            "Exit full screen",
            { Graph.watch.setFullscreen(false) },
            Modifier.align(Alignment.TopEnd).padding(12.dp),
            tint = Color.White,
            background = androidx.compose.ui.graphics.SolidColor(Color.Black.copy(alpha = 0.45f)),
        )
    }
}

/** One of the dialog's "From your phone" choices. */
@Composable
internal fun SourceOption(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, text: String, unavailable: String?, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val p = palette
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).border(1.dp, p.line, RoundedCornerShape(16.dp)).clickable(enabled = enabled && unavailable == null, onClick = onClick).padding(14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(p.subtle), contentAlignment = Alignment.Center) {
            if (busy) Spinner(size = 20.dp) else Icon(icon, null, tint = p.liveInk, modifier = Modifier.size(21.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(if (busy) "Starting…" else title, color = p.ink.copy(alpha = if (unavailable != null) 0.6f else 1f), fontWeight = FontWeight.SemiBold)
            Text(text, color = p.inkSoft, fontSize = 13.5.sp, modifier = Modifier.padding(top = 2.dp))
            if (unavailable != null) Text(unavailable, color = p.danger, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 4.dp))
        }
    }
}
