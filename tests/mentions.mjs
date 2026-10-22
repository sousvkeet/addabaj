// Mentions and muting in rooms: muting a room from Room info, "@" offering
// the room's members, mentions shown (and counted) even in a room you muted,
// replies to you counting the same, and mentions typed out by hand. Runs
// against the dev servers (npm run dev). Who gets a push for what is checked
// in test:push.
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
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

const browser = await chromium.launch();
async function person(name, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(`${BASE}/signup`);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(`${name.split(' ')[0].toLowerCase()}.mention.${stamp}@example.com`);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/chats');
  const id = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id);
  return { name, page, id };
}
const api = (page, path, body) =>
  page.evaluate(async ([path, body]) => (await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(), [path, body]);

const A = await person('Asha Sen');
const B = await person('Rahul Das');
const C = await person('Mitali Roy', true);
const ROOM = `Movie club ${stamp}`;
const { room } = await api(A.page, '/rooms', { name: ROOM, maxMembers: 6 });
for (const u of [B, C]) await api(A.page, `/rooms/${room.id}/members`, { userId: u.id });
const roomUrl = `${BASE}/rooms/${room.id}`;
const box = (u) => u.page.getByLabel(`Message ${ROOM}`);
const notifications = (u) => u.page.locator('section[aria-labelledby="notifications-heading"]');
const roomRow = (u) => u.page.getByRole('link', { name: new RegExp(ROOM) });

try {
  await check('Rahul mutes the room from Room info: the header and room list show it, with when it ends', async () => {
    await B.page.goto(roomUrl);
    await notifications(B).getByText('On for every message.').waitFor();
    await notifications(B).getByRole('button', { name: '8 hours' }).click();
    await notifications(B).getByText(/Muted until \S+.*mentions you or replies to you/).waitFor();
    await B.page.getByRole('img', { name: 'Notifications muted' }).waitFor();
    await notifications(B).getByRole('button', { name: 'Unmute' }).click();
    await notifications(B).getByText('On for every message.').waitFor();
    expect(!(await B.page.getByRole('img', { name: 'Notifications muted' }).count()), 'still marked muted');
    await notifications(B).getByRole('button', { name: 'Always' }).click();
    await notifications(B).getByText('Muted until you turn them back on.', { exact: false }).waitFor();
    await B.page.goto(`${BASE}/rooms`);
    await roomRow(B).getByRole('img', { name: 'Muted' }).waitFor();
  });

  await check('typing “@” offers the room’s other members; arrows move, Escape closes, Enter mentions', async () => {
    await A.page.goto(roomUrl);
    await box(A).click();
    await box(A).pressSequentially('Movie at 8. @');
    const list = A.page.getByRole('listbox', { name: 'People to mention' });
    await list.waitFor();
    const names = (await list.getByRole('option').allInnerTexts()).map((t) => t.split('\n').find((l) => /\s/.test(l)) ?? t);
    expect(names.length === 2 && names.includes('Rahul Das') && names.includes('Mitali Roy'), `offered: ${JSON.stringify(names)}`);
    await box(A).pressSequentially('mit');
    expect((await list.getByRole('option').count()) === 1, 'typing did not narrow the list');
    await box(A).press('Escape');
    await list.waitFor({ state: 'detached' });
    await box(A).press('Backspace');
    await box(A).press('Backspace');
    await box(A).press('Backspace');
    await list.waitFor();
    await box(A).press('ArrowDown');
    const second = await list.getByRole('option', { selected: true }).innerText();
    await box(A).press('ArrowUp');
    await box(A).pressSequentially('Ra');
    await box(A).press('Enter');
    await box(A).pressSequentially('are you coming?');
    const text = await box(A).inputValue();
    expect(text === 'Movie at 8. @Rahul Das are you coming?', `text: ${JSON.stringify(text)} (second was ${second})`);
    await A.page.screenshot({ path: `${SHOTS}mentions-1-typed.png` });
    await box(A).press('Enter');
    await A.page.getByRole('log').locator('[data-mention="other"]', { hasText: '@Rahul Das' }).waitFor();
    // And a plain message after it.
    await box(A).fill('Popcorn is on me');
    await box(A).press('Enter');
    await A.page.getByRole('log').getByText('Popcorn is on me').waitFor();
  });

  await check('in the room he muted, Rahul’s list shows the mention (“@”) and a grey count; the app counts just the mention', async () => {
    const row = roomRow(B);
    await row.getByText('Mentions you').waitFor({ timeout: 8000 });
    await row.getByText('2', { exact: true }).waitFor();
    await B.page.waitForFunction(() => document.title === '(1) Adda Khana', null, { timeout: 5000 });
    await B.page.screenshot({ path: `${SHOTS}mentions-2-muted-list.png` });
  });

  await check('Rahul sees himself picked out in the message; Mitali sees the mention too', async () => {
    await roomRow(B).click();
    await B.page.getByRole('log').locator('[data-mention="me"]', { hasText: '@Rahul Das' }).waitFor();
    await C.page.goto(roomUrl);
    await C.page.getByRole('log').locator('[data-mention="other"]', { hasText: '@Rahul Das' }).waitFor();
    await B.page.goto(`${BASE}/rooms`);
    await roomRow(B).getByText('Mentions you').waitFor({ state: 'detached', timeout: 5000 });
  });

  await check('a reply to Rahul’s own message counts like a mention in his muted room', async () => {
    // Rahul asks something (from his live connection), then Asha replies to it.
    const asked = await B.page.evaluate(
      (roomId) => new Promise((r) => window.adda.socket.emit('room:send', { roomId, body: 'Which film?' }, r)),
      room.id,
    );
    expect(asked.ok, `ask: ${JSON.stringify(asked)}`);
    const answered = await A.page.evaluate(
      ([roomId, replyTo]) => new Promise((r) => window.adda.socket.emit('room:send', { roomId, body: 'A surprise!', replyTo }, r)),
      [room.id, asked.message.id],
    );
    expect(answered.ok, `reply: ${JSON.stringify(answered)}`);
    await roomRow(B).getByText('Mentions you').waitFor({ timeout: 8000 });
  });

  await check('a mention typed out in full works too; an email address isn’t one', async () => {
    await box(A).fill('@Mitali Roy bring the snacks, or mail asha@example.com');
    await box(A).press('Enter');
    const msg = A.page.getByRole('log').locator('span', { hasText: 'bring the snacks' }).last();
    await msg.locator('[data-mention="other"]', { hasText: '@Mitali Roy' }).waitFor();
    expect((await msg.locator('[data-mention]').count()) === 1, 'the email address was taken for a mention');
    await C.page.getByRole('log').locator('[data-mention="me"]', { hasText: '@Mitali Roy' }).waitFor();
  });

  await check('on a phone, tapping a suggestion mentions them', async () => {
    await box(C).click();
    await box(C).pressSequentially('@as');
    await C.page.getByRole('listbox', { name: 'People to mention' }).getByRole('option', { name: /Asha Sen/ }).tap();
    await box(C).pressSequentially('on my way');
    expect((await box(C).inputValue()) === '@Asha Sen on my way', `text: ${await box(C).inputValue()}`);
    await C.page.screenshot({ path: `${SHOTS}mentions-3-phone.png` });
    await box(C).press('Enter');
    await A.page.getByRole('log').locator('[data-mention="me"]', { hasText: '@Asha Sen' }).waitFor({ timeout: 8000 });
  });

  await check('mentions are kept with the message: still there after a reload', async () => {
    await A.page.reload();
    await A.page.getByRole('log').locator('[data-mention="other"]', { hasText: '@Rahul Das' }).first().waitFor();
    await A.page.getByRole('log').locator('[data-mention="me"]', { hasText: '@Asha Sen' }).waitFor();
  });

  await check('Rahul turns notifications back on', async () => {
    await B.page.goto(roomUrl);
    await notifications(B).getByRole('button', { name: 'Unmute' }).click();
    await notifications(B).getByText('On for every message.').waitFor();
    await B.page.goto(`${BASE}/rooms`);
    await roomRow(B).waitFor();
    expect(!(await roomRow(B).getByRole('img', { name: 'Muted' }).count()), 'still shown muted');
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
