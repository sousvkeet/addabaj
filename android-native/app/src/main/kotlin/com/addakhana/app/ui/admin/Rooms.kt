package com.addakhana.app.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.HideImage
import androidx.compose.material.icons.rounded.OndemandVideo
import androidx.compose.material.icons.rounded.Sensors
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.AdminRoom
import com.addakhana.app.model.Paged
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppSheet
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.ConfirmDialog
import com.addakhana.app.ui.components.SheetItem
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.home.ListSearch
import com.addakhana.app.ui.listStamp
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val PAGE = 40

/** Every room on the site: its people, what's playing in it, its photo, or the whole room. */
@Composable
internal fun RoomsPage() {
    val p = palette
    val co = rememberCoroutineScope()
    val list = rememberLazyListState()
    var q by remember { mutableStateOf("") }
    var data by remember { mutableStateOf<Paged<AdminRoom>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loadingMore by remember { mutableStateOf(false) }
    var acting by remember { mutableStateOf<AdminRoom?>(null) }
    var deleting by remember { mutableStateOf<AdminRoom?>(null) }
    // The room whose people are open (a page of its own, over this list).
    var people by remember { mutableStateOf<AdminRoom?>(null) }

    LaunchedEffect(q) {
        if (q.isNotEmpty()) delay(250)
        attempt { Graph.api.adminRooms(q, PAGE) }
            .onSuccess {
                data = it
                error = null
            }
            .onFailure { error = reason(it) }
    }

    fun change(id: String, block: (AdminRoom) -> AdminRoom) {
        data = data?.let { d -> d.copy(items = d.items.map { if (it.id == id) block(it) else it }) }
    }

    // These go on whatever happens to the page (the sheet that started them is already closed).
    fun stopVideo(room: AdminRoom) = Graph.scope.launch {
        attempt { Graph.api.stopRoomVideo(room.id) }
            .onSuccess {
                change(room.id) { it.copy(watching = null, live = false) }
                Toasts.show("The video in ${room.name} was stopped.")
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    /** Takes down a room's photo (back to its letter). */
    fun removePhoto(room: AdminRoom) = Graph.scope.launch {
        attempt { Graph.api.takeDownRoomPhoto(room.id) }
            .onSuccess {
                change(room.id) { it.copy(photo = null) }
                Toasts.show("${room.name}'s photo was removed.")
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    fun remove(room: AdminRoom) = Graph.scope.launch {
        attempt { Graph.api.removeRoom(room.id) }
            .onSuccess {
                data = data?.let { d -> Paged(d.items.filterNot { it.id == room.id }, d.total - 1) }
                Toasts.show("${room.name} was deleted.")
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    people?.let { room ->
        RoomMembersPage(
            room,
            onBack = { people = null },
            onChanged = { count, owner -> change(room.id) { it.copy(memberCount = count, owner = owner ?: it.owner) } },
        )
        return
    }

    Column(Modifier.fillMaxSize().background(p.canvas)) {
        AdminHeader("Rooms", data?.let { "${num(it.total)} ${if (it.total == 1) "room" else "rooms"}" } ?: "Every room on the site")
        LazyColumn(Modifier.fillMaxSize().imePadding().navigationBarsPadding(), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
            item { ListSearch(q, { q = it }, "Search by room or owner name") }
            error?.let { item { ErrorBox(it, Modifier.padding(16.dp)) } }
            val d = data
            when {
                d == null -> if (error == null) item { Loading() }
                d.items.isEmpty() -> item { Box(Modifier.padding(16.dp)) { EmptyBox(if (q.isNotEmpty()) "No rooms match that." else "No rooms yet.") } }
                else -> items(d.items, key = { it.id }) { r -> RoomRow(r) { acting = r } }
            }
            if (d != null && d.items.size < d.total) {
                item {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        AddaButton("Show more", {
                            loadingMore = true
                            co.launch {
                                attempt { Graph.api.adminRooms(q, PAGE, offset = d.items.size) }
                                    .onSuccess { page -> data = data?.let { prev -> Paged(prev.items + page.items, page.total) } }
                                    .onFailure { Toasts.error(reason(it)) }
                                loadingMore = false
                            }
                        }, variant = Variant.Soft, loading = loadingMore)
                    }
                }
            }
        }
    }

    acting?.let { r ->
        AppSheet({ acting = null }, title = r.name) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp)) {
                Fact("Members", Modifier.weight(1f)) { FactText("${r.memberCount} of ${r.maxMembers}") }
                Fact("Messages", Modifier.weight(1f)) { FactText(num(r.messages)) }
                Fact("Started", Modifier.weight(1f)) { FactText(shortDate(r.createdAt)) }
            }
            SheetItem(Icons.Rounded.Group, "Add or remove people", { acting = null; people = r })
            if (r.watching != null) SheetItem(Icons.Rounded.Stop, if (r.live) "Stop the live stream" else "Stop the video", { acting = null; stopVideo(r) })
            if (r.photo != null) SheetItem(Icons.Rounded.HideImage, "Remove room photo", { acting = null; removePhoto(r) })
            SheetItem(Icons.Rounded.Delete, "Delete room", { acting = null; deleting = r }, danger = true)
        }
    }
    deleting?.let { r ->
        ConfirmDialog(
            "Delete ${r.name}?",
            "Everyone in it is removed and its chat history is gone for good. Its ${r.memberCount} members are told right away.",
            "Delete room",
            onConfirm = { remove(r) },
            onDismiss = { deleting = null },
        )
    }
}

@Composable
private fun RoomRow(r: AdminRoom, onClick: () -> Unit) {
    val p = palette
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(r.name, hueFromId(r.id), r.photo, 44.dp, room = true)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(r.name, color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(r.lastActivityAt?.let { listStamp(it) } ?: "No activity", color = p.inkSoft, fontSize = 12.5.sp)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(r.owner.name, r.owner.hue, r.owner.photo, 16.dp)
                Spacer(Modifier.width(6.dp))
                Text(r.owner.name + (r.watching?.let { " · “$it”" } ?: ""), color = p.inkSoft, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (r.inVoice > 0 || r.watching != null) {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (r.inVoice > 0) Chip("${r.inVoice} in voice", Tone.Live, Icons.Rounded.GraphicEq)
                    if (r.live) Chip("Live", Tone.Danger, Icons.Rounded.Sensors)
                    else if (r.watching != null) Chip("Watching", Tone.Muted, Icons.Rounded.OndemandVideo)
                }
            }
        }
    }
}
