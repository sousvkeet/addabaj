import { query, one, transaction } from '../db.js';
import { COOKIE_NAME, readCookie, verifyToken } from '../auth.js';
import { limits } from '../config.js';
import { AppError, isUuid } from '../errors.js';
import { presence, roomChannel, userChannel } from '../realtime.js';
import { DM_COLUMNS, dmMessage } from '../services/dms.js';
import { roomMessage } from '../services/rooms.js';
import { findUser } from '../services/users.js';
import { hidesPresence, receiptsShared } from '../services/privacy.js';
import { markAllRoomsDelivered, markDmDelivered, markRoomDelivered, queueRoomReceipts } from './receipts.js';
import { enrich, toggleReaction } from '../services/messages.js';
import { linkAttachment } from '../services/uploads.js';
import { calls } from './calls.js';
import { live } from './live.js';
import { guardSocket, handle, rateLimiter } from './util.js';
import { voice } from './voice.js';
import { registerWatch } from './watch.js';

/** Message text; may be empty when a photo, file or voice message goes with it. */
function cleanBody(body, hasAttachment = false) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text && !hasAttachment) throw new AppError(400, 'Type a message first.');
  if (text.length > limits.messageLength) throw new AppError(400, `Messages can be up to ${limits.messageLength} characters.`);
  return text;
}

const asId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// Plenty for a fast typist, but stops floods: 20 messages / 30 reactions per 10 s per person.
const canSend = rateLimiter(20, 10_000);
const canReact = rateLimiter(30, 10_000);
const SLOW_DOWN = "You're sending messages too fast. Wait a few seconds.";

/** Presence updates go only to people who share their own (it works both ways). */
export const PRESENCE = 'presence';

// One emoji (with skin tone / joiner / variation parts), nothing else.
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f)+$/u;

export function initSocket(io) {
  io.use(async (socket, next) => {
    const userId = verifyToken(readCookie(socket.handshake.headers.cookie, COOKIE_NAME));
    const user = userId && (await findUser(userId).catch(() => null));
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    socket.data.user = { id: user.id, name: user.name, email: user.email, hue: user.hue };
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    guardSocket(socket);

    // Register every handler synchronously so no early event is dropped.
    registerDm(io, socket);
    registerRoomChat(io, socket);
    calls.register(io, socket);
    voice.register(io, socket);
    registerWatch(socket);
    live.register(socket);

    socket.on('disconnect', async () => {
      const offline = presence.remove(userId, socket.id);
      calls.handleDisconnect(socket);
      voice.handleDisconnect(socket);
      live.handleDisconnect(socket);
      if (offline) {
        const row = await one('UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at', [userId]).catch(() => null);
        if (!presence.isOnline(userId) && !hidesPresence(userId)) {
          io.to(PRESENCE).emit('presence:update', { userId, online: false, lastSeenAt: row?.last_seen_at ?? new Date() });
        }
      }
    });

    socket.join(userChannel(userId));
    const sharing = !hidesPresence(userId);
    if (sharing) socket.join(PRESENCE);
    if (presence.add(userId, socket.id) && sharing) socket.to(PRESENCE).emit('presence:update', { userId, online: true });
    socket.emit('presence:snapshot', { online: sharing ? presence.list().filter((id) => !hidesPresence(id)) : [] });

    // Whatever arrived while this person was away is now on their device.
    markDmDelivered(userId).catch((err) => console.error('Could not mark chats delivered', err));
    markAllRoomsDelivered(userId).catch((err) => console.error('Could not mark rooms delivered', err));

    query('SELECT room_id FROM room_members WHERE user_id = $1', [userId])
      .then(({ rows }) => {
        const roomIds = rows.map((r) => r.room_id);
        socket.join(roomIds.map(roomChannel));
        socket.emit('voice:snapshot', voice.snapshot(roomIds));
      })
      .catch((err) => console.error('Failed to join rooms', err));
  });
}

