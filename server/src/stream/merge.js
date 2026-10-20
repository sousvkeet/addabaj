// Sites often keep their better qualities as a silent video file plus a
// separate sound file. Like IDM-CLI, the server downloads both (with the
// multi-connection download) and joins them with FFmpeg, copying the streams
// as they are (no re-encoding, so it's fast and loses nothing). The room sees
// "Getting the video ready…" with progress, then everyone starts together.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { config, streaming } from '../config.js';
import { query } from '../db.js';
import { getIO, roomChannel } from '../realtime.js';
import { getWatch, saveWatch } from '../services/watch.js';
import { cachedFile, registerLocal } from './cache.js';
import { ffmpegPath } from './ffmpeg.js';

const jobs = new Map(); // token -> { cancelled, child }

const progress = (roomId, phase, percent) => getIO()?.to(roomChannel(roomId)).emit('watch:preparing', { roomId, phase, percent });

/** Updates the room's video only if it's still this one (it may have changed meanwhile). */
async function updateIfCurrent(roomId, token, change) {
  const watch = await getWatch(roomId);
  if (watch?.stream?.token !== token) return;
  await saveWatch(roomId, change(watch));
}

const waitFor = (entry) =>
  new Promise((resolve) => {
    const check = () => (entry.done || entry.failed || entry.closed ? resolve() : entry.once('progress', check));
    check();
  });

/**
 * Downloads the picture and sound files (shared, multi-connection download)
 * and joins them into `${key}.merged.<container>` in the video space.
 * Returns the finished file's path. `onProgress(phase, percent)` reports along the way.
 */
export async function prepareJoined(key, { video, audio, container }, { onProgress = () => {}, job = {} } = {}) {
  const [v, a] = await Promise.all([cachedFile(`${key}:v`, video.url, video.headers), cachedFile(`${key}:a`, audio.url, audio.headers)]);
  if (!v || !a) throw new Error('Couldn’t download the picture and sound files. The link may have expired; find the video again.');
  if ((v.size + a.size) * 2 > streaming.cacheMaxBytes) throw new Error('This video is too large for the server’s video space (STREAM_CACHE_GB).');

  const total = v.size + a.size;
  const ticker = setInterval(() => onProgress('download', Math.min(95, Math.floor(((v.received + a.received) / total) * 95))), 1000);
  try {
    await Promise.all([waitFor(v), waitFor(a)]);
  } finally {
    clearInterval(ticker);
  }
  if (job.cancelled) return null;
  if (!v.done || !a.done) throw new Error('The site stopped sending the video. Find it again and try once more.');

  onProgress('join', 96);
  const out = join(streaming.cacheDir, `${key}.merged.${container}`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', v.path, '-i', a.path,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
    ...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
    out,
  ];
  try {
    await new Promise((resolve, reject) => {
      job.child = execFile(ffmpegPath(), args, { timeout: 30 * 60 * 1000 }, (err, _out, stderr) => {
        if (err) reject(new Error(`Couldn’t join picture and sound${stderr ? ` (${String(stderr).trim().split('\n').pop().slice(0, 160)})` : ''}. Try another quality.`));
        else resolve();
      });
    });
  } finally {
    await Promise.all([v.close(), a.close()]); // the separate files aren't needed any more
  }
  return job.cancelled ? null : out;
}

async function run(roomId, stream, job) {
  const { token } = stream;
  const out = await prepareJoined(token, stream.merge, { job, onProgress: (phase, percent) => progress(roomId, phase, percent) });
  if (!out) return;
  await registerLocal(token, out, stream.merge.container === 'webm' ? 'video/webm' : 'video/mp4');
  if (!config.isProd) console.log(`[merge] ready: ${out}`);
  await updateIfCurrent(roomId, token, (w) => ({
    ...w,
    source: { ...w.source, preparing: false, error: undefined },
    playing: true,
    position: 0,
    at: Date.now(),
  }));
}

export function startMerge(roomId, stream) {
  if (jobs.has(stream.token)) return;
  const job = { cancelled: false, child: null };
  jobs.set(stream.token, job);
  progress(roomId, 'download', 0);
  run(roomId, stream, job)
    .catch(async (err) => {
      if (job.cancelled) return;
      if (!config.isProd) console.warn(`[merge] failed: ${err.message}`);
      await updateIfCurrent(roomId, stream.token, (w) => ({ ...w, source: { ...w.source, preparing: false, error: err.message }, playing: false }));
    })
    .finally(() => jobs.delete(stream.token));
}

/** Stops a job whose video was changed or stopped. */
export function cancelMerge(token) {
  const job = jobs.get(token);
  if (!job) return;
  job.cancelled = true;
  job.child?.kill();
}

/** After a restart the temporary files are gone: prepare any merged video again. */
export async function resumeMerges() {
  const { rows } = await query(`SELECT id, watch FROM rooms WHERE watch->'stream'->'merge' IS NOT NULL`);
  for (const { id, watch } of rows) {
    await saveWatch(id, { ...watch, source: { ...watch.source, preparing: true, error: undefined }, playing: false, position: 0, at: Date.now() });
    startMerge(id, watch.stream);
  }
}
