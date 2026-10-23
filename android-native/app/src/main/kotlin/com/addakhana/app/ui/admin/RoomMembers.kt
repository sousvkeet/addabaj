package com.addakhana.app.ui.admin

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material.icons.rounded.PersonRemove
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.AdminRoom
import com.addakhana.app.model.AdminUser
import com.addakhana.app.model.HostMember
import com.addakhana.app.model.RoomOwner
import com.addakhana.app.model.RoomPeople
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.SectionLabel
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.home.ListSearch
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The host's view of a room's people: add anyone on the site, remove anyone
 * in it. `onChanged` gets how many are in it now, and who runs it.
 */
@Composable
internal fun RoomMembersPage(room: AdminRoom, onBack: () -> Unit, onChanged: (Int, RoomOwner?) -> Unit) {
    val p = palette
    BackHandler(onBack = onBack)
    var data by remember { mutableStateOf<RoomPeople?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var q by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<AdminUser>?>(null) }
    // "add:<id>" or "remove:<id>" while that runs.
    var busy by remember { mutableStateOf<String?>(null) }
    // The member whose removal is being confirmed.
    var removing by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(room.id) {
        attempt { Graph.api.roomPeople(room.id) }
            .onSuccess {
                data = it
                error = null
            }
            .onFailure { error = reason(it) }
    }

    // People to add: anyone on the site, by name, email or user ID.
    LaunchedEffect(q) {
        if (q.isBlank()) {
            found = null
            return@LaunchedEffect
        }
        delay(250)
        attempt { Graph.api.adminUsers(q.trim(), 8) }.onSuccess { found = it.items }.onFailure { error = reason(it) }
    }

    fun changed(after: RoomPeople) {
        data = after
        val owner = after.members.firstOrNull { it.owner }
        onChanged(after.members.size, owner?.let { RoomOwner(it.id, it.name, it.hue, it.photo) })
    }

    // On in the app's scope: the room list hears how it went even if this page is closed meanwhile.
    fun add(user: AdminUser) {
        busy = "add:${user.id}"
        Graph.scope.launch {
            attempt { Graph.api.hostAddMember(room.id, user.id) }
                .onSuccess {
                    changed(it)
                    Toasts.show("${user.name} is in ${room.name} now.")
                }
                .onFailure { Toasts.error(reason(it)) }
            busy = null
        }
    }

    fun remove(member: HostMember) {
        busy = "remove:${member.id}"
        Graph.scope.launch {
            attempt { Graph.api.hostRemoveMember(room.id, member.id) }
                .onSuccess {
                    changed(it)
                    removing = null
                    Toasts.show("${member.name} was removed from ${room.name}.")
                }
                .onFailure { Toasts.error(reason(it)) }
            busy = null
        }
    }

    val d = data
    val members = d?.members.orEmpty()
    val inRoom = members.map { it.id }.toSet()
    val full = d != null && members.size >= d.room.maxMembers
    // Who runs the room if its starter is removed: its longest-serving admin, else its longest-standing member.
    val nextOwner = members.filterNot { it.owner }.sortedWith(compareByDescending<HostMember> { it.role == "admin" }.thenBy { it.joinedAt }).firstOrNull()

    Column(Modifier.fillMaxSize().background(p.canvas)) {
        AdminHeader("People in ${room.name}", null, onBack = onBack)
        LazyColumn(Modifier.fillMaxSize().imePadding().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (d != null) {
                item {
                    Text(
                        "${members.size} of ${d.room.maxMembers} seats taken. As the host you can add anyone and remove anyone.",
                        color = p.inkSoft,
                        fontSize = 13.5.sp,
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                    )
                }
            }
            error?.let { item { ErrorBox(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) } }
            item { ListSearch(q, { q = it }, "Add someone: name, email or user ID") }
            if (full && q.isNotEmpty()) {
                item {
                    Text(
                        "The room is full. Its admins can raise the member limit in room settings.",
                        color = p.danger,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }
            found?.let { list ->
                item {
                    val shape = RoundedCornerShape(16.dp)
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth().clip(shape).border(1.dp, p.line.copy(alpha = 0.7f), shape)) {
                        if (list.isEmpty()) Text("No one matches “$q”.", color = p.inkSoft, fontSize = 14.sp, modifier = Modifier.padding(12.dp))
                        list.forEachIndexed { i, u ->
                            if (i > 0) HorizontalDivider(color = p.line.copy(alpha = 0.6f))
                            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Avatar(u.name, u.hue, u.photo, 34.dp)
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(u.name, color = p.ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(u.handle?.let { "@$it" } ?: u.email, color = p.inkSoft, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                when {
                                    u.id in inRoom -> Text("In the room", color = p.inkSoft, fontSize = 13.sp)
                                    u.disabled -> Chip("Switched off", Tone.Danger)
                                    else -> AddaButton(
                                        "Add",
                                        { add(u) },
                                        height = 36.dp,
                                        icon = Icons.Rounded.PersonAdd,
                                        enabled = busy == null && !full,
                                        loading = busy == "add:${u.id}",
                                    )
                                }
                            }
                        }
                    }
                }
            }
            item { SectionLabel("Members", Modifier.padding(top = 8.dp)) }
            if (d == null) {
                if (error == null) item { Loading() }
            } else {
                items(members, key = { it.id }) { m ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(m.name, m.hue, m.photo, 36.dp)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(m.name, color = p.ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                    Spacer(Modifier.width(6.dp))
                                    if (m.owner) Chip("Owner", Tone.Brand, Icons.Rounded.Star)
                                    else if (m.role == "admin") Chip("Admin", Tone.Muted, Icons.Rounded.VerifiedUser)
                                }
                                Text(m.handle?.let { "@$it" } ?: m.email, color = p.inkSoft, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            AddaButton("Remove", { removing = m.id }, height = 36.dp, variant = Variant.DangerGhost, icon = Icons.Rounded.PersonRemove, enabled = busy == null)
                        }
                        if (removing == m.id) {
                            Column(Modifier.padding(top = 6.dp, bottom = 4.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.danger.copy(alpha = 0.1f)).padding(10.dp)) {
                                Text(
                                    when {
                                        !m.owner -> "Remove ${m.name} from ${room.name}?"
                                        nextOwner != null -> "${m.name} started the room. Remove them? ${nextOwner.name} will run it."
                                        else -> "${m.name} is the only one here. Delete the room instead."
                                    },
                                    color = p.danger,
                                    fontSize = 13.5.sp,
                                )
                                @OptIn(ExperimentalLayoutApi::class)
                                FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    AddaButton("Cancel", { removing = null }, height = 36.dp, variant = Variant.Ghost)
                                    if (!m.owner || nextOwner != null) {
                                        AddaButton("Remove", { remove(m) }, height = 36.dp, variant = Variant.Danger, loading = busy == "remove:${m.id}")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
