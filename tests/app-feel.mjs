import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync } from 'node:fs';

// The Android app should feel like a phone app, not a web page. Runs in a page
// posing as the app (its user agent and a stand-in for its bridge) against the
// dev servers (npm run dev). Opening offline needs the built app (npm run
// build), which the API server hosts; that check is skipped without it.
const root = new URL('..', import.meta.url).pathname;
const clientEnv = `${root}client/.env`;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const BUILT = existsSync(`${root}client/dist/index.html`) ? API : null;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
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

async function register(name) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.toLowerCase()}.feel.${stamp}@example.com`, password: 'password123' }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`register ${name}: ${res.status}`);
  return { name, cookie: res.headers.get('set-cookie').split(';')[0], id: (await res.json()).user.id };
}
const connect = (u) =>
  new Promise((resolve) => {
    const s = io(API, { transports: ['websocket'], extraHeaders: { cookie: u.cookie } });
    s.on('connect', () => resolve(s));
  });
const emit = (s, event, data) => new Promise((r) => s.emit(event, data, r));
const messagesBetween = async (viewer, other) =>
  (await (await fetch(`${API}/api/dms/${other.id}/messages`, { headers: { cookie: viewer.cookie } })).json()).messages.map((m) => m.body);

const ana = await register('Ana');
const bo = await register('Bo');
const cy = await register('Cy');
const [sAna, sBo, sCy] = await Promise.all([connect(ana), connect(bo), connect(cy)]);
for (const [s, to, body] of [
  [sBo, ana, 'Chai at six?'],
  [sAna, bo, 'Yes, the usual place'],
  [sBo, ana, 'Bring the book you mentioned'],
  [sCy, ana, 'Call me when you are free'],
]) {
  await emit(s, 'dm:send', { to: to.id, body });
  await sleep(40);
}
[sAna, sBo, sCy].forEach((s) => s.close());

const browser = await chromium.launch();

/** A phone-sized page as the Android app shows it; window.__haptics records the buzzes asked for. */
async function appPage(user, base = BASE) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: APP_UA });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: base }]);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await ctx.addInitScript(() => {
    window.__haptics = [];
    window.__transitions = [];
    window.AddaNative = {
      setTheme() {},
      retry() {},
      ready() {},
      ack() {},
      setUser() {},
      callState() {},
      pushToken: () => '',
      haptic: (kind) => window.__haptics.push(kind),
      setBackHandled: (open) => (window.__backOpen = open),
    };
    // Which way each screen change animates.
    const start = document.startViewTransition?.bind(document);
    if (start) {
      document.startViewTransition = (cb) => {
        window.__transitions.push(document.documentElement.dataset.nav);
        return start(cb);
      };
    }
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  const cdp = await ctx.newCDPSession(page);
  /** Real touches (they make pointer events, as a finger does): a path of points with a pause at the start. */
  page.touch = async (points, { hold = 0, step = 16 } = {}) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
    if (hold) await sleep(hold);
    for (const p of points.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
      await sleep(step);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  return page;
}
const thread = (p) => p.getByRole('log');
const kept = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('adda-cache')));
/** "Waiting for network…" where phones show it: in the header, under the name. */
const waiting = (p, text = 'Waiting for network…') => p.getByRole('status').filter({ hasText: text, visible: true });

await check('The app looks like an app: the phone font, no zoom, no web fonts, no selecting words', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats/${bo.id}`);
  await thread(p).getByText('Bring the book you mentioned').waitFor();
  const look = await p.evaluate(() => ({
    app: document.documentElement.classList.contains('app'),
    font: getComputedStyle(document.body).fontFamily,
    viewport: document.querySelector('meta[name=viewport]').content,
    webFonts: [...document.querySelectorAll('link[rel=stylesheet]')].some((l) => l.href.includes('fonts.googleapis')),
    bubble: getComputedStyle(document.querySelector('[role=log] .select-text')).userSelect,
    box: getComputedStyle(document.querySelector('textarea')).userSelect,
  }));
  expect(look.app && look.font.startsWith('Roboto') && look.viewport.includes('user-scalable=no') && !look.webFonts, `look: ${JSON.stringify(look)}`);
  expect(look.bubble === 'none' && look.box === 'text', `selecting: ${JSON.stringify(look)}`);
  await p.context().close();

  // A phone's browser keeps the website as it was.
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'adda_token', value: ana.cookie.split('=')[1], url: BASE }]);
  const web = await ctx.newPage();
  await web.goto(`${BASE}/chats/${bo.id}`);
  await thread(web).getByText('Bring the book you mentioned').waitFor();
  const site = await web.evaluate(() => ({
    app: document.documentElement.classList.contains('app'),
    webFonts: [...document.querySelectorAll('link[rel=stylesheet]')].some((l) => l.href.includes('fonts.googleapis')),
    bubble: getComputedStyle(document.querySelector('[role=log] .select-text')).userSelect,
    kept: Object.keys(localStorage).filter((k) => k.startsWith('adda-cache')),
  }));
  expect(!site.app && site.webFonts && site.bubble === 'text' && !site.kept.length, `browser: ${JSON.stringify(site)}`);
  await ctx.close();
});

