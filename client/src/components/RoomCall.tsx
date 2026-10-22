import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize, MicOff, Minimize, Minimize2, PhoneOff, Settings2, SwitchCamera, Video, VideoOff } from 'lucide-react';
import { useBackClose } from '../lib/back';
import type { VoiceParticipant } from '../lib/types';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { useDevices } from '../store/devices';
import { useUi } from '../store/ui';
import { useVoice, type View } from '../store/voice';
import { Avatar } from './ui/Avatar';
import { IconButton } from './ui/Button';
import { MuteButton, SoundBlocked, SpeakerButton } from './CallControls';

// A room's call with video: everyone in the room's voice, on camera or not.
// The window opens when a camera is on in the call; Back or "Shrink video"
// leaves just the voice bar, which brings it back.

const EMPTY: VoiceParticipant[] = [];
const GAP = 8;

/** How many cameras are on in my room call, mine included (0 when I'm not in one). */
export function useCallCameras() {
  const roomId = useVoice((s) => (s.status === 'live' ? s.roomId : null));
  const mine = useVoice((s) => s.cameraOn);
  const meId = useAuth((s) => s.user?.id);
  const others = useChat((s) => (roomId ? (s.voice[roomId] ?? EMPTY).filter((p) => p.camera && p.userId !== meId).length : 0));
  return roomId ? others + (mine ? 1 : 0) : 0;
}

/** The room call's window is showing (rather than just the voice bar). */
export function useRoomStageOpen() {
  const cameras = useCallCameras();
  const minimized = useVoice((s) => s.minimized);
  return cameras > 0 && !minimized;
}

/** My camera in the room call, on or off. */
export function RoomCameraButton({ size = 40 }: { size?: number }) {
  const cameraOn = useVoice((s) => s.cameraOn);
  const busy = useVoice((s) => s.cameraBusy);
  const toggle = useVoice((s) => s.toggleCamera);
  return (
    <IconButton
      label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
      aria-pressed={cameraOn}
      variant="on-dark"
      size={size}
      disabled={busy}
      onClick={() => void toggle()}
    >
      {cameraOn ? <Video size={size * 0.45} /> : <VideoOff size={size * 0.45} />}
    </IconButton>
  );
}

/** Front or back camera (or the next one along), when there's more than one. */
function SwitchCameraButton({ size = 40 }: { size?: number }) {
  const devices = useDevices((s) => s.devices);
  const localVideo = useVoice((s) => s.localVideo);
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  if (!localVideo || cameras.length < 2) return null;
  const next = () => {
    const current = localVideo.getVideoTracks()[0]?.getSettings().deviceId;
    const i = cameras.findIndex((c) => c.deviceId === current);
    useDevices.getState().choose('videoinput', cameras[(i + 1) % cameras.length].deviceId);
  };
  return (
    <IconButton label="Switch camera" variant="on-dark" size={size} onClick={next}>
      <SwitchCamera size={size * 0.45} />
    </IconButton>
  );
}

export function RoomCallStage() {
  const roomId = useVoice((s) => s.roomId);
  const open = useRoomStageOpen();
  const setMinimized = useVoice((s) => s.setMinimized);
  // Back shrinks the video to the voice bar rather than changing the screen behind it.
  useBackClose(open, () => setMinimized(true));
  if (!open || !roomId) return null;
  return <Stage roomId={roomId} />;
}

type Person = {
  id: string;
  name: string;
  hue: number;
  photo?: string | null;
  muted: boolean;
  camera: boolean;
  speaking: boolean;
  stream: MediaStream | null;
  me: boolean;
  connecting: boolean;
};

/**
 * How sharp someone's camera needs to be for a tile this size: 180p, 360p or
 * 720p. (Sharp screens count for a bit more, not all of it: a phone's small
 * tiles don't need a computer's picture.)
 */
function viewFor(w: number, h: number): View {
  const px = Math.max(w, h) * Math.min(window.devicePixelRatio || 1, 1.5);
  return px < 340 ? 'small' : px < 680 ? 'medium' : 'large';
}

/**
 * The number of columns that gives `n` tiles the most room in a w×h area:
 * landscape tiles on a wide screen, portrait ones on a phone held upright.
 * Each tile then fills its cell (the picture is cropped to fit).
 */
function fitGrid(n: number, w: number, h: number) {
  const aspect = w >= h ? 4 / 3 : 3 / 4;
  let best = { score: -1, width: w, height: h };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const width = Math.floor((w - GAP * (cols - 1)) / cols);
    const height = Math.floor((h - GAP * (rows - 1)) / rows);
    const score = Math.min(width, height * aspect);
    if (score > best.score) best = { score, width, height };
  }
  return best;
}

