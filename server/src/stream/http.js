// Outbound requests for scanning pages and relaying video, with the private-
// address guard applied on every hop (including redirects).
import http from 'node:http';
import https from 'node:https';
import { assertPublicHost, guardedLookup } from './guard.js';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const lower = (headers = {}) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

/** Resolves with the final (non-redirect) response; the caller reads or pipes it. */
export async function guardedRequest(url, { method = 'GET', headers = {}, maxRedirects = 6, timeout = 15000 } = {}) {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('Only http and https links are supported.');
    await assertPublicHost(current.hostname); // IP literals skip DNS lookup, so check them here
    const res = await new Promise((resolve, reject) => {
      const lib = current.protocol === 'https:' ? https : http;
      const req = lib.request(
        current,
        {
          method,
          headers: { 'user-agent': BROWSER_UA, accept: '*/*', ...lower(headers), 'accept-encoding': 'identity' },
          lookup: guardedLookup,
          timeout,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error('The site took too long to respond.')));
      req.on('error', reject);
      req.end();
    });
    const location = res.headers.location;
    if (res.statusCode >= 300 && res.statusCode < 400 && location && hop < maxRedirects) {
      res.resume();
      current = new URL(location, current);
      continue;
    }
    return { res, url: current.href };
  }
}

/** Reads a response body as text, up to `limit` bytes. */
export function readText(res, limit = 3_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy();
        resolve(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

export const isMediaType = (contentType = '') => /^(video\/|audio\/mp4)|mpegurl/i.test(contentType);
export const isPlaylistType = (contentType = '') => /mpegurl/i.test(contentType);
