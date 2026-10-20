// Finds videos with yt-dlp, which understands ~1,800 sites and generic web
// players. All of its traffic goes through the private-address guard proxy.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardProxy } from './guard.js';
import { finishOptions, pickHeaders, playableFile } from './formats.js';

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
  if (/private or local address|403: forbidden/i.test(line)) return { reason: 'blocked' };
  return { reason: 'failed', detail: line.replace(/^ERROR:\s*/, '').slice(0, 200) };
}

/** "archive.org" rather than yt-dlp's internal "ArchiveOrg". */
function siteName(entry, info) {
  const domain = entry.webpage_url_domain ?? info.webpage_url_domain;
  if (domain) return domain.replace(/^(www|m|player)\./, '');
  return entry.extractor_key && entry.extractor_key !== 'Generic' ? entry.extractor_key : null;
}

function normalize(info) {
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
    if (/^youtube$/i.test(e.extractor_key ?? '') && /^[\w-]{11}$/.test(e.id ?? '')) {
      videos.push({ ...meta, site: 'YouTube', options: finishOptions([{ kind: 'youtube', videoId: e.id }]) });
      continue;
    }
    const formats = e.formats?.length ? e.formats : e.url ? [e] : [];
    const options = [];
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
      if (f.vcodec === 'none') continue; // sound only
      if (f.acodec === 'none') {
        skipped.split++;
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
    if (options.length) videos.push({ ...meta, options: finishOptions(options) });
  }
  return { videos, skipped };
}

/** Returns { videos, skipped } or { videos: [], reason } — never throws for site problems. */
export async function ytdlpFind(url) {
  const bin = ytdlpPath();
  if (!bin) return { videos: [], reason: 'missing' };
  const proxy = await guardProxy();
  const release = await slot();
  try {
    const args = [
      '-J', '--ignore-config', '--no-warnings', '--skip-download', '--no-playlist',
      '--playlist-items', '1:8', '--socket-timeout', '15', '--proxy', proxy.url, '--', url,
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
    return normalize(info);
  } catch (err) {
    return { videos: [], reason: 'failed', detail: err.message };
  } finally {
    release();
  }
}
