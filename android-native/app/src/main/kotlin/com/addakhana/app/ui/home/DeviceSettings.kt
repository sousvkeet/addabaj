package com.addakhana.app.ui.home

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.addakhana.app.Graph
import com.addakhana.app.call.CallService
import com.addakhana.app.data.Devices
import com.addakhana.app.data.Output
import com.addakhana.app.rtc.NoiseCanceller
import com.addakhana.app.rtc.Rtc
import com.addakhana.app.ui.admin.ToggleRow
import com.addakhana.app.ui.call.VideoView
import com.addakhana.app.ui.call.rememberMediaPermission
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Settings › Audio and video: where calls and room voice sound (and a test
 * sound there), whether the microphone hears you, noise cancellation, and
 * which camera they start with (with a preview).
 */
@Composable
fun DeviceSettings(onDismiss: () -> Unit) {
    val p = palette
    val context = LocalContext.current
    val output by Devices.output.collectAsState()
    val front by Devices.frontCamera.collectAsState()
    val call by Graph.calls.state.collectAsState()
    val voice by Graph.voice.state.collectAsState()
    // In a call or room voice, the microphone and camera are theirs.
    val busy = !call.idle || voice.active
    var outputs by remember { mutableStateOf(Devices.outputs(context)) }
    // Headphones or Bluetooth coming and going while it's open.
    DisposableEffect(Unit) {
        val am = context.getSystemService(AudioManager::class.java)
        val watch = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
                outputs = Devices.outputs(context)
            }

            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
                outputs = Devices.outputs(context)
            }
        }
        am?.registerAudioDeviceCallback(watch, Handler(Looper.getMainLooper()))
        onDispose { am?.unregisterAudioDeviceCallback(watch) }
    }
    AppDialog(
        onDismiss,
        "Audio and video",
        "How calls and room voice sound, and which camera they start with.",
        buttons = { AddaButton("Done", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Soft) },
    ) {
        Heading(Icons.AutoMirrored.Rounded.VolumeUp, "Sound")
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Choice(Output.Auto.label, output == Output.Auto) {
                Devices.setOutput(Output.Auto)
                CallService.refreshAudio()
            }
            for ((o, d) in outputs) Choice(Devices.label(o, d), output == o) {
                Devices.setOutput(o)
                CallService.refreshAudio()
            }
        }
        Text(
            when {
                output == Output.Auto -> "The earpiece for voice calls, the loudspeaker for video and rooms, and headphones when they're in."
                outputs.none { it.first == output } -> "${output.label} isn't connected now, so calls use the automatic choice."
                else -> "Calls and room voice play here when it's connected."
            },
            color = p.inkSoft,
            fontSize = 12.5.sp,
            modifier = Modifier.padding(top = 6.dp),
        )
        Spacer(Modifier.height(8.dp))
        AddaButton("Play test sound", { testSound(context, Devices.device(context, output)) }, height = 36.dp, variant = Variant.Soft, icon = Icons.AutoMirrored.Rounded.VolumeUp)

        Spacer(Modifier.height(18.dp))
        Heading(Icons.Rounded.Mic, "Microphone")
        MicMeter(output, busy)
        Spacer(Modifier.height(14.dp))
        val noiseCancel by Devices.noiseCancel.collectAsState()
        val tooSlow by NoiseCanceller.tooSlow.collectAsState()
        val canCancel = NoiseCanceller.available && !tooSlow
        ToggleRow(
            "Noise cancellation",
            noiseCancel && canCancel,
            { Devices.setNoiseCancel(it) },
            hint = when {
                !NoiseCanceller.available -> "Not available on this phone."
                tooSlow -> "Off for now: this phone couldn't keep up with it in a call. It tries again when the app starts next."
                else -> "Takes background noise out of your microphone in calls and room voice: traffic, typing, fans, a television. Your voice stays."
            },
            enabled = canCancel,
        )

        Spacer(Modifier.height(18.dp))
        Heading(Icons.Rounded.Videocam, "Camera")
        val cameras = remember { runCatching { livekit.org.webrtc.Camera2Enumerator(context).deviceNames.size }.getOrDefault(0) }
        if (cameras > 1) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Choice("Front", front) { Devices.setFrontCamera(true) }
                Choice("Back", !front) { Devices.setFrontCamera(false) }
            }
            Spacer(Modifier.height(8.dp))
        }
        if (cameras == 0) Text("This phone has no camera.", color = p.inkSoft, fontSize = 13.sp)
        else CameraPreview(front, busy)
    }
}

@Composable
private fun Heading(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    val p = palette
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
        Icon(icon, null, tint = p.inkSoft, modifier = Modifier.size(17.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, color = p.ink, fontWeight = FontWeight.SemiBold)
    }
}

