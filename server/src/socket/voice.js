// Room voice ("live adda") and video: a full mesh of WebRTC peer connections.
// The server only tracks who is in which voice room (muted, camera on) and
// relays signalling messages.
import { one } from '../db.js';
import { limits } from '../config.js';
import { AppError, isUuid } from '../errors.js';
import { getIO, roomChannel } from '../realtime.js';
import { calls } from './calls.js';
import { handle } from './util.js';

const rooms = new Map(); // roomId -> Map<userId, { socketId, muted, camera }>
const userRoom = new Map(); // userId -> roomId

function participants(roomId) {
  const room = rooms.get(roomId);
  return room ? [...room].map(([userId, p]) => ({ userId, muted: p.muted, camera: p.camera })) : [];
}

function broadcastState(roomId) {
  getIO()?.to(roomChannel(roomId)).emit('voice:state', { roomId, participants: participants(roomId) });
}

function leave(userId, roomId) {
  const room = rooms.get(roomId);
  if (!room?.has(userId)) return;
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

  /** Pull a user out of whatever voice room they're in (e.g. they took a call). */
  leaveAny(userId) {
    const roomId = userRoom.get(userId);
    if (roomId) leave(userId, roomId);
  },

  register(io, socket) {
    const userId = socket.data.userId;

    socket.on('voice:join', handle(async ({ roomId, muted, camera }) => {
      if (!isUuid(roomId)) throw new AppError(404, "That room doesn't exist.");
      const member = await one('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
      if (!member) throw new AppError(403, "You're not a member of this room.");
      if (calls.isInCall(userId)) throw new AppError(409, 'End your call before joining voice.');

      const current = userRoom.get(userId);
      if (current) {
        const mine = rooms.get(current)?.get(userId);
        if (current === roomId && mine?.socketId === socket.id) return { peers: participants(roomId).filter((p) => p.userId !== userId) };
        if (mine && mine.socketId !== socket.id) io.to(mine.socketId).emit('voice:kicked', { roomId: current, reason: 'elsewhere' });
        leave(userId, current);
      }

      let room = rooms.get(roomId);
      if (!room) rooms.set(roomId, (room = new Map()));
      if (room.size >= limits.voiceSeats) {
        throw new AppError(409, `Voice is full (${limits.voiceSeats} people). Try again when someone leaves.`);
      }
      const peers = participants(roomId);
      room.set(userId, { socketId: socket.id, muted: !!muted, camera: !!camera });
      userRoom.set(userId, roomId);
      for (const p of room.values()) {
        if (p.socketId !== socket.id) io.to(p.socketId).emit('voice:peer-joined', { roomId, userId });
      }
      broadcastState(roomId);
      return { peers };
    }));

    socket.on('voice:signal', ({ roomId, to, data } = {}) => {
      if (userRoom.get(userId) !== roomId) return;
      const target = rooms.get(roomId)?.get(to);
      if (target) io.to(target.socketId).emit('voice:signal', { roomId, from: userId, data });
    });

    socket.on('voice:mute', ({ roomId, muted } = {}) => {
      const p = rooms.get(roomId)?.get(userId);
      if (!p || p.socketId !== socket.id) return;
      p.muted = !!muted;
      broadcastState(roomId);
    });

    // Whose camera is on: everyone's call window shows their video (or their photo).
    socket.on('voice:camera', ({ roomId, on } = {}) => {
      const p = rooms.get(roomId)?.get(userId);
      if (!p || p.socketId !== socket.id || p.camera === !!on) return;
      p.camera = !!on;
      broadcastState(roomId);
    });

    socket.on('voice:leave', ({ roomId } = {}) => {
      const p = rooms.get(roomId)?.get(userId);
      if (p?.socketId === socket.id) leave(userId, roomId);
    });
  },

  handleDisconnect(socket) {
    const userId = socket.data.userId;
    const roomId = userRoom.get(userId);
    if (roomId && rooms.get(roomId)?.get(userId)?.socketId === socket.id) leave(userId, roomId);
  },
};
