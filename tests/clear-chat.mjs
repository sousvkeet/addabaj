import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

// Clear chat history in a chat with someone, as Telegram's: for me (it goes
// from my view only), or "Also clear for them" (every message goes on both
// sides, theirs too, with files). Either way the chat stays in the list,
// empty, until the next message, and open apps empty it at once. Runs
// against the dev servers (npm run dev).
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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.clear.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
/** A live connection for `user`, keeping every dm:cleared it's told. */
async function connect(user) {
  const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: user.cookie } });
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  s.cleared = [];
  s.on('dm:cleared', (e) => s.cleared.push(e));
  return s;
}
const send = async (s, to, body, attachmentId) => {
  const res = await s.timeout(8000).emitWithAck('dm:send', { to, body, attachmentId });
  if (!res?.message) throw new Error(`sending: ${JSON.stringify(res)}`);
  return res.message;
};
async function photo(user) {
  const up = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: {
      cookie: user.cookie,
      'content-type': 'application/octet-stream',
      'x-upload-meta': encodeURIComponent(JSON.stringify({ kind: 'image', name: 'beach.jpg', mime: 'image/jpeg', width: 640, height: 480 })),
    },
    body: readFileSync(new URL('./fixtures/photo.jpg', import.meta.url)),
  });
  const { attachment, error } = await up.json();
  if (up.status !== 201) throw new Error(`upload: ${up.status} ${error}`);
  return attachment;
}
const thread = async (user, partner) => (await call(user, 'GET', `/dms/${partner.id}/messages`)).data.messages;
const listed = async (user, partner) => (await call(user, 'GET', '/dms')).data.conversations.find((c) => c.partner.id === partner.id);

const [asha, rahul, mitu] = await Promise.all([register('Asha Clear'), register('Rahul Clear'), register('Mitu Clear')]);
const sa = await connect(asha);
const sr = await connect(rahul);
const sm = await connect(mitu);
const browser = await chromium.launch();

