import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { io } from 'socket.io-client';

// Push notifications for the Android app, against a fake Firebase: the server
// signs in to "Google" with a service account and sends data messages to
// "FCM". Checks who gets a push and when (offline, app in the background, not
// while looking), what it carries, calls ringing a phone whose app is closed
// (and being answered or declined from it), replying and marking read from a
// notification, phones that were uninstalled, and that nobody else can use any of it.
//
// Starts its own server on API_PORT (default 4091) with the same database as
// the dev server; nothing else needs to be running.
const PORT = Number(process.env.API_PORT ?? 4091);
const API = `http://localhost:${PORT}`;
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

// ── Fake Google sign-in + FCM ─────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pushes = []; // { token, data, android }
const gone = new Set(); // tokens FCM says were uninstalled
let tokenRequests = 0;
let badAssertions = 0;

const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/token') {
      tokenRequests++;
      const assertion = new URLSearchParams(body).get('assertion') ?? '';
      const [h, p, sig] = assertion.split('.');
      const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString() || '{}');
      const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig ?? '', 'base64url');
      if (!ok || claims.scope !== 'https://www.googleapis.com/auth/firebase.messaging' || claims.iss !== 'push-test@example.iam.gserviceaccount.com') {
        badAssertions++;
        res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'fake-access', expires_in: 3600 }));
      return;
    }
    if (req.url === '/v1/projects/adda-test/messages:send') {
      if (req.headers.authorization !== 'Bearer fake-access') return res.writeHead(401).end('{}');
      const { message } = JSON.parse(body);
      if (gone.has(message.token)) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
        );
        return;
      }
      pushes.push({ token: message.token, data: message.data, android: message.android });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'projects/adda-test/messages/1' }));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

// ── A server that pushes to the fake ─────────────────────────────────

const account = {
  type: 'service_account',
  project_id: 'adda-test',
  client_email: 'push-test@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: `${FAKE}/token`,
};
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), FCM_SERVICE_ACCOUNT: JSON.stringify(account), FCM_API_URL: FAKE, NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
for (let i = 0; i < 100 && !serverLog.includes('listening'); i++) await sleep(200);
if (!serverLog.includes('listening')) {
  console.log(serverLog);
  throw new Error('The test server did not start');
}

// ── Helpers ───────────────────────────────────────────────────────────

async function call(user, method, path, body, headers = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(user?.cookie ? { cookie: user.cookie } : {}), ...headers },
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
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.toLowerCase()}.push.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

/** A live connection; `active` is what it reports (undefined: says nothing). */
async function connect(user, active) {
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
  if (active !== undefined) s.emit('client:state', { active });
  await sleep(150);
  return s;
}

const emit = (s, event, payload) =>
  new Promise((resolve) => s.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: String(err) } : res)));

const pushesFor = (token, type) => pushes.filter((p) => p.token === token && (!type || p.data.type === type));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
}

// ── The tests ─────────────────────────────────────────────────────────

const ana = await register('Ana');
const bo = await register('Bo');
const cy = await register('Cy');
const TOKEN_BO = `bo-phone-${stamp}-${'x'.repeat(40)}`;
const TOKEN_CY = `cy-phone-${stamp}-${'y'.repeat(40)}`;
let anaSock;
let boSock;

await check('A phone registers for notifications (and outsiders and other websites cannot)', async () => {
  expect((await call(null, 'POST', '/push/devices', { token: TOKEN_BO })).status === 401, 'signed-out register allowed');
  const cross = await call(bo, 'POST', '/push/devices', { token: TOKEN_BO }, { 'sec-fetch-site': 'cross-site' });
  expect(cross.status === 403, `cross-site register: ${cross.status}`);
  expect((await call(bo, 'POST', '/push/devices', { token: 'short' })).status === 400, 'short token accepted');
  expect((await call(bo, 'POST', '/push/devices', { token: TOKEN_BO, platform: 'android' })).status === 204, 'register failed');
  expect((await call(cy, 'POST', '/push/devices', { token: TOKEN_CY })).status === 204, 'register failed');
  const config = await call(bo, 'GET', '/config');
  expect(config.data.push === true, 'config should say push is on');
});

