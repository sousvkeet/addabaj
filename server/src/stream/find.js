// "Find videos": turns any pasted link into a list of playable choices, the
// way a download manager does. Tries, in order: YouTube, a direct video link,
// yt-dlp (site support), a scan of the page's HTML, and a deep scan in a
// hidden browser. Results stay on the server; people only see option ids.
import { randomUUID } from 'node:crypto';
import { badRequest } from '../errors.js';
import { fileTitle, youtubeInfo, youtubeLink, youtubePlaylistId } from '../services/watch.js';
import { finishOptions, playlistHasDrm } from './formats.js';
import { adBlocker, isAd } from './adblock.js';
import { assertPublicHost } from './guard.js';
import { probeDuration } from './probe.js';
import { guardedRequest, isMediaType, isPlaylistType, readText } from './http.js';
import { scanPage } from './scan.js';
import { deepScan } from './sniff.js';
import { youtubeFiles, ytdlpFind, ytdlpPath, ytdlpPlaylist } from './ytdlp.js';

const DIRECT = /\.(mp4|m4v|webm|mov|m3u8)$/i;
const SCAN_TTL_MS = 20 * 60 * 1000;
const scans = new Map(); // scanId -> { userId, at, videos, link, playlist }
/** At most this many of a playlist's videos go into Up next at once. */
const PLAYLIST_MAX = 50;

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

/**
 * Leaves out ad videos (pre-rolls, promos from ad networks) that a finder
 * picked up, using the same filter lists as the ad blocker.
 */
function withoutAds(videos, pageUrl, skipped) {
  const urls = (o) => (o.kind === 'merge' ? [o.video?.url, o.audio?.url] : [o.url]).filter(Boolean);
  const ad = (o) => urls(o).some((u) => isAd(u, { sourceUrl: pageUrl, type: o.kind === 'hls' ? 'xhr' : 'media' }));
  const kept = [];
  for (const v of videos) {
    const options = v.options.filter((o) => !ad(o));
    if (!options.length) {
      skipped.ads++;
      continue;
    }
    if (options.length < v.options.length && !options.some((o) => o.recommended)) options[0].recommended = true;
    kept.push({ ...v, options });
  }
  return kept;
}

