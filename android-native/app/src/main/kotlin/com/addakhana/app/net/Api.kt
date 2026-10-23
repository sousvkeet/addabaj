package com.addakhana.app.net

import okhttp3.Call
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import com.addakhana.app.model.AdminOverview
import com.addakhana.app.model.AdminRelease
import com.addakhana.app.model.AdminReport
import com.addakhana.app.model.AdminRoom
import com.addakhana.app.model.AdminUser
import com.addakhana.app.model.AppVersions
import com.addakhana.app.model.Attachment
import com.addakhana.app.model.AuthOptions
import com.addakhana.app.model.BlockedUser
import com.addakhana.app.model.ClearAfter
import com.addakhana.app.model.ClientConfig
import com.addakhana.app.model.Conversation
import com.addakhana.app.model.EmailSettings
import com.addakhana.app.model.Invite
import com.addakhana.app.model.Message
import com.addakhana.app.model.Messaging
import com.addakhana.app.model.Paged
import com.addakhana.app.model.ReadState
import com.addakhana.app.model.ReportList
import com.addakhana.app.model.Room
import com.addakhana.app.model.RoomPeople
import com.addakhana.app.model.RoomPreview
import com.addakhana.app.model.Session
import com.addakhana.app.model.SignupConfirm
import com.addakhana.app.model.SiteInfo
import com.addakhana.app.model.SiteSettings
import com.addakhana.app.model.User
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.InputStream
import java.net.URLEncoder

private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

@Serializable
data class MessagesPage(val messages: List<Message> = emptyList(), val hasMore: Boolean = false)

/** Every REST endpoint this app uses (server/src/routes, under /api). */
class Api(val http: OkHttpClient) {
    /** Sends a request and returns its JSON (null for 204), or throws ApiError. */
    suspend fun call(method: String, path: String, body: JsonElement? = null): JsonElement? {
        val payload = when {
            body != null -> json.encodeToString(JsonElement.serializer(), body).toRequestBody(JSON_TYPE)
            method == "GET" || method == "HEAD" -> null
            else -> ByteArray(0).toRequestBody(null)
        }
        val request = Request.Builder().url("$appUrl/api$path").method(method, payload).build()
        val (code, text) = http.newCall(request).answer()
        if (code !in 200..299) throw errorOf(code, text)
        return if (text.isBlank()) null else withContext(Dispatchers.Default) { json.parseToJsonElement(text) }
    }

    /**
     * Sends it and reads the whole answer, off the main thread: a long one
     * (a big list, a page of messages) is still arriving from the network.
     */
    private suspend fun Call.answer(): Pair<Int, String> = await().use { res -> withContext(Dispatchers.IO) { res.code to res.body.string() } }

    private suspend fun <T> field(method: String, path: String, name: String, serializer: KSerializer<T>, body: JsonElement? = null): T {
        val obj = call(method, path, body) as? JsonObject ?: throw ApiError(0, "The server sent an empty answer.")
        return json.decodeFromJsonElement(serializer, obj[name] ?: JsonNull)
    }

    private suspend inline fun <reified T> get(path: String, name: String): T = field("GET", path, name, serializer())
    private suspend inline fun <reified T> post(path: String, name: String, body: JsonElement? = null): T = field("POST", path, name, serializer(), body)
    private suspend inline fun <reified T> patch(path: String, name: String, body: JsonElement): T = field("PATCH", path, name, serializer(), body)
    private suspend inline fun <reified T> put(path: String, name: String, body: JsonElement): T = field("PUT", path, name, serializer(), body)

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    // ── Account ─────────────────────────────────────────────────────────

    suspend fun authOptions(): AuthOptions = json.decodeFromJsonElement(AuthOptions.serializer(), call("GET", "/auth/options") ?: JsonObject(emptyMap()))
    suspend fun me(): User? = get("/auth/me", "user")
    suspend fun login(email: String, password: String): User = post("/auth/login", "user", buildJsonObject { put("email", email); put("password", password) })
    suspend fun logout() { call("POST", "/auth/logout") }

