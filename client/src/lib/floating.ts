import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

// A window floating over the app, as in other messengers: drag it anywhere
// (a floating call settles at the nearest side), pinch it with two fingers or
// drag a corner to resize it, tap it to open what it's for. Where it was and
// how big are remembered for next time.

/** Its left and top (CSS pixels) and size. */
export type Box = { x: number; y: number; w: number; h: number };
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
type Insets = { top: number; right: number; bottom: number; left: number };

type Options = {
  /** Remembered under this name. */
  name: string;
  /** Where it starts the first time, in a viewport this big. */
  initial: (vw: number, vh: number) => Box;
  /** Width over height, kept while resizing (null: any shape). */
  aspect: number | null;
  min: { w: number; h: number };
  max: (vw: number, vh: number) => { w: number; h: number };
  /** Room to leave around it (system bars, the tab bar). */
  insets?: () => Insets;
  /** After moving, it settles at the nearest side. */
  snap?: boolean;
  /** A tap: no drag, one finger. */
  onTap?: () => void;
};

const KEY = (name: string) => `adda-floating-${name}`;
/** A press that moves less than this is a tap. */
const SLOP = 6;
const MARGIN = 10;
const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function load(name: string): Box | null {
  try {
    const b = JSON.parse(localStorage.getItem(KEY(name)) ?? 'null');
    return b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? b : null;
  } catch {
    return null;
  }
}
function save(name: string, box: Box) {
  try {
    localStorage.setItem(KEY(name), JSON.stringify(box));
  } catch {
    /* storage unavailable */
  }
}

type Gesture =
  | { kind: 'drag'; x: number; y: number; start: Box; moved: boolean; at: number }
  | { kind: 'pinch'; dist: number; start: Box }
  | { kind: 'resize'; corner: Corner; x: number; y: number; start: Box };

