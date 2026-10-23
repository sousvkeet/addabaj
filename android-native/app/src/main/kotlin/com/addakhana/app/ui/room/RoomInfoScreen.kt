package com.addakhana.app.ui.room

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AdminPanelSettings
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.data.mutedForGood
import com.addakhana.app.data.mutedNow
import com.addakhana.app.model.ClearAfter
import com.addakhana.app.model.Room
import com.addakhana.app.model.RoomMember
import com.addakhana.app.model.Scope
import com.addakhana.app.net.appUrl
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.call.VoiceTable
import com.addakhana.app.ui.clock
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.ConfirmDialog
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.home.Choice
import com.addakhana.app.ui.home.UserPicker
import com.addakhana.app.ui.home.copy
import com.addakhana.app.ui.home.formatCode
import com.addakhana.app.ui.home.share
import com.addakhana.app.ui.lastSeen
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun RoomInfoScreen(roomId: String, adding: Boolean = false) {
    val p = palette
    val state by Graph.chat.state.collectAsState()
    val co = rememberCoroutineScope()
    val room = state.roomDetails[roomId] ?: state.rooms[roomId]
    val me = Graph.auth.user
    var dialog by remember { mutableStateOf(if (adding) "add" else null) }
    androidx.compose.runtime.LaunchedEffect(roomId) { Graph.chat.loadRoom(roomId) }
    Column(Modifier.fillMaxSize().background(p.canvas)) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { Nav.back() })
            Text("Room info", color = p.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        if (room == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner() }
            return
        }
        val admin = room.myRole == "admin" || me?.siteAdmin == true
        val owner = room.ownerId == me?.id
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 24.dp)) {
            // Photo, name, members, description, history.
            Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.clickable(enabled = room.myRole == "admin") { dialog = "photo" }) { Avatar(room.name, hueFromId(room.id), room.photo, 96.dp, room = true) }
                Spacer(Modifier.height(10.dp))
                Text(room.name, color = p.ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                Text("Room · ${room.memberCount} members", color = p.inkSoft, fontSize = 14.sp)
                if (room.description.isNotBlank()) Text(room.description, color = p.ink, fontSize = 14.5.sp, modifier = Modifier.padding(top = 6.dp))
                room.clearAfter?.let {
                    Text("Messages clear after ${label(it)}", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp).clip(RoundedCornerShape(10.dp)).background(p.subtle).padding(horizontal = 10.dp, vertical = 4.dp))
                }
            }
            VoiceTable(room)
            Notifications(room)
            Members(room, admin, owner, onAdd = { dialog = "add" })
            Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (room.myRole == "admin") AddaButton("Room settings", { dialog = "settings" }, Modifier.weight(1f), variant = Variant.Soft, icon = Icons.Rounded.Settings)
                if (!owner) AddaButton("Leave room", { dialog = "leave" }, Modifier.weight(1f), variant = Variant.DangerSoft)
            }
        }
        when (dialog) {
            "add" -> UserPicker(onDismiss = { dialog = null }, roomId = roomId)
            "settings" -> RoomSettings(room) { dialog = null }
            "photo" -> RoomPhoto(room) { dialog = null }
            "leave" -> ConfirmDialog("Leave ${room.name}?", "You'll stop getting its messages. An admin can add you back.", "Leave room", onConfirm = {
                co.launch {
                    runCatching { Graph.chat.leaveRoom(roomId) }.onSuccess { Nav.leaveRoom(roomId) }.onFailure { Toasts.error(it.message ?: "Couldn't leave.") }
                }
            }, onDismiss = { dialog = null }, cancel = "Stay")
        }
    }
}

