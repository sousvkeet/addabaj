package com.addakhana.app.ui.auth

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.model.AuthOptions
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.Logo
import com.addakhana.app.ui.components.Wordmark
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Log in, sign up (with an email code when the host wants one), or reset a forgotten password. */
@Composable
fun AuthScreen() {
    val p = palette
    var mode by remember { mutableStateOf("login") }
    var options by remember { mutableStateOf(AuthOptions()) }
    val signup by Graph.auth.signup.collectAsState()
    val reset by Graph.auth.reset.collectAsState()
    LaunchedEffect(Unit) { runCatching { Graph.api.authOptions() }.onSuccess { options = it } }

    Box(
        Modifier
            .fillMaxSize()
            .background(p.canvas)
            .background(Brush.radialGradient(listOf(p.glowA, p.canvas.copy(alpha = 0f)), center = Offset(80f, 0f), radius = 900f))
            .background(Brush.radialGradient(listOf(p.glowB, p.canvas.copy(alpha = 0f)), center = Offset(1100f, 200f), radius = 800f)),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Logo(48.dp)
                Spacer(Modifier.width(12.dp))
                Wordmark(24f)
            }
            Spacer(Modifier.height(24.dp))
            Text("Where your friends", color = p.ink, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Text("hang out live.", style = TextStyle(brush = p.auroraText, fontSize = 28.sp, fontWeight = FontWeight.Bold))
            Spacer(Modifier.height(24.dp))
            Column(
                Modifier
                    .widthIn(max = 460.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(30.dp))
                    .background(p.surface.copy(alpha = if (p.dark) 0.74f else 1f))
                    .border(1.dp, p.line.copy(alpha = 0.7f), RoundedCornerShape(30.dp)),
            ) {
                Box(Modifier.fillMaxWidth().height(4.dp).background(p.aurora))
                Column(Modifier.padding(22.dp)) {
                    when {
                        signup != null -> ConfirmSignup()
                        mode == "signup" -> Signup(options, onLogin = { mode = "login" })
                        mode == "forgot" && reset != null -> ResetPassword(onBack = { Graph.auth.cancelReset(); mode = "login" })
                        mode == "forgot" -> Forgot(onBack = { mode = "login" })
                        else -> Login(options, onSignup = { mode = "signup" }, onForgot = { mode = "forgot" })
                    }
                }
            }
        }
    }
}

@Composable
private fun Title(title: String, subtitle: String) {
    val p = palette
    Text(title, color = p.ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(4.dp))
    Text(subtitle, color = p.inkSoft, fontSize = 14.sp)
    Spacer(Modifier.height(18.dp))
}

@Composable
private fun ErrorText(error: String?) {
    if (error == null) return
    Text(error, color = palette.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 10.dp))
}

@Composable
private fun Link(text: String, onClick: () -> Unit) {
    Text(text, color = palette.brand, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable(onClick = onClick).padding(vertical = 6.dp))
}

