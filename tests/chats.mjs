import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// My own settings for chats and rooms: mute (the chat's count goes grey and
// leaves the app's count), pin (to the top of the list), archive (out of the
// list, under Archived, staying there when new messages come). From a row's ⋮
// on a computer, by pressing and holding it on a phone, from a chat's menu, or
// from Room info; they follow to my other devices at once. Runs against the
// dev servers (npm run dev). Who gets a push for what is checked in test:push.
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
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}
async function register(name) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}.chats.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
const say = (from, to, body) => call(from, 'POST', `/dms/${to.id}/messages`, { body });

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const C = await register('Chitra Pal');
const D = await register('Dipa Roy');
// Asha's chats, newest last: Bikram, Chitra, Dipa.
for (const u of [B, C, D]) {
  await say(u, A, `Hello from ${u.name.split(' ')[0]}`);
  await sleep(30);
}
await call(A, 'POST', `/dms/${B.id}/read`);
await call(A, 'POST', `/dms/${C.id}/read`);
await call(A, 'POST', `/dms/${D.id}/read`);
const ROOM_A = `Tea club ${stamp}`;
const ROOM_B = `Book club ${stamp}`;
const roomA = (await call(A, 'POST', '/rooms', { name: ROOM_A, maxMembers: 6 })).data.room;
const roomB = (await call(A, 'POST', '/rooms', { name: ROOM_B, maxMembers: 6 })).data.room;

