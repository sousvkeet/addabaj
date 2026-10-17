import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../lib/api';
import type { RoomDetail } from '../lib/types';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { Dialog, Field, inputClass } from './ui/Dialog';
import { MemberLimit } from './MemberLimit';

export function RoomSettingsDialog({ room, open, onClose, isOwner }: { room: RoomDetail; open: boolean; onClose: () => void; isOwner: boolean }) {
  const updateRoom = useChat((s) => s.updateRoom);
  const deleteRoom = useChat((s) => s.deleteRoom);
  const navigate = useNavigate();
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [max, setMax] = useState(room.maxMembers);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setName(room.name);
      setDescription(room.description);
      setMax(room.maxMembers);
      setError('');
      setConfirmDelete(false);
    }
    // Only reset when the dialog opens, not on every live room update.
  }, [open]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the room a name.');
    if (max < room.memberCount) return setError(`The room has ${room.memberCount} members, so the limit can't go below that.`);
    setBusy('save');
    setError('');
    try {
      await updateRoom(room.id, { name: name.trim(), description: description.trim(), maxMembers: max });
      toast('Room settings saved.');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    try {
      await deleteRoom(room.id);
      onClose();
      navigate('/rooms', { replace: true });
      toast(`${room.name} was deleted.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Room settings">
      <form onSubmit={save} className="space-y-5" noValidate>
        <Field label="Room name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label="What's it for?">
          <textarea
            className={`${inputClass} h-auto min-h-[76px] resize-none py-2.5`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={280}
            rows={2}
          />
        </Field>
        <Field label="Maximum members" hint={`${room.memberCount} people are in the room now, so the limit can't go lower than that.`}>
          <MemberLimit value={max} onChange={setMax} min={room.memberCount} />
        </Field>
        {error && <p role="alert" className="text-[14px] text-oxide">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy === 'save'} disabled={!!busy}>
            Save changes
          </Button>
        </div>
      </form>

      {isOwner && (
        <div className="mt-6 border-t border-line pt-5">
          <h3 className="font-semibold">Delete this room</h3>
          <p className="mt-0.5 text-[14px] text-ink-soft">Everyone is removed and the chat history is gone for good.</p>
          {confirmDelete ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-oxide/10 p-3">
              <span className="flex-1 text-[14px] text-oxide">Delete {room.name} for everyone?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep room
              </Button>
              <Button size="sm" variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
                Delete room
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="mt-3 text-oxide" onClick={() => setConfirmDelete(true)}>
              Delete room
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}
