import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { KeyRound, Lock, Users } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { formatRoomCode } from '../lib/invite';
import type { RoomPreview } from '../lib/types';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog, Field, inputClass } from './ui/Dialog';

const clean = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Join a room with its invite code (and its password, if it has one). `code` comes from a /join link. */
export function JoinRoomDialog({ open, onClose, code: given = '' }: { open: boolean; onClose: () => void; code?: string }) {
  const joinRoom = useChat((s) => s.joinRoom);
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [room, setRoom] = useState<RoomPreview | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function lookUp(value: string) {
    setBusy(true);
    setError('');
    try {
      const { room } = await api<{ room: RoomPreview }>(`/rooms/join/${encodeURIComponent(clean(value))}`);
      setRoom(room);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setCode(given ? formatRoomCode(clean(given)) : '');
    setRoom(null);
    setPassword('');
    setError('');
    if (given) void lookUp(given);
    // When the dialog opens (or a new link arrives).
  }, [open, given]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!room) {
      if (clean(code).length !== 8) return setError('Room codes are 8 letters and numbers, like K7PQ-2XMB.');
      return void lookUp(code);
    }
    if (room.member) {
      onClose();
      return navigate(`/rooms/${room.id}`);
    }
    if (room.needsPassword && !password) return setError('Enter the room password.');
    setBusy(true);
    setError('');
    try {
      const joined = await joinRoom(clean(code), room.needsPassword ? password : undefined);
      onClose();
      toast(`You joined ${joined.name}.`);
      navigate(`/rooms/${joined.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const full = room && !room.member && room.memberCount >= room.maxMembers;

  return (
    <Dialog open={open} onClose={onClose} title="Join a room" description="Enter the invite code someone shared with you.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Invite code">
          <input
            className={`${inputClass} font-mono tracking-[0.18em] uppercase`}
            value={code}
            onChange={(e) => {
              const c = clean(e.target.value).slice(0, 8);
              setCode(c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
              setRoom(null);
              setError('');
            }}
            placeholder="K7PQ-2XMB"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={!given}
          />
        </Field>
        {room && (
          <div className="flex items-center gap-3 rounded-2xl border border-line/70 p-3">
            <Avatar name={room.name} hue={hueFromId(room.id)} size={46} square />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 font-semibold">
                <span className="truncate">{room.name}</span>
                {room.needsPassword && <Lock size={14} className="shrink-0 text-ink-soft" aria-label="Password protected" />}
              </span>
              <span className="flex items-center gap-1 text-[13px] text-ink-soft">
                <Users size={13} />
                {room.memberCount} of {room.maxMembers} members
                {room.member && ' · You’re in this room'}
              </span>
              {room.description && <span className="mt-0.5 block truncate text-[13px] text-ink-soft">{room.description}</span>}
            </span>
          </div>
        )}
        {room?.needsPassword && !room.member && (
          <Field label="Room password" hint="The room’s admins set it. Ask whoever shared the code.">
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              autoFocus
              autoComplete="off"
            />
          </Field>
        )}
        {full && <p className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">This room is full. Ask one of its admins to make room.</p>}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!!full}>
            {!room ? (
              <>
                <KeyRound size={16} />
                Find room
              </>
            ) : room.member ? (
              'Open room'
            ) : (
              'Join room'
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