@Composable
private fun Notifications(room: Room) {
    val p = palette
    val co = rememberCoroutineScope()
    var muting by remember { mutableStateOf(false) }
    val muted = mutedNow(room.mutedUntil)
    Section("Notifications") {
        Text(
            when {
                muted && mutedForGood(room.mutedUntil) -> "Muted. You still hear when someone mentions you or replies to you."
                muted -> "Muted until ${clock(room.mutedUntil)}. You still hear when someone mentions you or replies to you."
                else -> "On for every message."
            },
            color = p.inkSoft,
            fontSize = 13.5.sp,
        )
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (muted) AddaButton("Unmute", { co.launch { runCatching { Graph.chat.setChatSettings(Scope.Room, room.id, mute = "off") } } }, height = 36.dp, variant = Variant.Soft)
            else AddaButton("Mute", { muting = true }, height = 36.dp, variant = Variant.Soft)
            AddaButton(if (room.pinnedAt != null) "Unpin room" else "Pin room", { co.launch { runCatching { Graph.chat.setChatSettings(Scope.Room, room.id, pinned = room.pinnedAt == null) }.onFailure { Toasts.error(it.message ?: "") } } }, height = 36.dp, variant = Variant.Soft)
            AddaButton(if (room.archivedAt != null) "Unarchive" else "Archive", { co.launch { runCatching { Graph.chat.setChatSettings(Scope.Room, room.id, archived = room.archivedAt == null) } } }, height = 36.dp, variant = Variant.Soft)
        }
    }
    if (muting) com.addakhana.app.ui.home.MuteDialog(room.name, room = true, onPick = { span -> muting = false; co.launch { runCatching { Graph.chat.setChatSettings(Scope.Room, room.id, mute = span) } } }, onDismiss = { muting = false })
}

@Composable
fun Section(title: String, content: @Composable () -> Unit) {
    val p = palette
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).clip(RoundedCornerShape(20.dp)).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), RoundedCornerShape(20.dp)).padding(16.dp)) {
        Text(title, color = p.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        content()
    }
}

@Composable
private fun Members(room: Room, admin: Boolean, owner: Boolean, onAdd: () -> Unit) {
    val p = palette
    val co = rememberCoroutineScope()
    val state by Graph.chat.state.collectAsState()
    val me = Graph.auth.user?.id
    val members = room.members.orEmpty().sortedWith(compareBy({ it.id != room.ownerId }, { it.role != "admin" }, { it.name.lowercase() }))
    val full = room.memberCount >= room.maxMembers
    var removing by remember { mutableStateOf<RoomMember?>(null) }
    Section("Members, ${room.memberCount} of ${room.maxMembers}") {
        if (room.myRole == "admin") {
            AddaButton("Add people", onAdd, Modifier.fillMaxWidth(), icon = Icons.Rounded.PersonAdd, enabled = !full)
            if (full) Text("The room is full. Raise the limit in settings to add more people.", color = p.danger, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
            room.joinCode?.let { code -> InviteCard(room, code) }
        }
        Spacer(Modifier.height(8.dp))
        members.forEach { m ->
            val online = m.id in state.online && !m.presenceHidden
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(m.name, m.hue, m.photo, 36.dp, online = online)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(m.name + if (m.id == me) " (you)" else "", color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    val moderation = when {
                        m.voiceMuted && m.cameraBlocked -> "Muted and camera stopped by an admin"
                        m.voiceMuted -> "Muted in voice by an admin"
                        m.cameraBlocked -> "Camera stopped by an admin"
                        else -> null
                    }
                    if (moderation != null) Text(moderation, color = p.danger, fontSize = 12.5.sp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (m.id == room.ownerId) {
                            Icon(Icons.Rounded.Star, null, tint = p.brand, modifier = Modifier.size(13.dp))
                            Text(" Admin, started the room · ", color = p.inkSoft, fontSize = 12.5.sp)
                        } else if (m.role == "admin") {
                            Icon(Icons.Rounded.AdminPanelSettings, null, tint = p.brand, modifier = Modifier.size(13.dp))
                            Text(" Admin · ", color = p.inkSoft, fontSize = 12.5.sp)
                        }
                        Text(if (online) "Online" else if (m.presenceHidden) "" else lastSeen(state.lastSeen[m.id] ?: m.lastSeenAt), color = if (online) p.liveInk else p.inkSoft, fontSize = 12.5.sp)
                    }
                }
                if (m.id != me) MemberMenu(room, m, admin, owner, onRemove = { removing = m })
            }
        }
        // People invited who haven't answered yet (admins).
        val invites = room.invites.orEmpty()
        if (room.myRole == "admin" && invites.isNotEmpty()) {
            Text("Waiting to join ${invites.size}", color = p.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
            invites.forEach { i ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(i.invitee.name, i.invitee.hue, i.invitee.photo, 32.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(i.invitee.name, color = p.ink, fontSize = 14.sp)
                        Text("Invited by ${i.invitedBy}", color = p.inkSoft, fontSize = 12.5.sp)
                    }
                    AddaButton("Cancel", { co.launch { runCatching { Graph.chat.cancelInvite(room.id, i.id) }.onFailure { Toasts.error(it.message ?: "") } } }, height = 36.dp, variant = Variant.Ghost)
                }
            }
        }
    }
    removing?.let { m ->
        ConfirmDialog("Remove ${m.name} from the room?", "They can be added again later.", "Remove", onConfirm = {
            co.launch { runCatching { Graph.chat.removeMember(room.id, m.id) }.onFailure { Toasts.error(it.message ?: "Couldn't remove them.") } }
        }, onDismiss = { removing = null })
    }
}

