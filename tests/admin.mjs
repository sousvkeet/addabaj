import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// The host admin: the default admin / admin login, people, rooms and site
// settings. Runs against the dev servers (npm run dev). The admin account must
// still have its default password (npm run admin:reset puts it back).
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
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  return { name, ctx, page, email: `${name.split(' ')[0].toLowerCase()}.${stamp}@example.com`, password: 'password123' };
}

async function signup(u) {
  await u.page.goto(`${BASE}/signup`);
  await u.page.getByLabel('Your name').fill(u.name);
  await u.page.getByLabel('Email').fill(u.email);
  await u.page.getByLabel('Password').fill(u.password);
  await u.page.getByRole('button', { name: 'Create account' }).click();
  await u.page.waitForURL(`${BASE}/chats`);
  u.id = await u.page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id);
}

async function login(u, identifier, password) {
  await u.page.goto(`${BASE}/login`);
  await u.page.getByLabel('Email or username').fill(identifier);
  await u.page.getByLabel('Password').fill(password);
  await u.page.getByRole('button', { name: 'Log in' }).click();
}

const api = (page, path, init) =>
  page.evaluate(
    async ([path, init]) => {
      const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      return { status: res.status, data: await res.json().catch(() => null) };
    },
    [path, init],
  );

/** A person's row on the admin People page, found by searching their email. */
async function personRow(page, email) {
  await page.getByLabel('Search people').fill(email);
  const row = page.getByRole('list', { name: 'People' }).getByRole('listitem').filter({ hasText: email });
  await row.waitFor({ timeout: 5000 });
  return row;
}
async function personAction(page, email, action) {
  const row = await personRow(page, email);
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

const H = await user('Host');
const B = await user('Rahul Das');
const C = await user('Mitali Roy');
const P = await user('Phone Host', true);

await check('the default admin / admin login works and opens the app with an Admin tab', async () => {
  await login(H, 'admin', 'admin');
  await H.page.waitForURL(`${BASE}/chats`, { timeout: 8000 });
  await H.page.getByRole('link', { name: 'Admin' }).waitFor();
  const me = (await api(H.page, '/auth/me')).data.user;
  if (!me.siteAdmin || !me.mustChangePassword) throw new Error(JSON.stringify(me));
});

await check('two people sign up; they have no Admin tab and the admin API refuses them', async () => {
  await signup(B);
  await signup(C);
  if (await B.page.getByRole('link', { name: 'Admin' }).count()) throw new Error('a normal person sees the Admin tab');
  const r = await api(B.page, '/admin/overview');
  if (r.status !== 403) throw new Error(`admin API answered ${r.status}`);
  await B.page.goto(`${BASE}/admin/people`);
  await B.page.waitForURL(`${BASE}/chats`);
});

await check('the overview shows the numbers and warns about the default password', async () => {
  await H.page.getByRole('link', { name: 'Admin' }).click();
  await H.page.getByText("You're using the default admin password").waitFor();
  await H.page.getByText('Online now').waitFor();
  const people = Number((await H.page.getByRole('link', { name: /People \d/ }).first().innerText()).match(/People\s+([\d,]+)/)[1].replace(/,/g, ''));
  if (people < 3) throw new Error(`overview counts ${people} people`);
  await H.page.waitForTimeout(500);
  await H.page.screenshot({ path: `${SHOTS}admin-01-overview.png` });
});

await check('making someone a host admin gives them the Admin tab at once; taking it away removes it', async () => {
  await H.page.goto(`${BASE}/admin/people`);
  await personAction(H.page, B.email, 'Make host admin');
  await (await personRow(H.page, B.email)).getByText('Host admin').waitFor();
  await B.page.getByRole('link', { name: 'Admin' }).waitFor({ timeout: 5000 });
  await H.page.screenshot({ path: `${SHOTS}admin-02-people.png` });
  await personAction(H.page, B.email, 'Remove host admin');
  await B.page.getByRole('link', { name: 'Admin' }).waitFor({ state: 'detached', timeout: 5000 });
});

await check('switching an account off logs them out with a reason, and they can’t log back in until it’s on again', async () => {
  await personAction(H.page, C.email, 'Switch account off');
  await C.page.getByText('The host switched off your account.').waitFor({ timeout: 5000 });
  await C.page.waitForURL(/\/login$/, { timeout: 5000 });
  await login(C, C.email, C.password);
  await C.page.getByText('This account has been switched off by the host.').waitFor({ timeout: 5000 });
  await H.page.getByRole('radio', { name: 'Switched off' }).click();
  await (await personRow(H.page, C.email)).getByText('Switched off').waitFor();
  await personAction(H.page, C.email, 'Switch account on');
  await H.page.getByRole('radio', { name: 'Everyone' }).click();
  await login(C, C.email, C.password);
  await C.page.waitForURL(`${BASE}/chats`, { timeout: 5000 });
});

await check('setting a new password for someone lets them log in with it', async () => {
  await personAction(H.page, C.email, 'Set a new password');
  const dlg = H.page.getByRole('dialog', { name: /New password for/ });
  await dlg.getByLabel('New password').fill('fresh-start-42');
  await dlg.getByRole('button', { name: 'Set password' }).click();
  await dlg.waitFor({ state: 'hidden' });
  C.password = 'fresh-start-42';
  await C.page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await login(C, C.email, C.password);
  await C.page.waitForURL(`${BASE}/chats`, { timeout: 5000 });
});

let D = null;
await check('the admin adds a person, who can log in right away; removing them ends that', async () => {
  await H.page.getByRole('button', { name: 'Add person' }).click();
  const dlg = H.page.getByRole('dialog', { name: 'Add a person' });
  D = { email: `dev.${stamp}@example.com` };
  await dlg.getByLabel('Name').fill('Dev Added');
  await dlg.getByLabel('Email').fill(D.email);
  D.password = await dlg.getByLabel('Password').inputValue();
  await dlg.getByRole('button', { name: 'Add person' }).click();
  await dlg.waitFor({ state: 'hidden' });
  const ctx = await browser.newContext();
  D.page = await ctx.newPage();
  await login(D, D.email, D.password);
  await D.page.waitForURL(`${BASE}/chats`, { timeout: 5000 });
  await personAction(H.page, D.email, 'Remove account');
  await H.page.getByRole('dialog', { name: /Remove Dev Added/ }).getByRole('button', { name: 'Remove account' }).click();
  await H.page.getByText("Dev Added's account was removed.").waitFor();
  await login(D, D.email, D.password);
  await D.page.getByText('Email or password is incorrect.').waitFor({ timeout: 5000 });
});

await check('the admin can’t demote or switch off their own account', async () => {
  const me = (await api(H.page, '/auth/me')).data.user;
  const r = await api(H.page, `/admin/users/${me.id}`, { method: 'PATCH', body: JSON.stringify({ siteAdmin: false }) });
  if (r.status !== 400) throw new Error(`demoting myself answered ${r.status}`);
});

await check('the admin sees every room and can delete one; its members are told', async () => {
  const { data } = await api(B.page, '/rooms', { method: 'POST', body: JSON.stringify({ name: `Late night ${stamp}`, maxMembers: 5 }) });
  await api(B.page, `/rooms/${data.room.id}/members`, { method: 'POST', body: JSON.stringify({ userId: C.id }) });
  await H.page.goto(`${BASE}/admin/rooms`);
  await H.page.getByLabel('Search rooms').fill(stamp);
  const row = H.page.getByRole('list', { name: 'Rooms' }).getByRole('listitem').filter({ hasText: `Late night ${stamp}` });
  await row.getByText('Rahul Das').waitFor();
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await H.page.getByRole('menuitem', { name: 'Delete room' }).click();
  await H.page.getByRole('dialog', { name: /Delete Late night/ }).getByRole('button', { name: 'Delete room' }).click();
  await C.page.getByText(`Late night ${stamp} was deleted.`).waitFor({ timeout: 5000 });
});

await check('the host adds anyone to any room and removes anyone, even its owner (the room passes on)', async () => {
  const { data } = await api(B.page, '/rooms', { method: 'POST', body: JSON.stringify({ name: `Book club ${stamp}`, maxMembers: 3 }) });
  const roomId = data.room.id;
  const denied = await api(C.page, `/admin/rooms/${roomId}/members`, { method: 'POST', body: JSON.stringify({ userId: C.id }) });
  if (denied.status !== 403) throw new Error(`a member used the host's add: ${denied.status}`);

  await H.page.goto(`${BASE}/admin/rooms`);
  await H.page.getByLabel('Search rooms').fill(`Book club ${stamp}`);
  const row = H.page.getByRole('list', { name: 'Rooms' }).getByRole('listitem').filter({ hasText: `Book club ${stamp}` });
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await H.page.getByRole('menuitem', { name: 'Add or remove people' }).click();
  const dlg = H.page.getByRole('dialog', { name: `People in Book club ${stamp}` });
  const members = dlg.getByRole('list', { name: 'Members' });
  await members.getByText('Rahul Das', { exact: true }).waitFor();
  await dlg.getByLabel('Find someone to add').fill(C.email);
  await dlg.getByRole('button', { name: 'Add Mitali Roy' }).click();
  await members.getByText('Mitali Roy').waitFor({ timeout: 5000 });
  await C.page.getByText(`You were added to Book club ${stamp}.`).waitFor({ timeout: 5000 });
  await row.getByText('2 of 3').waitFor();
  await H.page.screenshot({ path: `${SHOTS}admin-07-room-people.png` });
  const twice = await api(H.page, `/admin/rooms/${roomId}/members`, { method: 'POST', body: JSON.stringify({ userId: C.id }) });
  if (twice.status !== 409) throw new Error(`added twice: ${twice.status}`);

  // Rahul started the room; removing him hands it to Mitali.
  await dlg.getByRole('button', { name: 'Remove Rahul Das' }).click();
  await dlg.getByText(/Mitali Roy will run it/).waitFor();
  await dlg.getByRole('button', { name: 'Remove', exact: true }).click();
  await B.page.getByText(`You were removed from Book club ${stamp}.`).waitFor({ timeout: 5000 });
  await members.getByText('Rahul Das', { exact: true }).waitFor({ state: 'detached', timeout: 5000 });
  const people = (await api(H.page, `/admin/rooms/${roomId}/members`)).data;
  const [only] = people.members;
  if (people.members.length !== 1 || only.id !== C.id || !only.owner || only.role !== 'admin') throw new Error(`after: ${JSON.stringify(people.members)}`);
  await row.getByText('Mitali Roy').waitFor();
  const notes = (await api(C.page, `/rooms/${roomId}/messages`)).data.messages.filter((m) => m.kind === 'system').map((m) => m.body);
  for (const want of ['The host added Mitali Roy', 'The host removed Rahul Das', 'Mitali Roy now runs the room']) {
    if (!notes.includes(want)) throw new Error(`no "${want}" in the room (${notes})`);
  }
  const last = await api(H.page, `/admin/rooms/${roomId}/members/${C.id}`, { method: 'DELETE' });
  if (last.status !== 409) throw new Error(`removed the last person: ${last.status}`);
  await H.page.keyboard.press('Escape');
});

await check('closing sign-ups shows a closed sign-up page and the server refuses new accounts', async () => {
  await H.page.goto(`${BASE}/admin/settings`);
  await H.page.getByRole('switch', { name: /Let new people create accounts/ }).click({ force: true });
  await H.page.getByText('Sign-ups are closed. Add people from the People page.').waitFor();
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`${BASE}/signup`);
  await guest.getByText('Sign-ups are closed right now').waitFor();
  await guest.goto(`${BASE}/login`);
  if (await guest.getByRole('link', { name: 'Create an account' }).count()) throw new Error('the login page still offers sign-up');
  const r = await guest.evaluate(async (email) => {
    const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', email, password: 'password123' }) });
    return res.status;
  }, `closed.${stamp}@example.com`);
  if (r !== 403) throw new Error(`register answered ${r}`);
  await H.page.getByRole('switch', { name: /Let new people create accounts/ }).click({ force: true });
  await H.page.getByText('Anyone can create an account now.').waitFor();
});

