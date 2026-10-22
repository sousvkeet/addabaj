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
import { ROOM_MESSAGE_SELECT, roomMessage } from './rooms.js';
import { copyAttachment, discardAttachment, linkAttachment, uploadDir } from './uploads.js';
import { findUser, isHost } from './users.js';
import { blockedEitherWay, blockedMessage } from './blocks.js';
import { firstLink, schedulePreview } from './previews.js';
import { messaging } from './site.js';

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

/** The site's host admins aren't held to the limits they set for everyone. */

// Plenty for a fast typist, but stops floods: 20 messages per 10 s per person.
const canSend = rateLimiter(20, 10_000);
const SLOW_DOWN = "You're sending messages too fast. Wait a few seconds.";

const toUser = (userId, except) => {
  const target = getIO()?.to(userChannel(userId));
  return except ? target?.except(except) : target;
};

/** The app's name for a send (see schema.sql), or null. */
const sendName = (v) => (typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null);

/** A message saved earlier under this send's name: its answer was lost, and the app sent it again. */
async function savedDm(userId, to, clientId) {
  const row = clientId && (await one(`SELECT ${DM_COLUMNS} FROM dm_messages WHERE sender_id = $1 AND recipient_id = $2 AND client_id = $3`, [userId, to, clientId]));
  if (!row) return null;
  const message = dmMessage(row);
  await enrich('dm', [message]);
  return message;
}

/**
 * `internal`: what only the server sets (never from the app's own send):
 * `forwarded`, and a forwarded message's `preview`.
 */
export async function sendDm(userId, to, { body, attachmentId, replyTo, clientId: name } = {}, except = null, internal = {}) {
  if (!isUuid(to) || to === userId) throw new AppError(400, "You can't message that person.");
  const clientId = sendName(name);
  const again = await savedDm(userId, to, clientId);
  if (again) return again;
  if (!canSend(userId)) throw new AppError(429, SLOW_DOWN);
  const text = cleanBody(body, !!attachmentId);
  const partner = await findUser(to, userId);
  if (!partner) throw new AppError(404, "That person doesn't exist.");
  if (blockedEitherWay(userId, to)) throw new AppError(403, blockedMessage(userId, to, partner.name));
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
      `INSERT INTO dm_messages (sender_id, recipient_id, body, reply_to_id, client_id, forwarded, preview) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING ${DM_COLUMNS}`,
      [userId, to, text, replyToId, clientId, !!internal.forwarded, internal.preview ? JSON.stringify(internal.preview) : null],
    );
    if (!row) return null; // the same send, saved a moment ago
    const m = dmMessage(row);
    if (attachmentId) await linkAttachment(c, attachmentId, userId, 'dm_message_id', m.id);
    return m;
  });
  if (!message) return (await savedDm(userId, to, clientId)) ?? Promise.reject(new AppError(409, 'Send it again.'));
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
  if (!internal.preview) schedulePreview('dm', message);
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

/** As savedDm, in a room. */
async function savedRoomMessage(userId, roomId, clientId) {
  const row = clientId && (await one(`${ROOM_MESSAGE_SELECT} WHERE m.room_id = $1 AND m.sender_id = $2 AND m.client_id = $3`, [roomId, userId, clientId]));
  if (!row) return null;
  const message = roomMessage(row);
  await enrich('room', [message]);
  return message;
}

/** Most mentions one message can have. */
const MAX_MENTIONS = 20;

/**
 * The mentions in a room message: [{ id, offset, length }], each where the
 * text says "@" and that member's name (so nobody can be notified by a
 * mention that names someone else, or no one). Null when there are none.
 */
