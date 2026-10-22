import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// A room's admins keep its voice in order: mute someone (they can't unmute,
// and nobody hears them even if their app still sent sound), or stop their
// camera in the room's video call (they can't turn it on again), until an
// admin lets them; it holds when they leave voice and come back. From
// Room info's member menu, or a person's tile in the call. Members can't;
// admins can't do it to the room's starter, and only the starter to another
// admin. Runs against the dev servers (npm run dev), with fake microphones
// and cameras.
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);

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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.mod.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const A = await register('Asha Sen'); // started the room
const B = await register('Bikram Sil');
const C = await register('Chitra Pal'); // an admin
const ROOM = `Debate club ${stamp}`;
const room = (await call(A, 'POST', '/rooms', { name: ROOM, maxMembers: 6 })).data.room;
for (const u of [B, C]) await call(A, 'POST', `/rooms/${room.id}/members`, { userId: u.id });
await call(A, 'PATCH', `/rooms/${room.id}/members/${C.id}`, { role: 'admin' });

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function page(user, phone = false) {
  const ctx = await browser.newContext({
    ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }),
    permissions: ['microphone', 'camera'],
  });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
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
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
const pa = await page(A);
const pb = await page(B, true);
const voiceOf = (p, id) => p.evaluate(([roomId, id]) => window.adda.chat.getState().voice[roomId]?.find((x) => x.userId === id) ?? null, [room.id, id]);
const mine = (p) => p.evaluate(() => ({ ...window.adda.voice.getState().moderation, muted: window.adda.voice.getState().muted, cameraOn: window.adda.voice.getState().cameraOn }));
const toasts = (p) => p.locator('[role=status], [role=alert]').allInnerTexts();
const memberMenu = async (p, name) => {
  await p.getByRole('button', { name: `Options for ${name}` }).first().click();
  return p.getByRole('menu', { name: `Options for ${name}` });
};
/** Bikram's room info (a page of its own on his phone), where the voice buttons are. */
async function bikramsVoice() {
  if (!(await pb.getByRole('region', { name: 'Voice', exact: true }).isVisible().catch(() => false))) {
    await pb.getByRole('button', { name: 'Members and voice' }).click();
  }
  return pb.getByRole('region', { name: 'Voice', exact: true });
}

