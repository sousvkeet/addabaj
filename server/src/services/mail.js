// Email: codes that confirm a new account's address and reset a forgotten
// password. The host sets up the mail server (SMTP) in Admin › Site settings,
// or with SMTP_* variables in server/.env (used until the admin page saves its own).
import nodemailer from 'nodemailer';
import { AppError } from '../errors.js';
import { getSettings } from './site.js';

const SECURITY = ['starttls', 'tls', 'none'];

/** From server/.env, if set there. */
function fromEnv() {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  const security = SECURITY.includes(process.env.SMTP_SECURITY) ? process.env.SMTP_SECURITY : port === 465 ? 'tls' : 'starttls';
  return {
    enabled: true,
    host,
    port,
    security,
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.SMTP_FROM ?? '',
    verifySignups: process.env.EMAIL_VERIFY_SIGNUPS !== 'false',
  };
}

/** Mail settings are in server/.env (the admin page's own, once saved, come first). */
export const envMail = () => !!fromEnv();

/** The mail server and what email is used for, and where that came from ('admin' | 'env'); null when not set up. */
export function mailSettings() {
  const saved = getSettings().email;
  if (saved) return { ...saved, source: 'admin' };
  const env = fromEnv();
  return env ? { ...env, source: 'env' } : null;
}

/** Email can be sent: password resets work (and sign-ups may be confirmed). */
export function emailReady() {
  const s = mailSettings();
  return !!(s?.enabled && s.host && s.from);
}

/** New accounts confirm their email address with a code first. */
export const confirmingSignups = () => emailReady() && mailSettings().verifySignups !== false;

let cached = { key: '', transport: null };
function transport(s) {
  const key = JSON.stringify([s.host, s.port, s.security, s.user, s.password]);
  if (cached.key !== key) {
    cached.transport?.close();
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.security === 'tls',
        requireTLS: s.security === 'starttls',
        ignoreTLS: s.security === 'none',
        auth: s.user ? { user: s.user, pass: s.password } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      }),
    };
  }
  return cached.transport;
}

/** Sends one email. Throws the mail server's own error (for the host's test). */
export async function sendMail({ to, subject, text, html }) {
  const s = mailSettings();
  if (!s?.enabled || !s.host || !s.from) throw new AppError(503, "Email isn't set up on this server.");
  await transport(s).sendMail({ from: s.from, to, subject, text, html });
}

// ── What the emails say ───────────────────────────────────────────────

const firstName = (name) => String(name).trim().split(/\s+/)[0];
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A simple branded email: a heading, paragraphs, and the code (if any) large. */
function layout({ heading, before, code, after }) {
  const paragraphs = (lines) => lines.map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#2d3047">${escape(l)}</p>`).join('');
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f2f1fb;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden">
<tr><td style="height:5px;background:linear-gradient(90deg,#7c5cff,#e04fd0,#20c7d8);background-color:#7c5cff"></td></tr>
<tr><td style="padding:28px 28px 12px">
<p style="margin:0 0 18px;font-size:14px;font-weight:700;letter-spacing:.02em;color:#7c5cff">Adda Khana</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#14152b">${escape(heading)}</h1>
${paragraphs(before)}
${code ? `<p style="margin:6px 0 20px;font-size:34px;font-weight:700;letter-spacing:.32em;color:#14152b;font-family:'SF Mono',Menlo,Consolas,monospace">${escape(code)}</p>` : ''}
${paragraphs(after)}
</td></tr></table></td></tr></table></body></html>`;
  const text = [heading, ...before, ...(code ? [code] : []), ...after].join('\n\n');
  return { html, text };
}

/** The code that confirms a new account's email. */
export function signupEmail({ name, code, minutes }) {
  return {
    subject: `${code} is your Adda Khana code`,
    ...layout({
      heading: 'Confirm your email',
      before: [`Hi ${firstName(name)},`, 'Enter this code in Adda Khana to finish creating your account:'],
      code,
      after: [`It works for ${minutes} minutes.`, "If you didn't sign up, you can ignore this email. No account is made without the code."],
    }),
  };
}

/** The code that lets someone choose a new password. */
export function resetEmail({ name, email, code, minutes }) {
  return {
    subject: `${code} is your Adda Khana password reset code`,
    ...layout({
      heading: 'Reset your password',
      before: [`Hi ${firstName(name)},`, `Someone asked to reset the password for ${email}. If it was you, enter this code in Adda Khana to choose a new one:`],
      code,
      after: [`It works for ${minutes} minutes.`, "If it wasn't you, ignore this email: your password stays the same."],
    }),
  };
}

/** The host's test from Admin › Site settings. */
export function testEmail() {
  return {
    subject: 'Adda Khana can send email',
    ...layout({
      heading: 'Email works',
      before: ['This is a test from your Adda Khana server.', 'Codes for confirming new accounts and resetting forgotten passwords will arrive like this.'],
      after: [],
    }),
  };
}
