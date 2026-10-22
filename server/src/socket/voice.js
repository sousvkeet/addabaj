// Room voice ("live adda") and video: a full mesh of WebRTC peer connections.
// The server only tracks who is in which voice room (muted, camera on) and
// relays signalling messages. Someone whose connection drops (switching from
// mobile data to Wi-Fi, a tunnel) keeps their seat for a while, shown as
// reconnecting, and takes it back on their new connection (voice:join with
// `resume`), as in other messengers. Room admins can mute someone (they can't
// unmute) or stop their camera (they can't turn it on) until they let them:
// kept on the member, so it holds when they come back too.
import { one } from '../db.js';
import { limits } from '../config.js';
import { AppError, isUuid } from '../errors.js';
import { getIO, roomChannel } from '../realtime.js';
import { calls } from './calls.js';
import { handle } from './util.js';

/** How long a seat waits for someone whose connection dropped. */
const AWAY_MS = 45_000;

const rooms = new Map(); // roomId -> Map<userId, { socketId, muted, camera, silenced, cameraBlocked, awayTimer }>
const userRoom = new Map(); // userId -> roomId

function participants(roomId) {
  const room = rooms.get(roomId);
  return room
    ? [...room].map(([userId, p]) => ({
        userId,
        muted: p.muted,
        camera: p.camera,
        ...(p.awayTimer ? { away: true } : {}),
        // An admin muted them, or stopped their camera: everyone's app keeps them quiet, or off camera.
        ...(p.silenced ? { silenced: true } : {}),
        ...(p.cameraBlocked ? { cameraBlocked: true } : {}),
      }))
    : [];
}

function broadcastState(roomId) {
  getIO()?.to(roomChannel(roomId)).emit('voice:state', { roomId, participants: participants(roomId) });
}

function leave(userId, roomId) {
  const room = rooms.get(roomId);
  if (!room?.has(userId)) return;
  clearTimeout(room.get(userId).awayTimer);
  room.delete(userId);
  if (userRoom.get(userId) === roomId) userRoom.delete(userId);
  if (room.size === 0) rooms.delete(roomId);
  const io = getIO();
  for (const peer of room.values()) io?.to(peer.socketId).emit('voice:peer-left', { roomId, userId });
  broadcastState(roomId);
}

