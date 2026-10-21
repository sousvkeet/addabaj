import { create } from 'zustand';
import { errorMessage } from '../lib/api';
import { CandidateQueue, createPeer, loadIceServers, stopStream } from '../lib/rtc';
import { emitAck, socket } from '../lib/socket';
import { probeSound, SoundFix, type LocalOutput } from '../lib/soundFix';
import { onLogout, useAuth } from './auth';
import { canPickSpeaker, chosen, onDeviceChoice } from './devices';
import { toast } from './ui';

// Live streams from an admin's device. The host's browser plays a video file
// (or captures their screen) and sends it to each viewer over its own
// WebRTC connection; the host always offers, viewers only answer.
//
// The file plays in a hidden <video> that lives outside React, so the stream
// keeps going while the host moves around the app.

type Signal = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export type HostSession = {
  roomId: string;
  sessionId: string;
  mode: 'file' | 'screen';
  title: string;
  /** What viewers get, shown muted to the host as a preview. */
  preview: MediaStream;
  audio: boolean;
  viewers: Record<string, RTCPeerConnectionState>;
  playing: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  /** "Sound converted from Dolby Digital 5.1", or why there's no sound. */
  soundNote: string | null;
  /** The converted sound is catching up after a jump. */
  soundWaiting: boolean;
};

export type ViewerSession = {
  roomId: string;
  sessionId: string;
  stream: MediaStream | null;
  status: 'connecting' | 'live' | 'retrying' | 'failed';
  error?: string;
};

type LiveState = {
  host: HostSession | null;
  viewer: ViewerSession | null;

  startFile: (roomId: string, file: File, onStatus?: (text: string) => void) => Promise<void>;
  startScreen: (roomId: string) => Promise<boolean>;
  stop: () => Promise<void>;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;

  watch: (roomId: string, sessionId: string) => void;
  unwatch: () => void;

  onViewer: (e: { roomId: string; viewer: string }) => Promise<void>;
  onViewerLeft: (e: { roomId: string; viewer: string }) => void;
  onSignal: (e: { roomId: string; from: string; data: Signal }) => Promise<void>;
  onEnded: (e: { roomId: string; sessionId: string; reason: string }) => void;
  onReconnected: () => void;
};

/** Each viewer gets its own copy, so keep it sensible for a home upload. */
const VIDEO_BITRATE = 2_500_000;
const AUDIO_BITRATE = 128_000;
const MAX_HEIGHT = 720;

type HMLE = HTMLMediaElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
const proto = (typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : {}) as HMLE;

/** Chrome, Edge and Firefox (desktop and Android) can stream a file; Safari can't. */
export const canStreamFile = () => typeof proto.captureStream === 'function' || typeof proto.mozCaptureStream === 'function';
/** Screens can be shared from computers only. */
export const canShareScreen = () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/** Where WebRTC starts before it has measured the connection (it climbs slowly from its default of 0.3 Mbps). */
const START_KBPS = 1200;

/**
 * Tunes the codecs: Opus in stereo at music quality, and video that starts
 * sharp instead of spending its first half minute blurry. The offer carries
 * what the host sends, the answer what the viewer accepts, so both are tuned.
 */
function tune(sdp: string | undefined) {
  if (!sdp) return sdp;
  const addParams = (text: string, pt: string, params: Record<string, string | number>) => {
    const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    const extra = (kept: string[]) => [...kept, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)].join(';');
    if (fmtp.test(text)) {
      return text.replace(fmtp, (_line, existing: string) =>
        `a=fmtp:${pt} ${extra(existing.split(';').filter((p) => !(p.split('=')[0].trim() in params)))}`,
      );
    }
    // Codecs without parameters (VP8) get a line of their own.
    return text.replace(new RegExp(`(a=rtpmap:${pt} [^\\r\\n]*)(\\r?\\n)`), `$1$2a=fmtp:${pt} ${extra([])}$2`);
  };
  let out = sdp;
  const opus = /a=rtpmap:(\d+) opus\/48000/i.exec(out)?.[1];
  if (opus) out = addParams(out, opus, { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: AUDIO_BITRATE });
  for (const [, pt] of out.matchAll(/a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\/90000/gi)) {
    out = addParams(out, pt, { 'x-google-start-bitrate': START_KBPS });
  }
  return out;
}

/** Firefox's capture takes the sound away from the page; this plays it back to the host. */
function audible(stream: MediaStream) {
  const out = new Audio();
  out.srcObject = new MediaStream(stream.getAudioTracks());
  void out.play().catch(() => {});
  return out;
}

