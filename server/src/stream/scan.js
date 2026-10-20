// Page scan: reads a page's HTML and finds videos the way a download manager
// does: <video>/<source> tags, og:video and JSON-LD metadata, YouTube embeds,
// and links to .mp4/.webm/.m3u8 anywhere in the page (scripts included).
import { BROWSER_UA, guardedRequest, isMediaType, isPlaylistType, readText } from './http.js';
import { finishOptions, playableFile, playlistHasDrm } from './formats.js';

const MEDIA_URL = /(?:https?:)?\/\/[^\s"'<>\\()]+?\.(?:m3u8|mp4|m4v|webm|mov)(?:\?[^\s"'<>\\()]*)?/gi;

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function meta(html, ...names) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (names.includes(key)) {
      const content = attr(tag, 'content');
      if (content) return content;
    }
  }
  return null;
}

const extOf = (url) => (/\.(m3u8|mp4|m4v|webm|mov)(?:$|\?)/i.exec(new URL(url).pathname + '?')?.[1] ?? '').toLowerCase();

/** Everything in the page that looks like a video link, most likely first. */
export function candidatesFrom(html, pageUrl) {
  const found = [];
  const add = (raw) => {
    if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return;
    try {
      const url = new URL(raw.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/'), pageUrl);
      url.hash = '';
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !found.includes(url.href)) found.push(url.href);
    } catch {
      /* not a URL */
    }
  };
  for (const name of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) {
    add(meta(html, name));
  }
  for (const tag of html.match(/<(video|source)\b[^>]*>/gi) ?? []) add(attr(tag, 'src') ?? attr(tag, 'data-src'));
  for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/g)) add(m[1]);
  for (const m of html.replace(/\\\//g, '/').matchAll(MEDIA_URL)) add(m[0]);
  // Only keep links that look like video (og:video can be a player page).
  return found.filter((u) => extOf(u) || /\/(video|media|stream|hls|manifest)/i.test(new URL(u).pathname)).slice(0, 12);
}

/** Asks the server what a link really is (type, size, DRM) without downloading it. */
async function probe(url, referer) {
  const headers = { referer, 'user-agent': BROWSER_UA };
  try {
    const { res, url: finalUrl } = await guardedRequest(url, { headers: { ...headers, range: 'bytes=0-65535' }, timeout: 8000 });
    const type = res.headers['content-type'] ?? '';
    const total = Number(/\/(\d+)$/.exec(res.headers['content-range'] ?? '')?.[1] ?? res.headers['content-length']) || null;
    if (res.statusCode >= 400) {
      res.resume();
      return null;
    }
    const playlist = isPlaylistType(type) || extOf(finalUrl) === 'm3u8';
    if (playlist) {
      const text = await readText(res, 2_000_000);
      if (!text.trimStart().startsWith('#EXTM3U')) return null;
      if (playlistHasDrm(text)) return { drm: true };
      return { kind: 'hls', url: finalUrl, headers, master: text.includes('#EXT-X-STREAM-INF') };
    }
    res.destroy();
    if (!isMediaType(type) && !extOf(finalUrl)) return null;
    const ext = extOf(finalUrl) || (/webm/.test(type) ? 'webm' : 'mp4');
    if (!playableFile({ ext })) return null;
    return { kind: 'file', url: finalUrl, headers, ext, size: total };
  } catch {
    return null;
  }
}

function absoluteHttp(raw, base) {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const titleOf = (html) =>
  decodeEntities(meta(html, 'og:title', 'twitter:title') ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '')
    .trim()
    .slice(0, 200);

/**
 * Returns { direct } when the link itself is a video, otherwise { videos }
 * found on the page (possibly empty).
 */
export async function scanPage(url) {
  const { res, url: pageUrl } = await guardedRequest(url, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
  });
  const type = res.headers['content-type'] ?? '';
  if (isMediaType(type)) {
    res.destroy();
    return { direct: { kind: isPlaylistType(type) ? 'hls' : 'file', url: pageUrl } };
  }
  if (res.statusCode >= 400 || !/html|xml|text\/plain/i.test(type)) {
    res.resume();
    return { videos: [], status: res.statusCode };
  }
  const html = await readText(res, 4_000_000);
  const title = titleOf(html) || new URL(pageUrl).hostname;
  const thumbnail = meta(html, 'og:image', 'twitter:image');
  const site = new URL(pageUrl).hostname.replace(/^www\./, '');

  const videos = [];
  for (const m of html.matchAll(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/g)) {
    if (!videos.some((v) => v.options[0].videoId === m[1])) {
      videos.push({ title: `${title} (YouTube)`, thumbnail: null, duration: null, site: 'YouTube', options: finishOptions([{ kind: 'youtube', videoId: m[1] }]) });
    }
  }
  const probed = (await Promise.all(candidatesFrom(html, pageUrl).map((u) => probe(u, pageUrl)))).filter(Boolean);
  const drm = probed.filter((p) => p.drm).length;
  const playable = probed.filter((p) => !p.drm);
  // A master playlist already covers its own variant playlists.
  const hasMaster = playable.some((p) => p.kind === 'hls' && p.master);
  const kept = playable.filter((p) => !(p.kind === 'hls' && hasMaster && !p.master));
  kept.forEach((p) => {
    videos.push({
      title,
      thumbnail: absoluteHttp(thumbnail, pageUrl),
      duration: null,
      site,
      options: finishOptions([p]),
    });
  });
  return { videos, title, skipped: { drm } };
}
