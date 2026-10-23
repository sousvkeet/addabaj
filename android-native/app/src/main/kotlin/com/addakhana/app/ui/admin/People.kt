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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.HideImage
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.RemoveModerator
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.AdminUser
import com.addakhana.app.model.Paged
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.AppSheet
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.ConfirmDialog
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.SheetItem
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.home.ListSearch
import com.addakhana.app.ui.lastSeen
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.security.SecureRandom

private val FILTERS = listOf("all" to "Everyone", "online" to "Online", "admins" to "Host admins", "disabled" to "Switched off")

private const val PAGE = 40

/** A strong password that's still possible to read out. */
private fun suggestPassword(): String {
    val words = listOf("amber", "river", "tiger", "cloud", "mango", "lotus", "comet", "pearl", "storm", "maple")
    val random = SecureRandom()
    return "${words[random.nextInt(words.size)]}-${words[random.nextInt(words.size)]}-${random.nextInt(900) + 100}"
}

/** Accounts on the site: find them, add one, and change how one stands (host admin, switched off, password, removed). */
@Composable
internal fun PeoplePage() {
    val p = palette
    val co = rememberCoroutineScope()
    val meId = Graph.auth.user?.id
    var q by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("all") }
    var data by remember { mutableStateOf<Paged<AdminUser>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loadingMore by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    // The person whose details and actions are open, and the dialogs for them.
    var acting by remember { mutableStateOf<AdminUser?>(null) }
    var resetFor by remember { mutableStateOf<AdminUser?>(null) }
    var removing by remember { mutableStateOf<AdminUser?>(null) }

    LaunchedEffect(q, filter) {
        // Wait for typing to pause before searching.
        if (q.isNotEmpty()) delay(250)
        attempt { Graph.api.adminUsers(q, PAGE, filter = filter) }
            .onSuccess {
                data = it
                error = null
            }
            .onFailure { error = reason(it) }
    }

    fun replace(user: AdminUser) {
        data = data?.let { d -> d.copy(items = d.items.map { if (it.id == user.id) user else it }) }
    }

    // These go on whatever happens to the page (the sheet that started them is already closed).
    fun update(user: AdminUser, siteAdmin: Boolean? = null, disabled: Boolean? = null, done: String) = Graph.scope.launch {
        attempt { Graph.api.updateUser(user.id, siteAdmin, disabled) }
            .onSuccess {
                replace(it)
                Toasts.show(done, Toasts.Tone.Live)
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    /** Takes down someone's profile photo (they're back to initials). */
    fun removePhoto(user: AdminUser) = Graph.scope.launch {
        attempt { Graph.api.removeUserPhoto(user.id) }
            .onSuccess {
                replace(user.copy(photo = null))
                Toasts.show("${user.name}'s photo was removed.")
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    fun remove(user: AdminUser) = Graph.scope.launch {
        attempt { Graph.api.removeUser(user.id) }
            .onSuccess {
                data = data?.let { d -> Paged(d.items.filterNot { it.id == user.id }, d.total - 1) }
                Toasts.show("${user.name}'s account was removed.")
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    val subtitle = data?.let { d -> "${num(d.total)} ${if (filter == "all") (if (d.total == 1) "account" else "accounts") else "shown"}" } ?: "Accounts on Adda Khana"
    Column(Modifier.fillMaxSize().background(p.canvas)) {
        AdminHeader("People", subtitle) {
            AddaButton("Add person", { adding = true }, height = 36.dp, icon = Icons.Rounded.PersonAdd)
        }
        LazyColumn(Modifier.fillMaxSize().imePadding().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { ListSearch(q, { q = it }, "Search by name or email") }
            item {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((id, label) in FILTERS) Option(label, filter == id) { filter = id }
                }
            }
            error?.let { item { ErrorBox(it, Modifier.padding(16.dp)) } }
            val d = data
            when {
                d == null -> if (error == null) item { Loading() }
                d.items.isEmpty() -> item { Box(Modifier.padding(16.dp)) { EmptyBox("No one matches that.") } }
                else -> items(d.items, key = { it.id }) { u -> PersonRow(u, u.id == meId) { acting = u } }
            }
            if (d != null && d.items.size < d.total) {
                item {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        AddaButton("Show more", {
                            loadingMore = true
                            co.launch {
                                attempt { Graph.api.adminUsers(q, PAGE, offset = d.items.size, filter = filter) }
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

    acting?.let { u ->
        AppSheet({ acting = null }, title = u.name) {
            Text(u.email, color = p.inkSoft, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 20.dp))
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp)) {
                Fact("Joined", Modifier.weight(1f)) { FactText(shortDate(u.createdAt)) }
                Fact("Rooms", Modifier.weight(1f)) { FactText(num(u.rooms)) }
                Fact("Messages", Modifier.weight(1f)) { FactText(num(u.messages)) }
            }
            // Nothing to do to your own account here (that's in the You tab).
            if (u.id != meId) {
                if (u.siteAdmin) {
                    SheetItem(Icons.Rounded.RemoveModerator, "Remove host admin", { acting = null; update(u, siteAdmin = false, done = "${u.name} is no longer a host admin.") })
                } else {
                    SheetItem(Icons.Rounded.VerifiedUser, "Make host admin", { acting = null; update(u, siteAdmin = true, done = "${u.name} is now a host admin.") })
                }
                SheetItem(Icons.Rounded.Key, "Set a new password", { acting = null; resetFor = u })
                if (u.photo != null) SheetItem(Icons.Rounded.HideImage, "Remove profile photo", { acting = null; removePhoto(u) })
                if (u.disabled) {
                    SheetItem(Icons.Rounded.PowerSettingsNew, "Switch account on", { acting = null; update(u, disabled = false, done = "${u.name} can log in again.") })
                } else {
                    SheetItem(Icons.Rounded.PowerSettingsNew, "Switch account off", { acting = null; update(u, disabled = true, done = "${u.name} was logged out and can't log in.") })
                }
                SheetItem(Icons.Rounded.Delete, "Remove account", { acting = null; removing = u }, danger = true)
            }
        }
    }
    if (adding) {
        AddPersonDialog(onDismiss = { adding = false }) { u ->
            data = data?.let { d -> Paged(listOf(u) + d.items, d.total + 1) }
            Toasts.show("${u.name} can now log in with ${u.email}.", Toasts.Tone.Live)
        }
    }
    resetFor?.let { u -> ResetPasswordDialog(u) { resetFor = null } }
    removing?.let { u ->
        ConfirmDialog(
            "Remove ${u.name}?",
            "Their account, messages and the rooms they started are deleted for good, and they're logged out everywhere. To keep their history, switch the account off instead.",
            "Remove account",
            onConfirm = { remove(u) },
            onDismiss = { removing = null },
        )
    }
}

@Composable
private fun PersonRow(u: AdminUser, me: Boolean, onClick: () -> Unit) {
    val p = palette
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(u.name, u.hue, u.photo, 44.dp, Modifier.alpha(if (u.disabled) 0.5f else 1f), online = u.online)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(u.name, color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (me) Text("(you)", color = p.inkSoft, fontSize = 13.sp, modifier = Modifier.align(Alignment.CenterVertically))
                if (u.siteAdmin) Box(Modifier.align(Alignment.CenterVertically)) { Chip("Host admin", Tone.Brand) }
                if (u.disabled) Box(Modifier.align(Alignment.CenterVertically)) { Chip("Switched off", Tone.Danger) }
                if (u.defaultPassword) Box(Modifier.align(Alignment.CenterVertically)) { Chip("Default password", Tone.Warn) }
            }
            Text(u.email, color = p.inkSoft, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                if (u.online) "Online now" else lastSeen(u.lastSeenAt).replace("Last seen ", "Seen "),
                color = if (u.online) p.liveInk else p.inkSoft,
                fontSize = 12.5.sp,
                fontWeight = if (u.online) FontWeight.SemiBold else FontWeight.Normal,
            )
        }
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, "Actions for ${u.name}", tint = p.inkSoft)
    }
}

@Composable
private fun AddPersonDialog(onDismiss: () -> Unit, onAdded: (AdminUser) -> Unit) {
    val p = palette
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf(suggestPassword()) }
    var siteAdmin by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AppDialog(onDismiss, "Add a person", "Make an account for someone and give them the email and password to log in.", buttons = {
        AddaButton("Add person", {
            busy = true
            error = null
            // On even if the dialog is closed meanwhile: the account is being made either way.
            Graph.scope.launch {
                attempt { Graph.api.addUser(name, email, password, siteAdmin) }
                    .onSuccess {
                        onAdded(it)
                        onDismiss()
                    }
                    .onFailure { error = reason(it) }
                busy = false
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = name.isNotBlank() && email.isNotBlank() && password.length >= 8)
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Field(name, { name = it }, label = "Name", maxLength = 40)
        Spacer(Modifier.height(12.dp))
        Field(email, { email = it }, label = "Email", keyboard = KeyboardType.Email)
        Spacer(Modifier.height(12.dp))
        Field(password, { password = it }, label = "Password")
        Text("Share it with them privately. They can change it from their account menu.", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth().clickable { siteAdmin = !siteAdmin }, verticalAlignment = Alignment.CenterVertically) {
            Checkbox(siteAdmin, { siteAdmin = it }, colors = CheckboxDefaults.colors(checkedColor = p.brand, uncheckedColor = p.inkSoft))
            Text("Make them a host admin too", color = p.ink, fontSize = 14.sp)
        }
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
}

/** For someone who forgot theirs: a new password the host gives them. */
@Composable
private fun ResetPasswordDialog(user: AdminUser, onDismiss: () -> Unit) {
    val p = palette
    var password by remember { mutableStateOf(suggestPassword()) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AppDialog(onDismiss, "New password for ${user.name}", "For someone who forgot theirs. Give it to them privately; they can change it after logging in.", buttons = {
        AddaButton("Set password", {
            busy = true
            error = null
            Graph.scope.launch {
                attempt { Graph.api.setUserPassword(user.id, password) }
                    .onSuccess {
                        Toasts.show("${user.name}'s password was changed.", Toasts.Tone.Live)
                        onDismiss()
                    }
                    .onFailure { error = reason(it) }
                busy = false
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = password.length >= 8)
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Field(password, { password = it }, label = "New password")
        Text("At least 8 characters.", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
}
