import { Coffee, Headphones, Mic, MicOff, PhoneOff } from 'lucide-react';
import type { RoomMember, VoiceParticipant } from '../lib/types';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { useVoice } from '../store/voice';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';

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
  const inCall = useCall((s) => s.phase !== 'idle');
  const meId = useAuth((s) => s.user?.id);

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
        <div
          className="absolute left-1/2 flex size-[112px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-line bg-wall px-3 text-center"
          style={{ top: box / 2 }}
        >
          <Coffee size={20} className="text-ink-soft" />
          <span className="mt-1 text-[13px] leading-tight text-ink-soft">
            {n === 0 ? 'No one is talking yet' : `${n} at the table`}
          </span>
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
              title={`${user?.name ?? 'Someone'}${p.muted ? ' (muted)' : ''}`}
            >
              <Avatar name={user?.name ?? '?'} hue={user?.hue ?? 160} size={seat} speaking={lit} muted={p.muted} className={linking ? 'opacity-50' : ''} />
              {n <= 8 && (
                <span className="mt-1 w-[72px] truncate text-center text-[11.5px] font-medium">
                  {isMe ? 'You' : user?.name.split(' ')[0] ?? 'Someone'}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        {!here ? (
          <Button
            variant="live"
            className="flex-1"
            onClick={() => void join(roomId)}
            disabled={inCall || full}
          >
            <Headphones size={17} />
            {full ? 'Voice is full' : 'Join voice'}
          </Button>
        ) : status === 'joining' ? (
          <Button variant="live" className="flex-1" busy>
            Joining…
          </Button>
        ) : (
          <>
            <Button variant={muted ? 'live' : 'outline'} className="flex-1" onClick={toggleMute} aria-pressed={muted}>
              {muted ? <MicOff size={17} /> : <Mic size={17} />}
              {muted ? 'Unmute' : 'Mute'}
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => void leave()}>
              <PhoneOff size={17} />
              Leave
            </Button>
          </>
        )}
      </div>
      <p className="mt-2 text-center text-[12.5px] text-ink-soft">
        {inCall && !here ? 'End your call to join voice.' : `Up to ${VOICE_SEATS} people can talk at once.`}
      </p>
    </section>
  );
}
