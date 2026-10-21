import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// Sent / delivered / read ticks, "Seen by" in rooms, message info, last seen,
// and the two privacy switches. Runs against the dev servers (npm run dev).
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);

const browser = await chromium.launch();
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
  });
  const u = { name, ctx, email: `${name.split(' ')[0].toLowerCase()}.${stamp}@example.com` };
  u.open = async () => {
    u.page = await ctx.newPage();
    u.page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
    return u.page;
  };
  await u.open();
  return u;
}

async function signup(u) {
  await u.page.goto(`${BASE}/signup`);
  await u.page.getByLabel('Your name').fill(u.name);
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

/** My message bubble, found by its text. */
const bubble = (page, text) => page.getByRole('log').locator('[id^="msg-"]').filter({ hasText: text }).last();
const tick = (page, text, state) => bubble(page, text).getByLabel(state, { exact: true });
const header = (page) => page.locator('header').first();

async function send(page, label, text) {
  await page.getByLabel(label).fill(text);
  await page.getByLabel(label).press('Enter');
}

const A = await user('Asha Sen');
const B = await user('Rahul Das');
const C = await user('Mitali Roy', true);

await check('three people sign up', async () => {
  await signup(A);
  await signup(B);
  await signup(C);
});

// ── One-to-one ──

await check('to someone offline a message shows one tick (sent)', async () => {
  await B.page.close(); // Rahul is offline now
  await A.page.goto(`${BASE}/chats/${B.id}`);
  await send(A.page, 'Message Rahul', 'Are you there?');
  await tick(A.page, 'Are you there?', 'Sent').waitFor({ timeout: 8000 });
  await header(A.page).getByText(/Last seen/).waitFor({ timeout: 8000 });
});

await check('when they come online it turns into two ticks (delivered), live', async () => {
  // Several waiting messages from the same person are all marked delivered.
  await send(A.page, 'Message Rahul', 'Hello?');
  await tick(A.page, 'Hello?', 'Sent').waitFor({ timeout: 8000 });
  await B.open();
  await B.page.goto(`${BASE}/chats`);
  await tick(A.page, 'Are you there?', 'Delivered').waitFor({ timeout: 8000 });
  await tick(A.page, 'Hello?', 'Delivered').waitFor({ timeout: 8000 });
  await header(A.page).getByText('Online').waitFor({ timeout: 8000 });
});

await check('to someone online, a message is delivered at once', async () => {
  await send(A.page, 'Message Rahul', 'Movie at 9?');
  await tick(A.page, 'Movie at 9?', 'Delivered').waitFor({ timeout: 8000 });
  // The chat list shows where my last message has got to.
  await A.page.getByRole('link', { name: /Rahul Das/ }).getByLabel('Delivered').waitFor();
});

await check('when they open the chat both messages turn to read ticks', async () => {
  await B.page.getByRole('link', { name: /Asha Sen/ }).click();
  await tick(A.page, 'Movie at 9?', 'Read').waitFor({ timeout: 8000 });
  await tick(A.page, 'Are you there?', 'Read').waitFor({ timeout: 8000 });
  await A.page.screenshot({ path: `${SHOTS}receipts-01-chat.png` });
});

await check('message info shows when it was delivered and read', async () => {
  const msg = bubble(A.page, 'Movie at 9?');
  await msg.hover();
  await msg.getByRole('button', { name: 'Message info' }).click();
  const dlg = A.page.getByRole('dialog', { name: 'Message info' });
  await dlg.getByText(/^Today, /).first().waitFor();
  const text = await dlg.innerText();
  if (!/Read\s+Today/.test(text) || !/Delivered to Rahul Das\s+Today/.test(text)) throw new Error(`info said: ${text.replace(/\s+/g, ' ')}`);
  await A.page.screenshot({ path: `${SHOTS}receipts-02-info.png` });
  await A.page.keyboard.press('Escape');
});

await check('last seen: closing the app shows "Last seen just now", coming back shows "Online"', async () => {
  await B.page.close();
  await header(A.page).getByText('Last seen just now').waitFor({ timeout: 8000 });
  await B.open();
  await B.page.goto(`${BASE}/chats/${A.id}`);
  await header(A.page).getByText('Online').waitFor({ timeout: 8000 });
});

// ── Privacy ──

async function setPrivacy(u, label, on) {
  await u.page.getByRole('button', { name: 'Your account' }).click();
  await u.page.getByRole('menuitem', { name: /Privacy/ }).click();
  const dlg = u.page.getByRole('dialog', { name: 'Privacy' });
  const sw = dlg.getByRole('switch', { name: new RegExp(label) });
  // The switch itself is visually hidden; its label toggles it.
  if ((await sw.isChecked()) !== on) await dlg.locator('label').filter({ hasText: new RegExp(`^${label}`) }).click();
  await u.page.waitForFunction(
    ([key, want]) => fetch('/api/auth/me').then((r) => r.json()).then((d) => d.user.privacy[key] === want),
    [label.startsWith('Read') ? 'readReceipts' : 'sharePresence', on],
  );
  await u.page.keyboard.press('Escape');
}

await check('read receipts off: the sender only sees "delivered", and it works both ways', async () => {
  await setPrivacy(B, 'Read receipts', false);
  await B.page.goto(`${BASE}/chats`);
  await send(A.page, 'Message Rahul', 'Did you read this?');
  await tick(A.page, 'Did you read this?', 'Delivered').waitFor({ timeout: 8000 });
  await B.page.getByRole('link', { name: /Asha Sen/ }).click();
  await B.page.getByRole('log').getByText('Did you read this?').waitFor();
  await A.page.waitForTimeout(2000);
  if (await tick(A.page, 'Did you read this?', 'Read').count()) throw new Error('the read tick showed though Rahul turned receipts off');
  // Reloading must not reveal it either.
  await A.page.reload();
  await tick(A.page, 'Did you read this?', 'Delivered').waitFor({ timeout: 8000 });
  // Rahul doesn't see when Asha reads his messages.
  await send(B.page, 'Message Asha', 'Yes I did');
  await A.page.getByRole('log').getByText('Yes I did').waitFor();
  await B.page.waitForTimeout(2000);
  if (await tick(B.page, 'Yes I did', 'Read').count()) throw new Error('Rahul saw a read tick with his receipts off');
  await setPrivacy(B, 'Read receipts', true);
});

await check('last seen hidden: nobody sees Rahul’s status, and he doesn’t see theirs', async () => {
  await setPrivacy(B, 'Show when', false);
  await A.page.goto(`${BASE}/chats/${B.id}`);
  await A.page.getByRole('log').waitFor();
  await A.page.waitForTimeout(1500);
  const aStatus = await header(A.page).innerText();
  if (/Online|Last seen/.test(aStatus)) throw new Error(`Asha still sees: ${aStatus.replace(/\s+/g, ' ')}`);
  await B.page.goto(`${BASE}/chats/${A.id}`);
  await B.page.getByRole('log').waitFor();
  await B.page.waitForTimeout(1500);
  const bStatus = await header(B.page).innerText();
  if (/Online|Last seen/.test(bStatus)) throw new Error(`Rahul still sees: ${bStatus.replace(/\s+/g, ' ')}`);
  const fromApi = (await api(A.page, `/users/${B.id}`)).data.user;
  if (fromApi.online || fromApi.lastSeenAt) throw new Error(`the API still reveals it: ${JSON.stringify(fromApi)}`);
  await setPrivacy(B, 'Show when', true);
  await header(A.page).getByText('Online').waitFor({ timeout: 8000 });
});

// ── Rooms ──

let roomId = '';
await check('in a room: sent, then delivered when everyone’s app has it, then "Seen by" and read', async () => {
  const { data } = await api(A.page, '/rooms', { method: 'POST', body: JSON.stringify({ name: `Receipts ${stamp}`, maxMembers: 5 }) });
  roomId = data.room.id;
  for (const u of [B, C]) await api(A.page, `/rooms/${roomId}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id }) });
  await C.page.close(); // Mitali offline
  await B.page.goto(`${BASE}/chats`); // Rahul online, not in the room
  await A.page.goto(`${BASE}/rooms/${roomId}`);
  await send(A.page, `Message Receipts ${stamp}`, 'Who is coming?');
  await tick(A.page, 'Who is coming?', 'Sent').waitFor({ timeout: 8000 });
  await C.open();
  await C.page.goto(`${BASE}/rooms`);
  await tick(A.page, 'Who is coming?', 'Delivered').waitFor({ timeout: 8000 });
  await B.page.goto(`${BASE}/rooms/${roomId}`);
  await A.page.getByRole('button', { name: 'Seen by Rahul' }).waitFor({ timeout: 8000 });
  await C.page.goto(`${BASE}/rooms/${roomId}`);
  await C.page.getByRole('log').getByText('Who is coming?').waitFor({ timeout: 8000 });
  await A.page.getByRole('button', { name: /^Seen by (Rahul and Mitali|Mitali and Rahul)$/ }).waitFor({ timeout: 8000 });
  await tick(A.page, 'Who is coming?', 'Read').waitFor({ timeout: 8000 });
  await A.page.screenshot({ path: `${SHOTS}receipts-03-room.png` });
});

await check('room message info lists who read it', async () => {
  await A.page.getByRole('button', { name: /^Seen by (Rahul and Mitali|Mitali and Rahul)$/ }).click();
  const dlg = A.page.getByRole('dialog', { name: 'Message info' });
  await dlg.getByText('Read by').waitFor();
  await dlg.getByText('Rahul Das').waitFor();
  await dlg.getByText('Mitali Roy').waitFor();
  await A.page.screenshot({ path: `${SHOTS}receipts-04-room-info.png` });
  await A.page.keyboard.press('Escape');
});

await check('room members show online / last seen in the panel', async () => {
  await C.page.close();
  const panel = A.page.locator('aside').filter({ hasText: 'Members' });
  await panel.getByText('Online').first().waitFor({ timeout: 8000 });
  await panel.getByText(/Last seen just now/).waitFor({ timeout: 8000 });
  await C.open();
});

await check('nobody can fake reading ahead, or see info for someone else’s message', async () => {
  // Rahul leaves the room, then claims to have read a message far in the future.
  await B.page.goto(`${BASE}/chats`);
  await B.page.waitForTimeout(500);
  await B.page.evaluate((r) => new Promise((done) => window.adda.socket.emit('room:read', { roomId: r, messageId: 9e12 }, done)), roomId);
  await send(A.page, `Message Receipts ${stamp}`, 'After the fake read');
  await A.page.waitForTimeout(1500);
  if (await A.page.getByRole('button', { name: /Seen by Rahul/ }).count()) {
    const text = await A.page.getByRole('button', { name: /Seen by/ }).innerText().catch(() => '');
    if (/Rahul/.test(text)) throw new Error('a fake read marked a future message as seen');
  }
  const ids = await api(A.page, `/rooms/${roomId}/messages`);
  const asha = ids.data.messages.find((m) => m.body === 'After the fake read');
  const other = await api(B.page, `/rooms/${roomId}/messages/${asha.id}/info`);
  if (other.status !== 403) throw new Error(`info on someone else's message answered ${other.status}`);
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAIL', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
