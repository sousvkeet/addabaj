import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync } from 'node:fs';

// Finding people and joining rooms: nobody is listed; people are found by exact
// user ID or email; strangers don't get each other's online status;
// rooms are joined with an invite code, open or with a password. Runs against
// the dev servers (npm run dev).
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
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

async function call(user, method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(user?.cookie ? { cookie: user.cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data };
}

async function register(name) {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${stamp}@example.com`;
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, email, id: data.user.id, handle: data.user.handle, cookie: res.headers.get('set-cookie').split(';')[0] };
}

async function connect(user) {
  const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: user.cookie } });
  s.events = [];
  s.onAny((event, ...args) => s.events.push({ event, data: args[0] }));
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  await sleep(300);
  return s;
}

const ana = await register('Ana Rahman');
const bo = await register('Bo Chowdhury');
const cy = await register('Cy Stranger');

// ── People ────────────────────────────────────────────────────────────

await check('Everyone gets a user ID; nobody is listed anywhere', async () => {
  expect(/^ana\.rahman\d{4}$/.test(ana.handle), `Ana's ID: ${ana.handle}`);
  expect(/^bo\.chowdhury\d{4}$/.test(bo.handle), `Bo's ID: ${bo.handle}`);
  expect((await call(ana, 'GET', '/users')).status === 404, 'GET /users still answers');
  expect((await call(ana, 'GET', '/users?q=')).status === 404, 'the old search still answers');
  expect((await call(ana, 'GET', '/users/find?q=')).status === 400, 'an empty search answered');
  expect((await call(null, 'GET', `/users/find?q=${bo.handle}`)).status === 401, 'signed-out lookup allowed');
});

await check('Found by exact user ID (any case, with or without @) or exact email; nothing partial', async () => {
  for (const q of [bo.handle, `@${bo.handle}`, bo.handle.toUpperCase(), bo.email, bo.email.toUpperCase()]) {
    const r = await call(ana, 'GET', `/users/find?q=${encodeURIComponent(q)}`);
    expect(r.status === 200 && r.data.user.id === bo.id, `"${q}" → ${r.status} ${JSON.stringify(r.data)}`);
  }
  for (const q of ['bo', 'chowdhury', bo.handle.slice(0, -1), bo.email.split('@')[0], `${bo.email}x`]) {
    const r = await call(ana, 'GET', `/users/find?q=${encodeURIComponent(q)}`);
    expect(r.status === 404 || r.status === 400, `partial "${q}" found someone (${r.status})`);
  }
  const me = await call(ana, 'GET', `/users/find?q=${ana.handle}`);
  expect(me.status === 400 && /you/.test(me.data.error), 'finding yourself');
  const nobody = await call(ana, 'GET', '/users/find?q=nobody.here.9999');
  expect(nobody.status === 404 && /No one/.test(nobody.data.error), `not found: ${JSON.stringify(nobody.data)}`);
});

await check('Strangers don’t see each other online (only contacts get your status)', async () => {
  const cySock = await connect(cy);
  const anaSock = await connect(ana);
  await sleep(500);
  const snap = cySock.events.find((e) => e.event === 'presence:snapshot');
  expect(snap && !snap.data.online.includes(ana.id), `Cy sees: ${JSON.stringify(snap?.data)}`);
  expect(!cySock.events.some((e) => e.event === 'presence:update' && e.data.userId === ana.id), 'Cy was told Ana came online');
  cySock.disconnect();
  anaSock.disconnect();
});

await check('A first message makes contacts: they see each other online from then on', async () => {
  const anaSock = await connect(ana);
  const boSock = await connect(bo);
  await new Promise((resolve) => anaSock.emit('dm:send', { to: bo.id, body: 'Hi Bo!' }, resolve));
  await sleep(500);
  expect(anaSock.events.some((e) => e.event === 'presence:update' && e.data.userId === bo.id && e.data.online), 'Ana not told Bo is online');
  expect(boSock.events.some((e) => e.event === 'presence:update' && e.data.userId === ana.id && e.data.online), 'Bo not told Ana is online');
  boSock.disconnect();
  // (Offline only once they've stayed away a few seconds: a network change doesn't count.)
  await sleep(7000);
  const off = anaSock.events.find((e) => e.event === 'presence:update' && e.data.userId === bo.id && !e.data.online);
  expect(off && off.data.lastSeenAt, 'Ana not told Bo went offline');
  // Reconnecting: the snapshot has contacts only.
  const again = await connect(bo);
  const snap = again.events.find((e) => e.event === 'presence:snapshot');
  expect(snap.data.online.includes(ana.id), 'Bo’s snapshot lacks Ana');
  again.disconnect();
  anaSock.disconnect();
});

