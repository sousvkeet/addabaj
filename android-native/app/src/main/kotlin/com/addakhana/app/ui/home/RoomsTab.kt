package com.addakhana.app.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.foundation.clickable
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.OndemandVideo
import androidx.compose.material.icons.rounded.PushPin
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.MAX_PINNED
import com.addakhana.app.data.Toasts
import com.addakhana.app.data.mutedNow
import com.addakhana.app.data.ordered
import com.addakhana.app.model.Room
import com.addakhana.app.model.Scope
import com.addakhana.app.model.VoiceParticipant
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppSheet
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.CountBadge
import com.addakhana.app.ui.components.EmptyState
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.SheetItem
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.listStamp
import com.addakhana.app.ui.messagePreview
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch

/** The Rooms tab: rooms, pinned first then by their newest message, with an Archived row and a search. */
@Composable
fun RoomsTab(joinCode: String? = null) {
    val p = palette
    val state by Graph.chat.state.collectAsState()
    var query by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var joining by remember { mutableStateOf(joinCode != null) }
    var held by remember { mutableStateOf<Room?>(null) }
    var archived by remember { mutableStateOf(false) }
    val me = Graph.auth.user?.id
    BackHandler(archived) { archived = false }

    val all = state.rooms.values.toList()
    // A search finds archived rooms too.
    val shown = if (query.isNotBlank()) all.filter { it.name.contains(query.trim(), ignoreCase = true) }
    else all.filter { (it.archivedAt != null) == archived }
    val list = ordered(shown, { it.pinnedAt }, { it.lastMessage?.createdAt ?: it.createdAt.orEmpty() })
    val archive = all.filter { it.archivedAt != null }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            if (archived) {
                Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconBtn(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { archived = false })
                    Column {
                        Text("Archived rooms", color = p.ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Text("They stay here when new messages come in.", color = p.inkSoft, fontSize = 12.5.sp)
                    }
                }
            } else {
                ListHeader("Rooms") { IconBtn(Icons.Rounded.Key, "Join a room with a code", { joining = true }) }
                ListSearch(query, { query = it }, "Search rooms")
            }
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 4.dp, bottom = 96.dp)) {
                if (!archived && query.isBlank() && archive.isNotEmpty()) {
                    item("archived") {
                        Row(
                            Modifier.fillMaxWidth().clickable { archived = true }.padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Archive, null, tint = p.inkSoft) }
                            Spacer(Modifier.width(12.dp))
                            Text("Archived", color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text(archive.size.toString(), color = p.inkSoft, fontSize = 13.sp)
                            if (archive.any { it.unread > 0 }) {
                                Spacer(Modifier.width(8.dp))
                                Box(Modifier.size(8.dp).clip(CircleShape).background(p.brand))
                            }
                        }
                    }
                }
                items(list, key = { it.id }) { room ->
                    RoomRow(room, state.voice[room.id].orEmpty(), me, onClick = { Nav.push(Screen.Room(room.id)) }, onHold = { held = room })
                }
                if (list.isEmpty() && state.bootstrapped && !archived && (query.isNotBlank() || archive.isEmpty())) {
                    item("empty") {
                        if (query.isNotBlank()) {
                            Text("No rooms called \"$query\".", color = p.inkSoft, fontSize = 14.sp, modifier = Modifier.padding(24.dp))
                        } else {
                            EmptyState(Icons.Rounded.Groups, "No rooms yet", "Start a room for your friends, or join one with its invite code.") {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    AddaButton("Start a room", { creating = true })
                                    AddaButton("Join with a code", { joining = true }, variant = Variant.Soft)
                                }
                            }
                        }
                    }
                }
            }
        }
        if (!archived) Fab(Icons.Rounded.Groups, "Start a room") { creating = true }
    }
    if (creating) CreateRoomDialog(onDismiss = { creating = false })
    if (joining) JoinRoomDialog(onDismiss = { joining = false }, initialCode = joinCode.orEmpty())
    held?.let { RoomSheet(it, onDismiss = { held = null }) }
}

