package com.addakhana.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import com.addakhana.app.ui.components.IconBtn
import androidx.compose.ui.text.withStyle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.ChatBubble
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Mail
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.AuthState
import com.addakhana.app.data.UiPrefs
import com.addakhana.app.data.countedDmUnread
import com.addakhana.app.data.countedUnread
import com.addakhana.app.ui.admin.AdminScreen
import com.addakhana.app.ui.auth.AuthScreen
import com.addakhana.app.ui.call.CallBar
import com.addakhana.app.ui.call.CallStage
import com.addakhana.app.ui.call.IncomingCallScreen
import com.addakhana.app.ui.call.RoomCallStage
import com.addakhana.app.ui.call.VoiceBar
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.Logo
import com.addakhana.app.ui.components.ToastHost
import com.addakhana.app.ui.components.Wordmark
import com.addakhana.app.ui.home.ChatsTab
import com.addakhana.app.ui.home.InvitesTab
import com.addakhana.app.ui.home.RoomsTab
import com.addakhana.app.ui.home.YouTab
import com.addakhana.app.ui.room.RoomInfoScreen
import com.addakhana.app.ui.theme.AddaTheme
import com.addakhana.app.ui.theme.palette
import com.addakhana.app.ui.thread.ChatScreen
import com.addakhana.app.ui.thread.RoomScreen

/** The whole app: the splash while it starts, the login, or the chats. */
@Composable
fun AddaRoot(leave: () -> Unit) {
    val theme by UiPrefs.theme.collectAsState()
    AddaTheme(theme) {
        val p = palette
        val auth by Graph.auth.state.collectAsState()
        // Light status and navigation bar icons on the dark theme, dark ones on the light.
        val view = androidx.compose.ui.platform.LocalView.current
        androidx.compose.runtime.SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
            androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !p.dark
                isAppearanceLightNavigationBars = !p.dark
            }
        }
        val inPip by com.addakhana.app.MainActivity.pip.collectAsState()
        if (inPip) {
            com.addakhana.app.ui.call.PipView()
            return@AddaTheme
        }
        Box(Modifier.fillMaxSize().background(p.canvas)) {
            when (auth) {
                AuthState.Loading -> Splash()
                AuthState.SignedOut -> AuthScreen()
                is AuthState.SignedIn -> Main(leave)
            }
            ToastHost(bottom = if (auth is AuthState.SignedIn && Nav.top is Screen.Home) 84.dp else 24.dp)
        }
    }
}

@Composable
private fun Splash() {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Logo(76.dp)
        Spacer(Modifier.height(16.dp))
        Wordmark(22f)
    }
}

