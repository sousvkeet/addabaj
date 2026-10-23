package com.addakhana.app.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Mail
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.Invite
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.EmptyState
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.hueFromId
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch

/** The Invites tab: rooms someone invited me to, to join or decline. */
@Composable
fun InvitesTab() {
    val state by Graph.chat.state.collectAsState()
    Column(Modifier.fillMaxSize()) {
        ListHeader("Invites")
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(state.invites, key = { it.id }) { InviteCard(it) }
            if (state.invites.isEmpty() && state.bootstrapped) {
                item { EmptyState(Icons.Rounded.Mail, "No invites right now", "When someone invites you to a room, it shows up here.") }
            }
        }
    }
}

@Composable
private fun InviteCard(invite: Invite) {
    val p = palette
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    val full = invite.room.memberCount >= invite.room.maxMembers
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), RoundedCornerShape(20.dp))) {
        Box(Modifier.fillMaxWidth().height(4.dp).background(p.aurora))
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(invite.room.name, hueFromId(invite.room.id), invite.room.photo, 48.dp, room = true)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(invite.room.name, color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    Text("${invite.inviter.name} invited you", color = p.inkSoft, fontSize = 13.5.sp)
                    Text(if (full) "This room is full right now" else "${invite.room.memberCount} of ${invite.room.maxMembers} members", color = if (full) p.danger else p.inkSoft, fontSize = 12.5.sp)
                }
            }
            if (invite.room.description.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(invite.room.description, color = p.ink, fontSize = 14.sp)
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AddaButton("Join room", {
                    busy = "join"
                    scope.launch {
                        runCatching { Graph.chat.acceptInvite(invite.id) }
                            .onSuccess { Nav.push(Screen.Room(it.id)) }
                            .onFailure { Toasts.error(it.message ?: "Couldn't join.") }
                        busy = null
                    }
                }, Modifier.weight(1f), enabled = !full, loading = busy == "join")
                AddaButton("Decline", {
                    busy = "decline"
                    scope.launch {
                        runCatching { Graph.chat.declineInvite(invite.id) }.onFailure { Toasts.error(it.message ?: "Couldn't decline.") }
                        busy = null
                    }
                }, Modifier.weight(1f), variant = Variant.Soft, loading = busy == "decline")
            }
        }
    }
}
