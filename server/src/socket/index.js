import { one, query } from '../db.js';
import { COOKIE_NAME, readCookie, readToken } from '../auth.js';
import { touchSession } from '../services/sessions.js';
import { AppError, isUuid } from '../errors.js';
import { presence, roomChannel, userChannel } from '../realtime.js';
import { findUser } from '../services/users.js';
import { hidesPresence } from '../services/privacy.js';
import { onlineContacts, tellContacts } from '../services/presence.js';
import { asId, deleteMessage, editMessage, forwardMessage, readDm, readRoom, sendDm, sendRoomMessage } from '../services/chat.js';
import { blockedEitherWay } from '../services/blocks.js';
import { markAllRoomsDelivered, markDmDelivered } from './receipts.js';
import { toggleReaction } from '../services/messages.js';
import { calls } from './calls.js';
import { live } from './live.js';
import { guardSocket, handle, rateLimiter } from './util.js';
import { voice } from './voice.js';
import { registerWatch } from './watch.js';
import { registerQueue } from './queue.js';

/**
 * Someone whose last connection dropped shows as offline only after this:
 * back on a new one in time (switching from mobile data to Wi-Fi), they were
 * never offline to their contacts.
 */
const OFFLINE_AFTER_MS = 6000;

// Stops reaction, delete and edit floods: 30 per 10 s per person.
const canReact = rateLimiter(30, 10_000);
const canDelete = rateLimiter(30, 10_000);
const canEdit = rateLimiter(30, 10_000);
// A forward is a handful of sends (each counted as a message too).
const canForward = rateLimiter(10, 10_000);

// One emoji, nothing else: a picture (with skin tones, joiners and variation
// parts), a flag, or a keycap like 1️⃣ (but not plain digits, # or *).
const PICTURE = String.raw`\p{Extended_Pictographic}[\p{Emoji_Modifier}\ufe0f\u{e0020}-\u{e007f}]*`;
const EMOJI = new RegExp(String.raw`^(?:${PICTURE}(?:\u200d${PICTURE})*|\p{Regional_Indicator}{2}|[0-9#*]\ufe0f?\u20e3)$`, 'u');

