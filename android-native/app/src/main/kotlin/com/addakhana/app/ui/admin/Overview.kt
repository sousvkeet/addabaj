package com.addakhana.app.ui.admin

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.ChatBubble
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.MeetingRoom
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Sensors
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.AuthState
import com.addakhana.app.model.AdminOverview
import com.addakhana.app.model.VideoTools
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.formatBytes
import com.addakhana.app.ui.home.PasswordDialog
import com.addakhana.app.ui.instant
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private fun day(iso: String): LocalDate? = runCatching { LocalDate.parse(iso) }.getOrNull()

/** "T" for Tuesday, under a bar. */
private fun weekday(d: LocalDate?): String = d?.format(DateTimeFormatter.ofPattern("EEEEE", Locale.getDefault())).orEmpty()

/** "Tue, 12 Oct" */
private fun dayName(d: LocalDate?): String = d?.format(DateTimeFormatter.ofPattern("EEE, d MMM", Locale.getDefault())).orEmpty()

/** Activity at a glance: people, rooms and messages, what's happening right now, and the server. */
@Composable
internal fun OverviewPage() {
    val p = palette
    val auth by Graph.auth.state.collectAsState()
    val me = (auth as? AuthState.SignedIn)?.user
    var data by remember { mutableStateOf<AdminOverview?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var changing by remember { mutableStateOf(false) }
    var tick by remember { mutableIntStateOf(0) }
    val live by ReportCount.open.collectAsState()
    val waiting = live ?: data?.reports?.open ?: 0

    LaunchedEffect(tick) {
        // Keep the "right now" numbers fresh.
        while (true) {
            attempt { Graph.api.adminOverview() }
                .onSuccess { d ->
                    data = d
                    error = null
                    d.reports?.let { ReportCount.set(it.open) }
                }
                .onFailure { error = reason(it) }
            delay(15_000)
        }
    }

    AdminPage("Overview", "What's happening on Adda Khana", actions = {
        IconBtn(Icons.Rounded.Refresh, "Refresh", { tick++ }, size = 40.dp, background = SolidColor(p.subtle))
    }) {
        if (me?.mustChangePassword == true) DefaultPassword { changing = true }
        if (waiting > 0) Waiting(waiting)
        error?.let { ErrorBox(it) }
        val d = data
        if (d == null) {
            if (error == null) Loading()
        } else {
            val stats = listOf(
                Stat(Icons.Rounded.Group, "People", d.users.total, "+${d.users.newThisWeek} this week", page = "people"),
                Stat(Icons.Rounded.Wifi, "Online now", d.users.online, "of ${d.users.total} people", live = true),
                Stat(Icons.Rounded.MeetingRoom, "Rooms", d.rooms.total, "${d.rooms.activeToday} active today", page = "rooms"),
                Stat(Icons.Rounded.ChatBubble, "Messages today", d.messages.today, "${num(d.messages.total)} in all"),
                Stat(Icons.Rounded.GraphicEq, "In room voice", d.now.inVoice, "talking right now", live = true),
                Stat(Icons.Rounded.Call, "Calls", d.now.calls, "one-to-one, right now", live = true),
                Stat(Icons.Rounded.Sensors, "Videos playing", d.rooms.watching, "${d.now.liveStreams} live from a device", live = true),
                Stat(Icons.Rounded.Image, "Files shared", d.files.count, formatBytes(d.files.bytes)),
            )
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                for (pair in stats.chunked(2)) {
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        for (s in pair) StatTile(s, Modifier.weight(1f).fillMaxHeight())
                    }
                }
            }
            Bars("New people", "Sign-ups, last 14 days", d.days.map { it.day to it.signups })
            Bars("Messages", "Chats and rooms, last 14 days", d.days.map { it.day to it.messages })
            d.videoTools?.let { VideoToolsPanel(it) }
            Panel(title = "Server") {
                Row(Modifier.fillMaxWidth()) {
                    Fact("Up for", Modifier.weight(1f)) { FactText(uptime(d.server.uptime)) }
                    Fact("Memory", Modifier.weight(1f)) { FactText(formatBytes(d.server.memory)) }
                }
                Spacer(Modifier.height(16.dp))
                Row(Modifier.fillMaxWidth()) {
                    Fact("Node.js", Modifier.weight(1f)) { FactText(d.server.node) }
                    Fact("Sign-ups", Modifier.weight(1f)) {
                        Box(Modifier.padding(top = 2.dp).clickable { Nav.push(Screen.Admin("settings")) }) {
                            if (d.signupsOpen) Chip("Open", Tone.Live) else Chip("Closed", Tone.Danger)
                        }
                    }
                }
            }
        }
    }
    if (changing) PasswordDialog(onDismiss = { changing = false })
}

