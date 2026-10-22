// A room's chat history, cleared by its admins: on a schedule (messages older
// than its choice go by themselves) and all at once. What the app kept from
// before goes too, also when it was offline then (see the server's
// services/history.js).
import type { ClearAfter, ClearAfterUnit, Paged, RoomMessage, RoomSummary } from './types';

const MS: Record<Exclude<ClearAfterUnit, 'month'>, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** The most of each unit (as the server allows). */
export const MOST: Record<ClearAfterUnit, number> = { minute: 1440, hour: 720, day: 365, month: 12 };

/** "7 days", "1 hour". */
export const clearAfterLabel = (c: ClearAfter) => `${c.amount} ${c.unit}${c.amount === 1 ? '' : 's'}`;

/** Messages from before this have gone on the schedule, counting back from `now`. */
function expiredBefore(c: ClearAfter, now: number) {
  if (c.unit !== 'month') return now - c.amount * MS[c.unit];
  const d = new Date(now);
  d.setMonth(d.getMonth() - c.amount);
  return d.getTime();
}

/**
 * Nothing in the room from this time or earlier shows any more (0: everything's
 * kept). `schedule`: count its schedule too, by this device's clock (only for
 * chats kept from before; live, the server says when, in its own time, as a
 * phone's clock can be off).
 */
export function clearedUpTo(room: Pick<RoomSummary, 'clearAfter' | 'clearedAt'> | undefined, { schedule = false, now = Date.now() } = {}) {
  if (!room) return 0;
  return Math.max(room.clearedAt ? Date.parse(room.clearedAt) : 0, schedule && room.clearAfter ? expiredBefore(room.clearAfter, now) : 0);
}

/** A page without what was cleared (the same page when nothing was; messages still sending stay). */
export function withoutCleared<T extends Paged<RoomMessage> | undefined>(page: T, upTo: number): T {
  if (!page || !upTo) return page;
  const items = page.items.filter((m) => m.pending || Date.parse(m.createdAt) > upTo);
  return (items.length === page.items.length ? page : { ...page, items }) as T;
}
