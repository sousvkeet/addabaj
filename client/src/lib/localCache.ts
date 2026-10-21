// The Android app keeps the last chats on the phone, like other messengers:
// it opens straight onto them (even offline) and the server's copy replaces
// them as soon as it arrives. Browsers keep nothing, as a shared computer
// shouldn't hold someone's messages. Logging out (or the session ending)
// wipes it.
import { inApp } from './native';
import type { Conversation, DmMessage, Invite, Paged, RoomDetail, RoomMessage, RoomSummary, User } from './types';

const USER = 'adda-cache-user';
const CHATS = 'adda-cache-chats:';
/** Messages kept per chat, for the most recently active chats. */
const KEEP_MESSAGES = 40;
const KEEP_THREADS = 25;

export type ChatSnapshot = {
  conversations: Record<string, Conversation>;
  rooms: Record<string, RoomSummary>;
  invites: Invite[];
  users: Record<string, User>;
  dms: Record<string, Paged<DmMessage>>;
  roomMessages: Record<string, Paged<RoomMessage>>;
  roomDetails: Record<string, RoomDetail>;
};

function read<T>(key: string): T | null {
  if (!inApp) return null;
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  if (!inApp) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or unavailable: the app just starts from the server next time.
  }
}

export const cachedUser = () => read<User>(USER);
export const saveUser = (user: User) => write(USER, user);

/** The cached chats of this account; their message pages are marked stale until reloaded. */
export function cachedChats(userId: string): ChatSnapshot | null {
  const snap = read<ChatSnapshot & { v: number }>(CHATS + userId);
  if (!snap || snap.v !== 1) return null;
  const stale = <T,>(pages: Record<string, Paged<T>>) =>
    Object.fromEntries(Object.entries(pages ?? {}).map(([id, p]) => [id, { ...p, loadingMore: false, stale: true }]));
  return { ...snap, dms: stale(snap.dms), roomMessages: stale(snap.roomMessages) };
}

/** Keeps the latest messages of the most recently active chats (nothing still sending). */
function trim<T extends { id: number; pending?: string }>(pages: Record<string, Paged<T>>, order: string[]) {
  const out: Record<string, Paged<T>> = {};
  for (const id of order) {
    const p = pages[id];
    if (!p?.loaded) continue;
    const sent = p.items.filter((m) => !m.pending && m.id > 0);
    const items = sent.slice(-KEEP_MESSAGES).map((m) => {
      const { draft: _draft, upload: _upload, ...rest } = m as T & { draft?: unknown; upload?: unknown };
      return rest as T;
    });
    out[id] = { items, loaded: true, hasMore: p.hasMore || sent.length > items.length };
    if (Object.keys(out).length >= KEEP_THREADS) break;
  }
  return out;
}

export function saveChats(userId: string, s: ChatSnapshot) {
  if (!inApp) return;
  const latest = <V,>(record: Record<string, V>, at: (v: V) => string | undefined) =>
    Object.entries(record)
      .sort(([, a], [, b]) => (at(b) ?? '').localeCompare(at(a) ?? ''))
      .map(([id]) => id);
  const dmOrder = latest(s.conversations, (c) => c.lastMessage?.createdAt);
  const roomOrder = latest(s.rooms, (r) => r.lastMessage?.createdAt ?? r.createdAt);
  const people = new Set(Object.keys(s.conversations));
  write(CHATS + userId, {
    v: 1,
    conversations: s.conversations,
    rooms: s.rooms,
    invites: s.invites,
    users: Object.fromEntries(Object.entries(s.users).filter(([id]) => people.has(id))),
    dms: trim(s.dms, dmOrder),
    roomMessages: trim(s.roomMessages, roomOrder),
    roomDetails: Object.fromEntries(roomOrder.slice(0, KEEP_THREADS).filter((id) => s.roomDetails[id]).map((id) => [id, s.roomDetails[id]])),
  });
}

/** Signed out: nothing of theirs stays on the phone. */
export function forgetCache() {
  try {
    for (const key of Object.keys(localStorage)) if (key === USER || key.startsWith(CHATS)) localStorage.removeItem(key);
  } catch {
    // Storage unavailable: there's nothing kept either.
  }
}