await check('Changing your user ID: rules, taken IDs, the old one stops working', async () => {
  const fresh = `ana.r.${stamp}`.slice(0, 24).replace(/[._]$/, 'x');
  for (const bad of ['ab', 'a'.repeat(25), '.ana', 'ana.', 'an..a', 'ana rahman', 'ana@x', 'ÄNA']) {
    expect((await call(ana, 'PATCH', '/auth/handle', { handle: bad })).status === 400, `"${bad}" accepted`);
  }
  expect((await call(ana, 'PATCH', '/auth/handle', { handle: bo.handle })).status === 409, 'took Bo’s ID');
  const ok = await call(ana, 'PATCH', '/auth/handle', { handle: `@${fresh.toUpperCase()}` });
  expect(ok.status === 200 && ok.data.user.handle === fresh, `change: ${JSON.stringify(ok.data)}`);
  expect((await call(bo, 'GET', `/users/find?q=${ana.handle}`)).status === 404, 'the old ID still finds Ana');
  expect((await call(bo, 'GET', `/users/find?q=${fresh}`)).data.user.id === ana.id, 'the new ID doesn’t');
  ana.handle = fresh;
});

await check('Lookups are rate-limited (no trying email after email)', async () => {
  const dan = await register('Dan Searcher');
  let limited = 0;
  for (let i = 0; i < 32; i++) {
    const r = await call(dan, 'GET', `/users/find?q=guess${i}@example.com`);
    if (r.status === 429) limited++;
  }
  expect(limited >= 2, `only ${limited} of 32 lookups were limited`);
});

// ── Rooms with invite codes ──────────────────────────────────────────

let open;
let locked;
await check('New rooms get an invite code (admins see it), open or password protected', async () => {
  const a = await call(ana, 'POST', '/rooms', { name: `Open room ${stamp}`, maxMembers: 3 });
  expect(a.status === 201 && /^[A-HJ-NP-Z2-9]{8}$/.test(a.data.room.joinCode) && a.data.room.hasPassword === false, `open: ${JSON.stringify(a.data.room)}`);
  open = a.data.room;
  const b = await call(ana, 'POST', '/rooms', { name: `Locked room ${stamp}`, maxMembers: 5, password: 'chai1234' });
  expect(b.status === 201 && b.data.room.hasPassword === true, 'locked room');
  locked = b.data.room;
  expect((await call(ana, 'POST', '/rooms', { name: 'Short', maxMembers: 5, password: 'abc' })).status === 400, 'a 3-character password accepted');
  expect(!JSON.stringify(b.data).includes('chai1234'), 'the password came back');
});

await check('Anyone with an open room’s code joins; the preview shows what it opens', async () => {
  const preview = await call(bo, 'GET', `/rooms/join/${open.joinCode.toLowerCase().slice(0, 4)}-${open.joinCode.slice(4)}`);
  expect(preview.status === 200 && preview.data.room.name === open.name && preview.data.room.needsPassword === false && !preview.data.room.member, `preview: ${JSON.stringify(preview.data)}`);
  const join = await call(bo, 'POST', '/rooms/join', { code: open.joinCode });
  expect(join.status === 201 && join.data.room.members.some((m) => m.id === bo.id), `join: ${join.status}`);
  expect(!('joinCode' in join.data.room), 'a member who isn’t admin sees the code');
  const again = await call(bo, 'POST', '/rooms/join', { code: open.joinCode });
  expect(again.status === 200, `joining twice: ${again.status}`);
  const msgs = await call(ana, 'GET', `/rooms/${open.id}/messages`);
  expect(msgs.data.messages.some((m) => m.kind === 'system' && /Bo Chowdhury joined with the invite code/.test(m.body)), 'no "joined" line');
});

