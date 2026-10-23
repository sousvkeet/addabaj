package com.addakhana.app.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallMissed
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Unarchive
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.MAX_PINNED
import com.addakhana.app.data.Toasts
import com.addakhana.app.data.mutedNow
import com.addakhana.app.data.ordered
import com.addakhana.app.model.Conversation
import com.addakhana.app.model.Message
import com.addakhana.app.model.Scope
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppSheet
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.CountBadge
import com.addakhana.app.ui.components.EmptyState
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.SheetItem
import com.addakhana.app.ui.listStamp
import com.addakhana.app.ui.messagePreview
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch

/** The Chats tab: chats, pinned first then newest, with an Archived row and a search. */
@Composable
fun ChatsTab() {
    val p = palette
    val state by Graph.chat.state.collectAsState()
    var query by remember { mutableStateOf("") }
    var archived by remember { mutableStateOf(false) }
    var held by remember { mutableStateOf<Conversation?>(null) }
    var picking by remember { mutableStateOf(false) }
    val me = Graph.auth.user?.id
    androidx.activity.compose.BackHandler(archived) { archived = false }

    val all = state.conversations.values.filter { it.lastMessage != null || it.clearedAt != null }
    val shown = if (query.isNotBlank()) all.filter { it.partner.name.contains(query.trim(), ignoreCase = true) }
    else all.filter { (it.archivedAt != null) == archived }
    val list = ordered(shown, { it.pinnedAt }, { it.lastMessage?.createdAt ?: it.clearedAt.orEmpty() })
    val archive = all.filter { it.archivedAt != null }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            if (archived) {
                Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconBtn(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { archived = false })
                    Column {
                        Text("Archived chats", color = p.ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Text("They stay here when new messages come in.", color = p.inkSoft, fontSize = 12.5.sp)
                    }
                }
            } else {
                ListHeader("Chats")
                ListSearch(query, { query = it }, "Search chats")
            }
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp, top = 4.dp)) {
                if (!archived && query.isBlank() && archive.isNotEmpty()) {
                    item("archived") {
                        Row(
                            Modifier.fillMaxWidth().combinedClickable(onClick = { archived = true }).padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Archive, null, tint = p.inkSoft) }
                            Spacer(Modifier.width(12.dp))
                            Text("Archived", color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text(archive.size.toString(), color = p.inkSoft, fontSize = 13.sp)
                            if (archive.any { it.unread > 0 }) {
                                Spacer(Modifier.width(8.dp))
                                Box(Modifier.size(8.dp).background(p.brand, androidx.compose.foundation.shape.CircleShape))
                            }
                        }
                    }
                }
                items(list, key = { it.partner.id }) { c ->
                    ChatRow(c, typing = c.partner.id in state.dmTyping, online = c.partner.id in state.online, me = me, onClick = { Nav.push(Screen.Chat(c.partner.id)) }, onHold = { held = c })
                }
                if (list.isEmpty() && state.bootstrapped && !archived && (query.isNotBlank() || archive.isEmpty())) {
                    item("empty") {
                        if (query.isNotBlank()) {
                            Text("No chats called \"$query\".", color = p.inkSoft, fontSize = 14.sp, modifier = Modifier.padding(24.dp))
                        } else {
                            EmptyState(Icons.Rounded.Edit, "No chats yet", "Find someone on Adda Khana and say hello. Your conversations will show up here.") {
                                AddaButton("Find people", { picking = true })
                            }
                        }
                    }
                }
            }
        }
        if (!archived) Fab(Icons.Rounded.Edit, "Start a new chat") { picking = true }
    }

    held?.let { c -> ChatSheet(c, onDismiss = { held = null }) }
    if (picking) UserPicker(onDismiss = { picking = false })
}

