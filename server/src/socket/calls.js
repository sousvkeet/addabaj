// One-to-one voice calls. The server runs the ring/accept/end state machine
// and relays WebRTC offers, answers and ICE candidates between the two sockets.
import { randomUUID } from 'node:crypto';
import { one } from '../db.js';
import { AppError, isUuid } from '../errors.js';
import { getIO, presence, userChannel } from '../realtime.js';
import { DM_COLUMNS, dmMessage } from '../services/dms.js';
import { findUser } from '../services/users.js';
import { handle } from './util.js';
import { voice } from './voice.js';

const RING_TIMEOUT_MS = 35_000;
const active = new Map(); // callId -> call
const userCall = new Map(); // userId -> callId

function otherSocket(call, socketId) {
  if (socketId === call.callerSocket) return call.calleeSocket;
  if (socketId === call.calleeSocket) return call.callerSocket;
  return null;
}

async function recordCall(call, outcome) {
  const duration = call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
  const what = call.video ? 'video call' : 'voice call';
  const body = outcome === 'completed' ? (call.video ? 'Video call' : 'Voice call') : outcome === 'declined' ? 'Call declined' : `Missed ${what}`;
  const row = await one(
    `INSERT INTO dm_messages (sender_id, recipient_id, kind, body, meta) VALUES ($1, $2, 'call', $3, $4)
     RETURNING ${DM_COLUMNS}`,
    [call.callerId, call.calleeId, body, { outcome, duration, video: call.video }],
  );
  const message = dmMessage(row);
  const [caller, callee] = await Promise.all([findUser(call.callerId), findUser(call.calleeId)]);
  const io = getIO();
  io?.to(userChannel(call.callerId)).emit('dm:new', { message, partner: callee });
  io?.to(userChannel(call.calleeId)).emit('dm:new', { message, partner: caller });
}

function finish(call, reason) {
  if (!active.has(call.id)) return;
  clearTimeout(call.timer);
  active.delete(call.id);
  if (userCall.get(call.callerId) === call.id) userCall.delete(call.callerId);
  if (userCall.get(call.calleeId) === call.id) userCall.delete(call.calleeId);
  getIO()?.to(userChannel(call.callerId)).to(userChannel(call.calleeId)).emit('call:ended', { callId: call.id, reason });
  const outcome = call.startedAt ? 'completed' : reason === 'declined' ? 'declined' : 'missed';
  recordCall(call, outcome).catch((err) => console.error('Failed to record call', err));
}

export const calls = {
  isInCall: (userId) => userCall.has(userId),

  register(io, socket) {
    const userId = socket.data.userId;
    const getCall = (callId) => {
      const call = active.get(callId);
      if (!call || (call.callerId !== userId && call.calleeId !== userId)) {
        throw new AppError(404, 'That call has already ended.');
      }
      return call;
    };

    socket.on('call:start', handle(async ({ to, video }) => {
      if (!isUuid(to) || to === userId) throw new AppError(400, "You can't call that person.");
      if (userCall.has(userId)) throw new AppError(409, "You're already on a call.");
      const callee = await findUser(to);
      if (!callee) throw new AppError(404, "That person doesn't exist.");
      if (!presence.isOnline(to)) throw new AppError(409, `${callee.name} is offline right now. Send a message instead.`);
      if (userCall.has(to)) throw new AppError(409, `${callee.name} is on another call.`);

      voice.leaveAny(userId);
      const call = {
        id: randomUUID(),
        callerId: userId,
        calleeId: to,
        callerSocket: socket.id,
        calleeSocket: null,
        startedAt: null,
        // Whether the caller asked for video; either side can turn its camera on later.
        video: !!video,
      };
      call.timer = setTimeout(() => finish(call, 'missed'), RING_TIMEOUT_MS);
      active.set(call.id, call);
      userCall.set(userId, call.id);
      userCall.set(to, call.id);
      io.to(userChannel(to)).emit('call:incoming', { callId: call.id, from: socket.data.user, video: call.video });
      return { callId: call.id };
    }));

    socket.on('call:accept', handle(async ({ callId, video }) => {
      const call = getCall(callId);
      if (call.calleeId !== userId || call.calleeSocket) throw new AppError(409, 'That call was already answered.');
      clearTimeout(call.timer);
      voice.leaveAny(userId);
      call.calleeSocket = socket.id;
      call.startedAt = Date.now();
      io.to(call.callerSocket).emit('call:accepted', { callId, video: !!video });
      socket.to(userChannel(userId)).emit('call:dismissed', { callId });
      return {};
    }));

    socket.on('call:decline', handle(async ({ callId }) => {
      const call = getCall(callId);
      finish(call, call.calleeId === userId ? 'declined' : 'cancelled');
      return {};
    }));

    socket.on('call:end', handle(async ({ callId }) => {
      const call = getCall(callId);
      if (!call.startedAt) finish(call, call.callerId === userId ? 'cancelled' : 'declined');
      else finish(call, 'ended');
      return {};
    }));

    socket.on('call:signal', ({ callId, data } = {}) => {
      const call = active.get(callId);
      const target = call && otherSocket(call, socket.id);
      if (target) io.to(target).emit('call:signal', { callId, data });
    });

    socket.on('call:mute', ({ callId, muted } = {}) => {
      const call = active.get(callId);
      const target = call && otherSocket(call, socket.id);
      if (target) io.to(target).emit('call:peer-mute', { callId, muted: !!muted });
    });

    socket.on('call:camera', ({ callId, on } = {}) => {
      const call = active.get(callId);
      if (!call) return;
      if (on) call.video = true;
      const target = otherSocket(call, socket.id);
      if (target) io.to(target).emit('call:peer-camera', { callId, on: !!on });
    });
  },

  handleDisconnect(socket) {
    const userId = socket.data.userId;
    const call = active.get(userCall.get(userId));
    if (!call) return;
    if (socket.id === call.callerSocket || socket.id === call.calleeSocket) {
      finish(call, call.startedAt ? 'dropped' : 'cancelled');
    } else if (!call.calleeSocket && call.calleeId === userId && !presence.isOnline(userId)) {
      finish(call, 'missed');
    }
  },
};
