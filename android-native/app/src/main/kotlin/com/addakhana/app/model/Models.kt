package com.addakhana.app.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// What the server sends (see server/src/services/*.js), as the web client
// reads it (client/src/lib/types.ts). Times are ISO-8601 strings unless noted;
// message ids are numbers, with separate sequences for chats and rooms.

@Serializable
data class Privacy(val sharePresence: Boolean = true, val readReceipts: Boolean = true)

@Serializable
data class User(
    val id: String,
    val name: String,
    val hue: Int = 260,
    val handle: String? = null,
    /** Only on your own account (and the host's admin pages). */
    val email: String? = null,
    /** "/api/users/<id>/photo/<version>", or null for initials. */
    val photo: String? = null,
    val lastSeenAt: String? = null,
    val online: Boolean = false,
    /** Only on your own account: */
    val siteAdmin: Boolean = false,
    val mustChangePassword: Boolean = false,
    val passwordChangeRequired: Boolean = false,
    val privacy: Privacy? = null,
    /** Online status and last seen aren't shared (by them, or by you, which works both ways). */
    val presenceHidden: Boolean = false,
    /** I blocked them. */
    val blocked: Boolean = false,
    /** In the people finder for a room: already in it, or invited. */
    val roomStatus: String? = null,
)

@Serializable
data class LinkPreview(
    val url: String,
    val title: String = "",
    val description: String = "",
    val site: String = "",
    val image: String? = null,
)

@Serializable
data class Attachment(
    val id: String,
    /** image, video, voice or file */
    val kind: String,
    val name: String = "",
    val mime: String = "",
    val size: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    /** Seconds. */
    val duration: Double? = null,
    val waveform: List<Int>? = null,
    /** "/api/files/<id>" */
    val url: String,
)

@Serializable
data class ReplyAttachment(val kind: String, val name: String = "", val duration: Double? = null)

@Serializable
data class ReplyRef(
    val id: Long,
    val senderId: String? = null,
    val senderName: String = "",
    val body: String = "",
    val attachment: ReplyAttachment? = null,
    val deleted: Boolean = false,
)

@Serializable
data class Reaction(val emoji: String, val users: List<String> = emptyList())

@Serializable
data class Mention(val id: String, val offset: Int, val length: Int)

@Serializable
data class CallMeta(
    /** completed, missed or declined */
    val outcome: String? = null,
    /** Seconds. */
    val duration: Int? = null,
    val video: Boolean = false,
)

@Serializable
data class Sender(val id: String, val name: String, val hue: Int = 260, val photo: String? = null)

/**
 * A chat (DM) or room message, in one shape: chats carry senderId and
 * recipientId, rooms roomId and sender. The fields after `preview` are this
 * app's own (a message being sent).
 */
@Serializable
data class Message(
    val id: Long,
    /** text, call (chats) or system (rooms) */
    val kind: String = "text",
    val body: String = "",
    val createdAt: String,
    // Chats
    val senderId: String? = null,
    val recipientId: String? = null,
    val meta: CallMeta? = null,
    val deliveredAt: String? = null,
    val readAt: String? = null,
    // Rooms
    val roomId: String? = null,
    val sender: Sender? = null,
    val mentions: List<Mention>? = null,
    val deletedByAdmin: Boolean = false,
    // Both
    val deletedAt: String? = null,
    val replyToId: Long? = null,
    val replyTo: ReplyRef? = null,
    val clientId: String? = null,
    val editedAt: String? = null,
    val forwarded: Boolean = false,
    val preview: LinkPreview? = null,
    val attachment: Attachment? = null,
    val reactions: List<Reaction> = emptyList(),
    // This app's own
    /** sending or failed */
    val pending: String? = null,
    val tempId: String? = null,
    /** Upload progress, 0–100, while a file is on its way. */
    val upload: Int? = null,
    /** A file still on this phone, to send (or send again). */
    val localFile: LocalFile? = null,
) {
    val from: String? get() = senderId ?: sender?.id
    val isDeleted: Boolean get() = deletedAt != null
}

/** A file picked on this phone, kept until it's sent. */
@Serializable
data class LocalFile(
    val path: String,
    val kind: String,
    val name: String,
    val mime: String,
    val width: Int? = null,
    val height: Int? = null,
    val duration: Double? = null,
    val waveform: List<Int>? = null,
)