async function cleanMentions(roomId, senderId, text, raw) {
  if (!Array.isArray(raw) || !raw.length || !text) return null;
  const { rows } = await query('SELECT u.id, u.name FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = $1', [roomId]);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const found = [];
  for (const m of raw.slice(0, MAX_MENTIONS * 2)) {
    const id = typeof m?.id === 'string' ? m.id : '';
    const offset = Number(m?.offset);
    const length = Number(m?.length);
    const name = names.get(id);
    if (!name || id === senderId || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0) continue;
    if (text.slice(offset, offset + length).toLowerCase() !== `@${name}`.toLowerCase()) continue;
    found.push({ id, offset, length });
  }
  // In order, without overlaps, each person once.
  found.sort((a, b) => a.offset - b.offset);
  const out = [];
  const seen = new Set();
  for (const m of found) {
    const last = out.at(-1);
    if ((last && m.offset < last.offset + last.length) || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length === MAX_MENTIONS) break;
  }
  return out.length ? out : null;
}

/** `internal`: as for sendDm. */
export async function sendRoomMessage(user, roomId, { body, attachmentId, replyTo, mentions: named, clientId: name } = {}, except = null, internal = {}) {
  const userId = user.id;
  if (!isUuid(roomId)) throw new AppError(404, "That room doesn't exist.");
  const clientId = sendName(name);
  const again = await savedRoomMessage(userId, roomId, clientId);
  if (again) return again;
  if (!canSend(userId)) throw new AppError(429, SLOW_DOWN);
  const text = cleanBody(body, !!attachmentId);
  let replyToId = asId(replyTo);
  if (replyToId && !(await one('SELECT 1 FROM room_messages WHERE id = $1 AND room_id = $2', [replyToId, roomId]))) replyToId = null;
  const mentions = await cleanMentions(roomId, userId, text, named);
  const message = await transaction(async (c) => {
    const { rows: [row] } = await c.query(
      `INSERT INTO room_messages (room_id, sender_id, body, reply_to_id, client_id, mentions, forwarded, preview)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE EXISTS (SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2)
       ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING id, room_id, kind, body, created_at, sender_id, reply_to_id, client_id, mentions, edited_at, forwarded, preview`,
      [roomId, userId, text, replyToId, clientId, mentions ? JSON.stringify(mentions) : null, !!internal.forwarded, internal.preview ? JSON.stringify(internal.preview) : null],
    );
    if (!row) {
      if (clientId) return null; // perhaps the same send, saved a moment ago
      throw new AppError(403, "You're not a member of this room anymore.");
    }
    const m = roomMessage({ ...row, sender_name: user.name, sender_hue: user.hue, sender_photo_url: user.photo ?? null });
    if (attachmentId) await linkAttachment(c, attachmentId, userId, 'room_message_id', m.id);
    return m;
  });
  if (!message) return (await savedRoomMessage(userId, roomId, clientId)) ?? Promise.reject(new AppError(403, "You're not a member of this room anymore."));
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
  if (!internal.preview) schedulePreview('room', message);
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
  // Room admins, and the site's host admins, can take down anyone's message.
  const admin = m.role === 'admin' || (await isHost(user.id));
  if (!own && !admin) throw new AppError(403, 'Only room admins can delete other people’s messages for everyone.');
  if (own && !admin && Date.now() - new Date(m.created_at).getTime() > DELETE_FOR_EVERYONE_MS) {
    throw new AppError(403, 'Messages can be deleted for everyone only within two days of sending. You can still delete it for yourself.');
  }
  const deletedAt = await eraseMessage('room', id, user.id);
  io?.to(roomChannel(m.room_id)).emit('msg:deleted', { scope, roomId: m.room_id, messageId: id, deletedAt, byAdmin: !own });
  const { rows } = await query('SELECT user_id FROM room_members WHERE room_id = $1 AND user_id <> $2', [m.room_id, user.id]);
  pushDeleted(rows.map((r) => r.user_id), { scope, chatId: m.room_id, messageId: id });
  return { deletedAt, byAdmin: !own };
}