/** Where the host hears the file: the converted sound, Firefox's playback copy, or the video itself. */
const localOutput = (): LocalOutput | null => soundFix?.local ?? echo ?? source;

/** The host hears the file on the speaker chosen in settings, like calls. */
function toChosenSpeaker(out: LocalOutput | null) {
  if (canPickSpeaker) void out?.setSinkId?.(chosen('audiooutput')).catch(() => {});
}

// ── Host resources ──
let source: HTMLVideoElement | null = null;
let sourceUrl = '';
let sending: MediaStream | null = null;
let display: MediaStream | null = null;
/** Firefox's capture takes the sound away from the page, so it's played back here. */
let echo: HTMLAudioElement | null = null;
/** Sound the browser can't play itself (Dolby, DTS), converted in this browser. */
let soundFix: SoundFix | null = null;
const hostPeers = new Map<string, { pc: RTCPeerConnection; queue: CandidateQueue }>();
let reportTimer = 0;
let anchorTimer = 0;
let lastReport = { playing: false, position: 0, at: 0 };

// ── Viewer resources ──
let viewerPc: RTCPeerConnection | null = null;
let viewerQueue: CandidateQueue | null = null;
let hostSocket = '';
let watchdog = 0;

const without = <T,>(rec: Record<string, T>, key: string) => {
  const next = { ...rec };
  delete next[key];
  return next;
};

/** Waits for a media element event, failing on 'error' or after a while. */
function once(el: HTMLMediaElement, event: string, ms = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const done = (ok: boolean) => {
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
      window.clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error("This file can't be played in your browser. MP4 (H.264) and WebM files work best."));
    };
    const onOk = () => done(true);
    const onErr = () => done(false);
    const timer = window.setTimeout(() => done(false), ms);
    el.addEventListener(event, onOk);
    el.addEventListener('error', onErr);
  });
}

