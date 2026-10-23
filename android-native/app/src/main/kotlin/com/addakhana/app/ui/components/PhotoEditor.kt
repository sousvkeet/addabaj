package com.addakhana.app.ui.components

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val OUT = 512
private const val MAX_ZOOM = 4f

/** A photo from the phone, upright (its EXIF rotation applied) and no bigger than needed. */
fun loadPhoto(context: Context, uri: Uri, maxSide: Int = 2048): Bitmap? = runCatching {
    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val rotation = runCatching { androidx.exifinterface.media.ExifInterface(bytes.inputStream()).rotationDegrees }.getOrDefault(0)
    if (rotation == 0) src else Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
}.getOrNull()

/** Where the photo sits in the frame: zoom (1 fills it) and how far it's moved from the middle, in frame pixels. */
private data class View(val zoom: Float = 1f, val x: Float = 0f, val y: Float = 0f)

/**
 * Fit a photo in its frame before it's used: drag to move it, pinch (or the
 * slider and buttons) to zoom. The result is a 512-pixel square JPEG, as the
 * web app sends. `room`: a room's photo (a rounded square), else mine (a circle).
 */
@Composable
fun PhotoEditor(uri: Uri, room: Boolean, onUse: suspend (ByteArray) -> Unit, onAnother: () -> Unit, onDismiss: () -> Unit) {
    val p = palette
    val context = LocalContext.current
    val co = rememberCoroutineScope()
    var photo by remember(uri) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(uri) { mutableStateOf(false) }
    var view by remember(uri) { mutableStateOf(View()) }
    var frame by remember { mutableStateOf(IntSize.Zero) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(uri) {
        val b = withContext(Dispatchers.IO) { loadPhoto(context, uri) }
        if (b == null) failed = true else photo = b
    }
    val img = photo
    // The scale at which the photo just covers the frame.
    val base = if (img != null && frame.width > 0) max(frame.width.toFloat() / img.width, frame.height.toFloat() / img.height) else 1f

    fun fit(v: View): View {
        val b = img ?: return v
        val zoom = v.zoom.coerceIn(1f, MAX_ZOOM)
        val scale = base * zoom
        val maxX = max(0f, (b.width * scale - frame.width) / 2)
        val maxY = max(0f, (b.height * scale - frame.height) / 2)
        return View(zoom, v.x.coerceIn(-maxX, maxX), v.y.coerceIn(-maxY, maxY))
    }

    fun zoomTo(zoom: Float) {
        val z = zoom.coerceIn(1f, MAX_ZOOM)
        view = fit(View(z, view.x * (z / view.zoom), view.y * (z / view.zoom)))
    }

    fun save() {
        val b = img ?: return
        busy = true
        error = null
        co.launch {
            try {
                val jpeg = withContext(Dispatchers.Default) {
                    // The frame's square, in the photo's own pixels.
                    val scale = base * view.zoom
                    val side = frame.width / scale
                    val left = (b.width / 2f) - (frame.width / 2f + view.x) / scale
                    val top = (b.height / 2f) - (frame.height / 2f + view.y) / scale
                    val out = Bitmap.createBitmap(OUT, OUT, Bitmap.Config.ARGB_8888)
                    val canvas = android.graphics.Canvas(out)
                    canvas.drawColor(android.graphics.Color.WHITE)
                    val m = Matrix().apply {
                        postTranslate(-left, -top)
                        postScale(OUT / side, OUT / side)
                    }
                    canvas.drawBitmap(b, m, android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
                    ByteArrayOutputStream().use { s ->
                        out.compress(Bitmap.CompressFormat.JPEG, 88, s)
                        s.toByteArray()
                    }
                }
                onUse(jpeg)
            } catch (e: Exception) {
                error = e.message ?: "Couldn't save the photo."
            } finally {
                busy = false
            }
        }
    }

    AppDialog(
        onDismiss = { if (!busy) onDismiss() },
        title = if (room) "Fit the room photo" else "Fit your photo",
        text = if (failed) "That photo couldn't be opened. Try another." else "Drag to move it, pinch to zoom.",
        buttons = {
            if (!failed) AddaButton("Use photo", { save() }, Modifier.fillMaxWidth(), loading = busy, enabled = img != null)
            AddaButton("Choose another", onAnother, Modifier.fillMaxWidth(), variant = Variant.Ghost, enabled = !busy)
        },
    ) {
        if (!failed) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .widthIn(max = 320.dp)
                    .aspectRatio(1f)
                    .align(Alignment.CenterHorizontally)
                    .clip(RoundedCornerShape(20.dp))
                    .background(Color.Black)
                    .onSizeChanged { frame = it }
                    .semantics { contentDescription = if (room) "The room photo, to fit in the frame" else "Your photo, to fit in the circle" }
                    .pointerInput(img, frame) {
                        detectTransformGestures { centroid, pan, zoomChange, _ ->
                            val z = (view.zoom * zoomChange).coerceIn(1f, MAX_ZOOM)
                            val k = z / view.zoom
                            // Zoom about the fingers, then move with them.
                            val cx = centroid.x - frame.width / 2f
                            val cy = centroid.y - frame.height / 2f
                            view = fit(View(z, (view.x - cx) * k + cx + pan.x, (view.y - cy) * k + cy + pan.y))
                        }
                    },
            ) {
                if (img != null) {
                    val bitmap = remember(img) { img.asImageBitmap() }
                    Canvas(Modifier.matchParentSize()) {
                        val scale = base * view.zoom
                        val w = img.width * scale
                        val h = img.height * scale
                        drawImage(
                            bitmap,
                            dstOffset = IntOffset(((size.width - w) / 2 + view.x).roundToInt(), ((size.height - h) / 2 + view.y).roundToInt()),
                            dstSize = IntSize(w.roundToInt(), h.roundToInt()),
                        )
                        // Outside the circle (or rounded square), dimmed.
                        val shape = Path().apply {
                            if (room) addRoundRect(androidx.compose.ui.geometry.RoundRect(0f, 0f, size.width, size.height, CornerRadius(size.width * 0.22f)))
                            else addOval(androidx.compose.ui.geometry.Rect(Offset.Zero, Size(size.width, size.height)))
                        }
                        clipPath(shape, ClipOp.Difference) { drawRect(Color.Black.copy(alpha = 0.55f)) }
                        if (room) drawRoundRect(Color.White.copy(alpha = 0.8f), cornerRadius = CornerRadius(size.width * 0.22f), style = Stroke(2.dp.toPx()))
                        else drawCircle(Color.White.copy(alpha = 0.8f), radius = min(size.width, size.height) / 2 - 1.dp.toPx(), style = Stroke(2.dp.toPx()))
                    }
                } else Box(Modifier.matchParentSize(), contentAlignment = Alignment.Center) { Spinner(color = Color.White) }
            }
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBtn(Icons.Rounded.Remove, "Zoom out", { zoomTo(view.zoom / 1.2f) }, size = 40.dp, enabled = view.zoom > 1f)
                Slider(
                    value = view.zoom,
                    onValueChange = { zoomTo(it) },
                    valueRange = 1f..MAX_ZOOM,
                    colors = SliderDefaults.colors(thumbColor = p.brand, activeTrackColor = p.brand, inactiveTrackColor = p.line),
                    modifier = Modifier.weight(1f).semantics { contentDescription = "Zoom" },
                )
                IconBtn(Icons.Rounded.Add, "Zoom in", { zoomTo(view.zoom * 1.2f) }, size = 40.dp, enabled = view.zoom < MAX_ZOOM)
            }
            error?.let { Text(it, color = p.danger, fontSize = 14.sp) }
        }
    }
}
