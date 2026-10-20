// Fetch once, share with everyone: like a download manager, the server pulls
// each relayed video file with a single connection into a temporary file, and
// every viewer reads from that file as it fills. The site sees one download
// however many people watch, seeking back is instant, and a link that expires
// mid-movie doesn't matter for the part already fetched.
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { config, streaming } from '../config.js';
import { guardedRequest } from './http.js';

const IDLE_MS = 10 * 60 * 1000;
const CHUNK = 256 * 1024;

// Start clean: partial files from a previous run are useless.
try {
  rmSync(streaming.cacheDir, { recursive: true, force: true });
} catch {
  /* nothing to clear */
}
mkdirSync(streaming.cacheDir, { recursive: true });

const entries = new Map(); // key -> CachedFile

class CachedFile extends EventEmitter {
  constructor(key, url, headers) {
    super();
    this.setMaxListeners(0);
    this.key = key;
    this.url = url;
    this.headers = headers;
    this.path = join(streaming.cacheDir, `${key}.part`);
    this.size = null; // total bytes, once known
    this.type = 'video/mp4';
    this.downloaded = 0; // bytes on disk, contiguous from the start
    this.done = false;
    this.failed = null;
    this.lastUsed = Date.now();
    this.ready = this.start();
  }

  /** Resolves once the size and type are known; rejects if the file can't be cached. */
  async start() {
    this.file = await open(this.path, 'w+');
    const { res } = await guardedRequest(this.url, { headers: { ...this.headers, range: 'bytes=0-' }, timeout: 30_000 });
    const total = Number(/\/(\d+)$/.exec(res.headers['content-range'] ?? '')?.[1] ?? (res.statusCode === 200 ? res.headers['content-length'] : NaN));
    if (res.statusCode >= 400 || !Number.isFinite(total) || total <= 0) {
      res.resume();
      throw new Error(`can't cache (status ${res.statusCode}, size ${total})`);
    }
    if (total > streaming.cacheMaxBytes || !(await makeRoom(total, this))) {
      res.resume();
      throw new Error('too large to cache');
    }
    this.size = total;
    this.type = res.headers['content-type'] ?? this.type;
    this.resumable = res.statusCode === 206 || res.headers['accept-ranges'] === 'bytes';
    this.began = Date.now();
    if (!config.isProd) console.log(`[cache] downloading ${new URL(this.url).hostname} (${(total / 1e6).toFixed(1)} MB) once for everyone`);
    void this.pump(res);
  }

  /** Writes the download to disk, resuming after dropped connections. */
  async pump(res) {
    let attempts = 0;
    while (!this.done && !this.closed) {
      try {
        for await (const chunk of res) {
          if (this.closed) break;
          await this.file.write(chunk, 0, chunk.length, this.downloaded);
          this.downloaded += chunk.length;
          this.emit('progress');
        }
        if (this.downloaded >= this.size) {
          this.done = true;
          this.emit('progress');
          if (!config.isProd) console.log(`[cache] finished ${(this.size / 1e6).toFixed(1)} MB in ${((Date.now() - this.began) / 1000).toFixed(1)}s`);
          return;
        }
        throw new Error('connection ended early');
      } catch (err) {
        if (this.closed) return;
        if (++attempts > 5 || !this.resumable) {
          this.failed = err;
          this.emit('progress');
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempts));
        try {
          ({ res } = await guardedRequest(this.url, { headers: { ...this.headers, range: `bytes=${this.downloaded}-` }, timeout: 30_000 }));
          if (res.statusCode !== 206) throw new Error(`resume refused (${res.statusCode})`);
        } catch (e) {
          res = Readable.from([]); // loop around and count the attempt
          if (e.code === 'EBLOCKED') attempts = 99;
        }
      }
    }
  }

  /** Bytes [start, end] as a stream, waiting for the download where needed. */
  read(start, end) {
    const self = this;
    let pos = start;
    this.lastUsed = Date.now();
    return new Readable({
      highWaterMark: CHUNK,
      async read() {
        try {
          if (pos > end) return this.push(null);
          while (pos >= self.downloaded && !self.done && !self.failed && !self.closed) {
            await new Promise((r) => self.once('progress', r));
          }
          if (pos >= self.downloaded) return this.destroy(self.failed ?? new Error('download stopped'));
          const length = Math.min(CHUNK, end - pos + 1, self.downloaded - pos);
          const buf = Buffer.allocUnsafe(length);
          const { bytesRead } = await self.file.read(buf, 0, length, pos);
          pos += bytesRead;
          self.lastUsed = Date.now();
          this.push(bytesRead ? buf.subarray(0, bytesRead) : null);
        } catch (err) {
          this.destroy(err);
        }
      },
    });
  }

  async close() {
    this.closed = true;
    entries.delete(this.key);
    this.emit('progress');
    await this.file?.close().catch(() => {});
    await rm(this.path, { force: true }).catch(() => {});
  }
}

