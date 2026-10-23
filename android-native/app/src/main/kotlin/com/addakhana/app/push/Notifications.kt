package com.addakhana.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import com.addakhana.app.MainActivity
import com.addakhana.app.R
import com.addakhana.app.data.AppLifecycle
import org.json.JSONArray
import org.json.JSONObject

/**
 * Message notifications, one per chat or room, like a messenger: the latest
 * messages stacked with each sender's picture, Reply and Mark as read
 * buttons, and a bundle when several chats are waiting. What each shows is
 * kept here (Android only shows what's posted), and dropped once it's read.
 */
class Notifications(private val c: Context) {
    companion object {
        const val CH_MESSAGES = "messages"
        const val CH_ROOMS = "rooms"
        const val CH_CALLS = "calls"
        const val CH_MISSED = "missed_calls"
        const val CH_ONGOING = "ongoing"
        val RING_VIBRATION = longArrayOf(0, 900, 700, 900, 700)

        const val ID_CHAT = 1
        const val ID_SUMMARY = 2
        const val ID_MISSED = 3
        const val GROUP = "com.addakhana.app.MESSAGES"
        const val KEY_REPLY = "reply"
        const val BRAND = 0xFF7C5CFF.toInt()
        private const val KEEP = 12

        fun key(scope: String, chatId: String) = "$scope:$chatId"
        fun path(scope: String, chatId: String) = (if (scope == "room") "/rooms/" else "/chats/") + chatId

        /** Opens the app at `path` (a chat, a room). */
        fun open(c: Context, path: String, requestCode: Int): PendingIntent {
            val i = Intent(c, MainActivity::class.java)
                .setAction(MainActivity.ACTION_OPEN)
                .putExtra(MainActivity.EXTRA_PATH, path)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        fun notify(c: Context, tag: String, id: Int, b: NotificationCompat.Builder) {
            val nm = NotificationManagerCompat.from(c)
            if (!nm.areNotificationsEnabled()) return
            try {
                nm.notify(tag, id, b.build())
            } catch (_: SecurityException) {
                // The notifications permission was taken away meanwhile.
            }
        }
    }

    private val store get() = c.getSharedPreferences("notifications", Context.MODE_PRIVATE)

    /** The channels, as the WebView app had them (their ids are the same, so settings carry over). */
    fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = c.getSystemService(NotificationManager::class.java)
        val messages = NotificationChannel(CH_MESSAGES, c.getString(R.string.ch_messages), NotificationManager.IMPORTANCE_HIGH).apply {
            description = c.getString(R.string.ch_messages_desc)
            enableVibration(true)
            setShowBadge(true)
        }
        val rooms = NotificationChannel(CH_ROOMS, c.getString(R.string.ch_rooms), NotificationManager.IMPORTANCE_HIGH).apply {
            description = c.getString(R.string.ch_rooms_desc)
            enableVibration(true)
            setShowBadge(true)
        }
        // Rings with the phone's ringtone, over and over until answered (FLAG_INSISTENT).
        val calls = NotificationChannel(CH_CALLS, c.getString(R.string.ch_calls), NotificationManager.IMPORTANCE_HIGH).apply {
            description = c.getString(R.string.ch_calls_desc)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
            )
            enableVibration(true)
            vibrationPattern = RING_VIBRATION
            setShowBadge(false)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
        val missed = NotificationChannel(CH_MISSED, c.getString(R.string.ch_missed), NotificationManager.IMPORTANCE_HIGH).apply {
            description = c.getString(R.string.ch_missed_desc)
        }
        val ongoing = NotificationChannel(CH_ONGOING, c.getString(R.string.ch_ongoing), NotificationManager.IMPORTANCE_LOW).apply {
            description = c.getString(R.string.ch_ongoing_desc)
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }
        nm.createNotificationChannels(listOf(messages, rooms, calls, missed, ongoing))
    }

    private fun load(key: String): JSONObject? = runCatching { store.getString(key, null)?.let { JSONObject(it) } }.getOrNull()

    // ── New messages ───────────────────────────────────────────────────