await check('A message to someone offline buzzes their phone with who, where and what', async () => {
  anaSock = await connect(ana, true);
  const res = await emit(anaSock, 'dm:send', { to: bo.id, body: 'Hey Bo, dinner at 8?' });
  expect(res.ok, `send failed: ${res.error}`);
  const p = await waitFor(() => pushesFor(TOKEN_BO, 'message')[0]);
  expect(p, 'no push');
  expect(p.data.scope === 'dm' && p.data.chatId === ana.id && p.data.chatName === 'Ana', `wrong chat: ${JSON.stringify(p.data)}`);
  expect(p.data.senderName === 'Ana' && p.data.text === 'Hey Bo, dinner at 8?', `wrong content: ${JSON.stringify(p.data)}`);
  expect(p.data.messageId === String(res.message.id) && /^\d+$/.test(p.data.sentAt) && /^\d+$/.test(p.data.chatHue), 'ids and times should be strings of digits');
  expect(p.android.priority === 'high', 'should be high priority');
  expect(Object.values(p.data).every((v) => typeof v === 'string'), 'FCM data must be all strings');
  expect(tokenRequests === 1 && badAssertions === 0, `signed in to Google ${tokenRequests}x, ${badAssertions} bad`);
  expect(pushesFor(TOKEN_CY).length === 0, 'Cy got a push for a message that is not theirs');
});

await check('No push while looking at the app; a push once it goes to the background', async () => {
  boSock = await connect(bo, true);
  const before = pushesFor(TOKEN_BO).length;
  await emit(anaSock, 'dm:send', { to: bo.id, body: 'You there?' });
  await sleep(600);
  expect(pushesFor(TOKEN_BO).length === before, 'pushed while Bo was looking');
  boSock.emit('client:state', { active: false });
  await sleep(150);
  await emit(anaSock, 'dm:send', { to: bo.id, body: 'Pick up your phone' });
  const p = await waitFor(() => pushesFor(TOKEN_BO, 'message').find((x) => x.data.text === 'Pick up your phone'));
  expect(p, 'no push while in the background');
});

await check('Photos, voice messages and files say what they are', async () => {
  const { preview } = await import('../server/src/services/push.js');
  expect(preview({ body: '', attachment: { kind: 'image' } }) === '📷 Photo', 'photo');
  expect(preview({ body: 'Look!', attachment: { kind: 'image' } }) === '📷 Look!', 'photo with caption');
  expect(preview({ body: '', attachment: { kind: 'voice' } }) === '🎤 Voice message', 'voice');
  expect(preview({ body: '', attachment: { kind: 'file', name: 'plan.pdf' } }) === '📎 plan.pdf', 'file');
  expect(preview({ body: 'x'.repeat(500) }).length === 300, 'long text is cut');
});

await check('Reading on one device clears the notification on the phone', async () => {
  const res = await emit(boSock, 'dm:read', { partnerId: ana.id });
  expect(res.ok, 'read failed');
  const p = await waitFor(() => pushesFor(TOKEN_BO, 'read')[0]);
  expect(p && p.data.scope === 'dm' && p.data.chatId === ana.id, `no read push: ${JSON.stringify(p?.data)}`);
  // Nothing new was notified since, so reading again sends nothing.
  const n = pushesFor(TOKEN_BO, 'read').length;
  await emit(boSock, 'dm:read', { partnerId: ana.id });
  await sleep(400);
  expect(pushesFor(TOKEN_BO, 'read').length === n, 'a second read push for nothing');
});

await check('Deleting for everyone takes the message out of the phone’s notification', async () => {
  const sent = await emit(anaSock, 'dm:send', { to: bo.id, body: 'Oops, delete me' });
  const id = String(sent.message.id);
  expect(await waitFor(() => pushesFor(TOKEN_BO, 'message').find((x) => x.data.messageId === id)), 'no message push first');
  const res = await emit(anaSock, 'msg:delete', { scope: 'dm', messageId: sent.message.id, forEveryone: true });
  expect(res.ok, `delete: ${JSON.stringify(res)}`);
  const p = await waitFor(() => pushesFor(TOKEN_BO, 'deleted').find((x) => x.data.messageId === id));
  expect(p && p.data.scope === 'dm' && p.data.chatId === ana.id, `deleted push: ${JSON.stringify(p?.data)}`);
  expect(!pushesFor(TOKEN_CY, 'deleted').length, 'someone else’s phone was told');
});