await check('Headers fit even on phones whose WebView also reports the status bar (the app keeps the page clear of it)', async () => {
  const p = await appPage(ana);
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 30, topMax: 30, bottom: 24, bottomMax: 24, left: 0, right: 0 } });
  await p.goto(`${BASE}/chats/${bo.id}`);
  await thread(p).getByText('Bring the book you mentioned').waitFor();
  const fit = await p.evaluate(() => {
    const h = document.querySelector('main header');
    const box = h.getBoundingClientRect();
    return { pad: getComputedStyle(h).paddingTop, inside: [...h.querySelectorAll('h1, p')].every((e) => e.getBoundingClientRect().bottom <= box.bottom) };
  });
  expect(fit.pad === '0px' && fit.inside, `header: ${JSON.stringify(fit)}`);
  await p.context().close();
});

/**
 * Android's back button, as the app does it: while the page says it has
 * something to do, the page closes what's open or goes back a screen;
 * otherwise the app leaves.
 */
async function pressBack(p) {
  const before = new URL(p.url()).pathname;
  const handled = await p.evaluate(() => (window.__backOpen ? window.__addaBack() : false));
  if (!handled) return (await p.evaluate(() => history.state?.idx ?? 0)) === 0 ? 'left the app' : 'left the app with screens to go back to';
  await sleep(500);
  const after = new URL(p.url()).pathname;
  return after === before ? 'closed' : after;
}

await check('Back goes to the chats (the home screen) first, and from there leaves the app', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats`);
  await p.getByRole('link', { name: /Bo/ }).waitFor();
  // Around the tabs: Rooms, You, Invites, then Back.
  for (const tab of ['Rooms', 'You: settings', 'Invites']) {
    await p.getByRole('link', { name: tab, exact: true }).click();
    await sleep(400);
  }
  expect((await pressBack(p)) === '/chats', 'Back from a tab did not go to the chats');
  expect((await pressBack(p)) === 'left the app', 'Back from the chats did not leave');
  // A chat, then back, then back.
  await p.getByRole('link', { name: /Bo/ }).click();
  await thread(p).getByText('Chai at six?').waitFor();
  expect((await pressBack(p)) === '/chats', 'Back from a chat');
  expect((await pressBack(p)) === 'left the app', 'leave after the chat');
  // The chats tab from another tab goes back down to the chats.
  await p.getByRole('link', { name: 'Rooms', exact: true }).click();
  await sleep(300);
  await p.getByRole('link', { name: /^Chats/ }).click();
  await sleep(500);
  expect(new URL(p.url()).pathname === '/chats' && (await pressBack(p)) === 'left the app', 'the Chats tab left history behind');
  await p.context().close();
});

await check('Opened from a notification straight onto a chat: Back reaches the chats before leaving', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats/${bo.id}`);
  await thread(p).getByText('Chai at six?').waitFor();
  await sleep(500);
  expect((await pressBack(p)) === '/chats', 'Back did not reach the chats');
  await p.getByRole('link', { name: /Bo/ }).waitFor();
  expect((await pressBack(p)) === 'left the app', 'did not leave from the chats');
  await p.context().close();
});