/** Public embed players for sites whose main page asks for a login (used with yt-dlp). */
function embedAlternative(url) {
  const vimeo = /^(?:www\.)?vimeo\.com$/.test(url.hostname) && /^\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

/** Clips shorter than this are dropped when a real video (LONG_SECONDS+) is also found. */
const SHORT_SECONDS = 30;
const LONG_SECONDS = 60;

const isShort = (v) => !v.live && v.duration != null && v.duration < SHORT_SECONDS;
const allShort = (videos) => videos.length > 0 && videos.every(isShort);

/** Fills in how long each found video is (scans don't know; yt-dlp usually does). */
async function withDurations(videos) {
  await Promise.all(
    videos
      .filter((v) => v.duration == null && !v.live)
      .slice(0, 12)
      .map(async (v) => {
        const o = v.options.find((x) => x.kind !== 'youtube');
        if (!o) return;
        // A video that has to be joined: its picture file tells the length.
        const option = o.kind === 'merge' ? { kind: 'file', url: o.video.url, headers: o.video.headers } : o;
        const seconds = await probeDuration(option);
        if (seconds === Infinity) v.live = true;
        else if (seconds) v.duration = seconds;
      }),
  );
  return videos;
}

/** Adds newly found videos, skipping ones already in the list. */
function merge(videos, more) {
  const key = (o) => o.url ?? o.videoId ?? o.video?.url;
  const seen = new Set(videos.flatMap((v) => v.options.map(key)));
  return [...videos, ...more.filter((v) => !v.options.some((o) => seen.has(key(o))))];
}

/**
 * Drops short clips (previews, intros, ads) when a real video is there, and,
 * for videos found by scanning, lists the longest first.
 */
function rank(videos, skipped, { byLength }) {
  const hasLong = videos.some((v) => v.live || (v.duration ?? 0) >= LONG_SECONDS);
  const kept = hasLong ? videos.filter((v) => !isShort(v)) : videos;
  skipped.short += videos.length - kept.length;
  if (!byLength) return kept;
  const length = (v) => (v.live ? Number.MAX_VALUE : v.duration ?? -1);
  return kept.map((v, i) => [v, i]).sort(([a, i], [b, j]) => length(b) - length(a) || i - j).map(([v]) => v);
}

const NOTES = {
  ads: 'Ad videos on the page were left out.',
  short: 'Short clips on the page (previews or ads) were left out.',
  drm: 'Some videos were skipped because they are protected (DRM).',
  split: 'Some qualities were skipped because their picture and sound are separate files.',
  codec: 'Some files were skipped because browsers can’t play their format.',
};

const FAILURES = {
  drm: 'This video is protected (DRM), so it can’t be played here. Services like Netflix and Prime Video work this way.',
  login: 'This site only shows the video to logged-in users, so it can’t be fetched from here.',
  unavailable: 'The video on this page isn’t available. It may be private or removed.',
  geo: 'This video isn’t available in the server’s country.',
  age: 'This site requires digital age verification in the server’s country (France). Stream it live from your device instead, or paste a direct video link.',
  split: 'This site keeps picture and sound in separate files, which can’t be played together here.',
  blocked: 'That link points to a private or local address, which this server won’t fetch.',
  refused:
    'The site is turning this server away right now. Sites do this to servers, or when they’re visited too often. Try again in a while, or paste a direct link to the video file.',
  unreachable: 'Couldn’t open that page. Check the link, or try again in a moment.',
};

export async function findVideos(raw, { userId, onProgress } = {}) {
  const url = parseLink(raw);
  const progress = (message) => onProgress?.(message);
  const reasons = new Set();
  const skipped = { drm: 0, split: 0, codec: 0, short: 0, ads: 0 };
  let adsBlocked = 0;
  let byLength = false;
  const collect = (r) => {
    if (r?.reason) reasons.add(r.reason);
    adsBlocked += r?.adsBlocked ?? 0;
    for (const k of Object.keys(skipped)) skipped[k] += r?.skipped?.[k] ?? 0;
  };
  let videos = [];

  const extraNotes = [];
  const yt = youtubeLink(url);
  // A YouTube playlist (its page, or a video played from it): all its videos can go into Up next.
  const listId = youtubePlaylistId(url);
  let playlist = null;
  if (listId) {
    progress('Reading the playlist…');
    playlist = await ytdlpPlaylist(`https://www.youtube.com/playlist?list=${listId}`, { max: PLAYLIST_MAX });
  }
  if (!yt && playlist) {
    // The playlist's page: its first videos to pick one from.
    videos = playlist.entries
      .filter((e) => e.videoId)
      .slice(0, 8)
      .map((e) => ({ title: e.title, site: 'YouTube', thumbnail: e.thumbnail, duration: e.duration, options: finishOptions([{ kind: 'youtube', videoId: e.videoId }]) }));
  }
  if (yt) {
    // YouTube's own player when it's allowed (instant, no load on the server),
    // and, like IDM-CLI, the video's own files fetched through the server: they
    // play even where YouTube's player won't.
    progress('Checking the YouTube video…');
    const info = await youtubeInfo(yt.videoId);
    progress('Asking YouTube for its qualities…');
    const files = await youtubeFiles(`https://www.youtube.com/watch?v=${yt.videoId}`).catch(() => null);
    const options = [
      ...(info.embeddable ? [{ kind: 'youtube', videoId: yt.videoId, start: yt.start }] : []),
      ...(files?.options ?? []).map((o) => ({ ...o, recommended: false })),
    ];
    if (!options.length) throw badRequest("This video's owner doesn't allow it to be played on other sites, and it couldn't be fetched another way. Try another video.");
    if (!info.embeddable) extraNotes.push('The owner doesn’t allow YouTube’s player on other sites, so this video plays through this server.');
    videos = [{
      title: info.title ?? files?.title ?? 'YouTube video',
      site: 'YouTube',
      thumbnail: `https://i.ytimg.com/vi/${yt.videoId}/mqdefault.jpg`,
      duration: files?.duration ?? null,
      options: finishOptions(options),
    }];
  }
  const direct = !yt && !playlist && DIRECT.test(url.pathname) ? await directKind(url) : null;
  if (direct) {
    // A direct video link: everyone's browser plays it directly, and the
    // server relays it only if a browser can't (cross-site blocks, http on https).
    videos = [{
      title: fileTitle(url),
      site: url.hostname.replace(/^www\./, ''),
      options: finishOptions([{ ...direct, url: url.href, headers: {}, direct: true }]),
    }];
  } else if (!yt && !videos.length) {
    await assertPublicHost(url.hostname); // clear error up front for local links
    await adBlocker(); // the filter lists, to tell ad videos apart from the real one

    if (ytdlpPath()) {
      progress('Asking the site for its videos…');
      let r = await ytdlpFind(url.href);
      const alt = !r.videos.length && r.reason === 'login' ? embedAlternative(url) : null;
      if (alt) {
        const embedded = await ytdlpFind(alt);
        if (embedded.videos.length) r = embedded;
      }
      collect(r);
      videos = await withoutDrm(withoutAds(r.videos, url.href, skipped), skipped);
      // Generic page players often come back without a length: check it, so a
      // preview clip found this way can't pass for the real video.
      if (videos.some((v) => v.duration == null && !v.live)) {
        progress('Checking how long each video is…');
        videos = await withDurations(videos);
        byLength = true;
      }
    }
    // Each next finder also runs when everything found so far is a short clip:
    // the real video is often a stream the earlier finders couldn't see.
    if (!videos.length || allShort(videos)) {
      progress('Reading the page…');
      try {
        const r = await scanPage(url.href);
        if (r.direct) {
          videos = [{ title: fileTitle(new URL(r.direct.url)), site: url.hostname.replace(/^www\./, ''), options: finishOptions([{ ...r.direct, headers: {} }]) }];
        } else {
          collect(r);
          if ([403, 412, 429].includes(r.status)) reasons.add('refused');
          const found = await withoutDrm(withoutAds(r.videos, url.href, skipped), skipped);
          if (found.length) {
            progress('Checking how long each video is…');
            videos = merge(videos, await withDurations(found));
            byLength = true;
          }
        }
      } catch (err) {
        if (err.code === 'EBLOCKED') throw err;
        reasons.add('unreachable');
      }
    }
    if (!videos.length || allShort(videos)) {
      progress('Looking deeper: opening the page in a background browser…');
      const r = await deepScan(url.href, { onProgress: progress });
      collect(r);
      const found = await withoutDrm(withoutAds(r.videos, url.href, skipped), skipped);
      if (found.length) {
        progress('Checking how long each video is…');
        videos = merge(videos, await withDurations(found));
        byLength = true;
      }
    }
    videos = rank(videos, skipped, { byLength });
    if (videos.length && videos.every(isShort)) {
      extraNotes.push('This site only provided a short preview clip (not the full movie) to the server. You can stream the full movie from your phone or device instead.');
    }
  }

  if (!videos.length) {
    console.warn(`[find] no videos found for "${url.href}". reasons: [${[...reasons].join(', ')}], skipped: ${JSON.stringify(skipped)}`);
    const why = ['drm', 'login', 'age', 'unavailable', 'geo', 'blocked', 'split', 'refused', 'unreachable'].find((r) => reasons.has(r) || skipped[r]);
    if (FAILURES[why]) throw badRequest(FAILURES[why]);
    // Say so when the server is missing a tool, rather than blaming the page.
    const missing = [!ytdlpPath() && 'yt-dlp', reasons.has('missing') && 'the background browser'].filter(Boolean);
    if (missing.length) {
      throw badRequest(
        `This server can’t fully search pages right now: ${missing.join(' and ')} ${missing.length > 1 ? 'aren’t' : 'isn’t'} set up. ` +
          'The site’s host can fix this (see Host admin › Overview). Until then, paste a direct link to the video file.',
      );
    }
    throw badRequest('No playable video was found on this page. Try the page of the video itself, or a direct link to the video file.');
  }

  // Several videos with the same page title get numbered, in list order.
  const counts = {};
  for (const v of videos) counts[v.title] = (counts[v.title] ?? 0) + 1;
  const seen = {};
  for (const v of videos) if (counts[v.title] > 1) v.title = `${v.title} (${(seen[v.title] = (seen[v.title] ?? 0) + 1)})`;

  videos.forEach((v, i) => {
    v.id = String(i);
    v.options.forEach((o, j) => (o.id = `${i}.${j}`));
  });
  const scanId = randomUUID();
  scans.set(scanId, { userId, at: Date.now(), videos, link: url.href, playlist: playlist?.entries ?? null, playlistTitle: playlist?.title ?? null });
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
    playlist: playlist ? { title: playlist.title, count: playlist.entries.length, total: playlist.count } : null,
    notes: [
      ...extraNotes,
      ...(adsBlocked ? [`Blocked ${adsBlocked} ${adsBlocked === 1 ? 'ad or tracker' : 'ads and trackers'} while searching.`] : []),
      ...Object.entries(skipped).filter(([, n]) => n > 0).map(([k]) => NOTES[k]),
    ],
  };
}

