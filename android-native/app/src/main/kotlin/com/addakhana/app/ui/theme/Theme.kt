package com.addakhana.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** The web app's theme tokens (client/src/index.css): Midnight Aurora (dark, the default) and Ocean Mint (light). */
@Immutable
data class Palette(
    val dark: Boolean,
    val canvas: Color,
    val surface: Color,
    val subtle: Color,
    val line: Color,
    val ink: Color,
    val inkSoft: Color,
    val brand: Color,
    val brand2: Color,
    val onBrand: Color,
    val deep: Color,
    val live: Color,
    val onLive: Color,
    val liveInk: Color,
    val danger: Color,
    val tickRead: Color,
    val rail: Color,
    val railInk: Color,
    val railLine: Color,
    val logoA: Color,
    val logoB: Color,
    val logoDot: Color,
    /** Primary buttons, my bubbles, badges, the round button. */
    val aurora: Brush,
    /** Headline words. */
    val auroraText: Brush,
    val glowA: Color,
    val glowB: Color,
    val glowC: Color,
)

val Dark = Palette(
    dark = true,
    canvas = Color(0xFF090C1A),
    surface = Color(0xFF121730),
    subtle = Color(0xFF1A2042),
    line = Color(0xFF262E55),
    ink = Color(0xFFECEEFF),
    inkSoft = Color(0xFF9AA2C8),
    brand = Color(0xFF7C5CFF),
    brand2 = Color(0xFFFF5CA8),
    onBrand = Color.White,
    deep = Color(0xFF060814),
    live = Color(0xFF22D3EE),
    onLive = Color(0xFF03202A),
    liveInk = Color(0xFF22D3EE),
    danger = Color(0xFFFF4D6D),
    tickRead = Color(0xFF67E8F9),
    rail = Color(0xFF060814),
    railInk = Color.White,
    railLine = Color.White.copy(alpha = 0.10f),
    logoA = Color(0xFF7C5CFF),
    logoB = Color(0xFFFF5CA8),
    logoDot = Color(0xFF22D3EE),
    aurora = Brush.linearGradient(0f to Color(0xFF7C5CFF), 0.55f to Color(0xFFC25CCF), 1f to Color(0xFFFF5CA8)),
    auroraText = Brush.linearGradient(listOf(Color(0xFF7C5CFF), Color(0xFFFF5CA8))),
    glowA = Color(0x337C5CFF),
    glowB = Color(0x1FFF5CA8),
    glowC = Color(0x1422D3EE),
)

val Light = Palette(
    dark = false,
    canvas = Color(0xFFF4F8FB),
    surface = Color.White,
    subtle = Color(0xFFEAF1F6),
    line = Color(0xFFDBE5ED),
    ink = Color(0xFF0F1B2D),
    inkSoft = Color(0xFF5A6B80),
    brand = Color(0xFF0F766E),
    brand2 = Color(0xFF2563EB),
    onBrand = Color.White,
    deep = Color(0xFF0F1B2D),
    live = Color(0xFF10B981),
    onLive = Color(0xFF03281B),
    liveInk = Color(0xFF047857),
    danger = Color(0xFFE11D48),
    tickRead = Color(0xFFFDE047),
    rail = Color.White,
    railInk = Color(0xFF0F1B2D),
    railLine = Color(0xFFDBE5ED),
    logoA = Color(0xFF14B8A6),
    logoB = Color(0xFF3B82F6),
    logoDot = Color(0xFF34D399),
    aurora = Brush.linearGradient(0f to Color(0xFF0F8B82), 0.52f to Color(0xFF0E86B0), 1f to Color(0xFF2563EB)),
    auroraText = Brush.linearGradient(listOf(Color(0xFF0D9488), Color(0xFF2563EB))),
    glowA = Color(0x1214B8A6),
    glowB = Color(0x0F3B82F6),
    glowC = Color(0x0D10B981),
)

val LocalPalette = staticCompositionLocalOf { Dark }

/** The app's colours, wherever a composable needs them. */
val palette: Palette @Composable get() = LocalPalette.current

private val type = Typography(
    headlineMedium = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.02).em),
    titleLarge = TextStyle(fontSize = 21.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
    labelSmall = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.Medium),
)

/** Dark unless the person chose light (Settings › Dark theme); "system" follows the phone. */
@Composable
fun AddaTheme(choice: String = "dark", content: @Composable () -> Unit) {
    val dark = when (choice) {
        "light" -> false
        "system" -> isSystemInDarkTheme()
        else -> true
    }
    val p = if (dark) Dark else Light
    val scheme = if (dark) {
        darkColorScheme(
            primary = p.brand, onPrimary = p.onBrand, secondary = p.brand2, background = p.canvas, onBackground = p.ink,
            surface = p.surface, onSurface = p.ink, surfaceVariant = p.subtle, onSurfaceVariant = p.inkSoft, outline = p.line,
            error = p.danger, surfaceContainer = p.surface, surfaceContainerHigh = p.subtle, surfaceContainerLow = p.surface,
        )
    } else {
        lightColorScheme(
            primary = p.brand, onPrimary = p.onBrand, secondary = p.brand2, background = p.canvas, onBackground = p.ink,
            surface = p.surface, onSurface = p.ink, surfaceVariant = p.subtle, onSurfaceVariant = p.inkSoft, outline = p.line,
            error = p.danger, surfaceContainer = p.surface, surfaceContainerHigh = p.subtle, surfaceContainerLow = p.surface,
        )
    }
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, typography = type, content = content)
    }
}
