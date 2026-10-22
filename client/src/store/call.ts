import { create } from 'zustand';
import { errorMessage } from '../lib/api';
import { CandidateQueue, createPeer, getCamera, getMicrophone, loadIceServers, stopStream, watchSpeaking } from '../lib/rtc';
import { droppedSocketId, emitAck, socket } from '../lib/socket';
import { startTone, stopTone, unlockAudio } from '../lib/sounds';
import { inApp, nativeAnswering, nativeRinging, pushToken } from '../lib/native';
import type { User } from '../lib/types';
import { onLogout } from './auth';
import { onDeviceChoice } from './devices';
import { toast } from './ui';
import { useVoice } from './voice';

type Phase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active';
type Peer = Pick<User, 'id' | 'name' | 'hue' | 'photo'>;

type CallState = {
  phase: Phase;
  callId: string | null;
  peer: Peer | null;
  /** The call was started as a video call (affects labels only). */
  videoCall: boolean;
  muted: boolean;
  peerMuted: boolean;
  cameraOn: boolean;
  cameraBusy: boolean;
  peerCameraOn: boolean;
  /** Your own camera, for the self view. */
  localVideo: MediaStream | null;
  /** The video window is collapsed to the call bar. */
  minimized: boolean;
  startedAt: number | null;
  reconnecting: boolean;
  remoteStream: MediaStream | null;
  localSpeaking: boolean;
  remoteSpeaking: boolean;
  /** Connected, but no audio packets have arrived for a few seconds. */
  noIncomingAudio: boolean;
  accepting: boolean;

  startCall: (peer: Peer, options?: { video?: boolean }) => Promise<void>;
  acceptCall: (options?: { video?: boolean }) => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleCamera: () => Promise<void>;
  setMinimized: (minimized: boolean) => void;

  onIncoming: (e: { callId: string; from: Peer; video?: boolean }) => void;
  onAccepted: (e: { callId: string; video?: boolean }) => Promise<void>;
  onSignal: (e: { callId: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; restart?: boolean } }) => Promise<void>;
  onPeerMute: (e: { callId: string; muted: boolean }) => void;
  onPeerCamera: (e: { callId: string; on: boolean }) => void;
  onEnded: (e: { callId: string; reason: string }) => void;
  onDismissed: (e: { callId: string }) => void;
  onConnectionLost: () => void;
  /** Connected again: the call carries on here, and finds its sound and video a new path. */
  onReconnected: () => Promise<void>;
  /** The other person's connection dropped, or came back. */
  onPeerAway: (e: { callId: string }) => void;
  onPeerBack: (e: { callId: string }) => void;
};

const idle = {
  phase: 'idle' as Phase,
  callId: null,
  peer: null,
  videoCall: false,
  muted: false,
  peerMuted: false,
  cameraOn: false,
  cameraBusy: false,
  peerCameraOn: false,
  localVideo: null,
  minimized: false,
  startedAt: null,
  reconnecting: false,
  remoteStream: null,
  localSpeaking: false,
  remoteSpeaking: false,
  noIncomingAudio: false,
  accepting: false,
};

// Every call negotiates one audio and one video slot up front. The video slot
// starts empty for voice calls, so turning a camera on later is just a track
// swap: no renegotiation, no risk of both sides offering at once.
//
// A network change (mobile data to Wi-Fi, a tunnel) doesn't end a call. The
// connection to the server comes back by itself and the call resumes on it
// (the server waits); the sound and video get a new path with an ICE restart,
// which the caller always offers (the callee asks for one when it notices first).

/** How long a call waits for its connection to come back before giving up (the server waits about as long). */
const RECONNECT_MS = 50_000;
/** A connection "disconnected" this long gets a new path (it rarely comes back by itself after a network change). */
const STALL_MS = 2500;
/** At most one new path this often. */
const REPAIR_EVERY_MS = 4000;
let pc: RTCPeerConnection | null = null;
let queue: CandidateQueue | null = null;
let micStream: MediaStream | null = null;
let cameraTrack: MediaStreamTrack | null = null;
let outStream: MediaStream | null = null;
let audioSender: RTCRtpSender | null = null;
let videoTx: RTCRtpTransceiver | null = null;
let remote = new MediaStream();
let stopLocalMeter: (() => void) | null = null;
let stopRemoteMeter: (() => void) | null = null;
let healthTimer = 0;
/** Who started the call: the caller makes every offer, ICE restarts included. */
let role: 'caller' | 'callee' | null = null;
let lostTimer = 0;
let lastRepair = 0;

