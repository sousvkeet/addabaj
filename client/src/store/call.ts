import { create } from 'zustand';
import { errorMessage } from '../lib/api';
import { CandidateQueue, createPeer, getMicrophone, loadIceServers, stopStream, watchSpeaking } from '../lib/rtc';
import { emitAck, socket } from '../lib/socket';
import { startTone, stopTone } from '../lib/sounds';
import type { User } from '../lib/types';
import { onLogout } from './auth';
import { toast } from './ui';
import { useVoice } from './voice';

type Phase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active';

type CallState = {
  phase: Phase;
  callId: string | null;
  peer: Pick<User, 'id' | 'name' | 'hue'> | null;
  muted: boolean;
  peerMuted: boolean;
  startedAt: number | null;
  reconnecting: boolean;
  remoteStream: MediaStream | null;
  localSpeaking: boolean;
  remoteSpeaking: boolean;
  accepting: boolean;

  startCall: (peer: Pick<User, 'id' | 'name' | 'hue'>) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleMute: () => void;

  onIncoming: (e: { callId: string; from: Pick<User, 'id' | 'name' | 'hue'> }) => void;
  onAccepted: (e: { callId: string }) => Promise<void>;
  onSignal: (e: { callId: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => Promise<void>;
  onPeerMute: (e: { callId: string; muted: boolean }) => void;
  onEnded: (e: { callId: string; reason: string }) => void;
  onDismissed: (e: { callId: string }) => void;
  onConnectionLost: () => void;
};

const idle = {
  phase: 'idle' as Phase,
  callId: null,
  peer: null,
  muted: false,
  peerMuted: false,
  startedAt: null,
  reconnecting: false,
  remoteStream: null,
  localSpeaking: false,
  remoteSpeaking: false,
  accepting: false,
};

let pc: RTCPeerConnection | null = null;
let queue: CandidateQueue | null = null;
let localStream: MediaStream | null = null;
let stopMeters: (() => void)[] = [];

export const useCall = create<CallState>()((set, get) => {
  function cleanup() {
    stopTone();
    stopMeters.forEach((fn) => fn());
    stopMeters = [];
    pc?.close();
    pc = null;
    queue = null;
    stopStream(localStream);
    localStream = null;
    set({ ...idle });
  }

  function setupPeer(callId: string) {
    const conn = createPeer();
    pc = conn;
    queue = new CandidateQueue(conn);
    for (const track of localStream?.getTracks() ?? []) conn.addTrack(track, localStream!);
    conn.onicecandidate = (e) => {
      if (e.candidate) socket.emit('call:signal', { callId, data: { candidate: e.candidate.toJSON() } });
    };
    conn.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      set({ remoteStream: stream });
      stopMeters.push(watchSpeaking(stream, (s) => set({ remoteSpeaking: s })));
    };
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      const state = conn.connectionState;
      if (state === 'connected') {
        set((s) => ({ phase: 'active', reconnecting: false, startedAt: s.startedAt ?? Date.now() }));
      } else if (state === 'disconnected') {
        set({ reconnecting: true });
      } else if (state === 'failed') {
        toast("The call couldn't connect. If you're on different networks, a TURN server may be needed.", 'error');
        get().endCall();
      }
    };
    if (localStream) {
      stopMeters.push(watchSpeaking(localStream, (s) => set({ localSpeaking: s && !get().muted })));
    }
    return conn;
  }

  return {
    ...idle,

    startCall: async (peer) => {
      if (get().phase !== 'idle') {
        toast("You're already on a call.");
        return;
      }
      set({ ...idle, phase: 'outgoing', peer });
      try {
        if (useVoice.getState().roomId) await useVoice.getState().leave();
        [localStream] = await Promise.all([getMicrophone(), loadIceServers()]);
        if (get().phase !== 'outgoing') return cleanup();
        const { callId } = await emitAck<{ callId: string }>('call:start', { to: peer.id });
        set({ callId });
        startTone('ringback');
      } catch (err) {
        cleanup();
        toast(errorMessage(err), 'error');
      }
    },

    acceptCall: async () => {
      const { callId, phase } = get();
      if (phase !== 'incoming' || !callId) return;
      stopTone();
      set({ accepting: true });
      try {
        if (useVoice.getState().roomId) await useVoice.getState().leave();
        [localStream] = await Promise.all([getMicrophone(), loadIceServers()]);
        if (get().callId !== callId) return;
        setupPeer(callId);
        await emitAck('call:accept', { callId });
        set({ phase: 'connecting', accepting: false });
      } catch (err) {
        socket.emit('call:decline', { callId });
        cleanup();
        toast(errorMessage(err), 'error');
      }
    },

    declineCall: () => {
      const { callId } = get();
      if (callId) socket.emit('call:decline', { callId });
      cleanup();
    },

    endCall: () => {
      const { callId } = get();
      if (callId) socket.emit('call:end', { callId });
      cleanup();
    },

    toggleMute: () => {
      const muted = !get().muted;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
      set({ muted, localSpeaking: false });
      const { callId } = get();
      if (callId) socket.emit('call:mute', { callId, muted });
    },

    onIncoming: ({ callId, from }) => {
      if (get().phase !== 'idle') return;
      set({ ...idle, phase: 'incoming', callId, peer: from });
      startTone('incoming');
    },

    onAccepted: async ({ callId }) => {
      if (get().callId !== callId || get().phase !== 'outgoing') return;
      stopTone();
      set({ phase: 'connecting' });
      try {
        const conn = setupPeer(callId);
        const offer = await conn.createOffer();
        await conn.setLocalDescription(offer);
        socket.emit('call:signal', { callId, data: { sdp: conn.localDescription?.toJSON() } });
      } catch {
        toast("Couldn't start the call. Try again.", 'error');
        get().endCall();
      }
    },

    onSignal: async ({ callId, data }) => {
      if (get().callId !== callId || !pc) return;
      const conn = pc;
      try {
        if (data.sdp) {
          await conn.setRemoteDescription(data.sdp);
          await queue?.flush();
          if (data.sdp.type === 'offer') {
            const answer = await conn.createAnswer();
            await conn.setLocalDescription(answer);
            socket.emit('call:signal', { callId, data: { sdp: conn.localDescription?.toJSON() } });
          }
        } else if (data.candidate) {
          await queue?.add(data.candidate);
        }
      } catch (err) {
        console.warn('Call signalling failed', err);
      }
    },

    onPeerMute: ({ callId, muted }) => {
      if (get().callId === callId) set({ peerMuted: muted });
    },

    onEnded: ({ callId, reason }) => {
      const { callId: current, peer, phase } = get();
      if (current !== callId) return;
      const name = peer?.name ?? 'They';
      cleanup();
      if (reason === 'declined' && phase === 'outgoing') toast(`${name} declined the call.`);
      else if (reason === 'missed' && phase === 'outgoing') toast(`${name} didn't answer.`);
      else if ((reason === 'missed' || reason === 'cancelled') && phase === 'incoming') toast(`Missed call from ${name}.`);
      else if (reason === 'dropped') toast(`Call dropped. ${name} lost connection.`, 'error');
      else if (reason === 'ended') toast('Call ended.');
    },

    onDismissed: ({ callId }) => {
      if (get().callId === callId && get().phase === 'incoming') {
        cleanup();
        toast('You answered on another tab.');
      }
    },

    onConnectionLost: () => {
      if (get().phase === 'idle') return;
      cleanup();
      toast('Your call ended because the connection dropped.', 'error');
    },
  };
});

onLogout(() => {
  const s = useCall.getState();
  if (s.phase !== 'idle') s.endCall();
});
