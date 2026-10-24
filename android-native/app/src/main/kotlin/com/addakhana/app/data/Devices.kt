package com.addakhana.app.data

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where a call's sound goes, as chosen in Settings › Audio and video. */
enum class Output(val label: String) {
    /** The earpiece for voice calls, the loudspeaker otherwise; headphones when they're in. */
    Auto("Automatic"),
    Earpiece("Earpiece"),
    Speaker("Loudspeaker"),
    Bluetooth("Bluetooth"),
    Wired("Headphones"),
}

/**
 * Settings › Audio and video: where calls and room voice sound, and which
 * camera they start with. A phone's microphone follows its sound (the
 * headset's when the sound is in the headset), so there's no separate choice.
 */
object Devices {
    private lateinit var prefs: android.content.SharedPreferences
    private val _output = MutableStateFlow(Output.Auto)
    val output: StateFlow<Output> = _output.asStateFlow()
    private val _frontCamera = MutableStateFlow(true)
    /** Calls and room video start with the front camera (else the back one). */
    val frontCamera: StateFlow<Boolean> = _frontCamera.asStateFlow()

    fun init(c: Context) {
        prefs = c.getSharedPreferences("devices", Context.MODE_PRIVATE)
        _output.value = runCatching { Output.valueOf(prefs.getString("output", null) ?: "Auto") }.getOrDefault(Output.Auto)
        _frontCamera.value = prefs.getBoolean("front_camera", true)
    }

    fun setOutput(o: Output) {
        _output.value = o
        prefs.edit().putString("output", o.name).apply()
    }

    fun setFrontCamera(front: Boolean) {
        _frontCamera.value = front
        prefs.edit().putBoolean("front_camera", front).apply()
    }

    /** What kind of output a device is (null: one calls don't use). */
    fun kind(d: AudioDeviceInfo): Output? = when (d.type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> Output.Earpiece
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> Output.Speaker
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> Output.Bluetooth
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> Output.Wired
        else -> if (Build.VERSION.SDK_INT >= 31 && d.type == AudioDeviceInfo.TYPE_BLE_HEADSET) Output.Bluetooth else null
    }

    /** What calls can play through now (with a device's name, for Bluetooth). */
    fun outputs(c: Context): List<Pair<Output, AudioDeviceInfo>> {
        val am = c.getSystemService(AudioManager::class.java) ?: return emptyList()
        val list = if (Build.VERSION.SDK_INT >= 31) am.availableCommunicationDevices else am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
        return list.mapNotNull { d -> kind(d)?.let { it to d } }.distinctBy { it.first }.sortedBy { it.first.ordinal }
    }

    /** The device for a choice, when it's there now (null: Automatic, or not connected). */
    fun device(c: Context, o: Output): AudioDeviceInfo? = if (o == Output.Auto) null else outputs(c).firstOrNull { it.first == o }?.second

    /** A device's label for the list: "Bluetooth: Buds Pro". */
    fun label(o: Output, d: AudioDeviceInfo?): String =
        if (o == Output.Bluetooth && d != null && d.productName.isNotBlank()) "Bluetooth: ${d.productName}" else o.label

    /** The microphone that goes with a sound output (the headset's own, or the phone's). */
    fun microphone(c: Context, o: Output): AudioDeviceInfo? {
        val am = c.getSystemService(AudioManager::class.java) ?: return null
        val inputs = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
        val wanted = when (o) {
            Output.Bluetooth -> listOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO) + if (Build.VERSION.SDK_INT >= 31) listOf(AudioDeviceInfo.TYPE_BLE_HEADSET) else emptyList()
            Output.Wired -> listOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET)
            else -> listOf(AudioDeviceInfo.TYPE_BUILTIN_MIC)
        }
        return inputs.firstOrNull { it.type in wanted } ?: inputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
    }

    fun microphoneLabel(d: AudioDeviceInfo?): String = when (d?.type) {
        null, AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone microphone"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth: ${d.productName}"
        else -> if (Build.VERSION.SDK_INT >= 31 && d.type == AudioDeviceInfo.TYPE_BLE_HEADSET) "Bluetooth: ${d.productName}" else "Headset microphone"
    }
}
