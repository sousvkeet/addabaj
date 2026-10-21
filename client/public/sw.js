// Keeps the app's own page and built files on the device, so it opens at once
// and also without a connection (the Android app then shows the chats it kept,
// with "Waiting for network…"), like an installed app. Only the page and the
// files in /assets: never the API, uploads, live connections or videos.
const CACHE = 'adda-shell-v1';
const PAGE = '/';
const LISTS = '/__shell-assets';
/** A slow line: start from the kept page after this long, rather than wait. */
const PATIENCE_MS = 2500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    fetch(PAGE, { cache: 'no-store' })
      .then((response) => keepShell(response))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const assetsIn = (html) => [...new Set(html.match(/\/assets\/[\w.-]+/g) ?? [])];

/**
 * Keeps a fresh copy of the page and every built file it names (their names
 * carry a hash, so they never change). Files of versions before the last two
 * are dropped.
 */
async function keepShell(response) {
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return;
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  const assets = assetsIn(html);
  const old = await cache.match(LISTS).then((r) => (r ? r.json() : { current: [], previous: [] }));
  await cache.put(PAGE, response);
  await Promise.all(
    assets.map(async (url) => {
      if (await cache.match(url)) return;
      const r = await fetch(url);
      if (r.ok) await cache.put(url, r);
    }),
  );
  const changed = assets.join() !== old.current.join();
  if (changed) {
    const keep = new Set([...assets, ...old.current]);
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(req);
    }
    await cache.put(LISTS, new Response(JSON.stringify({ current: assets, previous: old.current })));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/socket.io')) {
    event.respondWith(page(event));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(asset(req));
  }
});

/** The server's page when it answers in time; otherwise (offline, slow, server down) the kept one. */
async function page(event) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(PAGE);
  const network = fetch(event.request).then((r) => {
    if (r.ok) event.waitUntil(keepShell(r.clone()).catch(() => {}));
    return r.ok || !kept ? r : kept;
  });
  if (!kept) return network;
  return Promise.race([network.catch(() => kept), new Promise((resolve) => setTimeout(() => resolve(kept), PATIENCE_MS))]);
}

async function asset(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) await cache.put(req, r.clone());
  return r;
}
