import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Maximize2, MicOff } from 'lucide-react';
import type { VoiceParticipant } from '../../lib/types';
import { useAuth } from '../../store/auth';
import { useChat } from '../../store/chat';
import { useVoice, type View } from '../../store/voice';
import { IconButton } from '../ui/Button';
import { MuteButton } from '../CallControls';
import { RoomCameraButton, SwitchCameraButton, TileVideo, useCallsOnPlayer, viewFor } from '../RoomCall';

// A room's video call over its video: while the room's video plays on its
// page, the call's cameras float over the player instead of a window covering
// it. Up to three windows, mine among them; with more cameras on, the others
// shown are the ones who spoke last. Each window moves (drag it) and resizes
// (drag a corner) on its own, always inside the player. The player itself is
// never touched, so the video plays on through all of it.

const MAX_WINDOWS = 3;
const PAD = 6;
const MIN_W = 88;
const MIN_H = 66;
/** Someone talking takes a window from whoever's been quiet at least this long. */
const QUIET_MS = 4000;
const EMPTY: VoiceParticipant[] = [];

/** A window's place, as fractions of the player (so it scales with it). */
type Box = { x: number; y: number; w: number; h: number };
type Px = Box;
type Corner = 'tl' | 'tr' | 'bl' | 'br';

/** Where each window was left, kept while the app is open (the player is rebuilt now and then). */
const placed = new Map<string, Box>();

export function PlayerCalls({ roomId }: { roomId: string }) {
  const on = useCallsOnPlayer();
  const callRoom = useVoice((s) => s.roomId);
  if (!on || callRoom !== roomId) return null;
  return <Overlay roomId={roomId} />;
}

type Shown = { id: string; key: string; name: string; stream: MediaStream | null; me: boolean; muted: boolean; silenced: boolean; speaking: boolean };

/** Within the player, at least the smallest size. */
function clamp(b: Px, W: number, H: number): Px {
  const w = Math.min(Math.max(b.w, Math.min(MIN_W, W - 2 * PAD)), W - 2 * PAD);
  const h = Math.min(Math.max(b.h, Math.min(MIN_H, H - 2 * PAD)), H - 2 * PAD);
  return { w, h, x: Math.min(Math.max(b.x, PAD), W - PAD - w), y: Math.min(Math.max(b.y, PAD), H - PAD - h) };
}

/** Kept clear at first: the call's buttons along the top, the player's own (sound, full screen) along the bottom. */
const TOP = 44;
const BOTTOM = 46;

/** Where the i-th window starts: down the right side, clear of the buttons, then a column further left. */
function initial(i: number, W: number, H: number): Px {
  const free = Math.max(MIN_H, H - TOP - BOTTOM);
  let w = Math.min(Math.max(W * 0.26, MIN_W), 280);
  let h = (w * 3) / 4;
  // Two fit one above the other where there's room; otherwise each as tall as the space.
  const fit = Math.min(h, free >= 2 * MIN_H + PAD ? (free - PAD) / 2 : free);
  if (fit < h) {
    h = Math.max(MIN_H, fit);
    w = (h * 4) / 3;
  }
  const perColumn = Math.max(1, Math.floor((free + PAD) / (h + PAD)));
  const column = Math.floor(i / perColumn);
  const row = i % perColumn;
  return clamp({ x: W - PAD - w - column * (w + PAD), y: TOP + row * (h + PAD), w, h }, W, H);
}

