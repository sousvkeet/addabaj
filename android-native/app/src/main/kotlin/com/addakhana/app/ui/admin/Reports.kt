package com.addakhana.app.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Forward
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.HideImage
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.RemoveCircle
import androidx.compose.material.icons.rounded.Replay
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.addakhana.app.Graph
import com.addakhana.app.data.Media
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.AdminReport
import com.addakhana.app.model.Attachment
import com.addakhana.app.model.KeptFile
import com.addakhana.app.model.KeptMessage
import com.addakhana.app.model.ReportList
import com.addakhana.app.ui.clock
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.ConfirmDialog
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.components.url
import com.addakhana.app.ui.dayLabel
import com.addakhana.app.ui.sameDay
import com.addakhana.app.ui.theme.palette
import com.addakhana.app.ui.thread.MediaViewer
import kotlinx.coroutines.launch

private val REASONS = mapOf(
    "spam" to "Spam",
    "harassment" to "Harassment or bullying",
    "inappropriate" to "Inappropriate content",
    "impersonation" to "Pretending to be someone",
    "other" to "Something else",
)

private val DID = mapOf("deleted-message" to "message deleted", "switched-off" to "account switched off")

/** What the toast says once an action is done. */
private fun doneText(action: String, r: AdminReport) = when (action) {
    "resolve" -> "Marked as resolved."
    "dismiss" -> "Dismissed."
    "reopen" -> "Reopened. It's waiting again."
    "delete-message" -> "The message was deleted for everyone."
    else -> "${r.target?.name ?: "They"} was logged out and can't log in."
}

private const val PAGE = 20

/** Messages a report shows before "Show earlier". */
private const val SHOWN = 4

private fun about(r: AdminReport) = when (r.scope) {
    "user" -> "A person"
    "room" -> "A message in ${r.room?.name ?: "a room"}"
    else -> "A message in a chat"
}

/** `status`: open or closed. Keeps the waiting count up to date too. */
private suspend fun fetchReports(status: String, offset: Int): ReportList {
    val list = Graph.api.adminReports(status, PAGE, offset)
    ReportCount.set(list.open)
    return list
}

/** Another report about the same person or message, brought up to date after acting on `done`. */
private fun sync(r: AdminReport, done: AdminReport): AdminReport {
    var next = r
    if (done.target != null && r.target?.id == done.target.id) next = next.copy(target = done.target)
    if (done.messageId != null && r.scope == done.scope && r.messageId == done.messageId) next = next.copy(messageDeleted = done.messageDeleted)
    return next
}

private data class Shown(val reports: List<AdminReport>, val hasMore: Boolean)

/** Not shown, only compared: the tab the list is of, and the waiting count when it loaded. */
private class Seen {
    var tab: String? = null
    var baseline: Int? = null
}

