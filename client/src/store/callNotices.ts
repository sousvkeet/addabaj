import { create } from 'zustand';
import { messagePreview } from '../lib/format';
import { haptic } from '../lib/native';
import type { DmMessage, RoomMessage, User } from '../lib/types';
import { myId } from './auth';
import { isForMe, isMuted, useChat } from './chat';
import { useVoice } from './voice';

/** A message that arrived while a call's window covered the app (one per chat: its latest). */
export type CallNotice = {
  /** "dm:<partner id>" or "room:<room id>". */
  key: string;
  scope: 'dm' | 'room';
  chatId: string;
  sender: { name: string; hue: number; photo?: string | null };
  /** The room's name, for a room's message. */
  room?: string;
  text: string;
  /** How many came from the chat while it showed. */
  count: number;
};

type CallNoticesState = {
  notices: CallNotice[];
  /** A call's video window covers the app (components/CallNotices.tsx keeps this up to date). */
  windowOpen: boolean;
  dismiss: (key: string) => void;
  clear: () => void;
};

/** How long each shows; a new message from the same chat starts it again. */
const SHOW_MS = 6000;
/** The most that show at once, newest on top. */
const MOST = 3;
const timers = new Map<string, number>();

export const useCallNotices = create<CallNoticesState>()((set) => ({
  notices: [],
  windowOpen: false,
  dismiss: (key) => {
    window.clearTimeout(timers.get(key));
    timers.delete(key);
    set((s) => ({ notices: s.notices.filter((n) => n.key !== key) }));
  },
  clear: () => {
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
    set({ notices: [] });
  },
}));

/** Only while a call's window covers the app, on screen (out of sight, the phone's notifications are there). */
const showing = () => useCallNotices.getState().windowOpen && document.visibilityState === 'visible';

function add(notice: Omit<CallNotice, 'key' | 'count'>) {
  const key = `${notice.scope}:${notice.chatId}`;
  useCallNotices.setState((s) => {
    const before = s.notices.find((n) => n.key === key);
    return { notices: [{ ...notice, key, count: (before?.count ?? 0) + 1 }, ...s.notices.filter((n) => n.key !== key)].slice(0, MOST) };
  });
  haptic('tick');
  window.clearTimeout(timers.get(key));
  timers.set(
    key,
    window.setTimeout(() => useCallNotices.getState().dismiss(key), SHOW_MS),
  );
}

/** A chat message from someone else (not in a chat I muted). */
export function noticeDm(message: DmMessage, partner: User) {
  if (!showing() || message.kind !== 'text' || message.senderId === myId() || message.senderId !== partner.id) return;
  const conversation = useChat.getState().conversations[partner.id];
  if (conversation && isMuted(conversation)) return;
  add({ scope: 'dm', chatId: partner.id, sender: partner, text: messagePreview(message) });
}

/**
 * A room message from someone else. The call's own room always shows (its
 * chat is part of the call); a room I muted only for what's for me.
 */
export function noticeRoom(message: RoomMessage) {
  const me = myId();
  if (!showing() || message.kind !== 'text' || !message.sender || message.sender.id === me) return;
  const chat = useChat.getState();
  if (chat.users[message.sender.id]?.blocked) return;
  const room = chat.rooms[message.roomId];
  const callRoom = useVoice.getState().roomId === message.roomId;
  if (!callRoom && room && isMuted(room) && !isForMe(message, me)) return;
  add({ scope: 'room', chatId: message.roomId, sender: message.sender, room: room?.name ?? 'A room', text: messagePreview(message) });
}