@Composable
private fun DefaultPassword(onChange: () -> Unit) {
    val p = palette
    val shape = RoundedCornerShape(24.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(p.warnBg).border(1.dp, p.warnLine, shape).padding(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(16.dp)).background(p.warnLine.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Key, null, tint = p.warnInk, modifier = Modifier.size(21.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("You're using the default admin password", color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text("Anyone who knows \"admin\" can run your site. Choose your own password now.", color = p.inkSoft, fontSize = 13.5.sp)
            }
        }
        Spacer(Modifier.height(14.dp))
        AddaButton("Change password", onChange, Modifier.fillMaxWidth())
    }
}

/** Reports waiting: a way straight to them. */
@Composable
private fun Waiting(count: Int) {
    val p = palette
    val shape = RoundedCornerShape(24.dp)
    Row(
        Modifier.fillMaxWidth().clip(shape).background(p.brand.copy(alpha = 0.1f)).border(1.dp, p.brand.copy(alpha = 0.3f), shape)
            .clickable { Nav.push(Screen.Admin("reports")) }.padding(18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(16.dp)).background(p.aurora), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Flag, null, tint = p.onBrand, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(if (count == 1) "1 report waiting" else "${num(count)} reports waiting", color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Text("Messages and people reported to you. Have a look and decide what to do.", color = p.inkSoft, fontSize = 13.5.sp)
        }
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = p.inkSoft)
    }
}

private class Stat(val icon: ImageVector, val label: String, val value: Int, val sub: String, val page: String? = null, val live: Boolean = false)

