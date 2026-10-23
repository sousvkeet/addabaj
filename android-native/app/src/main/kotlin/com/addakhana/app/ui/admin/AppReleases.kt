package com.addakhana.app.ui.admin

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Android
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material.icons.rounded.UploadFile
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.Toasts
import com.addakhana.app.model.AdminRelease
import com.addakhana.app.net.ApiError
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.AppDialog
import com.addakhana.app.ui.components.ConfirmDialog
import com.addakhana.app.ui.components.Field
import com.addakhana.app.ui.components.IconBtn
import com.addakhana.app.ui.components.Variant
import com.addakhana.app.ui.formatBytes
import com.addakhana.app.ui.theme.palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.FileNotFoundException
import java.io.IOException

private const val APK = "application/vnd.android.package-archive"

/** An app file picked on this phone: sent straight from where it is. `size` is -1 when the phone can't say. */
private class Picked(val uri: Uri, val name: String, val size: Long)

private fun picked(context: Context, uri: Uri): Picked? = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) Picked(uri, c.getString(0) ?: "app.apk", if (c.isNull(1)) -1 else c.getLong(1)) else null
    }
}.getOrNull()

/** Host admin: new versions of the Android app. Phones offer the newest when they open; mandatory ones must be installed. */
@Composable
internal fun AppUpdatesPage() {
    val p = palette
    val context = LocalContext.current
    val co = rememberCoroutineScope()
    var releases by remember { mutableStateOf<List<AdminRelease>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var file by remember { mutableStateOf<Picked?>(null) }
    var notes by remember { mutableStateOf("") }
    var mandatory by remember { mutableStateOf(false) }
    // Percent sent while uploading.
    var uploading by remember { mutableStateOf<Int?>(null) }
    var uploadError by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<AdminRelease?>(null) }
    var removing by remember { mutableStateOf<AdminRelease?>(null) }

    // Some file apps call an APK just "a file", so those can be picked too (the server checks it really is this app).
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val chosen = picked(context, uri)
        file = chosen
        uploadError = if (chosen == null) "Couldn't read that file." else null
    }

    LaunchedEffect(Unit) {
        attempt { Graph.api.releases() }.onSuccess { releases = it }.onFailure { error = reason(it) }
    }

    // The upload is the page's to wait for (it shows how far it's got); leaving the page stops it.
    fun submit() {
        val f = file ?: run {
            uploadError = "Choose the app file (.apk) first."
            return
        }
        uploadError = null
        uploading = 0
        co.launch {
            try {
                val release = Graph.api.uploadRelease(
                    { context.contentResolver.openInputStream(f.uri) ?: throw FileNotFoundException("Couldn't read that file.") },
                    f.size,
                    notes.trim(),
                    mandatory,
                ) { uploading = it }
                releases = listOf(release) + releases.orEmpty()
                file = null
                notes = ""
                mandatory = false
                Toasts.show("Version ${release.versionName} is out. Phones offer it the next time the app opens.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                uploadError = reason(e)
            } catch (e: FileNotFoundException) {
                uploadError = reason(e)
            } catch (e: IOException) {
                uploadError = "Can't reach the server. Check your connection and try again."
            } finally {
                uploading = null
            }
        }
    }

    // These go on in the app's scope, whatever happens to the page.
    fun setMandatory(r: AdminRelease, on: Boolean) = Graph.scope.launch {
        attempt { Graph.api.updateRelease(r.versionCode, mandatory = on) }
            .onSuccess {
                releases = it
                Toasts.show(if (on) "Version ${r.versionName} is now required: older apps must update." else "Version ${r.versionName} is optional now.")
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    fun remove(r: AdminRelease) = Graph.scope.launch {
        attempt { Graph.api.deleteRelease(r.versionCode) }
            .onSuccess {
                releases = it
                Toasts.show("Version ${r.versionName} was removed.")
            }
            .onFailure { Toasts.error(reason(it)) }
    }

    val latest = releases?.firstOrNull()
    AdminPage("App updates", latest?.let { "Latest: ${it.versionName}" } ?: "New versions of the Android app") {
        Panel(
            title = "Upload a new version",
            hint = "Build it with ./gradlew assembleRelease after raising versionCode. Every copy of the app offers it the next time it opens, then downloads and installs it.",
        ) {
            AddaButton(
                "App file (.apk)",
                { pick.launch(arrayOf(APK, "application/octet-stream")) },
                Modifier.fillMaxWidth(),
                variant = Variant.Soft,
                icon = Icons.Rounded.Android,
                enabled = uploading == null,
            )
            file?.let { f ->
                Text(
                    if (f.size >= 0) "${f.name}, ${formatBytes(f.size)}" else f.name,
                    color = p.inkSoft,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
            Spacer(Modifier.height(14.dp))
            Field(notes, { notes = it }, placeholder = "Optional. Shown on the update screen.", label = "What's new", singleLine = false, maxLength = 2000)
            Spacer(Modifier.height(14.dp))
            ToggleRow(
                "Make it mandatory",
                mandatory,
                { mandatory = it },
                hint = "Older apps can't be used until they update. They see the update screen, with no way to put it off, every time they open.",
                enabled = uploading == null,
            )
            uploadError?.let {
                Text(
                    it,
                    color = p.danger,
                    fontSize = 14.sp,
                    modifier = Modifier.padding(top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.danger.copy(alpha = 0.1f)).padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
            Spacer(Modifier.height(14.dp))
            AddaButton(
                uploading?.let { "Uploading $it%" } ?: "Upload and publish",
                { submit() },
                Modifier.fillMaxWidth(),
                icon = Icons.Rounded.UploadFile,
                loading = uploading != null,
            )
        }

        error?.let { ErrorBox(it) }

        Panel(title = "Versions", hint = "Phones are offered the newest. Any version made mandatory has to be installed before the app can be used.") {
            val list = releases
            when {
                list == null -> if (error == null) Loading()
                list.isEmpty() -> Text(
                    "No versions uploaded yet. Phones won't be offered updates until you upload one.",
                    color = p.inkSoft,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
                )
                else -> list.forEachIndexed { i, r ->
                    if (i > 0) HorizontalDivider(color = p.line.copy(alpha = 0.7f))
                    ReleaseRow(r, latest = i == 0, onMandatory = { setMandatory(r, it) }, onEdit = { editing = r }, onRemove = { removing = r })
                }
            }
        }
    }

    editing?.let { r -> NotesDialog(r, onSaved = { releases = it }) { editing = null } }
    removing?.let { r ->
        ConfirmDialog(
            "Remove version ${r.versionName}?",
            "Phones stop being offered it. Phones that already installed it keep it; if it's the newest, they're offered the one before it.",
            "Remove",
            onConfirm = { remove(r) },
            onDismiss = { removing = null },
        )
    }
}

@Composable
private fun ReleaseRow(r: AdminRelease, latest: Boolean, onMandatory: (Boolean) -> Unit, onEdit: () -> Unit, onRemove: () -> Unit) {
    val p = palette
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(16.dp)).background(p.subtle), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Smartphone, null, tint = if (p.dark) p.live else p.brand, modifier = Modifier.size(19.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Version ${r.versionName}", color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    Text("code ${r.versionCode}", color = p.inkSoft, fontSize = 12.5.sp, modifier = Modifier.align(Alignment.CenterVertically))
                    if (latest) Chip("Latest", Tone.Live)
                    if (r.mandatory) Chip("Mandatory", Tone.Danger)
                }
                Text(
                    "${formatBytes(r.size)} · ${shortDate(r.publishedAt)}" + (r.uploadedBy?.let { " · by $it" } ?: ""),
                    color = p.inkSoft,
                    fontSize = 13.sp,
                )
                if (r.notes.isNotEmpty()) Text(r.notes, color = p.ink, fontSize = 13.5.sp, modifier = Modifier.padding(top = 4.dp))
                r.certSha256?.let {
                    Text("Signed by $it", color = p.inkSoft, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = 40.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clickable { onMandatory(!r.mandatory) }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(r.mandatory, onMandatory, colors = CheckboxDefaults.colors(checkedColor = p.brand, uncheckedColor = p.inkSoft))
                Text("Mandatory", color = p.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
            IconBtn(Icons.Rounded.Edit, "Edit what's new in version ${r.versionName}", onEdit, size = 40.dp, tint = p.inkSoft)
            IconBtn(Icons.Rounded.Delete, "Remove version ${r.versionName}", onRemove, size = 40.dp, tint = p.inkSoft)
        }
    }
}

/** What's new in a version, as its update screen shows it. */
@Composable
private fun NotesDialog(r: AdminRelease, onSaved: (List<AdminRelease>) -> Unit, onDismiss: () -> Unit) {
    val p = palette
    var notes by remember { mutableStateOf(r.notes) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AppDialog(onDismiss, "Version ${r.versionName}", buttons = {
        AddaButton("Save", {
            busy = true
            error = null
            // On even if the dialog is closed meanwhile: the list follows when it's saved.
            Graph.scope.launch {
                attempt { Graph.api.updateRelease(r.versionCode, notes = notes.trim()) }
                    .onSuccess {
                        onSaved(it)
                        Toasts.show("The notes for version ${r.versionName} were saved.")
                        onDismiss()
                    }
                    .onFailure { error = reason(it) }
                busy = false
            }
        }, Modifier.fillMaxWidth(), loading = busy, enabled = notes.trim() != r.notes)
        AddaButton("Cancel", onDismiss, Modifier.fillMaxWidth(), variant = Variant.Ghost)
    }) {
        Field(notes, { notes = it }, placeholder = "Optional. Shown on the update screen.", label = "What's new", singleLine = false, maxLength = 2000)
        error?.let { Text(it, color = p.danger, fontSize = 13.5.sp, modifier = Modifier.padding(top = 8.dp)) }
    }
}
