// A room's chat history, cleared by its admins (Room settings › Chat history):
// on a schedule, messages older than the room's choice ("30 days", "12 hours")
// go by themselves; and all at once, with one tap. They go for everyone,
// with their files, reactions and earlier versions (a report keeps its own
// copy). Apps drop what they kept: they're told (room:cleared), and a room's
// clearedAt and clearAfter tell those that were offline.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { one, query, transaction } from '../db.js';
import { getIO, roomChannel } from '../realtime.js';
import { pushChatRead } from './push.js';
import { uploadDir } from './uploads.js';

/** The units a room's history can clear after, and the most of each. */
export const UNITS = { minute: 1440, hour: 720, day: 365, month: 12 };

/** How often the schedule is checked. */
const SWEEP_MS = 20_000;

/** "30 days" for { amount: 30, unit: 'day' }; null for off. */
export function clearAfterText(choice) {
  if (!choice) return null;
  return `${choice.amount} ${choice.unit}${choice.amount === 1 ? '' : 's'}`;
}

/** { amount: 30, unit: 'day' } for "30 days" (null: off). */
export function parseClearAfter(text) {
  const m = /^(\d+) (minute|hour|day|month)s?$/.exec(text ?? '');
  return m ? { amount: Number(m[1]), unit: m[2] } : null;
}

/**
 * Deletes room messages (those `where` picks, from room_messages m), with
 * their files and earlier versions. Returns the rooms that lost some, with
 * the time before which nothing is left.
 */
async function erase(where, params) {
  const { files, rooms } = await transaction(async (c) => {
    const { rows: files } = await c.query(
      `SELECT a.stored FROM attachments a JOIN room_messages m ON m.id = a.room_message_id JOIN rooms r ON r.id = m.room_id WHERE ${where}`,
      params,
    );
    const { rows: gone } = await c.query(
      `DELETE FROM room_messages m USING rooms r WHERE r.id = m.room_id AND ${where} RETURNING m.id, m.room_id`,
      params,
    );
    if (gone.length) {
      await c.query(`DELETE FROM message_edits WHERE scope = 'room' AND message_id = ANY($1::bigint[])`, [gone.map((g) => g.id)]);
    }
    return { files, rooms: [...new Set(gone.map((g) => g.room_id))] };
  });
  for (const f of files) await rm(join(uploadDir, f.stored), { force: true }).catch(() => {});
  return rooms;
}

const EXPIRED = `r.clear_after IS NOT NULL AND m.created_at < now() - r.clear_after::interval`;

/** Messages past their room's schedule go; each room's apps drop theirs. */
export async function sweepHistory(roomId = null) {
  const rooms = await erase(roomId ? `${EXPIRED} AND r.id = $1` : EXPIRED, roomId ? [roomId] : []);
  if (!rooms.length) return;
  const { rows } = await query(
    `SELECT id, now() - clear_after::interval AS before FROM rooms WHERE id = ANY($1::uuid[]) AND clear_after IS NOT NULL`,
    [rooms],
  );
  const io = getIO();
  for (const r of rows) io?.to(roomChannel(r.id)).emit('room:cleared', { roomId: r.id, before: r.before });
}

/** Every message in the room goes now. Returns when (apps drop what they kept from before then). */
export async function clearRoomHistory(roomId) {
  await erase('m.room_id = $1', [roomId]);
  const { cleared_at: before } = await one('UPDATE rooms SET history_cleared_at = now() WHERE id = $1 RETURNING history_cleared_at AS cleared_at', [roomId]);
  getIO()?.to(roomChannel(roomId)).emit('room:cleared', { roomId, before, all: true });
  // Phones drop the room's notifications too.
  const { rows } = await query('SELECT user_id FROM room_members WHERE room_id = $1', [roomId]);
  for (const r of rows) pushChatRead(r.user_id, 'room', roomId);
  return before;
}

let timer = null;

/** Checks every room's schedule from now on. */
export function startHistorySweeps() {
  if (timer) return;
  timer = setInterval(() => {
    sweepHistory().catch((err) => console.error('Clearing room history failed:', err.message));
  }, SWEEP_MS);
  timer.unref?.();
}
