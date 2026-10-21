// Live streams from an admin's device: a video file playing in their browser,
// or their screen. The media goes straight from the host's browser to each
// viewer over WebRTC; the server only keeps the room's watch state, decides
// who may watch, and relays the connection setup between host and viewers.
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { limits } from '../config.js';
import { AppError } from '../errors.js';
import { getIO } from '../realtime.js';
import { postSystemMessage, requireAdmin, requireMember } from '../services/rooms.js';
import { cleanPosition, getWatch, saveWatch } from '../services/watch.js';
import { handle } from './util.js';
import { replaceWatch } from './watch.js';

/** How long a host whose connection dropped has to come back before the stream ends. */
const HOST_GRACE_MS = 15_000;

/**
 * roomId -> {
 *   id, roomId, hostId, hostName,
 *   hostSocket: socket id, or null while the host is reconnecting,
 *   viewers: Map<socketId, userId>,
 *   waiting: Set<socketId> (asked to watch while the host was reconnecting),
 *   grace: timer,
 * }
 */
const sessions = new Map();

const emitTo = (socketId, event, payload) => getIO()?.to(socketId).emit(event, payload);

function cleanTitle(value, fallback) {
  const t = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return (t || fallback).slice(0, 200);
}

/** Forgets a session and tells its host and viewers it's over. Doesn't touch the saved watch state. */
function close(session, reason) {
  if (sessions.get(session.roomId) !== session) return;
  sessions.delete(session.roomId);
  clearTimeout(session.grace);
  if (session.hostSocket) emitTo(session.hostSocket, 'live:ended', { roomId: session.roomId, sessionId: session.id, reason });
  for (const viewer of session.viewers.keys()) emitTo(viewer, 'live:ended', { roomId: session.roomId, sessionId: session.id, reason });
}

/** Ends a session and clears the room's video, if the room is still showing this session. */
async function finish(session, reason, message) {
  close(session, reason);
  const watch = await getWatch(session.roomId);
  if (watch?.source?.device?.sessionId !== session.id) return;
  await saveWatch(session.roomId, null);
  if (message) await postSystemMessage(session.roomId, message);
}

function removeViewer(session, socketId) {
  if (!session.viewers.delete(socketId)) return;
  session.waiting.delete(socketId);
  if (session.hostSocket) emitTo(session.hostSocket, 'live:viewer-left', { roomId: session.roomId, viewer: socketId });
}

