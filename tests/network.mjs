import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// Switching networks (mobile data to Wi-Fi, a tunnel), as in other
// messengers: the connection drops and comes back by itself, and a room's
// call or a one-to-one call carries on. The person shows "Reconnecting…",
// the others see them reconnecting (their seat waits), and the call's sound
// and video get a new path. Gone for good, they leave after the wait. Runs
// against the dev servers (npm run dev), with fake microphones and cameras;
// a page's network going down is Chrome's "offline".
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

async function call(user, method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(user?.cookie ? { cookie: user.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function register(name) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.net.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const ROOM = `Night owls ${stamp}`;
const room = (await call(A, 'POST', '/rooms', { name: ROOM, maxMembers: 6 })).data.room;
await call(A, 'POST', `/rooms/${room.id}/members`, { userId: B.id });
await call(A, 'POST', `/dms/${B.id}/messages`, { body: 'Hi' });

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function page(user, phone = false) {
  const ctx = await browser.newContext({
    ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }),
    permissions: ['microphone', 'camera'],
  });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  // Every call connection, to see what flows over it.
  await ctx.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__pcs.push(this);
      }
    };
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
/** Bytes of sound and video received over the page's working call connections. */
const received = (p) =>
  p.evaluate(async () => {
    let bytes = 0;
    for (const pc of window.__pcs) {
      if (pc.connectionState !== 'connected') continue;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp') bytes += r.bytesReceived;
      });
    }
    return bytes;
  });
/** Sound (and video) arriving: the bytes keep growing. */
async function flowing(p, who) {
  const end = Date.now() + 15_000;
  let before = await received(p);
  while (Date.now() < end) {
    await sleep(1500);
    const now = await received(p);
    if (now > before + 2000) return;
    before = now;
  }
  throw new Error(`nothing arriving at ${who}`);
}
const toasts = (p) => p.locator('[role=status], [role=alert]').allInnerTexts();
const voiceBar = (p) => p.getByRole('region', { name: 'Room voice' });
const voiceOf = (p, id) => p.evaluate(([roomId, id]) => window.adda.chat.getState().voice[roomId]?.find((x) => x.userId === id) ?? null, [room.id, id]);

const pa = await page(A, true);
const pb = await page(B);

