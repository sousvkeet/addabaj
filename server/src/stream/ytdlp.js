// Finds videos with yt-dlp, which understands ~1,800 sites and generic web
// players. All of its traffic goes through the private-address guard proxy.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardProxy } from './guard.js';
import { finishOptions, pairForJoining, pickHeaders, playableFile } from './formats.js';
import { ffmpegPath } from './ffmpeg.js';

const bundled = fileURLToPath(new URL('../../bin/yt-dlp', import.meta.url));

const executable = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

let found;
export function ytdlpPath() {
  if (found !== undefined) return found;
  const candidates = [process.env.YTDLP_PATH, bundled, ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, 'yt-dlp'))];
  found = candidates.find((p) => p && executable(p)) ?? null;
  return found;
}

let version = null;
/** yt-dlp's version ("2026.08.19"), or null when it's missing or won't run. */
export function ytdlpVersion() {
  const path = ytdlpPath();
  if (!path) return Promise.resolve(null);
  version ??= new Promise((resolve) =>
    execFile(path, ['--version'], { timeout: 20_000 }, (err, out) => resolve(err ? null : String(out).trim() || null)),
  );
  return version;
}

/** Installs yt-dlp when there's none (a fresh deploy has no server/bin/). */
export async function ensureYtdlp() {
  if (ytdlpPath()) return { installed: false };
  const { installYtdlp } = await import('./ytdlp-install.js');
  const result = await installYtdlp();
  found = undefined;
  version = null;
  return { installed: !!ytdlpPath(), ...result };
}

// At most two yt-dlp runs at once; each can take a few seconds.
let running = 0;
const queue = [];
async function slot() {
  if (running >= 2) await new Promise((resolve) => queue.push(resolve));
  running++;
  return () => {
    running--;
    queue.shift()?.();
  };
}

function reasonFrom(stderr) {
  const line = stderr.split('\n').filter((l) => l.startsWith('ERROR:')).pop() ?? '';
  if (/unsupported url/i.test(line)) return { reason: 'unsupported' };
  if (/drm/i.test(line)) return { reason: 'drm' };
  if (/log(ged)?[ -]?in|sign in|cookies|account/i.test(line)) return { reason: 'login' };
  if (/private|unavailable|removed|not exist|404/i.test(line)) return { reason: 'unavailable' };
  if (/country|geo/i.test(line)) return { reason: 'geo' };
  if (/private or local address/i.test(line)) return { reason: 'blocked' };
  // The site turned the server away (blocks servers, or limits how often it's visited).
  if (/HTTP Error (403|412|429)|forbidden|too many requests|precondition failed|captcha|rate.?limit/i.test(line)) return { reason: 'refused' };
  return { reason: 'failed', detail: line.replace(/^ERROR:\s*/, '').slice(0, 200) };
}

/** "archive.org" rather than yt-dlp's internal "ArchiveOrg". */
function siteName(entry, info) {
  const domain = entry.webpage_url_domain ?? info.webpage_url_domain;
  if (domain) return domain.replace(/^(www|m|player)\./, '');
  return entry.extractor_key && entry.extractor_key !== 'Generic' ? entry.extractor_key : null;
}

/** `keepYouTubeFiles`: list YouTube's own files (to fetch through the server) instead of its player. */
function normalize(info, { keepYouTubeFiles = false } = {}) {
  const entries = info._type === 'playlist' ? (info.entries ?? []).filter(Boolean) : [info];
  const videos = [];
  const skipped = { drm: 0, split: 0, codec: 0 };
  for (const e of entries) {
    const meta = {
      title: (e.title || info.title || 'Video').slice(0, 200),
      thumbnail: /^https?:/.test(e.thumbnail ?? '') ? e.thumbnail : null,
      duration: Number.isFinite(e.duration) ? e.duration : null,
      live: !!e.is_live,
      site: siteName(e, info),
      page: e.webpage_url ?? info.webpage_url ?? null,
    };
    // YouTube videos play in YouTube's own player instead of being relayed.
    if (!keepYouTubeFiles && /^youtube$/i.test(e.extractor_key ?? '') && /^[\w-]{11}$/.test(e.id ?? '')) {
      videos.push({ ...meta, site: 'YouTube', options: finishOptions([{ kind: 'youtube', videoId: e.id }]) });
      continue;
    }
    const formats = e.formats?.length ? e.formats : e.url ? [e] : [];
    const options = [];
    const pictureOnly = [];
    const soundOnly = [];
    let hls = null;
    for (const f of formats) {
      if (f.has_drm) {
        skipped.drm++;
        continue;
      }
      const protocol = String(f.protocol ?? '');
      const headers = pickHeaders(f.http_headers, f.cookies);
      if (protocol.startsWith('m3u8')) {
        // The whole HLS ladder becomes one adaptive option (the master playlist).
        const url = f.manifest_url || f.url;
        if (!hls) options.push((hls = { kind: 'hls', url, headers, maxHeight: f.height ?? 0 }));
        else hls.maxHeight = Math.max(hls.maxHeight, f.height ?? 0);
        continue;
      }
      if (protocol !== 'https' && protocol !== 'http') continue; // DASH, RTMP, storyboards…
      const size = f.filesize ?? f.filesize_approx ?? null;
      if (f.vcodec === 'none') {
        if (f.acodec && f.acodec !== 'none') soundOnly.push({ url: f.url, headers, ext: f.ext, acodec: f.acodec, abr: f.abr ?? f.tbr ?? 0, size });
        continue;
      }
      if (f.acodec === 'none') {
        if (playableFile(f)) pictureOnly.push({ url: f.url, headers, ext: f.ext, vcodec: f.vcodec, height: f.height ?? null, size });
        continue;
      }
      if (!playableFile(f)) {
        skipped.codec++;
        continue;
      }
      options.push({
        kind: 'file',
        url: f.url,
        headers,
        height: f.height ?? null,
        ext: f.ext,
        vcodec: f.vcodec,
        size: f.filesize ?? f.filesize_approx ?? null,
      });
    }
    // Picture-only qualities become playable by joining them with a sound file (needs FFmpeg).
    const joined = ffmpegPath() ? pairForJoining(pictureOnly, soundOnly) : [];
    if (pictureOnly.length && !joined.length) skipped.split += pictureOnly.length;
    options.push(...joined);
    if (options.length) videos.push({ ...meta, options: finishOptions(options) });
  }
  return { videos, skipped };
}