/** Host admin: what people reported, and what was done about it. */
@Composable
internal fun ReportsPage() {
    val p = palette
    val co = rememberCoroutineScope()
    val open by ReportCount.open.collectAsState()
    // open (waiting) or closed (handled)
    var tab by remember { mutableStateOf("open") }
    var data by remember { mutableStateOf<Shown?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloads by remember { mutableIntStateOf(0) }
    var loadingMore by remember { mutableStateOf(false) }
    // What's being done to each report right now (by its id).
    var busy by remember { mutableStateOf(mapOf<String, String>()) }
    var confirming by remember { mutableStateOf<Pair<AdminReport, String>?>(null) }
    // New reports since the list loaded: offered with a button, so the list doesn't move under the host's finger.
    var fresh by remember { mutableStateOf(false) }
    val seen = remember { Seen() }

    LaunchedEffect(tab, reloads) {
        if (seen.tab != tab) data = null
        error = null
        seen.baseline = null
        attempt { fetchReports(tab, 0) }
            .onSuccess { list ->
                seen.tab = tab
                data = Shown(list.reports, list.hasMore)
                fresh = false
                if (tab == "open") seen.baseline = list.open
            }
            .onFailure { error = reason(it) }
    }

    LaunchedEffect(open, tab) {
        val now = open ?: return@LaunchedEffect
        val before = seen.baseline ?: return@LaunchedEffect
        if (tab != "open") return@LaunchedEffect
        if (now > before) fresh = true else seen.baseline = now
    }

    // Everything shown was handled but there are more: fetch them.
    LaunchedEffect(data) {
        val d = data
        if (d != null && d.reports.isEmpty() && d.hasMore) reloads++
    }

    fun more() {
        val d = data ?: return
        val asked = tab
        loadingMore = true
        co.launch {
            attempt { fetchReports(asked, d.reports.size) }
                .onSuccess { list ->
                    if (seen.tab == asked) {
                        data = data?.let { cur -> Shown(cur.reports + list.reports.filter { r -> cur.reports.none { it.id == r.id } }, list.hasMore) }
                    }
                }
                .onFailure { Toasts.error(reason(it)) }
            loadingMore = false
        }
    }

    // On in the app's scope: it's done on the server whatever happens to this page.
    fun act(report: AdminReport, action: String) {
        busy = busy + (report.id to action)
        Graph.scope.launch {
            attempt { Graph.api.actOnReport(report.id, action) }
                .onSuccess { done ->
                    // Out of this tab if it's moved to the other one.
                    val stays = (done.status == "open") == (seen.tab == "open")
                    data = data?.let { d -> d.copy(reports = d.reports.flatMap { r -> if (r.id == done.id) listOfNotNull(done.takeIf { stays }) else listOf(sync(r, done)) }) }
                    Toasts.show(doneText(action, done), Toasts.Tone.Live)
                    ReportCount.load()
                }
                .onFailure { Toasts.error(reason(it)) }
            busy = busy - report.id
        }
    }

    Column(Modifier.fillMaxSize().background(p.canvas)) {
        AdminHeader("Reports", "Messages and people reported to you") {
            IconBtn(Icons.Rounded.Refresh, "Refresh", { reloads++ }, size = 40.dp, background = SolidColor(p.subtle))
        }
        LazyColumn(
            Modifier.fillMaxSize().navigationBarsPadding(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Tabs(tab, open) { tab = it } }
            if (fresh && tab == "open") {
                item {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        AddaButton("New reports came in. Show them", { reloads++ }, height = 36.dp, variant = Variant.Outline, icon = Icons.Rounded.Refresh)
                    }
                }
            }
            error?.let { item { ErrorBox(it) } }
            val d = data
            when {
                d == null -> if (error == null) item { Loading() }
                d.reports.isEmpty() -> if (!d.hasMore) {
                    item { EmptyBox(if (tab == "open") "Nothing waiting. Reports people send come here." else "No handled reports yet.", Icons.Rounded.Flag) }
                }
                else -> items(d.reports, key = { it.id }) { r ->
                    ReportCard(r, busy[r.id]) { action ->
                        if (action == "delete-message" || action == "switch-off") confirming = r to action else act(r, action)
                    }
                }
            }
            if (d != null && d.hasMore && d.reports.isNotEmpty()) {
                item {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        AddaButton("Show more", { more() }, variant = Variant.Soft, loading = loadingMore)
                    }
                }
            }
        }
    }

    confirming?.let { (r, action) ->
        val switchOff = action == "switch-off"
        ConfirmDialog(
            if (switchOff) "Switch off ${r.target?.name.orEmpty()}?" else "Delete this message?",
            if (switchOff) {
                "They're logged out everywhere and can't log in until you switch their account back on in People. Their messages stay. The report is marked resolved."
            } else {
                "It's deleted for everyone in the ${if (r.scope == "room") "room" else "chat"}, with any photo or file in it. The report keeps its copy and is marked resolved."
            },
            if (switchOff) "Switch off" else "Delete message",
            onConfirm = { act(r, action) },
            onDismiss = { confirming = null },
        )
    }
}

