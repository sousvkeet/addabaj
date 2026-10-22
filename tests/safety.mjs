import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { existsSync, mkdirSync } from 'node:fs';

// Safety on a public server: blocking (no messages or calls either way, no
// adding or inviting the blocker to rooms, no online status), unblocking from
// Settings › Privacy, and reports to the host admin: a person, or a message in
// a chat or room, with a copy of the messages before it. The host sees them in
// Admin › Reports and can delete the message or switch the account off; the
// host can't be blocked. Runs against the dev servers (npm run dev); run
// `npm run admin:reset` first (the host admin's password is "admin").
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
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}
async function register(name) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email: `${name.split(' ')[0].toLowerCase()}.safety.${stamp}@example.com`, password: 'password123' }),
  });
  const data = await res.json();
  if (res.status !== 201) throw new Error(`registering ${name}: ${res.status} ${JSON.stringify(data)}`);
  return { name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const data = await res.json();
  if (res.status !== 200) throw new Error(`host admin login: ${res.status} ${JSON.stringify(data)} (run npm run admin:reset)`);
  return { name: data.user.name, id: data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
function connect(user) {
  const s = io(API, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: user.cookie } });
  s.events = [];
  s.onAny((event, data) => s.events.push({ event, data }));
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const emit = (s, event, payload) =>
  new Promise((resolve) => s.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: String(err) } : res)));
const waitEvent = async (s, event, test = () => true, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const e = s.events.find((x) => x.event === event && test(x.data));
    if (e) return e.data;
  }
  throw new Error(`no ${event}`);
};

const A = await register('Arjun Mehta'); // the trouble
const B = await register('Bina Das');
const C = await register('Chandra Ghosh');
const H = await login('admin', 'admin');
const sA = await connect(A);
const sH = await connect(H);
const ROOM = `Neighbours ${stamp}`;
const room = (await call(C, 'POST', '/rooms', { name: ROOM, maxMembers: 6 })).data.room;
await call(C, 'POST', `/rooms/${room.id}/members`, { userId: A.id });
await call(C, 'POST', `/rooms/${room.id}/members`, { userId: B.id });
await call(A, 'POST', `/dms/${B.id}/messages`, { body: 'Hey Bina' });
await call(B, 'POST', `/dms/${A.id}/messages`, { body: 'Hi' });

