// How long is a found video? Pages often carry short clips next to the real
// video (hover previews, intros, ads), so durations let "Find videos" put the
// real video first and drop the clips. Reads only file headers, never whole files.
import { guardedRequest, readText, requestMedia } from './http.js';

const HEAD_BYTES = 64 * 1024;

async function fetchRange(url, headers, range) {
  const { res } = await requestMedia(url, { headers: { ...headers, range }, timeout: 6000 });
  if ((res.statusCode ?? 500) >= 400) {
    res.resume();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const c of res) {
    chunks.push(c);
    size += c.length;
    if (size >= HEAD_BYTES) {
      res.destroy();
      break;
    }
  }
  const total = Number(/\/(\d+)$/.exec(res.headers['content-range'] ?? '')?.[1]) || null;
  return { buf: Buffer.concat(chunks), total };
}

/** Seconds from an MP4/MOV "mvhd" box inside the given bytes, or null. */
function mvhdSeconds(buf) {
  const i = buf.indexOf('mvhd', 0, 'latin1');
  if (i < 4 || i + 32 > buf.length) return null;
  const version = buf[i + 4];
  const timescale = version === 1 ? buf.readUInt32BE(i + 24) : buf.readUInt32BE(i + 16);
  const duration = version === 1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20);
  return timescale > 0 && duration > 0 ? duration / timescale : null;
}

/** Where the "moov" box starts when it comes after the media data (MP4 "moov at end"). */
function moovOffset(buf) {
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1 && off + 16 <= buf.length) size = Number(buf.readBigUInt64BE(off + 8));
    if (type === 'moov') return null; // already in these bytes
    if (size < 8) return null;
    off += size;
    if (off > buf.length) return off; // jumped past what we have: the next box is out there
  }
  return null;
}

/** Seconds from a WebM/Matroska header (Segment Info: TimecodeScale and Duration). */
function webmSeconds(buf) {
  if (buf.readUInt32BE(0) !== 0x1a45dfa3) return null;
  let scale = 1_000_000; // nanoseconds per tick (the default)
  const s = buf.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  if (s >= 0) {
    const len = buf[s + 3] & 0x0f; // 1-byte size, e.g. 0x83 = 3 bytes
    if (len > 0 && len <= 8) scale = buf.readUIntBE(s + 4, Math.min(len, 6));
  }
  const d = buf.indexOf(Buffer.from([0x44, 0x89]));
  if (d < 0) return null;
  const size = buf[d + 2];
  const ticks = size === 0x84 ? buf.readFloatBE(d + 3) : size === 0x88 ? buf.readDoubleBE(d + 3) : null;
  return ticks && ticks > 0 ? (ticks * scale) / 1e9 : null;
}

async function fileSeconds(url, headers) {
  const head = await fetchRange(url, headers, `bytes=0-${HEAD_BYTES - 1}`);
  if (!head) return null;
  const webm = webmSeconds(head.buf);
  if (webm) return webm;
  const direct = mvhdSeconds(head.buf);
  if (direct) return direct;
  const moov = moovOffset(head.buf);
  if (moov && (!head.total || moov < head.total)) {
    const tail = await fetchRange(url, headers, `bytes=${moov}-${moov + HEAD_BYTES - 1}`);
    if (tail) return mvhdSeconds(tail.buf);
  }
  return null;
}

/** Total of a stream's segment lengths; Infinity for a live stream. */
async function streamSeconds(url, headers, depth = 0) {
  const { res, url: finalUrl } = await guardedRequest(url, { headers, timeout: 6000 });
  const text = await readText(res, 2_000_000);
  if (!text.trimStart().startsWith('#EXTM3U')) return null;
  const lines = text.split(/\r?\n/);
  const variant = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (variant >= 0) {
    if (depth > 1) return null;
    const next = lines.slice(variant + 1).find((l) => l.trim() && !l.startsWith('#'));
    return next ? streamSeconds(new URL(next.trim(), finalUrl).href, headers, depth + 1) : null;
  }
  if (!text.includes('#EXT-X-ENDLIST')) return Infinity;
  let total = 0;
  for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) total += Number(m[1]);
  return total > 0 ? total : null;
}

/** Seconds (Infinity when live), or null when it can't be told. Never throws. */
export async function probeDuration({ kind, url, headers = {} }) {
  try {
    return kind === 'hls' ? await streamSeconds(url, headers) : await fileSeconds(url, headers);
  } catch {
    return null;
  }
}
