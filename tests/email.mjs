// Email codes: the host sets up a mail server, new people confirm their email
// with a code, and a forgotten password is reset with one. Runs against the dev
// servers (npm run dev) with a mail catcher of its own, and turns email off again
// at the end.
import { chromium } from 'playwright';
import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';

const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4080}`;
const SMTP_PORT = Number(process.env.SMTP_TEST_PORT ?? 2526);
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);

// ── A mail server that keeps what it's sent (just enough SMTP) ──
const inbox = [];
const catcher = createServer((sock) => {
  sock.setEncoding('utf8');
  let buf = '';
  let data = false;
  let to = [];
  const reply = (line) => sock.write(`${line}\r\n`);
  reply('220 catcher ESMTP');
  sock.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      if (data) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        const raw = buf.slice(0, end);
        buf = buf.slice(end + 5);
        data = false;
        inbox.push({ to, subject: /^Subject: (.*)$/im.exec(raw)?.[1] ?? '', raw });
        to = [];
        reply('250 OK');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-catcher\r\n250 8BITMIME\r\n');
      else if (cmd === 'RCPT') {
        to.push(/<([^>]*)>/.exec(line)?.[1]);
        reply('250 OK');
      } else if (cmd === 'DATA') {
        data = true;
        reply('354 Go on');
      } else if (cmd === 'QUIT') {
        reply('221 Bye');
        sock.end();
      } else reply('250 OK');
    }
  });
});
await new Promise((r) => catcher.listen(SMTP_PORT, '127.0.0.1', r));

/** The newest email to this address whose subject matches, once it arrives. */
async function mailTo(to, match, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = inbox.filter((x) => x.to.includes(to) && match.test(x.subject)).at(-1);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no email to ${to} matching ${match}`);
}
const codeIn = (mail) => /(\d{6})/.exec(mail.subject)?.[1];

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

