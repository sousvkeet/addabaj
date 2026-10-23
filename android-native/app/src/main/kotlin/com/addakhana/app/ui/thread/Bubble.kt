package com.addakhana.app.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallMissed
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.produceState
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import android.media.MediaMetadataRetriever
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.addakhana.app.data.DataUse
import androidx.compose.ui.draw.blur
import com.addakhana.app.data.Media
import com.addakhana.app.data.VoicePlayer
import com.addakhana.app.model.Attachment
import com.addakhana.app.model.LinkPreview
import com.addakhana.app.model.Message
import com.addakhana.app.model.ReplyRef
import com.addakhana.app.ui.attachmentLabel
import com.addakhana.app.ui.clock
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.components.hsl
import com.addakhana.app.ui.components.url
import com.addakhana.app.ui.deletedText
import com.addakhana.app.ui.duration
import com.addakhana.app.ui.formatBytes
import com.addakhana.app.ui.home.Ticks
import com.addakhana.app.ui.theme.palette
import java.io.File

/** How a message sits: mine or theirs, first or later in a group (the grouped corner is tighter). */
data class Placement(val mine: Boolean, val firstInGroup: Boolean, val lastInGroup: Boolean, val showName: Boolean)

private val URL = Regex("""https?://[^\s<]+""")

