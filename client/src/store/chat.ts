import { create } from 'zustand';
import { api, errorMessage } from '../lib/api';
import { emitAck, socket } from '../lib/socket';
import type {
  Attachment, Conversation, DmMessage, Draft, Invite, Paged, PreparedFile, Reaction, ReplyRef, Role, RoomDetail, RoomMessage, RoomSummary, User, VoiceParticipant,
} from '../lib/types';
import { uploadFile } from '../lib/upload';
import { nativeClearChat } from '../lib/native';
import { cachedChats, saveChats } from '../lib/localCache';
import { myId, onLogout, useAuth } from './auth';
import { toast } from './ui';

type Typing = Record<string, string>; // userId -> display name

type ChatState = {
  bootstrapped: boolean;
  online: Record<string, boolean>;
  lastSeen: Record<string, string | null>;
  /** People whose online status and last seen aren't shared with me (live updates). */
  hiddenPresence: Record<string, boolean>;
  users: Record<string, User>;
  conversations: Record<string, Conversation>;
  dms: Record<string, Paged<DmMessage>>;
  dmTyping: Record<string, boolean>;
  rooms: Record<string, RoomSummary>;
  roomDetails: Record<string, RoomDetail>;
  roomMessages: Record<string, Paged<RoomMessage>>;
  roomTyping: Record<string, Typing>;
  invites: Invite[];
  voice: Record<string, VoiceParticipant[]>;
  activeDm: string | null;
  activeRoom: string | null;

  sync: () => Promise<void>;
  rememberUser: (user: User) => void;
  /** Someone changed their photo (or other details): show it everywhere they appear. */
  applyUser: (user: Pick<User, 'id'> & Partial<User>) => void;

  openDm: (partnerId: string | null) => void;
  loadDm: (partnerId: string, older?: boolean) => Promise<void>;
  sendDm: (partnerId: string, draft: Draft, retryOf?: string) => Promise<void>;
  receiveDm: (message: DmMessage, partner: User) => void;
  markDmRead: (partnerId: string) => void;
  applyDmRead: (e: { readerId: string; partnerId: string; readAt: string }) => void;
  applyDmDelivered: (e: { partnerId: string; ids: number[]; deliveredAt: string }) => void;
  applyRoomReceipts: (e: { roomId: string; members: { userId: string; lastReadId: number; lastDeliveredId: number }[] }) => void;
  setDmTyping: (from: string, typing: boolean) => void;

  openRoom: (roomId: string | null) => void;
  loadRoom: (roomId: string) => Promise<void>;
  loadRoomMessages: (roomId: string, older?: boolean) => Promise<void>;
  sendRoomMessage: (roomId: string, draft: Draft, retryOf?: string) => Promise<void>;
  react: (scope: 'dm' | 'room', messageId: number, emoji: string) => Promise<void>;
  applyReactions: (e: { scope: 'dm' | 'room'; messageId: number; reactions: Reaction[]; between?: string[]; roomId?: string }) => void;
  /** Delete a message for me, or (my own; any, for room admins) for everyone. `chatId`: the partner or room. */
  deleteMessage: (scope: 'dm' | 'room', chatId: string, messageId: number, forEveryone: boolean) => Promise<boolean>;
  applyDeleted: (e: { scope: 'dm' | 'room'; messageId: number; deletedAt: string; between?: string[]; roomId?: string; byAdmin?: boolean }) => void;
  applyHidden: (e: { scope: 'dm' | 'room'; messageId: number; chatId: string }) => void;
  receiveRoomMessage: (message: RoomMessage) => void;
  markRoomRead: (roomId: string) => void;
  setRoomTyping: (e: { roomId: string; userId: string; name: string; typing: boolean }) => void;
  upsertRoom: (room: RoomSummary | RoomDetail) => void;
  dropRoom: (roomId: string) => void;

  createRoom: (input: { name: string; description: string; maxMembers: number; password?: string }) => Promise<RoomDetail>;
  joinRoom: (code: string, password?: string) => Promise<RoomDetail>;
  setRoomPassword: (roomId: string, password: string | null) => Promise<void>;
  renewRoomCode: (roomId: string) => Promise<void>;
  updateRoom: (roomId: string, input: Partial<{ name: string; description: string; maxMembers: number }>) => Promise<void>;
  deleteRoom: (roomId: string) => Promise<void>;
  addMember: (roomId: string, userId: string) => Promise<void>;
  inviteMember: (roomId: string, userId: string) => Promise<void>;
  cancelInvite: (roomId: string, inviteId: string) => Promise<void>;
  removeMember: (roomId: string, userId: string) => Promise<void>;
  setRole: (roomId: string, userId: string, role: Role) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;

  acceptInvite: (inviteId: string) => Promise<RoomDetail>;
  declineInvite: (inviteId: string) => Promise<void>;

  setVoice: (roomId: string, participants: VoiceParticipant[]) => void;
};

