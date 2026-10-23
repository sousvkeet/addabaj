package com.addakhana.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.animation.core.animateFloat
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.addakhana.app.data.Toasts
import com.addakhana.app.net.appUrl
import com.addakhana.app.push.Avatars
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay

/** hsl(h s% l%), as the web app's CSS. */
fun hsl(h: Float, s: Float, l: Float, alpha: Float = 1f): Color = Color.hsl(((h % 360) + 360) % 360, s, l, alpha)

/** A room's colour, from its id (h = (h*31 + char) % 360, as the web app). */
fun hueFromId(id: String): Int {
    var h = 0
    for (ch in id) h = (h * 31 + ch.code) % 360
    return h
}

/** A server address ("/api/…") as a full one. */
fun url(path: String?): String? = path?.let { if (it.startsWith("http")) it else appUrl + it }

/**
 * Someone's avatar: their photo, or initials on a gradient from their hue.
 * Rooms are rounded squares with one letter.
 */
@Composable
fun Avatar(
    name: String,
    hue: Int,
    photo: String?,
    size: Dp,
    modifier: Modifier = Modifier,
    online: Boolean = false,
    room: Boolean = false,
    ring: Boolean = false,
) {
    val p = palette
    val shape: Shape = if (room) RoundedCornerShape(percent = 32) else CircleShape
    Box(modifier.size(size)) {
        Box(
            Modifier
                .size(size)
                .then(if (ring) Modifier.border(3.dp, p.live, shape) else Modifier)
                .padding(if (ring) 3.dp else 0.dp)
                .clip(shape)
                .background(Brush.linearGradient(listOf(hsl(hue.toFloat(), 0.78f, 0.62f), hsl(hue + 48f, 0.72f, 0.48f)))),
            contentAlignment = Alignment.Center,
        ) {
            val label = if (room) name.trim().take(1).uppercase() else Avatars.initials(name)
            Text(
                label,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * if (room) 0.44f else 0.36f).sp,
                maxLines = 1,
            )
            if (photo != null) {
                AsyncImage(model = url(photo), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
            }
        }
        if (online) {
            val dot = maxOf(10f, size.value * 0.26f).dp
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(dot)
                    .clip(CircleShape)
                    .background(p.surface)
                    .padding(2.dp)
                    .clip(CircleShape)
                    .background(p.live),
            )
        }
    }
}

enum class Variant { Primary, Live, Danger, DangerGhost, DangerSoft, Ghost, Outline, Soft, OnDark }