await check('Back closes what’s open first: a sheet, the message menu, a menu', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats`);
  await p.getByRole('button', { name: 'Start a new chat' }).click();
  const sheet = p.getByRole('dialog', { name: 'Start a chat' });
  await sheet.waitFor();
  expect((await p.evaluate(() => window.__backOpen)) === true, 'the app was not told something is open');
  expect((await pressBack(p)) === 'closed', 'Back did not close the sheet');
  await sheet.waitFor({ state: 'hidden' });
  expect((await p.evaluate(() => window.__backOpen)) === false, 'the app still thinks something is open');
  expect(new URL(p.url()).pathname === '/chats', 'Back also left the chats');
  // The message menu (press and hold).
  await p.getByRole('link', { name: /Bo/ }).click();
  const msg = thread(p).getByText('Chai at six?');
  await msg.waitFor();
  await sleep(400);
  const b = await msg.boundingBox();
  await p.touch([{ x: b.x + 20, y: b.y + 8 }], { hold: 700 });
  const menu = p.getByRole('dialog', { name: 'Message actions' });
  await menu.waitFor();
  expect((await pressBack(p)) === 'closed', 'Back did not close the message menu');
  await menu.waitFor({ state: 'detached' });
  expect(new URL(p.url()).pathname === `/chats/${bo.id}`, 'Back left the chat too');
  await p.context().close();
});

await check('Tabs at the bottom of the screen; the You tab is Settings', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats`);
  const nav = p.getByRole('navigation', { name: 'Main' });
  await nav.waitFor();
  const box = await nav.boundingBox();
  expect(Math.abs(box.y + box.height - 915) < 2 && box.width >= 410, `the tab bar sits at ${JSON.stringify(box)}`);
  expect(!(await p.getByRole('button', { name: 'Your account' }).count()), 'the account pop-up is still on the phone');
  await nav.getByRole('link', { name: 'You: settings' }).click();
  await p.getByRole('heading', { name: 'Settings' }).waitFor();
  const theme = p.getByRole('switch', { name: /Dark theme/ });
  const before = await p.evaluate(() => document.documentElement.dataset.theme);
  await theme.click();
  expect((await p.evaluate(() => document.documentElement.dataset.theme)) !== before, 'the theme switch did nothing');
  await theme.click();
  await p.getByRole('button', { name: /^Your user ID/ }).click();
  await p.getByRole('dialog', { name: 'Your user ID' }).waitFor();
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: 'Log out' }).click();
  const confirm = p.getByRole('dialog', { name: 'Log out?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await p.screenshot({ path: `${SHOTS}feel-1-settings.png` });
  await p.context().close();
});

await check('The floating button starts a chat in a sheet from the bottom; swiping it down closes it', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats`);
  const fab = p.getByRole('button', { name: 'Start a new chat' });
  await fab.waitFor();
  const at = await fab.boundingBox();
  expect(at.x > 300 && at.y > 700, `the button is at ${JSON.stringify(at)}`);
  await fab.click();
  const sheet = p.getByRole('dialog', { name: 'Start a chat' });
  await sheet.waitFor();
  await sleep(400);
  const box = await sheet.boundingBox();
  expect(Math.abs(box.y + box.height - 915) < 2 && box.width >= 410, `the sheet is at ${JSON.stringify(box)}`);
  await p.screenshot({ path: `${SHOTS}feel-2-sheet.png` });
  const y = box.y + 30;
  await p.touch([{ x: 206, y }, { x: 206, y: y + 60 }, { x: 206, y: y + 140 }, { x: 206, y: y + 220 }, { x: 206, y: y + 300 }]);
  await sheet.waitFor({ state: 'hidden', timeout: 3000 });
  await p.context().close();
});

await check('Opening a chat slides it in; back (the arrow or Android’s back) slides it away', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats`);
  await p.getByRole('link', { name: /Bo/ }).click();
  await thread(p).getByText('Chai at six?').waitFor();
  await sleep(500);
  await p.getByRole('button', { name: 'Back to chats' }).click();
  await p.waitForURL(/\/chats$/);
  await sleep(500);
  expect((await p.evaluate(() => history.state?.idx)) === 0, 'the back arrow added a page instead of going back');
  await p.getByRole('link', { name: /Cy/ }).click();
  await thread(p).getByText('Call me when you are free').waitFor();
  await sleep(500);
  await p.goBack();
  await p.waitForURL(/\/chats$/);
  await sleep(500);
  await p.getByRole('link', { name: 'Rooms' }).click();
  await sleep(500);
  const moves = await p.evaluate(() => window.__transitions);
  const has = await p.evaluate(() => typeof document.startViewTransition === 'function');
  if (has) expect(moves.join() === 'forward,back,forward,back,tab', `transitions: ${moves.join()}`);
  await p.context().close();
});

