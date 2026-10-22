import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';
import { useAuth } from '../store/auth';
import { toast } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog, Field, inputClass } from './ui/Dialog';

const MAX = 40;

/** Your name: what everyone sees with your messages, calls and rooms. Changing it shows everywhere at once. */
export function NameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const user = useAuth((s) => s.user);
  const changeName = useAuth((s) => s.changeName);
  const [value, setValue] = useState(user?.name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(user?.name ?? '');
      setError('');
    }
    // Only when the dialog opens.
  }, [open]);

  if (!user) return null;
  const next = value.replace(/\s+/g, ' ').trim();

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!next) return setError('Enter your name.');
    if (next.length > MAX) return setError(`Keep your name under ${MAX} characters.`);
    if (next === user!.name) return onClose();
    setBusy(true);
    setError('');
    try {
      await changeName(next);
      toast('Your name is changed. Everyone sees the new one.');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Your name" description="Everyone sees it with your messages, calls and rooms. Your user ID stays the same.">
      <form onSubmit={save} className="space-y-4" noValidate>
        <div className="flex items-center gap-3 rounded-2xl bg-subtle/70 px-4 py-3">
          <Avatar name={next || user.name} hue={user.hue} photo={user.photo} size={44} />
          <span className="min-w-0">
            <span className="block truncate text-[16px] font-semibold">{next || user.name}</span>
            {user.handle && <span className="block truncate text-[13px] text-ink-soft">@{user.handle}</span>}
          </span>
        </div>
        <Field label="Name" hint={`Up to ${MAX} characters.`} error={error}>
          <input
            className={inputClass}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError('');
            }}
            maxLength={MAX + 10}
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="done"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!next || next === user.name}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
