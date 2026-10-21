import { useEffect, useRef, useState, type RefObject } from 'react';
import { AudioLines, LoaderCircle, Maximize, Pause, Play, Radio, Volume2, VolumeX } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { serverNow } from '../../lib/clock';
import { duration as clock } from '../../lib/format';
import { emitAck } from '../../lib/socket';
import { unlockAudio } from '../../lib/sounds';
import type { RoomDetail, WatchState } from '../../lib/types';
import { useAuth } from '../../store/auth';
import { canPickSpeaker, useDevices } from '../../store/devices';
import { useLiveStream, type HostSession } from '../../store/liveStream';
import { toast } from '../../store/ui';
import { Button, IconButton } from '../ui/Button';

/** Where the host's file is now, from the last shared state. */
const positionOf = (w: WatchState) => (w.playing ? w.position + Math.max(0, serverNow() - w.at) / 1000 : w.position);

/**
 * A live stream from an admin's device. The host sees a preview with their
 * player controls; everyone else gets the live picture and sound.
 */
export function LiveStage({ room, onChange }: { room: RoomDetail; onChange: () => void }) {
  const watch = room.watch!;
  const device = watch.source.device!;
  const meId = useAuth((s) => s.user?.id);
  const host = useLiveStream((s) => s.host);
  const frame = useRef<HTMLDivElement>(null);
  // The tab that is streaming. (The same person in another tab is just a viewer.)
  const mine = !!host && host.roomId === room.id && device.hostId === meId && (host.sessionId === device.sessionId || host.sessionId === '');
  const isAdmin = room.myRole === 'admin';
  const states = Object.values(host?.viewers ?? {});
  const watching = states.filter((s) => s === 'connected').length;
  const joining = states.filter((s) => s === 'new' || s === 'connecting').length;
  const firstName = device.hostName.split(' ')[0];

  async function stopForEveryone() {
    try {
      await emitAck('watch:stop', { roomId: room.id });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <section aria-label="Live stream" className="shrink-0 border-b border-line bg-black">
      <div ref={frame} className="relative mx-auto aspect-video w-full max-w-[calc(44dvh*16/9)] bg-black">
        {mine ? <HostView host={host} frame={frame} /> : <ViewerView key={device.sessionId} room={room} watch={watch} frame={frame} />}
        <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[12px] font-bold tracking-wide text-white">
          <span className="rec-dot size-2 rounded-full bg-danger" aria-hidden />
          LIVE
          <span className="font-semibold opacity-80">· {mine ? `${watching} watching` : device.hostName}</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-deep px-4 py-2.5 text-on-brand">
        <Radio size={18} className="shrink-0 text-live" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px]">
            <span className="font-semibold">{watch.source.title}</span>
            {watch.source.detail && <span className="ml-2 text-on-brand/60">{watch.source.detail}</span>}
          </p>
          <p className="truncate text-[12.5px] text-on-brand/70">
            {mine
              ? `Live to ${watching} ${watching === 1 ? 'person' : 'people'}${joining ? `, ${joining} joining` : ''}. Keep this tab open while you stream.`
              : device.mode === 'screen'
                ? `Live: you see what ${firstName} shares`
                : `Live: ${firstName} controls play, pause and seeking`}
          </p>
        </div>
        {mine ? (
          <Button size="sm" variant="danger" onClick={() => void useLiveStream.getState().stop()}>
            Stop streaming
          </Button>
        ) : (
          isAdmin && (
            <div className="flex gap-2">
              <Button size="sm" variant="on-dark" onClick={onChange}>
                Change video
              </Button>
              <Button size="sm" variant="danger" onClick={() => void stopForEveryone()}>
                Stop for everyone
              </Button>
            </div>
          )
        )}
      </div>
    </section>
  );
}

function SoundOnly({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80">
      <AudioLines size={34} className="text-live" />
      <p className="text-[14px] font-semibold">{label}</p>
    </div>
  );
}

const fullscreen = (frame: RefObject<HTMLDivElement | null>) => void frame.current?.requestFullscreen?.().catch(() => {});

