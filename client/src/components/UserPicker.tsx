import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { AtSign, Copy, Search, Share2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { copyText, shareText } from '../lib/invite';
import type { PickerUser } from '../lib/types';
import { lastSeen } from '../lib/format';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

type Props = { open: boolean; onClose: () => void } & ({ mode: 'chat' } | { mode: 'room'; roomId: string });

/**
 * Find one person by their exact user ID or email: there's no list of
 * everyone on Adda Khana. Then message them, or add or invite them to a room.
 */
export function UserPicker(props: Props) {
  const { open, onClose } = props;
  const roomId = props.mode === 'room' ? props.roomId : null;
  const room = useChat((s) => (roomId ? s.roomDetails[roomId] ?? s.rooms[roomId] : null));
  const online = useChat((s) => s.online);
  const rememberUser = useChat((s) => s.rememberUser);
  const addMember = useChat((s) => s.addMember);
  const inviteMember = useChat((s) => s.inviteMember);
  const myHandle = useAuth((s) => s.user?.handle);
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [found, setFound] = useState<PickerUser | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<'add' | 'invite' | null>(null);

  useEffect(() => {
    if (!open) {
      setQ('');
      setFound(null);
      setError('');
    }
  }, [open]);

  async function find(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return setError('Enter a user ID or an email address.');
    setSearching(true);
    setError('');
    setFound(null);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (roomId) params.set('roomId', roomId);
      const { user } = await api<{ user: PickerUser }>(`/users/find?${params}`);
      setFound(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }

  const seatsLeft = room ? room.maxMembers - room.memberCount : 0;
  const full = props.mode === 'room' && seatsLeft <= 0;

  async function act(user: PickerUser, action: 'add' | 'invite') {
    if (!roomId) return;
    setBusy(action);
    try {
      if (action === 'add') {
        await addMember(roomId, user.id);
        toast(`${user.name} is in the room now.`);
      } else {
        await inviteMember(roomId, user.id);
        toast(`Invite sent to ${user.name}.`);
      }
      setFound({ ...user, roomStatus: action === 'add' ? 'member' : 'invited' });
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
          ? 'Enter their user ID or email. Ask your friend for it: nobody is listed.'
          : 'Find them by user ID or email. Add puts them in the room right away; Invite lets them choose.'
      }
    >
      {props.mode === 'room' && room && (
        <p className={`mb-3 rounded-xl px-3.5 py-2.5 text-[14px] ${full ? 'bg-danger/10 text-danger' : 'bg-subtle'}`}>
          {full
            ? `The room is full (${room.maxMembers} of ${room.maxMembers}). Raise the member limit in room settings to add more people.`
            : `${room.memberCount} of ${room.maxMembers} seats taken, ${seatsLeft} left.`}
        </p>
      )}
      <form onSubmit={find} className="flex gap-2" noValidate>
        <label className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-2xl border border-line/70 bg-subtle px-3.5 text-ink-soft transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_16%,transparent)]">
          <AtSign size={17} />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setError('');
            }}
            placeholder="User ID or email"
            aria-label="User ID or email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-soft/70"
          />
        </label>
        <Button type="submit" busy={searching} className="h-12">
          <Search size={16} />
          Find
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
          {error}
        </p>
      )}
      {found && (
        <div role="group" aria-label="Search result" className="mt-3 flex items-center gap-3 rounded-2xl border border-line/70 p-3">
          <Avatar name={found.name} hue={found.hue} photo={found.photo} size={44} online={online[found.id] ?? found.online} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{found.name}</span>
            <span className="block truncate text-[13px] text-ink-soft">
              {found.handle && `@${found.handle}`}
              {!found.presenceHidden && (online[found.id] || found.online || found.lastSeenAt) && (
                <span className={online[found.id] || found.online ? 'font-medium text-live-ink' : ''}>
                  {' · '}
                  {online[found.id] || found.online ? 'Online' : lastSeen(found.lastSeenAt).replace('Last seen ', 'seen ')}
                </span>
              )}
            </span>
          </span>
          {props.mode === 'chat' ? (
            <Button size="sm" onClick={() => openChat(found)}>
              Message
            </Button>
          ) : found.roomStatus === 'member' ? (
            <span className="px-2 text-[13px] text-ink-soft">In the room</span>
          ) : found.roomStatus === 'invited' ? (
            <span className="px-2 text-[13px] text-ink-soft">Invited</span>
          ) : (
            <span className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={full || !!busy} busy={busy === 'invite'} onClick={() => act(found, 'invite')}>
                Invite
              </Button>
              <Button size="sm" disabled={full || !!busy} busy={busy === 'add'} onClick={() => act(found, 'add')}>
                Add
              </Button>
            </span>
          )}
        </div>
      )}
      {props.mode === 'chat' && myHandle && (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-subtle/70 px-3.5 py-3 text-[14px]">
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-ink-soft">Your user ID, for friends to find you</span>
            <span className="block truncate font-semibold">@{myHandle}</span>
          </span>
          <span className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => void copyText(myHandle, 'Your user ID')}>
              <Copy size={15} />
              Copy
            </Button>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void shareText(`Find me on Adda Khana: my user ID is ${myHandle}\n${location.origin}`, 'Your user ID')}
            >
              <Share2 size={15} />
              Share
            </Button>
          </span>
        </div>
      )}
    </Dialog>
  );
}
