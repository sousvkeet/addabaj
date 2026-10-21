// Signed-in devices (Settings › Devices). Every login is a session: which
// device it is (the Android app or a browser), where it last came from and
// when. A login cookie names its session, so a session that's gone (logged
// out here, or from another device) stops working at once: its live
// connection is closed and its phone stops getting notifications.
import { one, query } from '../db.js';
import { notFound } from '../errors.js';
import { getIO, userChannel } from '../realtime.js';

/** session id → user id, for every session that can still be used (checked on every request). */
const live = new Map();
/** When each session was last marked active, so that happens at most once a minute. */
const touched = new Map();
const TOUCH_MS = 60 * 1000;
/** Logins last 30 days (the cookie's life); older sessions are dropped. */
const LIFETIME = "interval '30 days'";

export async function loadSessions() {
  await query(`DELETE FROM sessions WHERE created_at < now() - ${LIFETIME}`);
  live.clear();
  for (const r of (await query('SELECT id, user_id FROM sessions')).rows) live.set(r.id, r.user_id);
}

export const sessionAlive = (sid, userId) => live.get(sid) === userId;

const clientOf = (req) => ({
  userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 400),
  ip: req?.ip ? String(req.ip).replace(/^::ffff:/, '') : null,
});

/** A new login on this request's device; returns the session id. `announce`: tell their other devices. */
export async function createSession(userId, req, { announce = true } = {}) {
  const { userAgent, ip } = clientOf(req);
  const row = await one('INSERT INTO sessions (user_id, user_agent, ip) VALUES ($1, $2, $3) RETURNING id', [userId, userAgent, ip]);
  live.set(row.id, userId);
  touched.set(row.id, Date.now());
  // Their other open devices hear about it, in case it wasn't them.
  if (announce) getIO()?.to(userChannel(userId)).emit('session:new', { session: describe(userAgent) });
  return row.id;
}

/** The device was just used: note when (and from where), at most once a minute. */
export function touchSession(sid, req) {
  if (!sid || Date.now() - (touched.get(sid) ?? 0) < TOUCH_MS) return;
  touched.set(sid, Date.now());
  const { userAgent, ip } = clientOf(req);
  query(
    `UPDATE sessions SET last_active_at = now(), ip = coalesce($2, ip), user_agent = CASE WHEN $3 = '' THEN user_agent ELSE $3 END WHERE id = $1`,
    [sid, ip, userAgent],
  ).catch(() => {});
}

/**
 * What a device is, from its user agent: the Android app (with the phone's
 * model and Android version) or a browser on a computer or phone.
 */
export function describe(userAgent = '') {
  const ua = String(userAgent);
  const android = /Android ([\d.]+)/.exec(ua)?.[1];
  // The phone's model, when the user agent still says it ("K" is Chrome's stand-in).
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua)?.[1]?.trim();
  const phoneModel = model && model !== 'K' && model !== 'wv' ? model : null;
  const app = /AddaKhanaApp\/([\w.-]+)/.exec(ua)?.[1];
  if (app) {
    return {
      kind: 'app',
      phone: true,
      name: phoneModel ?? 'Android phone',
      detail: [`Adda Khana ${app}`, android && `Android ${android}`].filter(Boolean).join(' · '),
    };
  }
  const browser = /Edg(?:A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'A browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : android
        ? phoneModel ?? 'Android'
        : /Windows NT/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  return {
    kind: 'web',
    phone: /iPhone|Android|Mobile/.test(ua),
    name: os ? `${browser} on ${os}` : browser,
    detail: android ? `Browser · Android ${android}` : 'Browser',
  };
}

/** Sessions with a live connection right now. */
function connectedSessions(userId) {
  const io = getIO();
  const ids = new Set();
  if (!io) return ids;
  for (const s of io.of('/').sockets.values()) if (s.data.userId === userId && s.data.sid) ids.add(s.data.sid);
  return ids;
}

/** Everywhere this person is signed in, this device first, then the most recently used. */
export async function listSessions(userId, currentSid) {
  const { rows } = await query(
    `SELECT id, created_at, last_active_at, user_agent, ip FROM sessions WHERE user_id = $1 ORDER BY last_active_at DESC`,
    [userId],
  );
  const online = connectedSessions(userId);
  return rows
    .map((r) => ({
      id: r.id,
      ...describe(r.user_agent),
      ip: r.ip,
      signedInAt: r.created_at,
      lastActiveAt: r.last_active_at,
      current: r.id === currentSid,
      online: online.has(r.id) || r.id === currentSid,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/**
 * Signs a device out: its cookie stops working, its open app or tab is told
 * and disconnected, and its phone gets no more notifications.
 */
export async function endSession(userId, sid, reason = 'elsewhere') {
  const row = await one('DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id', [sid, userId]);
  if (!row) throw notFound('That device is already logged out.');
  live.delete(sid);
  touched.delete(sid);
  await query('DELETE FROM push_devices WHERE session_id = $1', [sid]);
  const io = getIO();
  if (io) {
    for (const s of io.of('/').sockets.values()) {
      if (s.data.sid !== sid) continue;
      s.emit('session:ended', { reason });
      s.disconnect(true);
    }
  }
}

/**
 * This device carries on under a new session, and its old one stops (the
 * password changed: any copy of its old cookie must stop working too).
 */
export async function rotateSession(userId, oldSid, req) {
  if (oldSid) {
    await query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [oldSid, userId]);
    live.delete(oldSid);
    touched.delete(oldSid);
  }
  return createSession(userId, req, { announce: false });
}

/** Every other device: signed out (keeps `keepSid`, this one; none when it's null). */
export async function endOtherSessions(userId, keepSid, reason = 'elsewhere') {
  const { rows } = await query('SELECT id FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2', [userId, keepSid]);
  for (const r of rows) await endSession(userId, r.id, reason).catch(() => {});
  // Phones registered before devices were tracked can't be told apart: they stop too (they register again on their next login).
  await query('DELETE FROM push_devices WHERE user_id = $1 AND session_id IS NULL', [userId]);
  return rows.length;
}
