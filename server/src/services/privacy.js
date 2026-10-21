// Two privacy choices, like most chat apps, and both work both ways:
// - share_presence off: others don't see when you're online or were last seen,
//   and you don't see theirs.
// - read_receipts off: people you chat with don't see when you've read their
//   messages, and you don't see when they've read yours. Rooms always show who
//   has seen a message, like group chats elsewhere.
// Kept in memory (loaded on start) because they're checked on every presence
// change and message.
import { query } from '../db.js';

const hidden = new Set();
const noReceipts = new Set();

export async function loadPrivacy() {
  hidden.clear();
  noReceipts.clear();
  const { rows } = await query('SELECT id, share_presence, read_receipts FROM users WHERE NOT share_presence OR NOT read_receipts');
  for (const r of rows) {
    if (!r.share_presence) hidden.add(r.id);
    if (!r.read_receipts) noReceipts.add(r.id);
  }
}

export const hidesPresence = (userId) => hidden.has(userId);
export const sendsReceipts = (userId) => !noReceipts.has(userId);
/** Read receipts in a chat show only when both people share them. */
export const receiptsShared = (a, b) => !noReceipts.has(a) && !noReceipts.has(b);

export async function savePrivacy(userId, { sharePresence, readReceipts }) {
  const { rows: [row] } = await query(
    `UPDATE users SET share_presence = coalesce($2, share_presence), read_receipts = coalesce($3, read_receipts)
     WHERE id = $1 RETURNING share_presence, read_receipts`,
    [userId, sharePresence ?? null, readReceipts ?? null],
  );
  if (!row) return null;
  if (row.share_presence) hidden.delete(userId);
  else hidden.add(userId);
  if (row.read_receipts) noReceipts.delete(userId);
  else noReceipts.add(userId);
  return { sharePresence: row.share_presence, readReceipts: row.read_receipts };
}
