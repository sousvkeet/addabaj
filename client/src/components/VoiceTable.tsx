import { useEffect } from 'react';
import { AudioLines, Headphones, Mic, MicOff, PhoneOff, Video, VideoOff, Volume2 } from 'lucide-react';
import type { RoomMember, VoiceParticipant } from '../lib/types';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { canPickSpeaker, useDevices } from '../store/devices';
import { useUi } from '../store/ui';
import { useVoice } from '../store/voice';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { DeviceSelect } from './DeviceSettings';
import { useCallCameras, useRoomStageOpen } from './RoomCall';

export const VOICE_SEATS = 12;
const EMPTY: VoiceParticipant[] = [];

/** The adda table: everyone in voice sits around it; whoever speaks lights up. */
export function VoiceTable({ roomId, members }: { roomId: string; members: RoomMember[] }) {
  const participants = useChat((s) => s.voice[roomId] ?? EMPTY);
  const voiceRoom = useVoice((s) => s.roomId);
  const status = useVoice((s) => s.status);
  const muted = useVoice((s) => s.muted);
  const speaking = useVoice((s) => s.speaking);
  const connection = useVoice((s) => s.connection);
  const join = useVoice((s) => s.join);
  const leave = useVoice((s) => s.leave);
  const toggleMute = useVoice((s) => s.toggleMute);
  const moderation = useVoice((s) => s.moderation);
  const cameraOn = useVoice((s) => s.cameraOn);
  const cameraBusy = useVoice((s) => s.cameraBusy);
  const toggleCamera = useVoice((s) => s.toggleCamera);
  const setMinimized = useVoice((s) => s.setMinimized);
  const cameras = useCallCameras();
  const stageOpen = useRoomStageOpen();
  const inCall = useCall((s) => s.phase !== 'idle');
  const meId = useAuth((s) => s.user?.id);
  const openDevices = useUi((s) => s.setDevicesOpen);

  const here = voiceRoom === roomId && status !== 'idle';
  const byId = new Map(members.map((m) => [m.id, m]));
  const n = participants.length;
  const seat = n <= 6 ? 52 : n <= 9 ? 44 : 38;
  const box = 260;
  const radius = 98;
  const full = n >= VOICE_SEATS && !here;

  return (
    <section aria-label="Voice" className="px-4 pt-4 pb-5">
      <div className="relative mx-auto" style={{ width: box, height: box + 18 }}>
        {/* The orbit the seats sit on, and the glowing table in the middle. */}
        <div
          aria-hidden
          className="absolute rounded-full border border-dashed border-line"
          style={{ left: box / 2 - radius, top: box / 2 - radius, width: radius * 2, height: radius * 2 }}
        />
        <div
          className={`absolute left-1/2 size-[100px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-aurora p-[2px] ${n ? 'shadow-glow' : 'opacity-70'}`}
          style={{ top: box / 2 }}
        >
          <div className="flex size-full flex-col items-center justify-center rounded-full bg-surface px-3 text-center">
            <AudioLines size={20} className={n ? 'text-brand dark:text-live' : 'text-ink-soft'} />
            <span className="mt-1 text-[12.5px] leading-tight font-medium text-ink-soft">
              {n === 0 ? 'No one is talking yet' : `${n} at the table`}
            </span>
          </div>
        </div>
        {participants.map((p, i) => {
          const user = byId.get(p.userId);
          const angle = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
          const x = box / 2 + radius * Math.cos(angle) - seat / 2;
          const y = box / 2 + radius * Math.sin(angle) - seat / 2;
          const isMe = p.userId === meId;
          const lit = here && !p.muted && !!speaking[p.userId];
          const linking = here && !isMe && connection[p.userId] && connection[p.userId] !== 'connected';
          return (
            <div
              key={p.userId}
              className="absolute flex flex-col items-center transition-[left,top] duration-300"
              style={{ left: x, top: y, width: seat }}
              title={`${user?.name ?? 'Someone'}${p.away ? ' (reconnecting)' : ''}${p.silenced ? ' (muted by an admin)' : p.muted ? ' (muted)' : ''}${
                p.cameraBlocked ? ' (camera stopped by an admin)' : p.camera ? ' (camera on)' : ''
              }`}
            >
              <span className="relative">
                <Avatar name={user?.name ?? '?'} hue={user?.hue ?? 160} photo={user?.photo} size={seat} speaking={lit} muted={p.muted} className={linking || p.away ? 'opacity-50' : ''} />
                {p.camera && (
                  <span className="absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border-2 border-surface bg-brand text-white" aria-hidden>
                    <Video size={10} strokeWidth={2.5} />
                  </span>
                )}
              </span>
              {n <= 8 && (
                <span className="mt-1 w-[72px] truncate text-center text-[11.5px] font-semibold">
                  {isMe ? 'You' : user?.name.split(' ')[0] ?? 'Someone'}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        {!here ? (
          <>
            <Button variant="live" className="flex-1" onClick={() => void join(roomId)} disabled={inCall || full}>
              <Headphones size={17} />
              {full ? 'Voice is full' : 'Join voice'}
            </Button>
            {!full && (
              <Button variant="soft" className="flex-1" onClick={() => void join(roomId, { video: true })} disabled={inCall}>
                <Video size={17} />
                Join with video
              </Button>
            )}
          </>
        ) : status === 'joining' ? (
          <Button variant="live" className="flex-1" busy>
            Joining…
          </Button>
        ) : (
          <>
            <Button
              variant={muted ? 'live' : 'soft'}
              className="flex-1"
              onClick={toggleMute}
              aria-pressed={muted}
              aria-label={moderation.voiceMuted ? 'Muted by an admin' : undefined}
            >
              {muted ? <MicOff size={17} /> : <Mic size={17} />}
              {moderation.voiceMuted ? 'Muted' : muted ? 'Unmute' : 'Mute'}
            </Button>
            <Button
              variant={cameraOn ? 'live' : 'soft'}
              className="flex-1"
              onClick={() => void toggleCamera()}
              disabled={cameraBusy}
              aria-pressed={cameraOn}
              aria-label={moderation.cameraBlocked ? 'Camera stopped by an admin' : cameraOn ? 'Turn camera off' : 'Turn camera on'}
            >
              {cameraOn ? <Video size={17} /> : <VideoOff size={17} />}
              Camera
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => void leave()}>
              <PhoneOff size={17} />
              Leave
            </Button>
          </>
        )}
      </div>
      {here && status === 'live' && cameras > 0 && !stageOpen && (
        <Button variant="outline" className="mt-2 w-full" onClick={() => setMinimized(false)}>
          <Video size={17} />
          Show video ({cameras} on camera)
        </Button>
      )}
      <p className="mt-2 text-center text-[12.5px] text-ink-soft">
        {here && (moderation.voiceMuted || moderation.cameraBlocked)
          ? `An admin ${moderation.voiceMuted && moderation.cameraBlocked ? 'muted you and stopped your camera' : moderation.voiceMuted ? 'muted you' : 'stopped your camera'} until they let you.`
          : inCall && !here
            ? 'End your call to join voice.'
            : `Up to ${VOICE_SEATS} people can talk at once, cameras on or off.`}
      </p>
      <DevicePickers onMore={() => openDevices(true)} />
    </section>
  );
}

/** Microphone and speaker choice, right where people talk. */
function DevicePickers({ onMore }: { onMore: () => void }) {
  const refresh = useDevices((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mt-4 space-y-2 rounded-2xl border border-line/70 bg-subtle/40 p-3">
      <label className="flex items-center gap-2.5">
        <Mic size={16} className="shrink-0 text-ink-soft" aria-hidden />
        <span className="sr-only">Microphone</span>
        <DeviceSelect kind="audioinput" label="Microphone" compact />
      </label>
      {canPickSpeaker && (
        <label className="flex items-center gap-2.5">
          <Volume2 size={16} className="shrink-0 text-ink-soft" aria-hidden />
          <span className="sr-only">Speaker</span>
          <DeviceSelect kind="audiooutput" label="Speaker" compact />
        </label>
      )}
      <button type="button" onClick={onMore} className="pl-[26px] text-[12.5px] font-semibold text-brand underline-offset-2 hover:underline dark:text-live">
        Test microphone and speaker
      </button>
    </div>
  );
}
