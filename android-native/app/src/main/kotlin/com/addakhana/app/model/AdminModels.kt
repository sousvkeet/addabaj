package com.addakhana.app.model

import kotlinx.serialization.Serializable

// The host admin's pages (server/src/routes/admin.js), as the web client
// reads them (client/src/pages/admin/shared.tsx and each page's own types).

/** A page of a longer list (people, rooms): these items, and how many there are in all. */
@Serializable
data class Paged<T>(val items: List<T> = emptyList(), val total: Int = 0)

// ── Overview ──────────────────────────────────────────────────────────

@Serializable
data class OverviewUsers(val total: Int = 0, val newThisWeek: Int = 0, val disabled: Int = 0, val admins: Int = 0, val online: Int = 0)

@Serializable
data class OverviewRooms(val total: Int = 0, val activeToday: Int = 0, val watching: Int = 0)

@Serializable
data class OverviewMessages(val total: Int = 0, val today: Int = 0)

@Serializable
data class OverviewFiles(val count: Int = 0, val bytes: Long = 0)

@Serializable
data class OverviewNow(val calls: Int = 0, val inVoice: Int = 0, val liveStreams: Int = 0)

/** One of the last 14 days ("2025-10-12"). */
@Serializable
data class OverviewDay(val day: String, val signups: Int = 0, val messages: Int = 0)

/** Seconds up, bytes of memory, and the Node.js version ("v22.11.0"). */
@Serializable
data class ServerInfo(val uptime: Long = 0, val memory: Long = 0, val node: String = "")

@Serializable
data class OpenReports(val open: Int = 0)

@Serializable
data class YtDlpTool(val version: String? = null, val fix: String = "")

@Serializable
data class FfmpegTool(val installed: Boolean = false, val fix: String = "")

@Serializable
data class BrowserTool(val enabled: Boolean = false, val checked: Boolean = false, val ok: Boolean = false, val problem: String? = null, val fix: String = "")

@Serializable
data class AdBlockTool(val enabled: Boolean = false, val ready: Boolean = false, val rules: Int = 0, val updatedAt: String? = null, val error: String? = null)

/** What "Find videos" can use on this server. */
@Serializable
data class VideoTools(val ytdlp: YtDlpTool = YtDlpTool(), val ffmpeg: FfmpegTool = FfmpegTool(), val browser: BrowserTool = BrowserTool(), val adBlock: AdBlockTool = AdBlockTool())

@Serializable
data class AdminOverview(
    val users: OverviewUsers = OverviewUsers(),
    val rooms: OverviewRooms = OverviewRooms(),
    val messages: OverviewMessages = OverviewMessages(),
    val files: OverviewFiles = OverviewFiles(),
    val now: OverviewNow = OverviewNow(),
    val days: List<OverviewDay> = emptyList(),
    val server: ServerInfo = ServerInfo(),
    val signupsOpen: Boolean = true,
    val reports: OpenReports? = null,
    val videoTools: VideoTools? = null,
)

// ── People and rooms ──────────────────────────────────────────────────

/** An account as the host sees it: with its email, standing and how much it's used. */
@Serializable
data class AdminUser(
    val id: String,
    val name: String,
    val hue: Int = 260,
    val handle: String? = null,
    val email: String = "",
    val photo: String? = null,
    val lastSeenAt: String? = null,
    val online: Boolean = false,
    val createdAt: String? = null,
    val siteAdmin: Boolean = false,
    /** Switched off: can't log in. */
    val disabled: Boolean = false,
    /** A host admin still on the default password. */
    val defaultPassword: Boolean = false,
    val rooms: Int = 0,
    val messages: Int = 0,
)

@Serializable
data class RoomOwner(val id: String, val name: String, val hue: Int = 260, val photo: String? = null)

@Serializable
data class AdminRoom(
    val id: String,
    val name: String,
    val photo: String? = null,
    val description: String = "",
    val maxMembers: Int = 0,
    val memberCount: Int = 0,
    val messages: Int = 0,
    val createdAt: String? = null,
    val lastActivityAt: String? = null,
    val owner: RoomOwner,
    /** The title of the video playing in it. */
    val watching: String? = null,
    /** What's playing is streamed live from someone's device. */
    val live: Boolean = false,
    val inVoice: Int = 0,
)