@Serializable
data class Conversation(
    val partner: User,
    val lastMessage: Message? = null,
    val unread: Int = 0,
    val mutedUntil: String? = null,
    val pinnedAt: String? = null,
    val archivedAt: String? = null,
    /** Its history was cleared then: it stays in the list, empty, until the next message. */
    val clearedAt: String? = null,
)

@Serializable
data class ClearAfter(val amount: Int, val unit: String)

@Serializable
data class RoomMember(
    val id: String,
    val name: String,
    val hue: Int = 260,
    val handle: String? = null,
    val photo: String? = null,
    val lastSeenAt: String? = null,
    val online: Boolean = false,
    val presenceHidden: Boolean = false,
    val blocked: Boolean = false,
    /** admin or member */
    val role: String = "member",
    val joinedAt: String? = null,
    val lastReadId: Long = 0,
    val lastDeliveredId: Long = 0,
    val voiceMuted: Boolean = false,
    val cameraBlocked: Boolean = false,
) {
    fun asUser() = User(id = id, name = name, hue = hue, handle = handle, photo = photo, lastSeenAt = lastSeenAt, online = online, presenceHidden = presenceHidden, blocked = blocked)
}

@Serializable
data class RoomInviteAdminView(val id: String, val createdAt: String, val invitedBy: String = "", val invitee: User)

@Serializable
data class VoiceParticipant(
    val userId: String,
    val muted: Boolean = false,
    val camera: Boolean = false,
    val away: Boolean = false,
    val silenced: Boolean = false,
    val cameraBlocked: Boolean = false,
)

@Serializable
data class DeviceStream(
    val sessionId: String,
    val hostId: String,
    val hostName: String = "",
    val mode: String = "file",
    val duration: Double? = null,
    val audio: Boolean = true,
)

@Serializable
data class WatchSource(
    val kind: String,
    val url: String = "",
    val videoId: String? = null,
    val title: String = "",
    val detail: String? = null,
    val fallbackUrl: String? = null,
    val relay: Boolean = false,
    val preparing: Boolean = false,
    val finding: Boolean = false,
    val error: String? = null,
    val device: DeviceStream? = null,
)

@Serializable
data class WatchMuted(val by: String, val byName: String = "")

@Serializable
data class WatchState(
    val id: String? = null,
    val source: WatchSource,
    val playing: Boolean = false,
    /** Seconds, at server time `at` (ms). */
    val position: Double = 0.0,
    val at: Long = 0,
    val by: String = "",
    val byName: String = "",
    val duration: Double? = null,
    val muted: WatchMuted? = null,
)

@Serializable
data class QueueAddedBy(val id: String, val name: String = "")

@Serializable
data class QueueItem(
    val id: String,
    val title: String = "",
    val site: String? = null,
    val thumbnail: String? = null,
    val duration: Double? = null,
    val kind: String = "",
    val addedBy: QueueAddedBy? = null,
    val addedAt: Long = 0,
)

/** One way to play a found video: a quality, a file or stream, or YouTube's player. */
@Serializable
data class FoundOption(
    val id: String,
    /** youtube, file, hls or merge (the server joins separate picture and sound first) */
    val kind: String = "",
    val label: String = "",
    val detail: String = "",
    val size: String? = null,
    val recommended: Boolean = false,
    val relay: Boolean = false,
)

@Serializable
data class FoundVideo(
    val id: String,
    val title: String = "",
    val thumbnail: String? = null,
    val duration: Double? = null,
    val live: Boolean = false,
    val site: String? = null,
    val options: List<FoundOption> = emptyList(),
)

@Serializable
data class FoundPlaylist(val title: String = "", val count: Int = 0, val total: Int = 0)

/** What the server found at a link (watch:scan). */
@Serializable
data class FindResult(
    val scanId: String,
    val videos: List<FoundVideo> = emptyList(),
    val notes: List<String> = emptyList(),
    val playlist: FoundPlaylist? = null,
)