const emptyPage = <T,>(): Paged<T> => ({ items: [], loaded: false, hasMore: false });

let tempCounter = 0;
const tempId = () => `tmp-${Date.now()}-${++tempCounter}`;

/** Merge server messages into a list, replacing optimistic copies and keeping id order. */
function merge<T extends { id: number; tempId?: string; pending?: string }>(items: T[], incoming: T[], replaceTemp?: string) {
  // Optimistic messages all have id 0, so they're keyed by their temp id.
  const byKey = new Map<string | number, T>();
  for (const m of items) if (!m.tempId || m.tempId !== replaceTemp) byKey.set(m.tempId ?? m.id, m);
  for (const m of incoming) byKey.set(m.id, m);
  const all = [...byKey.values()];
  const sent = all.filter((m) => !m.pending).sort((a, b) => a.id - b.id);
  const pending = all.filter((m) => m.pending);
  return [...sent, ...pending];
}

const typingTimers = new Map<string, number>();

/** A message written offline waits (with its clock) this long for the connection to come back. */
const OUTBOX_WAIT_MS = 2 * 60_000;

/** How a file being sent looks in the chat before the server has it: its local preview. */
const localAttachment = (file: PreparedFile): Attachment => ({
  id: 'local',
  kind: file.meta.kind,
  name: file.meta.name,
  mime: file.meta.mime,
  size: file.blob.size,
  width: file.meta.width ?? null,
  height: file.meta.height ?? null,
  duration: file.meta.duration ?? null,
  waveform: file.meta.waveform ?? null,
  url: file.previewUrl ?? '',
});

/** Uploads a draft's file once (a retry reuses it), reporting progress. */
async function uploadOnce(draft: Draft, onProgress: (percent: number) => void) {
  if (!draft.file) return undefined;
  if (!draft.file.uploaded) {
    let last = -10;
    draft.file.uploaded = await uploadFile(draft.file, (p) => {
      if (p - last >= 3 || p === 100) onProgress((last = p));
    });
  }
  return draft.file.uploaded;
}

/** A file the server no longer has waiting (expired, or the send got through after all) is uploaded again on retry. */
const forgetUpload = (draft: Draft, err: unknown) => {
  if (draft.file?.uploaded && /already sent or has expired/.test(errorMessage(err))) draft.file.uploaded = undefined;
};

/** The local preview isn't needed once the sent message shows the server's copy. */
const releasePreview = (draft: Draft) => {
  const url = draft.file?.previewUrl;
  if (url) window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
};
const visible = () => document.visibilityState === 'visible';

const initial = {
  bootstrapped: false,
  online: {},
  lastSeen: {},
  hiddenPresence: {},
  users: {},
  conversations: {},
  dms: {},
  dmTyping: {},
  rooms: {},
  roomDetails: {},
  roomMessages: {},
  roomTyping: {},
  invites: [],
  voice: {},
  activeDm: null,
  activeRoom: null,
};

