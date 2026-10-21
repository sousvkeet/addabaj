import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { AppError } from './errors.js';
import { isDisabled, sessionValid } from './services/site.js';

export const COOKIE_NAME = 'adda_token';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '30d' });
}

/** The person a login cookie belongs to, or null if it's invalid, expired or signed out. */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    return sessionValid(payload.sub, payload.iat) ? payload.sub : null;
  } catch {
    return null;
  }
}

export function setAuthCookie(res, userId) {
  res.cookie(COOKIE_NAME, signToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function requireAuth(req, _res, next) {
  const userId = verifyToken(req.cookies?.[COOKIE_NAME]);
  if (!userId) {
    const switchedOff = isDisabled(jwt.decode(req.cookies?.[COOKIE_NAME] ?? '')?.sub);
    return next(new AppError(401, switchedOff ? 'This account has been switched off by the host.' : 'Log in to continue.'));
  }
  req.userId = userId;
  next();
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
