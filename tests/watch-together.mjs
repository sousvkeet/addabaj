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
const CLIP2 = `http://localhost:${MEDIA_PORT}/tone-60s.webm`;
// A public playlist from 2010 (29 videos).
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLBB231211A4F62143';
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
    console.log('FAIL', label, '-', e.message.split('\n').slice(0, 8).join(' | '));
  }
};

/**
 * Lets a test take a page out of sight (as leaving the app or locking the
 * phone does) with window.__sight('hidden' | 'visible'), and notes every
 * media element that plays (an <audio> made by script isn't in the page).
 */
const sightHooks = () => {
  window.__vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__vis === 'hidden' });
  window.__sight = (v) => {
    window.__vis = v;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  window.__media = new Set();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__media.add(this);
    return play.call(this);
  };
};

async function user(name, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(sightHooks);
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
  const email = `${name.toLowerCase().replace(' ', '')}.${stamp}@example.com`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/chats');
  return { page, ctx, name, email };
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
for (const who of [B, C]) {
  const dlg = A.page.getByRole('dialog');
  await dlg.getByLabel('User ID or email').fill(who.email);
  await dlg.getByRole('button', { name: 'Find' }).click();
  const result = dlg.getByRole('group', { name: 'Search result' });
  await result.getByRole('button', { name: 'Add' }).click();
  await result.getByText('In the room').waitFor();
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

/** Someone's own live connection, as their browser has. */
async function socketOf(who) {
  const cookie = (await who.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const s = io(API, { extraHeaders: { cookie }, transports: ['websocket'] });
  await new Promise((r, j) => {
    s.on('connect', r);
    s.on('connect_error', j);
  });
  return s;
}
/** Asha plays the test clip from the start, and everyone in the room watches. */
async function playClip(watchers) {
  const s = await socketOf(A);
  const res = await s.timeout(30000).emitWithAck('watch:set', { roomId, url: CLIP });
  s.close();
  if (!res.ok) throw new Error(res.error);
  for (const p of watchers) await watchAlong(p);
  await waitFor(async () => {
    const all = await Promise.all(watchers.map(vid));
    return { ok: all.every((v) => v && !v.paused && v.t > 1.5), all };
  }, 15000, 'the clip did not start for everyone');
}

await check('someone’s phone pausing the video out of sight (leaving the app, locking it) doesn’t stop the room, nor pull it back after', async () => {
  await playClip([A.page, B.page]);
  // Asha leaves the app: her phone pauses her video by itself.
  await A.page.evaluate(() => {
    window.__sight('hidden');
    document.querySelector('video[data-watch-video]').pause();
  });
  await A.page.waitForTimeout(3500);
  const b = await vid(B.page);
  if (b.paused) throw new Error('the room was paused for everyone');
  // She comes back: the browser plays on from where it froze; she catches up instead.
  await A.page.evaluate(() => {
    window.__sight('visible');
    void document.querySelector('video[data-watch-video]').play();
  });
  await A.page.waitForTimeout(4000);
  const a2 = await vid(A.page), b2 = await vid(B.page);
  if (b2.t < b.t + 3) throw new Error(`the room was pulled back: ${b.t.toFixed(1)}s, then ${b2.t.toFixed(1)}s`);
  if (a2.paused || Math.abs(a2.t - b2.t) > 1.5) throw new Error(`she didn't catch up: ${JSON.stringify({ a2, b2 })}`);
});

await check('leaving the room keeps its video playing in a small player; tapping it goes back; closing it stops it just for you', async () => {
  await playClip([A.page, B.page]);
  await B.page.getByRole('link', { name: 'Chats' }).first().click();
  await B.page.waitForURL('**/chats');
  const dock = B.page.getByRole('region', { name: 'Watching in Movie night' });
  await dock.waitFor({ timeout: 5000 });
  const t1 = (await vid(B.page)).t;
  await B.page.waitForTimeout(2000);
  const t2 = await vid(B.page);
  if (t2.paused || t2.t < t1 + 1.5) throw new Error(`not playing on: ${t1} then ${JSON.stringify(t2)}`);
  await B.page.screenshot({ path: `${SHOTS}watch-5-small-player.png` });
  await dock.getByRole('button', { name: 'Open Movie night' }).click();
  await B.page.waitForURL(roomUrl);
  const t3 = await vid(B.page);
  if (t3.paused || t3.t < t2.t) throw new Error(`started over or stopped on the way back: ${JSON.stringify({ t2, t3 })}`);
  await dock.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {
    throw new Error('the small player stayed on the room page');
  });
  await B.page.getByRole('region', { name: 'Watch together' }).waitFor();
  await B.page.getByRole('link', { name: 'Chats' }).first().click();
  await dock.getByRole('button', { name: 'Stop watching' }).click();
  await dock.waitFor({ state: 'hidden' });
  if (await B.page.locator('video[data-watch-video]').count()) throw new Error('still playing after closing');
  if ((await vid(A.page)).paused) throw new Error('closing it stopped it for the room');
  await B.page.goto(roomUrl);
  await B.page.locator('video[data-watch-video]').waitFor();
});

await check('in the app the sound goes on out of sight (the phone pauses the picture), and the picture picks up after', async () => {
  await playClip([A.page, B.page]);
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 AddaKhanaApp/1.6.2',
  });
  await ctx.addCookies(await B.ctx.cookies());
  await ctx.addInitScript(sightHooks);
  await ctx.addInitScript(() => {
    window.__sessions = [];
    const json = (j) => window.__sessions.push(JSON.parse(j));
    window.AddaNative = { setTheme() {}, retry() {}, ready() {}, ack() {}, setUser() {}, haptic() {}, setBackHandled() {}, pushToken: () => '', callState: json };
  });
  const p = await ctx.newPage();
  try {
    await p.goto(roomUrl);
    await waitFor(async () => {
      const v = await vid(p);
      return { ok: v && !v.paused && v.t > 1, v };
    }, 15000, 'not playing in the app');
    const sessions = await p.evaluate(() => window.__sessions);
    if (!sessions.some((s) => s.kind === 'watch' && s.title === 'count-40s.webm')) throw new Error(`the app wasn't told: ${JSON.stringify(sessions.at(-1))}`);
    const sound = () =>
      p.evaluate(() => {
        const a = [...window.__media].find((m) => m.tagName === 'AUDIO' && m.getAttribute('src'));
        const v = document.querySelector('video[data-watch-video]');
        return { a: a && { t: a.currentTime, paused: a.paused }, v: { t: v.currentTime, paused: v.paused } };
      });
    await p.evaluate(() => {
      window.__sight('hidden');
      document.querySelector('video[data-watch-video]').pause();
    });
    await p.waitForTimeout(3500);
    const out = await sound();
    const room = await vid(A.page);
    if (!out.a || out.a.paused || Math.abs(out.a.t - room.t) > 2.5) throw new Error(`no sound out of sight: ${JSON.stringify({ out, room })}`);
    await p.evaluate(() => window.__sight('visible'));
    await p.waitForTimeout(2500);
    const back = await sound();
    const room2 = await vid(A.page);
    if (back.a || back.v.paused || Math.abs(back.v.t - room2.t) > 2.5) throw new Error(`the picture didn't pick up: ${JSON.stringify({ back, room2 })}`);
  } finally {
    await ctx.close();
  }
});

