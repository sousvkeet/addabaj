import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MicOff } from 'lucide-react';
import { useFloating, type Corner } from '../lib/floating';
import { useMedia } from '../lib/useMedia';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { usePip } from '../store/pip';
import { useVoice } from '../store/voice';
import { useCallPip, useCallVideo } from './CallUi';
import { VideoView } from './CallControls';
import { useMainPerson, useRoomPip, useRoomStageOpen, viewFor } from './RoomCall';
import { Avatar } from './ui/Avatar';

// A video call shrunk to its bar keeps its video floating over the app, as in
// other messengers: the other person (or, in a room, whoever last spoke on
// camera). Drag it anywhere and it settles at the nearest side; pinch it, or
// drag its inner corner, to make it bigger or smaller; tap it for the call.
// In the Android app, leaving the app turns the call into Android's own
// picture-in-picture window, which this page then fills with just the video.

/** The room left free at the top and bottom: the system bars, and on a phone the call bar. */
let probe: HTMLDivElement | null = null;
function safeArea() {
  probe ??= Object.assign(document.createElement('div'), { ariaHidden: 'true' });
  if (!probe.isConnected) {
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)';
    document.body.appendChild(probe);
  }
  const s = getComputedStyle(probe);
  return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0 };
}

export function CallPip() {
  const native = usePip((s) => s.native);
  const callPip = useCallPip();
  const roomPip = useRoomPip();
  const callVideo = useCallVideo();
  const roomCall = useRoomStageOpen() || roomPip;
  // Android's own picture-in-picture: the page is the floating window.
  if (native) {
    if (callVideo) return <NativePip>{<OneToOneVideo />}</NativePip>;
    if (roomCall) return <NativePip>{<RoomVideo small={false} />}</NativePip>;
    return null;
  }
  if (callPip) return <OneToOnePip />;
  if (roomPip) return <RoomPip />;
  return null;
}

