// Deep scan, the way IDM catches videos: open the page in a hidden browser,
// press play, and record the video and stream requests the page makes.
// All browser traffic goes through the private-address guard proxy.
import { streaming } from '../config.js';
import { guardProxy } from './guard.js';
import { finishOptions, playableFile, playlistHasDrm } from './formats.js';

let browserPromise = null;
let idleTimer = null;
let active = 0;

async function browser() {
  if (!streaming.deepScan) return null;
  if (!browserPromise) {
    browserPromise = (async () => {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        return null; // Playwright isn't installed on this server
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
      } catch {
        return null; // browser binary missing: `npx playwright install chromium`
      }
    })();
  }
  const b = await browserPromise;
  if (!b) browserPromise = null;
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

const MEDIA_EXT = /\.(m3u8|mp4|m4v|webm|mov)(?:$|\?)/i;
const SEGMENT_EXT = /\.(ts|m4s|aac|m4a|vtt|key)(?:$|\?)/i;
const PLAY_BUTTONS = [
  '.vjs-big-play-button', '.jw-icon-display', '.plyr__control--overlaid', '.ytp-large-play-button',
  'button[aria-label*="play" i]', '[class*="play-button" i]', '[class*="playButton" i]', '[class*="big-play" i]',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function deepScan(url, { onProgress } = {}) {
  const b = await browser();
  if (!b) return { videos: [], reason: 'missing' };
  active++;
  const context = await b.newContext({
    viewport: { width: 1280, height: 720 },
    acceptDownloads: false,
    serviceWorkers: 'block',
    locale: 'en-US',
  });
  const found = new Map(); // url -> capture
  let page = null;
  try {
    context.setDefaultTimeout(8000);
    await context.route('**/*', (route) => {
      const req = route.request();
      if (!/^https?:/.test(req.url())) return route.abort();
      if (['image', 'font'].includes(req.resourceType())) return route.abort();
      return route.continue();
    });
    context.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!/^https?:/.test(u) || SEGMENT_EXT.test(new URL(u).pathname)) return;
        const type = resp.headers()['content-type'] ?? '';
        const playlist = /mpegurl/i.test(type) || /\.m3u8(?:$|\?)/i.test(u);
        const video = /^video\//i.test(type) || MEDIA_EXT.test(new URL(u).pathname);
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
          found.set(u, { kind: 'hls', url: u, headers, master: text.includes('#EXT-X-STREAM-INF'), drm: playlistHasDrm(text), text });
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
    onProgress?.('Opening the page in a background browser…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await sleep(2500);

    // Press play the way a person would: video elements, common play buttons, then the middle.
    onProgress?.('Starting the video to catch its stream…');
    for (const frame of page.frames()) {
      await frame
        .evaluate(() => document.querySelectorAll('video').forEach((v) => { v.muted = true; void v.play().catch(() => {}); }))
        .catch(() => {});
      for (const selector of PLAY_BUTTONS) {
        const el = frame.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 1500 }).catch(() => {});
          break;
        }
      }
    }
    await page.mouse.click(640, 360).catch(() => {});

    // Wait until something substantial shows up, up to ~10 s.
    for (let i = 0; i < 20; i++) {
      const good = [...found.values()].some((f) => (f.kind === 'hls' && f.master) || (f.kind === 'file' && (f.size ?? 0) > 2_000_000));
      if (good && i >= 4) break;
      await sleep(500);
    }

    // Videos whose element points straight at a file (not a blob) count too.
    for (const frame of page.frames()) {
      const srcs = await frame.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src)).catch(() => []);
      for (const s of srcs) {
        if (/^https?:/.test(s) && !found.has(s)) found.set(s, { kind: 'file', url: s, headers: { referer: frame.url() }, ext: (/\.(mp4|m4v|webm|mov)/i.exec(s)?.[1] ?? 'mp4').toLowerCase(), size: null });
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
    const videos = kept.map((c, i) => ({
      title: kept.length > 1 ? `${title} (${i + 1})` : title,
      thumbnail: null,
      duration: null,
      site,
      options: finishOptions([{ kind: c.kind, url: c.url, headers: c.headers, ext: c.ext, size: c.size }]),
    }));
    return { videos, title, skipped: { drm } };
  } finally {
    await context.close().catch(() => {});
    active--;
    scheduleIdleClose();
  }
}