    /** Signed up (a user), or an email code to confirm first. */
    suspend fun register(name: String, email: String, password: String): Pair<User?, SignupConfirm?> {
        val obj = call("POST", "/auth/register", buildJsonObject { put("name", name); put("email", email); put("password", password) }) as JsonObject
        val user = obj["user"]?.takeIf { it != JsonNull }?.let { json.decodeFromJsonElement(User.serializer(), it) }
        val confirm = obj["confirm"]?.takeIf { it != JsonNull }?.let { json.decodeFromJsonElement(SignupConfirm.serializer(), it) }
        return user to confirm
    }

    suspend fun confirmSignup(token: String, code: String): User = post("/auth/register/confirm", "user", buildJsonObject { put("token", token); put("code", code) })
    suspend fun resendSignup(token: String): Int = post("/auth/register/resend", "resendIn", buildJsonObject { put("token", token) })
    suspend fun forgot(email: String): Int = post("/auth/forgot", "resendIn", buildJsonObject { put("email", email) })
    suspend fun reset(email: String, code: String, password: String): User =
        post("/auth/reset", "user", buildJsonObject { put("email", email); put("code", code); put("password", password) })

    suspend fun changePassword(current: String, new: String): User = post("/auth/password", "user", buildJsonObject { put("currentPassword", current); put("newPassword", new) })
    suspend fun setName(name: String): User = patch("/auth/name", "user", buildJsonObject { put("name", name) })
    suspend fun setHandle(handle: String): User = patch("/auth/handle", "user", buildJsonObject { put("handle", handle) })
    suspend fun setPrivacy(sharePresence: Boolean? = null, readReceipts: Boolean? = null): User =
        patch("/auth/privacy", "user", buildJsonObject { sharePresence?.let { put("sharePresence", it) }; readReceipts?.let { put("readReceipts", it) } })

    suspend fun setPhoto(jpeg: ByteArray): User = rawPut("/auth/photo", jpeg, "user")
    suspend fun removePhoto(): User = field("DELETE", "/auth/photo", "user", User.serializer())
    suspend fun presence(): List<String> = get("/auth/presence", "online")
    suspend fun sessions(): List<Session> = get("/auth/sessions", "sessions")
    suspend fun endSession(id: String): List<Session> = field("DELETE", "/auth/sessions/${enc(id)}", "sessions", ListSerializer(Session.serializer()))
    suspend fun endOtherSessions(): List<Session> = field("DELETE", "/auth/sessions/others", "sessions", ListSerializer(Session.serializer()))

    // ── Site ────────────────────────────────────────────────────────────

    suspend fun config(): ClientConfig = json.decodeFromJsonElement(ClientConfig.serializer(), call("GET", "/config")!!)
    suspend fun site(): SiteInfo = json.decodeFromJsonElement(SiteInfo.serializer(), call("GET", "/site")!!)
    suspend fun appVersions(): AppVersions = json.decodeFromJsonElement(AppVersions.serializer(), call("GET", "/app/version")!!)

    // ── People ──────────────────────────────────────────────────────────

    suspend fun findUser(query: String, roomId: String? = null): User = get("/users/find?q=${enc(query)}" + (roomId?.let { "&roomId=${enc(it)}" } ?: ""), "user")
    suspend fun user(id: String): User = get("/users/${enc(id)}", "user")
    suspend fun blocked(): List<BlockedUser> = get("/users/blocked", "blocked")
    suspend fun block(id: String) { call("POST", "/users/${enc(id)}/block") }
    suspend fun unblock(id: String) { call("DELETE", "/users/${enc(id)}/block") }

    suspend fun report(scope: String, targetId: String?, messageId: Long?, reason: String, details: String, block: Boolean) {
        call("POST", "/reports", buildJsonObject {
            put("scope", scope)
            targetId?.let { put("targetId", it) }
            messageId?.let { put("messageId", it) }
            put("reason", reason)
            if (details.isNotBlank()) put("details", details)
            put("block", block)
        })
    }