try {
  // A chat with a photo, a reply and a reaction; and another chat that mustn't be touched.
  let picture;
  await send(sa, rahul.id, 'Hi Rahul');
  const hello = await send(sr, asha.id, 'Hello Asha');
  picture = await photo(asha);
  await send(sa, rahul.id, 'At the beach', picture.id);
  await sr.timeout(8000).emitWithAck('msg:react', { scope: 'dm', messageId: hello.id, emoji: '👍' });
  await send(sm, asha.id, 'Mitu here');

  await check('nobody can clear a chat without signing in, with themselves, or with someone who doesn’t exist', async () => {
    expect((await call(null, 'POST', `/dms/${rahul.id}/clear`, {})).status === 401, 'signed out');
    expect((await call(asha, 'POST', `/dms/${asha.id}/clear`, {})).status === 400, 'with myself');
    expect((await call(asha, 'POST', '/dms/00000000-0000-4000-8000-000000000000/clear', {})).status === 404, 'nobody');
  });

  await check('Clear for me: the chat empties for Asha only, and stays in her list as cleared', async () => {
    sr.cleared.length = 0;
    const res = await call(asha, 'POST', `/dms/${rahul.id}/clear`, {});
    expect(res.status === 200 && res.data.upTo && res.data.clearedAt, `answer ${JSON.stringify(res.data)}`);
    expect((await thread(asha, rahul)).length === 0, 'Asha still sees messages');
    expect((await thread(rahul, asha)).length === 3, 'Rahul lost messages');
    const mine = await listed(asha, rahul);
    expect(mine && mine.lastMessage === null && mine.clearedAt, `Asha's list: ${JSON.stringify(mine)}`);
    expect((await listed(rahul, asha))?.lastMessage?.body === 'At the beach', "Rahul's list changed");
    await sleep(300);
    expect(sa.cleared.some((e) => e.chatId === rahul.id && !e.everyone), "Asha's other devices weren't told");
    expect(!sr.cleared.length, 'Rahul was told');
    // The photo is still Rahul's to see.
    expect((await fetch(`${API}${picture.url}`, { headers: { cookie: rahul.cookie } })).status === 200, "Rahul's photo went");
  });

  await check('a message after clearing shows as usual', async () => {
    await send(sr, asha.id, 'Still there?');
    const after = await thread(asha, rahul);
    expect(after.length === 1 && after[0].body === 'Still there?', JSON.stringify(after.map((m) => m.body)));
    expect((await listed(asha, rahul))?.lastMessage?.body === 'Still there?', 'the list');
  });

  await check('Also clear for Rahul: every message goes on both sides, with the photo, and both are told', async () => {
    sa.cleared.length = 0;
    sr.cleared.length = 0;
    const res = await call(asha, 'POST', `/dms/${rahul.id}/clear`, { everyone: true });
    expect(res.status === 200, `status ${res.status}`);
    expect((await thread(asha, rahul)).length === 0, 'Asha still sees messages');
    expect((await thread(rahul, asha)).length === 0, 'Rahul still sees messages');
    expect((await fetch(`${API}${picture.url}`, { headers: { cookie: rahul.cookie } })).status === 404, 'the photo is still there');
    for (const [who, other] of [[asha, rahul], [rahul, asha]]) {
      const c = await listed(who, other);
      expect(c && c.lastMessage === null && c.clearedAt && c.unread === 0, `${who.name}'s list: ${JSON.stringify(c)}`);
    }
    await sleep(300);
    expect(sr.cleared.some((e) => e.chatId === asha.id && e.everyone && e.by === asha.id && e.upTo === res.data.upTo), `Rahul told: ${JSON.stringify(sr.cleared)}`);
    expect(sa.cleared.some((e) => e.chatId === rahul.id && e.everyone), 'Asha told');
  });

  await check("another chat isn't touched", async () => {
    const other = await thread(asha, mitu);
    expect(other.length === 1 && other[0].body === 'Mitu here', JSON.stringify(other));
    expect(!sm.cleared.length, 'Mitu was told');
  });

  await check('either of them can clear for both, and a message after it stays', async () => {
    await send(sa, rahul.id, 'One');
    await send(sr, asha.id, 'Two');
    expect((await call(rahul, 'POST', `/dms/${asha.id}/clear`, { everyone: true })).status === 200, 'Rahul clearing');
    expect((await thread(asha, rahul)).length === 0, 'Asha still sees messages');
    await send(sa, rahul.id, 'Fresh start');
    const both = [await thread(asha, rahul), await thread(rahul, asha)].map((t) => t.map((m) => m.body).join(','));
    expect(both[0] === 'Fresh start' && both[1] === 'Fresh start', JSON.stringify(both));
  });

  await check('in the browser: Clear chat history with "Also clear for", and the other side empties at once', async () => {
    await send(sr, asha.id, 'See you tomorrow');
    const open = async (user, partner) => {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/chats/${partner.id}`);
      await page.getByText('See you tomorrow').first().waitFor({ timeout: 15000 });
      return page;
    };
    const pa = await open(asha, rahul);
    const pr = await open(rahul, asha);
    await pa.getByRole('button', { name: 'Chat options' }).click();
    await pa.getByRole('menuitem', { name: 'Clear chat history' }).click();
    const dialog = pa.getByRole('dialog', { name: 'Clear chat history?' });
    await dialog.waitFor();
    await dialog.getByLabel(/Also clear for Rahul Clear/).check();
    await pa.screenshot({ path: `${SHOTS}clear-01-dialog.png` });
    await dialog.getByRole('button', { name: 'Clear for both of us' }).click();
    await dialog.waitFor({ state: 'detached' });
    await pa.getByText('See you tomorrow').waitFor({ state: 'detached', timeout: 5000 });
    // Rahul's open chat empties by itself.
    await pr.getByText('See you tomorrow').waitFor({ state: 'detached', timeout: 5000 });
    // Both lists keep the chat, as cleared.
    await pr.getByText('History cleared').first().waitFor({ timeout: 5000 });
    await pr.screenshot({ path: `${SHOTS}clear-02-other-side.png` });
    expect((await thread(rahul, asha)).length === 0, 'the server still has messages');
  });
} finally {
  sa.disconnect();
  sr.disconnect();
  sm.disconnect();
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