function Stage({ roomId }: { roomId: string }) {
  const me = useAuth((s) => s.user);
  const participants = useChat((s) => s.voice[roomId] ?? EMPTY);
  const members = useChat((s) => s.roomDetails[roomId]?.members);
  const roomName = useChat((s) => s.rooms[roomId]?.name ?? 'Room');
  const videos = useVoice((s) => s.videos);
  const localVideo = useVoice((s) => s.localVideo);
  const speaking = useVoice((s) => s.speaking);
  const connection = useVoice((s) => s.connection);
  const muted = useVoice((s) => s.muted);
  const cameraOn = useVoice((s) => s.cameraOn);
  const toggleMute = useVoice((s) => s.toggleMute);
  const leave = useVoice((s) => s.leave);
  const setMinimized = useVoice((s) => s.setMinimized);
  const setViews = useVoice((s) => s.setViews);
  const openDevices = useUi((s) => s.setDevicesOpen);
  const [focus, setFocus] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const change = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);

  // Everyone else in the order they came, then me.
  const meId = me?.id ?? '';
  const byId = new Map((members ?? []).map((m) => [m.id, m]));
  const people: Person[] = participants
    .filter((p) => p.userId !== meId)
    .map((p) => {
      const m = byId.get(p.userId);
      return {
        id: p.userId,
        name: m?.name ?? 'Someone',
        hue: m?.hue ?? 160,
        photo: m?.photo,
        muted: p.muted,
        camera: !!p.camera,
        speaking: !!speaking[p.userId],
        stream: videos[p.userId] ?? null,
        me: false,
        connecting: connection[p.userId] !== 'connected',
      };
    });
  const others = people.length;
  people.push({
    id: meId,
    name: me?.name ?? 'You',
    hue: me?.hue ?? 160,
    photo: me?.photo,
    muted,
    camera: cameraOn,
    speaking: !!speaking[meId] && !muted,
    stream: localVideo,
    me: true,
    connecting: false,
  });
  const cameras = people.filter((p) => p.camera).length;
  const focused = focus ? people.find((p) => p.id === focus) : undefined;
  // With one other person: them large, me in the corner (as in a one-to-one call).
  const pair = !focused && others === 1;
  const mirrored = localVideo?.getVideoTracks()[0]?.getSettings().facingMode !== 'environment';

  // Sizes in the layout below.
  const grid = fitGrid(people.length, box.w, box.h);
  const strip = { height: Math.round(Math.min(120, box.h * 0.24)), width: 0 };
  strip.width = Math.round(strip.height * (box.w >= box.h ? 4 / 3 : 3 / 4));
  const main = { w: box.w, h: Math.max(0, box.h - strip.height - GAP) };

  // Tell everyone how big I show them, so they send me just that (and nothing once this closes).
  const views: Record<string, View> = {};
  for (const p of people) {
    if (p.me) continue;
    views[p.id] = pair ? viewFor(box.w, box.h) : focused ? (p.id === focused.id ? viewFor(main.w, main.h) : viewFor(strip.width, strip.height)) : viewFor(grid.width, grid.height);
  }
  const viewKey = JSON.stringify(views);
  useEffect(() => {
    if (box.w > 0) setViews(JSON.parse(viewKey) as Record<string, View>);
  }, [viewKey, box.w, setViews]);
  useEffect(() => () => setViews({}), [setViews]);

  // Whoever was focused left: back to everyone.
  useEffect(() => {
    if (focus && !focused) setFocus(null);
  }, [focus, focused]);

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen?.().catch(() => {});
  };

  let layout: ReactNode;
  if (pair) {
    const [other, self] = people;
    layout = (
      <div className="relative size-full">
        <Tile person={other} fill contain />
        {self.camera && (
          <div className="absolute right-3 bottom-3 aspect-[3/4] w-[30%] max-w-[170px] min-w-[92px] md:aspect-video md:max-w-[210px]">
            <Tile person={self} fill mirrored={mirrored} small />
          </div>
        )}
      </div>
    );
  } else if (focused) {
    layout = (
      <div className="flex size-full flex-col" style={{ gap: GAP }}>
        <div className="min-h-0 flex-1">
          <Tile person={focused} fill contain mirrored={focused.me && mirrored} onClick={() => setFocus(null)} action="Back to everyone" />
        </div>
        <div className="flex shrink-0 justify-center-safe overflow-x-auto" style={{ gap: GAP, height: strip.height }}>
          {people
            .filter((p) => p.id !== focused.id)
            .map((p) => (
              <Tile key={p.id} person={p} width={strip.width} height={strip.height} mirrored={p.me && mirrored} small onClick={() => setFocus(p.id)} action={`Show ${p.me ? 'yourself' : p.name} large`} />
            ))}
        </div>
      </div>
    );
  } else {
    layout = (
      <div className="flex size-full flex-wrap content-center justify-center" style={{ gap: GAP }}>
        {people.map((p) => (
          <Tile
            key={p.id}
            person={p}
            width={grid.width}
            height={grid.height}
            mirrored={p.me && mirrored}
            small={grid.height < 160}
            onClick={() => setFocus(p.id)}
            action={`Show ${p.me ? 'yourself' : p.name} large`}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={root}
      role="region"
      aria-label={`Video call in ${roomName}`}
      className="pop-in fixed inset-0 z-[45] flex flex-col bg-deep text-on-brand md:inset-auto md:right-4 md:bottom-4 md:h-[min(560px,calc(100dvh-32px))] md:w-[min(780px,calc(100vw-440px))] md:overflow-hidden md:rounded-[28px] md:border md:border-white/10 md:shadow-[0_30px_70px_-20px_rgb(4_6_18/0.75)]"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pt-[max(12px,var(--safe-top))] pb-2">
        <div className="min-w-0 flex-1 pl-1">
          <p className="truncate font-display text-[19px] leading-tight text-white">{roomName}</p>
          <p className="truncate text-[13px] text-white/75">
            {people.length} in the call, {cameras} on camera
          </p>
        </div>
        <span className="hidden md:inline-flex">
          <IconButton label={full ? 'Exit full screen' : 'Full screen'} variant="on-dark" size={38} onClick={toggleFull}>
            {full ? <Minimize size={17} /> : <Maximize size={17} />}
          </IconButton>
        </span>
        <IconButton label="Shrink video" variant="on-dark" size={38} onClick={() => setMinimized(true)}>
          <Minimize2 size={17} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 px-2">
        <div ref={area} className="relative size-full overflow-hidden">
          {box.w > 0 && layout}
          <SoundBlocked className="inset-x-2 top-3" />
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-2.5 p-3 pb-[max(14px,var(--safe-bottom))] sm:gap-4">
        <MuteButton muted={muted} speaking={!!speaking[meId] && !muted} onClick={toggleMute} size={48} />
        <RoomCameraButton size={48} />
        <SwitchCameraButton size={48} />
        <SpeakerButton size={48} />
        <IconButton label="Audio and video settings" variant="on-dark" size={48} onClick={() => openDevices(true)}>
          <Settings2 size={21} />
        </IconButton>
        <IconButton label="Leave the call" variant="danger" size={48} onClick={() => void leave()}>
          <PhoneOff size={21} />
        </IconButton>
      </div>
    </div>
  );
}

type TileProps = {
  person: Person;
  width?: number;
  height?: number;
  /** Fills its container instead of a set size. */
  fill?: boolean;
  /** The whole picture on wider screens (a focused tile), rather than cropped to fill the tile. */
  contain?: boolean;
  mirrored?: boolean;
  /** Small: a compact name label. */
  small?: boolean;
  onClick?: () => void;
  /** What a tap does, for screen readers. */
  action?: string;
};

function Tile({ person, width, height, fill, contain, mirrored, small, onClick, action }: TileProps) {
  const side = fill ? 220 : Math.min(width ?? 220, height ?? 220);
  const avatar = Math.round(Math.max(32, Math.min(104, side * 0.42)));
  const label = person.me ? 'You' : person.name.split(' ')[0];
  const className = `relative block overflow-hidden rounded-2xl bg-white/[0.06] text-left ${fill ? 'size-full' : 'shrink-0'} ${
    person.speaking && !person.muted ? 'ring-2 ring-live' : ''
  }`;
  const content = (
    <>
      <span className={`absolute inset-0 flex items-center justify-center ${person.connecting ? 'opacity-50' : ''}`}>
        <Avatar name={person.name} hue={person.hue} photo={person.photo} size={avatar} />
      </span>
      {person.camera && person.stream && <TileVideo stream={person.stream} mirrored={!!mirrored} contain={!!contain} who={person.me ? 'me' : person.id} />}
      <span
        className={`absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/55 font-semibold text-white ${
          small ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-[12.5px]'
        }`}
      >
        {person.muted && <MicOff size={small ? 11 : 13} className="shrink-0 text-live" aria-hidden />}
        <span className="truncate">{person.connecting ? `${label}, connecting…` : label}</span>
      </span>
    </>
  );
  const style = fill ? undefined : { width, height };
  if (!onClick) {
    return (
      <div className={className} style={style}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={onClick}
      aria-label={`${person.me ? 'You' : person.name}${person.muted ? ', muted' : ''}${person.camera ? '' : ', camera off'}. ${action ?? ''}`}
    >
      {content}
    </button>
  );
}

/** A camera in a tile, shown once its first picture arrives (the photo shows until then). */
function TileVideo({ stream, mirrored, contain, who }: { stream: MediaStream; mirrored: boolean; contain: boolean; who: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    void el.play().catch(() => {});
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      data-room-video={who}
      onLoadedData={() => setReady(true)}
      className={`absolute inset-0 size-full bg-black transition-opacity duration-300 object-cover ${contain ? 'md:object-contain' : ''} ${mirrored ? '-scale-x-100' : ''} ${
        ready ? 'opacity-100' : 'opacity-0'
      }`}
    />
  );
}
