import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FileVideo, Link2, LoaderCircle, Maximize, MonitorPlay, MonitorUp, Play, Search, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { inApp } from '../../lib/native';
import { serverNow } from '../../lib/clock';
import { duration } from '../../lib/format';
import { getLimits } from '../../lib/config';
import { emitAck, socket } from '../../lib/socket';
import type { FindResult, RoomDetail, WatchState } from '../../lib/types';
import { useAuth } from '../../store/auth';
import { canShareScreen, canStreamFile, useLiveStream } from '../../store/liveStream';
import { useWatchProgress } from '../../store/watchProgress';
import { toast } from '../../store/ui';
import { Button, IconButton } from '../ui/Button';
import { Dialog, Field, inputClass } from '../ui/Dialog';
import { LiveStage } from './LiveStage';
import { FileView, YouTubeView, type PlayerAdapter, type UserAction } from './players';

/** Where the video should be right now, from the last shared state. */
function expected(w: WatchState) {
  return w.playing ? w.position + Math.max(0, serverNow() - w.at) / 1000 : w.position;
}

/** Members re-seek when they are this far from the shared timeline. */
const DRIFT_SECONDS = 1.25;
/** Players with fine speed control (files, streams) only seek past this; smaller drifts are eased out. */
const SEEK_SECONDS = 2.5;

/**
 * Speed that closes a small gap smoothly: up to 15% faster when behind,
 * slower when ahead. Browsers keep the pitch natural at these speeds.
 */
const catchUpRate = (drift: number) => (Math.abs(drift) < 0.2 ? 1 : 1 - Math.max(-0.15, Math.min(0.15, drift * 0.25)));
/** The host re-anchors the timeline to its real position past this (e.g. after buffering). */
const HOST_DRIFT_SECONDS = 1;

type StageProps = { room: RoomDetail; onChange: () => void };

/** The room's video: a link everyone plays in sync, or a live stream from an admin's device. */
export function WatchStage(props: StageProps) {
  return props.room.watch?.source.kind === 'device' ? <LiveStage {...props} /> : <SyncedStage {...props} />;
}

/**
 * A linked video. Everyone's player follows the room's watch state; the
 * admin who last pressed play, pause or seek is the host, and their player
 * is the reference the others follow.
 */