await check('an announcement reaches everyone live, can be dismissed, and taken down', async () => {
  const text = `Calls restart at 11 pm (${stamp})`;
  await H.page.getByLabel('Announcement').fill(text);
  await H.page.getByRole('button', { name: 'Publish' }).click();
  const banner = B.page.getByRole('status').filter({ hasText: text });
  await banner.waitFor({ timeout: 5000 });
  await H.page.screenshot({ path: `${SHOTS}admin-03-settings.png` });
  await B.page.screenshot({ path: `${SHOTS}admin-04-announcement.png` });
  await banner.getByRole('button', { name: 'Dismiss announcement' }).click();
  await banner.waitFor({ state: 'detached' });
  await C.page.getByRole('status').filter({ hasText: text }).first().waitFor({ timeout: 5000 });
  await H.page.getByRole('button', { name: 'Take down' }).click();
  await C.page.getByRole('status').filter({ hasText: text }).first().waitFor({ state: 'detached', timeout: 5000 });
});

await check('anyone can change their own password from the account menu', async () => {
  await B.page.getByRole('button', { name: 'Your account' }).click();
  await B.page.getByRole('menuitem', { name: 'Change password' }).click();
  const dlg = B.page.getByRole('dialog', { name: 'Change password' });
  await dlg.getByLabel('Current password').fill('wrong-password');
  await dlg.getByLabel('New password', { exact: true }).fill('brand-new-pass');
  await dlg.getByLabel('New password again').fill('brand-new-pass');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await dlg.getByText('Your current password is incorrect.').waitFor();
  await dlg.getByLabel('Current password').fill(B.password);
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await B.page.getByText('Your password was changed.').waitFor();
  await B.page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await login(B, B.email, 'brand-new-pass');
  await B.page.waitForURL(`${BASE}/chats`, { timeout: 5000 });
});

await check('on a phone, the admin menu opens each page with a way back', async () => {
  await login(P, 'admin', 'admin');
  await P.page.waitForURL(`${BASE}/chats`, { timeout: 8000 });
  await P.page.getByRole('link', { name: 'Admin' }).click();
  await P.page.getByRole('navigation', { name: 'Admin' }).waitFor();
  await P.page.screenshot({ path: `${SHOTS}admin-05-phone-menu.png` });
  await P.page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: /People/ }).click();
  await P.page.getByLabel('Search people').waitFor();
  await P.page.screenshot({ path: `${SHOTS}admin-06-phone-people.png` });
  const over = await P.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) throw new Error(`phone page scrolls sideways by ${over}px`);
  await P.page.getByRole('button', { name: 'Back to admin' }).click();
  await P.page.getByRole('navigation', { name: 'Admin' }).waitFor();
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAIL', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
