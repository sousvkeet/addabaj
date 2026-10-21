// Sending and reading chat and room messages. Used by the live connection and
// by the REST routes the Android app's notifications call (reply, mark read).
// `except` is the socket that did it, which already knows.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { query, one, transaction } from '../db.js';
import { limits } from '../config.js';
import { AppError, isUuid } from '../errors.js';
import { getIO, roomChannel, userChannel } from '../realtime.js';
import { markDmDelivered, markRoomDelivered, queueRoomReceipts } from '../socket/receipts.js';
import { rateLimiter } from '../socket/util.js';
import { DM_COLUMNS, dmMessage } from './dms.js';
import { enrich } from './messages.js';
import { receiptsShared } from './privacy.js';
import { introduce } from './presence.js';
import { pushChatRead, pushDeleted, pushDm, pushRoomMessage } from './push.js';
import { roomMessage } from './rooms.js';
import { linkAttachment, uploadDir } from './uploads.js';
import { findUser } from './users.js';

/** Message text; may be empty when a photo, file or voice message goes with it. */
function cleanBody(body, hasAttachment = false) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text && !hasAttachment) throw new AppError(400, 'Type a message first.');
  if (text.length > limits.messageLength) throw new AppError(400, `Messages can be up to ${limits.messageLength} characters.`);
  return text;
}

export const asId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// Plenty for a fast typist, but stops floods: 20 messages per 10 s per person.
const canSend = rateLimiter(20, 10_000);
const SLOW_DOWN = "You're sending messages too fast. Wait a few seconds.";

const toUser = (userId, except) => {
  const target = getIO()?.to(userChannel(userId));
  return except ? target?.except(except) : target;
};

export async function sendDm(userId, to, { body, attachmentId, replyTo } = {}, except = null) {
  if (!isUuid(to) || to === userId) throw new AppError(400, "You can't message that person.");
  if (!canSend(userId)) throw new AppError(429, SLOW_DOWN);
  const text = cleanBody(body, !!attachmentId);
  const partner = await findUser(to, userId);
  if (!partner) throw new AppError(404, "That person doesn't exist.");
  // A reply must point at a message in this same conversation.
  let replyToId = asId(replyTo);
  if (replyToId) {
    const ok = await one(
      `SELECT 1 FROM dm_messages WHERE id = $1 AND ((sender_id = $2 AND recipient_id = $3) OR (sender_id = $3 AND recipient_id = $2))`,
      [replyToId, userId, to],
    );
    if (!ok) replyToId = null;
  }
  const message = await transaction(async (c) => {
    const { rows: [row] } = await c.query(
      `INSERT INTO dm_messages (sender_id, recipient_id, body, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING ${DM_COLUMNS}`,
      [userId, to, text, replyToId],
    );
    const m = dmMessage(row);
    if (attachmentId) await linkAttachment(c, attachmentId, userId, 'dm_message_id', m.id);
    return m;
  });
  await enrich('dm', [message]);
  // Their first message: now they're contacts, and see each other's online status.
  const before = await one(
    `SELECT 1 FROM dm_messages WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)) AND id <> $3 LIMIT 1`,
    [userId, to, message.id],
  );
  if (!before) introduce(userId, to);
  // Delivered as soon as any of the recipient's devices confirms it has the message.
  const me = await findUser(userId, to);
  toUser(to)?.timeout(8000).emit('dm:new', { message, partner: me }, (_err, answers) => {
    if (answers?.length) markDmDelivered(to, [message.id]).catch(() => {});
  });
  toUser(userId, except)?.emit('dm:new', { message, partner });
  if (me) pushDm(message, me);
  return message;
}

