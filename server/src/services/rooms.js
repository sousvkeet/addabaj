import { randomInt } from 'node:crypto';
import { one, query } from '../db.js';
import { conflict, forbidden, notFound, assertUuid } from '../errors.js';
import { getIO, roomChannel, userChannel } from '../realtime.js';
import { photoUrl, publicUser, roomPhotoUrl, USER_COLUMNS } from './users.js';
import { forgetRoomPhoto } from './photos.js';
import { live } from '../socket/live.js';
import { voice } from '../socket/voice.js';
import { getWatch, publicQueue, publicWatch } from './watch.js';
import { cancelMerge } from '../stream/merge.js';
import { forgetStream } from '../stream/cache.js';
import { enrich } from './messages.js';
import { introduce } from './presence.js';

export function roomMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
    sender: row.sender_id
      ? { id: row.sender_id, name: row.sender_name, hue: row.sender_hue, photo: row.sender_photo_url ?? photoUrl(row.sender_id, row.sender_photo) }
      : null,
    replyToId: row.reply_to_id ?? null,
    // The members named in the text: [{ id, offset, length }].
    mentions: row.mentions ?? null,
    clientId: row.client_id ?? null,
    editedAt: row.edited_at ?? null,
    forwarded: !!row.forwarded,
    preview: row.preview ?? null,
    deletedAt: row.deleted_at ?? null,
    // Deleted by a room admin rather than by whoever sent it.
    deletedByAdmin: !!row.deleted_at && !!row.deleted_by && row.deleted_by !== row.sender_id,
    attachment: null,
    replyTo: null,
    reactions: [],
  };
}

export const ROOM_MESSAGE_SELECT = `
  SELECT m.id, m.room_id, m.kind, m.body, m.created_at, m.sender_id, m.reply_to_id, m.deleted_at, m.deleted_by, m.client_id, m.mentions,
         m.edited_at, m.forwarded, m.preview,
         u.name AS sender_name, u.avatar_hue AS sender_hue, u.photo AS sender_photo
  FROM room_messages m LEFT JOIN users u ON u.id = m.sender_id`;

/** Throws unless the user belongs to the room. Returns { role, ownerId }. */
export async function requireMember(roomId, userId) {
  assertUuid(roomId, 'room');
  const row = await one(
    `SELECT rm.role, r.owner_id FROM room_members rm JOIN rooms r ON r.id = rm.room_id
     WHERE rm.room_id = $1 AND rm.user_id = $2`,
    [roomId, userId],
  );
  if (!row) throw notFound("That room doesn't exist or you're not a member.");
  return { role: row.role, ownerId: row.owner_id };
}

export async function requireAdmin(roomId, userId) {
  const m = await requireMember(roomId, userId);
  if (m.role !== 'admin') throw forbidden('Only room admins can do that.');
  return m;
}

/**
 * Locks the room row and checks there is a free seat. Must run inside a
 * transaction so concurrent adds/accepts can't overfill the room.
 */
export async function lockSeat(client, roomId, userId = null) {
  const { rows: [room] } = await client.query(
    'SELECT id, name, max_members FROM rooms WHERE id = $1 FOR UPDATE',
    [roomId],
  );
  if (!room) throw notFound("That room doesn't exist anymore.");
  // Already in (checked under the lock, so two requests at once can't both join): no seat needed.
  if (userId && (await client.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId])).rowCount) {
    return { ...room, member: true };
  }
  const { rows: [{ count }] } = await client.query(
    'SELECT count(*)::int AS count FROM room_members WHERE room_id = $1',
    [roomId],
  );
  if (count >= room.max_members) {
    throw conflict(`${room.name} is full (${room.max_members} of ${room.max_members}). Raise the member limit or remove someone first.`);
  }
  return room;
}

// ── Invite codes ──────────────────────────────────────────────────────
// Anyone with a room's code can join it (with its password, if it has one).
// 8 characters without look-alikes (no I, L, O, 0, 1): about 850 billion codes,
// and guessing is rate-limited.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newRoomCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** "k7pq-2xmb " → "K7PQ2XMB"; null when it can't be a code. */
export function normalizeRoomCode(value) {
  const code = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{8}$/.test(code) ? code : null;
}

/** Gives the room a new code (the old one stops working). */
export async function renewRoomCode(roomId, client = { query }) {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query('UPDATE rooms SET join_code = $2 WHERE id = $1', [roomId, newRoomCode()]);
      return;
    } catch (err) {
      if (err.code !== '23505' || attempt > 4) throw err;
    }
  }
}

/** Rooms made before invite codes existed get one (on start). */
export async function ensureRoomCodes() {
  const { rows } = await query('SELECT id FROM rooms WHERE join_code IS NULL');
  for (const r of rows) await renewRoomCode(r.id);
}