@Composable
private fun RoomSheet(room: Room, onDismiss: () -> Unit) {
    var muting by remember { mutableStateOf(false) }
    // The app's scope: the sheet closes at once, and its own would go with it.
    fun settings(mute: String? = null, pinned: Boolean? = null, archived: Boolean? = null, toast: String? = null) = Graph.scope.launch {
        try {
            Graph.chat.setChatSettings(Scope.Room, room.id, mute, pinned, archived)
            toast?.let { Toasts.show(it) }
        } catch (e: Exception) {
            Toasts.error(e.message ?: "That didn't work.")
        }
    }
    if (muting) {
        MuteDialog(room.name, room = true, onPick = { settings(mute = it); muting = false; onDismiss() }, onDismiss = { muting = false; onDismiss() })
        return
    }
    AppSheet(onDismiss, title = room.name) {
        if (mutedNow(room.mutedUntil)) SheetItem(Icons.Rounded.Notifications, "Unmute notifications", { settings(mute = "off"); onDismiss() })
        else SheetItem(Icons.Rounded.NotificationsOff, "Mute notifications", { muting = true })
        val pinned = Graph.chat.now.rooms.values.count { it.pinnedAt != null }
        if (room.pinnedAt != null) SheetItem(Icons.Rounded.PushPin, "Unpin room", { settings(pinned = false); onDismiss() })
        else SheetItem(Icons.Rounded.PushPin, "Pin room", {
            if (pinned >= MAX_PINNED) Toasts.show("You can pin up to $MAX_PINNED rooms.") else settings(pinned = true)
            onDismiss()
        })
        if (room.archivedAt != null) SheetItem(Icons.Rounded.Unarchive, "Unarchive room", { settings(archived = false); onDismiss() })
        else SheetItem(Icons.Rounded.Archive, "Archive room", { settings(archived = true); onDismiss() })
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun RoomRow(room: Room, voice: List<VoiceParticipant>, me: String?, onClick: () -> Unit, onHold: () -> Unit) {
    val p = palette
    val haptic = LocalHapticFeedback.current
    val muted = mutedNow(room.mutedUntil)
    val last = room.lastMessage
    val unread = (if (muted) room.unreadMentions else room.unread) > 0
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onHold() })
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(room.name, hueFromId(room.id), room.photo, 48.dp, room = true)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(room.name, color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (muted) {
                    Spacer(Modifier.width(4.dp))
                    Icon(Icons.Rounded.NotificationsOff, "Muted", tint = p.inkSoft, modifier = Modifier.size(14.dp))
                }
                Spacer(Modifier.weight(1f))
                Text(
                    listStamp(last?.createdAt ?: room.createdAt),
                    color = if (unread) (if (p.dark) p.live else p.brand) else p.inkSoft,
                    fontSize = 12.sp,
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                )
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val preview = when {
                    last == null -> room.description.ifBlank { "No messages yet" }
                    last.kind == "system" -> messagePreview(last, false)
                    last.sender?.id == me -> "You: " + messagePreview(last, true)
                    else -> "${last.sender?.name?.split(' ')?.firstOrNull().orEmpty()}: " + messagePreview(last, false)
                }
                Text(preview, color = p.inkSoft, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (room.watching != null) {
                    Pill { Icon(Icons.Rounded.OndemandVideo, "Watching together", tint = p.brand2, modifier = Modifier.size(14.dp)) }
                }
                if (voice.isNotEmpty()) {
                    val video = voice.any { it.camera }
                    Pill(p.live.copy(alpha = 0.15f)) {
                        Icon(if (video) Icons.Rounded.Videocam else Icons.Rounded.GraphicEq, null, tint = p.liveInk, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(3.dp))
                        Text(voice.size.toString(), color = p.liveInk, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
                if (room.pinnedAt != null) {
                    Icon(Icons.Rounded.PushPin, "Pinned", tint = p.inkSoft, modifier = Modifier.size(15.dp).rotate(45f))
                    Spacer(Modifier.width(6.dp))
                }
                if (room.unreadMentions > 0) {
                    Box(Modifier.size(22.dp).clip(CircleShape).background(p.aurora), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.AlternateEmail, "Mentions you", tint = p.onBrand, modifier = Modifier.size(14.dp))
                    }
                    Spacer(Modifier.width(4.dp))
                }
                CountBadge(room.unread, muted = muted)
            }
        }
    }
}

@Composable
private fun Pill(background: androidx.compose.ui.graphics.Color = palette.brand2.copy(alpha = 0.15f), content: @Composable () -> Unit) {
    Row(
        Modifier.padding(end = 6.dp).clip(RoundedCornerShape(10.dp)).background(background).padding(horizontal = 6.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { content() }
}
