// Ad blocking while finding videos, like Brave's Shields. The same filter
// lists Brave and uBlock Origin use (EasyList, EasyPrivacy, Peter Lowe's list,
// uBlock Origin's lists, cookie notices):
// - block ad and tracker requests in the background browser, so pre-roll ads
//   and pop-unders never load and the real video starts straight away;
// - hide ad overlays and cookie banners that cover the play button, and run
//   uBlock Origin's anti-ad scripts;
// - keep ad videos and ad segments out of what's found and relayed.
// The lists are downloaded and compiled once a day and kept in server/data/.
// AD_BLOCK=false turns all of this off.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ENGINE_VERSION, fullLists, Request } from '@ghostery/adblocker';
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import { rootDir, streaming } from '../config.js';

const dataDir = resolve(rootDir, 'server/data');
// The compiled format changes between library versions; a new version builds afresh.
const file = resolve(dataDir, `adblock-engine-v${ENGINE_VERSION}.bin`);
const REFRESH_MS = 24 * 60 * 60 * 1000;
/** On the very first build, how long a search waits for the lists before going ahead without. */
const FIRST_BUILD_WAIT_MS = 20_000;

let engine = null;
let builtAt = 0;
let rules = 0;
let lastError = null;
let building = null;
let started = null;

const fetchWithTimeout = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) });

function countRules(e) {
  try {
    const { networkFilters, cosmeticFilters } = e.getFilters();
    return networkFilters.length + cosmeticFilters.length;
  } catch {
    return 0;
  }
}

/** Downloads the lists and compiles a fresh engine; the old one stays in use if this fails. */
function rebuild() {
  building ??= (async () => {
    try {
      const fresh = await PlaywrightBlocker.fromLists(fetchWithTimeout, fullLists, {
        enableCompression: true,
        guessRequestTypeFromUrl: true,
        loadCosmeticFilters: true,
        loadNetworkFilters: true,
      });
      await mkdir(dataDir, { recursive: true });
      await writeFile(`${file}.tmp`, fresh.serialize());
      await rename(`${file}.tmp`, file);
      engine = fresh;
      builtAt = Date.now();
      rules = countRules(fresh);
      lastError = null;
      console.log(`Ad blocking: ${rules.toLocaleString('en')} filter rules ready`);
    } catch (err) {
      lastError = err.message;
      console.error(`Ad blocking: couldn't update the filter lists (${err.message})${engine ? '; using the previous ones' : ''}`);
    } finally {
      building = null;
    }
  })();
  return building;
}

/** Loads the saved engine, and refreshes it when it's a day old (or missing). */
function start() {
  started ??= (async () => {
    try {
      const saved = await readFile(file);
      engine = PlaywrightBlocker.deserialize(saved);
      builtAt = (await stat(file)).mtimeMs;
      rules = countRules(engine);
    } catch {
      engine = null; // none saved yet, or from another version
    }
    if (!engine) await rebuild();
    else if (Date.now() - builtAt > REFRESH_MS) void rebuild();
  })();
  return started;
}

/** Starts loading the lists in the background (on server start). */
export function warmAdBlocker() {
  if (streaming.adBlock) void start();
}

/** The blocker, or null when ad blocking is off or the lists aren't available yet. */
export async function adBlocker() {
  if (!streaming.adBlock) return null;
  const ready = start();
  if (!engine) await Promise.race([ready, new Promise((r) => setTimeout(r, FIRST_BUILD_WAIT_MS))]);
  if (engine && Date.now() - builtAt > REFRESH_MS) void rebuild();
  return engine;
}

/**
 * True when a filter list says this request is an ad or tracker. `type` is
 * how it's loaded ('media', 'xhr', 'script', 'sub_frame'…), `sourceUrl` the page.
 */
export function isAd(url, { sourceUrl = '', type = 'media' } = {}) {
  if (!engine || !url) return false;
  try {
    return engine.match(Request.fromRawDetails({ url, sourceUrl, type })).match === true;
  } catch {
    return false;
  }
}

/** Tags that describe the segment after them; they go with an ad segment. */
const SEGMENT_TAGS = /^#(EXTINF|EXT-X-BYTERANGE|EXT-X-PROGRAM-DATE-TIME|EXT-X-GAP|EXT-X-BITRATE)\b/;

/**
 * Leaves out segments served by ad networks (ads stitched into a video) from
 * a finished, on-demand HLS playlist. Live playlists are returned as they are:
 * players count their segments, and removing some would throw them off.
 */
export function withoutAdSegments(text, base) {
  if (!engine || !text.includes('#EXT-X-ENDLIST') || text.includes('#EXT-X-STREAM-INF')) return text;
  const out = [];
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    let ad = false;
    if (t && !t.startsWith('#')) {
      try {
        ad = isAd(new URL(t, base).href, { sourceUrl: base, type: 'xhr' });
      } catch {
        ad = false;
      }
    }
    if (!ad) {
      out.push(line);
      continue;
    }
    removed++;
    while (out.length && SEGMENT_TAGS.test(out.at(-1).trim())) out.pop();
  }
  return removed ? out.join('\n') : text;
}

export function adBlockStatus() {
  return {
    enabled: streaming.adBlock,
    ready: !!engine,
    rules,
    updatedAt: builtAt ? new Date(builtAt).toISOString() : null,
    error: engine ? null : lastError,
  };
}
