import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';
import { useAuth } from '../store/auth';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { Dialog, Field, inputClass } from './ui/Dialog';

/** Change your own password. `required` is for the host admin's default password on a public server. */
export function ChangePasswordDialog({ open, onClose, required = false }: { open: boolean; onClose: () => void; required?: boolean }) {
  const changePassword = useAuth((s) => s.changePassword);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setAgain('');
    setError('');
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError('Use at least 8 characters for your new password.');
    if (next !== again) return setError('The two new passwords don’t match.');
    setBusy(true);
    try {
      await changePassword(current, next);
      toast('Your password was changed.', 'live');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={required ? () => {} : onClose}
      dismissible={!required}
      title={required ? 'Set a new admin password' : 'Change password'}
      description={
        required
          ? 'This server is public and the host admin account still has its default password. Choose your own before you continue.'
          : 'You stay logged in on this device.'
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Current password">
          <input className={inputClass} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <input className={inputClass} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="New password again">
          <input className={inputClass} type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </Field>
        {error && (
          <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          {!required && (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="submit" busy={busy} disabled={!current || !next || !again}>
            Change password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
