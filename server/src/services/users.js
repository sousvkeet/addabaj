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
  return publicUser(await one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]));
}