/** The floating frame, wherever it was left and as big as it was made. */
function Floating({ label, onOpen, children }: { label: string; onOpen: () => void; children: ReactNode }) {
  const phone = useMedia('(max-width: 767px)');
  const aspect = phone ? 3 / 4 : 4 / 3;
  const f = useFloating({
    name: phone ? 'call-pip-phone' : 'call-pip',
    aspect,
    initial: (vw, vh) => {
      const w = phone ? 120 : 260;
      const h = w / aspect;
      return { x: vw - w, y: phone ? vh - h - 150 : vh - h - 24, w, h };
    },
    min: { w: 96, h: 72 },
    max: (vw, vh) => ({ w: phone ? vw * 0.75 : Math.min(560, vw * 0.5), h: vh * 0.7 }),
    insets: () => {
      const safe = safeArea();
      return { top: safe.top + (phone ? 72 : 0), right: 0, bottom: safe.bottom, left: 0 };
    },
    snap: true,
    onTap: onOpen,
  });
  // The corner facing into the screen resizes it.
  const onRight = f.box.x + f.box.w / 2 > window.innerWidth / 2;
  const corner: Corner = onRight ? 'tl' : 'tr';
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      data-call-pip=""
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      style={f.style}
      {...f.drag}
      className={`pop-in z-[42] overflow-hidden rounded-[18px] border border-white/15 bg-deep text-on-brand shadow-[0_18px_44px_-12px_rgb(4_6_18/0.75)] outline-none select-none focus-visible:ring-2 focus-visible:ring-live ${
        f.active ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      {children}
      <span
        {...f.resize(corner)}
        aria-hidden
        title="Drag to resize"
        className={`absolute top-0 z-[1] flex size-8 items-start p-1.5 ${corner === 'tl' ? 'left-0 cursor-nwse-resize justify-start' : 'right-0 cursor-nesw-resize justify-end'}`}
      >
        <span className={`block size-3 border-white/80 ${corner === 'tl' ? 'rounded-tl-[5px] border-t-2 border-l-2' : 'rounded-tr-[5px] border-t-2 border-r-2'}`} />
      </span>
    </div>
  );
}

/** Android's picture-in-picture window: the page shows only the video, edge to edge. */
function NativePip({ children }: { children: ReactNode }) {
  return (
    <div data-native-pip="" className="fixed inset-0 z-[200] overflow-hidden bg-deep text-on-brand">
      {children}
    </div>
  );
}

/** What the call is doing while it isn't simply on: over its picture, or under the photo. */
function Status({ text, over }: { text: string; over: boolean }) {
  return (
    <span
      className={
        over
          ? 'absolute inset-x-1.5 top-1/2 -translate-y-1/2 truncate rounded-full bg-black/60 px-2 py-0.5 text-center text-[12px] font-semibold text-white'
          : 'max-w-full truncate px-1.5 text-[12px] font-semibold text-white/85'
      }
    >
      {text}
    </span>
  );
}

function NameTag({ name, muted }: { name: string; muted: boolean }) {
  return (
    <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/55 px-1.5 py-px text-[11.5px] font-semibold text-white">
      {muted && <MicOff size={11} className="shrink-0 text-live" aria-hidden />}
      <span className="truncate">{name}</span>
    </span>
  );
}

function OneToOnePip() {
  const peer = useCall((s) => s.peer);
  const setMinimized = useCall((s) => s.setMinimized);
  if (!peer) return null;
  return (
    <Floating label={`Video call with ${peer.name}. Open the call`} onOpen={() => setMinimized(false)}>
      <OneToOneVideo />
    </Floating>
  );
}

/** The other person's camera, or their photo while it's off. */
function OneToOneVideo() {
  const peer = useCall((s) => s.peer);
  const phase = useCall((s) => s.phase);
  const peerCameraOn = useCall((s) => s.peerCameraOn);
  const peerMuted = useCall((s) => s.peerMuted);
  const remoteStream = useCall((s) => s.remoteStream);
  const reconnecting = useCall((s) => s.reconnecting);
  if (!peer) return null;
  const video = peerCameraOn && phase !== 'outgoing' && remoteStream?.getVideoTracks().length ? remoteStream : null;
  const status = phase === 'outgoing' ? 'Calling…' : phase === 'connecting' ? 'Connecting…' : reconnecting ? 'Reconnecting…' : null;
  return (
    <>
      {video ? (
        <>
          <VideoView stream={video} remote className="pointer-events-none size-full object-cover" />
          {status && <Status text={status} over />}
        </>
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-2 bg-white/[0.06]">
          <Avatar name={peer.name} hue={peer.hue} photo={peer.photo} size={56} />
          {status && <Status text={status} over={false} />}
        </span>
      )}
      <NameTag name={peer.name.split(' ')[0]} muted={peerMuted} />
    </>
  );
}

function RoomPip() {
  const roomId = useVoice((s) => s.roomId);
  const roomName = useChat((s) => (roomId ? s.rooms[roomId]?.name : undefined) ?? 'the room');
  const setMinimized = useVoice((s) => s.setMinimized);
  return (
    <Floating label={`Video call in ${roomName}. Open the call`} onOpen={() => setMinimized(false)}>
      <RoomVideo small />
    </Floating>
  );
}

/** Whoever the room call's small view shows; it asks them for a picture just this big. */
function RoomVideo({ small }: { small: boolean }) {
  const roomId = useVoice((s) => s.roomId);
  const main = useMainPerson(roomId);
  const meId = useAuth((s) => s.user?.id ?? '');
  const me = useAuth((s) => s.user);
  const member = useChat((s) => (roomId && main ? s.roomDetails[roomId]?.members.find((m) => m.id === main) : undefined));
  const participant = useChat((s) => (roomId && main ? s.voice[roomId]?.find((p) => p.userId === main) : undefined));
  const video = useVoice((s) => (main && main !== meId ? s.videos[main] : s.localVideo));
  const muted = useVoice((s) => s.muted);
  const reconnecting = useVoice((s) => s.reconnecting);
  const setViews = useVoice((s) => s.setViews);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 120, h: 160 });

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Only the person shown is asked for a picture (the call's window asks again when it opens).
  const view = main && main !== meId ? viewFor(size.w, size.h) : null;
  useEffect(() => {
    if (main && view) setViews({ [main]: view }, 'pip');
    else setViews({}, 'pip');
  }, [main, view, setViews]);
  useEffect(() => () => setViews({}, 'pip'), [setViews]);

  const isMe = main === meId;
  const person = isMe ? me : member;
  const name = isMe ? 'You' : (person?.name.split(' ')[0] ?? 'Someone');
  const camera = isMe ? !!video : !!participant?.camera;
  return (
    <div ref={frame} className="relative size-full">
      {camera && video?.getVideoTracks().length ? (
        <>
          <VideoView stream={video} remote={!isMe} mirrored={isMe} className="pointer-events-none size-full object-cover" />
          {reconnecting && <Status text="Reconnecting…" over />}
        </>
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-2 bg-white/[0.06]">
          {person && <Avatar name={person.name} hue={person.hue} photo={person.photo} size={small ? 56 : 88} />}
          {reconnecting && <Status text="Reconnecting…" over={false} />}
        </span>
      )}
      <NameTag name={name} muted={isMe ? muted : !!participant?.muted} />
    </div>
  );
}
