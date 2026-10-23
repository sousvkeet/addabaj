package com.addakhana.app.ui.home

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.addakhana.app.ui.components.IconBtn
import androidx.compose.material.icons.Icons
import kotlin.math.roundToInt
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material.icons.rounded.Add
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.RoomPreview
import com.addakhana.app.model.User
import com.addakhana.app.net.appUrl
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch

/** "Mute X?": for 8 hours, a week, or until turned back on. */
@Composable
fun MuteDialog(name: String, room: Boolean, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    AppDialog(
        onDismiss,
        "Mute $name?",
        if (room) "You won't be notified of its messages, except ones that mention you or reply to you." else "You won't be notified of their messages. Calls still ring.",
        buttons = {
            AddaButton("8 hours", { onPick("8h") }, Modifier.fillMaxWidth(), variant = Variant.Soft)
            AddaButton("1 week", { onPick("1w") }, Modifier.fillMaxWidth(), variant = Variant.Soft)
            AddaButton("Always", { onPick("always") }, Modifier.fillMaxWidth(), variant = Variant.Soft)
            AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
        },
    )
}

fun copy(context: Context, text: String, toast: String? = null) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Adda Khana", text))
    // Android 13+ shows its own note when something is copied.
    if (toast != null && android.os.Build.VERSION.SDK_INT < 33) Toasts.show(toast)
}

fun share(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/** How many people a room can hold: minus, plus, or the slider. */
@Composable
internal fun MembersStepper(value: Int, onChange: (Int) -> Unit, least: Int, most: Int) {
    val p = palette
    Text("Maximum members: $value", color = p.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconBtn(Icons.Rounded.Remove, "Fewer members", { onChange((value - 1).coerceAtLeast(least)) }, size = 40.dp, enabled = value > least)
        Slider(
            value = value.toFloat(),
            onValueChange = { onChange(it.roundToInt().coerceIn(least, most)) },
            valueRange = least.toFloat()..most.toFloat(),
            colors = SliderDefaults.colors(thumbColor = p.brand, activeTrackColor = p.brand, inactiveTrackColor = p.line),
            modifier = Modifier.weight(1f),
        )
        IconBtn(Icons.Rounded.Add, "More members", { onChange((value + 1).coerceAtMost(most)) }, size = 40.dp, enabled = value < most)
    }
}

/**
 * Finding someone: by their exact user ID or email (nobody is listed). For a
 * room, they can be added or invited.
 */
@Composable
fun UserPicker(onDismiss: () -> Unit, roomId: String? = null) {
    val p = palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<User?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val me = Graph.auth.user
    val room = roomId?.let { Graph.chat.now.roomDetails[it] ?: Graph.chat.now.rooms[it] }
    fun find() {
        if (busy || query.isBlank()) return
        busy = true
        error = null
        found = null
        scope.launch {
            try {
                found = Graph.api.findUser(query.trim().removePrefix("@"), roomId)
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }
    AppDialog(
        onDismiss,
        if (room != null) "Add people to ${room.name}" else "Start a chat",
        if (room != null) "${room.memberCount} of ${room.maxMembers} seats taken, ${maxOf(0, room.maxMembers - room.memberCount)} left." else "Enter their user ID or email. Ask your friend for it: nobody is listed.",
        buttons = { AddaButton("Close", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost) },
    ) {
        Field(query, { query = it; found = null; error = null }, placeholder = "User ID or email", keyboard = KeyboardType.Email, imeAction = ImeAction.Search, onDone = ::find,
            trailing = { AddaButton("Find", ::find, height = 36.dp, loading = busy, enabled = query.isNotBlank()) })
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
        found?.let { u ->
            Spacer(Modifier.height(12.dp))
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.subtle).padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(u.name, u.hue, u.photo, 44.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(u.name, color = p.ink, fontWeight = FontWeight.SemiBold)
                    u.handle?.let { Text("@$it", color = p.inkSoft, fontSize = 13.sp) }
                }
                if (roomId == null) {
                    AddaButton("Message", {
                        Graph.chat.rememberUser(u)
                        onDismiss()
                        Nav.push(Screen.Chat(u.id))
                    }, height = 36.dp)
                } else {
                    when (u.roomStatus) {
                        "member" -> Text("In the room", color = p.inkSoft, fontSize = 13.sp)
                        "invited" -> Text("Invited", color = p.inkSoft, fontSize = 13.sp)
                        else -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            AddaButton("Invite", {
                                scope.launch {
                                    runCatching { Graph.chat.inviteMember(roomId, u.id) }.onSuccess { Toasts.show("Invited ${u.name}."); found = u.copy(roomStatus = "invited") }.onFailure { Toasts.error(it.message ?: "Couldn't invite them.") }
                                }
                            }, height = 36.dp, variant = Variant.Soft)
                            AddaButton("Add", {
                                scope.launch {
                                    runCatching { Graph.chat.addMember(roomId, u.id) }.onSuccess { Toasts.show("Added ${u.name}."); found = u.copy(roomStatus = "member") }.onFailure { Toasts.error(it.message ?: "Couldn't add them.") }
                                }
                            }, height = 36.dp)
                        }
                    }
                }
            }
        }
        if (roomId == null && me?.handle != null) {
            Spacer(Modifier.height(16.dp))
            Text("Your user ID, for friends to find you", color = p.inkSoft, fontSize = 13.sp)
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("@${me.handle}", color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                AddaButton("Copy", { copy(context, me.handle, "Copied") }, height = 36.dp, variant = Variant.Soft)
                Spacer(Modifier.width(6.dp))
                AddaButton("Share", { share(context, "Find me on Adda Khana: my user ID is ${me.handle}\n$appUrl") }, height = 36.dp, variant = Variant.Soft)
            }
        }
    }
}