/** Waiting (with how many) or Handled. */
@Composable
private fun Tabs(tab: String, open: Int?, onPick: (String) -> Unit) {
    val p = palette
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(p.subtle).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((id, label, count) in listOf(Triple("open", "Waiting", open), Triple("closed", "Handled", null))) {
            val selected = tab == id
            Row(
                Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(if (selected) p.aurora else SolidColor(Color.Transparent)).clickable { onPick(id) }.padding(vertical = 9.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, color = if (selected) Color.White else p.inkSoft, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                if (count != null && count > 0) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (count > 99) "99+" else count.toString(),
                        color = if (selected) Color.White else p.ink,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.clip(CircleShape).background(if (selected) Color.White.copy(alpha = 0.25f) else p.inkSoft.copy(alpha = 0.15f)).padding(horizontal = 7.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ReportCard(r: AdminReport, busy: String?, onAction: (String) -> Unit) {
    val p = palette
    val t = r.target
    val target = t?.takeIf { !it.gone }
    val waiting = r.status == "open"
    val canDelete = waiting && r.scope != "user" && r.messageId != null && r.messageDeleted != true
    val canSwitchOff = waiting && target != null && !target.disabled
    val did = r.actions.joinToString(", ") { DID[it] ?: it }
    val shape = RoundedCornerShape(24.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), shape).padding(16.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Box(
                Modifier.size(40.dp).clip(RoundedCornerShape(16.dp)).background(if (waiting) p.danger.copy(alpha = 0.12f) else p.subtle),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Rounded.Flag, null, tint = if (waiting) p.danger else p.inkSoft, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(REASONS[r.reason] ?: "Something else", color = p.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text("${about(r)} · ${stamp(r.createdAt)}", color = p.inkSoft, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(14.dp))
        Who("Reported by", r.reporter?.name, r.reporter?.handle, null)
        Spacer(Modifier.height(8.dp))
        Who("Person reported", t?.name, t?.handle, t?.email) {
            if (t?.gone == true) Chip("Account removed", Tone.Muted)
            if (target?.disabled == true) Chip("Switched off", Tone.Danger)
            if (target != null && target.reports > 1) Chip("${target.reports} reports in all", Tone.Warn)
        }
        r.details?.let { details ->
            Row(Modifier.padding(top = 12.dp).fillMaxWidth().height(IntrinsicSize.Min).clip(RoundedCornerShape(16.dp)).background(p.subtle.copy(alpha = 0.6f))) {
                Box(Modifier.width(3.dp).fillMaxHeight().background(if (p.dark) p.live else p.brand))
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Text("${r.reporter?.name ?: "The reporter"} wrote", color = p.inkSoft, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    Text("“$details”", color = p.ink, fontSize = 14.sp)
                }
            }
        }
        Transcript(r)
        HorizontalDivider(Modifier.padding(top = 16.dp), color = p.line.copy(alpha = 0.7f))
        if (waiting) {
            // Two buttons a row; whichever of the first two is there takes the whole row.
            Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (canDelete || canSwitchOff) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (canDelete) {
                            AddaButton("Delete message", { onAction("delete-message") }, Modifier.weight(1f), height = 36.dp, variant = Variant.DangerSoft, icon = Icons.Rounded.Delete, enabled = busy == null)
                        }
                        if (canSwitchOff) {
                            AddaButton("Switch off", { onAction("switch-off") }, Modifier.weight(1f), height = 36.dp, variant = Variant.DangerSoft, icon = Icons.Rounded.PowerSettingsNew, enabled = busy == null)
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AddaButton(
                        "Dismiss", { onAction("dismiss") }, Modifier.weight(1f), height = 36.dp, variant = Variant.Soft, icon = Icons.Rounded.Close,
                        enabled = busy == null || busy == "dismiss", loading = busy == "dismiss",
                    )
                    AddaButton(
                        "Resolve", { onAction("resolve") }, Modifier.weight(1f), height = 36.dp, icon = Icons.Rounded.Check,
                        enabled = busy == null || busy == "resolve", loading = busy == "resolve",
                    )
                }
            }
        } else {
            val dismissed = r.status == "dismissed"
            Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.Top) {
                    Icon(
                        if (dismissed) Icons.Rounded.RemoveCircle else Icons.Rounded.CheckCircle,
                        null,
                        tint = if (dismissed) p.inkSoft else p.liveInk,
                        modifier = Modifier.padding(top = 1.dp).size(17.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        buildAnnotatedString {
                            withStyle(SpanStyle(color = p.ink, fontWeight = FontWeight.SemiBold)) { append(if (dismissed) "Dismissed" else "Resolved") }
                            r.handledBy?.let { append(" by $it") }
                            r.handledAt?.let { append(", ${stamp(it)}") }
                            if (did.isNotEmpty()) append(": $did")
                        },
                        color = p.inkSoft,
                        fontSize = 13.5.sp,
                    )
                }
                Spacer(Modifier.width(8.dp))
                AddaButton("Reopen", { onAction("reopen") }, height = 36.dp, variant = Variant.Soft, icon = Icons.Rounded.Replay, loading = busy == "reopen")
            }
        }
    }
}

/** Who reported, or who was reported: name, @handle, email and how they stand (null name: the account was removed). */
@Composable
private fun Who(label: String, name: String?, handle: String?, email: String?, chips: @Composable () -> Unit = {}) {
    val p = palette
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.subtle.copy(alpha = 0.6f)).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Text(label, color = p.inkSoft, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        if (name != null) {
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(name, color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                if (handle != null) Text("@$handle", color = p.inkSoft, fontSize = 13.sp, modifier = Modifier.align(Alignment.CenterVertically))
                chips()
            }
            if (!email.isNullOrEmpty()) Text(email, color = p.inkSoft, fontSize = 13.sp)
        } else {
            Text("Account removed", color = p.inkSoft, fontSize = 14.sp, fontStyle = FontStyle.Italic)
        }
    }
}

/** The messages kept with the report, as a short chat; the reported one stands out. */
@Composable
private fun Transcript(r: AdminReport) {
    val p = palette
    var all by remember(r.id) { mutableStateOf(false) }
    val messages = r.messages
    if (messages.isEmpty()) {
        if (r.scope == "user") Text("They had no messages with each other.", color = p.inkSoft, fontSize = 13.5.sp, modifier = Modifier.padding(top = 12.dp))
        return
    }
    val at = messages.indexOfFirst { it.id == r.messageId }
    // The last few, always including the reported one.
    val from = if (all) 0 else maxOf(0, minOf(messages.size - SHOWN, if (at < 0) messages.size else at))
    val shown = messages.drop(from)
    val accent = if (p.dark) p.live else p.brand
    val shape = RoundedCornerShape(16.dp)
    Column(Modifier.padding(top = 12.dp).fillMaxWidth().clip(shape).background(p.canvas.copy(alpha = 0.5f)).border(1.dp, p.line.copy(alpha = 0.7f), shape).padding(6.dp)) {
        Text(
            if (r.scope == "user") "Their chat when it was reported" else "The conversation when it was reported",
            color = p.inkSoft,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
        if (all || from > 0) {
            Row(
                Modifier.align(Alignment.CenterHorizontally).clip(CircleShape).clickable { all = !all }.padding(horizontal = 12.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (all) Icons.Rounded.KeyboardArrowDown else Icons.Rounded.KeyboardArrowUp, null, tint = accent, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text(if (all) "Show fewer" else "Show $from earlier ${if (from == 1) "message" else "messages"}", color = accent, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        shown.forEachIndexed { i, m ->
            if (i == 0 || !sameDay(shown[i - 1].createdAt, m.createdAt)) {
                Text(dayLabel(m.createdAt), color = p.inkSoft, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
            }
            Line(m, r, m.id == r.messageId)
        }
    }
}

@Composable
private fun Line(m: KeptMessage, report: AdminReport, reported: Boolean) {
    val p = palette
    if (m.kind == "system") {
        Text(m.body, color = p.inkSoft, fontSize = 12.5.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp))
        return
    }
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().then(
            if (reported) {
                Modifier.padding(vertical = 4.dp).clip(shape).background(p.danger.copy(alpha = 0.08f)).border(1.dp, p.danger.copy(alpha = 0.4f), shape).padding(horizontal = 10.dp, vertical = 8.dp)
            } else {
                Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
            },
        ),
    ) {
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(m.senderName ?: "Removed account", color = p.ink, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
            Text(clock(m.createdAt), color = p.inkSoft, fontSize = 12.5.sp)
            if (m.forwarded) {
                Row(Modifier.align(Alignment.CenterVertically), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Rounded.Forward, null, tint = p.inkSoft, modifier = Modifier.size(12.dp))
                    Spacer(Modifier.width(3.dp))
                    Text("Forwarded", color = p.inkSoft, fontSize = 12.5.sp)
                }
            }
            if (m.editedAt != null && m.deletedAt == null) Text("edited", color = p.inkSoft, fontSize = 12.5.sp)
            if (reported) {
                Chip("Reported", Tone.Danger)
                if (report.messageDeleted == true) Chip("Deleted", Tone.Muted)
            }
        }
        when {
            m.deletedAt != null -> Text("This message was deleted", color = p.inkSoft, fontSize = 14.sp, fontStyle = FontStyle.Italic)
            m.kind == "call" -> Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Call, null, tint = p.inkSoft, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(m.body, color = p.inkSoft, fontSize = 14.sp)
            }
            else -> {
                m.file?.let { KeptFileView(report.id, it, gone = reported && report.messageDeleted == true) }
                if (m.body.isNotEmpty()) Text(m.body, color = p.ink, fontSize = 14.5.sp)
            }
        }
        if (reported && report.edits.isNotEmpty()) {
            HorizontalDivider(Modifier.padding(top = 8.dp), color = p.danger.copy(alpha = 0.2f))
            Text("Before it was edited:", color = p.inkSoft, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
            for (e in report.edits) {
                Row(Modifier.padding(top = 4.dp).height(IntrinsicSize.Min)) {
                    Box(Modifier.width(2.dp).fillMaxHeight().background(p.line))
                    Text(
                        buildAnnotatedString {
                            append(e.body)
                            withStyle(SpanStyle(color = p.inkSoft, fontSize = 12.sp)) { append("  changed at ${clock(e.editedAt)}") }
                        },
                        color = p.ink,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }
        }
    }
}

/** A photo (a thumbnail) or a file from a kept message: photos and videos open here, voice messages and files download. */
@Composable
private fun KeptFileView(reportId: String, file: KeptFile, gone: Boolean) {
    val p = palette
    val context = LocalContext.current
    var broken by remember(file.id) { mutableStateOf(false) }
    var viewing by remember { mutableStateOf(false) }
    // As a message's attachment, so the photo viewer and Downloads take it as they are.
    val a = Attachment(id = file.id, kind = file.kind, name = file.name, url = "/api/admin/reports/$reportId/files/${file.id}")
    val shape = RoundedCornerShape(12.dp)
    if (gone || broken) {
        Row(Modifier.padding(vertical = 4.dp).clip(shape).background(p.subtle).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.HideImage, null, tint = p.inkSoft, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text("File deleted", color = p.inkSoft, fontSize = 12.5.sp)
        }
        return
    }
    if (file.kind == "image") {
        AsyncImage(
            model = url(a.url),
            contentDescription = "Open photo ${file.name}",
            contentScale = ContentScale.Fit,
            onError = { broken = true },
            modifier = Modifier.padding(vertical = 4.dp).heightIn(max = 160.dp).clip(shape).background(p.subtle).border(1.dp, p.line.copy(alpha = 0.7f), shape).clickable { viewing = true },
        )
    } else {
        Row(
            Modifier.padding(vertical = 4.dp).clip(shape).background(p.subtle).clickable { if (file.kind == "video") viewing = true else Media.download(context, a) }.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val icon = when (file.kind) {
                "video" -> Icons.Rounded.Movie
                "voice" -> Icons.Rounded.Mic
                else -> Icons.Rounded.Description
            }
            Icon(icon, null, tint = if (p.dark) p.live else p.brand, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(if (file.kind == "voice") "Voice message" else file.name, color = p.ink, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.width(6.dp))
            Icon(Icons.AutoMirrored.Rounded.OpenInNew, null, tint = p.inkSoft, modifier = Modifier.size(13.dp))
        }
    }
    if (viewing) MediaViewer(a, null) { viewing = false }
}
