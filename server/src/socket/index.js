import { query, one, transaction } from '../db.js';
import { COOKIE_NAME, readCookie, verifyToken } from '../auth.js';
import { limits } from '../config.js';
import { AppError, isUuid } from '../errors.js';
import { presence, roomChannel, userChannel } from '../realtime.js';
import { DM_COLUMNS, dmMessage } from '../services/dms.js';
import { roomMessage } from '../services/rooms.js';
import { findUser } from '../services/users.js';
import { enrich, toggleReaction } from '../services/messages.js';
import { linkAttachment } from '../services/uploads.js';
import { calls } from './calls.js';
import { live } from './live.js';
import { handle } from './util.js';
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
        if (!presence.isOnline(userId)) {
          io.emit('presence:update', { userId, online: false, lastSeenAt: row?.last_seen_at ?? new Date() });
        }
      }
    });

    socket.join(userChannel(userId));
    if (presence.add(userId, socket.id)) socket.broadcast.emit('presence:update', { userId, online: true });
    socket.emit('presence:snapshot', { online: presence.list() });

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
    const text = cleanBody(body, !!attachmentId);
    const partner = await findUser(to);
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
    io.to(userChannel(to)).emit('dm:new', { message, partner: { ...socket.data.user, online: true, lastSeenAt: null } });
    socket.to(userChannel(userId)).emit('dm:new', { message, partner });
    return { message };
  }));

  socket.on('dm:typing', ({ to, typing } = {}) => {
    if (isUuid(to)) socket.to(userChannel(to)).emit('dm:typing', { from: userId, typing: !!typing });
  });

  socket.on('dm:read', handle(async ({ partnerId }) => {
    if (!isUuid(partnerId)) return {};
    const { rowCount } = await query(
      `UPDATE dm_messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
      [userId, partnerId],
    );
    const event = { readerId: userId, partnerId, readAt: new Date() };
    socket.to(userChannel(userId)).emit('dm:read', event);
    if (rowCount) io.to(userChannel(partnerId)).emit('dm:read', event);
    return {};
  }));
}

function registerRoomChat(io, socket) {
  const userId = socket.data.userId;
  const inRoom = (roomId) => isUuid(roomId) && socket.rooms.has(roomChannel(roomId));

  socket.on('room:send', handle(async ({ roomId, body, attachmentId, replyTo }) => {
    if (!isUuid(roomId)) throw new AppError(404, "That room doesn't exist.");
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
    await query('UPDATE room_members SET last_read_id = $3 WHERE room_id = $1 AND user_id = $2', [roomId, userId, message.id]);
    socket.to(roomChannel(roomId)).emit('room:message', message);
    return { message };
  }));

  // Toggle an emoji reaction on a chat or room message the person can see.
  socket.on('msg:react', handle(async ({ scope, messageId, emoji }) => {
    const id = asId(messageId);
    const e = typeof emoji === 'string' ? emoji.trim() : '';
    if (!id || (scope !== 'dm' && scope !== 'room')) throw new AppError(400, 'That message doesn’t exist.');
    if (!e || e.length > 16 || !EMOJI.test(e)) throw new AppError(400, 'Pick an emoji.');
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
    await query(
      `UPDATE room_members SET last_read_id = GREATEST(last_read_id, $3) WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId, messageId],
    );
    socket.to(userChannel(userId)).emit('room:read', { roomId });
    return {};
  }));
}
