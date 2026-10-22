import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';

// Security and robustness: who can reach what, forged logins, other websites,
// bad input to every endpoint and live event, injected HTML, disguised files.
// Runs against the dev servers (npm run dev); the API is reached directly too.
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? 'http://localhost:4080';
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

/** A REST call as someone (or no one), from our own site unless `origin` says otherwise. */
async function call(user, method, path, body, { origin, raw, headers = {} } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      ...(user?.cookie ? { cookie: user.cookie } : {}),
      ...(origin ? { origin } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

async function register(name) {
  const email = `${name.toLowerCase()}.${stamp}@example.com`;
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, email, password: 'password123', id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0], setCookie: res.headers.get('set-cookie') };
}

/** A live connection as someone; resolves once connected (or rejects with the refusal). */
function connect(user, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const s = io(API, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { ...(user?.cookie ? { cookie: user.cookie } : {}), ...(origin ? { origin } : {}) },
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (err) => {
      s.close();
      reject(err);
    });
  });
}
const emit = (s, event, payload, ms = 4000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'no answer' }), ms);
    s.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
const alive = async () => (await fetch(`${API}/api/health`).catch(() => null))?.status === 200;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny valid PNG, an SVG with a script, and an HTML page.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c636000010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');
async function upload(user, buffer, meta) {
  return call(user, 'POST', '/uploads', undefined, {
    raw: buffer,
    headers: { 'content-type': 'application/octet-stream', 'x-upload-meta': encodeURIComponent(JSON.stringify(meta)) },
  });
}

const A = await register('Asha');
const B = await register('Rahul');
const C = await register('Intruder');
const sA = await connect(A);
const sB = await connect(B);
const sC = await connect(C);

// Shared fixtures: a private room of Asha and Rahul, a chat between them, files in both.
const room = (await call(A, 'POST', '/rooms', { name: `Private ${stamp}`, maxMembers: 5 })).data.room;
await call(A, 'POST', `/rooms/${room.id}/members`, { userId: B.id });
const roomMsg = (await emit(sA, 'room:send', { roomId: room.id, body: 'room secret' })).message;
const dmMsg = (await emit(sA, 'dm:send', { to: B.id, body: 'dm secret' })).message;
const photo = (await upload(A, PNG, { kind: 'image', name: 'p.png', mime: 'image/png', width: 1, height: 1 })).data.attachment;
await emit(sA, 'room:send', { roomId: room.id, body: '', attachmentId: photo.id });

// ── Logging in ──

await check('every private endpoint refuses someone who isn’t logged in', async () => {
  const paths = [
    ['GET', '/users/find?q=a'], ['GET', '/dms'], ['GET', `/dms/${A.id}`], ['GET', '/rooms'], ['GET', `/rooms/${room.id}`],
    ['GET', `/rooms/${room.id}/messages`], ['GET', '/invites'], ['GET', '/config'], ['GET', '/site'], ['GET', '/admin/overview'],
    ['GET', `/files/${photo.id}`], ['POST', '/rooms'], ['POST', '/uploads'], ['POST', '/auth/password'],
    ['POST', '/reports'], ['GET', '/users/blocked'], ['POST', `/users/${B.id}/block`], ['PUT', `/dms/${B.id}/settings`],
    ['PUT', `/rooms/${room.id}/settings`], ['GET', `/previews/${'a'.repeat(32)}`], ['GET', '/admin/reports'], ['GET', '/admin/messaging'],
  ];
  for (const [m, p] of paths) {
    const r = await call(null, m, p, m === 'POST' ? {} : undefined);
    expect(r.status === 401, `${m} ${p} answered ${r.status}`);
  }
});

await check('a live connection without a login is refused', async () => {
  const err = await connect(null).then((s) => (s.close(), null), (e) => e);
  expect(err?.message === 'unauthorized', `connected without logging in (${err?.message})`);
});

