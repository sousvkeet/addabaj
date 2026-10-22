import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

// A room's chat history, cleared by its admins (Room settings › Chat
// history): messages older than a chosen time go by themselves, for
// everyone; or the whole history, at once, with its files. Members see the
// schedule in Room info, and a notice in the chat says who changed what. An
// app that was offline drops what it kept when it's back. Runs against the
// dev servers (npm run dev); the schedule's check waits about a minute and a half.
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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.hist.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
/** A photo in the room, from `user`: its attachment. */
async function sendPhoto(user, roomId) {
  const up = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: {
      cookie: user.cookie,
      'content-type': 'application/octet-stream',
      'x-upload-meta': encodeURIComponent(JSON.stringify({ kind: 'image', name: 'beach.jpg', mime: 'image/jpeg', width: 640, height: 480 })),
    },
    body: readFileSync(new URL('./fixtures/photo.jpg', import.meta.url)),
  });
  const { attachment, error } = await up.json();
  if (up.status !== 201) throw new Error(`upload: ${up.status} ${error}`);
  // Files go the way the app sends them: over its live connection.
  const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: user.cookie } });
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  const sent = await s.timeout(8000).emitWithAck('room:send', { roomId, body: 'At the beach', attachmentId: attachment.id });
  s.disconnect();
  if (!sent.ok) throw new Error(`photo: ${JSON.stringify(sent)}`);
  return attachment;
}

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const C = await register('Chitra Pal');
const ROOM = `Weekend plans ${stamp}`;
const room = (await call(A, 'POST', '/rooms', { name: ROOM, maxMembers: 6 })).data.room;
for (const u of [B, C]) await call(A, 'POST', `/rooms/${room.id}/members`, { userId: u.id });