/** I've read my chat with `partnerId` (and so everything in it is delivered too). */
export async function readDm(userId, partnerId, except = null) {
  if (!isUuid(partnerId)) return;
  // Read means delivered too (the sender gets "delivered" even when read receipts are off).
  await markDmDelivered(userId);
  const { rowCount } = await query(
    `UPDATE dm_messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
    [userId, partnerId],
  );
  const event = { readerId: userId, partnerId, readAt: new Date() };
  toUser(userId, except)?.emit('dm:read', event);
  if (rowCount && receiptsShared(userId, partnerId)) toUser(partnerId)?.emit('dm:read', event);
  pushChatRead(userId, 'dm', partnerId);
}

export async function sendRoomMessage(user, roomId, { body, attachmentId, replyTo } = {}, except = null) {
  const userId = user.id;
  if (!isUuid(roomId)) throw new AppError(404, "That room doesn't exist.");
  if (!canSend(userId)) throw new AppError(429, SLOW_DOWN);
  const text = cleanBody(body, !!attachmentId);
  let replyToId = asId(replyTo);
  if (replyToId && !(await one('SELECT 1 FROM room_messages WHERE id = $1 AND room_id = $2', [replyToId, roomId]))) replyToId = null;
  const message = await transaction(async (c) => {
    const { rows: [row] } = await c.query(
      `INSERT INTO room_messages (room_id, sender_id, body, reply_to_id)
       SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2)
       RETURNING id, room_id, kind, body, created_at, sender_id, reply_to_id`,
      [roomId, userId, text, replyToId],
    );
    if (!row) throw new AppError(403, "You're not a member of this room anymore.");
    const m = roomMessage({ ...row, sender_name: user.name, sender_hue: user.hue });
    if (attachmentId) await linkAttachment(c, attachmentId, userId, 'room_message_id', m.id);
    return m;
  });
  await enrich('room', [message]);
  await query(
    `UPDATE room_members SET last_read_id = $3, last_delivered_id = $3, last_read_at = now() WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId, message.id],
  );
  queueRoomReceipts(roomId, userId);
  // Each member's device confirms it got the message, which marks it delivered to them.
  const io = getIO();
  for (const id of io?.sockets.adapter.rooms.get(roomChannel(roomId)) ?? []) {
    const member = id === except ? null : io.sockets.sockets.get(id);
    if (!member) continue;
    const memberId = member.data.userId;
    member.timeout(8000).emit('room:message', message, (err) => {
      if (!err && memberId !== userId) markRoomDelivered(roomId, memberId, message.id).catch(() => {});
    });
  }
  pushRoomMessage(message).catch((err) => console.error('Room push failed', err));
  return message;
}