/** Links in text (trailing punctuation left out, a ")" kept when it closes a "(" inside), and @mentions highlighted. */
@Composable
fun richText(m: Message, mine: Boolean, me: String?): AnnotatedString {
    val p = palette
    val text = m.body
    return buildAnnotatedString {
        val marks = mutableListOf<Triple<Int, Int, String?>>() // start, end, url (null: a mention of someone)
        for (match in URL.findAll(text)) {
            var u = match.value
            while (u.isNotEmpty() && u.last() in ".,!?;:'\"") u = u.dropLast(1)
            if (u.endsWith(")") && u.count { it == '(' } < u.count { it == ')' }) u = u.dropLast(1)
            marks += Triple(match.range.first, match.range.first + u.length, u)
        }
        val mentions = m.mentions.orEmpty().filter { it.offset >= 0 && it.offset + it.length <= text.length }
        var i = 0
        val all = (marks.map { Triple(it.first, it.second, it.third) } + mentions.map { Triple(it.offset, it.offset + it.length, "@" + it.id) }).sortedBy { it.first }
        for ((start, end, target) in all) {
            if (start < i) continue
            append(text.substring(i, start))
            val piece = text.substring(start, end)
            if (target != null && target.startsWith("@")) {
                val forMe = target.drop(1) == me
                withStyle(SpanStyle(color = if (mine) Color.White else if (forMe && p.dark) p.live else p.brand, fontWeight = FontWeight.SemiBold, background = if (forMe) (if (p.dark) p.live.copy(alpha = 0.2f) else p.brand.copy(alpha = 0.15f)) else Color.Transparent)) { append(piece) }
            } else if (target != null) {
                withLink(LinkAnnotation.Url(target, TextLinkStyles(SpanStyle(color = if (mine) Color.White else p.brand, textDecoration = TextDecoration.Underline)))) { append(piece) }
            }
            i = end
        }
        append(text.substring(i))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Bubble(
    m: Message,
    place: Placement,
    me: String?,
    receipts: String?,
    onImage: (Attachment) -> Unit,
    onQuote: (ReplyRef) -> Unit,
    onRetry: () -> Unit,
    onReact: (String) -> Unit,
) {
    val p = palette
    val mine = place.mine
    val big = 22.dp
    val small = 8.dp
    val shape = if (mine) {
        RoundedCornerShape(topStart = big, topEnd = if (place.firstInGroup) big else small, bottomStart = big, bottomEnd = if (place.lastInGroup) big else small)
    } else {
        RoundedCornerShape(topStart = if (place.firstInGroup) big else small, topEnd = big, bottomStart = if (place.lastInGroup) big else small, bottomEnd = big)
    }
    val a = m.attachment
    val media = a != null && (a.kind == "image" || a.kind == "video") && !m.isDeleted
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        if (place.showName && !mine && m.sender != null) {
            Text(
                m.sender.name,
                color = if (p.dark) hsl(m.sender.hue.toFloat(), 0.9f, 0.74f) else hsl(m.sender.hue.toFloat(), 0.75f, 0.32f),
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(start = 12.dp, bottom = 2.dp),
            )
        }
        BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
            val maxW = minOf(maxWidth * 0.78f, 560.dp)
            if (m.isDeleted) {
                Text(
                    deletedText(mine, m.deletedByAdmin),
                    color = p.inkSoft,
                    fontStyle = FontStyle.Italic,
                    fontSize = 14.sp,
                    modifier = Modifier
                        .widthIn(max = maxW)
                        .clip(RoundedCornerShape(16.dp))
                        .border(1.dp, p.line, RoundedCornerShape(16.dp))
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                )
                return@BoxWithConstraints
            }
            Column(
                Modifier
                    .widthIn(max = maxW)
                    .clip(shape)
                    .background(if (mine) p.aurora else SolidColor(p.surface))
                    .then(if (!mine) Modifier.border(1.dp, p.line.copy(alpha = 0.7f), shape) else Modifier)
                    .then(if (m.pending == "failed") Modifier.background(Color.Transparent) else Modifier)
                    .padding(if (media) 4.dp else 0.dp),
            ) {
                if (m.forwarded) {
                    Text("Forwarded", color = if (mine) Color.White.copy(alpha = 0.8f) else p.inkSoft, fontSize = 12.sp, fontStyle = FontStyle.Italic, modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp))
                }
                m.replyTo?.let { Quote(it, mine, onQuote) }
                if (a != null) AttachmentView(a, m, mine, onImage)
                if (m.body.isNotEmpty()) {
                    Text(
                        richText(m, mine, me),
                        color = if (mine) Color.White else p.ink,
                        fontSize = 15.sp,
                        lineHeight = 21.sp,
                        modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = if (a != null || m.replyTo != null) 6.dp else 9.dp),
                    )
                }
                m.preview?.let { LinkCard(it, mine) }
                // Time, "edited" and (mine) where it got to.
                Row(
                    Modifier.align(Alignment.End).padding(start = 14.dp, end = 10.dp, bottom = 6.dp, top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val metaColor = if (mine) Color.White.copy(alpha = 0.8f) else p.inkSoft
                    if (m.editedAt != null) Text("edited · ", color = metaColor, fontSize = 11.5.sp)
                    Text(clock(m.createdAt), color = metaColor, fontSize = 11.5.sp)
                    if (mine && m.senderId != null) {
                        Spacer(Modifier.width(3.dp))
                        Ticks(m, size = 13, tint = metaColor)
                    } else if (mine && m.pending == "sending") {
                        Spacer(Modifier.width(3.dp))
                        Ticks(m, size = 13, tint = metaColor)
                    }
                }
            }
        }
        if (m.reactions.isNotEmpty()) Reactions(m, me, mine, onReact)
        if (m.pending == "failed") {
            Text("Not sent. Tap to retry", color = p.danger, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable(onClick = onRetry).padding(horizontal = 8.dp, vertical = 4.dp))
        }
        if (receipts != null) Text(receipts, color = p.inkSoft, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
    }
}

/** The quoted message a reply answers; tapping it goes there. */
@Composable
private fun Quote(r: ReplyRef, mine: Boolean, onQuote: (ReplyRef) -> Unit) {
    val p = palette
    Row(
        Modifier
            .padding(start = 8.dp, end = 8.dp, top = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (mine) Color.White.copy(alpha = 0.16f) else p.subtle)
            .clickable { onQuote(r) }
            .padding(end = 10.dp),
    ) {
        Box(Modifier.width(3.dp).height(40.dp).background(if (mine) Color.White else p.brand))
        Column(Modifier.padding(start = 8.dp, top = 5.dp, bottom = 5.dp)) {
            Text(r.senderName, color = if (mine) Color.White else p.brand, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, maxLines = 1)
            Text(
                if (r.deleted) "This message was deleted" else r.body.ifEmpty { r.attachment?.let { attachmentLabel(it) }.orEmpty() },
                color = if (mine) Color.White.copy(alpha = 0.85f) else p.inkSoft,
                fontSize = 13.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                fontStyle = if (r.deleted) FontStyle.Italic else FontStyle.Normal,
            )
        }
    }
}

