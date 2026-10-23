package com.addakhana.app.ui.home

import android.content.Context
import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.SingletonImageLoader
import com.addakhana.app.Graph
import com.addakhana.app.data.AutoDownload
import com.addakhana.app.data.CallSaving
import com.addakhana.app.data.DataUse
import com.addakhana.app.data.Net
import com.addakhana.app.data.Toasts
import com.addakhana.app.data.UploadQuality
import com.addakhana.app.data.Usage
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.admin.AdminPage
import com.addakhana.app.ui.admin.Panel
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.ConfirmDialog
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.formatBytes
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** Settings › Storage and data: its menu ("home"), or Network usage ("usage"). */
@Composable
fun StorageDataScreen(page: String) {
    if (page == "usage") NetworkUsage() else StorageData()
}

@Composable
private fun StorageData() {
    val context = LocalContext.current
    val calls by DataUse.calls.collectAsState()
    val auto by DataUse.auto.collectAsState()
    val photos by DataUse.photos.collectAsState()
    val videos by DataUse.videos.collectAsState()
    val usage by DataUse.usage.collectAsState()
    var dialog by remember { mutableStateOf<String?>(null) }
    var stored by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(Unit) { stored = keptSize(context) }

    AdminPage("Storage and data", "Network use, and what downloads by itself") {
        Panel {
            Row(Modifier.fillMaxWidth().clickable { Nav.push(Screen.Storage("usage")) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Network usage", color = palette.ink, fontSize = 15.5.sp, fontWeight = FontWeight.Medium)
                    val sent = usage.total(true, true) + usage.total(false, true)
                    val received = usage.total(true, false) + usage.total(false, false)
                    Text("${formatBytes(sent)} sent · ${formatBytes(received)} received", color = palette.inkSoft, fontSize = 13.sp)
                }
                Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = palette.inkSoft)
            }
            Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Kept on this phone", color = palette.ink, fontSize = 15.5.sp, fontWeight = FontWeight.Medium)
                    Text(stored?.let { "${formatBytes(it)} of photos, videos and voice messages" } ?: "Counting…", color = palette.inkSoft, fontSize = 13.sp)
                }
                AddaButton("Clear", { dialog = "clear" }, height = 36.dp, variant = Variant.Soft, enabled = (stored ?: 0) > 0)
            }
        }
        Panel(title = "Calls", hint = "Calls, room voice and live streams send less (lower video quality); voices send next to nothing while nobody speaks, always.") {
            Setting("Use less data for calls", calls.label) { dialog = "calls" }
        }
        Panel(title = "Media auto-download", hint = "What downloads by itself on each network. Voice messages always download when you play them, and photos open in full when you tap them.") {
            for (n in Net.entries) Setting(n.label, auto.getValue(n).summary) { dialog = n.name }
        }
        Panel(title = "Media upload quality", hint = "How photos and videos you send are sized.") {
            Setting("Photos", photos.label) { dialog = "photos" }
            Setting("Videos", videos.label) { dialog = "videos" }
        }
    }

    when (val d = dialog) {
        "calls" -> PickOne("Use less data for calls", CallSaving.entries, calls, { it.label }, {
            when (it) {
                CallSaving.Never -> "Calls use what the connection allows"
                CallSaving.Mobile -> "Less on mobile data, full quality on Wi-Fi"
                CallSaving.Always -> "Less on every network"
            }
        }, onPick = { DataUse.setCalls(it) }, onDismiss = { dialog = null })
        "photos" -> PickOne("Photos", UploadQuality.entries, photos, { it.label }, { it.hint }, onPick = { DataUse.setPhotos(it) }, onDismiss = { dialog = null })
        "videos" -> PickOne("Videos", UploadQuality.entries, videos, { it.label }, { it.hint }, onPick = { DataUse.setVideos(it) }, onDismiss = { dialog = null })
        "clear" -> ConfirmDialog(
            "Clear what's kept on this phone?",
            "Photos, videos and voice messages download again when you open them. Your chats and messages stay.",
            "Clear",
            onConfirm = {
                dialog = null
                Graph.scope.launch {
                    clearKept(context)
                    stored = keptSize(context)
                    Toasts.show("Cleared.")
                }
            },
            onDismiss = { dialog = null },
            danger = false,
        )
        null -> {}
        else -> Net.entries.firstOrNull { it.name == d }?.let { n -> AutoDownloadDialog(n, auto.getValue(n)) { dialog = null } }
    }
}

/** A setting's row: its name, what it's set to, and an arrow. */
@Composable
private fun Setting(title: String, value: String, onClick: () -> Unit) {
    val p = palette
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(value, color = p.inkSoft, fontSize = 13.sp)
        }
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = p.inkSoft)
    }
}

