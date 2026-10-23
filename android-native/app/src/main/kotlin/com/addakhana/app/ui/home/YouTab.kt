package com.addakhana.app.ui.home

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.rounded.Badge
import androidx.compose.material.icons.rounded.CameraAlt
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material.icons.rounded.DataUsage
import androidx.compose.material.icons.rounded.Headset
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.style.TextOverflow
import com.addakhana.app.ui.components.IconBtn
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.BuildConfig
import com.addakhana.app.Graph
import com.addakhana.app.data.AuthState
import com.addakhana.app.data.Toasts
import com.addakhana.app.data.UiPrefs
import com.addakhana.app.model.BlockedUser
import com.addakhana.app.model.Session
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.ConfirmDialog
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.IconTile
import com.addakhana.app.ui.components.Toggle
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.lastSeen
import com.addakhana.app.ui.shortDay
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** The "You" tab: your account and the app's settings. */
@Composable
fun YouTab() {
    val p = palette
    val auth by Graph.auth.state.collectAsState()
    val me = (auth as? AuthState.SignedIn)?.user ?: return
    val theme by UiPrefs.theme.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var dialog by remember { mutableStateOf<String?>(null) }
    var sessions by remember { mutableStateOf<List<Session>?>(null) }
    LaunchedEffect(Unit) { runCatching { Graph.api.sessions() }.onSuccess { sessions = it } }

    // A photo picked: fit it in the circle first.
    var editing by remember { mutableStateOf<android.net.Uri?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) editing = uri }
    editing?.let { uri ->
        com.addakhana.app.ui.components.PhotoEditor(
            uri,
            room = false,
            onUse = { jpeg ->
                Graph.auth.setUser(Graph.api.setPhoto(jpeg))
                editing = null
                Toasts.show("Your photo is changed.")
            },
            onAnother = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onDismiss = { editing = null },
        )
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        ListHeader("You")
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box {
                Avatar(me.name, me.hue, me.photo, 64.dp)
                Box(
                    Modifier.align(Alignment.BottomEnd).size(28.dp).clip(CircleShape).background(p.aurora).clickable { dialog = "photo" },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Rounded.PhotoCamera, "Profile photo", tint = p.onBrand, modifier = Modifier.size(15.dp)) }
            }
            Spacer(Modifier.width(14.dp))
            Column {
                Text(me.name, color = p.ink, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                Text(me.handle?.let { "@$it" } ?: me.email.orEmpty(), color = p.inkSoft, fontSize = 14.sp)
            }
        }
        if (me.siteAdmin) SettingRow(Icons.Rounded.VerifiedUser, "Admin", "Run Adda Khana") { Nav.push(Screen.Admin()) }
        SettingRow(Icons.Rounded.CameraAlt, "Profile photo", if (me.photo != null) "Change or remove your photo" else "Add a photo so people recognise you") { dialog = "photo" }
        SettingRow(Icons.Rounded.Badge, "Your name", "${me.name} · what everyone sees") { dialog = "name" }
        SettingRow(Icons.Rounded.AlternateEmail, "Your user ID", me.handle?.let { "@$it · how friends find you" } ?: "Choose how friends find you") { dialog = "handle" }
        val list = sessions
        SettingRow(Icons.Rounded.Devices, "Devices", list?.let { s -> "${s.size} device${if (s.size == 1) "" else "s"}: ${s.count { it.kind == "app" }} app, ${s.count { it.kind != "app" }} browser${if (s.count { it.kind != "app" } == 1) "" else "s"}" } ?: "Where you're logged in") { dialog = "devices" }
        SettingRow(Icons.Rounded.Shield, "Privacy", "Last seen, read receipts and blocked people") { dialog = "privacy" }
        SettingRow(Icons.Rounded.Headset, "Microphone, speaker and camera", "Where calls sound, and testing them") { dialog = "av" }
        SettingRow(Icons.Rounded.DataUsage, "Storage and data", "Network usage, auto-download, quality") { Nav.push(Screen.Storage()) }
        val perms by com.addakhana.app.data.Permissions.items.collectAsState()
        val missing = perms.filter { it.status == com.addakhana.app.data.Permissions.Status.Ask || it.status == com.addakhana.app.data.Permissions.Status.Settings }
        SettingRow(
            Icons.Rounded.Security,
            "App permissions",
            when (missing.size) {
                0 -> "All allowed"
                1 -> "${missing[0].title} not allowed"
                else -> "${missing[0].title} and ${missing.size - 1} more not allowed"
            },
        ) { dialog = "permissions" }
        Row(
            Modifier.fillMaxWidth().clickable { UiPrefs.setTheme(if (theme == "light") "dark" else "light") }.padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconTile(Icons.Rounded.DarkMode)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Dark theme", color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.Medium)
                Text(if (theme != "light") "Midnight Aurora" else "Off: Ocean Mint", color = p.inkSoft, fontSize = 13.sp)
            }
            Toggle(theme != "light", { UiPrefs.setTheme(if (it) "dark" else "light") })
        }
        SettingRow(Icons.Rounded.Lock, "Change password", null) { dialog = "password" }
        SettingRow(Icons.AutoMirrored.Rounded.Logout, "Log out", null, danger = true) { dialog = "logout" }
        Text("Adda Khana ${BuildConfig.VERSION_NAME}", color = p.inkSoft, fontSize = 12.sp, modifier = Modifier.padding(24.dp))
    }

    when (dialog) {
        "photo" -> AppDialog({ dialog = null }, "Profile photo", buttons = {
            AddaButton(if (me.photo != null) "Choose a new photo" else "Choose a photo", {
                dialog = null
                pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }, Modifier.fillMaxWidth())
            if (me.photo != null) AddaButton("Remove photo", {
                dialog = null
                scope.launch { runCatching { Graph.auth.setUser(Graph.api.removePhoto()) }.onFailure { Toasts.error(it.message ?: "Couldn't remove it.") } }
            }, Modifier.fillMaxWidth(), variant = Variant.DangerSoft)
            AddaButton("Cancel", { dialog = null }, Modifier.fillMaxWidth(), variant = Variant.Ghost)
        }) { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { Avatar(me.name, me.hue, me.photo, 120.dp) } }
        "name" -> TextDialog("Your name", "What everyone sees. Up to 40 characters.", me.name, 40, "Save") { name ->
            Graph.auth.setUser(Graph.api.setName(name.trim().replace(Regex("\\s+"), " ")))
            Toasts.show("Your name is changed. Everyone sees the new one.")
        }.also { if (it) dialog = null }
        "handle" -> MyIdDialog(me.handle.orEmpty()) { dialog = null }
        "password" -> PasswordDialog(onDismiss = { dialog = null })
        "permissions" -> PermissionsDialog { dialog = null }
        "privacy" -> PrivacyDialog { dialog = null }
        "av" -> DeviceSettings { dialog = null }
        "devices" -> DevicesDialog(sessions, { sessions = it }) { dialog = null }
        "logout" -> ConfirmDialog(
            "Log out?",
            "You'll stop getting messages and calls on this device until you log in again.",
            "Log out",
            onConfirm = { scope.launch { Graph.auth.logout() } },
            onDismiss = { dialog = null },
        )
    }
}

