import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// Messages during a room's video call: while the call's window covers the
// app, a message from anyone (a chat, another room, the call's own room)
// shows as a banner over it, like a phone's notification; tapping it shrinks
// the call to its bar and opens the chat. Muted chats stay quiet (the call's
// own room doesn't), and with the call shrunk the chats are in view, so no
// banners. Runs against the dev servers (npm run dev), with fake cameras.
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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.incall.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const C = await register('Chitra Pal');
const D = await register('Dipa Roy');
const ROOM = `Film night ${stamp}`;
const OTHER = `Quiz club ${stamp}`;
const room = (await call(A, 'POST', '/rooms', { name: ROOM, maxMembers: 6 })).data.room;
for (const u of [B, C]) await call(A, 'POST', `/rooms/${room.id}/members`, { userId: u.id });
const other = (await call(D, 'POST', '/rooms', { name: OTHER, maxMembers: 6 })).data.room;
await call(D, 'POST', `/rooms/${other.id}/members`, { userId: A.id });
await call(D, 'POST', `/dms/${A.id}/messages`, { body: 'Hi Asha!' });
// Asha muted the quiz club.
await call(A, 'PUT', `/rooms/${other.id}/mute`, { for: 'always' });

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function page(user, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.grantPermissions(['microphone', 'camera']);
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
const pa = await page(A, true);
const pb = await page(B);
const stage = (p) => p.getByRole('region', { name: /^Video call in/ });
const banners = (p) => p.getByLabel('New messages');
const banner = (p, text) => banners(p).getByRole('button', { name: new RegExp(text) });

try {
  await check('in a room’s video call on a phone, a chat message shows as a banner over the call', async () => {
    await pa.goto(`${BASE}/rooms/${room.id}`);
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await pa.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('region', { name: 'Voice', exact: true }).getByRole('button', { name: 'Turn camera on' }).click();
    await stage(pa).waitFor({ timeout: 15_000 });
    await call(D, 'POST', `/dms/${A.id}/messages`, { body: 'Are you coming to the quiz?' });
    await banner(pa, 'Dipa Roy: Are you coming to the quiz\\?').waitFor({ timeout: 8000 });
    await pa.waitForTimeout(400);
    await pa.screenshot({ path: `${SHOTS}in-call-1-phone-banner.png` });
    expect(await stage(pa).isVisible(), 'the call’s window closed');
  });

  await check('the call’s own room shows too, with the room’s name, even muted; another muted room doesn’t', async () => {
    await call(C, 'POST', `/rooms/${room.id}/messages`, { body: 'Can everyone see my screen?' });
    await banner(pa, `Chitra Pal in ${ROOM}: Can everyone see my screen\\?`).waitFor({ timeout: 8000 });
    await call(A, 'PUT', `/rooms/${room.id}/mute`, { for: 'always' });
    await call(C, 'POST', `/rooms/${room.id}/messages`, { body: 'Still muted for you?' });
    await banner(pa, 'Still muted for you\\?').waitFor({ timeout: 8000 });
    await call(D, 'POST', `/rooms/${other.id}/messages`, { body: 'Quiz starts at 9' });
    await sleep(1500);
    expect(!(await banner(pa, 'Quiz starts at 9').count()), 'a muted room showed a banner');
    await call(A, 'PUT', `/rooms/${room.id}/mute`, { for: 'off' });
  });

  await check('more from the same chat updates its banner with a count; each goes by itself after a few seconds', async () => {
    await banners(pa).waitFor({ state: 'detached', timeout: 10_000 });
    await call(D, 'POST', `/dms/${A.id}/messages`, { body: 'Hello?' });
    await call(D, 'POST', `/dms/${A.id}/messages`, { body: 'Hello again' });
    const b = banner(pa, 'Dipa Roy: Hello again');
    await b.waitFor({ timeout: 8000 });
    expect((await banners(pa).getByRole('button', { name: /^Dipa Roy/ }).count()) === 1, 'two banners for one chat');
    await b.getByText('2', { exact: true }).waitFor();
    await b.waitFor({ state: 'detached', timeout: 10_000 });
  });

  await check('tapping a banner shrinks the call to its bar and opens the chat; then no more banners', async () => {
    await call(D, 'POST', `/dms/${A.id}/messages`, { body: 'Call me after' });
    await banner(pa, 'Call me after').tap();
    await pa.waitForURL(`**/chats/${D.id}`);
    await stage(pa).waitFor({ state: 'detached' });
    await pa.getByRole('log').getByText('Call me after').waitFor();
    // Still in the call: the voice bar shows.
    expect(await pa.evaluate(() => window.adda.voice?.getState?.().status ?? 'live') !== 'idle', 'the call ended');
    await call(C, 'POST', `/rooms/${room.id}/messages`, { body: 'Back to the film' });
    await sleep(1500);
    expect(!(await banners(pa).count()), 'a banner with the call shrunk');
    await pa.screenshot({ path: `${SHOTS}in-call-2-opened-chat.png` });
  });

  await check('on a computer, the floating call window gets banners too', async () => {
    await stage(pb).waitFor();
    await call(C, 'POST', `/dms/${B.id}/messages`, { body: 'Bikram, the link?' });
    await banner(pb, 'Chitra Pal: Bikram, the link\\?').waitFor({ timeout: 8000 });
    await pb.screenshot({ path: `${SHOTS}in-call-3-desktop-banner.png` });
    await banners(pb).getByRole('button', { name: 'Dismiss Chitra Pal', exact: true }).click();
    await banner(pb, 'Bikram, the link').waitFor({ state: 'detached' });
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
