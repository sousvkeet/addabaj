// Watch together's Up next: videos an admin queued (one at a time, or a whole
// YouTube playlist) to play after the current one. The server knows how long
// each video is and moves on by itself when one ends, so the room isn't left
// waiting for an admin between videos. Members see the list; admins change it.
import { randomUUID } from 'node:crypto';
import { one, query } from '../db.js';
import { AppError } from '../errors.js';
import { getIO, roomChannel } from '../realtime.js';
import { postSystemMessage, requireAdmin } from '../services/rooms.js';
import { getWatch, onWatchSaved, publicQueue, saveWatch, youtubeInfo } from '../services/watch.js';
import { refind, takeOption, takePlaylist } from '../stream/find.js';
import { handle, rateLimiter } from './util.js';
import { replaceWatch, startWatch } from './watch.js';

const QUEUE_MAX = 100;
/** A found link is used for this long; after that the video is found again (sites' links expire). */
const FRESH_MS = 15 * 60 * 1000;
const MAX_DELAY = 2 ** 31 - 1;

const lengthOf = (s) => (Number.isFinite(s) && s > 0 ? s : null);
const keyOf = (watch) => (watch ? (watch.id ?? String(watch.at)) : null);
const person = (user) => ({ id: user.id, name: user.name });

export async function getQueue(roomId) {
  return (await one('SELECT watch_queue FROM rooms WHERE id = $1', [roomId]))?.watch_queue ?? [];
}

async function saveQueue(roomId, queue) {
  await query('UPDATE rooms SET watch_queue = $2 WHERE id = $1', [roomId, JSON.stringify(queue)]);
  getIO()?.to(roomChannel(roomId)).emit('watch:queue', { roomId, queue: publicQueue(queue) });
}

// One change at a time per room (two admins at once, or a video ending as someone skips).
const turns = new Map();
function inTurn(roomId, fn) {
  const run = (turns.get(roomId) ?? Promise.resolve()).then(fn);
  const done = run.catch(() => {});
  turns.set(roomId, done);
  void done.then(() => turns.get(roomId) === done && turns.delete(roomId));
  return run;
}

// ── What's in it ───────────────────────────────────────────────────────

/** A video chosen in "Find videos". The choice is kept for a while; then it's found again by its link. */
function itemFromChoice({ video, option, link }, user) {
  const base = {
    id: randomUUID(),
    title: video.title,
    site: video.site ?? null,
    thumbnail: video.thumbnail ?? null,
    duration: lengthOf(video.duration),
    addedBy: person(user),
    addedAt: Date.now(),
  };
  if (option.kind === 'youtube') {
    return { ...base, kind: 'youtube', videoId: option.videoId, start: option.start ?? 0, link: `https://www.youtube.com/watch?v=${option.videoId}` };
  }
  return {
    ...base,
    kind: option.kind,
    link,
    pick: { title: video.title, kind: option.kind, label: option.label },
    choice: slim({ video, option }),
    foundAt: Date.now(),
  };
}

/** One of a playlist's videos. */
function itemFromEntry(entry, user) {
  return {
    id: randomUUID(),
    title: entry.title,
    site: entry.videoId ? 'YouTube' : null,
    thumbnail: entry.thumbnail ?? null,
    duration: lengthOf(entry.duration),
    kind: entry.videoId ? 'youtube' : 'file',
    link: entry.url,
    ...(entry.videoId ? { videoId: entry.videoId, start: 0 } : {}),
    addedBy: person(user),
    addedAt: Date.now(),
  };
}

/** Just what playing it needs (not every other quality the search found). */
const slim = ({ video, option }) => ({
  video: { title: video.title, site: video.site ?? null, thumbnail: video.thumbnail ?? null, duration: lengthOf(video.duration) },
  option,
});

const fresh = (item) => !!item.videoId || (!!item.choice && Date.now() - item.foundAt < FRESH_MS);

/** What to play for a queued video, finding it again when its link may have expired. */
async function choiceFor(item) {
  if (item.videoId) {
    // YouTube's player, unless its owner turned that off: then its own files, through the server.
    const info = await youtubeInfo(item.videoId);
    if (info.embeddable) {
      return {
        video: { title: info.title ?? item.title, site: 'YouTube', thumbnail: item.thumbnail, duration: item.duration },
        option: { kind: 'youtube', videoId: item.videoId, start: item.start ?? 0 },
      };
    }
    return refind(item.link, null, item.addedBy.id);
  }
  if (fresh(item)) return item.choice;
  return refind(item.link, item.pick, item.addedBy.id);
}

