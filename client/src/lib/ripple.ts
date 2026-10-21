// Android's press ripple for anything marked .ripple (list rows, menu items,
// icon buttons), in the app only (index.css scopes it to html.app). The wave
// starts under the finger and fades when it lifts. Like Android, it waits a
// moment first, so a finger that starts scrolling a list lights nothing up.
const WAIT_MS = 80;

function wave(host: HTMLElement, x: number, y: number) {
  const box = host.getBoundingClientRect();
  const cx = x - box.left;
  const cy = y - box.top;
  // Big enough to reach the farthest corner.
  const r = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy));
  const el = document.createElement('span');
  el.className = 'ripple-wave';
  Object.assign(el.style, { width: `${r * 2}px`, height: `${r * 2}px`, left: `${cx - r}px`, top: `${cy - r}px` });
  host.appendChild(el);
  return el;
}

function fade(el: HTMLElement, after: number) {
  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 300);
  }, after);
}

export function watchRipples() {
  if (!document.documentElement.classList.contains('app')) return;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return;
      const host = (e.target as Element | null)?.closest?.('.ripple');
      if (!(host instanceof HTMLElement) || host.matches(':disabled')) return;
      const { clientX: x, clientY: y } = e;
      let el: HTMLElement | null = null;
      let started = 0;
      const timer = window.setTimeout(() => {
        el = wave(host, x, y);
        started = performance.now();
      }, WAIT_MS);
      const done = (tapped: boolean) => {
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.clearTimeout(timer);
        // A quick tap still gets its wave; a scroll that began first gets none.
        if (!el && tapped) {
          el = wave(host, x, y);
          started = performance.now();
        }
        // Let the wave grow a little before it fades.
        if (el) fade(el, Math.max(0, 160 - (performance.now() - started)));
      };
      const up = () => done(true);
      const cancel = () => done(false);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    },
    { passive: true },
  );
}
