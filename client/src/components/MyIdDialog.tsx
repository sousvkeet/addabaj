import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Share2 } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { copyText, shareText } from '../lib/invite';
import { useAuth } from '../store/auth';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { Dialog, Field, inputClass } from './ui/Dialog';

const RULES = 'Use 3 to 24 letters, numbers, dots or underscores, starting and ending with a letter or number.';
const VALID = /^[a-z0-9](?:[a-z0-9]|[._](?![._])){1,22}[a-z0-9]$/;

/** Your user ID: what friends type to find you. Copy it, share it, or change it. */
export function MyIdDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const handle = useAuth((s) => s.user?.handle ?? '');
  const changeHandle = useAuth((s) => s.changeHandle);
  const [value, setValue] = useState(handle);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(handle);
      setError('');
    }
    // Only when the dialog opens.
  }, [open]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const next = value.trim().replace(/^@/, '').toLowerCase();
    if (next === handle) return onClose();
    if (!VALID.test(next)) return setError(`That user ID won't work. ${RULES}`);
    setBusy(true);
    setError('');
    try {
      await changeHandle(next);
      toast(`Your user ID is now @${next}.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Your user ID" description="Friends find you on Adda Khana by your user ID or your email. Nobody is listed.">
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl bg-subtle/70 px-4 py-3">
        <span className="min-w-0 flex-1 truncate font-display text-[20px] font-semibold">@{handle}</span>
        <Button size="sm" variant="ghost" onClick={() => void copyText(handle, 'Your user ID')}>
          <Copy size={15} />
          Copy
        </Button>
        <Button size="sm" variant="soft" onClick={() => void shareText(`Find me on Adda Khana: my user ID is ${handle}\n${location.origin}`, 'Your user ID')}>
          <Share2 size={15} />
          Share
        </Button>
      </div>
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field label="Change your user ID" hint={`${RULES} Your old ID stops working.`} error={error}>
          <input
            className={inputClass}
            value={value}
            onChange={(e) => {
              setValue(e.target.value.toLowerCase().replace(/\s/g, ''));
              setError('');
            }}
            maxLength={25}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" busy={busy} disabled={value.trim().replace(/^@/, '') === handle}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
