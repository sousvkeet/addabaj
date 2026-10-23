package com.addakhana.app.ui.home

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.BatteryChargingFull
import androidx.compose.material.icons.rounded.Bedtime
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.PhoneInTalk
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.addakhana.app.data.Permissions
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.IconTile
import com.addakhana.app.ui.components.Logo
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.theme.palette

private fun iconFor(key: String): ImageVector = when (key) {
    "notifications" -> Icons.Rounded.Notifications
    "microphone" -> Icons.Rounded.Mic
    "camera" -> Icons.Rounded.Videocam
    "fullScreen" -> Icons.Rounded.PhoneInTalk
    "battery" -> Icons.Rounded.BatteryChargingFull
    "samsung" -> Icons.Rounded.Bedtime
    else -> Icons.Rounded.Warning
}

/** Asks for one item: Android's prompt while it can still show, otherwise the phone's settings. */
@Composable
fun rememberAsk(): (String) -> Unit {
    val activity = LocalContext.current as? Activity
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { Permissions.refresh(activity) }
    return { which ->
        val prompts = Permissions.prompts(which)
        if (prompts.isNotEmpty()) {
            Permissions.markAsked(prompts)
            launcher.launch(prompts.toTypedArray())
        } else if (activity != null && which != "all") {
            Permissions.openSettings(activity, which)
        }
    }
}

@Composable
private fun PermissionRows(ask: (String) -> Unit) {
    val p = palette
    val items by Permissions.items.collectAsState()
    items.forEach { item ->
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconTile(iconFor(item.key))
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(item.title, color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold)
                Text(item.hint, color = p.inkSoft, fontSize = 13.sp)
            }
            Spacer(Modifier.width(8.dp))
            when (item.status) {
                Permissions.Status.Granted -> Box(Modifier.size(28.dp).clip(CircleShape).background(p.live), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Check, "Allowed", tint = p.onLive, modifier = Modifier.size(18.dp))
                }
                Permissions.Status.Ask -> AddaButton(if (item.key == "samsung") "Open" else "Allow", { ask(item.key) }, height = 36.dp)
                Permissions.Status.Settings -> AddaButton("Settings", { ask(item.key) }, height = 36.dp, variant = Variant.Soft)
                Permissions.Status.Opened -> AddaButton("Open", { ask(item.key) }, height = 36.dp, variant = Variant.Ghost)
            }
        }
    }
}

/**
 * "Before you start": once, after the first login, so calls ring and
 * messages arrive even when the app is closed. The main button steps
 * through whatever is left.
 */
@Composable
fun PermissionsScreen(onDone: () -> Unit) {
    val p = palette
    val activity = LocalContext.current as? Activity
    val items by Permissions.items.collectAsState()
    val ask = rememberAsk()
    LifecycleResumeEffect(Unit) {
        Permissions.refresh(activity)
        onPauseOrDispose { }
    }
    val runtimeLeft = Permissions.prompts("all").isNotEmpty()
    val next = items.firstOrNull { it.status == Permissions.Status.Ask || it.status == Permissions.Status.Settings }
    Box(Modifier.fillMaxSize().background(p.canvas).background(Brush.radialGradient(listOf(p.glowA, p.canvas.copy(alpha = 0f))))) {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Logo(60.dp)
            Spacer(Modifier.height(16.dp))
            Text("Before you start", color = p.ink, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text("Adda Khana needs a few things from your phone, so calls ring and messages arrive even when the app is closed.", color = p.inkSoft, fontSize = 15.sp, textAlign = TextAlign.Center)
            Spacer(Modifier.height(20.dp))
            PermissionRows(ask)
            Spacer(Modifier.height(24.dp))
            val label = when {
                runtimeLeft -> "Allow"
                next == null -> "Continue"
                next.key == "fullScreen" -> "Next: calls on the lock screen"
                next.key == "battery" -> "Next: run in the background"
                next.key == "background" -> "Next: background activity"
                next.key == "samsung" -> "Next: never sleeping on Samsung"
                else -> "Next: ${next.title.lowercase()}"
            }
            AddaButton(label, {
                when {
                    runtimeLeft -> ask("all")
                    next == null -> {
                        Permissions.markSeen()
                        onDone()
                    }
                    else -> ask(next.key)
                }
            }, Modifier.fillMaxWidth(), height = 48.dp)
            Spacer(Modifier.height(8.dp))
            AddaButton("Not now", {
                Permissions.markSeen()
                onDone()
            }, Modifier.fillMaxWidth(), variant = Variant.Ghost)
            Text("You can change these any time in Settings › App permissions.", color = p.inkSoft, fontSize = 12.5.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp))
        }
    }
}

/** Settings › App permissions: the same rows. */
@Composable
fun PermissionsDialog(onDismiss: () -> Unit) {
    val activity = LocalContext.current as? Activity
    val ask = rememberAsk()
    LifecycleResumeEffect(Unit) {
        Permissions.refresh(activity)
        onPauseOrDispose { }
    }
    AppDialog(onDismiss, "App permissions", "What Adda Khana can do on this phone.", buttons = {
        AddaButton("Done", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Soft)
    }) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) { PermissionRows(ask) }
    }
}
