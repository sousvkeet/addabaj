import { syncClock } from './lib/clock';
import { socket } from './lib/socket';
import type { DmMessage, Invite, RoomMessage, RoomSummary, User, VoiceParticipant, WatchState } from './lib/types';
import { useAuth } from './store/auth';
import { useCall } from './store/call';
import { useChat } from './store/chat';
import { toast } from './store/ui';
import { useVoice } from './store/voice';

const chat = () => useChat.getState();

let bound = false;

export function bindRealtime() {
  if (bound) return;
  bound = true;

  socket.on('connect', () => {
    void chat().sync();
    void syncClock();
  });
  socket.on('disconnect', (reason) => {
    useCall.getState().onConnectionLost();
    useVoice.getState().onConnectionLost();
    if (reason === 'io server disconnect' && useAuth.getState().status === 'authed') socket.connect();
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') useAuth.getState().expire();
  });

  // Presence
  socket.on('presence:snapshot', ({ online }: { online: string[] }) => {
    useChat.setState({ online: Object.fromEntries(online.map((id) => [id, true])) });
  });
  socket.on('presence:update', ({ userId, online, lastSeenAt }: { userId: string; online: boolean; lastSeenAt?: string }) => {
    useChat.setState((s) => ({
      online: { ...s.online, [userId]: online },
      lastSeen: lastSeenAt ? { ...s.lastSeen, [userId]: lastSeenAt } : s.lastSeen,
    }));
  });

  // Direct messages
  socket.on('dm:new', ({ message, partner }: { message: DmMessage; partner: User }) => chat().receiveDm(message, partner));
  socket.on('dm:typing', ({ from, typing }: { from: string; typing: boolean }) => chat().setDmTyping(from, typing));
  socket.on('dm:read', (e: { readerId: string; partnerId: string; readAt: string }) => chat().applyDmRead(e));

  // Rooms
  socket.on('room:message', (m: RoomMessage) => chat().receiveRoomMessage(m));
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
  socket.on('watch:state', ({ roomId, watch }: { roomId: string; watch: WatchState | null }) => {
    useChat.setState((s) => ({
      roomDetails: s.roomDetails[roomId] ? { ...s.roomDetails, [roomId]: { ...s.roomDetails[roomId], watch } } : s.roomDetails,
      rooms: s.rooms[roomId] ? { ...s.rooms, [roomId]: { ...s.rooms[roomId], watching: watch?.source.title ?? null } } : s.rooms,
    }));
  });

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