@Composable
private fun MemberMenu(room: Room, m: RoomMember, admin: Boolean, owner: Boolean, onRemove: () -> Unit) {
    val p = palette
    val co = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    val first = m.name.split(' ').first()
    fun act(block: suspend () -> Unit) = co.launch { runCatching { block() }.onFailure { Toasts.error(it.message ?: "That didn't work.") } }
    Box {
        IconBtn(Icons.Rounded.MoreVert, "Options for ${m.name}", { open = true }, size = 40.dp, tint = p.inkSoft)
        DropdownMenu(open, { open = false }, containerColor = p.surface) {
            DropdownMenuItem(text = { Text("Message $first", color = p.ink) }, onClick = { open = false; Nav.push(Screen.Chat(m.id)) })
            if (owner && m.id != room.ownerId) {
                DropdownMenuItem(text = { Text(if (m.role == "admin") "Remove as admin" else "Make admin", color = p.ink) }, onClick = {
                    open = false
                    act { Graph.chat.setRole(room.id, m.id, if (m.role == "admin") "member" else "admin") }
                })
            }
            // Admins keep voice in order (the room's starter only by its starter or the host).
            val canModerate = admin && (m.id != room.ownerId || Graph.auth.user?.siteAdmin == true) && (m.role != "admin" || owner || Graph.auth.user?.siteAdmin == true)
            if (canModerate) {
                DropdownMenuItem(text = { Text(if (m.voiceMuted) "Let $first talk in voice" else "Mute $first in voice", color = p.ink) }, onClick = {
                    open = false
                    act { Graph.chat.moderateVoice(room.id, m.id, voiceMuted = !m.voiceMuted) }
                })
                DropdownMenuItem(text = { Text(if (m.cameraBlocked) "Let $first turn their camera on" else "Stop $first's camera", color = p.ink) }, onClick = {
                    open = false
                    act { Graph.chat.moderateVoice(room.id, m.id, cameraBlocked = !m.cameraBlocked) }
                })
            }
            if (room.myRole == "admin" && m.id != room.ownerId && (m.role != "admin" || owner)) {
                DropdownMenuItem(text = { Text("Remove from room", color = p.danger) }, onClick = { open = false; onRemove() })
            }
        }
    }
}

/** The room's invite code (admins): share, copy, a new one, and whether joining needs a password. */
@Composable
private fun InviteCard(room: Room, code: String) {
    val p = palette
    val context = LocalContext.current
    val co = rememberCoroutineScope()
    var dialog by remember { mutableStateOf<String?>(null) }
    val link = "$appUrl/join/$code"
    Column(Modifier.fillMaxWidth().padding(top = 12.dp).clip(RoundedCornerShape(16.dp)).background(p.subtle).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Invite code", color = p.inkSoft, fontSize = 12.5.sp)
                Text(formatCode(code), color = p.ink, fontSize = 20.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
            }
            Choice(if (room.hasPassword) "Password" else "Open", room.hasPassword) { dialog = "access" }
        }
        Spacer(Modifier.height(10.dp))
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AddaButton("Share link", {
                share(context, "Join ${room.name} on Adda Khana: $link\nInvite code: ${formatCode(code)}" + if (room.hasPassword) " (ask me for the password)" else "")
            }, height = 36.dp)
            AddaButton("Copy code", { copy(context, formatCode(code), "Code copied") }, height = 36.dp, variant = Variant.Soft)
            AddaButton("Copy link", { copy(context, link, "Link copied") }, height = 36.dp, variant = Variant.Soft)
            AddaButton("New code", { dialog = "renew" }, height = 36.dp, variant = Variant.Ghost)
        }
    }
    when (dialog) {
        "renew" -> ConfirmDialog("Make a new invite code?", "The old code and link stop working.", "Make a new code", onConfirm = {
            co.launch { runCatching { Graph.chat.renewRoomCode(room.id) }.onFailure { Toasts.error(it.message ?: "") } }
        }, onDismiss = { dialog = null }, danger = false)
        "access" -> AccessDialog(room) { dialog = null }
    }
}

