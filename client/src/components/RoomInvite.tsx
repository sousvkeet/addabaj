import { useEffect, useId, useState, type FormEvent } from 'react';
import { Copy, Link2, Lock, LockOpen, RefreshCw, Share2 } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { copyText, formatRoomCode, roomLink, shareText } from '../lib/invite';
import type { RoomSummary } from '../lib/types';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { ConfirmDialog, Dialog, Field, inputClass } from './ui/Dialog';

/** Admins: the room's invite code to share, and who can join with it. */
export function RoomInviteCard({ room }: { room: RoomSummary }) {
  const renewRoomCode = useChat((s) => s.renewRoomCode);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  if (!room.joinCode) return null;
  const code = room.joinCode;
  const message = `Join ${room.name} on Adda Khana: ${roomLink(code)}\nInvite code: ${formatRoomCode(code)}${room.hasPassword ? ' (ask me for the password)' : ''}`;

  async function renew() {
    setBusy(true);
    try {
      await renewRoomCode(room.id);
      toast('New invite code made. The old one no longer works.');
      setConfirmNew(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="mx-2 mb-3 rounded-2xl border border-line/70 bg-subtle/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="text-[13px] font-semibold text-ink-soft">
            Invite code
          </h3>
          <p className="font-mono text-[20px] font-semibold tracking-[0.12em]" aria-label={`Invite code ${code.split('').join(' ')}`}>
            {formatRoomCode(code)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAccessOpen(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[12.5px] font-semibold text-ink-soft hover:text-ink"
          aria-label={room.hasPassword ? 'Password protected. Change who can join' : 'Open to anyone with the code. Change who can join'}
        >
          {room.hasPassword ? <Lock size={13} /> : <LockOpen size={13} />}
          {room.hasPassword ? 'Password' : 'Open'}
        </button>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-soft">
        {room.hasPassword ? 'People need this code and the room password to join.' : 'Anyone with this code can join.'}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => void shareText(message, 'Invite')}>
          <Share2 size={14} />
          Share link
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyText(code, 'Invite code')}>
          <Copy size={14} />
          Copy code
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyText(roomLink(code), 'Invite link')}>
          <Link2 size={14} />
          Copy link
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmNew(true)}>
          <RefreshCw size={14} />
          New code
        </Button>
      </div>
      <RoomAccessDialog room={room} open={accessOpen} onClose={() => setAccessOpen(false)} />
      <ConfirmDialog
        open={confirmNew}
        title="Make a new invite code?"
        body="The current code and links stop working. People already in the room stay."
        confirm="Make new code"
        busy={busy}
        onConfirm={() => void renew()}
        onClose={() => setConfirmNew(false)}
      />
    </section>
  );
}

/** Admins: open to anyone with the code, or code plus a password. */
export function RoomAccessDialog({ room, open, onClose }: { room: RoomSummary; open: boolean; onClose: () => void }) {
  const setRoomPassword = useChat((s) => s.setRoomPassword);
  const [mode, setMode] = useState<'open' | 'password'>(room.hasPassword ? 'password' : 'open');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setMode(room.hasPassword ? 'password' : 'open');
      setPassword('');
      setError('');
    }
    // Only when the dialog opens.
  }, [open]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (mode === 'password' && password.length < 4) {
      return setError(room.hasPassword && !password ? 'Type a new password to change it, or close to keep the current one.' : 'Use at least 4 characters for the room password.');
    }
    setBusy(true);
    setError('');
    try {
      await setRoomPassword(room.id, mode === 'password' ? password : null);
      toast(mode === 'password' ? 'The room now needs a password to join.' : 'Anyone with the code can join now.');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Who can join with the code" description="People already in the room stay either way.">
      <form onSubmit={save} className="space-y-4" noValidate>
        <AccessChoice value={mode} onChange={setMode} />
        {mode === 'password' && (
          <Field label={room.hasPassword ? 'New room password' : 'Room password'} hint="At least 4 characters. Share it only with people you want in the room.">
            <input className={inputClass} type="text" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={64} autoComplete="off" autoFocus />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-[14px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Open / Password protected. */
export function AccessChoice({ value, onChange }: { value: 'open' | 'password'; onChange: (v: 'open' | 'password') => void }) {
  const options = [
    ['open', 'Open', 'Anyone with the invite code can join', LockOpen],
    ['password', 'Password protected', 'They also need a password you choose', Lock],
  ] as const;
  return (
    <div role="radiogroup" aria-label="Who can join with the code" className="grid gap-2 sm:grid-cols-2">
      {options.map(([id, label, text, Icon]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`flex items-start gap-2.5 rounded-2xl border p-3 text-left transition-colors ${
            value === id ? 'border-brand bg-brand/10' : 'border-line hover:bg-subtle'
          }`}
        >
          <Icon size={18} className={`mt-0.5 shrink-0 ${value === id ? 'text-brand dark:text-live' : 'text-ink-soft'}`} />
          <span>
            <span className="block text-[14.5px] font-semibold">{label}</span>
            <span className="block text-[12.5px] text-ink-soft">{text}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
