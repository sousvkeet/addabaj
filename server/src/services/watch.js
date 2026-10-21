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

/** The watch state as members may see it (without the private relay details). */
export function publicWatch(watch) {
  if (!watch) return null;
  const { stream: _private, ...rest } = watch;
  return rest;
}

export async function getWatch(roomId) {
  return (await one('SELECT watch FROM rooms WHERE id = $1', [roomId]))?.watch ?? null;
}

export async function saveWatch(roomId, watch) {
  await one('UPDATE rooms SET watch = $2 WHERE id = $1 RETURNING id', [roomId, watch]);
  getIO()?.to(roomChannel(roomId)).emit('watch:state', { roomId, watch: publicWatch(watch) });
}
