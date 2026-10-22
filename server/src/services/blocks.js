// Blocking. Once someone is blocked, the two can't message or call each other,
// the blocked person can't add the blocker to a room or invite them, and
// neither sees the other's online status or last seen. Messages they already
// exchanged stay. The host admin can't be blocked: they run the site.
// Kept in memory too, like privacy settings: it's checked on every message.
import { query } from '../db.js';
import { getIO, userChannel } from '../realtime.js';

const pairs = new Set(); // "blocker:blocked"

export async function loadBlocks() {
  const { rows } = await query('SELECT blocker_id, blocked_id FROM blocks');
  pairs.clear();
  for (const r of rows) pairs.add(`${r.blocker_id}:${r.blocked_id}`);
}

/** `blocker` has blocked `blocked`. */
export const hasBlocked = (blocker, blocked) => pairs.has(`${blocker}:${blocked}`);

/** Either of the two has blocked the other. */
export const blockedEitherWay = (a, b) => !!a && !!b && (hasBlocked(a, b) || hasBlocked(b, a));

/** Why someone can't be messaged (or called): one of the two blocked the other. */
export function blockedMessage(userId, otherId, name, what = 'message') {
  if (hasBlocked(userId, otherId)) return `You blocked ${name}. Unblock them to ${what === 'call' ? 'call them' : 'send a message'}.`;
  return `You can't ${what} this person.`;
}

/** Neither sees the other's online status any more (or, unblocked, again). */
function refreshPresence(a, b, blocked) {
  const io = getIO();
  if (!io) return;
  if (blocked) {
    io.to(userChannel(a)).emit('presence:update', { userId: b, online: false, lastSeenAt: null, hidden: true });
    io.to(userChannel(b)).emit('presence:update', { userId: a, online: false, lastSeenAt: null, hidden: true });
  } else {
    io.to(userChannel(a)).to(userChannel(b)).emit('presence:refresh');
  }
}

export async function block(blocker, blocked) {
  await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [blocker, blocked]);
  pairs.add(`${blocker}:${blocked}`);
  refreshPresence(blocker, blocked, true);
  // The blocker's other devices show it.
  getIO()?.to(userChannel(blocker)).emit('blocks:changed');
}

export async function unblock(blocker, blocked) {
  await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [blocker, blocked]);
  pairs.delete(`${blocker}:${blocked}`);
  if (!hasBlocked(blocked, blocker)) refreshPresence(blocker, blocked, false);
  getIO()?.to(userChannel(blocker)).emit('blocks:changed');
}

/** Who I've blocked (newest first). */
export async function blockedBy(userId) {
  const { rows } = await query(
    `SELECT b.created_at, u.id, u.name, u.handle, u.avatar_hue, u.photo
     FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [userId],
  );
  return rows;
}
