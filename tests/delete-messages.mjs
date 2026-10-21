import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync } from 'node:fs';

// Deleting messages, like WhatsApp: "for me" hides a message from one person
// (on all their devices); "for everyone" leaves "This message was deleted" and
// removes the text, the file and the reactions for good. Your own messages,
// within two days; room admins can delete anyone's. Runs against the dev
// servers (npm run dev).
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const serverEnv = new URL('../server/.env', import.meta.url).pathname;
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
    /* empty */
  }
  return { status: res.status, data };
}

async function register(name) {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.del.${stamp}@example.com`;
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, email, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

async function connect(user) {
  const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: user.cookie } });
  s.events = [];
  s.onAny((event, ...args) => {
    s.events.push({ event, data: args[0] });
    const ack = args.at(-1);
    if (typeof ack === 'function') ack(true);
  });
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  return s;
}
const emit = (s, event, payload) =>
  new Promise((resolve) => s.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: String(err) } : res)));
const seen = (s, event, test) => s.events.some((e) => e.event === event && test(e.data));

// A 1×1 PNG, to check a deleted message's file is gone too.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function upload(user) {
  const meta = encodeURIComponent(JSON.stringify({ kind: 'image', name: 'p.png', mime: 'image/png', width: 1, height: 1 }));
  return call(user, 'POST', '/uploads', undefined, { headers: { 'content-type': 'application/octet-stream', 'x-upload-meta': meta }, body: PNG });
}

const ana = await register('Ana Rahman');
const bo = await register('Bo Chowdhury');
const cy = await register('Cy Member');
const sA = await connect(ana);
const sB = await connect(bo);
const sC = await connect(cy);
const dmsOf = async (u, partner) => (await call(u, 'GET', `/dms/${partner.id}/messages`)).data.messages;

// ── Chats ─────────────────────────────────────────────────────────────

let photoMsg;
let photoUrl;
await check('Deleting for everyone leaves a marker for both, and removes the text, photo, reactions and quote', async () => {
  const up = await upload(ana);
  expect(up.status === 201, `upload: ${up.status}`);
  photoUrl = up.data.attachment.url;
  photoMsg = (await emit(sA, 'dm:send', { to: bo.id, body: 'secret photo caption', attachmentId: up.data.attachment.id })).message;
  const reply = (await emit(sB, 'dm:send', { to: ana.id, body: 'nice!', replyTo: photoMsg.id })).message;
  await emit(sB, 'msg:react', { scope: 'dm', messageId: photoMsg.id, emoji: '❤️' });
  expect((await call(bo, 'GET', photoUrl.replace(/^\/api/, ''))).status === 200, 'photo should load before');
  const res = await emit(sA, 'msg:delete', { scope: 'dm', messageId: photoMsg.id, forEveryone: true });
  expect(res.ok && res.deletedAt, `delete: ${JSON.stringify(res)}`);
  await sleep(300);
  expect(seen(sB, 'msg:deleted', (d) => d.messageId === photoMsg.id), 'Bo was not told live');
  for (const u of [ana, bo]) {
    const m = (await dmsOf(u, u === ana ? bo : ana)).find((x) => x.id === photoMsg.id);
    expect(m && m.deletedAt && m.body === '' && !m.attachment && !m.reactions.length, `${u.name} sees ${JSON.stringify(m)}`);
    const r = (await dmsOf(u, u === ana ? bo : ana)).find((x) => x.id === reply.id);
    expect(r.replyTo?.deleted === true && !r.replyTo.body, `the quote still shows: ${JSON.stringify(r.replyTo)}`);
  }
  expect(!JSON.stringify(await dmsOf(bo, ana)).includes('secret photo caption'), 'the text is still served');
  expect((await call(bo, 'GET', photoUrl.replace(/^\/api/, ''))).status === 404, 'the photo is still served');
  const again = await emit(sB, 'msg:react', { scope: 'dm', messageId: photoMsg.id, emoji: '👍' });
  expect(!again.ok, 'reacted to a deleted message');
});

await check('Only the sender can delete a chat message for everyone; anyone in it can delete it for themselves', async () => {
  const m = (await emit(sA, 'dm:send', { to: bo.id, body: 'keep me' })).message;
  const theirs = await emit(sB, 'msg:delete', { scope: 'dm', messageId: m.id, forEveryone: true });
  expect(!theirs.ok && /your own/.test(theirs.error), `Bo deleted Ana's message for everyone: ${JSON.stringify(theirs)}`);
  const outsider = await emit(sC, 'msg:delete', { scope: 'dm', messageId: m.id, forEveryone: false });
  expect(!outsider.ok && /doesn't exist/.test(outsider.error), 'an outsider could act on the message');
  const mine = await emit(sB, 'msg:delete', { scope: 'dm', messageId: m.id, forEveryone: false });
  expect(mine.ok && mine.hidden, `hide: ${JSON.stringify(mine)}`);
  await sleep(300);
  expect(!(await dmsOf(bo, ana)).some((x) => x.id === m.id), 'Bo still sees it');
  expect((await dmsOf(ana, bo)).some((x) => x.id === m.id && x.body === 'keep me'), 'Ana lost it too');
  expect(seen(sB, 'msg:hidden', (d) => d.messageId === m.id && d.chatId === ana.id), "Bo's other devices were not told");
  expect(!seen(sA, 'msg:hidden', (d) => d.messageId === m.id), 'Ana was told about Bo hiding it');
});

