// Wires the page to the Android app (see lib/native.ts): registers the phone
// for notifications, keeps the app told what's running (call, room voice,
// live stream) so it can keep it going in the background, and acts on what
// the person did in the app's notifications and call screen.
import { api } from './lib/api';
import { inApp, nativeReady, nativeRinging, nativeSession, nativeUser, onNative, pushToken, setNativeAnswer, type Session } from './lib/native';
import { startTone } from './lib/sounds';
import { socket } from './lib/socket';
import { beforeLogout, onLogout, useAuth } from './store/auth';
import { useCall } from './store/call';
import { useChat } from './store/chat';
import { useLiveStream } from './store/liveStream';
import { useVoice } from './store/voice';

let voiceSince = 0;
let liveSince = 0;

function currentSession(): Session {
  const call = useCall.getState();
  if (call.phase !== 'idle' && call.peer) {
    return {
      kind: 'call',
      phase: call.phase,
      callId: call.callId,
      name: call.peer.name,
      hue: call.peer.hue,
      video: call.cameraOn || call.peerCameraOn,
      startedAt: call.startedAt,
    };
  }
  const rooms = useChat.getState().rooms;
  const voice = useVoice.getState();
  if (voice.roomId && voice.status !== 'idle') {
    voiceSince ||= Date.now();
    return { kind: 'voice', roomId: voice.roomId, name: rooms[voice.roomId]?.name ?? 'Room', startedAt: voiceSince };
  }
  voiceSince = 0;
  const host = useLiveStream.getState().host;
  if (host) {
    liveSince ||= Date.now();
    return { kind: 'live', roomId: host.roomId, name: rooms[host.roomId]?.name ?? 'Room', mode: host.mode, startedAt: liveSince };
  }
  liveSince = 0;
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

/** Ends whatever is running (the notification's hang-up button). */
function hangUp() {
  const call = useCall.getState();
  if (call.phase === 'incoming') return call.declineCall();
  if (call.phase !== 'idle') return call.endCall();
  if (useVoice.getState().roomId) return void useVoice.getState().leave();
  if (useLiveStream.getState().host) return void useLiveStream.getState().stop();
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
  useChat.subscribe((s, prev) => {
    if (s.rooms !== prev.rooms) sync();
  });

  nativeReady();
}
