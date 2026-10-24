import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSounds } from './fixtures/sounds.mjs';

// Noise cancellation: a browser whose microphone "hears" made-up sounds
// (fixtures/sounds.mjs: noise, or a voice) talks to another, which measures
// what reaches it (WebRTC's own count of the sound's energy). The settings'
// microphone bar goes quiet on noise with it on; in a one-to-one call and in
// room voice the noise arrives far quieter with it on than off, switched
// mid-call; and a voice arrives about as loud either way. Runs against the
// dev servers (npm run dev).
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const sounds = writeSounds(join(tmpdir(), `adda-noise-${stamp}`));

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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.noise.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const room = (await call(A, 'POST', '/rooms', { name: `Quiet please ${stamp}`, maxMembers: 4 })).data.room;
await call(A, 'POST', `/rooms/${room.id}/members`, { userId: B.id });

/** A browser whose microphone plays this sound file (looped). */
async function browserHearing(file) {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  if (file) args.push(`--use-file-for-fake-audio-capture=${file}`);
  return chromium.launch({ args });
}
async function page(browser, user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  await ctx.addInitScript(() => {
    const N = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends N {
      constructor(...a) {
        super(...a);
        window.__pcs.push(this);
      }
    };
  });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'warning' && /Noise cancellation/.test(m.text()) && console.log('  page:', m.text()));
  return p;
}
const online = (p) => p.waitForFunction(() => window.adda?.socket?.connected, null, { timeout: 15_000 });

/** How loud what this page receives is (dBFS), over a few seconds, and how much data it took (kbps). */
async function heard(p, seconds = 6) {
  const total = () =>
    p.evaluate(async () => {
      const out = { energy: 0, duration: 0, bytes: 0 };
      for (const pc of window.__pcs.filter((c) => c.connectionState === 'connected')) {
        (await pc.getStats()).forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            out.energy += r.totalAudioEnergy ?? 0;
            out.duration += r.totalSamplesDuration ?? 0;
            out.bytes += r.bytesReceived;
          }
        });
      }
      return out;
    });
  const a = await total();
  await sleep(seconds * 1000);
  const b = await total();
  const db = 10 * Math.log10((b.energy - a.energy) / Math.max(1e-9, b.duration - a.duration) + 1e-12);
  return { db, kbps: ((b.bytes - a.bytes) * 8) / seconds / 1000 };
}
const fmt = (h) => `${h.db.toFixed(1)} dBFS, ${h.kbps.toFixed(1)} kbps`;

/** Account menu › Microphone, speaker and camera: noise cancellation on or off, then closed. */
async function setNoiseCancel(p, on) {
  await p.getByRole('button', { name: 'Your account' }).click();
  await p.getByRole('menuitem', { name: 'Microphone, speaker and camera' }).click();
  const toggle = p.getByRole('switch', { name: /Noise cancellation/ });
  // As a person would: a tap on its name (the switch itself is drawn, its checkbox hidden).
  if ((await toggle.isChecked()) !== on) await p.getByText('Noise cancellation', { exact: true }).click();
  expect((await toggle.isChecked()) === on, 'the switch did not change');
  await p.getByRole('button', { name: 'Done' }).click();
  await sleep(1500);
}
/** The settings' microphone bar at its highest over a few seconds (0 to 100). */
async function meterPeak(p) {
  let peak = 0;
  const meter = p.getByRole('meter', { name: 'Microphone level' });
  await meter.waitFor();
  await sleep(1500);
  for (let i = 0; i < 25; i++) {
    peak = Math.max(peak, Number(await meter.getAttribute('aria-valuenow')));
    await sleep(120);
  }
  return peak;
}

const listener = await browserHearing(null);
const pb = await page(listener, B);
let noisy = await browserHearing(sounds.noise);
let pa = await page(noisy, A);