const playingSrc = (p) => p.evaluate(() => document.querySelector('video[data-watch-video]')?.currentSrc ?? '');

await check('Up next: an admin queues a video, everyone sees it, and it plays by itself when the current one ends', async () => {
  await playClip([A.page, B.page]);
  const found = await find(A.page, CLIP2);
  if (found.outcome !== 'choose') throw new Error(found.error);
  await found.dlg.getByRole('button', { name: 'Add to Up next' }).click();
  await found.dlg.waitFor({ state: 'hidden' });
  const upNext = B.page.getByRole('region', { name: 'Up next' });
  await upNext.getByText(/tone-60s\.webm/).waitFor({ timeout: 5000 });
  if (!(await playingSrc(B.page)).includes('count-40s')) throw new Error('adding replaced what was playing');
  // Near its end: then the next one plays for everyone, with nobody pressing anything.
  await A.page.evaluate(() => {
    const v = document.querySelector('video[data-watch-video]');
    v.currentTime = 36;
    void v.play();
  });
  await waitFor(async () => {
    const src = await playingSrc(B.page), b = await vid(B.page);
    return { ok: src.includes('tone-60s') && b && !b.paused && b.t > 0.5, src, b };
  }, 20000, 'the next video did not start by itself');
  await B.page.getByRole('log').getByText(/Up next: “tone-60s.webm” is playing for everyone/).waitFor({ timeout: 5000 });
  await upNext.waitFor({ state: 'hidden', timeout: 5000 });
});