function Overlay({ roomId }: { roomId: string }) {
  const me = useAuth((s) => s.user);
  const meId = me?.id ?? '';
  const participants = useChat((s) => s.voice[roomId] ?? EMPTY);
  const members = useChat((s) => s.roomDetails[roomId]?.members);
  const videos = useVoice((s) => s.videos);
  const localVideo = useVoice((s) => s.localVideo);
  const cameraOn = useVoice((s) => s.cameraOn);
  const speaking = useVoice((s) => s.speaking);
  const muted = useVoice((s) => s.muted);
  const toggleMute = useVoice((s) => s.toggleMute);
  const setViews = useVoice((s) => s.setViews);
  const setOnPlayer = useVoice((s) => s.setOnPlayer);
  const setMinimized = useVoice((s) => s.setMinimized);
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const [, redraw] = useState(0);
  const [order, setOrder] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const lastSpoke = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setSize({ W: el.clientWidth, H: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Others on camera (an admin's stop counts as off), and when each last spoke.
  const byId = new Map((members ?? []).map((m) => [m.id, m]));
  // (Not waiting for their picture: it only comes once a window asks for it.)
  const onCamera = participants.filter((p) => p.userId !== meId && p.camera && !p.cameraBlocked);
  const now = Date.now();
  for (const p of onCamera) if (speaking[p.userId] && !p.silenced) lastSpoke.current.set(p.userId, now);
  const mine = cameraOn && !!localVideo;
  const room = MAX_WINDOWS - (mine ? 1 : 0);
  const ids = onCamera.map((p) => p.userId);
  const idsKey = ids.join(',');
  const talkingKey = ids.filter((id) => speaking[id]).join(',');

  // Who gets the windows: those already in one keep it, free windows go to whoever spoke last,
  // and someone talking takes the window of whoever's been quiet longest (and a while).
  useEffect(() => {
    setPicked((before) => {
      const spoke = (id: string) => lastSpoke.current.get(id) ?? 0;
      let next = before.filter((id) => ids.includes(id)).slice(0, room);
      const rest = ids.filter((id) => !next.includes(id)).sort((a, b) => spoke(b) - spoke(a));
      while (next.length < room && rest.length) next.push(rest.shift()!);
      for (const id of rest) {
        if (!speaking[id]) continue;
        const quietest = [...next].sort((a, b) => spoke(a) - spoke(b))[0];
        if (quietest !== undefined && Date.now() - spoke(quietest) > QUIET_MS) next = next.map((x) => (x === quietest ? id : x));
      }
      return next.join(',') === before.join(',') ? before : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, talkingKey, room]);

  const shown: Shown[] = [];
  if (mine && localVideo) shown.push({ id: meId, key: 'me', name: 'You', stream: localVideo, me: true, muted, silenced: false, speaking: !!speaking[meId] && !muted });
  for (const id of picked) {
    const p = onCamera.find((x) => x.userId === id);
    const stream = videos[id] ?? null;
    if (!p) continue;
    shown.push({
      id,
      key: id,
      name: byId.get(id)?.name?.split(' ')[0] ?? 'Someone',
      stream,
      me: false,
      muted: p.muted || !!p.silenced,
      silenced: !!p.silenced,
      speaking: !!speaking[id] && !p.silenced,
    });
  }
  const hiddenCount = onCamera.length - shown.filter((s) => !s.me).length;

  const { W, H } = size;
  /** A window's place in pixels now (where it was left, or where it starts). */
  const boxOf = (key: string, i: number): Px => {
    const f = placed.get(key);
    return f ? clamp({ x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H }, W, H) : initial(i, W, H);
  };
  const keep = (key: string, b: Px) => {
    placed.set(key, { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H });
    redraw((n) => n + 1);
  };
  const raise = (key: string) => setOrder((o) => [...o.filter((k) => k !== key), key]);

  // Everyone else's camera comes at the size its window shows it; those without a window, not at all.
  const views: Record<string, View> = {};
  shown.forEach((s, i) => {
    if (s.me || !W) return;
    const b = boxOf(s.key, i);
    views[s.id] = viewFor(b.w, b.h);
  });
  const viewKey = JSON.stringify(views);
  useEffect(() => {
    if (W > 0) setViews(JSON.parse(viewKey) as Record<string, View>, 'player');
  }, [viewKey, W, setViews]);
  useEffect(
    () => () => {
      setViews({}, 'player');
      // Away from the room's video (another page): the call shrinks to its bar, rather than its window opening.
      const v = useVoice.getState();
      if (v.status === 'live' && v.onPlayer) v.setMinimized(true);
    },
    [setViews],
  );

  const mirrored = localVideo?.getVideoTracks()[0]?.getSettings().facingMode !== 'environment';

  return (
    <div ref={area} className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" data-player-calls="">
      {W > 0 &&
        shown.map((s, i) => (
          <CallWindow
            key={s.key}
            person={s}
            box={boxOf(s.key, i)}
            z={10 + Math.max(0, order.indexOf(s.key))}
            mirrored={s.me && mirrored}
            area={{ W, H }}
            onChange={(b) => keep(s.key, b)}
            onRaise={() => raise(s.key)}
          />
        ))}
      <div className="pointer-events-auto absolute top-1.5 right-1.5 z-[30] flex items-center gap-1 rounded-full bg-black/55 p-1 backdrop-blur-sm" role="toolbar" aria-label="Video call">
        {hiddenCount > 0 && <span className="px-1.5 text-[11.5px] font-semibold whitespace-nowrap text-white/85">+{hiddenCount} on camera</span>}
        <MuteButton muted={muted} speaking={!!speaking[meId] && !muted} onClick={toggleMute} size={32} />
        <RoomCameraButton size={32} />
        <SwitchCameraButton size={32} />
        <IconButton
          label="Open the call"
          variant="on-dark"
          size={32}
          onClick={() => {
            setOnPlayer(false);
            setMinimized(false);
          }}
        >
          <Maximize2 size={15} />
        </IconButton>
      </div>
    </div>
  );
}

type WindowProps = {
  person: Shown;
  box: Px;
  z: number;
  mirrored: boolean;
  area: { W: number; H: number };
  onChange: (b: Px) => void;
  onRaise: () => void;
};

/** One camera's window: drag it to move, drag a corner to resize (or arrow keys, with Shift to resize). */
function CallWindow({ person, box, z, mirrored, area, onChange, onRaise }: WindowProps) {
  const start = useRef<{ x: number; y: number; box: Px; corner: Corner | null } | null>(null);
  const [active, setActive] = useState(false);

  const begin = (e: PointerEvent<HTMLElement>, corner: Corner | null) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, box, corner };
    setActive(true);
    onRaise();
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const b = s.box;
    let next: Px;
    if (!s.corner) next = { ...b, x: b.x + dx, y: b.y + dy };
    else {
      // The opposite corner stays where it is.
      const left = s.corner === 'tl' || s.corner === 'bl';
      const top = s.corner === 'tl' || s.corner === 'tr';
      const right = b.x + b.w;
      const bottom = b.y + b.h;
      let w = Math.max(MIN_W, left ? b.w - dx : b.w + dx);
      let h = Math.max(MIN_H, top ? b.h - dy : b.h + dy);
      w = Math.min(w, left ? right - PAD : area.W - PAD - b.x);
      h = Math.min(h, top ? bottom - PAD : area.H - PAD - b.y);
      next = { w, h, x: left ? right - w : b.x, y: top ? bottom - h : b.y };
    }
    onChange(clamp(next, area.W, area.H));
  };
  const end = () => {
    start.current = null;
    setActive(false);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.altKey ? 2 : 16;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    onRaise();
    onChange(clamp(e.shiftKey ? { ...box, w: box.w + d[0], h: box.h + d[1] } : { ...box, x: box.x + d[0], y: box.y + d[1] }, area.W, area.H));
  };

  const handles: Corner[] = ['tl', 'tr', 'bl', 'br'];
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${person.me ? 'Your camera' : `${person.name}'s camera`}. Drag to move it, or a corner to resize it (arrow keys move it, Shift with them resizes it).`}
      data-call-window={person.me ? 'me' : person.id}
      onPointerDown={(e) => begin(e, null)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={keys}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: active ? 29 : z, touchAction: 'none' }}
      className={`pointer-events-auto absolute overflow-hidden rounded-xl bg-deep shadow-[0_10px_30px_-8px_rgb(0_0_0/0.7)] outline-none select-none focus-visible:ring-2 focus-visible:ring-brand ${
        active ? 'cursor-grabbing' : 'cursor-grab'
      } ${person.speaking ? 'ring-2 ring-live' : 'ring-1 ring-white/15'}`}
    >
      {/* Until their picture comes, their name (it's on its way). */}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-white/70">{person.name}</span>
      {person.stream && <TileVideo stream={person.stream} mirrored={mirrored} contain={false} who={person.me ? 'me' : person.id} />}
      <span className="pointer-events-none absolute bottom-1 left-1 flex max-w-[calc(100%-8px)] items-center gap-1 rounded-full bg-black/55 px-1.5 py-px text-[11px] font-semibold text-white">
        {person.muted && <MicOff size={11} className={`shrink-0 ${person.silenced ? 'text-danger' : 'text-live'}`} aria-hidden />}
        <span className="truncate">{person.name}</span>
      </span>
      {handles.map((c) => (
        <span
          key={c}
          aria-hidden
          data-no-drag=""
          onPointerDown={(e) => begin(e, c)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          className={`absolute size-6 sm:size-4 ${c[0] === 't' ? 'top-0' : 'bottom-0'} ${c[1] === 'l' ? 'left-0' : 'right-0'} ${
            c === 'tl' || c === 'br' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'
          }`}
          style={{ touchAction: 'none' }}
        >
          {c === 'br' && <span className="absolute right-1 bottom-1 size-2 rounded-br-sm border-r-2 border-b-2 border-white/70" />}
        </span>
      ))}
    </div>
  );
}
