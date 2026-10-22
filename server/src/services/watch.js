// Watch together: the room's shared playback state, plus link helpers.
import { randomBytes } from 'node:crypto';
import { one } from '../db.js';
import { badRequest } from '../errors.js';
import { getIO, roomChannel } from '../realtime.js';

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);
const YT_ID = /^[\w-]{11}$/;

/** "1h2m3s", "90", "90s" → seconds. */
function parseStart(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** { videoId, start } for a YouTube video link, null for other sites. */
export function youtubeLink(url) {
  if (!YT_HOSTS.has(url.hostname)) return null;
  let id = null;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else id = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null;
  if (!id) return null; // channels, playlists… are left to the general finder
  if (!YT_ID.test(id)) throw badRequest("That YouTube link doesn't point to a video. Copy the link from the video's Share button.");
  return { videoId: id, start: parseStart(url.searchParams.get('t') ?? url.searchParams.get('start')) };
}

/** A YouTube playlist's id in a link (the playlist's page, or a video played from it), or null. */
export function youtubePlaylistId(url) {
  if (!YT_HOSTS.has(url.hostname)) return null;
  const list = url.searchParams.get('list');
  return list && /^[\w-]{10,80}$/.test(list) ? list : null;
}

/**
 * Asks YouTube whether the video exists and may be shown in its player on
 * other sites, and for its title: { title, embeddable } (title may be null).
 */
export async function youtubeInfo(videoId) {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401 || res.status === 403) return { title: null, embeddable: false };
    if (res.status === 404 || res.status === 400) throw badRequest("That YouTube video doesn't exist or is private.");
    if (!res.ok) return { title: null, embeddable: true };
    const data = await res.json();
    return { title: typeof data.title === 'string' ? data.title.slice(0, 200) : null, embeddable: true };
  } catch (err) {
    if (err.expose) throw err;
    return { title: null, embeddable: true }; // YouTube unreachable: still try to play it
  }
}

export function fileTitle(url) {
  let last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    /* keep it encoded */
  }
  return (last || url.hostname).slice(0, 200);
}

/**
 * What the room plays for a chosen option. Videos found on web pages are
 * relayed by the server (`stream` holds the real link and the headers the
 * site needs; it never leaves the server). Direct links play straight from
 * the source, with the relay as a fallback.
 */
export function playbackFor(roomId, { video, option }) {
  if (option.kind === 'youtube') {
    return {
      source: { kind: 'youtube', url: `https://www.youtube.com/watch?v=${option.videoId}`, videoId: option.videoId, title: video.title },
      start: option.start ?? 0,
      stream: null,
    };
  }
  const token = randomBytes(16).toString('base64url');
  const relayUrl = `/api/stream/${roomId}/${token}/main`;
  if (option.kind === 'merge') {
    const { video: v, audio: a, container } = option;
    const detail = `${option.label} ${option.detail}${video.site ? `, from ${video.site}` : ''}`;
    return {
      source: { kind: 'file', url: relayUrl, title: video.title, detail, relay: true, preparing: true },
      start: 0,
      stream: {
        token,
        kind: 'file',
        url: v.url,
        headers: v.headers ?? {},
        merge: { container, video: { url: v.url, headers: v.headers ?? {} }, audio: { url: a.url, headers: a.headers ?? {} } },
      },
    };
  }
  const quality = option.kind === 'file' ? `${option.label} ${option.detail}` : option.detail;
  const detail = video.site ? `${quality}, from ${video.site}` : quality;
  const stream = { token, url: option.url, headers: option.headers ?? {}, kind: option.kind };
  const source = option.direct
    ? { kind: option.kind, url: option.url, fallbackUrl: relayUrl, title: video.title, detail }
    : { kind: option.kind, url: relayUrl, title: video.title, detail, relay: true };
  return { source, start: 0, stream };
}

const MAX_POSITION = 7 * 24 * 3600;

export function cleanPosition(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_POSITION);
}

/**
 * The watch state as members may see it (without the private relay details),
 * with the room's mute when given (see muteWatch).
 */
export function publicWatch(watch, muted) {
  if (!watch) return null;
  const { stream: _private, ...rest } = watch;
  return muted === undefined ? rest : { ...rest, muted: muted ?? null };
}

/** Up next as members may see it (not the links or choices behind each video). */
export function publicQueue(queue) {
  return (queue ?? []).map(({ id, title, site, thumbnail, duration, kind, addedBy, addedAt }) => ({
    id,
    title,
    site: site ?? null,
    thumbnail: thumbnail ?? null,
    duration: duration ?? null,
    kind,
    addedBy,
    addedAt,
  }));
}

export async function getWatch(roomId) {
  return (await one('SELECT watch FROM rooms WHERE id = $1', [roomId]))?.watch ?? null;
}

// Told about every change (see socket/queue.js: Up next moves on when a video ends).
let saved = () => {};
export function onWatchSaved(fn) {
  saved = fn;
}

export async function saveWatch(roomId, watch) {
  // A mute for everyone holds for the videos that follow, and ends when the video stops.
  const row = await one(
    'UPDATE rooms SET watch = $2, watch_muted = CASE WHEN $2::jsonb IS NULL THEN NULL ELSE watch_muted END WHERE id = $1 RETURNING watch_muted',
    [roomId, watch],
  );
  getIO()?.to(roomChannel(roomId)).emit('watch:state', { roomId, watch: publicWatch(watch, row?.watch_muted) });
  saved(roomId, watch);
}

/**
 * Turns the video's sound off for everyone in the room (`mute`: the admin
 * who did, { by, byName }) or back on (null). Kept apart from the playback
 * state, so a play or seek at the same moment can't undo it. The new state;
 * null when nothing is playing or it already was that way.
 */
export async function muteWatch(roomId, mute) {
  const row = await one(
    'UPDATE rooms SET watch_muted = $2 WHERE id = $1 AND watch IS NOT NULL AND (watch_muted IS NULL) = $3 RETURNING watch',
    [roomId, mute, !!mute],
  );
  if (!row) return null;
  const watch = publicWatch(row.watch, mute);
  getIO()?.to(roomChannel(roomId)).emit('watch:state', { roomId, watch });
  return watch;
}