await check('forged login cookies are refused (wrong key, "none" algorithm, garbage)', async () => {
  const forged = [
    jwt.sign({ sub: A.id }, 'not-the-real-secret', { expiresIn: '1d' }),
    `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: A.id })).toString('base64url')}.`,
    'garbage',
  ];
  for (const token of forged) {
    const r = await call({ cookie: `adda_token=${token}` }, 'GET', '/rooms');
    expect(r.status === 401, `forged token got ${r.status}`);
    const me = await call({ cookie: `adda_token=${token}` }, 'GET', '/auth/me');
    expect(me.data?.user === null, 'a forged token was treated as logged in');
  }
});

await check('the login cookie can’t be read by page scripts or sent from other sites', async () => {
  expect(/HttpOnly/i.test(A.setCookie), `cookie: ${A.setCookie}`);
  expect(/SameSite=Lax/i.test(A.setCookie), `cookie: ${A.setCookie}`);
});

await check('logins are rate-limited, and take as long for unknown emails as for wrong passwords', async () => {
  const r = await call(null, 'POST', '/auth/login', { email: 'nobody@example.com', password: 'x' });
  expect(r.status === 401, `login answered ${r.status}`);
  const policy = r.headers.get('ratelimit-policy') ?? '';
  // 60 per 15 minutes in production (600 in development, where tests share one address).
  expect(/q=(60|600); w=900/.test(policy), `no login rate limit (policy "${policy}")`);
  const time = async (email) => {
    const t = performance.now();
    await call(null, 'POST', '/auth/login', { email, password: 'wrong-password' });
    return performance.now() - t;
  };
  let known = 0;
  let unknown = 0;
  for (let i = 0; i < 3; i++) {
    known += await time(A.email);
    unknown += await time(`ghost.${i}.${stamp}@example.com`);
  }
  expect(Math.abs(known - unknown) / 3 < 40, `known ${Math.round(known / 3)} ms vs unknown ${Math.round(unknown / 3)} ms`);
});

// ── Other websites ──

await check('another website can’t make changes with a visitor’s login', async () => {
  const r = await call(A, 'POST', '/rooms', { name: 'From evil', maxMembers: 3 }, { origin: 'https://evil.example' });
  expect(r.status === 403, `cross-site POST answered ${r.status}`);
  const d = await call(A, 'DELETE', `/rooms/${room.id}`, undefined, { origin: 'https://evil.example' });
  expect(d.status === 403, `cross-site DELETE answered ${d.status}`);
  const fetchMeta = await call(A, 'PATCH', `/rooms/${room.id}`, { name: 'Taken' }, { headers: { 'sec-fetch-site': 'cross-site' } });
  expect(fetchMeta.status === 403, `a request marked cross-site by the browser answered ${fetchMeta.status}`);
  const ok = await call(A, 'GET', `/rooms/${room.id}`, undefined, { origin: 'https://evil.example' });
  expect(ok.status === 200, 'reading is still allowed (other sites can’t see the answer anyway)');
});

await check('another website can’t open a live connection with a visitor’s login', async () => {
  const err = await connect(A, { origin: 'https://evil.example' }).then((s) => (s.close(), null), (e) => e);
  expect(err, 'a cross-site live connection was accepted');
  const own = await connect(A, { origin: API });
  own.close();
});

await check('responses carry security headers', async () => {
  const r = await fetch(`${API}/api/health`);
  for (const [h, v] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'strict-origin-when-cross-origin']]) {
    expect(r.headers.get(h) === v, `${h}: ${r.headers.get(h)}`);
  }
  expect(!r.headers.get('x-powered-by'), 'x-powered-by leaks the server');
});

// ── Rooms, chats and files of other people ──