/** The web app's buttons: aurora primary, live, danger, ghost, outline, soft. Sizes sm 36, md 44, lg 48. */
@Composable
fun AddaButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: Variant = Variant.Primary,
    height: Dp = 44.dp,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
) {
    val p = palette
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val shape = RoundedCornerShape(if (height <= 36.dp) 12.dp else 16.dp)
    val (bg, fg, border) = when (variant) {
        Variant.Primary -> Triple<Brush?, Color, Color?>(p.aurora, p.onBrand, null)
        Variant.Live -> Triple(SolidColor(p.live), p.onLive, null)
        Variant.Danger -> Triple(SolidColor(p.danger), Color.White, null)
        Variant.DangerGhost -> Triple(null, p.danger, null)
        Variant.DangerSoft -> Triple(SolidColor(p.danger.copy(alpha = 0.1f)), p.danger, null)
        Variant.Ghost -> Triple(null, p.ink, null)
        Variant.Outline -> Triple(SolidColor(p.surface.copy(alpha = 0.4f)), p.ink, p.line)
        Variant.Soft -> Triple(SolidColor(p.subtle), p.ink, null)
        Variant.OnDark -> Triple(SolidColor(Color.White.copy(alpha = 0.1f)), p.onBrand, null)
    }
    Row(
        modifier
            .scale(if (pressed && enabled) 0.98f else 1f)
            .defaultMinSize(minHeight = height)
            .clip(shape)
            .then(if (bg != null) Modifier.background(bg) else Modifier)
            .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
            .clickable(interactionSource = source, indication = androidx.compose.material3.ripple(), enabled = enabled && !loading, onClick = onClick)
            .padding(horizontal = if (height <= 36.dp) 14.dp else 18.dp)
            .then(if (!enabled) Modifier.background(Color.Transparent) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        val alpha = if (enabled) 1f else 0.5f
        if (loading) {
            CircularProgressIndicator(Modifier.size(18.dp), color = fg, strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        } else if (icon != null) {
            Icon(icon, null, tint = fg.copy(alpha = alpha), modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, color = fg.copy(alpha = alpha), fontWeight = FontWeight.SemiBold, fontSize = if (height <= 36.dp) 13.5.sp else 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A round icon button (44 by default). */
@Composable
fun IconBtn(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    tint: Color = palette.ink,
    background: Brush? = null,
    enabled: Boolean = true,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    Box(
        modifier
            .size(size)
            .scale(if (pressed) 0.95f else 1f)
            .clip(CircleShape)
            .then(if (background != null) Modifier.background(background) else Modifier)
            .clickable(interactionSource = source, indication = androidx.compose.material3.ripple(), enabled = enabled, onClick = onClick, onClickLabel = label),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = if (enabled) tint else tint.copy(alpha = 0.4f), modifier = Modifier.size(size * 0.48f))
    }
}

/** A text field: 48 high, rounded 16, brand border when focused. */
@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    label: String? = null,
    password: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    singleLine: Boolean = true,
    maxLength: Int = Int.MAX_VALUE,
    imeAction: androidx.compose.ui.text.input.ImeAction = androidx.compose.ui.text.input.ImeAction.Default,
    onDone: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val p = palette
    var focused by remember { mutableStateOf(false) }
    Column(modifier) {
        if (label != null) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = p.ink, modifier = Modifier.padding(bottom = 6.dp))
        }
        Row(
            Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 48.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (focused) p.surface else p.subtle.copy(alpha = 0.6f))
                .border(1.dp, if (focused) p.brand else p.line, RoundedCornerShape(16.dp))
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f).padding(vertical = 12.dp)) {
                if (value.isEmpty()) Text(placeholder, color = p.inkSoft, fontSize = 15.sp)
                BasicTextField(
                    value = value,
                    onValueChange = { onChange(it.take(maxLength)) },
                    singleLine = singleLine,
                    textStyle = TextStyle(color = p.ink, fontSize = 15.sp),
                    cursorBrush = SolidColor(p.brand),
                    visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboard, imeAction = imeAction),
                    keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }, onGo = { onDone?.invoke() }, onSend = { onDone?.invoke() }),
                    modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label ?: placeholder },
                )
            }
            trailing?.invoke()
        }
    }
}

