// Watch together. Admins find and pick the video and drive playback; the
// server keeps { playing, position, at } so every member can compute where
// the video should be right now, including members who join late.
import { AppError } from '../errors.js';
import { postSystemMessage, requireAdmin } from '../services/rooms.js';
import { cleanPosition, getWatch, playbackFor, publicWatch, saveWatch } from '../services/watch.js';
import { forgetStream } from '../stream/cache.js';
import { bestFor, findVideos, takeOption } from '../stream/find.js';
import { handle } from './util.js';

// Finding videos can open pages and run tools, so keep it to a sane rate.
const recentScans = new Map(); // userId -> timestamps
function allowScan(userId) {
  const now = Date.now();
  const list = (recentScans.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 8) return false;
  list.push(now);
  recentScans.set(userId, list);
  return true;
}

export function registerWatch(socket) {
  const user = socket.data.user;

  // Lets clients line their clocks up with the server's to within a few ms.
  socket.on('time:now', (_payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, now: Date.now() });
  });

  socket.on('watch:scan', handle(async ({ roomId, url, requestId }) => {
    await requireAdmin(roomId, user.id);
    if (!allowScan(user.id)) throw new AppError(429, 'That’s a lot of searches. Wait a minute and try again.');
    return findVideos(url, {
      userId: user.id,
      onProgress: (message) => socket.emit('watch:scan-progress', { requestId, message }),
    });
  }));

  // Either { scanId, optionId } from "Find videos", or { url } to play the best match directly.
  socket.on('watch:set', handle(async ({ roomId, scanId, optionId, url }) => {
    await requireAdmin(roomId, user.id);
    const choice = scanId ? takeOption(String(scanId), String(optionId ?? ''), user.id) : await bestFor(url, { userId: user.id });
    const { source, start, stream } = playbackFor(roomId, choice);
    const watch = { source, playing: true, position: start, at: Date.now(), by: user.id, byName: user.name, stream };
    const previous = await getWatch(roomId);
    await saveWatch(roomId, watch);
    if (previous?.stream) forgetStream(previous.stream.token);
    await postSystemMessage(roomId, `${user.name} is playing “${source.title}” for everyone`);
    return { watch: publicWatch(watch) };
  }));

  socket.on('watch:control', handle(async ({ roomId, playing, position }) => {
    await requireAdmin(roomId, user.id);
    const current = await getWatch(roomId);
    if (!current) throw new AppError(409, 'Nothing is playing right now.');
    const watch = { ...current, playing: !!playing, position: cleanPosition(position), at: Date.now(), by: user.id, byName: user.name };
    await saveWatch(roomId, watch);
    return { watch: publicWatch(watch) };
  }));

  socket.on('watch:stop', handle(async ({ roomId }) => {
    await requireAdmin(roomId, user.id);
    const current = await getWatch(roomId);
    if (!current) return {};
    await saveWatch(roomId, null);
    if (current.stream) forgetStream(current.stream.token);
    await postSystemMessage(roomId, `${user.name} stopped the video`);
    return {};
  }));
}
