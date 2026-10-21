import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { AppError, conflict, forbidden } from '../errors.js';
import { adoptLogin, clearAuthCookie, COOKIE_NAME, readToken, requireAuth, setAuthCookie } from '../auth.js';
import { findSessionUser, HANDLE_RULES, normalizeHandle, SESSION_COLUMNS, sessionUser } from '../services/users.js';
import { endSessions, getSettings, retireLogins } from '../services/site.js';
import { createSession, endOtherSessions, endSession, listSessions, rotateSession, touchSession } from '../services/sessions.js';
import { savePrivacy } from '../services/privacy.js';
import { onlineContacts, tellContacts } from '../services/presence.js';
import { MAX_PHOTO_BYTES, removePhoto, savePhoto } from '../services/photos.js';
import { presence } from '../realtime.js';
import { getIO, userChannel } from '../realtime.js';

// Compared against when the email doesn't exist, so a login takes as long either
// way and can't be used to find out who has an account.
const NO_ONE = bcrypt.hashSync('no-such-account', 10);

export const authRouter = Router();

// 60 sign-ins or sign-ups per address per 15 minutes; more in development, where
// every test runs from the same address.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isProd ? 60 : 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
export const newPassword = z.string().min(8, 'Use at least 8 characters for your password.').max(200);

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(40, 'Keep your name under 40 characters.'),
  email,
  password: newPassword,
});

// People log in with their email; the host admin can also use a username such as "admin".
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Enter your email or username.').max(254),
  password: z.string().min(1, 'Enter your password.'),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword,
});

/** Golden-angle spacing keeps consecutive sign-ups visually distinct. */
export async function nextHue() {
  const { n } = await one('SELECT count(*)::int AS n FROM users');
  return Math.round(n * 137.508 + 24) % 360;
}

// What the login page needs before anyone is signed in.
authRouter.get('/options', (_req, res) => {
  res.json({ allowSignups: getSettings().allowSignups });
});

authRouter.post('/register', limiter, async (req, res) => {
  if (!getSettings().allowSignups) throw forbidden('New sign-ups are closed right now. Ask the host to add you.');
  const { name, email, password } = registerSchema.parse(req.body);
  const hash = await bcrypt.hash(password, 10);
  // The database gives each account a user ID; two sign-ups getting the same one at once just try again.
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await one(
        `INSERT INTO users (email, name, password_hash, avatar_hue) VALUES ($1, $2, $3, $4)
         RETURNING ${SESSION_COLUMNS}`,
        [email, name, hash, await nextHue()],
      );
      setAuthCookie(res, row.id, await createSession(row.id, req));
      res.status(201).json({ user: sessionUser(row) });
      return;
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'users_handle_key' && attempt < 3) continue;
      if (err.code === '23505') throw conflict('An account with this email already exists. Log in instead.');
      throw err;
    }
  }
});

authRouter.post('/login', limiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const row = await one(`SELECT ${SESSION_COLUMNS}, password_hash, disabled_at FROM users WHERE lower(email) = $1`, [email]);
  const ok = await bcrypt.compare(password, row?.password_hash ?? NO_ONE);
  if (!row || !ok) throw new AppError(401, 'Email or password is incorrect.');
  if (row.disabled_at) throw forbidden('This account has been switched off by the host.');
  setAuthCookie(res, row.id, await createSession(row.id, req));
  res.json({ user: sessionUser(row) });
});

// This device's session ends for good: the cookie no longer works, even if it was copied.
authRouter.post('/logout', async (req, res) => {
  const login = readToken(req.cookies?.[COOKIE_NAME]);
  if (login?.sessionId) await endSession(login.userId, login.sessionId, 'logout').catch(() => {});
  clearAuthCookie(res);
  res.status(204).end();
});

authRouter.post('/password', limiter, requireAuth, async (req, res) => {
  const { currentPassword, newPassword: next } = passwordSchema.parse(req.body);
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
    throw new AppError(400, 'Your current password is incorrect.');
  }
  if (await bcrypt.compare(next, row.password_hash)) throw new AppError(400, 'Choose a password different from your current one.');
  await query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [req.userId, await bcrypt.hash(next, 10)]);
  // Everywhere else is signed out; this device gets a fresh login (any copy of its old one stops) and stays in.
  await endOtherSessions(req.userId, req.sessionId, 'password');
  await endSessions(req.userId);
  setAuthCookie(res, req.userId, await rotateSession(req.userId, req.sessionId, req));
  getIO()?.in(userChannel(req.userId)).disconnectSockets(true);
  res.json({ user: await findSessionUser(req.userId) });
});

