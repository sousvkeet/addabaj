package com.addakhana.app.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.Messaging
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch

private val EDIT_MINUTES = listOf(5, 15, 30, 60, 1440)
private val FORWARD_TO = listOf(1, 3, 5, 10, 20)

/** "15 minutes", "1 hour", "1 day". */
private fun minutes(n: Int): String = when {
    n % 1440 == 0 -> if (n == 1440) "1 day" else "${n / 1440} days"
    n % 60 == 0 -> if (n == 60) "1 hour" else "${n / 60} hours"
    else -> if (n == 1) "1 minute" else "$n minutes"
}

private fun chats(n: Int) = if (n == 1) "1 chat" else "$n chats"

/** The usual choices, plus the saved one if it's something else. */
private fun choices(usual: List<Int>, saved: Int) = if (saved in usual) usual else (usual + saved).sorted()

private fun editFor(m: Messaging) = "People can edit a message for ${minutes(m.editMinutes)} after sending it."
private fun forwardTo(m: Messaging) = "People can forward a message to up to ${chats(m.forwardTo)} at a time."

/** What everyone can do with messages: link previews, editing and forwarding. Each change is saved at once. */
@Composable
internal fun MessagingPage() {
    val p = palette
    var settings by remember { mutableStateOf<Messaging?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        attempt { Graph.api.adminMessaging() }.onSuccess { settings = it }.onFailure { error = reason(it) }
    }

    fun save(next: Messaging, done: (Messaging) -> String, request: suspend () -> Messaging) {
        val before = settings ?: return
        // Show the change at once; put it back if it isn't saved.
        settings = next
        saving = true
        Graph.scope.launch {
            attempt { request() }
                .onSuccess {
                    settings = it
                    Toasts.show(done(it), Toasts.Tone.Live)
                }
                .onFailure {
                    settings = before
                    Toasts.error(reason(it))
                }
            saving = false
        }
    }

    AdminPage("Messages", "How Adda Khana works for everyone") {
        val s = settings
        if (s == null) {
            val e = error
            if (e != null) ErrorBox(e) else Loading()
            return@AdminPage
        }
        Panel(hint = "What people can do with messages in chats and rooms. Host admins can always edit and forward, with no time or chat limit.") {
            ToggleRow(
                "Link previews",
                s.linkPreviews,
                { on ->
                    save(s.copy(linkPreviews = on), { if (on) "Links in messages show a preview card now." else "Link previews are off. Links show as plain links." }) {
                        Graph.api.setMessaging(linkPreviews = on)
                    }
                },
                hint = "Links in messages show a card with the page's title and picture. The server fetches the page itself, and never reaches addresses on your own network.",
                enabled = !saving,
            )
            HorizontalDivider(Modifier.padding(vertical = 16.dp), color = p.line.copy(alpha = 0.7f))
            ToggleRow(
                "Editing",
                s.editing,
                { on ->
                    save(s.copy(editing = on), { m -> if (on) editFor(m) else "Editing is off. People can't change messages they've sent." }) { Graph.api.setMessaging(editing = on) }
                },
                hint = "People can change a message after sending it, for a while. It's marked edited, and if it's reported you see what it said before.",
                enabled = !saving,
            )
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (n in choices(EDIT_MINUTES, s.editMinutes)) {
                    Option("for ${minutes(n)}", s.editMinutes == n, enabled = !saving && s.editing) {
                        if (n != s.editMinutes) save(s.copy(editMinutes = n), ::editFor) { Graph.api.setMessaging(editMinutes = n) }
                    }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 16.dp), color = p.line.copy(alpha = 0.7f))
            ToggleRow(
                "Forwarding",
                s.forwarding,
                { on -> save(s.copy(forwarding = on), { m -> if (on) forwardTo(m) else "Forwarding is off." }) { Graph.api.setMessaging(forwarding = on) } },
                hint = "People can send a message on to other chats and rooms. It's marked forwarded.",
                enabled = !saving,
            )
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (n in choices(FORWARD_TO, s.forwardTo)) {
                    Option("to up to ${chats(n)} at a time", s.forwardTo == n, enabled = !saving && s.forwarding) {
                        if (n != s.forwardTo) save(s.copy(forwardTo = n), ::forwardTo) { Graph.api.setMessaging(forwardTo = n) }
                    }
                }
            }
        }
    }
}
