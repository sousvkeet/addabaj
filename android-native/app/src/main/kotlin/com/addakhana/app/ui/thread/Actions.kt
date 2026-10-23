package com.addakhana.app.ui.thread

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Shortcut
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import com.addakhana.app.Graph
import com.addakhana.app.data.Media
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.Attachment
import com.addakhana.app.model.Message
import com.addakhana.app.model.ReadState
import com.addakhana.app.model.Scope
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.AppSheet
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.SheetItem
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.components.url
import com.addakhana.app.ui.home.copy
import com.addakhana.app.ui.instant
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.time.Duration
import java.time.Instant

val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

/** Press and hold a message: react, reply, copy, edit, forward, info, download, report, delete. */
@Composable
fun MessageSheet(
    m: Message,
    scope: Scope,
    onDismiss: () -> Unit,
    onReply: () -> Unit,
    onEdit: () -> Unit,
    onForward: () -> Unit,
    onDelete: () -> Unit,
    onReport: () -> Unit,
    onInfo: () -> Unit,
) {
    val p = palette
    val context = LocalContext.current
    val me = Graph.auth.user
    val mine = m.from == me?.id
    val messaging = Graph.site.site.value.messaging
    val editable = mine && m.kind == "text" && m.body.isNotEmpty() && m.attachment?.kind != "voice" && (
        me?.siteAdmin == true || (messaging.editing && Duration.between(instant(m.createdAt) ?: Instant.EPOCH, Instant.now()).toMinutes() < messaging.editMinutes)
        )
    AppSheet(onDismiss) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            QUICK_REACTIONS.forEach { e ->
                val picked = m.reactions.any { it.emoji == e && me?.id in it.users }
                Box(
                    Modifier.size(48.dp).clip(CircleShape).background(if (picked) p.brand.copy(alpha = 0.18f) else p.subtle).clickable {
                        Graph.chat.react(scope, m.id, e)
                        onDismiss()
                    },
                    contentAlignment = Alignment.Center,
                ) { Text(e, fontSize = 22.sp) }
            }
        }
        SheetItem(Icons.AutoMirrored.Rounded.Reply, "Reply", { onReply(); onDismiss() })
        if (m.body.isNotEmpty()) SheetItem(Icons.Rounded.ContentCopy, "Copy", { copy(context, m.body, "Message copied"); onDismiss() })
        if (editable) SheetItem(Icons.Rounded.Edit, "Edit", { onEdit(); onDismiss() })
        if (messaging.forwarding || me?.siteAdmin == true) SheetItem(Icons.Rounded.Shortcut, "Forward", { onForward(); onDismiss() })
        if (mine) SheetItem(Icons.Rounded.Info, "Message info", { onInfo(); onDismiss() })
        m.attachment?.takeIf { it.kind != "voice" }?.let { a -> SheetItem(Icons.Rounded.Download, "Download", { Media.download(context, a); onDismiss() }) }
        if (!mine) SheetItem(Icons.Rounded.Flag, "Report", { onReport(); onDismiss() })
        SheetItem(Icons.Rounded.Delete, "Delete", { onDelete(); onDismiss() }, danger = true)
    }
}

/** "Delete message?": for everyone (mine within 48 hours; any, for room admins), or just for me. */
@Composable
fun DeleteDialog(m: Message, scope: Scope, chatId: String, canModerate: Boolean, onDismiss: () -> Unit) {
    val me = Graph.auth.user?.id
    val mine = m.from == me
    val recent = Duration.between(instant(m.createdAt) ?: Instant.EPOCH, Instant.now()).toHours() < 48
    val forEveryone = !m.isDeleted && ((mine && recent && m.kind == "text") || (scope == Scope.Room && canModerate))
    AppDialog(onDismiss, "Delete message?", buttons = {
        if (forEveryone) AddaButton("Delete for everyone", { Graph.scope.launch { Graph.chat.deleteMessage(scope, chatId, m.id, true) }; onDismiss() }, Modifier.fillMaxWidth(), variant = Variant.Danger)
        AddaButton("Delete for me", { Graph.scope.launch { Graph.chat.deleteMessage(scope, chatId, m.id, false) }; onDismiss() }, Modifier.fillMaxWidth(), variant = Variant.DangerSoft)
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    })
}