@Composable
private fun StatTile(s: Stat, modifier: Modifier) {
    val p = palette
    val shape = RoundedCornerShape(24.dp)
    Column(
        modifier.clip(shape).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), shape)
            .then(if (s.page != null) Modifier.clickable { Nav.push(Screen.Admin(s.page)) } else Modifier)
            .padding(16.dp),
    ) {
        Box(
            Modifier.size(40.dp).clip(RoundedCornerShape(16.dp)).background(if (s.live) SolidColor(p.live.copy(alpha = 0.15f)) else p.aurora),
            contentAlignment = Alignment.Center,
        ) {
            Icon(s.icon, null, tint = if (s.live) p.liveInk else p.onBrand, modifier = Modifier.size(19.dp))
        }
        Spacer(Modifier.height(14.dp))
        Text(s.label, color = p.inkSoft, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Text(num(s.value), color = p.ink, fontSize = 30.sp, fontWeight = FontWeight.Bold, lineHeight = 36.sp)
        Text(s.sub, color = p.inkSoft, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A day-by-day bar chart; tap a bar for its day and number (the web app shows them on hover). */
@Composable
private fun Bars(title: String, hint: String, values: List<Pair<String, Int>>) {
    val p = palette
    val max = maxOf(1, values.maxOfOrNull { it.second } ?: 0)
    var picked by remember { mutableStateOf<Int?>(null) }
    val shown = picked?.let { values.getOrNull(it) }
    Panel(
        title = title,
        hint = shown?.let { (d, v) -> "${dayName(day(d))}: $v" } ?: hint,
        action = { Text(num(values.sumOf { it.second }), color = p.ink, fontSize = 22.sp, fontWeight = FontWeight.Bold) },
    ) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(144.dp)
                .pointerInput(values.size) {
                    detectTapGestures { o ->
                        if (values.isEmpty()) return@detectTapGestures
                        val i = (o.x / size.width * values.size).toInt().coerceIn(0, values.lastIndex)
                        picked = if (picked == i) null else i
                    }
                }
                .semantics { contentDescription = "$title: ${values.joinToString { it.second.toString() }}" },
        ) {
            if (values.isEmpty()) return@Canvas
            val gap = 6.dp.toPx()
            val w = (size.width - gap * (values.size - 1)) / values.size
            // Rounded at the top, nearly square at the bottom.
            val top = CornerRadius(minOf(8.dp.toPx(), w / 2))
            val bottom = CornerRadius(2.dp.toPx())
            values.forEachIndexed { i, (_, v) ->
                // Days with nothing still show a sliver.
                val h = maxOf(if (v > 0) 0.06f else 0.03f, v.toFloat() / max) * size.height
                val left = i * (w + gap)
                val bar = Path().apply { addRoundRect(RoundRect(left, size.height - h, left + w, size.height, top, top, bottom, bottom)) }
                if (v > 0) drawPath(bar, p.aurora, alpha = if (picked == null || picked == i) 1f else 0.45f)
                else drawPath(bar, p.line.copy(alpha = 0.6f))
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((d, _) in values) {
                Text(weekday(day(d)), color = p.inkSoft, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            }
        }
    }
}

/** What "Find videos" relies on: whether each works, and the command that fixes it. */
@Composable
private fun VideoToolsPanel(tools: VideoTools) {
    val p = palette
    val (ytdlp, ffmpeg, browser, adBlock) = tools
    val broken = ytdlp.version == null || !ffmpeg.installed || (browser.enabled && browser.checked && !browser.ok)
    Panel(
        title = "Finding videos",
        hint = if (broken) {
            "Something \"Find videos\" needs is missing, so links from some sites won’t work. Run the command shown on the server, in the project folder, then restart it."
        } else {
            "What the server uses to find the video on a pasted link, like a download manager."
        },
    ) {
        Tool("yt-dlp", "Understands about 1,800 sites", ytdlp.version != null, ytdlp.version?.let { "Version $it" } ?: "Not installed", ytdlp.fix)
        HorizontalDivider(color = p.line.copy(alpha = 0.7f))
        Tool("FFmpeg", "Joins sites’ separate picture and sound", ffmpeg.installed, if (ffmpeg.installed) "Installed" else "Not installed", ffmpeg.fix)
        HorizontalDivider(color = p.line.copy(alpha = 0.7f))
        Tool(
            "Background browser",
            "Opens pages and catches the stream when nothing else finds it",
            if (browser.checked) browser.ok else null,
            when {
                !browser.enabled -> "Turned off (DEEP_SCAN=false)"
                browser.ok -> "Ready"
                else -> browser.problem.orEmpty()
            },
            browser.fix.takeIf { browser.enabled },
            off = !browser.enabled,
        )
        HorizontalDivider(color = p.line.copy(alpha = 0.7f))
        Tool(
            "Ad blocking",
            "Blocks ads and trackers while searching, with the filter lists Brave uses",
            if (adBlock.ready) true else if (adBlock.error != null) false else null,
            when {
                !adBlock.enabled -> "Turned off (AD_BLOCK=false)"
                adBlock.ready -> "${num(adBlock.rules)} rules" +
                    (instant(adBlock.updatedAt)?.let { ", updated ${dayName(it.atZone(ZoneId.systemDefault()).toLocalDate())}" } ?: "")
                adBlock.error != null -> "Couldn’t download the filter lists: ${adBlock.error}"
                else -> "Downloading the filter lists…"
            },
            null,
            off = !adBlock.enabled,
        )
    }
}

/** One tool: what it is, whether it works (null: still being checked), and the command that fixes it. */
@Composable
private fun Tool(name: String, what: String, ok: Boolean?, status: String, fix: String?, off: Boolean = false) {
    val p = palette
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(name, color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text(what, color = p.inkSoft, fontSize = 13.sp)
            }
            Spacer(Modifier.width(8.dp))
            when {
                off -> Chip("Off", Tone.Muted)
                ok == null -> Chip("Checking…", Tone.Muted)
                ok -> Chip("Working", Tone.Live)
                else -> Chip("Not working", Tone.Danger)
            }
        }
        if (status.isNotEmpty()) Text(status, color = p.inkSoft, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        if (!off && ok == false && !fix.isNullOrEmpty()) {
            Text(
                fix,
                color = p.ink,
                fontSize = 12.5.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(top = 6.dp).clip(RoundedCornerShape(8.dp)).background(p.subtle).padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
    }
}