    // ── Chats ───────────────────────────────────────────────────────────

    suspend fun conversations(): List<Conversation> = get("/dms", "conversations")

    suspend fun dmMessages(userId: String, before: Long? = null): MessagesPage =
        json.decodeFromJsonElement(MessagesPage.serializer(), call("GET", "/dms/${enc(userId)}/messages" + (before?.let { "?before=$it" } ?: ""))!!)

    suspend fun dmSettings(userId: String, mute: String? = null, pinned: Boolean? = null, archived: Boolean? = null): JsonObject =
        call("PUT", "/dms/${enc(userId)}/settings", buildJsonObject { mute?.let { put("mute", it) }; pinned?.let { put("pinned", it) }; archived?.let { put("archived", it) } }) as JsonObject

    suspend fun dmRead(userId: String) { call("POST", "/dms/${enc(userId)}/read") }

    /** A plain reply (from a notification): no attachment, no clientId. */
    suspend fun replyDm(userId: String, body: String) { call("POST", "/dms/${enc(userId)}/messages", buildJsonObject { put("body", body) }) }
    suspend fun replyRoom(roomId: String, body: String) { call("POST", "/rooms/${enc(roomId)}/messages", buildJsonObject { put("body", body) }) }

    // ── Rooms ───────────────────────────────────────────────────────────

    suspend fun rooms(): List<Room> = get("/rooms", "rooms")
    suspend fun room(id: String): Room = get("/rooms/${enc(id)}", "room")

    suspend fun createRoom(name: String, description: String, maxMembers: Int, password: String?): Room =
        post("/rooms", "room", buildJsonObject {
            put("name", name); put("description", description); put("maxMembers", maxMembers)
            if (!password.isNullOrEmpty()) put("password", password)
        })

    suspend fun roomPreview(code: String): RoomPreview = get("/rooms/join/${enc(code)}", "room")
    suspend fun joinRoom(code: String, password: String?): Room =
        post("/rooms/join", "room", buildJsonObject { put("code", code); if (!password.isNullOrEmpty()) put("password", password) })

    suspend fun updateRoom(id: String, name: String?, description: String?, maxMembers: Int?): Room =
        patch("/rooms/${enc(id)}", "room", buildJsonObject { name?.let { put("name", it) }; description?.let { put("description", it) }; maxMembers?.let { put("maxMembers", it) } })

    suspend fun setRoomPassword(id: String, password: String?): Room =
        patch("/rooms/${enc(id)}/access", "room", buildJsonObject { if (password == null) put("password", JsonNull) else put("password", password) })

    suspend fun newRoomCode(id: String): Room = post("/rooms/${enc(id)}/code", "room")

    suspend fun setRoomHistory(id: String, clearAfter: ClearAfter?): Room =
        put("/rooms/${enc(id)}/history", "room", buildJsonObject {
            if (clearAfter == null) put("clearAfter", JsonNull)
            else put("clearAfter", buildJsonObject { put("amount", clearAfter.amount); put("unit", clearAfter.unit) })
        })

    suspend fun clearRoomHistory(id: String): Room = post("/rooms/${enc(id)}/history/clear", "room")

    suspend fun moderateVoice(roomId: String, userId: String, voiceMuted: Boolean? = null, cameraBlocked: Boolean? = null): Room =
        put("/rooms/${enc(roomId)}/members/${enc(userId)}/voice", "room", buildJsonObject { voiceMuted?.let { put("voiceMuted", it) }; cameraBlocked?.let { put("cameraBlocked", it) } })

    suspend fun setRoomPhoto(id: String, jpeg: ByteArray): Room = rawPut("/rooms/${enc(id)}/photo", jpeg, "room")
    suspend fun removeRoomPhoto(id: String): Room = field("DELETE", "/rooms/${enc(id)}/photo", "room", Room.serializer())
    suspend fun deleteRoom(id: String) { call("DELETE", "/rooms/${enc(id)}") }