// Privacy: whether others see your online status / last seen, and your read receipts.
authRouter.patch('/privacy', requireAuth, async (req, res) => {
  const input = z.object({ sharePresence: z.boolean().optional(), readReceipts: z.boolean().optional() }).parse(req.body);
  const before = await one('SELECT share_presence FROM users WHERE id = $1', [req.userId]);
  const saved = await savePrivacy(req.userId, input);
  if (!saved) throw new AppError(404, 'Your account no longer exists.');
  const io = getIO();
  if (io && before && before.share_presence !== saved.sharePresence) {
    if (saved.sharePresence) {
      const row = await one('SELECT last_seen_at FROM users WHERE id = $1', [req.userId]);
      await tellContacts(req.userId, { userId: req.userId, online: presence.isOnline(req.userId), lastSeenAt: row?.last_seen_at ?? null });
    } else {
      await tellContacts(req.userId, { userId: req.userId, online: false, lastSeenAt: null, hidden: true });
    }
    // Their own apps reload who's online (their contacts, or no one now that it works both ways).
    io.to(userChannel(req.userId)).emit('presence:refresh');
  }
  res.json({ user: await findSessionUser(req.userId) });
});

// Your user ID: what people type to find you. Changing it frees the old one.
authRouter.patch('/handle', limiter, requireAuth, async (req, res) => {
  const handle = normalizeHandle(req.body?.handle);
  if (!handle) throw new AppError(400, `That user ID won't work. ${HANDLE_RULES}`);
  try {
    await query('UPDATE users SET handle = $2 WHERE id = $1', [req.userId, handle]);
  } catch (err) {
    if (err.code === '23505') throw conflict('That user ID is taken. Try another.');
    throw err;
  }
  res.json({ user: await findSessionUser(req.userId) });
});

// Your profile photo: a JPEG (the app crops and shrinks it first). Your contacts see it change at once.
authRouter.put('/photo', limiter, requireAuth, express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), async (req, res) => {
  await savePhoto(req.userId, Buffer.isBuffer(req.body) ? req.body : null);
  res.json({ user: await findSessionUser(req.userId) });
});

authRouter.delete('/photo', requireAuth, async (req, res) => {
  await removePhoto(req.userId);
  res.json({ user: await findSessionUser(req.userId) });
});

// Who's online right now (for the presence:refresh above), as this person may see it.
authRouter.get('/presence', requireAuth, async (req, res) => {
  res.json({ online: await onlineContacts(req.userId) });
});

// ── Devices (Settings › Devices) ──────────────────────────────────────

authRouter.get('/sessions', requireAuth, async (req, res) => {
  res.json({ sessions: await listSessions(req.userId, req.sessionId) });
});

// Every other device: logged out (and logins from before devices were tracked stop too).
authRouter.delete('/sessions/others', requireAuth, async (req, res) => {
  await endOtherSessions(req.userId, req.sessionId);
  await retireLogins(req.userId);
  setAuthCookie(res, req.userId, req.sessionId);
  res.json({ sessions: await listSessions(req.userId, req.sessionId) });
});

authRouter.delete('/sessions/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id);
  if (id === req.sessionId) throw new AppError(400, 'To log out of this device, use Log out.');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'That device is already logged out.');
  await endSession(req.userId, id);
  res.json({ sessions: await listSessions(req.userId, req.sessionId) });
});

// Always 200 so a logged-out visit doesn't log an error; user is null then.
// A login from before devices were tracked becomes this device here (the app's first call).
authRouter.get('/me', async (req, res) => {
  const login = readToken(req.cookies?.[COOKIE_NAME]);
  const user = login ? await findSessionUser(login.userId) : null;
  if (!user && req.cookies?.[COOKIE_NAME]) clearAuthCookie(res);
  if (user) touchSession(login.sessionId ?? (await adoptLogin(req, res, login.userId)), req);
  res.json({ user });
});
