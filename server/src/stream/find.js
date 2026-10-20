// "Find videos": turns any pasted link into a list of playable choices, the
// way a download manager does. Tries, in order: YouTube, a direct video link,
// yt-dlp (site support), a scan of the page's HTML, and a deep scan in a
// hidden browser. Results stay on the server; people only see option ids.
import { randomUUID } from 'node:crypto';
import { badRequest } from '../errors.js';
import { fileTitle, youtubeLink, youtubeTitle } from '../services/watch.js';
import { finishOptions, playlistHasDrm } from './formats.js';
import { assertPublicHost } from './guard.js';
import { guardedRequest, isMediaType, isPlaylistType, readText } from './http.js';
import { scanPage } from './scan.js';
import { deepScan } from './sniff.js';
import { ytdlpFind, ytdlpPath } from './ytdlp.js';

const DIRECT = /\.(mp4|m4v|webm|mov|m3u8)$/i;
const SCAN_TTL_MS = 20 * 60 * 1000;
const scans = new Map(); // scanId -> { userId, at, videos }

function parseLink(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw badRequest('Paste a link first.');
  if (text.length > 4000) throw badRequest('That link is too long.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw badRequest("That isn't a link. Paste a full address starting with https://");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Only http:// and https:// links can be played.');
  url.hash = '';
  return url;
}

/**
 * A link that looks like a file may still be a web page (e.g. a wiki page
 * named "Clip.webm"), so ask what it really serves. If the server can't check
 * (private address, network), trust the extension and let browsers try.
 */
async function directKind(url) {
  const ext = DIRECT.exec(url.pathname)[1].toLowerCase();
  const guess = { kind: ext === 'm3u8' ? 'hls' : 'file', ext };
  try {
    const { res } = await guardedRequest(url.href, { headers: { range: 'bytes=0-2047' }, timeout: 6000 });
    const type = res.headers['content-type'] ?? '';
    if (/html/i.test(type)) {
      res.resume();
      return null; // a page: find the videos on it instead
    }
    if (isPlaylistType(type) || ext === 'm3u8') {
      const text = await readText(res, 4096);
      return text.trimStart().startsWith('#EXTM3U') ? { kind: 'hls', ext: 'm3u8' } : guess;
    }
    res.destroy();
    return isMediaType(type) ? { kind: 'file', ext: /webm/i.test(type) ? 'webm' : ext } : guess;
  } catch {
    return guess;
  }
}

/**
 * DRM often hides one level down: the master playlist looks normal but each
 * quality playlist is encrypted for Widevine/FairPlay. Check one quality.
 */
async function streamIsProtected(option) {
  try {
    const { res, url } = await guardedRequest(option.url, { headers: option.headers, timeout: 6000 });
    const master = await readText(res, 2_000_000);
    if (playlistHasDrm(master)) return true;
    const lines = master.split(/\r?\n/);
    const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const variant = i >= 0 ? lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#')) : null;
    if (!variant) return false;
    const v = await guardedRequest(new URL(variant.trim(), url).href, { headers: option.headers, timeout: 6000 });
    return playlistHasDrm(await readText(v.res, 2_000_000));
  } catch {
    return false; // can't tell; let the player try
  }
}

/** Removes protected streams (and videos left with nothing playable). */
async function withoutDrm(videos, skipped) {
  const checks = videos.flatMap((v) => v.options.filter((o) => o.kind === 'hls').map((o) => streamIsProtected(o).then((drm) => (o.drm = drm))));
  await Promise.all(checks.slice(0, 8));
  const kept = [];
  for (const v of videos) {
    const before = v.options.length;
    v.options = v.options.filter((o) => !o.drm);
    skipped.drm += before - v.options.length;
    if (v.options.length) {
      if (!v.options.some((o) => o.recommended)) v.options[0].recommended = true;
      kept.push(v);
    }
  }
  return kept;
}

/** Public embed players for sites whose main page asks for a login (used with yt-dlp). */
function embedAlternative(url) {
  const vimeo = /^(?:www\.)?vimeo\.com$/.test(url.hostname) && /^\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

const NOTES = {
  drm: 'Some videos were skipped because they are protected (DRM).',
  split: 'Some qualities were skipped because their picture and sound are separate files.',
  codec: 'Some files were skipped because browsers can’t play their format.',
};

const FAILURES = {
  drm: 'This video is protected (DRM), so it can’t be played here. Services like Netflix and Prime Video work this way.',
  login: 'This site only shows the video to logged-in users, so it can’t be fetched from here.',
  unavailable: 'The video on this page isn’t available. It may be private or removed.',
  geo: 'This video isn’t available in the server’s country.',
  split: 'This site keeps picture and sound in separate files, which can’t be played together here.',
  blocked: 'That link points to a private or local address, which this server won’t fetch.',
  unreachable: 'Couldn’t open that page. Check the link, or try again in a moment.',
};

export async function findVideos(raw, { userId, onProgress } = {}) {
  const url = parseLink(raw);
  const progress = (message) => onProgress?.(message);
  const reasons = new Set();
  const skipped = { drm: 0, split: 0, codec: 0 };
  const collect = (r) => {
    if (r?.reason) reasons.add(r.reason);
    for (const k of Object.keys(skipped)) skipped[k] += r?.skipped?.[k] ?? 0;
  };
  let videos = [];

  const yt = youtubeLink(url);
  if (yt) {
    progress('Checking the YouTube video…');
    const title = (await youtubeTitle(yt.videoId)) ?? 'YouTube video';
    videos = [{ title, site: 'YouTube', thumbnail: `https://i.ytimg.com/vi/${yt.videoId}/mqdefault.jpg`, options: finishOptions([{ kind: 'youtube', videoId: yt.videoId, start: yt.start }]) }];
  }
  const direct = !yt && DIRECT.test(url.pathname) ? await directKind(url) : null;
  if (direct) {
    // A direct video link: everyone's browser plays it directly, and the
    // server relays it only if a browser can't (cross-site blocks, http on https).
    videos = [{
      title: fileTitle(url),
      site: url.hostname.replace(/^www\./, ''),
      options: finishOptions([{ ...direct, url: url.href, headers: {}, direct: true }]),
    }];
  } else if (!yt) {
    await assertPublicHost(url.hostname); // clear error up front for local links

    if (ytdlpPath()) {
      progress('Asking the site for its videos…');
      let r = await ytdlpFind(url.href);
      const alt = !r.videos.length && r.reason === 'login' ? embedAlternative(url) : null;
      if (alt) {
        const embedded = await ytdlpFind(alt);
        if (embedded.videos.length) r = embedded;
      }
      collect(r);
      videos = await withoutDrm(r.videos, skipped);
    }
    if (!videos.length) {
      progress('Reading the page…');
      try {
        const r = await scanPage(url.href);
        if (r.direct) {
          videos = [{ title: fileTitle(new URL(r.direct.url)), site: url.hostname.replace(/^www\./, ''), options: finishOptions([{ ...r.direct, headers: {} }]) }];
        } else {
          collect(r);
          videos = await withoutDrm(r.videos, skipped);
        }
      } catch (err) {
        if (err.code === 'EBLOCKED') throw err;
        reasons.add('unreachable');
      }
    }
    if (!videos.length) {
      progress('Looking deeper: opening the page in a background browser…');
      const r = await deepScan(url.href, { onProgress: progress });
      collect(r);
      videos = await withoutDrm(r.videos, skipped);
    }
  }

  if (!videos.length) {
    const why = ['drm', 'login', 'unavailable', 'geo', 'blocked', 'split', 'unreachable'].find((r) => reasons.has(r) || skipped[r]);
    throw badRequest(
      FAILURES[why] ?? 'No playable video was found on this page. Try the page of the video itself, or a direct link to the video file.',
    );
  }

  videos.forEach((v, i) => {
    v.id = String(i);
    v.options.forEach((o, j) => (o.id = `${i}.${j}`));
  });
  const scanId = randomUUID();
  scans.set(scanId, { userId, at: Date.now(), videos });
  for (const [id, s] of scans) if (Date.now() - s.at > SCAN_TTL_MS) scans.delete(id);

  return {
    scanId,
    videos: videos.map((v) => ({
      id: v.id,
      title: v.title,
      thumbnail: v.thumbnail ?? null,
      duration: v.duration ?? null,
      live: !!v.live,
      site: v.site ?? null,
      options: v.options.map((o) => ({
        id: o.id,
        kind: o.kind,
        label: o.label,
        detail: o.detail,
        size: o.sizeLabel ?? null,
        recommended: !!o.recommended,
        relay: o.kind !== 'youtube' && !o.direct,
      })),
    })),
    notes: Object.entries(skipped).filter(([, n]) => n > 0).map(([k]) => NOTES[k]),
  };
}

/** The full (server-side) choice behind an option id from an earlier search. */
export function takeOption(scanId, optionId, userId) {
  const scan = scans.get(scanId);
  if (!scan || scan.userId !== userId || Date.now() - scan.at > SCAN_TTL_MS) {
    throw badRequest('That search has expired. Find the videos again.');
  }
  for (const video of scan.videos) {
    const option = video.options.find((o) => o.id === optionId);
    if (option) return { video, option };
  }
  throw badRequest('Pick one of the videos that were found.');
}

/** The best option for a link, for callers that skip the choosing step. */
export async function bestFor(raw, { userId } = {}) {
  const { scanId, videos } = await findVideos(raw, { userId });
  const first = videos[0];
  return takeOption(scanId, (first.options.find((o) => o.recommended) ?? first.options[0]).id, userId);
}