try {
  await check('room voice survives a short drop: “Reconnecting…”, then the same seat, with sound again', async () => {
    await pa.goto(`${BASE}/rooms/${room.id}`);
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await pa.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('button', { name: 'Join voice' }).first().click();
    await voiceBar(pa).getByText('Talking with 1 other').waitFor({ timeout: 15_000 });
    await flowing(pa, 'Asha');
    await flowing(pb, 'Bikram');
    await pa.context().setOffline(true);
    await voiceBar(pa).getByText('Reconnecting…').waitFor({ timeout: 8000 });
    await pa.screenshot({ path: `${SHOTS}network-1-reconnecting.png` });
    await sleep(3000);
    await pa.context().setOffline(false);
    await voiceBar(pa).getByText('Talking with 1 other').waitFor({ timeout: 15_000 });
    expect(!(await toasts(pa)).some((t) => /left voice/.test(t)), 'Asha was told she left voice');
    expect(await voiceOf(pb, A.id), 'Asha isn’t in voice for Bikram');
    await flowing(pb, 'Bikram');
    await flowing(pa, 'Asha');
  });

  await check('a longer drop: the others see them reconnecting while their seat waits; back, it carries on', async () => {
    await pa.context().setOffline(true);
    // The server notices the dead connection by its heartbeat.
    await pb.waitForFunction(([roomId, id]) => window.adda.chat.getState().voice[roomId]?.find((x) => x.userId === id)?.away === true, [room.id, A.id], {
      timeout: 25_000,
    });
    await pb.getByRole('region', { name: 'Voice', exact: true }).locator('[title*="(reconnecting)"]').waitFor();
    await pb.screenshot({ path: `${SHOTS}network-2-seat-waits.png` });
    await pa.context().setOffline(false);
    await pb.waitForFunction(([roomId, id]) => window.adda.chat.getState().voice[roomId]?.find((x) => x.userId === id)?.away === undefined, [room.id, A.id], {
      timeout: 20_000,
    });
    await voiceBar(pa).getByText('Talking with 1 other').waitFor({ timeout: 15_000 });
    await flowing(pb, 'Bikram');
    await flowing(pa, 'Asha');
  });

  await check('a call connection that breaks gets a fresh one (the other side asks), and works', async () => {
    // Whoever has the smaller id asks the other for a fresh connection, as on a failure.
    const [small, big] = A.id < B.id ? [pa, pb] : [pb, pa];
    const bigId = A.id < B.id ? B.id : A.id;
    const before = await big.evaluate(() => window.__pcs.length);
    await small.evaluate(([roomId, to]) => window.adda.socket.emit('voice:signal', { roomId, to, data: { restart: true } }), [room.id, bigId]);
    await big.waitForFunction((n) => window.__pcs.length > n, before, { timeout: 8000 });
    await flowing(pa, 'Asha');
    await flowing(pb, 'Bikram');
    await pa.getByRole('button', { name: 'Leave voice' }).click();
    await pb.getByRole('button', { name: 'Leave voice' }).click();
  });

  let callId;
  await check('a one-to-one video call survives a drop: both see “Reconnecting…”, then it goes on with a new path', async () => {
    await pa.goto(`${BASE}/chats/${B.id}`);
    await pb.goto(`${BASE}/chats/${A.id}`);
    await pa.getByRole('button', { name: 'Video call Bikram Sil' }).click();
    await pb.getByRole('button', { name: 'Accept with video' }).click();
    await pa.waitForFunction(() => window.adda.call.getState().phase === 'active', null, { timeout: 15_000 });
    callId = await pa.evaluate(() => window.adda.call.getState().callId);
    await flowing(pb, 'Bikram');
    const ufrag = () => pa.evaluate(() => /a=ice-ufrag:(\S+)/.exec(window.__pcs.at(-1).localDescription?.sdp ?? '')?.[1]);
    const first = await ufrag();
    await pa.context().setOffline(true);
    await pa.waitForFunction(() => window.adda.call.getState().reconnecting, null, { timeout: 8000 });
    // Bikram hears she's away once the server notices.
    await pb.waitForFunction(() => window.adda.call.getState().reconnecting, null, { timeout: 25_000 });
    await pb.getByText('Reconnecting…').first().waitFor();
    await pb.screenshot({ path: `${SHOTS}network-3-call-reconnecting.png` });
    await pa.context().setOffline(false);
    await pa.waitForFunction(() => !window.adda.call.getState().reconnecting && window.adda.call.getState().phase === 'active', null, { timeout: 20_000 });
    await pb.waitForFunction(() => !window.adda.call.getState().reconnecting, null, { timeout: 20_000 });
    expect((await ufrag()) !== first, 'the call didn’t get a new path (no ICE restart)');
    expect(!(await toasts(pa)).concat(await toasts(pb)).some((t) => /ended|dropped/i.test(t)), 'someone was told the call ended');
    await flowing(pb, 'Bikram');
    await flowing(pa, 'Asha');
  });

  await check('the callee noticing a broken path first asks the caller for a new one', async () => {
    const pcOf = (p) => p.evaluate(() => /a=ice-ufrag:(\S+)/.exec(window.__pcs.at(-1).localDescription?.sdp ?? '')?.[1]);
    const before = await pcOf(pa);
    await pb.evaluate((id) => window.adda.socket.emit('call:signal', { callId: id, data: { restart: true } }), callId);
    await pa.waitForFunction((u) => /a=ice-ufrag:(\S+)/.exec(window.__pcs.at(-1).localDescription?.sdp ?? '')?.[1] !== u, before, { timeout: 8000 });
    await flowing(pb, 'Bikram');
    await pa.getByRole('region', { name: /Video call with/ }).getByRole('button', { name: 'End call' }).click();
    await pa.waitForFunction(() => window.adda.call.getState().phase === 'idle', null, { timeout: 8000 });
  });

  await check('gone for good: after the wait they leave the room’s call, and are told so', async () => {
    await pa.goto(`${BASE}/rooms/${room.id}`);
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await pa.getByRole('button', { name: 'Join voice' }).first().click();
    await pb.getByRole('button', { name: 'Join voice' }).first().click();
    await voiceBar(pb).getByText('Talking with 1 other').waitFor({ timeout: 15_000 });
    // Her page gives up 50 s after it notices, which can be before the server
    // lets her seat go: its notice may have come and gone by then.
    const told = pa.getByText('You left voice: the connection didn’t come back.').waitFor({ timeout: 190_000 });
    await pa.context().setOffline(true);
    // The server's wait (2 minutes, after noticing), then she's out for Bikram.
    await pb.waitForFunction(([roomId, id]) => !window.adda.chat.getState().voice[roomId]?.some((x) => x.userId === id), [room.id, A.id], { timeout: 170_000 });
    await voiceBar(pb).getByText('Only you so far').waitFor();
    await told;
    await pa.context().setOffline(false);
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
