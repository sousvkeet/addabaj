// Delivery and read receipts.
//
// Chats: a message is delivered when the recipient's app confirms it got it
// (or, if they were offline, when they next connect), and read when they open
// the chat. The sender is told about both.
//
// Rooms: each member has a delivered point and a read point (the newest
// message their app has received / shown). Changes are gathered for half a
// second and sent to the room in one go, so busy rooms don't flood anyone.
import { query } from '../db.js';
import { getIO, roomChannel, userChannel } from '../realtime.js';

/** Marks chat messages to `recipientId` as delivered (all undelivered ones, or just `ids`) and tells the senders. */
export async function markDmDelivered(recipientId, ids) {
  const { rows } = await query(
    `UPDATE dm_messages SET delivered_at = now()
     WHERE recipient_id = $1 AND delivered_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
     RETURNING id, sender_id, delivered_at`,
    [recipientId, ids ?? null],
  );
  const bySender = new Map(); // senderId -> { ids, at }
  for (const r of rows) {
    const entry = bySender.get(r.sender_id) ?? { ids: [], at: r.delivered_at };
    entry.ids.push(Number(r.id));
    bySender.set(r.sender_id, entry);
  }
  for (const [senderId, { ids: done, at }] of bySender) {
    getIO()?.to(userChannel(senderId)).emit('dm:delivered', { partnerId: recipientId, ids: done, deliveredAt: at });
  }
}

const pending = new Map(); // roomId -> Set<userId>
let timer = null;

/** Sends the room everyone's new delivered / read points, a little later and all at once. */
export function queueRoomReceipts(roomId, userId) {
  let set = pending.get(roomId);
  if (!set) pending.set(roomId, (set = new Set()));
  set.add(userId);
  timer ??= setTimeout(flushRoomReceipts, 500);
}

async function flushRoomReceipts() {
  timer = null;
  const batch = [...pending];
  pending.clear();
  for (const [roomId, users] of batch) {
    try {
      const { rows } = await query(
        `SELECT user_id, last_read_id, GREATEST(last_delivered_id, last_read_id) AS last_delivered_id
         FROM room_members WHERE room_id = $1 AND user_id = ANY($2::uuid[])`,
        [roomId, [...users]],
      );
      if (!rows.length) continue;
      getIO()?.to(roomChannel(roomId)).emit('room:receipts', {
        roomId,
        members: rows.map((r) => ({ userId: r.user_id, lastReadId: Number(r.last_read_id), lastDeliveredId: Number(r.last_delivered_id) })),
      });
    } catch (err) {
      console.error('Could not send room receipts', err);
    }
  }
}

/** Someone's app received room messages up to `messageId`. */
export async function markRoomDelivered(roomId, userId, messageId) {
  const { rowCount } = await query(
    `UPDATE room_members SET last_delivered_id = $3 WHERE room_id = $1 AND user_id = $2 AND last_delivered_id < $3`,
    [roomId, userId, messageId],
  );
  if (rowCount) queueRoomReceipts(roomId, userId);
}

/** On connecting, the app loads every room's latest messages: they're delivered. */
export async function markAllRoomsDelivered(userId) {
  const { rows } = await query(
    `UPDATE room_members rm SET last_delivered_id = latest.id
     FROM (
       SELECT room_id, max(id) AS id FROM room_messages
       WHERE room_id IN (SELECT room_id FROM room_members WHERE user_id = $1)
       GROUP BY room_id
     ) latest
     WHERE rm.user_id = $1 AND rm.room_id = latest.room_id AND rm.last_delivered_id < latest.id
     RETURNING rm.room_id`,
    [userId],
  );
  for (const r of rows) queueRoomReceipts(r.room_id, userId);
}
