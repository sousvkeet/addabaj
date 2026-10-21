// The Android app (android/) shows this site in a WebView and adds what a
// browser tab can't: notifications while the app is closed, ringing for
// incoming calls, calls that keep going in the background, and screen
// sharing. This is the page's side of that bridge. In a browser `inApp` is
// false and everything here does nothing.

type Bridge = {
  setTheme(color: string, dark: boolean): void;
  retry(): void;
  ready?(): void;
  ack?(id: string): void;
  pushToken?(): string;
  setUser?(json: string): void;
  callState?(json: string): void;
  clearChat?(scope: string, id: string): void;
  isRinging?(callId: string): boolean;
  setSpeaker?(on: boolean): void;
  isSpeakerOn?(): boolean;
  screenCapture?(action: 'start' | 'stop'): void;
};

/** What the app tells the page (window event "addanative"). */
export type NativeEvent =
  | { type: 'token'; token: string }
  | { type: 'answer'; callId: string; video?: boolean }
  | { type: 'decline'; callId: string }
  | { type: 'hangup' }
  | { type: 'open'; path: string }
  | { type: 'speaker'; on: boolean }
  | { type: 'screen'; state: 'denied' | 'ended' | 'failed' };

const bridge = (window as { AddaNative?: Bridge }).AddaNative;

/** Running inside the Android app. */
export const inApp = !!bridge;

const listeners = new Set<(e: NativeEvent) => void>();

// The app sends each event until the page confirms it, so a repeat is possible:
// each is handled once. Nothing is handled (or confirmed) until the page's
// listeners are set up (nativeReady), so nothing is lost while it starts.
type Delivered = NativeEvent & { __id?: number };
const inbox = () => ((window as { __addaInbox?: Delivered[] }).__addaInbox ??= []);
const handled = new Set<number>();
let listening = false;

function receive(detail: Delivered) {
  if (!detail || typeof detail.type !== 'string') return;
  if (typeof detail.__id === 'number') {
    if (handled.has(detail.__id)) return;
    handled.add(detail.__id);
    bridge?.ack?.(String(detail.__id));
  }
  listeners.forEach((fn) => fn(detail));
}

window.addEventListener('addanative', (e) => {
  if (!listening) return;
  inbox().length = 0;
  receive((e as CustomEvent<Delivered>).detail);
});