    suspend fun roomMessages(id: String, before: Long? = null): MessagesPage =
        json.decodeFromJsonElement(MessagesPage.serializer(), call("GET", "/rooms/${enc(id)}/messages" + (before?.let { "?before=$it" } ?: ""))!!)

    suspend fun roomMessageInfo(roomId: String, messageId: Long): List<ReadState> = get("/rooms/${enc(roomId)}/messages/$messageId/info", "members")

    suspend fun addMember(roomId: String, userId: String): Room = post("/rooms/${enc(roomId)}/members", "room", buildJsonObject { put("userId", userId) })
    suspend fun removeMember(roomId: String, userId: String) { call("DELETE", "/rooms/${enc(roomId)}/members/${enc(userId)}") }
    suspend fun setRole(roomId: String, userId: String, role: String): Room = patch("/rooms/${enc(roomId)}/members/${enc(userId)}", "room", buildJsonObject { put("role", role) })
    suspend fun invite(roomId: String, userId: String): Room = post("/rooms/${enc(roomId)}/invites", "room", buildJsonObject { put("userId", userId) })
    suspend fun cancelInvite(roomId: String, inviteId: String) { call("DELETE", "/rooms/${enc(roomId)}/invites/${enc(inviteId)}") }

    suspend fun muteRoom(id: String, forWhat: String): JsonObject = call("PUT", "/rooms/${enc(id)}/mute", buildJsonObject { put("for", forWhat) }) as JsonObject
    suspend fun roomSettings(id: String, pinned: Boolean? = null, archived: Boolean? = null): JsonObject =
        call("PUT", "/rooms/${enc(id)}/settings", buildJsonObject { pinned?.let { put("pinned", it) }; archived?.let { put("archived", it) } }) as JsonObject

    suspend fun roomRead(id: String) { call("POST", "/rooms/${enc(id)}/read") }

    // ── Invites ─────────────────────────────────────────────────────────

    suspend fun invites(): List<Invite> = get("/invites", "invites")
    suspend fun acceptInvite(id: String): Room = post("/invites/${enc(id)}/accept", "room")
    suspend fun declineInvite(id: String) { call("POST", "/invites/${enc(id)}/decline") }

    // ── Calls and push ──────────────────────────────────────────────────

    suspend fun declineCall(callId: String) { call("POST", "/calls/${enc(callId)}/decline") }
    suspend fun registerPush(token: String) { call("POST", "/push/devices", buildJsonObject { put("token", token); put("platform", "android") }) }
    suspend fun unregisterPush(token: String) { call("DELETE", "/push/devices", buildJsonObject { put("token", token) }) }

    // ── Files ───────────────────────────────────────────────────────────

