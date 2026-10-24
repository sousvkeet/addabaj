import { chromium } from 'playwright';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';

// A room's video call over its video (components/watch/PlayerCalls.tsx): with a
// video playing for the room and four people in its voice on camera, the
// cameras float over the player (no call window covering it): at most three
// windows, mine among them, the rest counted. Each window moves and resizes on
// its own and stays inside the player, while the video plays on throughout;
// the microphone and camera buttons work there; "Open the call" brings the
// call's window, and it goes back over the video. Also on a phone-sized screen.
// Runs against the dev servers (npm run dev), with fake cameras.
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const MEDIA_PORT = Number(process.env.MEDIA_PORT ?? 4098);
const CLIP = `http://localhost:${MEDIA_PORT}/count-40s.webm`;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);

// The clip, served with byte ranges (so it can seek).
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

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(['PASS', label]);
    console.log('PASS', label);
  } catch (err) {
    results.push(['FAIL', label, err.message.split('\n')[0]]);
    console.log('FAIL', label, '-', err.message.split('\n').slice(0, 3).join(' | '));
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(user, method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(user?.cookie ? { cookie: user.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function register(name) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.overvideo.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const C = await register('Chitra Pal');
const D = await register('Dipa Roy');
const room = (await call(A, 'POST', '/rooms', { name: `Film and friends ${stamp}`, maxMembers: 6 })).data.room;
for (const u of [B, C, D]) await call(A, 'POST', `/rooms/${room.id}/members`, { userId: u.id });

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
async function page(user, { phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 400, height: 860 } : { width: 1280, height: 860 },
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    permissions: ['microphone', 'camera'],
  });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/rooms/${room.id}`);
  await p.waitForFunction(() => window.adda?.socket?.connected, null, { timeout: 15_000 });
  return p;
}

const pa = await page(A);
const pb = await page(B, { phone: true });
const pc = await page(C);
const pd = await page(D);
const player = (p) => p.getByRole('region', { name: 'Watch together' });
const windows = (p) => p.locator('[data-call-window]');
const box = (l) => l.boundingBox();
/** The room's video, playing: its time moves on. */
const filmTime = (p) => p.evaluate(() => {
  const v = document.querySelector('section[aria-label="Watch together"] video:not([data-room-video])');
  return v ? { t: v.currentTime, paused: v.paused } : null;
});
/** The room's video again from the start (it's 40 seconds; Asha controls it): it plays through the next check. */
const restart = (p) =>
  p.evaluate(async () => {
    const v = document.querySelector('section[aria-label="Watch together"] video:not([data-room-video])');
    v.currentTime = 0;
    await v.play();
  });
const inside = (b, outer) => b.x >= outer.x - 0.5 && b.y >= outer.y - 0.5 && b.x + b.width <= outer.x + outer.width + 0.5 && b.y + b.height <= outer.y + outer.height + 0.5;
/** Drags with a mouse (or a finger on a phone) from the middle of an element, or of one of its corners. */
async function drag(p, locator, dx, dy, at = 'middle') {
  const b = await box(locator);
  const x = at === 'br' ? b.x + b.width - 5 : at === 'tl' ? b.x + 5 : b.x + b.width / 2;
  const y = at === 'br' ? b.y + b.height - 5 : at === 'tl' ? b.y + 5 : b.y + b.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await p.mouse.up();
  await sleep(150);
}

try {
  await check('Asha plays a video for the room; everyone joins its voice with their camera on', async () => {
    await pa.getByRole('button', { name: 'Watch together' }).click();
    const dlg = pa.getByRole('dialog');
    await dlg.getByRole('textbox').fill(CLIP);
    await dlg.getByRole('button', { name: 'Find videos' }).click();
    await dlg.getByRole('heading', { name: 'Pick what to play' }).waitFor({ timeout: 90_000 });
    await dlg.getByRole('button', { name: 'Play for everyone' }).click();
    await dlg.waitFor({ state: 'hidden', timeout: 15_000 });
    for (const p of [pa, pb, pc, pd]) await player(p).waitFor({ timeout: 10_000 });
    for (const p of [pa, pb, pc, pd]) {
      // (A phone has Join, then the camera; a wider screen a button for both: the store does what both do.)
      await p.evaluate((id) => window.adda.voice.getState().join(id, { video: true }), room.id);
      await p.waitForFunction(() => window.adda.voice.getState().status === 'live' && window.adda.voice.getState().cameraOn, null, { timeout: 30_000 });
    }
    await pa.waitForFunction((id) => (window.adda.chat.getState().voice[id] ?? []).filter((v) => v.camera).length === 4, room.id, { timeout: 20_000 });
  });

  await check('the cameras float over the playing video, no call window over it: three windows (mine too), the fourth counted', async () => {
    await windows(pa).nth(2).waitFor({ timeout: 15_000 });
    expect((await windows(pa).count()) === 3, `${await windows(pa).count()} windows`);
    expect((await pa.getByRole('region', { name: /^Video call in/ }).count()) === 0, 'the call window opened over the video');
    await pa.locator('[data-call-window="me"]').waitFor();
    await pa.getByText('+1 on camera').waitFor();
    const outer = await box(player(pa).locator('[data-player-calls]'));
    for (let i = 0; i < 3; i++) expect(inside(await box(windows(pa).nth(i)), outer), `window ${i} is outside the player`);
    // Each window shows a moving picture.
    await pa.waitForFunction(
      () => [...document.querySelectorAll('[data-call-window] video')].filter((v) => v.videoWidth > 0 && v.currentTime > 0.5 && !v.paused).length === 3,
      null,
      { timeout: 20_000 },
    );
    const t = await filmTime(pa);
    expect(t && !t.paused, `the room's video isn't playing: ${JSON.stringify(t)}`);
    await pa.screenshot({ path: `${SHOTS}player-calls-1.png` });
  });

  await check('each window moves anywhere in the player and stays inside it, while the video plays on', async () => {
    await restart(pa);
    await sleep(1000);
    const before = await filmTime(pa);
    const outer = await box(player(pa).locator('[data-player-calls]'));
    const me = pa.locator('[data-call-window="me"]');
    const start = await box(me);
    await drag(pa, me, -(start.x - outer.x) + 40, -(start.y - outer.y) + 60);
    const moved = await box(me);
    expect(Math.abs(moved.x - (outer.x + 40)) < 12 && Math.abs(moved.y - (outer.y + 60)) < 12, `moved to ${JSON.stringify(moved)}`);
    // Dragged far past the edge: it stops at the edge.
    await drag(pa, me, -2000, 2000);
    const pushed = await box(me);
    expect(inside(pushed, outer), `left the player: ${JSON.stringify(pushed)} in ${JSON.stringify(outer)}`);
    expect(pushed.x - outer.x < 12 && outer.y + outer.height - (pushed.y + pushed.height) < 12, `not at the bottom-left edge: ${JSON.stringify(pushed)}`);
    // Another window, independently.
    const other = windows(pa).nth(1);
    const o1 = await box(other);
    await drag(pa, other, -150, -40);
    const o2 = await box(other);
    expect(Math.abs(o2.x - (o1.x - 150)) < 12 && Math.abs(o2.y - Math.max(outer.y + 6, o1.y - 40)) < 12, `the second window went to ${JSON.stringify(o2)} from ${JSON.stringify(o1)}`);
    expect(JSON.stringify(await box(me)) === JSON.stringify(pushed), 'moving one window moved another');
    await sleep(1000);
    const after = await filmTime(pa);
    expect(after.t > before.t + 0.8 && !after.paused, `the video stopped: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });

  await check('each window resizes from a corner on its own, never past the player, and the video plays on', async () => {
    await restart(pa);
    await sleep(1000);
    const before = await filmTime(pa);
    const outer = await box(player(pa).locator('[data-player-calls]'));
    const me = pa.locator('[data-call-window="me"]');
    const other = windows(pa).nth(1);
    const otherBefore = await box(other);
    // To the middle first (it was left at an edge), so it has room to grow.
    const m = await box(me);
    await drag(pa, me, outer.x + outer.width / 2 - (m.x + m.width / 2), outer.y + outer.height / 2 - (m.y + m.height / 2));
    const b1 = await box(me);
    // Bigger from its top-left corner (its bottom-right one stays put).
    await drag(pa, me, -100, -75, 'tl');
    const b2 = await box(me);
    expect(b2.width > b1.width + 60 && b2.height > b1.height + 40, `didn't grow: ${JSON.stringify(b1)} → ${JSON.stringify(b2)}`);
    expect(Math.abs(b2.x + b2.width - (b1.x + b1.width)) < 2 && Math.abs(b2.y + b2.height - (b1.y + b1.height)) < 2, 'the far corner moved');
    // Far smaller: it stops at the smallest size.
    await drag(pa, me, 3000, 3000, 'tl');
    const b3 = await box(me);
    expect(b3.width >= 87 && b3.width < 95 && b3.height >= 65 && b3.height < 72, `not at the smallest: ${JSON.stringify(b3)}`);
    // Far bigger: it stops at the player's edges.
    await drag(pa, me, -3000, -3000, 'tl');
    const b4 = await box(me);
    expect(inside(b4, outer) && b4.width > b2.width && b4.height > b2.height, `${JSON.stringify(b4)} in ${JSON.stringify(outer)}`);
    expect(JSON.stringify(await box(other)) === JSON.stringify(otherBefore), 'resizing one window changed another');
    await drag(pa, me, 3000, 3000, 'tl');
    const after = await filmTime(pa);
    expect(after.t > before.t + 0.5 && !after.paused, `the video stopped: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    await pa.screenshot({ path: `${SHOTS}player-calls-2.png` });
  });

  await check('the microphone and camera buttons work over the video: my camera off frees my window for the fourth person', async () => {
    const bar = pa.getByRole('toolbar', { name: 'Video call' });
    await bar.getByRole('button', { name: 'Mute microphone' }).click();
    await pa.waitForFunction(() => window.adda.voice.getState().muted);
    await bar.getByRole('button', { name: 'Unmute microphone' }).click();
    await pa.waitForFunction(() => !window.adda.voice.getState().muted);
    await bar.getByRole('button', { name: 'Turn camera off' }).click();
    await pa.locator('[data-call-window="me"]').waitFor({ state: 'detached', timeout: 10_000 });
    await pa.waitForFunction(() => document.querySelectorAll('[data-call-window]').length === 3, null, { timeout: 10_000 });
    expect((await pa.getByText('+1 on camera').count()) === 0, 'still counting one more');
    await bar.getByRole('button', { name: 'Turn camera on' }).click();
    await pa.locator('[data-call-window="me"]').waitFor({ timeout: 15_000 });
    expect((await windows(pa).count()) === 3, `${await windows(pa).count()} windows`);
    expect((await pa.getByRole('region', { name: /^Video call in/ }).count()) === 0, 'turning the camera on opened the call window');
  });

  await check('"Open the call" brings the call window; "Show over the video" puts the cameras back over it', async () => {
    await restart(pa);
    await sleep(1000);
    const before = await filmTime(pa);
    await pa.getByRole('toolbar', { name: 'Video call' }).getByRole('button', { name: 'Open the call' }).click();
    const stage = pa.getByRole('region', { name: /^Video call in/ });
    await stage.waitFor({ timeout: 5000 });
    expect((await windows(pa).count()) === 0, 'windows left over the video');
    await stage.getByRole('button', { name: 'Show over the video' }).click();
    await stage.waitFor({ state: 'detached', timeout: 5000 });
    await windows(pa).nth(2).waitFor({ timeout: 10_000 });
    const t = await filmTime(pa);
    expect(t && !t.paused && t.t > before.t + 0.5, `the video stopped: ${JSON.stringify(before)} → ${JSON.stringify(t)}`);
  });

  await check('leaving the room page: the video goes to its small player and the call to its small window (no call window over the app); back, the cameras float over the video again', async () => {
    await pa.getByRole('link', { name: 'Chats' }).first().click();
    await pa.getByRole('region', { name: /^Watching in/ }).waitFor({ timeout: 8000 });
    await pa.locator('[data-call-pip]').waitFor({ timeout: 8000 });
    expect((await pa.getByRole('region', { name: /^Video call in/ }).count()) === 0, 'the call window opened over the app');
    // Back in the app (not a reload, which would end the call).
    await pa.getByRole('link', { name: 'Rooms' }).first().click();
    await pa.getByRole('link', { name: new RegExp(`Film and friends ${stamp}`) }).first().click();
    await windows(pa).nth(2).waitFor({ timeout: 15_000 });
    expect((await pa.getByRole('region', { name: /^Video call in/ }).count()) === 0, 'the call window covers the video');
    expect((await pa.locator('[data-call-pip]').count()) === 0, 'the small call window stayed too');
  });

  await check('on a phone-sized screen: three windows inside the smaller player, moved with a finger', async () => {
    await windows(pb).nth(2).waitFor({ timeout: 15_000 });
    expect((await pb.getByRole('region', { name: /^Video call in/ }).count()) === 0, 'the call window covers the video');
    const outer = await box(player(pb).locator('[data-player-calls]'));
    for (let i = 0; i < 3; i++) expect(inside(await box(windows(pb).nth(i)), outer), `window ${i} is outside the player`);
    const w = windows(pb).first();
    const b1 = await box(w);
    // A finger drag (touch events).
    const cdp = await pb.context().newCDPSession(pb);
    const x = b1.x + b1.width / 2;
    const y = b1.y + b1.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 15 * i, y: y - 5 * i }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(200);
    const b2 = await box(w);
    expect(b2.x < b1.x - 40 && inside(b2, outer), `the finger didn't move it: ${JSON.stringify(b1)} → ${JSON.stringify(b2)}`);
    await pb.screenshot({ path: `${SHOTS}player-calls-phone.png` });
  });
} finally {
  for (const p of [pa, pb, pc, pd]) await p.evaluate(() => window.adda.voice.getState().leave?.()).catch(() => {});
  await browser.close();
  media.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
