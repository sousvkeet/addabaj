import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// Profile photos: choosing and fitting one in the app, the server checking and
// cleaning it, and everyone who can see the person seeing it (live), in chats,
// rooms, people lookups and the host's admin pages. Runs against the dev
// servers (npm run dev); the host admin must have the default password
// (npm run admin:reset).
const root = new URL('..', import.meta.url).pathname;
const clientEnv = `${root}client/.env`;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const PHOTOS = process.env.PHOTO_DIR ?? `${root}server/data/photos`;
const PICTURE = readFileSync(new URL('./fixtures/photo.jpg', import.meta.url));
const APP_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 AddaKhanaApp/1.5.0';
const stamp = Date.now().toString(36);

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(['PASS', label]);
    console.log('PASS', label);
  } catch (err) {
    results.push(['FAIL', label, err.message]);
    console.log('FAIL', label, '-', err.message.split('\n').slice(0, 3).join(' | '));
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(cookie, method, path, body, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': raw ? 'image/jpeg' : 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data, headers: res.headers };
}
async function register(name) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.toLowerCase()}.photo.${stamp}@example.com`, password: 'password123' }),
  });
  const { user } = await res.json();
  return { name, cookie: res.headers.get('set-cookie').split(';')[0], id: user.id, handle: user.handle };
}
const connect = (u) =>
  new Promise((resolve) => {
    const s = io(API, { transports: ['websocket'], extraHeaders: { cookie: u.cookie } });
    s.on('connect', () => resolve(s));
  });
const emit = (s, event, data) => new Promise((r) => s.emit(event, data, r));
const setPhoto = (u, body = PICTURE) => call(u.cookie, 'PUT', '/auth/photo', body);
const filesOf = (u) => readdirSync(PHOTOS).filter((f) => f.startsWith(u.id));
/** A JPEG's width and height, from its frame header. */
function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length; ) {
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const host = await (async () => {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin', password: 'admin' }) });
  return { cookie: res.headers.get('set-cookie').split(';')[0] };
})();
const ana = await register('Ana');
const bo = await register('Bo');
const cy = await register('Cy');
const stranger = await register('Zed');
const [sAna, sBo] = await Promise.all([connect(ana), connect(bo)]);
await emit(sBo, 'dm:send', { to: ana.id, body: 'Hi Ana' });
const room = (await call(ana.cookie, 'POST', '/rooms', { name: `Photo room ${stamp}`, description: '', maxMembers: 5 })).data.room;
await call(ana.cookie, 'POST', `/rooms/${room.id}/members`, { userId: cy.id });
await emit(sAna, 'room:send', { roomId: room.id, body: 'Hello room' });

let anaPhoto;

await check('A photo is checked and cleaned: camera details and anything hidden after the picture are dropped', async () => {
  const body = Buffer.from('Exif\0\0GPS 22.57N 88.36E');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  const withExtras = Buffer.concat([PICTURE.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, PICTURE.subarray(2), Buffer.from('<script>alert(1)</script>')]);
  const r = await setPhoto(ana, withExtras);
  anaPhoto = r.data?.user?.photo;
  expect(r.status === 200 && /^\/api\/users\/[0-9a-f-]+\/photo\/[0-9a-f]{16}$/.test(anaPhoto ?? ''), `upload: ${r.status} ${JSON.stringify(r.data)}`);
  const kept = readFileSync(`${PHOTOS}/${filesOf(ana)[0]}`);
  expect(!kept.includes('Exif') && !kept.includes('GPS') && !kept.includes('<script>'), 'extras kept');
  expect(kept[kept.length - 2] === 0xff && kept[kept.length - 1] === 0xd9, 'does not end at the picture');
  const seen = await fetch(API + anaPhoto, { headers: { cookie: stranger.cookie } });
  expect(seen.status === 200 && seen.headers.get('content-type') === 'image/jpeg' && seen.headers.get('x-content-type-options') === 'nosniff', `view: ${seen.status}`);
  expect(/immutable/.test(seen.headers.get('cache-control') ?? ''), 'not cached for good');
  expect((await fetch(API + anaPhoto)).status === 401, 'signed out could see it');
});

await check('Not photos are refused: PNG, SVG, junk, too small, too big; and nobody signed out can set one', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  expect((await setPhoto(bo, png)).status === 400, 'png');
  expect((await setPhoto(bo, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status === 400, 'svg');
  expect((await setPhoto(bo, Buffer.from('not a picture at all'))).status === 400, 'junk');
  const tiny = Buffer.from(PICTURE);
  for (let i = 2; i + 9 < tiny.length; ) {
    const m = tiny[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      tiny.writeUInt16BE(32, i + 5);
      tiny.writeUInt16BE(32, i + 7);
      break;
    }
    i += 2 + tiny.readUInt16BE(i + 2);
  }
  const small = await setPhoto(bo, tiny);
  expect(small.status === 400 && /too small/.test(small.data.error), `tiny: ${JSON.stringify(small.data)}`);
  const big = await setPhoto(bo, Buffer.concat([PICTURE, Buffer.alloc(3 * 1024 * 1024)]));
  expect(big.status === 413 && /too big/.test(big.data.error), `big: ${big.status} ${JSON.stringify(big.data)}`);
  expect((await call(null, 'PUT', '/auth/photo', PICTURE)).status === 401, 'signed out');
  expect(!filesOf(bo).length, 'a refused photo was kept');
  expect((await call(bo.cookie, 'GET', '/auth/me')).data.user.photo === null, 'Bo has a photo');
});

await check('The photo shows wherever Ana appears: chat lists, rooms, messages, lookups and the admin pages', async () => {
  const dms = (await call(bo.cookie, 'GET', '/dms')).data.conversations;
  expect(dms.find((c) => c.partner.id === ana.id)?.partner.photo === anaPhoto, 'chat list');
  const detail = (await call(cy.cookie, 'GET', `/rooms/${room.id}`)).data.room;
  expect(detail.members.find((m) => m.id === ana.id)?.photo === anaPhoto, 'room members');
  const msgs = (await call(cy.cookie, 'GET', `/rooms/${room.id}/messages`)).data.messages;
  expect(msgs.find((m) => m.body === 'Hello room')?.sender.photo === anaPhoto, 'room message sender');
  expect((await call(stranger.cookie, 'GET', `/users/find?q=${encodeURIComponent(ana.handle)}`)).data.user?.photo === anaPhoto, 'lookup by user ID');
  expect((await call(stranger.cookie, 'GET', `/users/${ana.id}`)).data.user.photo === anaPhoto, 'profile');
  expect((await call(ana.cookie, 'GET', '/auth/me')).data.user.photo === anaPhoto, 'own account');
  const people = (await call(host.cookie, 'GET', `/admin/users?q=${encodeURIComponent(`ana.photo.${stamp}`)}`)).data.items;
  expect(people[0]?.photo === anaPhoto, `admin people: ${JSON.stringify(people)}`);
  // Sent by her open connection after the change: it carries the photo too.
  await emit(sAna, 'room:send', { roomId: room.id, body: 'After the photo' });
  const later = (await call(cy.cookie, 'GET', `/rooms/${room.id}/messages`)).data.messages;
  expect(later.find((m) => m.body === 'After the photo')?.sender.photo === anaPhoto, 'a new message');
});

await check('Contacts see a new photo at once; a replaced photo is gone for good', async () => {
  const told = new Promise((resolve) => sBo.on('user:updated', (e) => e.user.id === ana.id && resolve(e.user)));
  const before = anaPhoto;
  const other = Buffer.from(PICTURE);
  other[other.length - 3] ^= 0x01; // a slightly different picture: a new version
  const r = await setPhoto(ana, other);
  anaPhoto = r.data.user.photo;
  expect(anaPhoto && anaPhoto !== before, 'same version');
  const live = await Promise.race([told, sleep(4000).then(() => null)]);
  expect(live?.photo === anaPhoto, `live: ${JSON.stringify(live)}`);
  expect((await fetch(API + before, { headers: { cookie: bo.cookie } })).status === 404, 'the old photo still loads');
  expect(filesOf(ana).length === 1, `files: ${filesOf(ana).join()}`);
});

await check('Removing a photo (yourself, or the host) goes back to initials everywhere', async () => {
  const told = new Promise((resolve) => sBo.on('user:updated', (e) => e.user.id === ana.id && e.user.photo === null && resolve(true)));
  const r = await call(ana.cookie, 'DELETE', '/auth/photo');
  expect(r.status === 200 && r.data.user.photo === null && !filesOf(ana).length, `remove: ${JSON.stringify(r.data)}`);
  expect(await Promise.race([told, sleep(4000).then(() => false)]), 'Bo was not told');
  // The host takes one down.
  await setPhoto(cy);
  expect(filesOf(cy).length === 1, 'Cy has no photo');
  expect((await call(bo.cookie, 'DELETE', `/admin/users/${cy.id}/photo`)).status === 403, 'a normal user took it down');
  expect((await call(host.cookie, 'DELETE', `/admin/users/${cy.id}/photo`)).status === 204, 'the host could not');
  expect((await call(cy.cookie, 'GET', '/auth/me')).data.user.photo === null && !filesOf(cy).length, 'still there');
  // An account removed by the host takes its photo with it.
  await setPhoto(stranger);
  expect(filesOf(stranger).length === 1, 'no photo');
  expect((await call(host.cookie, 'DELETE', `/admin/users/${stranger.id}`)).status === 204, 'remove account');
  expect(!filesOf(stranger).length, 'the photo file was left behind');
});

// ── In the app ──

const browser = await chromium.launch();
async function appPage(user, { phone = true } = {}) {
  const ctx = await browser.newContext(
    phone ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: APP_UA } : { viewport: { width: 1280, height: 860 } },
  );
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  if (phone) await ctx.addInitScript(() => (window.AddaNative = { setTheme() {}, retry() {}, ready() {}, ack() {}, setUser() {}, callState() {}, pushToken: () => '', haptic() {} }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return p;
}
const shownPhoto = (locator) => locator.locator('img').first().evaluate((img) => (img.complete ? img.naturalWidth : 0)).catch(() => 0);

await check('In the app: choose a photo, fit it in the circle, and it shows at once for you and your contacts', async () => {
  const bob = await appPage(bo);
  await bob.goto(`${BASE}/chats`);
  const anaRow = bob.getByRole('link', { name: /Ana/ });
  await anaRow.waitFor();
  expect(!(await anaRow.locator('img').count()), 'Ana has a photo already');

  const p = await appPage(ana);
  await p.goto(`${BASE}/settings`);
  await p.getByRole('button', { name: 'Add a profile photo' }).click();
  await p.getByRole('dialog', { name: 'Profile photo' }).getByRole('button', { name: 'Choose a photo' }).waitFor();
  await p.getByLabel('Choose a photo').setInputFiles(new URL('./fixtures/photo.jpg', import.meta.url).pathname);
  const fit = p.getByRole('dialog', { name: 'Fit your photo' });
  await fit.waitFor();
  await fit.getByRole('button', { name: 'Zoom in' }).click();
  // Drag it a little with a finger.
  const stage = await fit.getByRole('img', { name: /Your photo/ }).boundingBox();
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', stage.x + 160, stage.y + 160);
  await touch('touchMove', stage.x + 140, stage.y + 150);
  await touch('touchEnd');
  await p.screenshot({ path: `${SHOTS}photo-1-fit.png` });
  await fit.getByRole('button', { name: 'Use photo' }).click();
  await p.getByText('Profile photo updated.').waitFor({ timeout: 8000 });
  const me = (await call(ana.cookie, 'GET', '/auth/me')).data.user;
  expect(me.photo, 'not saved');
  const saved = Buffer.from(await (await fetch(API + me.photo, { headers: { cookie: bo.cookie } })).arrayBuffer());
  const size = jpegSize(saved);
  expect(size?.w === 512 && size?.h === 512, `saved as ${JSON.stringify(size)}`);
  expect((await shownPhoto(p.getByRole('button', { name: 'Change your profile photo' }))) > 0, 'not shown in Settings');
  expect((await shownPhoto(p.getByRole('link', { name: 'You: settings' }))) > 0, 'not on the You tab');
  await p.screenshot({ path: `${SHOTS}photo-2-settings.png` });

  // Bo, already looking at his chats, sees it without reloading; and in the chat itself.
  await anaRow.locator('img').waitFor({ timeout: 6000 });
  await sleep(500);
  expect((await shownPhoto(anaRow)) > 0, 'not loaded in Bo’s list');
  await anaRow.click();
  await bob.getByRole('log').getByText('Hi Ana').waitFor();
  await sleep(400);
  expect((await shownPhoto(bob.locator('header').first())) > 0, 'not in the chat header');
  await bob.screenshot({ path: `${SHOTS}photo-3-chat.png` });
  await bob.context().close();

  // Cy sees it beside Ana's messages in the room.
  const c = await appPage(cy);
  await c.goto(`${BASE}/rooms/${room.id}`);
  // The picture sits beside the first of her messages in a row.
  const msg = c.getByRole('log').locator('[id^="msg-"]').filter({ hasText: 'Hello room' });
  await msg.waitFor();
  await sleep(500);
  expect((await shownPhoto(msg)) > 0, 'not beside room messages');
  await c.screenshot({ path: `${SHOTS}photo-4-room.png` });
  await c.context().close();

  // Removing it: initials again.
  await p.getByRole('button', { name: 'Change your profile photo' }).click();
  await p.getByRole('dialog', { name: 'Profile photo' }).getByRole('button', { name: 'Remove photo' }).click();
  await p.getByText('Profile photo removed.').waitFor({ timeout: 6000 });
  expect(!(await p.getByRole('button', { name: 'Add a profile photo' }).locator('img').count()), 'still shows a photo');
  await p.context().close();
});

await check('On a computer: the account menu has Profile photo; the host can take one down from People', async () => {
  await setPhoto(bo);
  const p = await appPage(bo, { phone: false });
  await p.goto(`${BASE}/chats`);
  await p.getByRole('button', { name: 'Your account' }).click();
  await p.getByRole('menuitem', { name: 'Profile photo' }).click();
  const dlg = p.getByRole('dialog', { name: 'Profile photo' });
  await dlg.getByRole('button', { name: 'Choose a new photo' }).waitFor();
  await dlg.getByRole('button', { name: 'Remove photo' }).waitFor();
  await p.keyboard.press('Escape');
  await p.context().close();

  const h = await appPage(host, { phone: false });
  await h.goto(`${BASE}/admin/people`);
  await h.getByPlaceholder(/Search/).fill(`bo.photo.${stamp}`);
  const row = h.locator('li').filter({ hasText: `bo.photo.${stamp}` }).first();
  await row.waitFor();
  await sleep(400);
  expect((await shownPhoto(row)) > 0, 'not in the People list');
  await row.getByRole('button', { name: /Actions for Bo/ }).click();
  await h.getByRole('menuitem', { name: 'Remove profile photo' }).click();
  await h.getByText("Bo's photo was removed.").waitFor({ timeout: 6000 });
  expect((await call(bo.cookie, 'GET', '/auth/me')).data.user.photo === null, 'not removed');
  await h.context().close();
});

sAna.close();
sBo.close();
await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(' -', f[1], ':', f[2]);
  process.exit(1);
}
