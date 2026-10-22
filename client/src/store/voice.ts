import { create } from 'zustand';
import { errorMessage } from '../lib/api';
import { CandidateQueue, createPeer, getCamera, getMicrophone, loadIceServers, stopStream, watchSpeaking } from '../lib/rtc';
import { inApp } from '../lib/native';
import { emitAck, socket } from '../lib/socket';
import { blip, unlockAudio } from '../lib/sounds';
import type { VoiceParticipant } from '../lib/types';
import { myId, onLogout } from './auth';
import { useCall } from './call';
import { onDeviceChoice } from './devices';
import { toast } from './ui';

// Room voice is a full mesh: the person who joins sends an offer to everyone
// already there, so two peers never both offer at once.
//
// Video rides on the same connections. Each one sets up a video slot from the
// start (empty while the camera is off), so a camera going on or off is just
// a track swap, with no renegotiation. In a mesh every camera is encoded once
// for each viewer, so each viewer tells each sender how big it shows them (a
// "view") and gets just that: nothing while its call window is closed or out
// of sight, a small picture for a tile in a big grid, a sharp one for a
// focused tile.

/** How big someone's camera is shown: not at all, or a small, medium or large tile. */
export type View = 'hidden' | 'small' | 'medium' | 'large';
const VIEWS: readonly string[] = ['hidden', 'small', 'medium', 'large'];

/** What each view gets: the picture's short side, bits and frames per second. */
const QUALITY = {
  small: { side: 180, bitrate: 200_000, fps: 15 },
  medium: { side: 360, bitrate: 600_000, fps: 24 },
  large: { side: 720, bitrate: 1_500_000, fps: 30 },
} as const;
/** All the copies of my camera together stay within this, so many viewers don't choke my upload. */
const UPLOAD_BUDGET = 3_000_000;

type Signal = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; view?: View };

type VoiceState = {
  roomId: string | null;
  status: 'idle' | 'joining' | 'live';
  muted: boolean;
  /** Each person's sound. */
  streams: Record<string, MediaStream>;
  /** Each person's camera: there from the start, with pictures while their camera is on. */
  videos: Record<string, MediaStream>;
  speaking: Record<string, boolean>;
  connection: Record<string, RTCPeerConnectionState>;
  cameraOn: boolean;
  cameraBusy: boolean;
  /** My own camera, for the self view. */
  localVideo: MediaStream | null;
  /** The call window is shrunk to the bar. */
  minimized: boolean;

  join: (roomId: string, options?: { video?: boolean }) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
  toggleCamera: () => Promise<void>;
  setMinimized: (minimized: boolean) => void;
  /** How big the call window shows each person now (anyone missing isn't shown). */
  setViews: (views: Record<string, View>) => void;

  onPeerJoined: (e: { roomId: string; userId: string }) => void;
  onPeerLeft: (e: { roomId: string; userId: string }) => void;
  onSignal: (e: { roomId: string; from: string; data: Signal }) => Promise<void>;
  onKicked: (e: { roomId: string; reason: string }) => void;
  onConnectionLost: () => void;
};

type Peer = {
  pc: RTCPeerConnection;
  queue: CandidateQueue;
  stopMeter?: () => void;
  /** The video slot. */
  video: RTCRtpTransceiver | null;
  /** Changes to what goes into the video slot, one at a time. */
  sending: Promise<void>;
};

type WithSetStreams = RTCRtpSender & { setStreams?: (...streams: MediaStream[]) => void };

const idle = {
  roomId: null,
  status: 'idle' as const,
  muted: false,
  streams: {},
  videos: {},
  speaking: {},
  connection: {},
  cameraOn: false,
  cameraBusy: false,
  localVideo: null,
  minimized: false,
};

let localStream: MediaStream | null = null;
let cameraTrack: MediaStreamTrack | null = null;
let stopLocalMeter: (() => void) | null = null;
const peers = new Map<string, Peer>();
/** How big each person shows my camera (as they asked). */
const wanted = new Map<string, View>();
/** How big I show each person (as the call window last said). */
let shown: Record<string, View> = {};
/** What I last told each person about that. */
const told = new Map<string, View>();

const without = <T,>(rec: Record<string, T>, key: string) => {
  const next = { ...rec };
  delete next[key];
  return next;
};