/** "Start a room": you're its admin; it opens with Add people. */
@Composable
fun CreateRoomDialog(onDismiss: () -> Unit) {
    val p = palette
    val scope = rememberCoroutineScope()
    val limits = Graph.site.config.value.limits
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var max by remember { mutableIntStateOf(12.coerceIn(limits.minRoomMembers, limits.maxRoomMembers)) }
    var locked by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AppDialog(
        onDismiss,
        "Start a room",
        "You'll be the room's admin. Share its invite code, or add people by their user ID.",
        buttons = {
            AddaButton("Start room", {
                if (locked && password.length < 4) {
                    error = "Use at least 4 characters for the password."
                    return@AddaButton
                }
                busy = true
                scope.launch {
                    try {
                        val room = Graph.chat.createRoom(name.trim(), description.trim(), max, if (locked) password else null)
                        onDismiss()
                        Nav.push(Screen.Room(room.id))
                        // Then straight on to adding people, as nobody else is in it yet.
                        Nav.push(Screen.RoomInfo(room.id, adding = true))
                    } catch (e: Exception) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            }, Modifier.fillMaxWidth(), loading = busy, enabled = name.isNotBlank())
            AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
        },
    ) {
        Field(name, { name = it }, label = "Room name", maxLength = 60, placeholder = "Friday adda")
        Spacer(Modifier.height(12.dp))
        Field(description, { description = it }, label = "What's it for?", maxLength = 280, singleLine = false, placeholder = "Optional")
        Spacer(Modifier.height(12.dp))
        MembersStepper(max, { max = it }, limits.minRoomMembers, limits.maxRoomMembers)
        Text("Who can join with the invite code", color = p.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Open", !locked) { locked = false }
            Choice("Password protected", locked) { locked = true }
        }
        if (locked) {
            Spacer(Modifier.height(10.dp))
            Field(password, { password = it }, placeholder = "Password (at least 4)", password = true)
        }
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
}

@Composable
fun Choice(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = palette
    Text(
        label,
        color = if (selected) p.brand else p.ink,
        fontSize = 13.5.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, if (selected) p.brand else p.line, RoundedCornerShape(12.dp))
            .background(if (selected) p.brand.copy(alpha = 0.12f) else p.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

/** Joining with a code (K7PQ-2XMB): find the room, then join (with its password, if it has one). */
@Composable
fun JoinRoomDialog(onDismiss: () -> Unit, initialCode: String = "") {
    val p = palette
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf(initialCode) }
    var preview by remember { mutableStateOf<RoomPreview?>(null) }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun clean(c: String) = c.uppercase().filter { it.isLetterOrDigit() }
    fun find() {
        if (busy || clean(code).length < 8) return
        busy = true
        error = null
        scope.launch {
            try {
                preview = Graph.api.roomPreview(clean(code))
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }
    fun join() {
        val room = preview ?: return
        if (room.member) {
            onDismiss()
            Nav.push(Screen.Room(room.id))
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                val joined = Graph.chat.joinRoom(clean(code), password.ifEmpty { null })
                onDismiss()
                Nav.push(Screen.Room(joined.id))
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }
    AppDialog(
        onDismiss,
        "Join a room",
        "Enter the invite code someone shared with you.",
        buttons = {
            val room = preview
            if (room == null) AddaButton("Find room", ::find, Modifier.fillMaxWidth(), loading = busy, enabled = clean(code).length >= 8)
            else AddaButton(if (room.member) "Open room" else "Join room", ::join, Modifier.fillMaxWidth(), loading = busy, enabled = room.member || room.memberCount < room.maxMembers)
            AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
        },
    ) {
        Field(code, { code = it.uppercase().take(12); preview = null }, placeholder = "K7PQ-2XMB", imeAction = ImeAction.Search, onDone = ::find)
        preview?.let { room ->
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.subtle).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(room.name, hueFromId(room.id), room.photo, 44.dp, room = true)
                Spacer(Modifier.width(12.dp))
                Column {
                    Text(room.name, color = p.ink, fontWeight = FontWeight.SemiBold)
                    Text("${room.memberCount} of ${room.maxMembers} members", color = p.inkSoft, fontSize = 13.sp)
                }
            }
            if (!room.member && room.memberCount >= room.maxMembers) {
                Text("This room is full. Ask one of its admins to make room.", color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp))
            }
            if (room.needsPassword && !room.member) {
                Spacer(Modifier.height(10.dp))
                Field(password, { password = it }, placeholder = "Password", password = true, imeAction = ImeAction.Go, onDone = ::join)
            }
        }
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
}

/** The code as people read it: K7PQ-2XMB. */
fun formatCode(code: String) = if (code.length == 8) code.substring(0, 4) + "-" + code.substring(4) else code

