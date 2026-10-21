// The stream relay: room members' players fetch the chosen video through the
// server, which adds the headers the site expects and passes byte ranges
// through, so seeking works. HLS playlists are rewritten so every playlist,
// segment and key also goes through here, via signed links: the relay only
// ever fetches URLs that appeared in a playlist it served.
import { Router } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { one } from '../db.js';
import { isUuid, notFound } from '../errors.js';
import { withoutAdSegments } from '../stream/adblock.js';
import { playlistHasDrm } from '../stream/formats.js';
import { cachedFile, localFile, sharedSegment } from '../stream/cache.js';
import { isPlaylistType, readText, requestMedia as guardedRequest } from '../stream/http.js';

export const streamRouter = Router();

const key = createHash('sha256').update(`${config.jwtSecret}:stream-relay`).digest();
const sign = (token, url, playlist) =>
  createHmac('sha256', key).update(`${token}\n${playlist ? 'p' : 's'}\n${url}`).digest('base64url').slice(0, 24);

function relayPath(roomId, token, url, playlist) {
  const u = Buffer.from(url).toString('base64url');
  return `/api/stream/${roomId}/${token}/x?u=${u}&p=${playlist ? 1 : 0}&s=${sign(token, url, playlist)}`;
}

// Membership and the room's current stream, cached briefly: players ask often.
const access = new Map();
async function streamFor(roomId, token, userId) {
  if (!isUuid(roomId)) throw notFound();
  const cacheKey = `${roomId}:${userId}`;
  const hit = access.get(cacheKey);
  // Reuse a recent answer only for the same video; a new token means look again.
  let stream = hit && Date.now() - hit.at < 10_000 && hit.stream?.token === token ? hit.stream : undefined;
  if (stream === undefined) {
    const row = await one(
      `SELECT r.watch FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.user_id = $2 WHERE r.id = $1`,
      [roomId, userId],
    );
    stream = row?.watch?.stream ?? null;
    if (access.size > 5000) access.clear();
    access.set(cacheKey, { stream, at: Date.now() });
  }
  if (!stream || stream.token !== token) throw notFound('This video was stopped or changed.');
  return stream;
}

const PLAYLIST_TAGS = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)\b/;

/**
 * Points every URI in a playlist back at the relay, after leaving out
 * segments served by ad networks (see withoutAdSegments).
 */
function rewrite(text, base, roomId, token) {
  const through = (uri, playlist) => (/^(data|skd):/i.test(uri) ? uri : relayPath(roomId, token, new URL(uri, base).href, playlist));
  let nextIsPlaylist = false;
  return withoutAdSegments(text, base)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        if (t.startsWith('#EXT-X-STREAM-INF')) nextIsPlaylist = true;
        const playlist = PLAYLIST_TAGS.test(t);
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${through(uri, playlist)}"`);
      }
      const out = through(t, nextIsPlaylist);
      nextIsPlaylist = false;
      return out;
    })
    .join('\n');
}

// In development, one line per relayed request helps when a site is slow or refuses.
const devLog = !config.isProd;

/** Serves a byte range from the shared download, waiting for it where needed. */
function serveCached(req, res, entry) {
  const size = entry.size;
  let start = 0;
  let end = size - 1;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    }
  }
  if (start >= size || start > end) return res.status(416).set('content-range', `bytes */${size}`).end();
  res.status(m ? 206 : 200).set({
    'content-type': entry.type,
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  });
  const body = entry.read(start, end);
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
}