const SUMMARY_SELECT = `
  SELECT r.id, r.name, r.description, r.photo, r.owner_id, r.max_members, r.created_at, r.watch, rm.role,
    r.join_code, (r.join_password_hash IS NOT NULL) AS has_password,
    (SELECT count(*)::int FROM room_members x WHERE x.room_id = r.id) AS member_count,
    (SELECT count(*)::int FROM room_messages m
       WHERE m.room_id = r.id AND m.id > rm.last_read_id AND m.kind = 'text' AND m.sender_id IS DISTINCT FROM rm.user_id AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM room_hidden h WHERE h.user_id = rm.user_id AND h.message_id = m.id)) AS unread,
    -- Of those, the ones that mention me or reply to me.
    (SELECT count(*)::int FROM room_messages m
       WHERE m.room_id = r.id AND m.id > rm.last_read_id AND m.kind = 'text' AND m.sender_id IS DISTINCT FROM rm.user_id AND m.deleted_at IS NULL
         AND (m.mentions @> jsonb_build_array(jsonb_build_object('id', rm.user_id::text))
              OR EXISTS (SELECT 1 FROM room_messages p WHERE p.id = m.reply_to_id AND p.sender_id = rm.user_id))
         AND NOT EXISTS (SELECT 1 FROM room_hidden h WHERE h.user_id = rm.user_id AND h.message_id = m.id)) AS unread_mentions,
    CASE WHEN rm.muted_until > now() THEN rm.muted_until END AS muted_until, rm.pinned_at, rm.archived_at,
    lm.id AS lm_id, lm.kind AS lm_kind, lm.body AS lm_body, lm.created_at AS lm_created_at,
    lm.sender_id AS lm_sender_id, lm.deleted_at AS lm_deleted_at, lm.deleted_by AS lm_deleted_by,
    lu.name AS lm_sender_name, lu.avatar_hue AS lm_sender_hue
  FROM room_members rm
  JOIN rooms r ON r.id = rm.room_id
  LEFT JOIN LATERAL (
    SELECT * FROM room_messages m
    WHERE m.room_id = r.id AND NOT EXISTS (SELECT 1 FROM room_hidden h WHERE h.user_id = rm.user_id AND h.message_id = m.id)
    ORDER BY m.id DESC LIMIT 1
  ) lm ON true
  LEFT JOIN users lu ON lu.id = lm.sender_id`;

function summary(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    photo: roomPhotoUrl(row.id, row.photo),
    ownerId: row.owner_id,
    maxMembers: row.max_members,
    memberCount: row.member_count,
    myRole: row.role,
    // Joining with the code needs a password; admins also get the code to share.
    hasPassword: row.has_password,
    ...(row.role === 'admin' ? { joinCode: row.join_code } : {}),
    unread: row.unread,
    unreadMentions: row.unread_mentions,
    // My notifications for it are off until then (year 9999: until I turn them on).
    mutedUntil: row.muted_until ?? null,
    // Pinned to the top of my list, or archived out of it.
    pinnedAt: row.pinned_at ?? null,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    watching: row.watch?.source?.title ?? null,
    lastMessage: row.lm_id
      ? roomMessage({
          id: row.lm_id, room_id: row.id, kind: row.lm_kind, body: row.lm_body,
          created_at: row.lm_created_at, sender_id: row.lm_sender_id, deleted_at: row.lm_deleted_at, deleted_by: row.lm_deleted_by,
          sender_name: row.lm_sender_name, sender_hue: row.lm_sender_hue,
        })
      : null,
  };
}

export async function listRooms(userId) {
  const { rows } = await query(
    `${SUMMARY_SELECT} WHERE rm.user_id = $1
     ORDER BY COALESCE(lm.created_at, r.created_at) DESC`,
    [userId],
  );
  const rooms = rows.map(summary);
  await enrich('room', rooms.map((r) => r.lastMessage).filter(Boolean)); // "Photo", "Voice message"… in previews
  return rooms;
}

export async function roomSummary(roomId, userId) {
  const row = await one(`${SUMMARY_SELECT} WHERE rm.user_id = $1 AND rm.room_id = $2`, [userId, roomId]);
  if (!row) return null;
  const room = summary(row);
  if (room.lastMessage) await enrich('room', [room.lastMessage]);
  return room;
}

