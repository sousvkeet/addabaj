import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync, mkdirSync } from 'node:fs';

// Messages: links you can tap, with a card showing the page's title and
// picture; editing a sent message (marked "edited", within the time the host
// allows); forwarding to other chats and rooms (marked "Forwarded", files
// copied). The host admin's Messages settings turn each of them off. Runs
// against the dev servers (npm run dev); run `npm run admin:reset` first (the
// host admin's password is "admin"). The link cards fetch a real page
// (Wikipedia), so this needs the internet.
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

async function call(user, method, path, body, raw) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(user?.cookie ? { cookie: user.cookie } : {}), ...(raw ? raw.headers : body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined,
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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.msgs.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const data = await res.json();
  if (res.status !== 200) throw new Error(`host admin login: ${res.status} ${JSON.stringify(data)} (run npm run admin:reset)`);
  return { name: data.user.name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
function connect(user) {
  const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: user.cookie } });
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const emit = (s, event, payload) =>
  new Promise((resolve) => s.timeout(10_000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: String(err) } : res)));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upload = (user) =>
  call(user, 'POST', '/uploads', undefined, {
    headers: { 'content-type': 'application/octet-stream', 'x-upload-meta': encodeURIComponent(JSON.stringify({ kind: 'image', name: 'p.png', mime: 'image/png', width: 1, height: 1 })) },
    body: PNG,
  });
const setMessaging = (patch) => call(H, 'PATCH', '/admin/messaging', patch);

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const C = await register('Chitra Pal');
const H = await login('admin', 'admin');
const sA = await connect(A);
const sB = await connect(B);
const ROOM = `Links ${stamp}`;
const { data: made } = await call(A, 'POST', '/rooms', { name: ROOM, maxMembers: 6 });
const room = made.room;
await call(A, 'POST', `/rooms/${room.id}/members`, { userId: B.id });
await call(A, 'POST', `/rooms/${room.id}/members`, { userId: C.id });
// C has a chat with A, so it's somewhere to forward to.
await call(C, 'POST', `/dms/${A.id}/messages`, { body: 'Hi Asha!' });
await setMessaging({ linkPreviews: true, editing: true, editMinutes: 15, forwarding: true, forwardTo: 5 });

