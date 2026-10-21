import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Pause, Play } from 'lucide-react';
import { duration as clock } from '../lib/format';
import type { Attachment } from '../lib/types';

const FLAT = new Array(48).fill(30);
const RATES = [1, 1.5, 2];

/** A voice message: play/pause, its waveform (click to jump), time, and speed. */
export function VoicePlayer({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  // Recorded WebM often has no length in its header, so trust the length sent with it.
  const total = attachment.duration ?? 0;
  const bars = attachment.waveform?.length ? attachment.waveform : FLAT;
  const progress = total ? Math.min(1, time / total) : 0;

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  function toggle() {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  }

  function seekTo(fraction: number) {
    const a = audio.current;
    if (!a || !total) return;
    a.currentTime = Math.max(0, Math.min(total, fraction * total));
    setTime(a.currentTime);
  }

  const onBarsClick = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - box.left) / box.width);
  };
  const onBarsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') seekTo(progress + 0.05);
    if (e.key === 'ArrowLeft') seekTo(progress - 0.05);
  };

  const played = mine ? 'bg-white' : 'bg-brand dark:bg-live';
  const unplayed = mine ? 'bg-white/35' : 'bg-ink-soft/35';

  return (
    <div className="flex w-[min(260px,62vw)] items-center gap-2.5 py-0.5">
      <audio
        ref={audio}
        src={attachment.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={`flex size-10 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95 ${mine ? 'bg-white text-brand shadow-md' : 'bg-aurora text-white shadow-glow'}`}
      >
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Voice message position"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(time)}
          onClick={onBarsClick}
          onKeyDown={onBarsKey}
          className="flex h-7 cursor-pointer items-center gap-[2px]"
        >
          {bars.map((h, i) => (
            <span
              key={i}
              className={`w-full max-w-[3px] flex-1 rounded-full ${i / bars.length < progress ? played : unplayed}`}
              style={{ height: `${Math.max(12, h)}%` }}
            />
          ))}
        </div>
        <div className={`mt-0.5 flex justify-between text-[11.5px] tabular-nums ${mine ? 'text-white/75' : 'text-ink-soft'}`}>
          <span>{clock(playing || time ? time : total)}</span>
          <button
            type="button"
            onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])}
            aria-label={`Playback speed ${rate}×`}
            className="rounded px-1 font-semibold hover:underline"
          >
            {rate}×
          </button>
        </div>
      </div>
    </div>
  );
}
