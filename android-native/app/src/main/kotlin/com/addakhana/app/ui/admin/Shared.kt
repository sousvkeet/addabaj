package com.addakhana.app.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.AuthState
import com.addakhana.app.net.int
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.components.Toggle
import com.addakhana.app.ui.instant
import com.addakhana.app.ui.lastSeen
import com.addakhana.app.ui.theme.Palette
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// What the admin pages share (client/src/pages/admin/shared.tsx): the page
// frame, panels, chips, and how numbers and dates read.

/**
 * How many reports are waiting for the host admin (null until it's known),
 * for the menu's badge, the overview and the Reports page. The server tells
 * every host admin's app as reports come in and are handled.
 */
object ReportCount {
    private val _open = MutableStateFlow<Int?>(null)
    val open: StateFlow<Int?> = _open.asStateFlow()
    // Bumped whenever the count is set, so an older load can't overwrite a newer count.
    private var version = 0

    init {
        Graph.scope.launch {
            Graph.realtime.events.collect { e -> if (e.name == "admin:reports") e.obj.int("open")?.let { set(it) } }
        }
        // Someone else's count isn't mine.
        Graph.scope.launch {
            Graph.auth.state.collect {
                if (it !is AuthState.SignedIn) {
                    version++
                    _open.value = null
                }
            }
        }
    }

    fun set(open: Int) {
        version++
        _open.value = open
    }

    suspend fun load() {
        val asked = version
        // The count can wait if this fails.
        attempt { Graph.api.adminReports("open", 1).open }.onSuccess { if (asked == version) _open.value = it }
    }
}

/** Runs a request: its result, or what went wrong (a cancelled one stays cancelled). */
internal suspend fun <T> attempt(block: suspend () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.w("Admin", "request failed", e)
        Result.failure(e)
    }

internal fun reason(e: Throwable) = e.message ?: "That didn't work."

/** 1,234 */
internal fun num(n: Number): String = NumberFormat.getIntegerInstance().format(n)

/** 12 Oct 2025 (in this phone's language). */
internal fun shortDate(iso: String?): String =
    instant(iso)?.atZone(ZoneId.systemDefault())?.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.getDefault())).orEmpty()

/** "3d 4h", "5h 12m", "7m" */
internal fun uptime(seconds: Long): String {
    val d = seconds / 86_400
    val h = seconds % 86_400 / 3_600
    val m = seconds % 3_600 / 60
    return if (d > 0) "${d}d ${h}h" else if (h > 0) "${h}h ${m}m" else "${m}m"
}

/** "just now", "5 min ago", "today at 4:05 PM", "12 Oct". */
internal fun stamp(iso: String?): String = lastSeen(iso).replace("Last seen ", "")

/** Amber, for warnings (the default password). */
private val Amber = Color(0xFFFBBF24)
internal val Palette.warnInk: Color get() = if (dark) Color(0xFFFCD34D) else Color(0xFFB45309)
internal val Palette.warnBg: Color get() = Amber.copy(alpha = 0.12f)
internal val Palette.warnLine: Color get() = Amber.copy(alpha = 0.4f)

