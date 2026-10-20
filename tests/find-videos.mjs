// Finder and shared-download checks that need no internet. Runs the server's
// own modules with local addresses allowed, against pages served from here.
//   npm run test:find
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STREAM_ALLOW_PRIVATE = 'true';
const work = mkdtempSync(join(tmpdir(), 'adda-find-'));
process.env.STREAM_CACHE_DIR = join(work, 'cache');
const serverEnv = new URL('../server/.env', import.meta.url).pathname;
try {
  process.loadEnvFile(serverEnv);
} catch {
  /* defaults are fine for these checks */
}

const { probeDuration } = await import('../server/src/stream/probe.js');
const { findVideos } = await import('../server/src/stream/find.js');
const { cachedFile } = await import('../server/src/stream/cache.js');
const { ffmpegPath } = await import('../server/src/stream/ffmpeg.js');
const { prepareJoined } = await import('../server/src/stream/merge.js');
const { pairForJoining } = await import('../server/src/stream/formats.js');
const { execFileSync, spawnSync } = await import('node:child_process');

// ── Fixtures ─────────────────────────────────────────────────────────

const box = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const mvhd = (seconds) => {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(1000, 12); // timescale
  b.writeUInt32BE(seconds * 1000, 16); // duration
  return box('mvhd', b);
};
const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1'));
const site = join(work, 'site');
mkdirSync(join(site, 'movie'), { recursive: true });
// Index at the start (5 s preview) and at the end (13 min, as many uploads are).
writeFileSync(join(site, 'preview-5s.mp4'), Buffer.concat([ftyp, box('moov', mvhd(5)), box('mdat', Buffer.alloc(200 * 1024))]));
writeFileSync(join(site, 'movie-13min.mp4'), Buffer.concat([ftyp, box('mdat', Buffer.alloc(2 * 1024 * 1024)), box('moov', mvhd(780))]));
let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-PLAYLIST-TYPE:VOD\n';
for (let i = 0; i < 78; i++) playlist += `#EXTINF:10.0,\nseg${i}.ts\n`;
writeFileSync(join(site, 'movie', 'stream-playlist'), `${playlist}#EXT-X-ENDLIST\n`);
writeFileSync(join(site, 'live-playlist'), '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n#EXTINF:6.0,\nb.ts\n');
writeFileSync(join(site, 'clip.webm'), readFileSync(new URL('./fixtures/count-40s.webm', import.meta.url)));
writeFileSync(join(site, 'movie-12mb.mp4'), randomBytes(12 * 1024 * 1024));
// A page with a hover-preview clip, whose real movie is a stream that loads
// only after Play, from a URL with no .m3u8 and a generic content type.
writeFileSync(
  join(site, 'page.html'),
  `<!doctype html><title>My 13 minute movie</title>
   <video src="/preview-5s.mp4" autoplay muted loop></video>
   <button class="big-play-button" onclick="fetch('/movie/stream-playlist').then((r) => r.text())">Play</button>`,
);

// A silent H.264 picture file and a separate AAC sound file, 20 s each, like
// the split qualities many sites offer (needs FFmpeg; skipped without it).
const ffmpeg = ffmpegPath();
if (ffmpeg) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=20:size=320x180:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', join(site, 'picture-only.mp4')]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:a', 'aac', '-vn', join(site, 'sound-only.m4a')]);
}

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.html': 'text/html' };
let inFlight = 0;
let maxInFlight = 0;
const server = createServer(async (req, res) => {
  const query = new URL(req.url, 'http://x').searchParams;
  // ?single: like sites that allow one connection at a time.
  if (query.has('single') && inFlight > 0) return res.writeHead(429).end();
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try {
    body = readFileSync(join(site, path));
  } catch {
    return res.writeHead(404).end();
  }
  const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  // Like some CDNs, hand out at most 64 KB per range request when ?pieces is set.
  const cap = new URL(req.url, 'http://x').searchParams.has('pieces') ? 65536 : Infinity;
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = Math.min(m?.[2] ? Number(m[2]) : body.length - 1, start + cap - 1, body.length - 1);
  res.writeHead(m ? 206 : 200, {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    ...(m ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}),
  });
  const slice = body.subarray(start, end + 1);
  // ?rate=N: like sites that limit each connection to N bytes per second.
  const rate = Number(query.get('rate'));
  if (!rate) return res.end(slice);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  res.on('close', () => inFlight--);
  const step = Math.ceil(rate / 10);
  for (let off = 0; off < slice.length && !res.destroyed; off += step) {
    res.write(slice.subarray(off, off + step));
    await new Promise((r) => setTimeout(r, 100));
  }
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── Checks ───────────────────────────────────────────────────────────

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push(true);
    console.log('PASS', label);
  } catch (err) {
    results.push(false);
    console.log('FAIL', label, '-', err.message);
  }
}
const near = (got, want, what) => {
  if (!(Math.abs((got ?? -1) - want) < 1)) throw new Error(`${what}: got ${got}, expected ${want}`);
};

