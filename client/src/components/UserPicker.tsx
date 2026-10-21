import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import type { PickerUser } from '../lib/types';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

type Props = { open: boolean; onClose: () => void } & ({ mode: 'chat' } | { mode: 'room'; roomId: string });

export function UserPicker(props: Props) {
  const { open, onClose } = props;
  const roomId = props.mode === 'room' ? props.roomId : null;
  const room = useChat((s) => (roomId ? s.roomDetails[roomId] ?? s.rooms[roomId] : null));
  const online = useChat((s) => s.online);
  const rememberUser = useChat((s) => s.rememberUser);
  const addMember = useChat((s) => s.addMember);
  const inviteMember = useChat((s) => s.inviteMember);
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [users, setUsers] = useState<PickerUser[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQ('');
      setUsers(null);
      setError('');
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: q.trim() });
        if (roomId) params.set('roomId', roomId);
        const res = await api<{ users: PickerUser[] }>(`/users?${params}`);
        setUsers(res.users);
        setError('');
      } catch (err) {
        setError(errorMessage(err));
      }
    }, q ? 220 : 0);
    return () => window.clearTimeout(t);
  }, [q, open, roomId]);

  const seatsLeft = room ? room.maxMembers - room.memberCount : 0;
  const full = props.mode === 'room' && seatsLeft <= 0;

  async function act(user: PickerUser, action: 'add' | 'invite') {
    if (!roomId) return;
    setBusy(`${user.id}:${action}`);
    try {
      if (action === 'add') {
        await addMember(roomId, user.id);
        toast(`${user.name} is in the room now.`);
      } else {
        await inviteMember(roomId, user.id);
        toast(`Invite sent to ${user.name}.`);
      }
      setUsers((list) => list?.map((u) => (u.id === user.id ? { ...u, roomStatus: action === 'add' ? 'member' : 'invited' } : u)) ?? null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  function openChat(user: PickerUser) {
    rememberUser(user);
    onClose();
    navigate(`/chats/${user.id}`);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={480}
      title={props.mode === 'chat' ? 'Start a chat' : `Add people to ${room?.name ?? 'the room'}`}
      description={
        props.mode === 'chat'
          ? 'Search by name or email.'
          : 'Add puts someone in the room right away. Invite lets them choose to join.'
      }
    >
      {props.mode === 'room' && room && (
        <p className={`mb-3 rounded-xl px-3.5 py-2.5 text-[14px] ${full ? 'bg-danger/10 text-danger' : 'bg-subtle'}`}>
          {full
            ? `The room is full (${room.maxMembers} of ${room.maxMembers}). Raise the member limit in room settings to add more people.`
            : `${room.memberCount} of ${room.maxMembers} seats taken, ${seatsLeft} left.`}
        </p>
      )}
      <label className="sticky top-0 z-10 mb-2 flex h-12 items-center gap-2.5 rounded-2xl border border-line/70 bg-subtle px-3.5 text-ink-soft transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_16%,transparent)]">
        <Search size={17} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name or email"
          aria-label="Search people"
          className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-soft/70"
        />
      </label>
      {error && <p className="py-3 text-[14px] text-danger">{error}</p>}
      <ul className="-mx-2">
        {users?.map((u) => (
          <li key={u.id} className="flex items-center gap-3 rounded-2xl px-2 py-2 transition-colors hover:bg-subtle/70">
            <button
              type="button"
              disabled={props.mode !== 'chat'}
              onClick={() => openChat(u)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
            >
              <Avatar name={u.name} hue={u.hue} size={40} online={online[u.id]} />
              <span className="min-w-0">
                <span className="block truncate font-semibold">{u.name}</span>
                <span className="block truncate text-[13px] text-ink-soft">{u.email}</span>
              </span>
            </button>
            {props.mode === 'room' &&
              (u.roomStatus === 'member' ? (
                <span className="px-2 text-[13px] text-ink-soft">In the room</span>
              ) : u.roomStatus === 'invited' ? (
                <span className="px-2 text-[13px] text-ink-soft">Invited</span>
              ) : (
                <span className="flex gap-1.5">
                  <Button size="sm" variant="outline" disabled={full || !!busy} busy={busy === `${u.id}:invite`} onClick={() => act(u, 'invite')}>
                    Invite
                  </Button>
                  <Button size="sm" disabled={full || !!busy} busy={busy === `${u.id}:add`} onClick={() => act(u, 'add')}>
                    Add
                  </Button>
                </span>
              ))}
          </li>
        ))}
      </ul>
      {users && users.length === 0 && (
        <p className="py-6 text-center text-[14px] text-ink-soft">
          {q ? `No one matches “${q}”.` : 'No one else has joined Adda Khana yet. Share the link with a friend.'}
        </p>
      )}
    </Dialog>
  );
}
