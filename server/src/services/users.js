import { config } from '../config.js';
import { one } from '../db.js';
import { presence } from '../realtime.js';
import { hidesPresence } from './privacy.js';

export const USER_COLUMNS = 'id, email, name, avatar_hue, last_seen_at';

/**
 * A person as others see them. Pass who is looking (`viewerId`): when either
 * of them doesn't share presence, online and last seen are left out.
 */
export function publicUser(row, viewerId) {
  if (!row) return null;
  const hidden = hidesPresence(row.id) || (viewerId && viewerId !== row.id && hidesPresence(viewerId));
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    hue: row.avatar_hue,
    lastSeenAt: hidden ? null : row.last_seen_at,
    online: hidden ? false : presence.isOnline(row.id),
    ...(hidden ? { presenceHidden: true } : {}),
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