export function initSocket(io) {
  io.use(async (socket, next) => {
    const login = readToken(readCookie(socket.handshake.headers.cookie, COOKIE_NAME));
    const user = login && (await findUser(login.userId).catch(() => null));
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    // Which device (Settings › Devices), so logging it out also closes this connection.
    socket.data.sid = login.sessionId;
    touchSession(login.sessionId, null);
    socket.data.user = { id: user.id, name: user.name, hue: user.hue, photo: user.photo };
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
    registerQueue(socket);
    live.register(socket);

    // Whether this app or tab is on screen and in use. Phones only get a push
    // when none of the person's apps or tabs is.
    socket.on('client:state', ({ active } = {}) => {
      socket.data.active = active !== false;
    });

    socket.on('disconnect', async () => {
      const offline = presence.remove(userId, socket.id);
      calls.handleDisconnect(socket);
      voice.handleDisconnect(socket);
      live.handleDisconnect(socket);
      if (!offline) return;
      const at = new Date();
      setTimeout(async () => {
        if (presence.isOnline(userId)) return;
        const row = await one('UPDATE users SET last_seen_at = $2 WHERE id = $1 RETURNING last_seen_at', [userId, at]).catch(() => null);
        if (!presence.isOnline(userId) && !hidesPresence(userId)) {
          await tellContacts(userId, { userId, online: false, lastSeenAt: row?.last_seen_at ?? at }).catch(() => {});
        }
      }, OFFLINE_AFTER_MS);
    });

    socket.join(userChannel(userId));
    // Online status: to and from contacts only (people they chat with or share a room with).
    const sharing = !hidesPresence(userId);
    const first = presence.add(userId, socket.id);
    if (first && sharing) tellContacts(userId, { userId, online: true }).catch((err) => console.error('Presence update failed', err));
    onlineContacts(userId)
      .then((online) => socket.emit('presence:snapshot', { online }))
      .catch((err) => console.error('Presence snapshot failed', err));
    // A call that rang this person's phone while the app was closed.
    calls.handleConnect(socket);

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

  socket.on('dm:send', handle(async (input) => ({ message: await sendDm(userId, input.to, input, socket.id) })));

  socket.on('dm:typing', ({ to, typing } = {}) => {
    if (isUuid(to) && !blockedEitherWay(userId, to)) socket.to(userChannel(to)).emit('dm:typing', { from: userId, typing: !!typing });
  });

  socket.on('dm:read', handle(async ({ partnerId }) => {
    await readDm(userId, partnerId, socket.id);
    return {};
  }));
}

function registerRoomChat(io, socket) {
  const userId = socket.data.userId;
  const inRoom = (roomId) => isUuid(roomId) && socket.rooms.has(roomChannel(roomId));

  socket.on('room:send', handle(async (input) => ({
    message: await sendRoomMessage(socket.data.user, input.roomId, input, socket.id),
  })));

  // Toggle an emoji reaction on a chat or room message the person can see.
  socket.on('msg:react', handle(async ({ scope, messageId, emoji }) => {
    const id = asId(messageId);
    const e = typeof emoji === 'string' ? emoji.trim() : '';
    if (!id || (scope !== 'dm' && scope !== 'room')) throw new AppError(400, 'That message doesn’t exist.');
    if (!e || e.length > 16 || !EMOJI.test(e)) throw new AppError(400, 'Pick an emoji.');
    if (!canReact(userId)) throw new AppError(429, 'Slow down a little.');
    if (scope === 'dm') {
      const m = await one('SELECT sender_id, recipient_id, deleted_at FROM dm_messages WHERE id = $1', [id]);
      if (!m || (m.sender_id !== userId && m.recipient_id !== userId)) throw new AppError(404, 'That message doesn’t exist.');
      if (m.deleted_at) throw new AppError(409, 'That message was deleted.');
      if (blockedEitherWay(m.sender_id, m.recipient_id)) throw new AppError(403, "You can't message this person.");
      const reactions = await toggleReaction('dm', id, userId, e);
      io.to(userChannel(m.sender_id)).to(userChannel(m.recipient_id)).emit('msg:reactions', {
        scope, messageId: id, between: [m.sender_id, m.recipient_id], reactions,
      });
      return { reactions };
    }
    const m = await one(
      `SELECT m.room_id, m.deleted_at FROM room_messages m
       WHERE m.id = $1 AND EXISTS (SELECT 1 FROM room_members r WHERE r.room_id = m.room_id AND r.user_id = $2)`,
      [id, userId],
    );
    if (!m) throw new AppError(404, 'That message doesn’t exist.');
    if (m.deleted_at) throw new AppError(409, 'That message was deleted.');
    const reactions = await toggleReaction('room', id, userId, e);
    io.to(roomChannel(m.room_id)).emit('msg:reactions', { scope, roomId: m.room_id, messageId: id, reactions });
    return { reactions };
  }));

  // Delete a chat or room message for yourself, or for everyone (see services/chat.js).
  socket.on('msg:delete', handle(async ({ scope, messageId, forEveryone }) => {
    if (!canDelete(userId)) throw new AppError(429, 'Slow down a little.');
    return deleteMessage(socket.data.user, { scope, messageId, forEveryone: forEveryone === true });
  }));

  // Change what one of my messages says (see services/chat.js).
  socket.on('msg:edit', handle(async ({ scope, messageId, body, mentions }) => {
    if (!canEdit(userId)) throw new AppError(429, 'Slow down a little.');
    return editMessage(socket.data.user, { scope, messageId, body, mentions });
  }));

  // Send a copy of a message to other chats and rooms: { results: [{ scope, id, ok, error? }] }.
  socket.on('msg:forward', handle(async ({ scope, messageId, to }) => {
    if (!canForward(userId)) throw new AppError(429, 'Slow down a little.');
    return forwardMessage(socket.data.user, { scope, messageId, to });
  }));

  socket.on('room:typing', ({ roomId, typing } = {}) => {
    if (!inRoom(roomId)) return;
    socket.to(roomChannel(roomId)).emit('room:typing', {
      roomId, userId, name: socket.data.user.name, typing: !!typing,
    });
  });

  socket.on('room:read', handle(async ({ roomId, messageId }) => {
    if (Number.isSafeInteger(messageId)) await readRoom(userId, roomId, messageId, socket.id);
    return {};
  }));
}
