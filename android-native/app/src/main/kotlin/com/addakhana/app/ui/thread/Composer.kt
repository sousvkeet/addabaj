package com.addakhana.app.ui.thread

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import coil3.compose.AsyncImage
import com.addakhana.app.Graph
import com.addakhana.app.data.Media
import com.addakhana.app.data.Recorder
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.LocalFile
import com.addakhana.app.model.Mention
import com.addakhana.app.model.Message
import com.addakhana.app.model.ReplyRef
import com.addakhana.app.model.Scope
import com.addakhana.app.model.User
import com.addakhana.app.ui.attachmentLabel
import com.addakhana.app.ui.components.Avatar
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.duration
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.launch
import java.io.File

/** What the composer is doing besides writing: replying to a message, or editing one of mine. */
class ComposerState {
    var text by mutableStateOf(TextFieldValue(""))
    var replyTo by mutableStateOf<ReplyRef?>(null)
    var editing by mutableStateOf<Message?>(null)
    val files = mutableStateListOf<LocalFile>()

    fun reply(m: Message) {
        editing = null
        val name = m.sender?.name ?: if (m.senderId == Graph.auth.user?.id) "You" else Graph.chat.now.users[m.senderId]?.name.orEmpty()
        replyTo = ReplyRef(m.id, m.from, name, m.body.take(200), m.attachment?.let { com.addakhana.app.model.ReplyAttachment(it.kind, it.name, it.duration) })
    }

    fun edit(m: Message) {
        replyTo = null
        editing = m
        text = TextFieldValue(m.body, TextRange(m.body.length))
    }
}

/**
 * The message box: text (with @mentions in rooms), photos and files (up to
 * 10, the text going with the first), and voice messages (tap the mic to
 * record, then send or bin it).
 */