// The standalone yt-dlp build can impersonate a real browser's network
// fingerprint (curl_cffi), which gets past some bot blockers (as IDM-CLI does).
let impersonation;
function canImpersonate(bin) {
  if (impersonation !== undefined) return Promise.resolve(impersonation);
  return new Promise((resolve) => {
    execFile(bin, ['--list-impersonate-targets'], { timeout: 20_000 }, (_err, out) => {
      impersonation = /^chrome\b.*curl_cffi(?!.*unavailable)/im.test(String(out));
      resolve(impersonation);
    });
  });
}

/** Problems a browser disguise can't fix. */
const FINAL = new Set(['login', 'drm', 'unavailable', 'geo', 'blocked']);

/**
 * Returns { videos, skipped } or { videos: [], reason } — never throws for site
 * problems. If the site blocks the first try, tries again looking like Chrome.
 */
export async function ytdlpFind(url) {
  const first = await ytdlpRun(url, []);
  if (first.videos.length || FINAL.has(first.reason) || first.reason === 'missing') return first;
  if (!(await canImpersonate(ytdlpPath()))) return first;
  const second = await ytdlpRun(url, ['--impersonate', 'chrome', '--extractor-args', 'generic:impersonate']);
  return second.videos.length ? second : first;
}

// YouTube decides which qualities each of its "player clients" may see. As in
// IDM-CLI, try several and keep what gives the most: yt-dlp's own choice
// (it follows YouTube's changes; usually the whole ladder, picture and sound
// apart, joined here) together with android/ios (a ready-made 360p file),
// then IDM-CLI's other clients when YouTube refuses those.
const PLAYER_CLIENTS = [null, ['android', 'ios'], ['tv_embedded'], ['web_safari'], ['mweb'], ['tv'], ['web']];
const clientArgs = (clients) => (clients ? ['--extractor-args', `youtube:player_client=${clients.join(',')}`] : []);

/**
 * A YouTube video's own files, fetched the way IDM-CLI does, so it can play
 * through the server when YouTube's player can't be used (embedding turned
 * off, age checks, regions). Returns { title, duration, thumbnail, options } or null.
 */
export async function youtubeFiles(url, { budgetMs = 30_000 } = {}) {
  if (!ytdlpPath()) return null;
  const deadline = Date.now() + budgetMs;
  const heights = (v) => new Set((v?.options ?? []).map((o) => o.height).filter(Boolean)).size;
  const run = (clients) => ytdlpRun(url, clientArgs(clients), { keepYouTubeFiles: true }).then((r) => r.videos[0] ?? null);
  // The two best clients at once; their qualities complement each other.
  const firstTwo = (await Promise.all(PLAYER_CLIENTS.slice(0, 2).map(run))).filter(Boolean);
  let best = firstTwo[0] ?? null;
  if (firstTwo.length > 1) best = { ...firstTwo[0], options: finishOptions(firstTwo.flatMap((v) => v.options).map((o) => ({ ...o, recommended: false }))) };
  for (const clients of PLAYER_CLIENTS.slice(2)) {
    if (heights(best) >= 3 || Date.now() > deadline) break;
    const v = await run(clients);
    if (heights(v) > heights(best)) best = v;
  }
  return best?.options.length ? best : null;
}

async function ytdlpRun(url, extra, { keepYouTubeFiles = false } = {}) {
  const bin = ytdlpPath();
  if (!bin) return { videos: [], reason: 'missing' };
  const proxy = await guardProxy();
  const release = await slot();
  try {
    const args = [
      '-J', '--ignore-config', '--no-warnings', '--skip-download', '--no-playlist',
      '--playlist-items', '1:8', '--socket-timeout', '15', '--proxy', proxy.url,
      // YouTube needs a JavaScript runtime to solve its challenges; without one it
      // hides formats and throttles downloads. Node (running this server) will do.
      '--js-runtimes', `node:${process.execPath}`,
      ...extra, '--', url,
    ];
    const { stdout, stderr, timedOut } = await new Promise((resolve) => {
      execFile(bin, args, { timeout: 60_000, maxBuffer: 48 * 1024 * 1024 }, (err, out, errOut) =>
        resolve({ stdout: String(out), stderr: String(errOut), timedOut: err?.killed }),
      );
    });
    if (timedOut) return { videos: [], reason: 'timeout' };
    // On failure yt-dlp prints "null"; the reason is on stderr.
    const info = stdout.trim() ? JSON.parse(stdout) : null;
    if (!info) return { videos: [], ...reasonFrom(stderr) };
    return normalize(info, { keepYouTubeFiles });
  } catch (err) {
    return { videos: [], reason: 'failed', detail: err.message };
  } finally {
    release();
  }
}