function registerDm(io, socket) {
  const userId = socket.data.userId;

  socket.on('dm:send', handle(async ({ to, body, attachmentId, replyTo }) => {
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
    // Delivered as soon as any of the recipient's devices confirms it has the message.
    const me = await findUser(userId, to);
    io.to(userChannel(to)).timeout(8000).emit('dm:new', { message, partner: me }, (_err, answers) => {
      if (answers?.length) markDmDelivered(to, [message.id]).catch(() => {});
    });
    socket.to(userChannel(userId)).emit('dm:new', { message, partner });
    return { message };
  }));

  socket.on('dm:typing', ({ to, typing } = {}) => {
    if (isUuid(to)) socket.to(userChannel(to)).emit('dm:typing', { from: userId, typing: !!typing });
  });

  socket.on('dm:read', handle(async ({ partnerId }) => {
    if (!isUuid(partnerId)) return {};
    // Read means delivered too (the sender gets "delivered" even when read receipts are off).
    await markDmDelivered(userId);
    const { rowCount } = await query(
      `UPDATE dm_messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
      [userId, partnerId],
    );
    const event = { readerId: userId, partnerId, readAt: new Date() };
    socket.to(userChannel(userId)).emit('dm:read', event);
    if (rowCount && receiptsShared(userId, partnerId)) io.to(userChannel(partnerId)).emit('dm:read', event);
    return {};
  }));
}

function registerRoomChat(io, socket) {
  const userId = socket.data.userId;
  const inRoom = (roomId) => isUuid(roomId) && socket.rooms.has(roomChannel(roomId));

  socket.on('room:send', handle(async ({ roomId, body, attachmentId, replyTo }) => {
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
      const m = roomMessage({ ...row, sender_name: socket.data.user.name, sender_hue: socket.data.user.hue });
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
    for (const id of io.sockets.adapter.rooms.get(roomChannel(roomId)) ?? []) {
      const member = id === socket.id ? null : io.sockets.sockets.get(id);
      if (!member) continue;
      const memberId = member.data.userId;
      member.timeout(8000).emit('room:message', message, (err) => {
        if (!err && memberId !== userId) markRoomDelivered(roomId, memberId, message.id).catch(() => {});
      });
    }
    return { message };
  }));

  // Toggle an emoji reaction on a chat or room message the person can see.
  socket.on('msg:react', handle(async ({ scope, messageId, emoji }) => {
    const id = asId(messageId);
    const e = typeof emoji === 'string' ? emoji.trim() : '';
    if (!id || (scope !== 'dm' && scope !== 'room')) throw new AppError(400, 'That message doesn’t exist.');
    if (!e || e.length > 16 || !EMOJI.test(e)) throw new AppError(400, 'Pick an emoji.');
    if (!canReact(userId)) throw new AppError(429, 'Slow down a little.');
    if (scope === 'dm') {
      const m = await one('SELECT sender_id, recipient_id FROM dm_messages WHERE id = $1', [id]);
      if (!m || (m.sender_id !== userId && m.recipient_id !== userId)) throw new AppError(404, 'That message doesn’t exist.');
      const reactions = await toggleReaction('dm', id, userId, e);
      io.to(userChannel(m.sender_id)).to(userChannel(m.recipient_id)).emit('msg:reactions', {
        scope, messageId: id, between: [m.sender_id, m.recipient_id], reactions,
      });
      return { reactions };
    }
    const m = await one(
      `SELECT m.room_id FROM room_messages m
       WHERE m.id = $1 AND EXISTS (SELECT 1 FROM room_members r WHERE r.room_id = m.room_id AND r.user_id = $2)`,
      [id, userId],
    );
    if (!m) throw new AppError(404, 'That message doesn’t exist.');
    const reactions = await toggleReaction('room', id, userId, e);
    io.to(roomChannel(m.room_id)).emit('msg:reactions', { scope, roomId: m.room_id, messageId: id, reactions });
    return { reactions };
  }));

  socket.on('room:typing', ({ roomId, typing } = {}) => {
    if (!inRoom(roomId)) return;
    socket.to(roomChannel(roomId)).emit('room:typing', {
      roomId, userId, name: socket.data.user.name, typing: !!typing,
    });
  });

  socket.on('room:read', handle(async ({ roomId, messageId }) => {
    if (!isUuid(roomId) || !Number.isSafeInteger(messageId)) return {};
    // Never past the room's newest message, so nobody can mark future messages seen.
    const { rowCount } = await query(
      `UPDATE room_members SET
         last_read_id = GREATEST(last_read_id, LEAST($3, coalesce((SELECT max(id) FROM room_messages WHERE room_id = $1), 0))),
         last_delivered_id = GREATEST(last_delivered_id, LEAST($3, coalesce((SELECT max(id) FROM room_messages WHERE room_id = $1), 0))),
         last_read_at = now()
       WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId, messageId],
    );
    if (rowCount) queueRoomReceipts(roomId, userId);
    socket.to(userChannel(userId)).emit('room:read', { roomId });
    return {};
  }));
}
