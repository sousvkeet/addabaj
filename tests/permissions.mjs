import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// The Android app's first start: "Before you start" lists what Adda Khana
// needs from the phone (notifications, microphone, camera, ringing over the
// lock screen, running in the background) and asks for them one tap at a
// time; Not now (or Back) leaves the rest for Settings › App permissions. In
// pages with a stand-in for the app (app 1.10.0 on), whose "Android" grants
// or refuses as each check says. Browsers, and older apps, see none of it.
// Runs against the dev servers (npm run dev).
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

const res = await fetch(`${API}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Pia Sen', email: `pia.perms.${stamp}@example.com`, password: 'password123' }),
});
if (res.status !== 201) throw new Error(`registering: ${res.status}`);
const cookie = res.headers.get('set-cookie').split(';')[0];

const browser = await chromium.launch();
/**
 * A page as the app shows it. `start`: where the phone's permissions stand;
 * `refuse`: what "Android" refuses when asked; null: an app from before 1.10.0.
 */
async function appPage({ start, refuse = [], signedIn = false, theme } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: APP_UA, ...(theme ? { colorScheme: theme } : {}) });
  if (signedIn) await ctx.addCookies([{ name: 'adda_token', value: cookie.split('=')[1], url: BASE }]);
  await ctx.addInitScript(
    ([start, refuse]) => {
      // The phone's state survives reloads, as the app's would.
      const load = () => JSON.parse(localStorage.getItem('fake-perms') ?? 'null') ?? start;
      const save = (p) => localStorage.setItem('fake-perms', JSON.stringify(p));
      window.__asked = [];
      const report = () =>
        window.dispatchEvent(new CustomEvent('addanative', { detail: { type: 'permissions', state: load(), __id: Math.random() } }));
      window.AddaNative = {
        setTheme() {},
        retry() {},
        ready() {},
        pushToken: () => '',
        ...(start
          ? {
              permissions: () => JSON.stringify(load()),
              askPermission: (which) => {
                window.__asked.push(which);
                const p = load();
                const names = which === 'all' ? ['notifications', 'microphone', 'camera'].filter((n) => p[n] === 'ask') : [which];
                for (const n of names) if (!refuse.includes(n)) p[n] = 'granted';
                save(p);
                // Android's prompt (or the settings page) takes a moment.
                setTimeout(report, 250);
              },
              permissionsSeen: () => save({ ...load(), seen: true }),
            }
          : {}),
      };
    },
    [start, refuse],
  );
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return p;
}

const FRESH = { notifications: 'ask', microphone: 'ask', camera: 'ask', fullScreen: 'settings', battery: 'ask', seen: false };
const screen = (p) => p.getByRole('dialog', { name: 'Before you start' });
const row = (p, name) => screen(p).locator('li', { hasText: name });

try {
  await check('first start in the app: "Before you start" lists what the phone needs, even before logging in', async () => {
    const p = await appPage({ start: FRESH });
    await p.goto(`${BASE}/login`);
    await screen(p).waitFor();
    for (const name of ['Notifications', 'Microphone', 'Camera', 'Calls on the lock screen', 'Run in the background']) await row(p, name).waitFor();
    await p.screenshot({ path: `${SHOTS}permissions-1-first-start.png` });
    const light = await appPage({ start: FRESH, theme: 'light' });
    await light.goto(`${BASE}/login`);
    await light.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await screen(light).waitFor();
    await light.screenshot({ path: `${SHOTS}permissions-1-first-start-light.png` });
    await light.context().close();
    await p.context().close();
  });

  await check('one tap each: Android’s prompts together, then calls on the lock screen, then the background; Continue closes it for good', async () => {
    const p = await appPage({ start: FRESH });
    await p.goto(`${BASE}/login`);
    await screen(p).getByRole('button', { name: 'Allow', exact: true }).click();
    for (const name of ['Notifications', 'Microphone', 'Camera']) await row(p, name).getByRole('img', { name: 'Allowed' }).waitFor();
    expect(JSON.stringify(await p.evaluate(() => window.__asked)) === '["all"]', `asked: ${await p.evaluate(() => JSON.stringify(window.__asked))}`);
    await screen(p).getByRole('button', { name: 'Next: calls on the lock screen' }).click();
    await row(p, 'Calls on the lock screen').getByRole('img', { name: 'Allowed' }).waitFor();
    await screen(p).getByRole('button', { name: 'Next: run in the background' }).click();
    await row(p, 'Run in the background').getByRole('img', { name: 'Allowed' }).waitFor();
    expect(!(await screen(p).getByRole('button', { name: 'Not now' }).count()), 'Not now is offered with everything allowed');
    await p.screenshot({ path: `${SHOTS}permissions-2-all-allowed.png` });
    await screen(p).getByRole('button', { name: 'Continue' }).click();
    await screen(p).waitFor({ state: 'detached' });
    await p.getByRole('button', { name: 'Log in' }).waitFor();
    await p.reload();
    await p.getByRole('button', { name: 'Log in' }).waitFor();
    expect(!(await screen(p).count()), 'it came back after Continue');
    await p.context().close();
  });

  await check('refused: the main button moves on to the next step, and the row keeps its own button', async () => {
    const p = await appPage({ start: FRESH, refuse: ['microphone', 'battery'] });
    await p.goto(`${BASE}/login`);
    await screen(p).getByRole('button', { name: 'Allow', exact: true }).click();
    await row(p, 'Notifications').getByRole('img', { name: 'Allowed' }).waitFor();
    await screen(p).getByRole('button', { name: 'Next: calls on the lock screen' }).waitFor();
    await row(p, 'Microphone').getByRole('button', { name: 'Allow microphone' }).waitFor();
    await screen(p).getByRole('button', { name: 'Next: calls on the lock screen' }).click();
    await screen(p).getByRole('button', { name: 'Next: run in the background' }).click();
    // Refused too: nothing left to try, so Continue (the rows can still ask).
    await screen(p).getByRole('button', { name: 'Continue' }).waitFor();
    await row(p, 'Run in the background').getByRole('button', { name: 'Allow run in the background' }).waitFor();
    await p.screenshot({ path: `${SHOTS}permissions-3-refused.png` });
    await p.context().close();
  });

  await check('Not now leaves the rest for Settings › App permissions, which says what’s off and asks again', async () => {
    const p = await appPage({ start: { ...FRESH, microphone: 'settings', notifications: 'granted' }, signedIn: true });
    await p.goto(`${BASE}/chats`);
    await screen(p).getByRole('button', { name: 'Not now' }).click();
    await screen(p).waitFor({ state: 'detached' });
    await p.reload();
    await p.getByRole('link', { name: /Chats/ }).first().waitFor();
    expect(!(await screen(p).count()), 'it came back after Not now');
    await p.goto(`${BASE}/settings`);
    const settingsRow = p.getByRole('button', { name: /App permissions/ });
    await settingsRow.getByText('Microphone and 3 more not allowed').waitFor();
    await settingsRow.click();
    const dlg = p.getByRole('dialog', { name: 'App permissions' });
    // Refused for good: only the phone's settings can allow it now.
    await dlg.getByRole('button', { name: 'Open settings for microphone' }).click();
    await dlg.getByRole('img', { name: 'Allowed' }).nth(1).waitFor();
    expect((await p.evaluate(() => window.__asked)).includes('microphone'), 'the app wasn’t asked');
    await p.screenshot({ path: `${SHOTS}permissions-4-settings.png` });
    await p.context().close();
  });

  await check('Android’s Back puts it off like Not now', async () => {
    const p = await appPage({ start: FRESH });
    await p.goto(`${BASE}/login`);
    await screen(p).waitFor();
    // What the app calls on Back (lib/back.ts).
    expect(await p.evaluate(() => window.__addaBack?.()), 'Back wasn’t handled by the page');
    await screen(p).waitFor({ state: 'detached' });
    expect(await p.evaluate(() => JSON.parse(localStorage.getItem('fake-perms')).seen === true), 'not marked seen');
    await p.context().close();
  });

  await check('nothing missing, an older app, or a browser: no screen, and no Settings row in a browser', async () => {
    const all = await appPage({ start: { notifications: 'granted', microphone: 'granted', camera: 'granted', battery: 'granted', seen: false } });
    await all.goto(`${BASE}/login`);
    await all.getByRole('button', { name: 'Log in' }).waitFor();
    expect(!(await screen(all).count()), 'shown with everything allowed');
    await all.context().close();
    const old = await appPage({ start: null });
    await old.goto(`${BASE}/login`);
    await old.getByRole('button', { name: 'Log in' }).waitFor();
    expect(!(await screen(old).count()), 'shown in an older app');
    await old.context().close();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: 'adda_token', value: cookie.split('=')[1], url: BASE }]);
    const web = await ctx.newPage();
    await web.goto(`${BASE}/settings`);
    await web.getByRole('button', { name: /Privacy/ }).waitFor();
    expect(!(await screen(web).count()) && !(await web.getByRole('button', { name: /App permissions/ }).count()), 'shown in a browser');
    await ctx.close();
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
