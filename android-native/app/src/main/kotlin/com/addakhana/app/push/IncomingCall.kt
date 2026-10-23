package com.addakhana.app.push

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import com.addakhana.app.Graph
import com.addakhana.app.MainActivity
import com.addakhana.app.R
import com.addakhana.app.call.CallService
import com.addakhana.app.call.IncomingCallActivity
import com.addakhana.app.data.AppLifecycle

/**
 * Incoming calls while the app is closed or in the background: the phone
 * rings with its ringtone and shows the call screen (over the lock screen
 * too), with Answer and Decline, like a phone call.
 */
object IncomingCall {
    const val ID_CALL = 4
    /** A little longer than the server lets a call ring a phone. */
    const val RING_MS = 46_000L
    private const val CLOCK_SLACK_MS = 10 * 60_000L

    /**
     * Calls this process already rang for. The push and the live connection
     * often bring the same call at the same moment, and posting it twice
     * stops the ringtone (Android mutes a notification that alerts again).
     */
    private val rung: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet())

    fun tag(callId: String) = "call:$callId"

    /** From a push (or the live connection while the app is out of sight). */
    fun ring(c: Context, d: Map<String, String>) {
        val callId = d["callId"]
        if (!ActionReceiver.isId(callId) || wasEnded(c, callId!!)) return
        // A push that arrived too late to answer (the margin allows for a phone whose clock is off).
        val sentAt = d["sentAt"]?.toLongOrNull() ?: System.currentTimeMillis()
        if (System.currentTimeMillis() - sentAt > RING_MS + CLOCK_SLACK_MS) return
        // The app on screen rings itself; and nobody takes a second call mid-call (watching a video isn't one).
        if (AppLifecycle.foreground.value || (CallService.running && CallService.kind != "watch")) return
        if (isRinging(c, callId) || !rung.add(callId)) return

        val name = d["callerName"] ?: "Someone"
        val hue = Avatars.hue(d["callerHue"])
        val video = d["video"] == "1"
        val caller = Person.Builder()
            .setName(name)
            .setKey(d["callerId"])
            .setIcon(Avatars.iconNow(c, name, hue, d["callerPhoto"]))
            .setImportant(true)
            .build()

        val screen = Intent(c, IncomingCallActivity::class.java)
            .putExtra("callId", callId)
            .putExtra("callerId", d["callerId"])
            .putExtra("name", name)
            .putExtra("hue", hue)
            .putExtra("photo", d["callerPhoto"])
            .putExtra("video", video)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
        val full = PendingIntent.getActivity(c, tag(callId).hashCode(), screen, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val n = NotificationCompat.Builder(c, Notifications.CH_CALLS)
            .setSmallIcon(if (video) R.drawable.ic_video else R.drawable.ic_call)
            .setColor(Notifications.BRAND)
            .setContentTitle(name)
            .setContentText(c.getString(if (video) R.string.incoming_video_call else R.string.incoming_voice_call))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setTimeoutAfter(RING_MS)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, ActionReceiver.decline(c, callId), answer(c, callId, video)).setIsVideo(video))
            .addPerson(caller)
            // Android 7 (channels set these from 8 on).
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
            .setVibrate(Notifications.RING_VIBRATION)
            .build()
        // Keep ringing until answered, declined or the caller gives up.
        n.flags = n.flags or Notification.FLAG_INSISTENT
        try {
            NotificationManagerCompat.from(c).notify(tag(callId), ID_CALL, n)
        } catch (_: SecurityException) {
            // No permission to notify.
        }
    }

    /** Answering opens the app, which joins the call. */
    fun answer(c: Context, callId: String, video: Boolean): PendingIntent {
        val i = Intent(c, MainActivity::class.java)
            .setAction(MainActivity.ACTION_ANSWER)
            .putExtra("callId", callId)
            .putExtra("video", video)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(c, ("answer$callId").hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** The server says the call is over: stop ringing, and note a call nobody answered. */
    fun ended(c: Context, d: Map<String, String>) {
        val callId = d["callId"]
        if (!ActionReceiver.isId(callId)) return
        val wasRinging = isRinging(c, callId!!)
        val firstWord = !wasEnded(c, callId)
        stopRinging(c, callId)
        val reason = d["reason"]
        val missed = reason == "missed" || reason == "cancelled"
        if (missed && firstWord && (wasRinging || !AppLifecycle.foreground.value)) {
            Graph.notifications.showMissedCall(d["callerId"], d["callerName"] ?: "Someone", Avatars.hue(d["callerHue"]), d["callerPhoto"], d["video"] == "1")
        }
    }

    fun stopRinging(c: Context, callId: String) {
        rememberEnded(c, callId)
        NotificationManagerCompat.from(c).cancel(tag(callId), ID_CALL)
        IncomingCallActivity.finishFor(callId)
    }

    fun isRinging(c: Context, callId: String?): Boolean {
        if (callId == null) return false
        val nm = c.getSystemService(NotificationManager::class.java) ?: return false
        return nm.activeNotifications.any { it.id == ID_CALL && it.tag == tag(callId) }
    }

    // Calls that ended, so a push that arrives late doesn't ring for them.
    private fun ended(c: Context) = c.getSharedPreferences("ended_calls", Context.MODE_PRIVATE)

    fun wasEnded(c: Context, callId: String) = ended(c).contains(callId)

    private fun rememberEnded(c: Context, callId: String) {
        val p = ended(c)
        val e = p.edit()
        val now = System.currentTimeMillis()
        for ((key, value) in p.all) if (value is Long && now - value > 10 * 60_000) e.remove(key)
        e.putLong(callId, now).apply()
    }

    fun canRingFullScreen(c: Context): Boolean {
        if (Build.VERSION.SDK_INT < 34) return true
        return c.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() == true
    }
}
