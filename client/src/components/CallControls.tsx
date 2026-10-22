import { useEffect, useRef, useState } from 'react';
import { Ear, Mic, MicOff, Volume2 } from 'lucide-react';
import { useFloating, type Corner } from '../lib/floating';
import { canToggleSpeaker, nativeSetSpeaker, nativeSpeakerOn, onNative } from '../lib/native';
import { audioContext } from '../lib/sounds';
import { noteVideoSize } from '../lib/videoSize';
import { useUi } from '../store/ui';
import { IconButton } from './ui/Button';

// What one-to-one calls and room calls share.

/** Shown when the browser blocked call audio; one tap lets it play. */
export function SoundBlocked({ className = '' }: { className?: string }) {
  const blocked = useUi((s) => s.soundBlocked);
  const setBlocked = useUi((s) => s.setSoundBlocked);
  if (!blocked) return null;
  const enable = () => {
    try {
      void audioContext().resume();
    } catch {
      /* audio unavailable */
    }
    const players = [...document.querySelectorAll<HTMLAudioElement>('audio[data-call-audio]')];
    void Promise.all(players.map((a) => a.play())).then(() => setBlocked(false), () => {});
  };
  return (
    <button
      type="button"
      onClick={enable}
      className={`absolute z-10 flex min-h-10 items-center justify-center gap-2 rounded-xl bg-live px-3 py-2 text-center text-[14px] font-semibold text-on-live shadow-lg ${className}`}
    >
      <Volume2 size={17} />
      Sound is paused. Tap to hear the call.
    </button>
  );
}

/** Glows while your own microphone picks up sound, so you know it's working. */
export function MuteButton({ muted, speaking, onClick, size = 40 }: { muted: boolean; speaking: boolean; onClick: () => void; size?: number }) {
  return (
    <IconButton
      label={muted ? 'Unmute microphone' : 'Mute microphone'}
      aria-pressed={muted}
      variant={muted ? 'live' : 'on-dark'}
      size={size}
      onClick={onClick}
      className={speaking && !muted ? 'speaking-ring' : ''}
    >
      {muted ? <MicOff size={size * 0.45} /> : <Mic size={size * 0.45} />}
    </IconButton>
  );
}

/** In the Android app: the call's sound from the loudspeaker or the earpiece (at your ear). */
export function SpeakerButton({ size = 40 }: { size?: number }) {
  const [on, setOn] = useState(nativeSpeakerOn);
  useEffect(
    () =>
      onNative((e) => {
        if (e.type === 'speaker') setOn(e.on);
      }),
    [],
  );
  if (!canToggleSpeaker()) return null;
  return (
    <IconButton
      label={on ? 'Use the earpiece' : 'Use the loudspeaker'}
      aria-pressed={on}
      variant={on ? 'live' : 'on-dark'}
      size={size}
      onClick={() => {
        nativeSetSpeaker(!on);
        setOn(!on);
      }}
    >
      {on ? <Volume2 size={size * 0.45} /> : <Ear size={size * 0.45} />}
    </IconButton>
  );
}

/** Muted <video>: call audio always plays through the separate audio sink. */
export function VideoView({ stream, mirrored, remote, className = '' }: { stream: MediaStream; mirrored?: boolean; remote?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    void el.play().catch(() => {});
    // The picture's size (a phone turned, a new camera) shapes Android's floating window.
    const sized = () => noteVideoSize(stream, el.videoWidth, el.videoHeight);
    sized();
    el.addEventListener('resize', sized);
    return () => el.removeEventListener('resize', sized);
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      data-remote-video={remote ? '' : undefined}
      data-self-video={remote ? undefined : ''}
      className={`${mirrored ? '-scale-x-100' : ''} ${className}`}
    />
  );
}

/** Invisible corners of a call window on a computer: drag one to resize the window (see lib/floating.ts). */
export function ResizeCorners({ resize }: { resize: (corner: Corner) => object }) {
  const at: Record<Corner, string> = {
    tl: 'top-0 left-0 cursor-nwse-resize',
    tr: 'top-0 right-0 cursor-nesw-resize',
    bl: 'bottom-0 left-0 cursor-nesw-resize',
    br: 'right-0 bottom-0 cursor-nwse-resize',
  };
  return (
    <>
      {(Object.keys(at) as Corner[]).map((c) => (
        // As big as the window's rounded corner, which clips what's outside its curve.
        <span key={c} {...resize(c)} aria-hidden className={`absolute z-[2] size-7 ${at[c]}`} />
      ))}
    </>
  );
}

/**
 * A call window on a computer: drag it by its top, resize it from a corner.
 * Where it was left and how big are kept for every call (phones show calls full screen).
 */
export function useCallWindow() {
  return useFloating({
    name: 'call-window',
    aspect: null,
    initial: (vw, vh) => {
      const w = Math.max(420, Math.min(780, vw - 440));
      const h = Math.min(560, vh - 32);
      return { x: vw - w - 16, y: vh - h - 16, w, h };
    },
    min: { w: 360, h: 280 },
    max: (vw, vh) => ({ w: vw - 16, h: vh - 16 }),
  });
}
