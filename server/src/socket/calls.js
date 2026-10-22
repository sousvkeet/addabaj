// One-to-one voice calls. The server runs the ring/accept/end state machine
// and relays WebRTC offers, answers and ICE candidates between the two sockets.
// Someone whose app is closed or in the background is rung on their phone
// (a push notification); their app joins the call when they answer there.
import { randomUUID } from 'node:crypto';
import { one } from '../db.js';
import { AppError, isUuid } from '../errors.js';
import { blockedEitherWay, blockedMessage } from '../services/blocks.js';
import { getIO, presence, userChannel } from '../realtime.js';
import { DM_COLUMNS, dmMessage } from '../services/dms.js';
import { findUser } from '../services/users.js';
import { hasDevices, isLooking, pushCall, pushCallEnded } from '../services/push.js';
import { handle, rateLimiter } from './util.js';
import { voice } from './voice.js';

const RING_TIMEOUT_MS = 35_000;
// A phone woken by a push needs a little longer: unlock, open, connect.
const PHONE_RING_TIMEOUT_MS = 45_000;
// Answered, but the caller's app never connected (it hung up as it was placed, or went away).
const CONNECT_TIMEOUT_MS = 30_000;
// Ringing someone's phone is loud: 5 calls a minute per caller.
const canCall = rateLimiter(5, 60_000);
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
  const [caller, callee] = await Promise.all([findUser(call.callerId, call.calleeId), findUser(call.calleeId, call.callerId)]);
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
  if (call.pushed && !call.startedAt) pushCallEnded(call, call.caller, reason);
  const outcome = call.startedAt ? 'completed' : reason === 'declined' ? 'declined' : 'missed';
  recordCall(call, outcome).catch((err) => console.error('Failed to record call', err));
}

export const calls = {
  isInCall: (userId) => userCall.has(userId),
  activeCount: () => active.size,

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
      if (!canCall(userId)) throw new AppError(429, "You're calling too often. Wait a minute and try again.");
      const callee = await findUser(to);
      if (!callee) throw new AppError(404, "That person doesn't exist.");
      if (blockedEitherWay(userId, to)) throw new AppError(403, blockedMessage(userId, to, callee.name, 'call'));
      // Offline is fine when their phone can ring.
      if (!presence.isOnline(to) && !(await hasDevices(to))) {
        throw new AppError(409, `${callee.name} is offline right now. Send a message instead.`);
      }
      if (userCall.has(to)) throw new AppError(409, `${callee.name} is on another call.`);
      // Gone while those were looked up: there's nobody to ring them for.
      if (socket.disconnected || userCall.has(userId)) throw new AppError(409, 'The call was cancelled.');

      voice.leaveAny(userId);
      const call = {
        id: randomUUID(),
        callerId: userId,
        calleeId: to,
        callerSocket: socket.id,
        calleeSocket: null,
        caller: socket.data.user,
        startedAt: null,
        // Whether the caller asked for video; either side can turn its camera on later.
        video: !!video,
      };
      call.timer = setTimeout(() => finish(call, 'missed'), RING_TIMEOUT_MS);
      active.set(call.id, call);
      userCall.set(userId, call.id);
      userCall.set(to, call.id);
      io.to(userChannel(to)).emit('call:incoming', { callId: call.id, from: socket.data.user, video: call.video });
      // Not looking at the app anywhere: ring their phones. Marked first, so
      // answering or ending the call meanwhile also reaches the phones.
      if (!isLooking(to) && (await hasDevices(to)) && active.has(call.id) && !call.startedAt) {
        call.pushed = true;
        clearTimeout(call.timer);
        call.timer = setTimeout(() => finish(call, 'missed'), PHONE_RING_TIMEOUT_MS);
        void pushCall(call, socket.data.user);
      }
      return { callId: call.id };
    }));

    socket.on('call:accept', handle(async ({ callId, video }) => {
      const call = getCall(callId);
      if (call.calleeId !== userId || call.calleeSocket) throw new AppError(409, 'That call was already answered.');
      clearTimeout(call.timer);
      voice.leaveAny(userId);
      call.calleeSocket = socket.id;
      call.startedAt = Date.now();
      call.timer = setTimeout(() => {
        if (!call.callerConnected) finish(call, 'dropped');
      }, CONNECT_TIMEOUT_MS);
      io.to(call.callerSocket).emit('call:accepted', { callId, video: !!video });
      socket.to(userChannel(userId)).emit('call:dismissed', { callId });
      // Other phones stop ringing.
      if (call.pushed) pushCallEnded(call, call.caller, 'answered');
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
      if (!target) return;
      if (socket.id === call.callerSocket) call.callerConnected = true;
      io.to(target).emit('call:signal', { callId, data });
    });

    socket.on('call:mute', ({ callId, muted } = {}) => {
      const call = active.get(callId);
      const target = call && otherSocket(call, socket.id);
      if (target) io.to(target).emit('call:peer-mute', { callId, muted: !!muted });
    });

    socket.on('call:camera', ({ callId, on } = {}) => {
      const call = active.get(callId);
      // Only from someone in the call.
      const target = call && otherSocket(call, socket.id);
      if (!target) return;
      if (on) call.video = true;
      io.to(target).emit('call:peer-camera', { callId, on: !!on });
    });
  },

  /** Declined from the phone's notification, without opening the app. */
  decline(userId, callId) {
    const call = active.get(callId);
    if (!call || call.calleeId !== userId) throw new AppError(404, 'That call has already ended.');
    if (call.startedAt) throw new AppError(409, 'That call was already answered.');
    finish(call, 'declined');
  },

  /** An app that connects while its person's phone is ringing gets the call. */
  handleConnect(socket) {
    const call = active.get(userCall.get(socket.data.userId));
    if (call && call.calleeId === socket.data.userId && !call.calleeSocket) {
      socket.emit('call:incoming', { callId: call.id, from: call.caller, video: call.video });
    }
  },

  handleDisconnect(socket) {
    const userId = socket.data.userId;
    const call = active.get(userCall.get(userId));
    if (!call) return;
    if (socket.id === call.callerSocket || socket.id === call.calleeSocket) {
      finish(call, call.startedAt ? 'dropped' : 'cancelled');
    } else if (!call.calleeSocket && call.calleeId === userId && !presence.isOnline(userId) && !call.pushed) {
      // (A phone that was rung keeps ringing: its app may just be asleep.)
      finish(call, 'missed');
    }
  },
};