try {
  await check('an admin mutes someone in voice from Room info: muted at once, and they can’t unmute', async () => {
    await pa.goto(`${BASE}/rooms/${room.id}`);
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await pa.getByRole('button', { name: 'Join voice' }).first().click();
    await (await bikramsVoice()).getByRole('button', { name: 'Join voice' }).click();
    await pa.waitForFunction(([roomId]) => window.adda.chat.getState().voice[roomId]?.length === 2, [room.id], { timeout: 15_000 });
    await (await memberMenu(pa, 'Bikram Sil')).getByRole('menuitem', { name: 'Mute Bikram in voice' }).click();
    await pb.waitForFunction(() => window.adda.voice.getState().moderation.voiceMuted && window.adda.voice.getState().muted, null, { timeout: 8000 });
    expect((await toasts(pb)).some((t) => t.includes('An admin muted you.')), 'Bikram wasn’t told');
    // His Mute button says so, and doesn't unmute.
    const voice = await bikramsVoice();
    await voice.getByRole('button', { name: 'Muted by an admin' }).click();
    await sleep(500);
    expect((await mine(pb)).muted, 'he unmuted himself');
    await voice.getByText('An admin muted you until they let you.').waitFor();
    await pb.screenshot({ path: `${SHOTS}moderation-1-muted.png` });
    // Asha's members list says so.
    await pa.getByText('Muted in voice by an admin').waitFor({ timeout: 8000 });
  });

  await check('nobody hears them, even if their app tries: the server keeps them muted, and every app mutes their sound', async () => {
    await pb.evaluate((roomId) => window.adda.socket.emit('voice:mute', { roomId, muted: false }), room.id);
    await sleep(800);
    const seen = await voiceOf(pa, B.id);
    expect(seen?.muted && seen.silenced, `the server let him unmute: ${JSON.stringify(seen)}`);
    // Asha's player for his sound is muted.
    await pa.waitForFunction(() => [...document.querySelectorAll('audio[data-call-audio]')].some((a) => a.muted), null, { timeout: 8000 });
  });

  await check('it holds after leaving voice and coming back', async () => {
    const voice = await bikramsVoice();
    await voice.getByRole('button', { name: 'Leave' }).click();
    await voice.getByRole('button', { name: 'Join voice' }).click();
    await pb.waitForFunction(() => window.adda.voice.getState().status === 'live', null, { timeout: 15_000 });
    const m = await mine(pb);
    expect(m.voiceMuted && m.muted, `back in voice, he isn’t muted: ${JSON.stringify(m)}`);
    expect((await toasts(pb)).some((t) => t.includes('An admin muted you here, until they let you.')), 'he wasn’t told on joining');
  });

  await check('let them talk again: they can unmute, and they’re heard', async () => {
    await (await memberMenu(pa, 'Bikram Sil')).getByRole('menuitem', { name: 'Let Bikram talk in voice' }).click();
    await pb.waitForFunction(() => !window.adda.voice.getState().moderation.voiceMuted, null, { timeout: 8000 });
    expect((await toasts(pb)).some((t) => t.includes('An admin let you talk again.')), 'he wasn’t told');
    await (await bikramsVoice()).getByRole('button', { name: 'Unmute' }).click();
    await pb.waitForFunction(() => !window.adda.voice.getState().muted, null, { timeout: 5000 });
    await pa.waitForFunction(([roomId, id]) => window.adda.chat.getState().voice[roomId]?.find((x) => x.userId === id)?.muted === false, [room.id, B.id], { timeout: 8000 });
    await pa.waitForFunction(() => [...document.querySelectorAll('audio[data-call-audio]')].every((a) => !a.muted), null, { timeout: 8000 });
  });

  await check('an admin stops someone’s camera from their tile in the video call; they can’t turn it on again', async () => {
    await (await bikramsVoice()).getByRole('button', { name: 'Turn camera on' }).click();
    const stage = pa.getByRole('region', { name: /^Video call in/ });
    await stage.waitFor({ timeout: 15_000 });
    await stage.locator('video[data-room-video]').first().waitFor({ timeout: 15_000 });
    await stage.getByRole('button', { name: 'Call options for Bikram Sil' }).click();
    await pa.screenshot({ path: `${SHOTS}moderation-2-tile-menu.png` });
    await pa.getByRole('menu', { name: 'Call options for Bikram Sil' }).getByRole('menuitem', { name: 'Stop Bikram’s camera' }).click();
    await pb.waitForFunction(() => window.adda.voice.getState().moderation.cameraBlocked && !window.adda.voice.getState().cameraOn, null, { timeout: 8000 });
    expect((await toasts(pb)).some((t) => t.includes('An admin stopped your camera.')), 'he wasn’t told');
    await pa.waitForFunction(([roomId, id]) => window.adda.chat.getState().voice[roomId]?.find((x) => x.userId === id)?.camera === false, [room.id, B.id], { timeout: 8000 });
    // The call's window closes for Asha (no cameras), and his app can't turn it back on.
    await stage.waitFor({ state: 'detached', timeout: 8000 });
    await pb.evaluate(() => window.adda.voice.getState().toggleCamera());
    await pb.evaluate((roomId) => window.adda.socket.emit('voice:camera', { roomId, on: true }), room.id);
    await sleep(800);
    expect(!(await mine(pb)).cameraOn, 'his camera came back on');
    expect((await voiceOf(pa, B.id))?.camera === false, 'the server let his camera back on');
    await pb.screenshot({ path: `${SHOTS}moderation-3-camera-stopped.png` });
  });

  await check('allowed again: they can turn it on', async () => {
    await (await memberMenu(pa, 'Bikram Sil')).getByRole('menuitem', { name: 'Let Bikram turn their camera on' }).click();
    await pb.waitForFunction(() => !window.adda.voice.getState().moderation.cameraBlocked, null, { timeout: 8000 });
    await (await bikramsVoice()).getByRole('button', { name: 'Turn camera on' }).click();
    await pb.waitForFunction(() => window.adda.voice.getState().cameraOn, null, { timeout: 10_000 });
    await pa.getByRole('region', { name: /^Video call in/ }).waitFor({ timeout: 15_000 });
  });

  await check('the room’s call starts each picture sharp: video is asked to start at 1.2 Mbps, and a large view gets 720p at 2 Mbps', async () => {
    const sdp = await pa.evaluate(() => window.__pcs.filter((pc) => pc.connectionState === 'connected').map((pc) => pc.remoteDescription?.sdp ?? ''));
    expect(sdp.length && sdp.every((s) => s.includes('x-google-start-bitrate=1200')), 'the start bitrate hint is missing');
    // Asha shows Bikram large: his camera goes to her at full size, within its most.
    await pb.waitForFunction(
      () =>
        window.__pcs
          .filter((pc) => pc.connectionState === 'connected')
          .some((pc) => {
            const e = pc.getSenders().find((s) => s.track?.kind === 'video')?.getParameters().encodings?.[0];
            return e && e.maxBitrate >= 1_000_000 && e.maxBitrate <= 2_000_000;
          }),
      null,
      { timeout: 10_000 },
    );
  });

  await check('who can: not members; admins can’t do it to the room’s starter; only the starter to another admin', async () => {
    const mod = (by, who, change) => call(by, 'PUT', `/rooms/${room.id}/members/${who.id}/voice`, change);
    expect((await mod(B, C, { voiceMuted: true })).status === 403, 'a member muted an admin');
    expect((await mod(B, A, { cameraBlocked: true })).status === 403, 'a member stopped the starter’s camera');
    expect((await mod(C, A, { voiceMuted: true })).status === 403, 'an admin muted the room’s starter');
    expect((await mod(C, B, { voiceMuted: true })).status === 200, 'an admin couldn’t mute a member');
    expect((await mod(C, B, { voiceMuted: false })).status === 200, 'an admin couldn’t let a member talk');
    expect((await mod(A, C, { cameraBlocked: true })).status === 200, 'the starter couldn’t stop an admin’s camera');
    expect((await mod(A, C, { cameraBlocked: false })).status === 200, 'the starter couldn’t let an admin’s camera back');
    expect((await mod(A, A, { voiceMuted: true })).status === 400, 'muted themselves');
    expect((await mod(A, B, {})).status === 400, 'an empty change was taken');
    const outsider = await register('Dipa Roy');
    expect((await mod(A, outsider, { voiceMuted: true })).status === 404, 'muted someone not in the room');
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
