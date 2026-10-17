import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { AudioLines, Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { duration } from '../lib/format';
import { useNow } from '../lib/useMedia';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { useVoice } from '../store/voice';
import { Avatar } from './ui/Avatar';
import { IconButton } from './ui/Button';

/** Full-screen ring for an incoming one-to-one call. */
export function IncomingCall() {
  const phase = useCall((s) => s.phase);
  const peer = useCall((s) => s.peer);
  const accepting = useCall((s) => s.accepting);
  const accept = useCall((s) => s.acceptCall);
  const decline = useCall((s) => s.declineCall);
  const navigate = useNavigate();
  const acceptRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (phase === 'incoming') acceptRef.current?.focus();
  }, [phase]);

  if (phase !== 'incoming' || !peer) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(10_25_21/0.62)] p-4 sm:items-center">
      <div
        role="alertdialog"
        aria-labelledby="incoming-name"
        aria-describedby="incoming-label"
        className="pop-in w-full max-w-sm rounded-[28px] bg-shutter-deep px-8 pt-10 pb-8 text-center text-on-shutter shadow-2xl"
      >
        <div className="ring-pulse relative mx-auto w-fit rounded-full">
          <Avatar name={peer.name} hue={peer.hue} size={104} />
        </div>
        <p id="incoming-label" className="mt-7 text-[14px] text-on-shutter/70">
          Incoming voice call
        </p>
        <h2 id="incoming-name" className="mt-0.5 font-display text-[30px] leading-tight">
          {peer.name}
        </h2>
        <div className="mt-9 flex justify-center gap-14">
          <div className="flex flex-col items-center gap-2">
            <IconButton label="Decline call" variant="danger" size={64} onClick={decline} disabled={accepting}>
              <PhoneOff size={26} />
            </IconButton>
            <span className="text-[13px] text-on-shutter/80">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button
              ref={acceptRef}
              type="button"
              aria-label="Accept call"
              disabled={accepting}
              onClick={() => {
                void accept();
                navigate(`/chats/${peer.id}`);
              }}
              className="inline-flex size-16 items-center justify-center rounded-full bg-taxi text-on-taxi hover:brightness-105 disabled:opacity-60"
            >
              <Phone size={26} />
            </button>
            <span className="text-[13px] text-on-shutter/80">{accepting ? 'Connecting…' : 'Accept'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Persistent bar for whatever is live: a one-to-one call or room voice. */
export function LiveBar() {
  const phase = useCall((s) => s.phase);
  const voiceStatus = useVoice((s) => s.status);
  if (phase === 'outgoing' || phase === 'connecting' || phase === 'active') return <CallBar />;
  if (voiceStatus !== 'idle') return <VoiceBar />;
  return null;
}

export const useLive = () => {
  const phase = useCall((s) => s.phase);
  const voiceStatus = useVoice((s) => s.status);
  return (phase !== 'idle' && phase !== 'incoming') || voiceStatus !== 'idle';
};

const barClass =
  'pop-in fixed inset-x-2 top-[max(8px,env(safe-area-inset-top))] z-40 flex items-center gap-3 rounded-2xl bg-shutter-deep p-2.5 pl-3 text-on-shutter shadow-[0_16px_40px_-16px_rgb(5_20_16/0.7)] md:inset-x-auto md:top-auto md:bottom-4 md:left-[88px] md:w-[304px]';

function MuteButton({ muted, onClick }: { muted: boolean; onClick: () => void }) {
  return (
    <IconButton label={muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={muted} variant={muted ? 'live' : 'on-dark'} size={40} onClick={onClick}>
      {muted ? <MicOff size={18} /> : <Mic size={18} />}
    </IconButton>
  );
}

function CallBar() {
  const phase = useCall((s) => s.phase);
  const peer = useCall((s) => s.peer);
  const muted = useCall((s) => s.muted);
  const peerMuted = useCall((s) => s.peerMuted);
  const startedAt = useCall((s) => s.startedAt);
  const reconnecting = useCall((s) => s.reconnecting);
  const remoteSpeaking = useCall((s) => s.remoteSpeaking);
  const toggleMute = useCall((s) => s.toggleMute);
  const endCall = useCall((s) => s.endCall);
  const now = useNow(1000, phase === 'active');
  const navigate = useNavigate();
  if (!peer) return null;

  const status =
    phase === 'outgoing' ? 'Calling…' : phase === 'connecting' ? 'Connecting…' : reconnecting ? 'Reconnecting…' : duration((now - (startedAt ?? now)) / 1000);

  return (
    <div className={barClass} role="region" aria-label="Current call">
      <button type="button" onClick={() => navigate(`/chats/${peer.id}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Avatar name={peer.name} hue={peer.hue} size={40} speaking={phase === 'active' && remoteSpeaking && !peerMuted} muted={peerMuted} />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{peer.name}</span>
          <span className="block truncate text-[13px] text-on-shutter/70 tabular-nums">
            {status}
            {peerMuted && phase === 'active' ? ', muted' : ''}
          </span>
        </span>
      </button>
      {phase !== 'outgoing' && <MuteButton muted={muted} onClick={toggleMute} />}
      <IconButton label={phase === 'outgoing' ? 'Cancel call' : 'End call'} variant="danger" size={40} onClick={endCall}>
        <PhoneOff size={18} />
      </IconButton>
    </div>
  );
}

function VoiceBar() {
  const roomId = useVoice((s) => s.roomId);
  const status = useVoice((s) => s.status);
  const muted = useVoice((s) => s.muted);
  const toggleMute = useVoice((s) => s.toggleMute);
  const leave = useVoice((s) => s.leave);
  const room = useChat((s) => (roomId ? s.rooms[roomId] : undefined));
  const count = useChat((s) => (roomId ? s.voice[roomId]?.length ?? 0 : 0));
  const navigate = useNavigate();
  if (!roomId) return null;

  return (
    <div className={barClass} role="region" aria-label="Room voice">
      <button type="button" onClick={() => navigate(`/rooms/${roomId}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-taxi text-on-taxi">
          <AudioLines size={19} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{room?.name ?? 'Room voice'}</span>
          <span className="block truncate text-[13px] text-on-shutter/70">
            {status === 'joining' ? 'Joining voice…' : count === 1 ? 'Only you so far' : `Talking with ${count - 1} ${count - 1 === 1 ? 'other' : 'others'}`}
          </span>
        </span>
      </button>
      {status === 'live' && <MuteButton muted={muted} onClick={toggleMute} />}
      <IconButton label="Leave voice" variant="danger" size={40} onClick={() => void leave()}>
        <PhoneOff size={18} />
      </IconButton>
    </div>
  );
}

function Sink({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
}

/** Plays every remote audio stream: the call partner and room voice peers. */
export function AudioSinks() {
  const remote = useCall((s) => s.remoteStream);
  const streams = useVoice((s) => s.streams);
  return (
    <div hidden>
      {remote && <Sink stream={remote} />}
      {Object.entries(streams).map(([id, s]) => (
        <Sink key={id} stream={s} />
      ))}
    </div>
  );
}