await check('Press and hold a message (a wobbly finger is fine) for its menu, with a buzz; Copy copies it', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats/${bo.id}`);
  const msg = thread(p).getByText('Chai at six?');
  await msg.waitFor();
  await sleep(400);
  const b = await msg.boundingBox();
  const x = b.x + 20;
  const y = b.y + 8;
  await p.touch([{ x, y }, { x: x + 3, y: y + 4 }], { hold: 700 });
  const menu = p.getByRole('dialog', { name: 'Message actions' });
  await menu.waitFor({ timeout: 3000 });
  await sleep(300);
  expect(await menu.isVisible(), 'the menu closed when the finger lifted');
  expect((await p.evaluate(() => window.__haptics)).includes('press'), 'no buzz');
  expect(!(await p.evaluate(() => String(getSelection()))), 'words got selected');
  await menu.getByRole('button', { name: 'Copy' }).click();
  await menu.waitFor({ state: 'detached' });
  expect((await p.evaluate(() => navigator.clipboard.readText())) === 'Chai at six?', 'not copied');
  await p.context().close();
});

await check('Swipe a message to the right to reply, with a tick as it reaches the point', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats/${bo.id}`);
  const msg = thread(p).getByText('Bring the book you mentioned');
  await msg.waitFor();
  await sleep(400);
  const b = await msg.boundingBox();
  const y = b.y + 8;
  await p.touch(Array.from({ length: 10 }, (_, i) => ({ x: b.x + 20 + i * 10, y })));
  await p.getByText('Replying to Bo').waitFor({ timeout: 3000 });
  expect((await p.evaluate(() => window.__haptics)).includes('tick'), 'no tick');
  // Scrolling up and down isn't a swipe.
  await p.getByRole('button', { name: 'Cancel reply' }).click();
  await p.touch(Array.from({ length: 8 }, (_, i) => ({ x: b.x + 20 + i * 2, y: y - i * 12 })));
  await sleep(300);
  expect(!(await p.getByText('Replying to Bo').count()), 'a scroll started a reply');
  await p.context().close();
});

await check('A message written offline waits with its clock, and goes by itself when the line is back', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats/${cy.id}`);
  await thread(p).getByText('Call me when you are free').waitFor();
  await sleep(800);
  await p.context().setOffline(true);
  await waiting(p).waitFor({ timeout: 6000 });
  await p.getByLabel(/^Message Cy/).fill('Written offline');
  await p.getByLabel(/^Message Cy/).press('Enter');
  const mine = thread(p).locator('[id], div').filter({ hasText: /^Written offline/ }).first();
  await thread(p).getByLabel('Sending').waitFor({ timeout: 3000 });
  expect(!(await p.getByRole('alert').count()), 'an error was shown');
  expect(!(await mine.getByText('Not sent').count()), 'marked as not sent');
  await p.context().setOffline(false);
  for (let i = 0; i < 40 && !(await messagesBetween(cy, ana)).includes('Written offline'); i++) await sleep(250);
  expect((await messagesBetween(cy, ana)).includes('Written offline'), 'it never arrived');
  await thread(p).getByLabel('Sending').waitFor({ state: 'detached', timeout: 5000 });
  await p.context().close();
});

await check('Several messages written offline arrive in the order they were written, once each', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats/${cy.id}`);
  await thread(p).getByText('Call me when you are free').waitFor();
  await sleep(800);
  await p.context().setOffline(true);
  await waiting(p).waitFor({ timeout: 6000 });
  const box = p.getByLabel(/^Message Cy/);
  for (let i = 1; i <= 6; i++) {
    await box.fill(`In order ${i}`);
    await box.press('Enter');
  }
  await p.context().setOffline(false);
  const wanted = [1, 2, 3, 4, 5, 6].map((i) => `In order ${i}`).join(' | ');
  let got = '';
  for (let i = 0; i < 40 && got !== wanted; i++) {
    got = (await messagesBetween(cy, ana)).filter((b) => b.startsWith('In order')).join(' | ');
    await sleep(250);
  }
  expect(got === wanted, `the chat has: ${got}`);
  await thread(p).getByLabel('Sending').first().waitFor({ state: 'detached', timeout: 5000 });
  const shown = await thread(p).getByText(/^In order \d$/).allTextContents();
  expect(shown.join(' | ') === wanted, `the app shows: ${shown.join(' | ')}`);
  await p.context().close();
});