@Composable
private fun Login(options: AuthOptions, onSignup: () -> Unit, onForgot: () -> Unit) {
    val p = palette
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun submit() {
        if (busy || email.isBlank() || password.isEmpty()) return
        busy = true
        error = null
        scope.launch {
            try {
                Graph.auth.login(email, password)
            } catch (e: Exception) {
                error = e.message ?: "Couldn't log in."
            } finally {
                busy = false
            }
        }
    }
    Title("Log in to Adda Khana", "Welcome back. Your chats and rooms are waiting.")
    Field(email, { email = it }, label = "Email or username", placeholder = "you@example.com", keyboard = KeyboardType.Email, imeAction = ImeAction.Next)
    Spacer(Modifier.height(12.dp))
    Field(password, { password = it }, label = "Password", password = true, imeAction = ImeAction.Go, onDone = ::submit)
    if (options.passwordReset) Link("Forgot password?", onForgot)
    ErrorText(error)
    Spacer(Modifier.height(16.dp))
    AddaButton("Log in", ::submit, Modifier.fillMaxWidth(), height = 48.dp, loading = busy, enabled = email.isNotBlank() && password.isNotEmpty())
    if (options.allowSignups) {
        Spacer(Modifier.height(14.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Text("New here? ", color = p.inkSoft, fontSize = 14.sp)
            Link("Create an account", onSignup)
        }
    }
}

@Composable
private fun Signup(options: AuthOptions, onLogin: () -> Unit) {
    val p = palette
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    if (!options.allowSignups) {
        Title("Sign-ups are closed right now", "Ask the host to make an account for you, then log in.")
        AddaButton("Log in", onLogin, Modifier.fillMaxWidth(), height = 48.dp)
        return
    }
    fun submit() {
        if (busy) return
        if (password.length < 8) {
            error = "Use at least 8 characters for your password."
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                Graph.auth.register(name.trim(), email, password)
            } catch (e: Exception) {
                error = e.message ?: "Couldn't create your account."
            } finally {
                busy = false
            }
        }
    }
    Title("Create your account", "It takes less than a minute. No phone number needed.")
    Field(name, { name = it }, label = "Your name", placeholder = "Asha Sen", maxLength = 40, imeAction = ImeAction.Next)
    Spacer(Modifier.height(12.dp))
    Field(email, { email = it }, label = "Email", placeholder = "you@example.com", keyboard = KeyboardType.Email, imeAction = ImeAction.Next)
    Spacer(Modifier.height(12.dp))
    Field(password, { password = it }, label = "Password", placeholder = "At least 8 characters", password = true, imeAction = ImeAction.Go, onDone = ::submit)
    ErrorText(error)
    Spacer(Modifier.height(16.dp))
    AddaButton("Create account", ::submit, Modifier.fillMaxWidth(), height = 48.dp, loading = busy, enabled = name.isNotBlank() && email.isNotBlank() && password.isNotEmpty())
    Spacer(Modifier.height(14.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Text("Have an account? ", color = p.inkSoft, fontSize = 14.sp)
        Link("Log in", onLogin)
    }
}

/** "Check your email": the 6-digit code; it goes as soon as all six are in. */
@Composable
private fun ConfirmSignup() {
    val p = palette
    val scope = rememberCoroutineScope()
    val pending by Graph.auth.signup.collectAsState()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }
    fun submit() {
        if (busy || code.length < 6) return
        busy = true
        error = null
        scope.launch {
            try {
                Graph.auth.confirmSignup(code)
            } catch (e: Exception) {
                error = e.message
                code = ""
            } finally {
                busy = false
            }
        }
    }
    Title("Check your email", "We sent a 6-digit code to ${pending?.email}.")
    Field(code, { v -> code = v.filter { it.isDigit() }.take(6); if (code.length == 6) submit() }, label = "Code from the email", placeholder = "123456", keyboard = KeyboardType.NumberPassword)
    ErrorText(error)
    Spacer(Modifier.height(16.dp))
    AddaButton("Create account", ::submit, Modifier.fillMaxWidth(), height = 48.dp, loading = busy, enabled = code.length == 6)
    Spacer(Modifier.height(12.dp))
    val wait = (((pending?.resendAt ?: 0) - now) / 1000).coerceAtLeast(0)
    if (wait > 0) {
        Text("Didn't get it? Check your spam folder, or send a new code in $wait s.", color = p.inkSoft, fontSize = 13.sp)
    } else {
        Link("Send a new code") { scope.launch { runCatching { Graph.auth.resendSignup() }.onFailure { error = it.message } } }
    }
    Link("Use a different email") { Graph.auth.cancelSignup() }
}

@Composable
private fun Forgot(onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun submit() {
        if (busy || email.isBlank()) return
        busy = true
        error = null
        scope.launch {
            try {
                Graph.auth.forgot(email)
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }
    Title("Forgot your password?", "We'll email you a code to set a new one.")
    Field(email, { email = it }, label = "Email", keyboard = KeyboardType.Email, imeAction = ImeAction.Go, onDone = ::submit)
    ErrorText(error)
    Spacer(Modifier.height(16.dp))
    AddaButton("Send code", ::submit, Modifier.fillMaxWidth(), height = 48.dp, loading = busy, enabled = email.isNotBlank())
    Link("Back to log in", onBack)
}

@Composable
private fun ResetPassword(onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val pending by Graph.auth.reset.collectAsState()
    var code by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun submit() {
        if (busy) return
        if (password.length < 8) {
            error = "Use at least 8 characters for your password."
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                Graph.auth.resetPassword(code, password)
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }
    Title("Set a new password", "Enter the code we emailed to ${pending?.email}.")
    Field(code, { v -> code = v.filter { it.isDigit() }.take(6) }, label = "Code from the email", keyboard = KeyboardType.NumberPassword, imeAction = ImeAction.Next)
    Spacer(Modifier.height(12.dp))
    Field(password, { password = it }, label = "New password", password = true, imeAction = ImeAction.Go, onDone = ::submit)
    ErrorText(error)
    Spacer(Modifier.height(16.dp))
    AddaButton("Reset password", ::submit, Modifier.fillMaxWidth(), height = 48.dp, loading = busy, enabled = code.length == 6 && password.isNotEmpty())
    Link("Back to log in", onBack)
}