@Composable
private fun SettingRow(icon: ImageVector, title: String, hint: String?, danger: Boolean = false, onClick: () -> Unit) {
    val p = palette
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        IconTile(icon, tint = if (danger) p.danger else p.brand, background = (if (danger) p.danger else p.brand).copy(alpha = 0.13f))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = if (danger) p.danger else p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.Medium)
            if (hint != null) Text(hint, color = p.inkSoft, fontSize = 13.sp)
        }
        if (!danger) Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = p.inkSoft)
    }
}

/** A dialog with one text field; true once saved (the caller closes it). */
@Composable
private fun TextDialog(title: String, text: String, initial: String, max: Int, action: String, save: suspend (String) -> Unit): Boolean {
    val p = palette
    val scope = rememberCoroutineScope()
    var value by remember { mutableStateOf(initial) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }
    if (done) return true
    AppDialog({ done = true }, title, text, buttons = {
        AddaButton(action, {
            busy = true
            error = null
            scope.launch {
                try {
                    save(value)
                    done = true
                } catch (e: Exception) {
                    error = e.message
                } finally {
                    busy = false
                }
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = value.isNotBlank() && value != initial)
        AddaButton("Cancel", { done = true }, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Field(value, { value = it }, maxLength = max)
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
    return false
}

/** My user ID: what friends type to find me. Copy it, share it, or change it. */
@Composable
private fun MyIdDialog(handle: String, onDismiss: () -> Unit) {
    val p = palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var value by remember { mutableStateOf(handle) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val next = value.trim().removePrefix("@").lowercase()
    AppDialog(onDismiss, "Your user ID", "Friends find you on Adda Khana by your user ID or your email. Nobody is listed.", buttons = {
        AddaButton("Change", {
            busy = true
            error = null
            scope.launch {
                try {
                    Graph.auth.setUser(Graph.api.setHandle(next))
                    Toasts.show("Your user ID is now @$next.")
                    onDismiss()
                } catch (e: Exception) {
                    error = e.message
                } finally {
                    busy = false
                }
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = next.isNotEmpty() && next != handle)
        AddaButton("Close", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.subtle).padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("@$handle", color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            IconBtn(Icons.Rounded.ContentCopy, "Copy", { copy(context, handle, "Your user ID is copied.") }, size = 40.dp, tint = p.inkSoft)
            IconBtn(Icons.Rounded.Share, "Share", { share(context, "Find me on Adda Khana: my user ID is $handle\n${BuildConfig.SITE_URL}") }, size = 40.dp, tint = p.inkSoft)
        }
        Spacer(Modifier.height(14.dp))
        Field(value, { value = it }, label = "Change your user ID", maxLength = 25)
        Text(
            "Use 3 to 24 letters, numbers, dots or underscores, starting and ending with a letter or number. Your old ID stops working.",
            color = p.inkSoft,
            fontSize = 12.5.sp,
            modifier = Modifier.padding(top = 6.dp),
        )
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
}

@Composable
internal fun PasswordDialog(onDismiss: () -> Unit, required: Boolean = false) {
    val p = palette
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AppDialog(
        { if (!required) onDismiss() },
        if (required) "Set a new admin password" else "Change password",
        if (required) "This server is public and the host admin account still has its default password. Choose your own before you continue." else "Your other devices are logged out; this one stays in.",
        buttons = {
        AddaButton("Change password", {
            if (next.length < 8) return@AddaButton run { error = "Use at least 8 characters." }
            if (next != again) return@AddaButton run { error = "The new passwords don't match." }
            busy = true
            scope.launch {
                try {
                    Graph.auth.setUser(Graph.api.changePassword(current, next))
                    Toasts.show("Your password is changed.")
                    onDismiss()
                } catch (e: Exception) {
                    error = e.message
                } finally {
                    busy = false
                }
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = current.isNotEmpty() && next.isNotEmpty())
        if (!required) AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Field(current, { current = it }, label = "Current password", password = true)
        Spacer(Modifier.height(10.dp))
        Field(next, { next = it }, label = "New password", password = true)
        Spacer(Modifier.height(10.dp))
        Field(again, { again = it }, label = "New password again", password = true)
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
}

@Composable
private fun PrivacyDialog(onDismiss: () -> Unit) {
    val p = palette
    val scope = rememberCoroutineScope()
    val me = Graph.auth.user ?: return
    var blocked by remember { mutableStateOf<List<BlockedUser>?>(null) }
    LaunchedEffect(Unit) { runCatching { Graph.api.blocked() }.onSuccess { blocked = it } }
    val privacy = me.privacy ?: com.addakhana.app.model.Privacy()
    fun set(sharePresence: Boolean? = null, readReceipts: Boolean? = null) = scope.launch {
        runCatching { Graph.auth.setUser(Graph.api.setPrivacy(sharePresence, readReceipts)) }.onFailure { Toasts.error(it.message ?: "That didn't work.") }
    }
    AppDialog(onDismiss, "Privacy", buttons = { AddaButton("Done", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Soft) }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Show when I'm online and last seen", color = p.ink, fontWeight = FontWeight.Medium)
                Text("Off: you don't see others' either.", color = p.inkSoft, fontSize = 13.sp)
            }
            Toggle(privacy.sharePresence, { set(sharePresence = it) })
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Read receipts", color = p.ink, fontWeight = FontWeight.Medium)
                Text("Off: you don't see others' either.", color = p.inkSoft, fontSize = 13.sp)
            }
            Toggle(privacy.readReceipts, { set(readReceipts = it) })
        }
        Spacer(Modifier.height(18.dp))
        Text("Blocked people", color = p.ink, fontWeight = FontWeight.SemiBold)
        val list = blocked
        if (list != null && list.isEmpty()) Text("Nobody.", color = p.inkSoft, fontSize = 13.5.sp, modifier = Modifier.padding(top = 6.dp))
        list?.forEach { b ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(b.name, b.hue, b.photo, 36.dp)
                Spacer(Modifier.width(10.dp))
                Text(b.name, color = p.ink, modifier = Modifier.weight(1f))
                AddaButton("Unblock", {
                    scope.launch {
                        runCatching { Graph.chat.unblock(b.id) }.onSuccess { blocked = blocked?.filterNot { it.id == b.id } }.onFailure { Toasts.error(it.message ?: "That didn't work.") }
                    }
                }, height = 36.dp, variant = Variant.Soft)
            }
        }
    }
}

@Composable
private fun DevicesDialog(sessions: List<Session>?, update: (List<Session>) -> Unit, onDismiss: () -> Unit) {
    val p = palette
    val scope = rememberCoroutineScope()
    AppDialog(onDismiss, "Devices", "Where you're logged in.", buttons = {
        if ((sessions?.size ?: 0) > 1) AddaButton("Log out of all other devices", {
            scope.launch { runCatching { update(Graph.api.endOtherSessions()) }.onFailure { Toasts.error(it.message ?: "That didn't work.") } }
        }, Modifier.fillMaxWidth(), variant = Variant.DangerSoft)
        AddaButton("Done", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Soft)
    }) {
        sessions?.forEach { s ->
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                // The app on its aurora; a browser, plainer (a phone's or a computer's).
                val app = s.kind == "app"
                Box(Modifier.size(44.dp).clip(CircleShape).background(if (app) p.aurora else androidx.compose.ui.graphics.SolidColor(p.subtle)), contentAlignment = Alignment.Center) {
                    Icon(if (s.phone || app) Icons.Rounded.Smartphone else Icons.Rounded.Computer, null, tint = if (app) Color.White else p.inkSoft, modifier = Modifier.size(21.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(s.name, color = p.ink, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (s.current) Text("  This device", color = p.liveInk, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                    s.detail?.takeIf { it.isNotBlank() }?.let { Text(it, color = p.inkSoft, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    val active = if (s.online) "Active now" else lastSeen(s.lastActiveAt).replace("Last seen", "Last active")
                    Text("$active · Logged in ${shortDay(s.signedInAt)}" + (s.ip?.let { " · $it" } ?: ""), color = p.inkSoft, fontSize = 12.5.sp)
                }
                if (!s.current) AddaButton("Log out", {
                    scope.launch { runCatching { update(Graph.api.endSession(s.id)) }.onFailure { Toasts.error(it.message ?: "That didn't work.") } }
                }, height = 36.dp, variant = Variant.DangerGhost)
            }
        }
    }
}