    /**
     * Sends a file as the request's body (not multipart), its details in the
     * X-Upload-Meta header; the server keeps it until a message carries it.
     */
    suspend fun upload(file: File, meta: JsonObject, onProgress: (Int) -> Unit): Attachment {
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = file.length()
            override fun writeTo(sink: BufferedSink) {
                val total = file.length().coerceAtLeast(1)
                var sent = 0L
                var last = -1
                file.source().use { src ->
                    val buffer = okio.Buffer()
                    while (true) {
                        val read = src.read(buffer, 64 * 1024)
                        if (read == -1L) break
                        sink.write(buffer, read)
                        sent += read
                        val percent = (sent * 100 / total).toInt()
                        if (percent != last) {
                            last = percent
                            onProgress(percent)
                        }
                    }
                }
            }
        }
        val header = URLEncoder.encode(json.encodeToString(JsonObject.serializer(), meta), "UTF-8").replace("+", "%20")
        val request = Request.Builder().url("$appUrl/api/uploads").post(body).header("X-Upload-Meta", header).build()
        val (code, text) = http.newCall(request).answer()
        if (code !in 200..299) throw errorOf(code, text)
        return json.decodeFromJsonElement(Attachment.serializer(), (json.parseToJsonElement(text) as JsonObject)["attachment"]!!)
    }

    // ── Admin (host admins only) ────────────────────────────────────────

    suspend fun adminOverview(): AdminOverview = json.decodeFromJsonElement(AdminOverview.serializer(), call("GET", "/admin/overview")!!)

    /** `filter`: all, online, admins or disabled. */
    suspend fun adminUsers(q: String, limit: Int, offset: Int = 0, filter: String = "all"): Paged<AdminUser> =
        json.decodeFromJsonElement(Paged.serializer(AdminUser.serializer()), call("GET", "/admin/users?q=${enc(q)}&filter=${enc(filter)}&limit=$limit&offset=$offset")!!)

    suspend fun addUser(name: String, email: String, password: String, siteAdmin: Boolean): AdminUser =
        post("/admin/users", "user", buildJsonObject { put("name", name); put("email", email); put("password", password); put("siteAdmin", siteAdmin) })

    suspend fun updateUser(id: String, siteAdmin: Boolean? = null, disabled: Boolean? = null): AdminUser =
        patch("/admin/users/${enc(id)}", "user", buildJsonObject { siteAdmin?.let { put("siteAdmin", it) }; disabled?.let { put("disabled", it) } })

    suspend fun setUserPassword(id: String, password: String) { call("POST", "/admin/users/${enc(id)}/password", buildJsonObject { put("password", password) }) }
    suspend fun removeUser(id: String) { call("DELETE", "/admin/users/${enc(id)}") }
    suspend fun removeUserPhoto(id: String) { call("DELETE", "/admin/users/${enc(id)}/photo") }

    suspend fun adminRooms(q: String, limit: Int, offset: Int = 0): Paged<AdminRoom> =
        json.decodeFromJsonElement(Paged.serializer(AdminRoom.serializer()), call("GET", "/admin/rooms?q=${enc(q)}&limit=$limit&offset=$offset")!!)

    suspend fun stopRoomVideo(id: String) { call("POST", "/admin/rooms/${enc(id)}/stop-video") }
    suspend fun takeDownRoomPhoto(id: String) { call("DELETE", "/admin/rooms/${enc(id)}/photo") }
    suspend fun removeRoom(id: String) { call("DELETE", "/admin/rooms/${enc(id)}") }

    suspend fun roomPeople(id: String): RoomPeople = json.decodeFromJsonElement(RoomPeople.serializer(), call("GET", "/admin/rooms/${enc(id)}/members")!!)
    suspend fun hostAddMember(roomId: String, userId: String): RoomPeople =
        json.decodeFromJsonElement(RoomPeople.serializer(), call("POST", "/admin/rooms/${enc(roomId)}/members", buildJsonObject { put("userId", userId) })!!)
    suspend fun hostRemoveMember(roomId: String, userId: String): RoomPeople =
        json.decodeFromJsonElement(RoomPeople.serializer(), call("DELETE", "/admin/rooms/${enc(roomId)}/members/${enc(userId)}")!!)

    /** `status`: open (waiting) or closed (handled). */
    suspend fun adminReports(status: String, limit: Int, offset: Int = 0): ReportList =
        json.decodeFromJsonElement(ReportList.serializer(), call("GET", "/admin/reports?status=${enc(status)}&limit=$limit&offset=$offset")!!)

    /** `action`: resolve, dismiss, reopen, delete-message or switch-off. */
    suspend fun actOnReport(id: String, action: String): AdminReport = post("/admin/reports/${enc(id)}", "report", buildJsonObject { put("action", action) })

    suspend fun siteSettings(): SiteSettings = get("/admin/settings", "settings")
    suspend fun setSignups(allow: Boolean): SiteSettings = patch("/admin/settings", "settings", buildJsonObject { put("allowSignups", allow) })
    /** A new announcement, or none (null takes it down). */
    suspend fun setAnnouncement(text: String?): SiteSettings =
        patch("/admin/settings", "settings", buildJsonObject { if (text == null) put("announcement", JsonNull) else put("announcement", text) })

    suspend fun adminMessaging(): Messaging = get("/admin/messaging", "messaging")
    suspend fun setMessaging(
        linkPreviews: Boolean? = null,
        editing: Boolean? = null,
        editMinutes: Int? = null,
        forwarding: Boolean? = null,
        forwardTo: Int? = null,
    ): Messaging = patch("/admin/messaging", "messaging", buildJsonObject {
        linkPreviews?.let { put("linkPreviews", it) }
        editing?.let { put("editing", it) }
        editMinutes?.let { put("editMinutes", it) }
        forwarding?.let { put("forwarding", it) }
        forwardTo?.let { put("forwardTo", it) }
    })

    suspend fun emailSettings(): EmailSettings = get("/admin/email", "email")

    /** An empty password keeps the saved one. */
    suspend fun saveEmailSettings(s: EmailSettings, password: String): EmailSettings =
        put("/admin/email", "email", buildJsonObject {
            put("enabled", s.enabled); put("host", s.host); put("port", s.port); put("security", s.security)
            put("user", s.user); put("from", s.from); put("verifySignups", s.verifySignups)
            if (password.isNotEmpty()) put("password", password)
        })

    /** Back to the settings in the server's .env file. */
    suspend fun useEnvEmail(): EmailSettings = field("DELETE", "/admin/email", "email", EmailSettings.serializer())
    suspend fun testEmail(to: String) { call("POST", "/admin/email/test", buildJsonObject { put("to", to) }) }

    suspend fun releases(): List<AdminRelease> = get("/admin/app/releases", "releases")
    suspend fun updateRelease(versionCode: Int, notes: String? = null, mandatory: Boolean? = null): List<AdminRelease> =
        patch("/admin/app/releases/$versionCode", "releases", buildJsonObject { notes?.let { put("notes", it) }; mandatory?.let { put("mandatory", it) } })
    suspend fun deleteRelease(versionCode: Int): List<AdminRelease> =
        field("DELETE", "/admin/app/releases/$versionCode", "releases", ListSerializer(AdminRelease.serializer()))

    /**
     * A new version of the app: the APK as the request's body (it can be
     * large), its notes and whether it's mandatory in the X-Release-Meta
     * header. `open` is called for each try, so a retried request starts the
     * file again; `length` is -1 when unknown (then no progress is reported).
     */
    suspend fun uploadRelease(open: () -> InputStream, length: Long, notes: String, mandatory: Boolean, onProgress: (Int) -> Unit): AdminRelease {
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = length
            override fun writeTo(sink: BufferedSink) {
                var sent = 0L
                var last = -1
                open().source().use { src ->
                    val buffer = okio.Buffer()
                    while (true) {
                        val read = src.read(buffer, 64 * 1024)
                        if (read == -1L) break
                        sink.write(buffer, read)
                        sent += read
                        if (length > 0) {
                            val percent = (sent * 100 / length).toInt()
                            if (percent != last) {
                                last = percent
                                onProgress(percent)
                            }
                        }
                    }
                }
            }
        }
        val meta = buildJsonObject { put("notes", notes); put("mandatory", mandatory) }
        val header = URLEncoder.encode(json.encodeToString(JsonObject.serializer(), meta), "UTF-8").replace("+", "%20")
        val request = Request.Builder().url("$appUrl/api/admin/app/releases").post(body).header("X-Release-Meta", header).build()
        val (code, text) = http.newCall(request).answer()
        if (code !in 200..299) throw errorOf(code, text)
        return json.decodeFromJsonElement(AdminRelease.serializer(), (json.parseToJsonElement(text) as JsonObject)["release"]!!)
    }

    private suspend fun <T> rawPut(path: String, jpeg: ByteArray, name: String, serializer: KSerializer<T>): T {
        val request = Request.Builder().url("$appUrl/api$path").put(jpeg.toRequestBody("image/jpeg".toMediaType())).build()
        val (code, text) = http.newCall(request).answer()
        if (code !in 200..299) throw errorOf(code, text)
        return json.decodeFromJsonElement(serializer, (json.parseToJsonElement(text) as JsonObject)[name]!!)
    }

    private suspend inline fun <reified T> rawPut(path: String, jpeg: ByteArray, name: String): T = rawPut(path, jpeg, name, serializer())
}
