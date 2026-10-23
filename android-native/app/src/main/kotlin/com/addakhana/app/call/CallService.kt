package com.addakhana.app.call

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.addakhana.app.Graph
import com.addakhana.app.R
import com.addakhana.app.push.Avatars
import com.addakhana.app.data.Devices
import com.addakhana.app.push.Notifications
import kotlinx.coroutines.launch

/** What's running: a call, room voice, a live stream or a room's video playing on. */
data class Session(
    /** call, voice, live or watch */
    val kind: String,
    val name: String,
    /** A call's phase: outgoing, connecting, active. */
    val phase: String? = null,
    val hue: Int = 260,
    val photo: String? = null,
    /** My camera is on. */
    val video: Boolean = false,
    val startedAt: Long = 0,
    val muted: Boolean = false,
    /** live: file or screen */
    val mode: String? = null,
    val title: String? = null,
    val paused: Boolean = false,
    /** My screen is being captured for a live stream (whatever the notification is about). */
    val projection: Boolean = false,
    /** A file's sound goes out through WebRTC's recording, so the microphone is in use. */
    val recording: Boolean = false,
)

/**
 * Keeps a call, room voice or live stream going with the app in the
 * background or the screen off: a foreground service, with the ongoing
 * notification and its hang-up button; the processor and Wi-Fi awake; the
 * phone in call audio mode. One-to-one voice calls play from the earpiece
 * (the screen turns off at your ear); video calls and rooms use the
 * loudspeaker.
 */
