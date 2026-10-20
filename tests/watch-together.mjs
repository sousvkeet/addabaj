// Watch together end-to-end test. Needs `npm run dev` running.
// Serves a numbered test clip itself and drives three people through it.
import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';

for (const f of ['../client/.env', '../server/.env']) {
  const p = new URL(f, import.meta.url).pathname;
  if (existsSync(p)) process.loadEnvFile(p);
}
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4080}`;
const MEDIA_PORT = Number(process.env.MEDIA_PORT ?? 4099);
const CLIP = `http://localhost:${MEDIA_PORT}/count-40s.webm`;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);

// A tiny file server with byte ranges, so the clip can be seeked.
const fixtures = new URL('./fixtures/', import.meta.url).pathname;
const media = createServer((req, res) => {
  const file = fixtures + decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (file.includes('..') || !existsSync(file)) return res.writeHead(404).end();
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const start = range?.[1] ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/webm',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  createReadStream(file, { start, end }).pipe(res);
});
await new Promise((r) => media.listen(MEDIA_PORT, r));

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(true);
    console.log('PASS', label);
  } catch (e) {
    results.push(false);
    console.log('FAIL', label, '-', e.message.split('\n')[0]);
  }
};

async function user(name, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  // Track YouTube player status messages (position, state) from the iframe.
  await ctx.addInitScript(() => {
    window.__yt = {};
    addEventListener('message', (e) => {
      if (!/youtube/.test(e.origin)) return;
      try {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (d?.info) Object.assign(window.__yt, d.info);
      } catch {}
    });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name} pageerror]`, e.message));
  await page.goto(`${BASE}/signup`);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(`${name.toLowerCase().replace(' ', '')}.${stamp}@example.com`);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/chats');
  return { page, ctx, name };
}

const vid = (p) =>
  p.evaluate(() => {
    const v = document.querySelector('video[data-watch-video]');
    return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState } : null;
  });

/** Clicks "Click to watch along" if the browser blocked autoplay. */
async function watchAlong(p) {
  const btn = p.getByRole('button', { name: 'Click to watch along' });
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    return true;
  }
  return false;
}

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

/** Opens the dialog (if needed), pastes a link and presses Find videos. */
async function find(page, link) {
  const dlg = page.getByRole('dialog');
  if (!(await dlg.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Watch together' }).click();
  if (await dlg.getByRole('button', { name: 'Try another link' }).isVisible().catch(() => false)) {
    await dlg.getByRole('button', { name: 'Try another link' }).click();
  }
  await dlg.getByRole('textbox').fill(link);
  await dlg.getByRole('button', { name: 'Find videos' }).click();
  const outcome = await Promise.race([
    dlg.getByRole('heading', { name: 'Pick what to play' }).waitFor({ timeout: 90000 }).then(() => 'choose'),
    dlg.getByRole('alert').waitFor({ timeout: 90000 }).then(() => 'error'),
  ]);
  return { dlg, outcome, error: outcome === 'error' ? await dlg.getByRole('alert').innerText() : null };
}

/** Picks an option by its label (or keeps the recommended one) and plays it. */
async function play(dlg, label) {
  if (label) await dlg.getByRole('radio', { name: new RegExp(`^${label}`) }).first().check();
  await dlg.getByRole('button', { name: 'Play for everyone' }).click();
  await dlg.waitFor({ state: 'hidden', timeout: 15000 });
}

// <video> loads don't show up in resource timing, so check its source as well.
const usesRelay = (p) =>
  p.evaluate(
    () =>
      (document.querySelector('video[data-watch-video]')?.currentSrc ?? '').includes('/api/stream/') ||
      performance.getEntriesByType('resource').some((e) => e.name.includes('/api/stream/')),
  );

const A = await user('Asha Host');
const B = await user('Rahul Member');
const C = await user('Mitali Late', { width: 390, height: 844 });

// Asha starts a room with Rahul and Mitali in it.
await A.page.getByRole('link', { name: 'Rooms' }).click();
await A.page.getByRole('button', { name: 'Start a room' }).first().click();
await A.page.getByLabel('Room name', { exact: true }).fill('Movie night');
await A.page.getByRole('button', { name: 'Create room' }).click();
await A.page.waitForURL(/\/rooms\//);
const roomUrl = A.page.url();
const roomId = roomUrl.split('/').pop();
for (const who of ['rahulmember', 'mitalilate']) {
  const dlg = A.page.getByRole('dialog');
  await dlg.getByLabel('Search people').fill(`${who}.${stamp}`);
  for (let i = 0; i < 50 && (await dlg.locator('li').count()) !== 1; i++) await A.page.waitForTimeout(100);
  await dlg.locator('li').getByRole('button', { name: 'Add' }).click();
  await dlg.locator('li').getByText('In the room').waitFor();
}
await A.page.keyboard.press('Escape');
await B.page.goto(roomUrl);
await B.page.getByRole('heading', { name: 'Movie night' }).waitFor();

await check('only admins see the Watch button', async () => {
  await A.page.getByRole('button', { name: 'Watch together' }).waitFor();
  if (await B.page.getByRole('button', { name: 'Watch together' }).count()) throw new Error('member can see Watch');
});

await check('a bad YouTube link is refused with a clear reason', async () => {
  const r = await find(A.page, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  if (!/doesn't exist or is private/.test(r.error ?? '')) throw new Error(`got: ${r.outcome} ${r.error}`);
});

await check('admin plays a video file and the member sees it in sync', async () => {
  const found = await find(A.page, CLIP);
  if (found.outcome !== 'choose') throw new Error(found.error);
  await play(found.dlg);
  await A.page.getByRole('region', { name: 'Watch together' }).waitFor({ timeout: 8000 });
  await B.page.getByRole('region', { name: 'Watch together' }).waitFor({ timeout: 8000 });
  await B.page.getByRole('log').getByText(/is playing “count-40s.webm” for everyone/).waitFor({ timeout: 5000 });
  await A.page.waitForTimeout(1500);
  const tapped = (await watchAlong(A.page)) | (await watchAlong(B.page));
  if (tapped) console.log('     (autoplay was blocked; used "Click to watch along")');
  const r = await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: a && b && !a.paused && !b.paused && a.t > 2 && Math.abs(a.t - b.t) < 1, a, b };
  }, 15000, 'not playing in sync');
  console.log(`     playing at ${r.a.t.toFixed(2)}s / ${r.b.t.toFixed(2)}s`);
  await A.page.screenshot({ path: `${SHOTS}watch-1-admin.png` });
});

await check('admin pause pauses the member at the same point', async () => {
  await A.page.evaluate(() => document.querySelector('video[data-watch-video]').pause());
  const r = await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: b.paused && Math.abs(a.t - b.t) < 0.6, a, b };
  }, 6000, 'member did not pause in sync');
  console.log(`     paused at ${r.a.t.toFixed(2)}s / ${r.b.t.toFixed(2)}s`);
});

await check('admin seek moves the member too', async () => {
  await A.page.evaluate(() => (document.querySelector('video[data-watch-video]').currentTime = 20));
  await waitFor(async () => {
    const b = await vid(B.page);
    return { ok: Math.abs(b.t - 20) < 0.6, b };
  }, 6000, 'member did not seek');
});

await check('admin play resumes everyone together', async () => {
  await A.page.evaluate(() => document.querySelector('video[data-watch-video]').play());
  await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: !b.paused && a.t > 21 && Math.abs(a.t - b.t) < 1, a, b };
  }, 8000, 'member did not resume in sync');
});

await check('a member who drifts is pulled back within a few seconds', async () => {
  await B.page.evaluate(() => (document.querySelector('video[data-watch-video]').currentTime = 3));
  await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: Math.abs(a.t - b.t) < 1, a, b };
  }, 6000, 'drift not corrected');
});

await check('someone joining late starts at the right point (phone)', async () => {
  await C.page.goto(roomUrl);
  await C.page.getByRole('region', { name: 'Watch together' }).waitFor({ timeout: 8000 });
  await C.page.waitForTimeout(1500);
  await watchAlong(C.page);
  await waitFor(async () => {
    const a = await vid(A.page), c = await vid(C.page);
    return { ok: c && !c.paused && Math.abs(a.t - c.t) < 1, a, c };
  }, 10000, 'late joiner out of sync');
  await C.page.screenshot({ path: `${SHOTS}watch-2-phone-member.png` });
});

await check('the server refuses playback control from a member', async () => {
  const cookies = await B.ctx.cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const s = io(API, { extraHeaders: { cookie }, transports: ['websocket'] });
  await new Promise((r, j) => { s.on('connect', r); s.on('connect_error', j); });
  const res = await s.timeout(5000).emitWithAck('watch:control', { roomId, playing: false, position: 0 });
  const res2 = await s.timeout(5000).emitWithAck('watch:set', { roomId, url: CLIP });
  const res3 = await s.timeout(5000).emitWithAck('watch:scan', { roomId, url: 'https://archive.org/details/BigBuckBunny_124', requestId: 'x' });
  s.close();
  if (res.ok !== false || !/admins/.test(res.error) || res2.ok !== false || res3.ok !== false) throw new Error(JSON.stringify([res, res2, res3]));
  const a = await vid(A.page);
  if (a.paused) throw new Error('playback was paused by a member');
});

await check('stop for everyone removes the video for all', async () => {
  await A.page.getByRole('button', { name: 'Stop for everyone' }).click();
  await B.page.getByRole('region', { name: 'Watch together' }).waitFor({ state: 'detached', timeout: 5000 });
  await C.page.getByRole('region', { name: 'Watch together' }).waitFor({ state: 'detached', timeout: 5000 });
  await B.page.getByRole('log').getByText('Asha Host stopped the video').waitFor();
});

await check('YouTube plays for everyone (and appears live on a phone already in the room)', async () => {
  const found = await find(A.page, 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  if (found.outcome !== 'choose') throw new Error(found.error);
  await play(found.dlg);
  // Mitali (phone) is already in the room: the video must appear live, without a reload.
  await C.page.getByRole('region', { name: 'Watch together' }).waitFor({ timeout: 8000 });
  await B.page.locator('iframe[src*="M7lc1UVf-VE"]').waitFor({ timeout: 15000 });
  await A.page.locator('iframe[src*="M7lc1UVf-VE"]').waitFor({ timeout: 15000 });
  await A.page.waitForTimeout(4000);
  await watchAlong(A.page);
  await watchAlong(B.page);
  const yt = (p) => p.evaluate(() => ({ t: window.__yt.currentTime, state: window.__yt.playerState }));
  const r = await waitFor(async () => {
    const a = await yt(A.page), b = await yt(B.page);
    return { ok: a.state === 1 && b.state === 1 && a.t > 2 && Math.abs(a.t - b.t) < 1.5, a, b };
  }, 25000, 'YouTube not playing in sync');
  console.log(`     YouTube at ${r.a.t.toFixed(1)}s / ${r.b.t.toFixed(1)}s`);
  await B.page.screenshot({ path: `${SHOTS}watch-3-youtube.png` });
  const err = await B.page.getByRole('region', { name: 'Watch together' }).getByRole('alert').count();
  if (err) throw new Error('error overlay shown');
});

await check('a video page: find, pick a quality, everyone watches through the server (shared download)', async () => {
  const found = await find(A.page, 'https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm');
  if (found.outcome !== 'choose') throw new Error(found.error);
  await found.dlg.getByText('Big Buck Bunny').first().waitFor();
  const labels = await found.dlg.getByRole('radio').evaluateAll((els) => els.map((e) => e.closest('label').innerText.split('\n')[0]));
  console.log(`     qualities offered: ${labels.join(', ')}`);
  await A.page.screenshot({ path: `${SHOTS}watch-4-pick.png` });
  await play(found.dlg, '240p');
  await B.page.getByRole('log').getByText(/is playing “Big Buck Bunny 4K” for everyone/).waitFor({ timeout: 8000 });
  await A.page.waitForTimeout(1500);
  await watchAlong(A.page);
  await watchAlong(B.page);
  const r = await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: a && b && !a.paused && !b.paused && a.t > 1 && Math.abs(a.t - b.t) < 1.5, a, b };
  }, 40000, 'relayed video not playing in sync');
  if (!(await usesRelay(A.page)) || !(await usesRelay(B.page))) throw new Error('not played through the relay');
  console.log(`     relayed file at ${r.a.t.toFixed(2)}s / ${r.b.t.toFixed(2)}s`);
  // A jump far past the downloaded part is fetched from the site directly.
  await A.page.evaluate(() => (document.querySelector('video[data-watch-video]').currentTime = 300));
  await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: !b.paused && a.t > 300 && Math.abs(a.t - b.t) < 1.5, a, b };
  }, 30000, 'seek ahead through the relay failed');
  await B.page.screenshot({ path: `${SHOTS}watch-5-relayed.png` });
});

await check('separate picture and sound (Bilibili) are joined on the server, then everyone watches with sound', async () => {
  const found = await find(A.page, 'https://www.bilibili.com/video/BV1bK411W797');
  if (found.outcome !== 'choose') throw new Error(found.error);
  await found.dlg.getByText('picture and sound joined first').first().waitFor();
  await play(found.dlg, '720p');
  // Everyone sees the progress while the server downloads and joins.
  await B.page.getByText('Getting the video ready for everyone…').waitFor({ timeout: 15000 });
  await B.page.screenshot({ path: `${SHOTS}watch-6-preparing.png` });
  await B.page.getByText('Getting the video ready for everyone…').waitFor({ state: 'detached', timeout: 90000 });
  await A.page.waitForTimeout(1500);
  await watchAlong(A.page);
  await watchAlong(B.page);
  const r = await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: a && b && !a.paused && !b.paused && a.t > 2 && Math.abs(a.t - b.t) < 1.5, a, b };
  }, 30000, 'joined video not playing in sync');
  const sound = await B.page.evaluate(() => document.querySelector('video[data-watch-video]').webkitAudioDecodedByteCount);
  if (!(sound > 0)) throw new Error(`no sound decoded (${sound})`);
  console.log(`     joined video at ${r.a.t.toFixed(2)}s / ${r.b.t.toFixed(2)}s, sound decoded: ${sound} bytes`);
});

await check('a JavaScript player page is found by the deep scan and streams through the relay', async () => {
  const found = await find(A.page, 'https://hls-js.netlify.app/demo/');
  if (found.outcome !== 'choose') throw new Error(found.error);
  await play(found.dlg);
  await A.page.waitForTimeout(1500);
  await watchAlong(A.page);
  await watchAlong(B.page);
  const r = await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: a && b && !a.paused && !b.paused && a.t > 1 && Math.abs(a.t - b.t) < 1.5, a, b };
  }, 30000, 'deep-scanned stream not playing in sync');
  const relayedSegments = await B.page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/stream/') && e.name.includes('/x?')).length);
  if (relayedSegments < 2) throw new Error(`only ${relayedSegments} relayed stream requests`);
  console.log(`     relayed stream at ${r.a.t.toFixed(2)}s / ${r.b.t.toFixed(2)}s (${relayedSegments} relayed requests)`);
});

await check('a direct stream a browser can’t reach falls back to the relay', async () => {
  await B.page.route('**/test-streams.mux.dev/**', (route) => route.abort());
  const found = await find(A.page, 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
  if (found.outcome !== 'choose') throw new Error(found.error);
  await play(found.dlg);
  await A.page.waitForTimeout(1500);
  await watchAlong(A.page);
  await watchAlong(B.page);
  await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: a && b && !a.paused && !b.paused && a.t > 1 && Math.abs(a.t - b.t) < 1.5, a, b };
  }, 30000, 'fallback stream not playing in sync');
  const direct = await A.page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('test-streams.mux.dev')));
  if (!direct) throw new Error('admin did not play the stream directly');
  if (!(await usesRelay(B.page))) throw new Error('member did not fall back to the relay');
  await B.page.unroute('**/test-streams.mux.dev/**');
});

await check('a DRM-protected video gets a clear explanation', async () => {
  const r = await find(A.page, 'https://vimeo.com/76979871');
  // Vimeo answers either way depending on the moment; both are honest reasons.
  if (!/protected \(DRM\)|logged-in users/.test(r.error ?? '')) throw new Error(`got: ${r.outcome} ${r.error}`);
});

await check('a page with no video says so', async () => {
  const r = await find(A.page, 'https://example.com/');
  if (!/No playable video was found/.test(r.error ?? '')) throw new Error(`got: ${r.outcome} ${r.error}`);
});

await check('links to private addresses are refused', async () => {
  const r = await find(A.page, 'http://192.168.1.1/admin');
  if (!/private or local address/.test(r.error ?? '')) throw new Error(`got: ${r.outcome} ${r.error}`);
  await A.page.keyboard.press('Escape');
});

await browser.close();
media.close();
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
