import { api } from './lib/api';
import { syncClock } from './lib/clock';
import { useSite } from './lib/site';
import { watchConnection } from './lib/liveness';
import { socket } from './lib/socket';
import type { DmMessage, Invite, QueueItem, RoomMessage, RoomSummary, User, VoiceParticipant, WatchState } from './lib/types';
import { useAuth } from './store/auth';
import { useCall } from './store/call';
import { useChat } from './store/chat';
import { noticeDm, noticeRoom } from './store/callNotices';
import { useLiveStream } from './store/liveStream';
import { useReports } from './store/reports';
import { toast } from './store/ui';
import { useVoice } from './store/voice';
import { useWatching } from './store/watching';
import { setPreparing, type Preparing } from './store/watchProgress';

const chat = () => useChat.getState();

// ── A newer version of the site ───────────────────────────────────────
//
// A page left running for days (the Android app keeps its page alive in the
// background) would never get a new version of the site, so nothing new would
// show, not even the app update screen. When the server hosts a newer page,
// reload once that can't disturb anything: out of sight, with no call, room
// voice, live stream or message still sending.

/** The main script this page runs ("/assets/index-…js"); null in development. */
const runningBuild = () =>
  [...document.scripts].map((s) => (s.src ? new URL(s.src).pathname : '')).find((p) => p.startsWith('/assets/index-')) ?? null;

function busy() {
  const c = chat();
  const sending = [...Object.values(c.dms), ...Object.values(c.roomMessages)].some((p) => p.items.some((m) => m.pending === 'sending'));
  return (
    sending ||
    useCall.getState().phase !== 'idle' ||
    !!useVoice.getState().roomId ||
    !!useLiveStream.getState().host ||
    !!useWatching.getState().roomId
  );
}

let outdated = false;
const reloadIfQuiet = () => {
  if (outdated && document.visibilityState === 'hidden' && !busy()) window.location.reload();
};

function watchSiteVersion() {
  useSite.subscribe((s) => {
    const mine = runningBuild();
    if (!s.build || !mine || s.build === mine) return;
    outdated = true;
    reloadIfQuiet();
  });
  document.addEventListener('visibilitychange', reloadIfQuiet);
}

let bound = false;

