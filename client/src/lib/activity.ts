// Tells the server whether this app or tab is actually in use, so the
// person's phone only buzzes with notifications when they aren't looking at
// Adda Khana anywhere (like a messenger that's open on a computer).
import { inApp } from './native';
import { socket } from './socket';

/** A computer left alone this long counts as away. */
const IDLE_MS = 3 * 60_000;

let lastInput = Date.now();
let reported: boolean | null = null;

function looking() {
  if (document.visibilityState !== 'visible') return false;
  // The phone app on screen is in use (the screen turns off otherwise).
  if (inApp) return true;
  return document.hasFocus() && Date.now() - lastInput < IDLE_MS;
}

function report(force = false) {
  const now = looking();
  if (!socket.connected || (!force && now === reported)) return;
  reported = now;
  socket.emit('client:state', { active: now });
}

export function watchActivity() {
  const input = () => {
    lastInput = Date.now();
    if (reported === false) report();
  };
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(event, input, { passive: true });
  }
  const back = () => {
    if (document.visibilityState === 'visible') lastInput = Date.now();
    report();
  };
  document.addEventListener('visibilitychange', back);
  window.addEventListener('focus', back);
  window.addEventListener('blur', () => report());
  socket.on('connect', () => report(true));
  // Notices a computer going idle.
  window.setInterval(() => report(), 30_000);
}