@Composable
fun Composer(scope: Scope, chatId: String, state: ComposerState, placeholder: String, members: List<User> = emptyList()) {
    val p = palette
    val context = LocalContext.current
    val co = rememberCoroutineScope()
    var preparing by remember { mutableStateOf(0) }
    /** A video being made smaller to send (Settings › Storage and data), in percent. */
    var compressing by remember { mutableStateOf<Int?>(null) }
    val recorder = remember { Recorder(context) }
    var recording by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { if (recording) recorder.cancel() } }
    val me = Graph.auth.user?.id

    fun addFiles(uris: List<Uri>) {
        val room = 10 - state.files.size
        if (uris.size > room) Toasts.show("Up to 10 files at a time.")
        for (uri in uris.take(room)) {
            preparing++
            co.launch {
                try {
                    state.files += Media.prepare(context, uri) { compressing = it }
                } catch (e: Exception) {
                    Toasts.error(e.message ?: "Couldn't add that file.")
                } finally {
                    preparing--
                    compressing = null
                }
            }
        }
    }
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { addFiles(it) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { addFiles(it) }
    var attachMenu by remember { mutableStateOf(false) }

    fun startRecording() {
        try {
            recorder.start(onLimit = {
                recorder.finish()?.let { Graph.chat.send(scope, chatId, "", state.replyTo, null, it) }
                state.replyTo = null
                recording = false
                Toasts.show("Voice messages can be up to 5 minutes, so this one was sent.")
            })
            recording = true
        } catch (e: Exception) {
            Toasts.error("Couldn't start recording.")
        }
    }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) startRecording() else Toasts.error("Allow the microphone to record voice messages.")
    }

    fun send() {
        val body = state.text.text.trim()
        val editing = state.editing
        if (editing != null) {
            if (body.isEmpty()) return
            co.launch {
                if (Graph.chat.editMessage(scope, editing.id, body, if (scope == Scope.Room) mentionsIn(body, members) else null)) {
                    state.editing = null
                    state.text = TextFieldValue("")
                }
            }
            return
        }
        if (body.isEmpty() && state.files.isEmpty()) return
        val mentions = if (scope == Scope.Room) mentionsIn(body, members) else null
        if (state.files.isEmpty()) {
            Graph.chat.send(scope, chatId, body, state.replyTo, mentions)
        } else {
            state.files.forEachIndexed { i, f ->
                if (i == 0) Graph.chat.send(scope, chatId, body, state.replyTo, mentions, f) else Graph.chat.send(scope, chatId, "", null, null, f)
            }
        }
        state.files.clear()
        state.replyTo = null
        state.text = TextFieldValue("")
        Graph.chat.stopTyping(scope, chatId)
    }

    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp)) {
        // Mentions: "@" (not right after a letter, digit, _ or .) suggests room members.
        if (scope == Scope.Room) {
            val query = mentionQuery(state.text)
            if (query != null) {
                val picks = suggest(query, members.filter { it.id != me })
                if (picks.isNotEmpty()) MentionPopup(picks) { u ->
                    val t = state.text
                    val start = t.text.lastIndexOf('@', t.selection.start - 1)
                    val inserted = "@${u.name} "
                    val text = t.text.substring(0, start) + inserted + t.text.substring(t.selection.start)
                    state.text = TextFieldValue(text, TextRange(start + inserted.length))
                }
            }
        }
        state.replyTo?.let { r -> Banner(Icons.AutoMirrored.Rounded.Reply, "Replying to ${r.senderName}", r.body.ifEmpty { r.attachment?.let { attachmentLabel(it) }.orEmpty() }) { state.replyTo = null } }
        state.editing?.let { Banner(Icons.Rounded.Edit, "Editing message", it.body) { state.editing = null; state.text = TextFieldValue("") } }
        if (state.files.isNotEmpty() || preparing > 0) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.files.forEach { f ->
                    Box(Modifier.size(72.dp).clip(RoundedCornerShape(14.dp)).background(p.subtle)) {
                        if (f.kind == "image") AsyncImage(model = File(f.path), contentDescription = f.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().fillMaxHeight())
                        else if (f.kind == "video") VideoFrame(File(f.path), Modifier.fillMaxWidth().fillMaxHeight())
                        else Column(Modifier.padding(6.dp)) {
                            Icon(Icons.Rounded.Description, null, tint = p.brand)
                            Text(f.name, color = p.ink, fontSize = 10.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Box(
                            Modifier.align(Alignment.TopEnd).padding(3.dp).size(22.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)).clickable { state.files.remove(f); File(f.path).delete() },
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Rounded.Close, "Remove", tint = Color.White, modifier = Modifier.size(14.dp)) }
                    }
                }
                if (preparing > 0) Box(Modifier.size(72.dp).clip(RoundedCornerShape(14.dp)).background(p.subtle), contentAlignment = Alignment.Center) {
                    Spinner()
                    compressing?.let { Text("$it%", color = p.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp)) }
                }
            }
        }
        if (recording) {
            RecordingBar(recorder, onBin = { recorder.cancel(); recording = false }, onSend = {
                recorder.finish()?.let { Graph.chat.send(scope, chatId, "", state.replyTo, null, it) }
                state.replyTo = null
                recording = false
            })
            return@Column
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Row(
                Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(26.dp))
                    .background(p.surface)
                    .border(1.dp, p.line.copy(alpha = 0.8f), RoundedCornerShape(26.dp))
                    .padding(start = 4.dp, end = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    IconBtn(Icons.Rounded.AttachFile, "Attach photos or files", { attachMenu = true }, size = 40.dp, tint = p.inkSoft, enabled = state.editing == null)
                    androidx.compose.material3.DropdownMenu(attachMenu, { attachMenu = false }, containerColor = p.surface) {
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Photos and videos", color = p.ink) }, onClick = {
                            attachMenu = false
                            pickMedia.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                        })
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Files", color = p.ink) }, onClick = {
                            attachMenu = false
                            pickFiles.launch(arrayOf("*/*"))
                        })
                    }
                }
                Box(Modifier.weight(1f).padding(vertical = 12.dp)) {
                    if (state.text.text.isEmpty()) {
                        Text(if (state.files.isNotEmpty()) "Add a caption" else if (state.editing != null) "Edit your message" else placeholder, color = p.inkSoft, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    BasicTextField(
                        value = state.text,
                        onValueChange = {
                            if (it.text.length > Graph.site.config.value.limits.messageLength) return@BasicTextField
                            if (it.text != state.text.text && it.text.isNotEmpty()) Graph.chat.typing(scope, chatId)
                            state.text = it
                        },
                        textStyle = TextStyle(color = p.ink, fontSize = 15.sp, lineHeight = 21.sp),
                        cursorBrush = SolidColor(p.brand),
                        maxLines = 6,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
            val empty = state.text.text.isBlank() && state.files.isEmpty()
            Box(
                Modifier.size(48.dp).clip(CircleShape).background(p.aurora).clickable {
                    when {
                        preparing > 0 -> Unit
                        empty && state.editing == null -> {
                            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startRecording()
                            else askMic.launch(Manifest.permission.RECORD_AUDIO)
                        }
                        else -> send()
                    }
                },
                contentAlignment = Alignment.Center,
            ) {
                when {
                    preparing > 0 -> Spinner(size = 20.dp, color = Color.White)
                    state.editing != null -> Icon(Icons.Rounded.Check, "Save", tint = Color.White)
                    empty -> Icon(Icons.Rounded.Mic, "Record a voice message", tint = Color.White)
                    else -> Icon(Icons.AutoMirrored.Rounded.Send, "Send", tint = Color.White)
                }
            }
        }
    }
}

@Composable
private fun Banner(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, text: String, onClose: () -> Unit) {
    val p = palette
    Row(
        Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), RoundedCornerShape(16.dp)).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = p.brand, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
            Text(title, color = p.brand, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(text, color = p.inkSoft, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconBtn(Icons.Rounded.Close, if (title.startsWith("Reply")) "Cancel reply" else "Cancel editing", onClose, size = 40.dp, tint = p.inkSoft)
    }
}

@Composable
private fun RecordingBar(recorder: Recorder, onBin: () -> Unit, onSend: () -> Unit) {
    val p = palette
    val levels by recorder.live.collectAsState()
    val elapsed by recorder.elapsed.collectAsState()
    val blink = rememberInfiniteTransition(label = "rec")
    val dot by blink.animateFloat(1f, 0.25f, infiniteRepeatable(tween(500), RepeatMode.Reverse), label = "dot")
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        IconBtn(Icons.Rounded.Delete, "Discard", onBin, tint = p.danger)
        Box(Modifier.size(10.dp).alpha(dot).clip(CircleShape).background(p.danger))
        Spacer(Modifier.width(8.dp))
        Text(duration(elapsed / 1000.0), color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(10.dp))
        Row(Modifier.weight(1f).heightIn(min = 32.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
            levels.forEach { v -> Box(Modifier.width(3.dp).fillMaxHeight(fraction = (v.coerceIn(8, 100) / 100f)).clip(RoundedCornerShape(2.dp)).background(p.aurora)) }
        }
        Box(Modifier.size(48.dp).clip(CircleShape).background(p.aurora).clickable(onClick = onSend), contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Rounded.Send, "Send", tint = Color.White)
        }
    }
}