async function call(method, path, body, cookie) {
  const r = await fetch(`${API}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}

const browser = await chromium.launch();
async function person(name, phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  return { name, ctx, page };
}

const admin = (await call('POST', '/auth/login', { email: 'admin', password: 'admin' })).cookie;
if (!admin) throw new Error('Log in as the host admin failed: run npm run admin:reset first.');
const before = (await call('GET', '/admin/email', null, admin)).data.email;
if (before.source === 'env') console.log('     (server/.env has SMTP settings; this test overrides them and goes back to them at the end)');

const H = await person('Host');
const N = await person('Nila', true);
const R = await person('Rahul');
const nila = { name: 'Nila Basu', email: `nila.${stamp}@adda.test`, password: 'password123' };

try {
  await check('the host sets up email in Site settings and a test email arrives', async () => {
    await H.page.goto(`${BASE}/login`);
    await H.page.getByLabel('Email or username').fill('admin');
    await H.page.getByLabel('Password', { exact: true }).fill('admin');
    await H.page.getByRole('button', { name: 'Log in' }).click();
    await H.page.waitForURL('**/chats');
    await H.page.goto(`${BASE}/admin/settings`);
    const panel = H.page.locator('section').filter({ has: H.page.getByRole('heading', { name: 'Email', exact: true }) });
    await panel.getByText('Email is off').waitFor();
    await panel.getByText('Send email from Adda Khana').click();
    await panel.getByLabel('Mail server (SMTP)').fill('127.0.0.1');
    await panel.getByLabel('Security').selectOption('none');
    await panel.getByLabel('Port', { exact: true }).fill(String(SMTP_PORT));
    await panel.getByLabel('Emails come from').fill('Adda Khana <no-reply@adda.test>');
    await panel.getByRole('button', { name: 'Save' }).click();
    await panel.getByText(/Email is on\. New accounts confirm their email/).waitFor();
    await panel.getByLabel('Send a test email to').fill('host@adda.test');
    await panel.getByRole('button', { name: 'Send test' }).click();
    await H.page.getByText('Test email sent to host@adda.test').waitFor();
    if ((await mailTo('host@adda.test', /can send email/)).subject !== 'Adda Khana can send email') throw new Error('wrong test email');
    await H.page.screenshot({ path: `${SHOTS}email-1-admin.png`, fullPage: true });
  });

  await check('the host’s settings never show the mail password', async () => {
    await call('PUT', '/admin/email', { ...before, enabled: true, host: '127.0.0.1', port: SMTP_PORT, security: 'none', from: 'Adda Khana <no-reply@adda.test>', verifySignups: true, user: 'catcher', password: 'secret-pass' }, admin);
    const views = [await call('GET', '/admin/email', null, admin), await call('GET', '/admin/settings', null, admin)];
    if (JSON.stringify(views.map((v) => v.data)).includes('secret-pass')) throw new Error('the password came back');
    if (!views[0].data.email.passwordSet) throw new Error('the saved password is not reported');
    // Back to no login for the catcher.
    await call('PUT', '/admin/email', { enabled: true, host: '127.0.0.1', port: SMTP_PORT, security: 'none', from: 'Adda Khana <no-reply@adda.test>', verifySignups: true, user: '', password: '' }, admin);
  });

  await check('signing up (phone) asks for the code emailed to the address; a wrong code says so', async () => {
    await N.page.goto(`${BASE}/signup`);
    await N.page.getByLabel('Your name').fill(nila.name);
    await N.page.getByLabel('Email').fill(nila.email);
    await N.page.getByLabel('Password').fill(nila.password);
    await N.page.getByRole('button', { name: 'Create account' }).click();
    await N.page.getByRole('heading', { name: 'Check your email' }).waitFor();
    const code = codeIn(await mailTo(nila.email, /is your Adda Khana code/));
    if (!code) throw new Error('no code in the email');
    nila.code = code;
    // No account until the code comes back.
    if ((await call('POST', '/auth/login', { email: nila.email, password: nila.password })).status !== 401) throw new Error('the account exists before the code');
    await N.page.screenshot({ path: `${SHOTS}email-2-code-phone.png` });
    await N.page.getByLabel('Code from the email').fill(code === '000000' ? '111111' : '000000');
    await N.page.getByRole('alert').getByText('That code isn’t right. 4 tries left.').waitFor();
  });

  await check('the code step survives a reload (a trip to the mail app) and is offered on the login page; the right code logs in', async () => {
    await N.page.reload();
    await N.page.getByRole('heading', { name: 'Check your email' }).waitFor();
    // An app the phone closed meanwhile opens on the login page: it offers to carry on.
    await N.page.goto(`${BASE}/login`);
    await N.page.getByRole('link', { name: `Finish creating your account: enter the code we emailed to ${nila.email}.` }).click();
    await N.page.getByRole('heading', { name: 'Check your email' }).waitFor();
    await N.page.getByLabel('Code from the email').fill(nila.code);
    await N.page.waitForURL('**/chats', { timeout: 10000 });
    const me = await call('POST', '/auth/login', { email: nila.email, password: nila.password });
    if (me.status !== 200) throw new Error(`can't log in afterwards: ${me.status}`);
  });

  await check('a sign-up’s code works only from the browser that signed up (and only once)', async () => {
    const email = `taken.${stamp}@adda.test`;
    const start = await call('POST', '/auth/register', { name: 'Someone', email, password: 'password123' });
    const code = codeIn(await mailTo(email, /is your Adda Khana code/));
    const elsewhere = await call('POST', '/auth/register/confirm', { token: 'not-the-token-0123456789', code });
    if (elsewhere.status !== 410) throw new Error(`the code worked without the token: ${elsewhere.status}`);
    const ok = await call('POST', '/auth/register/confirm', { token: start.data.confirm.token, code });
    const again = await call('POST', '/auth/register/confirm', { token: start.data.confirm.token, code });
    if (ok.status !== 201 || again.status !== 410) throw new Error(`${ok.status} then ${again.status}`);
  });

  await check('a sign-up waiting for its code can’t finish once the host closes sign-ups', async () => {
    const email = `closed.${stamp}@adda.test`;
    const start = await call('POST', '/auth/register', { name: 'Late', email, password: 'password123' });
    const code = codeIn(await mailTo(email, /is your Adda Khana code/));
    await call('PATCH', '/admin/settings', { allowSignups: false }, admin);
    try {
      const r = await call('POST', '/auth/register/confirm', { token: start.data.confirm.token, code });
      if (r.status !== 403 || !/closed/.test(r.data.error)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
    } finally {
      await call('PATCH', '/admin/settings', { allowSignups: true }, admin);
    }
  });

  await check('five wrong tries use a code up', async () => {
    const email = `tries.${stamp}@adda.test`;
    const start = await call('POST', '/auth/register', { name: 'Tara', email, password: 'password123' });
    const code = codeIn(await mailTo(email, /is your Adda Khana code/));
    for (let i = 1; i <= 5; i++) {
      await call('POST', '/auth/register/confirm', { token: start.data.confirm.token, code: String((Number(code) + i) % 1e6).padStart(6, '0') });
    }
    const right = await call('POST', '/auth/register/confirm', { token: start.data.confirm.token, code });
    if (right.status !== 400 || !/can’t be used any more/.test(right.data.error)) throw new Error(JSON.stringify(right.data));
  });

  await check('“Forgot password?”: a code by email sets a new password, logs in, and logs out the other device', async () => {
    // Nila is also logged in on a computer.
    await R.page.goto(`${BASE}/login`);
    await R.page.getByLabel('Email or username').fill(nila.email);
    await R.page.getByLabel('Password', { exact: true }).fill(nila.password);
    await R.page.getByRole('button', { name: 'Log in' }).click();
    await R.page.waitForURL('**/chats');
    // On her phone, she's forgotten it.
    await N.page.evaluate(async () => fetch('/api/auth/logout', { method: 'POST' }));
    await N.page.goto(`${BASE}/login`);
    await N.page.getByLabel('Email or username').fill(nila.email);
    await N.page.getByRole('link', { name: 'Forgot password?' }).click();
    await N.page.getByRole('heading', { name: 'Forgot your password?' }).waitFor();
    if ((await N.page.getByLabel('Email').inputValue()) !== nila.email) throw new Error('the email was not carried over');
    await N.page.getByRole('button', { name: 'Send code' }).click();
    await N.page.getByRole('heading', { name: 'Check your email' }).waitFor();
    const code = codeIn(await mailTo(nila.email, /password reset code/));
    await N.page.screenshot({ path: `${SHOTS}email-3-reset-phone.png` });
    await N.page.getByLabel('Code from the email').fill(code);
    await N.page.getByLabel('New password').fill('newpass456');
    await N.page.getByRole('button', { name: 'Reset password' }).click();
    await N.page.waitForURL('**/chats', { timeout: 10000 });
    await R.page.getByText('You were logged out because the password was changed.').waitFor({ timeout: 8000 });
    await R.page.waitForURL('**/login', { timeout: 8000 });
    if ((await call('POST', '/auth/login', { email: nila.email, password: nila.password })).status !== 401) throw new Error('the old password still works');
    if ((await call('POST', '/auth/login', { email: nila.email, password: 'newpass456' })).status !== 200) throw new Error('the new password does not work');
  });

  await check('asking to reset a password says the same whether or not there’s an account, and sends nothing for none', async () => {
    const nobody = `nobody.${stamp}@adda.test`;
    const [a, b] = [await call('POST', '/auth/forgot', { email: nobody }), await call('POST', '/auth/forgot', { email: `x${nila.email}` })];
    if (a.status !== 200 || JSON.stringify(a.data) !== JSON.stringify(b.data)) throw new Error(`${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    await new Promise((r) => setTimeout(r, 1500));
    if (inbox.some((m) => m.to.includes(nobody))) throw new Error('an email went to an address with no account');
  });

  await check('with email off, sign-up logs straight in and there’s no “Forgot password?”', async () => {
    await call('PUT', '/admin/email', { enabled: false, host: '127.0.0.1', port: SMTP_PORT, security: 'none', from: 'Adda Khana <no-reply@adda.test>', verifySignups: true, user: '' }, admin);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}/signup`);
      await page.getByLabel('Your name').fill('Off Line');
      await page.getByLabel('Email').fill(`off.${stamp}@adda.test`);
      await page.getByLabel('Password').fill('password123');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.waitForURL('**/chats', { timeout: 10000 });
      await page.evaluate(async () => fetch('/api/auth/logout', { method: 'POST' }));
      await page.goto(`${BASE}/login`);
      await page.getByRole('button', { name: 'Log in' }).waitFor();
      await page.waitForTimeout(800);
      if (await page.getByRole('link', { name: 'Forgot password?' }).count()) throw new Error('the reset link shows with email off');
    } finally {
      await ctx.close();
    }
  });
} finally {
  // Back to how email was before the test.
  if (before.source === 'admin') {
    const { passwordSet: _p, source: _s, envAvailable: _e, ready: _r, ...settings } = before;
    await call('PUT', '/admin/email', settings, admin);
  } else {
    await call('DELETE', '/admin/email', null, admin);
  }
  await browser.close();
  catcher.close();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
