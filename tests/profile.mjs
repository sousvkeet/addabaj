import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// Changing your name (Settings › Your name, or the account menu on a
// computer): everyone sees the new one at once, everywhere you appear (chat
// lists, a chat's header, a room's members and your earlier messages there),
// and so do your other devices. Names are kept on one line, without invisible
// characters (joiners stay, for Bengali spellings and emoji), up to 40
// characters. Runs against the dev servers (npm run dev).
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
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.name.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const A = await register('Asha Sen');
const B = await register('Bikram Sil');
const ROOM = `Book club ${stamp}`;
const room = (await call(A, 'POST', '/rooms', { name: ROOM, maxMembers: 6 })).data.room;
await call(A, 'POST', `/rooms/${room.id}/members`, { userId: B.id });
await call(A, 'POST', `/dms/${B.id}/messages`, { body: 'Hi Bikram' });
await call(A, 'POST', `/rooms/${room.id}/messages`, { body: 'Chapter three tonight?' });

const browser = await chromium.launch();
async function page(user, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
const pa = await page(A, true);
const pa2 = await page(A);
const pb = await page(B);
const pc = await page(B);
const dialog = (p) => p.getByRole('dialog', { name: 'Your name' });

try {
  await check('Settings has “Your name”; the dialog won’t take an empty or too long name', async () => {
    await pa.goto(`${BASE}/settings`);
    await pa.getByRole('button', { name: /^Your name/ }).click();
    await dialog(pa).waitFor();
    const input = dialog(pa).getByLabel('Name');
    expect((await input.inputValue()) === 'Asha Sen', 'it doesn’t start from the current name');
    await input.fill('   ');
    await dialog(pa).getByRole('button', { name: 'Save' }).isDisabled();
    expect(await dialog(pa).getByRole('button', { name: 'Save' }).isDisabled(), 'Save works with an empty name');
    await input.fill('A'.repeat(41));
    await dialog(pa).getByRole('button', { name: 'Save' }).click();
    await dialog(pa).getByText('Keep your name under 40 characters.').waitFor();
    await pa.screenshot({ path: `${SHOTS}profile-1-name-dialog.png` });
  });

  await check('a new name shows at once: in Settings, and on my other device', async () => {
    await pb.goto(`${BASE}/chats/${A.id}`);
    await pc.goto(`${BASE}/rooms/${room.id}`);
    await pa2.goto(`${BASE}/chats`);
    await pb.getByRole('log').getByText('Hi Bikram').waitFor();
    await pc.getByRole('log').getByText('Chapter three tonight?').waitFor();
    await dialog(pa).getByLabel('Name').fill('Asha Roy');
    await dialog(pa).getByRole('button', { name: 'Save' }).click();
    await dialog(pa).waitFor({ state: 'detached' });
    await pa.getByRole('button', { name: 'Asha Roy: change your name' }).waitFor();
    // My other device (a computer): its account menu has the new name.
    await pa2.getByRole('button', { name: 'Your account' }).click();
    await pa2.getByRole('menu').getByText('Asha Roy', { exact: true }).waitFor({ timeout: 8000 });
    await pa2.keyboard.press('Escape');
  });

  await check('everyone sees it at once: the chat list, the chat’s header, the room’s members and my earlier messages', async () => {
    // Bikram's open chat with her, and his list of chats.
    await pb.getByRole('heading', { name: 'Asha Roy' }).first().waitFor({ timeout: 8000 });
    await pb.getByRole('link', { name: /Asha Roy/ }).first().waitFor();
    expect(!(await pb.getByText('Asha Sen').count()), 'the old name still shows in Bikram’s chats');
    // The room: her message there shows her new name.
    const roomShows = () =>
      pc.evaluate(() => {
        const text = document.body.innerText;
        // Room notices say what happened then ("Asha Sen started the room"): they keep the name she had.
        const notices = /Asha Sen (started the room|added )/;
        return { now: text.includes('Asha Roy'), before: [...text.matchAll(/.{0,40}Asha Sen.{0,40}/g)].map((m) => m[0]).filter((m) => !notices.test(m)) };
      });
    const end = Date.now() + 8000;
    let seen = await roomShows();
    while (Date.now() < end && (!seen.now || seen.before.length)) seen = await roomShows();
    expect(seen.now && !seen.before.length, `in the room: ${JSON.stringify(seen)}`);
    await pb.screenshot({ path: `${SHOTS}profile-2-seen-by-contact.png` });
  });

  await check('names stay on one line, without invisible characters (joiners stay), and need signing in', async () => {
    const spaced = await call(A, 'PATCH', '/auth/name', { name: '  Asha ​\t Roy\n ' });
    expect(spaced.status === 200 && spaced.data.user.name === 'Asha Roy', `cleaned: ${JSON.stringify(spaced.data)}`);
    const bengali = await call(A, 'PATCH', '/auth/name', { name: 'আশা র‍্যায়' });
    expect(bengali.status === 200 && bengali.data.user.name === 'আশা র‍্যায়', `the joiner was dropped: ${JSON.stringify(bengali.data?.user?.name)}`);
    expect((await call(A, 'PATCH', '/auth/name', { name: '​ ‮ ' })).status === 400, 'an invisible name was taken');
    expect((await call(A, 'PATCH', '/auth/name', { name: 'x'.repeat(41) })).status === 400, 'a long name was taken');
    expect((await call(null, 'PATCH', '/auth/name', { name: 'Someone' })).status === 401, 'changed without signing in');
    // Messages sent now carry the new name.
    await call(A, 'PATCH', '/auth/name', { name: 'Asha Roy' });
    const sent = await call(A, 'POST', `/rooms/${room.id}/messages`, { body: 'New name, same me' });
    expect(sent.data.message.sender.name === 'Asha Roy', `the message says ${sent.data.message.sender?.name}`);
  });

  await check('on a computer, the account menu has “Your name” too', async () => {
    await pa2.getByRole('button', { name: 'Your account' }).click();
    await pa2.getByRole('menuitem', { name: 'Your name' }).click();
    await dialog(pa2).waitFor();
    const value = await dialog(pa2).getByLabel('Name').inputValue();
    expect(value === 'Asha Roy', `it shows “${value}”, not the current name`);
    await pa2.screenshot({ path: `${SHOTS}profile-3-computer.png` });
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
