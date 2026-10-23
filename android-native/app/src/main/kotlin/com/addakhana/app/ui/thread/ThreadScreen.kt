package com.addakhana.app.ui.thread

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.OndemandVideo
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.data.mutedNow
import com.addakhana.app.model.Attachment
import com.addakhana.app.model.Message
import com.addakhana.app.model.Scope
import com.addakhana.app.model.Sender
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.EmptyState
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.dayLabel
import com.addakhana.app.ui.home.MuteDialog
import com.addakhana.app.ui.instant
import com.addakhana.app.ui.lastSeen
import com.addakhana.app.ui.sameDay
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Duration
import kotlin.math.roundToInt

/** A chat with one person. */
@Composable
fun ChatScreen(partnerId: String) {
    val p = palette
    val state by Graph.chat.state.collectAsState()
    val call by Graph.calls.state.collectAsState()
    val co = rememberCoroutineScope()
    DisposableEffect(partnerId) {
        Graph.chat.openDm(partnerId)
        onDispose { if (Graph.chat.now.activeDm == partnerId) Graph.chat.openDm(null) }
    }
    val partner = state.users[partnerId] ?: state.conversations[partnerId]?.partner
    val conv = state.conversations[partnerId]
    var menu by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<String?>(null) }
    val composer = remember(partnerId) { ComposerState() }
    val blocked = partner?.blocked == true
    val onCall = call.peer?.id == partnerId && !call.idle
    val startCall = com.addakhana.app.ui.call.rememberMediaPermission { ok, video ->
        if (ok && partner != null) Graph.calls.startCall(Sender(partner.id, partner.name, partner.hue, partner.photo), video)
    }
    Column(Modifier.fillMaxSize().background(p.canvas).imePadding()) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(64.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { Nav.back() })
            if (partner != null) Avatar(partner.name, partner.hue, partner.photo, 40.dp, online = partnerId in state.online && !partner.presenceHidden && partnerId !in state.hiddenPresence)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(partner?.name ?: "", color = p.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (mutedNow(conv?.mutedUntil)) Icon(Icons.Rounded.NotificationsOff, "Muted", tint = p.inkSoft, modifier = Modifier.padding(start = 4.dp).size(14.dp))
                }
                val status = when {
                    partnerId in state.dmTyping -> "typing…"
                    partner == null || partner.presenceHidden || partnerId in state.hiddenPresence -> null
                    partnerId in state.online -> "Online"
                    else -> lastSeen(state.lastSeen[partnerId] ?: partner.lastSeenAt)
                }
                if (status != null) Text(status, color = if (status == "Online" || status == "typing…") p.liveInk else p.inkSoft, fontSize = 13.sp)
            }
            if (onCall) {
                IconBtn(Icons.Rounded.CallEnd, "End call", { Graph.calls.endCall() }, tint = Color.White, background = androidx.compose.ui.graphics.SolidColor(p.danger))
            } else if (partner != null) {
                IconBtn(Icons.Rounded.Videocam, "Video call ${partner.name}", { startCall(true) }, enabled = !blocked && call.idle)
                IconBtn(Icons.Rounded.Call, "Voice call ${partner.name}", { startCall(false) }, enabled = !blocked && call.idle)
            }
            Box {
                IconBtn(Icons.Rounded.MoreVert, "More", { menu = true })
                DropdownMenu(menu, { menu = false }, containerColor = p.surface) {
                    val muted = mutedNow(conv?.mutedUntil)
                    DropdownMenuItem(text = { Text(if (muted) "Unmute notifications" else "Mute notifications", color = p.ink) }, onClick = {
                        menu = false
                        if (muted) co.launch { runCatching { Graph.chat.setChatSettings(Scope.Dm, partnerId, mute = "off") } } else dialog = "mute"
                    })
                    if (conv != null) {
                        DropdownMenuItem(text = { Text(if (conv.pinnedAt != null) "Unpin chat" else "Pin chat", color = p.ink) }, onClick = {
                            menu = false
                            co.launch { runCatching { Graph.chat.setChatSettings(Scope.Dm, partnerId, pinned = conv.pinnedAt == null) }.onFailure { Toasts.error(it.message ?: "") } }
                        })
                        DropdownMenuItem(text = { Text(if (conv.archivedAt != null) "Unarchive chat" else "Archive chat", color = p.ink) }, onClick = {
                            menu = false
                            co.launch { runCatching { Graph.chat.setChatSettings(Scope.Dm, partnerId, archived = conv.archivedAt == null) } }
                        })
                    }
                    // Something to clear.
                    if (conv?.lastMessage != null) {
                        DropdownMenuItem(text = { Text("Clear chat history", color = p.ink) }, onClick = { menu = false; dialog = "clear" })
                    }
                    if (partner != null) {
                        DropdownMenuItem(text = { Text(if (blocked) "Unblock ${partner.name}" else "Block ${partner.name}", color = p.danger) }, onClick = {
                            menu = false
                            if (blocked) co.launch { runCatching { Graph.chat.unblock(partnerId) }.onFailure { Toasts.error(it.message ?: "") } } else dialog = "block"
                        })
                        DropdownMenuItem(text = { Text("Report ${partner.name}", color = p.danger) }, onClick = { menu = false; dialog = "report" })
                    }
                }
            }
        }
        Box(Modifier.weight(1f)) {
            Messages(
                scope = Scope.Dm,
                chatId = partnerId,
                page = state.dms[partnerId],
                me = Graph.auth.user?.id,
                canModerate = false,
                composer = composer,
                receipts = { null },
                empty = {
                    if (partner != null) EmptyState(Icons.Rounded.Call, "Say hello to ${partner.name}", "Messages arrive instantly. Use the buttons above for a voice or video call.")
                },
            )
        }
        if (blocked && partner != null) {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("You blocked ${partner.name}. You can't message or call each other.", color = p.inkSoft, fontSize = 14.sp, modifier = Modifier.weight(1f))
                AddaButton("Unblock", { co.launch { runCatching { Graph.chat.unblock(partnerId) } } }, height = 36.dp, variant = Variant.Soft)
            }
        } else {
            Composer(Scope.Dm, partnerId, composer, "Message ${partner?.name?.split(' ')?.firstOrNull().orEmpty()}")
        }
    }
    when (dialog) {
        "mute" -> MuteDialog(partner?.name ?: "", room = false, onPick = { span -> dialog = null; co.launch { runCatching { Graph.chat.setChatSettings(Scope.Dm, partnerId, mute = span) } } }, onDismiss = { dialog = null })
        "block" -> com.addakhana.app.ui.components.ConfirmDialog(
            "Block ${partner?.name}?",
            "They won't be able to message or call you, or add you to rooms, and neither of you will see when the other is online. They aren't told. Your messages so far stay.",
            "Block",
            onConfirm = { co.launch { runCatching { Graph.chat.block(partnerId) }.onFailure { Toasts.error(it.message ?: "") } } },
            onDismiss = { dialog = null },
        )
        "report" -> ReportDialog("user", partnerId, partner?.name ?: "them", null) { dialog = null }
        "clear" -> ClearChatDialog(partnerId, partner?.name ?: "them") { dialog = null }
    }
}

