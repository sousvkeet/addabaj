import { query, one } from '../db.js';
import { COOKIE_NAME, readCookie, verifyToken } from '../auth.js';
import { limits } from '../config.js';
import { AppError, isUuid } from '../errors.js';
import { presence, roomChannel, userChannel } from '../realtime.js';
import { DM_COLUMNS, dmMessage } from '../services/dms.js';
import { roomMessage } from '../services/rooms.js';
import { findUser } from '../services/users.js';
import { calls } from './calls.js';
import { handle } from './util.js';
import { voice } from './voice.js';
import { registerWatch } from './watch.js';

function cleanBody(body) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new AppError(400, 'Type a message first.');
  if (text.length > limits.messageLength) throw new AppError(400, `Messages can be up to ${limits.messageLength} characters.`);
  return text;
}

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
    registerRoomChat(socket);
    calls.register(io, socket);
    voice.register(io, socket);
    registerWatch(socket);

    socket.on('disconnect', async () => {
      const offline = presence.remove(userId, socket.id);
      calls.handleDisconnect(socket);
      voice.handleDisconnect(socket);
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

  socket.on('dm:send', handle(async ({ to, body }) => {
    if (!isUuid(to) || to === userId) throw new AppError(400, "You can't message that person.");
    const text = cleanBody(body);
    const partner = await findUser(to);
    if (!partner) throw new AppError(404, "That person doesn't exist.");
    const row = await one(
      `INSERT INTO dm_messages (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING ${DM_COLUMNS}`,
      [userId, to, text],
    );
    const message = dmMessage(row);
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

function registerRoomChat(socket) {
  const userId = socket.data.userId;
  const inRoom = (roomId) => isUuid(roomId) && socket.rooms.has(roomChannel(roomId));

  socket.on('room:send', handle(async ({ roomId, body }) => {
    if (!isUuid(roomId)) throw new AppError(404, "That room doesn't exist.");
    const text = cleanBody(body);
    const row = await one(
      `INSERT INTO room_messages (room_id, sender_id, body)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2)
       RETURNING id, room_id, kind, body, created_at, sender_id`,
      [roomId, userId, text],
    );
    if (!row) throw new AppError(403, "You're not a member of this room anymore.");
    const message = roomMessage({ ...row, sender_name: socket.data.user.name, sender_hue: socket.data.user.hue });
    await query('UPDATE room_members SET last_read_id = $3 WHERE room_id = $1 AND user_id = $2', [roomId, userId, row.id]);
    socket.to(roomChannel(roomId)).emit('room:message', message);
    return { message };
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