await check('MP4 length when the index is at the start', async () =>
  near(await probeDuration({ kind: 'file', url: `${base}/preview-5s.mp4` }), 5, 'seconds'));
await check('MP4 length when the index is at the end of the file', async () =>
  near(await probeDuration({ kind: 'file', url: `${base}/movie-13min.mp4` }), 780, 'seconds'));
await check('WebM length', async () => near(await probeDuration({ kind: 'file', url: `${base}/clip.webm` }), 40, 'seconds'));
await check('stream length, from a URL without .m3u8', async () =>
  near(await probeDuration({ kind: 'hls', url: `${base}/movie/stream-playlist` }), 780, 'seconds'));
await check('a live stream is recognised as live', async () => {
  const d = await probeDuration({ kind: 'hls', url: `${base}/live-playlist` });
  if (d !== Infinity) throw new Error(`got ${d}`);
});

await check('a page with a 5 s preview finds the 13 min movie, not the preview', async () => {
  const r = await findVideos(`${base}/page.html`, { userId: 'test' });
  const lengths = r.videos.map((v) => Math.round(v.duration ?? -1));
  if (lengths[0] !== 780) throw new Error(`first video lasts ${lengths[0]} s (all: ${lengths})`);
  if (lengths.includes(5)) throw new Error(`the 5 s preview is still offered (${lengths})`);
  if (!r.notes.some((n) => /Short clips/.test(n))) throw new Error('no note about the skipped clip');
});