/** "Forward message": to up to N chats and rooms, at once. */
@Composable
fun ForwardDialog(m: Message, scope: Scope, onDismiss: () -> Unit) {
    val p = palette
    val co = rememberCoroutineScope()
    val state = Graph.chat.now
    val limit = if (Graph.auth.user?.siteAdmin == true) 50 else Graph.site.site.value.messaging.forwardTo
    var query by remember { mutableStateOf("") }
    val picked = remember { mutableStateListOf<Pair<Scope, String>>() }
    var busy by remember { mutableStateOf(false) }
    data class Target(val scope: Scope, val id: String, val name: String, val hue: Int, val photo: String?)
    val targets = (
        state.conversations.values.filter { !it.partner.blocked }.map { Target(Scope.Dm, it.partner.id, it.partner.name, it.partner.hue, it.partner.photo) } +
            state.rooms.values.map { Target(Scope.Room, it.id, it.name, hueFromId(it.id), it.photo) }
        ).filter { query.isBlank() || it.name.contains(query, ignoreCase = true) }
    AppDialog(onDismiss, "Forward message", "Choose up to $limit chats or rooms.", buttons = {
        AddaButton(if (picked.isEmpty()) "Forward" else "Forward to ${picked.size}", {
            busy = true
            co.launch {
                val results = Graph.chat.forwardMessage(scope, m.id, picked.toList())
                busy = false
                if (results != null) {
                    val names = targets.associate { (it.scope to it.id) to it.name }
                    val failed = results.filter { !it.ok }
                    if (failed.isEmpty()) Toasts.show(if (results.size == 1) "Forwarded to ${names[(if (results[0].scope == "dm") Scope.Dm else Scope.Room) to results[0].id] ?: "the chat"}" else "Forwarded to ${results.size} chats")
                    else failed.forEach { Toasts.error("Not forwarded to ${names[(if (it.scope == "dm") Scope.Dm else Scope.Room) to it.id] ?: "a chat"}: ${it.error}") }
                    onDismiss()
                }
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = picked.isNotEmpty())
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Field(query, { query = it }, placeholder = "Search")
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.heightIn(max = 320.dp)) {
            items(targets, key = { "${it.scope}:${it.id}" }) { t ->
                val key = t.scope to t.id
                val on = key in picked
                Row(
                    Modifier.fillMaxWidth().clickable {
                        if (on) picked.remove(key) else if (picked.size < limit) picked.add(key) else Toasts.show("Up to $limit at a time.")
                    }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Avatar(t.name, t.hue, t.photo, 36.dp, room = t.scope == Scope.Room)
                    Spacer(Modifier.width(10.dp))
                    Text(t.name, color = p.ink, modifier = Modifier.weight(1f))
                    Checkbox(on, null, colors = CheckboxDefaults.colors(checkedColor = p.brand))
                }
            }
        }
    }
}

/** Reporting a person or one of their messages to the site's host. */
@Composable
fun ReportDialog(scope: String, targetId: String?, targetName: String, messageId: Long?, onDismiss: () -> Unit) {
    val p = palette
    val co = rememberCoroutineScope()
    val reasons = listOf(
        "spam" to "Spam", "harassment" to "Harassment or bullying", "inappropriate" to "Inappropriate content",
        "impersonation" to "Pretending to be someone", "other" to "Something else",
    )
    var reason by remember { mutableStateOf<String?>(null) }
    var details by remember { mutableStateOf("") }
    var block by remember { mutableStateOf(scope == "dm" || scope == "user") }
    var busy by remember { mutableStateOf(false) }
    AppDialog(onDismiss, if (messageId != null) "Report this message?" else "Report $targetName?", "The host sees what you report, and can act on it.", buttons = {
        AddaButton("Send report", {
            val r = reason ?: return@AddaButton
            busy = true
            co.launch {
                try {
                    Graph.api.report(scope, targetId, messageId, r, details, block && targetId != null)
                    if (block && targetId != null) Graph.chat.markBlocked(targetId, true)
                    Toasts.show("Report sent. Thanks for telling the host.")
                    onDismiss()
                } catch (e: Exception) {
                    Toasts.error(e.message ?: "Couldn't send the report.")
                } finally {
                    busy = false
                }
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = reason != null, variant = Variant.Danger)
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        reasons.forEach { (key, label) ->
            Row(Modifier.fillMaxWidth().clickable { reason = key }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                androidx.compose.material3.RadioButton(reason == key, { reason = key }, colors = androidx.compose.material3.RadioButtonDefaults.colors(selectedColor = p.brand))
                Text(label, color = p.ink)
            }
        }
        Field(details, { details = it }, placeholder = "Anything else the host should know (optional)", singleLine = false, maxLength = 500)
        if (targetId != null) Row(Modifier.fillMaxWidth().clickable { block = !block }.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(block, { block = it }, colors = CheckboxDefaults.colors(checkedColor = p.brand))
            Text("Also block $targetName", color = p.ink)
        }
    }
}

/** Who has read or received one of my messages. */
@Composable
fun MessageInfoDialog(m: Message, scope: Scope, chatId: String, onDismiss: () -> Unit) {
    val p = palette
    var members by remember { mutableStateOf<List<ReadState>?>(null) }
    if (scope == Scope.Room) {
        LaunchedEffect(m.id) {
            while (true) {
                runCatching { Graph.api.roomMessageInfo(chatId, m.id) }.onSuccess { members = it }
                delay(4_000)
            }
        }
    }
    AppDialog(onDismiss, "Message info", buttons = { AddaButton("Done", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Soft) }) {
        if (scope == Scope.Dm) {
            val name = Graph.chat.now.users[chatId]?.name ?: "them"
            Text(
                when {
                    m.readAt != null -> "Read"
                    m.deliveredAt != null -> "Delivered to $name"
                    else -> "Sent. Not yet delivered: their app hasn't been online since."
                },
                color = p.ink,
            )
        } else {
            val list = members
            if (list == null) Text("Loading…", color = p.inkSoft)
            else {
                listOf("Read by" to list.filter { it.read }, "Delivered to" to list.filter { !it.read && it.delivered }, "Not delivered yet" to list.filter { !it.delivered }).forEach { (title, people) ->
                    if (people.isEmpty()) return@forEach
                    Text(title, color = p.inkSoft, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                    people.forEach { r ->
                        Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(r.user.name, r.user.hue, r.user.photo, 30.dp)
                            Spacer(Modifier.width(10.dp))
                            Text(r.user.name, color = p.ink)
                        }
                    }
                }
            }
        }
    }
}

/** A photo full screen (pinch to zoom, double-tap, drag down to close), or a video playing. */
@OptIn(UnstableApi::class)
@Composable
fun MediaViewer(a: Attachment, local: String?, onDismiss: () -> Unit) {
    val context = LocalContext.current
    Dialog(onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color(0xF0040612))) {
            if (a.kind == "video") {
                val player = remember {
                    ExoPlayer.Builder(context)
                        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(Graph.http)))
                        .build().apply {
                            // Mine, still on the phone; or downloaded ahead (Settings › Storage and data); else streamed.
                            val file = local?.let { File(it) } ?: com.addakhana.app.data.Media.cachedFile(context, a.url)
                            setMediaItem(MediaItem.fromUri(file?.let { android.net.Uri.fromFile(it) } ?: android.net.Uri.parse(url(a.url))))
                            prepare()
                            playWhenReady = true
                        }
                }
                DisposableEffect(Unit) { onDispose { player.release() } }
                AndroidView({ PlayerView(it).apply { this.player = player } }, Modifier.fillMaxSize())
            } else {
                var scale by remember { mutableFloatStateOf(1f) }
                var offset by remember { mutableStateOf(Offset.Zero) }
                AsyncImage(
                    // Mine, still on the phone (or kept since it was sent); else the whole photo.
                    model = local?.let { File(it) } ?: com.addakhana.app.data.Media.cachedFile(context, a.url) ?: url(a.url),
                    contentDescription = a.name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectTapGestures(onDoubleTap = {
                                scale = if (scale > 1f) 1f else 2.5f
                                offset = Offset.Zero
                            })
                        }
                        .pointerInput(Unit) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(0.8f, 5f)
                                offset = if (scale <= 1f) Offset(0f, offset.y + pan.y) else offset + pan
                                if (scale <= 1f && offset.y > 330f) onDismiss()
                            }
                        }
                        .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                )
            }
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                IconBtn(Icons.Rounded.Close, "Close", onDismiss, tint = Color.White)
                IconBtn(Icons.Rounded.Download, "Download", { Media.download(context, a) }, tint = Color.White)
            }
        }
    }
}