await check('A password room needs the right password', async () => {
  const preview = await call(cy, 'GET', `/rooms/join/${locked.joinCode}`);
  expect(preview.data.room.needsPassword === true, 'preview should say it needs a password');
  const none = await call(cy, 'POST', '/rooms/join', { code: locked.joinCode });
  expect(none.status === 403 && /password/.test(none.data.error), `no password: ${none.status}`);
  const wrong = await call(cy, 'POST', '/rooms/join', { code: locked.joinCode, password: 'chai12345' });
  expect(wrong.status === 403 && /isn't right/.test(wrong.data.error), `wrong password: ${wrong.status}`);
  const right = await call(cy, 'POST', '/rooms/join', { code: locked.joinCode, password: 'chai1234' });
  expect(right.status === 201, `right password: ${right.status} ${JSON.stringify(right.data)}`);
});

await check('Full rooms, bad and unknown codes are refused', async () => {
  const eve = await register('Eve Late');
  expect((await call(cy, 'POST', '/rooms/join', { code: open.joinCode })).status === 201, 'third seat');
  const full = await call(eve, 'POST', '/rooms/join', { code: open.joinCode });
  expect(full.status === 409 && /full/.test(full.data.error), `full: ${full.status}`);
  expect((await call(eve, 'GET', '/rooms/join/SHORT')).status === 400, 'malformed code');
  const unknown = await call(eve, 'GET', '/rooms/join/ZZZZ2222');
  expect(unknown.status === 404 && /No room/.test(unknown.data.error), 'unknown code');
  expect((await call(null, 'POST', '/rooms/join', { code: open.joinCode })).status === 401, 'signed out joined');
});

await check('Only admins see, change or reset the code and password', async () => {
  expect((await call(bo, 'POST', `/rooms/${open.id}/code`)).status === 403, 'a member reset the code');
  expect((await call(bo, 'PATCH', `/rooms/${open.id}/access`, { password: 'x1234' })).status === 403, 'a member set a password');
  expect((await call(cy, 'GET', `/rooms/${open.id}`)).data.room.joinCode === undefined, 'a member sees the code');
  const old = open.joinCode;
  const renewed = await call(ana, 'POST', `/rooms/${open.id}/code`);
  expect(renewed.status === 200 && renewed.data.room.joinCode !== old, 'no new code');
  expect((await call(cy, 'GET', `/rooms/join/${old}`)).status === 404, 'the old code still works');
  open = renewed.data.room;
  const lock = await call(ana, 'PATCH', `/rooms/${locked.id}/access`, { password: null });
  expect(lock.status === 200 && lock.data.room.hasPassword === false, 'making it open');
  const relock = await call(ana, 'PATCH', `/rooms/${locked.id}/access`, { password: 'newpass1' });
  expect(relock.data.room.hasPassword === true, 'adding a password');
});

await check('Guessing passwords or codes is stopped after a few wrong tries', async () => {
  const guesser = await register('Guess Er');
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await call(guesser, 'POST', '/rooms/join', { code: locked.joinCode, password: `guess${i}xx` });
    limited = r.status === 429;
  }
  expect(limited, 'never limited');
  const right = await call(guesser, 'POST', '/rooms/join', { code: locked.joinCode, password: 'newpass1' });
  expect(right.status === 429, `still limited for the right password too: ${right.status}`);
});

// ── In the app ────────────────────────────────────────────────────────

const browser = await chromium.launch();
async function page(user, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  if (user) await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return p;
}

await check('Start a chat: no list, find by user ID, your own ID to share', async () => {
  const fay = await register('Fay Finder');
  const p = await page(fay);
  await p.goto(`${BASE}/chats`);
  await p.getByRole('button', { name: 'Start a new chat' }).first().click();
  const dlg = p.getByRole('dialog', { name: 'Start a chat' });
  await dlg.waitFor();
  expect((await dlg.locator('li').count()) === 0, 'people are listed');
  await dlg.getByText(`@${fay.handle}`).waitFor();
  await dlg.getByLabel('User ID or email').fill(`@${bo.handle}`);
  await dlg.getByRole('button', { name: 'Find' }).click();
  const result = dlg.getByRole('group', { name: 'Search result' });
  await result.getByText('Bo Chowdhury').waitFor({ timeout: 5000 });
  await p.screenshot({ path: `${SHOTS}people-01-find-by-id.png` });
  await result.getByRole('button', { name: 'Message' }).click();
  await p.waitForURL(new RegExp(`/chats/${bo.id}$`));
  await p.context().close();
});