    @Synchronized
    fun showMessage(d: Map<String, String>) {
        // The app on screen shows new messages itself (not while it's only a call floating over other apps).
        if (AppLifecycle.foreground.value && !MainActivity.inPip) return
        val scope = d["scope"]
        val chatId = d["chatId"] ?: return
        if (scope != "dm" && scope != "room") return
        val key = key(scope, chatId)
        try {
            val chat = load(key) ?: JSONObject().put("scope", scope).put("chatId", chatId).put("messages", JSONArray())
            chat.put("name", value(d, "chatName", "Adda Khana")).put("hue", value(d, "chatHue", "260")).put("photo", value(d, "chatPhoto", ""))
            val old = chat.getJSONArray("messages")
            val id = value(d, "messageId", "0").toLong()
            for (i in 0 until old.length()) if (old.getJSONObject(i).optLong("id") == id) return // already shown
            val list = JSONArray()
            for (i in maxOf(0, old.length() - (KEEP - 1)) until old.length()) list.put(old.get(i))
            list.put(
                JSONObject()
                    .put("id", id)
                    .put("sender", value(d, "senderName", "Someone"))
                    .put("senderId", value(d, "senderId", ""))
                    .put("hue", value(d, "senderHue", "260"))
                    .put("photo", value(d, "senderPhoto", ""))
                    .put("text", value(d, "text", ""))
                    .put("at", value(d, "sentAt", System.currentTimeMillis().toString()).toLong()),
            )
            chat.put("messages", list)
            chat.put("unread", chat.optInt("unread") + 1)
            store.edit().putString(key, chat.toString()).apply()
            post(key, chat, alert = true)
            postSummary()
        } catch (_: Exception) {
            // A malformed push: nothing to show.
        }
    }

    /** After replying from the notification: shows the reply (or that it failed) without alerting again. */
    @Synchronized
    fun showReply(scope: String, chatId: String, text: String, sent: Boolean) {
        val key = key(scope, chatId)
        val chat = load(key) ?: return
        runCatching {
            chat.getJSONArray("messages").put(
                JSONObject()
                    .put("id", -System.currentTimeMillis())
                    .put("self", true)
                    .put("text", if (sent) text else c.getString(R.string.reply_failed, text))
                    .put("at", System.currentTimeMillis()),
            )
            store.edit().putString(key, chat.toString()).apply()
            post(key, chat, alert = false)
        }
    }

    private fun post(key: String, chat: JSONObject, alert: Boolean) {
        val scope = chat.getString("scope")
        val chatId = chat.getString("chatId")
        val name = chat.optString("name", "Adda Khana")
        val room = scope == "room"
        val messages = chat.getJSONArray("messages")

        val me = Person.Builder().setName(c.getString(R.string.you)).setKey("me").build()
        val style = NotificationCompat.MessagingStyle(me)
        if (room) {
            style.setConversationTitle(name)
            style.setGroupConversation(true)
        }
        val people = HashMap<String, Person>()
        var last = System.currentTimeMillis()
        for (i in 0 until messages.length()) {
            val m = messages.getJSONObject(i)
            last = m.optLong("at", last)
            if (m.optBoolean("self")) {
                style.addMessage(m.optString("text"), last, null as Person?)
                continue
            }
            val sender = m.optString("sender", "Someone")
            val senderKey = m.optString("senderId", sender)
            val p = people.getOrPut(senderKey) {
                Person.Builder().setName(sender).setKey(senderKey).setIcon(Avatars.icon(c, sender, Avatars.hue(m.optString("hue")), m.optString("photo"))).build()
            }
            style.addMessage(m.optString("text"), last, p)
        }

        val unread = chat.optInt("unread", 1)
        val count = c.resources.getQuantityString(R.plurals.new_messages, unread, unread)
        val channel = if (room) CH_ROOMS else CH_MESSAGES
        val b = NotificationCompat.Builder(c, channel)
            .setSmallIcon(R.drawable.ic_stat_adda)
            .setColor(BRAND)
            .setStyle(style)
            .setContentTitle(name)
            .setContentText(count)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .setGroup(GROUP)
            .setWhen(last)
            .setShowWhen(true)
            .setNumber(unread)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            // On the lock screen: who, not what.
            .setPublicVersion(
                NotificationCompat.Builder(c, channel)
                    .setSmallIcon(R.drawable.ic_stat_adda)
                    .setColor(BRAND)
                    .setContentTitle(c.getString(R.string.app_name))
                    .setContentText(count)
                    .build(),
            )
            .setContentIntent(open(c, path(scope, chatId), key.hashCode()))
            .setDeleteIntent(ActionReceiver.pending(c, ActionReceiver.ACTION_DISMISS, scope, chatId, mutable = false))
            .addAction(replyAction(scope, chatId))
            .addAction(
                NotificationCompat.Action.Builder(R.drawable.ic_done, c.getString(R.string.mark_read), ActionReceiver.pending(c, ActionReceiver.ACTION_READ, scope, chatId, mutable = false))
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                    .setShowsUserInterface(false)
                    .build(),
            )
        // Older Android shows no sender pictures in the message list.
        if (!room && Build.VERSION.SDK_INT < 28) b.setLargeIcon(Avatars.bitmap(c, name, Avatars.hue(chat.optString("hue")), chat.optString("photo"), 192))
        b.setShortcutInfo(conversation(scope, chatId, name, Avatars.hue(chat.optString("hue")), chat.optString("photo"), if (room) null else people[chatId]))
        notify(c, key, ID_CHAT, b)
    }