/** An admin page's header: back to the admin menu, the title and a line under it, and its buttons. */
@Composable
internal fun AdminHeader(title: String, subtitle: String?, onBack: () -> Unit = { Nav.back() }, actions: @Composable RowScope.() -> Unit = {}) {
    val p = palette
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(64.dp).padding(start = 4.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        IconBtn(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack)
        Column(Modifier.weight(1f).padding(start = 4.dp)) {
            Text(title, color = p.ink, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrEmpty()) Text(subtitle, color = p.inkSoft, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        actions()
    }
}

/** A page of the admin area: its header and a scrolling body. */
@Composable
internal fun AdminPage(title: String, subtitle: String?, actions: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(palette.canvas)) {
        AdminHeader(title, subtitle, actions = actions)
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

/** A rounded panel on an admin page. */
@Composable
internal fun Panel(
    modifier: Modifier = Modifier,
    title: String? = null,
    hint: String? = null,
    action: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = palette
    val shape = RoundedCornerShape(24.dp)
    Column(modifier.fillMaxWidth().clip(shape).background(p.surface).border(1.dp, p.line.copy(alpha = 0.7f), shape).padding(18.dp)) {
        if (title != null || hint != null || action != null) {
            Row(Modifier.fillMaxWidth().padding(bottom = 14.dp), verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    if (title != null) Text(title, color = p.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    if (hint != null) Text(hint, color = p.inkSoft, fontSize = 13.5.sp, modifier = Modifier.padding(top = 2.dp))
                }
                if (action != null) {
                    Spacer(Modifier.width(12.dp))
                    action()
                }
            }
        }
        content()
    }
}

internal enum class Tone { Brand, Danger, Live, Muted, Warn }

/** A small label on a person or room ("Host admin", "Switched off", "Live"). */
@Composable
internal fun Chip(text: String, tone: Tone, icon: ImageVector? = null) {
    val p = palette
    val (bg: Brush, fg: Color) = when (tone) {
        Tone.Brand -> p.aurora to Color.White
        Tone.Danger -> SolidColor(p.danger.copy(alpha = 0.15f)) to p.danger
        Tone.Live -> SolidColor(p.live.copy(alpha = 0.15f)) to p.liveInk
        Tone.Muted -> SolidColor(p.subtle) to p.inkSoft
        Tone.Warn -> SolidColor(Amber.copy(alpha = 0.15f)) to p.warnInk
    }
    Row(Modifier.clip(CircleShape).background(bg).padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, null, tint = fg, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(4.dp))
        }
        Text(text, color = fg, fontSize = 11.5.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

/** A request that failed, in red. */
@Composable
internal fun ErrorBox(text: String, modifier: Modifier = Modifier) {
    val p = palette
    val shape = RoundedCornerShape(16.dp)
    Text(
        text,
        color = p.danger,
        fontSize = 14.sp,
        modifier = modifier.fillMaxWidth().clip(shape).background(p.danger.copy(alpha = 0.1f)).border(1.dp, p.danger.copy(alpha = 0.3f), shape).padding(horizontal = 16.dp, vertical = 12.dp),
    )
}

/** Waiting for a page's first answer. */
@Composable
internal fun Loading(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(vertical = 64.dp), contentAlignment = Alignment.Center) { Spinner(color = palette.inkSoft) }
}

/** Nothing to list: a line in a dashed box. */
@Composable
internal fun EmptyBox(text: String, icon: ImageVector? = null) {
    val p = palette
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind {
                drawRoundRect(
                    p.line,
                    cornerRadius = CornerRadius(24.dp.toPx()),
                    style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
                )
            }
            .padding(horizontal = 24.dp, vertical = 44.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = p.inkSoft.copy(alpha = 0.6f), modifier = Modifier.size(22.dp))
            Spacer(Modifier.height(8.dp))
        }
        Text(text, color = p.inkSoft, fontSize = 14.5.sp, textAlign = TextAlign.Center)
    }
}

/** An on/off switch with its label and an explanation. */
@Composable
internal fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, hint: String? = null, enabled: Boolean = true) {
    val p = palette
    Row(Modifier.fillMaxWidth().alpha(if (enabled) 1f else 0.6f).clickable(enabled = enabled) { onChange(!checked) }, verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Text(label, color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            if (hint != null) Text(hint, color = p.inkSoft, fontSize = 13.5.sp, modifier = Modifier.padding(top = 2.dp))
        }
        Spacer(Modifier.width(16.dp))
        Toggle(checked, { if (enabled) onChange(it) }, Modifier.padding(top = 2.dp))
    }
}

/** One of a few choices (a filter, a time), as the app's chips; greyed out when it can't be changed now. */
@Composable
internal fun Option(label: String, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val p = palette
    val shape = RoundedCornerShape(12.dp)
    Text(
        label,
        color = if (selected) p.brand else p.ink,
        fontSize = 13.5.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .alpha(if (enabled) 1f else 0.5f)
            .clip(shape)
            .border(1.dp, if (selected) p.brand else p.line, shape)
            .background(if (selected) p.brand.copy(alpha = 0.12f) else p.surface)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

/** A label over a value ("Joined", "12 Oct 2025"). */
@Composable
internal fun Fact(label: String, modifier: Modifier = Modifier, value: @Composable () -> Unit) {
    Column(modifier) {
        Text(label, color = palette.inkSoft, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(2.dp))
        value()
    }
}

@Composable
internal fun FactText(text: String) = Text(text, color = palette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
