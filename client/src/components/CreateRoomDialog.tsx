import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../lib/api';
import { useChat } from '../store/chat';
import { Button } from './ui/Button';
import { Dialog, Field, inputClass } from './ui/Dialog';
import { MemberLimit, ROOM_MAX, ROOM_MIN } from './MemberLimit';
import { AccessChoice } from './RoomInvite';

export function CreateRoomDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createRoom = useChat((s) => s.createRoom);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [max, setMax] = useState(12);
  const [access, setAccess] = useState<'open' | 'password'>('open');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function close() {
    setName('');
    setDescription('');
    setMax(12);
    setAccess('open');
    setPassword('');
    setError('');
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the room a name.');
    if (max < ROOM_MIN || max > ROOM_MAX) return setError(`Choose a limit between ${ROOM_MIN} and ${ROOM_MAX}.`);
    if (access === 'password' && password.length < 4) return setError('Use at least 4 characters for the room password.');
    setBusy(true);
    setError('');
    try {
      const room = await createRoom({
        name: name.trim(),
        description: description.trim(),
        maxMembers: max,
        ...(access === 'password' ? { password } : {}),
      });
      close();
      navigate(`/rooms/${room.id}`, { state: { addPeople: true } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title="Start a room" description="You'll be the room's admin. Share its invite code, or add people by their user ID.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field label="Room name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Friday tea stall" autoFocus />
        </Field>
        <Field label="What's it for?" hint="Optional. Members see this under the room name.">
          <textarea
            className={`${inputClass} h-auto min-h-[76px] resize-none py-2.5`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={280}
            rows={2}
            placeholder="Old college friends catching up on weekends"
          />
        </Field>
        <Field label="Maximum members" hint={`Including you. Between ${ROOM_MIN} and ${ROOM_MAX}; you can change it later.`}>
          <MemberLimit value={max} onChange={setMax} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13.5px] font-semibold">Who can join with the invite code</p>
          <AccessChoice value={access} onChange={setAccess} />
        </div>
        {access === 'password' && (
          <Field label="Room password" hint="At least 4 characters. You can change it later in the room.">
            <input className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} maxLength={64} autoComplete="off" />
          </Field>
        )}
        {error && <p role="alert" className="text-[14px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create room
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