export const useLiveStream = create<LiveState>()((set, get) => {
  // ── Host ──

  function closeHostPeer(viewer: string) {
    const peer = hostPeers.get(viewer);
    if (!peer) return;
    peer.pc.close();
    hostPeers.delete(viewer);
    set((s) => (s.host ? { host: { ...s.host, viewers: without(s.host.viewers, viewer) } } : s));
  }

  function cleanupHost() {
    for (const id of [...hostPeers.keys()]) closeHostPeer(id);
    window.clearTimeout(reportTimer);
    window.clearInterval(anchorTimer);
    if (source) {
      source.pause();
      source.removeAttribute('src');
      source.load();
      source.remove();
      source = null;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = '';
    echo?.pause();
    echo = null;
    soundFix?.stop();
    soundFix = null;
    stopStream(display);
    display = null;
    sending = null;
    set({ host: null });
  }

  /** Tells the room where the file is, so viewers' progress bars follow (coalesces bursts of events). */
  function report() {
    window.clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => {
      const host = get().host;
      if (!host || !source) return;
      lastReport = { playing: !source.paused && !source.ended, position: source.currentTime, at: performance.now() };
      emitAck('live:progress', { roomId: host.roomId, ...lastReport }).catch(() => {});
    }, 250);
  }

  /** Shared setup once there is something to send. */
  async function begin(roomId: string, mode: 'file' | 'screen', title: string, duration: number | null, soundNote: string | null = null) {
    const stream = sending!;
    const audio = stream.getAudioTracks().length > 0;
    // In place before the server announces the stream, so this tab knows it's the host
    // (viewers may even ask to watch before the server's reply arrives).
    set({
      host: {
        roomId,
        sessionId: '',
        mode,
        title,
        preview: stream,
        audio,
        viewers: {},
        playing: source ? !source.paused : true,
        time: source?.currentTime ?? 0,
        duration: duration ?? 0,
        volume: localOutput()?.volume ?? 1,
        muted: localOutput()?.muted ?? false,
        soundNote,
        soundWaiting: false,
      },
    });
    const { sessionId } = await emitAck<{ sessionId: string }>('live:start', { roomId, mode, title, duration, audio });
    set((s) => (s.host ? { host: { ...s.host, sessionId } } : s));
    if (source) {
      lastReport = { playing: !source.paused, position: source.currentTime, at: performance.now() };
      report();
      // Re-anchor viewers' progress bars if playback drifts (buffering, a stall).
      anchorTimer = window.setInterval(() => {
        if (!source || !lastReport.playing) return;
        const expected = lastReport.position + (performance.now() - lastReport.at) / 1000;
        if (Math.abs(source.currentTime - expected) > 1.5) report();
      }, 5000);
    }
  }

  // ── Viewer ──

  function closeViewerPeer() {
    window.clearTimeout(watchdog);
    viewerPc?.close();
    viewerPc = null;
    viewerQueue = null;
    hostSocket = '';
  }

  /** Asks the host (through the server) for a fresh connection. */
  async function request(attempt = 0) {
    const v = get().viewer;
    if (!v) return;
    window.clearTimeout(watchdog);
    try {
      await loadIceServers();
      await emitAck('live:watch', { roomId: v.roomId, sessionId: v.sessionId });
    } catch (err) {
      const current = get().viewer;
      if (current?.sessionId !== v.sessionId) return;
      const msg = errorMessage(err);
      // "Ended" arrives with the room's new state; "full" may clear up, so keep trying quietly.
      set({ viewer: { ...current, status: 'failed', error: msg } });
      if (/full/i.test(msg)) watchdog = window.setTimeout(() => void request(attempt + 1), 15_000);
      return;
    }
    // No picture within 15 s: ask again.
    watchdog = window.setTimeout(() => {
      const current = get().viewer;
      if (current?.sessionId !== v.sessionId || current.status === 'live') return;
      set({ viewer: { ...current, status: 'retrying' } });
      void request(attempt + 1);
    }, 15_000);
  }

  return {
    host: null,
    viewer: null,

    startFile: async (roomId, file, onStatus) => {
      if (!canStreamFile()) {
        throw new Error("This browser can't stream a video file. Use Chrome, Edge or Firefox on a computer or Android phone.");
      }
      if (get().host) await get().stop();
      const el: HTMLVideoElement & HMLE = document.createElement('video');
      el.playsInline = true;
      el.preload = 'auto';
      // Off to the side but still "on screen", so the browser keeps decoding it.
      el.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';
      document.body.append(el);
      source = el;
      sourceUrl = URL.createObjectURL(file);
      try {
        const metadata = once(el, 'loadedmetadata');
        el.src = sourceUrl;
        await Promise.all([metadata, loadIceServers()]);
        const capture = el.captureStream ? el.captureStream() : el.mozCaptureStream!();
        try {
          await el.play();
        } catch {
          // Started too long after the click: play muted (viewers still get sound in Chrome) and let the host unmute.
          el.muted = true;
          await el.play();
        }
        // The tracks arrive once the file starts decoding.
        for (let i = 0; i < 30 && capture.getTracks().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
        if (!capture.getTracks().length) throw new Error("This file can't be played in your browser. MP4 (H.264) and WebM files work best.");
        for (const t of capture.getVideoTracks()) t.contentHint = 'motion';
        let soundNote: string | null = null;
        if (capture.getAudioTracks().length) {
          if (!el.captureStream) echo = audible(capture);
          sending = capture;
        } else {
          // No sound from the browser: the file has none, or its sound is a kind browsers
          // can't play (most movies: Dolby Digital, DTS). Then convert it right here.
          sending = capture;
          if (!SoundFix.supported()) {
            soundNote = 'No sound: this browser can’t play or convert this file’s sound';
          } else {
            try {
              const info = await probeSound(file, onStatus);
              soundNote = info ? `Sound converted from ${info.label}` : 'This video has no sound';
              if (info) {
                soundFix = await SoundFix.start(file, el, onStatus);
                soundFix.onWaiting = (waiting) =>
                  set((s) => (s.host && s.host.soundWaiting !== waiting ? { host: { ...s.host, soundWaiting: waiting } } : s));
                sending = new MediaStream([...capture.getVideoTracks(), soundFix.track]);
              }
            } catch (err) {
              // Stream the picture anyway, and say why there's no sound.
              console.warn('Sound conversion failed', err);
              soundFix?.stop();
              soundFix = null;
              soundNote = 'No sound: this file’s sound couldn’t be converted';
            }
          }
        }
        for (const t of sending.getAudioTracks()) t.contentHint = 'music';
        toChosenSpeaker(localOutput());
        const update = () =>
          set((s) =>
            s.host && source
              ? {
                  host: {
                    ...s.host,
                    playing: !source.paused && !source.ended,
                    time: source.currentTime,
                    duration: Number.isFinite(source.duration) ? source.duration : s.host.duration,
                    volume: localOutput()?.volume ?? source.volume,
                    muted: localOutput()?.muted ?? source.muted,
                  },
                }
              : s,
          );
        for (const ev of ['timeupdate', 'volumechange', 'durationchange']) el.addEventListener(ev, update);
        for (const ev of ['play', 'pause', 'seeked', 'ended']) {
          el.addEventListener(ev, () => {
            update();
            report();
          });
        }
        await begin(roomId, 'file', file.name.replace(/\.[^.]+$/, '') || file.name, Number.isFinite(el.duration) ? el.duration : null, soundNote);
      } catch (err) {
        cleanupHost();
        throw err;
      }
    },

    startScreen: async (roomId) => {
      if (!canShareScreen()) throw new Error("This device can't share its screen. Use a computer with Chrome, Edge or Firefox.");
      if (get().host) await get().stop();
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 } },
          audio: true,
          // Chrome-only hints: don't offer this tab itself, offer system sound.
          ...({ selfBrowserSurface: 'exclude', systemAudio: 'include', surfaceSwitching: 'include' } as object),
        });
      } catch (err) {
        const name = (err as DOMException)?.name;
        if (name === 'NotAllowedError' || name === 'AbortError') return false; // cancelled in the picker
        throw new Error("Couldn't start sharing your screen.");
      }
      display = stream;
      sending = stream;
      const video = stream.getVideoTracks()[0];
      if (video) video.contentHint = 'motion';
      for (const t of stream.getAudioTracks()) t.contentHint = 'music';
      const surface = (video?.getSettings() as { displaySurface?: string }).displaySurface;
      const what = surface === 'browser' ? 'tab' : surface === 'window' ? 'window' : 'screen';
      const name = useAuth.getState().user?.name ?? 'My';
      // Stopping from the browser's own "Stop sharing" bar ends the stream.
      video?.addEventListener('ended', () => {
        if (get().host?.mode === 'screen') void get().stop();
      });
      try {
        await loadIceServers();
        await begin(roomId, 'screen', `${name}'s ${what}`, null);
        return true;
      } catch (err) {
        cleanupHost();
        throw err;
      }
    },

    stop: async () => {
      const host = get().host;
      cleanupHost();
      if (host) await emitAck('live:stop', { roomId: host.roomId }).catch(() => {});
    },

    play: () => {
      if (source) void source.play().catch(() => {});
    },
    pause: () => source?.pause(),
    seek: (seconds) => {
      if (source && Number.isFinite(seconds)) source.currentTime = Math.max(0, Math.min(seconds, source.duration || seconds));
    },
    setVolume: (volume) => {
      const out = localOutput();
      if (!out) return;
      out.volume = volume;
      out.muted = volume === 0;
      set((s) => (s.host ? { host: { ...s.host, volume, muted: volume === 0 } } : s));
    },
    setMuted: (muted) => {
      const out = localOutput();
      if (!out) return;
      out.muted = muted;
      set((s) => (s.host ? { host: { ...s.host, muted } } : s));
    },

    watch: (roomId, sessionId) => {
      const v = get().viewer;
      if (v?.sessionId === sessionId && v.status !== 'failed') return;
      closeViewerPeer();
      set({ viewer: { roomId, sessionId, stream: null, status: 'connecting' } });
      void request();
    },

    unwatch: () => {
      const v = get().viewer;
      if (!v) return;
      closeViewerPeer();
      socket.emit('live:leave', { roomId: v.roomId });
      set({ viewer: null });
    },

    onViewer: async ({ roomId, viewer }) => {
      const host = get().host;
      if (!host || host.roomId !== roomId || !sending) return;
      closeHostPeer(viewer);
      const pc = createPeer();
      const queue = new CandidateQueue(pc);
      hostPeers.set(viewer, { pc, queue });
      for (const track of sending.getTracks()) {
        const height = track.kind === 'video' ? (track.getSettings().height ?? 0) : 0;
        pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [sending],
          sendEncodings: [
            track.kind === 'video'
              ? { maxBitrate: VIDEO_BITRATE, maxFramerate: 30, scaleResolutionDownBy: height > MAX_HEIGHT ? height / MAX_HEIGHT : 1 }
              : { maxBitrate: AUDIO_BITRATE },
          ],
        });
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('live:signal', { roomId, to: viewer, data: { candidate: e.candidate.toJSON() } });
      };
      pc.onconnectionstatechange = () => {
        if (hostPeers.get(viewer)?.pc !== pc) return;
        set((s) => (s.host ? { host: { ...s.host, viewers: { ...s.host.viewers, [viewer]: pc.connectionState } } } : s));
        // A dead link is dropped; the viewer asks again if they're still there.
        if (pc.connectionState === 'failed') closeHostPeer(viewer);
      };
      set((s) => (s.host ? { host: { ...s.host, viewers: { ...s.host.viewers, [viewer]: 'new' } } } : s));
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription({ type: 'offer', sdp: tune(offer.sdp) });
        socket.emit('live:signal', { roomId, to: viewer, data: { sdp: pc.localDescription?.toJSON() } });
      } catch (err) {
        console.warn('Live stream offer failed', err);
        closeHostPeer(viewer);
      }
    },

    onViewerLeft: ({ roomId, viewer }) => {
      if (get().host?.roomId === roomId) closeHostPeer(viewer);
    },

    onSignal: async ({ roomId, from, data }) => {
      try {
        // Answers and candidates from my viewers.
        const peer = get().host?.roomId === roomId ? hostPeers.get(from) : undefined;
        if (peer) {
          if (data.sdp?.type === 'answer') {
            await peer.pc.setRemoteDescription(data.sdp);
            await peer.queue.flush();
          } else if (data.candidate) {
            await peer.queue.add(data.candidate);
          }
          return;
        }
        // An offer or candidates from the host I'm watching.
        const v = get().viewer;
        if (!v || v.roomId !== roomId) return;
        if (data.sdp?.type === 'offer') {
          closeViewerPeer();
          const pc = createPeer();
          viewerPc = pc;
          viewerQueue = new CandidateQueue(pc);
          hostSocket = from;
          // Stuck connecting: ask for a fresh connection.
          watchdog = window.setTimeout(() => {
            const current = get().viewer;
            if (viewerPc !== pc || pc.connectionState === 'connected' || !current) return;
            set({ viewer: { ...current, status: 'retrying' } });
            void request();
          }, 15_000);
          pc.ontrack = (e) => {
            const stream = e.streams[0] ?? new MediaStream([e.track]);
            set((s) => (s.viewer && viewerPc === pc ? { viewer: { ...s.viewer, stream } } : s));
          };
          pc.onicecandidate = (e) => {
            if (e.candidate) socket.emit('live:signal', { roomId, to: hostSocket, data: { candidate: e.candidate.toJSON() } });
          };
          pc.onconnectionstatechange = () => {
            if (viewerPc !== pc) return;
            const state = pc.connectionState;
            const current = get().viewer;
            if (!current) return;
            if (state === 'connected') {
              window.clearTimeout(watchdog);
              set({ viewer: { ...current, status: 'live', error: undefined } });
            } else if (state === 'failed' || state === 'disconnected') {
              set({ viewer: { ...current, status: 'retrying' } });
              // "disconnected" often heals by itself; give it a moment first.
              window.clearTimeout(watchdog);
              watchdog = window.setTimeout(
                () => {
                  if (viewerPc === pc && pc.connectionState !== 'connected') void request();
                },
                state === 'failed' ? 500 : 4000,
              );
            }
          };
          await pc.setRemoteDescription(data.sdp);
          await viewerQueue.flush();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: tune(answer.sdp) });
          socket.emit('live:signal', { roomId, to: from, data: { sdp: pc.localDescription?.toJSON() } });
        } else if (data.candidate && from === hostSocket) {
          await viewerQueue?.add(data.candidate);
        }
      } catch (err) {
        console.warn('Live stream signalling failed', err);
      }
    },

    onEnded: ({ sessionId, reason }) => {
      if (get().host?.sessionId === sessionId) {
        cleanupHost();
        if (reason === 'replaced') toast('Your live stream ended because the video was changed.');
        else if (reason === 'stopped') toast('An admin ended your live stream.');
        else if (reason === 'lost') toast('Your live stream ended because your connection dropped.', 'error');
      }
      if (get().viewer?.sessionId === sessionId) {
        closeViewerPeer();
        set({ viewer: null });
      }
    },

    onReconnected: () => {
      const host = get().host;
      if (host) {
        emitAck('live:resume', { roomId: host.roomId, sessionId: host.sessionId }).catch((err) => {
          cleanupHost();
          toast(errorMessage(err), 'error');
        });
      }
      // The server knows viewers by connection, so ask again on the new one.
      const v = get().viewer;
      if (v) {
        closeViewerPeer();
        set({ viewer: { ...v, status: 'retrying' } });
        void request();
      }
    },
  };
});

// Closing or reloading the tab ends the stream right away instead of after the grace period.
window.addEventListener('pagehide', () => {
  const host = useLiveStream.getState().host;
  if (host) socket.emit('live:stop', { roomId: host.roomId });
});

// A new speaker picked while streaming takes effect at once.
onDeviceChoice((kind) => {
  if (kind === 'audiooutput') toChosenSpeaker(localOutput());
});

onLogout(() => {
  if (useLiveStream.getState().host) void useLiveStream.getState().stop();
  useLiveStream.getState().unwatch();
});