/** Bytes of call audio received so far, or null if unknown. */
async function audioBytesReceived(conn: RTCPeerConnection) {
  let bytes: number | null = null;
  (await conn.getStats()).forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = s.bytesReceived;
  });
  return bytes;
}

type WithSetStreams = RTCRtpSender & { setStreams?: (...streams: MediaStream[]) => void };

export const useCall = create<CallState>()((set, get) => {
  function cleanup() {
    window.clearInterval(healthTimer);
    healthTimer = 0;
    window.clearTimeout(lostTimer);
    role = null;
    lastRepair = 0;
    stopTone();
    stopLocalMeter?.();
    stopRemoteMeter?.();
    stopLocalMeter = stopRemoteMeter = null;
    pc?.close();
    pc = null;
    queue = null;
    audioSender = null;
    videoTx = null;
    outStream = null;
    cameraTrack?.stop();
    cameraTrack = null;
    stopStream(micStream);
    micStream = null;
    remote = new MediaStream();
    set({ ...idle });
  }

  function watchLocalMic() {
    stopLocalMeter?.();
    stopLocalMeter = micStream ? watchSpeaking(micStream, (s) => set({ localSpeaking: s && !get().muted })) : null;
  }

  function emitCamera(on: boolean) {
    const { callId } = get();
    if (callId && pc) socket.emit('call:camera', { callId, on });
  }

  async function startCamera(): Promise<boolean> {
    const cam = await getCamera();
    const track = cam.getVideoTracks()[0];
    if (get().phase === 'idle') {
      track.stop();
      return false;
    }
    cameraTrack?.stop();
    cameraTrack = track;
    // Unplugged or revoked camera: show it as off instead of a frozen frame.
    track.onended = () => {
      if (cameraTrack === track) stopCamera();
    };
    if (videoTx) await videoTx.sender.replaceTrack(track);
    set({ cameraOn: true, localVideo: new MediaStream([track]), minimized: false });
    return true;
  }

  function stopCamera() {
    cameraTrack?.stop();
    cameraTrack = null;
    void videoTx?.sender.replaceTrack(null).catch(() => {});
    set({ cameraOn: false, localVideo: null });
    emitCamera(false);
  }

  /** The call's connection is down: "Reconnecting…", and ends if it doesn't come back in time. */
  function waitForLine() {
    set({ reconnecting: true });
    window.clearTimeout(lostTimer);
    lostTimer = window.setTimeout(() => {
      if (get().phase === 'idle' || (pc?.connectionState === 'connected' && socket.connected)) return;
      get().endCall();
      toast('The call ended: the connection didn’t come back.', 'error');
    }, RECONNECT_MS);
  }

  /** A new path for the sound and video (the network changed): an ICE restart, offered by the caller. */
  async function restartIce() {
    const conn = pc;
    const { callId } = get();
    if (!conn || !callId || role !== 'caller' || !socket.connected) return;
    try {
      const offer = await conn.createOffer({ iceRestart: true });
      if (pc !== conn) return;
      await conn.setLocalDescription(offer);
      socket.emit('call:signal', { callId, data: { sdp: conn.localDescription?.toJSON() } });
    } catch (err) {
      console.warn('Call ICE restart failed', err);
    }
  }

  /** The call's connection broke: the caller finds it a new path; the callee asks it to. */
  function repair() {
    const { callId } = get();
    if (!pc || !callId || !socket.connected || Date.now() - lastRepair < REPAIR_EVERY_MS) return;
    lastRepair = Date.now();
    if (role === 'caller') void restartIce();
    else socket.emit('call:signal', { callId, data: { restart: true } });
  }

  function setupPeer(callId: string, as: 'caller' | 'callee') {
    role = as;
    const conn = createPeer();
    pc = conn;
    queue = new CandidateQueue(conn);
    outStream = new MediaStream(micStream?.getAudioTracks() ?? []);
    const mic = micStream?.getAudioTracks()[0];
    if (mic) audioSender = conn.addTrack(mic, outStream);
    // The caller creates the video slot; the callee adopts it from the offer.
    if (as === 'caller') {
      videoTx = conn.addTransceiver(cameraTrack ?? 'video', { direction: 'sendrecv', streams: [outStream] });
    }
    conn.onicecandidate = (e) => {
      if (e.candidate) socket.emit('call:signal', { callId, data: { candidate: e.candidate.toJSON() } });
    };
    conn.ontrack = (e) => {
      if (!remote.getTracks().includes(e.track)) remote.addTrack(e.track);
      set({ remoteStream: new MediaStream(remote.getTracks()) });
      if (e.track.kind === 'audio') {
        stopRemoteMeter?.();
        stopRemoteMeter = watchSpeaking(new MediaStream([e.track]), (s) => set({ remoteSpeaking: s }));
      }
    };
    let synced = false;
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      const state = conn.connectionState;
      if (state === 'connected') {
        window.clearTimeout(lostTimer);
        set((s) => ({ phase: 'active', reconnecting: false, startedAt: s.startedAt ?? Date.now() }));
        watchIncomingAudio(conn);
        // Tell the other side where our camera ended up (it may have changed while ringing).
        if (!synced) {
          synced = true;
          emitCamera(get().cameraOn);
        }
      } else if (state === 'disconnected') {
        // Often a network change: if it doesn't come back by itself, give it a new path.
        waitForLine();
        window.setTimeout(() => {
          if (pc === conn && (conn.connectionState === 'disconnected' || conn.connectionState === 'failed')) repair();
        }, STALL_MS);
      } else if (state === 'failed') {
        if (get().startedAt) {
          // It was working: find it a new path, rather than end the call.
          waitForLine();
          repair();
        } else {
          toast("The call couldn't connect. If you're on different networks, a TURN server may be needed.", 'error');
          get().endCall();
        }
      }
    };
    watchLocalMic();
    return conn;
  }

  // Even a silent speaker sends a few packets a second, so a stall means the
  // audio path is broken (network, firewall), not that they stopped talking.
  function watchIncomingAudio(conn: RTCPeerConnection) {
    window.clearInterval(healthTimer);
    let last: number | null = null;
    let stalledSince = 0;
    healthTimer = window.setInterval(async () => {
      if (pc !== conn) return;
      const bytes = await audioBytesReceived(conn).catch(() => null);
      if (bytes === null) return;
      if (last !== null && bytes === last) {
        stalledSince ||= Date.now();
        if (Date.now() - stalledSince > 6000 && !get().noIncomingAudio) set({ noIncomingAudio: true });
      } else {
        stalledSince = 0;
        if (get().noIncomingAudio) set({ noIncomingAudio: false });
      }
      last = bytes;
    }, 2000);
  }

  /** Opens the camera for a starting call; on failure, carries on with voice. */
  async function cameraOrVoice() {
    try {
      await startCamera();
    } catch (err) {
      toast(`${errorMessage(err)} Continuing with voice only.`, 'error');
    }
  }

  // A new device chosen in settings takes effect mid-call.
  async function switchMic() {
    const { phase, muted } = get();
    if (!micStream || phase === 'idle' || phase === 'incoming') return;
    try {
      const fresh = await getMicrophone();
      const track = fresh.getAudioTracks()[0];
      track.enabled = !muted;
      await audioSender?.replaceTrack(track);
      stopStream(micStream);
      micStream = fresh;
      watchLocalMic();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function switchCamera() {
    if (!get().cameraOn) return;
    try {
      await startCamera();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  onDeviceChoice((kind) => {
    if (kind === 'audioinput') void switchMic();
    if (kind === 'videoinput') void switchCamera();
  });

  return {
    ...idle,

    startCall: async (peer, options = {}) => {
      if (get().phase !== 'idle') {
        toast("You're already on a call.");
        return;
      }
      unlockAudio();
      set({ ...idle, phase: 'outgoing', peer, videoCall: !!options.video });
      try {
        if (useVoice.getState().roomId) await useVoice.getState().leave();
        [micStream] = await Promise.all([getMicrophone(), loadIceServers()]);
        if (options.video) await cameraOrVoice();
        if (get().phase !== 'outgoing') return cleanup();
        const video = !!cameraTrack;
        set({ videoCall: video });
        const { callId } = await emitAck<{ callId: string }>('call:start', { to: peer.id, video });
        // Hung up while it was being placed: cancel it, or they'd ring on.
        if (get().phase !== 'outgoing' || get().peer?.id !== peer.id || get().callId) {
          socket.emit('call:end', { callId });
          return;
        }
        set({ callId });
        startTone('ringback');
      } catch (err) {
        cleanup();
        toast(errorMessage(err), 'error');
      }
    },

    acceptCall: async (options = {}) => {
      const { callId, phase } = get();
      if (phase !== 'incoming' || !callId) return;
      unlockAudio();
      stopTone();
      set({ accepting: true });
      try {
        if (useVoice.getState().roomId) await useVoice.getState().leave();
        [micStream] = await Promise.all([getMicrophone(), loadIceServers()]);
        if (options.video) await cameraOrVoice();
        if (get().callId !== callId) return;
        setupPeer(callId, 'callee');
        await emitAck('call:accept', { callId, video: !!cameraTrack });
        if (get().callId === callId) set({ phase: 'connecting', accepting: false });
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
      micStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
      set({ muted, localSpeaking: false });
      const { callId } = get();
      if (callId) socket.emit('call:mute', { callId, muted });
    },

    toggleCamera: async () => {
      if (get().cameraBusy || get().phase === 'idle' || get().phase === 'incoming') return;
      if (get().cameraOn) return stopCamera();
      set({ cameraBusy: true });
      try {
        if (await startCamera()) emitCamera(true);
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        set({ cameraBusy: false });
      }
    },

    setMinimized: (minimized) => set({ minimized }),

    onIncoming: ({ callId, from, video }) => {
      if (get().phase !== 'idle') return;
      set({ ...idle, phase: 'incoming', callId, peer: from, videoCall: !!video, peerCameraOn: !!video });
      // In the Android app the phone rings itself (with the call screen) when
      // the app is in the background or already ringing; ring here otherwise.
      const quiet = nativeAnswering(callId) || nativeRinging(callId) || (document.visibilityState === 'hidden' && !!pushToken());
      if (!inApp || !quiet) startTone('incoming');
    },

    onAccepted: async ({ callId, video }) => {
      if (get().callId !== callId || get().phase !== 'outgoing') return;
      stopTone();
      set({ phase: 'connecting', peerCameraOn: !!video });
      try {
        const conn = setupPeer(callId, 'caller');
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
      // The callee's side broke: it asks me (the caller) for a new path.
      if (data.restart) {
        if (role === 'caller') {
          lastRepair = Date.now();
          void restartIce();
        }
        return;
      }
      try {
        if (data.sdp) {
          await conn.setRemoteDescription(data.sdp);
          await queue?.flush();
          if (data.sdp.type === 'offer') {
            // Adopt the caller's video slot and open it for sending, so our
            // camera can join any time with a simple track swap.
            videoTx = conn.getTransceivers().find((t) => t.receiver.track.kind === 'video') ?? null;
            if (videoTx) {
              videoTx.direction = 'sendrecv';
              if (outStream) (videoTx.sender as WithSetStreams).setStreams?.(outStream);
              if (cameraTrack) await videoTx.sender.replaceTrack(cameraTrack);
            }
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

    onPeerCamera: ({ callId, on }) => {
      if (get().callId !== callId) return;
      set(on ? { peerCameraOn: true, videoCall: true } : { peerCameraOn: false });
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
      // Meant for your other tabs; the tab that is answering keeps the call.
      if (get().callId === callId && get().phase === 'incoming' && !get().accepting) {
        cleanup();
        toast('You answered on another tab.');
      }
    },

    onConnectionLost: () => {
      // Ringing here, or in the call: it carries on once the connection is back.
      if (get().phase === 'idle') return;
      waitForLine();
    },

    onReconnected: async () => {
      const { callId, phase } = get();
      if (!callId || phase === 'idle') return;
      try {
        const res = await emitAck<{ ringing?: boolean; answered?: boolean; video?: boolean }>('call:resume', { callId, from: droppedSocketId() });
        if (get().callId !== callId) return;
        if (res.ringing || get().phase === 'incoming') {
          window.clearTimeout(lostTimer);
          set({ reconnecting: false });
          return;
        }
        // Answered while my connection was down: start connecting now.
        if (get().phase === 'outgoing') {
          window.clearTimeout(lostTimer);
          set({ reconnecting: false });
          if (res.answered) await get().onAccepted({ callId, video: res.video });
          return;
        }
        if (pc?.connectionState === 'connected') {
          window.clearTimeout(lostTimer);
          set({ reconnecting: false });
        }
        // The network changed, so the sound and video need a new path too.
        lastRepair = Date.now();
        if (role === 'caller') void restartIce();
        else socket.emit('call:signal', { callId, data: { restart: true } });
      } catch (err) {
        if (get().callId !== callId) return;
        cleanup();
        toast(errorMessage(err), 'error');
      }
    },

    onPeerAway: ({ callId }) => {
      if (get().callId === callId && get().phase !== 'incoming') waitForLine();
    },

    onPeerBack: ({ callId }) => {
      if (get().callId !== callId) return;
      // Still working (it can ride out a short drop): nothing to wait for.
      if (pc?.connectionState === 'connected') {
        window.clearTimeout(lostTimer);
        set({ reconnecting: false });
      }
      // Their network changed: the caller gives the sound and video a new path.
      lastRepair = Date.now();
      if (role === 'caller') void restartIce();
    },
  };
});

onLogout(() => {
  const s = useCall.getState();
  if (s.phase !== 'idle') s.endCall();
});