let roomId;
await check('Room messages buzz every member who is away, with the room name', async () => {
  const room = await call(ana, 'POST', '/rooms', { name: `Push room ${stamp}`, description: '', maxMembers: 5 });
  expect(room.status === 201, `room: ${room.status}`);
  roomId = room.data.room.id;
  expect((await call(ana, 'POST', `/rooms/${roomId}/members`, { userId: bo.id })).status < 300, 'add Bo');
  expect((await call(ana, 'POST', `/rooms/${roomId}/members`, { userId: cy.id })).status < 300, 'add Cy');
  anaSock.disconnect();
  anaSock = await connect(ana, true);
  const res = await emit(anaSock, 'room:send', { roomId, body: 'Movie night?' });
  expect(res.ok, `room send: ${res.error}`);
  const forCy = await waitFor(() => pushesFor(TOKEN_CY, 'message').find((x) => x.data.scope === 'room'));
  expect(forCy && forCy.data.chatId === roomId && forCy.data.chatName === `Push room ${stamp}` && forCy.data.senderName === 'Ana', `Cy: ${JSON.stringify(forCy?.data)}`);
  const forBo = await waitFor(() => pushesFor(TOKEN_BO, 'message').find((x) => x.data.scope === 'room'));
  expect(forBo, 'Bo (in the background) got nothing');
  expect(!pushes.some((x) => x.data.scope === 'room' && x.data.senderName === 'Ana' && x.token.startsWith('ana')), 'the sender was pushed');
});

await check('Notifications carry the sender’s profile photo, which the phone can download', async () => {
  const set = await fetch(`${API}/api/auth/photo`, {
    method: 'PUT',
    headers: { cookie: ana.cookie, 'content-type': 'image/jpeg' },
    body: readFileSync(new URL('./fixtures/photo.jpg', import.meta.url)),
  });
  const photo = (await set.json()).user?.photo;
  expect(set.status === 200 && photo, `photo: ${set.status}`);
  // Ana's open connection picked up her new photo: no reconnecting needed.
  const dm = await emit(anaSock, 'dm:send', { to: bo.id, body: 'Now with my photo' });
  expect(dm.ok, `send: ${dm.error}`);
  const p = await waitFor(() => pushesFor(TOKEN_BO, 'message').find((x) => x.data.text === 'Now with my photo'));
  expect(p?.data.senderPhoto === photo && p.data.chatPhoto === photo, `dm push: ${JSON.stringify(p?.data)}`);
  const inRoom = await emit(anaSock, 'room:send', { roomId, body: 'Room, with my photo' });
  expect(inRoom.ok, `room send: ${inRoom.error}`);
  const q = await waitFor(() => pushesFor(TOKEN_CY, 'message').find((x) => x.data.text === 'Room, with my photo'));
  expect(q?.data.senderPhoto === photo && !q.data.chatPhoto, `room push: ${JSON.stringify(q?.data)}`);
  const file = await fetch(API + photo, { headers: { cookie: bo.cookie } });
  expect(file.status === 200 && file.headers.get('content-type') === 'image/jpeg', `download: ${file.status}`);
  expect((await fetch(API + photo)).status === 401, 'anyone could download it');
});

