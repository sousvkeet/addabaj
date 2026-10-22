import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// Video calls that float, as in other messengers. A one-to-one video call, or
// a room's call with cameras on, shrunk, keeps its video in a small window
// over the app: drag it anywhere and it settles at the nearest side, pinch it
// or drag its inner corner to resize it, tap it for the call; next time it's
// where it was left. On a computer the call's own window moves and resizes the
// same way. In the Android app, leaving the app turns the call into Android's
// picture-in-picture window, which the page fills with the video (the app's
// side is played here by a stand-in). Runs against the dev servers (npm run
// dev), with fake microphones and cameras.
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const APP_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 AddaKhanaApp/1.10.0';

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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.pip.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const ROOM = `Film club ${stamp}`;
const room = (await call(A, 'POST', '/rooms', { name: ROOM, maxMembers: 6 })).data.room;
await call(A, 'POST', `/rooms/${room.id}/members`, { userId: B.id });
await call(A, 'POST', `/dms/${B.id}/messages`, { body: 'Hi' });

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
/** A phone or a computer; `app`: the Android app, with a stand-in for its side of the bridge. */
async function page(user, { phone = false, app = false } = {}) {
  const ctx = await browser.newContext({
    ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }),
    ...(app ? { userAgent: APP_UA } : {}),
    permissions: ['microphone', 'camera'],
  });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  await ctx.addInitScript((app) => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__pcs.push(this);
      }
    };
    if (!app) return;
    // The app keeps what the page says is running (it floats a video call from it).
    window.__sessions = [];
    const granted = { notifications: 'granted', microphone: 'granted', camera: 'granted', fullScreen: 'granted', battery: 'granted', seen: true };
    window.AddaNative = {
      setTheme() {},
      retry() {},
      ready() {},
      ack() {},
      setUser() {},
      haptic() {},
      setBackHandled() {},
      setSpeaker() {},
      clearChat() {},
      askPermission() {},
      permissionsSeen() {},
      pushToken: () => '',
      isRinging: () => false,
      isSpeakerOn: () => false,
      appVersion: () => '1.10.0',
      permissions: () => JSON.stringify(granted),
      callState: (json) => window.__sessions.push(JSON.parse(json)),
    };
  }, app);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}