    /** The chat as a conversation: Android 11+ shows conversations apart, with their picture. */
    private fun conversation(scope: String, chatId: String, name: String, hue: Int, photo: String?, partner: Person?): ShortcutInfoCompat {
        val open = Intent(c, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN).putExtra(MainActivity.EXTRA_PATH, path(scope, chatId))
        val s = ShortcutInfoCompat.Builder(c, key(scope, chatId))
            .setShortLabel(name)
            .setLongLived(true)
            .setIntent(open)
            .setIcon(Avatars.icon(c, name, hue, photo))
        if (partner != null) s.setPerson(partner)
        val info = s.build()
        runCatching { ShortcutManagerCompat.pushDynamicShortcut(c, info) }
        return info
    }

    private fun replyAction(scope: String, chatId: String): NotificationCompat.Action {
        val input = RemoteInput.Builder(KEY_REPLY).setLabel(c.getString(R.string.reply_hint)).build()
        return NotificationCompat.Action.Builder(R.drawable.ic_reply, c.getString(R.string.reply), ActionReceiver.pending(c, ActionReceiver.ACTION_REPLY, scope, chatId, mutable = true))
            .addRemoteInput(input)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
    }

    /** The bundle header when several chats are waiting. */
    private fun postSummary() {
        var chats = 0
        var total = 0
        val inbox = NotificationCompat.InboxStyle()
        for (raw in store.all.values) {
            runCatching {
                val chat = JSONObject(raw.toString())
                val m = chat.getJSONArray("messages")
                if (m.length() == 0) return@runCatching
                chats++
                total += chat.optInt("unread", 1)
                inbox.addLine(chat.optString("name") + ": " + m.getJSONObject(m.length() - 1).optString("text"))
            }
        }
        val nm = NotificationManagerCompat.from(c)
        if (chats < 2) {
            nm.cancel("summary", ID_SUMMARY)
            return
        }
        val line = c.resources.getQuantityString(R.plurals.messages_from_chats, total, total, chats)
        inbox.setSummaryText(line)
        val b = NotificationCompat.Builder(c, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_adda)
            .setColor(BRAND)
            .setContentTitle(c.getString(R.string.app_name))
            .setContentText(line)
            .setStyle(inbox)
            .setGroup(GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setContentIntent(open(c, "/chats", 0))
        notify(c, "summary", ID_SUMMARY, b)
    }

    // ── Clearing ───────────────────────────────────────────────────────

    /** Read here or on another device: the chat's notification goes. */
    @Synchronized
    fun clearChat(scope: String?, chatId: String?) {
        if (scope == null || chatId == null) return
        val key = key(scope, chatId)
        val had = store.contains(key)
        store.edit().remove(key).apply()
        val nm = NotificationManagerCompat.from(c)
        release(key, ID_CHAT)
        nm.cancel(key, ID_CHAT)
        if (scope == "dm") {
            nm.cancel("missed:$chatId", ID_MISSED)
            c.getSharedPreferences("missed", Context.MODE_PRIVATE).edit().remove(chatId).apply()
        }
        if (had) postSummary()
    }

    /** A message was deleted for everyone: take it out of its chat's notification. */
    @Synchronized
    fun removeMessage(scope: String?, chatId: String?, messageId: Long) {
        if (scope == null || chatId == null) return
        val key = key(scope, chatId)
        val chat = load(key) ?: return
        runCatching {
            val old = chat.getJSONArray("messages")
            val kept = JSONArray()
            var removed = 0
            for (i in 0 until old.length()) {
                val m = old.getJSONObject(i)
                if (m.optLong("id") == messageId && !m.optBoolean("self")) removed++ else kept.put(m)
            }
            if (removed == 0) return
            var othersLeft = false
            for (i in 0 until kept.length()) if (!kept.getJSONObject(i).optBoolean("self")) othersLeft = true
            if (!othersLeft) {
                clearChat(scope, chatId)
                return
            }
            chat.put("messages", kept)
            chat.put("unread", maxOf(1, chat.optInt("unread", 1) - removed))
            store.edit().putString(key, chat.toString()).apply()
            post(key, chat, alert = false)
            postSummary()
        }
    }

    /** The notification was swiped away: forget its messages. */
    @Synchronized
    fun forget(scope: String, chatId: String) {
        store.edit().remove(key(scope, chatId)).apply()
        postSummary()
    }

    /** Signed out: nothing of theirs stays on screen. */
    @Synchronized
    fun clearAll() {
        store.edit().clear().apply()
        c.getSharedPreferences("missed", Context.MODE_PRIVATE).edit().clear().apply()
        c.getSystemService(NotificationManager::class.java)?.activeNotifications?.forEach { release(it.tag, it.id) }
        NotificationManagerCompat.from(c).cancelAll()
        val kept = ShortcutManagerCompat.getShortcuts(c, ShortcutManagerCompat.FLAG_MATCH_CACHED).map { it.id }
        ShortcutManagerCompat.removeAllDynamicShortcuts(c)
        if (kept.isNotEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(c, kept)
    }

    /** Android 15+ keeps a notification you replied to and ignores the app removing it; posting it again (silently) lets it go. */
    private fun release(tag: String?, id: Int) {
        if (Build.VERSION.SDK_INT < 35 || tag == null) return
        val nm = c.getSystemService(NotificationManager::class.java) ?: return
        val n = nm.activeNotifications.firstOrNull { it.id == id && it.tag == tag } ?: return
        val quiet = NotificationCompat.Builder(c, n.notification.channelId)
            .setSmallIcon(R.drawable.ic_stat_adda)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setGroup(GROUP)
        notify(c, tag, id, quiet)
    }

    // ── Missed calls ───────────────────────────────────────────────────

    @Synchronized
    fun showMissedCall(callerId: String?, name: String, hue: Int, photo: String?, video: Boolean) {
        if (callerId == null) return
        val missed = c.getSharedPreferences("missed", Context.MODE_PRIVATE)
        val count = missed.getInt(callerId, 0) + 1
        missed.edit().putInt(callerId, count).apply()
        val text = if (count > 1) c.resources.getQuantityString(R.plurals.missed_calls, count, count)
        else c.getString(if (video) R.string.missed_video_call else R.string.missed_voice_call)
        val b = NotificationCompat.Builder(c, CH_MISSED)
            .setSmallIcon(R.drawable.ic_missed)
            .setColor(0xFFFF5C7A.toInt())
            .setLargeIcon(Avatars.bitmap(c, name, hue, photo, 192))
            .setContentTitle(name)
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setContentIntent(open(c, path("dm", callerId), key("dm", callerId).hashCode()))
        notify(c, "missed:$callerId", ID_MISSED, b)
    }

    private fun value(d: Map<String, String>, key: String, fallback: String) = d[key]?.takeIf { it.isNotEmpty() } ?: fallback
}