// ── Moving on ──────────────────────────────────────────────────────────

/** While a video is found again, the room sees what's coming. */
const finding = (item, who) => ({
  id: randomUUID(),
  source: { kind: 'file', url: '', title: item.title, detail: 'Up next', preparing: true, finding: true },
  playing: false,
  position: 0,
  at: Date.now(),
  by: who.id,
  byName: who.name,
  duration: null,
});

/**
 * Plays the first video in Up next (taking it off the list). `user`: the
 * admin who moved on; null when the last video ended by itself. A video that
 * can't be played any more is skipped, with a note in the room. `endOf`: only
 * if the room's video is still that one (the end of a video counts once).
 */
function playNext(roomId, user, endOf = null) {
  return inTurn(roomId, async () => {
    if (endOf !== null && keyOf(await getWatch(roomId)) !== endOf) return null;
    for (let tries = 0; tries < 3; tries++) {
      const queue = await getQueue(roomId);
      const item = queue[0];
      if (!item) break;
      await saveQueue(roomId, queue.slice(1));
      const who = user ?? item.addedBy;
      const shown = fresh(item) ? null : finding(item, who);
      if (shown) await replaceWatch(roomId, shown);
      try {
        const choice = await choiceFor(item);
        // Stopped, or something else put on, while it was being found: that
        // stands, and this one is next again.
        if (shown && keyOf(await getWatch(roomId)) !== shown.id) {
          await saveQueue(roomId, [item, ...(await getQueue(roomId))]);
          return null;
        }
        const title = choice.video.title;
        const note = user ? `${user.name} is playing “${title}” for everyone` : `Up next: “${title}” is playing for everyone`;
        return await startWatch(roomId, choice, who, note);
      } catch (err) {
        const why = err.expose ? err.message : 'It couldn’t be found any more.';
        await postSystemMessage(roomId, `Skipped “${item.title}” from Up next. ${why}`);
      }
    }
    // Nothing more could be played: don't leave "getting ready" up.
    if ((await getWatch(roomId))?.source?.finding) await replaceWatch(roomId, null);
    return null;
  });
}

/** An admin's player says the video ended: with something in Up next, it plays now. True when it did. */
export async function endedAtPlayer(roomId, watch) {
  if (!(await getQueue(roomId)).length) return false;
  await playNext(roomId, null, keyOf(watch));
  return true;
}

/** The room's clock reached the end of its video: the next one plays, or it stays at its end. */
async function ended(roomId, key) {
  const watch = await getWatch(roomId);
  if (keyOf(watch) !== key || !watch.playing) return;
  const position = watch.position + (Date.now() - watch.at) / 1000;
  if (position < watch.duration - 1) return schedule(roomId, watch); // a very long wait is done in steps
  if ((await getQueue(roomId)).length) return void (await playNext(roomId, null, key));
  // Nothing next: every player stops at the end, rather than the room's clock running on past it.
  await saveWatch(roomId, { ...watch, playing: false, position: watch.duration, at: Date.now() });
}

/** A minute before the end, the next video's link is found again if it needs it, so it starts at once. */
async function prepareNext(roomId) {
  const item = (await getQueue(roomId))[0];
  if (!item || item.videoId || (item.choice && Date.now() - item.foundAt < FRESH_MS - 5 * 60_000)) return;
  try {
    const choice = slim(await refind(item.link, item.pick, item.addedBy.id));
    await inTurn(roomId, async () => {
      const queue = await getQueue(roomId);
      const i = queue.findIndex((q) => q.id === item.id);
      if (i < 0) return;
      queue[i] = { ...queue[i], choice, foundAt: Date.now() };
      await saveQueue(roomId, queue);
    });
  } catch {
    // It's found again when it plays.
  }
}

const timers = new Map(); // roomId -> timeouts

/** After every change to a room's video: when it will end, Up next moves on. */
function schedule(roomId, watch) {
  for (const t of timers.get(roomId) ?? []) clearTimeout(t);
  timers.delete(roomId);
  const length = lengthOf(watch?.duration);
  if (!watch?.playing || !length || watch.source?.kind === 'device' || watch.source?.preparing || watch.source?.error) return;
  const left = (length - watch.position) * 1000 - (Date.now() - watch.at);
  const key = keyOf(watch);
  const list = [setTimeout(() => void ended(roomId, key).catch((err) => console.error('[queue] moving on failed', err)), Math.min(MAX_DELAY, Math.max(0, left) + 1000))];
  if (left > 65_000) list.push(setTimeout(() => void prepareNext(roomId), Math.min(MAX_DELAY, left - 60_000)));
  else void prepareNext(roomId);
  for (const t of list) t.unref?.();
  timers.set(roomId, list);
}