@Composable
private fun Main(leave: () -> Unit) {
    val p = palette
    val call by Graph.calls.state.collectAsState()
    val voice by Graph.voice.state.collectAsState()
    val chat by Graph.chat.state.collectAsState()
    val top = Nav.top
    BackHandler { if (!Nav.back()) leave() }

    // "Before you start", once after the first login.
    var permissions by remember { mutableStateOf(!com.addakhana.app.data.Permissions.seen) }
    if (permissions) {
        com.addakhana.app.ui.home.PermissionsScreen(onDone = { permissions = false })
        return
    }
    val cams = voice.roomId?.let { id -> chat.voice[id].orEmpty().count { it.camera } } ?: 0
    val roomStage = voice.live && !voice.minimized && (cams > 0 || voice.cameraOn)
    val callStage = call.inCall && !call.minimized
    // A call's stage layout (who's full screen or floating) lasts until it ends.
    androidx.compose.runtime.LaunchedEffect(call.idle && !voice.active) { if (call.idle && !voice.active) com.addakhana.app.ui.call.Stages.clear() }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            // A call or room voice going on: its bar at the top (it takes the status bar's space, so the screens below don't).
            // My live stream, while I'm away from its room.
            val live by Graph.live.state.collectAsState()
            val streaming = live.host?.let { h -> (top as? Screen.Room)?.roomId != h.roomId } == true
            val topBar = (call.inCall && call.minimized) || (voice.active && !callStage) || streaming
            // The host's announcement, on the lists (under a bar, or in the status bar's place).
            val site by Graph.site.site.collectAsState()
            val dismissed by Graph.site.dismissed.collectAsState()
            val announcing = top is Screen.Home && site.announcement?.let { it.id != dismissed && it.text.isNotBlank() } == true
            val bar = topBar || announcing
            if (call.inCall && call.minimized) CallBar()
            else if (voice.active && !callStage) VoiceBar()
            else if (streaming) com.addakhana.app.ui.watch.StreamBar()
            if (announcing) Announcement(statusBar = !topBar)
            Box(Modifier.weight(1f).then(if (bar) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
                AnimatedContent(
                    targetState = top,
                    transitionSpec = {
                        val tabSwitch = initialState is Screen.Home && targetState is Screen.Home
                        when {
                            tabSwitch -> fadeIn(tween(210, delayMillis = 60)) togetherWith fadeOut(tween(90))
                            Nav.forward.value -> slideInHorizontally(tween(320)) { it } togetherWith slideOutHorizontally(tween(320)) { -it / 4 } + fadeOut(tween(320), 0.7f)
                            else -> slideInHorizontally(tween(260)) { -it / 4 } togetherWith slideOutHorizontally(tween(260)) { it }
                        }
                    },
                    label = "screens",
                ) { screen ->
                    Box(Modifier.fillMaxSize().background(p.canvas).then(if (screen is Screen.Home) Modifier.statusBarsPadding() else Modifier)) {
                        when (screen) {
                            is Screen.Home -> when (screen.tab) {
                                Tab.Chats -> ChatsTab()
                                Tab.Rooms -> RoomsTab(Nav.joinCode.also { Nav.joinCode = null })
                                Tab.Invites -> InvitesTab()
                                Tab.You -> YouTab()
                            }
                            is Screen.Chat -> ChatScreen(screen.partnerId)
                            is Screen.Room -> RoomScreen(screen.roomId)
                            is Screen.RoomInfo -> RoomInfoScreen(screen.roomId, screen.adding)
                            is Screen.Admin -> AdminScreen(screen.page)
                            is Screen.Storage -> com.addakhana.app.ui.home.StorageDataScreen(screen.page)
                        }
                    }
                }
            }
            if (top is Screen.Home) TabBar(top.tab, chat)
        }
        // The room's video, small, while I'm elsewhere: above the message box in a chat, above the round button on a list.
        com.addakhana.app.ui.watch.WatchDock(bottom = if (top is Screen.Home) 150.dp else 84.dp)
        com.addakhana.app.ui.watch.WatchFullscreen()
        if (roomStage) RoomCallStage()
        if (callStage) CallStage()
        if (call.phase == "incoming") IncomingCallScreen()
        CallBanners()
        com.addakhana.app.ui.home.AppUpdate()
        // The host admin still on the default password of a public server: a new one first.
        val auth by Graph.auth.state.collectAsState()
        if ((auth as? AuthState.SignedIn)?.user?.passwordChangeRequired == true) com.addakhana.app.ui.home.PasswordDialog(onDismiss = {}, required = true)
    }
}