const browser = await chromium.launch();
async function page(user, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
const bubble = (p, text) => p.getByRole('log').locator('[id^="msg-"]').filter({ hasText: text }).last();
async function more(p, text, item) {
  const b = bubble(p, text);
  await b.hover();
  await b.getByRole('button', { name: 'More actions' }).click();
  await p.getByRole('menuitem', { name: item, exact: true }).click();
}
/** Press and hold a message on a phone (its menu opens). */
async function hold(p, text) {
  const box = await bubble(p, text).locator('span.whitespace-pre-wrap').first().boundingBox();
  const cdp = await p.context().newCDPSession(p);
  const point = { x: box.x + 8, y: box.y + 6 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await sleep(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  return p.getByRole('dialog', { name: 'Message actions' });
}

const pa = await page(A);
const pb = await page(B, true);
const KOLKATA = 'https://en.wikipedia.org/wiki/Kolkata';

try {
  await check('a link can be tapped, and gets a card with the page’s title and picture for both', async () => {
    await pa.goto(`${BASE}/chats/${B.id}`);
    await pb.goto(`${BASE}/chats/${A.id}`);
    await pa.getByLabel('Message Bikram').fill(`Have you seen ${KOLKATA}? Lovely city.`);
    await pa.keyboard.press('Enter');
    const link = pb.getByRole('log').getByRole('link', { name: KOLKATA, exact: true });
    await link.waitFor({ timeout: 8000 });
    expect((await link.getAttribute('target')) === '_blank', 'opens in place');
    expect(/noopener/.test((await link.getAttribute('rel')) ?? ''), 'no rel=noopener');
    // The card: the full stop and "?" aren't part of the address.
    const card = pb.getByRole('log').locator(`a[href="${KOLKATA}"]`).filter({ hasText: 'Kolkata - Wikipedia' });
    await card.waitFor({ timeout: 15_000 });
    await bubble(pa, 'Lovely city').locator('a', { hasText: 'Kolkata - Wikipedia' }).waitFor({ timeout: 5000 });
    const img = card.locator('img');
    if (await img.count()) {
      await pb.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 8000 });
      expect(/^\/api\/previews\//.test((await img.getAttribute('src')) ?? ''), 'the picture isn’t kept on this server');
    }
    await pb.screenshot({ path: `${SHOTS}messages-1-link-card.png` });
  });

  await check('only web links can be tapped; one to a private address gets no card', async () => {
    const sent = await emit(sA, 'dm:send', { to: B.id, body: 'javascript:alert(1) ftp://files.example.com http://localhost:4080/api/health' });
    expect(sent.ok, JSON.stringify(sent));
    const b = bubble(pb, 'javascript:alert(1)');
    await b.waitFor({ timeout: 8000 });
    const hrefs = await b.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length === 1 && hrefs[0] === 'http://localhost:4080/api/health', `links: ${JSON.stringify(hrefs)}`);
    await sleep(2500);
    const { data } = await call(B, 'GET', `/dms/${A.id}/messages`);
    expect(!data.messages.find((m) => m.id === sent.message.id).preview, 'the server fetched a private address');
  });

  await check('editing on a computer: More actions › Edit, then Enter; both see the new text, marked edited', async () => {
    await more(pa, 'Lovely city', 'Edit');
    const box = pa.getByLabel('Edit message');
    await box.waitFor();
    expect((await box.inputValue()) === `Have you seen ${KOLKATA}? Lovely city.`, 'the box doesn’t hold the message');
    await pa.getByText('Editing message').waitFor();
    await box.fill(`Have you seen ${KOLKATA}? Such a lovely city.`);
    await pa.screenshot({ path: `${SHOTS}messages-2-editing.png` });
    await box.press('Enter');
    await bubble(pa, 'Such a lovely city').getByText('edited').waitFor({ timeout: 5000 });
    await bubble(pb, 'Such a lovely city').getByText('edited').waitFor({ timeout: 5000 });
    expect(!(await pb.getByRole('log').getByText('Lovely city.', { exact: false }).filter({ hasNotText: 'Such' }).count()), 'Bikram still sees the old text');
    // The same link: its card stays.
    await bubble(pb, 'Such a lovely city').locator('a', { hasText: 'Kolkata - Wikipedia' }).waitFor();
    await pa.getByLabel('Message Bikram').waitFor();
  });

  await check('Escape stops editing and puts back what was being written', async () => {
    const box = pa.getByLabel('Message Bikram');
    await box.fill('half-written thought');
    await more(pa, 'Such a lovely city', 'Edit');
    await pa.getByLabel('Edit message').press('Escape');
    expect((await pa.getByLabel('Message Bikram').inputValue()) === 'half-written thought', 'the draft was lost');
    await pa.getByLabel('Message Bikram').fill('');
  });

  await check('editing on a phone: press and hold › Edit, then Save changes', async () => {
    await pb.getByLabel('Message Asha').fill('See you at 6');
    await pb.getByRole('button', { name: 'Send message' }).click();
    await bubble(pa, 'See you at 6').waitFor({ timeout: 8000 });
    const sheet = await hold(pb, 'See you at 6');
    await sheet.getByRole('button', { name: 'Edit' }).click();
    await pb.getByLabel('Edit message').fill('See you at 7');
    await pb.getByRole('button', { name: 'Save changes' }).click();
    await bubble(pa, 'See you at 7').getByText('edited').waitFor({ timeout: 5000 });
    await pb.screenshot({ path: `${SHOTS}messages-3-edited-phone.png` });
  });

  await check('someone else’s message has no Edit, and the server refuses it too', async () => {
    const sheet = await hold(pb, 'Such a lovely city');
    await sheet.getByRole('button', { name: 'Reply' }).waitFor();
    expect(!(await sheet.getByRole('button', { name: 'Edit' }).count()), 'Edit offered on Asha’s message');
    await pb.keyboard.press('Escape');
    await pb.goBack().catch(() => {});
    await pb.goto(`${BASE}/chats/${A.id}`);
    const { data } = await call(B, 'GET', `/dms/${A.id}/messages`);
    const hers = data.messages.find((m) => m.body.includes('Such a lovely city'));
    const res = await emit(sB, 'msg:edit', { scope: 'dm', messageId: hers.id, body: 'changed by Bikram' });
    expect(!res.ok, 'edited someone else’s message');
  });

  await check('an edit that changes nothing isn’t saved, nor marked edited', async () => {
    const sent = await emit(sA, 'dm:send', { to: B.id, body: 'Same as before' });
    const res = await emit(sA, 'msg:edit', { scope: 'dm', messageId: sent.message.id, body: '  Same as before  ' });
    expect(res.ok && !res.editedAt && res.body === 'Same as before', JSON.stringify(res));
    const { data } = await call(B, 'GET', `/dms/${A.id}/messages`);
    expect(!data.messages.find((m) => m.id === sent.message.id).editedAt, 'marked edited');
  });

  await check('a mention still names them after an edit', async () => {
    const members = (await call(A, 'GET', `/rooms/${room.id}`)).data.room.members;
    const rahul = members.find((m) => m.id === B.id);
    const body = `@${rahul.name} lunch?`;
    const sent = await emit(sA, 'room:send', { roomId: room.id, body, mentions: [{ id: B.id, offset: 0, length: rahul.name.length + 1 }] });
    expect(sent.ok, JSON.stringify(sent));
    await pa.goto(`${BASE}/rooms/${room.id}`);
    await more(pa, 'lunch?', 'Edit');
    const box = pa.getByLabel('Edit message');
    await box.fill(`@${rahul.name} lunch at 1?`);
    await box.press('Enter');
    await bubble(pa, 'lunch at 1?').getByText('edited').waitFor({ timeout: 5000 });
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await bubble(pb, 'lunch at 1?').locator('[data-mention="me"]').waitFor({ timeout: 8000 });
  });

  await check('forwarding a photo with its caption to a chat and a room: copies arrive marked Forwarded, each with its own file', async () => {
    const up = await upload(A);
    const sent = await emit(sA, 'dm:send', { to: B.id, body: 'The view from the bridge', attachmentId: up.data.attachment.id });
    expect(sent.ok, JSON.stringify(sent));
    await pa.goto(`${BASE}/chats/${B.id}`);
    await more(pa, 'The view from the bridge', 'Forward');
    const dlg = pa.getByRole('dialog', { name: 'Forward message' });
    await dlg.getByRole('checkbox', { name: /Chitra Pal/ }).click();
    await dlg.getByRole('checkbox', { name: new RegExp(ROOM) }).click();
    await pa.screenshot({ path: `${SHOTS}messages-4-forward.png` });
    await dlg.getByRole('button', { name: 'Forward' }).click();
    await pa.getByText('Forwarded to 2 chats').waitFor({ timeout: 8000 });
    const pc = await page(C);
    await pc.goto(`${BASE}/chats/${A.id}`);
    const copy = bubble(pc, 'The view from the bridge');
    await copy.getByText('Forwarded').waitFor({ timeout: 8000 });
    const src = await copy.locator('img').first().getAttribute('src');
    expect(src && src !== up.data.attachment.url, 'the copy shares the original’s file');
    await pc.goto(`${BASE}/rooms/${room.id}`);
    await bubble(pc, 'The view from the bridge').getByText('Forwarded').waitFor({ timeout: 8000 });
    // The original deleted for everyone: the copies keep their pictures.
    const del = await emit(sA, 'msg:delete', { scope: 'dm', messageId: sent.message.id, forEveryone: true });
    expect(del.ok, JSON.stringify(del));
    expect((await call(C, 'GET', src.replace(/^\/api/, ''))).status === 200, 'the copy’s picture went with the original');
    await pc.context().close();
  });

  await check('the host’s limit: choosing more chats than allowed says so', async () => {
    await setMessaging({ forwardTo: 1 });
    await pa.reload();
    await more(pa, 'Such a lovely city', 'Forward');
    const dlg = pa.getByRole('dialog', { name: 'Forward message' });
    await dlg.getByText('Choose up to 1 chat or room.').waitFor({ timeout: 5000 });
    await dlg.getByRole('checkbox', { name: /Chitra Pal/ }).click();
    await dlg.getByRole('checkbox', { name: new RegExp(ROOM) }).click();
    await pa.getByText('You can forward a message to up to 1 chat at a time.').waitFor();
    expect((await dlg.getByRole('checkbox', { checked: true }).count()) === 1, 'more than the limit were chosen');
    await pa.keyboard.press('Escape');
    await setMessaging({ forwardTo: 5 });
  });

  await check('the host turns editing and forwarding off in Site settings: open apps stop offering them at once, and the server refuses', async () => {
    const ph = await page(H);
    await ph.goto(`${BASE}/admin/settings`);
    const panel = ph.locator('section', { has: ph.getByRole('heading', { name: 'Messages' }) }).last();
    await panel.getByRole('switch', { name: /Editing/ }).waitFor({ state: 'attached' });
    await panel.getByText('Editing', { exact: true }).click();
    await ph.getByText("Editing is off. People can't change messages they've sent.").waitFor();
    await panel.getByText('Forwarding', { exact: true }).click();
    await ph.getByText('Forwarding is off.').waitFor();
    await ph.screenshot({ path: `${SHOTS}messages-5-site-settings.png` });
    await ph.context().close();
    // Asha's page is still open from before (no reload).
    const b = bubble(pa, 'Such a lovely city');
    await b.hover();
    await b.getByRole('button', { name: 'More actions' }).click();
    await pa.getByRole('menuitem', { name: 'Message info' }).waitFor();
    expect(!(await pa.getByRole('menuitem', { name: 'Edit', exact: true }).count()), 'Edit still offered');
    expect(!(await pa.getByRole('menuitem', { name: 'Forward', exact: true }).count()), 'Forward still offered');
    await pa.keyboard.press('Escape');
    const { data } = await call(A, 'GET', `/dms/${B.id}/messages`);
    const mine = data.messages.find((m) => m.body.includes('Such a lovely city'));
    expect(/turned off/.test((await emit(sA, 'msg:edit', { scope: 'dm', messageId: mine.id, body: 'x' })).error ?? ''), 'edit not refused');
    expect(/turned off/.test((await emit(sA, 'msg:forward', { scope: 'dm', messageId: mine.id, to: [{ scope: 'dm', id: C.id }] })).error ?? ''), 'forward not refused');
    await setMessaging({ editing: true, forwarding: true });
  });

  await check('the host turns link previews off: new links get no card', async () => {
    await setMessaging({ linkPreviews: false });
    const sent = await emit(sA, 'dm:send', { to: B.id, body: 'https://en.wikipedia.org/wiki/Howrah_Bridge' });
    expect(sent.ok, JSON.stringify(sent));
    await sleep(4000);
    const { data } = await call(B, 'GET', `/dms/${A.id}/messages`);
    expect(!data.messages.find((m) => m.id === sent.message.id).preview, 'a card was made');
    await setMessaging({ linkPreviews: true });
  });
} finally {
  await setMessaging({ linkPreviews: true, editing: true, editMinutes: 15, forwarding: true, forwardTo: 5 }).catch(() => {});
  sA.close();
  sB.close();
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
