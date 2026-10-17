import { create } from 'zustand';
import { errorMessage } from '../lib/api';
import { CandidateQueue, createPeer, getMicrophone, loadIceServers, stopStream, watchSpeaking } from '../lib/rtc';
import { emitAck, socket } from '../lib/socket';
import { blip } from '../lib/sounds';
import type { VoiceParticipant } from '../lib/types';
import { myId, onLogout } from './auth';
import { useCall } from './call';
import { toast } from './ui';

// Room voice is a full mesh: the person who joins sends an offer to everyone
// already there, so two peers never both offer at once.

type VoiceState = {
  roomId: string | null;
  status: 'idle' | 'joining' | 'live';
  muted: boolean;
  streams: Record<string, MediaStream>;
  speaking: Record<string, boolean>;
  connection: Record<string, RTCPeerConnectionState>;

  join: (roomId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;

  onPeerJoined: (e: { roomId: string; userId: string }) => void;
  onPeerLeft: (e: { roomId: string; userId: string }) => void;
  onSignal: (e: { roomId: string; from: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => Promise<void>;
  onKicked: (e: { roomId: string; reason: string }) => void;
  onConnectionLost: () => void;
};

type Peer = { pc: RTCPeerConnection; queue: CandidateQueue; stopMeter?: () => void };

const idle = {
  roomId: null,
  status: 'idle' as const,
  muted: false,
  streams: {},
  speaking: {},
  connection: {},
};

let localStream: MediaStream | null = null;
let stopLocalMeter: (() => void) | null = null;
const peers = new Map<string, Peer>();

const without = <T,>(rec: Record<string, T>, key: string) => {
  const next = { ...rec };
  delete next[key];
  return next;
};

export const useVoice = create<VoiceState>()((set, get) => {
  function closePeer(userId: string) {
    const peer = peers.get(userId);
    if (!peer) return;
    peer.stopMeter?.();
    peer.pc.close();
    peers.delete(userId);
    set((s) => ({
      streams: without(s.streams, userId),
      speaking: without(s.speaking, userId),
      connection: without(s.connection, userId),
    }));
  }

  function cleanup() {
    for (const id of [...peers.keys()]) closePeer(id);
    stopLocalMeter?.();
    stopLocalMeter = null;
    stopStream(localStream);
    localStream = null;
    set({ ...idle });
  }

  function connect(userId: string, roomId: string): Peer {
    closePeer(userId);
    const pc = createPeer();
    const peer: Peer = { pc, queue: new CandidateQueue(pc) };
    peers.set(userId, peer);
    for (const track of localStream?.getTracks() ?? []) pc.addTrack(track, localStream!);
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice:signal', { roomId, to: userId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      peer.stopMeter?.();
      peer.stopMeter = watchSpeaking(stream, (speaking) =>
        set((s) => ({ speaking: { ...s.speaking, [userId]: speaking } })),
      );
      set((s) => ({ streams: { ...s.streams, [userId]: stream } }));
    };
    pc.onconnectionstatechange = () => {
      if (peers.get(userId)?.pc !== pc) return;
      set((s) => ({ connection: { ...s.connection, [userId]: pc.connectionState } }));
    };
    return peer;
  }

  async function offerTo(userId: string, roomId: string) {
    const { pc } = connect(userId, roomId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('voice:signal', { roomId, to: userId, data: { sdp: pc.localDescription?.toJSON() } });
  }

  return {
    ...idle,

    join: async (roomId) => {
      const call = useCall.getState();
      if (call.phase !== 'idle') {
        toast('End your call before joining voice.');
        return;
      }
      const current = get();
      if (current.roomId === roomId && current.status !== 'idle') return;
      if (current.roomId) await get().leave();

      set({ ...idle, roomId, status: 'joining' });
      try {
        [localStream] = await Promise.all([getMicrophone(), loadIceServers()]);
        if (get().roomId !== roomId) return cleanup();
        const { peers: others } = await emitAck<{ peers: VoiceParticipant[] }>('voice:join', { roomId, muted: false });
        if (get().roomId !== roomId) return;
        set({ status: 'live' });
        blip('join');
        const me = myId();
        stopLocalMeter = watchSpeaking(localStream, (speaking) =>
          set((s) => ({ speaking: { ...s.speaking, [me]: speaking && !s.muted } })),
        );
        await Promise.all(others.map((p) => offerTo(p.userId, roomId).catch((err) => console.warn('Voice offer failed', err))));
      } catch (err) {
        cleanup();
        toast(errorMessage(err), 'error');
      }
    },

    leave: async () => {
      const { roomId } = get();
      if (roomId) socket.emit('voice:leave', { roomId });
      if (get().status === 'live') blip('leave');
      cleanup();
    },

    toggleMute: () => {
      const { roomId, muted } = get();
      const next = !muted;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = !next));
      set((s) => ({ muted: next, speaking: { ...s.speaking, [myId()]: false } }));
      if (roomId) socket.emit('voice:mute', { roomId, muted: next });
    },

    onPeerJoined: ({ roomId }) => {
      if (get().roomId === roomId && get().status === 'live') blip('join');
    },

    onPeerLeft: ({ roomId, userId }) => {
      if (get().roomId !== roomId) return;
      closePeer(userId);
      blip('leave');
    },

    onSignal: async ({ roomId, from, data }) => {
      if (get().roomId !== roomId || !localStream) return;
      try {
        if (data.sdp?.type === 'offer') {
          const { pc, queue } = connect(from, roomId);
          await pc.setRemoteDescription(data.sdp);
          await queue.flush();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('voice:signal', { roomId, to: from, data: { sdp: pc.localDescription?.toJSON() } });
        } else if (data.sdp?.type === 'answer') {
          const peer = peers.get(from);
          if (!peer) return;
          await peer.pc.setRemoteDescription(data.sdp);
          await peer.queue.flush();
        } else if (data.candidate) {
          await peers.get(from)?.queue.add(data.candidate);
        }
      } catch (err) {
        console.warn('Voice signalling failed', err);
      }
    },

    onKicked: ({ roomId, reason }) => {
      if (get().roomId !== roomId) return;
      cleanup();
      if (reason === 'elsewhere') toast('You joined voice from another tab, so this one left.');
      else if (reason === 'removed') toast('You were removed from the room, so you left voice.');
      else if (reason === 'deleted') toast('The room was deleted, so voice ended.');
    },

    onConnectionLost: () => {
      if (get().status === 'idle') return;
      cleanup();
      toast('You left voice because the connection dropped.', 'error');
    },
  };
});

onLogout(() => {
  if (useVoice.getState().roomId) void useVoice.getState().leave();
});