await check('A muted room stays quiet, except for messages that mention you or reply to you', async () => {
  // Cy asks something, then mutes the room for good.
  const question = await call(cy, 'POST', `/rooms/${roomId}/messages`, { body: 'Who has the tickets?' });
  expect(question.status === 201, `question: ${question.status}`);
  const muted = await call(cy, 'PUT', `/rooms/${roomId}/mute`, { for: 'always' });
  expect(muted.status === 200 && muted.data.mutedUntil?.startsWith('9999'), `mute: ${muted.status} ${JSON.stringify(muted.data)}`);
  expect((await emit(anaSock, 'room:send', { roomId, body: 'Quiet one' })).ok, 'send');
  // Bo hasn't muted it: he hears; Cy doesn't.
  expect(await waitFor(() => pushesFor(TOKEN_BO, 'message').find((x) => x.data.text === 'Quiet one')), 'Bo got nothing');
  await sleep(300);
  expect(!pushesFor(TOKEN_CY, 'message').some((x) => x.data.text === 'Quiet one'), 'Cy was pushed in a room she muted');
  // Mentioning her gets through.
  const text = 'Hey @Cy, are you coming?';
  const mention = await emit(anaSock, 'room:send', { roomId, body: text, mentions: [{ id: cy.id, offset: 4, length: 3 }] });
  expect(mention.ok && mention.message.mentions?.[0]?.id === cy.id, `mention: ${JSON.stringify(mention)}`);
  expect(await waitFor(() => pushesFor(TOKEN_CY, 'message').find((x) => x.data.text === text)), 'the mention did not reach Cy');
  // A "mention" that doesn't say her name is dropped: no hidden pings.
  const sneaky = await emit(anaSock, 'room:send', { roomId, body: 'Hello @everyone', mentions: [{ id: cy.id, offset: 6, length: 9 }] });
  expect(sneaky.ok && !sneaky.message.mentions, `a mention not naming her was kept: ${JSON.stringify(sneaky.message?.mentions)}`);
  // So does a reply to her own message.
  const reply = await emit(anaSock, 'room:send', { roomId, body: 'I have them!', replyTo: question.data.message.id });
  expect(reply.ok, 'reply');
  expect(await waitFor(() => pushesFor(TOKEN_CY, 'message').find((x) => x.data.text === 'I have them!')), 'the reply did not reach Cy');
  await sleep(300);
  expect(!pushesFor(TOKEN_CY, 'message').some((x) => x.data.text === 'Hello @everyone'), 'the dropped mention still buzzed Cy');
  // Her room list: muted, 4 unread, 2 of them for her.
  const mine = (await call(cy, 'GET', '/rooms')).data.rooms.find((r) => r.id === roomId);
  expect(mine.mutedUntil?.startsWith('9999') && mine.unread === 4 && mine.unreadMentions === 2, `room list: ${JSON.stringify({ mutedUntil: mine.mutedUntil, unread: mine.unread, unreadMentions: mine.unreadMentions })}`);
  // Muted for 8 hours, then back on: everything buzzes again.
  const eight = await call(cy, 'PUT', `/rooms/${roomId}/mute`, { for: '8h' });
  const hours = (new Date(eight.data.mutedUntil).getTime() - Date.now()) / 3600_000;
  expect(hours > 7.9 && hours <= 8, `8 hours: ${eight.data.mutedUntil}`);
  expect((await call(cy, 'PUT', `/rooms/${roomId}/mute`, { for: 'off' })).data.mutedUntil === null, 'unmute');
  expect((await emit(anaSock, 'room:send', { roomId, body: 'Loud again' })).ok, 'send');
  expect(await waitFor(() => pushesFor(TOKEN_CY, 'message').find((x) => x.data.text === 'Loud again')), 'unmuted, Cy got nothing');
  // Only members, and only real choices.
  expect((await call(cy, 'PUT', `/rooms/${roomId}/mute`, { for: 'forever' })).status === 400, 'a made-up length was accepted');
  const dan = await register('Dana');
  expect((await call(dan, 'PUT', `/rooms/${roomId}/mute`, { for: 'always' })).status === 404, 'an outsider muted the room');
});

await check('A muted chat stays quiet (calls still ring); a blocked one sends nothing at all', async () => {
  const muted = await call(bo, 'PUT', `/dms/${ana.id}/settings`, { mute: 'always' });
  expect(muted.status === 200 && muted.data.mutedUntil?.startsWith('9999'), `mute: ${muted.status} ${JSON.stringify(muted.data)}`);
  expect((await emit(anaSock, 'dm:send', { to: bo.id, body: 'Shh, muted' })).ok, 'send');
  await sleep(500);
  expect(!pushesFor(TOKEN_BO, 'message').some((x) => x.data.text === 'Shh, muted'), 'Bo was pushed in a chat he muted');
  // Cy hasn't muted Ana: she still hears.
  expect((await emit(anaSock, 'dm:send', { to: cy.id, body: 'Not muted for Cy' })).ok, 'send');
  expect(await waitFor(() => pushesFor(TOKEN_CY, 'message').find((x) => x.data.text === 'Not muted for Cy')), 'Cy got nothing');
  expect((await call(bo, 'PUT', `/dms/${ana.id}/settings`, { mute: 'off' })).data.mutedUntil === null, 'unmute');
  expect((await emit(anaSock, 'dm:send', { to: bo.id, body: 'Loud chat again' })).ok, 'send');
  expect(await waitFor(() => pushesFor(TOKEN_BO, 'message').find((x) => x.data.text === 'Loud chat again')), 'unmuted, Bo got nothing');
  // Blocked: the message isn't sent, so nothing buzzes.
  expect((await call(bo, 'POST', `/users/${ana.id}/block`)).status === 200, 'block');
  const refused = await emit(anaSock, 'dm:send', { to: bo.id, body: 'Blocked message' });
  expect(!refused.ok, 'a blocked message was sent');
  await sleep(300);
  expect(!pushesFor(TOKEN_BO, 'message').some((x) => x.data.text === 'Blocked message'), 'Bo was pushed by someone he blocked');
  // In a room they share, her messages show, but don't buzz him, mentioning him or not.
  const mention = await emit(anaSock, 'room:send', { roomId, body: 'Hey @Bo, look', mentions: [{ id: bo.id, offset: 4, length: 3 }] });
  expect(mention.ok, `room send: ${JSON.stringify(mention)}`);
  await sleep(500);
  expect(!pushesFor(TOKEN_BO, 'message').some((x) => x.data.text === 'Hey @Bo, look'), 'Bo was pushed by someone he blocked, in a room');
  expect((await call(bo, 'DELETE', `/users/${ana.id}/block`)).status === 200, 'unblock');
});

