import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AudioLines, Ear, Mic, MicOff, Minimize2, Pause, Phone, PhoneOff, Play, Radio, Settings2, Square, Video, VideoOff, Volume2 } from 'lucide-react';
import { duration } from '../lib/format';
import { canToggleSpeaker, nativeSetSpeaker, nativeSpeakerOn, onNative } from '../lib/native';
import { audioContext } from '../lib/sounds';
import { useNow } from '../lib/useMedia';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { canPickSpeaker, useDevices } from '../store/devices';
import { useLiveStream } from '../store/liveStream';
import { useUi } from '../store/ui';
import { useVoice } from '../store/voice';
import { Avatar } from './ui/Avatar';
import { IconButton } from './ui/Button';

const LIVE_PHASES = ['outgoing', 'connecting', 'active'];

/** True when the call should show the video window rather than the bar. */
function useVideoActive() {
  return useCall((s) => s.cameraOn || s.peerCameraOn || (s.videoCall && s.phase !== 'active'));
}

/** Full-screen ring for an incoming one-to-one call. */
export function IncomingCall() {
  const phase = useCall((s) => s.phase);
  const peer = useCall((s) => s.peer);
  const video = useCall((s) => s.videoCall);
  const accepting = useCall((s) => s.accepting);
  const accept = useCall((s) => s.acceptCall);
  const decline = useCall((s) => s.declineCall);
  const navigate = useNavigate();
  const acceptRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (phase === 'incoming') acceptRef.current?.focus();
  }, [phase]);

  if (phase !== 'incoming' || !peer) return null;
  const answer = (withVideo: boolean) => {
    void accept({ video: withVideo });
    navigate(`/chats/${peer.id}`);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(6_8_22/0.62)] p-4 backdrop-blur-[6px] sm:items-center">
      <div
        role="alertdialog"
        aria-labelledby="incoming-name"
        aria-describedby="incoming-label"
        className="pop-in relative w-full max-w-sm overflow-hidden rounded-[32px] border border-white/10 bg-deep px-8 pt-10 pb-8 text-center text-on-brand shadow-2xl"
      >
        <span aria-hidden className="absolute -top-28 left-1/2 size-80 -translate-x-1/2 rounded-full bg-aurora opacity-35 blur-3xl" />
        <div className="ring-pulse relative mx-auto w-fit rounded-full">
          <Avatar name={peer.name} hue={peer.hue} photo={peer.photo} size={104} />
        </div>
        <p id="incoming-label" className="relative mt-7 text-[14px] font-medium text-on-brand/70">
          {video ? 'Incoming video call' : 'Incoming voice call'}
        </p>
        <h2 id="incoming-name" className="relative mt-0.5 font-display text-[30px] leading-tight font-bold tracking-[-0.02em]">
          {peer.name}
        </h2>
        <div className={`relative mt-9 flex justify-center ${video ? 'gap-8' : 'gap-14'}`}>
          <div className="flex flex-col items-center gap-2">
            <IconButton label="Decline call" variant="danger" size={64} onClick={decline} disabled={accepting}>
              <PhoneOff size={26} />
            </IconButton>
            <span className="text-[13px] text-on-brand/80">Decline</span>
          </div>
          {video && (
            <div className="flex flex-col items-center gap-2">
              <IconButton label="Answer with voice only" variant="on-dark" size={64} onClick={() => answer(false)} disabled={accepting}>
                <Phone size={26} />
              </IconButton>
              <span className="text-[13px] text-on-brand/80">Voice only</span>
            </div>
          )}
          <div className="flex flex-col items-center gap-2">
            <button
              ref={acceptRef}
              type="button"
              aria-label={video ? 'Accept with video' : 'Accept call'}
              disabled={accepting}
              onClick={() => answer(video)}
              className="inline-flex size-16 items-center justify-center rounded-full bg-live text-on-live shadow-[0_0_30px_-4px_var(--live)] transition-transform hover:scale-105 hover:brightness-105 disabled:opacity-60"
            >
              {video ? <Video size={26} /> : <Phone size={26} />}
            </button>
            <span className="text-[13px] text-on-brand/80">{accepting ? 'Connecting…' : video ? 'With video' : 'Accept'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Persistent bar for whatever is live: a one-to-one call, room voice, or your live stream. */
export function LiveBar() {
  const phase = useCall((s) => s.phase);
  const minimized = useCall((s) => s.minimized);
  const videoActive = useVideoActive();
  const voiceStatus = useVoice((s) => s.status);
  const streaming = useStreamElsewhere();
  if (LIVE_PHASES.includes(phase)) return videoActive && !minimized ? null : <CallBar />;
  if (voiceStatus !== 'idle') return <VoiceBar />;
  if (streaming) return <StreamBar />;
  return null;
}

/** Streaming to a room while looking at another page (the room's own page shows the stream). */
function useStreamElsewhere() {
  const roomId = useLiveStream((s) => s.host?.roomId);
  const { pathname } = useLocation();
  return !!roomId && pathname !== `/rooms/${roomId}`;
}

/** Shown when the browser blocked call audio; one tap lets it play. */
function SoundBlocked({ className = '' }: { className?: string }) {
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

export const useLive = () => {
  const phase = useCall((s) => s.phase);
  const voiceStatus = useVoice((s) => s.status);
  const streaming = useStreamElsewhere();
  return (phase !== 'idle' && phase !== 'incoming') || voiceStatus !== 'idle' || streaming;
};

const barClass =
  'pop-in glass-deep fixed inset-x-2 top-[max(8px,var(--safe-top))] z-40 flex items-center gap-2 rounded-[22px] border border-white/10 p-2.5 pl-3 text-on-brand shadow-[0_16px_40px_-16px_rgb(4_6_18/0.7)] md:inset-x-auto md:top-auto md:bottom-6 md:left-[120px] md:w-[316px]';
const barPrompt = 'inset-x-0 top-full mt-2 md:top-auto md:bottom-full md:mt-0 md:mb-2';

/** Glows while your own microphone picks up sound, so you know it's working. */
function MuteButton({ muted, speaking, onClick, size = 40 }: { muted: boolean; speaking: boolean; onClick: () => void; size?: number }) {
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
function SpeakerButton({ size = 40 }: { size?: number }) {
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

function CameraButton({ size = 40 }: { size?: number }) {
  const cameraOn = useCall((s) => s.cameraOn);
  const busy = useCall((s) => s.cameraBusy);
  const toggle = useCall((s) => s.toggleCamera);
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

function useCallStatus() {
  const phase = useCall((s) => s.phase);
  const startedAt = useCall((s) => s.startedAt);
  const reconnecting = useCall((s) => s.reconnecting);
  const noIncomingAudio = useCall((s) => s.noIncomingAudio);
  const now = useNow(1000, phase === 'active');
  if (phase === 'outgoing') return 'Calling…';
  if (phase === 'connecting') return 'Connecting…';
  if (reconnecting) return 'Reconnecting…';
  if (noIncomingAudio) return 'No sound arriving';
  return duration((now - (startedAt ?? now)) / 1000);
}

function CallBar() {
  const phase = useCall((s) => s.phase);
  const peer = useCall((s) => s.peer);
  const muted = useCall((s) => s.muted);
  const peerMuted = useCall((s) => s.peerMuted);
  const remoteSpeaking = useCall((s) => s.remoteSpeaking);
  const localSpeaking = useCall((s) => s.localSpeaking);
  const noIncomingAudio = useCall((s) => s.noIncomingAudio);
  const toggleMute = useCall((s) => s.toggleMute);
  const endCall = useCall((s) => s.endCall);
  const setMinimized = useCall((s) => s.setMinimized);
  const videoActive = useVideoActive();
  const status = useCallStatus();
  const navigate = useNavigate();
  if (!peer) return null;

  return (
    <div className={barClass} role="region" aria-label="Current call">
      <SoundBlocked className={barPrompt} />
      <button
        type="button"
        onClick={() => {
          navigate(`/chats/${peer.id}`);
          if (videoActive) setMinimized(false);
        }}
        aria-label={videoActive ? `Show video with ${peer.name}` : `Open chat with ${peer.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Avatar name={peer.name} hue={peer.hue} photo={peer.photo} size={40} speaking={phase === 'active' && remoteSpeaking && !peerMuted} muted={peerMuted} />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{peer.name}</span>
          <span className={`block truncate text-[13px] tabular-nums ${noIncomingAudio && phase === 'active' ? 'text-live' : 'text-on-brand/70'}`}>
            {status}
            {peerMuted && phase === 'active' ? ', muted' : ''}
          </span>
        </span>
      </button>
      {phase !== 'outgoing' && <SpeakerButton size={38} />}
      {phase !== 'outgoing' && <CameraButton size={38} />}
      {phase !== 'outgoing' && <MuteButton muted={muted} speaking={localSpeaking} onClick={toggleMute} size={38} />}
      <IconButton label={phase === 'outgoing' ? 'Cancel call' : 'End call'} variant="danger" size={38} onClick={endCall}>
        <PhoneOff size={17} />
      </IconButton>
    </div>
  );
}

/** The video window: the other person large, you in the corner. */
export function CallStage() {
  const phase = useCall((s) => s.phase);
  const peer = useCall((s) => s.peer);
  const minimized = useCall((s) => s.minimized);
  const cameraOn = useCall((s) => s.cameraOn);
  const peerCameraOn = useCall((s) => s.peerCameraOn);
  const localVideo = useCall((s) => s.localVideo);
  const remoteStream = useCall((s) => s.remoteStream);
  const muted = useCall((s) => s.muted);
  const peerMuted = useCall((s) => s.peerMuted);
  const localSpeaking = useCall((s) => s.localSpeaking);
  const remoteSpeaking = useCall((s) => s.remoteSpeaking);
  const toggleMute = useCall((s) => s.toggleMute);
  const endCall = useCall((s) => s.endCall);
  const setMinimized = useCall((s) => s.setMinimized);
  const openDevices = useUi((s) => s.setDevicesOpen);
  const videoActive = useVideoActive();
  const status = useCallStatus();

  if (!LIVE_PHASES.includes(phase) || !peer || !videoActive || minimized) return null;
  const remoteVideo = peerCameraOn && phase !== 'outgoing' && remoteStream?.getVideoTracks().length ? remoteStream : null;
  const first = peer.name.split(' ')[0];

  return (
    <div
      role="region"
      aria-label={`Video call with ${peer.name}`}
      className="pop-in fixed inset-0 z-[45] flex flex-col bg-deep text-on-brand md:inset-auto md:right-4 md:bottom-4 md:h-[min(560px,calc(100dvh-32px))] md:w-[min(780px,calc(100vw-440px))] md:overflow-hidden md:rounded-[28px] md:border md:border-white/10 md:shadow-[0_30px_70px_-20px_rgb(4_6_18/0.75)]"
    >
      <div className="relative min-h-0 flex-1 bg-black/30">
        {remoteVideo ? (
          <VideoView stream={remoteVideo} remote className="size-full object-cover md:object-contain" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
            <Avatar name={peer.name} hue={peer.hue} photo={peer.photo} size={112} speaking={phase === 'active' && remoteSpeaking && !peerMuted} muted={peerMuted} />
            <p className="text-[14px] text-on-brand/70">
              {phase === 'active' ? `${first}'s camera is off` : phase === 'connecting' ? 'Connecting…' : `Calling ${first}…`}
            </p>
          </div>
        )}

        {/* Name and timer stay legible over any picture. */}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-[linear-gradient(rgb(0_0_0/0.55),transparent)] p-3 pt-[max(12px,var(--safe-top))]">
          <div className="min-w-0 pl-1">
            <p className="truncate font-display text-[21px] leading-tight text-white">{peer.name}</p>
            <p className="truncate text-[13px] text-white/80 tabular-nums">
              {status}
              {peerMuted && phase === 'active' ? ', muted' : ''}
            </p>
          </div>
          <IconButton label="Shrink video" variant="on-dark" size={38} onClick={() => setMinimized(true)}>
            <Minimize2 size={17} />
          </IconButton>
        </div>

        <SoundBlocked className="inset-x-4 top-20" />

        {cameraOn && localVideo && (
          <div className="absolute right-3 bottom-3 w-[30%] max-w-[190px] min-w-[96px] overflow-hidden rounded-xl border border-white/25 bg-black shadow-lg">
            <VideoView stream={localVideo} mirrored className="aspect-[3/4] w-full object-cover md:aspect-video" />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-center gap-4 p-3 pb-[max(14px,var(--safe-bottom))]">
        {phase !== 'outgoing' && <MuteButton muted={muted} speaking={localSpeaking} onClick={toggleMute} size={50} />}
        <CameraButton size={50} />
        <SpeakerButton size={50} />
        <IconButton label="Audio and video settings" variant="on-dark" size={50} onClick={() => openDevices(true)}>
          <Settings2 size={22} />
        </IconButton>
        <IconButton label={phase === 'outgoing' ? 'Cancel call' : 'End call'} variant="danger" size={50} onClick={endCall}>
          <PhoneOff size={22} />
        </IconButton>
      </div>
    </div>
  );
}

/** Muted <video>: call audio always plays through the separate audio sink. */
function VideoView({ stream, mirrored, remote, className = '' }: { stream: MediaStream; mirrored?: boolean; remote?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
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
      data-remote-video={remote ? '' : undefined}
      data-self-video={remote ? undefined : ''}
      className={`${mirrored ? '-scale-x-100' : ''} ${className}`}
    />
  );
}

function VoiceBar() {
  const roomId = useVoice((s) => s.roomId);
  const status = useVoice((s) => s.status);
  const muted = useVoice((s) => s.muted);
  const toggleMute = useVoice((s) => s.toggleMute);
  const leave = useVoice((s) => s.leave);
  const meSpeaking = useVoice((s) => !!s.speaking[useAuth.getState().user?.id ?? '']);
  const room = useChat((s) => (roomId ? s.rooms[roomId] : undefined));
  const count = useChat((s) => (roomId ? s.voice[roomId]?.length ?? 0 : 0));
  const navigate = useNavigate();
  if (!roomId) return null;

  return (
    <div className={barClass} role="region" aria-label="Room voice">
      <SoundBlocked className={barPrompt} />
      <button type="button" onClick={() => navigate(`/rooms/${roomId}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-live text-on-live shadow-[0_0_16px_-2px_var(--live)]">
          <AudioLines size={19} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{room?.name ?? 'Room voice'}</span>
          <span className="block truncate text-[13px] text-on-brand/70">
            {status === 'joining' ? 'Joining voice…' : count === 1 ? 'Only you so far' : `Talking with ${count - 1} ${count - 1 === 1 ? 'other' : 'others'}`}
          </span>
        </span>
      </button>
      {status === 'live' && <MuteButton muted={muted} speaking={meSpeaking} onClick={toggleMute} />}
      <IconButton label="Leave voice" variant="danger" size={40} onClick={() => void leave()}>
        <PhoneOff size={18} />
      </IconButton>
    </div>
  );
}

/** Your live stream keeps going while you look around the app; this keeps it in reach. */
function StreamBar() {
  const host = useLiveStream((s) => s.host);
  const room = useChat((s) => (host ? s.rooms[host.roomId] : undefined));
  const navigate = useNavigate();
  if (!host) return null;
  const live = useLiveStream.getState();
  const watching = Object.values(host.viewers).filter((v) => v === 'connected').length;

  return (
    <div className={barClass} role="region" aria-label="Your live stream">
      <button type="button" onClick={() => navigate(`/rooms/${host.roomId}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger text-white shadow-[0_0_16px_-2px_var(--danger)]">
          <Radio size={19} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">Live in {room?.name ?? 'your room'}</span>
          <span className="block truncate text-[13px] text-on-brand/70">
            {host.title}, {watching} watching
          </span>
        </span>
      </button>
      {host.mode === 'file' && (
        <IconButton label={host.playing ? 'Pause for everyone' : 'Play for everyone'} variant="on-dark" size={40} onClick={() => (host.playing ? live.pause() : live.play())}>
          {host.playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </IconButton>
      )}
      <IconButton label="Stop streaming" variant="danger" size={40} onClick={() => void live.stop()}>
        <Square size={16} />
      </IconButton>
    </div>
  );
}

type SinkElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

function Sink({ stream }: { stream: MediaStream }) {
  const ref = useRef<SinkElement>(null);
  const setBlocked = useUi((s) => s.setSoundBlocked);
  const speaker = useDevices((s) => s.choice.audiooutput);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Re-assigning the same stream restarts loading and aborts play(), so only set it once.
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().then(
      () => setBlocked(false),
      (err: DOMException) => {
        if (err.name === 'NotAllowedError') setBlocked(true);
      },
    );
  }, [stream, setBlocked]);

  // Route call audio to the speaker chosen in settings ('' = system default).
  useEffect(() => {
    if (canPickSpeaker) void ref.current?.setSinkId?.(speaker).catch(() => {});
  }, [speaker]);

  return <audio ref={ref} data-call-audio autoPlay playsInline />;
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