// ── The host ─────────────────────────────────────────────────────────

function HostView({ host, frame }: { host: HostSession; frame: RefObject<HTMLDivElement | null> }) {
  const preview = useRef<HTMLVideoElement>(null);
  const live = useLiveStream.getState();
  const hasVideo = host.preview.getVideoTracks().length > 0;

  useEffect(() => {
    const el = preview.current;
    if (!el) return;
    el.srcObject = host.preview;
    void el.play().catch(() => {});
  }, [host.preview]);

  return (
    <>
      <video ref={preview} muted autoPlay playsInline aria-label="What everyone sees" className="size-full object-contain" />
      {!hasVideo && <SoundOnly label="Streaming sound only" />}
      {!host.sessionId && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white" role="status">
          <LoaderCircle size={26} className="animate-spin text-live" />
          <span className="sr-only">Starting your stream</span>
        </div>
      )}
      {host.soundNote && (
        <span
          role="status"
          className="pointer-events-none absolute top-2 right-2 flex max-w-[60%] items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[12px] font-semibold text-white"
        >
          {host.soundWaiting ? <LoaderCircle size={13} className="shrink-0 animate-spin" /> : <AudioLines size={13} className="shrink-0" />}
          <span className="truncate">{host.soundWaiting ? 'Getting the sound ready…' : host.soundNote}</span>
        </span>
      )}
      {host.mode === 'file' ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/85 to-transparent px-2 pt-8 pb-2 text-white">
          <IconButton
            label={host.playing ? 'Pause for everyone' : 'Play for everyone'}
            size={36}
            variant="on-dark"
            onClick={() => (host.playing ? live.pause() : live.play())}
          >
            {host.playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
          </IconButton>
          <span className="shrink-0 text-[12.5px] tabular-nums">
            {clock(host.time)} / {clock(host.duration)}
          </span>
          <input
            type="range"
            aria-label="Position"
            min={0}
            max={host.duration || 0}
            step="any"
            value={Math.min(host.time, host.duration || 0)}
            onChange={(e) => live.seek(Number(e.target.value))}
            className="min-w-0 flex-1 accent-[var(--live)]"
          />
          <IconButton label={host.muted ? 'Unmute (only for you)' : 'Mute (only for you)'} size={32} variant="on-dark" onClick={() => live.setMuted(!host.muted)}>
            {host.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </IconButton>
          <input
            type="range"
            aria-label="Your volume"
            min={0}
            max={1}
            step={0.05}
            value={host.muted ? 0 : host.volume}
            onChange={(e) => live.setVolume(Number(e.target.value))}
            className="hidden w-16 accent-[var(--live)] sm:block"
          />
          <IconButton label="Full screen" size={32} variant="on-dark" onClick={() => fullscreen(frame)}>
            <Maximize size={15} />
          </IconButton>
        </div>
      ) : (
        <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pt-8 pb-2 text-[12.5px] text-white/85">
          {host.audio
            ? 'Everyone sees and hears what you share. Stop from here or from your browser’s sharing bar.'
            : 'Sharing without sound. To include sound, share a tab and turn on “Share tab audio”.'}
        </p>
      )}
    </>
  );
}

// ── Everyone else ────────────────────────────────────────────────────

