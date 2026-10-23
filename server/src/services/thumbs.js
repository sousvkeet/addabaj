// Small copies of sent photos, and a frame of sent videos, for showing them in
// a chat: a phone (or a browser on mobile data) needn't download a whole photo
// to show it in a bubble. FFmpeg makes each one the first time it's asked
// for, and it's kept beside the files. Without FFmpeg, photos are sent whole
// and videos have no picture.
import { execFile } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegPath } from '../stream/ffmpeg.js';
import { thumbDir } from './uploads.js';

/** The sizes made (the longer side, in pixels): a blurred placeholder, a bubble, a large bubble. */
const SIZES = [48, 320, 640];
/** At most this many FFmpeg runs at once, so a long chat scrolled quickly can't load the server. */
const AT_ONCE = 2;

const making = new Map(); // output file -> Promise<string | null>
const waiting = [];
let running = 0;

/** The nearest size made, for what was asked (?thumb=480 gets 640). */
export function thumbSize(asked) {
  const n = Number(asked);
  if (!Number.isFinite(n) || n <= 0) return SIZES.at(-1);
  return SIZES.find((s) => s >= n) ?? SIZES.at(-1);
}

/** Whether a sent file has a small copy (GIFs move, so they're shown whole). */
export const hasThumb = (row) => (row.kind === 'image' && row.mime !== 'image/gif') || row.kind === 'video';

const exists = (path) => stat(path).then(
  (s) => s.size > 0,
  () => false,
);

function slot() {
  if (running < AT_ONCE) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

async function make(src, out, size, video, duration) {
  await slot();
  const part = `${out}.part`;
  try {
    const scale = `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`;
    const encode = ['-frames:v', '1', '-vf', scale, '-q:v', size <= 64 ? '8' : '5', '-f', 'image2', '-c:v', 'mjpeg', '-y', part];
    // A video's picture from just after its start (its very first frame is often black).
    const seek = video && (duration ?? 0) > 1 ? ['-ss', '0.5'] : [];
    await ffmpeg(['-hide_banner', '-loglevel', 'error', ...seek, '-i', src, ...encode]);
    if (!(await exists(part))) return null;
    await rename(part, out);
    return out;
  } catch {
    await rm(part, { force: true });
    return null;
  } finally {
    release();
  }
}

/**
 * The small copy of a sent file (a path), made if needed; null when there
 * can't be one (no FFmpeg, or a file FFmpeg can't read).
 */
export async function thumbFor({ path, row }, size) {
  if (!hasThumb(row)) return null;
  const out = join(thumbDir, `${row.stored}-${size}.jpg`);
  if (await exists(out)) return out;
  if (!ffmpegPath()) return null;
  let job = making.get(out);
  if (!job) {
    job = make(path, out, size, row.kind === 'video', row.duration).finally(() => making.delete(out));
    making.set(out, job);
  }
  return job;
}

/** Sends a small copy, cached like the file itself (it never changes). */
export function sendThumb(res, path) {
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path, { dotfiles: 'allow' });
}