/** The host admin takes a message down (from a report): gone for everyone, as when its sender deletes it. */
export async function deleteAsHost(hostId, scope, messageId) {
  const id = asId(messageId);
  if (!id || !TABLES[scope]) throw new AppError(404, GONE);
  const io = getIO();
  if (scope === 'dm') {
    const m = await one('SELECT sender_id, recipient_id, deleted_at FROM dm_messages WHERE id = $1', [id]);
    if (!m) throw new AppError(404, GONE);
    if (m.deleted_at) return { deletedAt: m.deleted_at };
    const deletedAt = await eraseMessage('dm', id);
    io?.to(userChannel(m.sender_id)).to(userChannel(m.recipient_id)).emit('msg:deleted', {
      scope, messageId: id, between: [m.sender_id, m.recipient_id], deletedAt,
    });
    pushDeleted([m.recipient_id], { scope, chatId: m.sender_id, messageId: id });
    pushDeleted([m.sender_id], { scope, chatId: m.recipient_id, messageId: id });
    return { deletedAt };
  }
  const m = await one('SELECT room_id, deleted_at FROM room_messages WHERE id = $1', [id]);
  if (!m) throw new AppError(404, GONE);
  if (m.deleted_at) return { deletedAt: m.deleted_at };
  const deletedAt = await eraseMessage('room', id, hostId);
  io?.to(roomChannel(m.room_id)).emit('msg:deleted', { scope, roomId: m.room_id, messageId: id, deletedAt, byAdmin: true });
  const { rows } = await query('SELECT user_id FROM room_members WHERE room_id = $1', [m.room_id]);
  pushDeleted(rows.map((r) => r.user_id), { scope, chatId: m.room_id, messageId: id });
  return { deletedAt };
}

// ── Editing ───────────────────────────────────────────────────────────

/** The same people at the same places (kept mentions' keys come back from the database in another order). */
const sameMentions = (a, b) => JSON.stringify((a ?? []).map((x) => [x.id, x.offset, x.length])) === JSON.stringify((b ?? []).map((x) => [x.id, x.offset, x.length]));

const minutesText = (n) => (n % 60 === 0 && n >= 60 ? `${n / 60} ${n === 60 ? 'hour' : 'hours'}` : `${n} ${n === 1 ? 'minute' : 'minutes'}`);

/**
 * Changes what one of my messages says, within the time the host allows
 * (Site settings › Messages; a host admin's own, any time). Everyone with the
 * chat sees it change, marked "edited", and the earlier text is kept for the
 * host admin (it shows with reports).
 */
