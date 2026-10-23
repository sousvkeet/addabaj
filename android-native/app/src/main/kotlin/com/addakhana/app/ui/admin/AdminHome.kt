package com.addakhana.app.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Dashboard
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Mail
import androidx.compose.material.icons.rounded.MeetingRoom
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.VerifiedUser
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.addakhana.app.Graph
import com.addakhana.app.data.AuthState
import com.addakhana.app.ui.Nav
import com.addakhana.app.ui.Screen
import com.addakhana.app.ui.components.AddaButton
import com.addakhana.app.ui.components.CountBadge
import com.addakhana.app.ui.home.PasswordDialog
import com.addakhana.app.ui.theme.palette

private class Item(val page: String, val label: String, val hint: String, val icon: ImageVector)

// The web app's admin menu; its Site settings page is three here (settings, messages, email), as phones show one panel at a time.
private val ITEMS = listOf(
    Item("overview", "Overview", "Activity at a glance", Icons.Rounded.Dashboard),
    Item("people", "People", "Accounts, roles and passwords", Icons.Rounded.Group),
    Item("rooms", "Rooms", "Every room on the site", Icons.Rounded.MeetingRoom),
    Item("reports", "Reports", "What people reported to you", Icons.Rounded.Flag),
    Item("settings", "Site settings", "Sign-ups, announcement and your admin login", Icons.Rounded.Tune),
    Item("messages", "Messages", "Link previews, editing and forwarding", Icons.Rounded.Forum),
    Item("email", "Email", "Codes for new accounts and forgotten passwords", Icons.Rounded.Mail),
    Item("app", "App updates", "New versions of the Android app", Icons.Rounded.Smartphone),
)

/** The admin area: its menu, or one of its pages. Only a host admin gets in. */
@Composable
fun AdminScreen(page: String) {
    val auth by Graph.auth.state.collectAsState()
    if ((auth as? AuthState.SignedIn)?.user?.siteAdmin != true) {
        // No longer a host admin (another admin changed that): out of the whole admin area.
        LaunchedEffect(Unit) {
            while (Nav.top is Screen.Admin) if (!Nav.back()) break
        }
        return
    }
    when (page) {
        "overview" -> OverviewPage()
        "people" -> PeoplePage()
        "rooms" -> RoomsPage()
        "reports" -> ReportsPage()
        "settings" -> SiteSettingsPage()
        "messages" -> MessagingPage()
        "email" -> EmailPage()
        "app" -> AppUpdatesPage()
        else -> AdminHome()
    }
}

/** The admin area's menu (client AdminNav). */
@Composable
private fun AdminHome() {
    val p = palette
    val auth by Graph.auth.state.collectAsState()
    val me = (auth as? AuthState.SignedIn)?.user ?: return
    val waiting by ReportCount.open.collectAsState()
    var changing by remember { mutableStateOf(false) }
    // Reports waiting, for the badge (kept up to date live after this).
    LaunchedEffect(Unit) { ReportCount.load() }

    Column(Modifier.fillMaxSize().background(p.canvas)) {
        AdminHeader("Admin", "Run Adda Khana")
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 24.dp)) {
            for (item in ITEMS) {
                Row(
                    Modifier.fillMaxWidth().clickable { Nav.push(Screen.Admin(item.page)) }.padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(16.dp)).background(p.subtle), contentAlignment = Alignment.Center) {
                        Icon(item.icon, null, tint = if (p.dark) p.live else p.brand, modifier = Modifier.size(20.dp))
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(item.label, color = p.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold)
                        Text(item.hint, color = p.inkSoft, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    val count = if (item.page == "reports") waiting ?: 0 else 0
                    if (count > 0) {
                        Spacer(Modifier.width(8.dp))
                        CountBadge(count)
                    }
                    Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = p.inkSoft)
                }
            }
            Spacer(Modifier.height(16.dp))
            if (me.mustChangePassword) {
                val shape = RoundedCornerShape(24.dp)
                Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(shape).background(p.warnBg).border(1.dp, p.warnLine, shape).padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Key, null, tint = p.warnInk, modifier = Modifier.size(17.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Default password in use", color = p.warnInk, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    }
                    Text("Anyone who knows it can run your site. Choose your own now.", color = p.inkSoft, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                    Spacer(Modifier.height(12.dp))
                    AddaButton("Change password", { changing = true }, Modifier.fillMaxWidth(), height = 36.dp)
                }
            } else {
                Row(
                    Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.subtle.copy(alpha = 0.6f)).padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.VerifiedUser, null, tint = if (p.dark) p.live else p.brand, modifier = Modifier.size(17.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Signed in as host admin ${me.name}", color = p.inkSoft, fontSize = 13.sp)
                }
            }
        }
    }
    if (changing) PasswordDialog(onDismiss = { changing = false })
}