onWatchSaved(schedule);

/** On start: the clocks of rooms that were watching (a video that ended meanwhile moves on now). */
export async function armQueues() {
  const { rows } = await query('SELECT id, watch FROM rooms WHERE watch IS NOT NULL');
  for (const r of rows) schedule(r.id, r.watch);
}

// ── What admins do ─────────────────────────────────────────────────────

/** Nothing on, or what was on has ended (or failed): Up next starts when something is added. */
const idle = (w) =>
  !w || !!w.source?.error || (!w.playing && !w.source?.preparing && !!lengthOf(w.duration) && w.position >= w.duration - 1);

const canAdd = rateLimiter(30, 60_000);

export function registerQueue(socket) {
  const user = socket.data.user;

  // From "Find videos": one video ({ scanId, optionId }), or a playlist's videos ({ scanId, playlist: true }).
  socket.on('watch:queue-add', handle(async ({ roomId, scanId, optionId, playlist }) => {
    await requireAdmin(roomId, user.id);
    if (!canAdd(user.id)) throw new AppError(429, 'That’s a lot of videos at once. Wait a minute and try again.');
    let items;
    let note;
    if (playlist) {
      const list = takePlaylist(String(scanId ?? ''), user.id);
      items = list.entries.map((e) => itemFromEntry(e, user));
      note = (n) => `${user.name} added ${n} ${n === 1 ? 'video' : 'videos'} from “${list.title}” to Up next`;
    } else {
      items = [itemFromChoice(takeOption(String(scanId ?? ''), String(optionId ?? ''), user.id), user)];
      note = () => `${user.name} added “${items[0].title}” to Up next`;
    }
    const added = await inTurn(roomId, async () => {
      const queue = await getQueue(roomId);
      const room = QUEUE_MAX - queue.length;
      if (room <= 0) throw new AppError(409, `Up next is full (${QUEUE_MAX} videos). Remove some first.`);
      const fit = items.slice(0, room);
      await saveQueue(roomId, [...queue, ...fit]);
      return fit.length;
    });
    await postSystemMessage(roomId, note(added));
    if (idle(await getWatch(roomId))) await playNext(roomId, user);
    return { added };
  }));

  socket.on('watch:queue-remove', handle(async ({ roomId, itemId }) => {
    await requireAdmin(roomId, user.id);
    await inTurn(roomId, async () => {
      const queue = await getQueue(roomId);
      const next = queue.filter((i) => i.id !== itemId);
      if (next.length === queue.length) throw new AppError(404, 'That video isn’t in Up next any more.');
      await saveQueue(roomId, next);
    });
    return {};
  }));

  // Moves a video to place `to` (0 is next).
  socket.on('watch:queue-move', handle(async ({ roomId, itemId, to }) => {
    await requireAdmin(roomId, user.id);
    await inTurn(roomId, async () => {
      const queue = await getQueue(roomId);
      const from = queue.findIndex((i) => i.id === itemId);
      if (from < 0) throw new AppError(404, 'That video isn’t in Up next any more.');
      const [item] = queue.splice(from, 1);
      queue.splice(Math.max(0, Math.min(queue.length, Math.trunc(Number(to)) || 0)), 0, item);
      await saveQueue(roomId, queue);
    });
    return {};
  }));

  socket.on('watch:queue-clear', handle(async ({ roomId }) => {
    await requireAdmin(roomId, user.id);
    const had = await inTurn(roomId, async () => {
      const n = (await getQueue(roomId)).length;
      if (n) await saveQueue(roomId, []);
      return n;
    });
    if (had) await postSystemMessage(roomId, `${user.name} cleared Up next`);
    return {};
  }));

  // Plays one of the queued videos now.
  socket.on('watch:queue-play', handle(async ({ roomId, itemId }) => {
    await requireAdmin(roomId, user.id);
    await inTurn(roomId, async () => {
      const queue = await getQueue(roomId);
      const from = queue.findIndex((i) => i.id === itemId);
      if (from < 0) throw new AppError(404, 'That video isn’t in Up next any more.');
      queue.unshift(...queue.splice(from, 1));
      await saveQueue(roomId, queue);
    });
    await playNext(roomId, user);
    return {};
  }));

  // Skips to the next video.
  socket.on('watch:next', handle(async ({ roomId }) => {
    await requireAdmin(roomId, user.id);
    if (!(await getQueue(roomId)).length) throw new AppError(409, 'Nothing is in Up next.');
    await playNext(roomId, user);
    return {};
  }));
}