/** A short two-note chime, where calls would sound (the loudspeaker for Automatic). */
private fun testSound(c: Context, device: AudioDeviceInfo?) {
    val rate = 44_100
    val samples = ShortArray((rate * 0.9).toInt())
    for (i in samples.indices) {
        val t = i.toDouble() / rate
        val f = if (t < 0.3) 660.0 else 880.0
        val fade = minOf(1.0, (0.9 - t) * 8, t * 60)
        samples[i] = (sin(2 * PI * f * t) * 0.35 * fade * Short.MAX_VALUE).toInt().toShort()
    }
    val track = AudioTrack.Builder()
        .setAudioAttributes(
            AudioAttributes.Builder()
                // The earpiece and headsets are call devices; the loudspeaker plays it as media.
                .setUsage(if (device == null || device.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) AudioAttributes.USAGE_MEDIA else AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setBufferSizeInBytes(samples.size * 2)
        .setTransferMode(AudioTrack.MODE_STATIC)
        .build()
    track.write(samples, 0, samples.size)
    if (device != null) track.setPreferredDevice(device)
    track.play()
    Handler(Looper.getMainLooper()).postDelayed({ runCatching { track.release() } }, 1_200)
}

/** Whether the microphone that goes with the sound hears you: a level and a word. */
@SuppressLint("MissingPermission")
@Composable
private fun MicMeter(output: Output, busy: Boolean) {
    val p = palette
    val context = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberMediaPermission { ok, _ -> granted = ok }
    val mic = remember(output) { Devices.microphone(context, output) }
    var level by remember { mutableFloatStateOf(0f) }
    Text(Devices.microphoneLabel(mic), color = p.ink, fontSize = 14.sp)
    Spacer(Modifier.height(6.dp))
    when {
        busy -> Text("Your call is using the microphone. It shows who's talking there.", color = p.inkSoft, fontSize = 13.sp)
        !granted -> AddaButton("Allow the microphone", { ask(false) }, height = 36.dp, variant = Variant.Soft)
        else -> {
            LaunchedEffect(output) {
                withContext(Dispatchers.IO) {
                    val rate = 16_000
                    val size = maxOf(AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), 3_200)
                    val rec = runCatching { AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size) }.getOrNull()
                        ?.takeIf { it.state == AudioRecord.STATE_INITIALIZED } ?: return@withContext
                    try {
                        mic?.let { rec.setPreferredDevice(it) }
                        rec.startRecording()
                        val buf = ShortArray(1_600)
                        while (isActive) {
                            val n = rec.read(buf, 0, buf.size)
                            if (n <= 0) continue
                            var sum = 0.0
                            for (i in 0 until n) sum += buf[i].toDouble() * buf[i]
                            val rms = sqrt(sum / n) / Short.MAX_VALUE
                            // Quick to rise, slow to fall, like a meter.
                            val shown = minOf(1f, (rms * 6).toFloat())
                            level = if (shown > level) shown else level * 0.85f + shown * 0.15f
                        }
                    } finally {
                        runCatching { rec.stop() }
                        rec.release()
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                LinearProgressIndicator(progress = { level }, modifier = Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(50)), color = p.live, trackColor = p.line)
                Spacer(Modifier.width(10.dp))
                Text(if (level > 0.08f) "Hearing you" else "Say something", color = if (level > 0.08f) p.liveInk else p.inkSoft, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** The chosen camera's picture, while asked for. */
@Composable
private fun CameraPreview(front: Boolean, busy: Boolean) {
    val p = palette
    val context = LocalContext.current
    var on by remember { mutableStateOf(false) }
    val ask = rememberMediaPermission { ok, video -> on = ok && video }
    if (busy) {
        Text("Your call is using the camera.", color = p.inkSoft, fontSize = 13.sp)
        return
    }
    if (!on) {
        AddaButton("Preview camera", { ask(true) }, height = 36.dp, variant = Variant.Soft, icon = Icons.Rounded.Videocam)
        return
    }
    val camera = remember(front) {
        Rtc.init(context)
        Rtc.Camera.open(front = front)
    }
    DisposableEffect(camera) { onDispose { camera?.stop() } }
    Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(RoundedCornerShape(16.dp)).background(Color.Black)) {
        if (camera != null) VideoView(camera.track, Modifier.fillMaxSize(), mirror = camera.front)
        else Text("The camera couldn't start.", color = Color.White, fontSize = 13.sp, modifier = Modifier.align(Alignment.Center))
    }
    Spacer(Modifier.height(8.dp))
    AddaButton("Stop preview", { on = false }, height = 36.dp, variant = Variant.Ghost)
}
