package com.addakhana.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.addakhana.app.ui.theme.palette

/** A sheet from the bottom, as the web app's on phones (rounded 28 at the top). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppSheet(onDismiss: () -> Unit, title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val p = palette
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
        contentColor = p.ink,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        scrimColor = Color(0x8C060816),
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(bottom = 12.dp)) {
            if (title != null) {
                Text(title, color = p.ink, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            }
            content()
        }
    }
}

/** One choice in a sheet: an icon and a label (red for things that can't be undone). */
@Composable
fun SheetItem(icon: ImageVector, label: String, onClick: () -> Unit, danger: Boolean = false, enabled: Boolean = true) {
    val p = palette
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val c = if (danger) p.danger else p.ink
        Icon(icon, null, tint = if (enabled) c else c.copy(alpha = 0.4f), modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(16.dp))
        Text(label, color = if (enabled) c else c.copy(alpha = 0.4f), fontSize = 15.5.sp)
    }
}

/** A dialog card: a title, a line of text, whatever else, then buttons. */
@Composable
fun AppDialog(
    onDismiss: () -> Unit,
    title: String,
    text: String? = null,
    buttons: @Composable ColumnScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val p = palette
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier
                .padding(20.dp)
                .widthIn(max = 460.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(28.dp))
                .background(p.surface)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(22.dp),
        ) {
            Text(title, color = p.ink, fontSize = 21.sp, fontWeight = FontWeight.SemiBold)
            if (text != null) {
                Spacer(Modifier.height(8.dp))
                Text(text, color = p.inkSoft, fontSize = 14.5.sp)
            }
            Spacer(Modifier.height(16.dp))
            content()
            Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { buttons() }
        }
    }
}

/** "Are you sure?": a dangerous action and a way out. */
@Composable
fun ConfirmDialog(title: String, text: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit, cancel: String = "Cancel", danger: Boolean = true) {
    AppDialog(onDismiss, title, text, buttons = {
        AddaButton(confirm, { onConfirm(); onDismiss() }, Modifier.fillMaxWidth(), variant = if (danger) Variant.Danger else Variant.Primary)
        AddaButton(cancel, onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    })
}
