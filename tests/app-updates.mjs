import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// Android app updates: the host uploads a new APK (Admin › App updates), the
// app offers it when it opens (a mandatory one can't be put off), and "Update
// app" hands it to the app to download and install. Runs against the dev
// servers (npm run dev); the host admin must have the default password
// (npm run admin:reset). It REMOVES every uploaded release from this database.
//
// Real app files are needed (they aren't in git). Defaults, after building:
//   OLD_APK        android/dist/AddaKhana-1.3.0.apk     (an earlier release)
//   NEW_APK        the next release, same signing key   (./gradlew assembleRelease)
//   OTHER_KEY_APK  a build signed with another key       (./gradlew assembleDebug)
const root = new URL('..', import.meta.url).pathname;
const clientEnv = `${root}client/.env`;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const OLD_APK = process.env.OLD_APK ?? `${root}android/dist/AddaKhana-1.3.0.apk`;
const NEW_APK = process.env.NEW_APK ?? `${root}android/app/build/outputs/apk/release/app-release.apk`;
const OTHER_KEY_APK = process.env.OTHER_KEY_APK ?? `${root}android/app/build/outputs/apk/debug/app-debug.apk`;
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
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data, headers: res.headers };
}
const upload = (cookie, file, meta = {}) =>
  call(cookie, 'POST', '/admin/app/releases', readFileSync(file), {
    'content-type': 'application/octet-stream',
    'x-release-meta': encodeURIComponent(JSON.stringify(meta)),
  });

async function cookieFor(identifier, password) {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: identifier, password }) });
  if (res.status !== 200) throw new Error(`login ${identifier}: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0];
}
async function register(name) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.toLowerCase()}.upd.${stamp}@example.com`, password: 'password123' }),
  });
  return { cookie: res.headers.get('set-cookie').split(';')[0], id: (await res.json()).user.id };
}

const host = await cookieFor('admin', 'admin');
const user = await register('Ana');
const haveApks = [OLD_APK, NEW_APK, OTHER_KEY_APK].every(existsSync);
if (!haveApks) console.log(`SKIP upload checks: build the app files first (missing ${[OLD_APK, NEW_APK, OTHER_KEY_APK].filter((f) => !existsSync(f)).join(', ')})`);

// Start clean.
for (const r of (await call(host, 'GET', '/admin/app/releases')).data.releases) await call(host, 'DELETE', `/admin/app/releases/${r.versionCode}`);

let newCode;
let newSha;
if (haveApks) {
  await check('The host uploads a release; the server reads its version and key from the file', async () => {
    const none = await call(null, 'GET', '/app/version');
    expect(none.status === 200 && none.data.latest === null, `before: ${JSON.stringify(none.data)}`);
    // Even the first one must be signed with the app's key (ANDROID_CERT_SHA256, default the release key).
    const first = await upload(host, OTHER_KEY_APK);
    expect(first.status === 400 && /different key/.test(first.data.error), `another key as the first release: ${first.status} ${JSON.stringify(first.data)}`);
    const r = await upload(host, OLD_APK, { notes: 'The first one' });
    expect(r.status === 201 && r.data.release.versionName && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(r.data.release.certSha256), `upload: ${r.status} ${JSON.stringify(r.data)}`);
    const v = (await call(null, 'GET', '/app/version')).data;
    expect(v.latest.versionCode === r.data.release.versionCode && v.latest.notes === 'The first one' && v.required === null, `version: ${JSON.stringify(v)}`);
  });

  await check('Wrong files are refused: not an APK, not newer, another signing key; only the host may upload', async () => {
    expect((await upload(host, `${root}package.json`)).data?.error?.includes("isn't an Android app"), 'a non-APK was accepted');
    const same = await upload(host, OLD_APK);
    expect(same.status === 409 && /already up/.test(same.data.error), `same version: ${JSON.stringify(same.data)}`);
    const other = await upload(host, OTHER_KEY_APK);
    expect(other.status === 400 && /different key/.test(other.data.error), `other key: ${other.status} ${JSON.stringify(other.data)}`);
    expect((await upload(user.cookie, NEW_APK)).status === 403, 'a normal user uploaded');
    expect((await upload(null, NEW_APK)).status === 401, 'signed out uploaded');
  });

  await check('A newer release is announced live, and its file downloads intact', async () => {
    const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: user.cookie } });
    const told = new Promise((resolve) => s.on('app:versions', resolve));
    await new Promise((r) => s.on('connect', r));
    const r = await upload(host, NEW_APK, { notes: 'Faster and fixed' });
    expect(r.status === 201, `upload: ${r.status} ${JSON.stringify(r.data)}`);
    newCode = r.data.release.versionCode;
    newSha = r.data.release.sha256;
    const v = await Promise.race([told, sleep(4000).then(() => null)]);
    expect(v?.latest?.versionCode === newCode, `live: ${JSON.stringify(v)}`);
    s.close();
    const dl = await fetch(`${API}/api/app/download/${newCode}`);
    expect(dl.status === 200 && dl.headers.get('content-type') === 'application/vnd.android.package-archive', `download: ${dl.status}`);
    const body = Buffer.from(await dl.arrayBuffer());
    expect(createHash('sha256').update(body).digest('hex') === newSha && body.equals(readFileSync(NEW_APK)), 'the download differs');
    expect((await fetch(`${API}/api/app/download/99999`)).status === 404, 'a missing version downloaded');
  });

  await check('Making a release mandatory (and optional again)', async () => {
    expect((await call(user.cookie, 'PATCH', `/admin/app/releases/${newCode}`, { mandatory: true })).status === 403, 'a normal user changed it');
    const r = await call(host, 'PATCH', `/admin/app/releases/${newCode}`, { mandatory: true });
    expect(r.status === 200 && r.data.releases.find((x) => x.versionCode === newCode).mandatory, `patch: ${JSON.stringify(r.data)}`);
    const v = (await call(null, 'GET', '/app/version')).data;
    expect(v.required?.versionCode === newCode, `required: ${JSON.stringify(v.required)}`);
    await call(host, 'PATCH', `/admin/app/releases/${newCode}`, { mandatory: false });
    expect((await call(null, 'GET', '/app/version')).data.required === null, 'still required');
  });
}

