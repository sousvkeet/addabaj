package com.addakhana.app.data

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.NotificationManager
import android.app.usage.UsageStatsManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.addakhana.app.push.IncomingCall
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What the app needs from Android, for "Before you start" and Settings ›
 * App permissions: notifications, the microphone and the camera, ringing
 * over the lock screen (Android 14+) and running in the background; whether
 * Android restricts the app in the background (Android 9+), and on Samsung
 * phones keeping it out of One UI's sleeping apps (which nothing can check:
 * "opened" once its page was shown). Each is granted, ask (Android's prompt
 * can still show) or settings (only the phone's settings can change it now).
 */
object Permissions {
    enum class Status { Granted, Ask, Settings, Opened }

    data class Item(val key: String, val title: String, val hint: String, val status: Status)

    private lateinit var app: Context
    private val prefs get() = app.getSharedPreferences("permissions", Context.MODE_PRIVATE)
    private val _items = MutableStateFlow<List<Item>>(emptyList())
    val items: StateFlow<List<Item>> = _items.asStateFlow()

    fun init(c: Context) {
        app = c.applicationContext
        refresh(null)
    }

    val seen: Boolean get() = prefs.getBoolean("seen", false)

    /** "Before you start" was seen (continued from, or put off): it doesn't come back by itself. */
    fun markSeen() = prefs.edit().putBoolean("seen", true).apply()

    /** Looked again (back from a prompt or the phone's settings). */
    fun refresh(activity: Activity?) {
        val c: Context = activity ?: app
        val list = mutableListOf(
            Item("notifications", "Notifications", "Messages and calls, even when the app is closed.", notifications(activity)),
            Item("microphone", "Microphone", "Calls, room voice and voice messages.", runtime(activity, Manifest.permission.RECORD_AUDIO)),
            Item("camera", "Camera", "Video calls and room video.", runtime(activity, Manifest.permission.CAMERA)),
        )
        if (Build.VERSION.SDK_INT >= 34) {
            list += Item("fullScreen", "Calls on the lock screen", "Calls ring full screen, like a phone call.", if (IncomingCall.canRingFullScreen(c)) Status.Granted else Status.Settings)
        }
        list += Item("battery", "Run in the background", "Calls still ring when the phone saves battery.", if (ignoringBatteryOptimizations()) Status.Granted else Status.Ask)
        if (Build.VERSION.SDK_INT >= 28 && restricted()) {
            list += Item("background", "Background activity", "Android holds Adda Khana back in the background: messages and calls may not arrive.", Status.Settings)
        }
        if (isSamsung) {
            list += Item("samsung", "Never sleeping (Samsung)", "Add Adda Khana to Never sleeping apps, so voice and calls go on when you leave the app.", if (prefs.getBoolean("opened:samsung", false)) Status.Opened else Status.Ask)
        }
        _items.value = list
    }

    val allGood: Boolean get() = _items.value.all { it.status == Status.Granted || it.status == Status.Opened }

    private val isSamsung get() = Build.MANUFACTURER.equals("samsung", ignoreCase = true)

    private fun restricted(): Boolean {
        if (Build.VERSION.SDK_INT < 28) return false
        if (app.getSystemService(ActivityManager::class.java)?.isBackgroundRestricted == true) return true
        if (Build.VERSION.SDK_INT >= 30) return app.getSystemService(UsageStatsManager::class.java)?.appStandbyBucket == UsageStatsManager.STANDBY_BUCKET_RESTRICTED
        return false
    }

    private fun ignoringBatteryOptimizations() = app.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(app.packageName) == true

    private fun runtime(activity: Activity?, permission: String): Status {
        if (app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return Status.Granted
        // Android stops showing its prompt once it's been refused twice (or for good).
        val asked = prefs.getBoolean("asked:$permission", false)
        val prompts = !asked || activity?.shouldShowRequestPermissionRationale(permission) == true
        return if (prompts) Status.Ask else Status.Settings
    }

    private fun notifications(activity: Activity?): Status {
        val on = app.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true
        if (Build.VERSION.SDK_INT >= 33) {
            val r = runtime(activity, Manifest.permission.POST_NOTIFICATIONS)
            // Allowed once, but switched off in the phone's settings since.
            return if (r == Status.Granted && !on) Status.Settings else r
        }
        return if (on) Status.Granted else Status.Settings
    }

    /** The runtime permissions Android can still prompt for ("all"), or one of them. */
    fun prompts(which: String): List<String> {
        val s = _items.value.associate { it.key to it.status }
        fun want(key: String, permission: String) = if (s[key] == Status.Ask) listOf(permission) else emptyList()
        return when (which) {
            "all" -> (if (Build.VERSION.SDK_INT >= 33) want("notifications", Manifest.permission.POST_NOTIFICATIONS) else emptyList()) +
                want("microphone", Manifest.permission.RECORD_AUDIO) + want("camera", Manifest.permission.CAMERA)
            "notifications" -> if (Build.VERSION.SDK_INT >= 33) want("notifications", Manifest.permission.POST_NOTIFICATIONS) else emptyList()
            "microphone" -> want("microphone", Manifest.permission.RECORD_AUDIO)
            "camera" -> want("camera", Manifest.permission.CAMERA)
            else -> emptyList()
        }
    }

    fun markAsked(permissions: List<String>) {
        val e = prefs.edit()
        permissions.forEach { e.putBoolean("asked:$it", true) }
        e.apply()
    }

    /** The phone's own page for one of them, when no prompt can show. */
    fun openSettings(a: Activity, which: String) {
        val pkg = Uri.parse("package:${a.packageName}")
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        when (which) {
            "notifications" -> open(a, Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.packageName), details)
            "fullScreen" -> if (Build.VERSION.SDK_INT >= 34) open(a, Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg), details)
            // Android's "Let the app always run in the background?"; or, where that's missing, the list of apps.
            "battery" -> open(a, Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg), Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            "samsung" -> {
                // One UI's battery page (Background usage limits › Never sleeping apps), older One UI's, or app info.
                prefs.edit().putBoolean("opened:samsung", true).apply()
                open(
                    a,
                    Intent().setComponent(ComponentName("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity")),
                    Intent().setComponent(ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")),
                    details,
                )
            }
            else -> open(a, details)
        }
    }

    private fun open(a: Activity, vararg intents: Intent) {
        for (i in intents) {
            try {
                a.startActivity(i)
                return
            } catch (_: ActivityNotFoundException) {
            } catch (_: SecurityException) {
            }
        }
    }
}