await check('a file handed out in 64 KB pieces downloads completely and intact', async () => {
  const entry = await cachedFile('pieces', `${base}/clip.webm?pieces`, {});
  if (!entry) throw new Error('not cached');
  const until = Date.now() + 15000;
  while (!entry.done && !entry.failed && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const chunks = [];
  for await (const c of entry.read(0, entry.size - 1)) chunks.push(c);
  const same = Buffer.compare(Buffer.concat(chunks), readFileSync(join(site, 'clip.webm'))) === 0;
  if (!entry.done || !same) throw new Error(`downloaded ${entry.downloaded} of ${entry.size}, intact: ${same}`);
});

async function download(key, url) {
  const t0 = Date.now();
  const entry = await cachedFile(key, url, {});
  if (!entry) throw new Error('not cached');
  while (!entry.done && !entry.failed && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
  const chunks = [];
  for await (const c of entry.read(0, entry.size - 1)) chunks.push(c);
  const intact = Buffer.compare(Buffer.concat(chunks), readFileSync(join(site, new URL(url).pathname))) === 0;
  return { entry, intact, seconds: (Date.now() - t0) / 1000 };
}

await check('several connections at once speed up a site that limits each one (like IDM)', async () => {
  maxInFlight = 0;
  // 12 MB at 1 MB/s per connection: one connection would need about 12 s.
  const { entry, intact, seconds } = await download('fast', `${base}/movie-12mb.mp4?rate=1000000`);
  console.log(`     12 MB in ${seconds.toFixed(1)} s using up to ${maxInFlight} connections (one connection: ~12 s)`);
  if (!entry.done || !intact) throw new Error(`done ${entry.done}, intact ${intact}`);
  if (maxInFlight < 3 || seconds > 8) throw new Error(`${maxInFlight} connections, ${seconds.toFixed(1)} s`);
});

await check('a site that allows only one connection still downloads completely', async () => {
  // Let the previous check's connections finish closing first.
  for (let i = 0; i < 40 && inFlight > 0; i++) await new Promise((r) => setTimeout(r, 50));
  maxInFlight = 0;
  const { entry, intact } = await download('single', `${base}/movie-12mb.mp4?rate=4000000&single`);
  if (!entry.done || !intact) throw new Error(`done ${entry.done}, intact ${intact}, failed: ${entry.failed?.message}`);
  if (maxInFlight > 1) throw new Error(`used ${maxInFlight} connections`);
});

await check('jumping ahead starts a connection right there, so that part arrives quickly', async () => {
  const entry = await cachedFile('jump', `${base}/movie-12mb.mp4?rate=500000`, {});
  const at = 10 * 1024 * 1024; // 10 MB in; one connection would need ~20 s to get there
  const t0 = Date.now();
  if (!entry.serves(at)) throw new Error('would not serve from the shared download');
  const chunks = [];
  for await (const c of entry.read(at, at + 256 * 1024 - 1)) chunks.push(c);
  const seconds = (Date.now() - t0) / 1000;
  const correct = Buffer.compare(Buffer.concat(chunks), readFileSync(join(site, 'movie-12mb.mp4')).subarray(at, at + 256 * 1024)) === 0;
  console.log(`     256 KB at the 10 MB mark arrived in ${seconds.toFixed(1)} s`);
  if (!correct || seconds > 3) throw new Error(`correct ${correct}, ${seconds.toFixed(1)} s`);
  await entry.close();
});

await check('separate picture (H.264) and sound (AAC) are paired for joining into MP4', async () => {
  const [joined] = pairForJoining(
    [{ url: 'v', headers: {}, ext: 'mp4', vcodec: 'avc1.4d401f', height: 1080, size: 100 }],
    [{ url: 'opus', headers: {}, ext: 'webm', acodec: 'opus', abr: 160 }, { url: 'aac', headers: {}, ext: 'm4a', acodec: 'mp4a.40.2', abr: 128 }],
  );
  if (joined?.container !== 'mp4' || joined.audio.url !== 'aac') throw new Error(JSON.stringify(joined));
  const [webm] = pairForJoining([{ url: 'v', headers: {}, ext: 'webm', vcodec: 'vp9', height: 1080 }], [{ url: 'opus', headers: {}, ext: 'webm', acodec: 'opus', abr: 160 }]);
  if (webm?.container !== 'webm') throw new Error(JSON.stringify(webm));
});

await check('picture and sound downloaded separately are joined into one playable file', async () => {
  if (!ffmpeg) {
    console.log('     (FFmpeg not installed; run npm run setup:ffmpeg)');
    return;
  }
  const phases = new Set();
  const out = await prepareJoined('join-test', {
    container: 'mp4',
    video: { url: `${base}/picture-only.mp4`, headers: {} },
    audio: { url: `${base}/sound-only.m4a`, headers: {} },
  }, { onProgress: (phase) => phases.add(phase) });
  const info = spawnSync(ffmpeg, ['-hide_banner', '-i', out]).stderr.toString();
  const hasPicture = /Stream #0:\d.*Video: h264/.test(info);
  const hasSound = /Stream #0:\d.*Audio: aac/.test(info);
  const seconds = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(info)?.slice(1).reduce((t, x) => t * 60 + Number(x), 0));
  if (!hasPicture || !hasSound || Math.abs(seconds - 20) > 1 || !phases.has('join')) {
    throw new Error(`picture ${hasPicture}, sound ${hasSound}, ${seconds} s, phases ${[...phases]}`);
  }
  console.log(`     joined file: H.264 picture + AAC sound, ${seconds.toFixed(1)} s`);
});

server.close();
rmSync(work, { recursive: true, force: true });
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