@Composable
private fun AttachmentView(a: Attachment, m: Message, mine: Boolean, onImage: (Attachment) -> Unit) {
    val p = palette
    val context = LocalContext.current
    val local = m.localFile?.path?.let { File(it) }
    when (a.kind) {
        "image", "video" -> {
            val ratio = if ((a.width ?: 0) > 0 && (a.height ?: 0) > 0) a.width!!.toFloat() / a.height!! else 1f
            // On the phone: being sent, sent from here, or downloaded ahead.
            val onPhone = local ?: remember(a.url) { Media.cachedFile(context, a.url) }
            // Otherwise the server's small copy in the chat (the whole photo opens on a tap).
            val remote = onPhone == null && a.url.startsWith("/api/files/")
            val preview = url(Media.thumb(a.url, 640)).orEmpty()
            val net by DataUse.net.collectAsState()
            val auto by DataUse.auto.collectAsState()
            val cached = rememberInCache(preview)
            val shown = remote && (mine || auto.getValue(net).photos || a.id in Loaded.ids || cached)
            // Downloaded ahead where Settings › Storage and data allows it, so they play at once.
            if (a.kind == "video" && remote && m.pending == null && auto.getValue(net).videos && a.size in 1..PREFETCH_VIDEO) {
                LaunchedEffect(a.id) { Media.prefetch(context, a.url) }
            }
            Box(
                Modifier
                    .widthIn(max = 300.dp)
                    .heightIn(max = 340.dp)
                    .aspectRatio(ratio.coerceIn(0.5f, 2.2f))
                    .clip(RoundedCornerShape(14.dp))
                    .background(p.subtle)
                    .clickable { if (a.kind == "image" && remote && !shown) Loaded.ids += a.id else onImage(a) },
                contentAlignment = Alignment.Center,
            ) {
                when {
                    !remote -> when {
                        a.kind == "image" -> AsyncImage(model = onPhone ?: url(a.url), contentDescription = a.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        onPhone != null -> VideoFrame(onPhone, Modifier.fillMaxSize())
                    }
                    shown -> AsyncImage(model = preview, contentDescription = a.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    // Not downloaded on this network: a blurred hint of it (half a kilobyte), and its size.
                    else -> AsyncImage(model = url(Media.thumb(a.url, 48)), contentDescription = a.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().blur(18.dp))
                }
                if (a.kind == "video") {
                    Box(Modifier.size(52.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.PlayArrow, "Play", tint = Color.White, modifier = Modifier.size(32.dp))
                    }
                    // Its size while it isn't on the phone (as WhatsApp's).
                    val details = listOfNotNull(a.duration?.let { duration(it) }, a.size.takeIf { it > 0 && remote }?.let { formatBytes(it) }).joinToString(" · ")
                    if (details.isNotEmpty()) Text(details, color = Color.White, fontSize = 12.sp, modifier = Modifier.align(Alignment.BottomStart).padding(8.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.5f)).padding(horizontal = 6.dp, vertical = 2.dp))
                } else if (remote && !shown) {
                    Row(Modifier.clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Download, "Download", tint = Color.White, modifier = Modifier.size(18.dp))
                        if (a.size > 0) Text(" ${formatBytes(a.size)}", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                m.upload?.let { pct -> Text("$pct%", color = Color.White, fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 10.dp, vertical = 4.dp)) }
            }
        }
        "voice" -> {
            val net by DataUse.net.collectAsState()
            val auto by DataUse.auto.collectAsState()
            if (m.pending == null && auto.getValue(net).audio) LaunchedEffect(a.id) { Media.prefetch(context, a.url) }
            VoiceView(a, m, mine)
        }
        else -> Row(
            Modifier
                .padding(start = 8.dp, end = 8.dp, top = 8.dp)
                .widthIn(min = 220.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(if (mine) Color.White.copy(alpha = 0.16f) else p.subtle)
                .clickable(enabled = m.pending == null) { Media.download(context, a) }
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(if (mine) Color.White.copy(alpha = 0.2f) else p.brand.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Description, null, tint = if (mine) Color.White else p.brand)
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(a.name, color = if (mine) Color.White else p.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(m.upload?.let { "Sending… $it%" } ?: formatBytes(a.size.takeIf { it > 0 } ?: (local?.length() ?: 0)), color = if (mine) Color.White.copy(alpha = 0.8f) else p.inkSoft, fontSize = 12.5.sp)
            }
            if (m.pending == null) Icon(Icons.Rounded.Download, "Download", tint = if (mine) Color.White else p.inkSoft)
        }
    }
}

/** Videos up to this size download ahead, where allowed (bigger ones stream when played). */
private const val PREFETCH_VIDEO = 25L * 1024 * 1024

/** Photos tapped to download (on a network where they don't by themselves), for as long as the app runs. */
private object Loaded {
    val ids = androidx.compose.runtime.mutableStateListOf<String>()
}

/** A video's picture, from the file on the phone (nothing to download). */
@Composable
internal fun VideoFrame(file: File, modifier: Modifier = Modifier) {
    val frame by produceState<ImageBitmap?>(null, file.path) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val r = MediaMetadataRetriever()
                try {
                    r.setDataSource(file.path)
                    val at = 500_000L // just after the start (the very first frame is often black)
                    val bmp = if (Build.VERSION.SDK_INT >= 27) r.getScaledFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 640, 640) else r.getFrameAtTime(at)
                    bmp?.asImageBitmap()
                } finally {
                    r.release()
                }
            }.getOrNull()
        }
    }
    frame?.let { Image(it, null, contentScale = ContentScale.Crop, modifier = modifier) }
}

