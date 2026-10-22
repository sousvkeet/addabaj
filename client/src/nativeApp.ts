// Wires the page to the Android app (see lib/native.ts): registers the phone
// for notifications, keeps the app told what's running (call, room voice,
// live stream, a room's video) so it can keep it going in the background, and
// acts on what the person did in the app's notifications and call screen.
import { api } from './lib/api';
import { inApp, nativeReady, nativeRinging, nativeSession, nativeUser, onNative, pushToken, setNativeAnswer, type Pip, type Session } from './lib/native';
import { startTone } from './lib/sounds';
import { socket } from './lib/socket';
import { onVideoSize, videoSize } from './lib/videoSize';
import { beforeLogout, onLogout, useAuth } from './store/auth';
import { useCall } from './store/call';
import { useChat } from './store/chat';
import { useLiveStream } from './store/liveStream';
import { usePermissions } from './store/permissions';
import { usePip } from './store/pip';
import { useVoice } from './store/voice';
import { useWatching } from './store/watching';

let voiceSince = 0;
let liveSince = 0;

const SHAPES: Pip[] = [
  { w: 9, h: 16 },
  { w: 3, h: 4 },
  { w: 1, h: 1 },
  { w: 4, h: 3 },
  { w: 16, h: 9 },
];

/** The picture-in-picture window's shape for a video: the nearest common one (portrait 3:4 until its picture says). */
function pipShape(stream: MediaStream | null | undefined): Pip {
  // A remote camera's size is known once its picture is decoded; my own camera's track says.
  const decoded = stream ? videoSize(stream) : undefined;
  const settings = stream?.getVideoTracks()[0]?.getSettings();
  const width = decoded?.w ?? settings?.width;
  const height = decoded?.h ?? settings?.height;
  if (!width || !height) return SHAPES[1];
  const ratio = Math.log(width / height);
  return SHAPES.reduce((a, b) => (Math.abs(Math.log(b.w / b.h) - ratio) < Math.abs(Math.log(a.w / a.h) - ratio) ? b : a));
}

function currentSession(): Session {
  const call = useCall.getState();
  if (call.phase !== 'idle' && call.peer) {
    const video = call.cameraOn || call.peerCameraOn;
    return {
      kind: 'call',
      phase: call.phase,
      callId: call.callId,
      name: call.peer.name,
      hue: call.peer.hue,
      photo: call.peer.photo ?? null,
      video,
      startedAt: call.startedAt,
      muted: call.muted,
      // A video call shrinks into Android's picture-in-picture when you leave the app.
      ...(video && call.phase !== 'incoming' ? { pip: pipShape(call.peerCameraOn ? call.remoteStream : call.localVideo) } : {}),
    };
  }
  const chat = useChat.getState();
  const rooms = chat.rooms;
  const voice = useVoice.getState();
  if (voice.roomId && voice.status !== 'idle') {
    voiceSince ||= Date.now();
    const cameras = voice.cameraOn || (chat.voice[voice.roomId] ?? []).some((p) => p.camera);
    return {
      kind: 'voice',
      roomId: voice.roomId,
      name: rooms[voice.roomId]?.name ?? 'Room',
      startedAt: voiceSince,
      video: voice.cameraOn,
      muted: voice.muted,
      ...(cameras && voice.status === 'live' ? { pip: { w: 3, h: 4 } } : {}),
    };
  }
  voiceSince = 0;
  const host = useLiveStream.getState().host;
  if (host) {
    liveSince ||= Date.now();
    return { kind: 'live', roomId: host.roomId, name: rooms[host.roomId]?.name ?? 'Room', mode: host.mode, startedAt: liveSince };
  }
  liveSince = 0;
  const roomId = useWatching.getState().roomId;
  const watch = roomId ? useChat.getState().roomDetails[roomId]?.watch : null;
  if (roomId && watch && !watch.source.preparing && !watch.source.error && (watch.source.kind === 'file' || watch.source.kind === 'device')) {
    return { kind: 'watch', roomId, name: rooms[roomId]?.name ?? 'Room', title: watch.source.title, paused: !watch.playing };
  }
  return { kind: 'none' };
}

// A tapped notification opens its chat; held until the router is up.
let navigateTo: ((path: string) => void) | null = null;
let pendingPath: string | null = null;

export function setNativeNavigator(fn: ((path: string) => void) | null) {
  navigateTo = fn;
  if (fn && pendingPath) {
    fn(pendingPath);
    pendingPath = null;
  }
}

/**
 * While this phone streams a video file live, the app keeps the page awake
 * out of sight (a WebView pauses a hidden page's video, which would stop the
 * stream) and says when it's really out of sight: the page then counts as
 * hidden, so everything else acts as it does in the background.
 */