/** Press and hold a chat: mute, pin, archive. */
@Composable
private fun ChatSheet(c: Conversation, onDismiss: () -> Unit) {
    var muting by remember { mutableStateOf(false) }
    val muted = mutedNow(c.mutedUntil)
    // The app's scope: the sheet closes at once, and its own would go with it.
    fun settings(mute: String? = null, pinned: Boolean? = null, archived: Boolean? = null, toast: String? = null) = Graph.scope.launch {
        try {
            Graph.chat.setChatSettings(Scope.Dm, c.partner.id, mute, pinned, archived)
            toast?.let { Toasts.show(it) }
        } catch (e: Exception) {
            Toasts.error(e.message ?: "That didn't work.")
        }
    }
    if (muting) {
        MuteDialog(c.partner.name, room = false, onPick = { settings(mute = it); muting = false; onDismiss() }, onDismiss = { muting = false; onDismiss() })
        return
    }
    AppSheet(onDismiss, title = c.partner.name) {
        if (muted) SheetItem(Icons.Rounded.Notifications, "Unmute notifications", { settings(mute = "off"); onDismiss() })
        else SheetItem(Icons.Rounded.NotificationsOff, "Mute notifications", { muting = true })
        val pinnedCount = Graph.chat.now.conversations.values.count { it.pinnedAt != null }
        if (c.pinnedAt != null) SheetItem(Icons.Rounded.PushPin, "Unpin chat", { settings(pinned = false); onDismiss() })
        else SheetItem(Icons.Rounded.PushPin, "Pin chat", {
            if (pinnedCount >= MAX_PINNED) Toasts.show("You can pin up to $MAX_PINNED chats.") else settings(pinned = true)
            onDismiss()
        })
        if (c.archivedAt != null) SheetItem(Icons.Rounded.Unarchive, "Unarchive chat", { settings(archived = false, toast = "Chat is back in your list"); onDismiss() })
        else SheetItem(Icons.Rounded.Archive, "Archive chat", { settings(archived = true, toast = "Chat archived"); onDismiss() })
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatRow(c: Conversation, typing: Boolean, online: Boolean, me: String?, onClick: () -> Unit, onHold: () -> Unit) {
    val p = palette
    val haptic = LocalHapticFeedback.current
    val muted = mutedNow(c.mutedUntil)
    val last = c.lastMessage
    val unread = c.unread > 0 && !muted
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onHold() })
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(c.partner.name, c.partner.hue, c.partner.photo, 48.dp, online = online && !c.partner.presenceHidden)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(c.partner.name, color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (muted) {
                    Spacer(Modifier.width(4.dp))
                    Icon(Icons.Rounded.NotificationsOff, "Muted", tint = p.inkSoft, modifier = Modifier.size(14.dp))
                }
                Spacer(Modifier.weight(1f))
                Text(
                    listStamp(last?.createdAt ?: c.clearedAt),
                    color = if (unread) (if (p.dark) p.live else p.brand) else p.inkSoft,
                    fontSize = 12.sp,
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                )
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    if (last == null && !typing && c.clearedAt != null) Text("History cleared", color = p.inkSoft, fontSize = 14.sp, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic, maxLines = 1)
                    else Preview(last, typing, me)
                }
                if (c.pinnedAt != null) {
                    Icon(Icons.Rounded.PushPin, "Pinned", tint = p.inkSoft, modifier = Modifier.size(15.dp).rotate(45f))
                    Spacer(Modifier.width(6.dp))
                }
                CountBadge(c.unread, muted = muted)
            }
        }
    }
}

@Composable
private fun Preview(last: Message?, typing: Boolean, me: String?) {
    val p = palette
    if (typing) {
        Text("typing…", color = if (p.dark) p.live else p.brand, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        return
    }
    if (last == null) return
    val mine = last.senderId == me
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (last.kind == "call") {
            val missed = last.meta?.outcome == "missed" || last.meta?.outcome == "declined"
            Icon(if (missed) Icons.Rounded.CallMissed else if (last.meta?.video == true) Icons.Rounded.Videocam else Icons.Rounded.Call, null, tint = if (missed) p.danger else p.inkSoft, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(4.dp))
        } else if (mine && !last.isDeleted) {
            Ticks(last, size = 15)
            Spacer(Modifier.width(3.dp))
        }
        if (last.isDeleted) {
            Icon(Icons.Rounded.Block, null, tint = p.inkSoft, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
        }
        Text(
            messagePreview(last, mine),
            color = p.inkSoft,
            fontSize = 14.sp,
            fontStyle = if (last.isDeleted) FontStyle.Italic else FontStyle.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** My message's state: sending (clock), sent (tick), delivered (two), read (two, coloured). */
@Composable
fun Ticks(m: Message, size: Int = 14, tint: Color = palette.inkSoft) {
    val p = palette
    when {
        m.pending == "sending" -> Icon(Icons.Rounded.Schedule, "Sending", tint = tint, modifier = Modifier.size(size.dp))
        m.pending == "failed" -> Unit
        m.readAt != null -> Icon(Icons.Rounded.DoneAll, "Read", tint = p.tickRead, modifier = Modifier.size((size + 1).dp))
        m.deliveredAt != null -> Icon(Icons.Rounded.DoneAll, "Delivered", tint = tint, modifier = Modifier.size((size + 1).dp))
        else -> Icon(Icons.Rounded.Check, "Sent", tint = tint, modifier = Modifier.size(size.dp))
    }
}