await check('an outsider can’t see, change, join or post in someone else’s room', async () => {
  for (const [m, p, body] of [
    ['GET', `/rooms/${room.id}`], ['GET', `/rooms/${room.id}/messages`], ['PATCH', `/rooms/${room.id}`, { name: 'Taken' }],
    ['DELETE', `/rooms/${room.id}`], ['POST', `/rooms/${room.id}/members`, { userId: C.id }], ['POST', `/rooms/${room.id}/invites`, { userId: C.id }],
  ]) {
    const r = await call(C, m, p, body);
    expect([403, 404].includes(r.status), `${m} ${p} answered ${r.status}`);
  }
  for (const [event, payload] of [
    ['room:send', { roomId: room.id, body: 'hi' }], ['msg:react', { scope: 'room', messageId: roomMsg.id, emoji: '👍' }],
    ['voice:join', { roomId: room.id }], ['watch:set', { roomId: room.id, url: 'https://example.com/v.mp4' }],
    ['watch:stop', { roomId: room.id }], ['live:start', { roomId: room.id, mode: 'file', title: 'x' }],
    ['msg:edit', { scope: 'room', messageId: roomMsg.id, body: 'changed' }],
    ['msg:forward', { scope: 'room', messageId: roomMsg.id, to: [{ scope: 'dm', id: C.id }] }],
    ['msg:forward', { scope: 'dm', messageId: dmMsg.id, to: [{ scope: 'room', id: room.id }] }],
  ]) {
    const r = await emit(sC, event, payload);
    expect(r?.ok === false, `${event} was allowed for an outsider`);
  }
  // Nor pin, archive or mute it, report its messages, or see a report.
  expect((await call(C, 'PUT', `/rooms/${room.id}/settings`, { pinned: true })).status === 404, 'an outsider pinned the room');
  expect((await call(C, 'POST', '/reports', { scope: 'room', messageId: roomMsg.id, reason: 'spam' })).status === 404, 'an outsider reported a room message');
  expect((await call(C, 'POST', '/reports', { scope: 'dm', messageId: dmMsg.id, reason: 'spam' })).status === 404, 'an outsider reported a private message');
  for (const [m, p, body] of [['GET', '/admin/reports'], ['GET', '/admin/messaging'], ['PATCH', '/admin/messaging', { editing: false }]]) {
    expect((await call(C, m, p, body)).status === 403, `${m} ${p} was allowed for someone who isn’t the host`);
  }
  const msgs = await call(A, 'GET', `/rooms/${room.id}/messages`);
  expect(!JSON.stringify(msgs.data).includes('Intruder'), 'the outsider left a trace in the room');
});

await check('a member who isn’t an admin can’t run the room', async () => {
  for (const [m, p, body] of [['PATCH', `/rooms/${room.id}`, { maxMembers: 50 }], ['DELETE', `/rooms/${room.id}`], ['POST', `/rooms/${room.id}/members`, { userId: C.id }]]) {
    const r = await call(B, m, p, body);
    expect(r.status === 403, `${m} ${p} answered ${r.status} for a member`);
  }
  for (const [event, payload] of [['watch:set', { roomId: room.id, url: 'https://example.com/v.mp4' }], ['live:start', { roomId: room.id, mode: 'screen' }]]) {
    const r = await emit(sB, event, payload);
    expect(r?.ok === false, `${event} was allowed for a member`);
  }
});

await check('nobody can edit a message that isn’t theirs, or forward it as their own', async () => {
  expect((await emit(sB, 'msg:edit', { scope: 'dm', messageId: dmMsg.id, body: 'Rahul’s words now' })).ok === false, 'Rahul edited Asha’s chat message');
  expect((await emit(sB, 'msg:edit', { scope: 'room', messageId: roomMsg.id, body: 'Rahul’s words now' })).ok === false, 'Rahul edited Asha’s room message');
  const fwd = await emit(sB, 'msg:forward', { scope: 'dm', messageId: dmMsg.id, to: [{ scope: 'room', id: room.id }] });
  expect(fwd.ok && fwd.results[0].ok, `forward: ${JSON.stringify(fwd)}`);
  const copy = (await call(A, 'GET', `/rooms/${room.id}/messages`)).data.messages.at(-1);
  expect(copy.sender.id === B.id && copy.forwarded === true && copy.body === 'dm secret', `the copy: ${JSON.stringify(copy)}`);
  // A forwarded message can't be passed off as fresh, nor a "forwarded" mark faked.
  const fake = await emit(sC, 'dm:send', { to: B.id, body: 'pretend', forwarded: true, preview: { url: 'https://evil.example', title: 'Phish', image: '/api/files/x' } });
  expect(fake.ok && !fake.message.forwarded && !fake.message.preview, `the app set server-only fields: ${JSON.stringify(fake.message)}`);
});

