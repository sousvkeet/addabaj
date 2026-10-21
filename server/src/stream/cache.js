// Fetch once, share with everyone: like a download manager, the server pulls
// each relayed video file (over several connections) into a temporary file,
// and every viewer reads from that file as it fills. The site sees one download
// however many people watch, seeking back is instant, and a link that expires
// mid-movie doesn't matter for the part already fetched.
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { config, streaming } from '../config.js';
import { createReadStream, statSync } from 'node:fs';
import { requestMedia as guardedRequest } from './http.js';

const IDLE_MS = 10 * 60 * 1000;
const CHUNK = 256 * 1024;
// Each request asks for at most this much, the way download managers (and
// yt-dlp, for YouTube) do: sites like YouTube slow a connection down to
// playback speed when it asks for a big or open-ended range.
const MAX_RANGE = 10 * 1024 * 1024;

// Start clean: partial files from a previous run are useless.
try {
  rmSync(streaming.cacheDir, { recursive: true, force: true });
} catch {
  /* nothing to clear */
}
mkdirSync(streaming.cacheDir, { recursive: true });

const entries = new Map(); // key -> CachedFile

/** Smallest part worth giving its own connection. */
const MIN_PART = 2 * 1024 * 1024;
/** Files smaller than this use one connection. */
const MIN_SPLIT = 8 * 1024 * 1024;
/** A request this close ahead of a connection's position just waits for it. */
const NEAR = 4 * 1024 * 1024;
const ALIGN = 64 * 1024;

class RangeRefused extends Error {}

