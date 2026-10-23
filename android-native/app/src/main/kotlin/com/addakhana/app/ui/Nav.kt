package com.addakhana.app.ui

import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf

/** Where the person is. The chats are always at the bottom of the stack, as in the web app. */
sealed interface Screen {
    data class Home(val tab: Tab) : Screen
    data class Chat(val partnerId: String) : Screen
    data class Room(val roomId: String) : Screen
    /** `adding`: open with Add people (a room just started). */
    data class RoomInfo(val roomId: String, val adding: Boolean = false) : Screen
    /** The host admin's area (site admins): its menu ("home"), or one of its pages (see ui/admin/AdminHome.kt). */
    data class Admin(val page: String = "home") : Screen
    /** Settings › Storage and data ("home"), or its Network usage ("usage"). */
    data class Storage(val page: String = "home") : Screen
}

enum class Tab { Chats, Rooms, Invites, You }

/**
 * The screens, as a stack: tabs replace each other (going from the chats to
 * a tab can be undone with Back), threads go on top, and Back from the chats
 * leaves the app.
 */
object Nav {
    val stack = mutableStateListOf<Screen>(Screen.Home(Tab.Chats))
    /** An invite link's code (https://<site>/join/CODE), for the Rooms tab's join dialog. */
    var joinCode: String? = null

    /** Moving forward (into a thread) or back, for the transition. */
    val forward = mutableStateOf(true)

    val top: Screen get() = stack.last()

    fun tab(tab: Tab) {
        forward.value = true
        // Back to the chats: everything above them goes.
        if (tab == Tab.Chats) {
            stack.clear()
            stack.add(Screen.Home(Tab.Chats))
            return
        }
        while (stack.size > 1 && stack.last() !is Screen.Home) stack.removeAt(stack.lastIndex)
        if (stack.size > 1) stack.removeAt(stack.lastIndex)
        stack.add(Screen.Home(tab))
    }

    fun push(screen: Screen) {
        if (stack.last() == screen) return
        forward.value = true
        stack.add(screen)
    }

    /** Opens a chat or room from a notification or link: the chats go underneath it. */
    fun open(screen: Screen) {
        forward.value = true
        stack.clear()
        stack.add(Screen.Home(Tab.Chats))
        if (screen !is Screen.Home) stack.add(screen) else if (screen.tab != Tab.Chats) stack.add(screen)
    }

    /** One step back; false when there's nowhere to go (the app leaves). */
    fun back(): Boolean {
        if (stack.size <= 1) return false
        forward.value = false
        stack.removeAt(stack.lastIndex)
        return true
    }

    /** After leaving or deleting a room: back past it and its info. */
    fun leaveRoom(roomId: String) {
        forward.value = false
        stack.removeAll { (it is Screen.Room && it.roomId == roomId) || (it is Screen.RoomInfo && it.roomId == roomId) }
        if (stack.isEmpty()) stack.add(Screen.Home(Tab.Chats))
    }

    /** A path from a notification or link ("/chats/<id>", "/rooms/<id>"). */
    fun openPath(path: String) {
        val parts = path.trim('/').split('/')
        when {
            parts.size == 2 && parts[0] == "chats" -> open(Screen.Chat(parts[1]))
            parts.size == 2 && parts[0] == "rooms" -> open(Screen.Room(parts[1]))
            parts.firstOrNull() == "rooms" -> open(Screen.Home(Tab.Rooms))
            parts.firstOrNull() == "invites" -> open(Screen.Home(Tab.Invites))
            parts.firstOrNull() == "chats" -> open(Screen.Home(Tab.Chats))
        }
    }

    /** An invite link: the Rooms tab, with its join dialog open on the code. */
    fun join(code: String) {
        joinCode = code
        open(Screen.Home(Tab.Rooms))
    }

    fun reset() {
        stack.clear()
        stack.add(Screen.Home(Tab.Chats))
    }
}