function sight(visible: boolean | null) {
  const was = document.visibilityState;
  if (visible === false) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  } else {
    delete (document as { visibilityState?: unknown }).visibilityState;
    delete (document as { hidden?: unknown }).hidden;
  }
  if (document.visibilityState !== was) document.dispatchEvent(new Event('visibilitychange'));
}

/** Ends whatever is running (the notification's hang-up button). */
function hangUp() {
  const call = useCall.getState();
  if (call.phase === 'incoming') return call.declineCall();
  if (call.phase !== 'idle') return call.endCall();
  if (useVoice.getState().roomId) return void useVoice.getState().leave();
  if (useLiveStream.getState().host) return void useLiveStream.getState().stop();
  if (useWatching.getState().roomId) return useWatching.getState().stop();
}

export function bindNative() {
  if (!inApp) return;

  // ── Notifications: this phone's token goes to the server while signed in ──
  const register = () => {
    const token = pushToken();
    if (token && useAuth.getState().status === 'authed') {
      void api('/push/devices', { method: 'POST', body: { token, platform: 'android' } }).catch(() => {});
    }
  };
  socket.on('connect', register);
  beforeLogout(async () => {
    const token = pushToken();
    if (token) await api('/push/devices', { method: 'DELETE', body: { token } });
  });
  onLogout(() => nativeUser(null));
  // Who's signed in, whenever it settles or changes (including a session that ran out).
  useAuth.subscribe((s, prev) => {
    if (s.status === 'loading') return;
    const changed = s.status !== prev.status || s.user?.id !== prev.user?.id || s.user?.name !== prev.user?.name;
    if (changed) nativeUser(s.status === 'authed' && s.user ? { id: s.user.id, name: s.user.name } : null);
  });
  // Already signed in when the page opened (the account kept on the phone).
  const now = useAuth.getState();
  if (now.status === 'authed' && now.user) nativeUser({ id: now.user.id, name: now.user.name });

  // ── Calls answered or declined on the phone's call screen ──
  let answer: { callId: string; video: boolean; at: number } | null = null;
  const tryAnswer = () => {
    if (!answer) return;
    if (Date.now() - answer.at > 60_000) {
      answer = null;
      setNativeAnswer(null);
      return;
    }
    const call = useCall.getState();
    if (call.phase === 'incoming' && call.callId === answer.callId) {
      const { video } = answer;
      answer = null;
      setNativeAnswer(null);
      void call.acceptCall({ video });
    }
  };
  useCall.subscribe(tryAnswer);

  onNative((e) => {
    switch (e.type) {
      case 'token':
        register();
        break;
      case 'answer':
        // The call may not have reached this page yet (the app was closed): answer when it does.
        answer = { callId: e.callId, video: !!e.video, at: Date.now() };
        setNativeAnswer(e.callId);
        tryAnswer();
        break;
      case 'decline': {
        const call = useCall.getState();
        if (call.callId === e.callId && call.phase === 'incoming') call.declineCall();
        break;
      }
      case 'hangup':
        hangUp();
        break;
      case 'sight':
        sight(e.visible);
        break;
      case 'pip':
        usePip.setState({ native: !!e.on });
        break;
      case 'mute': {
        // The picture-in-picture window's mute button: the call, or room voice.
        const call = useCall.getState();
        if (call.phase !== 'idle' && call.phase !== 'incoming') call.toggleMute();
        else if (useVoice.getState().status === 'live') useVoice.getState().toggleMute();
        break;
      }
      case 'permissions':
        // After Android's prompt, or back from the phone's settings.
        if (e.state && typeof e.state === 'object') usePermissions.getState().set(e.state);
        break;
      case 'open':
        // Only this site's own pages.
        if (typeof e.path !== 'string' || !e.path.startsWith('/') || e.path.startsWith('//')) break;
        if (navigateTo) navigateTo(e.path);
        else pendingPath = e.path;
        break;
    }
  });

  // Back on screen during an incoming call the phone isn't ringing for: ring here.
  document.addEventListener('visibilitychange', () => {
    const call = useCall.getState();
    if (document.visibilityState === 'visible' && call.phase === 'incoming' && call.callId && !nativeRinging(call.callId)) startTone('incoming');
  });

  // ── Keep the app told what's running ──
  const sync = () => nativeSession(currentSession());
  useCall.subscribe(sync);
  useVoice.subscribe(sync);
  useLiveStream.subscribe(sync);
  useWatching.subscribe(sync);
  useChat.subscribe((s, prev) => {
    if (s.rooms !== prev.rooms || s.roomDetails !== prev.roomDetails || s.voice !== prev.voice) sync();
  });
  // The other person's picture changed shape (they turned their phone): so does the floating window.
  onVideoSize(sync);

  nativeReady();
}