@Composable
private fun TabBar(current: Tab, chat: com.addakhana.app.data.ChatState) {
    val p = palette
    val me = Graph.auth.user
    val chats = chat.conversations.values.sumOf { countedDmUnread(it) }
    val rooms = chat.rooms.values.sumOf { countedUnread(it) }
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.rail)
            .drawBehind { drawLine(p.railLine, androidx.compose.ui.geometry.Offset.Zero, androidx.compose.ui.geometry.Offset(size.width, 0f), 1.dp.toPx()) }
            .navigationBarsPadding()
            .height(68.dp)
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        TabItem("Chats", Icons.Rounded.ChatBubble, current == Tab.Chats, chats) { Nav.tab(Tab.Chats) }
        TabItem("Rooms", Icons.Rounded.Groups, current == Tab.Rooms, rooms) { Nav.tab(Tab.Rooms) }
        TabItem("Invites", Icons.Rounded.Mail, current == Tab.Invites, chat.invites.size) { Nav.tab(Tab.Invites) }
        Column(Modifier.clickable { Nav.tab(Tab.You) }.padding(horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(56.dp, 32.dp).clip(CircleShape).background(if (current == Tab.You) p.brand.copy(alpha = if (p.dark) 0.4f else 0.18f) else Color.Transparent), contentAlignment = Alignment.Center) {
                if (me != null) Avatar(me.name, me.hue, me.photo, 26.dp)
            }
            Text("You", color = if (current == Tab.You) p.railInk else p.railInk.copy(alpha = 0.6f), fontSize = 12.sp, fontWeight = if (current == Tab.You) FontWeight.Bold else FontWeight.SemiBold)
        }
    }
}

@Composable
private fun TabItem(label: String, icon: ImageVector, active: Boolean, badge: Int, onClick: () -> Unit) {
    val p = palette
    Column(Modifier.clickable(onClick = onClick).padding(horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box {
            Box(Modifier.size(56.dp, 32.dp).clip(CircleShape).background(if (active) p.brand.copy(alpha = if (p.dark) 0.4f else 0.18f) else Color.Transparent), contentAlignment = Alignment.Center) {
                Icon(icon, label, tint = if (active) (if (p.dark) Color.White else p.brand) else p.railInk.copy(alpha = 0.6f), modifier = Modifier.size(21.dp))
            }
            if (badge > 0) {
                Box(
                    Modifier.align(Alignment.TopEnd).offset(x = (-6).dp, y = (-4).dp).size(width = if (badge > 9) 26.dp else 19.dp, height = 19.dp).clip(CircleShape).background(p.rail).padding(2.dp).clip(CircleShape).background(p.brand2),
                    contentAlignment = Alignment.Center,
                ) { Text(if (badge > 99) "99+" else badge.toString(), color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold) }
            }
        }
        Text(label, color = if (active) p.railInk else p.railInk.copy(alpha = 0.6f), fontSize = 12.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold)
    }
}

/** The host's announcement, at the top until dismissed. */
@Composable
private fun Announcement(statusBar: Boolean) {
    val p = palette
    val site by Graph.site.site.collectAsState()
    val a = site.announcement ?: return
    Row(
        Modifier.fillMaxWidth().background(p.aurora).then(if (statusBar) Modifier.statusBarsPadding() else Modifier).padding(start = 16.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(Icons.Rounded.Campaign, null, tint = Color.White, modifier = Modifier.padding(top = 2.dp).size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(
            androidx.compose.ui.text.buildAnnotatedString {
                withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)) { append("From the host: ") }
                append(a.text)
            },
            color = Color.White,
            fontSize = 14.sp,
            modifier = Modifier.weight(1f).padding(top = 1.dp),
        )
        IconBtn(Icons.Rounded.Close, "Dismiss announcement", { Graph.site.dismissAnnouncement(a.id) }, size = 32.dp, tint = Color.White)
    }
}

/** Messages that arrive during a video call, as banners over it; tap one to shrink the call and open it. */
@Composable
private fun CallBanners() {
    val p = palette
    val items by Graph.callNotices.items.collectAsState()
    if (items.isEmpty()) return
    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp)) {
        items.forEach { n ->
            Row(
                Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(RoundedCornerShape(18.dp)).background(p.deep.copy(alpha = 0.94f)).clickable {
                    Graph.callNotices.dismiss(n.key)
                    Graph.calls.setMinimized(true)
                    Graph.voice.setMinimized(true)
                    Nav.openPath(n.path)
                }.padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(n.name, n.hue, n.photo, 36.dp, room = n.room)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(n.title + if (n.count > 1) " · ${n.count} new" else "", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
                    Text(n.text, color = Color.White.copy(alpha = 0.8f), fontSize = 13.sp, maxLines = 1)
                }
            }
        }
    }
}
