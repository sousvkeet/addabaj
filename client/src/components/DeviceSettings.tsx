import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, Mic, Volume2 } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { getCamera, getMicrophone, stopStream, watchLevel } from '../lib/rtc';
import { useCall } from '../store/call';
import { canPickSpeaker, useDevices, type DeviceKind } from '../store/devices';
import { useUi } from '../store/ui';
import { useVoice } from '../store/voice';
import { Button } from './ui/Button';
import { Dialog, inputClass } from './ui/Dialog';
import { Toggle } from './ui/Toggle';

export function DeviceSettings() {
  const open = useUi((s) => s.devicesOpen);
  const setOpen = useUi((s) => s.setDevicesOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Audio and video" width={520}>
      <Settings onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-2 font-semibold">
        {icon}
        {title}
      </h3>
      <p className="mt-0.5 mb-2.5 text-[13.5px] text-ink-soft">{hint}</p>
      {children}
    </section>
  );
}

export function DeviceSelect({ kind, label, compact }: { kind: DeviceKind; label: string; compact?: boolean }) {
  const devices = useDevices((s) => s.devices);
  const value = useDevices((s) => s.choice[kind]);
  const choose = useDevices((s) => s.choose);
  const list = devices.filter((d) => d.kind === kind);
  const fallback = useDevices((s) => s.defaults[kind]);
  const noun = kind === 'audioinput' ? 'Microphone' : kind === 'audiooutput' ? 'Speaker' : 'Camera';
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => choose(kind, e.target.value)}
      className={`${inputClass} cursor-pointer appearance-auto pr-2 ${compact ? 'h-9 min-w-0 truncate rounded-lg px-2.5 text-[13.5px]' : ''}`}
    >
      <option value="">{fallback ? `System default (${fallback})` : 'System default'}</option>
      {list.map((d, i) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `${noun} ${i + 1}`}
        </option>
      ))}
    </select>
  );
}

function Settings({ onDone }: { onDone: () => void }) {
  const refresh = useDevices((s) => s.refresh);
  const micChoice = useDevices((s) => s.choice.audioinput);
  const noiseCancel = useDevices((s) => s.noiseCancel);
  const setNoiseCancel = useDevices((s) => s.setNoiseCancel);
  const speakerChoice = useDevices((s) => s.choice.audiooutput);
  const cameraChoice = useDevices((s) => s.choice.videoinput);
  const callCamera = useCall((s) => (s.cameraOn ? s.localVideo : null));
  const roomCamera = useVoice((s) => (s.cameraOn ? s.localVideo : null));
  const inCallCamera = callCamera ?? roomCamera;

  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState('');
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [wantPreview, setWantPreview] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open the chosen microphone while the dialog is up so the level bar is live.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let stop = () => {};
    setMicError('');
    getMicrophone()
      .then((s) => {
        if (cancelled) return stopStream(s);
        stream = s;
        stop = watchLevel(s, setLevel);
      })
      .catch((err) => setMicError(errorMessage(err)));
    return () => {
      cancelled = true;
      stop();
      stopStream(stream);
      setLevel(0);
    };
  }, [micChoice, noiseCancel]);

  // Camera preview only on request (or when your call camera is already on).
  useEffect(() => {
    if (!wantPreview || inCallCamera) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    setCameraError('');
    getCamera()
      .then((s) => {
        if (cancelled) return stopStream(s);
        stream = s;
        setPreview(s);
      })
      .catch((err) => {
        setCameraError(errorMessage(err));
        setWantPreview(false);
      });
    return () => {
      cancelled = true;
      stopStream(stream);
      setPreview(null);
    };
  }, [wantPreview, cameraChoice, inCallCamera]);

  async function playTestSound() {
    setTesting(true);
    const el = new Audio(testToneUrl());
    try {
      if (canPickSpeaker && speakerChoice) await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(speakerChoice);
      await el.play();
      await new Promise((r) => (el.onended = r));
    } catch {
      /* the button state resets either way */
    } finally {
      setTesting(false);
    }
  }

  const shownVideo = inCallCamera ?? preview;

  return (
    <div>
      <Section
        icon={<Mic size={17} />}
        title="Microphone"
        hint="Talk and watch the bar. Choose the microphone whose bar moves. If you wear a headset, pick the headset."
      >
        <DeviceSelect kind="audioinput" label="Microphone" />
        <div className="mt-2.5 flex items-center gap-3">
          <div
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
            className="h-2.5 flex-1 overflow-hidden rounded-full bg-subtle"
          >
            <div className="h-full rounded-full bg-live transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <span className="shrink-0 text-right text-[12.5px] whitespace-nowrap text-ink-soft">{level > 0.08 ? 'Hearing you' : 'Say something'}</span>
        </div>
        {micError && <p className="mt-2 text-[13.5px] text-danger">{micError}</p>}
        <div className="mt-3.5">
          <Toggle
            checked={noiseCancel}
            onChange={setNoiseCancel}
            label="Noise cancellation"
            hint="Takes background noise out of your microphone in calls and room voice: traffic, typing, fans, a television. Your voice stays. The bar above shows what the others hear."
          />
        </div>
      </Section>

      <Section
        icon={<Volume2 size={17} />}
        title="Speaker"
        hint={
          canPickSpeaker
            ? 'Where you hear calls. With headphones, the other person won’t hear an echo of themselves.'
            : 'This browser always uses your system’s sound output. Change it in your device’s sound settings.'
        }
      >
        {canPickSpeaker && <DeviceSelect kind="audiooutput" label="Speaker" />}
        <Button variant="outline" size="sm" className="mt-2.5" busy={testing} onClick={() => void playTestSound()}>
          Play test sound
        </Button>
      </Section>

      <Section icon={<Camera size={17} />} title="Camera" hint="Used for video calls. You can switch cameras during a call.">
        <DeviceSelect kind="videoinput" label="Camera" />
        <div className="mt-2.5 overflow-hidden rounded-xl bg-deep">
          {shownVideo ? (
            <Video stream={shownVideo} />
          ) : (
            <div className="flex aspect-video items-center justify-center">
              <Button variant="on-dark" size="sm" onClick={() => setWantPreview(true)}>
                Preview camera
              </Button>
            </div>
          )}
        </div>
        {cameraError && <p className="mt-2 text-[13.5px] text-danger">{cameraError}</p>}
      </Section>

      <div className="flex justify-end pt-2">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function Video({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className="aspect-video w-full -scale-x-100 object-cover" />;
}

let toneUrl: string | null = null;

/** A short two-note chime as a WAV, so it can be routed to a chosen speaker. */
function testToneUrl() {
  if (toneUrl) return toneUrl;
  const rate = 44100;
  const notes = [
    [660, 0.22],
    [880, 0.32],
  ] as const;
  const total = Math.round(rate * notes.reduce((n, [, d]) => n + d, 0));
  const buf = new DataView(new ArrayBuffer(44 + total * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  buf.setUint32(4, 36 + total * 2, true);
  str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  str(36, 'data');
  buf.setUint32(40, total * 2, true);
  let i = 0;
  for (const [freq, dur] of notes) {
    const n = Math.round(rate * dur);
    for (let k = 0; k < n; k++, i++) {
      const fade = Math.min(1, k / 400, (n - k) / 2000);
      buf.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * k) / rate) * 0.3 * fade * 32767, true);
    }
  }
  toneUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return toneUrl;
}