await check('Your user ID in Settings (the You tab on a phone); changing it', async () => {
  const gus = await register('Gus Handle');
  const p = await page(gus, { width: 390, height: 844 });
  await p.goto(`${BASE}/chats`);
  await p.getByRole('link', { name: 'You: settings' }).click();
  await p.getByRole('button', { name: /^Your user ID/ }).click();
  const dlg = p.getByRole('dialog', { name: 'Your user ID' });
  await dlg.getByText(`@${gus.handle}`).waitFor();
  const next = `gus.${stamp}`;
  await dlg.getByLabel('Change your user ID').fill(next);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await p.getByText(`Your user ID is now @${next}.`).waitFor({ timeout: 5000 });
  expect((await call(ana, 'GET', `/users/find?q=${next}`)).data.user.id === gus.id, 'the new ID doesn’t find Gus');
  await p.context().close();
});

await check('Admins share the invite code; a join link works even when signed out (password room)', async () => {
  const admin = await page(ana);
  await admin.goto(`${BASE}/rooms/${locked.id}`);
  const card = admin.getByRole('region', { name: 'Invite code' });
  await card.waitFor({ timeout: 8000 }).catch(async () => {
    // On narrower screens the members panel opens from the header.
    await admin.getByRole('button', { name: /Members|People|In this room/ }).first().click();
    await card.waitFor();
  });
  await card.getByText(`${locked.joinCode.slice(0, 4)}-${locked.joinCode.slice(4)}`).waitFor();
  await card.getByRole('button', { name: /Password protected/ }).waitFor();
  await admin.screenshot({ path: `${SHOTS}people-02-invite-card.png` });

  const hal = await register('Hal Joiner');
  const visitor = await page(null, { width: 390, height: 844 });
  await visitor.goto(`${BASE}/join/${locked.joinCode}`);
  await visitor.waitForURL(/\/login/);
  await visitor.getByLabel(/Email/).fill(hal.email);
  await visitor.getByLabel('Password').fill('password123');
  await visitor.getByRole('button', { name: /Log in/ }).click();
  const dlg = visitor.getByRole('dialog', { name: 'Join a room' });
  await dlg.waitFor({ timeout: 8000 });
  await dlg.getByText(locked.name).waitFor({ timeout: 5000 });
  await dlg.getByLabel('Room password').fill('nope1234');
  await dlg.getByRole('button', { name: 'Join room' }).click();
  await dlg.getByText("That password isn't right.").waitFor({ timeout: 5000 });
  await dlg.getByLabel('Room password').fill('newpass1');
  await visitor.screenshot({ path: `${SHOTS}people-03-join-dialog.png` });
  await dlg.getByRole('button', { name: 'Join room' }).click();
  await visitor.waitForURL(new RegExp(`/rooms/${locked.id}$`), { timeout: 8000 });
  await admin.getByRole('log').getByText('Hal Joiner joined with the invite code').waitFor({ timeout: 5000 });
  await admin.context().close();
  await visitor.context().close();
});

await check('Join with a code from the Rooms list; start a password room', async () => {
  const ida = await register('Ida Code');
  const p = await page(ida);
  await p.goto(`${BASE}/rooms`);
  await p.getByRole('button', { name: 'Join a room with a code' }).click();
  const dlg = p.getByRole('dialog', { name: 'Join a room' });
  await dlg.getByLabel('Invite code').fill(open.joinCode.toLowerCase());
  await dlg.getByRole('button', { name: 'Find room' }).click();
  await dlg.getByText('3 of 3 members').waitFor({ timeout: 5000 });
  await dlg.getByText(/full/).first().waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();

  await p.getByRole('button', { name: 'Start a room' }).first().click();
  const create = p.getByRole('dialog', { name: 'Start a room' });
  await create.getByLabel('Room name', { exact: true }).fill(`Ida's den ${stamp}`);
  await create.getByRole('radio', { name: /Password protected/ }).click();
  await create.getByLabel('Room password').fill('denpass9');
  await create.getByRole('button', { name: 'Create room' }).click();
  await p.waitForURL(/\/rooms\/[0-9a-f-]+$/);
  const id = p.url().split('/').pop();
  const room = (await call(ida, 'GET', `/rooms/${id}`)).data.room;
  expect(room.hasPassword === true && room.joinCode, `created: ${JSON.stringify({ hasPassword: room.hasPassword, code: room.joinCode })}`);
  await p.context().close();
});

await browser.close();

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(' -', f[1], ':', f[2]);
  process.exit(1);
}