@Composable
private fun MentionPopup(picks: List<User>, onPick: (User) -> Unit) {
    val p = palette
    Column(Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(16.dp))) {
        picks.forEach { u ->
            Row(Modifier.fillMaxWidth().clickable { onPick(u) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(u.name, u.hue, u.photo, 30.dp)
                Spacer(Modifier.width(10.dp))
                Text(u.name, color = p.ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                u.handle?.let { Text("  @$it", color = p.inkSoft, fontSize = 13.sp) }
            }
        }
    }
}

/** What's typed after an "@" that starts a mention, or null. */
private fun mentionQuery(t: TextFieldValue): String? {
    val before = t.text.substring(0, t.selection.start.coerceIn(0, t.text.length))
    val at = before.lastIndexOf('@')
    if (at < 0) return null
    if (at > 0 && (before[at - 1].isLetterOrDigit() || before[at - 1] == '_' || before[at - 1] == '.')) return null
    val q = before.substring(at + 1)
    if (q.length > 30 || q.contains('\n')) return null
    return q
}

/** Up to 6: names starting with it, then any word of the name, then user IDs. */
private fun suggest(q: String, members: List<User>): List<User> {
    val query = q.lowercase().trim()
    val first = members.filter { it.name.lowercase().startsWith(query) }
    val word = members.filter { it !in first && it.name.lowercase().split(' ').any { w -> w.startsWith(query) } }
    val handle = members.filter { it !in first && it !in word && it.handle?.lowercase()?.startsWith(query) == true }
    return (first + word + handle).take(6)
}

/** The people a room message names: "@Full Name" found in it, longest names first. */
fun mentionsIn(body: String, members: List<User>): List<Mention> {
    val out = mutableListOf<Mention>()
    val taken = BooleanArray(body.length)
    for (u in members.sortedByDescending { it.name.length }) {
        val needle = "@" + u.name
        var from = 0
        while (true) {
            val i = body.indexOf(needle, from, ignoreCase = true)
            if (i < 0) break
            from = i + needle.length
            if ((i until i + needle.length).any { taken[it] }) continue
            for (k in i until i + needle.length) taken[k] = true
            out += Mention(u.id, i, needle.length)
        }
    }
    return out.sortedBy { it.offset }.take(20)
}