/** Whether a picture is on the phone already (Coil's disk cache): showing it costs nothing. */
@Composable
private fun rememberInCache(url: String): Boolean {
    val context = LocalContext.current
    return remember(url) { runCatching { coil3.SingletonImageLoader.get(context).diskCache?.openSnapshot(url)?.use { true } }.getOrNull() == true }
}

/** A voice message: play/pause, the waveform (tap to go there), its time, and its speed. */
@Composable
private fun VoiceView(a: Attachment, m: Message, mine: Boolean) {
    val p = palette
    val context = LocalContext.current
    val player by VoicePlayer.state.collectAsState()
    val current = player.id == a.id
    val total = if (current && player.duration > 0) player.duration else ((a.duration ?: 0.0) * 1000).toLong()
    val progress = if (current && total > 0) player.position.toFloat() / total else 0f
    Row(Modifier.padding(start = 8.dp, end = 12.dp, top = 8.dp).width(240.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(40.dp).clip(CircleShape).background(if (mine) SolidColor(Color.White) else p.aurora).clickable(enabled = m.pending == null) { VoicePlayer.toggle(context, a) },
            contentAlignment = Alignment.Center,
        ) {
            if (current && player.loading) Spinner(size = 18.dp, color = if (mine) p.brand else Color.White)
            else Icon(if (current && player.playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (current && player.playing) "Pause" else "Play", tint = if (mine) p.brand else Color.White)
        }
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            val bars = a.waveform?.takeIf { it.isNotEmpty() } ?: List(48) { 30 }
            BoxWithConstraints(Modifier.fillMaxWidth().height(28.dp).pointerInput(a.id) {
                detectTapGestures(onTap = { pos -> if (current) VoicePlayer.seek(pos.x / size.width) })
            }) {
                Row(Modifier.fillMaxWidth().fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(1.5.dp), verticalAlignment = Alignment.CenterVertically) {
                    bars.forEachIndexed { i, v ->
                        val played = i.toFloat() / bars.size < progress
                        val color = if (mine) Color.White.copy(alpha = if (played) 1f else 0.35f) else (if (p.dark) p.live else p.brand).copy(alpha = if (played) 1f else 0.35f)
                        Box(Modifier.weight(1f).fillMaxHeight(v.coerceIn(8, 100) / 100f).clip(RoundedCornerShape(2.dp)).background(color))
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                val shown = if (current && player.position > 0) player.position else total
                Text(duration(shown / 1000.0), color = if (mine) Color.White.copy(alpha = 0.85f) else p.inkSoft, fontSize = 12.sp)
                Spacer(Modifier.weight(1f))
                if (current) Text(
                    "${if (player.speed % 1f == 0f) player.speed.toInt().toString() else player.speed.toString()}×",
                    color = if (mine) Color.White else p.brand,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.clickable { VoicePlayer.cycleSpeed() }.padding(horizontal = 4.dp),
                )
                m.upload?.let { Text("$it%", color = if (mine) Color.White else p.inkSoft, fontSize = 12.sp) }
            }
        }
    }
}

/** A link's card: picture, site, title and description. */
@Composable
private fun LinkCard(link: LinkPreview, mine: Boolean) {
    val p = palette
    val uri = LocalUriHandler.current
    Column(
        Modifier
            .padding(start = 8.dp, end = 8.dp, top = 6.dp)
            .width(280.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (mine) Color.White.copy(alpha = 0.16f) else p.subtle)
            .clickable { runCatching { uri.openUri(link.url) } },
    ) {
        link.image?.let { AsyncImage(model = url(it), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().aspectRatio(1.91f)) }
        Column(Modifier.padding(10.dp)) {
            if (link.site.isNotBlank()) Text(link.site.uppercase(), color = if (mine) Color.White.copy(alpha = 0.8f) else p.inkSoft, fontSize = 11.5.sp, maxLines = 1)
            if (link.title.isNotBlank()) Text(link.title, color = if (mine) Color.White else p.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (link.description.isNotBlank()) Text(link.description, color = if (mine) Color.White.copy(alpha = 0.85f) else p.inkSoft, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Reactions(m: Message, me: String?, mine: Boolean, onReact: (String) -> Unit) {
    val p = palette
    FlowRow(Modifier.padding(start = if (mine) 0.dp else 8.dp, end = if (mine) 8.dp else 0.dp, top = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (r in m.reactions) {
            val minePick = me != null && me in r.users
            Row(
                Modifier
                    .clip(CircleShape)
                    .background(if (minePick) p.brand.copy(alpha = 0.15f) else p.surface)
                    .border(1.dp, if (minePick) p.brand.copy(alpha = 0.6f) else p.line, CircleShape)
                    .clickable { onReact(r.emoji) }
                    .padding(horizontal = 8.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(r.emoji, fontSize = 14.sp)
                if (r.users.size > 1) {
                    Spacer(Modifier.width(3.dp))
                    Text(r.users.size.toString(), color = p.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/** A call in a chat: who called, how it went, and "Call back" for a missed one. */
@Composable
fun CallEntry(m: Message, me: String?, onCallBack: (Boolean) -> Unit) {
    val p = palette
    val outgoing = m.senderId == me
    val outcome = m.meta?.outcome
    val video = m.meta?.video == true
    val missed = outcome == "missed" || outcome == "declined"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start) {
        Row(
            Modifier.clip(RoundedCornerShape(18.dp)).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), RoundedCornerShape(18.dp)).padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(if (missed) SolidColor(p.danger) else p.aurora), contentAlignment = Alignment.Center) {
                Icon(if (missed) Icons.Rounded.CallMissed else if (video) Icons.Rounded.Videocam else Icons.Rounded.Call, null, tint = Color.White, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column {
                val what = (if (outgoing) "Outgoing" else "Incoming") + if (video) " video call" else " call"
                Text(if (missed && !outgoing) "Missed ${if (video) "video " else ""}call" else m.body.ifBlank { what }, color = p.ink, fontWeight = FontWeight.SemiBold, fontSize = 14.5.sp)
                val d = m.meta?.duration
                Text((if (d != null && d > 0) "${duration(d.toDouble())} long, " else "") + clock(m.createdAt), color = p.inkSoft, fontSize = 12.5.sp)
                if (missed && !outgoing) Text("Call back", color = p.brand, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable { onCallBack(video) }.padding(top = 2.dp))
            }
        }
    }
}

/** A room's notice ("Riya added Meera"): a quiet pill in the middle. */
@Composable
fun SystemEntry(m: Message) {
    val p = palette
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            m.body,
            color = p.inkSoft,
            fontSize = 13.sp,
            modifier = Modifier.clip(RoundedCornerShape(14.dp)).background(p.subtle.copy(alpha = 0.7f)).padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

/** "Today", "Yesterday", "Tuesday, 12 October". */
@Composable
fun DayPill(label: String) {
    val p = palette
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(
            label.uppercase(),
            color = p.inkSoft,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(p.surface.copy(alpha = 0.74f)).border(1.dp, p.line.copy(alpha = 0.6f), RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

