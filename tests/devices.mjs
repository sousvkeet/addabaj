import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { existsSync } from 'node:fs';

// Devices (Settings › Devices): everywhere an account is logged in, the app
// or a browser, and logging any of them out, as in other messengers. Runs
// against the dev servers (npm run dev).
const root = new URL('..', import.meta.url).pathname;
for (const f of [`${root}client/.env`, `${root}server/.env`]) if (existsSync(f)) process.loadEnvFile(f);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const APP_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 8 Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 AddaKhanaApp/1.6.0';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
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
const cookieFrom = (res) => res.headers.get('set-cookie')?.split(';')[0] ?? null;

async function call(cookie, method, path, body, ua = WIN_UA) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'user-agent': ua, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data, cookie: cookieFrom(res) };
}
const email = (name) => `${name.toLowerCase()}.dev.${stamp}@example.com`;
async function login(name, ua) {
  const r = await call(null, 'POST', '/auth/login', { email: email(name), password: 'password123' }, ua);
  expect(r.status === 200 && r.cookie, `login ${name}: ${r.status}`);
  return r.cookie;
}
const connect = (cookie) =>
  new Promise((resolve, reject) => {
    const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const signedIn = async (cookie) => (await call(cookie, 'GET', '/auth/me')).data?.user?.id ?? null;

// Ana, on her phone (the app) first.
const reg = await call(null, 'POST', '/auth/register', { name: 'Ana', email: email('Ana'), password: 'password123' }, APP_UA);
const ana = { id: reg.data.user.id, phone: reg.cookie };
let bo = (await call(null, 'POST', '/auth/register', { name: 'Bo', email: email('Bo'), password: 'password123' })).cookie;

await check('Each login is a device: the app and browsers, named, with this one first and a count', async () => {
  const phoneSock = await connect(ana.phone);
  const told = new Promise((resolve) => phoneSock.on('session:new', (e) => resolve(e.session)));
  ana.laptop = await login('Ana', WIN_UA);
  const heard = await Promise.race([told, sleep(4000).then(() => null)]);
  expect(heard?.name === 'Chrome on Windows', `the phone was told: ${JSON.stringify(heard)}`);
  phoneSock.close();
  const { status, data } = await call(ana.laptop, 'GET', '/auth/sessions');
  expect(status === 200 && data.sessions.length === 2, `sessions: ${JSON.stringify(data)}`);
  const [first, second] = data.sessions;
  expect(first.current && first.kind === 'web' && first.name === 'Chrome on Windows' && !first.phone, `this device: ${JSON.stringify(first)}`);
  expect(!second.current && second.kind === 'app' && second.name === 'Pixel 8' && /Adda Khana 1\.6\.0 · Android 16/.test(second.detail) && second.phone, `the phone: ${JSON.stringify(second)}`);
  expect(first.signedInAt && first.lastActiveAt && 'ip' in first, 'times and address');
  expect((await call(bo, 'GET', '/auth/sessions')).data.sessions.length === 1, 'Bo sees Ana’s devices');
  expect((await call(null, 'GET', '/auth/sessions')).status === 401, 'signed out could list');
});

await check('Logging one device out: its login stops working, its open app is told and cut off, its phone gets no notifications', async () => {
  const sessions = (await call(ana.laptop, 'GET', '/auth/sessions')).data.sessions;
  const phone = sessions.find((s) => s.kind === 'app');
  // The phone is open, and registered for notifications.
  expect((await call(ana.phone, 'POST', '/push/devices', { token: `tok-${stamp}-phone-aaaaaaaaaaaaaaaa`, platform: 'android' }, APP_UA)).status === 204, 'register phone');
  const sock = await connect(ana.phone);
  const ended = new Promise((resolve) => sock.on('session:ended', resolve));
  const gone = new Promise((resolve) => sock.on('disconnect', resolve));
  expect((await call(bo, 'DELETE', `/auth/sessions/${phone.id}`)).status === 404, 'Bo logged out Ana’s phone');
  const current = sessions.find((s) => s.current);
  expect((await call(ana.laptop, 'DELETE', `/auth/sessions/${current.id}`)).status === 400, 'this device logged itself out here');
  const r = await call(ana.laptop, 'DELETE', `/auth/sessions/${phone.id}`);
  expect(r.status === 200 && r.data.sessions.length === 1 && r.data.sessions[0].current, `after: ${JSON.stringify(r.data)}`);
  expect((await Promise.race([ended, sleep(3000).then(() => null)]))?.reason === 'elsewhere', 'the phone was not told');
  expect(await Promise.race([gone.then(() => true), sleep(3000).then(() => false)]), 'the phone stayed connected');
  expect((await signedIn(ana.phone)) === null, 'the phone is still logged in');
  expect((await call(ana.phone, 'GET', '/dms', undefined, APP_UA)).status === 401, 'the phone can still use the API');
  await connect(ana.phone).then(
    (s) => {
      s.close();
      throw new Error('the phone could connect again');
    },
    () => {},
  );
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const left = await db.query('SELECT 1 FROM push_devices WHERE token = $1', [`tok-${stamp}-phone-aaaaaaaaaaaaaaaa`]);
  await db.end();
  expect(!left.rowCount, 'the phone still gets notifications');
});

await check('Log out of all other devices: every other login stops, this one carries on', async () => {
  ana.phone = await login('Ana', APP_UA);
  ana.mac = await login('Ana', MAC_UA);
  const before = (await call(ana.laptop, 'GET', '/auth/sessions')).data.sessions;
  expect(before.length === 3, `before: ${before.length}`);
  const r = await call(ana.laptop, 'DELETE', '/auth/sessions/others');
  expect(r.status === 200 && r.data.sessions.length === 1, `after: ${JSON.stringify(r.data)}`);
  if (r.cookie) ana.laptop = r.cookie;
  expect((await signedIn(ana.laptop)) === ana.id, 'this device was logged out too');
  expect((await signedIn(ana.phone)) === null && (await signedIn(ana.mac)) === null, 'another device is still in');
});

await check('Logging out ends the session for good, even if the cookie is kept', async () => {
  const cookie = await login('Ana', MAC_UA);
  expect((await signedIn(cookie)) === ana.id, 'not logged in');
  expect((await call(cookie, 'POST', '/auth/logout')).status === 204, 'logout');
  expect((await signedIn(cookie)) === null, 'the old cookie still works');
  expect((await call(ana.laptop, 'GET', '/auth/sessions')).data.sessions.every((s) => s.name !== 'Safari on Mac'), 'still listed');
});

await check('Logins from before devices were tracked keep working, and show up once used', async () => {
  // Bo (who hasn't logged out his other devices) with a login issued a while ago, as old logins were.
  const boId = (await call(bo, 'GET', '/auth/me')).data.user.id;
  const token = jwt.sign({ sub: boId, iat: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET, { expiresIn: '30d' });
  const r = await call(`adda_token=${token}`, 'GET', '/auth/me', undefined, MAC_UA);
  expect(r.data?.user?.id === boId, 'an old login was refused');
  expect(r.cookie && r.cookie !== `adda_token=${token}`, 'not moved onto a device');
  expect((await signedIn(r.cookie)) === boId, 'its new cookie does not work');
  const list = (await call(bo, 'GET', '/auth/sessions')).data.sessions;
  expect(list.some((s) => s.name === 'Safari on Mac'), `not listed: ${JSON.stringify(list.map((s) => s.name))}`);
  // Log out of all other devices also stops old-style logins.
  const out = await call(bo, 'DELETE', '/auth/sessions/others');
  if (out.cookie) bo = out.cookie;
  expect((await signedIn(`adda_token=${token}`)) === null, 'an old-style login survived');
  expect((await signedIn(bo)) === boId, 'Bo was logged out himself');
});

await check('Changing the password logs out every other device', async () => {
  const other = await login('Ana', APP_UA);
  const r = await call(ana.laptop, 'POST', '/auth/password', { currentPassword: 'password123', newPassword: 'password456' });
  expect(r.status === 200, `change: ${r.status} ${JSON.stringify(r.data)}`);
  if (r.cookie) ana.laptop = r.cookie;
  expect((await signedIn(ana.laptop)) === ana.id && (await signedIn(other)) === null, 'not as expected');
  expect((await call(ana.laptop, 'GET', '/auth/sessions')).data.sessions.length === 1, 'other devices still listed');
});

// ── In the app ──

const browser = await chromium.launch();
await check('In the app: Settings shows how many devices; log one out from the list, and that device is sent to the login page', async () => {
  // Ana on the laptop (a browser), and on her phone (the app).
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 860 }, userAgent: WIN_UA });
  await laptop.addCookies([{ name: 'adda_token', value: ana.laptop.split('=')[1], url: BASE }]);
  const lp = await laptop.newPage();
  await lp.goto(`${BASE}/chats`);
  await lp.getByRole('button', { name: 'Your account' }).waitFor();

  const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: APP_UA });
  const phoneCookie = await login('Ana', APP_UA).catch(async () => {
    // (The password changed above.)
    const r = await call(null, 'POST', '/auth/login', { email: email('Ana'), password: 'password456' }, APP_UA);
    return r.cookie;
  });
  await phone.addCookies([{ name: 'adda_token', value: phoneCookie.split('=')[1], url: BASE }]);
  await phone.addInitScript(() => (window.AddaNative = { setTheme() {}, retry() {}, ready() {}, ack() {}, setUser() {}, callState() {}, pushToken: () => '', haptic() {} }));
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/settings`);
  // The laptop heard about the phone's login.
  await lp.getByText(/New login: Pixel 8/).waitFor({ timeout: 6000 });
  const devicesRow = pp.getByRole('button', { name: /^Devices/ });
  await devicesRow.getByText('2 devices: 1 app, 1 browser').waitFor({ timeout: 6000 });
  await devicesRow.click();
  const dlg = pp.getByRole('dialog', { name: 'Devices' });
  const list = dlg.getByRole('list', { name: 'Your devices' });
  await list.getByText('Chrome on Windows').waitFor();
  expect((await list.getByRole('listitem').first().textContent()).includes('This device'), 'this phone is not first');
  await pp.screenshot({ path: `${SHOTS}devices-1-phone.png` });
  await list.getByRole('button', { name: 'Log out Chrome on Windows' }).click();
  await pp.getByRole('dialog', { name: 'Log out Chrome on Windows?' }).getByRole('button', { name: 'Log out' }).click();
  await pp.getByText('Chrome on Windows was logged out.').waitFor({ timeout: 6000 });
  expect(!(await list.getByText('Chrome on Windows').count()), 'still listed');
  // The laptop is sent to the login page, and told why.
  await lp.waitForURL(/\/login$/, { timeout: 8000 });
  await lp.getByText(/logged out from another device/).waitFor({ timeout: 5000 });
  await lp.screenshot({ path: `${SHOTS}devices-2-loggedout.png` });
  await laptop.close();
  await phone.close();
});

await check('On a computer: Devices is in the account menu', async () => {
  const cookie = await call(null, 'POST', '/auth/login', { email: email('Ana'), password: 'password456' }, MAC_UA).then((r) => r.cookie);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, userAgent: MAC_UA });
  await ctx.addCookies([{ name: 'adda_token', value: cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/chats`);
  await p.getByRole('button', { name: 'Your account' }).click();
  await p.getByRole('menuitem', { name: 'Devices' }).click();
  const dlg = p.getByRole('dialog', { name: 'Devices' });
  await dlg.getByText('Safari on Mac').waitFor();
  await dlg.getByText('This device').waitFor();
  await ctx.close();
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(' -', f[1], ':', f[2]);
  process.exit(1);
}