await check('members can’t change Up next or skip', async () => {
  const s = await socketOf(B);
  const found = await s.timeout(90000).emitWithAck('watch:scan', { roomId, url: CLIP, requestId: 'm' });
  const tries = await Promise.all([
    s.timeout(5000).emitWithAck('watch:queue-add', { roomId, scanId: found.scanId, optionId: '0.0' }),
    s.timeout(5000).emitWithAck('watch:queue-clear', { roomId }),
    s.timeout(5000).emitWithAck('watch:next', { roomId }),
    s.timeout(5000).emitWithAck('watch:duration', { roomId, watchId: 'x', duration: 1 }),
  ]);
  s.close();
  if (found.ok !== false || tries.some((r) => r.ok !== false)) throw new Error(JSON.stringify([found, ...tries]));
});

await check('a YouTube playlist goes into Up next with one tap, in order, and Next moves on to it', async () => {
  const found = await find(A.page, PLAYLIST);
  if (found.outcome !== 'choose') throw new Error(found.error);
  await found.dlg.getByText(/A playlist:/).waitFor();
  await found.dlg.getByRole('button', { name: 'Add all to Up next' }).click();
  await found.dlg.waitFor({ state: 'hidden' });
  const upNext = B.page.getByRole('region', { name: 'Up next' });
  await upNext.getByRole('button', { name: /^Up next/ }).click();
  const first = await upNext.getByRole('listitem').first().innerText();
  const count = await upNext.getByRole('listitem').count();
  if (count < 20 || !/Team Fortress 2/.test(first)) throw new Error(`Up next has ${count}: ${first}`);
  // What members get of it: titles and such, never the links or choices behind them.
  const cookie = (await B.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const { room } = await (await fetch(`${API}/api/rooms/${roomId}`, { headers: { cookie } })).json();
  const leaked = room.queue.flatMap((i) => Object.keys(i)).filter((k) => !['id', 'title', 'site', 'thumbnail', 'duration', 'kind', 'addedBy', 'addedAt'].includes(k));
  if (room.queue.length !== count || leaked.length) throw new Error(`members see ${room.queue.length} items with ${[...new Set(leaked)]}`);
  await B.page.screenshot({ path: `${SHOTS}watch-6-up-next.png` });
  await A.page.getByRole('region', { name: 'Up next' }).getByRole('button', { name: 'Next', exact: true }).click();
  await B.page.locator('iframe[src*="youtube"]').waitFor({ timeout: 15000 });
  if ((await upNext.getByRole('listitem').count()) !== count - 1) throw new Error('the played video stayed in Up next');
  // Done with it: an empty Up next for what follows.
  await A.page.getByRole('region', { name: 'Up next' }).getByRole('button', { name: /^Up next/ }).click();
  await A.page.getByRole('button', { name: 'Clear Up next' }).click();
  await upNext.waitFor({ state: 'hidden', timeout: 5000 });
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

await check('YouTube through the server too (like IDM-CLI): its own files are offered, and play for everyone', async () => {
  const found = await find(A.page, 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  if (found.outcome !== 'choose') throw new Error(found.error);
  const labels = await found.dlg.getByRole('radio').evaluateAll((els) => els.map((e) => e.closest('label').innerText.split('\n')[0]));
  console.log(`     choices: ${labels.join(', ')}`);
  if (labels[0] !== 'YouTube') throw new Error(`YouTube's player should come first: ${labels}`);
  if (!labels.includes('360p')) throw new Error(`no server quality offered: ${labels}`);
  await play(found.dlg, '360p');
  await A.page.waitForTimeout(1500);
  await watchAlong(A.page);
  await watchAlong(B.page);
  const r = await waitFor(async () => {
    const a = await vid(A.page), b = await vid(B.page);
    return { ok: a && b && !a.paused && !b.paused && a.t > 1 && Math.abs(a.t - b.t) < 1.5, a, b };
  }, 40000, 'YouTube file not playing in sync through the server');
  if (!(await usesRelay(A.page)) || !(await usesRelay(B.page))) throw new Error('not played through the relay');
  console.log(`     YouTube file through the server at ${r.a.t.toFixed(2)}s / ${r.b.t.toFixed(2)}s`);
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
