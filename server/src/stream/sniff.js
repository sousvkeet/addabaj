// Deep scan, the way IDM catches videos: open the page in a hidden browser,
// press play, and record the video and stream requests the page makes.
// All browser traffic goes through the private-address guard proxy, and ads
// are blocked like Brave does (see adblock.js), so the real video plays first.
import { fromPlaywrightDetails } from '@ghostery/adblocker-playwright';
import { parse } from 'tldts-experimental';
import { streaming } from '../config.js';
import { adBlocker, isAd } from './adblock.js';
import { guardProxy } from './guard.js';
import { finishOptions, playableFile, playlistHasDrm } from './formats.js';

let browserPromise = null;
let idleTimer = null;
let active = 0;
/** Why the background browser can't be used ('' when it can); for the startup log and the admin page. */
let browserProblem = '';

async function browser() {
  if (!streaming.deepScan) return null;
  if (!browserPromise) {
    browserPromise = (async () => {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        browserProblem = 'Playwright isn’t installed. Run npm install in the project folder.';
        return null;
      }
      const proxy = await guardProxy();
      try {
        return await chromium.launch({
          headless: true,
          // Playwright's own signal handlers would stop the server from exiting
          // on SIGTERM/SIGINT; the browser closes by itself when we exit.
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
          // "<-loopback>" stops Chromium's built-in exception that would let
          // pages reach localhost without going through the guard.
          proxy: { server: `http://${proxy.host}`, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
        });
      } catch (err) {
        const msg = String(err?.message ?? err);
        browserProblem = /Executable doesn't exist|playwright install/i.test(msg)
          ? 'The background browser isn’t installed. Run npm run setup:browser on the server.'
          : /missing (system )?(libraries|dependencies)|install-deps|error while loading shared libraries/i.test(msg)
            ? 'The background browser needs system libraries. Run sudo npx playwright install-deps chromium on the server.'
            : `The background browser didn’t start: ${msg.split('\n')[0].slice(0, 200)}`;
        return null;
      }
    })();
  }
  const b = await browserPromise;
  if (!b) browserPromise = null;
  else browserProblem = '';
  return b;
}

/** Close the browser after two idle minutes so it doesn't hold memory. */
function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (active > 0 || !browserPromise) return;
    const b = await browserPromise;
    browserPromise = null;
    await b?.close().catch(() => {});
  }, 120_000);
  idleTimer.unref?.();
}

export async function deepScanAvailable() {
  return !!(await browser());
}

/** Checks the background browser can start (on server start), then lets it close when idle. */
export async function checkBrowser() {
  if (!streaming.deepScan) return { ok: false, problem: 'Turned off (DEEP_SCAN=false).' };
  const ok = !!(await browser());
  scheduleIdleClose();
  return { ok, problem: browserProblem };
}

export const browserStatus = () => ({ enabled: streaming.deepScan, problem: browserProblem || null });

/** "news.example.co.uk" → "example.co.uk": the site, whatever its subdomain. */
const siteOf = (url) => {
  try {
    return parse(url).domain || new URL(url).hostname;
  } catch {
    return '';
  }
};