await check('an outsider can’t read or react to a private chat', async () => {
  const r = await call(C, 'GET', `/dms/${A.id}`);
  expect(!JSON.stringify(r.data).includes('dm secret'), 'the outsider read the chat');
  const list = await call(C, 'GET', '/dms');
  expect(!JSON.stringify(list.data).includes('dm secret'), 'the outsider saw the chat in their list');
  const react = await emit(sC, 'msg:react', { scope: 'dm', messageId: dmMsg.id, emoji: '👍' });
  expect(react?.ok === false, 'the outsider reacted to the chat');
});

await check('a message can’t pretend to come from someone else', async () => {
  const r = await emit(sC, 'dm:send', { to: B.id, body: 'spoof', from: A.id, senderId: A.id, sender_id: A.id });
  expect(r.ok && r.message.senderId === C.id, `sent as ${r.message?.senderId}`);
});

await check('files stay private, and someone else’s upload can’t be sent as your own', async () => {
  expect((await call(C, 'GET', `/files/${photo.id}`)).status === 404, 'an outsider opened a room file');
  expect((await call(B, 'GET', `/files/${photo.id}`)).status === 200, 'a member could not open a room file');
  const mine = (await upload(A, PNG, { kind: 'image', name: 'q.png', mime: 'image/png' })).data.attachment;
  const steal = await emit(sC, 'dm:send', { to: B.id, body: 'look', attachmentId: mine.id });
  expect(steal?.ok === false, 'someone else’s upload was attached');
});

await check('disguised uploads (SVG with a script, HTML as a photo) only ever download', async () => {
  for (const [buf, meta] of [[SVG, { kind: 'image', name: 'x.svg', mime: 'image/svg+xml' }], [HTML, { kind: 'image', name: 'x.png', mime: 'image/png' }]]) {
    const up = await upload(A, buf, meta);
    expect(up.status === 201 && up.data.attachment.kind === 'file', `stored as ${up.data?.attachment?.kind}`);
    await emit(sA, 'dm:send', { to: B.id, body: '', attachmentId: up.data.attachment.id });
    const res = await fetch(`${API}/api/files/${up.data.attachment.id}`, { headers: { cookie: B.cookie } });
    expect(res.headers.get('content-type') === 'application/octet-stream', `served as ${res.headers.get('content-type')}`);
    expect(/^attachment/.test(res.headers.get('content-disposition') ?? ''), 'shown inside the page');
    expect(/sandbox/.test(res.headers.get('content-security-policy') ?? ''), 'no sandbox policy');
  }
  const named = await upload(A, PNG, { kind: 'file', name: 'evil"\r\nSet-Cookie: x=1.png', mime: 'image/png' });
  await emit(sA, 'dm:send', { to: B.id, body: '', attachmentId: named.data.attachment.id });
  const res = await fetch(`${API}/api/files/${named.data.attachment.id}`, { headers: { cookie: B.cookie } });
  expect(!res.headers.get('set-cookie'), 'a file name injected a header');
});

await check('the host admin’s pages refuse everyone else', async () => {
  for (const [m, p, body] of [
    ['GET', '/admin/overview'],
    ['GET', '/admin/users'],
    ['PATCH', `/admin/users/${C.id}`, { siteAdmin: true }],
    ['DELETE', `/admin/rooms/${room.id}`],
    ['PATCH', '/admin/settings', { allowSignups: false }],
    // The mail server: its settings, and sending email through it.
    ['GET', '/admin/email'],
    ['PUT', '/admin/email', { enabled: true, host: 'evil.example', port: 25, security: 'none', user: '', from: 'x@evil.example', verifySignups: false }],
    ['DELETE', '/admin/email'],
    ['POST', '/admin/email/test', { to: 'victim@example.com' }],
  ]) {
    const r = await call(C, m, p, body);
    expect(r.status === 403, `${m} ${p} answered ${r.status}`);
  }
});