const bytesInUse = () => [...entries.values()].reduce((n, e) => n + (e.size ?? 0), 0);

/** Frees space by dropping the least recently used files (never `keep`). */
async function makeRoom(needed, keep) {
  const others = [...entries.values()].filter((e) => e !== keep).sort((a, b) => a.lastUsed - b.lastUsed);
  while (bytesInUse() - (keep.size ?? 0) + needed > streaming.cacheMaxBytes && others.length) await others.shift().close();
  return bytesInUse() - (keep.size ?? 0) + needed <= streaming.cacheMaxBytes;
}

/** The shared download for a relayed file, or null if it can't be cached. */
export async function cachedFile(key, url, headers) {
  if (!streaming.cacheMaxBytes) return null;
  let entry = entries.get(key);
  if (!entry) {
    entry = new CachedFile(key, url, headers);
    entries.set(key, entry);
    entry.ready.catch(() => entry.close());
  }
  try {
    await entry.ready;
    return entry;
  } catch {
    return null;
  }
}

/** Drop the files for streams that are no longer playing. */
export function forgetStream(token) {
  for (const e of entries.values()) if (e.key.startsWith(`${token}`)) void e.close();
}

// Files nobody has read for a while are removed.
setInterval(() => {
  for (const e of entries.values()) if (Date.now() - e.lastUsed > IDLE_MS) void e.close();
}, 60_000).unref();

// ── Stream segments: fetched once, shared for a couple of minutes ────────

const segments = new Map(); // url -> { at, promise }
let segmentBytes = 0;
const SEGMENT_TTL_MS = 2 * 60 * 1000;
const SEGMENT_MAX = 16 * 1024 * 1024;
const SEGMENTS_TOTAL = 256 * 1024 * 1024;

/**
 * A stream segment as { status, headers, body }, fetched once even when every
 * viewer asks for it at the same moment.
 */
export function sharedSegment(url, headers) {
  const now = Date.now();
  for (const [k, v] of segments) {
    if (now - v.at > SEGMENT_TTL_MS) {
      segments.delete(k);
      segmentBytes -= v.size ?? 0;
    }
  }
  const hit = segments.get(url);
  if (hit) return hit.promise;
  const entry = { at: now, size: 0 };
  entry.promise = (async () => {
    const { res } = await guardedRequest(url, { headers, timeout: 30_000 });
    const chunks = [];
    let size = 0;
    for await (const c of res) {
      size += c.length;
      if (size > SEGMENT_MAX) throw new Error('segment too large to share');
      chunks.push(c);
    }
    if ((res.statusCode ?? 500) >= 400) segments.delete(url); // don't keep errors around
    entry.size = size;
    segmentBytes += size;
    while (segmentBytes > SEGMENTS_TOTAL && segments.size) {
      const [oldest, v] = segments.entries().next().value;
      segments.delete(oldest);
      segmentBytes -= v.size ?? 0;
    }
    return { status: res.statusCode ?? 502, type: res.headers['content-type'], body: Buffer.concat(chunks) };
  })();
  entry.promise.catch(() => {
    segments.delete(url);
    segmentBytes -= entry.size;
  });
  segments.set(url, entry);
  return entry.promise;
}
