import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { X } from 'lucide-react';
import { useChat } from '../../store/chat';
import { useLiveStream } from '../../store/liveStream';
import { playerHolder, setDockArea, useWatching } from '../../store/watching';
import { IconButton } from '../ui/Button';
import { WatchStage } from './WatchStage';

/** Where the room's video shows on the room's page (the player itself lives in WatchDock). */
export function WatchSlot({ roomId, onChange }: { roomId: string; onChange: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useLayoutEffect(() => {
    const el = ref.current!;
    useWatching.getState().attach(roomId, el, () => change.current());
    return () => useWatching.getState().detach(el);
  }, [roomId]);
  return <div ref={ref} className="shrink-0" />;
}

/**
 * The video of the room I'm watching. On the room's page it shows there (see
 * WatchSlot); anywhere else it carries on in a small player, which opens the
 * room when tapped and stops (just for me) with its close button.
 */
export function WatchDock() {
  const roomId = useWatching((s) => s.roomId);
  const slot = useWatching((s) => s.slot);
  const onChange = useWatching((s) => s.onChange);
  const moves = useWatching((s) => s.moves);
  const stop = useWatching((s) => s.stop);
  const room = useChat((s) => (roomId ? s.roomDetails[roomId] : undefined));
  const name = useChat((s) => (roomId ? s.rooms[roomId]?.name : undefined));
  const gone = useChat((s) => !!roomId && s.bootstrapped && !s.rooms[roomId]);
  // My own live stream keeps going without a player (its bar shows elsewhere).
  const hosting = useLiveStream((s) => !!roomId && s.host?.roomId === roomId);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const watch = room?.watch ?? null;
  // On a phone: above the message box in a chat, above the round button on a list.
  const inThread = /^\/(chats|rooms|admin)\/[^/]+/.test(pathname);

  // Nothing to play any more (stopped, or the room is gone for me).
  useEffect(() => {
    if (roomId && (gone || (room && !watch))) stop();
  }, [roomId, gone, room, watch, stop]);

  const docked = !!room && !!watch && !slot && !hosting;
  const open = () => roomId && navigate(`/rooms/${roomId}`);

  return (
    <>
      {room && watch && (slot || docked) && createPortal(<WatchStage key={moves} room={room} docked={docked} onChange={onChange ?? open} />, playerHolder)}
      <div
        role="region"
        aria-label={`Watching in ${name ?? 'a room'}`}
        hidden={!docked}
        className={`pop-in fixed right-2 z-30 w-[min(240px,62vw)] overflow-hidden rounded-2xl border border-white/10 bg-deep text-on-brand shadow-[0_16px_40px_-16px_rgb(4_6_18/0.7)] md:right-6 md:bottom-6 md:w-[320px] ${
          inThread ? 'bottom-[calc(84px+var(--safe-bottom))]' : 'bottom-[calc(156px+var(--safe-bottom))]'
        }`}
      >
        <div className="relative aspect-video w-full bg-black">
          <div ref={setDockArea} className="absolute inset-0" />
          <button type="button" onClick={open} aria-label={`Open ${name ?? 'the room'}`} className="absolute inset-0 z-10" />
        </div>
        <div className="flex items-center gap-1 py-1.5 pr-1 pl-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold">{watch?.source.title}</p>
            <p className="truncate text-[12px] text-on-brand/70">
              {watch?.source.kind === 'device' ? 'Live in' : 'Watching in'} {name}
            </p>
          </div>
          <IconButton label="Stop watching" variant="on-dark" size={34} onClick={stop}>
            <X size={16} />
          </IconButton>
        </div>
      </div>
    </>
  );
}
