package com.addakhana.app.ui

import com.addakhana.app.model.Attachment
import com.addakhana.app.model.Message
import com.addakhana.app.model.ReplyAttachment
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

// Times as the web app shows them (client/src/lib/format.ts), in this phone's language and time zone.

private val zone get() = ZoneId.systemDefault()
private val timeFmt get() = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault())
private val weekdayFmt get() = DateTimeFormatter.ofPattern("EEE", Locale.getDefault())
private val dayMonthFmt get() = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
private val fullFmt get() = DateTimeFormatter.ofPattern("EEEE, d MMMM", Locale.getDefault())

fun instant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

private fun daysAgo(i: Instant): Long = ChronoUnit.DAYS.between(i.atZone(zone).toLocalDate(), LocalDate.now(zone))

/** 4:05 PM */
fun clock(iso: String?): String = instant(iso)?.atZone(zone)?.format(timeFmt).orEmpty()

fun clock(ms: Long): String = Instant.ofEpochMilli(ms).atZone(zone).format(timeFmt)

/** For list rows: 4:05 PM, Yesterday, Tue, 12 Oct. */
fun listStamp(iso: String?): String {
    val i = instant(iso) ?: return ""
    val ago = daysAgo(i)
    val d = i.atZone(zone)
    return when {
        ago == 0L -> d.format(timeFmt)
        ago == 1L -> "Yesterday"
        ago < 7 -> d.format(weekdayFmt)
        else -> d.format(dayMonthFmt)
    }
}

/** Day separators: Today, Yesterday, Tuesday, 12 October. */
fun dayLabel(iso: String?): String {
    val i = instant(iso) ?: return ""
    return when (daysAgo(i)) {
        0L -> "Today"
        1L -> "Yesterday"
        else -> i.atZone(zone).format(fullFmt)
    }
}

fun sameDay(a: String?, b: String?): Boolean {
    val x = instant(a) ?: return false
    val y = instant(b) ?: return false
    return x.atZone(zone).toLocalDate() == y.atZone(zone).toLocalDate()
}

/** "today", "yesterday", "12 Oct". */
fun shortDay(iso: String?): String {
    val i = instant(iso) ?: return ""
    return when (daysAgo(i)) {
        0L -> "today"
        1L -> "yesterday"
        else -> i.atZone(zone).format(dayMonthFmt)
    }
}

fun lastSeen(iso: String?): String {
    val i = instant(iso) ?: return "Offline"
    val mins = ChronoUnit.MINUTES.between(i, Instant.now())
    if (mins < 1) return "Last seen just now"
    if (mins < 60) return "Last seen $mins min ago"
    val d = i.atZone(zone)
    return when (daysAgo(i)) {
        0L -> "Last seen today at ${d.format(timeFmt)}"
        1L -> "Last seen yesterday at ${d.format(timeFmt)}"
        else -> "Last seen ${d.format(dayMonthFmt)}"
    }
}

/** m:ss (h:mm:ss past an hour). */
fun duration(totalSeconds: Double): String {
    val s = maxOf(0, totalSeconds.toLong())
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = (s % 60).toString().padStart(2, '0')
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$sec" else "$m:$sec"
}

fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = listOf("B", "KB", "MB", "GB")
    var n = bytes.toDouble()
    var i = 0
    while (n >= 1024 && i < units.size - 1) {
        n /= 1024
        i++
    }
    val text = if (n >= 100 || i == 0) n.toLong().toString() else String.format(Locale.US, "%.1f", n).removeSuffix(".0")
    return "$text ${units[i]}"
}

fun attachmentLabel(kind: String, name: String, seconds: Double?): String = when (kind) {
    "image" -> "Photo"
    "video" -> "Video"
    "voice" -> if (seconds != null && seconds > 0) "Voice message ${duration(seconds)}" else "Voice message"
    else -> name
}

fun attachmentLabel(a: Attachment) = attachmentLabel(a.kind, a.name, a.duration)
fun attachmentLabel(a: ReplyAttachment) = attachmentLabel(a.kind, a.name, a.duration)

/** The marker where a message was deleted for everyone. */
fun deletedText(mine: Boolean, byAdmin: Boolean = false) = when {
    mine && !byAdmin -> "You deleted this message"
    byAdmin -> "This message was deleted by an admin"
    else -> "This message was deleted"
}

/** One line for a list: the text, or what was sent. */
fun messagePreview(m: Message, mine: Boolean): String = when {
    m.isDeleted -> deletedText(mine, m.deletedByAdmin)
    m.body.isNotEmpty() -> m.body.replace('\n', ' ')
    m.attachment != null -> attachmentLabel(m.attachment)
    else -> ""
}