await check('Hidden messages leave the chat list preview and the unread count', async () => {
  const last = (await emit(sA, 'dm:send', { to: bo.id, body: 'unread and hidden' })).message;
  let conv = (await call(bo, 'GET', '/dms')).data.conversations.find((c) => c.partner.id === ana.id);
  expect(conv.lastMessage.id === last.id, 'preview should be the new message');
  const unreadBefore = conv.unread;
  await emit(sB, 'msg:delete', { scope: 'dm', messageId: last.id, forEveryone: false });
  conv = (await call(bo, 'GET', '/dms')).data.conversations.find((c) => c.partner.id === ana.id);
  expect(conv.lastMessage.id !== last.id, 'the hidden message is still the preview');
  expect(conv.unread === unreadBefore - 1, `unread went from ${unreadBefore} to ${conv.unread}`);
});

await check('After two days, only "for me" is left; calls can only be deleted for yourself', async () => {
  const old = (await emit(sA, 'dm:send', { to: bo.id, body: 'old news' })).message;
  // Make it three days old, straight in the database.
  process.loadEnvFile(serverEnv);
  const pg = await import('pg');
  const db = new (pg.default ?? pg).Client(process.env.DATABASE_URL);
  await db.connect();
  await db.query(`UPDATE dm_messages SET created_at = now() - interval '3 days' WHERE id = $1`, [old.id]);
  const call1 = await db.query(
    `INSERT INTO dm_messages (sender_id, recipient_id, kind, body, meta) VALUES ($1, $2, 'call', 'Voice call', '{"outcome":"completed"}') RETURNING id`,
    [ana.id, bo.id],
  );
  await db.end();
  const late = await emit(sA, 'msg:delete', { scope: 'dm', messageId: old.id, forEveryone: true });
  expect(!late.ok && /two days/.test(late.error), `late delete: ${JSON.stringify(late)}`);
  const callDel = await emit(sA, 'msg:delete', { scope: 'dm', messageId: call1.rows[0].id, forEveryone: true });
  expect(!callDel.ok, 'a call record was deleted for everyone');
  expect((await emit(sA, 'msg:delete', { scope: 'dm', messageId: old.id, forEveryone: false })).ok, 'hiding an old message failed');
});

// ── Rooms ─────────────────────────────────────────────────────────────

let room;
await check('Rooms: members delete their own for everyone; admins delete anyone’s; others can’t', async () => {
  room = (await call(ana, 'POST', '/rooms', { name: `Delete test ${stamp}`, maxMembers: 5 })).data.room;
  await call(ana, 'POST', `/rooms/${room.id}/members`, { userId: bo.id });
  await call(ana, 'POST', `/rooms/${room.id}/members`, { userId: cy.id });
  for (const s of [sA, sB, sC]) s.disconnect();
  const [a, b, c] = await Promise.all([connect(ana), connect(bo), connect(cy)]);
  Object.assign(sA, { _s: a });
  const boMsg = (await emit(b, 'room:send', { roomId: room.id, body: 'my own words' })).message;
  const cyMsg = (await emit(c, 'room:send', { roomId: room.id, body: 'something rude' })).message;
  const boOwn = await emit(b, 'msg:delete', { scope: 'room', messageId: boMsg.id, forEveryone: true });
  expect(boOwn.ok && boOwn.byAdmin === false, `Bo deleting his own: ${JSON.stringify(boOwn)}`);
  const boOther = await emit(b, 'msg:delete', { scope: 'room', messageId: cyMsg.id, forEveryone: true });
  expect(!boOther.ok && /admins/.test(boOther.error), `Bo deleted Cy's message: ${JSON.stringify(boOther)}`);
  const admin = await emit(a, 'msg:delete', { scope: 'room', messageId: cyMsg.id, forEveryone: true });
  expect(admin.ok && admin.byAdmin === true, `admin delete: ${JSON.stringify(admin)}`);
  await sleep(300);
  expect(seen(c, 'msg:deleted', (d) => d.messageId === cyMsg.id && d.byAdmin), 'Cy was not told it was an admin');
  const msgs = (await call(cy, 'GET', `/rooms/${room.id}/messages`)).data.messages;
  const m = msgs.find((x) => x.id === cyMsg.id);
  expect(m.deletedAt && m.deletedByAdmin && m.body === '', `Cy sees ${JSON.stringify(m)}`);
  expect(msgs.find((x) => x.id === boMsg.id).deletedByAdmin === false, 'Bo deleting his own should not say admin');
  const notice = msgs.find((x) => x.kind === 'system');
  const sys = await emit(a, 'msg:delete', { scope: 'room', messageId: notice.id, forEveryone: true });
  expect(!sys.ok, 'a room notice was deleted for everyone');
  const hide = await emit(c, 'msg:delete', { scope: 'room', messageId: notice.id, forEveryone: false });
  expect(hide.ok, 'hiding a room notice failed');
  expect(!(await call(cy, 'GET', `/rooms/${room.id}/messages`)).data.messages.some((x) => x.id === notice.id), 'the notice is still there for Cy');
  expect((await call(bo, 'GET', `/rooms/${room.id}/messages`)).data.messages.some((x) => x.id === notice.id), 'the notice went for Bo too');
  const dan = await register('Dan Outsider');
  const sD = await connect(dan);
  const outsider = await emit(sD, 'msg:delete', { scope: 'room', messageId: boMsg.id, forEveryone: false });
  expect(!outsider.ok, 'someone outside the room hid one of its messages');
  for (const s of [a, b, c, sD]) s.disconnect();
});