export async function roomDetail(roomId, userId) {
  const base = await roomSummary(roomId, userId);
  if (!base) throw notFound("That room doesn't exist or you're not a member.");
  const { rows: members } = await query(
    `SELECT u.id, u.email, u.handle, u.name, u.avatar_hue, u.photo, u.last_seen_at, rm.role, rm.joined_at, rm.last_read_id, rm.last_delivered_id
     FROM room_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1
     ORDER BY (u.id = $2) DESC, (rm.role = 'admin') DESC, lower(u.name)`,
    [roomId, base.ownerId],
  );
  let invites = [];
  if (base.myRole === 'admin') {
    const { rows } = await query(
      `SELECT i.id, i.created_at,
              u.id AS u_id, u.email AS u_email, u.handle AS u_handle, u.name AS u_name, u.avatar_hue AS u_hue, u.photo AS u_photo, u.last_seen_at AS u_seen,
              b.name AS by_name
       FROM room_invites i
       JOIN users u ON u.id = i.invitee_id
       JOIN users b ON b.id = i.inviter_id
       WHERE i.room_id = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [roomId],
    );
    invites = rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      invitedBy: r.by_name,
      invitee: publicUser({ id: r.u_id, email: r.u_email, handle: r.u_handle, name: r.u_name, avatar_hue: r.u_hue, photo: r.u_photo, last_seen_at: r.u_seen }, userId),
    }));
  }
  return {
    ...base,
    // How far each member has received and read, for "delivered" and "seen by".
    members: members.map((m) => ({
      ...publicUser(m, userId),
      role: m.role,
      joinedAt: m.joined_at,
      lastReadId: Number(m.last_read_id),
      lastDeliveredId: Math.max(Number(m.last_delivered_id), Number(m.last_read_id)),
    })),
    invites,
    voice: voice.participants(roomId),
    ...(await one('SELECT watch, watch_queue, watch_muted FROM rooms WHERE id = $1', [roomId]).then((r) => ({
      watch: publicWatch(r?.watch ?? null, r?.watch_muted),
      queue: publicQueue(r?.watch_queue),
    }))),
  };
}

/** Inserts a system line ("Asha added Rahul") and pushes it to the room. */
export async function postSystemMessage(roomId, body) {
  const row = await one(
    `INSERT INTO room_messages (room_id, kind, body) VALUES ($1, 'system', $2)
     RETURNING id, room_id, kind, body, created_at, sender_id`,
    [roomId, body],
  );
  const message = roomMessage(row);
  getIO()?.to(roomChannel(roomId)).emit('room:message', message);
  return message;
}

/** Tell every member's client to refetch the room. */
export function announceRoomChanged(roomId) {
  getIO()?.to(roomChannel(roomId)).emit('room:changed', { roomId });
  // People invited but not in yet see its new name, photo and member count too.
  refreshInvites(roomId).catch((err) => console.error('Updating invites failed', err));
}

async function refreshInvites(roomId) {
  const io = getIO();
  if (!io) return;
  const { rows } = await query(`SELECT id, invitee_id FROM room_invites WHERE room_id = $1 AND status = 'pending'`, [roomId]);
  for (const r of rows) {
    const invite = await inviteForInvitee(r.id);
    if (invite) io.to(userChannel(r.invitee_id)).emit('invite:updated', invite);
  }
}

export async function attachMember(roomId, userId) {
  const io = getIO();
  if (!io) return;
  io.in(userChannel(userId)).socketsJoin(roomChannel(roomId));
  const room = await roomSummary(roomId, userId);
  io.to(userChannel(userId)).emit('room:added', room);
  // Room members are contacts: they see each other's online status.
  const { rows } = await query('SELECT user_id FROM room_members WHERE room_id = $1 AND user_id <> $2', [roomId, userId]);
  for (const r of rows) introduce(userId, r.user_id);
}

/** Deletes a room and tells its members and invitees it's gone. */
export async function deleteRoom(roomId) {
  const { rows: members } = await query('SELECT user_id FROM room_members WHERE room_id = $1', [roomId]);
  const { rows: invites } = await query(`SELECT id, invitee_id FROM room_invites WHERE room_id = $1 AND status = 'pending'`, [roomId]);
  // Its video's shared download (or a join in progress) isn't needed any more.
  const watch = await getWatch(roomId).catch(() => null);
  if (watch?.stream) {
    cancelMerge(watch.stream.token);
    forgetStream(watch.stream.token);
  }
  const gone = await one('DELETE FROM rooms WHERE id = $1 RETURNING photo', [roomId]);
  await forgetRoomPhoto(roomId, gone?.photo);
  for (const m of members) detachMember(roomId, m.user_id, 'deleted');
  for (const i of invites) getIO()?.to(userChannel(i.invitee_id)).emit('invite:removed', { inviteId: i.id });
}

export function detachMember(roomId, userId, reason) {
  const io = getIO();
  if (!io) return;
  voice.kick(roomId, userId, reason);
  live.dropUser(roomId, userId, reason);
  io.to(userChannel(userId)).emit('room:removed', { roomId, reason });
  io.in(userChannel(userId)).socketsLeave(roomChannel(roomId));
}

export async function inviteForInvitee(inviteId) {
  const r = await one(
    `SELECT i.id, i.created_at, r.id AS room_id, r.name AS room_name, r.description AS room_description, r.photo AS room_photo,
            r.max_members,
            (SELECT count(*)::int FROM room_members x WHERE x.room_id = r.id) AS member_count,
            ${USER_COLUMNS.split(', ').map((c) => `u.${c} AS u_${c}`).join(', ')}
     FROM room_invites i
     JOIN rooms r ON r.id = i.room_id
     JOIN users u ON u.id = i.inviter_id
     WHERE i.id = $1`,
    [inviteId],
  );
  if (!r) return null;
  return {
    id: r.id,
    createdAt: r.created_at,
    room: {
      id: r.room_id,
      name: r.room_name,
      description: r.room_description,
      photo: roomPhotoUrl(r.room_id, r.room_photo),
      memberCount: r.member_count,
      maxMembers: r.max_members,
    },
    inviter: publicUser({
      id: r.u_id, email: r.u_email, handle: r.u_handle, name: r.u_name, avatar_hue: r.u_avatar_hue, photo: r.u_photo, last_seen_at: r.u_last_seen_at,
    }),
  };
}
