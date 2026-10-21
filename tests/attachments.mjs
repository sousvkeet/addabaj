import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

// Photos, files, voice messages, replies and reactions, in chats and rooms.
// Runs against the dev servers (npm run dev).
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

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

async function user(name, phone = false) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && console.log(`[${name} console]`, m.text()));
  return { name, page, email: `${name.toLowerCase()}.${stamp}@example.com` };
}

async function signup(u, fullName) {
  await u.page.goto(`${BASE}/signup`);
  await u.page.getByLabel('Your name').fill(fullName);
  await u.page.getByLabel('Email').fill(u.email);
  await u.page.getByLabel('Password').fill('password123');
  await u.page.getByRole('button', { name: 'Create account' }).click();
  await u.page.waitForURL(`${BASE}/chats`);
  u.id = await u.page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id);
}

const api = (page, path, init) =>
  page.evaluate(
    async ([path, init]) => {
      const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      return { status: res.status, data: await res.json().catch(() => null) };
    },
    [path, init],
  );

/** A message bubble (the row with its actions), found by text inside it. */
const message = (page, text) => page.getByRole('log').locator('[id^="msg-"]').filter({ hasText: text }).last();
const thread = (page) => page.getByRole('log');
const noSideScroll = async (page) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) throw new Error(`page scrolls sideways by ${over}px`);
};

const A = await user('Asha');
const B = await user('Rahul');
const C = await user('Mitali', true);
const D = await user('Outsider');

await check('four people sign up', async () => {
  await signup(A, 'Asha Sen');
  await signup(B, 'Rahul Das');
  await signup(C, 'Mitali Roy');
  await signup(D, 'Out Sider');
});

// A big, detailed photo: should be shrunk to 2048px on the long side before upload.
const photo = Buffer.from(
  await A.page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 2600;
    c.height = 1700;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 2600, 1700);
    grad.addColorStop(0, '#f2a900');
    grad.addColorStop(1, '#15362f');
    g.fillStyle = grad;
    g.fillRect(0, 0, 2600, 1700);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `hsl(${i % 360} 70% 50%)`;
      g.fillRect(Math.random() * 2600, Math.random() * 1700, 30, 30);
    }
    return c.toDataURL('image/png').split(',')[1];
  }),
  'base64',
);
const smallPng = Buffer.from(
  await A.page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const g = c.getContext('2d');
    g.fillStyle = '#c0392b';
    g.fillRect(0, 0, 320, 240);
    return c.toDataURL('image/png').split(',')[1];
  }),
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\n% Adda test file\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const video = readFileSync(new URL('./fixtures/count-40s.webm', import.meta.url));

let photoUrl = '';

await check('Asha attaches a large photo with a caption; it is shrunk, and Rahul gets it live', async () => {
  await A.page.goto(`${BASE}/chats/${B.id}`);
  await B.page.goto(`${BASE}/chats/${A.id}`);
  await A.page.locator('input[type=file]').setInputFiles({ name: 'pandal.png', mimeType: 'image/png', buffer: photo });
  await A.page.getByRole('list', { name: 'Files to send' }).getByRole('img').waitFor({ timeout: 8000 });
  await A.page.getByLabel('Caption').fill('Puja pandal');
  await A.page.screenshot({ path: `${SHOTS}att-01-tray.png` });
  await A.page.getByLabel('Caption').press('Enter');
  const img = thread(B.page).getByRole('img', { name: /^pandal\.(webp|jpg)$/ });
  await img.waitFor({ timeout: 10000 });
  await thread(B.page).getByText('Puja pandal').waitFor();
  await B.page.waitForFunction(() => [...document.querySelectorAll('[role=log] img')].some((i) => i.complete && i.naturalWidth > 0));
  photoUrl = await img.getAttribute('src');
  const width = await img.evaluate((i) => i.naturalWidth);
  if (width !== 2048) throw new Error(`photo is ${width}px wide, expected 2048`);
  if (!photoUrl.startsWith('/api/files/')) throw new Error(`photo src ${photoUrl}`);
});

await check('Rahul opens the photo full screen and closes it with Escape', async () => {
  await thread(B.page).getByRole('button', { name: /Open photo/ }).click();
  const dlg = B.page.getByRole('dialog', { name: /pandal/ });
  await dlg.getByRole('link', { name: 'Download' }).waitFor();
  await B.page.screenshot({ path: `${SHOTS}att-02-lightbox.png` });
  await B.page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
});