export const voice = {
  participants,
  totalParticipants: () => userRoom.size,
  isInVoice: (userId) => userRoom.has(userId),

  snapshot(roomIds) {
    return Object.fromEntries(roomIds.map((id) => [id, participants(id)]));
  },

  /** Force someone out of a room's voice (removed from room, room deleted). */
  kick(roomId, userId, reason) {
    const p = rooms.get(roomId)?.get(userId);
    if (!p) return;
    getIO()?.to(p.socketId).emit('voice:kicked', { roomId, reason });
    leave(userId, roomId);
  },

  /** An admin muted them or stopped their camera (or let them again): it holds right away if they're in voice. */
  moderate(roomId, userId, { voiceMuted, cameraBlocked }) {
    const p = rooms.get(roomId)?.get(userId);
    if (!p) return;
    p.silenced = voiceMuted;
    p.cameraBlocked = cameraBlocked;
    if (voiceMuted) p.muted = true;
    if (cameraBlocked) p.camera = false;
    broadcastState(roomId);
  },

  /** Pull a user out of whatever voice room they're in (e.g. they took a call). */
  leaveAny(userId) {
    const roomId = userRoom.get(userId);
    if (roomId) leave(userId, roomId);
  },

  register(io, socket) {
    const userId = socket.data.userId;

    // `resume`: back on a new connection after the last one dropped (`from`
    // is its id): the same seat, without joining again. `resumed` says whether
    // it was still there (otherwise this joined afresh).
    socket.on('voice:join', handle(async ({ roomId, muted, camera, resume, from }) => {
      if (!isUuid(roomId)) throw new AppError(404, "That room doesn't exist.");
      const member = await one('SELECT voice_muted, camera_blocked FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
      if (!member) throw new AppError(403, "You're not a member of this room.");
      // What an admin decided holds from the start.
      const moderation = { voiceMuted: member.voice_muted, cameraBlocked: member.camera_blocked };
      muted = !!muted || moderation.voiceMuted;
      camera = !!camera && !moderation.cameraBlocked;
      if (calls.isInCall(userId)) throw new AppError(409, 'End your call before joining voice.');

      const current = userRoom.get(userId);
      if (current) {
        const mine = rooms.get(current)?.get(userId);
        const others = () => participants(roomId).filter((p) => p.userId !== userId);
        if (current === roomId && mine?.socketId === socket.id) return { peers: others(), resumed: true, moderation };
        if (resume && current === roomId && mine) {
          // Taken by another tab or device meanwhile: that one has the seat now.
          if (mine.socketId !== from) throw new AppError(409, 'You joined voice from another tab, so this one left.');
          clearTimeout(mine.awayTimer);
          mine.awayTimer = null;
          mine.socketId = socket.id;
          mine.muted = muted;
          mine.camera = camera;
          mine.silenced = moderation.voiceMuted;
          mine.cameraBlocked = moderation.cameraBlocked;
          // The old connection is dead (the server just may not have noticed yet).
          if (from !== socket.id) io.sockets.sockets.get(from)?.disconnect(true);
          broadcastState(roomId);
          return { peers: others(), resumed: true, moderation };
        }
        if (mine && mine.socketId !== socket.id) io.to(mine.socketId).emit('voice:kicked', { roomId: current, reason: 'elsewhere' });
        leave(userId, current);
      }

      let room = rooms.get(roomId);
      if (!room) rooms.set(roomId, (room = new Map()));
      if (room.size >= limits.voiceSeats) {
        throw new AppError(409, `Voice is full (${limits.voiceSeats} people). Try again when someone leaves.`);
      }
      const peers = participants(roomId);
      room.set(userId, { socketId: socket.id, muted, camera, silenced: moderation.voiceMuted, cameraBlocked: moderation.cameraBlocked });
      userRoom.set(userId, roomId);
      for (const p of room.values()) {
        if (p.socketId !== socket.id) io.to(p.socketId).emit('voice:peer-joined', { roomId, userId });
      }
      broadcastState(roomId);
      return { peers, resumed: false, moderation };
    }));

    socket.on('voice:signal', ({ roomId, to, data } = {}) => {
      if (userRoom.get(userId) !== roomId) return;
      const target = rooms.get(roomId)?.get(to);
      if (target) io.to(target.socketId).emit('voice:signal', { roomId, from: userId, data });
    });

    socket.on('voice:mute', ({ roomId, muted } = {}) => {
      const p = rooms.get(roomId)?.get(userId);
      if (!p || p.socketId !== socket.id) return;
      // Muted by an admin: stays muted (the app hears so again).
      if (p.silenced && !muted) {
        socket.emit('voice:moderated', { roomId, voiceMuted: true, cameraBlocked: !!p.cameraBlocked });
        return;
      }
      p.muted = !!muted;
      broadcastState(roomId);
    });

    // Whose camera is on: everyone's call window shows their video (or their photo).
    socket.on('voice:camera', ({ roomId, on } = {}) => {
      const p = rooms.get(roomId)?.get(userId);
      if (!p || p.socketId !== socket.id || p.camera === !!on) return;
      // Stopped by an admin: stays off.
      if (p.cameraBlocked && on) {
        socket.emit('voice:moderated', { roomId, voiceMuted: !!p.silenced, cameraBlocked: true });
        return;
      }
      p.camera = !!on;
      broadcastState(roomId);
    });

    socket.on('voice:leave', ({ roomId } = {}) => {
      const p = rooms.get(roomId)?.get(userId);
      if (p?.socketId === socket.id) leave(userId, roomId);
    });
  },

  /** A dropped connection keeps its seat for a while (see AWAY_MS); everyone sees them reconnecting. */
  handleDisconnect(socket) {
    const userId = socket.data.userId;
    const roomId = userRoom.get(userId);
    const p = roomId && rooms.get(roomId)?.get(userId);
    if (!p || p.socketId !== socket.id) return;
    clearTimeout(p.awayTimer);
    p.awayTimer = setTimeout(() => leave(userId, roomId), AWAY_MS);
    broadcastState(roomId);
  },
};