function scanOf(scanId, userId) {
  const scan = scans.get(scanId);
  if (!scan || scan.userId !== userId || Date.now() - scan.at > SCAN_TTL_MS) {
    throw badRequest('That search has expired. Find the videos again.');
  }
  return scan;
}

/** The full (server-side) choice behind an option id from an earlier search, and the link it was found on. */
export function takeOption(scanId, optionId, userId) {
  const scan = scanOf(scanId, userId);
  for (const video of scan.videos) {
    const option = video.options.find((o) => o.id === optionId);
    if (option) return { video, option, link: scan.link };
  }
  throw badRequest('Pick one of the videos that were found.');
}

/** The playlist found by an earlier search: { title, entries }. */
export function takePlaylist(scanId, userId) {
  const scan = scanOf(scanId, userId);
  if (!scan.playlist?.length) throw badRequest('That link isn’t a playlist.');
  return { title: scan.playlistTitle, entries: scan.playlist };
}

/**
 * Finds a queued video again just before it plays, as the links sites give
 * out expire: the same video and quality if they're still there, else the best.
 */
export async function refind(link, pick, userId) {
  const found = await findVideos(link, { userId });
  const video = found.videos.find((v) => v.title === pick?.title) ?? found.videos[0];
  const option =
    video.options.find((o) => o.kind === pick?.kind && o.label === pick?.label) ?? video.options.find((o) => o.recommended) ?? video.options[0];
  return takeOption(found.scanId, option.id, userId);
}

/** The best option for a link, for callers that skip the choosing step. */
export async function bestFor(raw, { userId } = {}) {
  const { scanId, videos } = await findVideos(raw, { userId });
  const first = videos[0];
  return takeOption(scanId, (first.options.find((o) => o.recommended) ?? first.options[0]).id, userId);
}
