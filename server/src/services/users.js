import { config } from '../config.js';
import { one, query } from '../db.js';
import { getIO, presence, userChannel } from '../realtime.js';
import { blockedEitherWay, hasBlocked } from './blocks.js';
import { hidesPresence } from './privacy.js';

export const USER_COLUMNS = 'id, email, handle, name, avatar_hue, photo, last_seen_at';

/**
 * Where someone's profile photo is (signed-in people only), or null for
 * initials. The version is in the address, so it can be cached for good.
 */
export const photoUrl = (userId, version) => (version ? `/api/users/${userId}/photo/${version}` : null);

/** A room's photo (set by its admins), or null for its letter. */
export const roomPhotoUrl = (roomId, version) => (version ? `/api/rooms/${roomId}/photo/${version}` : null);

/**
 * A person as others see them. Pass who is looking (`viewerId`): when either
 * of them doesn't share presence, or one blocked the other, online and last
 * seen are left out.
 */
export function publicUser(row, viewerId) {
  if (!row) return null;
  const other = viewerId && viewerId !== row.id;
  const hidden = hidesPresence(row.id) || (other && (hidesPresence(viewerId) || blockedEitherWay(viewerId, row.id)));
  return {
    id: row.id,
    handle: row.handle ?? null,
    name: row.name,
    hue: row.avatar_hue,
    photo: photoUrl(row.id, row.photo),
    lastSeenAt: hidden ? null : row.last_seen_at,
    online: hidden ? false : presence.isOnline(row.id),
    ...(hidden ? { presenceHidden: true } : {}),
    // I blocked them (whether they blocked me isn't said).
    ...(other && hasBlocked(viewerId, row.id) ? { blocked: true } : {}),
  };
}

export async function findUser(id, viewerId) {
  return publicUser(await one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND disabled_at IS NULL`, [id]), viewerId);
}

export const SESSION_COLUMNS = `${USER_COLUMNS}, site_role, must_change_password, share_presence, read_receipts`;

/** The signed-in person, with what only they need to know about their own account. */
export function sessionUser(row) {
  if (!row) return null;
  const siteAdmin = row.site_role === 'admin';
  return {
    ...publicUser({ ...row }),
    email: row.email,
    online: true,
    lastSeenAt: row.last_seen_at,
    presenceHidden: undefined,
    siteAdmin,
    mustChangePassword: row.must_change_password,
    // On a public server the well-known default password must go before anything else.
    passwordChangeRequired: siteAdmin && row.must_change_password && config.isProd,
    privacy: { sharePresence: row.share_presence ?? true, readReceipts: row.read_receipts ?? true },
  };
}

export async function findSessionUser(id) {
  return sessionUser(await one(`SELECT ${SESSION_COLUMNS} FROM users WHERE id = $1 AND disabled_at IS NULL`, [id]));
}

// ── User IDs ──────────────────────────────────────────────────────────

/** 3 to 24 lowercase letters, digits, dots or underscores, starting and ending with a letter or digit. */
export const HANDLE_RULES = 'Use 3 to 24 letters, numbers, dots or underscores, starting and ending with a letter or number.';
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|[._](?![._])){1,22}[a-z0-9]$/;

/** "@Ana.Rahman" → "ana.rahman"; null when it can't be a user ID. */
export function normalizeHandle(value) {
  const h = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  return HANDLE_RE.test(h) ? h : null;
}

/** The site's host admin, who can do in any room what its admins can. */
export async function isHost(userId) {
  return !!(await one(`SELECT 1 FROM users WHERE id = $1 AND site_role = 'admin'`, [userId]));
}

// ── Contacts: the people someone has a chat with or shares a room with ──
// Only they see each other's online status. Everyone else has to know the
// exact user ID or email to find someone.

export async function contactIds(userId) {
  const { rows } = await query(
    `SELECT recipient_id AS id FROM dm_messages WHERE sender_id = $1
     UNION SELECT sender_id FROM dm_messages WHERE recipient_id = $1
     UNION SELECT other.user_id FROM room_members mine
       JOIN room_members other ON other.room_id = mine.room_id AND other.user_id <> $1
       WHERE mine.user_id = $1`,
    [userId],
  );
  // Someone either of them blocked isn't told when the other comes and goes.
  return new Set(rows.map((r) => r.id).filter((id) => !blockedEitherWay(userId, id)));
}

/**
 * Tells everyone who can see this person (their contacts and their own apps)
 * what changed about them, and updates what their live connections send with
 * their messages and calls.
 */
export async function announceProfile(userId, fields) {
  const io = getIO();
  if (!io) return;
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data.userId === userId && socket.data.user) Object.assign(socket.data.user, fields);
  }
  const channels = [userId, ...(await contactIds(userId))].map(userChannel);
  io.to(channels).emit('user:updated', { user: { id: userId, ...fields } });
}
