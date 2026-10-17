import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one } from '../db.js';
import { AppError, conflict } from '../errors.js';
import { clearAuthCookie, COOKIE_NAME, setAuthCookie, verifyToken } from '../auth.js';
import { findUser, publicUser, USER_COLUMNS } from '../services/users.js';

export const authRouter = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(40, 'Keep your name under 40 characters.'),
  email,
  password: z.string().min(8, 'Use at least 8 characters for your password.').max(200),
});

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
});

authRouter.post('/register', limiter, async (req, res) => {
  const { name, email, password } = registerSchema.parse(req.body);
  const hash = await bcrypt.hash(password, 10);
  // Golden-angle spacing keeps consecutive sign-ups visually distinct.
  const { n } = await one('SELECT count(*)::int AS n FROM users');
  const hue = Math.round(n * 137.508 + 24) % 360;
  try {
    const row = await one(
      `INSERT INTO users (email, name, password_hash, avatar_hue) VALUES ($1, $2, $3, $4)
       RETURNING ${USER_COLUMNS}`,
      [email, name, hash, hue],
    );
    setAuthCookie(res, row.id);
    res.status(201).json({ user: publicUser(row) });
  } catch (err) {
    if (err.code === '23505') throw conflict('An account with this email already exists. Log in instead.');
    throw err;
  }
});

authRouter.post('/login', limiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const row = await one(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = $1`, [email]);
  const ok = row && (await bcrypt.compare(password, row.password_hash));
  if (!ok) throw new AppError(401, 'Email or password is incorrect.');
  setAuthCookie(res, row.id);
  res.json({ user: publicUser(row) });
});

authRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

// Always 200 so a logged-out visit doesn't log an error; user is null then.
authRouter.get('/me', async (req, res) => {
  const userId = verifyToken(req.cookies?.[COOKIE_NAME]);
  const user = userId ? await findUser(userId) : null;
  if (!user && req.cookies?.[COOKIE_NAME]) clearAuthCookie(res);
  res.json({ user });
});