export function bindRealtime() {
  if (bound) return;
  bound = true;
  watchSiteVersion();

  socket.on('connect', () => {
    // Back after a dropped connection (a network change): a call or room voice carries on.
    void useCall.getState().onReconnected();
    void useVoice.getState().onReconnected();
    void chat().sync();
    void syncClock();
    useLiveStream.getState().onReconnected();
    void useSite.getState().load();
  });
  socket.on('disconnect', (reason) => {
    useCall.getState().onConnectionLost();
    useVoice.getState().onConnectionLost();
    if (reason === 'io server disconnect' && useAuth.getState().status === 'authed') socket.connect();
  });
  // Refused: logged out elsewhere, or this device's login was just renewed (a
  // password change hands it a new one) while the old one tried to reconnect.
  // Ask the server once before going to the login page.
  let rechecked = 0;
  socket.on('connect_error', (err) => {
    if (err.message !== 'unauthorized') return;
    if (Date.now() - rechecked < 10_000) return useAuth.getState().expire();
    rechecked = Date.now();
    useAuth
      .getState()
      .refresh()
      .then(
        () => {
          if (useAuth.getState().status === 'authed') socket.connect();
        },
        () => useAuth.getState().expire(),
      );
  });
  watchConnection(() => useAuth.getState().status === 'authed');

  // The host admin
  socket.on('site:settings', (site) => useSite.getState().set(site));
  // A report came in, or was handled: how many are waiting (host admins only).
  socket.on('admin:reports', ({ open }: { open: number }) => useReports.getState().setOpen(open));
  socket.on('account:changed', () => void useAuth.getState().refresh().catch(() => {}));
  socket.on('account:disabled', () => {
    toast('The host switched off your account.', 'error');
    useAuth.getState().expire();
  });

  // Presence
  // Devices (Settings › Devices): a new login on my account, or this device logged out from another.
  socket.on('session:new', ({ session }: { session: { name: string } }) => {
    toast(`New login: ${session.name}. Not you? Log it out in Settings › Devices.`);
    window.dispatchEvent(new Event('adda:sessions'));
  });
  socket.on('session:ended', ({ reason }: { reason: string }) => {
    if (reason === 'logout') return;
    toast(
      reason === 'password'
        ? 'You were logged out because the password was changed.'
        : reason === 'host'
          ? 'The host logged you out. Log in with the new password they gave you.'
          : 'This device was logged out from another device.',
      'error',
    );
    useAuth.getState().expire();
  });

  // Someone changed their photo: everywhere they appear, including my own account.
  socket.on('user:updated', ({ user }: { user: Pick<User, 'id'> & Partial<User> }) => {
    chat().applyUser(user);
    const me = useAuth.getState().user;
    if (me?.id === user.id) useAuth.getState().setUser({ ...me, ...user });
  });
  socket.on('presence:snapshot', ({ online }: { online: string[] }) => {
    useChat.setState({ online: Object.fromEntries(online.map((id) => [id, true])) });
  });
  socket.on('presence:update', ({ userId, online, lastSeenAt, hidden }: { userId: string; online: boolean; lastSeenAt?: string | null; hidden?: boolean }) => {
    useChat.setState((s) => ({
      online: { ...s.online, [userId]: online },
      lastSeen: lastSeenAt ? { ...s.lastSeen, [userId]: lastSeenAt } : s.lastSeen,
      hiddenPresence: { ...s.hiddenPresence, [userId]: !!hidden },
    }));
  });
  // My privacy changed: reload who's online, and people's last seen with it.
  socket.on('presence:refresh', () => {
    void api<{ online: string[] }>('/auth/presence').then(({ online }) => {
      useChat.setState({ online: Object.fromEntries(online.map((id) => [id, true])), lastSeen: {}, hiddenPresence: {} });
      void chat().sync();
    });
  });

  // Direct messages
  // Answering tells the server this device has the message, so the sender sees "delivered".
  socket.on('dm:new', ({ message, partner }: { message: DmMessage; partner: User }, ack?: (ok: boolean) => void) => {
    chat().receiveDm(message, partner);
    // During a video call, as a banner over it.
    noticeDm(message, partner);
    if (typeof ack === 'function') ack(true);
  });
  socket.on('dm:delivered', (e: { partnerId: string; ids: number[]; deliveredAt: string }) => chat().applyDmDelivered(e));
  socket.on('dm:typing', ({ from, typing }: { from: string; typing: boolean }) => chat().setDmTyping(from, typing));
  socket.on('dm:read', (e: { readerId: string; partnerId: string; readAt: string }) => chat().applyDmRead(e));
  socket.on('msg:reactions', (e: Parameters<ReturnType<typeof useChat.getState>['applyReactions']>[0]) => chat().applyReactions(e));
  // Deleted for everyone (the marker stays), or hidden by me on another device.
  socket.on('msg:deleted', (e: Parameters<ReturnType<typeof useChat.getState>['applyDeleted']>[0]) => chat().applyDeleted(e));
  socket.on('msg:hidden', (e: Parameters<ReturnType<typeof useChat.getState>['applyHidden']>[0]) => chat().applyHidden(e));
  // A message changed by its sender, and a link's card arriving.
  socket.on('msg:edited', (e: Parameters<ReturnType<typeof useChat.getState>['applyEdited']>[0]) => chat().applyEdited(e));
  socket.on('msg:preview', (e: Parameters<ReturnType<typeof useChat.getState>['applyPreview']>[0]) => chat().applyPreview(e));
  // My settings for a chat or room (muted, pinned, archived), from another device.
  socket.on('chat:settings', (e: Parameters<ReturnType<typeof useChat.getState>['applyChatSettings']>[0]) => chat().applyChatSettings(e));
  // Someone blocked or unblocked, here or on another device.
  socket.on('blocks:changed', () => {
    void api<{ blocked: { id: string }[] }>('/users/blocked')
      .then(({ blocked }) => chat().applyBlocked(blocked.map((b) => b.id)))
      .catch(() => {});
  });

  // Rooms
  socket.on('room:message', (m: RoomMessage, ack?: (ok: boolean) => void) => {
    chat().receiveRoomMessage(m);
    noticeRoom(m);
    if (typeof ack === 'function') ack(true);
  });
  socket.on('room:receipts', (e: Parameters<ReturnType<typeof useChat.getState>['applyRoomReceipts']>[0]) => chat().applyRoomReceipts(e));
  socket.on('room:typing', (e: { roomId: string; userId: string; name: string; typing: boolean }) => chat().setRoomTyping(e));
  socket.on('room:read', ({ roomId }: { roomId: string }) => {
    useChat.setState((s) => (s.rooms[roomId] ? { rooms: { ...s.rooms, [roomId]: { ...s.rooms[roomId], unread: 0, unreadMentions: 0 } } } : s));
  });
  socket.on('room:muted', ({ roomId, mutedUntil }: { roomId: string; mutedUntil: string | null }) => chat().setRoomMuted(roomId, mutedUntil));
  socket.on('room:changed', ({ roomId }: { roomId: string }) => {
    if (chat().rooms[roomId]) void chat().loadRoom(roomId);
  });
  // A room's chat history was cleared (by an admin, or on its schedule): its older messages go.
  socket.on('room:cleared', (e: { roomId: string; before: string; all?: boolean }) => {
    const room = chat().rooms[e.roomId];
    chat().applyCleared(e);
    // Unread ones may have gone with them: the count comes from the server again.
    if (room?.unread && !e.all) void chat().loadRoom(e.roomId);
  });
  // An admin muted me in a room's voice, or stopped my camera (or let me again).
  socket.on('voice:moderated', (e: { roomId: string; voiceMuted: boolean; cameraBlocked: boolean }) => useVoice.getState().applyModeration(e));
  socket.on('room:added', (room: RoomSummary | null) => {
    if (!room) return;
    const isNew = !chat().rooms[room.id];
    chat().upsertRoom(room);
    if (isNew && room.ownerId !== useAuth.getState().user?.id) {
      toast(`You were added to ${room.name}.`, 'live');
    }
  });
  socket.on('room:removed', ({ roomId, reason }: { roomId: string; reason: string }) => {
    const room = chat().rooms[roomId];
    chat().dropRoom(roomId);
    if (!room) return;
    if (reason === 'removed') toast(`You were removed from ${room.name}.`);
    else if (reason === 'deleted' && room.ownerId !== useAuth.getState().user?.id) toast(`${room.name} was deleted.`);
  });

  // Watch together
  socket.on('watch:preparing', ({ roomId, ...p }: Preparing & { roomId: string }) => setPreparing(roomId, p));
  socket.on('watch:queue', ({ roomId, queue }: { roomId: string; queue: QueueItem[] }) => {
    useChat.setState((s) => (s.roomDetails[roomId] ? { roomDetails: { ...s.roomDetails, [roomId]: { ...s.roomDetails[roomId], queue } } } : s));
  });
  socket.on('watch:state', ({ roomId, watch }: { roomId: string; watch: WatchState | null }) => {
    useChat.setState((s) => ({
      roomDetails: s.roomDetails[roomId] ? { ...s.roomDetails, [roomId]: { ...s.roomDetails[roomId], watch } } : s.roomDetails,
      rooms: s.rooms[roomId] ? { ...s.rooms, [roomId]: { ...s.rooms[roomId], watching: watch?.source.title ?? null } } : s.rooms,
    }));
  });

  // Live streams from an admin's device
  const live = () => useLiveStream.getState();
  socket.on('live:viewer', (e) => void live().onViewer(e));
  socket.on('live:viewer-left', (e) => live().onViewerLeft(e));
  socket.on('live:signal', (e) => void live().onSignal(e));
  socket.on('live:ended', (e) => live().onEnded(e));

  // Invites
  socket.on('invite:new', (invite: Invite | null) => {
    if (!invite) return;
    useChat.setState((s) => ({ invites: [invite, ...s.invites.filter((i) => i.id !== invite.id)] }));
    toast(`${invite.inviter.name} invited you to ${invite.room.name}.`, 'live');
  });
  // The room changed (its name, photo, member count) before they answered.
  socket.on('invite:updated', (invite: Invite) => {
    useChat.setState((s) => ({ invites: s.invites.map((i) => (i.id === invite.id ? invite : i)) }));
  });
  socket.on('invite:removed', ({ inviteId }: { inviteId: string }) => {
    useChat.setState((s) => ({ invites: s.invites.filter((i) => i.id !== inviteId) }));
  });

  // One-to-one calls
  const call = () => useCall.getState();
  socket.on('call:incoming', (e) => call().onIncoming(e));
  socket.on('call:accepted', (e) => void call().onAccepted(e));
  socket.on('call:signal', (e) => void call().onSignal(e));
  socket.on('call:peer-mute', (e) => call().onPeerMute(e));
  socket.on('call:peer-camera', (e) => call().onPeerCamera(e));
  // Their connection dropped, or came back (a network change on their side).
  socket.on('call:peer-away', (e) => call().onPeerAway(e));
  socket.on('call:peer-back', (e) => call().onPeerBack(e));
  socket.on('call:ended', (e) => call().onEnded(e));
  socket.on('call:dismissed', (e) => call().onDismissed(e));

  // Room voice
  const voice = () => useVoice.getState();
  socket.on('voice:snapshot', (snap: Record<string, VoiceParticipant[]>) => {
    useChat.setState((s) => ({ voice: { ...s.voice, ...snap } }));
  });
  socket.on('voice:state', ({ roomId, participants }: { roomId: string; participants: VoiceParticipant[] }) =>
    chat().setVoice(roomId, participants),
  );
  socket.on('voice:peer-joined', (e) => voice().onPeerJoined(e));
  socket.on('voice:peer-left', (e) => voice().onPeerLeft(e));
  socket.on('voice:signal', (e) => void voice().onSignal(e));
  socket.on('voice:kicked', (e) => voice().onKicked(e));

  // Keep read state honest when the tab regains focus.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const { activeDm, activeRoom } = chat();
    if (activeDm) chat().markDmRead(activeDm);
    if (activeRoom) chat().markRoomRead(activeRoom);
  });
}
