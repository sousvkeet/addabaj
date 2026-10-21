import { config } from '../config.js';
import { one } from '../db.js';
import { presence } from '../realtime.js';

export const USER_COLUMNS = 'id, email, name, avatar_hue, last_seen_at';

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    hue: row.avatar_hue,
    lastSeenAt: row.last_seen_at,
    online: presence.isOnline(row.id),
  };
}

export async function findUser(id) {
  return publicUser(await one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND disabled_at IS NULL`, [id]));
}

export const SESSION_COLUMNS = `${USER_COLUMNS}, site_role, must_change_password`;

/** The signed-in person, with what only they need to know about their own account. */
export function sessionUser(row) {
  if (!row) return null;
  const siteAdmin = row.site_role === 'admin';
  return {
    ...publicUser(row),
    siteAdmin,
    mustChangePassword: row.must_change_password,
    // On a public server the well-known default password must go before anything else.
    passwordChangeRequired: siteAdmin && row.must_change_password && config.isProd,
  };
}

export async function findSessionUser(id) {
  return sessionUser(await one(`SELECT ${SESSION_COLUMNS} FROM users WHERE id = $1 AND disabled_at IS NULL`, [id]));
}
