import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { AppError } from './errors.js';
import { isDisabled, sessionValid } from './services/site.js';
import { createSession, sessionAlive, touchSession } from './services/sessions.js';

export const COOKIE_NAME = 'adda_token';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A login cookie: who, and which device's session (Settings › Devices). */
export function signToken(userId, sessionId) {
  return jwt.sign(sessionId ? { sub: userId, sid: sessionId } : { sub: userId }, config.jwtSecret, { expiresIn: '30d' });
}

/**
 * The login a cookie belongs to: { userId, sessionId }, or null if it's
 * invalid, expired, or that device was logged out. Logins from before devices
 * were tracked have no session yet (sessionId null) until adoptLogin.
 */
export function readToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    // An old-style login: valid unless the account logged out everywhere since it was issued.
    if (payload.sid === undefined) return sessionValid(payload.sub, payload.iat) ? { userId: payload.sub, sessionId: null } : null;
    // A device's login: valid while its session is (logging out deletes it) and the account is on.
    return typeof payload.sid === 'string' && !isDisabled(payload.sub) && sessionAlive(payload.sid, payload.sub)
      ? { userId: payload.sub, sessionId: payload.sid }
      : null;
  } catch {
    return null;
  }
}

/** The person a login cookie belongs to, or null if it's invalid, expired or logged out. */
export const verifyToken = (token) => readToken(token)?.userId ?? null;

// An old-style login seen on several requests at once becomes one device, not several.
const adopting = new Map();

/** A login from before devices were tracked: give it a session (this device) and a new cookie naming it. */
export async function adoptLogin(req, res, userId) {
  const token = req.cookies?.[COOKIE_NAME];
  let pending = adopting.get(token);
  if (!pending) {
    // Not a new login (it's been signed in all along), so the other devices aren't told.
    pending = createSession(userId, req, { announce: false });
    adopting.set(token, pending);
    setTimeout(() => adopting.delete(token), 60_000);
  }
  let sessionId;
  try {
    sessionId = await pending;
  } catch (err) {
    // The account is gone (removed by the host).
    if (err.code === '23503') throw new AppError(401, 'Log in to continue.');
    throw err;
  }
  setAuthCookie(res, userId, sessionId);
  return sessionId;
}

export function setAuthCookie(res, userId, sessionId) {
  res.cookie(COOKIE_NAME, signToken(userId, sessionId), {
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

export async function requireAuth(req, res, next) {
  const login = readToken(req.cookies?.[COOKIE_NAME]);
  if (!login) {
    const switchedOff = isDisabled(jwt.decode(req.cookies?.[COOKIE_NAME] ?? '')?.sub);
    return next(new AppError(401, switchedOff ? 'This account has been switched off by the host.' : 'Log in to continue.'));
  }
  req.userId = login.userId;
  req.sessionId = login.sessionId ?? (await adoptLogin(req, res, login.userId));
  touchSession(req.sessionId, req);
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