const browser = await chromium.launch();
async function page(user, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
const pa = await page(A);
const pb = await page(B);
const pc = await page(C, true);
const log = (p) => p.getByRole('log');
const settings = (p) => p.getByRole('dialog', { name: 'Room settings' });
const messagesFor = async (user) => (await call(user, 'GET', `/rooms/${room.id}/messages`)).data.messages.map((m) => m.body);

async function openSettings(p) {
  await p.goto(`${BASE}/rooms/${room.id}`);
  // Phones open Room info; on a computer it's beside the chat.
  const info = p.getByRole('button', { name: 'Members and voice' });
  if (await info.isVisible().catch(() => false)) await info.click();
  await p.getByRole('button', { name: 'Room settings' }).click();
  await settings(p).waitFor();
}

try {
  await check('only the room’s admins can set it or clear it; Room settings has it for them', async () => {
    expect((await call(B, 'PUT', `/rooms/${room.id}/history`, { clearAfter: { amount: 1, unit: 'day' } })).status === 403, 'a member set the schedule');
    expect((await call(B, 'POST', `/rooms/${room.id}/history/clear`)).status === 403, 'a member cleared the history');
    const outsider = await register('Dipa Roy');
    expect((await call(outsider, 'POST', `/rooms/${room.id}/history/clear`)).status === 404, 'an outsider cleared the history');
    await openSettings(pa);
    await settings(pa).getByRole('radiogroup', { name: 'Clear messages after' }).waitFor();
    await settings(pa).getByRole('button', { name: 'Clear chat history' }).waitFor();
    await settings(pa).getByText('Now: messages are kept.').waitFor();
  });

  await check('on a schedule (1 minute): older messages go by themselves for everyone, live; newer ones stay', async () => {
    await call(A, 'POST', `/rooms/${room.id}/messages`, { body: 'Old news' });
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await log(pb).getByText('Old news').waitFor();
    // Custom: 1 minute.
    await settings(pa).getByRole('radio', { name: 'Custom' }).click();
    await settings(pa).getByLabel('How many').fill('1');
    await settings(pa).getByLabel('Minutes, hours, days or months').selectOption('minute');
    await settings(pa).getByText('After you apply this, messages older than 1 minute go, starting now.').waitFor();
    await pa.screenshot({ path: `${SHOTS}history-1-settings.png` });
    await settings(pa).getByRole('button', { name: 'Apply' }).click();
    await settings(pa).getByText('Now: messages older than 1 minute clear by themselves.').waitFor({ timeout: 8000 });
    await log(pb).getByText('Asha Sen set messages to clear after 1 minute').waitFor({ timeout: 8000 });
    // Bikram sees it in Room info too.
    await pb.getByText('Messages clear after 1 minute').waitFor({ timeout: 8000 });
    await pb.screenshot({ path: `${SHOTS}history-2-room-info.png` });
    await sleep(30_000);
    await call(B, 'POST', `/rooms/${room.id}/messages`, { body: 'Fresh' });
    // "Old news" is a minute old about now; the server checks every 20 seconds.
    await log(pb).getByText('Old news').waitFor({ state: 'detached', timeout: 60_000 });
    expect(await log(pb).getByText('Fresh').isVisible(), 'a newer message went too');
    expect(!(await messagesFor(C)).includes('Old news'), 'the server still has it');
    expect((await messagesFor(C)).includes('Fresh'), 'the server lost a newer one');
  });

  await check('turned off: messages are kept again (and members are told)', async () => {
    await settings(pa).getByRole('radio', { name: 'Off' }).click();
    await settings(pa).getByRole('button', { name: 'Apply' }).click();
    await settings(pa).getByText('Now: messages are kept.').waitFor({ timeout: 8000 });
    await log(pb).getByText('Asha Sen turned off clearing messages').waitFor({ timeout: 8000 });
    await pb.getByText('Messages clear after 1 minute').waitFor({ state: 'detached', timeout: 8000 });
  });

  let photo;
  await check('cleared at once: every message and file goes for everyone, live, and a notice says who', async () => {
    await call(B, 'POST', `/rooms/${room.id}/messages`, { body: 'See you Saturday' });
    photo = await sendPhoto(C, room.id);
    expect((await fetch(API + photo.url, { headers: { cookie: B.cookie } })).status === 200, 'the photo isn’t there to begin with');
    await log(pb).getByText('See you Saturday').waitFor();
    await pc.goto(`${BASE}/rooms`);
    await pc.getByText('At the beach', { exact: false }).first().waitFor({ timeout: 8000 });
    await settings(pa).getByRole('button', { name: 'Clear chat history' }).click();
    await settings(pa).getByText(`Clear all of ${ROOM}’s messages for everyone?`).waitFor();
    await pa.screenshot({ path: `${SHOTS}history-3-confirm.png` });
    await settings(pa).getByRole('button', { name: 'Clear history' }).click();
    await log(pb).getByText('See you Saturday').waitFor({ state: 'detached', timeout: 8000 });
    await log(pb).getByText('Asha Sen cleared the chat history').waitFor({ timeout: 8000 });
    expect(!(await log(pb).getByText('Fresh').count()), 'an older message stayed');
    // Chitra's room list shows the notice, not the photo.
    await pc.getByText('Asha Sen cleared the chat history', { exact: false }).first().waitFor({ timeout: 8000 });
    expect(JSON.stringify(await messagesFor(C)) === JSON.stringify(['Asha Sen cleared the chat history']), `the server has ${JSON.stringify(await messagesFor(C))}`);
    expect((await fetch(API + photo.url, { headers: { cookie: B.cookie } })).status === 404, 'the photo’s file is still there');
    await pb.screenshot({ path: `${SHOTS}history-4-cleared.png` });
  });

  await check('an app that was offline then drops what it kept, once it’s back', async () => {
    await call(A, 'POST', `/rooms/${room.id}/messages`, { body: 'Kept while offline' });
    await log(pb).getByText('Kept while offline').waitFor({ timeout: 8000 });
    await pb.context().setOffline(true);
    await sleep(1500);
    expect((await call(A, 'POST', `/rooms/${room.id}/history/clear`)).status === 200, 'clear');
    await pb.context().setOffline(false);
    await log(pb).getByText('Kept while offline').waitFor({ state: 'detached', timeout: 25_000 });
  });

  await check('only real choices: 1 to 1440 minutes, 720 hours, 365 days or 12 months', async () => {
    const set = (clearAfter) => call(A, 'PUT', `/rooms/${room.id}/history`, { clearAfter });
    expect((await set({ amount: 0, unit: 'day' })).status === 400, '0 days');
    expect((await set({ amount: 2000, unit: 'minute' })).status === 400, '2000 minutes');
    expect((await set({ amount: 13, unit: 'month' })).status === 400, '13 months');
    expect((await set({ amount: 1, unit: 'week' })).status === 400, 'weeks');
    const ok = await set({ amount: 12, unit: 'month' });
    expect(ok.status === 200 && ok.data.room.clearAfter?.amount === 12 && ok.data.room.clearAfter.unit === 'month', `12 months: ${JSON.stringify(ok.data?.room?.clearAfter)}`);
    expect((await set(null)).data.room.clearAfter === null, 'off');
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