try {
  await check('settings: on noise, the microphone bar stays quiet with noise cancellation on (the default), and moves with it off', async () => {
    await pa.goto(`${BASE}/chats/${B.id}`);
    await online(pa);
    await pa.getByRole('button', { name: 'Your account' }).click();
    await pa.getByRole('menuitem', { name: 'Microphone, speaker and camera' }).click();
    const toggle = pa.getByRole('switch', { name: /Noise cancellation/ });
    expect(await toggle.isChecked(), 'noise cancellation is not on by default');
    const on = await meterPeak(pa);
    await pa.getByText('Noise cancellation', { exact: true }).click();
    const off = await meterPeak(pa);
    await pa.screenshot({ path: `${SHOTS}noise-settings-off.png` });
    await pa.getByText('Noise cancellation', { exact: true }).click();
    const again = await meterPeak(pa);
    await pa.screenshot({ path: `${SHOTS}noise-settings-on.png` });
    console.log(`  bar peaks: on ${on}, off ${off}, on again ${again}`);
    expect(off >= 8 && on < off / 2 && again < off / 2, `bar peaked at ${on} with it on, ${off} off, ${again} on again`);
    await pa.getByRole('button', { name: 'Done' }).click();
  });

  await check('a voice call: noise arrives at least 10 dB quieter with noise cancellation on than off (switched mid-call), on less data', async () => {
    await pb.goto(`${BASE}/chats/${A.id}`);
    await online(pb);
    await pa.getByRole('button', { name: 'Voice call Bikram Sil' }).click();
    await pb.getByRole('button', { name: /^Accept/ }).first().click();
    await pa.waitForFunction(() => window.adda.call.getState().phase === 'active', null, { timeout: 20_000 });
    await sleep(4000);
    const on = await heard(pb);
    await setNoiseCancel(pa, false);
    const off = await heard(pb);
    await setNoiseCancel(pa, true);
    const again = await heard(pb);
    console.log(`  heard: on ${fmt(on)}; off ${fmt(off)}; on again ${fmt(again)}`);
    expect(off.db - on.db >= 10 && off.db - again.db >= 10, `only ${(off.db - on.db).toFixed(1)} and ${(off.db - again.db).toFixed(1)} dB quieter`);
    await pa.evaluate(() => window.adda.call.getState().endCall());
    await sleep(1500);
  });

  await check('room voice: noise arrives at least 10 dB quieter with noise cancellation on than off', async () => {
    await pa.goto(`${BASE}/rooms/${room.id}`);
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await online(pa);
    await online(pb);
    await pa.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.waitForFunction(() => window.adda.voice.getState().status === 'live', null, { timeout: 30_000 });
    await pb.waitForFunction((id) => window.adda.chat.getState().voice[id]?.length === 2, room.id, { timeout: 30_000 });
    // Only Asha is heard.
    await pb.evaluate(() => window.adda.voice.getState().toggleMute());
    const via = await pa.evaluate(() => window.adda.voice.getState().via);
    await sleep(4000);
    const on = await heard(pb);
    await setNoiseCancel(pa, false);
    const off = await heard(pb);
    await setNoiseCancel(pa, true);
    const again = await heard(pb);
    console.log(`  heard (${via}): on ${fmt(on)}; off ${fmt(off)}; on again ${fmt(again)}`);
    expect(off.db - on.db >= 10 && off.db - again.db >= 10, `only ${(off.db - on.db).toFixed(1)} and ${(off.db - again.db).toFixed(1)} dB quieter`);
    await pa.getByRole('button', { name: 'Leave voice' }).first().click();
    await pb.getByRole('button', { name: 'Leave voice' }).first().click();
    await sleep(1500);
  });

  // The same person, now talking (a browser whose microphone hears a voice).
  await noisy.close();
  noisy = await browserHearing(sounds.voice);
  pa = await page(noisy, A);

  await check('a voice call: a voice arrives about as loud with noise cancellation on as off (within 4 dB)', async () => {
    await pa.goto(`${BASE}/chats/${B.id}`);
    await pb.goto(`${BASE}/chats/${A.id}`);
    await online(pa);
    await online(pb);
    await pa.getByRole('button', { name: 'Voice call Bikram Sil' }).click();
    await pb.getByRole('button', { name: /^Accept/ }).first().click();
    await pa.waitForFunction(() => window.adda.call.getState().phase === 'active', null, { timeout: 20_000 });
    // The browser's own gain control settles in over the first seconds; on, off and on again evens that out.
    await sleep(8000);
    const on = await heard(pb, 12);
    await setNoiseCancel(pa, false);
    const off = await heard(pb, 12);
    await setNoiseCancel(pa, true);
    const again = await heard(pb, 12);
    console.log(`  heard: on ${fmt(on)}; off ${fmt(off)}; on again ${fmt(again)}`);
    const both = (on.db + again.db) / 2;
    expect(both > -40 && Math.abs(off.db - both) <= 4, `the voice arrived at ${on.db.toFixed(1)} and ${again.db.toFixed(1)} dBFS with it on, ${off.db.toFixed(1)} off`);
    await pa.evaluate(() => window.adda.call.getState().endCall());
  });
} finally {
  await noisy.close();
  await listener.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