@Serializable
data class PeopleRoom(val id: String, val name: String, val maxMembers: Int = 0, val memberCount: Int = 0, val ownerId: String = "")

@Serializable
data class HostMember(
    val id: String,
    val name: String,
    val hue: Int = 260,
    val handle: String? = null,
    val email: String = "",
    val photo: String? = null,
    /** admin or member */
    val role: String = "member",
    /** Started the room. */
    val owner: Boolean = false,
    val joinedAt: String = "",
)

/** A room's people, for the host: who's in it and how many seats it has. */
@Serializable
data class RoomPeople(val room: PeopleRoom, val members: List<HostMember> = emptyList())

// ── Reports ───────────────────────────────────────────────────────────

@Serializable
data class ReportPerson(val id: String, val name: String = "", val handle: String? = null)

/** The person reported: as their account is now, or (`gone`) as it was when it was removed. */
@Serializable
data class ReportTarget(
    val id: String,
    val name: String = "",
    val handle: String? = null,
    val email: String = "",
    val disabled: Boolean = false,
    /** Reports about them in all. */
    val reports: Int = 0,
    val gone: Boolean = false,
)

@Serializable
data class ReportRoom(val id: String, val name: String? = null)

/** image, video, voice or file */
@Serializable
data class KeptFile(val id: String, val kind: String = "file", val name: String = "")

/** A message as it was when the report was made. */
@Serializable
data class KeptMessage(
    val id: Long,
    val senderId: String? = null,
    val senderName: String? = null,
    /** text, call or system */
    val kind: String = "text",
    val body: String = "",
    val file: KeptFile? = null,
    val createdAt: String = "",
    val editedAt: String? = null,
    val deletedAt: String? = null,
    val forwarded: Boolean = false,
)

@Serializable
data class KeptEdit(val body: String, val editedAt: String)

@Serializable
data class AdminReport(
    val id: String,
    /** user (a person), dm (a message in a one-to-one chat) or room (a message in a room) */
    val scope: String,
    /** spam, harassment, inappropriate, impersonation or other */
    val reason: String = "other",
    val details: String? = null,
    /** open, resolved or dismissed */
    val status: String = "open",
    /** What the host did about it: deleted-message, switched-off. */
    val actions: List<String> = emptyList(),
    val createdAt: String = "",
    val handledAt: String? = null,
    val handledBy: String? = null,
    val messageId: Long? = null,
    val room: ReportRoom? = null,
    val reporter: ReportPerson? = null,
    val target: ReportTarget? = null,
    /** The reported message and up to 10 before it; for a person, the end of the reporter's chat with them. */
    val messages: List<KeptMessage> = emptyList(),
    /** What the reported message said before each edit, oldest first. */
    val edits: List<KeptEdit> = emptyList(),
    /** Whether the reported message is deleted now (null: not about a message). */
    val messageDeleted: Boolean? = null,
)

@Serializable
data class ReportList(val reports: List<AdminReport> = emptyList(), val hasMore: Boolean = false, val open: Int = 0)

// ── Settings ──────────────────────────────────────────────────────────

@Serializable
data class SiteSettings(val allowSignups: Boolean = true, val announcement: Announcement? = null)

/** The mail server Adda Khana sends codes through. The password itself never comes back. */
@Serializable
data class EmailSettings(
    val enabled: Boolean = false,
    val host: String = "",
    val port: Int = 587,
    /** starttls, tls or none */
    val security: String = "starttls",
    val user: String = "",
    val from: String = "",
    val verifySignups: Boolean = true,
    /** A password is saved. */
    val passwordSet: Boolean = false,
    /** Where these came from: admin (this page) or env (server/.env). */
    val source: String? = null,
    val envAvailable: Boolean = false,
    val ready: Boolean = false,
)

/** A version of the Android app, as the host's App updates page lists it. */
@Serializable
data class AdminRelease(
    val versionCode: Int,
    val versionName: String,
    val notes: String = "",
    val mandatory: Boolean = false,
    val size: Long = 0,
    val sha256: String = "",
    val minSdk: Int? = null,
    val publishedAt: String? = null,
    /** The signing certificate's SHA-256 ("AB:CD:…"). */
    val certSha256: String? = null,
    val uploadedBy: String? = null,
)