if (BUILT) {
  await check('A message written offline still goes after the app is closed and opened again', async () => {
    const p = await appPage(ana, BUILT);
    await p.goto(`${BUILT}/chats/${cy.id}`);
    await thread(p).getByText('Call me when you are free').waitFor();
    await p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
    await p.context().setOffline(true);
    await waiting(p, /Waiting for network…|Connecting…/).waitFor({ timeout: 6000 });
    await p.getByLabel(/^Message Cy/).fill('Survives a restart');
    await p.getByLabel(/^Message Cy/).press('Enter');
    await thread(p).getByLabel('Sending').waitFor({ timeout: 3000 });
    await sleep(1500); // kept on the phone
    await p.goto(`${BUILT}/chats/${cy.id}`);
    await thread(p).getByText('Survives a restart').waitFor({ timeout: 8000 });
    await p.context().setOffline(false);
    let count = 0;
    for (let i = 0; i < 40 && !count; i++) {
      count = (await messagesBetween(cy, ana)).filter((b) => b === 'Survives a restart').length;
      await sleep(250);
    }
    await sleep(1500);
    count = (await messagesBetween(cy, ana)).filter((b) => b === 'Survives a restart').length;
    expect(count === 1, `it arrived ${count} times`);
    await p.context().close();
  });

  await check('The app opens straight onto the chats kept from last time, even with no connection', async () => {
    const p = await appPage(ana, BUILT);
    await p.goto(`${BUILT}/chats/${bo.id}`);
    await thread(p).getByText('Bring the book you mentioned').waitFor();
    // The page is kept by its service worker, the chats in the app's storage.
    await p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
    await p.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('adda-cache-chats')), null, { timeout: 8000 });
    await p.context().setOffline(true);
    await p.goto(`${BUILT}/chats`);
    await p.getByRole('link', { name: /Bo/ }).getByText('Bring the book you mentioned').waitFor({ timeout: 8000 });
    // (A test browser taken offline doesn't always tell a fresh page it is, so it may say "Connecting…".)
    await waiting(p, /Waiting for network…|Connecting…/).waitFor({ timeout: 6000 });
    await p.screenshot({ path: `${SHOTS}feel-3-offline.png` });
    await p.getByRole('link', { name: /Bo/ }).click();
    await thread(p).getByText('Chai at six?').waitFor({ timeout: 4000 });
    expect(!(await p.getByRole('alert').count()), 'an error was shown offline');
    await p.context().setOffline(false);
    await p.context().close();
  });

  await check('A page still running an older version of the site reloads itself once out of sight', async () => {
    const p = await appPage(ana, BUILT);
    // The server says it now hosts a newer page.
    await p.route('**/api/site', async (route) => {
      const r = await route.fetch();
      await route.fulfill({ response: r, json: { ...(await r.json()), build: '/assets/index-newer.js' } });
    });
    await p.goto(`${BUILT}/chats`);
    await p.getByRole('link', { name: /Bo/ }).waitFor();
    await p.evaluate(() => (window.__before = true));
    await sleep(1500);
    expect(await p.evaluate(() => window.__before), 'it reloaded while on screen');
    const reloaded = p.waitForEvent('load', { timeout: 8000 });
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await reloaded;
    expect(!(await p.evaluate(() => window.__before)), 'it did not reload');
    await p.context().close();
  });
} else {
  console.log('SKIP opening offline: build the app first (npm run build)');
}

await check('Logging out leaves nothing kept on the phone', async () => {
  const p = await appPage(ana);
  await p.goto(`${BASE}/chats`);
  await p.getByRole('link', { name: /Bo/ }).waitFor();
  await p.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('adda-cache-chats')), null, { timeout: 8000 });
  await p.getByRole('link', { name: 'You: settings' }).click();
  await p.getByRole('button', { name: 'Log out' }).click();
  await p.getByRole('dialog', { name: 'Log out?' }).getByRole('button', { name: 'Log out' }).click();
  await p.waitForURL(/\/login$/);
  expect(!(await kept(p)).length, `still kept: ${(await kept(p)).join()}`);
  await p.context().close();
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(' -', f[1], ':', f[2]);
  process.exit(1);
}
