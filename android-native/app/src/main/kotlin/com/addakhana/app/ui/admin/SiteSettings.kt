package com.addakhana.app.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.AuthState
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.SiteSettings
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.home.PasswordDialog
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch

private const val MAX = 280

/** How Adda Khana works for everyone: sign-ups, the announcement, and the host's own login. */
@Composable
internal fun SiteSettingsPage() {
    val p = palette
    val auth by Graph.auth.state.collectAsState()
    val me = (auth as? AuthState.SignedIn)?.user
    var settings by remember { mutableStateOf<SiteSettings?>(null) }
    var draft by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    // signups, publish or clear, while that's saved
    var busy by remember { mutableStateOf("") }
    var changing by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        attempt { Graph.api.siteSettings() }
            .onSuccess {
                settings = it
                draft = it.announcement?.text.orEmpty()
            }
            .onFailure { error = reason(it) }
    }

    // On in the app's scope, so leaving the page doesn't undo a change halfway.
    fun save(what: String, done: String, request: suspend () -> SiteSettings) {
        busy = what
        Graph.scope.launch {
            attempt { request() }
                .onSuccess {
                    settings = it
                    draft = it.announcement?.text.orEmpty()
                    Toasts.show(done, Toasts.Tone.Live)
                }
                .onFailure { Toasts.error(reason(it)) }
            busy = ""
        }
    }

    AdminPage("Site settings", "How Adda Khana works for everyone") {
        error?.let { ErrorBox(it) }
        val s = settings
        if (s == null) {
            if (error == null) Loading()
            return@AdminPage
        }
        Panel(title = "Sign-ups") {
            ToggleRow(
                "Let new people create accounts",
                s.allowSignups,
                { on ->
                    save("signups", if (on) "Anyone can create an account now." else "Sign-ups are closed. Add people from the People page.") { Graph.api.setSignups(on) }
                },
                hint = "When this is off, the sign-up page says sign-ups are closed, and only a host admin can add people.",
                enabled = busy != "signups",
            )
        }

        Panel(title = "Announcement", hint = "A banner at the top of the app for everyone who's signed in, for example about maintenance.") {
            s.announcement?.let { a ->
                val shape = RoundedCornerShape(16.dp)
                Row(
                    Modifier.padding(bottom = 14.dp).fillMaxWidth().clip(shape).background(p.brand.copy(alpha = 0.1f)).border(1.dp, p.brand.copy(alpha = 0.3f), shape).padding(14.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Rounded.Campaign, null, tint = if (p.dark) p.live else p.brand, modifier = Modifier.padding(top = 1.dp).size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(
                        buildAnnotatedString {
                            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("Showing now: ") }
                            append(a.text)
                        },
                        color = p.ink,
                        fontSize = 14.sp,
                    )
                }
            }
            Field(
                draft,
                { draft = it },
                placeholder = "Video calls will be down for 10 minutes at 11 pm for an update.",
                singleLine = false,
                maxLength = MAX,
            )
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${draft.length}/$MAX", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.weight(1f))
                if (s.announcement != null) {
                    AddaButton("Take down", {
                        save("clear", "The announcement was taken down.") { Graph.api.setAnnouncement(null) }
                    }, height = 36.dp, variant = Variant.Ghost, loading = busy == "clear")
                }
                AddaButton(
                    if (s.announcement != null) "Update" else "Publish",
                    { save("publish", "Everyone sees your announcement now.") { Graph.api.setAnnouncement(draft) } },
                    height = 36.dp,
                    icon = Icons.Rounded.Campaign,
                    loading = busy == "publish",
                    enabled = draft.isNotBlank() && draft.trim() != s.announcement?.text,
                )
            }
        }

        Panel(title = "Your admin login") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).clip(RoundedCornerShape(16.dp)).background(p.aurora), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Key, null, tint = p.onBrand, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(14.dp))
                Text(
                    buildAnnotatedString {
                        append("You log in as ")
                        withStyle(SpanStyle(color = p.ink, fontWeight = FontWeight.SemiBold)) { append(me?.email.orEmpty()) }
                        append(".")
                        if (me?.mustChangePassword == true) append(" You still have the default password.")
                        append(" Locked out? On the server, run ")
                        withStyle(SpanStyle(color = p.ink, fontFamily = FontFamily.Monospace, background = p.subtle)) { append("npm run admin:reset") }
                        append(".")
                    },
                    color = p.inkSoft,
                    fontSize = 14.sp,
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(14.dp))
            AddaButton(
                "Change password",
                { changing = true },
                Modifier.fillMaxWidth(),
                variant = if (me?.mustChangePassword == true) Variant.Primary else Variant.Soft,
            )
        }
    }
    if (changing) PasswordDialog(onDismiss = { changing = false })
}