await check('Bad input is refused without trouble', async () => {
  const s = await connect(ana);
  for (const bad of [null, {}, { scope: 'x', messageId: 1 }, { scope: 'dm', messageId: 'abc' }, { scope: 'dm', messageId: -5 }, { scope: 'room', messageId: 99999999999 }]) {
    const r = await emit(s, 'msg:delete', bad);
    expect(r && r.ok === false, `accepted ${JSON.stringify(bad)}: ${JSON.stringify(r)}`);
  }
  s.disconnect();
});

// ── In the app ────────────────────────────────────────────────────────

const browser = await chromium.launch();
async function page(user, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 500 });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return p;
}

await check('In the app: hover, Delete, "Delete for everyone": both see the marker live', async () => {
  const pa = await page(ana);
  const pb = await page(bo, { width: 390, height: 844 });
  await pa.goto(`${BASE}/chats/${bo.id}`);
  await pb.goto(`${BASE}/chats/${ana.id}`);
  await pa.getByLabel('Message Bo').fill('Oops, wrong chat');
  await pa.keyboard.press('Enter');
  const bubble = pa.getByRole('log').locator('[id^="msg-"]').filter({ hasText: 'Oops, wrong chat' }).last();
  await bubble.waitFor();
  await pb.getByRole('log').getByText('Oops, wrong chat').waitFor({ timeout: 8000 });
  await bubble.hover();
  await bubble.getByRole('button', { name: 'Delete message' }).click();
  const dlg = pa.getByRole('dialog', { name: 'Delete message?' });
  await dlg.getByRole('button', { name: 'Delete for everyone' }).waitFor();
  await pa.screenshot({ path: `${SHOTS}delete-1-dialog.png` });
  await dlg.getByRole('button', { name: 'Delete for everyone' }).click();
  await pa.getByRole('log').getByText('You deleted this message').last().waitFor({ timeout: 5000 });
  await pb.getByRole('log').getByText('This message was deleted').last().waitFor({ timeout: 5000 });
  expect(!(await pb.getByRole('log').getByText('Oops, wrong chat').count()), 'Bo still sees the text');
  await pb.screenshot({ path: `${SHOTS}delete-2-marker-phone.png` });

  // On the phone: press and hold → Delete → only "Delete for me" for someone else's message.
  await pa.getByLabel('Message Bo').fill('Bo can only hide this');
  await pa.keyboard.press('Enter');
  const theirs = pb.getByRole('log').getByText('Bo can only hide this');
  await theirs.waitFor({ timeout: 8000 });
  const box = await theirs.boundingBox();
  await pb.touchscreen.tap(box.x + 5, box.y + 5); // focus
  const cdp = await pb.context().newCDPSession(pb);
  const point = { x: box.x + 10, y: box.y + 8 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await sleep(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pb.getByRole('dialog', { name: 'Message actions' }).getByRole('button', { name: 'Delete' }).click();
  const phoneDlg = pb.getByRole('dialog', { name: 'Delete message?' });
  await phoneDlg.getByRole('button', { name: 'Delete for me' }).waitFor();
  expect(!(await phoneDlg.getByRole('button', { name: 'Delete for everyone' }).count()), 'Bo was offered "for everyone" on Ana’s message');
  await phoneDlg.getByRole('button', { name: 'Delete for me' }).click();
  await theirs.waitFor({ state: 'detached', timeout: 5000 });
  await pa.getByRole('log').getByText('Bo can only hide this').waitFor();
  await pa.context().close();
  await pb.context().close();
});

await check('In the app: a room admin deletes someone’s message for everyone', async () => {
  const pc = await page(cy);
  await pc.goto(`${BASE}/rooms/${room.id}`);
  await pc.getByRole('log').getByText('This message was deleted by an admin').first().waitFor({ timeout: 8000 });
  await pc.screenshot({ path: `${SHOTS}delete-3-room.png` });
  await pc.context().close();
});

await browser.close();
sA.disconnect();
sB.disconnect();
sC.disconnect();

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(' -', f[1], ':', f[2]);
  process.exit(1);
}