/** A room as the room list shows it, and (with the fields below `clearedAt`) as Room info does. */
@Serializable
data class Room(
    val id: String,
    val name: String,
    val description: String = "",
    val photo: String? = null,
    val ownerId: String = "",
    val maxMembers: Int = 12,
    val memberCount: Int = 0,
    /** admin or member */
    val myRole: String = "member",
    val hasPassword: Boolean = false,
    /** Admins only. */
    val joinCode: String? = null,
    val unread: Int = 0,
    val unreadMentions: Int = 0,
    val mutedUntil: String? = null,
    val pinnedAt: String? = null,
    val archivedAt: String? = null,
    val createdAt: String? = null,
    /** The title of what it's watching together. */
    val watching: String? = null,
    val clearAfter: ClearAfter? = null,
    val clearedAt: String? = null,
    val lastMessage: Message? = null,
    // Room info (GET /rooms/:id)
    val members: List<RoomMember>? = null,
    val invites: List<RoomInviteAdminView>? = null,
    val voice: List<VoiceParticipant>? = null,
    val watch: WatchState? = null,
    val queue: List<QueueItem>? = null,
)

@Serializable
data class RoomPreview(
    val id: String,
    val name: String,
    val description: String = "",
    val photo: String? = null,
    val memberCount: Int = 0,
    val maxMembers: Int = 0,
    val needsPassword: Boolean = false,
    val member: Boolean = false,
)

@Serializable
data class InviteRoom(
    val id: String,
    val name: String,
    val description: String = "",
    val photo: String? = null,
    val memberCount: Int = 0,
    val maxMembers: Int = 0,
)

@Serializable
data class Invite(val id: String, val createdAt: String, val room: InviteRoom, val inviter: User)

@Serializable
data class Announcement(val id: String, val text: String, val at: String? = null)

@Serializable
data class Messaging(
    val linkPreviews: Boolean = true,
    val editing: Boolean = true,
    val editMinutes: Int = 15,
    val forwarding: Boolean = true,
    val forwardTo: Int = 5,
)

@Serializable
data class SiteInfo(val announcement: Announcement? = null, val messaging: Messaging = Messaging(), val build: String? = null)

@Serializable
data class IceServer(val urls: JsonElement, val username: String? = null, val credential: String? = null)

@Serializable
data class Limits(
    val minRoomMembers: Int = 2,
    val maxRoomMembers: Int = 50,
    val voiceSeats: Int = 12,
    val liveViewers: Int = 10,
    val messageLength: Int = 4000,
    val uploadMaxBytes: Long = 25L * 1024 * 1024,
)

@Serializable
data class ClientConfig(
    val iceServers: List<IceServer> = emptyList(),
    val iceTransportPolicy: String = "all",
    val limits: Limits = Limits(),
    val push: Boolean = false,
    /** Room calls go through LiveKit (see call/LiveKitCall.kt), not phone to phone. */
    val livekit: Boolean = false,
)

@Serializable
data class Session(
    val id: String,
    /** app or web */
    val kind: String = "web",
    /** A phone (the app, or a phone's browser). */
    val phone: Boolean = false,
    val name: String = "",
    val detail: String? = null,
    val ip: String? = null,
    val signedInAt: String? = null,
    val lastActiveAt: String? = null,
    val current: Boolean = false,
    val online: Boolean = false,
)

@Serializable
data class BlockedUser(val id: String, val name: String, val handle: String? = null, val hue: Int = 260, val photo: String? = null, val blockedAt: String? = null)

@Serializable
data class Release(
    val versionCode: Int,
    val versionName: String,
    val notes: String = "",
    val mandatory: Boolean = false,
    val size: Long = 0,
    val sha256: String = "",
    val minSdk: Int? = null,
    val publishedAt: String? = null,
    val url: String,
)

@Serializable
data class RequiredVersion(val versionCode: Int, val versionName: String)

@Serializable
data class AppVersions(val latest: Release? = null, val required: RequiredVersion? = null)

@Serializable
data class SignupConfirm(val token: String, val email: String, val resendIn: Int = 60)

@Serializable
data class AuthOptions(val allowSignups: Boolean = true, val passwordReset: Boolean = false)

/** Where a send went, in a forward's results. */
@Serializable
data class ForwardResult(val scope: String, val id: String, val ok: Boolean, val messageId: Long? = null, val error: String? = null)

@Serializable
data class ReadState(val user: User, val read: Boolean, val delivered: Boolean)

@Serializable
enum class Scope {
    @SerialName("dm") Dm,
    @SerialName("room") Room,
    ;

    val wire: String get() = if (this == Dm) "dm" else "room"
}