@Composable
private fun AccessDialog(room: Room, onDismiss: () -> Unit) {
    val co = rememberCoroutineScope()
    var locked by remember { mutableStateOf(room.hasPassword) }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AppDialog(onDismiss, "Who can join with the invite code", buttons = {
        AddaButton("Save", {
            busy = true
            co.launch {
                runCatching { Graph.chat.setRoomPassword(room.id, if (locked) password else null) }
                    .onSuccess { onDismiss() }
                    .onFailure { Toasts.error(it.message ?: "") }
                busy = false
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = !locked || password.length >= 4)
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Open", !locked) { locked = false }
            Choice("Password protected", locked) { locked = true }
        }
        if (locked) {
            Spacer(Modifier.height(10.dp))
            Field(password, { password = it }, placeholder = "New password (at least 4)", password = true)
        }
    }
}

@Composable
private fun RoomPhoto(room: Room, onDismiss: () -> Unit) {
    val co = rememberCoroutineScope()
    // A photo picked: fit it in the frame first.
    var editing by remember { mutableStateOf<android.net.Uri?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) editing = uri }
    editing?.let { uri ->
        com.addakhana.app.ui.components.PhotoEditor(
            uri,
            room = true,
            onUse = { jpeg ->
                Graph.chat.setRoomPhoto(room.id, jpeg)
                onDismiss()
            },
            onAnother = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onDismiss = { editing = null },
        )
        return
    }
    AppDialog(onDismiss, "Room photo", buttons = {
        AddaButton(if (room.photo != null) "Change" else "Add photo", { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, Modifier.fillMaxWidth())
        if (room.photo != null) AddaButton("Remove photo", {
            // The app's scope: this dialog closes at once, and its own would go with it.
            Graph.scope.launch { runCatching { Graph.chat.removeRoomPhoto(room.id) }.onFailure { Toasts.error(it.message ?: "Couldn't remove it.") } }
            onDismiss()
        }, Modifier.fillMaxWidth(), variant = Variant.DangerSoft)
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    })
}

/** The most of each unit (as the server allows). */
private val MOST = mapOf("minute" to 1440, "hour" to 720, "day" to 365, "month" to 12)
private val PRESETS = listOf(null to "Off", ClearAfter(1, "hour") to "1 hour", ClearAfter(24, "hour") to "24 hours", ClearAfter(7, "day") to "7 days", ClearAfter(30, "day") to "30 days", ClearAfter(3, "month") to "3 months")

private fun label(c: ClearAfter) = "${c.amount} ${c.unit}${if (c.amount == 1) "" else "s"}"

/** Chat history: messages older than a chosen time clear by themselves, for everyone (a preset, or a custom time). */
@Composable
private fun RoomHistory(room: Room) {
    val p = palette
    val co = rememberCoroutineScope()
    val current = room.clearAfter
    var choice by remember(current) { mutableStateOf(current) }
    var custom by remember(current) { mutableStateOf(current != null && PRESETS.none { it.first == current }) }
    var amount by remember(current) { mutableStateOf((current?.amount ?: 15).toString()) }
    var unit by remember(current) { mutableStateOf(current?.unit ?: "minute") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val customValue = amount.toIntOrNull()?.takeIf { it in 1..(MOST[unit] ?: 1) }?.let { ClearAfter(it, unit) }
    val wanted = if (custom) customValue else choice
    val changed = if (custom) wanted != null && wanted != current else choice != current
    Text("Chat history", color = p.ink, fontWeight = FontWeight.SemiBold)
    Text("Clear messages by themselves after a while, for everyone in the room.", color = p.inkSoft, fontSize = 13.sp)
    Spacer(Modifier.height(8.dp))
    @OptIn(ExperimentalLayoutApi::class)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PRESETS.forEach { (value, text) ->
            Choice(text, !custom && choice == value) {
                custom = false
                choice = value
                error = null
            }
        }
        Choice("Custom", custom) {
            custom = true
            error = null
        }
    }
    if (custom) {
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("After", color = p.inkSoft, fontSize = 14.sp)
            Spacer(Modifier.width(8.dp))
            Field(amount, { amount = it.filter { c -> c.isDigit() }.take(4) }, Modifier.width(88.dp), placeholder = "How many", keyboard = androidx.compose.ui.text.input.KeyboardType.Number)
        }
        Spacer(Modifier.height(8.dp))
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (u in listOf("minute", "hour", "day", "month")) Choice("${u}s", unit == u) { unit = u }
        }
        Text("1 to ${MOST[unit]} ${unit}s.", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 4.dp))
    }
    error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 6.dp)) }
    if (changed || (custom && wanted == null)) {
        Spacer(Modifier.height(10.dp))
        AddaButton("Apply", {
            if (custom && wanted == null) return@AddaButton run { error = "Choose 1 to ${MOST[unit]} ${unit}s." }
            busy = true
            error = null
            co.launch {
                try {
                    Graph.chat.setRoomHistory(room.id, wanted)
                    Toasts.show(if (wanted != null) "Messages now clear after ${label(wanted)}." else "Messages are kept now.")
                } catch (e: Exception) {
                    error = e.message
                } finally {
                    busy = false
                }
            }
        }, Modifier.fillMaxWidth(), loading = busy)
    }
}