await check('a file arrives as a card with a download that saves it (never opens inline)', async () => {
  await A.page.locator('input[type=file]').setInputFiles({ name: 'menu.pdf', mimeType: 'application/pdf', buffer: pdf });
  await A.page.getByRole('list', { name: 'Files to send' }).getByText('menu.pdf').waitFor();
  await A.page.getByRole('button', { name: 'Send message' }).click();
  const link = thread(B.page).getByRole('link', { name: 'Download menu.pdf' });
  await link.waitFor({ timeout: 8000 });
  const href = await link.getAttribute('href');
  const head = await B.page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, disposition: r.headers.get('content-disposition'), type: r.headers.get('content-type') };
  }, href);
  if (head.status !== 200 || !/^attachment/.test(head.disposition) || head.type !== 'application/octet-stream') {
    throw new Error(JSON.stringify(head));
  }
});

await check('a video plays inline for Rahul', async () => {
  await A.page.locator('input[type=file]').setInputFiles({ name: 'count.webm', mimeType: 'video/webm', buffer: video });
  await A.page.getByRole('list', { name: 'Files to send' }).locator('video').waitFor({ timeout: 8000 });
  await A.page.getByRole('button', { name: 'Send message' }).click();
  const v = thread(B.page).locator('video');
  await v.waitFor({ timeout: 10000 });
  await B.page.waitForFunction(() => {
    const v = document.querySelector('[role=log] video');
    return v && v.readyState >= 1 && v.duration > 30;
  }, null, { timeout: 10000 });
});

await check('pasting an image adds it to the tray', async () => {
  await A.page.getByLabel('Message Rahul').focus();
  await A.page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, smallPng.toString('base64'));
  await A.page.getByRole('list', { name: 'Files to send' }).getByRole('img', { name: 'pasted.png' }).waitFor({ timeout: 5000 });
  await A.page.getByRole('button', { name: 'Remove pasted.png' }).click();
  await A.page.getByRole('list', { name: 'Files to send' }).waitFor({ state: 'detached' });
});

await check('dragging a file over the chat shows "Drop to send", and dropping adds it', async () => {
  const dt = await A.page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    return dt;
  }, smallPng.toString('base64'));
  const log = thread(A.page);
  await log.dispatchEvent('dragenter', { dataTransfer: dt });
  await A.page.getByText('Drop to send').waitFor();
  await A.page.screenshot({ path: `${SHOTS}att-03-drop.png` });
  await log.dispatchEvent('drop', { dataTransfer: dt });
  await A.page.getByText('Drop to send').waitFor({ state: 'detached' });
  await A.page.getByRole('list', { name: 'Files to send' }).getByRole('img', { name: 'dropped.png' }).waitFor({ timeout: 5000 });
  await A.page.getByRole('button', { name: 'Send message' }).click();
  await thread(B.page).getByRole('img', { name: 'dropped.png' }).waitFor({ timeout: 8000 });
});

await check('Asha records a voice message; Rahul plays it', async () => {
  await A.page.getByRole('button', { name: 'Record a voice message' }).click();
  await A.page.getByText('Recording a voice message').waitFor();
  await A.page.waitForTimeout(2600);
  await A.page.screenshot({ path: `${SHOTS}att-04-recording.png` });
  await A.page.getByRole('button', { name: 'Send voice message' }).click();
  const play = thread(B.page).getByRole('button', { name: 'Play voice message' });
  await play.waitFor({ timeout: 10000 });
  const shown = await play.locator('xpath=..').innerText();
  if (!/0:0[2-3]/.test(shown)) throw new Error(`voice length shown as ${JSON.stringify(shown)}`);
  await play.click();
  await B.page.waitForFunction(() => {
    const a = document.querySelector('[role=log] audio');
    return a && a.currentTime > 0.5;
  }, null, { timeout: 8000 });
  await thread(B.page).getByRole('button', { name: 'Pause voice message' }).click();
});