export function onNative(fn: (e: NativeEvent) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The page's listeners are set up: handle what already arrived, and ask the app for anything else held back. */
export function nativeReady() {
  listening = true;
  for (const detail of inbox().splice(0)) receive(detail);
  bridge?.ready?.();
}

/** This phone's push token ('' until Firebase has one, or when push isn't set up). */
export const pushToken = () => bridge?.pushToken?.() ?? '';

export function nativeUser(user: { id: string; name: string } | null) {
  bridge?.setUser?.(user ? JSON.stringify({ id: user.id, name: user.name }) : '');
}

/** What's running, so the app keeps it going in the background with a notification. */
export type Session =
  | { kind: 'none' }
  | { kind: 'call'; phase: string; callId: string | null; name: string; hue: number; video: boolean; startedAt: number | null }
  | { kind: 'voice'; roomId: string; name: string; startedAt: number }
  | { kind: 'live'; roomId: string; name: string; mode: string; startedAt: number };

let lastSession = '';
export function nativeSession(session: Session) {
  const json = JSON.stringify(session);
  if (json === lastSession) return;
  lastSession = json;
  bridge?.callState?.(json);
}

/** A chat was read here: drop its notifications. */
export const nativeClearChat = (scope: 'dm' | 'room', id: string) => bridge?.clearChat?.(scope, id);

/** The app is already ringing for this call (so the page stays quiet). */
export const nativeRinging = (callId: string) => !!bridge?.isRinging?.(callId);

// A call answered on the phone's call screen, joined as soon as the page has it.
let answering: string | null = null;
export const setNativeAnswer = (callId: string | null) => {
  answering = callId;
};
/** Answered on the call screen already (so the page doesn't ring first). */
export const nativeAnswering = (callId: string) => answering === callId;

/** Loudspeaker or earpiece during calls (the app picks: earpiece for voice, speaker for video). */
export const canToggleSpeaker = () => !!bridge?.setSpeaker;
export const nativeSetSpeaker = (on: boolean) => bridge?.setSpeaker?.(on);
export const nativeSpeakerOn = () => !!bridge?.isSpeakerOn?.();

// ── Screen sharing ───────────────────────────────────────────────────
//
// WebView has no getDisplayMedia. The app captures the screen with Android's
// screen recording permission, encodes it to H.264 and posts it here over a
// message port; WebCodecs decodes it into an ordinary video track, which the
// live stream then sends like any other.

type Generator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type GeneratorCtor = new (init: { kind: 'video' }) => Generator;

let stopCapture: (() => void) | null = null;

function base64Bytes(text: string) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** "avc1.PPCCLL" from the stream's sequence parameter set (NAL type 7). */
function codecFrom(bytes: Uint8Array) {
  for (let i = 0; i + 4 < bytes.length; i++) {
    const start = bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1));
    if (!start) continue;
    const at = bytes[i + 2] === 1 ? i + 3 : i + 4;
    if ((bytes[at] & 0x1f) === 7 && at + 3 < bytes.length) {
      return `avc1.${[bytes[at + 1], bytes[at + 2], bytes[at + 3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return 'avc1.42e01f';
}

function screenFromApp(): Promise<MediaStream> {
  stopCapture?.();
  return new Promise((resolve, reject) => {
    let port: MessagePort | null = null;
    let decoder: VideoDecoder | null = null;
    let track: MediaStreamTrack | null = null;
    let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let realStop: (() => void) | null = null;
    let settled = false;
    let ended = false;

    /** `byPage`: the page stopped the track itself, so it needs no "ended" event. */
    const finish = (notifyApp: boolean, byPage: boolean) => {
      if (ended) return;
      ended = true;
      window.removeEventListener('message', onPortMessage);
      off();
      if (stopCapture === stop) stopCapture = null;
      if (notifyApp) bridge?.screenCapture?.('stop');
      port?.close();
      if (decoder && decoder.state !== 'closed') decoder.close();
      void writer?.close().catch(() => {});
      realStop?.();
      // Ended on the phone: tell the page, as a browser's own "Stop sharing" would.
      if (track && !byPage) track.dispatchEvent(new Event('ended'));
    };
    const stop = () => finish(true, false);
    stopCapture = stop;

    const fail = (err: DOMException) => {
      finish(false, false);
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const off = onNative((e) => {
      if (e.type !== 'screen') return;
      if (e.state === 'denied') fail(new DOMException('Screen sharing was not allowed.', 'NotAllowedError'));
      else if (e.state === 'failed') fail(new DOMException("Couldn't start sharing your screen.", 'AbortError'));
      else finish(false, false);
    });

    const start = (width: number, height: number) => {
      const Gen = (window as { MediaStreamTrackGenerator?: GeneratorCtor }).MediaStreamTrackGenerator;
      if (Gen) {
        const gen = new Gen({ kind: 'video' });
        writer = gen.writable.getWriter();
        track = gen;
      } else {
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        track = canvas.captureStream(30).getVideoTracks()[0];
      }
      const ctx = canvas?.getContext('2d');
      decoder = new VideoDecoder({
        output: (frame) => {
          if (writer) void writer.write(frame).catch(() => frame.close());
          else {
            ctx?.drawImage(frame, 0, 0, canvas!.width, canvas!.height);
            frame.close();
          }
        },
        error: () => port?.postMessage('key'),
      });
      realStop = track.stop.bind(track);
      // The page stopping the track stops the capture on the phone too.
      track.stop = () => finish(true, true);
      settled = true;
      resolve(new MediaStream([track]));
    };

    let configured = false;
    const onFrame = (data: string) => {
      // "c|width|height" once, then "f|key|timestampUs|base64" per encoded frame.
      const parts = data.split('|');
      if (parts[0] === 'c') {
        if (!track) start(Number(parts[1]) || 1280, Number(parts[2]) || 720);
        return;
      }
      if (parts[0] === 'e') return finish(false, false);
      if (parts[0] !== 'f' || !decoder || decoder.state === 'closed') return;
      const key = parts[1] === '1';
      const bytes = base64Bytes(parts[3]);
      if (!configured) {
        if (!key) return;
        decoder.configure({ codec: codecFrom(bytes), optimizeForLatency: true });
        configured = true;
      }
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Number(parts[2]) || 0, data: bytes }));
    };

    // The app hands over a message port, then streams frames through it.
    function onPortMessage(e: MessageEvent) {
      if (e.source !== null || e.data !== 'adda-screen' || !e.ports[0]) return;
      port = e.ports[0];
      port.onmessage = (m) => typeof m.data === 'string' && onFrame(m.data);
      window.removeEventListener('message', onPortMessage);
    }
    window.addEventListener('message', onPortMessage);
    bridge!.screenCapture!('start');
  });
}

/** Gives the page a getDisplayMedia when the app can capture the screen. */
function installScreenCapture() {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!bridge?.screenCapture || !media || typeof media.getDisplayMedia === 'function') return;
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return;
  media.getDisplayMedia = () => screenFromApp();
}

installScreenCapture();
