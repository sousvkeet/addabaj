import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

// Live streams from an admin's device: a video file and a shared screen, sent
// browser to browser to the rest of the room. Runs against the dev servers.
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const clip = readFileSync(new URL('./fixtures/tone-60s.webm', import.meta.url)); // 640×360, 440 Hz tone, 60 s
// H.264 picture with Dolby Digital 5.1 sound, which browsers can't play: the host's browser converts it.
const dolby = readFileSync(new URL('./fixtures/dolby-24s.mkv', import.meta.url));

const browser = await chromium.launch({
  // No autoplay override: viewers must work under Chrome's real autoplay rules.
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

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

async function user(name, phone = false) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  // Keep a handle on every peer connection, to read what actually arrives.
  await ctx.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__pcs.push(this);
      }
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && console.log(`[${name} console]`, m.text()));
  return { name, ctx, page, email: `${name.toLowerCase()}.${stamp}@example.com` };
}

async function signup(u, fullName) {
  await u.page.goto(`${BASE}/signup`);
  await u.page.getByLabel('Your name').fill(fullName);
  await u.page.getByLabel('Email').fill(u.email);
  await u.page.getByLabel('Password').fill('password123');
  await u.page.getByRole('button', { name: 'Create account' }).click();
  await u.page.waitForURL(`${BASE}/chats`);
  u.id = await u.page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id);
}

const api = (page, path, init) =>
  page.evaluate(
    async ([path, init]) => {
      const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      return { status: res.status, data: await res.json().catch(() => null) };
    },
    [path, init],
  );

/** Picture size, frames decoded in a second, and sound level of the live video on this page. */
const viewerStats = (page) =>
  page.evaluate(async () => {
    const v = document.querySelector('[data-live-video]');
    if (!v?.srcObject) return null;
    const f1 = v.getVideoPlaybackQuality().totalVideoFrames;
    await new Promise((r) => setTimeout(r, 1000));
    const f2 = v.getVideoPlaybackQuality().totalVideoFrames;
    // Sound as received (Web Audio can't tap incoming call audio in Chrome).
    let level = 0;
    for (const pc of window.__pcs) {
      if (pc.connectionState !== 'connected') continue;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') level = Math.max(level, r.audioLevel ?? 0);
      });
    }
    return { width: v.videoWidth, height: v.videoHeight, frames: f2 - f1, audioTracks: v.srcObject.getAudioTracks().length, level: Number(level.toFixed(4)) };
  });

/** Waits for the live picture (tapping "watch along" if the browser wants a click first) and checks it moves. */
async function seesStream(u, { width, minWidth = 1, minLevel = 0.01, sound = true } = {}) {
  const deadline = Date.now() + 20_000;
  let stats = null;
  while (Date.now() < deadline) {
    const tap = u.page.getByRole('button', { name: 'Click to watch along' });
    if (await tap.isVisible().catch(() => false)) await tap.click();
    stats = await viewerStats(u.page).catch(() => null);
    // WebRTC starts small and sharpens as it learns the bandwidth, so give the size time too.
    if (stats && stats.width >= minWidth && (!width || stats.width === width) && stats.frames > 3 && (!sound || stats.level >= minLevel)) break;
    await u.page.waitForTimeout(500);
  }
  if (!stats || stats.width === 0) throw new Error(`${u.name} has no live picture (${JSON.stringify(stats)})`);
  if (stats.frames <= 3) throw new Error(`${u.name}'s picture is frozen (${JSON.stringify(stats)})`);
  if (width && stats.width !== width) throw new Error(`${u.name} gets ${stats.width}px wide video, expected ${width}`);
  if (stats.width < minWidth) throw new Error(`${u.name} gets ${stats.width}px wide video, expected at least ${minWidth}`);
  if (sound && stats.level < minLevel) throw new Error(`${u.name} hears nothing (${JSON.stringify(stats)})`);
  return stats;
}

const stage = (page) => page.getByRole('region', { name: 'Live stream' });

const A = await user('Asha');
const B = await user('Rahul');
const C = await user('Mitali', true);