function SyncedStage({ room, onChange }: StageProps) {
  const watch = room.watch!;
  const meId = useAuth((s) => s.user?.id);
  const isAdmin = room.myRole === 'admin';
  const [adapter, setAdapter] = useState<PlayerAdapter | null>(null);
  const [error, setError] = useState('');
  const [needsTap, setNeedsTap] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const frame = useRef<HTMLDivElement>(null);
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const suppressUntil = useRef(0);
  const sourceKey = `${watch.source.kind}:${watch.source.url}`;

  useEffect(() => {
    setAdapter(null);
    setError('');
    setNeedsTap(false);
  }, [sourceKey]);

  const control = useCallback(
    (playing: boolean, position: number) => {
      emitAck('watch:control', { roomId: room.id, playing, position }).catch((err) => toast(errorMessage(err), 'error'));
    },
    [room.id],
  );

  /** Bring this player in line with the shared state. */
  const apply = useCallback(
    async (force = false) => {
      const a = adapter;
      const w = watchRef.current;
      if (!a) return;
      // A change I just made already matches my player.
      if (!force && w.by === meId && serverNow() - w.at < 1500) return;
      suppressUntil.current = Date.now() + 1500;
      if (!a.live()) {
        const drift = a.time() - expected(w);
        if (Math.abs(drift) > (a.setRate ? SEEK_SECONDS : DRIFT_SECONDS)) {
          a.seek(expected(w));
          a.setRate?.(1);
        } else {
          a.setRate?.(w.playing ? catchUpRate(drift) : 1);
        }
      }
      if (w.playing && !a.playing()) setNeedsTap(!(await a.play()));
      else if (!w.playing && a.playing()) a.pause();
      if (!w.playing) setNeedsTap(false);
    },
    [adapter, meId],
  );

  // Follow every new shared state, and line up as soon as the player is ready.
  useEffect(() => {
    void apply();
  }, [watch, apply]);
  useEffect(() => {
    if (adapter) void apply(true);
  }, [adapter, apply]);

  // Every 2 s: the host reports where it really is (seeks inside YouTube's own
  // controls fire no event); everyone else corrects any drift.
  useEffect(() => {
    if (!adapter) return;
    const id = window.setInterval(() => {
      const w = watchRef.current;
      if (isAdmin && w.by === meId) {
        adapter.setRate?.(1); // the host is the reference and always plays at normal speed
        if (Date.now() < suppressUntil.current || needsTap) return;
        // Pauses are reported by the player's own events. This only re-anchors
        // the timeline (e.g. after buffering, or a seek in YouTube's controls),
        // and only while the host's video is really playing.
        if (w.playing && !adapter.playing()) {
          void adapter.play();
          return;
        }
        const t = adapter.time();
        if (!adapter.live() && Math.abs(t - expected(w)) > HOST_DRIFT_SECONDS) control(w.playing, t);
      } else {
        void apply();
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [adapter, apply, control, isAdmin, meId, needsTap]);

  const onUserAction = useCallback(
    ({ playing, position }: UserAction) => {
      if (!isAdmin || Date.now() < suppressUntil.current) return;
      const w = watchRef.current;
      // Our own sync moves look like clicks; only real changes go out.
      if (w.playing === playing && Math.abs(position - expected(w)) < DRIFT_SECONDS) return;
      control(playing, position);
    },
    [control, isAdmin],
  );

  async function watchAlong() {
    if (!adapter) return;
    adapter.setMuted(false);
    setMuted(false);
    const ok = await adapter.play();
    setNeedsTap(!ok);
    void apply(true);
  }

  async function stop() {
    try {
      await emitAck('watch:stop', { roomId: room.id });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const View = watch.source.kind === 'youtube' ? YouTubeView : FileView;
  const startAt = expected(watch);

  return (
    <section aria-label="Watch together" className="shrink-0 border-b border-line bg-black">
      <div ref={frame} className="relative mx-auto aspect-video w-full max-w-[calc(44dvh*16/9)] bg-black">
        {watch.source.preparing || watch.source.error ? (
          <Preparing roomId={room.id} failed={watch.source.error} />
        ) : (
          <View
            key={sourceKey}
            source={watch.source}
            controls={isAdmin}
            startAt={startAt}
            onReady={setAdapter}
            onUserAction={onUserAction}
            onError={setError}
          />
        )}

        {/* Members follow the host: block clicks that would pause or seek. */}
        {!isAdmin && <div className="absolute inset-0" aria-hidden />}

        {needsTap && !error && (
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

        {error && (
          <div role="alert" className="absolute inset-0 flex items-center justify-center bg-deep/95 p-6 text-center text-[14.5px] text-on-brand">
            <p className="max-w-sm">{error}</p>
          </div>
        )}

        {!isAdmin && adapter && !error && (
          <div className="absolute right-2 bottom-2 flex items-center gap-1.5 rounded-full bg-black/55 p-1 pr-2 text-white backdrop-blur-sm">
            <IconButton
              label={muted ? 'Unmute video' : 'Mute video'}
              size={32}
              variant="on-dark"
              onClick={() => {
                adapter.setMuted(!muted);
                setMuted(!muted);
              }}
            >
              {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </IconButton>
            <input
              type="range"
              aria-label="Video volume"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                adapter.setVolume(v);
                adapter.setMuted(v === 0);
                setVolume(v);
                setMuted(v === 0);
              }}
              className="hidden w-20 accent-[var(--live)] sm:block"
            />
            <IconButton label="Full screen" size={32} variant="on-dark" onClick={() => void frame.current?.requestFullscreen?.()}>
              <Maximize size={15} />
            </IconButton>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-deep px-4 py-2.5 text-on-brand">
        <MonitorPlay size={18} className="shrink-0 text-live" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px]">
            <span className="font-semibold">{watch.source.title}</span>
            {watch.source.detail && <span className="ml-2 text-on-brand/60">{watch.source.detail}</span>}
          </p>
          <p className="truncate text-[12.5px] text-on-brand/70">
            {isAdmin
              ? watch.by === meId
                ? 'You control playback for everyone'
                : `${watch.byName} is controlling playback. Play, pause or seek to take over.`
              : `Watching in sync with ${watch.byName}`}
          </p>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button size="sm" variant="on-dark" onClick={onChange}>
              Change video
            </Button>
            <Button size="sm" variant="danger" onClick={() => void stop()}>
              Stop for everyone
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * While the server downloads the separate picture and sound files and joins
 * them, everyone sees the progress; playback then starts for the whole room.
 */
function Preparing({ roomId, failed }: { roomId: string; failed?: string }) {
  const p = useWatchProgress((s) => s.rooms[roomId]);
  if (failed) {
    return (
      <div role="alert" className="absolute inset-0 flex items-center justify-center bg-deep p-6 text-center text-[14.5px] text-on-brand">
        <p className="max-w-sm">{failed}</p>
      </div>
    );
  }
  const percent = p?.percent ?? 0;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-deep px-8 text-center text-on-brand" role="status">
      <LoaderCircle size={26} className="animate-spin text-live" />
      <p className="text-[15px] font-semibold">Getting the video ready for everyone…</p>
      <div
        className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-white/15"
        role="progressbar"
        aria-label="Preparing the video"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="h-full rounded-full bg-live transition-[width] duration-700" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-[13px] text-on-brand/70">
        {p?.phase === 'join' ? 'Joining picture and sound…' : `Downloading picture and sound, ${percent}%`}
      </p>
    </div>
  );
}

/**
 * Admins paste any link: a video page on almost any site, YouTube, or a direct
 * file/stream. The server finds the videos on it (like a download manager),
 * the admin picks one and a quality, and it plays for the whole room.
 */
export function WatchDialog({ roomId, open, onClose, replacing }: { roomId: string; open: boolean; onClose: () => void; replacing: boolean }) {
  const [url, setUrl] = useState('');
  const [step, setStep] = useState<'link' | 'finding' | 'choose'>('link');
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'link' | 'device'>('link');
  const request = useRef(0);

  // Reset when it closes, so it never reopens showing the previous search.
  useEffect(() => {
    if (open) return;
    request.current++;
    setUrl('');
    setTab('link');
    setStep('link');
    setResult(null);
    setError('');
  }, [open]);

  useEffect(() => {
    const onProgress = ({ requestId, message }: { requestId: string; message: string }) => {
      if (requestId === String(request.current)) setProgress(message);
    };
    socket.on('watch:scan-progress', onProgress);
    return () => {
      socket.off('watch:scan-progress', onProgress);
    };
  }, []);

  async function find(e: FormEvent) {
    e.preventDefault();
    const id = ++request.current;
    setError('');
    setProgress('Looking at the link…');
    setStep('finding');
    try {
      const found = await emitAck<FindResult>('watch:scan', { roomId, url, requestId: String(id) }, 120_000);
      if (request.current !== id) return; // cancelled meanwhile
      const options = found.videos.flatMap((v) => v.options);
      setResult(found);
      setSelected((options.find((o) => o.recommended) ?? options[0])?.id ?? '');
      setStep('choose');
    } catch (err) {
      if (request.current !== id) return;
      setError(errorMessage(err));
      setStep('link');
    }
  }

  async function play() {
    if (!result || !selected) return;
    setBusy(true);
    setError('');
    try {
      await emitAck('watch:set', { roomId, scanId: result.scanId, optionId: selected }, 30_000);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const relayed = result?.videos.some((v) => v.options.some((o) => o.relay));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={580}
      title={step === 'choose' ? 'Pick what to play' : replacing ? 'Change the video' : 'Watch together'}
      description={
        step === 'choose'
          ? 'Everyone in the room watches it in sync.'
          : tab === 'device'
            ? 'Play a video from this device, or share your screen. It streams live to everyone in the room.'
            : 'Paste a link to a video, or to any page with a video on it. Admins control play, pause and seeking.'
      }
    >
      {step === 'link' && (
        <div role="tablist" aria-label="What to play" className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-subtle p-1">
          {(
            [
              ['link', 'Paste a link', Link2],
              ['device', 'From your device', Smartphone],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[14px] font-semibold transition-colors ${
                tab === id ? 'bg-aurora text-white shadow-glow' : 'text-ink-soft hover:text-ink'
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      )}

      {step === 'link' && tab === 'device' && <DeviceSource roomId={roomId} onDone={onClose} />}

      {step === 'link' && tab === 'link' && (
        <form onSubmit={find} className="space-y-4" noValidate>
          <Field
            label="Link"
            hint="Works with YouTube, Facebook, Instagram, X, Dailymotion, news and video sites, and direct .mp4 or .m3u8 links."
          >
            <input
              className={inputClass}
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              autoFocus
            />
          </Field>
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!url.trim()}>
              <Search size={16} />
              Find videos
            </Button>
          </div>
        </form>
      )}

      {step === 'finding' && (
        <div className="py-6 text-center" role="status" aria-live="polite">
          <LoaderCircle size={30} className="mx-auto animate-spin text-brand dark:text-live" />
          <p className="mt-4 font-semibold">{progress}</p>
          <p className="mt-1 text-[13.5px] text-ink-soft">Some sites take up to half a minute.</p>
          <Button
            variant="ghost"
            className="mt-5"
            onClick={() => {
              request.current++;
              setStep('link');
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {step === 'choose' && result && (
        <div>
          <ul className="space-y-3">
            {result.videos.map((v) => (
              <li key={v.id} className="rounded-2xl border border-line p-3">
                <div className="flex gap-3">
                  {v.thumbnail && (
                    <img
                      src={v.thumbnail}
                      alt=""
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                      className="aspect-video w-28 shrink-0 rounded-lg bg-subtle object-cover"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-semibold leading-snug">{v.title}</p>
                    <p className="mt-0.5 text-[13px] text-ink-soft">
                      {[v.site, v.live ? 'Live' : v.duration ? duration(v.duration) : null].filter(Boolean).join(', ')}
                    </p>
                  </div>
                </div>
                <div role="radiogroup" aria-label={`Ways to play ${v.title}`} className="mt-2 space-y-0.5">
                  {v.options.map((o) => (
                    <label
                      key={o.id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-subtle has-[:checked]:bg-subtle"
                    >
                      <input
                        type="radio"
                        name="watch-option"
                        value={o.id}
                        checked={selected === o.id}
                        onChange={() => setSelected(o.id)}
                        className="size-4 accent-[var(--brand)]"
                      />
                      <span className="w-[68px] shrink-0 font-semibold tabular-nums">{o.label}</span>
                      <span className="min-w-0 flex-1 text-[13.5px] text-ink-soft">
                        {o.detail}
                        {o.recommended && <span className="ml-2 font-semibold text-brand dark:text-live">Recommended</span>}
                      </span>
                      {o.size && <span className="shrink-0 text-[13px] text-ink-soft tabular-nums">{o.size}</span>}
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {(result.notes.length > 0 || relayed) && (
            <div className="mt-3 space-y-1 text-[13px] text-ink-soft">
              {result.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
              {relayed && <p>Videos from web pages play through your server, which uses its upload for each viewer.</p>}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep('link')}>
              Try another link
            </Button>
            <Button onClick={() => void play()} busy={busy} disabled={!selected}>
              Play for everyone
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Stream a file playing on this device, or share the screen, live to the room. */
function DeviceSource({ roomId, onDone }: { roomId: string; onDone: () => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'' | 'file' | 'screen'>('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [maxViewers, setMaxViewers] = useState<number | null>(null);
  const fileOk = canStreamFile();
  const screenOk = canShareScreen();

  useEffect(() => {
    void getLimits().then((l) => setMaxViewers(l.liveViewers));
  }, []);

  async function start(kind: 'file' | 'screen', file?: File) {
    setBusy(kind);
    setStatus('');
    setError('');
    try {
      const live = useLiveStream.getState();
      const started = kind === 'file' ? (await live.startFile(roomId, file!, setStatus), true) : await live.startScreen(roomId);
      if (started) onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy('');
      setStatus('');
    }
  }

  return (
    <div className="space-y-3">
      <input
        ref={picker}
        type="file"
        accept="video/*,audio/*,.mkv,.mov,.m4v"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void start('file', file);
        }}
      />
      <SourceOption
        icon={<FileVideo size={21} />}
        title="Stream a video file"
        text="Plays here and streams live to the room, with your play, pause and seek. Movie sound browsers can't play (Dolby, DTS) is converted for you."
        unavailable={fileOk ? '' : "This browser can't stream a file. Use Chrome, Edge or Firefox on a computer or Android phone."}
        busy={busy === 'file'}
        status={busy === 'file' ? status : ''}
        disabled={!!busy}
        onClick={() => picker.current?.click()}
      />
      <SourceOption
        icon={<MonitorUp size={21} />}
        title={inApp ? 'Share your screen' : 'Share your screen or a tab'}
        text={
          inApp
            ? 'Everyone watching sees your screen, even while you use other apps. The picture is shared, not the sound.'
            : 'To include sound, share a tab and turn on “Share tab audio”.'
        }
        unavailable={screenOk ? '' : 'Phones and tablets can’t share their screen. Use a computer.'}
        busy={busy === 'screen'}
        disabled={!!busy}
        onClick={() => void start('screen')}
      />
      <p className="text-[13px] text-ink-soft">
        The video goes from this device to each person watching, so your upload speed matters
        {maxViewers ? `, and up to ${maxViewers} people can watch` : ''}.{' '}
        {inApp ? 'Adda Khana keeps streaming in the background until you stop.' : 'Keep this tab open while you stream.'}
      </p>
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function SourceOption(props: {
  icon: ReactNode;
  title: string;
  text: string;
  unavailable: string;
  busy: boolean;
  /** What's happening while it starts ("Converting the sound…"). */
  status?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled || !!props.unavailable}
      className="flex w-full items-start gap-3 rounded-2xl border border-line p-3.5 text-left transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-subtle text-brand dark:text-live">
        {props.busy ? <LoaderCircle size={20} className="animate-spin" /> : props.icon}
      </span>
      <span className={`min-w-0 ${props.unavailable ? 'opacity-60' : ''}`}>
        <span className="block font-semibold">{props.busy ? 'Starting…' : props.title}</span>
        <span className="mt-0.5 block text-[13.5px] text-ink-soft" role={props.status ? 'status' : undefined}>
          {props.status || props.text}
        </span>
        {props.unavailable && <span className="mt-1 block text-[13px] font-medium text-danger">{props.unavailable}</span>}
      </span>
    </button>
  );
}
