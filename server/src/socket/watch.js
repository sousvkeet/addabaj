// Watch together. Admins find and pick the video and drive playback; the
// server keeps { playing, position, at } so every member can compute where
// the video should be right now, including members who join late.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { postSystemMessage, requireAdmin } from '../services/rooms.js';
import { cleanPosition, getWatch, muteWatch, playbackFor, publicWatch, saveWatch } from '../services/watch.js';
import { forgetStream } from '../stream/cache.js';
import { cancelMerge, startMerge } from '../stream/merge.js';
import { bestFor, findVideos, takeOption } from '../stream/find.js';
import { probeDuration } from '../stream/probe.js';
import { youtubeDuration } from '../stream/ytdlp.js';
import { live } from './live.js';
import { endedAtPlayer } from './queue.js';
import { handle } from './util.js';

// Finding videos can open pages and run tools, so keep it to a sane rate
// (more in development, where the tests search a lot).
const SCANS_PER_MINUTE = config.isProd ? 8 : 40;
const recentScans = new Map(); // userId -> timestamps
function allowScan(userId) {
  const now = Date.now();
  const list = (recentScans.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= SCANS_PER_MINUTE) return false;
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

const lengthOf = (s) => (Number.isFinite(s) && s > 0 ? s : null);

/**
 * Plays a chosen video for the room now: it replaces whatever was on (and its
 * download), joining separate picture and sound first when needed, and tells
 * the room (`note`). How long it is comes from the search, or is worked out
 * in the background: Up next needs it to move on by itself.
 */
export async function startWatch(roomId, choice, by, note) {
  const { source, start, stream } = playbackFor(roomId, choice);
  const watch = {
    id: randomUUID(),
    source,
    playing: !source.preparing,
    position: start,
    at: Date.now(),
    by: by.id,
    byName: by.name,
    stream,
    duration: lengthOf(choice.video?.duration),
  };
  await replaceWatch(roomId, watch);
  if (stream?.merge) startMerge(roomId, stream);
  if (note) await postSystemMessage(roomId, note);
  if (!watch.duration) void learnDuration(roomId, watch.id, choice.option).catch(() => {});
  return watch;
}

/** How long the playing video is, when the search didn't say. */
async function learnDuration(roomId, watchId, option) {
  const seconds =
    option.kind === 'youtube'
      ? await youtubeDuration(option.videoId)
      : option.kind === 'merge'
        ? await probeDuration({ kind: 'file', url: option.video.url, headers: option.video.headers })
        : option.url
          ? await probeDuration(option)
          : null;
  if (!lengthOf(seconds)) return;
  const current = await getWatch(roomId);
  if (current?.id !== watchId || current.duration) return;
  await saveWatch(roomId, { ...current, duration: seconds });
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
      // A joined video plays once it's ready; until then the room sees progress.
      const watch = await startWatch(roomId, choice, user, `${user.name} is playing “${choice.video.title}” for everyone`);
      console.log(`[watch:set] Room ${roomId}: now playing "${watch.source.title}" (${watch.source.kind})`);
      return { watch: publicWatch(watch) };
    } catch (err) {
      console.error(`[watch:set] Room ${roomId}: failed - ${err.message}`);
      throw err;
    }
  }));

  socket.on('watch:control', handle(async ({ roomId, playing, position, ended }) => {
    await requireAdmin(roomId, user.id);
    const current = await getWatch(roomId);
    if (!current) throw new AppError(409, 'Nothing is playing right now.');
    if (current.source?.kind === 'device') throw new AppError(409, `${current.byName} controls their live stream.`);
    const at = cleanPosition(position);
    // The video ended at an admin's player: Up next moves on, if there's anything in it.
    if (ended && !playing && (await endedAtPlayer(roomId, current))) return { watch: publicWatch(await getWatch(roomId)) };
    const watch = {
      ...current,
      playing: !!playing,
      position: at,
      at: Date.now(),
      by: user.id,
      byName: user.name,
      // Its end tells how long it was, when nothing else did.
      ...(ended && !current.duration && at > 0 ? { duration: at } : {}),
    };
    await saveWatch(roomId, watch);
    return { watch: publicWatch(watch) };
  }));

  // An admin's player knows how long the video is, when nothing else did.
  socket.on('watch:duration', handle(async ({ roomId, watchId, duration }) => {
    await requireAdmin(roomId, user.id);
    const current = await getWatch(roomId);
    const seconds = lengthOf(Number(duration));
    if (!current || current.id !== watchId || current.duration || !seconds || seconds > 7 * 24 * 3600) return {};
    await saveWatch(roomId, { ...current, duration: seconds });
    return {};
  }));

  // An admin turns the video's sound off for everyone in the room, or back on.
  // It stays off for the videos that follow, and for live streams too, until
  // an admin turns it back on or stops the video.
  socket.on('watch:mute', handle(async ({ roomId, muted }) => {
    await requireAdmin(roomId, user.id);
    const watch = await muteWatch(roomId, muted ? { by: user.id, byName: user.name } : null);
    if (!watch) {
      if (!(await getWatch(roomId))) throw new AppError(409, 'Nothing is playing right now.');
      return {}; // it already was
    }
    await postSystemMessage(roomId, `${user.name} ${muted ? 'muted' : 'unmuted'} the video for everyone`);
    return { watch };
  }));

  socket.on('watch:stop', handle(async ({ roomId }) => {
    await requireAdmin(roomId, user.id);
    const current = await replaceWatch(roomId, null);
    if (!current) return {};
    await postSystemMessage(roomId, current.source?.kind === 'device' ? `${user.name} ended the live stream` : `${user.name} stopped the video`);
    return {};
  }));
}