export const useChat = create<ChatState>()((set, get) => ({
  ...initial,

  sync: async () => {
    try {
      const [{ conversations }, { rooms }, { invites }] = await Promise.all([
        api<{ conversations: Conversation[] }>('/dms'),
        api<{ rooms: RoomSummary[] }>('/rooms'),
        api<{ invites: Invite[] }>('/invites'),
      ]);
      // Whatever happened while this device was away (messages deleted for
      // everyone, reactions, edits) shows when each chat is next opened: the
      // open one reloads right below.
      const outdated = <T,>(pages: Record<string, Paged<T>>, open: string | null) =>
        Object.fromEntries(Object.entries(pages).map(([id, p]) => [id, id === open || !p.loaded ? p : { ...p, stale: true }]));
      set((s) => ({
        bootstrapped: true,
        conversations: Object.fromEntries(conversations.map((c) => [c.partner.id, c])),
        rooms: Object.fromEntries(rooms.map((r) => [r.id, r])),
        invites,
        users: { ...s.users, ...Object.fromEntries(conversations.map((c) => [c.partner.id, c.partner])) },
        dms: outdated(s.dms, s.activeDm),
        roomMessages: outdated(s.roomMessages, s.activeRoom),
      }));
      // Catch up on whatever was open while we were disconnected.
      const { activeDm, activeRoom } = get();
      if (activeDm) {
        await get().loadDm(activeDm);
        get().markDmRead(activeDm);
      }
      if (activeRoom && get().rooms[activeRoom]) {
        await Promise.all([get().loadRoom(activeRoom), get().loadRoomMessages(activeRoom)]);
        get().markRoomRead(activeRoom);
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  },

  rememberUser: (user) => set((s) => ({ users: { ...s.users, [user.id]: { ...s.users[user.id], ...user } } })),

  applyUser: (user) =>
    set((s) => {
      const id = user.id;
      const conversation = s.conversations[id];
      const touches = (members: { id: string }[]) => members.some((m) => m.id === id);
      return {
        users: s.users[id] ? { ...s.users, [id]: { ...s.users[id], ...user } } : s.users,
        conversations: conversation ? { ...s.conversations, [id]: { ...conversation, partner: { ...conversation.partner, ...user } } } : s.conversations,
        roomDetails: Object.fromEntries(
          Object.entries(s.roomDetails).map(([roomId, d]) => [
            roomId,
            touches(d.members) || d.invites?.some((i) => i.invitee.id === id)
              ? {
                  ...d,
                  members: d.members.map((m) => (m.id === id ? { ...m, ...user } : m)),
                  invites: d.invites?.map((i) => (i.invitee.id === id ? { ...i, invitee: { ...i.invitee, ...user } } : i)),
                }
              : d,
          ]),
        ),
        roomMessages: Object.fromEntries(
          Object.entries(s.roomMessages).map(([roomId, page]) => [
            roomId,
            page.items.some((m) => m.sender?.id === id)
              ? { ...page, items: page.items.map((m) => (m.sender?.id === id ? { ...m, sender: { ...m.sender, ...('photo' in user ? { photo: user.photo } : {}) } } : m)) }
              : page,
          ]),
        ),
        invites: s.invites.some((i) => i.inviter.id === id) ? s.invites.map((i) => (i.inviter.id === id ? { ...i, inviter: { ...i.inviter, ...user } } : i)) : s.invites,
      };
    }),

  // ── Direct messages ──────────────────────────────────────────────

  openDm: (partnerId) => {
    set({ activeDm: partnerId });
    if (!partnerId) return;
    const { dms, users } = get();
    if (!users[partnerId]) {
      api<{ user: User }>(`/users/${partnerId}`)
        .then(({ user }) => get().rememberUser(user))
        .catch(() => {});
    }
    if (!dms[partnerId]?.loaded || dms[partnerId].stale) void get().loadDm(partnerId).then(() => get().markDmRead(partnerId));
    else get().markDmRead(partnerId);
  },

  loadDm: async (partnerId, older = false) => {
    const page = get().dms[partnerId] ?? emptyPage<DmMessage>();
    if (older && (!page.hasMore || page.loadingMore)) return;
    const firstId = page.items.find((m) => !m.pending)?.id;
    if (older) set((s) => ({ dms: { ...s.dms, [partnerId]: { ...page, loadingMore: true } } }));
    try {
      const q = older && firstId ? `?before=${firstId}` : '';
      const { messages, hasMore } = await api<{ messages: DmMessage[]; hasMore: boolean }>(`/dms/${partnerId}/messages${q}`);
      set((s) => {
        const cur = s.dms[partnerId] ?? emptyPage<DmMessage>();
        // A copy kept from last time gives way to the server's (only messages still sending stay).
        const fresh = cur.stale && !older;
        return {
          dms: {
            ...s.dms,
            [partnerId]: {
              items: merge(fresh ? cur.items.filter((m) => m.pending) : cur.items, messages),
              loaded: true,
              hasMore: older || fresh ? hasMore : cur.loaded ? cur.hasMore || hasMore : hasMore,
              loadingMore: false,
              stale: fresh ? false : cur.stale,
            },
          },
        };
      });
    } catch (err) {
      set((s) => ({ dms: { ...s.dms, [partnerId]: { ...(s.dms[partnerId] ?? emptyPage()), loadingMore: false } } }));
      // Offline with last time's copy on screen: no need to say so (the header says "Connecting…").
      if (socket.connected || !page.items.length) toast(errorMessage(err), 'error');
    }
  },

  sendDm: async (partnerId, draft, retryOf) => {
    const me = myId();
    const tid = tempId();
    const temp: DmMessage = {
      id: 0, tempId: tid, senderId: me, recipientId: partnerId, kind: 'text', body: draft.body, meta: null,
      createdAt: new Date().toISOString(), deliveredAt: null, readAt: null, pending: 'sending', draft,
      attachment: draft.file ? localAttachment(draft.file) : null,
      replyTo: draft.replyTo ?? null,
      reactions: [],
      upload: draft.file && !draft.file.uploaded ? 0 : undefined,
    };
    set((s) => {
      const page = s.dms[partnerId] ?? { ...emptyPage<DmMessage>(), loaded: true };
      const items = retryOf ? page.items.filter((m) => m.tempId !== retryOf) : page.items;
      return { dms: { ...s.dms, [partnerId]: { ...page, items: [...items, temp] } } };
    });
    const patch = (fn: (m: DmMessage) => DmMessage) =>
      set((s) => {
        const page = s.dms[partnerId];
        return page ? { dms: { ...s.dms, [partnerId]: { ...page, items: page.items.map((m) => (m.tempId === tid ? fn(m) : m)) } } } : s;
      });
    try {
      const attachment = await uploadOnce(draft, (upload) => patch((m) => ({ ...m, upload })));
      const { message } = await emitAck<{ message: DmMessage }>(
        'dm:send',
        { to: partnerId, body: draft.body, attachmentId: attachment?.id, replyTo: draft.replyTo?.id },
        10_000,
        { waitOnline: OUTBOX_WAIT_MS },
      );
      releasePreview(draft);
      const partner = get().users[partnerId] ?? get().conversations[partnerId]?.partner;
      set((s) => {
        const page = s.dms[partnerId] ?? emptyPage<DmMessage>();
        return {
          dms: { ...s.dms, [partnerId]: { ...page, items: merge(page.items, [message], tid) } },
          conversations: partner
            ? { ...s.conversations, [partnerId]: { partner, lastMessage: message, unread: s.conversations[partnerId]?.unread ?? 0 } }
            : s.conversations,
        };
      });
    } catch (err) {
      set((s) => {
        const page = s.dms[partnerId];
        if (!page) return s;
        return {
          dms: { ...s.dms, [partnerId]: { ...page, items: page.items.map((m) => (m.tempId === tid ? { ...m, pending: 'failed' as const } : m)) } },
        };
      });
      forgetUpload(draft, err);
      toast(errorMessage(err), 'error');
    }
  },

  receiveDm: (message, partner) => {
    const me = myId();
    const incoming = message.senderId !== me;
    set((s) => {
      const page = s.dms[partner.id];
      const isOpen = s.activeDm === partner.id && visible();
      const prev = s.conversations[partner.id];
      return {
        users: { ...s.users, [partner.id]: { ...s.users[partner.id], ...partner } },
        dms: page ? { ...s.dms, [partner.id]: { ...page, items: merge(page.items, [message]) } } : s.dms,
        dmTyping: incoming ? { ...s.dmTyping, [partner.id]: false } : s.dmTyping,
        conversations: {
          ...s.conversations,
          [partner.id]: {
            partner: { ...prev?.partner, ...partner },
            lastMessage: message,
            unread: (prev?.unread ?? 0) + (incoming && !isOpen && message.kind === 'text' ? 1 : 0),
          },
        },
      };
    });
    if (incoming && get().activeDm === partner.id && visible()) get().markDmRead(partner.id);
  },

  markDmRead: (partnerId) => {
    nativeClearChat('dm', partnerId);
    const { conversations, dms } = get();
    const me = myId();
    const hasUnread =
      (conversations[partnerId]?.unread ?? 0) > 0 ||
      dms[partnerId]?.items.some((m) => m.senderId === partnerId && m.recipientId === me && !m.readAt);
    if (!hasUnread) return;
    set((s) => ({
      conversations: s.conversations[partnerId]
        ? { ...s.conversations, [partnerId]: { ...s.conversations[partnerId], unread: 0 } }
        : s.conversations,
    }));
    socket.emit('dm:read', { partnerId });
  },

  applyDmRead: ({ readerId, partnerId, readAt }) => {
    const me = myId();
    if (readerId === me) {
      // Read on another of my tabs.
      set((s) => ({
        conversations: s.conversations[partnerId]
          ? { ...s.conversations, [partnerId]: { ...s.conversations[partnerId], unread: 0 } }
          : s.conversations,
      }));
      return;
    }
    // The other person read my messages.
    set((s) => {
      const page = s.dms[readerId];
      const conv = s.conversations[readerId];
      const stamp = (m: DmMessage) =>
        m.senderId === me && !m.readAt && !m.pending ? { ...m, readAt, deliveredAt: m.deliveredAt ?? readAt } : m;
      return {
        dms: page ? { ...s.dms, [readerId]: { ...page, items: page.items.map(stamp) } } : s.dms,
        conversations: conv?.lastMessage
          ? { ...s.conversations, [readerId]: { ...conv, lastMessage: stamp(conv.lastMessage) } }
          : s.conversations,
      };
    });
  },

  // The other person's app now has these messages of mine.
  applyDmDelivered: ({ partnerId, ids, deliveredAt }) => {
    const done = new Set(ids);
    const stamp = (m: DmMessage) => (done.has(m.id) && !m.deliveredAt ? { ...m, deliveredAt } : m);
    set((s) => {
      const page = s.dms[partnerId];
      const conv = s.conversations[partnerId];
      return {
        dms: page ? { ...s.dms, [partnerId]: { ...page, items: page.items.map(stamp) } } : s.dms,
        conversations: conv?.lastMessage
          ? { ...s.conversations, [partnerId]: { ...conv, lastMessage: stamp(conv.lastMessage) } }
          : s.conversations,
      };
    });
  },

  // Room members' apps received / showed messages up to new points.
  applyRoomReceipts: ({ roomId, members }) => {
    set((s) => {
      const detail = s.roomDetails[roomId];
      if (!detail) return s;
      const by = new Map(members.map((m) => [m.userId, m]));
      return {
        roomDetails: {
          ...s.roomDetails,
          [roomId]: {
            ...detail,
            members: detail.members.map((m) => {
              const r = by.get(m.id);
              return r ? { ...m, lastReadId: Math.max(m.lastReadId, r.lastReadId), lastDeliveredId: Math.max(m.lastDeliveredId, r.lastDeliveredId) } : m;
            }),
          },
        },
      };
    });
  },

  setDmTyping: (from, typing) => {
    window.clearTimeout(typingTimers.get(`dm:${from}`));
    set((s) => ({ dmTyping: { ...s.dmTyping, [from]: typing } }));
    if (typing) {
      typingTimers.set(`dm:${from}`, window.setTimeout(() => get().setDmTyping(from, false), 5000));
    }
  },

  // ── Rooms ────────────────────────────────────────────────────────

  openRoom: (roomId) => {
    set({ activeRoom: roomId });
    if (!roomId) return;
    void get().loadRoom(roomId);
    const page = get().roomMessages[roomId];
    if (!page?.loaded || page.stale) void get().loadRoomMessages(roomId).then(() => get().markRoomRead(roomId));
    else get().markRoomRead(roomId);
  },

  loadRoom: async (roomId) => {
    try {
      const { room } = await api<{ room: RoomDetail }>(`/rooms/${roomId}`);
      get().upsertRoom(room);
    } catch (err) {
      if ((err as { status?: number }).status === 404 || (err as { status?: number }).status === 403) get().dropRoom(roomId);
      else if (socket.connected || !get().roomDetails[roomId]) toast(errorMessage(err), 'error');
    }
  },

  loadRoomMessages: async (roomId, older = false) => {
    const page = get().roomMessages[roomId] ?? emptyPage<RoomMessage>();
    if (older && (!page.hasMore || page.loadingMore)) return;
    const firstId = page.items.find((m) => !m.pending)?.id;
    if (older) set((s) => ({ roomMessages: { ...s.roomMessages, [roomId]: { ...page, loadingMore: true } } }));
    try {
      const q = older && firstId ? `?before=${firstId}` : '';
      const { messages, hasMore } = await api<{ messages: RoomMessage[]; hasMore: boolean }>(`/rooms/${roomId}/messages${q}`);
      set((s) => {
        const cur = s.roomMessages[roomId] ?? emptyPage<RoomMessage>();
        const fresh = cur.stale && !older;
        return {
          roomMessages: {
            ...s.roomMessages,
            [roomId]: {
              items: merge(fresh ? cur.items.filter((m) => m.pending) : cur.items, messages),
              loaded: true,
              hasMore: older || fresh ? hasMore : cur.loaded ? cur.hasMore || hasMore : hasMore,
              loadingMore: false,
              stale: fresh ? false : cur.stale,
            },
          },
        };
      });
    } catch (err) {
      set((s) => ({ roomMessages: { ...s.roomMessages, [roomId]: { ...(s.roomMessages[roomId] ?? emptyPage()), loadingMore: false } } }));
      if ((err as { status?: number }).status !== 404 && (socket.connected || !page.items.length)) toast(errorMessage(err), 'error');
    }
  },

  sendRoomMessage: async (roomId, draft, retryOf) => {
    const me = meAsSender();
    const tid = tempId();
    const temp: RoomMessage = {
      id: 0, tempId: tid, roomId, kind: 'text', body: draft.body, createdAt: new Date().toISOString(),
      sender: me, pending: 'sending', draft,
      attachment: draft.file ? localAttachment(draft.file) : null,
      replyTo: draft.replyTo ?? null,
      reactions: [],
      upload: draft.file && !draft.file.uploaded ? 0 : undefined,
    };
    set((s) => {
      const page = s.roomMessages[roomId] ?? { ...emptyPage<RoomMessage>(), loaded: true };
      const items = retryOf ? page.items.filter((m) => m.tempId !== retryOf) : page.items;
      return { roomMessages: { ...s.roomMessages, [roomId]: { ...page, items: [...items, temp] } } };
    });
    const patch = (fn: (m: RoomMessage) => RoomMessage) =>
      set((s) => {
        const page = s.roomMessages[roomId];
        return page
          ? { roomMessages: { ...s.roomMessages, [roomId]: { ...page, items: page.items.map((m) => (m.tempId === tid ? fn(m) : m)) } } }
          : s;
      });
    try {
      const attachment = await uploadOnce(draft, (upload) => patch((m) => ({ ...m, upload })));
      const { message } = await emitAck<{ message: RoomMessage }>(
        'room:send',
        { roomId, body: draft.body, attachmentId: attachment?.id, replyTo: draft.replyTo?.id },
        10_000,
        { waitOnline: OUTBOX_WAIT_MS },
      );
      releasePreview(draft);
      set((s) => {
        const page = s.roomMessages[roomId] ?? emptyPage<RoomMessage>();
        const room = s.rooms[roomId];
        return {
          roomMessages: { ...s.roomMessages, [roomId]: { ...page, items: merge(page.items, [message], tid) } },
          rooms: room ? { ...s.rooms, [roomId]: { ...room, lastMessage: message, unread: 0 } } : s.rooms,
        };
      });
    } catch (err) {
      set((s) => {
        const page = s.roomMessages[roomId];
        if (!page) return s;
        return {
          roomMessages: {
            ...s.roomMessages,
            [roomId]: { ...page, items: page.items.map((m) => (m.tempId === tid ? { ...m, pending: 'failed' as const } : m)) },
          },
        };
      });
      forgetUpload(draft, err);
      toast(errorMessage(err), 'error');
    }
  },

  receiveRoomMessage: (message) => {
    const { roomId } = message;
    const me = myId();
    set((s) => {
      const room = s.rooms[roomId];
      const page = s.roomMessages[roomId];
      const isOpen = s.activeRoom === roomId && visible();
      const fromOther = message.kind === 'text' && message.sender?.id !== me;
      const typing = { ...(s.roomTyping[roomId] ?? {}) };
      if (message.sender) delete typing[message.sender.id];
      return {
        roomMessages: page ? { ...s.roomMessages, [roomId]: { ...page, items: merge(page.items, [message]) } } : s.roomMessages,
        roomTyping: { ...s.roomTyping, [roomId]: typing },
        rooms: room
          ? { ...s.rooms, [roomId]: { ...room, lastMessage: message, unread: room.unread + (fromOther && !isOpen ? 1 : 0) } }
          : s.rooms,
      };
    });
    if (get().activeRoom === roomId && visible()) get().markRoomRead(roomId);
  },

  markRoomRead: (roomId) => {
    nativeClearChat('room', roomId);
    const page = get().roomMessages[roomId];
    const last = page?.items.filter((m) => !m.pending).at(-1);
    set((s) => (s.rooms[roomId]?.unread ? { rooms: { ...s.rooms, [roomId]: { ...s.rooms[roomId], unread: 0 } } } : s));
    if (last) socket.emit('room:read', { roomId, messageId: last.id });
  },

  setRoomTyping: ({ roomId, userId, name, typing }) => {
    const key = `room:${roomId}:${userId}`;
    window.clearTimeout(typingTimers.get(key));
    set((s) => {
      const cur = { ...(s.roomTyping[roomId] ?? {}) };
      if (typing) cur[userId] = name;
      else delete cur[userId];
      return { roomTyping: { ...s.roomTyping, [roomId]: cur } };
    });
    if (typing) {
      typingTimers.set(key, window.setTimeout(() => get().setRoomTyping({ roomId, userId, name, typing: false }), 5000));
    }
  },

  upsertRoom: (room) =>
    set((s) => {
      const { members, invites, voice, ...summary } = room as RoomDetail;
      const next: Partial<ChatState> = {
        rooms: { ...s.rooms, [room.id]: { ...s.rooms[room.id], ...summary, unread: s.activeRoom === room.id ? 0 : summary.unread } },
      };
      if (members) {
        next.roomDetails = { ...s.roomDetails, [room.id]: room as RoomDetail };
        next.users = { ...s.users, ...Object.fromEntries(members.map((m) => [m.id, { ...s.users[m.id], ...m }])) };
        next.voice = { ...s.voice, [room.id]: voice ?? [] };
      }
      return next;
    }),

  dropRoom: (roomId) =>
    set((s) => {
      const rooms = { ...s.rooms };
      const roomDetails = { ...s.roomDetails };
      const roomMessages = { ...s.roomMessages };
      delete rooms[roomId];
      delete roomDetails[roomId];
      delete roomMessages[roomId];
      return { rooms, roomDetails, roomMessages };
    }),

  createRoom: async (input) => {
    const { room } = await api<{ room: RoomDetail }>('/rooms', { method: 'POST', body: input });
    get().upsertRoom(room);
    return room;
  },

  joinRoom: async (code, password) => {
    const { room } = await api<{ room: RoomDetail }>('/rooms/join', { method: 'POST', body: { code, password } });
    get().upsertRoom(room);
    return room;
  },

  setRoomPassword: async (roomId, password) => {
    const { room } = await api<{ room: RoomDetail }>(`/rooms/${roomId}/access`, { method: 'PATCH', body: { password } });
    get().upsertRoom(room);
  },

  renewRoomCode: async (roomId) => {
    const { room } = await api<{ room: RoomDetail }>(`/rooms/${roomId}/code`, { method: 'POST' });
    get().upsertRoom(room);
  },

  updateRoom: async (roomId, input) => {
    const { room } = await api<{ room: RoomDetail }>(`/rooms/${roomId}`, { method: 'PATCH', body: input });
    get().upsertRoom(room);
  },

  deleteRoom: async (roomId) => {
    await api(`/rooms/${roomId}`, { method: 'DELETE' });
    get().dropRoom(roomId);
  },

  addMember: async (roomId, userId) => {
    const { room } = await api<{ room: RoomDetail }>(`/rooms/${roomId}/members`, { method: 'POST', body: { userId } });
    get().upsertRoom(room);
  },

  inviteMember: async (roomId, userId) => {
    const { room } = await api<{ room: RoomDetail }>(`/rooms/${roomId}/invites`, { method: 'POST', body: { userId } });
    get().upsertRoom(room);
  },

  cancelInvite: async (roomId, inviteId) => {
    await api(`/rooms/${roomId}/invites/${inviteId}`, { method: 'DELETE' });
    await get().loadRoom(roomId);
  },

  removeMember: async (roomId, userId) => {
    await api(`/rooms/${roomId}/members/${userId}`, { method: 'DELETE' });
    await get().loadRoom(roomId);
  },

  setRole: async (roomId, userId, role) => {
    const { room } = await api<{ room: RoomDetail }>(`/rooms/${roomId}/members/${userId}`, { method: 'PATCH', body: { role } });
    get().upsertRoom(room);
  },

  leaveRoom: async (roomId) => {
    await api(`/rooms/${roomId}/members/${myId()}`, { method: 'DELETE' });
    get().dropRoom(roomId);
  },

  // ── Invites ──────────────────────────────────────────────────────

  acceptInvite: async (inviteId) => {
    const { room } = await api<{ room: RoomDetail }>(`/invites/${inviteId}/accept`, { method: 'POST' });
    set((s) => ({ invites: s.invites.filter((i) => i.id !== inviteId) }));
    get().upsertRoom(room);
    return room;
  },

  declineInvite: async (inviteId) => {
    await api(`/invites/${inviteId}/decline`, { method: 'POST' });
    set((s) => ({ invites: s.invites.filter((i) => i.id !== inviteId) }));
  },

  setVoice: (roomId, participants) => set((s) => ({ voice: { ...s.voice, [roomId]: participants } })),

  react: async (scope, messageId, emoji) => {
    try {
      await emitAck('msg:react', { scope, messageId, emoji });
      // The server tells everyone (including this tab) via 'msg:reactions'.
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  },

  deleteMessage: async (scope, chatId, messageId, forEveryone) => {
    try {
      const res = await emitAck<{ deletedAt?: string; hidden?: boolean; byAdmin?: boolean }>('msg:delete', { scope, messageId, forEveryone });
      // Shown here at once; the server also tells my other tabs and devices (and, for everyone, the others).
      if (res.hidden) get().applyHidden({ scope, messageId, chatId });
      else if (res.deletedAt) {
        get().applyDeleted({ scope, messageId, deletedAt: res.deletedAt, byAdmin: res.byAdmin, ...(scope === 'dm' ? { between: [myId(), chatId] } : { roomId: chatId }) });
      }
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  },

  applyDeleted: ({ scope, messageId, deletedAt, between, roomId, byAdmin }) => {
    if (scope === 'dm') {
      const me = myId();
      const partner = between?.find((id) => id !== me) ?? me;
      const fields = { deletedAt, meta: null } as Partial<DmMessage>;
      set((s) => {
        const conv = s.conversations[partner];
        return {
          dms: s.dms[partner] ? { ...s.dms, [partner]: { ...s.dms[partner], items: erased(s.dms[partner].items, messageId, fields) } } : s.dms,
          conversations:
            conv?.lastMessage?.id === messageId
              ? { ...s.conversations, [partner]: { ...conv, lastMessage: erased([conv.lastMessage], messageId, fields)[0] } }
              : s.conversations,
        };
      });
    } else if (roomId) {
      const fields = { deletedAt, deletedByAdmin: !!byAdmin } as Partial<RoomMessage>;
      set((s) => {
        const room = s.rooms[roomId];
        return {
          roomMessages: s.roomMessages[roomId]
            ? { ...s.roomMessages, [roomId]: { ...s.roomMessages[roomId], items: erased(s.roomMessages[roomId].items, messageId, fields) } }
            : s.roomMessages,
          rooms:
            room?.lastMessage?.id === messageId
              ? { ...s.rooms, [roomId]: { ...room, lastMessage: erased([room.lastMessage], messageId, fields)[0] } }
              : s.rooms,
        };
      });
    }
  },

  applyHidden: ({ scope, messageId, chatId }) => {
    if (scope === 'dm') {
      const wasLast = get().conversations[chatId]?.lastMessage?.id === messageId;
      set((s) => (s.dms[chatId] ? { dms: { ...s.dms, [chatId]: { ...s.dms[chatId], items: s.dms[chatId].items.filter((m) => m.id !== messageId) } } } : s));
      // The chat list now shows the message before it (or no chat at all).
      if (wasLast) {
        void api<{ conversations: Conversation[] }>('/dms')
          .then(({ conversations }) => set({ conversations: Object.fromEntries(conversations.map((c) => [c.partner.id, c])) }))
          .catch(() => {});
      }
    } else {
      const wasLast = get().rooms[chatId]?.lastMessage?.id === messageId;
      set((s) =>
        s.roomMessages[chatId]
          ? { roomMessages: { ...s.roomMessages, [chatId]: { ...s.roomMessages[chatId], items: s.roomMessages[chatId].items.filter((m) => m.id !== messageId) } } }
          : s,
      );
      if (wasLast) void get().loadRoom(chatId);
    }
  },

  applyReactions: ({ scope, messageId, reactions, between, roomId }) => {
    const update = <T extends { id: number; reactions?: Reaction[] }>(items: T[]) =>
      items.map((m) => (m.id === messageId ? { ...m, reactions } : m));
    if (scope === 'dm') {
      const me = myId();
      const partner = between?.find((id) => id !== me) ?? me;
      set((s) => (s.dms[partner] ? { dms: { ...s.dms, [partner]: { ...s.dms[partner], items: update(s.dms[partner].items) } } } : s));
    } else if (roomId) {
      set((s) =>
        s.roomMessages[roomId]
          ? { roomMessages: { ...s.roomMessages, [roomId]: { ...s.roomMessages[roomId], items: update(s.roomMessages[roomId].items) } } }
          : s,
      );
    }
  },
}));

/**
 * A message deleted for everyone keeps its place as a marker; replies to it
 * show it as deleted.
 */
function erased<T extends { id: number; replyTo?: ReplyRef | null }>(items: T[], messageId: number, fields: Partial<T>): T[] {
  return items.map((m) =>
    m.id === messageId
      ? { ...m, body: '', attachment: null, reactions: [], replyTo: null, replyToId: null, ...fields }
      : m.replyTo?.id === messageId
        ? { ...m, replyTo: { ...m.replyTo, body: '', attachment: null, deleted: true } }
        : m,
  );
}

function meAsSender() {
  const u = useAuth.getState().user;
  return { id: u?.id ?? '', name: u?.name ?? 'You', hue: u?.hue ?? 160 };
}

onLogout(() => useChat.setState({ ...initial }));

// ── Kept on the phone (the app only; see lib/localCache.ts) ──────────

// Signed in: show last time's chats at once, until the server's arrive.
const showKept = (id: string | undefined) => {
  const kept = id ? cachedChats(id) : null;
  if (kept) useChat.setState((c) => (c.bootstrapped ? c : { ...kept, bootstrapped: true }));
};
showKept(useAuth.getState().user?.id);
useAuth.subscribe((s, prev) => {
  if (s.user?.id !== prev.user?.id) showKept(s.user?.id);
});

let saveTimer = 0;
const saveNow = () => {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  const id = myId();
  const s = useChat.getState();
  if (id && s.bootstrapped) saveChats(id, s);
};
useChat.subscribe((s, prev) => {
  const changed =
    s.conversations !== prev.conversations || s.rooms !== prev.rooms || s.invites !== prev.invites || s.dms !== prev.dms || s.roomMessages !== prev.roomMessages || s.roomDetails !== prev.roomDetails;
  if (changed && !saveTimer) saveTimer = window.setTimeout(saveNow, 1500);
});
// Leaving the app: save what's pending now.
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveTimer && saveNow());