await check('three people sign up and share a room', async () => {
  await signup(A, 'Asha Sen');
  await signup(B, 'Rahul Das');
  await signup(C, 'Mitali Roy');
  const { data } = await api(A.page, '/rooms', { method: 'POST', body: JSON.stringify({ name: `Cinema ${stamp}`, maxMembers: 5 }) });
  A.room = data.room.id;
  for (const u of [B, C]) {
    const r = await api(A.page, `/rooms/${A.room}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id }) });
    if (r.status >= 300) throw new Error(`adding ${u.name}: ${r.status}`);
  }
  for (const u of [A, B, C]) await u.page.goto(`${BASE}/rooms/${A.room}`);
});

await check('the watch dialog offers "From your device" with a file and a screen option', async () => {
  await A.page.getByRole('button', { name: 'Watch together' }).click();
  const dlg = A.page.getByRole('dialog');
  await dlg.getByRole('tab', { name: 'From your device' }).click();
  await dlg.getByRole('button', { name: /Stream a video file/ }).waitFor();
  await dlg.getByRole('button', { name: /Share your screen or a tab/ }).waitFor();
  await dlg.getByText(/up to 10 people can watch/).waitFor();
  await A.page.screenshot({ path: `${SHOTS}live-01-dialog.png` });
});

await check('Asha streams a video file; the room announces it', async () => {
  await A.page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'Durga Puja 2026.webm', mimeType: 'video/webm', buffer: clip });
  await A.page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10_000 });
  await stage(A.page).getByText('Durga Puja 2026').waitFor();
  await A.page.getByRole('log').getByText('Asha Sen is streaming “Durga Puja 2026” live from their device').waitFor({ timeout: 5000 });
});

await check('Rahul (desktop) and Mitali (phone) get the live picture and sound', async () => {
  const b = await seesStream(B, { width: 640 });
  const c = await seesStream(C, { width: 640 });
  console.log(`     Rahul: ${JSON.stringify(b)}\n     Mitali: ${JSON.stringify(c)}`);
  await stage(A.page).getByText(/Live to 2 people/).waitFor({ timeout: 10_000 });
  await stage(A.page).getByText(/2 watching/).waitFor();
  await A.page.screenshot({ path: `${SHOTS}live-02-host.png` });
  await B.page.screenshot({ path: `${SHOTS}live-03-viewer.png` });
  await C.page.screenshot({ path: `${SHOTS}live-04-phone.png` });
  const over = await C.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) throw new Error(`phone page scrolls sideways by ${over}px`);
});

await check('members cannot pause or seek; Asha pausing shows "Paused by Asha Sen" for everyone', async () => {
  if (await stage(B.page).getByRole('button', { name: /Pause for everyone/ }).count()) throw new Error('a member got host controls');
  await stage(A.page).getByRole('button', { name: 'Pause for everyone' }).click();
  await stage(B.page).getByText('Paused by Asha Sen').waitFor({ timeout: 5000 });
  await stage(C.page).getByText('Paused by Asha Sen').waitFor({ timeout: 5000 });
  await stage(A.page).getByRole('button', { name: 'Play for everyone' }).click();
  await stage(B.page).getByText('Paused by Asha Sen').waitFor({ state: 'detached', timeout: 5000 });
});

await check('Asha jumps to 0:15 and Rahul’s progress follows', async () => {
  await stage(A.page).getByRole('slider', { name: 'Position' }).fill('15');
  await B.page.waitForFunction(
    () => {
      const bar = document.querySelector('[aria-label="Position in the video"]');
      const now = Number(bar?.getAttribute('aria-valuenow'));
      return now >= 14 && now <= 19;
    },
    null,
    { timeout: 6000 },
  );
});

await check('Asha muting her own speakers doesn’t mute the stream', async () => {
  await stage(A.page).getByRole('button', { name: 'Mute (only for you)' }).click();
  await A.page.waitForTimeout(800);
  await seesStream(B);
  await stage(A.page).getByRole('button', { name: 'Unmute (only for you)' }).click();
});

await check('Asha mutes the stream for everyone: Rahul’s and Mitali’s players and her own file go quiet; unmuting brings everyone’s own sound back', async () => {
  const viewer = (u) => u.page.evaluate(() => document.querySelector('[data-live-video]')?.muted);
  // The file Asha streams plays in a hidden player of its own.
  const hostFile = () => A.page.evaluate(() => [...document.querySelectorAll('body > video')].map((v) => v.muted));
  // Asha had turned her own speakers off: that's hers, and stays.
  await stage(A.page).getByRole('button', { name: 'Mute (only for you)' }).click();
  await stage(A.page).getByRole('button', { name: 'Mute for everyone', exact: true }).click();
  await stage(B.page).getByText('Muted for everyone by Asha Sen').waitFor({ timeout: 5000 });
  await stage(C.page).getByText('Muted for everyone by Asha Sen').waitFor({ timeout: 5000 });
  await C.page.getByRole('log').getByText('Asha Sen muted the video for everyone').waitFor({ timeout: 5000 });
  const muted = [await viewer(B), await viewer(C), await hostFile()];
  if (muted[0] !== true || muted[1] !== true || String(muted[2]) !== 'true') throw new Error(`not muted for everyone: ${JSON.stringify(muted)}`);
  await C.page.screenshot({ path: `${SHOTS}live-05-muted-phone.png` });
  // Rahul's own button can't turn it back on; reloading, he comes back to it muted.
  await stage(B.page).getByRole('button', { name: 'Muted for everyone' }).click();
  await B.page.getByText(/Only an admin can turn its sound back on/).waitFor();
  await B.page.reload();
  await seesStream(B, { sound: false });
  if ((await viewer(B)) !== true) throw new Error('Rahul came back with sound');
  await stage(A.page).getByRole('button', { name: 'Unmute for everyone', exact: true }).click();
  await B.page.getByRole('log').getByText('Asha Sen unmuted the video for everyone').waitFor({ timeout: 5000 });
  await A.page.waitForTimeout(2500);
  await seesStream(B);
  await seesStream(C);
  const back = [await viewer(B), await viewer(C), await hostFile()];
  if (back[0] !== false || back[1] !== false || String(back[2]) !== 'true') throw new Error(`the sound did not come back as it was: ${JSON.stringify(back)}`);
  await stage(A.page).getByRole('button', { name: 'Unmute (only for you)' }).click();
  if (String(await hostFile()) !== 'false') throw new Error('Asha could not turn her own sound back on');
});

await check('the stream keeps going while Asha looks at another page; her live bar brings her back', async () => {
  await A.page.getByRole('link', { name: /^Chats/ }).click();
  await A.page.waitForURL(/\/chats/);
  const bar = A.page.getByRole('region', { name: 'Your live stream' });
  await bar.getByText(`Live in Cinema ${stamp}`).waitFor();
  await A.page.screenshot({ path: `${SHOTS}live-06-bar.png` });
  await B.page.waitForTimeout(1500);
  await seesStream(B);
  await bar.getByRole('button', { name: `Live in Cinema ${stamp}` }).click();
  await A.page.waitForURL(new RegExp(`/rooms/${A.room}$`));
  await bar.waitFor({ state: 'detached' });
  await stage(A.page).getByRole('button', { name: /(Pause|Play) for everyone/ }).waitFor();
});

await check('Rahul reloads and gets the stream again', async () => {
  await B.page.reload();
  await seesStream(B);
  await stage(A.page).getByText(/Live to 2 people/).waitFor({ timeout: 10_000 });
});

await check('a short drop of Asha’s connection doesn’t end the stream', async () => {
  await A.page.evaluate(() => {
    window.adda.socket.disconnect();
    setTimeout(() => window.adda.socket.connect(), 3000);
  });
  await A.page.waitForTimeout(6000);
  if (!(await A.page.evaluate(() => !!window.adda.live.getState().host?.sessionId))) throw new Error('host lost its stream');
  await seesStream(B);
});

await check('Asha stops streaming; everyone’s player goes away', async () => {
  await stage(A.page).getByRole('button', { name: 'Stop streaming' }).click();
  await stage(B.page).waitFor({ state: 'detached', timeout: 5000 });
  await stage(C.page).waitFor({ state: 'detached', timeout: 5000 });
  await B.page.getByRole('log').getByText('Asha Sen ended the live stream').waitFor({ timeout: 5000 });
});

await check('a movie with Dolby Digital 5.1 sound is converted in Asha’s browser, and everyone hears it, also after a jump', async () => {
  await A.page.getByRole('button', { name: 'Watch together' }).click();
  const dlg = A.page.getByRole('dialog');
  await dlg.getByRole('tab', { name: 'From your device' }).click();
  await dlg.locator('input[type=file]').setInputFiles({ name: 'Dolby movie.mkv', mimeType: 'video/x-matroska', buffer: dolby });
  // The first time, this includes downloading the sound converter.
  await dlg.waitFor({ state: 'detached', timeout: 90_000 });
  await stage(A.page).getByText('Sound converted from Dolby Digital 5.1').waitFor({ timeout: 10_000 });
  const before = await seesStream(B);
  console.log(`     converted sound: ${JSON.stringify(before)}`);
  await A.page.screenshot({ path: `${SHOTS}live-07-dolby-host.png` });
  await stage(A.page).getByRole('slider', { name: 'Position' }).fill('15');
  await B.page.waitForTimeout(3500);
  await seesStream(B);
  const drift = await A.page.evaluate(() => {
    const [video, audio] = [document.querySelector('video[src^="blob:"]'), document.querySelector('audio[data-sound-fix]')];
    return audio && video ? Math.abs(audio.currentTime - video.currentTime) : null;
  });
  if (drift === null || drift > 0.35) throw new Error(`sound is ${drift}s off the picture`);
  // Muting her own speakers must not mute the converted sound for viewers.
  await stage(A.page).getByRole('button', { name: 'Mute (only for you)' }).click();
  await A.page.waitForTimeout(800);
  await seesStream(B);
  await stage(A.page).getByRole('button', { name: 'Unmute (only for you)' }).click();
  await stage(A.page).getByRole('button', { name: 'Stop streaming' }).click();
  await stage(B.page).waitFor({ state: 'detached', timeout: 5000 });
});

await check('Asha shares her screen; Rahul sees it with sound', async () => {
  await A.page.getByRole('button', { name: 'Watch together' }).click();
  const dlg = A.page.getByRole('dialog');
  await dlg.getByRole('tab', { name: 'From your device' }).click();
  await dlg.getByRole('button', { name: /Share your screen or a tab/ }).click();
  await dlg.waitFor({ state: 'detached', timeout: 10_000 });
  await stage(B.page).getByText("Asha Sen's screen", { exact: true }).waitFor({ timeout: 5000 });
  // A busy computer may trim a little to keep motion smooth, but it must not start blurry (WebRTC's default is 320 px).
  const s = await seesStream(B, { minWidth: 960, minLevel: 0.001 });
  console.log(`     screen: ${JSON.stringify(s)}`);
  await B.page.screenshot({ path: `${SHOTS}live-05-screen.png` });
});

await check('another admin can stop the stream; Asha is told', async () => {
  const r = await api(A.page, `/rooms/${A.room}/members/${B.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
  if (r.status >= 300) throw new Error(`making Rahul admin: ${r.status}`);
  await B.page.reload();
  await stage(B.page).getByRole('button', { name: 'Stop for everyone' }).click();
  await A.page.getByText('An admin ended your live stream.').waitFor({ timeout: 5000 });
  if (await A.page.evaluate(() => !!window.adda.live.getState().host)) throw new Error('Asha still thinks she is live');
});

await check('a member’s server refuses: they cannot start a stream', async () => {
  const res = await C.page.evaluate(
    (roomId) =>
      new Promise((resolve) =>
        window.adda.socket.emit('live:start', { roomId, mode: 'file', title: 'x' }, (r) => resolve(r)),
      ),
    A.room,
  );
  if (res.ok) throw new Error('a member started a stream');
});

await check('closing the host’s tab ends the stream for everyone at once', async () => {
  await A.page.getByRole('button', { name: 'Watch together' }).click();
  const dlg = A.page.getByRole('dialog');
  await dlg.getByRole('tab', { name: 'From your device' }).click();
  await dlg.locator('input[type=file]').setInputFiles({ name: 'second.webm', mimeType: 'video/webm', buffer: clip });
  await dlg.waitFor({ state: 'detached', timeout: 10_000 });
  await seesStream(B);
  await A.page.close({ runBeforeUnload: true });
  await stage(B.page).waitFor({ state: 'detached', timeout: 5000 });
});

await check('a host whose connection stays down is timed out after 15 s', async () => {
  A.page = await A.ctx.newPage();
  await A.page.goto(`${BASE}/rooms/${A.room}`);
  await A.page.getByRole('button', { name: 'Watch together' }).click();
  const dlg = A.page.getByRole('dialog');
  await dlg.getByRole('tab', { name: 'From your device' }).click();
  await dlg.locator('input[type=file]').setInputFiles({ name: 'third.webm', mimeType: 'video/webm', buffer: clip });
  await dlg.waitFor({ state: 'detached', timeout: 10_000 });
  await seesStream(B);
  await A.page.evaluate(() => window.adda.socket.disconnect());
  await B.page.getByRole('log').getByText("Asha Sen's live stream ended (their connection dropped)").waitFor({ timeout: 22_000 });
  await stage(B.page).waitFor({ state: 'detached', timeout: 3000 });
  await A.page.evaluate(() => window.adda.socket.connect());
  await A.page.getByText('Your live stream ended while you were offline.').waitFor({ timeout: 8000 });
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAIL', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
