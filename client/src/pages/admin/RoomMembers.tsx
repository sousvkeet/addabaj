import { useCallback, useEffect, useState } from 'react';
import { Crown, LoaderCircle, Search, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import type { User } from '../../lib/types';
import { toast } from '../../store/ui';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Chip, type AdminRoom, type AdminUser, type Page } from './shared';

type Member = User & { role: 'admin' | 'member'; owner: boolean; joinedAt: string };
type Data = { room: { id: string; name: string; maxMembers: number; memberCount: number; ownerId: string }; members: Member[] };

/** The host's view of a room's people: add anyone on the site, remove anyone in it. */
export function RoomMembers({
  room,
  onClose,
  onChanged,
}: {
  room: AdminRoom | null;
  onClose: () => void;
  onChanged: (memberCount: number, owner: { id: string; name: string; hue: number; photo?: string | null } | null) => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<AdminUser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const load = useCallback(async () => {
    if (!room) return;
    try {
      setData(await api<Data>(`/admin/rooms/${room.id}/members`));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [room]);

  useEffect(() => {
    setData(null);
    setQ('');
    setFound(null);
    setRemoving(null);
    void load();
  }, [load]);

  // People to add: anyone on the site, by name, email or user ID.
  useEffect(() => {
    if (!room || !q.trim()) return setFound(null);
    const id = window.setTimeout(() => {
      const params = new URLSearchParams({ q: q.trim(), limit: '8' });
      api<Page<AdminUser>>(`/admin/users?${params}`)
        .then((p) => setFound(p.items))
        .catch((err) => setError(errorMessage(err)));
    }, 250);
    return () => window.clearTimeout(id);
  }, [q, room]);

  function changed(after: Data) {
    setData(after);
    const owner = after.members.find((m) => m.owner);
    onChanged(after.members.length, owner ? { id: owner.id, name: owner.name, hue: owner.hue } : null);
  }

  async function add(user: AdminUser) {
    if (!room) return;
    setBusy(`add:${user.id}`);
    try {
      changed(await api<Data>(`/admin/rooms/${room.id}/members`, { method: 'POST', body: { userId: user.id } }));
      toast(`${user.name} is in ${room.name} now.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function remove(member: Member) {
    if (!room) return;
    setBusy(`remove:${member.id}`);
    try {
      changed(await api<Data>(`/admin/rooms/${room.id}/members/${member.id}`, { method: 'DELETE' }));
      setRemoving(null);
      toast(`${member.name} was removed from ${room.name}.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  const members = data?.members ?? [];
  const inRoom = new Set(members.map((m) => m.id));
  const full = !!data && members.length >= data.room.maxMembers;
  const nextOwner = members.filter((m) => !m.owner).sort((a, b) => Number(b.role === 'admin') - Number(a.role === 'admin') || a.joinedAt.localeCompare(b.joinedAt))[0];

  return (
    <Dialog
      open={!!room}
      onClose={onClose}
      width={520}
      title={room ? `People in ${room.name}` : 'People'}
      description={data ? `${members.length} of ${data.room.maxMembers} seats taken. As the host you can add anyone and remove anyone.` : undefined}
    >
      {error && (
        <p role="alert" className="mb-3 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
          {error}
        </p>
      )}

      <label className="flex h-11 items-center gap-2.5 rounded-2xl border border-line/70 bg-subtle/60 px-3.5 text-ink-soft focus-within:border-brand">
        <Search size={16} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Add someone: name, email or user ID"
          aria-label="Find someone to add"
          className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-soft/80"
        />
      </label>
      {full && q && <p className="mt-2 text-[13px] text-danger">The room is full. Its admins can raise the member limit in room settings.</p>}
      {found && (
        <ul aria-label="People to add" className="mt-2 rounded-2xl border border-line/70">
          {found.length === 0 && <li className="px-3 py-3 text-[14px] text-ink-soft">No one matches “{q}”.</li>}
          {found.map((u) => (
            <li key={u.id} className="flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-b-0">
              <Avatar name={u.name} hue={u.hue} photo={u.photo} size={34} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{u.name}</span>
                <span className="block truncate text-[12.5px] text-ink-soft">{u.handle ? `@${u.handle}` : u.email}</span>
              </span>
              {inRoom.has(u.id) ? (
                <span className="text-[13px] text-ink-soft">In the room</span>
              ) : u.disabled ? (
                <Chip tone="danger">Switched off</Chip>
              ) : (
                <Button size="sm" busy={busy === `add:${u.id}`} disabled={!!busy || full} onClick={() => void add(u)} aria-label={`Add ${u.name}`}>
                  <UserPlus size={15} />
                  Add
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-5 mb-1 text-[13px] font-semibold text-ink-soft">Members</h3>
      {!data ? (
        !error && (
          <p className="flex justify-center py-6 text-ink-soft">
            <LoaderCircle className="animate-spin" />
          </p>
        )
      ) : (
        <ul aria-label="Members" className="-mx-1">
          {members.map((m) => (
            <li key={m.id}>
              <div className="flex items-center gap-3 rounded-2xl px-1 py-1.5">
                <Avatar name={m.name} hue={m.hue} photo={m.photo} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14.5px] font-medium">{m.name}</span>
                    {m.owner ? (
                      <Chip tone="brand">
                        <Crown size={11} />
                        Owner
                      </Chip>
                    ) : (
                      m.role === 'admin' && (
                        <Chip tone="muted">
                          <ShieldCheck size={11} />
                          Admin
                        </Chip>
                      )
                    )}
                  </span>
                  <span className="block truncate text-[12.5px] text-ink-soft">{m.handle ? `@${m.handle}` : m.email}</span>
                </span>
                <Button size="sm" variant="ghost" className="text-danger" disabled={!!busy} onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`}>
                  <UserMinus size={15} />
                  Remove
                </Button>
              </div>
              {removing?.id === m.id && (
                <div className="mx-1 mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-danger/10 p-2.5">
                  <span className="min-w-[180px] flex-1 text-[13.5px] text-danger">
                    {m.owner
                      ? nextOwner
                        ? `${m.name} started the room. Remove them? ${nextOwner.name} will run it.`
                        : `${m.name} is the only one here. Delete the room instead.`
                      : `Remove ${m.name} from ${room?.name}?`}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                  {(!m.owner || nextOwner) && (
                    <Button size="sm" variant="danger" busy={busy === `remove:${m.id}`} onClick={() => void remove(m)}>
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