const MEDIA_EXT = /\.(m3u8|mp4|m4v|webm|mov)(?:$|\?)/i;
const SEGMENT_EXT = /\.(ts|m4s|aac|m4a|vtt|key)(?:$|\?)/i;
const PLAY_BUTTONS = [
  '.vjs-big-play-button', '.jw-icon-display', '.plyr__control--overlaid', '.ytp-large-play-button',
  'button[aria-label*="play" i]', '[class*="play-button" i]', '[class*="playButton" i]', '[class*="big-play" i]',
  '#playButton', '#play-button', 'button:text-is("Play")', 'button:text-is("Play video")', 'button:text-is("Play now")',
];
const SKIP_BUTTONS = ['[class*="skip" i]', 'button:has-text("Skip")', '[aria-label*="skip" i]'];
// Streams are often served without a .m3u8 name or the official type; these
// small responses get their first line checked for #EXTM3U.
const MAYBE_PLAYLIST_TYPE = /text\/plain|octet-stream|binary|x-unknown|^$/i;
const MAYBE_PLAYLIST_SIZE = 512 * 1024;
/** Big enough to be the real video rather than an ad or preview. */
const SUBSTANTIAL_BYTES = 20_000_000;
/** A video playing on the page this long (or live) is the real one, not an ad. */
const LONG_VIDEO_SECONDS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function deepScan(url, { onProgress } = {}) {
  const b = await browser();
  if (!b) return { videos: [], reason: 'missing' };
  const blocker = await adBlocker();
  active++;
  const context = await b.newContext({
    viewport: { width: 1280, height: 720 },
    acceptDownloads: false,
    serviceWorkers: 'block',
    locale: 'en-US',
  });
  const found = new Map(); // url -> capture
  let page = null;
  // The page's own site once it has loaded. Ad scripts like to send the whole
  // tab to an ad on the first click; after loading, the tab stays on this site.
  let home = null;
  let blocked = 0;
  try {
    context.setDefaultTimeout(8000);
    await context.route('**/*', (route) => {
      const req = route.request();
      const u = req.url();
      if (!/^https?:/.test(u)) return route.abort();
      if (['image', 'font'].includes(req.resourceType())) return route.abort();
      let request = null;
      try {
        if (req.isNavigationRequest() && req.frame() === page?.mainFrame()) {
          if (home && siteOf(u) !== home) {
            blocked++;
            // "Aborted" keeps the browser on the page (other errors would show an
            // error page instead), and the next click isn't left waiting for it.
            return route.abort('aborted');
          }
          return route.continue();
        }
        request = blocker ? fromPlaywrightDetails(req) : null;
      } catch {
        return route.continue(); // no frame to judge by (a worker); let it be
      }
      if (request) {
        if (request.type === 'other') request.guessTypeOfRequest();
        const { match, redirect } = blocker.match(request);
        if (redirect) {
          // A harmless stand-in (an empty script, a blank video) keeps the page from breaking.
          const base64 = redirect.contentType.endsWith(';base64');
          return route.fulfill({
            body: base64 ? Buffer.from(redirect.body, 'base64') : redirect.body,
            contentType: base64 ? redirect.contentType.slice(0, -7) : redirect.contentType,
          });
        }
        if (match) {
          blocked++;
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });
    context.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!/^https?:/.test(u) || SEGMENT_EXT.test(new URL(u).pathname)) return;
        const type = resp.headers()['content-type'] ?? '';
        const length = Number(resp.headers()['content-length']);
        const kindOfRequest = resp.request().resourceType();
        const maybe =
          ['xhr', 'fetch', 'media', 'other'].includes(kindOfRequest) &&
          MAYBE_PLAYLIST_TYPE.test(type) &&
          (length ? length <= MAYBE_PLAYLIST_SIZE : /m3u|playlist|manifest|master|index/i.test(u));
        const playlist = /mpegurl/i.test(type) || /\.m3u8(?:$|\?)/i.test(u) || maybe;
        const video = !playlist && (/^video\//i.test(type) || MEDIA_EXT.test(new URL(u).pathname));
        if (!playlist && !video) return;
        const status = resp.status();
        if (status >= 400) return;
        const req = resp.request();
        const all = await req.allHeaders();
        const headers = {};
        for (const k of ['referer', 'origin', 'user-agent', 'cookie']) if (all[k]) headers[k] = all[k];
        if (playlist) {
          const text = await resp.text().catch(() => '');
          if (!text.trimStart().startsWith('#EXTM3U')) return;
          found.set(u, {
            kind: 'hls', url: u, headers, text,
            master: text.includes('#EXT-X-STREAM-INF'),
            ended: text.includes('#EXT-X-ENDLIST'),
            drm: playlistHasDrm(text),
          });
        } else {
          const h = resp.headers();
          const size = Number(/\/(\d+)$/.exec(h['content-range'] ?? '')?.[1] ?? h['content-length']) || null;
          const ext = (/\.(mp4|m4v|webm|mov)(?:$|\?)/i.exec(new URL(u).pathname)?.[1] ?? (/webm/.test(type) ? 'webm' : 'mp4')).toLowerCase();
          if (!found.has(u)) found.set(u, { kind: 'file', url: u, headers, ext, size });
        }
      } catch {
        /* the page moved on; ignore */
      }
    });

    page = await context.newPage();
    // Ad pop-ups and new tabs are closed straight away.
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => {});
    });
    // Hide ad overlays and cookie banners (they cover the play button) and run
    // uBlock Origin's scripts against ads and anti-adblock, in every frame.
    if (blocker) page.on('framenavigated', blocker.onFrameNavigated);
    onProgress?.(blocker ? 'Opening the page in a background browser, with ads blocked…' : 'Opening the page in a background browser…');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
    const refused = [403, 412, 429].includes(response?.status());
    home = siteOf(page.url() || url);
    await sleep(2500);

    // Press play the way a person would: video elements, common play buttons,
    // the middle of the player; skip ads. Players often need a few tries (the
    // first click may only open an ad), and the real video can start after a
    // short ad, so keep going until something substantial appears (~25 s max).
    // Also enough: a long video actually playing (its stream already caught), or,
    // after a full round, a video tag pointing straight at a file. (The
    // background browser can't decode some formats, such as H.264, so those
    // never play or load; their tag is how they're found.)
    let playingLong = false;
    let roundsDone = 0;
    let fileTag = false;
    const checkPage = async () => {
      for (const frame of page.frames()) {
        const r = await frame
          .evaluate((min) => {
            const videos = [...document.querySelectorAll('video')];
            return {
              long: videos.some((v) => !v.paused && v.currentTime > 0 && (v.duration >= min || v.duration === Infinity)),
              srcs: videos.map((v) => v.currentSrc || v.src).filter((src) => /^https?:/.test(src)),
            };
          }, LONG_VIDEO_SECONDS)
          .catch(() => ({ long: false, srcs: [] }));
        if (r.long) playingLong = true;
        if (r.srcs.some((src) => !isAd(src, { sourceUrl: page.url(), type: 'media' }))) fileTag = true;
      }
    };
    const substantial = () =>
      (playingLong && found.size > 0) ||
      (roundsDone > 0 && fileTag) ||
      [...found.values()].some((f) => (f.kind === 'hls' && (f.master || f.ended)) || (f.kind === 'file' && (f.size ?? 0) > SUBSTANTIAL_BYTES));
    for (let round = 0; round < 3 && !substantial(); round++) {
      onProgress?.(round ? 'Still looking: the page may be showing an ad first…' : 'Starting the video to catch its stream…');
      for (const frame of page.frames()) {
        await frame
          .evaluate(() => document.querySelectorAll('video').forEach((v) => { v.muted = true; void v.play().catch(() => {}); }))
          .catch(() => {});
        for (const selector of [...SKIP_BUTTONS, ...PLAY_BUTTONS]) {
          const el = frame.locator(selector).first();
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 1500 }).catch(() => {});
            break;
          }
        }
      }
      await page.mouse.click(640, 360).catch(() => {});
      for (let i = 0; i < 16 && !(substantial() && i >= 4); i++) {
        await sleep(500);
        if (i % 2) await checkPage();
      }
      roundsDone++;
    }

    // Videos whose element points straight at a file (not a blob) count too.
    for (const frame of page.frames()) {
      const srcs = await frame.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src)).catch(() => []);
      for (const s of srcs) {
        if (/^https?:/.test(s) && !found.has(s) && !isAd(s, { sourceUrl: page.url(), type: 'media' })) found.set(s, { kind: 'file', url: s, headers: { referer: frame.url() }, ext: (/\.(mp4|m4v|webm|mov)/i.exec(s)?.[1] ?? 'mp4').toLowerCase(), size: null });
      }
    }

    const title = (await page.title().catch(() => '')).trim().slice(0, 200) || new URL(url).hostname;
    const site = new URL(page.url() || url).hostname.replace(/^www\./, '');
    const captures = [...found.values()];
    const drm = captures.filter((c) => c.drm).length;
    const masters = captures.filter((c) => c.kind === 'hls' && c.master && !c.drm);
    const mastered = (c) => masters.some((m) => m.text.includes(new URL(c.url).pathname.split('/').pop()));
    const kept = [
      ...masters,
      ...captures.filter((c) => c.kind === 'hls' && !c.master && !c.drm && !mastered(c)),
      ...captures.filter((c) => c.kind === 'file' && playableFile(c)).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)),
    ].slice(0, 8);
    const videos = kept.map((c) => ({
      title,
      thumbnail: null,
      duration: null,
      site,
      options: finishOptions([{ kind: c.kind, url: c.url, headers: c.headers, ext: c.ext, size: c.size }]),
    }));
    return { videos, title, skipped: { drm }, adsBlocked: blocked, ...(refused && !videos.length ? { reason: 'refused' } : {}) };
  } finally {
    await context.close().catch(() => {});
    active--;
    scheduleIdleClose();
  }
}
