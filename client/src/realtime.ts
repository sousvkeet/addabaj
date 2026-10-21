import { api } from './lib/api';
import { syncClock } from './lib/clock';
import { useSite } from './lib/site';
import { watchConnection } from './lib/liveness';
import { socket } from './lib/socket';
import type { DmMessage, Invite, RoomMessage, RoomSummary, User, VoiceParticipant, WatchState } from './lib/types';
import { useAuth } from './store/auth';
import { useCall } from './store/call';
import { useChat } from './store/chat';
import { useLiveStream } from './store/liveStream';
import { toast } from './store/ui';
import { useVoice } from './store/voice';
import { setPreparing, type Preparing } from './store/watchProgress';

const chat = () => useChat.getState();

let bound = false;

export function bindRealtime() {
  if (bound) return;
  bound = true;

  socket.on('connect', () => {
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
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') useAuth.getState().expire();
  });
  watchConnection(() => useAuth.getState().status === 'authed');

  // The host admin
  socket.on('site:settings', (site) => useSite.getState().set(site));
  socket.on('account:changed', () => void useAuth.getState().refresh().catch(() => {}));
  socket.on('account:disabled', () => {
    toast('The host switched off your account.', 'error');
    useAuth.getState().expire();
  });

  // Presence
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
    if (typeof ack === 'function') ack(true);
  });
  socket.on('dm:delivered', (e: { partnerId: string; ids: number[]; deliveredAt: string }) => chat().applyDmDelivered(e));
  socket.on('dm:typing', ({ from, typing }: { from: string; typing: boolean }) => chat().setDmTyping(from, typing));
  socket.on('dm:read', (e: { readerId: string; partnerId: string; readAt: string }) => chat().applyDmRead(e));
  socket.on('msg:reactions', (e: Parameters<ReturnType<typeof useChat.getState>['applyReactions']>[0]) => chat().applyReactions(e));
  // Deleted for everyone (the marker stays), or hidden by me on another device.
  socket.on('msg:deleted', (e: Parameters<ReturnType<typeof useChat.getState>['applyDeleted']>[0]) => chat().applyDeleted(e));
  socket.on('msg:hidden', (e: Parameters<ReturnType<typeof useChat.getState>['applyHidden']>[0]) => chat().applyHidden(e));

  // Rooms
  socket.on('room:message', (m: RoomMessage, ack?: (ok: boolean) => void) => {
    chat().receiveRoomMessage(m);
    if (typeof ack === 'function') ack(true);
  });
  socket.on('room:receipts', (e: Parameters<ReturnType<typeof useChat.getState>['applyRoomReceipts']>[0]) => chat().applyRoomReceipts(e));
  socket.on('room:typing', (e: { roomId: string; userId: string; name: string; typing: boolean }) => chat().setRoomTyping(e));
  socket.on('room:read', ({ roomId }: { roomId: string }) => {
    useChat.setState((s) => (s.rooms[roomId] ? { rooms: { ...s.rooms, [roomId]: { ...s.rooms[roomId], unread: 0 } } } : s));
  });
  socket.on('room:changed', ({ roomId }: { roomId: string }) => {
    if (chat().rooms[roomId]) void chat().loadRoom(roomId);
  });
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