/**
 * One relayed file, downloaded like a download manager does: up to
 * `streaming.connections` connections, each filling its own part of the file.
 * A connection that finishes takes over the second half of the largest part
 * still left, so all of them stay busy until the end.
 */
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
    this.have = []; // downloaded byte ranges [start, end), sorted and merged
    this.parts = []; // { start, end, pos, busy }: what's left to fetch
    this.responses = new Set();
    this.received = 0; // bytes written so far (all connections), for speed checks
    this.limit = Math.max(1, streaming.connections);
    this.done = false;
    this.failed = null;
    this.lastUsed = Date.now();
    this.ready = this.start();
  }

  /** Bytes on disk from the very start without a gap. */
  get downloaded() {
    return this.have[0]?.[0] === 0 ? this.have[0][1] : 0;
  }

  get busyCount() {
    return this.parts.filter((p) => p.busy).length;
  }

  /** End of the downloaded range that contains `pos`, or `pos` if it isn't there yet. */
  availableTo(pos) {
    const r = this.have.find(([a, b]) => a <= pos && pos < b);
    return r ? r[1] : pos;
  }

  markHave(a, b) {
    const list = [...this.have, [a, b]].sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const r of list) {
      const last = merged.at(-1);
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    this.have = merged;
  }

  /** Resolves once the size and type are known; rejects if the file can't be cached. */
  async start() {
    this.file = await open(this.path, 'w+');
    const { res } = await guardedRequest(this.url, { headers: { ...this.headers, range: `bytes=0-${MAX_RANGE - 1}` }, timeout: 30_000 });
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
    if (!this.resumable || total < MIN_SPLIT) this.limit = 1;
    if (!config.isProd) console.log(`[cache] downloading ${new URL(this.url).hostname} (${(total / 1e6).toFixed(1)} MB) once for everyone`);
    const first = { start: 0, end: total, pos: 0, busy: true };
    this.parts = [first];
    void this.work(first, res);
    if (this.limit > 1) this.growConnections();
  }

  /**
   * Adds connections only while they help, like a smart download manager: a
   * site that is already fast gains nothing (the extra connections just share
   * the same line), but one that limits each connection speeds up a lot.
   * Every 0.8 s: if the file arrives slower than FAST_BYTES_PER_S, add one;
   * stop once an added connection didn't make things at least 15% faster.
   */
  growConnections() {
    const FAST_BYTES_PER_S = 4_000_000; // 32 Mbit/s: plenty even for 4K video
    let lastBytes = this.received;
    let lastAt = Date.now();
    let rateBeforeAdding = null;
    const timer = setInterval(() => {
      if (this.closed || this.done || this.failed) return clearInterval(timer);
      const now = Date.now();
      const rate = ((this.received - lastBytes) * 1000) / (now - lastAt);
      lastBytes = this.received;
      lastAt = now;
      if (rateBeforeAdding !== null && rate < rateBeforeAdding * 1.15) {
        this.limit = this.busyCount; // the last connection didn't help: stay here
        return clearInterval(timer);
      }
      if (rate >= FAST_BYTES_PER_S || this.busyCount >= this.limit) {
        rateBeforeAdding = null;
        return;
      }
      const part = this.claim();
      if (!part) return;
      rateBeforeAdding = rate;
      void this.work(part);
    }, 800);
    timer.unref?.();
  }

  /**
   * Picks work for a free connection: a part nobody is fetching (earliest
   * first, since that's where people watch), else the second half of the
   * largest part still being fetched.
   */
  claim() {
    const idle = this.parts.filter((p) => !p.busy && p.pos < p.end).sort((a, b) => a.pos - b.pos)[0];
    if (idle) {
      idle.busy = true;
      return idle;
    }
    const biggest = this.parts.filter((p) => p.busy && p.end - p.pos >= 2 * MIN_PART).sort((a, b) => b.end - b.pos - (a.end - a.pos))[0];
    if (!biggest) return null;
    const mid = biggest.pos + Math.floor((biggest.end - biggest.pos) / 2 / ALIGN) * ALIGN;
    const half = { start: mid, end: biggest.end, pos: mid, busy: true };
    biggest.end = mid;
    this.parts.push(half);
    return half;
  }

  /**
   * Someone wants bytes from `pos` on. If no connection will reach it soon,
   * start one right there (allowed even at the limit: everyone in the room
   * jumps together, and they'll all read this download).
   */
  prioritize(pos) {
    if (!this.resumable || this.done || this.closed || this.availableTo(pos) > pos) return;
    if (this.parts.some((p) => p.busy && p.pos <= pos && pos < Math.min(p.end, p.pos + NEAR))) return;
    const part = this.parts.find((p) => p.pos <= pos && pos < p.end);
    if (!part) return;
    const at = Math.max(part.pos, Math.floor(pos / ALIGN) * ALIGN);
    if (at === part.pos && !part.busy) {
      part.busy = true;
      void this.work(part);
      return;
    }
    const jump = { start: at, end: part.end, pos: at, busy: true };
    part.end = at;
    this.parts.push(jump);
    void this.work(jump);
  }

  /** Can a viewer be served from this download (now, or shortly)? */
  serves(pos) {
    this.prioritize(pos);
    return this.availableTo(pos) > pos || this.parts.some((p) => p.busy && p.pos <= pos && pos < p.end);
  }

  /** One connection filling `part`; then it takes over more work until none is left. */
  async work(part, res = null) {
    let fruitless = 0;
    let lastError = null;
    while (part.pos < part.end && !this.closed) {
      if (!res) {
        try {
          const to = Math.min(part.end, part.pos + MAX_RANGE) - 1;
          ({ res } = await guardedRequest(this.url, { headers: { ...this.headers, range: `bytes=${part.pos}-${to}` }, timeout: 30_000 }));
          if (res.statusCode !== 206) {
            res.resume();
            throw new RangeRefused(`the site refused a range request (${res.statusCode})`);
          }
        } catch (err) {
          res = null;
          lastError = err;
          // Extra connections refused (too many at once): carry on with fewer.
          if (err instanceof RangeRefused && this.busyCount > 1) {
            part.busy = false;
            this.limit = Math.max(1, this.busyCount);
            return;
          }
          if (err.code === 'EBLOCKED' || ++fruitless > 5) break;
          await new Promise((r) => setTimeout(r, 1000 * fruitless));
          continue;
        }
      }
      this.responses.add(res);
      const before = part.pos;
      try {
        for await (const chunk of res) {
          if (this.closed) break;
          const room = part.end - part.pos; // shrinks when another connection takes half
          const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
          if (piece.length) {
            await this.file.write(piece, 0, piece.length, part.pos);
            this.received += piece.length;
            this.markHave(part.pos, part.pos + piece.length);
            part.pos += piece.length;
            this.emit('progress');
          }
          if (part.pos >= part.end) break;
        }
      } catch (err) {
        lastError = err;
      }
      this.responses.delete(res);
      res.destroy();
      res = null;
      fruitless = part.pos > before ? 0 : fruitless + 1;
      if (fruitless > 5) break;
      if (fruitless) await new Promise((r) => setTimeout(r, 1000 * fruitless));
    }
    part.busy = false;
    if (this.closed) return;
    if (this.availableTo(0) >= this.size) return this.finish();
    if (part.pos >= part.end) {
      // Done with this part: help with what's left.
      const next = this.claim();
      if (next) return this.work(next);
    }
    if (this.busyCount === 0 && !this.done) {
      const next = part.pos < part.end ? null : this.claim();
      if (next) return this.work(next);
      this.failed = lastError ?? new Error('the site stopped sending the file');
      this.emit('progress');
    }
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.emit('progress');
    if (!config.isProd) {
      const secs = (Date.now() - this.began) / 1000;
      console.log(`[cache] finished ${(this.size / 1e6).toFixed(1)} MB in ${secs.toFixed(1)}s (${(this.size / 1e6 / secs).toFixed(1)} MB/s, up to ${this.limit} connection${this.limit > 1 ? 's' : ''})`);
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
          while (self.availableTo(pos) <= pos && !self.done && !self.failed && !self.closed) {
            await new Promise((r) => self.once('progress', r));
          }
          const until = self.availableTo(pos);
          if (until <= pos) return this.destroy(self.failed ?? new Error('download stopped'));
          const length = Math.min(CHUNK, end - pos + 1, until - pos);
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
    for (const r of this.responses) r.destroy();
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

// Files nobody has read for a while are removed (joined files stay until their video ends).
setInterval(() => {
  for (const e of entries.values()) if (!e.pinned && Date.now() - e.lastUsed > IDLE_MS) void e.close();
}, 60_000).unref();

/**
 * A finished file on the server's disk (picture and sound joined), served
 * like the shared downloads and removed when its video stops or changes.
 */
export async function registerLocal(key, path, type) {
  const size = statSync(path).size;
  const entry = {
    key,
    path,
    size,
    type,
    pinned: true,
    done: true,
    lastUsed: Date.now(),
    serves: () => true,
    read: (start, end) => {
      entry.lastUsed = Date.now();
      return createReadStream(path, { start, end, highWaterMark: CHUNK });
    },
    close: async () => {
      entries.delete(key);
      await rm(path, { force: true }).catch(() => {});
    },
  };
  entries.set(key, entry);
  return entry;
}

/** The joined file for a video, once it's ready. */
export const localFile = (key) => {
  const e = entries.get(key);
  return e?.pinned ? e : null;
};

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
