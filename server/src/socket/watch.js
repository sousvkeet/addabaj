// Watch together. Admins find and pick the video and drive playback; the
// server keeps { playing, position, at } so every member can compute where
// the video should be right now, including members who join late.
import { AppError } from '../errors.js';
import { postSystemMessage, requireAdmin } from '../services/rooms.js';
import { cleanPosition, getWatch, playbackFor, publicWatch, saveWatch } from '../services/watch.js';
import { forgetStream } from '../stream/cache.js';
import { cancelMerge, startMerge } from '../stream/merge.js';
import { bestFor, findVideos, takeOption } from '../stream/find.js';
import { live } from './live.js';
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

/**
 * Puts a new video (or nothing) in place for the room and lets go of what
 * played before: its shared download, a join in progress, or a live stream.
 */
export async function replaceWatch(roomId, watch, { keepLive = false } = {}) {
  const previous = await getWatch(roomId);
  await saveWatch(roomId, watch);
  if (previous?.stream) {
    cancelMerge(previous.stream.token);
    forgetStream(previous.stream.token);
  }
  if (previous?.source?.kind === 'device' && !keepLive) live.closeRoom(roomId, watch ? 'replaced' : 'stopped');
  return previous;
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
    console.log(`[watch:scan] Room ${roomId}: scanning "${url}" by ${user.name}`);
    try {
      const res = await findVideos(url, {
        userId: user.id,
        onProgress: (message) => {
          console.log(`[watch:scan] Room ${roomId}: ${message}`);
          socket.emit('watch:scan-progress', { requestId, message });
        },
      });
      console.log(`[watch:scan] Room ${roomId}: found ${res.videos.length} videos for "${url}"`);
      return res;
    } catch (err) {
      console.error(`[watch:scan] Room ${roomId}: failed for "${url}" - ${err.message}`);
      throw err;
    }
  }));

  // Either { scanId, optionId } from "Find videos", or { url } to play the best match directly.
  socket.on('watch:set', handle(async ({ roomId, scanId, optionId, url }) => {
    await requireAdmin(roomId, user.id);
    console.log(`[watch:set] Room ${roomId}: setting video by ${user.name}`);
    try {
      const choice = scanId ? takeOption(String(scanId), String(optionId ?? ''), user.id) : await bestFor(url, { userId: user.id });
      const { source, start, stream } = playbackFor(roomId, choice);
      // A joined video plays once it's ready; until then the room sees progress.
      const watch = { source, playing: !source.preparing, position: start, at: Date.now(), by: user.id, byName: user.name, stream };
      await replaceWatch(roomId, watch);
      if (stream?.merge) startMerge(roomId, stream);
      await postSystemMessage(roomId, `${user.name} is playing “${source.title}” for everyone`);
      console.log(`[watch:set] Room ${roomId}: now playing "${source.title}" (${source.kind})`);
      return { watch: publicWatch(watch) };
    } catch (err) {
      console.error(`[watch:set] Room ${roomId}: failed - ${err.message}`);
      throw err;
    }
  }));

  socket.on('watch:control', handle(async ({ roomId, playing, position }) => {
    await requireAdmin(roomId, user.id);
    const current = await getWatch(roomId);
    if (!current) throw new AppError(409, 'Nothing is playing right now.');
    if (current.source?.kind === 'device') throw new AppError(409, `${current.byName} controls their live stream.`);
    const watch = { ...current, playing: !!playing, position: cleanPosition(position), at: Date.now(), by: user.id, byName: user.name };
    await saveWatch(roomId, watch);
    return { watch: publicWatch(watch) };
  }));

  socket.on('watch:stop', handle(async ({ roomId }) => {
    await requireAdmin(roomId, user.id);
    const current = await replaceWatch(roomId, null);
    if (!current) return {};
    await postSystemMessage(roomId, current.source?.kind === 'device' ? `${user.name} ended the live stream` : `${user.name} stopped the video`);
    return {};
  }));
}