await check('Replying and marking read from a notification (REST) work like the app', async () => {
  const before = anaSock.events.length;
  const reply = await call(cy, 'POST', `/rooms/${roomId}/messages`, { body: 'In!' });
  expect(reply.status === 201 && reply.data.message.body === 'In!', `room reply: ${reply.status}`);
  const dm = await call(bo, 'POST', `/dms/${ana.id}/messages`, { body: 'Yes, 8 works' });
  expect(dm.status === 201, `dm reply: ${dm.status} ${JSON.stringify(dm.data)}`);
  await sleep(400);
  const got = anaSock.events.slice(before);
  expect(got.some((e) => e.event === 'room:message' && e.data.body === 'In!'), 'room reply not delivered live');
  expect(got.some((e) => e.event === 'dm:new' && e.data.message.body === 'Yes, 8 works'), 'dm reply not delivered live');
  expect((await call(cy, 'POST', `/rooms/${roomId}/read`)).status === 204, 'room read');
  expect((await call(bo, 'POST', `/dms/${ana.id}/read`)).status === 204, 'dm read');
  expect((await call(cy, 'POST', `/dms/${ana.id}/messages`, { body: '' })).status === 400, 'empty reply accepted');
});

await check('Nobody can reply into, or mark, rooms and chats that are not theirs', async () => {
  const dan = await register('Dan');
  expect((await call(dan, 'POST', `/rooms/${roomId}/messages`, { body: 'let me in' })).status === 403, 'outsider posted to the room');
  expect((await call(dan, 'POST', `/rooms/${roomId}/read`)).status === 404, 'outsider marked the room read');
  expect((await call(null, 'POST', `/dms/${ana.id}/messages`, { body: 'hi' })).status === 401, 'signed out sent a message');
  expect((await call(dan, 'POST', `/dms/${dan.id}/messages`, { body: 'me' })).status === 400, 'messaged themselves');
  expect((await call(dan, 'POST', '/dms/not-a-uuid/messages', { body: 'x' })).status === 404, 'bad id');
  const cross = await call(bo, 'POST', `/dms/${ana.id}/messages`, { body: 'csrf' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  expect(cross.status === 403, `cross-site reply: ${cross.status}`);
});

let callId;
await check("Calling someone whose app is closed rings their phone instead of saying they're offline", async () => {
  boSock.disconnect();
  await sleep(300);
  const res = await emit(anaSock, 'call:start', { to: bo.id, video: false });
  expect(res.ok, `call refused: ${res.error}`);
  callId = res.callId;
  const p = await waitFor(() => pushesFor(TOKEN_BO, 'call').find((x) => x.data.callId === callId));
  expect(p, 'no ring push');
  expect(p.data.callerName === 'Ana' && p.data.callerId === ana.id && p.data.video === '0', `ring: ${JSON.stringify(p.data)}`);
  expect(/^\/api\/users\/[0-9a-f-]+\/photo\/[0-9a-f]{16}$/.test(p.data.callerPhoto ?? ''), `no caller photo: ${p.data.callerPhoto}`);
  expect(p.android.ttl === '40s', `a ring should not wait long in FCM (ttl ${p.android.ttl})`);
});

await check('Opening the app joins the ringing call, and answering stops other phones ringing', async () => {
  boSock = await connect(bo, true);
  const incoming = await waitFor(() => boSock.events.find((e) => e.event === 'call:incoming' && e.data.callId === callId));
  expect(incoming && incoming.data.from.name === 'Ana', 'the app was not given the call');
  const res = await emit(boSock, 'call:accept', { callId, video: false });
  expect(res.ok, `accept: ${res.error}`);
  const end = await waitFor(() => pushesFor(TOKEN_BO, 'call_end').find((x) => x.data.callId === callId));
  expect(end && end.data.reason === 'answered', `stop-ringing push: ${JSON.stringify(end?.data)}`);
  await emit(anaSock, 'call:end', { callId });
  await sleep(400);
  expect(pushesFor(TOKEN_BO, 'call_end').filter((x) => x.data.callId === callId).length === 1, 'pushed again when the answered call ended');
});

await check('Declining from the phone (REST) ends the call for the caller; nobody else can', async () => {
  boSock.disconnect();
  await sleep(300);
  const res = await emit(anaSock, 'call:start', { to: bo.id, video: true });
  expect(res.ok, `call: ${res.error}`);
  const id = res.callId;
  const ring = await waitFor(() => pushesFor(TOKEN_BO, 'call').find((x) => x.data.callId === id));
  expect(ring?.data.video === '1', 'video call should say so');
  expect((await call(cy, 'POST', `/calls/${id}/decline`)).status === 404, 'someone else declined it');
  expect((await call(null, 'POST', `/calls/${id}/decline`)).status === 401, 'signed out declined it');
  const before = anaSock.events.length;
  expect((await call(bo, 'POST', `/calls/${id}/decline`)).status === 204, 'decline failed');
  const ended = await waitFor(() => anaSock.events.slice(before).find((e) => e.event === 'call:ended' && e.data.callId === id));
  expect(ended?.data.reason === 'declined', `caller saw: ${JSON.stringify(ended?.data)}`);
  const end = await waitFor(() => pushesFor(TOKEN_BO, 'call_end').find((x) => x.data.callId === id));
  expect(end?.data.reason === 'declined', `phone told: ${JSON.stringify(end?.data)}`);
  expect((await call(bo, 'POST', `/calls/${id}/decline`)).status === 404, 'declined twice');
});

await check('A caller who hangs up leaves a missed call on the phone', async () => {
  const res = await emit(anaSock, 'call:start', { to: bo.id });
  expect(res.ok, `call: ${res.error}`);
  await waitFor(() => pushesFor(TOKEN_BO, 'call').find((x) => x.data.callId === res.callId));
  await emit(anaSock, 'call:end', { callId: res.callId });
  const end = await waitFor(() => pushesFor(TOKEN_BO, 'call_end').find((x) => x.data.callId === res.callId));
  expect(end?.data.reason === 'cancelled' && end.data.callerName === 'Ana', `missed: ${JSON.stringify(end?.data)}`);
});

await check('Someone with no phone and no app open is still "offline" to call', async () => {
  const eve = await register('Eve');
  const res = await emit(anaSock, 'call:start', { to: eve.id });
  expect(!res.ok && /offline/.test(res.error), `expected offline, got ${JSON.stringify(res)}`);
});

await check('An uninstalled app is forgotten; signing out stops the phone', async () => {
  gone.add(TOKEN_CY);
  await emit(anaSock, 'dm:send', { to: cy.id, body: 'Still there?' });
  await sleep(800);
  const again = await emit(anaSock, 'call:start', { to: cy.id });
  expect(!again.ok && /offline/.test(again.error), `Cy's dead phone still counts: ${JSON.stringify(again)}`);
  expect((await call(bo, 'DELETE', '/push/devices', { token: TOKEN_BO })).status === 204, 'unregister');
  const n = pushesFor(TOKEN_BO).length;
  await emit(anaSock, 'dm:send', { to: bo.id, body: 'Gone?' });
  await sleep(600);
  expect(pushesFor(TOKEN_BO).length === n, 'pushed after signing out');
});

await check('Changing your password stops notifications to your other phones', async () => {
  await call(bo, 'POST', '/push/devices', { token: TOKEN_BO });
  const res = await fetch(`${API}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bo.cookie },
    body: JSON.stringify({ currentPassword: 'password123', newPassword: 'password456' }),
  });
  expect(res.status === 200, `password: ${res.status}`);
  const n = pushesFor(TOKEN_BO).length;
  await emit(anaSock, 'dm:send', { to: bo.id, body: 'After the change' });
  await sleep(600);
  expect(pushesFor(TOKEN_BO).length === n, 'the old phone still got pushes');
});

await check('The server stays up; bad client:state input is harmless', async () => {
  for (const bad of [null, 1, 'x', [], { active: 'yes' }]) anaSock.emit('client:state', bad);
  await sleep(200);
  expect((await call(ana, 'GET', '/auth/me')).status === 200, 'server down');
});

anaSock?.disconnect();
boSock?.disconnect();
server.kill();
fake.close();

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(' -', f[1], ':', f[2]);
  if (/Error|error/.test(serverLog)) console.log('\nServer log:\n', serverLog.split('\n').filter((l) => /rror/.test(l)).slice(0, 20).join('\n'));
  process.exit(1);
}