/** An unread count: aurora (grey when muted), "99+" past 99. */
@Composable
fun CountBadge(count: Int, muted: Boolean = false, modifier: Modifier = Modifier) {
    if (count <= 0) return
    val p = palette
    Box(
        modifier
            .defaultMinSize(minWidth = 22.dp, minHeight = 22.dp)
            .clip(CircleShape)
            .background(if (muted) SolidColor(p.inkSoft.copy(alpha = 0.25f)) else p.aurora)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (count > 99) "99+" else count.toString(), color = if (muted) p.ink else Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

/** A switch: aurora when on. */
@Composable
fun Toggle(checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val p = palette
    Box(
        modifier
            .size(48.dp, 28.dp)
            .clip(CircleShape)
            .background(if (checked) p.aurora else SolidColor(p.line))
            .clickable { onChange(!checked) }
            .padding(4.dp),
        contentAlignment = if (checked) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(Modifier.size(20.dp).clip(CircleShape).background(Color.White))
    }
}

/** The logo: the "A" and its dot, on the theme's gradient. */
@Composable
fun Logo(size: Dp, modifier: Modifier = Modifier) {
    val p = palette
    Canvas(modifier.size(size)) {
        val k = this.size.width / 64f
        scale(k, k, pivot = Offset.Zero) {
            drawRoundRect(Brush.linearGradient(listOf(p.logoA, p.logoB), Offset.Zero, Offset(64f, 64f)), size = Size(64f, 64f), cornerRadius = CornerRadius(18f))
            val a = Path().apply {
                moveTo(20f, 46f); lineTo(32f, 16f); lineTo(44f, 46f)
                moveTo(24.5f, 36f); lineTo(39.5f, 36f)
            }
            drawPath(a, Color.White, style = Stroke(width = 6f, cap = StrokeCap.Round, join = StrokeJoin.Round))
            drawCircle(p.logoDot, radius = 6f, center = Offset(49f, 15f))
            drawCircle(Color.White, radius = 6f, center = Offset(49f, 15f), style = Stroke(2.5f))
        }
    }
}

/** "Adda Khana", "Khana" in the aurora gradient. */
@Composable
fun Wordmark(size: Float = 22f) {
    val p = palette
    Row {
        Text("Adda", color = p.ink, fontSize = size.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width((size / 4).dp))
        Text("Khana", style = TextStyle(brush = p.auroraText, fontSize = size.sp, fontWeight = FontWeight.Bold))
    }
}

/** Short notes at the bottom of the screen; each goes by itself (errors stay a little longer). */
@Composable
fun BoxScope.ToastHost(bottom: Dp = 84.dp) {
    val p = palette
    val items by Toasts.items.collectAsState()
    Column(
        Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = bottom, start = 16.dp, end = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        for (t in items) {
            androidx.compose.runtime.key(t.id) {
                LaunchedEffect(t.id) {
                    delay(if (t.tone == Toasts.Tone.Error) 6_000 else 4_500)
                    Toasts.dismiss(t.id)
                }
                AnimatedVisibility(visible = true, enter = fadeIn() + slideInVertically { it / 2 }, exit = fadeOut() + slideOutVertically()) {
                    val (bg, fg) = when (t.tone) {
                        Toasts.Tone.Error -> p.danger to Color.White
                        Toasts.Tone.Live -> p.live to p.onLive
                        Toasts.Tone.Info -> p.deep.copy(alpha = 0.92f) to Color.White
                    }
                    Text(
                        t.text,
                        color = fg,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .widthIn(max = 480.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(bg)
                            .clickable { Toasts.dismiss(t.id) }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                }
            }
        }
    }
}

/** A section title in lists and settings. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), color = palette.inkSoft, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp, modifier = modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

/** A round icon tile (settings rows, empty states). */
@Composable
fun IconTile(icon: ImageVector, modifier: Modifier = Modifier, size: Dp = 40.dp, tint: Color = palette.brand, background: Color = palette.brand.copy(alpha = 0.15f)) {
    Box(modifier.size(size).clip(CircleShape).background(background), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

@Composable
fun Spinner(modifier: Modifier = Modifier, size: Dp = 22.dp, color: Color = palette.brand) =
    CircularProgressIndicator(modifier.size(size), color = color, strokeWidth = 2.dp)

/** Padding for screen content (16 at the sides). */
val ScreenPadding = PaddingValues(horizontal = 16.dp)

/** Empty states: an icon, a title and a line or two, maybe a button. */
@Composable
fun EmptyState(icon: ImageVector, title: String, text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val p = palette
    Column(modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        IconTile(icon, size = 64.dp)
        Spacer(Modifier.height(16.dp))
        Text(title, color = p.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(text, color = p.inkSoft, fontSize = 14.sp, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.height(18.dp))
            action()
        }
    }
}

/** A dot that shows something's live (a red one for streams). */
@Composable
fun Dot(color: Color, size: Dp = 8.dp, modifier: Modifier = Modifier) = Box(modifier.size(size).clip(CircleShape).background(color))


/** Three dots bouncing in turn: someone is typing. */
@Composable
fun TypingDots(color: Color, modifier: Modifier = Modifier) {
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "typing")
    val phase by t.animateFloat(
        0f,
        3f,
        androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(1_050, easing = androidx.compose.animation.core.LinearEasing)),
        label = "phase",
    )
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until 3) {
            // Each dot rises during its third of the cycle.
            val local = ((phase - i + 3) % 3f).coerceIn(0f, 1f)
            val lift = kotlin.math.sin(local * Math.PI).toFloat()
            Box(Modifier.offset(y = (-3 * lift).dp).size(5.dp).clip(CircleShape).background(color.copy(alpha = 0.5f + 0.5f * lift)))
        }
    }
}