function ViewerView({ room, watch, frame }: { room: RoomDetail; watch: WatchState; frame: RefObject<HTMLDivElement | null> }) {
  const device = watch.source.device!;
  const viewer = useLiveStream((s) => (s.viewer?.sessionId === device.sessionId ? s.viewer : null));
  const video = useRef<HTMLVideoElement>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [, tick] = useState(0);
  const stream = viewer?.stream ?? null;
  const hasVideo = !stream || stream.getVideoTracks().length > 0;
  const speaker = useDevices((s) => s.choice.audiooutput);

  // Play the stream's sound on the speaker chosen in settings, like calls do.
  useEffect(() => {
    const el = video.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (canPickSpeaker) void el?.setSinkId?.(speaker).catch(() => {});
  }, [speaker, stream]);

  useEffect(() => {
    useLiveStream.getState().watch(room.id, device.sessionId);
    return () => useLiveStream.getState().unwatch();
  }, [room.id, device.sessionId]);

  useEffect(() => {
    const el = video.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().then(
      () => setNeedsTap(false),
      (err: DOMException) => setNeedsTap(err.name === 'NotAllowedError'),
    );
  }, [stream]);

  // Keep the progress bar moving.
  useEffect(() => {
    if (device.mode !== 'file' || !watch.playing) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [device.mode, watch.playing]);

  async function watchAlong() {
    unlockAudio();
    const el = video.current;
    if (!el) return;
    el.muted = false;
    setMuted(false);
    try {
      await el.play();
      setNeedsTap(false);
    } catch {
      setNeedsTap(true);
    }
  }

  const position = Math.min(positionOf(watch), device.duration ?? Infinity);
  const status = viewer?.status ?? 'connecting';
  const showProgress = device.mode === 'file' && !!device.duration;
  const ended = !!device.duration && position >= device.duration - 0.5;

  return (
    <>
      <video ref={video} autoPlay playsInline data-live-video className="size-full object-contain" />
      {stream && !hasVideo && <SoundOnly label={`Listening to ${device.hostName}`} />}

      {!stream && status !== 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white" role="status">
          <LoaderCircle size={26} className="animate-spin text-live" />
          <p className="text-[14.5px] font-semibold">
            {status === 'retrying' ? 'Reconnecting…' : `Connecting to ${device.hostName}'s stream…`}
          </p>
        </div>
      )}
      {stream && status === 'retrying' && (
        <span className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[12px] font-semibold text-white" role="status">
          <LoaderCircle size={13} className="animate-spin" />
          Reconnecting…
        </span>
      )}
      {status === 'failed' && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center bg-deep/95 p-6 text-center text-[14.5px] text-on-brand">
          <p className="max-w-sm">{viewer?.error ?? "Couldn't connect to the stream."}</p>
        </div>
      )}
      {stream && device.mode === 'file' && !watch.playing && !needsTap && (
        <span className="pointer-events-none absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-[14px] font-semibold text-white">
          <Pause size={16} />
          {ended ? 'The video has ended' : `Paused by ${device.hostName}`}
        </span>
      )}

      {needsTap && (
        <button
          type="button"
          onClick={() => void watchAlong()}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white"
        >
          <span className="flex size-16 items-center justify-center rounded-full bg-live text-on-live">
            <Play size={28} className="ml-1" />
          </span>
          <span className="text-[15px] font-semibold">Click to watch along</span>
        </button>
      )}

      {stream && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/75 to-transparent px-2 pt-6 pb-2 text-white">
          {showProgress ? (
            <>
              <span className="shrink-0 pl-1 text-[12.5px] tabular-nums">
                {clock(position)} / {clock(device.duration!)}
              </span>
              <div
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/25"
                role="progressbar"
                aria-label="Position in the video"
                aria-valuemin={0}
                aria-valuemax={Math.round(device.duration!)}
                aria-valuenow={Math.round(position)}
              >
                <div className="h-full rounded-full bg-live" style={{ width: `${(position / device.duration!) * 100}%` }} />
              </div>
            </>
          ) : (
            <span className="flex-1" />
          )}
          <IconButton
            label={muted ? 'Unmute' : 'Mute'}
            size={32}
            variant="on-dark"
            onClick={() => {
              if (video.current) video.current.muted = !muted;
              setMuted(!muted);
            }}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </IconButton>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (video.current) {
                video.current.volume = v;
                video.current.muted = v === 0;
              }
              setVolume(v);
              setMuted(v === 0);
            }}
            className="hidden w-20 accent-[var(--live)] sm:block"
          />
          <IconButton label="Full screen" size={32} variant="on-dark" onClick={() => fullscreen(frame)}>
            <Maximize size={15} />
          </IconButton>
        </div>
      )}
    </>
  );
}