const browser = await chromium.launch();
async function page(user, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'adda_token', value: user.cookie.split('=')[1], url: BASE }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${user.name} pageerror]`, e.message));
  return p;
}
const bubble = (p, text) => p.getByRole('log').locator('[id^="msg-"]').filter({ hasText: text }).last();
const chatMenu = async (p, item) => {
  await p.getByRole('button', { name: 'Chat options' }).click();
  await p.getByRole('menuitem', { name: item }).click();
};

const pa = await page(A);
const pb = await page(B);

try {
  await check('blocking from a chat’s menu: the message box says so, and calls are off', async () => {
    await pb.goto(`${BASE}/chats/${A.id}`);
    await chatMenu(pb, 'Block Arjun Mehta');
    const dlg = pb.getByRole('dialog', { name: 'Block Arjun Mehta?' });
    await dlg.getByRole('button', { name: 'Block' }).click();
    await pb.getByText('You blocked Arjun Mehta. You can\'t message or call each other.').waitFor();
    await pb.getByRole('button', { name: 'Unblock' }).waitFor();
    expect(await pb.getByRole('button', { name: 'Voice call Arjun Mehta' }).isDisabled(), 'calling is still on');
    await pb.screenshot({ path: `${SHOTS}safety-1-blocked.png` });
  });

  await check('the blocked person can’t message or call, and sees no online status', async () => {
    await pa.goto(`${BASE}/chats/${B.id}`);
    await pa.getByLabel('Message Bina').fill('Why won’t you answer?');
    await pa.keyboard.press('Enter');
    await pa.getByText("You can't message this person.").waitFor({ timeout: 8000 });
    // Not sent: it stays, to retry.
    await pa.getByRole('log').getByText('Not sent. Tap to retry').waitFor();
    const res = await emit(sA, 'call:start', { to: B.id });
    expect(!res.ok && /can't call/.test(res.error), `call: ${JSON.stringify(res)}`);
    const seen = await call(A, 'GET', `/users/${B.id}`);
    expect(seen.data.user.presenceHidden && !seen.data.user.online && !seen.data.user.blocked, JSON.stringify(seen.data.user));
    expect(!(await pb.getByRole('log').getByText('Why won’t you answer?').count()), 'Bina got it');
  });

  await check('they can’t add the blocker to a room or invite her', async () => {
    const mine = (await call(A, 'POST', '/rooms', { name: `Arjun’s ${stamp}`, maxMembers: 6 })).data.room;
    expect((await call(A, 'POST', `/rooms/${mine.id}/members`, { userId: B.id })).status === 403, 'added her');
    expect((await call(A, 'POST', `/rooms/${mine.id}/invites`, { userId: B.id })).status === 403, 'invited her');
  });

  await check('Settings › Privacy lists blocked people; unblocking there lets messages through again', async () => {
    await pb.goto(`${BASE}/settings`);
    await pb.getByRole('button', { name: /Privacy/ }).click();
    const dlg = pb.getByRole('dialog', { name: 'Privacy' });
    const list = dlg.locator('section[aria-labelledby="blocked-heading"]');
    await list.getByText('Arjun Mehta').waitFor();
    await pb.screenshot({ path: `${SHOTS}safety-2-privacy.png` });
    await list.getByRole('button', { name: 'Unblock' }).click();
    await list.getByText('You haven\'t blocked anyone.').waitFor();
    await pb.keyboard.press('Escape');
    const sent = await emit(sA, 'dm:send', { to: B.id, body: 'Sorry about earlier' });
    expect(sent.ok, JSON.stringify(sent));
  });

  await check('the site’s host can’t be blocked', async () => {
    await pb.goto(`${BASE}/chats/${H.id}`);
    await chatMenu(pb, `Block ${H.name}`);
    await pb.getByRole('dialog', { name: `Block ${H.name}?` }).getByRole('button', { name: 'Block' }).click();
    await pb.getByText("You can't block the site's host.").waitFor();
  });

  // The host has Admin › Reports open while the reports come in.
  const ph = await page(H);
  await ph.goto(`${BASE}/admin/reports`);
  await ph.getByRole('tab', { name: /Waiting/ }).waitFor();
  const waitingBefore = (await call(H, 'GET', '/admin/reports?limit=1')).data.open;
  const reportsLink = ph.locator('a[href="/admin/reports"]');

  let dmReport;
  await check('reporting a message on a phone: press and hold › Report; it goes to the host at once, and blocks them too', async () => {
    await call(A, 'POST', `/dms/${B.id}/messages`, { body: 'You will regret this' });
    const phone = await page(B, true);
    await phone.goto(`${BASE}/chats/${A.id}`);
    const box = await bubble(phone, 'You will regret this').locator('span.whitespace-pre-wrap').boundingBox();
    const cdp = await phone.context().newCDPSession(phone);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 8, y: box.y + 6 }] });
    await sleep(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await phone.getByRole('dialog', { name: 'Message actions' }).getByRole('button', { name: 'Report' }).click();
    const dlg = phone.getByRole('dialog', { name: 'Report this message?' });
    await dlg.getByText('Harassment or bullying').click();
    await dlg.getByRole('textbox').fill('He keeps threatening me.');
    expect(await dlg.getByRole('checkbox', { name: /Also block Arjun Mehta/ }).isChecked(), 'blocking isn’t offered by default in a chat');
    await phone.screenshot({ path: `${SHOTS}safety-3-report.png` });
    sH.events.length = 0;
    await dlg.getByRole('button', { name: 'Send report' }).click();
    await phone.getByText('Reported and blocked Arjun Mehta. Thanks for telling the host.').waitFor();
    await phone.getByText(/You blocked Arjun Mehta/).waitFor();
    const told = await waitEvent(sH, 'admin:reports');
    expect(told.open === waitingBefore + 1, JSON.stringify(told));
    // The host's open Reports page counts it at once, and offers to show it.
    await reportsLink.getByText(`${waitingBefore + 1} waiting`).waitFor({ timeout: 5000 });
    await ph.getByRole('button', { name: 'New reports came in. Show them' }).waitFor({ timeout: 5000 });
    const { data } = await call(H, 'GET', '/admin/reports');
    dmReport = data.reports.find((r) => r.reporter?.id === B.id && r.scope === 'dm');
    expect(dmReport && dmReport.reason === 'harassment' && dmReport.details === 'He keeps threatening me.', JSON.stringify(dmReport)?.slice(0, 300));
    expect(dmReport.target.id === A.id && dmReport.messages.at(-1).body === 'You will regret this', 'the copy is wrong');
    expect(dmReport.messages.some((m) => m.body === 'Hey Bina'), 'the messages before it weren’t kept');
    await phone.context().close();
    // Unblocked again, for what follows.
    await call(B, 'DELETE', `/users/${A.id}/block`);
  });

  let roomReport;
  await check('reporting a room message on a computer: More actions › Report, without blocking', async () => {
    await call(A, 'POST', `/rooms/${room.id}/messages`, { body: 'Buy cheap followers at my site' });
    const pc = await page(C);
    await pc.goto(`${BASE}/rooms/${room.id}`);
    const b = bubble(pc, 'Buy cheap followers');
    await b.hover();
    await b.getByRole('button', { name: 'More actions' }).click();
    await pc.getByRole('menuitem', { name: 'Report' }).click();
    const dlg = pc.getByRole('dialog', { name: 'Report this message?' });
    await dlg.getByText('Spam', { exact: true }).click();
    expect(!(await dlg.getByRole('checkbox', { name: /Also block/ }).isChecked()), 'blocking ticked in a room');
    await dlg.getByRole('button', { name: 'Send report' }).click();
    await pc.getByText('Report sent. Thanks for telling the host.').waitFor();
    const { data } = await call(H, 'GET', '/admin/reports');
    roomReport = data.reports.find((r) => r.reporter?.id === C.id && r.scope === 'room');
    expect(roomReport?.room?.name === ROOM && roomReport.reason === 'spam', JSON.stringify(roomReport)?.slice(0, 300));
    expect(!(await call(C, 'GET', `/users/${A.id}`)).data.user.blocked, 'blocked anyway');
    await pc.context().close();
  });

  await check('reports are for the host only, and one’s own message can’t be reported', async () => {
    expect((await call(B, 'GET', '/admin/reports')).status === 403, 'someone else saw the reports');
    const { data } = await call(A, 'GET', `/rooms/${room.id}/messages`);
    const own = data.messages.find((m) => m.body.startsWith('Buy cheap'));
    expect((await call(A, 'POST', '/reports', { scope: 'room', messageId: own.id, reason: 'spam' })).status === 400, 'reported his own message');
  });

  await check('Admin › Reports shows each report with the messages as they were, the reported one marked', async () => {
    await ph.getByRole('button', { name: 'New reports came in. Show them' }).click();
    const card = ph.getByRole('article', { name: `Spam: A message in ${ROOM}` });
    await card.waitFor({ timeout: 8000 });
    await card.getByText('Buy cheap followers at my site').waitFor();
    await card.getByText('Reported', { exact: true }).waitFor();
    const chat = ph.getByRole('article', { name: 'Harassment or bullying: A message in a chat' }).first();
    await chat.getByText('He keeps threatening me.').waitFor();
    await chat.getByText('You will regret this').waitFor();
    await ph.screenshot({ path: `${SHOTS}safety-4-admin-reports.png` });
  });

  await check('the host deletes the reported room message from there: everyone sees it taken down', async () => {
    await pb.goto(`${BASE}/rooms/${room.id}`);
    await pb.getByRole('log').getByText('Buy cheap followers').waitFor();
    const card = ph.getByRole('article', { name: `Spam: A message in ${ROOM}` });
    await card.getByRole('button', { name: 'Delete message' }).click();
    await ph.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete message' }).click();
    await ph.getByText('The message was deleted for everyone.').waitFor();
    await card.waitFor({ state: 'detached', timeout: 5000 });
    await pb.getByRole('log').getByText('This message was deleted by an admin').waitFor({ timeout: 8000 });
    expect(!(await pb.getByRole('log').getByText('Buy cheap followers').count()), 'still there');
    // The report keeps its copy.
    const { data } = await call(H, 'GET', '/admin/reports?status=closed');
    const done = data.reports.find((r) => r.id === roomReport.id);
    expect(done.status === 'resolved' && done.actions.includes('deleted-message') && done.messages.at(-1).body === 'Buy cheap followers at my site', JSON.stringify(done).slice(0, 300));
  });

  await check('the host switches the reported account off from there: their app is told and signed out', async () => {
    await pa.goto(`${BASE}/chats`);
    await pa.waitForFunction(() => window.adda?.socket?.connected, null, { timeout: 8000 });
    const card = ph.getByRole('article', { name: 'Harassment or bullying: A message in a chat' }).first();
    await card.getByRole('button', { name: 'Switch off Arjun Mehta' }).click();
    await ph.getByRole('dialog', { name: 'Switch off Arjun Mehta?' }).getByRole('button', { name: 'Switch off' }).click();
    await ph.getByText("Arjun Mehta was logged out and can't log in.").waitFor();
    const res = { data: { report: (await call(H, 'GET', '/admin/reports?status=closed')).data.reports.find((r) => r.id === dmReport.id) } };
    expect(res.data.report?.target.disabled && res.data.report.actions.includes('switched-off'), JSON.stringify(res.data).slice(0, 300));
    await pa.getByText('The host switched off your account.').waitFor({ timeout: 8000 });
    await pa.waitForURL('**/login', { timeout: 8000 });
    expect((await call(null, 'POST', '/auth/login', { email: `arjun.safety.${stamp}@example.com`, password: 'password123' })).status === 403, 'he can still log in');
    await call(H, 'PATCH', `/admin/users/${A.id}`, { disabled: false });
  });

  await check('handled reports say who handled them and what was done, and can be reopened', async () => {
    await ph.getByRole('tab', { name: 'Handled' }).click();
    const card = ph.getByRole('article', { name: `Spam: A message in ${ROOM}` });
    await card.getByText(/Resolved/).waitFor();
    await card.getByText(/message deleted/).waitFor();
    await card.getByRole('button', { name: 'Reopen' }).click();
    await ph.getByText("Reopened. It's waiting again.").waitFor();
    await card.waitFor({ state: 'detached', timeout: 5000 });
    await ph.getByRole('tab', { name: /Waiting/ }).click();
    await ph.getByRole('article', { name: `Spam: A message in ${ROOM}` }).getByRole('button', { name: 'Dismiss' }).click();
    await ph.getByText('Dismissed.').waitFor();
  });
} finally {
  sA.close();
  sH.close();
  await browser.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