class CallService : Service() {
    companion object {
        private const val ACTION_UPDATE = "com.addakhana.app.CALL_UPDATE"
        const val ACTION_HANGUP = "com.addakhana.app.CALL_HANGUP"
        const val ACTION_MUTE = "com.addakhana.app.CALL_MUTE"
        private const val ACTION_STOP = "com.addakhana.app.CALL_STOP"
        private const val ID = 5

        @Volatile var running = false
            private set
        private val _projecting = kotlinx.coroutines.flow.MutableStateFlow(false)
        /** Running with screen capture allowed (a live stream of my screen may start capturing). */
        val projecting: kotlinx.coroutines.flow.StateFlow<Boolean> = _projecting
        /** call, voice, live, watch or none */
        @Volatile var kind = "none"
            private set
        @Volatile private var session: Session? = null
        @Volatile private var instance: CallService? = null
        /** null: the session's default (the earpiece for voice calls); otherwise what the person chose. */
        @Volatile private var speakerChoice: Boolean? = null

        /** What's running now; null stops the service. */
        fun update(c: Context, next: Session?) {
            if (next == null) {
                session = null
                if (running) c.startService(Intent(c, CallService::class.java).setAction(ACTION_STOP))
                return
            }
            val wasKind = session?.kind
            session = next
            if (wasKind != next.kind) speakerChoice = null
            val i = Intent(c, CallService::class.java).setAction(ACTION_UPDATE)
            try {
                if (running) c.startService(i) else ContextCompat.startForegroundService(c, i)
            } catch (_: Exception) {
                // Not allowed from the background; the call goes on as long as Android lets it.
            }
        }

        fun setSpeaker(on: Boolean) {
            speakerChoice = on
            instance?.let { s -> s.main.post { s.applyAudio() } }
        }

        /** Settings › Audio and video changed: a call going on follows. */
        fun refreshAudio() {
            instance?.let { s -> s.main.post { s.applyAudio() } }
        }

        fun speakerOn(c: Context): Boolean {
            val am = c.getSystemService(AudioManager::class.java) ?: return false
            return if (Build.VERSION.SDK_INT >= 31) am.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else @Suppress("DEPRECATION") am.isSpeakerphoneOn
        }

        fun action(c: Context, action: String): PendingIntent =
            PendingIntent.getService(c, if (action == ACTION_MUTE) 72 else 71, Intent(c, CallService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    val main = Handler(Looper.getMainLooper())
    private var proximity: PowerManager.WakeLock? = null
    private var awake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var focus: AudioFocusRequest? = null
    private var callMode = false
    private var routed = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Graph.init(applicationContext)
        when (intent?.action) {
            ACTION_HANGUP -> {
                // Ends whatever is running.
                main.post {
                    when (kind) {
                        "call" -> Graph.calls.endCall()
                        "voice" -> Graph.voice.leave()
                        "watch" -> Graph.watch.stop()
                        "live" -> Graph.scope.launch { Graph.live.stop() }
                        else -> update(this, null)
                    }
                }
                return START_NOT_STICKY
            }
            ACTION_MUTE -> {
                main.post { if (kind == "call") Graph.calls.toggleMute() else if (kind == "voice") Graph.voice.toggleMute() }
                return START_NOT_STICKY
            }
            ACTION_UPDATE -> {}
            else -> {
                stop(startId)
                return START_NOT_STICKY
            }
        }
        val now = session
        if (now == null || !goForeground(now, build(now))) {
            stop(startId)
            return START_NOT_STICKY
        }
        running = true
        kind = now.kind
        stayAwake()
        if (now.kind == "call" || now.kind == "voice") enterCallAudio()
        applyAudio()
        return START_NOT_STICKY
    }

    /**
     * Android 14+ only allows a microphone or camera service once that
     * permission is granted, so ask for what's allowed now. False when
     * Android refuses altogether.
     */
    private fun goForeground(s: Session, n: Notification): Boolean {
        if (Build.VERSION.SDK_INT < 29) {
            startForeground(ID, n)
            return true
        }
        val talking = s.kind == "call" || s.kind == "voice" || s.recording
        var types = 0
        if (Build.VERSION.SDK_INT >= 30) {
            if (talking && granted(Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (s.video && granted(Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        // Screen capture needs its own type, and no fallback without it.
        if (s.projection) {
            try {
                ServiceCompat.startForeground(this, ID, n, types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
                _projecting.value = true
                return true
            } catch (e: Exception) {
                Log.w("CallService", "screen capture refused", e)
            }
        }
        _projecting.value = false
        val attempts = if (types == 0) listOf(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else listOf(types, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        for (t in attempts) {
            try {
                ServiceCompat.startForeground(this, ID, n, t)
                return true
            } catch (_: Exception) {
                // Try the next, smaller set.
            }
        }
        return running
    }

    private fun granted(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun build(s: Session): Notification {
        val open = Notifications.open(this, if (s.kind == "call") "/call" else "/", 70)
        val hangup = action(this, ACTION_HANGUP)
        val b = NotificationCompat.Builder(this, Notifications.CH_ONGOING)
            .setColor(Notifications.BRAND)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (s.startedAt > 0) b.setUsesChronometer(true).setWhen(s.startedAt).setShowWhen(true)
        when (s.kind) {
            "call" -> {
                val status = when (s.phase) {
                    "outgoing" -> R.string.call_calling
                    "connecting" -> R.string.call_connecting
                    else -> if (s.video) R.string.call_ongoing_video else R.string.call_ongoing_voice
                }
                val p = Person.Builder().setName(s.name).setIcon(Avatars.icon(this, s.name, s.hue, s.photo)).setImportant(true).build()
                b.setSmallIcon(if (s.video) R.drawable.ic_video else R.drawable.ic_call)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentTitle(s.name)
                    .setContentText(getString(status))
                    .setStyle(NotificationCompat.CallStyle.forOngoingCall(p, hangup).setIsVideo(s.video))
                    .addPerson(p)
            }
            "voice" -> b.setSmallIcon(if (s.video) R.drawable.ic_video else R.drawable.ic_mic)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentTitle(getString(if (s.video) R.string.room_video else R.string.room_voice))
                .setContentText(s.name)
                .addAction(if (s.muted) R.drawable.ic_mic_off else R.drawable.ic_mic, getString(if (s.muted) R.string.pip_unmute else R.string.pip_mute), action(this, ACTION_MUTE))
                .addAction(R.drawable.ic_call_end, getString(R.string.leave), hangup)
            "watch" -> b.setSmallIcon(R.drawable.ic_play)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setContentTitle(s.title ?: getString(R.string.app_name))
                .setContentText(getString(if (s.paused) R.string.watching_paused else R.string.watching_in, s.name))
                .addAction(R.drawable.ic_stop, getString(R.string.stop), hangup)
            else -> b.setSmallIcon(R.drawable.ic_radio)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentTitle(getString(if (s.mode == "screen") R.string.live_screen else R.string.live_file))
                .setContentText(getString(R.string.live_to, s.name))
                .addAction(R.drawable.ic_stop, getString(R.string.stop), hangup)
        }
        return b.build()
    }

    // ── Awake with the screen off ──────────────────────────────────────

    @SuppressLint("WakelockTimeout")
    private fun stayAwake() {
        if (awake == null) {
            awake = getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AddaKhana:running")?.apply { setReferenceCounted(false) }
        }
        awake?.acquire(6 * 60 * 60 * 1000L)
        if (wifi == null) {
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifi = applicationContext.getSystemService(WifiManager::class.java)?.createWifiLock(mode, "AddaKhana:running")?.apply { setReferenceCounted(false) }
        }
        wifi?.let { if (!it.isHeld) it.acquire() }
    }

    private fun letSleep() {
        awake?.let { if (it.isHeld) it.release() }
        wifi?.let { if (it.isHeld) it.release() }
    }

    // ── Sound: call mode, earpiece or loudspeaker, the proximity sensor ──

    /** The phone's call audio (echo cancelling, the call volume), and other sound pauses meanwhile. */
    private fun enterCallAudio() {
        if (callMode) return
        val am = getSystemService(AudioManager::class.java) ?: return
        callMode = true
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= 26) {
            focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener { }
                .build()
            am.requestAudioFocus(focus!!)
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
    }

    private fun leaveCallAudio() {
        if (!callMode) return
        callMode = false
        val am = getSystemService(AudioManager::class.java) ?: return
        am.mode = AudioManager.MODE_NORMAL
        if (Build.VERSION.SDK_INT >= 26) focus?.let { am.abandonAudioFocusRequest(it) } else @Suppress("DEPRECATION") am.abandonAudioFocus(null)
        focus = null
    }

    fun applyAudio() {
        if (!running) return
        val s = session ?: return
        val am = getSystemService(AudioManager::class.java) ?: return
        val oneToOne = s.kind == "call"
        val voiceCall = oneToOne && !s.video
        // A video's sound plays as media.
        if (s.kind == "live" || s.kind == "watch") {
            releaseProximity()
            return
        }
        // Where Settings › Audio and video sends it (when that's connected), unless the call's own speaker button was used.
        val chosen = Devices.device(this, Devices.output.value)
        if (speakerChoice == null && chosen != null) {
            routeTo(am, chosen)
            if (oneToOne && chosen.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE && s.phase == "active") holdProximity() else releaseProximity()
            val on = speakerOn(this)
            main.post { if (kind == "call") Graph.calls.speakerChanged(on) }
            return
        }
        // Headphones or a headset take the sound wherever they are.
        if (hasHeadset(am)) {
            releaseProximity()
            return
        }
        val speaker = speakerChoice ?: !voiceCall
        route(am, speaker)
        // The screen turns off at your ear (only when the sound is at your ear).
        if (oneToOne && !speaker && s.phase == "active") holdProximity() else releaseProximity()
        // What actually happened (a tablet has no earpiece, say), not what was asked for.
        val on = speakerOn(this)
        main.post { if (kind == "call") Graph.calls.speakerChanged(on) }
    }

    private fun route(am: AudioManager, speaker: Boolean) {
        routed = true
        if (Build.VERSION.SDK_INT >= 31) {
            val want = if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            am.availableCommunicationDevices.firstOrNull { it.type == want }?.let { am.setCommunicationDevice(it) }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = speaker
        }
    }

    /** A particular device (Settings › Audio and video). */
    private fun routeTo(am: AudioManager, d: AudioDeviceInfo) {
        routed = true
        if (Build.VERSION.SDK_INT >= 31) {
            am.setCommunicationDevice(d)
            return
        }
        @Suppress("DEPRECATION")
        when (d.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> {
                am.isSpeakerphoneOn = false
                am.startBluetoothSco()
                am.isBluetoothScoOn = true
            }
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> am.isSpeakerphoneOn = true
            else -> am.isSpeakerphoneOn = false
        }
    }

    private fun hasHeadset(am: AudioManager): Boolean = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { d ->
        when (d.type) {
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_USB_HEADSET -> true
            else -> Build.VERSION.SDK_INT >= 31 && d.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }
    }

    @SuppressLint("WakelockTimeout")
    private fun holdProximity() {
        if (proximity?.isHeld == true) return
        val pm = getSystemService(PowerManager::class.java) ?: return
        if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
        proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "AddaKhana:call").apply {
            setReferenceCounted(false)
            acquire(4 * 60 * 60 * 1000L)
        }
    }

    private fun releaseProximity() {
        proximity?.let { if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
        proximity = null
    }

    /** Stops, unless another request is queued behind this one (voice moving from one room to another). */
    private fun stop(startId: Int) {
        if (stopSelfResult(startId)) tearDown()
    }

    private fun tearDown() {
        running = false
        _projecting.value = false
        kind = "none"
        speakerChoice = null
        main.removeCallbacksAndMessages(null)
        releaseProximity()
        letSleep()
        val am = getSystemService(AudioManager::class.java)
        if (routed && am != null) {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice() else @Suppress("DEPRECATION") {
                am.setSpeakerphoneOn(false)
                if (am.isBluetoothScoOn) {
                    am.stopBluetoothSco()
                    am.isBluetoothScoOn = false
                }
            }
        }
        routed = false
        leaveCallAudio()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    override fun onDestroy() {
        if (running) tearDown()
        if (instance === this) instance = null
        super.onDestroy()
    }
}
