package com.addakhana.app.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the app's main screen is on screen, for read receipts and the
 * server's pushes. The call screen over the lock screen doesn't count:
 * nobody reads their chats there, so messages still come as notifications.
 */
object AppLifecycle {
    private val _foreground = MutableStateFlow(false)
    val foreground: StateFlow<Boolean> = _foreground.asStateFlow()

    private val _callScreen = MutableStateFlow(false)
    /** The phone's call screen (ringing, or a call answered on the lock screen) is showing. */
    val callScreen: StateFlow<Boolean> = _callScreen.asStateFlow()

    /** From the main screen's onStart and onStop. */
    fun shown(on: Boolean) {
        _foreground.value = on
    }

    /** From the call screen's onStart and onStop. */
    fun callScreenShown(on: Boolean) {
        _callScreen.value = on
    }
}
