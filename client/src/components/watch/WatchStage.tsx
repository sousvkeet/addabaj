import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Maximize, MonitorPlay, Play, Search, Volume2, VolumeX } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { serverNow } from '../../lib/clock';
import { duration } from '../../lib/format';
import { emitAck, socket } from '../../lib/socket';
import type { FindResult, RoomDetail, WatchState } from '../../lib/types';
import { useAuth } from '../../store/auth';
import { toast } from '../../store/ui';
import { Button, IconButton } from '../ui/Button';
import { Dialog, Field, inputClass } from '../ui/Dialog';
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

/**
 * The shared video. Everyone's player follows the room's watch state; the
 * admin who last pressed play, pause or seek is the host, and their player
 * is the reference the others follow.
 */
export function WatchStage({ room, onChange }: { room: RoomDetail; onChange: () => void }) {
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
        <View
          key={sourceKey}
          source={watch.source}
          controls={isAdmin}
          startAt={startAt}
          onReady={setAdapter}
          onUserAction={onUserAction}
          onError={setError}
        />

        {/* Members follow the host: block clicks that would pause or seek. */}
        {!isAdmin && <div className="absolute inset-0" aria-hidden />}

        {needsTap && !error && (
          <button
            type="button"
            onClick={() => void watchAlong()}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white"
          >
            <span className="flex size-16 items-center justify-center rounded-full bg-taxi text-on-taxi">
              <Play size={28} className="ml-1" />
            </span>
            <span className="text-[15px] font-semibold">Click to watch along</span>
          </button>
        )}

        {error && (
          <div role="alert" className="absolute inset-0 flex items-center justify-center bg-shutter-deep/95 p-6 text-center text-[14.5px] text-on-shutter">
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
              className="hidden w-20 accent-[var(--taxi)] sm:block"
            />
            <IconButton label="Full screen" size={32} variant="on-dark" onClick={() => void frame.current?.requestFullscreen?.()}>
              <Maximize size={15} />
            </IconButton>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-shutter-deep px-4 py-2.5 text-on-shutter">
        <MonitorPlay size={18} className="shrink-0 text-taxi" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px]">
            <span className="font-semibold">{watch.source.title}</span>
            {watch.source.detail && <span className="ml-2 text-on-shutter/60">{watch.source.detail}</span>}
          </p>
          <p className="truncate text-[12.5px] text-on-shutter/70">
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
  const request = useRef(0);

  useEffect(() => {
    if (!open) return;
    request.current++;
    setUrl('');
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
          : 'Paste a link to a video, or to any page with a video on it. Admins control play, pause and seeking.'
      }
    >
      {step === 'link' && (
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
            <p role="alert" className="rounded-xl bg-oxide/10 px-3.5 py-2.5 text-[14px] text-oxide">
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
          <LoaderCircle size={30} className="mx-auto animate-spin text-shutter dark:text-taxi" />
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
                      className="aspect-video w-28 shrink-0 rounded-lg bg-limewash object-cover"
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
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-limewash has-[:checked]:bg-limewash"
                    >
                      <input
                        type="radio"
                        name="watch-option"
                        value={o.id}
                        checked={selected === o.id}
                        onChange={() => setSelected(o.id)}
                        className="size-4 accent-[var(--shutter)]"
                      />
                      <span className="w-[68px] shrink-0 font-semibold tabular-nums">{o.label}</span>
                      <span className="min-w-0 flex-1 text-[13.5px] text-ink-soft">
                        {o.detail}
                        {o.recommended && <span className="ml-2 font-semibold text-shutter dark:text-taxi">Recommended</span>}
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
            <p role="alert" className="mt-3 rounded-xl bg-oxide/10 px-3.5 py-2.5 text-[14px] text-oxide">
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
