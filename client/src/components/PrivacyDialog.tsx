import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import type { User } from '../lib/types';
import { useAuth } from '../store/auth';
import { toast } from '../store/ui';
import { Dialog } from './ui/Dialog';
import { Toggle } from './ui/Toggle';

/** Online status / last seen, and read receipts. Both work both ways, like most chat apps. */
export function PrivacyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const privacy = useAuth((s) => s.user?.privacy ?? { sharePresence: true, readReceipts: true });
  const [busy, setBusy] = useState<'' | 'presence' | 'receipts'>('');

  async function save(change: { sharePresence?: boolean; readReceipts?: boolean }, what: typeof busy) {
    setBusy(what);
    try {
      const { user } = await api<{ user: User }>('/auth/privacy', { method: 'PATCH', body: change });
      useAuth.setState({ user });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Privacy" description="Choose what other people see about you." width={460}>
      <div className="space-y-5">
        <Toggle
          checked={privacy.sharePresence}
          disabled={busy === 'presence'}
          onChange={(on) => void save({ sharePresence: on }, 'presence')}
          label="Show when I'm online and last seen"
          hint="If you turn this off, people won't see when you're online or were last seen, and you won't see theirs either."
        />
        <Toggle
          checked={privacy.readReceipts}
          disabled={busy === 'receipts'}
          onChange={(on) => void save({ readReceipts: on }, 'receipts')}
          label="Read receipts"
          hint="If you turn this off, people won't see when you've read their chat messages, and you won't see when they've read yours. Messages still show when they're delivered, and rooms always show who has seen a message."
        />
      </div>
    </Dialog>
  );
}