await check('Rahul replies to the photo; both see the quote, and tapping it jumps to the photo', async () => {
  const msg = message(B.page, 'Puja pandal');
  await msg.hover();
  await msg.getByRole('button', { name: 'Reply', exact: true }).click();
  await B.page.getByText('Replying to Asha Sen').waitFor();
  await B.page.getByLabel('Message Asha').fill('Darun!');
  await B.page.screenshot({ path: `${SHOTS}att-05-reply-bar.png` });
  await B.page.getByLabel('Message Asha').press('Enter');
  await B.page.getByText('Replying to Asha Sen').waitFor({ state: 'detached' });
  const reply = message(A.page, 'Darun!');
  await reply.waitFor({ timeout: 5000 });
  const quote = reply.getByRole('button', { name: /^You\s*Puja pandal/ });
  await quote.waitFor();
  await message(B.page, 'Darun!').getByRole('button', { name: /^Asha Sen\s*Puja pandal/ }).waitFor();
  await quote.click();
  await A.page.waitForFunction(() => [...document.querySelectorAll('[id^="msg-"]')].some((el) => el.classList.contains('flash')));
});

await check('reactions: Asha reacts ❤️, Rahul adds his, Asha takes hers back', async () => {
  const msg = message(A.page, 'Darun!');
  await msg.hover();
  await msg.getByRole('button', { name: 'React', exact: true }).click();
  await A.page.getByRole('menuitem', { name: 'React ❤️' }).click();
  const chipB = message(B.page, 'Darun!').getByRole('button', { name: '❤️ 1' });
  await chipB.waitFor({ timeout: 5000 });
  await chipB.click();
  await message(A.page, 'Darun!').getByRole('button', { name: '❤️ 2, including you' }).waitFor({ timeout: 5000 });
  await A.page.screenshot({ path: `${SHOTS}att-06-reactions.png` });
  await message(A.page, 'Darun!').getByRole('button', { name: '❤️ 2, including you' }).click();
  await message(B.page, 'Darun!').getByRole('button', { name: '❤️ 1, including you' }).waitFor({ timeout: 5000 });
});

await check('a failed upload shows "Not sent", and retry sends it without picking the file again', async () => {
  let blocked = 0;
  await A.page.route('**/api/uploads', (route) => (blocked++ ? route.continue() : route.abort()));
  await A.page.locator('input[type=file]').setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: smallPng });
  await A.page.getByRole('list', { name: 'Files to send' }).getByRole('img').waitFor();
  await A.page.getByRole('button', { name: 'Send message' }).click();
  await thread(A.page).getByRole('button', { name: 'Not sent. Tap to retry' }).click({ timeout: 8000 });
  await thread(B.page).getByRole('img', { name: 'retry.png' }).waitFor({ timeout: 8000 });
  await A.page.unroute('**/api/uploads');
  if (await thread(A.page).getByText('Not sent').count()) throw new Error('still marked as not sent');
});

await check('a file over the size limit is refused before uploading, with a clear message', async () => {
  await A.page.locator('input[type=file]').setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(26 * 1024 * 1024, 1) });
  await A.page.getByText(/“huge\.bin” is 26 MB\. Files can be up to 25 MB\./).waitFor({ timeout: 8000 });
});

await check('history after reload keeps photo, reply quote and reactions', async () => {
  await B.page.reload();
  await thread(B.page).getByRole('img', { name: /^pandal\./ }).waitFor({ timeout: 8000 });
  await message(B.page, 'Darun!').getByRole('button', { name: /^Asha Sen\s*Puja pandal/ }).waitFor();
  await message(B.page, 'Darun!').getByRole('button', { name: '❤️ 1, including you' }).waitFor();
  await B.page.screenshot({ path: `${SHOTS}att-07-chat.png` });
});

await check('people outside the chat cannot open its files', async () => {
  const r = await D.page.evaluate(async (u) => (await fetch(u)).status, photoUrl);
  if (r !== 404) throw new Error(`outsider got ${r}`);
  const loggedOut = await (await fetch(`${BASE}${photoUrl}`)).status;
  if (loggedOut !== 401) throw new Error(`logged-out request got ${loggedOut}`);
});

// ── Rooms ──