const pip = (p) => p.locator('[data-call-pip]');
const rounded = (b) => b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
/** Where it is, once it's done moving (it pops in, and settles after a drag). */
async function boxOf(locator) {
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));
  let last = null;
  for (let i = 0; i < 20; i++) {
    const now = rounded(await locator.boundingBox());
    if (now && last && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
    await sleep(120);
  }
  throw new Error('it never stopped moving');
}
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
async function drag(p, from, to) {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move(to.x, to.y, { steps: 12 });
  await p.mouse.up();
}
/** Two fingers on the screen, from `from` to `to` pixels either side of `c`. */
async function pinch(p, c, from, to) {
  const cdp = await p.context().newCDPSession(p);
  const points = (d) => [
    { x: c.x - d, y: c.y, id: 1 },
    { x: c.x + d, y: c.y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + ((to - from) * i) / 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
/** A moving picture in this video. */
async function moving(p, selector, what) {
  const time = () => p.evaluate((s) => [...document.querySelectorAll(s)].map((v) => (v.videoWidth > 0 ? v.currentTime : -1))[0] ?? -1, selector);
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const before = await time();
    await sleep(800);
    if (before >= 0 && (await time()) > before) return;
  }
  throw new Error(`no moving picture in ${what}`);
}
/** Connected to the server, so a call reaches it. */
const online = (p) => p.waitForFunction(() => window.adda?.socket?.connected, null, { timeout: 15_000 });
/** What the Android app tells the page. */
const native = (p, detail) => p.evaluate((d) => window.dispatchEvent(new CustomEvent('addanative', { detail: { ...d, __id: Math.random() } })), detail);

const pa = await page(A, { phone: true });
const pb = await page(B);
const callWindow = (p, name) => p.getByRole('region', { name: `Video call with ${name}` });
const roomStage = (p) => p.getByRole('region', { name: /^Video call in/ });
let pn;

try {
  await check('a one-to-one video call shrunk on a phone floats at the side: “Calling…”, then the other person’s video', async () => {
    await pa.goto(`${BASE}/chats/${B.id}`);
    await pb.goto(`${BASE}/chats/${A.id}`);
    await online(pa);
    await online(pb);
    await pa.getByRole('button', { name: 'Video call Bikram Sil' }).click();
    await callWindow(pa, 'Bikram Sil').getByRole('button', { name: 'Shrink video' }).click();
    await pip(pa).getByText('Calling…').waitFor();
    await pa.screenshot({ path: `${SHOTS}pip-0-calling.png` });
    await pb.getByRole('button', { name: 'Accept with video' }).click();
    await pa.waitForFunction(() => window.adda.call.getState().phase === 'active', null, { timeout: 15_000 });
    await pa.getByRole('button', { name: 'Video call with Bikram Sil. Open the call' }).waitFor();
    await moving(pa, '[data-call-pip] video', 'the floating window');
    await pip(pa).getByText('Calling…').waitFor({ state: 'detached' });
    await pip(pa).getByText('Bikram', { exact: true }).waitFor();
    const b = await boxOf(pip(pa));
    expect(b.w === 120 && b.h === 160, `it’s ${b.w}×${b.h}, not 120×160`);
    expect(b.x + b.w === 380, `it isn’t at the right side (${JSON.stringify(b)})`);
    await pa.screenshot({ path: `${SHOTS}pip-1-floating.png` });
  });

  await check('the call’s picture starts sharp (1.2 Mbps) and may go up to 3 Mbps at 30 frames a second, both ways', async () => {
    for (const [p, who] of [
      [pa, 'Asha'],
      [pb, 'Bikram'],
    ]) {
      const got = await p.waitForFunction(
        () => {
          const pc = window.__pcs.filter((x) => x.connectionState === 'connected').at(-1);
          const e = pc?.getSenders().find((s) => s.track?.kind === 'video')?.getParameters().encodings?.[0];
          return e?.maxBitrate === 3_000_000 && e.maxFramerate === 30 && pc.remoteDescription?.sdp.includes('x-google-start-bitrate=1200') && { max: e.maxBitrate };
        },
        null,
        { timeout: 8000 },
      );
      expect(await got.jsonValue(), `${who}’s camera isn’t tuned`);
    }
  });

  await check('drag it anywhere: let go and it settles at the nearest side, where it was dropped', async () => {
    let b = await boxOf(pip(pa));
    await drag(pa, center(b), { x: 120, y: 420 });
    b = await boxOf(pip(pa));
    expect(b.x === 10, `it didn’t settle at the left side (${JSON.stringify(b)})`);
    expect(Math.abs(b.y + b.h / 2 - 420) <= 2, `it isn’t where it was dropped (${JSON.stringify(b)})`);
    expect(!(await callWindow(pa, 'Bikram Sil').count()), 'dragging it opened the call');
    await pa.screenshot({ path: `${SHOTS}pip-2-dragged-left.png` });
    await drag(pa, center(b), { x: 230, y: 300 });
    b = await boxOf(pip(pa));
    expect(b.x + b.w === 380, `just right of the middle, it didn’t settle at the right side (${JSON.stringify(b)})`);
    // Not off the screen, nor under the call's bar at the top.
    await drag(pa, center(b), { x: 300, y: 5 });
    b = await boxOf(pip(pa));
    expect(b.y === 82, `dragged off the top it’s at ${b.y}, not under the bar at 82`);
  });

  await check('drag its inner corner to make it bigger or smaller; it keeps its shape, up to three quarters of the screen', async () => {
    await drag(pa, center(await boxOf(pip(pa))), { x: 300, y: 500 });
    const b = await boxOf(pip(pa));
    // At the right side, the grip is its top left corner.
    const grip = rounded(await pip(pa).locator('[data-no-drag]').boundingBox());
    expect(Math.abs(grip.x - b.x) <= 1 && Math.abs(grip.y - b.y) <= 1, 'the grip isn’t at the inner top corner');
    await drag(pa, { x: grip.x + 8, y: grip.y + 8 }, { x: grip.x + 8 - 90, y: grip.y + 8 - 120 });
    const bigger = await boxOf(pip(pa));
    expect(bigger.w === b.w + 90, `it didn’t grow with the drag (${b.w} → ${bigger.w})`);
    expect(Math.abs(bigger.w / bigger.h - 3 / 4) < 0.01, `its shape changed (${bigger.w}×${bigger.h})`);
    expect(bigger.x + bigger.w === b.x + b.w && bigger.y + bigger.h === b.y + b.h, 'the opposite corner moved');
    await pa.screenshot({ path: `${SHOTS}pip-3-bigger.png` });
    const g = rounded(await pip(pa).locator('[data-no-drag]').boundingBox());
    await drag(pa, { x: g.x + 8, y: g.y + 8 }, { x: g.x + 8 - 300, y: g.y + 8 - 400 });
    const most = await boxOf(pip(pa));
    expect(Math.abs(most.w - 390 * 0.75) <= 1, `it grew to ${most.w}, not three quarters of the screen`);
    const h = rounded(await pip(pa).locator('[data-no-drag]').boundingBox());
    await drag(pa, { x: h.x + 8, y: h.y + 8 }, { x: h.x + 8 + 190, y: h.y + 8 + 260 });
    const smaller = await boxOf(pip(pa));
    expect(Math.abs(smaller.w - (most.w - 190)) <= 1, `it didn’t shrink with the drag (${most.w} → ${smaller.w})`);
  });

  await check('pinch it with two fingers: bigger, or smaller down to its smallest', async () => {
    const b = await boxOf(pip(pa));
    await pinch(pa, center(b), 30, 45);
    const bigger = await boxOf(pip(pa));
    expect(Math.abs(bigger.w - b.w * 1.5) <= 2, `pinched out by half, it went ${b.w} → ${bigger.w}`);
    expect(Math.abs(bigger.w / bigger.h - 3 / 4) < 0.01, `its shape changed (${bigger.w}×${bigger.h})`);
    expect(Math.abs(bigger.x + bigger.w - 380) <= 1, 'it didn’t settle at its side');
    await pinch(pa, center(bigger), 60, 8);
    const least = await boxOf(pip(pa));
    expect(least.w === 96 && least.h === 128, `pinched in, it’s ${least.w}×${least.h}, not its smallest 96×128`);
    await pinch(pa, center(least), 20, 30);
  });

  await check('tap it for the call; shrunk again, it’s where it was left, as big (and Enter opens it too)', async () => {
    const before = await boxOf(pip(pa));
    await pa.mouse.click(center(before).x, center(before).y);
    await callWindow(pa, 'Bikram Sil').waitFor();
    await pip(pa).waitFor({ state: 'detached' });
    await callWindow(pa, 'Bikram Sil').getByRole('button', { name: 'Shrink video' }).click();
    const after = await boxOf(pip(pa));
    expect(JSON.stringify(after) === JSON.stringify(before), `it came back at ${JSON.stringify(after)}, not ${JSON.stringify(before)}`);
    // A rotated phone (a wider screen) keeps it on screen, and it's back where it was after.
    await pa.setViewportSize({ width: 844, height: 390 });
    const turned = await boxOf(pip(pa));
    expect(turned.y + turned.h <= 390 - 10 && turned.x + turned.w === 844 - 10, `turned sideways, it’s off screen (${JSON.stringify(turned)})`);
    await pa.setViewportSize({ width: 390, height: 844 });
    const back = await boxOf(pip(pa));
    expect(JSON.stringify(back) === JSON.stringify(before), `turned back, it’s at ${JSON.stringify(back)}, not where it was left (${JSON.stringify(before)})`);
    await pip(pa).focus();
    await pa.keyboard.press('Enter');
    await callWindow(pa, 'Bikram Sil').waitFor();
  });

  await check('on a computer the call’s window moves by its top and resizes from its corners; it stays where it was put', async () => {
    const win = callWindow(pb, 'Asha Sen');
    const start = await boxOf(win);
    expect(start.x + start.w === 1280 - 16 && start.y + start.h === 860 - 16, `it doesn’t start at the bottom right (${JSON.stringify(start)})`);
    await drag(pb, { x: start.x + 90, y: start.y + 30 }, { x: 184 + 90, y: 134 + 30 });
    const moved = await boxOf(win);
    expect(moved.x === 184 && moved.y === 134 && moved.w === start.w && moved.h === start.h, `moved: ${JSON.stringify(moved)}`);
    await drag(pb, { x: moved.x + 12, y: moved.y + 12 }, { x: moved.x + 12 - 120, y: moved.y + 12 - 80 });
    const sized = await boxOf(win);
    expect(sized.w === moved.w + 120 && sized.h === moved.h + 80, `resized to ${sized.w}×${sized.h}`);
    expect(sized.x + sized.w === moved.x + moved.w && sized.y + sized.h === moved.y + moved.h, 'the opposite corner moved');
    // Any shape, but not smaller than a usable window.
    await drag(pb, { x: sized.x + sized.w - 12, y: sized.y + sized.h - 12 }, { x: sized.x + 100, y: sized.y + 100 });
    const least = await boxOf(win);
    expect(least.w === 360 && least.h === 280, `it shrank to ${least.w}×${least.h}, below 360×280`);
    await drag(pb, { x: least.x + least.w - 12, y: least.y + least.h - 12 }, { x: least.x + 360 - 12 + 285, y: least.y + 280 - 12 + 145 });
    const kept = await boxOf(win);
    await pb.screenshot({ path: `${SHOTS}pip-4-computer-window.png` });
    // Shrunk and opened again, it's where it was put.
    await win.getByRole('button', { name: 'Shrink video' }).click();
    await win.waitFor({ state: 'detached' });
    await pb.getByRole('button', { name: 'Video call with Asha Sen. Open the call' }).click();
    expect(JSON.stringify(await boxOf(win)) === JSON.stringify(kept), 'opened again, it moved');
  });

  await check('dropping off the network, it says “Reconnecting…”; back, the video carries on', async () => {
    await callWindow(pa, 'Bikram Sil').getByRole('button', { name: 'Shrink video' }).click();
    await pip(pa).waitFor();
    await pa.context().setOffline(true);
    await pip(pa).getByText('Reconnecting…').waitFor({ timeout: 10_000 });
    await pa.screenshot({ path: `${SHOTS}pip-4b-reconnecting.png` });
    await pa.context().setOffline(false);
    await pip(pa).getByText('Reconnecting…').waitFor({ state: 'detached', timeout: 25_000 });
    await moving(pa, '[data-call-pip] video', 'the floating window, connected again');
  });

  await check('the call ends: its floating window goes', async () => {
    await callWindow(pb, 'Asha Sen').getByRole('button', { name: 'End call' }).click();
    await pip(pa).waitFor({ state: 'detached', timeout: 8000 });
  });

  await check('a room’s call with cameras on, shrunk, floats whoever’s on camera, sent at its small size', async () => {
    await pa.goto(`${BASE}/rooms/${room.id}`);
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await pa.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('region', { name: 'Voice', exact: true }).getByRole('button', { name: 'Turn camera on' }).click();
    await roomStage(pa).waitFor({ timeout: 15_000 });
    await roomStage(pa).getByRole('button', { name: 'Shrink video' }).click();
    await pa.getByRole('button', { name: `Video call in ${ROOM}. Open the call` }).waitFor();
    await moving(pa, '[data-call-pip] video', 'the room’s floating window');
    await pip(pa).getByText('Bikram', { exact: true }).waitFor();
    // Bikram sends Asha's phone a small picture: just what the window needs.
    await pb.waitForFunction(
      () =>
        window.__pcs
          .filter((pc) => pc.connectionState === 'connected')
          .some((pc) => (pc.getSenders().find((s) => s.track?.kind === 'video')?.getParameters().encodings?.[0]?.scaleResolutionDownBy ?? 0) >= 2),
      null,
      { timeout: 10_000 },
    );
    await pa.screenshot({ path: `${SHOTS}pip-5-room-floating.png` });
    await pip(pa).click();
    await roomStage(pa).waitFor();
    await pip(pa).waitFor({ state: 'detached' });
  });

  await check('on a computer the room’s call window moves and resizes too, and full screen fills the screen', async () => {
    const win = roomStage(pb);
    const start = await boxOf(win);
    await drag(pb, { x: start.x + 160, y: start.y + 24 }, { x: 300 + 160, y: 120 + 24 });
    const moved = await boxOf(win);
    expect(moved.x === 300 && moved.y === 120 && moved.w === start.w, `moved: ${JSON.stringify(moved)} from ${JSON.stringify(start)}`);
    await drag(pb, { x: moved.x + moved.w - 12, y: moved.y + moved.h - 12 }, { x: moved.x + moved.w - 12 + 100, y: moved.y + moved.h - 12 + 60 });
    const sized = await boxOf(win);
    expect(sized.w === moved.w + 100 && sized.h === moved.h + 60 && sized.x === moved.x && sized.y === moved.y, `resized: ${JSON.stringify(sized)}`);
    await win.getByRole('button', { name: 'Full screen' }).click();
    const full = await boxOf(win);
    expect(full.x === 0 && full.y === 0 && full.w === 1280 && full.h === 860, `full screen: ${JSON.stringify(full)}`);
    await win.getByRole('button', { name: 'Exit full screen' }).click();
    expect(JSON.stringify(await boxOf(win)) === JSON.stringify(sized), 'out of full screen, it isn’t where it was');
    await pa.getByRole('button', { name: 'Leave the call' }).click();
    await win.getByRole('button', { name: 'Leave the call' }).click();
    await pb.getByRole('button', { name: 'Join voice' }).first().waitFor();
  });

  await check('in the Android app, a video call tells the app it can float, with its shape and whether I’m muted', async () => {
    await pa.context().close();
    pn = await page(A, { phone: true, app: true });
    await pn.goto(`${BASE}/chats/${B.id}`);
    await pb.goto(`${BASE}/chats/${A.id}`);
    await online(pn);
    await online(pb);
    await pn.getByRole('button', { name: 'Video call Bikram Sil' }).click();
    await pb.getByRole('button', { name: 'Accept with video' }).click();
    await pn.waitForFunction(() => window.adda.call.getState().phase === 'active', null, { timeout: 15_000 });
    // The window takes the shape of Bikram's picture (the nearest common one), once it arrives.
    const { width, height } = await pb.evaluate(() => window.adda.call.getState().localVideo.getVideoTracks()[0].getSettings());
    const want = [[9, 16], [3, 4], [1, 1], [4, 3], [16, 9]].reduce((a, b) =>
      Math.abs(Math.log(b[0] / b[1] / (width / height))) < Math.abs(Math.log(a[0] / a[1] / (width / height))) ? b : a,
    );
    expect(want[0] > want[1], `Bikram’s fake camera isn’t landscape (${width}×${height})`);
    const s = await (
      await pn.waitForFunction(
        ([w, h]) => window.__sessions.findLast((s) => s.kind === 'call' && s.phase === 'active' && s.pip?.w === w && s.pip?.h === h),
        want,
        { timeout: 10_000 },
      )
    ).jsonValue();
    expect(s.muted === false, 'it says I’m muted');
  });

  await check('leaving the app floats it: the page shows just the video, and isn’t counted as looking', async () => {
    await pn.evaluate(() => {
      window.__states = [];
      const socket = window.adda.socket;
      const emit = socket.emit.bind(socket);
      socket.emit = (event, ...args) => {
        if (event === 'client:state') window.__states.push(args[0].active);
        return emit(event, ...args);
      };
    });
    await native(pn, { type: 'pip', on: true });
    const full = pn.locator('[data-native-pip]');
    await full.waitFor();
    await moving(pn, '[data-native-pip] video', 'the app’s floating window');
    const b = await boxOf(full);
    expect(b.x === 0 && b.y === 0 && b.w === 390 && b.h === 844, `it doesn’t fill the window (${JSON.stringify(b)})`);
    await pn.waitForFunction(() => window.__states.at(-1) === false, null, { timeout: 5000 });
    // Android's window is small: the page is drawn that size.
    await pn.setViewportSize({ width: 240, height: 320 });
    await pn.screenshot({ path: `${SHOTS}pip-6-android-window.png` });
  });

  await check('its mute button mutes the call, and the app hears it to change the button; back in the app, all as it was', async () => {
    await native(pn, { type: 'mute' });
    await pn.waitForFunction(() => window.adda.call.getState().muted && window.__sessions.at(-1).muted === true, null, { timeout: 5000 });
    await pb.waitForFunction(() => window.adda.call.getState().peerMuted, null, { timeout: 8000 });
    await native(pn, { type: 'mute' });
    await pn.waitForFunction(() => !window.adda.call.getState().muted && window.__sessions.at(-1).muted === false, null, { timeout: 5000 });
    await pn.setViewportSize({ width: 390, height: 844 });
    await native(pn, { type: 'pip', on: false });
    await pn.locator('[data-native-pip]').waitFor({ state: 'detached' });
    await pn.waitForFunction(() => window.__states.at(-1) === true, null, { timeout: 5000 });
    await callWindow(pn, 'Bikram Sil').waitFor();
  });

  await check('its hang-up button ends the call, and the app hears there’s nothing left to float', async () => {
    await native(pn, { type: 'pip', on: true });
    await native(pn, { type: 'hangup' });
    await pn.waitForFunction(() => window.adda.call.getState().phase === 'idle', null, { timeout: 8000 });
    await pn.waitForFunction(() => !window.__sessions.at(-1).pip, null, { timeout: 5000 });
    await pn.locator('[data-native-pip]').waitFor({ state: 'detached' });
    await native(pn, { type: 'pip', on: false });
  });

  await check('a room’s call with cameras on floats too, showing whoever’s on camera; its mute button mutes my voice', async () => {
    await pn.goto(`${BASE}/rooms/${room.id}`);
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await pn.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('button', { name: 'Join voice' }).first().click();
    await pn.waitForFunction(() => window.__sessions.at(-1).kind === 'voice' && !window.__sessions.at(-1).pip, null, { timeout: 10_000 });
    await pb.getByRole('region', { name: 'Voice', exact: true }).getByRole('button', { name: 'Turn camera on' }).click();
    await pn.waitForFunction(() => window.__sessions.at(-1).kind === 'voice' && window.__sessions.at(-1).pip?.w === 3, null, { timeout: 10_000 });
    await native(pn, { type: 'pip', on: true });
    await pn.locator('[data-native-pip]').waitFor();
    await moving(pn, '[data-native-pip] video', 'the app’s floating window in the room');
    await pn.locator('[data-native-pip]').getByText('Bikram', { exact: true }).waitFor();
    await native(pn, { type: 'mute' });
    await pn.waitForFunction(() => window.adda.voice.getState().muted && window.__sessions.at(-1).muted === true, null, { timeout: 5000 });
    await native(pn, { type: 'pip', on: false });
    await roomStage(pn).waitFor();
    // Cameras off: nothing to float.
    await roomStage(pb).getByRole('button', { name: 'Turn camera off' }).click();
    await pn.waitForFunction(() => window.__sessions.at(-1).kind === 'voice' && !window.__sessions.at(-1).pip, null, { timeout: 10_000 });
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
