package com.addakhana.app.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.net.Connection
import com.addakhana.app.ui.components.Spinner
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.delay

/** A list's title, with the connection's state under it when it isn't connected (after a moment). */
@Composable
fun ListHeader(title: String, actions: @Composable () -> Unit = {}) {
    val p = palette
    val connection by Graph.realtime.state.collectAsState()
    var showState by remember { mutableStateOf(false) }
    LaunchedEffect(connection) {
        showState = false
        if (connection !is Connection.Online) {
            delay(1_500)
            showState = true
        }
    }
    Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 64.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp), color = p.ink)
            if (showState && connection !is Connection.Online) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Spinner(size = 12.dp, color = p.inkSoft)
                    Spacer(Modifier.width(6.dp))
                    Text(if (connection is Connection.Offline) "Waiting for network…" else "Connecting…", color = p.inkSoft, fontSize = 13.sp)
                }
            }
        }
        actions()
    }
}

/** The search box above a list. */
@Composable
fun ListSearch(value: String, onChange: (String) -> Unit, placeholder: String) {
    val p = palette
    var focused by remember { mutableStateOf(false) }
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (focused) p.surface else p.subtle.copy(alpha = 0.6f))
            .border(1.dp, if (focused) p.brand else p.line.copy(alpha = 0.7f), RoundedCornerShape(16.dp))
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.Search, null, tint = p.inkSoft, modifier = Modifier.size(19.dp))
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(placeholder, color = p.inkSoft, fontSize = 15.sp)
            BasicTextField(
                value,
                onChange,
                singleLine = true,
                textStyle = TextStyle(color = p.ink, fontSize = 15.sp),
                cursorBrush = SolidColor(p.brand),
                modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
            )
        }
    }
}

/** The round button at the bottom right of a list (phones). */
@Composable
fun BoxScope.Fab(icon: ImageVector, label: String, onClick: () -> Unit) {
    val p = palette
    Box(
        Modifier
            .align(Alignment.BottomEnd)
            .padding(16.dp)
            .size(56.dp)
            .shadow(14.dp, RoundedCornerShape(16.dp), ambientColor = p.brand, spotColor = p.brand)
            .clip(RoundedCornerShape(16.dp))
            .background(p.aurora)
            .clickable(onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = p.onBrand, modifier = Modifier.size(24.dp))
    }
}