/** A room's chat. */
@Composable
fun RoomScreen(roomId: String) {
    val p = palette
    val state by Graph.chat.state.collectAsState()
    val voice by Graph.voice.state.collectAsState()
    val call by Graph.calls.state.collectAsState()
    DisposableEffect(roomId) {
        Graph.chat.openRoom(roomId)
        onDispose { if (Graph.chat.now.activeRoom == roomId) Graph.chat.openRoom(null) }
    }
    val room = state.rooms[roomId]
    val detail = state.roomDetails[roomId]
    val composer = remember(roomId) { ComposerState() }
    val me = Graph.auth.user?.id
    if (room == null) {
        Column(Modifier.fillMaxSize().background(p.canvas).statusBarsPadding()) {
            IconBtn(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { Nav.back() })
            if (state.bootstrapped) EmptyState(Icons.Rounded.Groups, "This room isn't available", "It may have been deleted, or you're no longer a member.") {
                AddaButton("Back to your rooms", { Nav.tab(com.addakhana.app.ui.Tab.Rooms) })
            } else Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner() }
        }
        return
    }
    val inVoice = state.voice[roomId].orEmpty()
    val here = voice.roomId == roomId && voice.active
    val join = com.addakhana.app.ui.call.rememberMediaPermission { ok, video -> if (ok) Graph.voice.join(roomId, video) }
    val members = detail?.members.orEmpty().map { it.asUser() }
    var watchOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().background(p.canvas).imePadding()) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(64.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { Nav.back() })
            Row(Modifier.weight(1f).clickable { Nav.push(Screen.RoomInfo(roomId)) }, verticalAlignment = Alignment.CenterVertically) {
                Avatar(room.name, hueFromId(room.id), room.photo, 40.dp, room = true)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(room.name, color = p.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (mutedNow(room.mutedUntil)) Icon(Icons.Rounded.NotificationsOff, "Muted", tint = p.inkSoft, modifier = Modifier.padding(start = 4.dp).size(14.dp))
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${room.memberCount} members", color = p.inkSoft, fontSize = 13.sp)
                        if (inVoice.isNotEmpty()) {
                            Spacer(Modifier.width(6.dp))
                            Row(Modifier.clip(RoundedCornerShape(10.dp)).background(p.live.copy(alpha = 0.15f)).padding(horizontal = 6.dp, vertical = 1.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Rounded.GraphicEq, null, tint = p.liveInk, modifier = Modifier.size(13.dp))
                                Text(" ${inVoice.size} in voice", color = p.liveInk, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
            if (!here) {
                AddaButton("Join", { join(false) }, height = 36.dp, variant = Variant.Live, enabled = call.idle)
                Spacer(Modifier.width(4.dp))
            }
            if (room.myRole == "admin") IconBtn(Icons.Rounded.OndemandVideo, "Watch together", { watchOpen = true })
            IconBtn(Icons.Rounded.Groups, "Members and voice", { Nav.push(Screen.RoomInfo(roomId)) })
        }
        if (detail?.watch != null) com.addakhana.app.ui.watch.WatchStage(detail) { watchOpen = true }
        if (detail != null) com.addakhana.app.ui.watch.UpNext(detail)
        Box(Modifier.weight(1f)) {
            Messages(
                scope = Scope.Room,
                chatId = roomId,
                page = state.roomMessages[roomId],
                me = me,
                canModerate = room.myRole == "admin" || Graph.auth.user?.siteAdmin == true,
                composer = composer,
                receipts = { m -> seenBy(m, detail?.members.orEmpty().map { Triple(it.id, it.name, Pair(it.lastReadId, it.joinedAt)) }, me) },
                empty = { EmptyState(Icons.Rounded.Groups, "Say hello", "Messages here go to everyone in ${room.name}.") },
            )
        }
        val typing = state.roomTyping[roomId].orEmpty().filterKeys { it != me }.values.toList()
        if (typing.isNotEmpty()) {
            Row(Modifier.padding(horizontal = 18.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                com.addakhana.app.ui.components.TypingDots(p.inkSoft)
                Spacer(Modifier.width(8.dp))
                Text(
                    when (typing.size) {
                        1 -> "${typing[0]} is typing"
                        2 -> "${typing[0]} and ${typing[1]} are typing"
                        else -> "${typing.size} people are typing"
                    },
                    color = p.inkSoft,
                    fontSize = 13.sp,
                )
            }
        }
        Composer(Scope.Room, roomId, composer, "Message ${room.name}", members)
    }
    if (watchOpen) com.addakhana.app.ui.watch.WatchDialog(roomId, replacing = detail?.watch != null) { watchOpen = false }
}

/** Under my latest room message: "Seen by Rahul and Mitali", "Seen by A, B and 3 others", "Seen by everyone". */
private fun seenBy(m: Message, members: List<Triple<String, String, Pair<Long, String?>>>, me: String?): String? {
    if (m.from != me || m.pending != null) return null
    val created = instant(m.createdAt) ?: return null
    val audience = members.filter { it.first != me && (instant(it.third.second)?.let { j -> !j.isAfter(created) } ?: true) }
    val readers = audience.filter { it.third.first >= m.id }
    if (readers.isEmpty()) return null
    if (readers.size == audience.size && audience.size > 2) return "Seen by everyone"
    val names = readers.map { it.second.split(' ').first() }
    return when (names.size) {
        1 -> "Seen by ${names[0]}"
        2 -> "Seen by ${names[0]} and ${names[1]}"
        else -> "Seen by ${names[0]}, ${names[1]} and ${names.size - 2} other${if (names.size - 2 == 1) "" else "s"}"
    }
}

/** A chat's messages, newest at the bottom: grouped, with day pills; older ones load as you scroll up. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Messages(
    scope: Scope,
    chatId: String,
    page: com.addakhana.app.data.Paged?,
    me: String?,
    canModerate: Boolean,
    composer: ComposerState,
    receipts: (Message) -> String?,
    empty: @Composable () -> Unit,
) {
    val p = palette
    val co = rememberCoroutineScope()
    val list = rememberLazyListState()
    val haptic = LocalHapticFeedback.current
    val items = page?.items.orEmpty()
    var held by remember { mutableStateOf<Message?>(null) }
    var dialog by remember { mutableStateOf<Pair<String, Message>?>(null) }
    var viewing by remember { mutableStateOf<Pair<Attachment, String?>?>(null) }
    var flash by remember { mutableStateOf<Long?>(null) }
    var newCount by remember { mutableStateOf(0) }
    val callBack = com.addakhana.app.ui.call.rememberMediaPermission { ok, video ->
        val partner = Graph.chat.now.users[chatId]
        if (ok && partner != null) Graph.calls.startCall(Sender(partner.id, partner.name, partner.hue, partner.photo), video)
    }
    var lastSeenNewest by remember { mutableLongStateOf(0L) }

    // Older messages when near the top.
    val nearTop by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= list.layoutInfo.totalItemsCount - 3 } == true } }
    LaunchedEffect(nearTop, page?.hasMore) {
        if (nearTop && page?.hasMore == true && page.loadingMore != true) {
            if (scope == Scope.Dm) Graph.chat.loadDm(chatId, older = true) else Graph.chat.loadRoomMessages(chatId, older = true)
        }
    }
    // At the bottom: new messages show; away from it, a pill counts them.
    val newest = items.lastOrNull()
    // Scrolling down to a new message: one arriving meanwhile cuts it short, and carries on.
    var following by remember { mutableStateOf(false) }
    LaunchedEffect(newest?.id, newest?.tempId) {
        val atBottom = following || list.firstVisibleItemIndex <= 1
        val id = newest?.id ?: 0
        if (newest != null && (atBottom || newest.from == me)) {
            following = true
            try {
                list.animateScrollToItem(0)
            } finally {
                // There, or stopped by a finger (not by a newer message): following ends.
                if (isActive) following = false
            }
            newCount = 0
        } else if (newest != null && id > lastSeenNewest && lastSeenNewest != 0L) {
            newCount++
        }
        lastSeenNewest = maxOf(lastSeenNewest, id)
    }
    LaunchedEffect(Unit) {
        snapshotFlow { list.firstVisibleItemIndex }.collect { if (it == 0) newCount = 0 }
    }

    // The rows, newest first (the list grows upwards).
    data class Row(val key: String, val m: Message?, val day: String?, val place: Placement?, val receipts: String?)
    val rows = remember(items, me) {
        val out = ArrayList<Row>(items.size * 2)
        val sent = items
        val myLast = sent.lastOrNull { it.from == me && it.pending == null }
        for (i in sent.indices.reversed()) {
            val m = sent[i]
            val prev = sent.getOrNull(i - 1)
            val next = sent.getOrNull(i + 1)
            fun groups(a: Message?, b: Message?) = a != null && b != null && a.kind == "text" && b.kind == "text" && a.from == b.from &&
                sameDay(a.createdAt, b.createdAt) && Duration.between(instant(a.createdAt), instant(b.createdAt)).abs().toMinutes() <= 5
            val first = !groups(prev, m)
            val last = !groups(m, next)
            val place = Placement(mine = m.from == me, firstInGroup = first, lastInGroup = last, showName = first && scope == Scope.Room)
            out += Row(m.tempId ?: "m${m.id}", m, null, place, if (m === myLast && scope == Scope.Room) receipts(m) else null)
            if (prev == null || !sameDay(prev.createdAt, m.createdAt)) out += Row("d${m.createdAt.take(10)}${m.id}", null, dayLabel(m.createdAt), null, null)
        }
        out
    }

    Box(Modifier.fillMaxSize()) {
        if (page?.loaded == true && items.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { empty() }
        } else if (page == null || (!page.loaded && items.isEmpty())) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner() }
        }
        LazyColumn(Modifier.fillMaxSize(), state = list, reverseLayout = true, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
            rowsOf(rows.size, { rows[it].key }) { index ->
                val row = rows[index]
                if (row.day != null) {
                    DayPill(row.day)
                    return@rowsOf
                }
                val m = row.m ?: return@rowsOf
                val place = row.place!!
                Column(Modifier.padding(top = if (place.firstInGroup) 12.dp else 3.dp)) {
                    when (m.kind) {
                        "system" -> SystemEntry(m)
                        "call" -> CallEntry(m, me) { video -> callBack(video) }
                        else -> SwipeToReply(enabled = !m.isDeleted && m.pending == null, onReply = { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); composer.reply(m) }) {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(16.dp))
                                    .background(if (flash == m.id) p.brand.copy(alpha = 0.26f) else Color.Transparent)
                                    .combinedClickable(
                                        onClick = { if (m.pending == "failed") Graph.chat.retry(scope, chatId, m) },
                                        onLongClick = { if (m.pending == null) { haptic.performHapticFeedback(HapticFeedbackType.LongPress); held = m } },
                                    ),
                            ) {
                                Bubble(
                                    m, place, me, row.receipts,
                                    onImage = { a -> viewing = a to m.localFile?.path },
                                    onQuote = { r ->
                                        val target = rows.indexOfFirst { it.m?.id == r.id }
                                        if (target >= 0) co.launch {
                                            list.animateScrollToItem(target)
                                            flash = r.id
                                            kotlinx.coroutines.delay(1_400)
                                            flash = null
                                        }
                                    },
                                    onRetry = { Graph.chat.retry(scope, chatId, m) },
                                    onReact = { e -> Graph.chat.react(scope, m.id, e) },
                                )
                            }
                        }
                    }
                }
            }
            if (page?.loadingMore == true) item("more") { Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { Spinner() } }
        }
        val away by remember { derivedStateOf { list.firstVisibleItemIndex > 2 } }
        if (away) {
            Row(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(14.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(p.surface)
                    .clickable { co.launch { list.animateScrollToItem(0) } }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (newCount > 0) Text(if (newCount == 1) "New message " else "$newCount new messages ", color = p.brand, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Icon(Icons.Rounded.KeyboardArrowDown, "Newest", tint = p.ink)
            }
        }
    }

    held?.let { m ->
        MessageSheet(
            m, scope,
            onDismiss = { held = null },
            onReply = { composer.reply(m) },
            onEdit = { composer.edit(m) },
            onForward = { dialog = "forward" to m },
            onDelete = { dialog = "delete" to m },
            onReport = { dialog = "report" to m },
            onInfo = { dialog = "info" to m },
        )
    }
    dialog?.let { (what, m) ->
        val close = { dialog = null }
        when (what) {
            "delete" -> DeleteDialog(m, scope, chatId, canModerate, close)
            "forward" -> ForwardDialog(m, scope, close)
            "report" -> ReportDialog(scope.wire, m.from, m.sender?.name ?: Graph.chat.now.users[m.from]?.name ?: "them", m.id, close)
            "info" -> MessageInfoDialog(m, scope, chatId, close)
        }
    }
    viewing?.let { (a, local) -> MediaViewer(a, local) { viewing = null } }
}

private inline fun LazyListScope.rowsOf(count: Int, noinline key: (Int) -> Any, crossinline content: @Composable (Int) -> Unit) {
    items(count, key = key) { content(it) }
}

/** Drag a message right (64 dp) to reply to it, with a tick when far enough. */
@Composable
private fun SwipeToReply(enabled: Boolean, onReply: () -> Unit, content: @Composable () -> Unit) {
    val p = palette
    val co = rememberCoroutineScope()
    val dx = remember { Animatable(0f) }
    val threshold = with(LocalDensity.current) { 64.dp.toPx() }
    var armed by remember { mutableStateOf(false) }
    val haptic = LocalHapticFeedback.current
    Box(Modifier.fillMaxWidth()) {
        Icon(
            Icons.AutoMirrored.Rounded.Reply,
            null,
            tint = p.brand,
            modifier = Modifier.align(Alignment.CenterStart).padding(start = 4.dp).size(22.dp).alpha((dx.value / threshold).coerceIn(0f, 1f)),
        )
        Box(
            Modifier
                .offset { IntOffset(dx.value.roundToInt(), 0) }
                .then(if (!enabled) Modifier else Modifier.pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            if (armed) onReply()
                            armed = false
                            co.launch { dx.animateTo(0f) }
                        },
                        onDragCancel = { armed = false; co.launch { dx.animateTo(0f) } },
                    ) { change, amount ->
                        val next = (dx.value + amount).coerceAtLeast(0f)
                        // Resistance past the threshold.
                        val eased = if (next > threshold) threshold + (next - threshold) * 0.3f else next
                        co.launch { dx.snapTo(eased) }
                        if (!armed && eased >= threshold) {
                            armed = true
                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        }
                        change.consume()
                    }
                }),
        ) { content() }
    }
}