/** One of a few choices, each with a line about it. */
@Composable
private fun <T> PickOne(title: String, options: List<T>, current: T, label: (T) -> String, hint: (T) -> String, onPick: (T) -> Unit, onDismiss: () -> Unit) {
    val p = palette
    AppDialog(onDismiss, title, buttons = { AddaButton("Done", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Soft) }) {
        for (o in options) {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { onPick(o) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(o == current, { onPick(o) }, colors = RadioButtonDefaults.colors(selectedColor = p.brand, unselectedColor = p.inkSoft))
                Column(Modifier.weight(1f)) {
                    Text(label(o), color = p.ink, fontSize = 15.sp)
                    Text(hint(o), color = p.inkSoft, fontSize = 12.5.sp)
                }
            }
        }
    }
}

/** What downloads by itself on one network. */
@Composable
private fun AutoDownloadDialog(n: Net, current: AutoDownload, onDismiss: () -> Unit) {
    val p = palette
    var v by remember { mutableStateOf(current) }
    AppDialog(onDismiss, n.label, buttons = {
        AddaButton("Save", {
            DataUse.setAuto(n, v)
            onDismiss()
        }, Modifier.fillMaxWidth())
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        for ((label, on, set) in listOf(
            Triple("Photos", v.photos) { x: Boolean -> v = v.copy(photos = x) },
            Triple("Audio", v.audio) { x: Boolean -> v = v.copy(audio = x) },
            Triple("Videos", v.videos) { x: Boolean -> v = v.copy(videos = x) },
        )) {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { set(!on) }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(on, { set(it) }, colors = CheckboxDefaults.colors(checkedColor = p.brand, uncheckedColor = p.inkSoft))
                Text(label, color = p.ink, fontSize = 15.sp)
            }
        }
    }
}

/** Settings › Storage and data › Network usage: what the app sent and received, on mobile data or Wi-Fi. */
@Composable
private fun NetworkUsage() {
    val p = palette
    val context = LocalContext.current
    val usage by DataUse.usage.collectAsState()
    // Opens on the network in use.
    var wifi by remember { mutableStateOf(DataUse.net.value == Net.Wifi) }
    var resetting by remember { mutableStateOf(false) }
    val since = DateUtils.formatDateTime(context, usage.since, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_YEAR)
    AdminPage("Network usage", "Since $since") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Mobile data", !wifi) { wifi = false }
            Choice("Wi-Fi", wifi) { wifi = true }
        }
        Panel(title = "In all") { Amounts(usage.total(wifi, true), usage.total(wifi, false)) }
        Panel {
            Usage.entries.forEachIndexed { i, kind ->
                if (i > 0) Spacer(Modifier.padding(top = 12.dp))
                Text(kind.label, color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                Amounts(usage.get(wifi, kind, true), usage.get(wifi, kind, false))
            }
        }
        Text("Counted by this phone. Your mobile network may count a little differently.", color = p.inkSoft, fontSize = 12.5.sp)
        AddaButton("Reset statistics", { resetting = true }, Modifier.fillMaxWidth(), variant = Variant.DangerSoft)
    }
    if (resetting) ConfirmDialog(
        "Reset network usage?",
        "The counts start again from zero.",
        "Reset",
        onConfirm = {
            DataUse.resetUsage()
            resetting = false
        },
        onDismiss = { resetting = false },
    )
}

@Composable
private fun Amounts(sent: Long, received: Long) {
    val p = palette
    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.ArrowUpward, "Sent", tint = p.brand, modifier = Modifier.padding(end = 4.dp))
        Text(formatBytes(sent), color = p.ink, fontSize = 14.sp)
        Spacer(Modifier.width(18.dp))
        Icon(Icons.Rounded.ArrowDownward, "Received", tint = p.liveInk, modifier = Modifier.padding(end = 4.dp))
        Text(formatBytes(received), color = p.ink, fontSize = 14.sp)
    }
}

// ── Kept on this phone ─────────────────────────────────────────────

private suspend fun keptSize(c: Context): Long = withContext(Dispatchers.IO) {
    val media = File(c.cacheDir, "media").walkTopDown().filter { it.isFile }.sumOf { it.length() }
    media + (runCatching { SingletonImageLoader.get(c).diskCache?.size }.getOrNull() ?: 0L)
}

private suspend fun clearKept(c: Context) = withContext(Dispatchers.IO) {
    File(c.cacheDir, "media").listFiles()?.forEach { it.delete() }
    runCatching {
        val loader = SingletonImageLoader.get(c)
        loader.diskCache?.clear()
        loader.memoryCache?.clear()
    }
}
