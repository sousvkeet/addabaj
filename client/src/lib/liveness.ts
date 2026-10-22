import { useSyncExternalStore } from 'react';
import { socket } from './socket';

// Phones often lose their connection silently (screen lock, app switch,
// Wi-Fi to mobile data): neither side is told, and updates sent meanwhile
// are lost until the heartbeat gives up. Whenever the person comes back or
// touches the screen, quietly check the line and reconnect at once if it's dead.

/** On a tap, probe only if the server has been quiet this long (it pings every 8 s). */
const QUIET_MS = 2_000;
/** At most one probe this often; each is one tiny message. */
const PROBE_EVERY_MS = 3_000;
const PROBE_TIMEOUT_MS = 3_000;

let lastHeard = Date.now();
let lastProbe = 0;
let probing = false;
const heard = () => {
  lastHeard = Date.now();
};

/** `returning`: the person just came back to the app, so always check. */
export async function checkConnection(isAuthed: () => boolean, returning = false) {
  if (!isAuthed()) return;
  if (!socket.connected) {
    if (!socket.active) socket.connect();
    return;
  }
  const now = Date.now();
  if (probing || now - lastProbe < PROBE_EVERY_MS) return;
  if (!returning && now - lastHeard < QUIET_MS) return;
  lastProbe = now;
  probing = true;
  const alive = await new Promise<boolean>((resolve) =>
    socket.timeout(PROBE_TIMEOUT_MS).emit('time:now', {}, (err: unknown) => resolve(!err)),
  );
  probing = false;
  if (alive) heard();
  // Dead line: drop it so Socket.IO reconnects now, which also re-syncs the screen.
  else socket.io.engine?.close();
}

export function watchConnection(isAuthed: () => boolean) {
  socket.io.on('ping', heard);
  socket.io.on('packet', heard);
  socket.on('connect', heard);
  const check = () => void checkConnection(isAuthed);
  const returning = () => void checkConnection(isAuthed, true);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && returning());
  window.addEventListener('online', returning);
  // Switched networks (Wi-Fi to mobile data, or back): the old line is probably dead, so check it now.
  (navigator as { connection?: EventTarget }).connection?.addEventListener?.('change', returning);
  // The phone says the network is gone: drop the line now rather than wait for
  // the heartbeat to notice, so nothing seems sent that wasn't.
  window.addEventListener('offline', () => socket.connected && socket.io.engine?.close());
  window.addEventListener('focus', returning);
  window.addEventListener('pageshow', returning);
  window.addEventListener('pointerdown', check, { passive: true });
  window.addEventListener('keydown', check);
}

// ── "Reconnecting…" notice ────────────────────────────────────────────

const listeners = new Set<() => void>();
let connected = socket.connected;
const notify = () => listeners.forEach((fn) => fn());
socket.on('connect', () => {
  connected = true;
  notify();
});
socket.on('disconnect', () => {
  connected = false;
  notify();
});

/** True while the app has no live connection to the server. */
export function useOffline() {
  return !useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => connected,
  );
}