export const live = {
  count: () => sessions.size,

  /** The room's video was changed or stopped some other way: close its live session. */
  closeRoom(roomId, reason) {
    const session = sessions.get(roomId);
    if (session) close(session, reason);
  },

  /** Someone was removed from the room (or it was deleted). */
  dropUser(roomId, userId, reason) {
    const session = sessions.get(roomId);
    if (!session) return;
    if (session.hostId === userId) {
      if (reason === 'deleted') close(session, 'deleted');
      else finish(session, 'removed', `${session.hostName}'s live stream ended`).catch((err) => console.error('Could not end a live stream', err));
      return;
    }
    for (const [socketId, viewerId] of session.viewers) {
      if (viewerId !== userId) continue;
      removeViewer(session, socketId);
      emitTo(socketId, 'live:ended', { roomId, sessionId: session.id, reason: 'removed' });
    }
  },

  /** After a restart no host is connected, so live streams saved before it are over. */
  async clearStale() {
    await query(`UPDATE rooms SET watch = NULL WHERE watch -> 'source' ->> 'kind' = 'device'`);
  },

  register(socket) {
    const user = socket.data.user;

    socket.on('live:start', handle(async ({ roomId, mode, title, duration, audio }) => {
      await requireAdmin(roomId, user.id);
      if (mode !== 'file' && mode !== 'screen') throw new AppError(400, 'Choose a video file or your screen to stream.');
      const session = {
        id: randomUUID(),
        roomId,
        hostId: user.id,
        hostName: user.name,
        hostSocket: socket.id,
        viewers: new Map(),
        waiting: new Set(),
        grace: null,
      };
      const previous = sessions.get(roomId);
      sessions.set(roomId, session);
      if (previous) close(previous, 'replaced');

      const length = Number(duration);
      const name = cleanTitle(title, mode === 'screen' ? `${user.name}'s screen` : 'A video');
      const watch = {
        source: {
          kind: 'device',
          url: '',
          title: name,
          detail: mode === 'screen' ? 'shared live' : `from ${user.name}'s device`,
          device: {
            sessionId: session.id,
            hostId: user.id,
            hostName: user.name,
            mode,
            duration: mode === 'file' && Number.isFinite(length) && length > 0 ? length : null,
            audio: !!audio,
          },
        },
        playing: true,
        position: 0,
        at: Date.now(),
        by: user.id,
        byName: user.name,
      };
      await replaceWatch(roomId, watch, { keepLive: true });
      await postSystemMessage(
        roomId,
        mode === 'screen' ? `${user.name} is sharing their screen live` : `${user.name} is streaming “${name}” live from their device`,
      );
      return { sessionId: session.id, maxViewers: limits.liveViewers };
    }));

    // The host's file was played, paused or moved: viewers show it on their progress bar.
    socket.on('live:progress', handle(async ({ roomId, playing, position }) => {
      const session = sessions.get(roomId);
      if (!session || session.hostSocket !== socket.id) throw new AppError(409, 'Your live stream has ended.');
      const watch = await getWatch(roomId);
      if (watch?.source?.device?.sessionId !== session.id) throw new AppError(409, 'Your live stream has ended.');
      await saveWatch(roomId, { ...watch, playing: !!playing, position: cleanPosition(position), at: Date.now() });
      return {};
    }));

    socket.on('live:stop', handle(async ({ roomId }) => {
      const session = sessions.get(roomId);
      if (!session || session.hostSocket !== socket.id) return {};
      await finish(session, 'stopped', `${user.name} ended the live stream`);
      return {};
    }));

    // The host's connection came back (same tab): keep the stream going.
    socket.on('live:resume', handle(async ({ roomId, sessionId }) => {
      const session = sessions.get(roomId);
      if (!session || session.id !== sessionId || session.hostId !== user.id) throw new AppError(409, 'Your live stream ended while you were offline.');
      clearTimeout(session.grace);
      session.hostSocket = socket.id;
      for (const viewer of session.waiting) {
        emitTo(socket.id, 'live:viewer', { roomId, viewer, userId: session.viewers.get(viewer) });
      }
      session.waiting.clear();
      return { viewers: [...session.viewers.keys()] };
    }));

    // A member opens the stream (or reconnects to it).
    socket.on('live:watch', handle(async ({ roomId, sessionId }) => {
      await requireMember(roomId, user.id);
      const session = sessions.get(roomId);
      if (!session || session.id !== sessionId) throw new AppError(404, 'This live stream has ended.');
      if (session.hostSocket === socket.id) throw new AppError(400, "You're the one streaming.");
      if (!session.viewers.has(socket.id) && session.viewers.size >= limits.liveViewers) {
        throw new AppError(409, `The stream is full (${limits.liveViewers} people). Try again when someone stops watching.`);
      }
      session.viewers.set(socket.id, user.id);
      if (session.hostSocket) emitTo(session.hostSocket, 'live:viewer', { roomId, viewer: socket.id, userId: user.id });
      else session.waiting.add(socket.id);
      return { hostId: session.hostId };
    }));

    socket.on('live:leave', ({ roomId } = {}) => {
      const session = sessions.get(roomId);
      if (session) removeViewer(session, socket.id);
    });

    // Connection setup, only ever between a host and one of its viewers.
    socket.on('live:signal', ({ roomId, to, data } = {}) => {
      const session = sessions.get(roomId);
      if (!session || typeof to !== 'string' || !data || typeof data !== 'object') return;
      const fromHost = session.hostSocket === socket.id && session.viewers.has(to);
      const fromViewer = session.viewers.has(socket.id) && session.hostSocket === to;
      if (fromHost || fromViewer) emitTo(to, 'live:signal', { roomId, from: socket.id, data });
    });
  },

  handleDisconnect(socket) {
    for (const session of sessions.values()) {
      if (session.hostSocket === socket.id) {
        // Viewers' connections run browser to browser and usually survive a
        // short drop, so give the host time to come back before ending it.
        session.hostSocket = null;
        session.grace = setTimeout(() => {
          finish(session, 'lost', `${session.hostName}'s live stream ended (their connection dropped)`).catch((err) =>
            console.error('Could not end a live stream', err),
          );
        }, HOST_GRACE_MS);
      } else {
        removeViewer(session, socket.id);
      }
    }
  },
};
