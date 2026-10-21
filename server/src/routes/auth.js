import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, query } from '../db.js';
import { AppError, conflict, forbidden } from '../errors.js';
import { clearAuthCookie, COOKIE_NAME, requireAuth, setAuthCookie, verifyToken } from '../auth.js';
import { findSessionUser, SESSION_COLUMNS, sessionUser } from '../services/users.js';
import { getSettings, isDisabled } from '../services/site.js';

export const authRouter = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
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
  try {
    const row = await one(
      `INSERT INTO users (email, name, password_hash, avatar_hue) VALUES ($1, $2, $3, $4)
       RETURNING ${SESSION_COLUMNS}`,
      [email, name, hash, await nextHue()],
    );
    setAuthCookie(res, row.id);
    res.status(201).json({ user: sessionUser(row) });
  } catch (err) {
    if (err.code === '23505') throw conflict('An account with this email already exists. Log in instead.');
    throw err;
  }
});

authRouter.post('/login', limiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const row = await one(`SELECT ${SESSION_COLUMNS}, password_hash, disabled_at FROM users WHERE lower(email) = $1`, [email]);
  const ok = row && (await bcrypt.compare(password, row.password_hash));
  if (!ok) throw new AppError(401, 'Email or password is incorrect.');
  if (row.disabled_at) throw forbidden('This account has been switched off by the host.');
  setAuthCookie(res, row.id);
  res.json({ user: sessionUser(row) });
});

authRouter.post('/logout', (_req, res) => {
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
  res.json({ user: await findSessionUser(req.userId) });
});

// Always 200 so a logged-out visit doesn't log an error; user is null then.
authRouter.get('/me', async (req, res) => {
  const userId = verifyToken(req.cookies?.[COOKIE_NAME]);
  const user = userId && !isDisabled(userId) ? await findSessionUser(userId) : null;
  if (!user && req.cookies?.[COOKIE_NAME]) clearAuthCookie(res);
  res.json({ user });
});