export function useFloating({ name, initial, aspect, min, max, insets, snap = false, onTap }: Options) {
  const opts = useRef({ initial, aspect, min, max, insets, snap, onTap });
  opts.current = { initial, aspect, min, max, insets, snap, onTap };

  /** Within its limits and on screen; at its side when it snaps. */
  const fit = (b: Box, settle = false): Box => {
    const { aspect, min, max, insets, snap } = opts.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ins = insets?.() ?? ZERO;
    const most = max(vw, vh);
    let w = Math.min(Math.max(b.w, min.w), most.w, vw - ins.left - ins.right - 2 * MARGIN);
    let h = aspect ? w / aspect : Math.min(Math.max(b.h, min.h), most.h, vh - ins.top - ins.bottom - 2 * MARGIN);
    if (aspect && h > vh - ins.top - ins.bottom - 2 * MARGIN) {
      h = vh - ins.top - ins.bottom - 2 * MARGIN;
      w = h * aspect;
    }
    const left = ins.left + MARGIN;
    const right = vw - ins.right - MARGIN - w;
    const top = ins.top + MARGIN;
    const bottom = vh - ins.bottom - MARGIN - h;
    let x = Math.min(Math.max(b.x, left), Math.max(left, right));
    const y = Math.min(Math.max(b.y, top), Math.max(top, bottom));
    if (snap && settle) x = x + w / 2 < vw / 2 ? left : right;
    return { x, y, w, h };
  };

  /** Where the person left it (or its default place), as it fits now. */
  const placed = () => fit(load(name) ?? opts.current.initial(window.innerWidth, window.innerHeight), true);
  const [box, setBox] = useState<Box>(placed);
  const [settling, setSettling] = useState(false);
  const [active, setActive] = useState(false);
  /** Where it is now: pointer events can come faster than renders. */
  const live = useRef(box);
  const put = (b: Box) => {
    live.current = b;
    setBox(b);
  };
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  // A smaller window (rotating the phone, resizing the browser) keeps it on
  // screen; bigger again, it's back where it was left. Another name (a phone
  // turned into a tablet's width) is another remembered place.
  useLayoutEffect(() => {
    put(placed());
    const onResize = () => {
      if (!gesture.current) put(placed());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // placed reads the latest options from a ref.
  }, [name]);

  useEffect(() => {
    if (!settling) return;
    const id = window.setTimeout(() => setSettling(false), 260);
    return () => window.clearTimeout(id);
  }, [settling]);

  function finish(tap: boolean) {
    gesture.current = null;
    setActive(false);
    if (tap) return opts.current.onTap?.();
    const settled = fit(live.current, true);
    setSettling(true);
    put(settled);
    save(name, settled);
  }

  const span = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  /** On what it's dragged by: the whole of a floating call, a window's title bar. */
  const drag = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // Its own buttons work as usual.
      if ((e.target as Element).closest('button, a, input, [data-no-drag]')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        gesture.current = { kind: 'pinch', dist: span(), start: live.current };
      } else if (pointers.current.size === 1) {
        gesture.current = { kind: 'drag', x: e.clientX, y: e.clientY, start: live.current, moved: false, at: Date.now() };
      }
      setActive(true);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      if (!g) return;
      if (g.kind === 'pinch' && pointers.current.size >= 2) {
        // Bigger or smaller about its middle.
        const scale = span() / Math.max(1, g.dist);
        const w = g.start.w * scale;
        const h = g.start.h * scale;
        put(fit({ x: g.start.x + (g.start.w - w) / 2, y: g.start.y + (g.start.h - h) / 2, w, h }));
      } else if (g.kind === 'drag') {
        const dx = e.clientX - g.x;
        const dy = e.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < SLOP) return;
        g.moved = true;
        put(fit({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }));
      }
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (!pointers.current.delete(e.pointerId)) return;
      const g = gesture.current;
      if (pointers.current.size > 0) {
        // One finger of a pinch lifted: carry on dragging with the other, from where things are.
        if (g?.kind === 'pinch') {
          const [p] = [...pointers.current.values()];
          gesture.current = { kind: 'drag', x: p.x, y: p.y, start: live.current, moved: true, at: 0 };
        }
        return;
      }
      finish(g?.kind === 'drag' && !g.moved && Date.now() - g.at < 600);
    },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
      if (pointers.current.delete(e.pointerId) && pointers.current.size === 0) finish(false);
    },
  };

  /** A corner to drag for a bigger or smaller window. */
  const resize = (corner: Corner) => ({
    'data-no-drag': '',
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.current = { kind: 'resize', corner, x: e.clientX, y: e.clientY, start: live.current };
      setActive(true);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (g?.kind !== 'resize') return;
      const { aspect } = opts.current;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      const left = corner === 'tl' || corner === 'bl';
      const top = corner === 'tl' || corner === 'tr';
      let w = g.start.w + (left ? -dx : dx);
      let h = aspect ? w / aspect : g.start.h + (top ? -dy : dy);
      const sized = fit({ ...g.start, w, h });
      w = sized.w;
      h = sized.h;
      // The opposite corner stays put.
      put(fit({ x: left ? g.start.x + g.start.w - w : g.start.x, y: top ? g.start.y + g.start.h - h : g.start.y, w, h }));
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      e.stopPropagation();
      if (gesture.current?.kind === 'resize') finish(false);
    },
    onPointerCancel: () => {
      if (gesture.current?.kind === 'resize') finish(false);
    },
  });

  const style: CSSProperties = {
    position: 'fixed',
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    transition: settling ? 'left 220ms cubic-bezier(0.2, 0.8, 0.2, 1), top 220ms cubic-bezier(0.2, 0.8, 0.2, 1), width 220ms, height 220ms' : 'none',
    touchAction: 'none',
  };

  /** Puts it back to its default place and size. */
  const reset = () => {
    const b = fit(opts.current.initial(window.innerWidth, window.innerHeight), true);
    setSettling(true);
    put(b);
    save(name, b);
  };

  return { box, style, drag, resize, active, reset };
}
