// My own settings for each chat and room: muted (for a while, or until I turn
// it back on), pinned to the top of my list, or archived out of the way. Only
// I see them, on all my devices. Pinning takes a chat out of the archive, and
// archiving one unpins it. A muted chat still rings for calls, and mentions
// and replies to me still come through in a muted room.
import { one } from '../db.js';
import { AppError } from '../errors.js';
import { getIO, userChannel } from '../realtime.js';

/** How long a mute lasts ("always": until the year 9999, so until I turn it off). */
export const MUTE_SPANS = ['8h', '1w', 'always', 'off'];
const muteEnd = (span) =>
  ({ '8h': new Date(Date.now() + 8 * 3600_000), '1w': new Date(Date.now() + 7 * 24 * 3600_000), always: new Date('9999-12-31T00:00:00Z'), off: null })[span];

/** Most chats, and separately rooms, pinned at once. */
export const MAX_PINNED = 5;

const current = (at) => (at && new Date(at) > new Date() ? at : null);

/** My settings for a chat as the app gets them. */
export const settingsOf = (row) => ({
  mutedUntil: current(row?.muted_until),
  pinnedAt: row?.pinned_at ?? null,
  archivedAt: row?.archived_at ?? null,
});

/** The new pinned and archived times from a change ({ pinned?, archived? }). */
function next(row, { pinned, archived }) {
  let pinnedAt = row?.pinned_at ?? null;
  let archivedAt = row?.archived_at ?? null;
  if (pinned === true) {
    pinnedAt ??= new Date();
    archivedAt = null;
  } else if (pinned === false) pinnedAt = null;
  if (archived === true) {
    archivedAt ??= new Date();
    pinnedAt = null;
  } else if (archived === false) archivedAt = null;
  return { pinnedAt, archivedAt };
}

const tell = (userId, change) => getIO()?.to(userChannel(userId)).emit('chat:settings', change);

/** My chat with `peerId`: { mute?, pinned?, archived? }. */
export async function setDmSettings(userId, peerId, change) {
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [peerId]))) throw new AppError(404, "That person doesn't exist.");
  const row = await one('SELECT muted_until, pinned_at, archived_at FROM dm_settings WHERE user_id = $1 AND peer_id = $2', [userId, peerId]);
  const { pinnedAt, archivedAt } = next(row, change);
  if (pinnedAt && !row?.pinned_at) {
    // Pinned chats still in my list (a chat I've cleared doesn't count).
    const { count } = await one(
      `SELECT count(*)::int AS count FROM dm_settings s
       WHERE s.user_id = $1 AND s.pinned_at IS NOT NULL AND s.peer_id <> $2
         AND EXISTS (SELECT 1 FROM dm_messages d
                     WHERE ((d.sender_id = $1 AND d.recipient_id = s.peer_id) OR (d.sender_id = s.peer_id AND d.recipient_id = $1))
                       AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = $1 AND h.message_id = d.id))`,
      [userId, peerId],
    );
    if (count >= MAX_PINNED) throw new AppError(409, `You can pin up to ${MAX_PINNED} chats. Unpin one first.`);
  }
  const mutedUntil = change.mute ? muteEnd(change.mute) : (row?.muted_until ?? null);
  const saved = await one(
    `INSERT INTO dm_settings (user_id, peer_id, muted_until, pinned_at, archived_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, peer_id) DO UPDATE SET muted_until = $3, pinned_at = $4, archived_at = $5
     RETURNING muted_until, pinned_at, archived_at`,
    [userId, peerId, mutedUntil, pinnedAt, archivedAt],
  );
  const settings = settingsOf(saved);
  tell(userId, { scope: 'dm', id: peerId, ...settings });
  return settings;
}

/** A room of mine: { pinned?, archived? } (muting has its own route). */
export async function setRoomSettings(userId, roomId, change) {
  const row = await one('SELECT muted_until, pinned_at, archived_at FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  if (!row) throw new AppError(404, "That room doesn't exist or you're not a member.");
  const { pinnedAt, archivedAt } = next(row, change);
  if (pinnedAt && !row.pinned_at) {
    const { count } = await one(
      'SELECT count(*)::int AS count FROM room_members WHERE user_id = $1 AND pinned_at IS NOT NULL AND room_id <> $2',
      [userId, roomId],
    );
    if (count >= MAX_PINNED) throw new AppError(409, `You can pin up to ${MAX_PINNED} rooms. Unpin one first.`);
  }
  const saved = await one(
    `UPDATE room_members SET pinned_at = $3, archived_at = $4 WHERE room_id = $1 AND user_id = $2
     RETURNING muted_until, pinned_at, archived_at`,
    [roomId, userId, pinnedAt, archivedAt],
  );
  if (!saved) throw new AppError(404, "That room doesn't exist or you're not a member.");
  const settings = settingsOf(saved);
  tell(userId, { scope: 'room', id: roomId, ...settings });
  return settings;
}

/** Whether `userId` muted their chat with `peerId` (for notifications). */
export async function dmMuted(userId, peerId) {
  return !!(await one('SELECT 1 FROM dm_settings WHERE user_id = $1 AND peer_id = $2 AND muted_until > now()', [userId, peerId]));
}