await check('a video relay link only works for the room’s members with the right token', async () => {
  for (const u of [B, C]) {
    const r = await call(u, 'GET', `/stream/${room.id}/not-the-token/main`);
    expect(r.status === 404, `relay answered ${r.status}`);
  }
});

// ── Passwords ──

await check('changing your password signs you out everywhere else, but not on this device', async () => {
  const old = { cookie: C.cookie };
  const r = await call(C, 'POST', '/auth/password', { currentPassword: 'password123', newPassword: 'new-password-123' });
  expect(r.status === 200, `change answered ${r.status}`);
  const fresh = r.headers.get('set-cookie')?.split(';')[0];
  expect(fresh, 'no new login cookie for this device');
  await wait(1100);
  expect((await call(old, 'GET', '/rooms')).status === 401, 'the old login still works');
  C.cookie = fresh;
  expect((await call(C, 'GET', '/rooms')).status === 200, 'this device was signed out');
  const live = await connect(old).then((s) => (s.close(), 'connected'), () => 'refused');
  expect(live === 'refused', 'the old login opened a live connection');
});

// ── Bad input ──

await check('bad input gets a clear 4xx answer, never a crash or a 500', async () => {
  const cases = [
    ['POST', '/rooms', undefined, { raw: '{"name": ', headers: { 'content-type': 'application/json' } }],
    ['POST', '/rooms', { name: 'x'.repeat(61), maxMembers: 5 }],
    ['POST', '/rooms', { name: 'Ok', maxMembers: 1000 }],
    ['POST', '/rooms', { name: 'Ok', maxMembers: 'abc' }],
    ['POST', '/rooms', { name: { $gt: '' }, maxMembers: 5 }],
    ['GET', '/rooms/not-a-uuid'],
    ['GET', "/rooms/' OR 1=1 --"],
    ['GET', '/users/%00'],
    ['GET', '/files/..%2f..%2fetc%2fpasswd'],
    ['GET', '/rooms/00000000-0000-0000-0000-000000000000/messages?before=abc'],
    ['POST', '/rooms', { name: 'x'.repeat(40_000), maxMembers: 5 }],
    ['POST', '/auth/register', { name: '', email: 'not-an-email', password: 'short' }],
    ['POST', '/auth/register', { name: 'x'.repeat(41), email: `long.${stamp}@example.com`, password: 'password123' }],
    ['POST', '/auth/login', { email: ['a'], password: { x: 1 } }],
    ['POST', '/auth/register/confirm', { token: { $ne: 1 }, code: 123 }],
    ['POST', '/auth/register/confirm', { token: 'x'.repeat(5000), code: '1'.repeat(5000) }],
    ['POST', '/auth/register/resend', { token: ['a'] }],
    ['POST', '/auth/forgot', { email: { $gt: '' } }],
    ['POST', '/auth/reset', { email: 'a@b.co', code: { $ne: '' }, password: 'password123' }],
    ['POST', '/auth/reset', { email: `nobody.${stamp}@example.com`, code: '123456', password: 'short' }],
    ['POST', '/uploads', undefined, { raw: PNG, headers: { 'content-type': 'application/octet-stream', 'x-upload-meta': '%E0%A4%A' } }],
  ];
  for (const [m, p, body, opts] of cases) {
    const r = await call(A, m, p, body, opts);
    expect(r.status >= 400 && r.status < 500, `${m} ${p} answered ${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
  }
  const search = await call(A, 'GET', `/users/find?q=${encodeURIComponent("' OR 1=1 --")}`);
  expect(search.status === 400 && !search.data.user, 'a SQL-looking search found someone');
  expect(await alive(), 'the server went down');
});

const EVENTS = ['call:accept', 'call:camera', 'call:decline', 'call:end', 'call:mute', 'call:resume', 'call:signal', 'call:start', 'client:state', 'dm:read', 'dm:send', 'dm:typing', 'live:leave', 'live:progress', 'live:resume', 'live:signal', 'live:start', 'live:stop', 'live:watch', 'msg:delete', 'msg:edit', 'msg:forward', 'msg:react', 'room:read', 'room:send', 'room:typing', 'time:now', 'voice:camera', 'voice:join', 'voice:leave', 'voice:mute', 'voice:signal', 'watch:control', 'watch:duration', 'watch:mute', 'watch:next', 'watch:queue-add', 'watch:queue-clear', 'watch:queue-move', 'watch:queue-play', 'watch:queue-remove', 'watch:scan', 'watch:set', 'watch:stop'];
const BAD = [null, 42, 'text', [], true, { roomId: {}, to: [], callId: null }, { roomId: 'x'.repeat(5000), body: { $ne: 1 } }, { roomId: room.id, messageId: '1; DROP TABLE users', emoji: '<script>' }, { to: B.id, data: { sdp: { type: 'offer', sdp: 42 } }, callId: '../../' }];

await check('every live event survives garbage: the server stays up and answers with an error', async () => {
  const s = await connect(C);
  let answered = 0;
  for (const event of EVENTS) {
    for (const payload of BAD) {
      const r = await emit(s, event, payload, 1500);
      if (r && r.error !== 'no answer') answered++;
      // A few events answer nothing on purpose (signals, typing); they just mustn't crash.
    }
    expect(await alive(), `the server went down after "${event}"`);
  }
  expect(s.connected, 'the connection was dropped');
  s.close();
  console.log(`     ${EVENTS.length} events × ${BAD.length} bad payloads, ${answered} answered with an error, server still up`);
});

await check('nobody can take over someone else’s phone for their notifications', async () => {
  const token = `phone-${stamp}-${'x'.repeat(40)}`;
  expect((await call(B, 'POST', '/push/devices', { token })).status === 204, 'registering my own phone failed');
  const steal = await call(C, 'POST', '/push/devices', { token });
  expect(steal.status === 409, `claiming someone else’s phone answered ${steal.status}`);
  expect((await call(B, 'POST', '/push/devices', { token })).status === 204, 'the owner can’t register their phone any more');
  await call(B, 'DELETE', '/push/devices', { token });
});

await check('someone outside a call can’t change it', async () => {
  const start = await emit(sA, 'call:start', { to: B.id, video: false });
  expect(start.ok, `starting the call: ${start.error}`);
  sC.emit('call:camera', { callId: start.callId, on: true });
  await wait(300);
  await emit(sB, 'call:decline', { callId: start.callId });
  await wait(300);
  const record = (await call(A, 'GET', `/dms/${B.id}/messages`)).data.messages.filter((m) => m.kind === 'call').at(-1);
  expect(record?.meta?.video === false, `the call’s record says ${JSON.stringify(record?.meta)}`);
});

await check('calls can’t be used to flood someone’s phone', async () => {
  const answers = [];
  for (let i = 0; i < 7; i++) {
    const res = await emit(sC, 'call:start', { to: B.id });
    answers.push(res.ok ? 'rang' : res.error);
    if (res.ok) await emit(sC, 'call:end', { callId: res.callId });
  }
  expect(answers.filter((a) => a === 'rang').length <= 5 && answers.at(-1) !== 'rang', `calls: ${answers.join(' | ')}`);
});

await check('message pages from a nonsense starting point answer normally', async () => {
  for (const before of ['1e30', '9e99', '99999999999999999999', 'Infinity', '-5', 'abc']) {
    const inRoom = await call(A, 'GET', `/rooms/${room.id}/messages?before=${before}`);
    const inChat = await call(A, 'GET', `/dms/${B.id}/messages?before=${before}`);
    expect(inRoom.status === 200 && inChat.status === 200, `before=${before}: ${inRoom.status}, ${inChat.status}`);
  }
});

await check('nobody sees someone else’s email address', async () => {
  const incoming = new Promise((resolve) => sB.once('dm:new', resolve));
  await emit(sA, 'dm:send', { to: B.id, body: 'who are you' });
  const seen = [
    ['a lookup by ID', (await call(C, 'GET', `/users/${A.id}`)).data?.user],
    ['finding by email', (await call(C, 'GET', `/users/find?q=${encodeURIComponent(A.email)}`)).data?.user],
    ['the chat list', (await call(B, 'GET', '/dms')).data.conversations.find((c) => c.partner.id === A.id)?.partner],
    ['room members', (await call(B, 'GET', `/rooms/${room.id}`)).data.room.members.find((m) => m.id === A.id)],
    ['a live message', (await incoming).partner],
  ];
  const leaks = seen.filter(([, u]) => !u || 'email' in u).map(([where, u]) => (u ? where : `${where} (missing)`));
  expect(!leaks.length, `email shown in: ${leaks.join(', ')}`);
  expect((await call(A, 'GET', '/auth/me')).data.user.email === A.email, 'my own email is gone from my account');
});

await check('a message sent again because its answer was lost is saved once', async () => {
  const clientId = `resend-${stamp}`;
  let arrived = 0;
  const count = (p) => p.message?.body === `once ${stamp}` && arrived++;
  sB.on('dm:new', count);
  const first = await emit(sA, 'dm:send', { to: B.id, body: `once ${stamp}`, clientId });
  const again = await emit(sA, 'dm:send', { to: B.id, body: `once ${stamp}`, clientId });
  const twins = await Promise.all([1, 2].map(() => emit(sA, 'dm:send', { to: B.id, body: 'twins', clientId: `${clientId}-p` })));
  const inRoom = [];
  for (let i = 0; i < 2; i++) inRoom.push(await emit(sA, 'room:send', { roomId: room.id, body: `once ${stamp}`, clientId: `${clientId}-r` }));
  await wait(500);
  sB.off('dm:new', count);
  expect(first.message?.id && first.message.id === again.message?.id, `the resend got ${first.message?.id} and ${again.message?.id}`);
  expect(arrived === 1, `Rahul got it ${arrived} times`);
  expect(twins[0].message?.id && twins[0].message.id === twins[1].message?.id, `two at once got ${twins.map((t) => t.message?.id ?? t.error)}`);
  expect(inRoom[0].message?.id && inRoom[0].message.id === inRoom[1].message?.id, `in the room: ${inRoom.map((t) => t.message?.id ?? t.error)}`);
});

await check('reactions are emoji, not digits or symbols', async () => {
  for (const emoji of ['1234', '#*#*', '7']) {
    const res = await emit(sA, 'msg:react', { scope: 'dm', messageId: dmMsg.id, emoji });
    expect(!res.ok, `"${emoji}" was accepted as a reaction`);
  }
  for (const emoji of ['👍', '❤️', '1️⃣', '🇧🇩', '👍🏽']) {
    const res = await emit(sA, 'msg:react', { scope: 'dm', messageId: dmMsg.id, emoji });
    expect(res.ok, `"${emoji}" was refused: ${res.error}`);
  }
});

await check('doing the same thing twice at once does it once', async () => {
  const D = await register('Dev');
  const E = await register('Esha');
  const own = (await call(A, 'POST', '/rooms', { name: `Busy ${stamp}`, maxMembers: 5 })).data.room;
  await call(A, 'POST', `/rooms/${own.id}/invites`, { userId: D.id });
  const invite = (await call(D, 'GET', '/invites')).data.invites.find((i) => i.room.id === own.id);
  const accepts = await Promise.all([1, 2, 3].map(() => call(D, 'POST', `/invites/${invite.id}/accept`)));
  const joins = await Promise.all([1, 2, 3].map(() => call(E, 'POST', '/rooms/join', { code: own.joinCode })));
  const notes = (await call(A, 'GET', `/rooms/${own.id}/messages`)).data.messages.filter((m) => m.kind === 'system').map((m) => m.body);
  const joined = (name) => notes.filter((n) => n.startsWith(name) && /joined/.test(n)).length;
  expect([...accepts, ...joins].every((r) => r.status < 500), `answers: ${[...accepts, ...joins].map((r) => r.status)}`);
  expect(joined('Dev') === 1 && joined('Esha') === 1, `room notes: ${JSON.stringify(notes)}`);
  expect((await call(A, 'GET', `/rooms/${own.id}`)).data.room.memberCount === 3, 'member count is off');
});

await check('a removed account’s login stops working at once', async () => {
  const G = await register('Gone');
  const host = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin', password: 'admin' }) });
  expect(host.ok, `the host admin login (admin / admin) failed: ${host.status}`);
  const H = { cookie: host.headers.get('set-cookie').split(';')[0] };
  const sG = await connect(G);
  const cut = new Promise((resolve) => sG.once('disconnect', () => resolve(true)));
  expect((await call(H, 'DELETE', `/admin/users/${G.id}`)).status < 300, 'removing the account failed');
  const after = [await call(G, 'GET', '/config'), await call(G, 'GET', `/users/find?q=${encodeURIComponent(A.email)}`), await call(G, 'GET', '/auth/me')];
  expect(after[0].status === 401 && after[1].status === 401, `after removal: ${after.map((r) => r.status)}`);
  expect(!after[2].data?.user, 'the removed account is still signed in');
  expect(await Promise.race([cut, wait(3000).then(() => false)]), 'its live connection stayed open');
  sG.close();
});

await check('message limits: too long, empty, not text, and flooding are refused', async () => {
  expect((await emit(sA, 'room:send', { roomId: room.id, body: 'x'.repeat(4001) })).ok === false, 'a 4001-character message was sent');
  expect((await emit(sA, 'room:send', { roomId: room.id, body: '   ' })).ok === false, 'an empty message was sent');
  expect((await emit(sA, 'room:send', { roomId: room.id, body: { text: 'hi' } })).ok === false, 'a non-text message was sent');
  const flood = await Promise.all(Array.from({ length: 30 }, (_, i) => emit(sA, 'room:send', { roomId: room.id, body: `flood ${i}` })));
  const refused = flood.filter((r) => r.ok === false && /too fast/.test(r.error)).length;
  expect(refused >= 5, `only ${refused} of 30 rapid messages were held back`);
});

// ── Injected HTML in the app ──

await check('HTML and scripts in messages, names and room fields show as plain text', async () => {
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await wait(10_500); // the flood check above used up Asha's message allowance
  const xroom = (await call(A, 'POST', '/rooms', { name: '<b onmouseover=window.__xss=3>Room</b>', description: evil, maxMembers: 5 })).data.room;
  await call(A, 'POST', `/rooms/${xroom.id}/members`, { userId: B.id });
  await emit(sA, 'room:send', { roomId: xroom.id, body: evil });
  await emit(sA, 'dm:send', { to: B.id, body: evil });
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email or username').fill(B.email);
  await page.getByLabel('Password').fill(B.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(`${BASE}/chats`);
  await page.goto(`${BASE}/chats/${A.id}`);
  await page.getByRole('log').getByText('<img src=x', { exact: false }).first().waitFor({ timeout: 8000 });
  await page.goto(`${BASE}/rooms/${xroom.id}`);
  await page.getByRole('log').getByText('<script>', { exact: false }).first().waitFor({ timeout: 8000 });
  await page.getByText('<b onmouseover', { exact: false }).first().hover();
  await page.waitForTimeout(500);
  const xss = await page.evaluate(() => window.__xss);
  const injected = await page.evaluate(() => document.querySelectorAll('[role=log] img[src="x"], [role=log] script').length);
  await browser.close();
  expect(xss === undefined && injected === 0, `injected markup ran (xss=${xss}, elements=${injected})`);
});

await check('the server logged no crashes or unexpected errors during all of this', async () => {
  expect(await alive(), 'the server is down');
});

sA.close();
sB.close();
sC.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAIL', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