/** Room settings (admins): name, description, size, chat history; the starter can delete the room. */
@Composable
private fun RoomSettings(room: Room, onDismiss: () -> Unit) {
    val p = palette
    val co = rememberCoroutineScope()
    var name by remember { mutableStateOf(room.name) }
    var description by remember { mutableStateOf(room.description) }
    var max by remember { mutableIntStateOf(room.maxMembers) }
    val limits = Graph.site.config.collectAsState().value.limits
    var busy by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<String?>(null) }
    val owner = room.ownerId == Graph.auth.user?.id
    AppDialog(onDismiss, "Room settings", buttons = {
        AddaButton("Save changes", {
            val n = max
            if (n < room.memberCount) return@AddaButton Toasts.error("The room has ${room.memberCount} members, so it can't be smaller than that.")
            busy = true
            co.launch {
                runCatching { Graph.chat.updateRoom(room.id, name.trim(), description.trim(), n) }.onSuccess { onDismiss() }.onFailure { Toasts.error(it.message ?: "") }
                busy = false
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = name.isNotBlank())
        AddaButton("Close", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Field(name, { name = it }, label = "Room name", maxLength = 60)
        Spacer(Modifier.height(10.dp))
        Field(description, { description = it }, label = "What's it for?", maxLength = 280, singleLine = false)
        Spacer(Modifier.height(10.dp))
        com.addakhana.app.ui.home.MembersStepper(max, { max = it }, maxOf(limits.minRoomMembers, room.memberCount), maxOf(limits.maxRoomMembers, room.maxMembers))
        Spacer(Modifier.height(16.dp))
        RoomHistory(room)
        Spacer(Modifier.height(10.dp))
        AddaButton("Clear chat history", { confirm = "clear" }, Modifier.fillMaxWidth(), variant = Variant.DangerSoft)
        if (owner) {
            Spacer(Modifier.height(16.dp))
            Text("Delete this room", color = p.danger, fontWeight = FontWeight.SemiBold)
            Text("Everyone is removed and the chat history is gone for good.", color = p.inkSoft, fontSize = 13.sp)
            Spacer(Modifier.height(6.dp))
            AddaButton("Delete room", { confirm = "delete" }, Modifier.fillMaxWidth(), variant = Variant.Danger)
        }
    }
    when (confirm) {
        "clear" -> ConfirmDialog("Clear all of ${room.name}'s messages for everyone?", "Every message, photo and file goes, for everyone.", "Clear history", onConfirm = {
            co.launch { runCatching { Graph.chat.clearRoomHistory(room.id) }.onFailure { Toasts.error(it.message ?: "") } }
        }, onDismiss = { confirm = null }, cancel = "Keep them")
        "delete" -> ConfirmDialog("Delete ${room.name} for everyone?", "This can't be undone.", "Delete room", onConfirm = {
            co.launch {
                runCatching { Graph.chat.deleteRoom(room.id) }.onSuccess { onDismiss(); Nav.leaveRoom(room.id) }.onFailure { Toasts.error(it.message ?: "") }
            }
        }, onDismiss = { confirm = null })
    }
}