/** I've seen a room up to `messageId` (or its newest message when not given). */
export async function readRoom(userId, roomId, messageId, except = null) {
  if (!isUuid(roomId)) return;
  const upTo = Number.isSafeInteger(messageId) ? messageId : Number.MAX_SAFE_INTEGER;
  // Never past the room's newest message, so nobody can mark future messages seen.
  const { rowCount } = await query(
    `UPDATE room_members SET
       last_read_id = GREATEST(last_read_id, LEAST($3, coalesce((SELECT max(id) FROM room_messages WHERE room_id = $1), 0))),
       last_delivered_id = GREATEST(last_delivered_id, LEAST($3, coalesce((SELECT max(id) FROM room_messages WHERE room_id = $1), 0))),
       last_read_at = now()
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId, upTo],
  );
  if (!rowCount) return;
  queueRoomReceipts(roomId, userId);
  toUser(userId, except)?.emit('room:read', { roomId });
  pushChatRead(userId, 'room', roomId);
}

// ── Deleting ──────────────────────────────────────────────────────────

/** Your own messages can be deleted for everyone this long after sending, as on WhatsApp. */
export const DELETE_FOR_EVERYONE_MS = 48 * 60 * 60 * 1000;

const TABLES = {
  dm: { messages: 'dm_messages', hidden: 'dm_hidden', reactions: 'dm_reactions', fk: 'dm_message_id' },
  room: { messages: 'room_messages', hidden: 'room_hidden', reactions: 'room_reactions', fk: 'room_message_id' },
};
const GONE = "That message doesn't exist.";

/** Empties a message for everyone: text, reply, reactions, attachment (its file too). */
async function eraseMessage(scope, messageId, deletedBy) {
  const t = TABLES[scope];
  const files = await transaction(async (c) => {
    await c.query(
      scope === 'room'
        ? `UPDATE room_messages SET body = '', reply_to_id = NULL, deleted_at = now(), deleted_by = $2 WHERE id = $1`
        : `UPDATE dm_messages SET body = '', meta = NULL, reply_to_id = NULL, deleted_at = now() WHERE id = $1`,
      scope === 'room' ? [messageId, deletedBy] : [messageId],
    );
    await c.query(`DELETE FROM ${t.reactions} WHERE message_id = $1`, [messageId]);
    const { rows } = await c.query(`DELETE FROM attachments WHERE ${t.fk} = $1 RETURNING stored`, [messageId]);
    return rows;
  });
  for (const f of files) await rm(join(uploadDir, f.stored), { force: true }).catch(() => {});
  return new Date().toISOString();
}

/**
 * Deletes a chat or room message. `forEveryone`: replaced by "This message was
 * deleted" for everybody (your own messages, within two days; room admins:
 * anyone's, any time). Otherwise it's hidden from you only, on all your devices.
 */
export async function deleteMessage(user, { scope, messageId, forEveryone }) {
  const id = asId(messageId);
  if (!id || !TABLES[scope]) throw new AppError(404, GONE);
  const io = getIO();

  if (scope === 'dm') {
    const m = await one('SELECT sender_id, recipient_id, kind, created_at, deleted_at FROM dm_messages WHERE id = $1', [id]);
    if (!m || (m.sender_id !== user.id && m.recipient_id !== user.id)) throw new AppError(404, GONE);
    const partnerId = m.sender_id === user.id ? m.recipient_id : m.sender_id;
    if (!forEveryone) {
      await query('INSERT INTO dm_hidden (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, id]);
      io?.to(userChannel(user.id)).emit('msg:hidden', { scope, messageId: id, chatId: partnerId });
      return { hidden: true };
    }
    if (m.deleted_at) return { deletedAt: m.deleted_at };
    if (m.sender_id !== user.id || m.kind !== 'text') throw new AppError(403, 'You can only delete your own messages for everyone.');
    if (Date.now() - new Date(m.created_at).getTime() > DELETE_FOR_EVERYONE_MS) {
      throw new AppError(403, 'Messages can be deleted for everyone only within two days of sending. You can still delete it for yourself.');
    }
    const deletedAt = await eraseMessage('dm', id);
    io?.to(userChannel(m.sender_id)).to(userChannel(m.recipient_id)).emit('msg:deleted', {
      scope, messageId: id, between: [m.sender_id, m.recipient_id], deletedAt,
    });
    pushDeleted([m.recipient_id], { scope, chatId: m.sender_id, messageId: id });
    return { deletedAt };
  }

  const m = await one(
    `SELECT m.room_id, m.sender_id, m.kind, m.created_at, m.deleted_at, rm.role
     FROM room_messages m JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.id = $1`,
    [id, user.id],
  );
  if (!m) throw new AppError(404, GONE);
  if (!forEveryone) {
    await query('INSERT INTO room_hidden (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, id]);
    io?.to(userChannel(user.id)).emit('msg:hidden', { scope, messageId: id, chatId: m.room_id, roomId: m.room_id });
    return { hidden: true };
  }
  if (m.deleted_at) return { deletedAt: m.deleted_at };
  if (m.kind !== 'text') throw new AppError(403, 'Room notices can only be deleted for yourself.');
  const own = m.sender_id === user.id;
  if (!own && m.role !== 'admin') throw new AppError(403, 'Only room admins can delete other people’s messages for everyone.');
  if (own && m.role !== 'admin' && Date.now() - new Date(m.created_at).getTime() > DELETE_FOR_EVERYONE_MS) {
    throw new AppError(403, 'Messages can be deleted for everyone only within two days of sending. You can still delete it for yourself.');
  }
  const deletedAt = await eraseMessage('room', id, user.id);
  io?.to(roomChannel(m.room_id)).emit('msg:deleted', { scope, roomId: m.room_id, messageId: id, deletedAt, byAdmin: !own });
  const { rows } = await query('SELECT user_id FROM room_members WHERE room_id = $1 AND user_id <> $2', [m.room_id, user.id]);
  pushDeleted(rows.map((r) => r.user_id), { scope, chatId: m.room_id, messageId: id });
  return { deletedAt, byAdmin: !own };
}
