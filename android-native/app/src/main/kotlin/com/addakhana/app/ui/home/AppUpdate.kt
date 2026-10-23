package com.addakhana.app.ui.home

import android.app.Activity
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.BuildConfig
import com.addakhana.app.Graph
import com.addakhana.app.data.Updater
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.formatBytes
import com.addakhana.app.ui.theme.palette

/**
 * A newer version from the site's host: "Update app" downloads and installs
 * it; "Later" puts it off (until next time). A required one can't be put off.
 */
@Composable
fun AppUpdate() {
    val p = palette
    val activity = LocalContext.current as? Activity ?: return
    val versions by Graph.site.versions.collectAsState()
    val state by Updater.state.collectAsState()
    var laterFor by remember { mutableIntStateOf(0) }
    val latest = versions.latest ?: return
    if (!Updater.isNewer(latest.versionCode)) return
    val mandatory = versions.required?.let { Updater.isNewer(it.versionCode) } == true
    if (laterFor == latest.versionCode && !mandatory) return
    AppDialog(
        onDismiss = { if (!mandatory) laterFor = latest.versionCode },
        title = if (mandatory) "Update required" else "Update Adda Khana",
        text = "Version ${latest.versionName} is ready (you have ${BuildConfig.VERSION_NAME}).",
        buttons = {
            val busy = state is Updater.State.Downloading || state is Updater.State.Checking
            AddaButton(
                when (state) {
                    is Updater.State.Cancelled -> "Install update"
                    is Updater.State.Failed -> "Try again"
                    else -> "Update app"
                },
                { Updater.start(activity, latest) },
                Modifier.fillMaxWidth(),
                loading = busy,
                enabled = !busy,
            )
            if (!mandatory) AddaButton("Later", { laterFor = latest.versionCode }, Modifier.fillMaxWidth(), variant = Variant.Ghost)
        },
    ) {
        if (latest.notes.isNotBlank()) Text(latest.notes, color = p.ink, fontSize = 14.sp)
        if (latest.size > 0) Text(formatBytes(latest.size), color = p.inkSoft, fontSize = 12.5.sp)
        Spacer(Modifier.height(10.dp))
        when (val s = state) {
            is Updater.State.Downloading -> {
                Text("Downloading…", color = p.inkSoft, fontSize = 13.sp)
                if (s.percent >= 0) LinearProgressIndicator(progress = { s.percent / 100f }, modifier = Modifier.fillMaxWidth(), color = p.brand, trackColor = p.line)
                else LinearProgressIndicator(Modifier.fillMaxWidth(), color = p.brand, trackColor = p.line)
            }
            Updater.State.Checking -> Text("Checking the download…", color = p.inkSoft, fontSize = 13.sp)
            Updater.State.Permission -> Text("Allow Install unknown apps for Adda Khana in the settings that opened, then come back.", color = p.ink, fontSize = 13.5.sp)
            Updater.State.Installing -> Text("Opening the installer: tap Update (or Install) there.", color = p.ink, fontSize = 13.5.sp)
            is Updater.State.Failed -> Text(s.message, color = p.danger, fontSize = 13.5.sp)
            else -> {}
        }
    }
}