// ── The update screen, in a page with a stand-in for the Android app ──

const browser = await chromium.launch();
/** A page as the app shows it: `version` is what the app reports (null: an app from before 1.4.0). */
async function appPage(version, { ua = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(ua ? { userAgent: ua } : {}) });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  await ctx.addInitScript((v) => {
    window.__install = null;
    window.AddaNative = {
      setTheme() {},
      retry() {},
      ready() {},
      pushToken: () => '',
      ...(v
        ? {
            appVersion: () => JSON.stringify({ type: 'version', code: v.code, name: v.name }),
            installUpdate: (url, sha) => (window.__install = [url, sha]),
          }
        : {}),
    };
  }, version);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return p;
}
const nativeEvent = (p, detail) => p.evaluate((d) => window.dispatchEvent(new CustomEvent('addanative', { detail: { ...d, __id: Math.random() } })), detail);

if (haveApks) {
  await check('The app offers the update when it opens; Later puts it off until the next start', async () => {
    const p = await appPage({ code: newCode - 1, name: 'old' });
    await p.goto(`${BASE}/chats`);
    const dlg = p.getByRole('dialog', { name: 'Update Adda Khana' });
    await dlg.getByText('Faster and fixed').waitFor({ timeout: 8000 });
    await p.screenshot({ path: `${SHOTS}update-1-offer.png` });
    await dlg.getByRole('button', { name: 'Later' }).click();
    await dlg.waitFor({ state: 'detached' });
    await p.reload();
    await p.getByRole('dialog', { name: 'Update Adda Khana' }).waitFor({ timeout: 8000 });
    await p.context().close();
  });

  await check('Update app: the app downloads it (progress shown) and opens the installer', async () => {
    const p = await appPage({ code: newCode - 1, name: 'old' });
    await p.goto(`${BASE}/chats`);
    const dlg = p.getByRole('dialog', { name: 'Update Adda Khana' });
    await dlg.getByRole('button', { name: 'Update app' }).click();
    const [url, sha] = await p.evaluate(() => window.__install);
    expect(url === `/api/app/download/${newCode}` && sha === newSha, `asked the app for ${url} ${sha}`);
    await nativeEvent(p, { type: 'update', state: 'downloading', percent: 45 });
    await dlg.getByText('45%').waitFor();
    await p.screenshot({ path: `${SHOTS}update-2-downloading.png` });
    await nativeEvent(p, { type: 'update', state: 'permission' });
    await dlg.getByText(/Install unknown apps/).waitFor();
    await nativeEvent(p, { type: 'update', state: 'installing' });
    await dlg.getByText(/Opening the installer/).waitFor();
    // Cancelled in Android's installer: back in the app, it can be installed again.
    await nativeEvent(p, { type: 'update', state: 'cancelled' });
    await dlg.getByText(/wasn’t installed/).waitFor();
    await dlg.getByRole('button', { name: 'Install update' }).click();
    expect((await p.evaluate(() => window.__install))?.[0] === `/api/app/download/${newCode}`, 'Install update didn’t ask the app');
    await nativeEvent(p, { type: 'update', state: 'failed', message: 'The download was cut short. Try again.' });
    await dlg.getByRole('alert').getByText('The download was cut short').waitFor();
    await dlg.getByRole('button', { name: 'Try again' }).waitFor();
    await p.context().close();
  });

  await check('A mandatory update can’t be put off', async () => {
    await call(host, 'PATCH', `/admin/app/releases/${newCode}`, { mandatory: true });
    const p = await appPage({ code: newCode - 1, name: 'old' });
    await p.goto(`${BASE}/chats`);
    const dlg = p.getByRole('dialog', { name: 'Update required' });
    await dlg.getByRole('button', { name: 'Update app' }).waitFor({ timeout: 8000 });
    expect(!(await dlg.getByRole('button', { name: 'Later' }).count()), 'Later is offered');
    expect(!(await dlg.getByRole('button', { name: 'Close' }).count()), 'it can be closed');
    await p.keyboard.press('Escape');
    await sleep(300);
    expect(await dlg.isVisible(), 'Escape closed it');
    await p.screenshot({ path: `${SHOTS}update-3-mandatory.png` });
    // Opening the app again shows it straight away, even before (or without) the server's answer.
    await p.route('**/api/app/version', () => {});
    await p.reload();
    await p.getByRole('dialog', { name: 'Update required' }).waitFor({ timeout: 3000 });
    await p.context().close();
    await call(host, 'PATCH', `/admin/app/releases/${newCode}`, { mandatory: false });
  });

  await check('An app from before 1.4.0 downloads the update with the browser', async () => {
    const p = await appPage(null, { ua: 'Mozilla/5.0 (Linux; Android 16) AddaKhanaApp/1.0.0' });
    const asked = new Promise((resolve) => p.on('request', (r) => r.url().includes('/api/app/download/') && resolve(r.url())));
    await p.goto(`${BASE}/chats`);
    const dlg = p.getByRole('dialog', { name: 'Update Adda Khana' });
    await dlg.getByRole('button', { name: 'Update app' }).click();
    const url = await Promise.race([asked, sleep(5000).then(() => null)]);
    expect(url?.endsWith(`/api/app/download/${newCode}`), `requested ${url}`);
    await p.context().close();
  });

  await check('No offer when the app is up to date, or in a browser', async () => {
    const p = await appPage({ code: newCode, name: 'current' });
    await p.goto(`${BASE}/chats`);
    await sleep(2500);
    expect(!(await p.getByRole('dialog', { name: /Update/ }).count()), 'offered to an up-to-date app');
    await p.context().close();
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
    const web = await ctx.newPage();
    await web.goto(`${BASE}/chats`);
    await sleep(2500);
    expect(!(await web.getByRole('dialog', { name: /Update/ }).count()), 'offered in a browser');
    await ctx.close();
  });

  await check('Admin › App updates: upload with the page, make mandatory, remove', async () => {
    for (const r of (await call(host, 'GET', '/admin/app/releases')).data.releases) await call(host, 'DELETE', `/admin/app/releases/${r.versionCode}`);
    await upload(host, OLD_APK);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: 'adda_token', value: host.split('=')[1], url: BASE }]);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/admin/app`);
    await p.getByLabel('App file (.apk)').setInputFiles(NEW_APK);
    await p.getByPlaceholder('Optional. Shown on the update screen.').fill('Uploaded from the admin page');
    await p.getByText('Make it mandatory').click();
    await p.getByRole('button', { name: 'Upload and publish' }).click();
    const list = p.getByRole('list', { name: 'App versions' });
    await list.getByText('Uploaded from the admin page').waitFor({ timeout: 15000 });
    expect(await list.getByRole('switch', { name: /is mandatory/ }).first().isChecked(), 'the new version isn’t mandatory');
    await p.screenshot({ path: `${SHOTS}update-4-admin.png` });
    const v = (await call(null, 'GET', '/app/version')).data;
    expect(v.latest.versionCode === newCode && v.required?.versionCode === newCode, `after: ${JSON.stringify(v)}`);
    await p.getByLabel('App file (.apk)').setInputFiles(OTHER_KEY_APK);
    await p.getByRole('button', { name: 'Upload and publish' }).click();
    await p.getByRole('alert').getByText(/different key|already up/).waitFor({ timeout: 10000 });
    await list.getByRole('button', { name: new RegExp(`Remove version ${v.latest.versionName}`) }).click();
    await p.getByRole('dialog', { name: /Remove version/ }).getByRole('button', { name: 'Remove' }).click();
    await list.getByText('Uploaded from the admin page').waitFor({ state: 'detached', timeout: 5000 });
    expect((await call(null, 'GET', '/app/version')).data.latest.versionCode < newCode, 'the removed release is still offered');
    await ctx.close();
  });
}

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(' -', f[1], ':', f[2]);
  process.exit(1);
}
