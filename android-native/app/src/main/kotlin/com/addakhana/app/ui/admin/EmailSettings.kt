package com.addakhana.app.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Mail
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.AuthState
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.EmailSettings
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch

private class Security(val value: String, val label: String, val port: Int)

private val SECURITY = listOf(
    Security("starttls", "STARTTLS (usually port 587)", 587),
    Security("tls", "SSL/TLS (usually port 465)", 465),
    Security("none", "None (not encrypted)", 25),
)

/** The mail server Adda Khana sends codes through: confirming new accounts and resetting passwords. */
@Composable
internal fun EmailPage() {
    val p = palette
    val auth by Graph.auth.state.collectAsState()
    val me = (auth as? AuthState.SignedIn)?.user
    var saved by remember { mutableStateOf<EmailSettings?>(null) }
    var form by remember { mutableStateOf<EmailSettings?>(null) }
    // Typed here only; the saved one never comes back.
    var password by remember { mutableStateOf("") }
    var testTo by remember { mutableStateOf(me?.email?.takeIf { "@" in it }.orEmpty()) }
    // save, test or env, while that runs
    var busy by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    fun load(email: EmailSettings) {
        saved = email
        form = email
        password = ""
    }

    LaunchedEffect(Unit) {
        attempt { Graph.api.emailSettings() }.onSuccess { load(it) }.onFailure { error = reason(it) }
    }

    // These go on in the app's scope, so leaving the page doesn't cut a save off halfway.
    fun save(f: EmailSettings) {
        busy = "save"
        Graph.scope.launch {
            attempt { Graph.api.saveEmailSettings(f, password) }
                .onSuccess {
                    load(it)
                    Toasts.show(if (it.ready) "Email settings saved. Send a test to check them." else "Email settings saved. Email is off.", Toasts.Tone.Live)
                }
                .onFailure { Toasts.error(reason(it)) }
            busy = ""
        }
    }

    fun test(to: String) {
        busy = "test"
        Graph.scope.launch {
            attempt { Graph.api.testEmail(to) }
                .onSuccess { Toasts.show("Test email sent to $to. Check that inbox (and its spam folder).", Toasts.Tone.Live) }
                .onFailure { Toasts.error(reason(it)) }
            busy = ""
        }
    }

    fun switchToEnv() {
        busy = "env"
        Graph.scope.launch {
            attempt { Graph.api.useEnvEmail() }
                .onSuccess {
                    load(it)
                    Toasts.show("Using the email settings in the server’s .env file.", Toasts.Tone.Live)
                }
                .onFailure { Toasts.error(reason(it)) }
            busy = ""
        }
    }

    AdminPage("Email", "How Adda Khana works for everyone") {
        val s = saved
        val f = form
        if (s == null || f == null) {
            val e = error
            if (e != null) ErrorBox(e) else Loading()
            return@AdminPage
        }
        val changed = password.isNotEmpty() || f != s
        Panel(hint = "Codes by email: new people confirm their address, and anyone can reset a forgotten password. Without it, only you can reset passwords (from People).") {
            val shape = RoundedCornerShape(16.dp)
            Row(
                Modifier.fillMaxWidth().clip(shape)
                    .background(if (s.ready) p.live.copy(alpha = 0.1f) else p.subtle.copy(alpha = 0.6f))
                    .border(1.dp, if (s.ready) p.live.copy(alpha = 0.3f) else p.line, shape)
                    .padding(14.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(if (s.ready) Icons.Rounded.CheckCircle else Icons.Rounded.Mail, null, tint = if (s.ready) p.liveInk else p.inkSoft, modifier = Modifier.padding(top = 1.dp).size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    when {
                        s.ready && s.verifySignups -> "Email is on. New accounts confirm their email with a code, and people can reset a forgotten password."
                        s.ready -> "Email is on. People can reset a forgotten password; new accounts don’t confirm their email."
                        else -> "Email is off. Sign-ups don’t confirm an email, and there’s no “Forgot password?”."
                    } + if (s.source == "env") " These settings come from the server’s .env file; saving here takes over from it." else "",
                    color = if (s.ready) p.liveInk else p.inkSoft,
                    fontSize = 14.sp,
                )
            }

            Column(Modifier.padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                ToggleRow("Send email from Adda Khana", f.enabled, { form = f.copy(enabled = it) }, hint = "Through your mail server, below.")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Field(f.host, { form = f.copy(host = it) }, Modifier.weight(1f), placeholder = "smtp.gmail.com", label = "Mail server (SMTP)", keyboard = KeyboardType.Uri)
                    Field(
                        if (f.port == 0) "" else f.port.toString(),
                        { form = f.copy(port = it.filter(Char::isDigit).take(5).toIntOrNull() ?: 0) },
                        Modifier.width(104.dp),
                        placeholder = "587",
                        label = "Port",
                        keyboard = KeyboardType.Number,
                    )
                }
                Column {
                    Text("Security", color = p.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 6.dp))
                    @OptIn(ExperimentalLayoutApi::class)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (option in SECURITY) {
                            Option(option.label, f.security == option.value) {
                                // The usual port for it, unless they'd chosen an unusual one.
                                val usual = SECURITY.any { it.port == f.port }
                                form = f.copy(security = option.value, port = if (usual) option.port else f.port)
                            }
                        }
                    }
                }
                Field(f.user, { form = f.copy(user = it) }, placeholder = "you@gmail.com", label = "Username", keyboard = KeyboardType.Email)
                Column {
                    Field(password, { password = it }, placeholder = if (s.passwordSet) "••••••••" else "App password", label = "Password", password = true)
                    if (s.passwordSet) Text("Saved. Leave empty to keep it.", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
                }
                Column {
                    Field(f.from, { form = f.copy(from = it) }, placeholder = "Adda Khana <no-reply@yourdomain.com>", label = "Emails come from")
                    Text("The name and address people see. Use an address your mail server may send as.", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
                }
                ToggleRow(
                    "New people confirm their email with a code",
                    f.verifySignups,
                    { form = f.copy(verifySignups = it) },
                    hint = "Their account is made once they enter the code we email them. People already here aren't asked.",
                )
                Text(
                    "Gmail: smtp.gmail.com, port 587, STARTTLS, your Gmail address as the username, and an app password (Google Account › Security › 2-Step Verification › App passwords).",
                    color = p.inkSoft,
                    fontSize = 13.sp,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                    if (s.source == "admin" && s.envAvailable) {
                        AddaButton("Use the .env settings", { switchToEnv() }, height = 36.dp, variant = Variant.Ghost, loading = busy == "env")
                    }
                    AddaButton("Save", { save(f) }, height = 36.dp, enabled = changed, loading = busy == "save")
                }
            }

            HorizontalDivider(Modifier.padding(top = 20.dp, bottom = 16.dp), color = p.line.copy(alpha = 0.7f))
            Text("Send a test email", color = p.ink, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 8.dp))
            Field(testTo, { testTo = it }, placeholder = "you@example.com", keyboard = KeyboardType.Email)
            Spacer(Modifier.height(10.dp))
            AddaButton(
                "Send test",
                { test(testTo.trim()) },
                Modifier.fillMaxWidth(),
                variant = Variant.Soft,
                icon = Icons.AutoMirrored.Rounded.Send,
                enabled = s.ready && "@" in testTo && !changed,
                loading = busy == "test",
            )
            if (s.ready && changed) Text("Save your changes first, then test them.", color = p.inkSoft, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}