let roomId = '';
await check('in a room, a photo reaches every member, and the room list says "Photo"', async () => {
  const { data } = await api(A.page, '/rooms', { method: 'POST', body: JSON.stringify({ name: `Para adda ${stamp}`, maxMembers: 5 }) });
  roomId = data.room.id;
  for (const u of [B, C]) {
    const r = await api(A.page, `/rooms/${roomId}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id }) });
    if (r.status >= 300) throw new Error(`adding ${u.name}: ${r.status}`);
  }
  await A.page.goto(`${BASE}/rooms/${roomId}`);
  await C.page.goto(`${BASE}/rooms/${roomId}`);
  await A.page.locator('input[type=file]').setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: smallPng });
  await A.page.getByRole('list', { name: 'Files to send' }).getByRole('img').waitFor();
  await A.page.getByRole('button', { name: 'Send message' }).click();
  await thread(C.page).getByRole('img', { name: 'room.png' }).waitFor({ timeout: 8000 });
  const src = await thread(C.page).getByRole('img', { name: 'room.png' }).getAttribute('src');
  const status = await C.page.evaluate(async (u) => (await fetch(u)).status, src);
  if (status !== 200) throw new Error(`member got ${status}`);
  const outsider = await D.page.evaluate(async (u) => (await fetch(u)).status, src);
  if (outsider !== 404) throw new Error(`outsider got ${outsider} for a room file`);
  await B.page.goto(`${BASE}/rooms`);
  await B.page.getByRole('link', { name: new RegExp(`Para adda ${stamp}`) }).getByText('Asha: Photo').waitFor({ timeout: 5000 });
});

await check('on a phone, press and hold opens the action sheet; react and reply from it', async () => {
  const bubble = thread(C.page)
    .locator('[id^="msg-"]')
    .filter({ has: C.page.getByRole('img', { name: 'room.png' }) })
    .locator('.select-text');
  const box = await bubble.boundingBox();
  const at = { pointerType: 'touch', isPrimary: true, clientX: box.x + 20, clientY: box.y + 20 };
  await bubble.dispatchEvent('pointerdown', at);
  await C.page.waitForTimeout(650);
  await bubble.dispatchEvent('pointerup', at);
  const sheet = C.page.getByRole('dialog', { name: 'Message actions' });
  await sheet.waitFor({ timeout: 3000 });
  await C.page.screenshot({ path: `${SHOTS}att-08-phone-sheet.png` });
  await sheet.getByRole('button', { name: 'React 😂' }).click();
  await thread(A.page)
    .locator('[id^="msg-"]')
    .filter({ has: A.page.getByRole('img', { name: 'room.png' }) })
    .getByRole('button', { name: '😂 1' })
    .waitFor({ timeout: 5000 });

  await bubble.dispatchEvent('pointerdown', at);
  await C.page.waitForTimeout(650);
  await bubble.dispatchEvent('pointerup', at);
  await sheet.getByRole('button', { name: 'Reply' }).click();
  await C.page.getByText('Replying to Asha Sen').waitFor();
  await C.page.getByLabel(/^Message Para adda/).fill('Kothay eta?');
  await C.page.getByLabel(/^Message Para adda/).press('Enter');
  await message(A.page, 'Kothay eta?').getByRole('button', { name: /^You\s*Photo/ }).waitFor({ timeout: 5000 });
  await noSideScroll(C.page);
  await C.page.screenshot({ path: `${SHOTS}att-09-phone-room.png` });
});

await check('a voice message in a room (phone) reaches the others', async () => {
  await C.page.getByRole('button', { name: 'Record a voice message' }).click();
  await C.page.getByText('Recording a voice message').waitFor();
  await C.page.waitForTimeout(1500);
  await noSideScroll(C.page);
  await C.page.getByRole('button', { name: 'Send voice message' }).click();
  await thread(A.page).getByRole('button', { name: 'Play voice message' }).waitFor({ timeout: 8000 });
});

await check('the chat list shows "You: Darun!" style previews for attachments too', async () => {
  await A.page.goto(`${BASE}/chats`);
  // Rahul's last message was the reply "Darun!"; Asha's last was the retried photo — whichever is newer shows.
  await A.page.getByRole('link', { name: /Rahul Das/ }).getByText(/Photo|Darun!/).waitFor({ timeout: 5000 });
});

await A.page.goto(`${BASE}/chats/${B.id}`);
await A.page.evaluate(() => {
  document.documentElement.dataset.theme = 'dark';
});
await thread(A.page).getByRole('img', { name: /^pandal\./ }).waitFor({ timeout: 8000 });
await A.page.screenshot({ path: `${SHOTS}att-10-dark.png` });

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAIL', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
