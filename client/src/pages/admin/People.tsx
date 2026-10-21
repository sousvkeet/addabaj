import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle, Power, Search, ShieldCheck, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { lastSeen } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { toast } from '../../store/ui';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog, Dialog, Field, inputClass } from '../../components/ui/Dialog';
import { Menu, type MenuItem } from '../../components/ui/Menu';
import { AdminPage, Chip, shortDate, type AdminUser, type Page } from './shared';

const FILTERS = [
  { id: 'all', label: 'Everyone' },
  { id: 'online', label: 'Online' },
  { id: 'admins', label: 'Host admins' },
  { id: 'disabled', label: 'Switched off' },
] as const;
type Filter = (typeof FILTERS)[number]['id'];

const PAGE = 40;

/** A strong password that's still possible to read out. */
function suggestPassword() {
  const words = ['amber', 'river', 'tiger', 'cloud', 'mango', 'lotus', 'comet', 'pearl', 'storm', 'maple'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}-${pick()}-${(crypto.getRandomValues(new Uint32Array(1))[0] % 900) + 100}`;
}

export function People() {
  const meId = useAuth((s) => s.user?.id);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<Page<AdminUser> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (offset = 0) => {
      const params = new URLSearchParams({ q, filter, limit: String(PAGE), offset: String(offset) });
      const page = await api<Page<AdminUser>>(`/admin/users?${params}`);
      setData((prev) => (offset && prev ? { total: page.total, items: [...prev.items, ...page.items] } : page));
    },
    [q, filter],
  );

  useEffect(() => {
    // Wait for typing to pause before searching.
    const id = window.setTimeout(() => load().then(() => setError(''), (err) => setError(errorMessage(err))), q ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [load, q]);

  const replace = (user: AdminUser) => setData((d) => d && { ...d, items: d.items.map((u) => (u.id === user.id ? user : u)) });

  async function update(user: AdminUser, change: Partial<Pick<AdminUser, 'siteAdmin' | 'disabled'>>, done: string) {
    try {
      const res = await api<{ user: AdminUser }>(`/admin/users/${user.id}`, { method: 'PATCH', body: change });
      replace(res.user);
      toast(done, 'live');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/admin/users/${removing.id}`, { method: 'DELETE' });
      setData((d) => d && { total: d.total - 1, items: d.items.filter((u) => u.id !== removing.id) });
      toast(`${removing.name}'s account was removed.`);
      setRemoving(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  function actions(u: AdminUser): MenuItem[] {
    if (u.id === meId) return [];
    return [
      u.siteAdmin
        ? { label: 'Remove host admin', icon: <ShieldOff size={16} />, onSelect: () => void update(u, { siteAdmin: false }, `${u.name} is no longer a host admin.`) }
        : { label: 'Make host admin', icon: <ShieldCheck size={16} />, onSelect: () => void update(u, { siteAdmin: true }, `${u.name} is now a host admin.`) },
      { label: 'Set a new password', icon: <KeyRound size={16} />, onSelect: () => setResetFor(u) },
      u.disabled
        ? { label: 'Switch account on', icon: <Power size={16} />, onSelect: () => void update(u, { disabled: false }, `${u.name} can log in again.`) }
        : { label: 'Switch account off', icon: <Power size={16} />, onSelect: () => void update(u, { disabled: true }, `${u.name} was logged out and can't log in.`) },
      { label: 'Remove account', icon: <Trash2 size={16} />, danger: true, onSelect: () => setRemoving(u) },
    ];
  }

  return (
    <AdminPage
      title="People"
      subtitle={
        data
          ? `${data.total.toLocaleString()} ${filter === 'all' ? (data.total === 1 ? 'account' : 'accounts') : 'shown'}`
          : 'Accounts on Adda Khana'
      }
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <UserPlus size={16} />
          <span className="hidden sm:inline">Add person</span>
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-11 min-w-[220px] flex-1 items-center gap-2.5 rounded-2xl border border-line/70 bg-subtle/60 px-3.5 text-ink-soft transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_16%,transparent)]">
          <Search size={16} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or email"
            aria-label="Search people"
            className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-soft/80"
          />
        </label>
        <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors ${
                filter === f.id ? 'bg-aurora text-white shadow-glow' : 'bg-subtle text-ink-soft hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
          {error}
        </p>
      )}

      {!data ? (
        !error && (
          <p className="flex justify-center py-16 text-ink-soft">
            <LoaderCircle className="animate-spin" />
          </p>
        )
      ) : data.items.length === 0 ? (
        <p className="rounded-[26px] border border-dashed border-line py-12 text-center text-ink-soft">No one matches that.</p>
      ) : (
        <ul aria-label="People" className="rounded-[26px] border border-line/70 bg-surface/60">
          {data.items.map((u) => (
            <li key={u.id} className="flex items-center gap-3 border-b border-line/60 px-4 py-3 last:border-b-0">
              <Avatar name={u.name} hue={u.hue} size={44} online={u.online} className={u.disabled ? 'opacity-50 grayscale' : ''} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate font-semibold">{u.name}</span>
                  {u.id === meId && <span className="text-[13px] text-ink-soft">(you)</span>}
                  {u.siteAdmin && <Chip tone="brand">Host admin</Chip>}
                  {u.disabled && <Chip tone="danger">Switched off</Chip>}
                  {u.defaultPassword && <Chip tone="warn">Default password</Chip>}
                </p>
                <p className="truncate text-[13px] text-ink-soft">{u.email}</p>
              </div>
              <dl className="hidden shrink-0 grid-cols-3 gap-6 text-[12.5px] lg:grid">
                <div>
                  <dt className="text-ink-soft">Joined</dt>
                  <dd className="font-semibold">{shortDate(u.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-ink-soft">Rooms</dt>
                  <dd className="font-semibold tabular-nums">{u.rooms}</dd>
                </div>
                <div>
                  <dt className="text-ink-soft">Messages</dt>
                  <dd className="font-semibold tabular-nums">{u.messages.toLocaleString()}</dd>
                </div>
              </dl>
              <span className={`hidden w-[150px] shrink-0 text-right text-[12.5px] sm:block ${u.online ? 'font-semibold text-live-ink' : 'text-ink-soft'}`}>
                {u.online ? 'Online now' : lastSeen(u.lastSeenAt).replace('Last seen ', 'Seen ')}
              </span>
              <span className="w-8 shrink-0">
                <Menu label={`Actions for ${u.name}`} items={actions(u)} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {data && data.items.length < data.total && (
        <div className="flex justify-center">
          <Button
            variant="soft"
            busy={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              load(data.items.length)
                .catch((err) => toast(errorMessage(err), 'error'))
                .finally(() => setLoadingMore(false));
            }}
          >
            Show more
          </Button>
        </div>
      )}

      <AddPersonDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(u) => {
          setData((d) => d && { total: d.total + 1, items: [u, ...d.items] });
          toast(`${u.name} can now log in with ${u.email}.`, 'live');
        }}
      />
      <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? ''}?`}
        body={
          <>
            Their account, messages and the rooms they started are deleted for good, and they're logged out everywhere. To keep
            their history, switch the account off instead.
          </>
        }
        confirm="Remove account"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </AdminPage>
  );
}

function AddPersonDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (u: AdminUser) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [siteAdmin, setSiteAdmin] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setEmail('');
    setPassword(suggestPassword());
    setSiteAdmin(false);
    setError('');
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api<{ user: AdminUser }>('/admin/users', { method: 'POST', body: { name, email, password, siteAdmin } });
      onAdded(user);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add a person" description="Make an account for someone and give them the email and password to log in.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="Share it with them privately. They can change it from their account menu.">
          <input className={`${inputClass} font-mono`} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </Field>
        <label className="flex items-center gap-2.5 text-[14px]">
          <input type="checkbox" checked={siteAdmin} onChange={(e) => setSiteAdmin(e.target.checked)} className="size-4 accent-[var(--brand)]" />
          Make them a host admin too
        </label>
        {error && (
          <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!name.trim() || !email.trim() || password.length < 8}>
            Add person
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    setPassword(suggestPassword());
    setError('');
  }, [user]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/users/${user.id}/password`, { method: 'POST', body: { password } });
      toast(`${user.name}'s password was changed.`, 'live');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      title={`New password for ${user?.name ?? ''}`}
      description="For someone who forgot theirs. Give it to them privately; they can change it after logging in."
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="New password" hint="At least 8 characters.">
          <input className={`${inputClass} font-mono`} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus />
        </Field>
        {error && (
          <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={password.length < 8}>
            Set password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
