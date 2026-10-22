import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import type { User } from '../lib/types';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Toggle } from './ui/Toggle';

type Blocked = { id: string; name: string; handle: string | null; hue: number; photo: string | null };

/** Online status / last seen, and read receipts (both work both ways, like most chat apps); and who I've blocked. */
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
    <Dialog open={open} onClose={onClose} title="Privacy" description="Choose what other people see about you, and who can reach you." width={460}>
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
        {open && <BlockedPeople />}
      </div>
    </Dialog>
  );
}

/** People I've blocked (from a chat's menu), and unblocking them. */
function BlockedPeople() {
  const [list, setList] = useState<Blocked[] | null>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api<{ blocked: Blocked[] }>('/users/blocked')
      .then(({ blocked }) => setList(blocked))
      .catch((err) => toast(errorMessage(err), 'error'));
  }, []);

  async function unblock(person: Blocked) {
    setBusy(person.id);
    try {
      await useChat.getState().unblock(person.id);
      setList((l) => l?.filter((p) => p.id !== person.id) ?? null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <section aria-labelledby="blocked-heading" className="border-t border-line/70 pt-4">
      <h3 id="blocked-heading" className="font-semibold">
        Blocked people
      </h3>
      <p className="mt-0.5 text-[13.5px] text-ink-soft">They can't message or call you, or add you to rooms. Block someone from your chat's ⋮ menu.</p>
      {list === null ? null : list.length === 0 ? (
        <p className="mt-3 rounded-2xl bg-subtle/70 px-3.5 py-3 text-[14px] text-ink-soft">You haven't blocked anyone.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-3 rounded-2xl px-1 py-1.5">
              <Avatar name={p.name} hue={p.hue} photo={p.photo} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.name}</span>
                {p.handle && <span className="block truncate text-[12.5px] text-ink-soft">@{p.handle}</span>}
              </span>
              <Button size="sm" variant="soft" busy={busy === p.id} disabled={!!busy} onClick={() => void unblock(p)}>
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