async function relay(req, res, stream, target, asPlaylist) {
  // Picture and sound joined on the server: served from its disk once ready.
  if (stream.merge) {
    const file = localFile(stream.token);
    if (!file) return res.status(409).json({ error: 'The video is still being prepared.' });
    return serveCached(req, res, file);
  }
  // Video files: everyone shares one download (unless they jump far ahead of it).
  if (!asPlaylist && stream.kind === 'file' && target === stream.url) {
    const entry = await cachedFile(stream.token, stream.url, stream.headers);
    const start = Number(/^bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
    if (entry?.serves(start)) return serveCached(req, res, entry);
  }
  // Stream segments: fetched once and shared by everyone watching.
  if (!asPlaylist && stream.kind === 'hls' && !req.headers.range && target !== stream.url) {
    const segment = await sharedSegment(target, stream.headers).catch(() => null);
    if (segment && segment.status < 400) {
      return res.status(200).set({ 'content-type': segment.type ?? 'video/mp2t', 'cache-control': 'private, max-age=60' }).send(segment.body);
    }
  }
  return relayUpstream(req, res, stream, target, asPlaylist);
}

async function relayUpstream(req, res, stream, target, asPlaylist) {
  const headers = { ...stream.headers };
  if (req.headers.range) headers.range = req.headers.range;
  const started = Date.now();
  const host = new URL(target).hostname;
  // Sites on the open web hiccup (5xx, dropped connections): retry twice
  // before the viewer sees anything, since nothing has been sent yet.
  let up, finalUrl;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ res: up, url: finalUrl } = await guardedRequest(target, { headers, timeout: 30_000 }));
      if ((up.statusCode ?? 0) >= 500 && attempt < 2) {
        if (devLog) console.warn(`[relay] ${host} answered ${up.statusCode}, retrying`);
        up.resume();
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      break;
    } catch (err) {
      if (err.code === 'EBLOCKED' || attempt >= 2) {
        if (devLog) console.warn(`[relay] ${host} failed after ${Date.now() - started}ms: ${err.message}`);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (devLog) {
    const firstByte = Date.now() - started;
    let sent = 0;
    up.on('data', (c) => (sent += c.length));
    res.on('close', () =>
      console.log(
        `[relay] ${up.statusCode} ${req.headers.range ?? 'full'} ${host} first byte ${firstByte}ms, ${(sent / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s${res.writableFinished ? '' : ' (closed by viewer)'}`,
      ),
    );
  }
  const type = up.headers['content-type'] ?? '';
  const playlist = isPlaylistType(type) || /\.m3u8$/i.test(new URL(finalUrl).pathname) || (asPlaylist && !/^video\//i.test(type));

  if (playlist && (up.statusCode ?? 500) < 400) {
    const text = await readText(up, 4_000_000);
    if (!text.trimStart().startsWith('#EXTM3U')) return res.status(502).json({ error: "The stream didn't send a playlist." });
    if (playlistHasDrm(text)) return res.status(415).json({ error: 'This stream is protected (DRM) and can’t be played here.' });
    res.set({ 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    return res.send(rewrite(text, finalUrl, req.params.roomId, req.params.token));
  }

  res.status(up.statusCode ?? 502);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    if (up.headers[h]) res.setHeader(h, up.headers[h]);
  }
  res.setHeader('cache-control', 'private, no-store');
  up.on('error', () => res.destroy());
  res.on('close', () => up.destroy());
  up.pipe(res);
}

// The chosen video (or the top playlist of a stream).
streamRouter.get('/:roomId/:token/main', async (req, res) => {
  const stream = await streamFor(req.params.roomId, req.params.token, req.userId);
  await relay(req, res, stream, stream.url, stream.kind === 'hls');
});

// Anything a relayed playlist points at, if the link carries our signature.
streamRouter.get('/:roomId/:token/x', async (req, res) => {
  const stream = await streamFor(req.params.roomId, req.params.token, req.userId);
  const target = Buffer.from(String(req.query.u ?? ''), 'base64url').toString('utf8');
  const playlist = req.query.p === '1';
  const given = Buffer.from(String(req.query.s ?? ''));
  const expected = Buffer.from(sign(stream.token, target, playlist));
  if (!target || given.length !== expected.length || !timingSafeEqual(given, expected)) throw notFound();
  await relay(req, res, stream, target, playlist);
});