/** Sets one copy of my camera to the size, sharpness and smoothness its viewer asked for, within my upload. */
async function tune(sender: RTCRtpSender, track: MediaStreamTrack, view: Exclude<View, 'hidden'>) {
  const params = sender.getParameters();
  const encoding = params.encodings?.[0];
  if (!encoding) return;
  let asked = 0;
  for (const id of peers.keys()) {
    const v = wanted.get(id);
    if (v && v !== 'hidden') asked += QUALITY[v].bitrate;
  }
  const share = Math.min(1, UPLOAD_BUDGET / Math.max(asked, 1));
  const { width = 1280, height = 720 } = track.getSettings();
  const q = QUALITY[view];
  const size = { scaleResolutionDownBy: Math.max(1, Math.min(width, height) / q.side), maxBitrate: Math.max(100_000, Math.round(q.bitrate * share)) };
  Object.assign(encoding, size, { maxFramerate: q.fps });
  try {
    await sender.setParameters(params);
  } catch {
    // A browser without frame-rate control: size and bitrate matter most.
    const again = sender.getParameters();
    if (!again.encodings?.[0]) return;
    Object.assign(again.encodings[0], size);
    await sender.setParameters(again);
  }
}

export const useVoice = create<VoiceState>()((set, get) => {
  function closePeer(userId: string) {
    const peer = peers.get(userId);
    if (!peer) return;
    peer.stopMeter?.();
    peer.pc.close();
    peers.delete(userId);
    told.delete(userId);
    set((s) => ({
      streams: without(s.streams, userId),
      videos: without(s.videos, userId),
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
    cameraTrack?.stop();
    cameraTrack = null;
    wanted.clear();
    told.clear();
    shown = {};
    set({ ...idle });
  }

  /** Tells someone how big I show their camera, when that changed (out of sight: not at all). */
  function tell(userId: string, again = false) {
    const { roomId } = get();
    if (!roomId) return;
    const view = document.visibilityState === 'hidden' ? 'hidden' : (shown[userId] ?? 'hidden');
    if (!again && told.get(userId) === view) return;
    told.set(userId, view);
    socket.emit('voice:signal', { roomId, to: userId, data: { view } });
  }

  /** Puts my camera in someone's video slot the way they asked for it (or takes it out). */
  function sendVideo(userId: string) {
    const peer = peers.get(userId);
    if (!peer) return;
    peer.sending = peer.sending
      .then(async () => {
        const sender = peer.video?.sender;
        if (!sender || peers.get(userId) !== peer) return;
        const view = wanted.get(userId) ?? 'hidden';
        const track = view === 'hidden' ? null : cameraTrack;
        if (sender.track !== track) await sender.replaceTrack(track);
        if (track && view !== 'hidden') await tune(sender, track, view);
      })
      .catch(() => {
        // The connection is closing, or not ready for settings yet (they're set again once it connects).
      });
  }

  // My upload is shared out among everyone, so one viewer's change can change the others' copies too.
  const sendVideoToAll = () => {
    for (const id of peers.keys()) sendVideo(id);
  };

  function connect(userId: string, roomId: string, offering: boolean): Peer {
    closePeer(userId);
    const pc = createPeer();
    const peer: Peer = { pc, queue: new CandidateQueue(pc), video: null, sending: Promise.resolve() };
    peers.set(userId, peer);
    for (const track of localStream?.getTracks() ?? []) pc.addTrack(track, localStream!);
    // The one who offers makes the video slot; the other adopts it from the offer.
    if (offering) peer.video = pc.addTransceiver('video', { direction: 'sendrecv', streams: localStream ? [localStream] : [] });
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice:signal', { roomId, to: userId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      if (peers.get(userId) !== peer) return;
      if (e.track.kind === 'video') {
        set((s) => ({ videos: { ...s.videos, [userId]: new MediaStream([e.track]) } }));
        return;
      }
      const stream = new MediaStream([e.track]);
      peer.stopMeter?.();
      peer.stopMeter = watchSpeaking(stream, (speaking) =>
        set((s) => ({ speaking: { ...s.speaking, [userId]: speaking } })),
      );
      set((s) => ({ streams: { ...s.streams, [userId]: stream } }));
    };
    pc.onconnectionstatechange = () => {
      if (peers.get(userId)?.pc !== pc) return;
      set((s) => ({ connection: { ...s.connection, [userId]: pc.connectionState } }));
      // Connected (again): both ends settle what goes into the video slot.
      if (pc.connectionState === 'connected') {
        tell(userId, true);
        sendVideo(userId);
      }
    };
    tell(userId, true);
    return peer;
  }

  function watchLocalMic() {
    stopLocalMeter?.();
    if (!localStream) return;
    const me = myId();
    stopLocalMeter = watchSpeaking(localStream, (speaking) =>
      set((s) => ({ speaking: { ...s.speaking, [me]: speaking && !s.muted } })),
    );
  }

  /** Opens the camera (the chosen one) and sends it to whoever shows me. */
  async function startCamera(): Promise<boolean> {
    const cam = await getCamera();
    const track = cam.getVideoTracks()[0];
    if (get().status === 'idle') {
      track.stop();
      return false;
    }
    cameraTrack?.stop();
    cameraTrack = track;
    // Unplugged or taken away: shown as off rather than a frozen picture.
    track.onended = () => {
      if (cameraTrack === track) stopCamera();
    };
    set({ cameraOn: true, localVideo: new MediaStream([track]), minimized: false });
    sendVideoToAll();
    return true;
  }

  function stopCamera() {
    cameraTrack?.stop();
    cameraTrack = null;
    set({ cameraOn: false, localVideo: null });
    sendVideoToAll();
    const { roomId, status } = get();
    if (roomId && status === 'live') socket.emit('voice:camera', { roomId, on: false });
  }

  // A microphone chosen in settings takes effect for everyone in the room at once.
  async function switchMic() {
    if (!localStream || get().status !== 'live') return;
    try {
      const fresh = await getMicrophone();
      const track = fresh.getAudioTracks()[0];
      track.enabled = !get().muted;
      await Promise.all(
        [...peers.values()].map((p) => p.pc.getSenders().find((s) => s.track?.kind === 'audio')?.replaceTrack(track)),
      );
      stopStream(localStream);
      localStream = fresh;
      watchLocalMic();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // So does a camera.
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

  // Out of sight (another tab, the app in the background): nobody needs to send me video.
  // The Android app's camera stops out of sight too, so the others see my photo
  // instead of a frozen picture until I'm back. (A browser tab keeps its camera going.)
  document.addEventListener('visibilitychange', () => {
    for (const id of peers.keys()) tell(id);
    const { roomId, status } = get();
    if (inApp && cameraTrack && roomId && status === 'live') {
      socket.emit('voice:camera', { roomId, on: document.visibilityState !== 'hidden' });
    }
  });

  async function offerTo(userId: string, roomId: string) {
    const { pc } = connect(userId, roomId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('voice:signal', { roomId, to: userId, data: { sdp: pc.localDescription?.toJSON() } });
  }

  return {
    ...idle,

    join: async (roomId, options = {}) => {
      unlockAudio();
      const call = useCall.getState();
      if (call.phase !== 'idle') {
        toast('End your call before joining voice.');
        return;
      }
      const current = get();
      if (current.roomId === roomId && current.status !== 'idle') {
        // Already here: "with video" turns the camera on.
        if (options.video && current.status === 'live' && !current.cameraOn) await get().toggleCamera();
        return;
      }
      if (current.roomId) await get().leave();

      set({ ...idle, roomId, status: 'joining' });
      try {
        [localStream] = await Promise.all([getMicrophone(), loadIceServers()]);
        if (options.video && get().roomId === roomId) {
          try {
            await startCamera();
          } catch (err) {
            toast(`${errorMessage(err)} Joining with voice only.`, 'error');
          }
        }
        if (get().roomId !== roomId) return cleanup();
        const { peers: others } = await emitAck<{ peers: VoiceParticipant[] }>('voice:join', { roomId, muted: false, camera: !!cameraTrack });
        // Left while joining: the leave reached the server first, so say it again.
        if (get().roomId !== roomId) {
          socket.emit('voice:leave', { roomId });
          return;
        }
        set({ status: 'live' });
        blip('join');
        watchLocalMic();
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

    toggleCamera: async () => {
      const { status, cameraOn, cameraBusy } = get();
      if (status !== 'live' || cameraBusy) return;
      if (cameraOn) return stopCamera();
      set({ cameraBusy: true });
      try {
        if (await startCamera()) {
          const { roomId } = get();
          if (roomId) socket.emit('voice:camera', { roomId, on: true });
        }
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        set({ cameraBusy: false });
      }
    },

    setMinimized: (minimized) => set({ minimized }),

    setViews: (views) => {
      shown = views;
      for (const id of peers.keys()) tell(id);
    },

    onPeerJoined: ({ roomId }) => {
      if (get().roomId === roomId && get().status === 'live') blip('join');
    },

    onPeerLeft: ({ roomId, userId }) => {
      if (get().roomId !== roomId) return;
      wanted.delete(userId);
      closePeer(userId);
      sendVideoToAll();
      blip('leave');
    },

    onSignal: async ({ roomId, from, data }) => {
      if (get().roomId !== roomId) return;
      // How big they show my camera. (It can come before their offer or answer.)
      if (data.view) {
        if (!VIEWS.includes(data.view)) return;
        wanted.set(from, data.view);
        sendVideoToAll();
        return;
      }
      if (!localStream) return;
      try {
        if (data.sdp?.type === 'offer') {
          const peer = connect(from, roomId, false);
          const { pc, queue } = peer;
          await pc.setRemoteDescription(data.sdp);
          await queue.flush();
          // Adopt their video slot and open it for sending, so my camera can
          // join any time with a track swap.
          peer.video = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video') ?? null;
          if (peer.video) {
            peer.video.direction = 'sendrecv';
            (peer.video.sender as WithSetStreams).setStreams?.(localStream);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('voice:signal', { roomId, to: from, data: { sdp: pc.localDescription?.toJSON() } });
          sendVideo(from);
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