const browser = await chromium.launch();
async function page(user, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
/** The names down the list, in order. */
const names = (p) => p.locator('ul li.group a').evaluateAll((as) => as.map((a) => a.querySelector('span.truncate.font-semibold')?.textContent));
const row = (p, name) => p.locator('li.group').filter({ has: p.getByRole('link', { name: new RegExp(name) }) });
async function rowMenu(p, name, item) {
  const r = row(p, name);
  await r.hover();
  await r.getByRole('button', { name: `Options for ${name}` }).click();
  await p.getByRole('menuitem', { name: item }).click();
}

const pa = await page(A);
const phone = await page(A, true);

try {
  await check('pinning a chat from its ⋮ puts it at the top, with a pin, on my phone too', async () => {
    await pa.goto(`${BASE}/chats`);
    await phone.goto(`${BASE}/chats`);
    await row(pa, 'Dipa Roy').waitFor();
    expect((await names(pa))[0] === 'Dipa Roy', `order: ${await names(pa)}`);
    await rowMenu(pa, 'Bikram Sil', 'Pin chat');
    await row(pa, 'Bikram Sil').getByRole('img', { name: 'Pinned' }).waitFor();
    expect((await names(pa))[0] === 'Bikram Sil', `order after pinning: ${await names(pa)}`);
    // A new message elsewhere doesn't move it down.
    await say(C, A, 'Anyone around?');
    await row(pa, 'Chitra Pal').getByText('Anyone around?').waitFor({ timeout: 8000 });
    const order = await names(pa);
    expect(order[0] === 'Bikram Sil' && order[1] === 'Chitra Pal', `order: ${order}`);
    // The phone was told at once.
    await row(phone, 'Bikram Sil').getByRole('img', { name: 'Pinned' }).waitFor({ timeout: 5000 });
    expect((await names(phone))[0] === 'Bikram Sil', `phone order: ${await names(phone)}`);
    await pa.screenshot({ path: `${SHOTS}chats-1-pinned.png` });
  });

  await check('muting a chat: crossed-out bell, a grey count, and the app’s count leaves it out', async () => {
    await pa.goto(`${BASE}/rooms`);
    await pa.goto(`${BASE}/chats`);
    await rowMenu(pa, 'Chitra Pal', 'Mute notifications');
    const dlg = pa.getByRole('dialog', { name: 'Mute Chitra Pal?' });
    await dlg.getByRole('button', { name: '8 hours' }).click();
    await row(pa, 'Chitra Pal').getByRole('img', { name: 'Muted' }).waitFor();
    // Asha is on the chat list (not in the chat): new messages count as unread.
    await say(C, A, 'Muted message one');
    await say(C, A, 'Muted message two');
    await row(pa, 'Chitra Pal').getByText('Muted message two').waitFor({ timeout: 8000 });
    await pa.screenshot({ path: `${SHOTS}chats-2-muted.png` });
    expect((await pa.title()) === 'Adda Khana', `title counts the muted chat: ${await pa.title()}`);
    const badge = row(pa, 'Chitra Pal').getByText('3', { exact: true });
    await badge.waitFor();
    expect(/bg-ink-soft/.test((await badge.getAttribute('class')) ?? ''), 'the count isn’t grey');
    await say(B, A, 'Not muted');
    await pa.waitForFunction(() => document.title === '(1) Adda Khana', null, { timeout: 8000 });
    await phone.goto(`${BASE}/chats`);
    await row(phone, 'Chitra Pal').getByRole('img', { name: 'Muted' }).waitFor();
    await pa.screenshot({ path: `${SHOTS}chats-2-muted.png` });
  });

  await check('a muted chat says so in its header, and unmutes from its menu', async () => {
    await pa.goto(`${BASE}/chats/${C.id}`);
    await pa.getByRole('img', { name: 'Notifications muted' }).waitFor();
    await pa.getByRole('button', { name: 'Chat options' }).click();
    await pa.getByRole('menuitem', { name: 'Unmute notifications' }).click();
    await pa.getByRole('img', { name: 'Notifications muted' }).waitFor({ state: 'detached', timeout: 5000 });
  });

  await check('archiving a chat moves it under Archived, where it stays when new messages come', async () => {
    await pa.goto(`${BASE}/chats`);
    await rowMenu(pa, 'Dipa Roy', 'Archive chat');
    await pa.getByText('Chat archived').waitFor();
    await row(pa, 'Dipa Roy').waitFor({ state: 'detached' });
    const archived = pa.getByRole('button', { name: /^Archived/ });
    await archived.waitFor();
    await say(D, A, 'Still there?');
    await sleep(1500);
    expect(!(await row(pa, 'Dipa Roy').count()), 'a new message brought it back out');
    await archived.getByText(/with new messages/).waitFor({ timeout: 5000 });
    await pa.screenshot({ path: `${SHOTS}chats-3-archived-row.png` });
    await archived.click();
    await pa.getByText('Archived chats').waitFor();
    await row(pa, 'Dipa Roy').getByText('Still there?').waitFor();
    expect((await names(pa)).length === 1, `archived list: ${await names(pa)}`);
    await pa.screenshot({ path: `${SHOTS}chats-4-archive.png` });
    // Searching finds archived chats too.
    await pa.getByRole('button', { name: 'Back to all chats' }).click();
    await pa.getByLabel('Search chats').fill('dipa');
    await row(pa, 'Dipa Roy').waitFor();
    await pa.getByLabel('Search chats').fill('');
  });

  await check('on a phone, press and hold a chat for its menu: Unarchive brings it back (the chat doesn’t open)', async () => {
    await phone.goto(`${BASE}/chats`);
    await phone.getByRole('button', { name: /^Archived/ }).click();
    const r = await phone.getByRole('link', { name: /Dipa Roy/ }).boundingBox();
    const cdp = await phone.context().newCDPSession(phone);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + 120, y: r.y + 20 }] });
    await sleep(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const sheet = phone.getByRole('dialog', { name: 'Options for Dipa Roy' });
    await sheet.waitFor();
    expect(new URL(phone.url()).pathname === '/chats', `holding opened ${phone.url()}`);
    await phone.screenshot({ path: `${SHOTS}chats-5-phone-sheet.png` });
    await sheet.getByRole('button', { name: 'Unarchive chat' }).click();
    // The last archived one back: the list again.
    await phone.getByRole('link', { name: /Dipa Roy/ }).waitFor();
    await phone.getByRole('button', { name: /^Archived/ }).waitFor({ state: 'detached', timeout: 5000 });
    await row(pa, 'Dipa Roy').waitFor({ timeout: 5000 });
  });

  await check('pins have a limit: a sixth chat is refused with a reason', async () => {
    const more = [];
    for (let i = 0; i < 5; i++) more.push(await register(`Extra Friend${i}`));
    for (const u of more) await say(u, A, 'hi');
    for (const u of more.slice(0, 4)) expect((await call(A, 'PUT', `/dms/${u.id}/settings`, { pinned: true })).status === 200, 'pin');
    await pa.reload();
    await rowMenu(pa, 'Extra Friend4', 'Pin chat');
    await pa.getByText('You can pin up to 5 chats. Unpin one first.').waitFor({ timeout: 5000 });
    expect(!(await row(pa, 'Extra Friend4').getByRole('img', { name: 'Pinned' }).count()), 'pinned anyway');
  });

  await check('rooms: pin and archive from Room info, and the room list follows', async () => {
    await pa.goto(`${BASE}/rooms/${roomA.id}`);
    const info = pa.locator('section[aria-labelledby="notifications-heading"]');
    await info.getByRole('button', { name: 'Pin room' }).click();
    await info.getByRole('button', { name: 'Unpin room' }).waitFor();
    await call(A, 'POST', `/rooms/${roomB.id}/messages`, { body: 'Newer message' });
    await pa.goto(`${BASE}/rooms`);
    await row(pa, ROOM_A).getByRole('img', { name: 'Pinned' }).waitFor();
    expect((await names(pa))[0] === ROOM_A, `room order: ${await names(pa)}`);
    await pa.goto(`${BASE}/rooms/${roomB.id}`);
    await info.getByRole('button', { name: 'Archive room' }).click();
    await info.getByRole('button', { name: 'Unarchive room' }).waitFor();
    await pa.goto(`${BASE}/rooms`);
    await pa.getByRole('button', { name: /^Archived/ }).click();
    await row(pa, ROOM_B).waitFor();
    await rowMenu(pa, ROOM_B, 'Unarchive room');
    await row(pa, ROOM_B).waitFor();
    await pa.getByRole('button', { name: /^Archived/ }).waitFor({ state: 'detached', timeout: 5000 });
  });

  await check('a room muted from its row’s ⋮ shows the bell, like one muted from Room info', async () => {
    await rowMenu(pa, ROOM_B, 'Mute notifications');
    await pa.getByRole('dialog', { name: `Mute ${ROOM_B}?` }).getByRole('button', { name: 'Always' }).click();
    await row(pa, ROOM_B).getByRole('img', { name: 'Muted' }).waitFor();
    await rowMenu(pa, ROOM_B, 'Unmute notifications');
    await row(pa, ROOM_B).getByRole('img', { name: 'Muted' }).waitFor({ state: 'detached', timeout: 5000 });
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