export async function editMessage(user, { scope, messageId, body, mentions: named }) {
  const settings = messaging();
  const host = await isHost(user.id);
  if (!settings.editing && !host) throw new AppError(403, 'Editing messages is turned off on this site.');
  const id = asId(messageId);
  const t = TABLES[scope];
  if (!id || !t) throw new AppError(404, GONE);
  const m = await one(`SELECT m.*, EXISTS (SELECT 1 FROM attachments a WHERE a.${t.fk} = m.id) AS has_file FROM ${t.messages} m WHERE m.id = $1`, [id]);
  if (!m || m.sender_id !== user.id) throw new AppError(404, GONE);
  if (m.kind !== 'text' || m.deleted_at) throw new AppError(403, 'That message can’t be edited.');
  if (scope === 'room' && !(await one('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [m.room_id, user.id]))) {
    throw new AppError(403, "You're not a member of this room anymore.");
  }
  if (scope === 'dm' && blockedEitherWay(user.id, m.recipient_id)) throw new AppError(403, "You can't change messages in this chat any more.");
  if (!host && Date.now() - new Date(m.created_at).getTime() > settings.editMinutes * 60_000) {
    throw new AppError(403, `Messages can be edited for ${minutesText(settings.editMinutes)} after sending.`);
  }
  const text = cleanBody(body, m.has_file);
  const mentions = scope === 'room' ? await cleanMentions(m.room_id, user.id, text, named) : null;
  const where = scope === 'room' ? { roomId: m.room_id } : { between: [m.sender_id, m.recipient_id] };
  // Nothing changed: nothing saved, and it isn't marked edited.
  if (text === m.body && (scope === 'dm' || sameMentions(mentions, m.mentions))) {
    return { scope, messageId: id, body: m.body, editedAt: m.edited_at, preview: m.preview ?? null, ...where, ...(scope === 'room' ? { mentions: m.mentions ?? null } : {}) };
  }
  const sameLink = firstLink(text) === firstLink(m.body);
  const row = await transaction(async (c) => {
    await c.query('INSERT INTO message_edits (scope, message_id, body) VALUES ($1, $2, $3)', [scope, id, m.body]);
    const { rows: [r] } =
      scope === 'room'
        ? await c.query(
            `UPDATE room_messages SET body = $2, mentions = $3, edited_at = now(), preview = CASE WHEN $4 THEN preview END
             WHERE id = $1 RETURNING edited_at, preview, mentions`,
            [id, text, mentions ? JSON.stringify(mentions) : null, sameLink],
          )
        : await c.query(
            `UPDATE dm_messages SET body = $2, edited_at = now(), preview = CASE WHEN $3 THEN preview END
             WHERE id = $1 RETURNING edited_at, preview`,
            [id, text, sameLink],
          );
    return r;
  });
  const change = {
    scope,
    messageId: id,
    body: text,
    editedAt: row.edited_at,
    preview: row.preview ?? null,
    ...where,
    ...(scope === 'room' ? { mentions: row.mentions ?? null } : {}),
  };
  const io = getIO();
  if (scope === 'room') io?.to(roomChannel(m.room_id)).emit('msg:edited', change);
  else io?.to(userChannel(m.sender_id)).to(userChannel(m.recipient_id)).emit('msg:edited', change);
  if (!sameLink) schedulePreview(scope, { id, body: text, roomId: m.room_id, senderId: m.sender_id, recipientId: m.recipient_id });
  return change;
}

// ── Forwarding ────────────────────────────────────────────────────────

/**
 * Sends a copy of a message I can see to other chats and rooms of mine (as
 * many at once as the host allows), marked "forwarded". A photo, video, file
 * or voice message goes too, as a copy of its own. Each one goes like a
 * message of mine: blocks, rooms I've left and the sending rate all apply.
 */
export async function forwardMessage(user, { scope, messageId, to }) {
  const settings = messaging();
  const host = await isHost(user.id);
  if (!settings.forwarding && !host) throw new AppError(403, 'Forwarding messages is turned off on this site.');
  const targets = [
    ...new Map(
      (Array.isArray(to) ? to : [])
        .filter((x) => (x?.scope === 'dm' || x?.scope === 'room') && isUuid(x.id) && !(x.scope === 'dm' && x.id === user.id))
        .map((x) => [`${x.scope}:${x.id}`, { scope: x.scope, id: x.id }]),
    ).values(),
  ];
  if (!targets.length) throw new AppError(400, 'Choose where to forward it.');
  const limit = host ? 50 : settings.forwardTo;
  if (targets.length > limit) throw new AppError(400, `You can forward a message to up to ${limit} ${limit === 1 ? 'chat' : 'chats'} at a time.`);
  const id = asId(messageId);
  const t = TABLES[scope];
  if (!id || !t) throw new AppError(404, GONE);
  const m = await one(`SELECT * FROM ${t.messages} WHERE id = $1`, [id]);
  const sees =
    m &&
    (scope === 'dm'
      ? m.sender_id === user.id || m.recipient_id === user.id
      : !!(await one('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [m.room_id, user.id])));
  if (!sees || m.deleted_at || m.kind !== 'text' || (await one(`SELECT 1 FROM ${t.hidden} WHERE user_id = $1 AND message_id = $2`, [user.id, id]))) {
    throw new AppError(404, GONE);
  }
  const file = await one(`SELECT * FROM attachments WHERE ${t.fk} = $1`, [id]);
  const results = [];
  for (const target of targets) {
    let attachmentId;
    try {
      attachmentId = file ? await copyAttachment(file, user.id) : undefined;
      const extra = { forwarded: true, preview: m.preview ?? null };
      const sent =
        target.scope === 'dm'
          ? await sendDm(user.id, target.id, { body: m.body, attachmentId }, null, extra)
          : await sendRoomMessage(user, target.id, { body: m.body, attachmentId }, null, extra);
      results.push({ ...target, ok: true, messageId: sent.id });
    } catch (err) {
      if (attachmentId) await discardAttachment(attachmentId).catch(() => {});
      results.push({ ...target, ok: false, error: err.expose ? err.message : 'It couldn’t be forwarded there.' });
    }
  }
  return { results };
}
