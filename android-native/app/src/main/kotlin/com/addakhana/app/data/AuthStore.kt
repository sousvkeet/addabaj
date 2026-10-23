package com.addakhana.app.data

import android.content.Context
import com.addakhana.app.Graph
import com.addakhana.app.model.SignupConfirm
import com.addakhana.app.model.User
import com.addakhana.app.net.Api
import com.addakhana.app.net.Connection
import com.addakhana.app.net.CookieStore
import com.addakhana.app.net.Realtime
import com.addakhana.app.net.json
import com.addakhana.app.net.obj
import com.addakhana.app.net.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

sealed interface AuthState {
    data object Loading : AuthState
    data object SignedOut : AuthState
    data class SignedIn(val user: User) : AuthState
}

/** A sign-up waiting for its email code, kept a day (as the web app does). */
@Serializable
data class PendingSignup(val token: String, val email: String, val at: Long, val resendAt: Long)

/** A password reset waiting for its email code, kept 15 minutes. */
@Serializable
data class PendingReset(val email: String, val at: Long, val resendAt: Long)

/**
 * Who's signed in. The login cookie and the last copy of the account are
 * kept on the phone, so the app opens straight into the chats, offline too,
 * and checks with the server once it can.
 */
class AuthStore(
    context: Context,
    private val api: Api,
    private val realtime: Realtime,
    private val cookies: CookieStore,
    private val scope: CoroutineScope,
) {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state.asStateFlow()
    val user: User? get() = (_state.value as? AuthState.SignedIn)?.user

    private val _signup = MutableStateFlow(load<PendingSignup>("signup")?.takeIf { System.currentTimeMillis() - it.at < 86_400_000 })
    val signup: StateFlow<PendingSignup?> = _signup.asStateFlow()
    private val _reset = MutableStateFlow(load<PendingReset>("reset")?.takeIf { System.currentTimeMillis() - it.at < 900_000 })
    val reset: StateFlow<PendingReset?> = _reset.asStateFlow()

    init {
        val cached = load<User>("user")
        if (cookies.signedIn() && cached != null) {
            signedIn(cached, fresh = false)
            scope.launch { refresh() }
        } else if (cookies.signedIn()) {
            scope.launch { refresh() }
        } else {
            _state.value = AuthState.SignedOut
        }
        scope.launch {
            realtime.state.collect { if (it is Connection.Unauthorized) refresh() }
        }
        scope.launch {
            realtime.events.collect { e ->
                when (e.name) {
                    "account:changed" -> refresh()
                    "account:disabled" -> expire("The host switched your account off.")
                    "session:ended" -> expire(
                        when (e.obj.str("reason")) {
                            "password" -> "Your password was changed, so you were logged out here."
                            "host" -> "The host logged you out."
                            "elsewhere", "logout" -> "You were logged out of this device."
                            else -> "You were logged out."
                        },
                    )
                    "user:updated" -> {
                        val changed = e.obj.obj("user") ?: return@collect
                        val me = user ?: return@collect
                        if (changed.str("id") == me.id) refresh()
                    }
                    "session:new" -> {
                        val name = e.obj.obj("session")?.str("name") ?: "another device"
                        Toasts.show("New login: $name. Not you? Log it out in Settings › Devices.")
                    }
                }
            }
        }
    }

    /** Checks the login with the server (GET /auth/me always answers; null means signed out). */
    suspend fun refresh() {
        try {
            val me = api.me()
            if (me == null) {
                if (_state.value is AuthState.SignedIn) expire("Please log in again.") else _state.value = AuthState.SignedOut
            } else {
                signedIn(me, fresh = _state.value !is AuthState.SignedIn)
            }
        } catch (e: Exception) {
            // Offline: keep going with what the phone has.
            if (_state.value is AuthState.Loading) _state.value = if (cookies.signedIn()) load<User>("user")?.let { AuthState.SignedIn(it) } ?: AuthState.SignedOut else AuthState.SignedOut
        }
    }

    suspend fun login(email: String, password: String) {
        val me = api.login(email.trim(), password)
        signedIn(me, fresh = true)
    }

    /** Signs up, or keeps the sign-up waiting for its email code. */
    suspend fun register(name: String, email: String, password: String) {
        val (me, confirm) = api.register(name, email.trim(), password)
        if (me != null) signedIn(me, fresh = true) else if (confirm != null) pendSignup(confirm)
    }

    private fun pendSignup(c: SignupConfirm) {
        val now = System.currentTimeMillis()
        val pending = PendingSignup(c.token, c.email, now, now + c.resendIn * 1000L)
        _signup.value = pending
        save("signup", pending)
    }

    suspend fun confirmSignup(code: String) {
        val pending = _signup.value ?: return
        val me = api.confirmSignup(pending.token, code.filter { it.isDigit() })
        cancelSignup()
        signedIn(me, fresh = true)
    }

    suspend fun resendSignup() {
        val pending = _signup.value ?: return
        val wait = api.resendSignup(pending.token)
        val next = pending.copy(resendAt = System.currentTimeMillis() + wait * 1000L)
        _signup.value = next
        save("signup", next)
    }

    fun cancelSignup() {
        _signup.value = null
        prefs.edit().remove("signup").apply()
    }

    suspend fun forgot(email: String) {
        val wait = api.forgot(email.trim())
        val now = System.currentTimeMillis()
        val pending = PendingReset(email.trim(), now, now + wait * 1000L)
        _reset.value = pending
        save("reset", pending)
    }

    suspend fun resetPassword(code: String, password: String) {
        val pending = _reset.value ?: return
        val me = api.reset(pending.email, code.filter { it.isDigit() }, password)
        cancelReset()
        signedIn(me, fresh = true)
    }

    fun cancelReset() {
        _reset.value = null
        prefs.edit().remove("reset").apply()
    }

    /** Logs out here: the server forgets this device (and its notifications), and the phone what it kept. */
    suspend fun logout() {
        Graph.push.unregister()
        runCatching { api.logout() }
        signedOut()
    }

    /** The server ended the login (logged out elsewhere, password changed). */
    fun expire(reason: String) {
        if (_state.value !is AuthState.SignedIn) return
        Toasts.show(reason)
        signedOut()
    }

    /** The account changed (name, photo, privacy): keep the new copy. */
    fun setUser(me: User) {
        if (_state.value is AuthState.SignedIn) {
            _state.update { AuthState.SignedIn(me) }
            save("user", me)
        }
    }

    private fun signedIn(me: User, fresh: Boolean) {
        val was = user
        _state.value = AuthState.SignedIn(me)
        save("user", me)
        if (fresh || was?.id != me.id) {
            Graph.onSignedIn(me)
        }
    }

    private fun signedOut() {
        val was = user
        _state.value = AuthState.SignedOut
        prefs.edit().remove("user").apply()
        cookies.clear()
        Graph.onSignedOut(was)
    }

    private inline fun <reified T> load(key: String): T? =
        prefs.getString(key, null)?.let { runCatching { json.decodeFromString<T>(it) }.getOrNull() }

    private inline fun <reified T> save(key: String, value: T) {
        prefs.edit().putString(key, json.encodeToString(value)).apply()
    }
}
